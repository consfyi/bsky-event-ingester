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
- `_comment` — optional fixture-specific notes.

## TODAY-relative dates

A fixture whose case depends on when it runs relative to the con (for example,
a during-con post) writes its dates as `TODAY±N` tokens instead of fixed dates:
`"startDate": "TODAY-2"`, `"createdAt": "TODAY+0T22:00:00.000Z"`. A loader
resolves every `TODAY±N` occurrence in string values to the current UTC date
plus the offset, so the case can't decay as real time passes (a fixed past
edition would fall out of `upcoming_events()` and turn `expect_absent` checks
vacuous). `FixtureSmokeTest._resolve_today` implements the resolution; the
CON-9 eval harness must apply the same rule before feeding a fixture to the
pipeline.
