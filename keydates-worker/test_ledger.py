#!/usr/bin/env python3
"""Functional test for reapply_outstanding(): replays the production clobber
scenario from consfyi/bsky-event-ingester#17 without git, gh, or model calls."""
import datetime
import importlib.util
import json
import os
import sys
import tempfile

tmp = tempfile.mkdtemp(prefix="ledger-test-")
data_dir = os.path.join(tmp, "data")
os.makedirs(data_dir)
os.environ["DATA_DIR"] = data_dir
os.environ["CACHE_FILE"] = os.path.join(tmp, "cache", "verdict_cache.json")

spec = importlib.util.spec_from_file_location(
    "kw", os.path.join(os.path.dirname(os.path.abspath(__file__)), "keydates_worker.py"))
kw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kw)
# no venue zones unless a run sets them: the ledger path must never fetch the
# live events feed from a test
kw._event_tz_cache = {}

# edition dates derive from TODAY: reapply_outstanding prunes any entry whose
# event ended more than 2 days ago, so hardcoded dates would silently stop
# exercising merge() once the calendar passes them
_A_START = kw.TODAY + datetime.timedelta(days=30)
_B_START = kw.TODAY + datetime.timedelta(days=60)
MAIN_A = {"events": [{"id": "con-a-2026", "startDate": _A_START.isoformat(),
                      "endDate": (_A_START + datetime.timedelta(days=2)).isoformat()}]}
MAIN_B = {"events": [{"id": "con-b-2026", "startDate": _B_START.isoformat(),
                      "endDate": (_B_START + datetime.timedelta(days=2)).isoformat()}]}

def write_main_state(extra_a=None):
    """Simulate sync_checkout_to_main(): files reset to origin/main."""
    a = json.loads(json.dumps(MAIN_A))
    if extra_a:
        a["events"][0]["keyDates"] = extra_a
    with open(os.path.join(data_dir, "con-a.json"), "w") as f:
        json.dump(a, f)
    with open(os.path.join(data_dir, "con-b.json"), "w") as f:
        json.dump(json.loads(json.dumps(MAIN_B)), f)

def change(event_id, file, date, asof, cat="registration", kind="opens"):
    return {"event_id": event_id, "category": cat, "kind": kind, "date": date,
            "source": f"https://bsky.app/x/{date}", "asOf": asof,
            "confidence": 0.9, "_file": file, "_post_text": "post text", "verb": "add"}

def read(f):
    with open(os.path.join(data_dir, f)) as fh:
        return json.load(fh)

fails = []
def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)

# Run 1 (the sweep): applies X to con-a. Files already hold X (merge ran in
# process_con); ledger folds it in, nothing carried.
write_main_state()
X = change("con-a-2026", "con-a.json", "2026-08-01", "2026-07-01T00:00:00Z")
carried = kw.reapply_outstanding([X], [])
check("run1: nothing carried", carried == [])
check("run1: ledger holds X", len(kw.load_outstanding()) == 1)

# Run 2 (single detection for con-b — THE CLOBBER): checkout reset to main,
# X is gone from the file; run only produced Y for con-b.
write_main_state()
Y = change("con-b-2026", "con-b.json", "2026-09-15", "2026-07-02T00:00:00Z")
carried = kw.reapply_outstanding([Y], [])
a_kd = read("con-a.json")["events"][0].get("keyDates", {})
check("run2: X re-applied to con-a file", a_kd.get("registration", {}).get("opens", {}).get("date") == "2026-08-01")
check("run2: X carried into summary set", len(carried) == 1 and carried[0]["event_id"] == "con-a-2026")
check("run2: ledger holds X and Y", len(kw.load_outstanding()) == 2)

# Run 3: X has merged upstream (main now contains it); no run changes.
write_main_state(extra_a={"registration": {"opens": {"date": "2026-08-01",
    "source": X["source"], "asOf": X["asOf"], "confidence": 0.9}}})
carried = kw.reapply_outstanding([], [])
led = kw.load_outstanding()
check("run3: X pruned after merging upstream", not any("con-a" in k for k in led))
check("run3: Y still outstanding and re-applied", any("con-b" in k for k in led)
      and ((read("con-b.json")["events"][0].get("keyDates") or {})
           .get("registration", {}).get("opens", {}).get("date")) == "2026-09-15")

# Run 4: Y gets human-curated upstream (different value, no importer fields) —
# ledger must NOT clobber it and must prune Y.
write_main_state()
b = read("con-b.json")
b["events"][0]["keyDates"] = {"registration": {"opens": {"date": "2026-09-20"}}}  # curated: no source/asOf
with open(os.path.join(data_dir, "con-b.json"), "w") as f:
    json.dump(b, f)
