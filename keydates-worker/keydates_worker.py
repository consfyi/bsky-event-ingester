#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""keydates_worker.py — extract convention key dates from Bluesky posts and stage
them as changes to a consfyi/data checkout, using GitHub Models (free tier) for
extraction and verification.

Designed to run on the cons.fyi droplet (triggered by bsky-event-ingester's
con-post spool, and weekly via cron in sweep mode), but runs anywhere with a
data checkout.

Pipeline per con:
  A. fetch recent posts (public Bluesky appview, free) or take a spooled post
  B. EXTRACT candidate dates  — gpt-4.1-mini (low tier), hardened exclusion prompt
  C. VERIFY every guardrail-passing proposal — gpt-4.1 AND gpt-4o (high tier),
     unanimous confirm required; split verdicts are held (reported, not applied)
  D. MERGE confirmed dates into the con JSON (confidence gate, never overwrite
     curated values, recency-wins, rejections-file exclusions), run format.py
  E. (PUSH=1 only) commit to bot/bsky-keydates, push, open/update the PR

Validated against the 2026-07-01 manual baseline: Haiku-class extraction alone
carried ~30% false positives past the confidence gate; the adversarial verify
stage refuted all of them. Do not weaken stage C.

Env:
  GITHUB_TOKEN      required — fine-grained PAT with models:read (gh auth token works)
  DATA_DIR          path to consfyi/data checkout (default: cwd)
  DRY_RUN=1         full pipeline, no file writes / git ops
  PUSH=1            allow git commit+push+PR (default OFF: writes files only)
  EXTRACT_MODEL     default openai/gpt-4.1-mini
  VERIFY_MODELS     comma-separated, default openai/gpt-4.1,openai/gpt-4o
  SUMMARY_FILE      write the markdown report here (also printed)
  CACHE_FILE        verdict cache path (default: ~/.cache/keydates-worker/verdict_cache.json)
  MAX_EXTRACTS      stop after N actual extract calls this run (quota guard; default 120)

Usage:
  keydates_worker.py --sweep [--shard 1/2]
  keydates_worker.py --series anthrocon
  keydates_worker.py --post-file /var/spool/keydates/xyz.json   # from the ingester
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# --- config -----------------------------------------------------------------
GH_MODELS_URL = "https://models.github.ai/inference/chat/completions"
GH_CATALOG_URL = "https://models.github.ai/catalog/models"
EXTRACT_MODEL = os.environ.get("EXTRACT_MODEL", "openai/gpt-4.1-mini")
VERIFY_MODELS = os.environ.get("VERIFY_MODELS", "openai/gpt-4.1,openai/gpt-4o").split(",")
DATA_DIR = os.path.abspath(os.environ.get("DATA_DIR", "."))
DRY_RUN = os.environ.get("DRY_RUN") == "1"
PUSH = os.environ.get("PUSH") == "1"
MAX_EXTRACTS = int(os.environ.get("MAX_EXTRACTS", "120"))
CACHE_FILE = os.environ.get("CACHE_FILE", os.path.expanduser("~/.cache/keydates-worker/verdict_cache.json"))
REJECTIONS_FILE = os.path.join(DATA_DIR, ".github", "keydates_rejections.json")
BOT_BRANCH = "bot/bsky-keydates"

CONFIDENCE_THRESHOLD = 0.80
POSTS_PER_CON = 50
APPVIEW = "https://public.api.bsky.app/xrpc"
TODAY = datetime.datetime.now(datetime.timezone.utc).date()
CATEGORIES = ["registration", "hotel", "dealers", "panels", "volunteers"]
VERIFY_BATCH = 8
INPUT_BUDGET_CHARS = 24000  # ~6k tokens; free tier caps requests at 8k in
# RPM pacing per free-tier docs: low tier 15 RPM, high tier 10 RPM
MODEL_MIN_INTERVAL = {EXTRACT_MODEL: 4.5, **{m: 6.5 for m in VERIFY_MODELS}}

