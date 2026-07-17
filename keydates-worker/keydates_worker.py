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
     unanimous confirm required; split verdicts are held (reported, not applied),
     as are same-run conflicts (two confirmed dates for one slot in one run)
  D. MERGE confirmed dates into the con JSON (confidence gate, never overwrite
     curated values, recency-wins, rejections-file exclusions), run format.py
  E. (sweep only) SOURCE LIVENESS — verify recorded source posts still exist;
     an entry whose post was deleted with no replacement is removed once seen
     dead in two runs at least 20 hours apart (skipped when the whole account
     is unreachable, or on any appview error)
  F. (PUSH=1 only) commit to bot/bsky-keydates, push, open/update the PR

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
# contact path so Bluesky can reach us about our appview traffic
APPVIEW_USER_AGENT = "consfyi/bsky-event-ingester (+https://cons.fyi)"
TODAY = datetime.datetime.now(datetime.timezone.utc).date()
CATEGORIES = ["registration", "hotel", "dealers", "panels", "performances", "djs", "volunteers"]
VERIFY_BATCH = 8
INPUT_BUDGET_CHARS = 24000  # ~6k tokens; free tier caps requests at 8k in
# RPM pacing per free-tier docs: low tier 15 RPM, high tier 10 RPM
MODEL_MIN_INTERVAL = {EXTRACT_MODEL: 4.5, **{m: 6.5 for m in VERIFY_MODELS}}

# cheap pre-filter so we only spend model calls on date-relevant posts.
# KEEP IN SYNC with relevant_re in bsky-event-ingester/src/con_posts.rs
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
  (a definitive "sold out" announcement for attendee tickets counts as closing,
  dated by the post — but only for registration, never for hotel)
- hotel: room block / hotel booking opening or closing
- dealers: dealers den AND/OR artist alley vendor APPLICATIONS opening or closing (both belong here)
- panels: panel/programming SUBMISSIONS (talks, workshops, meetups, activities) opening
  or closing — performances and DJ sets are NOT panels, they have their own categories
- performances: dance competition, talent/variety show, and performer AUDITION
  signups opening or closing
- djs: DJ set applications opening or closing
- volunteers: general staff/volunteer signups opening or closing (not sub-group-only calls)

DO NOT extract (these are the known failure classes — none of them qualify):
- price-tier changes, early-bird endings, "more expensive at the door" (registration stays open)
- fursuit badges, creator/media badges, sponsor upgrades (not attendee registration)
- art show, charity auction, conbook/decor art submissions (not dealers or panels)
- payment/confirmation deadlines for ALREADY-ACCEPTED applicants (not an application closing)
- "soft closing" / "closing soon" / "almost sold out" with no explicit hard date
  (a definitive attendee-tickets "sold out" IS a registration close — see above)