carried = kw.reapply_outstanding([], [])
check("run4: curated value untouched", read("con-b.json")["events"][0]["keyDates"]["registration"]["opens"]["date"] == "2026-09-20")
check("run4: Y pruned (curated wins)", kw.load_outstanding() == {})

# Run 5: newer-asOf fold guard — ledger holds newer source for a slot, a run
# re-proposes an older post for the same slot; ledger must keep the newer one.
write_main_state()
NEW = change("con-a-2026", "con-a.json", "2026-08-05", "2026-07-05T00:00:00Z")
kw.reapply_outstanding([NEW], [])
OLD = change("con-a-2026", "con-a.json", "2026-08-01", "2026-07-01T00:00:00Z")
kw.reapply_outstanding([OLD], [])
led = kw.load_outstanding()
entry = next(iter(led.values()))
check("run5: ledger kept the newer source", entry["asOf"] == "2026-07-05T00:00:00Z")

# Run 6: rejected entries are dropped on re-apply.
write_main_state()
kw.save_outstanding({kw.outstanding_key(X): {k: X.get(k) for k in
    ("event_id", "category", "kind", "date", "source", "asOf", "confidence", "_file", "_post_text")}})
rejections = [{"event_id": "con-a-2026", "category": "registration", "kind": "opens",
               "date": "2026-08-01"}]
carried = kw.reapply_outstanding([], rejections)
check("run6: rejected entry dropped, not carried", carried == [] and kw.load_outstanding() == {})
check("run6: rejected entry not written to file", "keyDates" not in read("con-a.json")["events"][0])

def save_ledger(*entries):
    kw.save_outstanding({kw.outstanding_key(e): {k: e.get(k) for k in
        ("event_id", "category", "kind", "date", "source", "asOf", "confidence",
         "_file", "_post_text")} for e in entries})

# Run 7: a corrupted ledger file must not crash a run — load_outstanding
# returns {} and reapply proceeds cleanly.
write_main_state()
os.makedirs(os.path.dirname(kw.OUTSTANDING_FILE), exist_ok=True)
with open(kw.OUTSTANDING_FILE, "wb") as f:
    f.write(b"\x00\x01 not json {{{")
check("run7: corrupt ledger loads as empty", kw.load_outstanding() == {})
try:
    carried = kw.reapply_outstanding([], [])
    crashed = False
except Exception:
    crashed = True
    carried = None
check("run7: reapply survives corrupt ledger", not crashed and carried == [])

# Run 8: a ledger entry with an empty _file is skipped and dropped.
write_main_state()
save_ledger(change("con-a-2026", "", "2026-08-01", "2026-07-01T00:00:00Z"))
carried = kw.reapply_outstanding([], [])
check("run8: empty _file entry dropped, not carried", carried == [] and kw.load_outstanding() == {})

# Run 9: an entry whose event_id no longer exists in the con file is pruned.
write_main_state()
save_ledger(change("con-a-9999", "con-a.json", "2026-08-01", "2026-07-01T00:00:00Z"))
carried = kw.reapply_outstanding([], [])
check("run9: removed-edition entry pruned", carried == [] and kw.load_outstanding() == {})

# Run 10: two outstanding entries hitting the SAME con file must BOTH land —
# the carried loop re-reads the file per entry, so a last-write-wins refactor
# (loading the con once outside the loop) would regress this.
write_main_state()
save_ledger(
    change("con-a-2026", "con-a.json", "2026-08-01", "2026-07-01T00:00:00Z", cat="registration"),
    change("con-a-2026", "con-a.json", "2026-08-10", "2026-07-01T00:00:00Z", cat="hotel"))
carried = kw.reapply_outstanding([], [])
kd10 = read("con-a.json")["events"][0].get("keyDates", {})
check("run10: both same-file entries present in file",
      kd10.get("registration", {}).get("opens", {}).get("date") == "2026-08-01"
      and kd10.get("hotel", {}).get("opens", {}).get("date") == "2026-08-10")
check("run10: both entries carried", len(carried) == 2)

# Run 11: an entry for a past edition (endDate < today) is pruned — process_con
# never re-proposes it, so carrying it would pin it in every PR forever.
# (Module reads TODAY at import; use a fixture edition safely in the past.)
with open(os.path.join(data_dir, "con-a.json"), "w") as f:
    json.dump({"events": [{"id": "con-a-past", "startDate": "2020-01-01", "endDate": "2020-01-03"}]}, f)
with open(os.path.join(data_dir, "con-b.json"), "w") as f:
    json.dump(json.loads(json.dumps(MAIN_B)), f)
save_ledger(change("con-a-past", "con-a.json", "2020-01-05", "2019-12-20T00:00:00Z"))
carried = kw.reapply_outstanding([], [])
check("run11: past-edition entry pruned", carried == [] and kw.load_outstanding() == {})
check("run11: nothing written to past con file", "keyDates" not in read("con-a.json")["events"][0])

