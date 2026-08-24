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