- hotel/room-block "sold out" posts — a block filling up is not a booking close date
- themed metaphors ("boarding gates are open") that never explicitly say what opened
- temporary pauses and resumptions ("registration will pause March 8-10", "will resume
  March 11") — a pause is not a closing and a resumption is not an opening
- "still open" reminders and follow-ups addressed to applicants ("Dealers! Your reg is
  now open!" weeks after applications opened) — only the post that announces the opening
  (or explicitly states its date) sets an opens date

Rules:
- kind is "opens" or "closes" (a submission "deadline" is closes).
- date MUST be the bare calendar date, yyyy-MM-dd. If the post states a time of day,
  drop the time and keep the date.
- Resolve relative dates against that post's own timestamp. "today"/"tonight" means the
  post's own date. A weekday reference ("this Sunday", "next Friday") means the next such
  weekday ON OR AFTER the post's date. Anything announced as upcoming ("in a few days",
  "next week") lies in the future. A same-day signal ("now open", "starts today",
  attendee-tickets "sold out") means the event happens on the post's own date, and
  overrides the weekday resolution when both appear for the same event — but not when
  they name different events ("Reg now open! Panels close this Friday" opens reg on the
  post's date and closes panels that Friday).
- Attribute to the correct edition via event_id. If the convention has MORE THAN ONE
  upcoming edition, only extract when the post carries explicit edition evidence
  (year, hashtag like #FWA2027, or an unambiguous date range).
- source MUST be the exact post URL the date came from.
- confidence 0-1 covers date AND category AND edition together. Be conservative.
- If nothing qualifies, return {"dates": []}. Never invent or guess."""

VERIFY_SYSTEM = """You are an adversarial fact-checker for convention key dates. For each numbered item,
decide "confirm" or "refute" based ONLY on the quoted post text.

Strict category definitions:
- registration = general attendee badge/membership sales opening or hard-closing. A definitive
  attendee-tickets "sold out" announcement IS a hard close, dated by the post. NOT price-tier
  increases, early-bird endings, at-the-door price changes, fursuit/creator/media/sponsor badges.
- hotel = room block / hotel booking open or close only. NOT event-suite lotteries, and NOT
  "sold out" posts — a full block is not a booking close date.
- dealers = dealers den AND artist alley vendor applications — BOTH belong to this category;
  never refute a date merely because it concerns artist alley rather than dealers den.
  NOT art show, charity auction, conbook art, or payment deadlines for accepted vendors.
- panels = panel/programming submissions (talks, workshops, meetups, activities) ONLY.
  NOT dance/performance auditions or DJ sets (separate categories), art show, creator badges.
- performances = dance competition, talent/variety show, performer audition signups.
  NOT DJ set applications, and NOT general panel submissions.
- djs = DJ set applications only.
- volunteers = general staff/volunteer signups. NOT recruitment for one named sub-group only.

Refute when ANY of: the date is a price change rather than a true open/close; the post refers to
a different edition/year than the stated event (check the edition dates given — a post written
many months before the edition, especially one predating the convention's previous edition,
almost certainly refers to that earlier edition unless it carries explicit evidence like a year
or hashtag); the "closing" is soft ("closing soon", "almost sold out") with no explicit date;
the date is not explicitly stated in the post; the category is a stretch per the definitions;
the deadline applies only to already-accepted applicants; the "close" or "open" is actually a
temporary pause or a resumption of something already open; the post is a reminder that
something is still open (or a follow-up for people already accepted) rather than the
announcement of the opening; the claimed date contradicts the post text once the open/close
event's own relative references are resolved against post_timestamp (a weekday reference
like "this Sunday" for that event means the next such weekday on or after post_timestamp)
— refute only when the weekday names the open/close itself, not when it names something
else ("Registration is NOW OPEN — see you this Sunday!" opens on the post's date; the
Sunday is the con, not the open). When uncertain, refute — a dropped true date returns
next run; a published false date misleads attendees.

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
                     "User-Agent": "consfyi/bsky-event-ingester"})
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
            urllib.request.Request(GH_CATALOG_URL, headers={"User-Agent": "consfyi/bsky-event-ingester"}),
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
    req = urllib.request.Request(url, headers={"User-Agent": APPVIEW_USER_AGENT})
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
        change = {**d, "verb": verb}
        if existing and existing.get("date") != d["date"]:
            # recency-wins reminder for the PR body: the human sees what was
            # replaced and where it came from, in case the two posts announce
            # different sign-ups rather than a correction
            change["_prev"] = {"date": existing.get("date"), "source": existing.get("source"),
                               "asOf": existing.get("asOf")}
        changes.append(change)
    # drop empty stubs
    for ev in con.get("events", []):
        kd = ev.get("keyDates")
        if kd is not None:
            for c in [c for c, v in kd.items() if not v]:
                del kd[c]
            if not kd:
                del ev["keyDates"]
    return changes


# --- source liveness (sweep only) ----------------------------------------------
# A con deleting a key-date post usually means the announcement was wrong or
# withdrawn. The sweep re-checks every importer-owned source still referenced by
# an upcoming edition; a source deleted with no replacement (recency-wins would
# already have swapped in a newer post by the time this runs) gets its entry
# removed via the bot PR, where a human reviews the removal before merge.
# the profile segment is a handle (DNS name) or a did — [a-zA-Z0-9.:-] covers
# both and, critically, admits no markdown metacharacters or whitespace, so a
# matching URL can always be rendered raw inside a markdown link
SOURCE_URL_RE = re.compile(r"\Ahttps://bsky\.app/profile/([a-zA-Z0-9.:-]+)/post/([a-zA-Z0-9._~-]+)\Z")