# cheap pre-filter so we only spend model calls on date-relevant posts
# (validated in the 2026-07-01 run: 1559/~3850 posts passed across 77 cons)
RELEVANT = re.compile(
    r"\b(regist|reg open|hotel|room block|booking|dealer|artist alley|panel|"
    r"programming|submission|deadline|badge|sign ?up|volunteer|applicat|"
    r"opens?|closes?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|"
    r"\b\d{1,2}/\d{1,2}\b|\b20\d\d\b",
    re.I,
)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "dates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "event_id": {"type": "string"},
                    "category": {"type": "string", "enum": CATEGORIES},
                    "kind": {"type": "string", "enum": ["opens", "closes"]},
                    "date": {"type": "string"},
                    "source": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["event_id", "category", "kind", "date", "source", "confidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["dates"],
    "additionalProperties": False,
}

VERIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "verdict": {"type": "string", "enum": ["confirm", "refute"]},
                    "reason": {"type": "string"},
                },
                "required": ["index", "verdict", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["verdicts"],
    "additionalProperties": False,
}

# The exclusion list below encodes every false-positive class found in the
# 2026-07-01 baseline (19/63 proposals refuted). Keep it in sync with the
# verify rubric.
EXTRACT_SYSTEM = """You extract convention "key dates" from a furry convention's own recent Bluesky posts.

Only output a date when the post explicitly states it for THIS convention. Categories:
- registration: general ATTENDEE badge/membership sales opening or hard-closing
- hotel: room block / hotel booking opening or closing
- dealers: dealers den AND/OR artist alley vendor APPLICATIONS opening or closing (both belong here)
- panels: programming/panel/performance SUBMISSIONS opening or closing (dance/performance
  competition auditions count as performance submissions)
- volunteers: general staff/volunteer signups opening or closing (not sub-group-only calls)

DO NOT extract (these are the known failure classes — none of them qualify):
- price-tier changes, early-bird endings, "more expensive at the door" (registration stays open)
- fursuit badges, creator/media badges, sponsor upgrades (not attendee registration)
- art show, charity auction, conbook/decor art submissions, DJ applications (not dealers or panels)
- payment/confirmation deadlines for ALREADY-ACCEPTED applicants (not an application closing)
- "soft closing" / "closing soon" / "almost sold out" with no explicit hard date
- themed metaphors ("boarding gates are open") that never explicitly say what opened
- temporary pauses and resumptions ("registration will pause March 8-10", "will resume
  March 11") — a pause is not a closing and a resumption is not an opening

Rules:
- kind is "opens" or "closes" (a submission "deadline" is closes).
- date MUST be the bare calendar date, yyyy-MM-dd. If the post states a time of day,
  drop the time and keep the date.
- Resolve relative dates ("this Monday", "tonight") against that post's own timestamp.
- Attribute to the correct edition via event_id. If the convention has MORE THAN ONE
  upcoming edition, only extract when the post carries explicit edition evidence
  (year, hashtag like #FWA2027, or an unambiguous date range).
- source MUST be the exact post URL the date came from.
- confidence 0-1 covers date AND category AND edition together. Be conservative.
- If nothing qualifies, return {"dates": []}. Never invent or guess."""

VERIFY_SYSTEM = """You are an adversarial fact-checker for convention key dates. For each numbered item,
decide "confirm" or "refute" based ONLY on the quoted post text.

Strict category definitions:
- registration = general attendee badge/membership sales opening or hard-closing. NOT price-tier
  increases, early-bird endings, at-the-door price changes, fursuit/creator/media/sponsor badges.
- hotel = room block / hotel booking open or close only. NOT event-suite lotteries.
- dealers = dealers den AND artist alley vendor applications — BOTH belong to this category;
  never refute a date merely because it concerns artist alley rather than dealers den.
  NOT art show, charity auction, conbook art, or payment deadlines for accepted vendors.
- panels = programming/panel/performance submissions, INCLUDING dance/performance competition
  auditions. NOT DJ set applications, art show, or creator badges.
- volunteers = general staff/volunteer signups. NOT recruitment for one named sub-group only.

Refute when ANY of: the date is a price change rather than a true open/close; the post refers to
a different edition/year than the stated event (check the edition dates given — a post written
many months before the edition, especially one predating the convention's previous edition,
almost certainly refers to that earlier edition unless it carries explicit evidence like a year
or hashtag); the "closing" is soft ("closing soon", "almost sold out") with no explicit date;
the date is not explicitly stated in the post; the category is a stretch per the definitions;
the deadline applies only to already-accepted applicants; the "close" or "open" is actually a
temporary pause or a resumption of something already open. When uncertain, refute — a dropped
true date returns next run; a published false date misleads attendees.

Return a verdict for every item index you were given."""


