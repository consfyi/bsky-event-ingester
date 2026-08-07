# keydates-worker

Extracts convention key dates from con Bluesky posts and stages them as PRs
against `consfyi/data`, using an **OpenAI-compatible model provider** (Groq by
default, free tier — swappable via `MODEL_BASE_URL`) for extraction + verification.

Pipeline: gpt-oss-20b extract (hardened exclusion prompt) → gpt-oss-120b AND
gpt-oss-20b adversarial verify, **unanimity required** → validated merge guardrails
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
MODEL_API_KEY=$GROQ_API_KEY DRY_RUN=1 DATA_DIR=./data \
  python3 keydates_worker.py --series anthrocon

# full sweep, writes files but never pushes (PUSH unset)
MODEL_API_KEY=$GROQ_API_KEY DATA_DIR=./data \
  python3 keydates_worker.py --sweep
```

Provider is swappable via `MODEL_BASE_URL` (default
`https://api.groq.com/openai/v1`); any OpenAI-compatible endpoint exposing
`/chat/completions` and `/models` works. Groq's free tier is token-per-minute
limited (8000 TPM for gpt-oss); the worker budgets each request's INPUT against
`MODEL_MAX_REQUEST_TOKENS` (default derived as `(MODEL_TPM - MODEL_MAX_OUTPUT_TOKENS)/1.15`
≈ 4347 — reserving the output allowance so input+output stays under TPM) and paces
calls against `MODEL_TPM` (default 8000). `--shard 1/2` / `--shard 2/2` splits a full sweep across two
cron days, and `MAX_EXTRACTS` guards runaway usage.

## Droplet deployment

Runs as the `fbl` service user alongside the ingester. The worker ships inside the
ingester repo and deploys via `scripts/deploy.sh ingester`; on the box it lives at
`/home/fbl/keydates-worker/keydates_worker.py`.

1. Clone `consfyi/data` somewhere `fbl` can write — the worker's staging `DATA_DIR`.
   In PUSH mode the worker hard-resets it each run, so keep it bot-dedicated.
2. Provision two credentials as chmod-600 files (set rotation reminders):
   - **model API key** — a Groq API key (or any OpenAI-compatible provider's key)
     → `MODEL_API_KEY`. Override `MODEL_BASE_URL` to switch providers.
   - **repo PAT** — fine-grained PAT, `consfyi/data` only, Contents + Pull requests
     write → used by `git push` / `gh pr create` (via a credential helper on the checkout).
3. One wrapper `/home/fbl/keydates-run.sh` (chmod 700, owner-only) exports the
   worker's env from the chmod-600 secret files and forwards its arguments to the
   worker. The ingester calls it with `--post-file <spool>` (real-time); cron calls
   it with `--sweep --shard N/2`. The ops-bot vars are only needed for `--sweep` —
   the source-liveness guardrails and their alerts run only in sweep mode (unset =
   log-only).
   ```sh
   #!/bin/sh
   export MODEL_API_KEY=$(cat /home/fbl/.keydates-model-key)
   export DATA_DIR=/home/fbl/consfyi/data        # the bot-dedicated data checkout
   export PUSH=1
   # ops paging (sweep only). Real channel id (a negative -100… value) lives on the
   # box, never in this repo — the value below is a placeholder.
   export OPS_TELEGRAM_BOT_TOKEN=$(cat /home/fbl/.ops-telegram-token)
   export OPS_TELEGRAM_CHAT_ID=-1001234567890
   exec python3 /home/fbl/keydates-worker/keydates_worker.py "$@"
   ```
4. Weekly sweep backstop, sharded across two days at **09:00 UTC** (crontab):
   ```cron
   0 9 * * 6  /home/fbl/keydates-run.sh --sweep --shard 1/2
   0 9 * * 0  /home/fbl/keydates-run.sh --sweep --shard 2/2
   ```

## Ingester config (bsky-event-ingester config.toml)

```toml
# real-time detection (off when unset)
con_posts_spool_dir = "/var/spool/keydates"
keydates_worker_cmd = "/home/fbl/keydates-run.sh --post-file"   # ingester appends the spool path
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
