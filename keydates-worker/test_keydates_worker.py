"""Tests for the source-liveness check (keydates_worker.py stage E).

Stdlib-only; appget is monkeypatched so nothing touches the network.
Run: python3 -m unittest discover -s keydates-worker
"""
import copy
import json
import os
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

    def write_con(self, con, name="testcon.json"):
        fn = os.path.join(self.tmp.name, name)
        with open(fn, "w") as f:
            json.dump(con, f)
        return fn

    def read_con(self, fn):
        with open(fn) as f:
            return json.load(f)

    def check(self, files, **fake_kwargs):
        with unittest.mock.patch.object(kw, "appget", fake_appget(**fake_kwargs)):
            return kw.check_source_liveness(files)

    def test_dead_source_removed_and_stubs_cleaned(self):
        con = make_con({"panels": {"opens": entry("3dead")},
                        "hotel": {"opens": entry("3live")}})
        fn = self.write_con(con)
        removals, flags = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual(flags, [])
        self.assertEqual([(r["event_id"], r["category"], r["kind"], r["date"]) for r in removals],
                         [("testcon-2999", "panels", "opens", "2999-01-01")])
        after = self.read_con(fn)["events"][0]["keyDates"]
        self.assertNotIn("panels", after)  # emptied category dropped, not left as {}
        self.assertIn("hotel", after)

    def test_alive_sources_untouched(self):
        con = make_con({"panels": {"opens": entry("3live")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        removals, flags = self.check([fn], alive_rkeys={"3live"})
        self.assertEqual((removals, flags), ([], []))
        self.assertEqual(self.read_con(fn), before)

    def test_replaced_slot_not_removed(self):
        # the sweep already amended the slot to a newer, live post before the
        # liveness check runs — the dead old post is no longer referenced
        con = make_con({"panels": {"opens": entry("3newpost", date="2999-02-02")}})
        fn = self.write_con(con)
        removals, _ = self.check([fn], alive_rkeys={"3newpost"})
        self.assertEqual(removals, [])
        self.assertEqual(self.read_con(fn)["events"][0]["keyDates"]["panels"]["opens"]["date"],
                         "2999-02-02")

    def test_all_dead_with_unreachable_account_is_report_only(self):
        con = make_con({"panels": {"opens": entry("3aaa")},
                        "hotel": {"opens": entry("3bbb")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        removals, flags = self.check([fn], alive_rkeys=set(), profile_ok=False)
        self.assertEqual(removals, [])
        self.assertEqual(len(flags), 2)
        self.assertEqual(self.read_con(fn), before)

    def test_all_dead_with_live_account_removes(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        removals, flags = self.check([fn], alive_rkeys=set(), profile_ok=True)
        self.assertEqual(len(removals), 1)
        self.assertEqual(flags, [])
        self.assertNotIn("keyDates", self.read_con(fn)["events"][0])

    def test_getposts_error_skips_check(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        removals, flags = self.check([fn], alive_rkeys=set(), fail_getposts=True)
        self.assertEqual((removals, flags), ([], []))
        self.assertEqual(self.read_con(fn), before)

    def test_dry_run_reports_without_writing(self):
        con = make_con({"panels": {"opens": entry("3aaa")}})
        fn = self.write_con(con)
        before = copy.deepcopy(con)
        with unittest.mock.patch.object(kw, "DRY_RUN", True):
            removals, _ = self.check([fn], alive_rkeys=set())
        self.assertEqual(len(removals), 1)
        self.assertEqual(self.read_con(fn), before)


class SummaryTest(unittest.TestCase):
    def test_summary_lists_removals_and_flags(self):
        r = {"_file": "testcon.json", "event_id": "testcon-2999", "category": "panels",
             "kind": "opens", **entry("3aaa")}
        body = kw.render_summary([], [], [], [], "", removals=[r], account_flags=[r])
        self.assertIn("Source post deleted — entry removed", body)
        self.assertIn("Source account unreachable", body)
        self.assertIn("testcon-2999", body)


class UserAgentTest(unittest.TestCase):
    def test_appview_user_agent_has_contact_path(self):
        self.assertIn("(+https://cons.fyi)", kw.APPVIEW_USER_AGENT)


if __name__ == "__main__":
    unittest.main()