# --- GitHub Models client ----------------------------------------------------
class DailyCapHit(Exception):
    pass


_last_call: dict[str, float] = {}


def _pace(model: str):
    interval = MODEL_MIN_INTERVAL.get(model, 6.5)
    elapsed = time.monotonic() - _last_call.get(model, 0.0)
    if elapsed < interval:
        time.sleep(interval - elapsed)


def chat(model: str, system: str, user: str, schema: dict, schema_name: str):
    """One structured-output chat call. Returns parsed dict, or None on repeated
    malformed output. Raises DailyCapHit when the model's daily quota is gone."""
    token = os.environ.get("GITHUB_TOKEN") or subprocess.run(
        ["gh", "auth", "token"], capture_output=True, text=True
    ).stdout.strip()
    if not token:
        raise SystemExit("GITHUB_TOKEN not set and `gh auth token` unavailable")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": 3000,
        "response_format": {"type": "json_schema", "json_schema": {
            "name": schema_name, "strict": True, "schema": schema}},
    }).encode()
    for attempt in range(4):
        _pace(model)
        req = urllib.request.Request(
            GH_MODELS_URL, data=body, method="POST",
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "application/json",
                     "User-Agent": "consfyi-keydates-worker"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                _last_call[model] = time.monotonic()
                resp = json.load(r)
            content = resp["choices"][0]["message"]["content"]
            return json.loads(content)
        except urllib.error.HTTPError as e:
            _last_call[model] = time.monotonic()
            if e.code == 429:
                retry_after = int(e.headers.get("Retry-After") or "60")
                if retry_after > 300:
                    raise DailyCapHit(model)
                log(f"  429 on {model}, sleeping {retry_after}s")
                time.sleep(retry_after)
                continue
            if e.code in (400, 413) and attempt == 0:
                # token overflow — caller should have budgeted; retry once with a note
                log(f"  {e.code} on {model}: {e.read()[:200]!r}")
                return None
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))
        except (json.JSONDecodeError, KeyError):
            if attempt >= 1:
                return None
    return None


def catalog_check():
    """Fail fast if a configured model has vanished from the catalog."""
    try:
        with urllib.request.urlopen(
            urllib.request.Request(GH_CATALOG_URL, headers={"User-Agent": "consfyi-keydates"}),
            timeout=30,
        ) as r:
            ids = {m["id"] for m in json.load(r)}
    except Exception as e:
        log(f"warning: catalog check failed ({e}); proceeding")
        return
    missing = [m for m in [EXTRACT_MODEL, *VERIFY_MODELS] if m not in ids]
    if missing:
        raise SystemExit(
            f"model(s) {missing} not in the GitHub Models catalog. "
            f"Override with EXTRACT_MODEL / VERIFY_MODELS env vars."
        )


# --- Bluesky fetch (free public appview) -------------------------------------
def appget(method, params):
    url = f"{APPVIEW}/{method}?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"User-Agent": "consfyi-keydates"})
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except Exception:
            time.sleep(1.0)
    return {}


def fetch_posts(handle):
    feed = appget("app.bsky.feed.getAuthorFeed",
                  {"actor": handle, "limit": POSTS_PER_CON, "filter": "posts_no_replies"})
    out = []
    for it in feed.get("feed", []):
        p = it.get("post", {})
        rec = p.get("record", {})
        txt = (rec.get("text") or "").strip()
        if not txt or not RELEVANT.search(txt):
            continue
        rkey = p.get("uri", "").rsplit("/", 1)[-1]
        out.append({
            "asOf": rec.get("createdAt"),
            "text": txt,
            "url": f"https://bsky.app/profile/{handle}/post/{rkey}",
        })
    return out


# --- data model helpers -------------------------------------------------------
def upcoming_events(con):
    """Editions worth dating: end_date + 2 days grace vs current UTC date."""
    cutoff = (TODAY - datetime.timedelta(days=2)).isoformat()
    return [
        {"id": e["id"], "name": e["name"], "startDate": e["startDate"], "endDate": e["endDate"]}
        for e in con.get("events", [])
        if e.get("endDate", "") >= cutoff
    ]


