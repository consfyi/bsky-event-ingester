"""Tests for the source-liveness check (keydates_worker.py stage E).

Stdlib-only; appget is monkeypatched so nothing touches the network.
Run: python3 -m unittest discover -s keydates-worker
"""
import copy
import datetime
import json
import os
import sys
import tempfile
import unittest
import unittest.mock

import keydates_worker as kw

DID = "did:plc:testtesttesttesttesttest"
FUTURE = "2999-06-01"


def make_con(key_dates, did=DID, end_date=FUTURE):
    return {
        "name": "Testcon",
        "bluesky": {"did": did, "handle": "testcon.example"},
        "events": [{
            "id": "testcon-2999",
            "name": "Testcon 2999",
            "startDate": end_date,
            "endDate": end_date,
            "keyDates": key_dates,
        }],
    }


def entry(rkey, date="2999-01-01"):
    return {
        "date": date,
        "source": f"https://bsky.app/profile/testcon.example/post/{rkey}",
        "asOf": "2998-12-01T00:00:00.000Z",
        "confidence": 0.9,
    }


def uri(rkey, did=DID):
    return f"at://{did}/app.bsky.feed.post/{rkey}"


def fake_appget(alive_rkeys, profile_ok=True, fail_getposts=False):
    def _appget(method, params):
        if method == "app.bsky.feed.getPosts":
            if fail_getposts:
                return {}
            return {"posts": [{"uri": u} for u in params["uris"]
                              if u.rsplit("/", 1)[-1] in alive_rkeys]}
        if method == "app.bsky.actor.getProfile":
            return {"did": params["actor"]} if profile_ok else {}
        raise AssertionError(f"unexpected appget: {method}")
    return _appget


