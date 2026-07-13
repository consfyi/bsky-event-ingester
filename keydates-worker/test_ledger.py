#!/usr/bin/env python3
"""Functional test for reapply_outstanding(): replays the production clobber
scenario from consfyi/bsky-event-ingester#17 without git, gh, or model calls."""
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

MAIN_A = {"events": [{"id": "con-a-2026", "startDate": "2026-09-01", "endDate": "2026-09-03"}]}
MAIN_B = {"events": [{"id": "con-b-2026", "startDate": "2026-10-01", "endDate": "2026-10-03"}]}

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

print()
sys.exit(1 if fails else 0)