def importer_owned(kind_obj):
    return "bsky.app/profile/" in ((kind_obj or {}).get("source") or "")


def previous_edition_end(con, event_id):
    """End date of the latest edition that finished before the target edition
    started, or None. Used to kill wrong-edition attribution mechanically: a
    post written before the previous edition even ended cannot be announcing
    dates for the next one (baseline FP class: a 2025 'registration open' post
    attributed to the Oct-2026 edition)."""
    events = con.get("events", [])
    target = next((e for e in events if e["id"] == event_id), None)
    if target is None:
        return None
    prior = [e.get("endDate", "") for e in events
             if e["id"] != event_id and e.get("endDate", "") < target.get("startDate", "")]
    return max(prior) if prior else None


def load_rejections():
    if not os.path.exists(REJECTIONS_FILE):
        return []
    with open(REJECTIONS_FILE) as f:
        return json.load(f)


def is_rejected(rejections, d):
    for r in rejections:
        if (r["event_id"], r["category"], r["kind"], r["date"]) == \
           (d["event_id"], d["category"], d["kind"], d["date"]):
            if r.get("source") and r["source"] != d.get("source"):
                continue
            return r
    return None


def passes_guardrails(by_id, d):
    """Mechanical checks shared by proposal collection — semantics identical to
    the validated merge() from the 2026-07-01 run."""
    return (
        d.get("confidence", 0) >= CONFIDENCE_THRESHOLD
        and DATE_RE.match(d.get("date", ""))
        and d.get("category") in CATEGORIES
        and d.get("kind") in ("opens", "closes")
        and d.get("asOf")
        and d.get("event_id") in by_id
    )


def merge(con, dates):
    """Apply confirmed dates. Returns list of change descriptions."""
    by_id = {e["id"]: e for e in con.get("events", [])}
    changes = []
    for d in dates:
        ev = by_id[d["event_id"]]
        cat = ev.setdefault("keyDates", {}).setdefault(d["category"], {})
        existing = cat.get(d["kind"])
        if existing is not None and not importer_owned(existing):
            continue  # never clobber a human-curated value
        if existing is not None and (d["asOf"] or "") <= (existing.get("asOf") or ""):
            continue  # recency-wins: only a newer source post may supersede
        new_val = {
            "date": d["date"], "source": d["source"], "asOf": d["asOf"],
            "confidence": round(d["confidence"], 2),
        }
        if existing == new_val:
            continue
        cat[d["kind"]] = new_val
        verb = f"amend {existing['date']} -> {d['date']}" if existing and existing.get("date") != d["date"] else ("update" if existing else "add")
        changes.append({**d, "verb": verb})
    # drop empty stubs
    for ev in con.get("events", []):
        kd = ev.get("keyDates")
        if kd is not None:
            for c in [c for c, v in kd.items() if not v]:
                del kd[c]
            if not kd:
                del ev["keyDates"]
    return changes


# --- verdict cache -------------------------------------------------------------
def cache_key(d):
    raw = "|".join(str(d.get(k, "")) for k in ("event_id", "category", "kind", "date", "source", "asOf"))
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def load_cache():
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE) as f:
                return json.load(f)
        except json.JSONDecodeError:
            pass
    return {}


def save_cache(cache):
    if DRY_RUN:
        return
    # prune entries older than 90 days to bound growth
    cutoff = (TODAY - datetime.timedelta(days=90)).isoformat()
    cache = {k: v for k, v in cache.items() if v.get("at", "9999") >= cutoff}
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE, "w") as f:
        json.dump(cache, f, indent=1)


# --- pipeline -------------------------------------------------------------------
def log(msg):
    print(msg, file=sys.stderr, flush=True)


def extract_for_con(con, events, posts):
    # budget: trim oldest posts first (feed is newest-first; recency-wins makes old posts expendable)
    payload = {"convention": con["name"], "editions": events, "posts": posts}
    while len(json.dumps(payload)) > INPUT_BUDGET_CHARS and len(payload["posts"]) > 1:
        payload["posts"] = payload["posts"][:-1]
    user = json.dumps(payload, ensure_ascii=False)
    result = chat(EXTRACT_MODEL, EXTRACT_SYSTEM, user, EXTRACT_SCHEMA, "keydates")
    return (result or {}).get("dates", [])