class CollectSourcesTest(unittest.TestCase):
    def test_builds_at_uris_from_did(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        got = kw.collect_bsky_sources(con)
        self.assertEqual([(s[0], s[2], s[3]) for s in got],
                         [(uri("3aaa"), "panels", "opens")])

    def test_skips_curated_and_malformed_sources(self):
        con = make_con({
            "registration": {"opens": {"date": "2999-01-01", "source": "https://testcon.example/reg"}},
            "hotel": {"opens": {**entry("3bbb"), "source": "https://bsky.app/profile/x/post/3bbb?ref=1"}},
        })
        self.assertEqual(kw.collect_bsky_sources(con), [])

    def test_did_in_source_url_overrides_stored_did(self):
        # a con that migrated accounts: bluesky.did is the NEW did, but an old
        # source URL still names the OLD did in its profile segment — the at-uri
        # must target the OLD repo the post actually lives in, so the migration
        # can't make every still-live source look deleted and mass-remove them
        old_did = "did:plc:oldoldoldoldoldoldold"
        con = make_con(
            {"panels": {"opens": {**entry("3aaa"),
                                  "source": f"https://bsky.app/profile/{old_did}/post/3aaa"}}},
            did="did:plc:newnewnewnewnewnewnew")
        got = kw.collect_bsky_sources(con)
        self.assertEqual([s[0] for s in got], [uri("3aaa", did=old_did)])

    def test_skips_past_editions_and_conless_dids(self):
        past = make_con({"panels": {"opens": entry("3ccc")}}, end_date="2000-01-01")
        self.assertEqual(kw.collect_bsky_sources(past), [])
        nodid = make_con({"panels": {"opens": entry("3ddd")}})
        del nodid["bluesky"]
        self.assertEqual(kw.collect_bsky_sources(nodid), [])


class LivenessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pending_file = os.path.join(self.tmp.name, "dead_pending.json")
        patcher = unittest.mock.patch.object(kw, "DEAD_PENDING_FILE", self.pending_file)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_con(self, con, name="testcon.json"):
        fn = os.path.join(self.tmp.name, name)
        with open(fn, "w") as f:
            json.dump(con, f)
        return fn

    def read_con(self, fn):
        with open(fn) as f:
            return json.load(f)

    def seed_pending(self, *rkeys, first_seen="2000-01-01"):
        """Mark uris as already observed dead on an earlier sweep, so the
        20-hours-elapsed rule lets check_source_liveness remove them. The
        date-only default also exercises the pre-timestamp pending format
        (parsed as midnight UTC)."""
        with open(self.pending_file, "w") as f:
            json.dump({uri(rk): {"first_seen": first_seen} for rk in rkeys}, f)

    def read_pending(self):
        if not os.path.exists(self.pending_file):
            return {}
        with open(self.pending_file) as f:
            return json.load(f)

    def check(self, files, **fake_kwargs):
        with unittest.mock.patch.object(kw, "appget", fake_appget(**fake_kwargs)):
            return kw.check_source_liveness(files)

    def test_dead_source_removed_and_stubs_cleaned(self):
        con = make_con({"panels": {"opens": entry("3dead")},
                        "hotel": {"opens": entry("3live")}})
        fn = self.write_con(con)
        self.seed_pending("3dead")  # already seen dead on an earlier day
        removals, flags, pending = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual((flags, pending), ([], []))
        self.assertEqual([(r["event_id"], r["category"], r["kind"], r["date"]) for r in removals],
                         [("testcon-2999", "panels", "opens", "2999-01-01")])
        after = self.read_con(fn)["events"][0]["keyDates"]
        self.assertNotIn("panels", after)  # emptied category dropped, not left as {}
        self.assertIn("hotel", after)
        self.assertEqual(self.read_pending(), {})  # removed uri leaves pending

    def test_first_sighting_pends_without_removing(self):
        con = make_con({"panels": {"opens": entry("3dead")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        removals, flags, pending = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok"})
        self.assertEqual((removals, flags), ([], []))
        self.assertEqual([(p["event_id"], p["category"], p["kind"]) for p in pending],
                         [("testcon-2999", "panels", "opens")])
        self.assertEqual(self.read_con(fn), before)
        pend = self.read_pending()
        self.assertEqual(list(pend), [uri("3dead")])
        seen = datetime.datetime.fromisoformat(pend[uri("3dead")]["first_seen"])
        self.assertLess(datetime.datetime.now(datetime.timezone.utc) - seen,
                        datetime.timedelta(minutes=5))

    def test_second_sighting_within_20h_still_pends(self):
        # runs minutes apart across UTC midnight must NOT count as two sightings
        con = make_con({"panels": {"opens": entry("3dead")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        first = (datetime.datetime.now(datetime.timezone.utc)
                 - datetime.timedelta(hours=19)).isoformat()
        self.seed_pending("3dead", first_seen=first)
        removals, _, pending = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok"})
        self.assertEqual(removals, [])
        self.assertEqual(len(pending), 1)
        self.assertEqual(self.read_con(fn), before)
        self.assertEqual(self.read_pending(),
                         {uri("3dead"): {"first_seen": first}})

    def test_second_sighting_after_20h_removes(self):
        con = make_con({"panels": {"opens": entry("3dead")}})
        fn = self.write_con(con)
        first = (datetime.datetime.now(datetime.timezone.utc)
                 - datetime.timedelta(hours=21)).isoformat()
        self.seed_pending("3dead", first_seen=first)
        removals, _, pending = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok"})
        self.assertEqual(len(removals), 1)
        self.assertEqual(pending, [])
        self.assertNotIn("keyDates", self.read_con(fn)["events"][0])

    def test_save_prunes_stale_pending_entries(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        stale = {uri("3old"): {"first_seen": (now - datetime.timedelta(days=100)).isoformat()}}
        fresh = {uri("3new"): {"first_seen": now.isoformat()}}
        kw.save_dead_pending({**stale, **fresh})
        self.assertEqual(self.read_pending(), fresh)

    def test_alive_again_clears_pending(self):
        con = make_con({"panels": {"opens": entry("3live")}})
        fn = self.write_con(con)
        self.seed_pending("3live")  # earlier sweep missed it; it's back
        removals, _, pending = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual((removals, pending), ([], []))
        self.assertEqual(self.read_pending(), {})

    def test_alive_sources_untouched(self):
        con = make_con({"panels": {"opens": entry("3live")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        removals, flags, pending = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual((removals, flags, pending), ([], [], []))
        self.assertEqual(self.read_con(fn), before)

    def test_replaced_slot_not_removed(self):
        # the sweep already amended the slot to a newer, live post before the
        # liveness check runs — the dead old post is no longer referenced
        con = make_con({"panels": {"opens": entry("3newpost", date="2999-02-02")}})
        fn = self.write_con(con)
        removals, _, _ = self.check([fn], alive_rkeys={"3newpost"})
        self.assertEqual(removals, [])
        self.assertEqual(self.read_con(fn)["events"][0]["keyDates"]["panels"]["opens"]["date"],
                         "2999-02-02")

    def write_alive_companion(self):
        """A second con with a live source, so the dataset-wide zero-alive
        degradation guard doesn't trip in per-con all-dead scenarios."""
        other = make_con({"hotel": {"opens": entry("3ok")}}, did="did:plc:othercononly")
        other["events"][0]["id"] = "othercon-2999"
        return self.write_con(other, name="othercon.json")

    def test_all_dead_with_unreachable_account_is_report_only(self):
        con = make_con({"panels": {"opens": entry("3aaa")},
                        "hotel": {"opens": entry("3bbb")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        removals, flags, pending = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok"}, profile_ok=False)
        self.assertEqual((removals, pending), ([], []))
        self.assertEqual(len(flags), 2)
        self.assertEqual(self.read_con(fn), before)
        self.assertEqual(self.read_pending(), {})  # guarded uris stay out of pending

    def test_all_dead_with_live_account_removes(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        self.seed_pending("3aaa")
        removals, flags, _ = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok"}, profile_ok=True)
        self.assertEqual(len(removals), 1)
        self.assertEqual(flags, [])
        self.assertNotIn("keyDates", self.read_con(fn)["events"][0])

    def test_zero_alive_dataset_skips_check(self):
        # a degraded appview can answer 200 with an empty posts array for live
        # uris; if NOTHING in the dataset comes back alive, assume degradation
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        self.seed_pending("3aaa")  # even a confirmed-dead uri must not be removed
        removals, flags, pending = self.check([fn], alive_rkeys=set())
        self.assertEqual((removals, flags, pending), ([], [], []))
        self.assertEqual(self.read_con(fn), before)
        self.assertEqual(self.read_pending(), {uri("3aaa"): {"first_seen": "2000-01-01"}})

    def test_unparseable_first_seen_holds_instead_of_removing(self):
        con = make_con({"panels": {"opens": entry("3dead")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        for garbage in ("not-a-date", 12345):
            with open(self.pending_file, "w") as f:
                json.dump({uri("3dead"): {"first_seen": garbage}}, f)
            removals, _, pending = self.check(
                [fn, self.write_alive_companion()], alive_rkeys={"3ok"})
            self.assertEqual(removals, [], garbage)
            self.assertEqual(len(pending), 1, garbage)
            self.assertEqual(self.read_con(fn), before)

    def test_getposts_error_skips_check(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        removals, flags, pending = self.check([fn], alive_rkeys=set(), fail_getposts=True)
        self.assertEqual((removals, flags, pending), ([], [], []))
        self.assertEqual(self.read_con(fn), before)
        self.assertEqual(self.read_pending(), {})  # error path never writes pending

    def test_dry_run_reports_without_writing(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        self.seed_pending("3aaa")
        with unittest.mock.patch.object(kw, "DRY_RUN", True):
            removals, _, _ = self.check(
                [fn, self.write_alive_companion()], alive_rkeys={"3ok"})
        self.assertEqual(len(removals), 1)
        self.assertEqual(self.read_con(fn), before)
        # DRY_RUN doesn't touch the pending file either
        self.assertEqual(self.read_pending(), {uri("3aaa"): {"first_seen": "2000-01-01"}})

    def test_later_write_failure_keeps_earlier_removals(self):
        # finding 1: a mid-loop write error on a later con file must not discard
        # removals already written to disk for an earlier file (publish() stages
        # every changed .json, so an unreported one would still ship), and the
        # failed file's removal must NOT be reported — it never reached disk
        good = make_con({"panels": {"opens": entry("3good")}})
        good_fn = self.write_con(good, name="acon.json")
        bad = make_con({"panels": {"opens": entry("3bad")}}, did="did:plc:secondcononly")
        bad["events"][0]["id"] = "secondcon-2999"
        bad_fn = self.write_con(bad, name="zcon.json")
        before_bad = copy.deepcopy(bad)
        # both confirmed-dead (old first_seen); each at-uri derives from its own con's did
        with open(self.pending_file, "w") as f:
            json.dump({uri("3good"): {"first_seen": "2000-01-01"},
                       uri("3bad", did="did:plc:secondcononly"): {"first_seen": "2000-01-01"}}, f)
        real_replace = os.replace

        def flaky_replace(src, dst):
            if str(dst).endswith("zcon.json"):
                raise OSError("disk full")
            return real_replace(src, dst)

        with unittest.mock.patch.object(kw.os, "replace", flaky_replace):
            removals, flags, pending = self.check(
                [good_fn, bad_fn, self.write_alive_companion()], alive_rkeys={"3ok"})
        # the earlier file's removal survived and reached disk...
        self.assertEqual([r["event_id"] for r in removals], ["testcon-2999"])
        self.assertNotIn("keyDates", self.read_con(good_fn)["events"][0])
        # ...the failed file kept its data and was not reported as removed
        self.assertEqual(self.read_con(bad_fn), before_bad)
        self.assertEqual((flags, pending), ([], []))

    def test_pending_save_failure_still_returns_removals(self):
        # finding 1: if persisting the dead-pending file fails, removals already
        # written to disk must still be returned — main() would otherwise blank
        # them out and skip the format/prune path while they ship via git status
        con = make_con({"panels": {"opens": entry("3dead")}})
        fn = self.write_con(con)
        self.seed_pending("3dead")
        with unittest.mock.patch.object(kw, "save_dead_pending",
                                        side_effect=OSError("disk full")):
            removals, flags, pending = self.check(
                [fn, self.write_alive_companion()], alive_rkeys={"3ok"})
        self.assertEqual(len(removals), 1)
        self.assertNotIn("keyDates", self.read_con(fn)["events"][0])

    def test_dead_across_getposts_batches_all_collected(self):
        # >25 sources forces two getPosts calls; dead uris from BOTH batches
        # must be collected (28 fake categories keeps it in a single con file)
        rkeys = [f"3k{i:02d}" for i in range(28)]
        con = make_con({f"c{i:02d}": {"opens": entry(rk)} for i, rk in enumerate(rkeys)})
        con["events"][0]["keyDates"]["calive"] = {"opens": entry("3ok")}  # 29th, alive
        fn = self.write_con(con)
        self.seed_pending(*rkeys)
        calls = []
        inner = fake_appget(alive_rkeys={"3ok"})

        def tracking(method, params):
            if method == "app.bsky.feed.getPosts":
                calls.append(list(params["uris"]))
            return inner(method, params)

        with unittest.mock.patch.object(kw, "appget", tracking):
            removals, flags, _ = kw.check_source_liveness([fn])
        self.assertEqual([len(c) for c in calls], [25, 4])
        self.assertEqual(len(removals), 28)
        self.assertEqual(flags, [])


class SummaryTest(unittest.TestCase):
    def test_markdown_metachars_in_source_render_inert(self):
        # a bsky.app-prefixed source whose profile segment smuggles a second
        # markdown link must not survive into the PR body as live markup
        evil = "https://bsky.app/profile/x)[click](mailto:a@evil.example)y/post/3aaa"
        rendered = kw.md_link("deleted source", evil)
        self.assertFalse(rendered.startswith("[deleted source]("))  # not a link
        # inert = wrapped in a code span the payload can't close early
        self.assertTrue(rendered.startswith("`") and rendered.endswith("`"))
        self.assertNotIn("`", rendered[1:-1])

    def test_summary_lists_removals_flags_and_pending(self):
        r = {"_file": "testcon.json", "event_id": "testcon-2999", "category": "panels",
             "kind": "opens", **entry("3aaa")}
        body = kw.render_summary([], [], [], [], "", removals=[r], account_flags=[r],
                                 pending=[r])
        self.assertIn("Source post deleted — entry removed", body)
        self.assertIn("Source post missing — will remove next sweep if still gone", body)
        self.assertIn("Source account unreachable", body)
        self.assertIn("testcon-2999", body)

    def test_non_bsky_source_never_rendered_as_link(self):
        bad = {"_file": "testcon.json", "event_id": "testcon-2999", "category": "panels",
               "kind": "opens", "date": "2999-01-01", "asOf": "2998-12-01T00:00:00.000Z",
               "source": "javascript:alert(document.title)"}
        applied = {**bad, "verb": "add", "confidence": 0.9, "_post_text": "post"}
        body = kw.render_summary([applied], [], [], [], "", removals=[bad],
                                 account_flags=[bad], pending=[bad])
        self.assertNotIn("](javascript:", body)  # inert text, not a link
        self.assertIn("javascript:alert", body)  # still visible to the reviewer

    def test_newline_in_url_renders_as_inert_text(self):
        sneaky = "https://bsky.app/profile/testcon.example/post/3aaa\n[x](https://evil.example)"
        out = kw.md_link("source post", sneaky)
        self.assertNotIn("](https://bsky", out)  # not rendered as a link
        self.assertNotIn("\n", out)  # whitespace collapsed, can't break the line

    def test_newline_in_asof_cannot_break_summary_line(self):
        sneaky = "2998-12-01\n\n[approve all](https://evil.example)"
        applied = {"_file": "testcon.json", "event_id": "testcon-2999", "category": "panels",
                   "kind": "opens", "date": "2999-01-01", "asOf": sneaky,
                   "source": entry("3aaa")["source"], "verb": "add", "confidence": 0.9,
                   "_post_text": "post"}
        removal = {k: applied[k] for k in ("_file", "event_id", "category", "kind",
                                           "date", "asOf", "source")}
        body = kw.render_summary([applied], [], [], [], "", removals=[removal])
        self.assertNotIn(sneaky, body)  # raw newlines collapsed
        for line in body.splitlines():  # payload can't start a fresh markdown line
            self.assertFalse(line.startswith("[approve all]"))

    def test_summary_tolerates_missing_date(self):
        r = {"_file": "testcon.json", "event_id": "testcon-2999", "category": "panels",
             "kind": "opens", "source": entry("3aaa")["source"],
             "asOf": "2998-12-01T00:00:00.000Z"}  # no "date" key
        body = kw.render_summary([], [], [], [], "", removals=[r], account_flags=[r],
                                 pending=[r])
        self.assertIn("testcon-2999", body)


class PruneOutstandingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = unittest.mock.patch.object(
            kw, "OUTSTANDING_FILE", os.path.join(self.tmp.name, "outstanding.json"))
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def ledger_entry(category, rkey):
        return {"event_id": "testcon-2999", "category": category, "kind": "opens",
                **entry(rkey)}

    def test_matching_slot_and_source_dropped_others_kept(self):
        matched = self.ledger_entry("panels", "3aaa")
        # same slot as a removal but a DIFFERENT source — must survive the prune
        same_slot = self.ledger_entry("hotel", "3ccc")
        kw.save_outstanding({kw.outstanding_key(e): e for e in (matched, same_slot)})
        kw.prune_outstanding_removals([
            {"_file": "testcon.json", **matched},
            {"_file": "testcon.json", **self.ledger_entry("hotel", "3bbb")},
        ])
        kept = kw.load_outstanding()
        self.assertEqual(list(kept), [kw.outstanding_key(same_slot)])

    def test_no_match_leaves_ledger_unchanged(self):
        e = self.ledger_entry("panels", "3aaa")
        kw.save_outstanding({kw.outstanding_key(e): e})
        kw.prune_outstanding_removals([
            {"_file": "othercon.json", **self.ledger_entry("djs", "3zzz")}])
        self.assertEqual(kw.load_outstanding(), {kw.outstanding_key(e): e})


class MainSmokeTest(unittest.TestCase):
    """End-to-end main() wiring with the network/model/git layers mocked out."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = os.path.join(self.tmp.name, "data")
        os.makedirs(self.data_dir)
        for name in ("con-a.json", "con-b.json"):
            with open(os.path.join(self.data_dir, name), "w") as f:
                json.dump({"events": []}, f)
        self.summary_file = os.path.join(self.tmp.name, "summary.md")
        state = os.path.join(self.tmp.name, "state")
        for p in [
            unittest.mock.patch.object(kw, "DATA_DIR", self.data_dir),
            unittest.mock.patch.object(kw, "CACHE_FILE", os.path.join(state, "verdict_cache.json")),
            unittest.mock.patch.object(kw, "OUTSTANDING_FILE", os.path.join(state, "outstanding.json")),
            unittest.mock.patch.object(kw, "DEAD_PENDING_FILE", os.path.join(state, "dead_pending.json")),
            unittest.mock.patch.object(kw, "REJECTIONS_FILE", os.path.join(state, "no_rejections.json")),
            unittest.mock.patch.object(kw, "MAX_EXTRACTS", 1),
            unittest.mock.patch.object(kw, "PUSH", True),
            unittest.mock.patch.object(kw, "DRY_RUN", False),
            unittest.mock.patch.object(kw, "catalog_check", lambda: None),
            unittest.mock.patch.dict(os.environ, {"SUMMARY_FILE": self.summary_file}),
            unittest.mock.patch.object(sys, "argv", ["keydates_worker.py", "--sweep"]),
        ]:
            p.start()
            self.addCleanup(p.stop)

    def test_cap_limits_liveness_files_and_removals_only_still_publishes(self):
        slot = {"event_id": "testcon-2999", "category": "panels", "kind": "opens",
                "date": "2999-01-01", "source": entry("3aaa")["source"],
                "asOf": "2998-12-01T00:00:00.000Z"}
        applied = {**slot, "confidence": 0.9, "_post_text": "post",
                   "_file": "con-a.json", "verb": "add"}
        removal = {**slot, "_file": "con-a.json"}
        ok = unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([dict(applied)], [], [], [], True)) as pc, \
             unittest.mock.patch.object(
                 kw, "check_source_liveness", return_value=([removal], [], [])) as liveness, \
             unittest.mock.patch.object(kw, "publish") as publish, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=ok) as sprun:
            kw.main()
        # MAX_EXTRACTS=1: con-b never got a full pass, so liveness only sees con-a
        self.assertEqual(pc.call_count, 1)
        liveness.assert_called_once()
        self.assertEqual([os.path.basename(f) for f in liveness.call_args[0][0]],
                         ["con-a.json"])
        # the applied slot was liveness-removed: format still ran on its file...
        fmt_calls = [c.args[0] for c in sprun.call_args_list
                     if any("format.py" in str(a) for a in c.args[0])]
        self.assertEqual(len(fmt_calls), 1)
        self.assertIn(os.path.join(self.data_dir, "con-a.json"), fmt_calls[0])
        # ...publish still happened for a removals-only outcome...
        publish.assert_called_once()
        # ...and the summary doesn't list the slot as both applied and removed
        with open(self.summary_file) as f:
            body = f.read()
        self.assertNotIn("### Applied", body)
        self.assertIn("Source post deleted", body)

    def test_format_failure_withholds_publish_but_writes_summary(self):
        removal = {"event_id": "testcon-2999", "category": "panels", "kind": "opens",
                   "date": "2999-01-01", "source": entry("3aaa")["source"],
                   "asOf": "2998-12-01T00:00:00.000Z", "_file": "con-a.json"}
        bad = unittest.mock.Mock(returncode=1, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness", return_value=([removal], [], [])), \
             unittest.mock.patch.object(kw, "publish") as publish, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=bad):
            kw.main()
        publish.assert_not_called()  # format.py exited 1 — nothing may be pushed
        with open(self.summary_file) as f:
            self.assertIn("Source post deleted", f.read())

    def test_unextracted_con_excluded_from_liveness(self):
        # finding 2: a con whose extraction pass didn't run this sweep (e.g. its
        # feed fetch failed, so appget yielded no posts) must not be liveness
        # -checked — it never had a chance to re-post a replacement for a source
        # it may have just deleted, so its still-valid date must not look dead
        def pc(fn, *a, **k):
            extracted = os.path.basename(fn) == "con-a.json"
            return ([], [], [], [], extracted)
        ok = unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(kw, "MAX_EXTRACTS", 10), \
             unittest.mock.patch.object(kw, "process_con", side_effect=pc), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness", return_value=([], [], [])) as liveness, \
             unittest.mock.patch.object(kw, "publish"), \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=ok):
            kw.main()
        liveness.assert_called_once()
        self.assertEqual([os.path.basename(f) for f in liveness.call_args[0][0]],
                         ["con-a.json"])

    def test_liveness_error_does_not_kill_the_run(self):
        ok = unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness", side_effect=RuntimeError("bad con structure")), \
             unittest.mock.patch.object(kw, "publish") as publish, \
             unittest.mock.patch.object(kw, "save_cache") as save_cache, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=ok):
            kw.main()  # must not raise
        save_cache.assert_called_once()
        publish.assert_not_called()  # nothing to publish, but we got there cleanly
        self.assertTrue(os.path.exists(self.summary_file))


class UserAgentTest(unittest.TestCase):
    def test_appview_user_agent_has_contact_path(self):
        self.assertIn("(+https://cons.fyi)", kw.APPVIEW_USER_AGENT)


def proposal(date, rkey, asof="2999-01-01T00:00:00.000Z", slot=("testcon-2999", "performances", "opens")):
    event_id, category, kind = slot
    return {"event_id": event_id, "category": category, "kind": kind,
            "date": date, "source": f"https://bsky.app/profile/testcon.example/post/{rkey}",
            "asOf": asof, "confidence": 1.0,
            "_verdicts": [{"model": "m1", "verdict": "confirm", "reason": "ok"}]}


class SameRunConflictTest(unittest.TestCase):
    def test_conflicting_dates_all_held(self):
        a = proposal("2999-05-13", "3aaa", asof="2999-05-13T00:00:00.000Z")
        b = proposal("2999-07-15", "3bbb", asof="2999-07-15T00:00:00.000Z")
        kept, conflicted = kw.hold_same_run_conflicts([a, b])
        self.assertEqual(kept, [])
        self.assertEqual(len(conflicted), 2)
        # each conflicted proposal names the competing date for the reviewer
        reason_a = conflicted[0]["_verdicts"][-1]
        self.assertEqual(reason_a["verdict"], "hold")
        self.assertIn("2999-07-15", reason_a["reason"])
        self.assertIn("2999-05-13", conflicted[1]["_verdicts"][-1]["reason"])

    def test_same_date_from_two_posts_is_not_a_conflict(self):
        a = proposal("2999-05-13", "3aaa")
        b = proposal("2999-05-13", "3bbb")
        kept, conflicted = kw.hold_same_run_conflicts([a, b])
        self.assertEqual(len(kept), 2)
        self.assertEqual(conflicted, [])

    def test_different_slots_do_not_conflict(self):
        a = proposal("2999-05-13", "3aaa")
        b = proposal("2999-07-15", "3bbb", slot=("testcon-2999", "hotel", "opens"))
        kept, conflicted = kw.hold_same_run_conflicts([a, b])
        self.assertEqual(len(kept), 2)
        self.assertEqual(conflicted, [])

    def test_cached_verdicts_list_not_mutated(self):
        # verify_proposals stores the same _verdicts list object in the verdict
        # cache; the mechanical hold verdict must not leak into it
        a = proposal("2999-05-13", "3aaa")
        b = proposal("2999-07-15", "3bbb")
        cached = a["_verdicts"]
        kw.hold_same_run_conflicts([a, b])
        self.assertEqual(len(cached), 1)

    def test_held_rendering_shows_post_link(self):
        a = proposal("2999-05-13", "3aaa")
        b = proposal("2999-07-15", "3bbb")
        _, conflicted = kw.hold_same_run_conflicts([a, b])
        body = kw.render_summary([], [], conflicted, [], "")
        self.assertIn("same-run conflict", body)
        self.assertIn("[post](https://bsky.app/profile/testcon.example/post/3aaa)", body)
        self.assertIn("[post](https://bsky.app/profile/testcon.example/post/3bbb)", body)


class RecencyReminderTest(unittest.TestCase):
    def test_amend_carries_prev_and_renders_reminder(self):
        con = make_con({"performances": {"opens": entry("3aaa", date="2999-05-13")}})
        newer = {**proposal("2999-07-15", "3bbb", asof="2999-06-01T00:00:00.000Z"),
                 "_file": "testcon.json", "_post_text": "dance battle open"}
        changes = kw.merge(con, [newer])
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["_prev"]["date"], "2999-05-13")
        body = kw.render_summary(changes, [], [], [], "")
        self.assertIn("recency-wins", body)
        self.assertIn("2999-05-13", body)
        self.assertIn("[previous post](https://bsky.app/profile/testcon.example/post/3aaa)", body)

    def test_fresh_add_has_no_reminder(self):
        con = make_con({})
        add = {**proposal("2999-07-15", "3bbb", asof="2999-06-01T00:00:00.000Z"),
               "_file": "testcon.json", "_post_text": "dance battle open"}
        changes = kw.merge(con, [add])
        self.assertEqual(len(changes), 1)
        self.assertNotIn("_prev", changes[0])
        self.assertNotIn("recency-wins", kw.render_summary(changes, [], [], [], ""))


if __name__ == "__main__":
    unittest.main()