# Run 12: a traversal _file is dropped and nothing is written outside DATA_DIR.
write_main_state()
save_ledger(change("con-a-2026", "../evil.json", "2026-08-01", "2026-07-01T00:00:00Z"))
carried = kw.reapply_outstanding([], [])
check("run12: traversal _file dropped, not carried", carried == [] and kw.load_outstanding() == {})
check("run12: nothing written outside DATA_DIR", not os.path.exists(os.path.join(tmp, "evil.json")))

# Run 13: a "." (directory) _file passes basename() but would raise
# IsADirectoryError on open — must be dropped without crashing the run.
write_main_state()
save_ledger(change("con-a-2026", ".", "2026-08-01", "2026-07-01T00:00:00Z"))
try:
    carried = kw.reapply_outstanding([], [])
    crashed = False
except Exception:
    crashed = True
    carried = None
check("run13: dot _file dropped without crashing", not crashed and carried == [] and kw.load_outstanding() == {})

# Run 14: an outstanding entry dated after its edition's endDate (wrong-year
# anchoring, CON-55) hits merge()'s after-end backstop on re-apply: not carried,
# not written to the con file, and pruned from the ledger — but the drop is
# surfaced via the collector so the PR's Refuted section shows it.
write_main_state()
after_end = (_A_START + datetime.timedelta(days=20)).isoformat()
save_ledger(change("con-a-2026", "con-a.json", after_end, "2026-07-01T00:00:00Z"))
dropped = []
carried = kw.reapply_outstanding([], [], dropped=dropped)
check("run14: after-endDate entry not carried", carried == [])
check("run14: after-endDate entry not written to file", "keyDates" not in read("con-a.json")["events"][0])
check("run14: after-endDate entry pruned from ledger", kw.load_outstanding() == {})
check("run14: drop surfaced with a mechanical refute verdict",
      len(dropped) == 1 and dropped[0]["_verdicts"][0]["model"] == "mechanical"
      and dropped[0]["_verdicts"][0]["verdict"] == "refute")
check("run14: dropped entry renders in the Refuted section",
      after_end in kw.render_summary([], dropped, [], [], ""))

# Run 15: a corrupt ledger ENTRY (valid file, tampered/bogus field) on the
# re-apply path is skipped wholesale by merge()'s guard — the run survives,
# writes nothing for it, and a valid sibling entry still lands.
write_main_state()
good = change("con-a-2026", "con-a.json", "2026-08-01", "2026-07-01T00:00:00Z", cat="hotel")
bad = change("con-a-2026", "con-a.json", "2026-08-02", "2026-07-01T00:00:00Z")
bad["category"] = "bogus"
save_ledger(good, bad)
try:
    carried = kw.reapply_outstanding([], [])
    crashed = False
except Exception:
    crashed = True
    carried = None
check("run15: corrupt entry skipped without crashing",
      not crashed and carried is not None and len(carried) == 1)
kd15 = read("con-a.json")["events"][0].get("keyDates", {})
check("run15: valid sibling still applied",
      kd15.get("hotel", {}).get("opens", {}).get("date") == "2026-08-01")
check("run15: bogus category never written", "bogus" not in kd15)

# Run 16: the ledger keeps a change's venue-local _post_date (CON-60) so a
# re-apply judges same-day closes by the local day, not the UTC one.
write_main_state()
C = {**change("con-a-2026", "con-a.json", "2026-08-01", "2026-07-02T00:26:00Z", kind="closes"),
     "_post_date": "2026-07-01"}
kw.reapply_outstanding([C], [])
check("run16: ledger persists _post_date",
      kw.load_outstanding()[kw.outstanding_key(C)].get("_post_date") == "2026-07-01")

# Run 17: an outstanding closes dated on its post's local day (one applied
# before CON-60 deployed) is held on re-apply: not carried, not written,
# kept in the ledger (publish() rewrites the PR body every run, so the entry
# must be re-held each run), and surfaced via the collector for the Held
# section, flagged as a first hold so main() pages ops once.
write_main_state()
same_day = {**change("con-a-2026", "con-a.json", "2026-07-01", "2026-07-02T00:26:00Z",
                     kind="closes"), "_post_date": "2026-07-01"}
kw.save_outstanding({kw.outstanding_key(same_day): same_day})
held = []
carried = kw.reapply_outstanding([], [], held=held)
check("run17: same-day close not carried", carried == [])
check("run17: same-day close not written to file", "keyDates" not in read("con-a.json")["events"][0])
check("run17: same-day close kept in the ledger",
      list(kw.load_outstanding()) == [kw.outstanding_key(same_day)])
check("run17: hold surfaced with a mechanical hold verdict",
      len(held) == 1 and len(held[0]["_verdicts"]) == 1
      and held[0]["_verdicts"][0]["verdict"] == "hold")