def verify_proposals(proposals, cache):
    """Run every uncached proposal through all verify models. Returns
    (confirmed, refuted, held) lists; mutates cache."""
    confirmed, refuted, held = [], [], []
    pending = []
    for p in proposals:
        k = cache_key(p)
        cached = cache.get(k)
        if cached:
            p["_verdicts"] = cached["verdicts"]
        else:
            pending.append(p)

    for lo in range(0, len(pending), VERIFY_BATCH):
        batch = pending[lo:lo + VERIFY_BATCH]
        items = [{
            "index": i,
            "convention": p["_con_name"],
            "edition": {"id": p["event_id"], "startDate": p["_ev_dates"][0], "endDate": p["_ev_dates"][1]},
            "sibling_upcoming_editions": p["_siblings"],
            "claim": {k2: p[k2] for k2 in ("category", "kind", "date", "confidence")},
            "post_text": p["_post_text"],
            "post_timestamp": p["asOf"],
        } for i, p in enumerate(batch)]
        user = json.dumps({"items": items}, ensure_ascii=False)
        verdicts_by_model = {}
        for m in VERIFY_MODELS:
            try:
                res = chat(m, VERIFY_SYSTEM, user, VERIFY_SCHEMA, "verdicts")
            except DailyCapHit:
                log(f"  daily cap on {m}; holding remaining proposals")
                res = None
            verdicts_by_model[m] = {v["index"]: v for v in (res or {}).get("verdicts", [])}
        for i, p in enumerate(batch):
            vs = [verdicts_by_model[m].get(i) for m in VERIFY_MODELS]
            p["_verdicts"] = [
                {"model": m, "verdict": (v or {}).get("verdict", "unavailable"),
                 "reason": (v or {}).get("reason", "no verdict returned")}
                for m, v in zip(VERIFY_MODELS, vs)
            ]
            if all(v and v.get("verdict") == "confirm" for v in vs):
                cache[cache_key(p)] = {"verdicts": p["_verdicts"], "at": TODAY.isoformat()}
            elif any(v and v.get("verdict") == "refute" for v in vs):
                cache[cache_key(p)] = {"verdicts": p["_verdicts"], "at": TODAY.isoformat()}
            # unavailable (quota) -> not cached, retried next run

    for p in proposals:
        vd = [v["verdict"] for v in p["_verdicts"]]
        if all(v == "confirm" for v in vd):
            confirmed.append(p)
        elif "refute" in vd:
            refuted.append(p)
        else:
            held.append(p)
    return confirmed, refuted, held


def process_con(fn, cache, rejections, provided_posts=None):
    """Returns (changes, refuted, held, rejected_skips, did_extract) for one
    con file; did_extract is False when the con was skipped before any model
    call (no mapping / no upcoming edition / no posts)."""
    with open(fn) as f:
        con = json.load(f)
    bsky = con.get("bluesky")
    if not bsky or not bsky.get("did"):
        return [], [], [], [], False
    events = upcoming_events(con)
    if not events:
        return [], [], [], [], False
    posts = provided_posts if provided_posts is not None else fetch_posts(bsky.get("handle") or bsky["did"])
    if not posts:
        return [], [], [], [], False

    dates = extract_for_con(con, events, posts)
    url2post = {p["url"]: p for p in posts}
    by_id = {e["id"]: e for e in con.get("events", [])}
    ev_meta = {e["id"]: (e["startDate"], e["endDate"]) for e in events}

    proposals, rejected_skips, stale_drops = [], [], []
    for d in dates:
        post = url2post.get(d.get("source"))
        d["asOf"] = (post or {}).get("asOf")
        # models sometimes emit a full timestamp when the post names a time of day;
        # keep the date part rather than silently dropping a true date
        if re.match(r"^\d{4}-\d{2}-\d{2}[T ]", d.get("date", "")):
            d["date"] = d["date"][:10]
        if not passes_guardrails(by_id, d):
            log(f"  guardrail drop: {d.get('event_id')} {d.get('category')}.{d.get('kind')} "
                f"date={d.get('date')!r} conf={d.get('confidence')}")
            continue
        already = ((by_id[d["event_id"]].get("keyDates") or {}).get(d["category"]) or {}).get(d["kind"])
        if already and already.get("date") == d["date"]:
            continue  # same date already recorded; re-announcements add nothing, save the verify calls
        prev_end = previous_edition_end(con, d["event_id"])
        if prev_end and (d["asOf"] or "")[:10] <= prev_end:
            d["_file"] = os.path.basename(fn)
            d["_verdicts"] = [{"model": "mechanical", "verdict": "refute",
                               "reason": f"source post ({d['asOf'][:10]}) predates the previous "
                                         f"edition's end ({prev_end}) — almost certainly refers "
                                         f"to an earlier edition"}]
            stale_drops.append(d)
            continue
        rej = is_rejected(rejections, d)
        if rej:
            rejected_skips.append({**d, "_reason": rej.get("reason", "")})
            continue
        d["_con_name"] = con["name"]
        d["_post_text"] = (post or {}).get("text", "")
        d["_ev_dates"] = ev_meta.get(d["event_id"], ("?", "?"))
        d["_siblings"] = [
            {"id": e["id"], "startDate": e["startDate"]} for e in events if e["id"] != d["event_id"]
        ]
        d["_file"] = os.path.basename(fn)
        proposals.append(d)

    if not proposals:
        return [], stale_drops, [], rejected_skips, True

    confirmed, refuted, held = verify_proposals(proposals, cache)
    refuted = stale_drops + refuted

    changes = []
    if confirmed:
        changes = merge(con, confirmed)
        if changes and not DRY_RUN:
            with open(fn, "w") as f:
                json.dump(con, f, ensure_ascii=False, indent=2)
                f.write("\n")
    return changes, refuted, held, rejected_skips, True


