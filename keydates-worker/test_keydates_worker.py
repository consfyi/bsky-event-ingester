"""Tests for the source-liveness check (keydates_worker.py stage E).

Stdlib-only; appget is monkeypatched so nothing touches the network.
Run: python3 -m unittest discover -s keydates-worker
"""
import copy
import datetime
import io
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


def did_entry(rkey, date="2999-01-01"):
    """entry() but with an already-DID-pinned source URL."""
    return {**entry(rkey, date=date),
            "source": f"https://bsky.app/profile/{DID}/post/{rkey}"}


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
        removals, flags, bulk, pending, pins = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual((flags, bulk, pending), ([], [], []))
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
        removals, flags, bulk, pending, pins = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok"})
        self.assertEqual((removals, flags, bulk), ([], [], []))
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
        removals, _, _, pending, _ = self.check(
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
        removals, _, _, pending, _ = self.check(
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
        removals, _, _, pending, _ = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual((removals, pending), ([], []))
        self.assertEqual(self.read_pending(), {})

    def test_alive_did_form_sources_untouched(self):
        con = make_con({"panels": {"opens": did_entry("3live")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        removals, flags, bulk, pending, pins = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual((removals, flags, bulk, pending, pins), ([], [], [], [], []))
        self.assertEqual(self.read_con(fn), before)

    def test_alive_handle_source_pinned_to_did(self):
        # CON-26: an alive handle-form source is rewritten to the repo DID that
        # just proved it alive, so a later account migration can't fake deletion
        con = make_con({"panels": {"opens": entry("3live")}})
        fn = self.write_con(con)
        removals, flags, bulk, pending, pins = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual((removals, flags, bulk, pending), ([], [], [], []))
        self.assertEqual([(p["event_id"], p["category"], p["kind"]) for p in pins],
                         [("testcon-2999", "panels", "opens")])
        got = self.read_con(fn)["events"][0]["keyDates"]["panels"]["opens"]
        self.assertEqual(got["source"], f"https://bsky.app/profile/{DID}/post/3live")
        self.assertEqual(got["date"], "2999-01-01")  # pinning never touches the date

    def test_dry_run_reports_pins_without_writing(self):
        con = make_con({"panels": {"opens": entry("3live")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        with unittest.mock.patch.object(kw, "DRY_RUN", True):
            _, _, _, _, pins = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual(len(pins), 1)
        self.assertEqual(self.read_con(fn), before)

    def test_replaced_slot_not_removed(self):
        # the sweep already amended the slot to a newer, live post before the
        # liveness check runs — the dead old post is no longer referenced
        con = make_con({"panels": {"opens": entry("3newpost", date="2999-02-02")}})
        fn = self.write_con(con)
        removals, _, _, _, _ = self.check([fn], alive_rkeys={"3newpost"})
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
        removals, flags, bulk, pending, pins = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok"}, profile_ok=False)
        self.assertEqual((removals, bulk, pending), ([], [], []))
        self.assertEqual(len(flags), 2)
        self.assertEqual(self.read_con(fn), before)
        self.assertEqual(self.read_pending(), {})  # guarded uris stay out of pending

    def test_all_dead_with_live_account_removes(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        self.seed_pending("3aaa")
        removals, flags, bulk, _, _ = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok"}, profile_ok=True)
        self.assertEqual(len(removals), 1)
        self.assertEqual((flags, bulk), ([], []))
        self.assertNotIn("keyDates", self.read_con(fn)["events"][0])

    def test_all_dead_multi_source_live_account_holds_and_flags(self):
        # CON-24: every one of SEVERAL source posts dead at once while the
        # account is up is the signature of an account migration that kept its
        # handle, not of a con deleting each announcement — hold and flag for
        # a human, never auto-remove, even when the 20h two-sighting rule
        # would otherwise confirm every removal
        con = make_con({"panels": {"opens": entry("3aaa")},
                        "hotel": {"opens": entry("3bbb")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        first = (datetime.datetime.now(datetime.timezone.utc)
                 - datetime.timedelta(hours=21)).isoformat()
        self.seed_pending("3aaa", "3bbb", first_seen=first)  # past the 20h window
        removals, flags, bulk, pending, pins = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok"}, profile_ok=True)
        self.assertEqual((removals, flags, pending), ([], [], []))
        self.assertEqual([(b["event_id"], b["category"], b["kind"]) for b in bulk],
                         [("testcon-2999", "panels", "opens"),
                          ("testcon-2999", "hotel", "opens")])
        self.assertEqual(self.read_con(fn), before)
        # the hold restarts the two-sighting clock: pre-hold sightings are
        # cleared so they can't confirm a removal on a later sweep
        self.assertEqual(self.read_pending(), {})

    def test_hold_then_partial_alive_restarts_two_sighting_clock(self):
        # staggered scenario: sources accrued sightings, the bulk hold fired,
        # then one source flaps back alive so the hold lifts — the still-dead
        # source must pend anew, not confirm-remove off its pre-hold sighting
        con = make_con({"panels": {"opens": entry("3aaa")},
                        "hotel": {"opens": entry("3bbb")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        first = (datetime.datetime.now(datetime.timezone.utc)
                 - datetime.timedelta(hours=21)).isoformat()
        self.seed_pending("3aaa", "3bbb", first_seen=first)
        self.check([fn, self.write_alive_companion()], alive_rkeys={"3ok"})  # hold fires
        removals, flags, bulk, pending, pins = self.check(
            [fn, self.write_alive_companion()], alive_rkeys={"3ok", "3bbb"})
        self.assertEqual((removals, flags, bulk), ([], [], []))
        self.assertEqual([(p["event_id"], p["category"], p["kind"]) for p in pending],
                         [("testcon-2999", "panels", "opens")])
        after = self.read_con(fn)["events"][0]["keyDates"]
        # the still-dead source is untouched; the alive-again one keeps its
        # date and only had its source URL DID-pinned
        self.assertEqual(after["panels"]["opens"],
                         before["events"][0]["keyDates"]["panels"]["opens"])
        self.assertEqual(after["hotel"]["opens"]["date"], "2999-01-01")
        self.assertEqual(after["hotel"]["opens"]["source"],
                         f"https://bsky.app/profile/{DID}/post/3bbb")

    def test_zero_alive_dataset_skips_check(self):
        # a degraded appview can answer 200 with an empty posts array for live
        # uris; if NOTHING in the dataset comes back alive, assume degradation
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        self.seed_pending("3aaa")  # even a confirmed-dead uri must not be removed
        removals, flags, bulk, pending, pins = self.check([fn], alive_rkeys=set())
        self.assertEqual((removals, flags, bulk, pending), ([], [], [], []))
        self.assertEqual(self.read_con(fn), before)
        self.assertEqual(self.read_pending(), {uri("3aaa"): {"first_seen": "2000-01-01"}})

    def test_unparseable_first_seen_holds_instead_of_removing(self):
        con = make_con({"panels": {"opens": entry("3dead")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        for garbage in ("not-a-date", 12345):
            with open(self.pending_file, "w") as f:
                json.dump({uri("3dead"): {"first_seen": garbage}}, f)
            removals, _, _, pending, _ = self.check(
                [fn, self.write_alive_companion()], alive_rkeys={"3ok"})
            self.assertEqual(removals, [], garbage)
            self.assertEqual(len(pending), 1, garbage)
            self.assertEqual(self.read_con(fn), before)

    def test_getposts_error_skips_check(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        removals, flags, bulk, pending, pins = self.check([fn], alive_rkeys=set(), fail_getposts=True)
        self.assertEqual((removals, flags, bulk, pending), ([], [], [], []))
        self.assertEqual(self.read_con(fn), before)
        self.assertEqual(self.read_pending(), {})  # error path never writes pending

    def test_getposts_error_notifies_ops(self):
        # the skip is silent-to-humans today (stderr only) — CON-18 pages ops
        fn = self.write_con(make_con({"panels": {"opens": entry("3aaa")}}))
        with unittest.mock.patch.object(kw, "ops_notify") as notify:
            self.check([fn], alive_rkeys=set(), fail_getposts=True)
        notify.assert_called_once()
        self.assertIn("SKIPPED", notify.call_args[0][0])

    def test_zero_alive_notifies_ops(self):
        fn = self.write_con(make_con({"panels": {"opens": entry("3aaa")}}))
        with unittest.mock.patch.object(kw, "ops_notify") as notify:
            self.check([fn], alive_rkeys=set())
        notify.assert_called_once()
        self.assertIn("degradation", notify.call_args[0][0])

    def test_dry_run_reports_without_writing(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        self.seed_pending("3aaa")
        with unittest.mock.patch.object(kw, "DRY_RUN", True):
            removals, _, _, _, _ = self.check(
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
            removals, flags, bulk, pending, pins = self.check(
                [good_fn, bad_fn, self.write_alive_companion()], alive_rkeys={"3ok"})
        # the earlier file's removal survived and reached disk...
        self.assertEqual([r["event_id"] for r in removals], ["testcon-2999"])
        self.assertNotIn("keyDates", self.read_con(good_fn)["events"][0])
        # ...the failed file kept its data and was not reported as removed
        self.assertEqual(self.read_con(bad_fn), before_bad)
        self.assertEqual((flags, bulk, pending), ([], [], []))

    def test_pending_save_failure_still_returns_removals(self):
        # finding 1: if persisting the dead-pending file fails, removals already
        # written to disk must still be returned — main() would otherwise blank
        # them out and skip the format/prune path while they ship via git status
        con = make_con({"panels": {"opens": entry("3dead")}})
        fn = self.write_con(con)
        self.seed_pending("3dead")
        with unittest.mock.patch.object(kw, "save_dead_pending",
                                        side_effect=OSError("disk full")):
            removals, flags, bulk, pending, pins = self.check(
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
            removals, flags, bulk, _, _ = kw.check_source_liveness([fn])
        self.assertEqual([len(c) for c in calls], [25, 4])
        self.assertEqual(len(removals), 28)
        self.assertEqual((flags, bulk), ([], []))


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
                                 bulk_flags=[r], pending=[r], pins=[r])
        self.assertIn("Source post deleted — entry removed", body)
        self.assertIn("Source post missing — will remove next sweep if still gone", body)
        self.assertIn("Source account unreachable", body)
        self.assertIn("Every source post missing but account is live", body)
        self.assertIn("Source URLs pinned to account DID", body)
        self.assertIn("**testcon.json** — 1 source URL(s) pinned", body)
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


class SourceIdentTest(unittest.TestCase):
    def test_pin_source_url(self):
        handle_url = entry("3aaa")["source"]
        pinned = kw.pin_source_url(handle_url, DID)
        self.assertEqual(pinned, f"https://bsky.app/profile/{DID}/post/3aaa")
        # already pinned, non-bsky, and malformed inputs pass through untouched
        self.assertEqual(kw.pin_source_url(pinned, "did:plc:other"), pinned)
        for url in ("https://testcon.example/reg", "", None):
            self.assertEqual(kw.pin_source_url(url, DID), url)
        # a DID that would make the URL uncollectable (outside SOURCE_URL_RE)
        # leaves the original handle-form URL in place
        self.assertEqual(kw.pin_source_url(handle_url, "did:web:example.com%3A8443"),
                         handle_url)

    def test_fetch_posts_builds_urls_from_actor(self):
        feed = {"feed": [{"post": {
            "uri": f"at://{DID}/app.bsky.feed.post/3abc",
            "record": {"text": "registration opens tomorrow", "createdAt": "2998-12-01"}}}]}
        with unittest.mock.patch.object(kw, "appget", lambda method, params: feed):
            posts = kw.fetch_posts(DID)
        self.assertEqual([p["url"] for p in posts],
                         [f"https://bsky.app/profile/{DID}/post/3abc"])

    def test_handle_form_rejection_suppresses_did_form_candidate(self):
        # a /reject recorded before pinning must keep suppressing the same post
        rej = [{"event_id": "testcon-2999", "category": "panels", "kind": "opens",
                "date": "2999-01-01", "source": entry("3aaa")["source"], "reason": "no"}]
        cand = {"event_id": "testcon-2999", "category": "panels", "kind": "opens",
                "date": "2999-01-01", "source": did_entry("3aaa")["source"]}
        self.assertIsNotNone(kw.is_rejected(rej, cand))
        # ...but a genuinely different post still isn't suppressed
        other = {**cand, "source": did_entry("3zzz")["source"]}
        self.assertIsNone(kw.is_rejected(rej, other))


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

    def test_did_pinned_removal_prunes_handle_form_ledger_entry(self):
        # CON-26: after a backfill pin, a liveness removal carries the DID-form
        # URL while the ledger may still hold the handle form — same post, so
        # the entry must still be pruned (else next run resurrects the slot)
        stale = self.ledger_entry("panels", "3aaa")  # handle-form source
        kw.save_outstanding({kw.outstanding_key(stale): stale})
        kw.prune_outstanding_removals([
            {"_file": "testcon.json", **stale, "source": did_entry("3aaa")["source"]}])
        self.assertEqual(kw.load_outstanding(), {})

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


class LoadOutstandingCorruptTest(unittest.TestCase):
    """CON-35 M2: a corrupt outstanding.json must reset to {} but page ops first,
    so the silent drop of every applied-but-unmerged change reaches a human."""

    def test_corrupt_ledger_resets_and_pages_ops(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, "outstanding.json")
        with open(path, "w") as f:
            f.write("{not valid json")
        with unittest.mock.patch.object(kw, "OUTSTANDING_FILE", path), \
             unittest.mock.patch.object(kw, "ops_notify") as notify:
            result = kw.load_outstanding()
        self.assertEqual(result, {})
        notify.assert_called_once()
        self.assertIn("outstanding ledger", notify.call_args[0][0])
        self.assertIn("corrupt", notify.call_args[0][0])


class PublishFailureTest(unittest.TestCase):
    """CON-35 M3: when the PR push/update fails, the changes are committed to the
    bot branch locally but never reached the PR — publish() must page ops once
    and re-raise so the run's exit code reflects the failure."""

    def test_pr_push_failure_pages_ops_and_reraises(self):
        # git("status") reports one changed con file so publish proceeds to push;
        # git("push", ...) then raises CalledProcessError
        def fake_git(*args, check=True):
            if args[0] == "status":
                return unittest.mock.Mock(stdout=" M con-a.json\n")
            if args[0] == "push":
                raise kw.subprocess.CalledProcessError(1, ["git", "push"])
            return unittest.mock.Mock(stdout="")
        with unittest.mock.patch.object(kw, "git", side_effect=fake_git), \
             unittest.mock.patch.object(kw, "ops_notify") as notify, \
             unittest.mock.patch.object(kw, "DATA_DIR", "/tmp/data"):
            with self.assertRaises(kw.subprocess.CalledProcessError):
                kw.publish("summary body")
        notify.assert_called_once()
        self.assertIn("publishing the bot PR failed", notify.call_args[0][0])


class ProcessConPinningTest(unittest.TestCase):
    def test_process_con_pins_posts_and_dedupes_spool_twin(self):
        # ingestion-time pinning: a handle-form feed post is normalized to DID
        # form before extraction, its DID-form spooled twin dedupes against it,
        # and the stored source ends up DID-form
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        con = make_con({})
        fn = os.path.join(tmp.name, "testcon.json")
        with open(fn, "w") as f:
            json.dump(con, f)
        post = {"url": entry("3abc")["source"], "asOf": "2999-05-01T00:00:00.000Z",
                "text": "registration opens June 1"}
        did_twin = {**post, "url": did_entry("3abc")["source"]}
        seen = {}

        def fake_extract(con_, events, posts, tz="UTC"):
            seen["posts"] = posts
            return [{"event_id": "testcon-2999", "category": "registration",
                     "kind": "opens", "date": "2999-06-01",
                     "source": posts[0]["url"], "confidence": 0.95}]

        with unittest.mock.patch.object(kw, "extract_for_con", side_effect=fake_extract), \
             unittest.mock.patch.object(kw, "load_event_timezones", return_value={}), \
             unittest.mock.patch.object(kw, "verify_proposals",
                                        side_effect=lambda proposals, cache: (proposals, [], [])):
            changes, refuted, held, rejected, did_extract = kw.process_con(
                fn, {}, [], provided_posts=[post], extra_post=did_twin)
        self.assertTrue(did_extract)
        self.assertEqual([p["url"] for p in seen["posts"]],
                         [did_entry("3abc")["source"]])  # pinned AND twin deduped
        self.assertEqual(len(changes), 1)
        with open(fn) as f:
            stored = json.load(f)["events"][0]["keyDates"]["registration"]["opens"]
        self.assertEqual(stored["source"], did_entry("3abc")["source"])
        self.assertEqual(stored["date"], "2999-06-01")

    def test_exotic_did_falls_back_to_handle_urls(self):
        # a DID outside SOURCE_URL_RE would originate uncollectable source
        # URLs — such cons keep fetching (and storing) handle-form URLs
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        con = make_con({}, did="did:web:example.com%3A8443")
        fn = os.path.join(tmp.name, "testcon.json")
        with open(fn, "w") as f:
            json.dump(con, f)
        with unittest.mock.patch.object(kw, "fetch_posts", return_value=[]) as fp:
            result = kw.process_con(fn, {}, [])
        fp.assert_called_once_with("testcon.example")
        self.assertEqual(result, ([], [], [], [], False))  # no posts → clean bail


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
            unittest.mock.patch.object(kw, "catalog_check", lambda *a, **k: None),
            # sweep mode now fails fast unless the ops channel is configured (E)
            unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", "tok"),
            unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", "-1"),
            # ops_notify is exercised by dedicated tests; here keep it off the
            # network so wiring tests can't accidentally hit Telegram
            unittest.mock.patch.object(kw, "ops_notify"),
            # process_con is mocked in these tests, so the chat-level health
            # counter never runs — seed a healthy run so the CON-35 wholesale
            # verdict doesn't fire (the verdict has its own tests below)
            unittest.mock.patch.object(
                kw, "reset_run_health",
                lambda: kw._run_health.update(attempted=1, succeeded=1, backend_failures=0)),
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
                 kw, "check_source_liveness", return_value=([removal], [], [], [], [])) as liveness, \
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

    def test_pins_only_sweep_still_formats_and_publishes(self):
        # CON-26 backfill case: a sweep whose only outcome is DID-pinning must
        # still format the touched files and publish — otherwise the rewritten
        # URLs sit on disk unstaged until an unrelated change comes along
        pin = {"event_id": "testcon-2999", "category": "panels", "kind": "opens",
               "date": "2999-01-01", "source": did_entry("3aaa")["source"],
               "asOf": "2998-12-01T00:00:00.000Z", "_file": "con-a.json"}
        ok = unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness", return_value=([], [], [], [], [pin])), \
             unittest.mock.patch.object(kw, "publish") as publish, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=ok) as sprun:
            kw.main()
        fmt_calls = [c.args[0] for c in sprun.call_args_list
                     if any("format.py" in str(a) for a in c.args[0])]
        self.assertEqual(len(fmt_calls), 1)
        self.assertIn(os.path.join(self.data_dir, "con-a.json"), fmt_calls[0])
        publish.assert_called_once()
        with open(self.summary_file) as f:
            self.assertIn("Source URLs pinned to account DID", f.read())

    def test_format_failure_withholds_publish_but_writes_summary(self):
        removal = {"event_id": "testcon-2999", "category": "panels", "kind": "opens",
                   "date": "2999-01-01", "source": entry("3aaa")["source"],
                   "asOf": "2998-12-01T00:00:00.000Z", "_file": "con-a.json"}
        bad = unittest.mock.Mock(returncode=1, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness", return_value=([removal], [], [], [], [])), \
             unittest.mock.patch.object(kw, "publish") as publish, \
             unittest.mock.patch.object(kw, "ops_notify") as notify, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=bad):
            kw.main()
        publish.assert_not_called()  # format.py exited 1 — nothing may be pushed
        # N1: the format failure must page ops, not just log
        self.assertTrue(any("format.py failed" in c.args[0] for c in notify.call_args_list))
        with open(self.summary_file) as f:
            self.assertIn("Source post deleted", f.read())

    def test_format_timeout_withholds_publish_and_pages_ops(self):
        # N1: format.py hanging (TimeoutExpired -> rc="timeout") is a failure too —
        # publish must be withheld and ops paged, same as a non-zero exit
        removal = {"event_id": "testcon-2999", "category": "panels", "kind": "opens",
                   "date": "2999-01-01", "source": entry("3aaa")["source"],
                   "asOf": "2998-12-01T00:00:00.000Z", "_file": "con-a.json"}
        # only format.py hangs; git and everything else still return cleanly
        def run(cmd, *a, **k):
            if any("format.py" in str(arg) for arg in cmd):
                raise kw.subprocess.TimeoutExpired(cmd, 300)
            return unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness", return_value=([removal], [], [], [], [])), \
             unittest.mock.patch.object(kw, "publish") as publish, \
             unittest.mock.patch.object(kw, "ops_notify") as notify, \
             unittest.mock.patch.object(kw.subprocess, "run", side_effect=run):
            kw.main()
        publish.assert_not_called()  # format hung — nothing may be pushed
        self.assertTrue(any("format.py failed (timeout)" in c.args[0]
                            for c in notify.call_args_list))

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
                 kw, "check_source_liveness", return_value=([], [], [], [], [])) as liveness, \
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

    def test_liveness_flags_notify_ops_without_publishing(self):
        # CON-18: a sweep whose only outcome is held/pending findings publishes
        # nothing (no file changed), yet ops must still be paged with the counts
        flag = {"event_id": "testcon-2999", "category": "panels", "kind": "opens",
                "date": "2999-01-01", "source": entry("3aaa")["source"],
                "asOf": "2998-12-01T00:00:00.000Z", "_file": "con-a.json"}
        ok = unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness",
                 return_value=([], [flag], [], [flag], [])), \
             unittest.mock.patch.object(kw, "publish") as publish, \
             unittest.mock.patch.object(kw, "ops_notify") as notify, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=ok):
            kw.main()
        publish.assert_not_called()  # nothing changed on disk
        notify.assert_called_once()
        msg = notify.call_args[0][0]
        self.assertIn("account unreachable", msg)
        self.assertIn("will auto-remove next sweep", msg)

    def test_bulk_flags_page_ops_without_publishing(self):
        # CON-18: a sweep whose only outcome is a bulk hold (every source dead
        # but the account still live) changes no files, so it publishes nothing
        # — ops must still be paged with the count
        flag = {"event_id": "testcon-2999", "category": "panels", "kind": "opens",
                "date": "2999-01-01", "source": entry("3aaa")["source"],
                "asOf": "2998-12-01T00:00:00.000Z", "_file": "con-a.json"}
        ok = unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness",
                 return_value=([], [], [flag], [], [])), \
             unittest.mock.patch.object(kw, "publish") as publish, \
             unittest.mock.patch.object(kw, "ops_notify") as notify, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=ok):
            kw.main()
        publish.assert_not_called()  # nothing changed on disk
        notify.assert_called_once()
        self.assertIn("every source dead but account live", notify.call_args[0][0])

    def test_removals_context_line_rides_the_ops_alert(self):
        # T2: when a pending finding pages ops and removals also happened this
        # sweep, the removed-count line rides along in the same alert
        flag = {"event_id": "testcon-2999", "category": "panels", "kind": "opens",
                "date": "2999-01-01", "source": entry("3aaa")["source"],
                "asOf": "2998-12-01T00:00:00.000Z", "_file": "con-a.json"}
        removal = {"event_id": "testcon-2999", "category": "hotel", "kind": "opens",
                   "date": "2999-02-02", "source": entry("3bbb")["source"],
                   "asOf": "2998-12-01T00:00:00.000Z", "_file": "con-a.json"}
        ok = unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness",
                 return_value=([removal], [], [], [flag], [])), \
             unittest.mock.patch.object(kw, "publish"), \
             unittest.mock.patch.object(kw, "ops_notify") as notify, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=ok):
            kw.main()
        notify.assert_called_once()
        self.assertIn("entr(ies) removed — source post deleted", notify.call_args[0][0])

    def test_liveness_crash_pages_ops(self):
        # D2: a crash in the liveness check leaves every findings list empty, so
        # the findings alert never fires — the same silent-guardrail failure
        # CON-18 targets, via the crash path. Page ops from the except block so
        # an aborted sweep still reaches a human.
        ok = unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness", side_effect=RuntimeError("bad con structure")), \
             unittest.mock.patch.object(kw, "publish"), \
             unittest.mock.patch.object(kw, "ops_notify") as notify, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=ok):
            kw.main()  # must not raise
        notify.assert_called_once()
        self.assertIn("abort", notify.call_args[0][0].lower())

    def test_liveness_crash_alert_truncates_long_exception(self):
        # a verbose exception must not push the crash page past Telegram's
        # 4096-char cap and make the one page that matters silently fail
        ok = unittest.mock.Mock(returncode=0, stdout="")
        with unittest.mock.patch.object(
                 kw, "process_con", return_value=([], [], [], [], True)), \
             unittest.mock.patch.object(
                 kw, "check_source_liveness",
                 side_effect=RuntimeError("X" * 1000)), \
             unittest.mock.patch.object(kw, "publish"), \
             unittest.mock.patch.object(kw, "ops_notify") as notify, \
             unittest.mock.patch.object(kw.subprocess, "run", return_value=ok):
            kw.main()
        msg = notify.call_args[0][0]
        self.assertIn("X" * 500, msg)          # keeps a useful prefix
        self.assertNotIn("X" * 501, msg)       # but no more than the cap


class UserAgentTest(unittest.TestCase):
    def test_appview_user_agent_has_contact_path(self):
        self.assertIn("(+https://cons.fyi)", kw.APPVIEW_USER_AGENT)


class OpsNotifyTest(unittest.TestCase):
    """The ops-bot send path (CON-18) — best-effort, never raises, degrades to
    log-only when unconfigured, and honours DRY_RUN."""

    def test_unconfigured_is_silent_noop(self):
        opener = unittest.mock.Mock(side_effect=AssertionError("must not hit the network"))
        with unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", ""), \
             unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", ""), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", opener):
            kw.ops_notify("hi")  # must not raise, must not send
        opener.assert_not_called()

    def test_partial_config_is_silent_noop(self):
        # only one of the two secrets set (either order) must stay log-only —
        # ops_notify needs BOTH the bot token and the chat id to send
        for token, chat in (("tok", ""), ("", "-1")):
            opener = unittest.mock.Mock(side_effect=AssertionError("must not hit the network"))
            with unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", token), \
                 unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", chat), \
                 unittest.mock.patch.object(kw, "DRY_RUN", False), \
                 unittest.mock.patch.object(kw.urllib.request, "urlopen", opener):
                kw.ops_notify("hi")
            opener.assert_not_called()

    def test_sends_when_configured(self):
        opener = unittest.mock.Mock(return_value=unittest.mock.MagicMock())
        with unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", "tok123"), \
             unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", "-1009"), \
             unittest.mock.patch.object(kw, "DRY_RUN", False), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", opener):
            kw.ops_notify("hello ops")
        opener.assert_called_once()
        req = opener.call_args[0][0]
        self.assertIn("/bottok123/sendMessage", req.full_url)
        body = req.data.decode()
        self.assertIn("chat_id=-1009", body)
        self.assertIn("hello+ops", body)

    def test_send_errors_are_swallowed(self):
        opener = unittest.mock.Mock(side_effect=OSError("telegram down"))
        with unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", "tok"), \
             unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", "-1"), \
             unittest.mock.patch.object(kw, "DRY_RUN", False), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", opener):
            kw.ops_notify("boom")  # must not raise
        opener.assert_called_once()

    def test_dry_run_does_not_send(self):
        opener = unittest.mock.Mock(side_effect=AssertionError("DRY_RUN must not send"))
        with unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", "tok"), \
             unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", "-1"), \
             unittest.mock.patch.object(kw, "DRY_RUN", True), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", opener):
            kw.ops_notify("dry")
        opener.assert_not_called()


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
        # a closes amend (deadline moved) still carries _prev + the reminder;
        # opens-moved-later no longer amends (CON-30), so exercise closes here
        con = make_con({"registration": {"closes": entry("3aaa", date="2999-05-13")}})
        newer = {**proposal("2999-07-15", "3bbb", asof="2999-06-01T00:00:00.000Z",
                            slot=("testcon-2999", "registration", "closes")),
                 "_file": "testcon.json", "_post_text": "deadline extended"}
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


class OpensRecencyTest(unittest.TestCase):
    """CON-30: recency-wins is asymmetric for opens — a newer post can correct
    an opens earlier but never drag it later (that's a reminder, not a re-open).
    closes keeps full recency-wins in both directions."""

    def _newer(self, date, slot):
        # a strictly newer post (asOf 2999-06-01 beats entry()'s 2998-12-01)
        return {**proposal(date, "3bbb", asof="2999-06-01T00:00:00.000Z", slot=slot),
                "_file": "testcon.json", "_post_text": "sign up now"}

    def _date(self, con, cat, kind):
        return con["events"][0]["keyDates"][cat][kind]["date"]

    def test_opens_not_moved_later_by_a_newer_post(self):
        # existing opens 05-03; a newer "sign up now!" post says 06-08 -> ignored
        con = make_con({"panels": {"opens": entry("3aaa", date="2999-05-03")}})
        changes = kw.merge(con, [self._newer("2999-06-08", ("testcon-2999", "panels", "opens"))])
        self.assertEqual(changes, [])
        self.assertEqual(self._date(con, "panels", "opens"), "2999-05-03")

    def test_opens_corrected_earlier_still_applies(self):
        # a genuine correction to an EARLIER open date still wins
        con = make_con({"panels": {"opens": entry("3aaa", date="2999-06-08")}})
        changes = kw.merge(con, [self._newer("2999-05-03", ("testcon-2999", "panels", "opens"))])
        self.assertEqual(len(changes), 1)
        self.assertEqual(self._date(con, "panels", "opens"), "2999-05-03")
        self.assertEqual(changes[0]["_prev"]["date"], "2999-06-08")  # an amend still carries _prev

    def test_closes_still_moves_later(self):
        # closes keeps recency-wins: a later deadline (extension) applies
        con = make_con({"registration": {"closes": entry("3aaa", date="2999-07-27")}})
        changes = kw.merge(con, [self._newer("2999-08-02", ("testcon-2999", "registration", "closes"))])
        self.assertEqual(len(changes), 1)
        self.assertEqual(self._date(con, "registration", "closes"), "2999-08-02")

    def test_closes_still_moves_earlier(self):
        # and a moved-up deadline (tails-of-summer 07-27 -> 07-24) applies too
        con = make_con({"registration": {"closes": entry("3aaa", date="2999-07-27")}})
        changes = kw.merge(con, [self._newer("2999-07-24", ("testcon-2999", "registration", "closes"))])
        self.assertEqual(len(changes), 1)
        self.assertEqual(self._date(con, "registration", "closes"), "2999-07-24")


class ChatClientTest(unittest.TestCase):
    """CON-34: chat() posts to the configured (swappable) provider endpoint with
    the API key as a Bearer token and a real User-Agent."""

    def test_posts_to_configured_provider_with_auth_and_ua(self):
        captured = {}
        body = {"choices": [{"message": {"content": json.dumps({"dates": []})}}]}

        def fake_urlopen(req, timeout=None):
            captured["req"] = req
            return io.BytesIO(json.dumps(body).encode())

        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "secret-key"), \
             unittest.mock.patch.object(kw, "MODEL_CHAT_URL",
                                        "https://api.example/v1/chat/completions"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake_urlopen):
            out = kw.chat("openai/gpt-oss-20b", "sys", "usr", kw.EXTRACT_SCHEMA, "keydates")
        self.assertEqual(out, {"dates": []})
        req = captured["req"]
        self.assertEqual(req.full_url, "https://api.example/v1/chat/completions")
        self.assertEqual(req.get_method(), "POST")
        # urllib capitalizes header keys: Authorization / User-agent
        self.assertEqual(req.headers["Authorization"], "Bearer secret-key")
        self.assertTrue(req.headers["User-agent"])  # a non-empty UA (Groq WAF needs it)
        self.assertEqual(json.loads(req.data)["model"], "openai/gpt-oss-20b")

    def test_missing_api_key_raises_systemexit(self):
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", ""):
            with self.assertRaises(SystemExit):
                kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates")


class CatalogCheckTest(unittest.TestCase):
    """CON-34: catalog_check() GETs <base>/models (OpenAI {"data":[{"id"}]} shape)
    and fails fast when a configured model is absent."""

    def _urlopen(self, ids):
        captured = {}

        def fake(req, timeout=None):
            captured["req"] = req
            return io.BytesIO(json.dumps({"data": [{"id": i} for i in ids]}).encode())

        return fake, captured

    def test_gets_models_endpoint_and_passes_when_present(self):
        fake, captured = self._urlopen(["openai/gpt-oss-20b", "openai/gpt-oss-120b"])
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "MODEL_CATALOG_URL", "https://api.example/v1/models"), \
             unittest.mock.patch.object(kw, "EXTRACT_MODEL", "openai/gpt-oss-20b"), \
             unittest.mock.patch.object(kw, "VERIFY_MODELS", ["openai/gpt-oss-120b"]), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            kw.catalog_check()  # must not raise
        self.assertEqual(captured["req"].full_url, "https://api.example/v1/models")
        self.assertEqual(captured["req"].get_method(), "GET")

    def test_raises_when_configured_model_missing(self):
        fake, _ = self._urlopen(["openai/gpt-oss-20b"])  # 120b absent
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "EXTRACT_MODEL", "openai/gpt-oss-20b"), \
             unittest.mock.patch.object(kw, "VERIFY_MODELS", ["openai/gpt-oss-120b"]), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            with self.assertRaises(SystemExit):
                kw.catalog_check()


class TrimmingTest(unittest.TestCase):
    """CON-34: extract_for_con trims the payload so the ESTIMATED whole-request
    size (system prompt + payload) stays under MODEL_MAX_REQUEST_TOKENS, keeping
    at least one post."""

    def test_over_budget_con_trimmed_under_request_budget(self):
        # many long posts: their JSON alone dwarfs the request-token budget
        posts = [{"asOf": f"2999-01-{i:02d}T00:00:00Z",
                  "text": "registration opens " + "x" * 4000,
                  "url": f"https://bsky.app/profile/x/post/3p{i:02d}"}
                 for i in range(1, 40)]
        events = [{"id": "e", "name": "E", "startDate": "2999-01-01", "endDate": "2999-02-01"}]
        con = {"name": "Testcon"}
        captured = {}

        def fake_chat(model, system, user, schema, name):
            captured["user"] = user
            return {"dates": []}

        with unittest.mock.patch.object(kw, "chat", side_effect=fake_chat):
            kw.extract_for_con(con, events, posts)
        user = captured["user"]
        est = kw.estimate_tokens(kw.EXTRACT_SYSTEM, user)
        self.assertLessEqual(est, kw.MODEL_MAX_REQUEST_TOKENS)
        sent = json.loads(user)["posts"]
        self.assertGreaterEqual(len(sent), 1)          # never trims below one post
        self.assertLess(len(sent), len(posts))         # trimming actually occurred

    def test_single_oversized_post_kept(self):
        # one post larger than the whole budget must still be sent (can't drop it)
        posts = [{"asOf": "2999-01-01T00:00:00Z",
                  "text": "x" * (kw.MODEL_MAX_REQUEST_TOKENS * 8),
                  "url": "https://bsky.app/profile/x/post/3big"}]
        events = [{"id": "e", "name": "E", "startDate": "2999-01-01", "endDate": "2999-02-01"}]
        captured = {}

        def fake_chat(model, system, user, schema, name):
            captured["user"] = user
            return {"dates": []}

        with unittest.mock.patch.object(kw, "chat", side_effect=fake_chat):
            kw.extract_for_con({"name": "T"}, events, posts)
        self.assertEqual(len(json.loads(captured["user"])["posts"]), 1)


class TokenPaceTest(unittest.TestCase):
    """CON-34: the rolling-60s token limiter sleeps before a call that would
    push a model's per-minute token use over MODEL_TPM, with an injected clock
    so the decision is tested without real waiting."""

    def setUp(self):
        kw._token_window.clear()
        self.addCleanup(kw._token_window.clear)

    def test_under_budget_does_not_wait(self):
        clock = {"t": 1000.0}
        slept = []
        with unittest.mock.patch.object(kw, "MODEL_TPM", 8000):
            # two calls of 3000 tokens = 6000 in the window, under 8000
            kw.token_pace("m", 3000, now=lambda: clock["t"], sleep=lambda s: slept.append(s))
            got = kw.token_pace("m", 3000, now=lambda: clock["t"], sleep=lambda s: slept.append(s))
        self.assertEqual(slept, [])
        self.assertEqual(got, 0.0)

    def test_over_budget_waits(self):
        clock = {"t": 1000.0}
        slept = []

        def fake_sleep(s):
            slept.append(s)
            clock["t"] += s  # a real clock advances while we sleep

        with unittest.mock.patch.object(kw, "MODEL_TPM", 8000):
            # first 6000, then a 3000 call would reach 9000 > 8000 -> must wait
            kw.token_pace("m", 6000, now=lambda: clock["t"], sleep=fake_sleep)
            got = kw.token_pace("m", 3000, now=lambda: clock["t"], sleep=fake_sleep)
        self.assertEqual(len(slept), 1)
        self.assertGreater(got, 0.0)

    def test_loops_until_recent_samples_fit(self):
        # window already over MODEL_TPM with THREE live samples (11000). Waiting
        # only for the single oldest to age out leaves 8000+500 > 8000, so the
        # limiter must sleep again until the incoming call actually fits (M1).
        clock = {"t": 1059.0}
        slept = []

        def fake_sleep(s):
            slept.append(s)
            clock["t"] += s

        kw._token_window["m"] = [(1000.0, 3000), (1058.0, 4000), (1059.0, 4000)]
        with unittest.mock.patch.object(kw, "MODEL_TPM", 8000):
            kw.token_pace("m", 500, now=lambda: clock["t"], sleep=fake_sleep)
        self.assertGreaterEqual(len(slept), 2)  # single-oldest wait wasn't enough
        live = [s for s in kw._token_window["m"] if clock["t"] - s[0] < 60]
        self.assertLessEqual(sum(tok for _, tok in live), 8000)

    def test_window_ages_out_after_60s(self):
        slept = []
        with unittest.mock.patch.object(kw, "MODEL_TPM", 8000):
            kw.token_pace("m", 6000, now=lambda: 1000.0, sleep=lambda s: slept.append(s))
            # 61s later the earlier sample has aged out; a fresh 6000 fits again
            got = kw.token_pace("m", 6000, now=lambda: 1061.0, sleep=lambda s: slept.append(s))
        self.assertEqual(slept, [])
        self.assertEqual(got, 0.0)

    def test_per_model_windows_are_independent(self):
        slept = []
        with unittest.mock.patch.object(kw, "MODEL_TPM", 8000):
            kw.token_pace("a", 7000, now=lambda: 1000.0, sleep=lambda s: slept.append(s))
            got = kw.token_pace("b", 7000, now=lambda: 1000.0, sleep=lambda s: slept.append(s))
        self.assertEqual(slept, [])  # model b has its own empty window
        self.assertEqual(got, 0.0)


class ChatErrorTest(unittest.TestCase):
    """CON-34: chat()'s HTTPError branches — 413 (request too large) and a
    first-attempt 400 both return None rather than raising or retrying forever."""

    def _raise(self, code):
        def fake(req, timeout=None):
            raise kw.urllib.error.HTTPError(
                req.full_url, code, "err", {}, io.BytesIO(b"error body"))
        return fake

    def test_413_returns_none(self):
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", self._raise(413)):
            self.assertIsNone(kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates"))

    def test_400_first_attempt_returns_none(self):
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", self._raise(400)):
            self.assertIsNone(kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates"))

    def test_retry_after_fractional_over_cap_raises_dailycap(self):
        # a fractional Retry-After over the 300s cap must parse (int("301.5")
        # would ValueError) and be treated as the daily quota being gone (N1)
        def fake(req, timeout=None):
            raise kw.urllib.error.HTTPError(
                req.full_url, 429, "slow",
                {"Retry-After": "301.5"}, io.BytesIO(b""))
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            with self.assertRaises(kw.DailyCapHit):
                kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates")

    def test_retry_after_http_date_falls_back_and_retries(self):
        # an HTTP-date Retry-After must not crash: fall back to 60s and retry (N1)
        calls = {"n": 0}
        body = {"choices": [{"message": {"content": json.dumps({"dates": []})}}]}

        def fake(req, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise kw.urllib.error.HTTPError(
                    req.full_url, 429, "slow",
                    {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, io.BytesIO(b""))
            return io.BytesIO(json.dumps(body).encode())

        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.time, "sleep", lambda s: None), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            out = kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates")
        self.assertEqual(out, {"dates": []})
        self.assertEqual(calls["n"], 2)

    def test_retry_after_nonfinite_or_negative_falls_back_and_retries(self):
        # F1: "inf" overflows int(float(...)) (OverflowError) and "-5" would reach
        # time.sleep(-5); both must fall back to the 60s retry, not crash chat().
        body = {"choices": [{"message": {"content": json.dumps({"dates": []})}}]}
        for header in ("inf", "1e400", "-5"):
            with self.subTest(retry_after=header):
                calls = {"n": 0}
                slept = []

                def fake(req, timeout=None, calls=calls, header=header):
                    calls["n"] += 1
                    if calls["n"] == 1:
                        raise kw.urllib.error.HTTPError(
                            req.full_url, 429, "slow",
                            {"Retry-After": header}, io.BytesIO(b""))
                    return io.BytesIO(json.dumps(body).encode())

                with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
                     unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
                     unittest.mock.patch.object(kw.time, "sleep", lambda s, slept=slept: slept.append(s)), \
                     unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
                    out = kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates")
                self.assertEqual(out, {"dates": []})
                self.assertEqual(calls["n"], 2)
                self.assertEqual(slept, [60])  # sane fallback, never negative


class BudgetInvariantTest(unittest.TestCase):
    """M1/F2: the default token budget reserves the output allowance so a whole
    request (input estimate + output) stays under the per-minute TPM cap."""

    def test_default_budget_reserves_output(self):
        # if someone reverts the derivation to a payload-only bound, this fails
        self.assertLessEqual(
            kw.MODEL_MAX_REQUEST_TOKENS + kw.MODEL_MAX_OUTPUT_TOKENS, kw.MODEL_TPM)

    def test_chat_paces_on_input_plus_output(self):
        # spy on the tokens arg chat() hands token_pace: it must include the
        # output allowance, not just the prompt estimate (M1 output reservation)
        seen = {}
        body = {"choices": [{"message": {"content": json.dumps({"dates": []})}}]}

        def spy(model, tokens, *a, **k):
            seen["tokens"] = tokens
            return 0.0

        def fake(req, timeout=None):
            return io.BytesIO(json.dumps(body).encode())

        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", spy), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            kw.chat("m", "sys", "user", kw.EXTRACT_SCHEMA, "keydates")
        self.assertEqual(
            seen["tokens"],
            kw.estimate_tokens("sys", "user") + kw.MODEL_MAX_OUTPUT_TOKENS)


class VerifyBatchBudgetTest(unittest.TestCase):
    """M2: verify_proposals splits a large batch so each request stays under the
    per-request token budget, instead of 413-ing and stranding proposals as
    permanently 'unavailable'."""

    def _proposal(self, i):
        return {
            "event_id": f"e{i}", "category": "registration", "kind": "opens",
            "date": "2999-01-01", "source": f"https://bsky.app/profile/x/post/3v{i:02d}",
            "asOf": "2999-01-01T00:00:00Z", "confidence": 0.9,
            "_con_name": "Testcon", "_ev_dates": ("2999-01-01", "2999-02-01"),
            "_siblings": [], "_post_text": "registration opens " + "x" * 4000,
        }

    def test_large_batch_split_under_request_budget(self):
        proposals = [self._proposal(i) for i in range(20)]
        sent = []

        def fake_chat(model, system, user, schema, name):
            sent.append(user)
            items = json.loads(user)["items"]
            return {"verdicts": [{"index": it["index"], "verdict": "confirm",
                                  "reason": "ok"} for it in items]}

        with unittest.mock.patch.object(kw, "chat", side_effect=fake_chat):
            confirmed, refuted, held = kw.verify_proposals(proposals, {})
        for user in sent:
            self.assertLessEqual(
                kw.estimate_tokens(kw.VERIFY_SYSTEM, user), kw.MODEL_MAX_REQUEST_TOKENS)
        self.assertEqual(len(confirmed), 20)  # every proposal still verified
        # a single 8-item batch of these would blow the budget -> many requests
        self.assertGreater(len(sent), len(kw.VERIFY_MODELS))


class ProviderConfigTest(unittest.TestCase):
    """CON-34: env-driven provider config resolves correctly across reload."""

    def tearDown(self):
        import importlib
        importlib.reload(kw)  # restore module config from the ambient environ

    def test_groq_api_key_alias_resolves(self):
        import importlib
        with unittest.mock.patch.dict(os.environ, clear=False):
            os.environ.pop("MODEL_API_KEY", None)
            os.environ["GROQ_API_KEY"] = "groq-secret"
            importlib.reload(kw)
            self.assertEqual(kw.MODEL_API_KEY, "groq-secret")

    def test_base_url_trailing_slash_no_double_slash(self):
        import importlib
        with unittest.mock.patch.dict(
                os.environ, {"MODEL_BASE_URL": "https://api.example/v1/"}, clear=False):
            importlib.reload(kw)
            self.assertEqual(kw.MODEL_CHAT_URL, "https://api.example/v1/chat/completions")
            self.assertEqual(kw.MODEL_CATALOG_URL, "https://api.example/v1/models")


class BackendUnavailableTest(unittest.TestCase):
    """CON-35 A: chat() separates a backend-DOWN signal (raises
    BackendUnavailable, bumps backend_failures) from a single bad response
    (returns None, no backend_failure); a valid empty extraction is a success."""

    def setUp(self):
        kw.reset_run_health()
        self.addCleanup(kw.reset_run_health)

    def _raise_http(self, code):
        def fake(req, timeout=None):
            raise kw.urllib.error.HTTPError(req.full_url, code, "err", {}, io.BytesIO(b"body"))
        return fake

    def _ok(self, content):
        body = {"choices": [{"message": {"content": content}}]}

        def fake(req, timeout=None):
            return io.BytesIO(json.dumps(body).encode())
        return fake

    def test_gone_and_auth_statuses_raise_backend_unavailable(self):
        for code in (401, 403, 404, 410):
            with self.subTest(code=code):
                kw.reset_run_health()
                with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
                     unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
                     unittest.mock.patch.object(kw.urllib.request, "urlopen", self._raise_http(code)):
                    with self.assertRaises(kw.BackendUnavailable):
                        kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates")
                self.assertEqual(kw._run_health["backend_failures"], 1)
                self.assertEqual(kw._run_health["succeeded"], 0)

    def test_connection_error_raises_backend_unavailable(self):
        def fake(req, timeout=None):
            raise kw.urllib.error.URLError("connection refused")
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.time, "sleep", lambda s: None), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            with self.assertRaises(kw.BackendUnavailable):
                kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates")
        self.assertEqual(kw._run_health["backend_failures"], 1)

    def test_persistent_5xx_raises_backend_unavailable(self):
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.time, "sleep", lambda s: None), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", self._raise_http(503)):
            with self.assertRaises(kw.BackendUnavailable):
                kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates")
        self.assertEqual(kw._run_health["backend_failures"], 1)

    def test_400_returns_none_not_backend_failure(self):
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", self._raise_http(400)):
            self.assertIsNone(kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates"))
        self.assertEqual(kw._run_health["backend_failures"], 0)
        self.assertEqual(kw._run_health["succeeded"], 0)
        self.assertEqual(kw._run_health["attempted"], 1)

    def test_persistent_400_after_transient_returns_none_not_backend_failure(self):
        # N2: a 400 on a LATER attempt (after a transient 5xx blip) is still a
        # rejected request, not a backend outage — it must return None on ANY
        # attempt, not survive to attempt 3 and be raised as BackendUnavailable.
        calls = {"n": 0}

        def fake(req, timeout=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise kw.urllib.error.HTTPError(req.full_url, 503, "err", {}, io.BytesIO(b"body"))
            raise kw.urllib.error.HTTPError(req.full_url, 400, "err", {}, io.BytesIO(b"body"))

        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.time, "sleep", lambda s: None), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            self.assertIsNone(kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates"))
        self.assertEqual(kw._run_health["backend_failures"], 0)
        self.assertEqual(calls["n"], 2)

    def test_malformed_output_returns_none_not_backend_failure(self):
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", self._ok("not json")):
            self.assertIsNone(kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates"))
        self.assertEqual(kw._run_health["backend_failures"], 0)
        self.assertEqual(kw._run_health["succeeded"], 0)

    def test_empty_extraction_counts_as_success(self):
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen",
                                        self._ok(json.dumps({"dates": []}))):
            out = kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates")
        self.assertEqual(out, {"dates": []})
        self.assertEqual(kw._run_health["succeeded"], 1)
        self.assertEqual(kw._run_health["backend_failures"], 0)

    def test_non_dict_result_returns_none_not_success(self):
        # CodeRabbit #372: json.loads can yield a list/number/string; that's
        # malformed output, not a healthy call — chat() must return None (never
        # counted as success, never returned so extract/verify can't AttributeError).
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "token_pace", lambda *a, **k: 0.0), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen",
                                        self._ok(json.dumps([1, 2]))):
            self.assertIsNone(kw.chat("m", "s", "u", kw.EXTRACT_SCHEMA, "keydates"))
        self.assertEqual(kw._run_health["succeeded"], 0)
        self.assertEqual(kw._run_health["backend_failures"], 0)


class AppgetFailureTest(unittest.TestCase):
    """M2: appget() records an appview_failures signal when every retry is
    exhausted, so the end-of-run verdict can page on an appview outage (S1)."""

    def setUp(self):
        kw.reset_run_health()
        self.addCleanup(kw.reset_run_health)

    def test_exhausted_retries_returns_empty_and_marks_failure(self):
        def fake(req, timeout=None):
            raise kw.urllib.error.URLError("connection refused")
        with unittest.mock.patch.object(kw.time, "sleep", lambda s: None), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            out = kw.appget("app.bsky.feed.getAuthorFeed", {"actor": "did:x"})
        self.assertEqual(out, {})
        self.assertEqual(kw._run_health["appview_failures"], 1)

    def test_exhausted_retries_on_httperror_marks_failure(self):
        # HTTPError is a URLError subclass but appget catches broadly; a 5xx on
        # every attempt is still an exhausted-retry appview failure.
        def fake(req, timeout=None):
            raise kw.urllib.error.HTTPError(req.full_url, 502, "err", {}, io.BytesIO(b"body"))
        with unittest.mock.patch.object(kw.time, "sleep", lambda s: None), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            out = kw.appget("app.bsky.feed.getAuthorFeed", {"actor": "did:x"})
        self.assertEqual(out, {})
        self.assertEqual(kw._run_health["appview_failures"], 1)


class WholesaleVerdictTest(unittest.TestCase):
    """CON-35 B/C: the end-of-run verdict alerts once and exits non-zero on a
    wholesale backend failure, but leaves an ordinary run (a quiet all-empty
    week, or a lone realtime malformed post) to exit 0 so con_posts.rs reclaims
    its spool file."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = os.path.join(self.tmp.name, "data")
        os.makedirs(self.data_dir)
        # two cons so a --sweep has len(targets)==2: a single appview blip
        # (appview_failures==1 < 2) is below the F4 full-outage line and must
        # not page (the single-con full-outage case has its own test).
        for slug in ("con-a", "con-b"):
            with open(os.path.join(self.data_dir, slug + ".json"), "w") as f:
                json.dump({"events": []}, f)
        self.state = os.path.join(self.tmp.name, "state")
        self.post_file = os.path.join(self.tmp.name, "post.json")
        with open(self.post_file, "w") as f:
            json.dump({"series": "con-a", "url": "u",
                       "asOf": "2999-01-01T00:00:00Z", "text": "t"}, f)

    def _run(self, argv, health, process_con_side_effect=None):
        import contextlib
        notify = unittest.mock.Mock()
        process_con_kwargs = ({"side_effect": process_con_side_effect}
                              if process_con_side_effect is not None
                              else {"return_value": ([], [], [], [], True)})
        with contextlib.ExitStack() as stack:
            for p in [
                unittest.mock.patch.object(kw, "DATA_DIR", self.data_dir),
                unittest.mock.patch.object(kw, "CACHE_FILE", os.path.join(self.state, "verdict_cache.json")),
                unittest.mock.patch.object(kw, "OUTSTANDING_FILE", os.path.join(self.state, "outstanding.json")),
                unittest.mock.patch.object(kw, "DEAD_PENDING_FILE", os.path.join(self.state, "dead_pending.json")),
                unittest.mock.patch.object(kw, "REJECTIONS_FILE", os.path.join(self.state, "no_rej.json")),
                unittest.mock.patch.object(kw, "PUSH", False),
                unittest.mock.patch.object(kw, "DRY_RUN", False),
                unittest.mock.patch.object(kw, "catalog_check", lambda *a, **k: None),
                unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", "tok"),
                unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", "-1"),
                # zero every field first (tests share the process-wide
                # _run_health), then apply only the keys this case names
                unittest.mock.patch.object(
                    kw, "reset_run_health",
                    lambda: (kw._run_health.update(
                                 attempted=0, succeeded=0, backend_failures=0,
                                 appview_failures=0),
                             kw._run_health.update(**health))),
                unittest.mock.patch.object(kw, "process_con",
                                           **process_con_kwargs),
                unittest.mock.patch.object(kw, "check_source_liveness",
                                           return_value=([], [], [], [], [])),
                unittest.mock.patch.object(kw, "ops_notify", notify),
                unittest.mock.patch.object(sys, "argv", argv),
            ]:
                stack.enter_context(p)
            code = None
            try:
                kw.main()
            except SystemExit as e:
                code = e.code
        return code, notify

    def test_backend_failure_alerts_once_and_exits_nonzero(self):
        code, notify = self._run(["kw", "--sweep"],
                                 {"attempted": 3, "succeeded": 2, "backend_failures": 1})
        self.assertEqual(code, 1)
        self.assertEqual(notify.call_count, 1)
        self.assertIn("wholesale extraction failure", notify.call_args[0][0])

    def test_sweep_zero_successful_calls_exits_nonzero(self):
        # backend down: calls attempted but none succeeded
        code, notify = self._run(["kw", "--sweep"],
                                 {"attempted": 4, "succeeded": 0, "backend_failures": 0})
        self.assertEqual(code, 1)
        notify.assert_called_once()

    def test_sweep_appview_down_exits_nonzero(self):
        # appview unreachable: appget exhausted its retries on multiple cons, so
        # no chat() call ran (attempted==0) but appview_failures>=2 marks the
        # outage (N1: >=2, so a lone blip on a quiet shard doesn't false-page)
        code, notify = self._run(
            ["kw", "--sweep"],
            {"attempted": 0, "succeeded": 0, "backend_failures": 0, "appview_failures": 2})
        self.assertEqual(code, 1)
        notify.assert_called_once()

    def test_quiet_sweep_single_appview_blip_exits_zero(self):
        # N1: one transient appview failure on an all-quiet shard (no chat() call,
        # nothing else failed) is a blip, not an outage — it must NOT page and
        # exit 0. appview_failures must reach >=2 for the appview arm to fire.
        code, notify = self._run(
            ["kw", "--sweep"],
            {"attempted": 0, "succeeded": 0, "backend_failures": 0, "appview_failures": 1})
        self.assertIsNone(code)
        notify.assert_not_called()

    def test_quiet_sweep_no_relevant_posts_exits_zero(self):
        # S1: a shard where cons simply had no RELEVANT posts reaches no chat()
        # call (attempted==0) with a HEALTHY appview (appview_failures==0). This
        # is a genuinely quiet run, not an outage — it must NOT page and exit 0.
        code, notify = self._run(
            ["kw", "--sweep"],
            {"attempted": 0, "succeeded": 0, "backend_failures": 0, "appview_failures": 0})
        self.assertIsNone(code)
        notify.assert_not_called()

    def test_quiet_week_all_empty_exits_zero(self):
        # every con extracted successfully and returned {"dates": []} — NOT an outage
        code, notify = self._run(["kw", "--sweep"],
                                 {"attempted": 5, "succeeded": 5, "backend_failures": 0})
        self.assertIsNone(code)
        notify.assert_not_called()

    def test_realtime_malformed_post_exits_zero(self):
        # a single --post-file post that returned None (no BackendUnavailable) must
        # exit 0 so con_posts.rs reclaims the spool file rather than retaining it
        code, notify = self._run(["kw", "--post-file", self.post_file],
                                 {"attempted": 1, "succeeded": 0, "backend_failures": 0})
        self.assertIsNone(code)
        notify.assert_not_called()

    def test_realtime_backend_unavailable_exits_nonzero(self):
        code, notify = self._run(["kw", "--post-file", self.post_file],
                                 {"attempted": 1, "succeeded": 0, "backend_failures": 1})
        self.assertEqual(code, 1)
        notify.assert_called_once()

    def test_sweep_full_appview_outage_single_con_pages(self):
        # F4: a --sweep whose shard holds exactly one con under a TOTAL appview
        # outage (appview_failures==1 == len(targets)) is a full outage, not a
        # blip — it must page and exit non-zero even below the >=2 threshold.
        one_con = os.path.join(self.tmp.name, "one_con")
        os.makedirs(one_con)
        with open(os.path.join(one_con, "con-a.json"), "w") as f:
            json.dump({"events": []}, f)
        self.data_dir = one_con
        code, notify = self._run(
            ["kw", "--sweep"],
            {"attempted": 0, "succeeded": 0, "backend_failures": 0, "appview_failures": 1})
        self.assertEqual(code, 1)
        notify.assert_called_once()

    def test_sweep_daily_cap_hit_on_first_con_exits_zero(self):
        # Benign daily-quota exhaustion: the FIRST extract raises DailyCapHit
        # (chat() has already bumped attempted to 1 before raising, succeeded==0),
        # the sweep sets daily_cap_hit and breaks. This is ordinary recurring
        # quota exhaustion handled via skipped_note — it must NOT fire the
        # wholesale-failure ops page and must exit 0.
        code, notify = self._run(
            ["kw", "--sweep"],
            {"attempted": 1, "succeeded": 0, "backend_failures": 0},
            process_con_side_effect=kw.DailyCapHit("openai/gpt-oss-20b"))
        self.assertIsNone(code)
        notify.assert_not_called()

    def test_sweep_backend_outage_still_pages_when_cap_also_hit(self):
        # A genuine backend outage (backend_failures>0) must still page even if a
        # DailyCapHit also occurred — the cap must not mask a real outage.
        code, notify = self._run(
            ["kw", "--sweep"],
            {"attempted": 1, "succeeded": 0, "backend_failures": 1},
            process_con_side_effect=kw.DailyCapHit("openai/gpt-oss-20b"))
        self.assertEqual(code, 1)
        notify.assert_called_once()
        self.assertIn("wholesale extraction failure", notify.call_args[0][0])

    def test_realtime_backend_failure_page_rate_limited(self):
        # F3: two realtime backend-failure runs within the cooldown page ONCE,
        # but BOTH still exit non-zero so con_posts.rs retains each spool file.
        with unittest.mock.patch.object(kw.time, "time", return_value=1000.0):
            code1, n1 = self._run(["kw", "--post-file", self.post_file],
                                  {"attempted": 1, "succeeded": 0, "backend_failures": 1})
            code2, n2 = self._run(["kw", "--post-file", self.post_file],
                                  {"attempted": 1, "succeeded": 0, "backend_failures": 1})
        self.assertEqual(code1, 1)
        self.assertEqual(code2, 1)
        # a fresh Mock per _run; combined they page exactly once within the window
        self.assertEqual(n1.call_count + n2.call_count, 1)
        # once the cooldown elapses, a fresh outage pages again (still exit 1)
        with unittest.mock.patch.object(
                kw.time, "time", return_value=1000.0 + kw.REALTIME_PAGE_COOLDOWN + 1):
            code3, n3 = self._run(["kw", "--post-file", self.post_file],
                                  {"attempted": 1, "succeeded": 0, "backend_failures": 1})
        self.assertEqual(code3, 1)
        n3.assert_called_once()


class SweepShortCircuitTest(unittest.TestCase):
    """CON-35 S2: on a total backend outage a --sweep must bail after a few
    BackendUnavailable signals instead of grinding every con through its retries,
    so the end-of-run verdict pages in minutes, not hours."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = os.path.join(self.tmp.name, "data")
        os.makedirs(self.data_dir)
        # more cons than the failure limit, so a full grind would call every one
        for i in range(8):
            with open(os.path.join(self.data_dir, f"con-{i}.json"), "w") as f:
                json.dump({"events": []}, f)
        self.state = os.path.join(self.tmp.name, "state")

    def _run(self, backend_down):
        import contextlib
        notify = unittest.mock.Mock()

        def pc(*a, **k):
            # each con's extraction hits the down backend: chat() bumps
            # backend_failures then RAISES BackendUnavailable, which propagates out
            # of process_con to main()'s per-con handler — the real outage path the
            # short-circuit must fire on (a mock that merely returned would exercise
            # a path that can't happen and would hide the bug CodeRabbit found).
            if backend_down:
                kw._run_health["backend_failures"] += 1
                raise kw.BackendUnavailable("m: backend down")
            return ([], [], [], [], True)

        with contextlib.ExitStack() as stack:
            for p in [
                unittest.mock.patch.object(kw, "DATA_DIR", self.data_dir),
                unittest.mock.patch.object(kw, "CACHE_FILE", os.path.join(self.state, "verdict_cache.json")),
                unittest.mock.patch.object(kw, "OUTSTANDING_FILE", os.path.join(self.state, "outstanding.json")),
                unittest.mock.patch.object(kw, "DEAD_PENDING_FILE", os.path.join(self.state, "dead_pending.json")),
                unittest.mock.patch.object(kw, "REJECTIONS_FILE", os.path.join(self.state, "no_rej.json")),
                unittest.mock.patch.object(kw, "PUSH", False),
                unittest.mock.patch.object(kw, "DRY_RUN", False),
                unittest.mock.patch.object(kw, "SWEEP_BACKEND_FAILURE_LIMIT", 3),
                unittest.mock.patch.object(kw, "catalog_check", lambda *a, **k: None),
                unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", "tok"),
                unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", "-1"),
                unittest.mock.patch.object(kw, "reset_run_health",
                                           lambda: kw._run_health.update(
                                               attempted=0, succeeded=0,
                                               backend_failures=0, appview_failures=0)),
                unittest.mock.patch.object(kw, "process_con", side_effect=pc),
                unittest.mock.patch.object(kw, "check_source_liveness",
                                           return_value=([], [], [], [], [])),
                unittest.mock.patch.object(kw, "ops_notify", notify),
                unittest.mock.patch.object(sys, "argv", ["kw", "--sweep"]),
            ]:
                stack.enter_context(p)
            code = None
            try:
                kw.main()
            except SystemExit as e:
                code = e.code
            return code, notify, kw.process_con.call_count

    def test_sweep_bails_after_threshold_when_backend_down(self):
        code, notify, calls = self._run(backend_down=True)
        # limit is 3: break fires once backend_failures reaches 3, so only ~3 of
        # the 8 cons are processed rather than all of them
        self.assertEqual(calls, 3)
        self.assertEqual(code, 1)  # end-of-run verdict pages + exits non-zero
        notify.assert_called_once()

    def test_healthy_sweep_processes_every_con(self):
        # sanity: with the backend up, the short-circuit never trips
        code, notify, calls = self._run(backend_down=False)
        self.assertEqual(calls, 8)


class SweepFailFastTest(unittest.TestCase):
    """CON-35 E: sweep refuses to start if the ops channel is unconfigured, so a
    backend/appview outage can never page nobody."""

    def test_sweep_refuses_when_ops_unset(self):
        for token, chat in (("", ""), ("tok", ""), ("", "-1")):
            with self.subTest(token=token, chat=chat):
                with unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", token), \
                     unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", chat), \
                     unittest.mock.patch.object(sys, "argv", ["kw", "--sweep"]):
                    with self.assertRaises(SystemExit) as cm:
                        kw.main()
                self.assertIn("OPS_TELEGRAM", str(cm.exception))


class OpsNotifyLengthCapTest(unittest.TestCase):
    """CON-35 E: every ops_notify payload is capped to Telegram's 4096-char limit
    so an oversized alert isn't rejected outright."""

    def test_payload_truncated_with_ellipsis(self):
        captured = {}

        def fake(req, timeout=None):
            captured["body"] = req.data.decode()
            return unittest.mock.MagicMock()

        with unittest.mock.patch.object(kw, "OPS_TELEGRAM_BOT_TOKEN", "tok"), \
             unittest.mock.patch.object(kw, "OPS_TELEGRAM_CHAT_ID", "-1"), \
             unittest.mock.patch.object(kw, "DRY_RUN", False), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake):
            kw.ops_notify("x" * 9000)
        sent = kw.urllib.parse.parse_qs(captured["body"])["text"][0]
        self.assertLessEqual(len(sent), 4096)
        self.assertTrue(sent.endswith("…"))


class CatalogCheckAlertTest(unittest.TestCase):
    """CON-35 D: catalog_check alerts on BOTH the unreachable/error branch (and
    keeps going) and the missing-model branch (before SystemExit). A --sweep
    alerts unconditionally; a realtime run is cooldown-gated (no per-post flood)."""

    def test_unreachable_catalog_notifies_and_proceeds(self):
        def boom(req, timeout=None):
            raise kw.urllib.error.URLError("dns")
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", boom), \
             unittest.mock.patch.object(kw, "ops_notify") as notify:
            kw.catalog_check(sweep=True)  # must not raise
        notify.assert_called_once()

    def test_missing_model_notifies_before_exit(self):
        def fake(req, timeout=None):
            return io.BytesIO(json.dumps({"data": [{"id": "openai/gpt-oss-20b"}]}).encode())
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw, "EXTRACT_MODEL", "openai/gpt-oss-20b"), \
             unittest.mock.patch.object(kw, "VERIFY_MODELS", ["missing-model"]), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", fake), \
             unittest.mock.patch.object(kw, "ops_notify") as notify:
            with self.assertRaises(SystemExit):
                kw.catalog_check(sweep=True)
        notify.assert_called_once()

    def test_realtime_catalog_failure_is_cooldown_gated(self):
        # #447: a realtime (--post-file) run must NOT page from catalog_check while
        # the shared page cooldown is active — else a sustained outage floods ops
        # once per spooled post. The verdict page (also cooldown-gated) covers it.
        def boom(req, timeout=None):
            raise kw.urllib.error.URLError("dns")
        with unittest.mock.patch.object(kw, "MODEL_API_KEY", "k"), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", boom), \
             unittest.mock.patch.object(kw, "realtime_page_on_cooldown", lambda now: True), \
             unittest.mock.patch.object(kw, "ops_notify") as notify:
            kw.catalog_check(sweep=False)
        notify.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class VenueLocalDateTest(unittest.TestCase):
    """CON-50: the model must see post timestamps in the venue's local time, or
    "today" posted at 9 PM ET resolves to tomorrow's UTC date (data#88)."""

    def test_data88_post_localizes_to_previous_day(self):
        # the exact post behind data#88: 01:33Z Aug 3 is 21:33 EDT Aug 2 in Hickory, NC
        local, day = kw.localize_timestamp("2026-08-03T01:33:00.000Z", "America/New_York")
        self.assertEqual(day, "2026-08-02")
        self.assertEqual(local, "2026-08-02T21:33:00-04:00")

    def test_east_of_utc_morning_post_rolls_forward(self):
        local, day = kw.localize_timestamp("2026-08-02T22:30:00Z", "Asia/Tokyo")
        self.assertEqual(day, "2026-08-03")
        self.assertTrue(local.endswith("+09:00"))

    def test_utc_and_unknown_zone_keep_the_utc_date(self):
        self.assertEqual(kw.localize_timestamp("2026-08-03T01:33:00.000Z", "UTC")[1], "2026-08-03")
        # unknown zone / unparsable stamp degrade to the pre-CON-50 behaviour, never raise
        self.assertEqual(kw.localize_timestamp("2026-08-03T01:33:00.000Z", "Mars/Olympus"),
                         ("2026-08-03T01:33:00.000Z", "2026-08-03"))
        self.assertEqual(kw.localize_timestamp("garbage", "America/New_York"), ("garbage", "garbage"))
        self.assertEqual(kw.localize_timestamp(None, "America/New_York"), (None, ""))

    def test_createdat_variants_parse(self):
        # createdAt in the wild: 9-digit fractions, +00:00 offsets, no fraction
        for raw in ("2026-07-10T04:00:15.389618096Z", "2026-07-10T04:00:15+00:00",
                    "2026-07-10T04:00:15Z", "2026-07-10T04:00:15.5+0000"):
            self.assertEqual(kw.localize_timestamp(raw, "America/Edmonton")[1], "2026-07-09", raw)

    def test_venue_timezone_prefers_soonest_edition_then_utc(self):
        events = [{"id": "x-2027", "startDate": "2027-01-01"}, {"id": "x-2026", "startDate": "2026-10-01"}]
        self.assertEqual(kw.venue_timezone(events, {"x-2026": "America/New_York",
                                                    "x-2027": "Europe/Berlin"}), "America/New_York")
        self.assertEqual(kw.venue_timezone(events, {"x-2027": "Europe/Berlin"}), "Europe/Berlin")
        self.assertEqual(kw.venue_timezone(events, {}), "UTC")

    def test_load_event_timezones_parses_feed_and_degrades_to_utc(self):
        body = (json.dumps({"id": "a-2026", "timezone": "America/New_York"}) + "\n"
                + json.dumps({"id": "b-2026"}) + "\n\n").encode()

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with unittest.mock.patch.object(kw, "_event_tz_cache", None), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", return_value=Resp(body)):
            self.assertEqual(kw.load_event_timezones(), {"a-2026": "America/New_York"})
            # cached for the rest of the run
            self.assertIs(kw.load_event_timezones(), kw.load_event_timezones())
        with unittest.mock.patch.object(kw, "_event_tz_cache", None), \
             unittest.mock.patch.object(kw.urllib.request, "urlopen", side_effect=OSError("down")), \
             unittest.mock.patch.object(kw.time, "sleep"), \
             unittest.mock.patch.object(kw, "log") as lg:
            self.assertEqual(kw.load_event_timezones(), {})
        self.assertIn("UTC", lg.call_args[0][0])

    def test_extract_and_verify_payloads_carry_local_time(self):
        con = make_con({})
        events = kw.upcoming_events(con)
        post = {"url": did_entry("3abc")["source"], "asOf": "2026-08-03T01:33:00.000Z",
                "text": "Today is the final day to apply to host a panel"}
        sent = {}

        def fake_chat(model, system, user, schema, name):
            sent[name] = json.loads(user)
            if name == "keydates":
                return {"dates": [{"event_id": "testcon-2999", "category": "panels",
                                   "kind": "closes", "date": "2026-08-02",
                                   "source": post["url"], "confidence": 0.95}]}
            return {"verdicts": [{"index": 0, "verdict": "confirm", "reason": "ok"}]}

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        fn = os.path.join(tmp.name, "testcon.json")
        with open(fn, "w") as f:
            json.dump(con, f)
        with unittest.mock.patch.object(kw, "chat", side_effect=fake_chat), \
             unittest.mock.patch.object(kw, "DRY_RUN", True), \
             unittest.mock.patch.object(kw, "load_event_timezones",
                                        return_value={"testcon-2999": "America/New_York"}):
            changes, *_ = kw.process_con(fn, {}, [], provided_posts=[post])
        self.assertEqual(sent["keydates"]["timezone"], "America/New_York")
        self.assertEqual(sent["keydates"]["posts"][0]["asOf"], "2026-08-02T21:33:00-04:00")
        item = sent["verdicts"]["items"][0]
        self.assertEqual(item["post_timestamp"], "2026-08-02T21:33:00-04:00")
        self.assertEqual(item["post_timezone"], "America/New_York")
        # the stored asOf stays the raw UTC createdAt (schema unchanged)
        self.assertEqual(changes[0]["asOf"], "2026-08-03T01:33:00.000Z")
        self.assertEqual(changes[0]["date"], "2026-08-02")