def collect_bsky_sources(con):
    """(at_uri, event_id, category, kind, entry) for every importer-owned
    keyDates value on an upcoming edition; [] when the con has no bluesky DID.
    at-uris use the DID the source URL itself embeds when it carries one, else
    the stored DID: a handle change never makes a live post look dead, and a
    stored-DID URL survives an account migration (see repo derivation below)."""
    did = (con.get("bluesky") or {}).get("did")
    if not did:
        return []
    upcoming = {e["id"] for e in upcoming_events(con)}
    out = []
    for ev in con.get("events", []):
        if ev["id"] not in upcoming:
            continue
        for cat, kinds in (ev.get("keyDates") or {}).items():
            for kind, entry in (kinds or {}).items():
                if not entry or not importer_owned(entry):
                    continue
                m = SOURCE_URL_RE.match(entry.get("source") or "")
                if not m:
                    continue
                # a bsky post URL's profile segment is a handle OR a did. When
                # it names a did, pin the at-uri to that repo so a con that
                # MIGRATED accounts (bluesky.did rewritten to a new did) can't
                # make its old but still-live source posts look deleted and mass
                # -remove them. A handle-segment URL keeps falling back to the
                # stored did (what survives a benign handle rename).
                profile, rkey = m.group(1), m.group(2)
                repo = profile if profile.startswith("did:") else did
                out.append((f"at://{repo}/app.bsky.feed.post/{rkey}", ev["id"], cat, kind, entry))
    return out


# a single getPosts response can transiently omit a live post (appview reindex,
# PDS blip, brief takedown), so a source is only removed after being observed
# dead in two different runs at least 20 hours apart. The pending file
# remembers the first sighting: at-uri -> {"first_seen": UTC ISO timestamp}
# (older files stored a bare date; that parses as midnight UTC of that day).
DEAD_PENDING_FILE = os.path.join(os.path.dirname(CACHE_FILE), "dead_pending.json")


def dead_sighting_elapsed(first_seen, now):
    """True when first_seen is at least 20 hours before now — long enough that
    two sightings can't both come from one transient appview gap (and runs
    minutes apart across UTC midnight no longer count as 'two days')."""
    try:
        seen = datetime.datetime.fromisoformat(first_seen)
    except (ValueError, TypeError):
        return False  # unparseable/corrupt entry: hold rather than remove
    if seen.tzinfo is None:
        seen = seen.replace(tzinfo=datetime.timezone.utc)
    return now - seen >= datetime.timedelta(hours=20)


def load_dead_pending():
    if os.path.exists(DEAD_PENDING_FILE):
        try:
            with open(DEAD_PENDING_FILE) as f:
                return json.load(f)
        except json.JSONDecodeError:
            pass
    return {}


def save_dead_pending(entries):
    if DRY_RUN:
        return
    # prune entries older than 90 days to bound growth: a pending uri whose
    # source left the dataset (superseded/curated/edition aged out) is never
    # seen alive nor removed, so it would otherwise sit here forever
    cutoff = (TODAY - datetime.timedelta(days=90)).isoformat()
    entries = {k: v for k, v in entries.items() if str(v.get("first_seen", "9999")) >= cutoff}
    os.makedirs(os.path.dirname(DEAD_PENDING_FILE), exist_ok=True)
    tmp = DEAD_PENDING_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(entries, f, indent=1)
    os.replace(tmp, DEAD_PENDING_FILE)