def render_summary(all_changes, all_refuted, all_held, all_rejected, skipped_note):
    lines = ["## Key dates from Bluesky", ""]
    lines.append(f"_Extract: `{EXTRACT_MODEL}` · Verify (unanimous): `{'` + `'.join(VERIFY_MODELS)}` · {TODAY.isoformat()}_")
    if all_changes:
        lines.append("\n### Applied (unanimously verified)")
        for c in all_changes:
            lines.append(f"\n**{c['_file']}** — `{c['event_id']}` {c['category']}.{c['kind']} → **{c['date']}** ({c['verb']}, conf {c['confidence']})")
            lines.append(f"> {c['_post_text'][:400]}")
            lines.append(f"> — [source post]({c['source']}) at {c['asOf']}")
    if all_held:
        lines.append("\n### Held — verifier disagreement, needs a human (`/reject` or hand-apply)")
        for p in all_held:
            lines.append(f"- `{p['event_id']}` {p['category']}.{p['kind']} {p['date']} — " +
                         "; ".join(f"{v['model'].split('/')[-1]}: {v['verdict']} ({v['reason'][:120]})" for v in p["_verdicts"]))
    if all_refuted:
        lines.append("\n### Refuted by verification (not applied)")
        for p in all_refuted:
            reason = next((v["reason"] for v in p["_verdicts"] if v["verdict"] == "refute"), "")
            lines.append(f"- `{p['event_id']}` {p['category']}.{p['kind']} {p['date']} — {reason[:160]}")
    if all_rejected:
        lines.append("\n### Skipped — matches an entry in keydates_rejections.json")
        for p in all_rejected:
            lines.append(f"- `{p['event_id']}` {p['category']}.{p['kind']} {p['date']} — {p.get('_reason','')}")
    if skipped_note:
        lines.append(f"\n_{skipped_note}_")
    body = "\n".join(lines)
    if len(body) > 60000:
        body = body[:60000] + "\n\n_…truncated; full report in worker logs._"
    return body


