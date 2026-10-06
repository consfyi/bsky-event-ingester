# Prompt fixtures

Regression cases for the extract/verify prompts, in the shape the future eval
harness (CON-9) expects. `FixtureSmokeTest` in `test_keydates_worker.py`
validates the required keys below.

## Schema

Each `*.json` fixture carries:

- `issue` — the tracker issue the case pins.
- `synthetic` — `true` when the con and posts are invented for the case;
  absent/false when they're captured from the live pipeline.
- `description` — what the case pins and why.
- `con` — the con file the worker would process: `name`, `bluesky.did`, and
  `events` (editions with `id`, `name`, `startDate`, `endDate`).
- `timezone` — the venue timezone post timestamps resolve against.
- `posts` — the Bluesky posts fed to extraction; each has `url`, `createdAt`
  (UTC), and `text`.
- `expect` — proposals the pipeline MUST produce: `event_id`, `category`,
  `kind`, `date`, `source`. An empty list means the correct output is no
  extractions, in which case `expect_absent` must be non-empty (a fixture that
  expects nothing and forbids nothing asserts nothing).
- `expect_absent` — slots the pipeline must NOT fill, each naming `event_id`,
  `category`, `kind`, and a human `reason`. **With a `date`**, that slot must
  not carry that specific date (other dates are fine); **without a `date`**,
  the slot must be absent entirely.
- `requires_merge` — optional; `true` when the prompts are known to produce
  the forbidden proposal and only `merge()`'s mechanical guards remove it
  (CON-60). The harness must run `merge()` on the confirmed proposals before
  checking `expect_absent`.
- `_comment` — optional fixture-specific notes.

## TODAY-relative dates

A fixture whose case depends on when it runs relative to the con (for example,
a during-con post) writes its date fields as `TODAY±N` tokens instead of fixed
dates: `"startDate": "TODAY-2"`, `"createdAt": "TODAY+0T22:00:00.000Z"`. The
signed offset is mandatory (`TODAY+0` for today) and the token must be the
entire field value, optionally followed by a `T...` time suffix. A loader
resolves tokens ONLY in the known date fields — `startDate`, `endDate`,
`createdAt`, and `date` values inside `expect`/`expect_absent` — never in free
text such as post `text` or `description`, so a post that literally says
"CLOSES TODAY" is left verbatim. Token dating keeps a case from decaying as
real time passes (a fixed past edition would fall out of `upcoming_events()`
and turn `expect_absent` checks vacuous); token-dated post text must use
relative wording ("open now", "this Sunday") so it stays coherent with the
floating dates. `FixtureSmokeTest._resolve_today` implements the resolution;
the CON-9 eval harness must apply the same rule before feeding a fixture to
the pipeline.