def check_source_liveness(files):
    """Verify recorded source posts still exist; remove entries whose source is
    gone — but only after a second dead sighting at least 20 hours after the
    first (see DEAD_PENDING_FILE above). Returns (removals, account_flags,
    bulk_flags, pending) — account_flags are entries left untouched because the
    whole account is unreachable (deactivated/suspended), where per-post
    deletion can't be inferred; bulk_flags are entries held because every one
    of the con's several sources read dead at once while the account is up
    (the signature of an account migration, not of per-post deletes);
    pending are first-sighting dead entries held for the next sweep."""
    per_file, uris = {}, set()
    for fn in files:
        with open(fn) as f:
            con = json.load(f)
        sources = collect_bsky_sources(con)
        if sources:
            per_file[fn] = (con, sources)
            uris.update(u for u, *_ in sources)

    dead = set()
    uris = sorted(uris)
    for lo in range(0, len(uris), 25):  # getPosts caps at 25 uris per call
        batch = uris[lo:lo + 25]
        res = appget("app.bsky.feed.getPosts", {"uris": batch})
        if "posts" not in res:  # appview error after retries — never remove on a failed lookup
            log("source liveness: getPosts failed; skipping the check this run")
            return [], [], [], []
        alive = {p.get("uri") for p in res["posts"]}
        dead.update(u for u in batch if u not in alive)
    if uris and len(dead) == len(uris):
        # a degraded appview can answer 200 with an empty posts array; zero
        # alive posts across the whole dataset is that, not mass deletion
        log("source liveness: no source came back alive; assuming appview degradation, skipping")
        return [], [], [], []

    pending_state = load_dead_pending()
    now = datetime.datetime.now(datetime.timezone.utc)
    removals, account_flags, bulk_flags, pending = [], [], [], []
    removed_uris = set()
    for fn, (con, sources) in sorted(per_file.items()):
        # per-file isolation: a later file's I/O error must not discard the
        # removals already written to disk for earlier files. publish() stages
        # every changed root .json via git status, so a deletion that reached
        # disk always ships in the bot PR; if it never reached removals it would
        # ship unreported, unformatted, and unpruned (and reapply_outstanding
        # would resurrect the slot next run). So we accumulate what was actually
        # applied and always return it, logging any file we couldn't finish.
        try:
            dead_here = [s for s in sources if s[0] in dead]
            if not dead_here:
                continue
            base = os.path.basename(fn)
            if len(dead_here) == len(sources):
                # every source gone at once smells like account-level unavailability,
                # not per-post deletes — only proceed if the account itself is up
                profile = appget("app.bsky.actor.getProfile", {"actor": con["bluesky"]["did"]})
                if "did" not in profile:
                    account_flags += [
                        {"_file": base, "event_id": eid, "category": cat, "kind": kind, **entry}
                        for _, eid, cat, kind, entry in dead_here
                    ]
                    continue  # stays out of pending too — the account guard owns these
                if len(sources) > 1:
                    # the account is up yet every one of several source posts
                    # reads dead — the signature of an account migration that
                    # kept its handle (handle-segment at-uris resolve against
                    # the new repo, where the old posts don't exist), not of a
                    # con deleting each announcement. Hold and flag for a human
                    # instead of auto-removing. A single-source con stays on
                    # the normal two-sighting path: one dead post carries no
                    # bulk signal, it's just a deleted post.
                    bulk_flags += [
                        {"_file": base, "event_id": eid, "category": cat, "kind": kind, **entry}
                        for _, eid, cat, kind, entry in dead_here
                    ]
                    continue  # stays out of pending too — held until a human acts
            confirmed = []
            for s in dead_here:
                u, eid, cat, kind, entry = s
                first_seen = (pending_state.get(u) or {}).get("first_seen", "")
                if first_seen and dead_sighting_elapsed(first_seen, now):
                    confirmed.append(s)  # dead twice, 20+ hours apart — really gone
                else:
                    # first sighting (or a rerun inside the 20h window): could be a
                    # transient appview miss — hold for the next sweep instead of removing
                    pending_state.setdefault(u, {"first_seen": now.isoformat()})
                    pending.append({"_file": base, "event_id": eid, "category": cat,
                                    "kind": kind, **entry})
            if not confirmed:
                continue
            by_id = {e["id"]: e for e in con.get("events", [])}
            file_removals = []
            for u, event_id, cat, kind, entry in confirmed:
                kinds = by_id[event_id]["keyDates"][cat]
                del kinds[kind]
                if not kinds:
                    del by_id[event_id]["keyDates"][cat]
                if not by_id[event_id]["keyDates"]:
                    del by_id[event_id]["keyDates"]
                file_removals.append((u, {"_file": base, "event_id": event_id, "category": cat,
                                          "kind": kind, **entry}))
            if not DRY_RUN:
                tmp = fn + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(con, f, ensure_ascii=False, indent=2)
                    f.write("\n")
                os.replace(tmp, fn)
            # commit to the returned set only past a successful write, so a
            # failed write on this file never reports a removal the con file
            # didn't receive (DRY_RUN still reports without writing)
            for u, r in file_removals:
                removals.append(r)
                removed_uris.add(u)
        except Exception as e:
            log(f"source liveness: error applying removals to {os.path.basename(fn)}: {e}")
            continue
    # a uri seen alive again is no longer pending-dead; removed ones leave too
    alive_now = set(uris) - dead
    pending_state = {u: v for u, v in pending_state.items()
                     if u not in alive_now and u not in removed_uris}
    try:
        save_dead_pending(pending_state)
    except Exception as e:
        # persisting the pending file must not raise past removals already on
        # disk: main()'s blanket except would blank them out and skip the
        # format/prune path. A lost pending sighting only costs an extra sweep.
        log(f"source liveness: could not persist dead-pending state: {e}")
    return removals, account_flags, bulk_flags, pending


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
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f, indent=1)
    os.replace(tmp, CACHE_FILE)


# --- outstanding ledger ---------------------------------------------------------
# PUSH mode resets the bot branch from origin/main on every run, so without a
# memory of earlier runs the rolling PR only ever showed the latest run's
# changes — any unmerged batch was silently discarded by the next detection
# (consfyi/bsky-event-ingester#17). The ledger remembers applied-but-unmerged
# changes so every run re-applies the full outstanding set. Entries leave the
# ledger once origin/main reflects them (merge() then produces no diff), or
# when superseded by a newer source, curated by a human, or rejected.
OUTSTANDING_FILE = os.path.join(os.path.dirname(CACHE_FILE), "outstanding.json")