def publish(summary):
    """Commit staged changes and open/update the rolling PR. PUSH=1 only."""
    def git(*args, check=True):
        return subprocess.run(["git", "-C", DATA_DIR, *args], check=check, capture_output=True, text=True)

    status = git("status", "--porcelain").stdout
    changed = [l[3:] for l in status.splitlines() if l.endswith(".json") and "/" not in l[3:]]
    if not changed:
        log("nothing to publish")
        return
    git("checkout", "-B", BOT_BRANCH)
    git("add", *changed)
    git("commit", "-m", "via keydates_worker")
    git("push", "-f", "origin", BOT_BRANCH)
    pr = subprocess.run(["gh", "pr", "list", "--repo", "consfyi/data", "--head", BOT_BRANCH,
                         "--state", "open", "--json", "number", "-q", ".[0].number"],
                        capture_output=True, text=True).stdout.strip()
    summary_path = os.path.join(DATA_DIR, ".git", "KEYDATES_PR_BODY.md")
    with open(summary_path, "w") as f:
        f.write(summary)
    if pr:
        subprocess.run(["gh", "pr", "edit", pr, "--repo", "consfyi/data", "--body-file", summary_path], check=True)
        log(f"updated PR #{pr}")
    else:
        subprocess.run(["gh", "pr", "create", "--repo", "consfyi/data", "--head", BOT_BRANCH,
                        "--title", "Key dates from Bluesky", "--body-file", summary_path], check=True)
        log("opened new PR")


def main():
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--sweep", action="store_true", help="all mapped cons with upcoming editions")
    mode.add_argument("--series", help="one series id (filename without .json)")
    mode.add_argument("--post-file", help="spooled post JSON from the ingester: {did|series, text, url, asOf}")
    ap.add_argument("--shard", default=None, help="N/M — process the Nth of M slices (sweep only)")
    args = ap.parse_args()

    catalog_check()
    cache = load_cache()
    rejections = load_rejections()

    targets = []  # (filename, provided_posts | None)
    if args.series:
        targets = [(os.path.join(DATA_DIR, args.series + ".json"), None)]
    elif args.post_file:
        with open(args.post_file) as f:
            spool = json.load(f)
        series = spool.get("series")
        if not series:
            did = spool["did"]
            for fn in glob.glob(os.path.join(DATA_DIR, "*.json")):
                with open(fn) as f:
                    c = json.load(f)
                if (c.get("bluesky") or {}).get("did") == did:
                    series = os.path.basename(fn)[:-5]
                    break
        if not series:
            raise SystemExit(f"no series found for spooled post {args.post_file}")
        # single post + its context: still fetch the feed so recency-wins sees
        # neighbours, but the triggering post is guaranteed present
        targets = [(os.path.join(DATA_DIR, series + ".json"), None)]
    else:
        files = sorted(glob.glob(os.path.join(DATA_DIR, "*.json")))
        if args.shard:
            n, m = (int(x) for x in args.shard.split("/"))
            files = [f for i, f in enumerate(files) if i % m == n - 1]
        targets = [(f, None) for f in files]

    all_changes, all_refuted, all_held, all_rejected = [], [], [], []
    extracts = 0
    skipped_note = ""
    for fn, provided in targets:
        if not os.path.exists(fn):
            log(f"missing: {fn}")
            continue
        if extracts >= MAX_EXTRACTS:
            skipped_note = f"Stopped after {MAX_EXTRACTS} extract calls (quota guard); remaining cons pick up next run."
            break
        try:
            changes, refuted, held, rejected, did_extract = process_con(fn, cache, rejections, provided)
        except DailyCapHit as e:
            skipped_note = f"Daily quota hit on {e}; remaining cons pick up next run."
            break
        if did_extract:
            extracts += 1
        base = os.path.basename(fn)
        for c in changes:
            c.setdefault("_file", base)
        all_changes += changes
        all_refuted += refuted
        all_held += held
        all_rejected += rejected
        if changes or refuted or held:
            log(f"{base}: +{len(changes)} applied, {len(refuted)} refuted, {len(held)} held")

    save_cache(cache)

    if all_changes and not DRY_RUN:
        subprocess.run(["uv", "run", os.path.join(DATA_DIR, "tools", "format.py"),
                        *sorted({os.path.join(DATA_DIR, c["_file"]) for c in all_changes})],
                       check=False)

    summary = render_summary(all_changes, all_refuted, all_held, all_rejected, skipped_note)
    if os.environ.get("SUMMARY_FILE"):
        with open(os.environ["SUMMARY_FILE"], "w") as f:
            f.write(summary)
    print(summary)

    if PUSH and not DRY_RUN and all_changes:
        publish(summary)
    elif all_changes:
        log(f"\n{len(all_changes)} change(s) staged in {DATA_DIR} (PUSH not set — nothing pushed)")


if __name__ == "__main__":
    main()