check("run17: first hold flagged", held[0].get("_first_hold") is True)
check("run17: held entry renders in the Held section",
      "same-day close" in kw.render_summary([], [], held, [], ""))

# Run 17b: the next run re-holds the same entry (so the rewritten PR body
# still shows it), but it is no longer a first hold: no second ops page.
write_main_state()
held = []
carried = kw.reapply_outstanding([], [], held=held)
check("run17b: re-held on the next run", carried == [] and len(held) == 1)
check("run17b: not flagged as a first hold again", not held[0].get("_first_hold"))
check("run17b: still in the ledger",
      list(kw.load_outstanding()) == [kw.outstanding_key(same_day)])

# Run 17c: /reject prunes the held entry; a hand-applied curated value does too.
write_main_state()
held = []
kw.reapply_outstanding([], [{k: same_day[k] for k in ("event_id", "category", "kind", "date")}],
                       held=held)
check("run17c: /reject prunes a held entry", held == [] and kw.load_outstanding() == {})
kw.save_outstanding({kw.outstanding_key(same_day): {**same_day, "_held": True}})
write_main_state(extra_a={"registration": {"closes": {"date": "2026-07-01"}}})
held = []
kw.reapply_outstanding([], [], held=held)
check("run17c: curated value prunes a held entry", held == [] and kw.load_outstanding() == {})

# Run 17d: a held entry that applies again (e.g. now an earlier-moving close)
# loses its _held mark, so a later re-hold counts as a first hold again.
kw.save_outstanding({kw.outstanding_key(same_day): {**same_day, "_held": True}})
write_main_state(extra_a={"registration": {"closes": {
    "date": "2026-07-31", "source": "https://bsky.app/profile/x/post/old", "asOf": "2026-06-01T00:00:00Z",
    "confidence": 0.9}}})
held = []
carried = kw.reapply_outstanding([], [], held=held)
check("run17d: earlier-moving close applies", held == [] and len(carried) == 1)
check("run17d: _held mark cleared on apply",
      "_held" not in kw.load_outstanding()[kw.outstanding_key(same_day)])

# Run 17e: a held entry was never applied, so a run change for the same slot
# from an OLDER post must still replace it in the ledger (the newer-asOf fold
# guard must not let the held entry win).
kw.save_outstanding({kw.outstanding_key(same_day): {**same_day, "_held": True}})
write_main_state()
older_run = change("con-a-2026", "con-a.json", "2026-07-31", "2026-06-20T00:00:00Z", kind="closes")
held = []
kw.reapply_outstanding([older_run], [], held=held)
e17e = kw.load_outstanding()[kw.outstanding_key(same_day)]
check("run17e: older run change replaces a held entry in the ledger",
      e17e["date"] == "2026-07-31" and "_held" not in e17e)

# Run 18: an old ledger entry with no _post_date (written before CON-60) is
# judged by the venue-local day: the 07-02T00:26Z post is 07-01 in Chicago,
# its close is 07-01, so it is held — and the computed day is persisted.
write_main_state()
old_entry = {k: v for k, v in same_day.items() if k != "_post_date"}
kw.save_outstanding({kw.outstanding_key(old_entry): old_entry})
kw._event_tz_cache = {"con-a-2026": "America/Chicago"}
held = []
carried = kw.reapply_outstanding([], [], held=held)
check("run18: no _post_date uses the venue-local day", len(held) == 1 and carried == [])
check("run18: computed _post_date persisted in the ledger",
      kw.load_outstanding()[kw.outstanding_key(old_entry)].get("_post_date") == "2026-07-01")

# Run 18b: with no venue zone (feed down) the same entry falls back to the
# UTC day (07-02 != close 07-01): not held, carried.
write_main_state()
kw.save_outstanding({kw.outstanding_key(old_entry): old_entry})
kw._event_tz_cache = {}
held = []
carried = kw.reapply_outstanding([], [], held=held)
check("run18b: no venue zone falls back to the UTC day", held == [] and len(carried) == 1)

# Run 19: a tampered ledger entry with planted _verdicts must not carry them
# into the held entry (render_summary prints verdict models unescaped).
write_main_state()
planted = {**same_day, "_verdicts": [{"model": "[x](https://evil.example)",
                                      "verdict": "confirm", "reason": "planted"}]}
kw.save_outstanding({kw.outstanding_key(planted): planted})
held = []
kw.reapply_outstanding([], [], held=held)
check("run19: planted _verdicts dropped from the held entry",
      len(held) == 1 and [v["model"] for v in held[0]["_verdicts"]] == ["mechanical"])
check("run19: planted _verdicts not persisted in the kept ledger entry",
      all("_verdicts" not in e for e in kw.load_outstanding().values()))

print()
sys.exit(1 if fails else 0)