def outstanding_key(d):
    return f'{d.get("event_id")}|{d.get("category")}|{d.get("kind")}'


def load_outstanding():
    if os.path.exists(OUTSTANDING_FILE):
        try:
            with open(OUTSTANDING_FILE) as f:
                return json.load(f)
        except json.JSONDecodeError:
            pass
    return {}


def save_outstanding(entries):
    os.makedirs(os.path.dirname(OUTSTANDING_FILE), exist_ok=True)
    tmp = OUTSTANDING_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(entries, f, indent=1)
    os.replace(tmp, OUTSTANDING_FILE)


def reapply_outstanding(run_changes, rejections):
    """Fold this run's changes into the ledger, re-apply every other
    outstanding entry to the fresh checkout, and prune what is no longer
    outstanding. Returns the re-applied changes (for the summary/PR)."""
    ledger = load_outstanding()
    for c in run_changes:
        key = outstanding_key(c)
        prev = ledger.get(key)
        if prev and (prev.get("asOf") or "") > (c.get("asOf") or ""):
            # extraction is non-deterministic and may re-propose an older post
            # for a slot the ledger already holds from a newer one; keep the
            # newer entry. Note this only fixes the ledger: process_con already
            # wrote the older value to the file this run, and it will keep doing
            # so every run the older post is still re-extracted, so the older
            # value can persist in the PR until that post ages out of the feed.
            continue
        ledger[key] = {k: c.get(k) for k in
                       ("event_id", "category", "kind", "date", "source",
                        "asOf", "confidence", "_file", "_post_text")}
    run_keys = {outstanding_key(c) for c in run_changes}
    kept, carried = {}, []
    for key, entry in ledger.items():
        if key in run_keys:
            kept[key] = entry
            continue
        if is_rejected(rejections, entry):
            continue
        f_name = entry.get("_file") or ""
        # _file must be a bare basename under DATA_DIR; anything with path
        # separators (or the "."/".." directory names, which basename passes
        # but open() chokes on) is a corrupt/tampered ledger entry — drop it,
        # never join it (defense in depth, mirroring series_path's slug guard)
        if not f_name or f_name in (".", "..") or f_name != os.path.basename(f_name):
            continue
        fn = os.path.join(DATA_DIR, f_name)
        if not os.path.exists(fn):
            continue
        with open(fn) as f:
            con = json.load(f)
        event = next((e for e in con.get("events", []) if e["id"] == entry["event_id"]), None)
        if event is None:
            continue  # edition removed upstream
        # process_con never re-proposes an edition past upcoming_events' cutoff
        # (endDate < today minus the deliberate 2-day grace), so a stale entry
        # would otherwise sit in every PR forever — prune it, aligned to that
        # same grace so we don't drop one process_con would still re-propose
        if (event.get("endDate") or "") < (TODAY - datetime.timedelta(days=2)).isoformat():
            continue
        changes = merge(con, [entry])
        if not changes:
            continue  # main already has it, or a newer/curated value won
        tmp = fn + ".tmp"
        with open(tmp, "w") as f:
            json.dump(con, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, fn)
        kept[key] = entry
        carried += changes
    save_outstanding(kept)
    if carried:
        log(f"re-applied {len(carried)} outstanding change(s) from earlier runs")
    return carried


def slot_key(d):
    """Identity of the exact value a liveness removal deleted: the ledger slot
    plus the source post it came from."""
    return (d.get("event_id"), d.get("category"), d.get("kind"), d.get("source"))


def prune_outstanding_removals(removals):
    """Drop ledger entries whose exact slot+source was just removed by the
    liveness check, so the next run's reapply doesn't resurrect them."""
    gone = {slot_key(r) for r in removals}
    ledger = load_outstanding()
    kept = {k: v for k, v in ledger.items() if slot_key(v) not in gone}
    if len(kept) != len(ledger):
        save_outstanding(kept)


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


