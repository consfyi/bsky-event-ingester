# keydates-worker

Extracts convention key dates from con Bluesky posts and stages them as PRs
against `consfyi/data`, using **GitHub Models** (free tier, `models: read`
PAT — no card, paid usage is opt-in-only) for extraction + verification.

Pipeline: gpt-4.1-mini extract (hardened exclusion prompt) → gpt-4.1 AND
gpt-4o adversarial verify, **unanimity required** → validated merge guardrails
(confidence ≥ 0.8, never overwrite curated values, recency-wins, same-date
re-announcements skipped pre-verify, rejections file, previous-edition
timestamp gate) → rolling PR on `bot/bsky-keydates`.

Calibration: the 2026-07-01 baseline showed small-model extraction alone has
~30% false positives; this verify stage refuted 19/19 of them. Live testing
2026-07-02 confirmed all measured FP classes are handled (price tiers, DJ/art
show/creator apps, sub-group volunteer calls, soft closes, wrong edition).

## Local testing

```sh
# one con, no writes, ~3 model calls
GITHUB_TOKEN=$(gh auth token) DRY_RUN=1 DATA_DIR=./data \
  python3 keydates_worker.py --series anthrocon

# full sweep, writes files but never pushes (PUSH unset)
GITHUB_TOKEN=$(gh auth token) DATA_DIR=./data \
  python3 keydates_worker.py --sweep
```

Quota (free tier, per model per day): extract ~150, verify ~50 each. A full
77-con sweep fits in one day; `--shard 1/2` / `--shard 2/2` splits it across
two cron days. `MAX_EXTRACTS` guards runaway usage.

## Droplet deployment

1. Clone `consfyi/data` somewhere the `fbl` user can write, e.g.
   `~/consfyi/data-worktree` (this is the worker's staging checkout).
2. Create two fine-grained PATs (Sparky's account, ≤1yr, set rotation
   reminders):
   - **models PAT** — account permission "Models: read" only → `GITHUB_TOKEN`
   - **repo PAT** — `consfyi/data` only, Contents + Pull requests write →
     used by `git push` / `gh pr create` (configure via `gh auth login` or a
     credential helper for the checkout)
3. Wrapper script `/usr/local/bin/keydates-worker` (called by the ingester
   with the spool file as its argument):
   ```sh
   #!/bin/sh
   export GITHUB_TOKEN=$(cat /home/fbl/.keydates-models-token)
   export DATA_DIR=/home/fbl/consfyi/data-worktree
   export PUSH=1
   exec python3 /home/fbl/consfyi/keydates-worker/keydates_worker.py --post-file "$1"
   ```
4. Weekly sweep backstop, spread over two days (crontab):
   ```
   23 9 * * 1  /usr/local/bin/keydates-sweep 1/2
   23 9 * * 2  /usr/local/bin/keydates-sweep 2/2
   ```
   (same wrapper with `--sweep --shard $1` instead of `--post-file`.)

## Ingester config (bsky-event-ingester config.toml)

```toml
# real-time detection (off when unset)
con_posts_spool_dir = "/var/spool/keydates"
keydates_worker_cmd = "/usr/local/bin/keydates-worker"
# con_post_debounce_secs = 900
# con_posts_daily_cap = 30

# post-merge Telegram announcements (dry-run by default; flip after a week
# of clean dry-run logs — the snapshot advances either way, so no storm)
# telegram_bot_token = "..."       # from BotFather; bot must be channel admin
# telegram_chat_id = "@conannouncements"
# telegram_dry_run = false
```

Postgres migration (run once on the droplet before deploying the new binary):

```sql
CREATE TABLE con_posts_cursor (cursor BIGINT NOT NULL);
CREATE UNIQUE INDEX con_posts_cursor_single_row ON con_posts_cursor ((true));
CREATE TABLE keydates_snapshot (event_id TEXT PRIMARY KEY, key_dates TEXT NOT NULL);
```

## Rejections

Reviewing the bot PR and something's wrong? Comment on it:

```
/reject <event_id> <category>.<kind> <YYYY-MM-DD> — <reason>
```

The `keydates_reject` workflow appends it to `.github/keydates_rejections.json` on
main; the worker never proposes that exact date again (a *different* date for
the same slot from a newer post is still allowed). Held items (verifier
disagreement) are listed in the PR body — apply by hand or `/reject`.