def hold_same_run_conflicts(confirmed):
    """Two confirmed proposals for the same (event, category.kind) slot with
    different dates in one run are usually two different sign-ups mapped to
    the same slot (e.g. dance comp vs dance battle), not a correction —
    recency-wins must not arbitrate. Returns (kept, conflicted); conflicted
    proposals go to the Held section for a human to pick."""
    by_slot = {}
    for p in confirmed:
        by_slot.setdefault((p["event_id"], p["category"], p["kind"]), []).append(p)
    kept, conflicted = [], []
    for group in by_slot.values():
        if len({p["date"] for p in group}) == 1:
            kept.extend(group)
            continue
        for p in group:
            others = ", ".join(sorted({q["date"] for q in group} - {p["date"]}))
            # rebind rather than append: verify_proposals caches the same
            # _verdicts list object, and a mutated cache entry would hold
            # this proposal forever on later runs
            p["_verdicts"] = p["_verdicts"] + [{
                "model": "mechanical", "verdict": "hold",
                "reason": f"same-run conflict: {others} also proposed — "
                          "pick the right one by hand, /reject the other"}]
            conflicted.append(p)
    return kept, conflicted


def process_con(fn, cache, rejections, provided_posts=None, extra_post=None):
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
    if extra_post and all(p.get("url") != extra_post.get("url") for p in posts):
        # appview indexing can lag the jetstream trigger; make sure the post
        # that fired us is actually in the set we extract from
        posts = [extra_post, *posts]
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
    confirmed, conflicted = hold_same_run_conflicts(confirmed)
    held = conflicted + held
    refuted = stale_drops + refuted

    changes = []
    if confirmed:
        changes = merge(con, confirmed)
        if changes and not DRY_RUN:
            tmp = fn + ".tmp"
            with open(tmp, "w") as f:
                json.dump(con, f, ensure_ascii=False, indent=2)
                f.write("\n")
            os.replace(tmp, fn)  # atomic: a killed run can't truncate a con file
    return changes, refuted, held, rejected_skips, True


def md_inline(text, cap):
    """Collapse whitespace so attacker-influenceable text (post bodies,
    model reasons) cannot break out of its blockquote/list line in the
    PR markdown."""
    return " ".join(str(text).split())[:cap]


def md_link(label, url):
    """Render a markdown link only when the target is a verified bsky post URL;
    anything else (a tampered ledger/con file value) is rendered inside a code
    span — plain text is NOT inert, a smuggled [x](y) in it would still render
    as a live link. Backticks are stripped so the span can't be closed early."""
    if SOURCE_URL_RE.match(url or "") and not re.search(r"[()\[\]\s]", url):
        return f"[{label}]({url})"
    return "`" + md_inline(url or "(no source)", 200).replace("`", "'") + "`"


def render_summary(all_changes, all_refuted, all_held, all_rejected, skipped_note,
                   removals=(), account_flags=(), bulk_flags=(), pending=()):
    lines = ["## Key dates from Bluesky", ""]
    lines.append(f"_Extract: `{EXTRACT_MODEL}` · Verify (unanimous): `{'` + `'.join(VERIFY_MODELS)}` · {TODAY.isoformat()}_")
    if all_changes:
        lines.append("\n### Applied (unanimously verified — `/reject <event> <category>.<kind>` to drop a bad entry for good)")
        for c in all_changes:
            lines.append(f"\n**{c['_file']}** — `{c['event_id']}` {c['category']}.{c['kind']} → **{c['date']}** ({c['verb']}, conf {c['confidence']})")
            lines.append(f"> {md_inline(c['_post_text'], 400)}")
            lines.append(f"> — {md_link('source post', c['source'])} at {md_inline(c['asOf'], 40)}")
            if c.get("_prev"):
                prev = c["_prev"]
                lines.append(f"> ⚠️ recency-wins: this replaced **{md_inline(prev.get('date'), 40)}** "
                             f"({md_link('previous post', prev.get('source'))}, asOf {md_inline(prev.get('asOf'), 40)}) — "
                             f"a different sign-up rather than a correction? `/reject` this date and hand-restore the old one.")
    if all_held:
        lines.append("\n### Held — verifier disagreement or same-run conflict, needs a human (`/reject` or hand-apply)")
        for p in all_held:
            lines.append(f"- `{p['event_id']}` {p['category']}.{p['kind']} {p['date']} — {md_link('post', p.get('source'))} — " +
                         "; ".join(f"{v['model'].split('/')[-1]}: {v['verdict']} ({md_inline(v['reason'], 120)})" for v in p["_verdicts"]))
    if all_refuted:
        lines.append("\n### Refuted by verification (not applied)")
        for p in all_refuted:
            reason = next((v["reason"] for v in p["_verdicts"] if v["verdict"] == "refute"), "")
            lines.append(f"- `{p['event_id']}` {p['category']}.{p['kind']} {p['date']} — {md_inline(reason, 160)}")
    if all_rejected:
        lines.append("\n### Skipped — matches an entry in keydates_rejections.json")
        for p in all_rejected:
            lines.append(f"- `{p['event_id']}` {p['category']}.{p['kind']} {p['date']} — {p.get('_reason','')}")
    if removals:
        lines.append("\n### Source post deleted — entry removed (no replacement seen)")
        for r in removals:
            lines.append(f"- **{r['_file']}** — `{r['event_id']}` {r['category']}.{r['kind']} {r.get('date')} — "
                         f"{md_link('deleted source', r['source'])}, was asOf {md_inline(r.get('asOf'), 40)}")
    if pending:
        lines.append("\n### Source post missing — will remove next sweep if still gone")
        for r in pending:
            lines.append(f"- **{r['_file']}** — `{r['event_id']}` {r['category']}.{r['kind']} {r.get('date')} — "
                         f"{md_link('missing source', r['source'])}")
    if account_flags:
        lines.append("\n### Source account unreachable — entries left untouched (deactivated/suspended?)")
        for r in account_flags:
            lines.append(f"- **{r['_file']}** — `{r['event_id']}` {r['category']}.{r['kind']} {r.get('date')} — "
                         f"{md_link('source', r['source'])}")
    if bulk_flags:
        lines.append("\n### Every source post missing but account is live — held, needs a human "
                     "(account migration? re-source or hand-remove; nothing was auto-removed)")
        for r in bulk_flags:
            lines.append(f"- **{r['_file']}** — `{r['event_id']}` {r['category']}.{r['kind']} {r.get('date')} — "
                         f"{md_link('source', r['source'])}")
    if skipped_note:
        lines.append(f"\n_{skipped_note}_")
    body = "\n".join(lines)
    if len(body) > 60000:
        body = body[:60000] + "\n\n_…truncated; full report in worker logs._"
    return body


def git(*args, check=True):
    return subprocess.run(["git", "-C", DATA_DIR, *args], check=check, capture_output=True, text=True)


_LOCK_FD = None


def acquire_run_lock():
    """One worker at a time per DATA_DIR: concurrent runs would race on the
    git worktree, the bot branch force-push, the verdict cache, and would
    combine past the models RPM limits. Blocks until the running one exits."""
    global _LOCK_FD
    import fcntl
    lock_dir = os.path.join(DATA_DIR, ".git")
    if not os.path.isdir(lock_dir):
        lock_dir = DATA_DIR
    _LOCK_FD = open(os.path.join(lock_dir, "keydates_worker.lock"), "w")
    fcntl.flock(_LOCK_FD, fcntl.LOCK_EX)


def sync_checkout_to_main():
    """PUSH mode only: restage the bot branch from fresh origin/main so the
    checkout never drifts after the rolling PR merges (the run regenerates
    all file changes anyway)."""
    git("fetch", "origin")
    git("checkout", "-B", BOT_BRANCH, "origin/main")
    git("reset", "--hard", "origin/main")


def publish(summary):
    """Commit staged changes and open/update the rolling PR. PUSH=1 only."""
    status = git("status", "--porcelain").stdout
    # never stage worker state files (ledger, pending, cache), even if CACHE_FILE is misconfigured to
    # sit inside DATA_DIR — it is worker state, not con data
    state_names = {os.path.basename(p) for p in (OUTSTANDING_FILE, DEAD_PENDING_FILE, CACHE_FILE)}
    changed = [l[3:] for l in status.splitlines()
               if l.endswith(".json") and "/" not in l[3:] and l[3:] not in state_names]
    if not changed:
        log("nothing to publish")
        return
    git("checkout", "-B", BOT_BRANCH)
    git("add", "--", *changed)
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

    acquire_run_lock()
    if PUSH and not DRY_RUN:
        sync_checkout_to_main()
    catalog_check()
    cache = load_cache()
    rejections = load_rejections()

    def series_path(series):
        # series ids become filesystem paths under DATA_DIR — refuse anything
        # that is not a bare slug (defense in depth; ids come from the dataset)
        if not re.fullmatch(r"[a-z0-9-]+", series or ""):
            raise SystemExit(f"invalid series id: {series!r}")
        return os.path.join(DATA_DIR, series + ".json")

    targets = []  # (filename, provided_posts | None)
    if args.series:
        targets = [(series_path(args.series), None, None)]
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
        # neighbours; the spooled post itself is injected in process_con so
        # appview indexing lag can't drop the trigger
        spool_post = {k: spool.get(k) for k in ("url", "asOf", "text")}
        targets = [(series_path(series), None, spool_post)]
    else:
        files = sorted(glob.glob(os.path.join(DATA_DIR, "*.json")))
        if args.shard:
            n, m = (int(x) for x in args.shard.split("/"))
            files = [f for i, f in enumerate(files) if i % m == n - 1]
        targets = [(f, None, None) for f in files]

    all_changes, all_refuted, all_held, all_rejected = [], [], [], []
    processed = []  # files that got a full pass this run (liveness only checks these)
    extracts = 0
    skipped_note = ""
    for fn, provided, extra_post in targets:
        if not os.path.exists(fn):
            log(f"missing: {fn}")
            continue
        if extracts >= MAX_EXTRACTS:
            skipped_note = f"Stopped after {MAX_EXTRACTS} extract calls (quota guard); remaining cons pick up next run."
            break
        try:
            changes, refuted, held, rejected, did_extract = process_con(
                fn, cache, rejections, provided, extra_post)
        except DailyCapHit as e:
            skipped_note = f"Daily quota hit on {e}; remaining cons pick up next run."
            break
        except Exception as e:
            # one corrupt con file or feed hiccup must not kill the sweep
            log(f"ERROR processing {os.path.basename(fn)}: {e}")
            continue
        if did_extract:
            extracts += 1
            # liveness only re-checks cons whose extraction pass actually ran
            # this sweep. A con whose feed fetch failed (appget swallows the
            # error and yields no posts) never got the chance to re-post a
            # replacement, so its still-valid source must not be judged dead
            # here. did_extract is the conservative signal — it is also False
            # for a genuinely empty/irrelevant feed, which we likewise skip.
            processed.append(fn)
        base = os.path.basename(fn)
        for c in changes:
            c.setdefault("_file", base)
        all_changes += changes
        all_refuted += refuted
        all_held += held
        all_rejected += rejected
        if changes or refuted or held:
            log(f"{base}: +{len(changes)} applied, {len(refuted)} refuted, {len(held)} held")

    if PUSH and not DRY_RUN:
        all_changes += reapply_outstanding(all_changes, rejections)

    removals, account_flags, bulk_flags, pending = [], [], [], []
    if args.sweep:
        # after reapply_outstanding, each slot's source is the best-known post —
        # a slot amended this run already points at the replacement, so only
        # genuinely unreplaced dead sources are still referenced here
        try:
            removals, account_flags, bulk_flags, pending = check_source_liveness(processed)
        except Exception as e:
            # a malformed con structure must not kill the cache save, summary,
            # and publish for the whole run
            log(f"ERROR in source liveness check: {e}")
        if pending:
            log(f"source liveness: {len(pending)} missing source(s) pending a second sighting")
        if bulk_flags:
            log(f"source liveness: {len(bulk_flags)} entr(ies) held — all sources dead but account live (migration?)")
        if removals:
            log(f"source liveness: removed {len(removals)} entr(ies) with deleted sources")
            if PUSH and not DRY_RUN:
                prune_outstanding_removals(removals)
            # reapply_outstanding may have just re-added the very slot liveness
            # removed; drop it from the applied list so the summary doesn't show
            # it as both applied and removed (its file stays in the format set
            # via the removal entry itself)
            gone = {slot_key(r) for r in removals}
            all_changes = [c for c in all_changes if slot_key(c) not in gone]

    save_cache(cache)

    format_ok = True
    if (all_changes or removals) and not DRY_RUN:
        # cwd matters: uv's config discovery walks up from the working directory,
        # and an unsearchable foreign directory (e.g. launched via sudo from
        # another user's home) aborts uv before format.py even runs.
        fmt = subprocess.run(["uv", "run", os.path.join(DATA_DIR, "tools", "format.py"),
                              *sorted({os.path.join(DATA_DIR, c["_file"]) for c in [*all_changes, *removals]})],
                             cwd=DATA_DIR, check=False)
        format_ok = fmt.returncode == 0
        if not format_ok:
            log(f"ERROR: format.py exited {fmt.returncode} — withholding push, changes left staged")

    summary = render_summary(all_changes, all_refuted, all_held, all_rejected, skipped_note,
                             removals, account_flags, bulk_flags, pending)
    if os.environ.get("SUMMARY_FILE"):
        with open(os.environ["SUMMARY_FILE"], "w") as f:
            f.write(summary)
    print(summary)

    if PUSH and not DRY_RUN and (all_changes or removals):
        if format_ok:
            publish(summary)
    elif all_changes or removals:
        log(f"\n{len(all_changes) + len(removals)} change(s) staged in {DATA_DIR} (PUSH not set — nothing pushed)")


if __name__ == "__main__":
    main()
