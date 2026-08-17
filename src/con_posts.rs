//! Real-time key-date detection.
//!
//! Watches posts from the Bluesky accounts of cons we follow (a second,
//! DID-filtered Jetstream connection — the like-subscription connection must
//! not gain a DID filter, since Jetstream ANDs `wantedDids` with
//! `wantedCollections` and the labeler needs likes from everyone). When a
//! watched account posts something date-relevant, the post is written to a
//! spool directory and an optional worker command is invoked on it; the
//! worker (keydates_worker.py) does the LLM extraction/verification and PR.

use atrium_api::types::Collection as _;
use futures::StreamExt as _;

/// did string -> series id, rebuilt by sync_labels from current.jsonl.
pub type Watchlist = std::sync::Arc<tokio::sync::RwLock<std::collections::HashMap<String, String>>>;

pub struct Options {
    pub spool_dir: std::path::PathBuf,
    pub worker_cmd: Option<String>,
    pub debounce: std::time::Duration,
    pub daily_cap: u32,
    pub commit_cursor_every: std::time::Duration,
}

/// Same cheap pre-filter the worker uses: only date-relevant posts are spooled.
/// KEEP IN SYNC with RELEVANT in keydates-worker/keydates_worker.py.
fn relevant_re() -> &'static regex::Regex {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::RegexBuilder::new(
            r"\b(regist|reg open|hotel|room block|booking|dealer|artist alley|panel|programming|submission|deadline|badge|sign ?up|volunteer|applicat|opens?|closes?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b\d{1,2}/\d{1,2}\b|\b20\d\d\b",
        )
        .case_insensitive(true)
        .build()
        .unwrap()
    });
    &RE
}

#[derive(serde::Serialize)]
struct SpooledPost<'a> {
    series: &'a str,
    did: &'a str,
    rkey: &'a str,
    url: String,
    text: &'a str,
    #[serde(rename = "asOf")]
    as_of: &'a str,
    time_us: u64,
}

async fn read_cursor(db_pool: &sqlx::PgPool) -> Result<Option<i64>, anyhow::Error> {
    let mut conn = db_pool.acquire().await?;
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT cursor FROM con_posts_cursor")
            .fetch_optional(&mut *conn)
            .await?,
    )
}

async fn write_cursor(db_pool: &sqlx::PgPool, cursor: i64) -> Result<(), anyhow::Error> {
    let mut conn = db_pool.acquire().await?;
    sqlx::query(
        r#"
        INSERT INTO con_posts_cursor (cursor) VALUES ($1)
        ON CONFLICT ((true)) DO UPDATE SET cursor = excluded.cursor
        "#,
    )
    .bind(cursor)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

struct FireState {
    last_fired: std::collections::HashMap<String, tokio::time::Instant>,
    day: chrono::NaiveDate,
    fired_today: u32,
}

impl FireState {
    fn should_fire(&mut self, series: &str, debounce: std::time::Duration, cap: u32) -> bool {
        let today = chrono::Utc::now().date_naive();
        if today != self.day {
            self.day = today;
            self.fired_today = 0;
        }
        if self.fired_today >= cap {
            log::warn!("con_posts: daily cap ({cap}) reached, not firing for {series}");
            return false;
        }
        if let Some(last) = self.last_fired.get(series) {
            if last.elapsed() < debounce {
                log::info!("con_posts: debouncing {series}");
                return false;
            }
        }
        self.last_fired
            .insert(series.to_string(), tokio::time::Instant::now());
        self.fired_today += 1;
        true
    }
}

pub async fn service(
    db_pool: &sqlx::PgPool,
    watchlist: Watchlist,
    jetstream_endpoints: Vec<url::Url>,
    options: Options,
) -> Result<(), anyhow::Error> {
    std::fs::create_dir_all(&options.spool_dir)?;

    // Shared so the periodic drain task can read spool_dir/worker_cmd alongside
    // the firehose loop below.
    let options = std::sync::Arc::new(options);

    // A prior process that crashed mid-worker leaves `.inflight` files claimed;
    // this new process has no live workers yet, so reclaim them (rename back to
    // `.json`) once before starting the drain (CON-39). A single dir scan, cheap
    // enough to run inline before the firehose loop.
    reclaim_orphaned_inflight(&options).await;

    // Reprocess spool files left behind by prior non-zero worker exits (CON-35).
    // Run as a PERIODIC background task, NOT a blocking startup drain: a file
    // retained during an outage is retried automatically once the backend
    // recovers, with no operator restart, and the drain never delays firehose
    // resume past the jetstream cursor backfill window. Each file is atomically
    // claimed before its worker spawns (CON-39), so no min-age heuristic is
    // needed; the 7-day age bound survives as a backstop for a stuck file.
    tokio::spawn(periodic_drain(
        options.clone(),
        std::time::Duration::from_secs(600),
        std::time::Duration::from_secs(7 * 24 * 3600),
    ));

    let mut cursor = read_cursor(db_pool).await?;
    let mut reconnector = crate::jetstream::reconnect::Reconnector::new(
        jetstream_endpoints,
        crate::jetstream::reconnect::Policy::default(),
    )?;
    let mut fire_state = FireState {
        last_fired: std::collections::HashMap::new(),
        day: chrono::Utc::now().date_naive(),
        fired_today: 0,
    };

    loop {
        let dids_snapshot = watchlist.read().await.clone();
        if dids_snapshot.is_empty() {
            // watchlist not populated yet (or no cons mapped); check again soon
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            continue;
        }

        let endpoint = reconnector.endpoint().clone();
        let started = std::time::Instant::now();
        match service_once(
            db_pool,
            &watchlist,
            &dids_snapshot,
            &endpoint,
            &options,
            &mut fire_state,
            cursor,
        )
        .await
        {
            Ok(next_cursor) => {
                cursor = next_cursor;
            }
            Err(e) => {
                log::error!("con_posts: Jetstream disconnected ({endpoint}): {e}");
                // The in-memory cursor is only updated on clean exits, so after
                // an error it can be hours stale — and a replay here re-fires
                // the whole LLM pipeline, unlike the labeler's idempotent
                // upserts. Resume from the persisted cursor (committed every
                // few seconds) instead.
                match read_cursor(db_pool).await {
                    Ok(persisted) => cursor = persisted,
                    Err(e) => log::error!("con_posts: could not re-read cursor: {e}"),
                }
            }
        }
        let next = reconnector.on_disconnect(started.elapsed());
        if next.switched {
            // Rewind only on a host switch (not every reconnect): a replayed
            // post re-enters the LLM pipeline, and the debounce absorbs a
            // few seconds of overlap but not more.
            cursor = cursor.map(|c| c - crate::jetstream::reconnect::REWIND_US);
            log::error!(
                "con_posts: repeated short connections to {endpoint}, failing over to {}",
                reconnector.endpoint()
            );
        }
        tokio::time::sleep(next.delay).await;
    }
}

async fn service_once(
    db_pool: &sqlx::PgPool,
    watchlist: &Watchlist,
    dids_snapshot: &std::collections::HashMap<String, String>,
    jetstream_endpoint: &url::Url,
    options: &Options,
    fire_state: &mut FireState,
    mut cursor: Option<i64>,
) -> Result<Option<i64>, anyhow::Error> {
    let wanted_dids = dids_snapshot
        .keys()
        .filter_map(|did| atrium_api::types::string::Did::new(did.clone()).ok())
        .collect::<Vec<_>>();

    log::info!(
        "con_posts: connecting, watching {} con accounts",
        wanted_dids.len()
    );

    let js = crate::jetstream::connect(
        jetstream_endpoint,
        crate::jetstream::ConnectOptions {
            wanted_collections: vec![atrium_api::app::bsky::feed::Post::nsid()],
            wanted_dids,
            cursor,
            compress: true,
            ..Default::default()
        },
    )
    .await?;
    futures::pin_mut!(js);

    let mut watchlist_check = tokio::time::interval(std::time::Duration::from_secs(60));
    watchlist_check.reset(); // don't fire immediately
    let mut last_cursor_commit = std::time::SystemTime::now();

    loop {
        let event = tokio::select! {
            event = js.next() => match event {
                Some(event) => event?,
                None => return Ok(cursor),
            },
            _ = watchlist_check.tick() => {
                let current = watchlist.read().await;
                if *current != *dids_snapshot {
                    log::info!("con_posts: watchlist changed, reconnecting");
                    return Ok(cursor);
                }
                continue;
            }
        };

        if let crate::jetstream::event::EventKind::Commit {
            commit:
                crate::jetstream::event::Commit {
                    operation:
                        crate::jetstream::event::CommitOperation::Create {
                            record: atrium_api::record::KnownRecord::AppBskyFeedPost(post),
                            ..
                        },
                    rkey,
                    ..
                },
        } = &event.kind
        {
            handle_post(
                dids_snapshot,
                options,
                fire_state,
                &event.did,
                rkey,
                event.time_us,
                post,
            );
        }

        let now = std::time::SystemTime::now();
        if now >= last_cursor_commit + options.commit_cursor_every {
            write_cursor(db_pool, event.time_us as i64).await?;
            last_cursor_commit = now;
        }

        cursor = Some(event.time_us as i64);
    }
}

fn handle_post(
    dids_snapshot: &std::collections::HashMap<String, String>,
    options: &Options,
    fire_state: &mut FireState,
    did: &atrium_api::types::string::Did,
    rkey: &str,
    time_us: u64,
    post: &atrium_api::app::bsky::feed::post::Record,
) {
    let Some(series) = dids_snapshot.get(did.as_str()) else {
        return;
    };

    // replies are conversation, not announcements
    if post.reply.is_some() {
        return;
    }

    let text = post.text.trim();
    if text.is_empty() || !relevant_re().is_match(text) {
        return;
    }

    if !fire_state.should_fire(series, options.debounce, options.daily_cap) {
        return;
    }

    // series comes from the published events data, not post content, but it
    // becomes part of a filesystem path — refuse anything but a bare slug.
    if series.is_empty()
        || !series
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        log::warn!("con_posts: refusing to spool series with non-slug id {series:?}");
        return;
    }

    let as_of = post.created_at.as_str().to_string();
    let spooled = SpooledPost {
        series,
        did: did.as_str(),
        rkey,
        url: format!("https://bsky.app/profile/{}/post/{}", did.as_str(), rkey),
        text,
        as_of: &as_of,
        time_us,
    };

    let path = options.spool_dir.join(format!("{time_us}-{series}.json"));
    let json = match serde_json::to_vec_pretty(&spooled) {
        Ok(json) => json,
        Err(e) => {
            log::error!("con_posts: failed to serialize spool entry: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::write(&path, json) {
        log::error!("con_posts: failed to write {}: {e}", path.display());
        return;
    }
    log::info!(
        "con_posts: spooled date-relevant post from {series}: {}",
        spooled.url
    );

    if let Some(cmd) = &options.worker_cmd {
        // claim the file (atomic rename -> .inflight) before spawning, so a
        // concurrent drain pass can never start a second worker on it (CON-39).
        // We just wrote it, but a drain tick could race between the write and the
        // claim — whoever wins the rename owns it; if we lose, the drain has it.
        let Some(inflight) = claim_spool(&path) else {
            return;
        };
        let Some(mut command) = build_worker_command(cmd, &inflight) else {
            unclaim_spool(&inflight);
            return;
        };
        match command.spawn() {
            Ok(child) => {
                let series = series.clone();
                tokio::spawn(async move {
                    wait_and_reap(&series, &inflight, child, WORKER_TIMEOUT).await;
                });
            }
            Err(e) => {
                log::error!("con_posts: failed to spawn worker for {series}: {e}");
                unclaim_spool(&inflight);
            }
        }
    }
}

/// Build the worker process command for a spooled file: split the configured
/// `worker_cmd` into program + args and append the spool path. Returns None if
/// the command string is empty. Shared by the realtime and drain spawn paths.
fn build_worker_command(cmd: &str, path: &std::path::Path) -> Option<tokio::process::Command> {
    let mut parts = cmd.split_whitespace();
    let program = parts.next()?;
    let mut command = tokio::process::Command::new(program);
    command.args(parts).arg(path);
    Some(command)
}

/// Log a finished worker's exit and dispose of its CLAIMED (`.inflight`) spool
/// file: on success remove it; on a non-zero exit or a wait error, un-claim it
/// (rename back to `.json`) so a later drain retries it.
///
/// A NON-ZERO exit means the worker signalled a wholesale backend/extraction
/// outage (CON-35) — retaining the post (rather than the old unconditional exit-0
/// delete) is what stopped 4 days of spooled posts being lost during a silent
/// provider outage. Because the file was claimed before the spawn (CON-39), no
/// realtime worker or drain pass can be racing us for it here.
async fn reap_worker(
    series: &str,
    inflight: &std::path::Path,
    wait: Result<std::process::ExitStatus, std::io::Error>,
) {
    match wait {
        Ok(status) if status.success() => {
            log::info!("con_posts: worker for {series} exited: {status}");
            if let Err(e) = tokio::fs::remove_file(inflight).await {
                log::warn!(
                    "con_posts: could not remove spool file {}: {e}",
                    inflight.display()
                );
            }
        }
        Ok(status) => {
            log::warn!(
                "con_posts: worker for {series} exited non-zero ({status}); retaining for retry"
            );
            unclaim_spool(inflight);
        }
        Err(e) => {
            log::error!("con_posts: worker for {series} failed: {e}");
            unclaim_spool(inflight);
        }
    }
}

/// Ceiling on a single spooled-post worker's runtime. A `--post-file` worker makes
/// a few model calls (each up to ~120s + 429 backoff), so legit runs finish well
/// under this; the bound just stops a hung worker from wedging the sequential drain
/// forever (or leaking a claim + process on the realtime path). CON-39.
const WORKER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(900);

/// Wait for a spawned worker, bounded by `timeout`, then reap it. On timeout, kill
/// the child (tokio's `kill().await` also reaps it) and un-claim the spool file so
/// a later drain pass retries it — one hung worker must never block the drain.
async fn wait_and_reap(
    series: &str,
    inflight: &std::path::Path,
    mut child: tokio::process::Child,
    timeout: std::time::Duration,
) {
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(wait) => reap_worker(series, inflight, wait).await,
        Err(_) => {
            log::error!(
                "con_posts: worker for {series} exceeded {}s; killing and retaining {} for retry",
                timeout.as_secs(),
                inflight.display()
            );
            let _ = child.kill().await;
            unclaim_spool(inflight);
        }
    }
}

/// Atomically claim a spool file for processing by renaming `<f>.json` →
/// `<f>.json.inflight`. Returns the claimed path, or None if the rename fails
/// (another worker already claimed it, or it's gone). The drain only scans
/// unclaimed `.json` files, so a claimed file can never be double-spawned — this
/// replaces the old mtime `min_age` heuristic, which couldn't prove a realtime
/// worker had finished (CON-39).
fn claim_spool(path: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut inflight = path.to_path_buf().into_os_string();
    inflight.push(".inflight");
    let inflight = std::path::PathBuf::from(inflight);
    match std::fs::rename(path, &inflight) {
        Ok(()) => Some(inflight),
        Err(e) => {
            log::info!(
                "con_posts: could not claim {} ({e}); another worker has it",
                path.display()
            );
            None
        }
    }
}

/// Release a claimed spool file back to its `.json` name so a later drain retries
/// it (used on a non-zero worker exit and on spawn failure). Sync `rename` so the
/// synchronous `handle_post` can call it; the op is a quick metadata rename.
fn unclaim_spool(inflight: &std::path::Path) {
    let released = inflight.with_extension(""); // strip ".inflight" -> back to ".json"
    if let Err(e) = std::fs::rename(inflight, &released) {
        log::warn!(
            "con_posts: could not un-claim {} ({e}); it is recovered on next start",
            inflight.display()
        );
    }
}

/// On startup, release any `.inflight` files a PRIOR process left claimed when it
/// crashed mid-worker. This new process has no live workers yet, so every
/// `.inflight` file is an orphan — rename each back to `.json` so the periodic
/// drain reprocesses it. Runs once, before any worker is spawned (CON-39).
async fn reclaim_orphaned_inflight(options: &Options) {
    let mut dir = match tokio::fs::read_dir(&options.spool_dir).await {
        Ok(dir) => dir,
        Err(e) => {
            log::error!("con_posts: could not scan spool dir for orphan reclaim: {e}");
            return;
        }
    };
    loop {
        match dir.next_entry().await {
            Ok(Some(entry)) => {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("inflight") {
                    log::warn!(
                        "con_posts: reclaiming orphaned in-flight spool file {}",
                        path.display()
                    );
                    unclaim_spool(&path);
                }
            }
            Ok(None) => break,
            Err(e) => {
                log::error!("con_posts: error scanning spool dir for orphan reclaim: {e}");
                break;
            }
        }
    }
}

/// Series id embedded in a spool filename (`{time_us}-{series}.json`), for logs.
fn spool_series(path: &std::path::Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(|stem| stem.split_once('-').map(|(_, series)| series.to_string()))
        .unwrap_or_else(|| "unknown".to_string())
}

/// Re-drain the spool on a fixed interval, forever. The first tick fires
/// immediately, so this subsumes the old startup drain while keeping it off the
/// firehose critical path. Each pass is sequential (`drain_spool`); passes never
/// overlap because we `await` one before ticking again.
async fn periodic_drain(
    options: std::sync::Arc<Options>,
    every: std::time::Duration,
    max_age: std::time::Duration,
) {
    let mut interval = tokio::time::interval(every);
    loop {
        interval.tick().await;
        drain_spool(&options, max_age).await;
    }
}

/// Reprocess spool files left behind by prior non-zero worker exits (CON-35):
/// the realtime path un-claims a file on a non-zero exit, so anything left as
/// `.json` on disk is a retry. Each is atomically CLAIMED (renamed to
/// `.inflight`) before its worker is spawned, so the drain can never collide with
/// a realtime worker or another drain pass (CON-39). `max_age` stays as a
/// backstop against reprocessing a permanently-failing entry forever.
async fn drain_spool(options: &Options, max_age: std::time::Duration) {
    let Some(cmd) = &options.worker_cmd else {
        return;
    };
    let mut dir = match tokio::fs::read_dir(&options.spool_dir).await {
        Ok(dir) => dir,
        Err(e) => {
            log::error!("con_posts: could not scan spool dir for drain: {e}");
            return;
        }
    };
    let mut paths = Vec::new();
    loop {
        match dir.next_entry().await {
            Ok(Some(entry)) => {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                    paths.push(path);
                }
            }
            Ok(None) => break,
            // don't treat a read error as end-of-directory (that would silently
            // drain a partial scan) — log it and stop this pass; the next tick retries
            Err(e) => {
                log::error!("con_posts: error scanning spool dir during drain: {e}");
                break;
            }
        }
    }
    paths.sort(); // deterministic, oldest time_us first

    for path in paths {
        // backstop: leave a permanently-failing entry alone once it's very old
        let too_old = tokio::fs::metadata(&path)
            .await
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if too_old {
            log::warn!(
                "con_posts: spool file {} older than {}s, skipping drain",
                path.display(),
                max_age.as_secs()
            );
            continue;
        }
        let series = spool_series(&path);
        // claim atomically; if we lose the claim (a realtime worker grabbed it,
        // or it's already gone), skip — its owner processes it
        let Some(inflight) = claim_spool(&path) else {
            continue;
        };
        let Some(mut command) = build_worker_command(cmd, &inflight) else {
            unclaim_spool(&inflight);
            return;
        };
        log::info!("con_posts: draining spool file {}", path.display());
        match command.spawn() {
            Ok(child) => wait_and_reap(&series, &inflight, child, WORKER_TIMEOUT).await,
            Err(e) => {
                log::error!("con_posts: failed to spawn drain worker for {series}: {e}");
                unclaim_spool(&inflight);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // unique scratch dir without pulling in a tempfile dev-dependency
    fn scratch_dir() -> std::path::PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("con_posts_drain_test_{}_{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn drain_opts(dir: &std::path::Path, cmd: &str) -> Options {
        Options {
            spool_dir: dir.to_path_buf(),
            worker_cmd: Some(cmd.to_string()),
            debounce: std::time::Duration::ZERO,
            daily_cap: 0,
            commit_cursor_every: std::time::Duration::ZERO,
        }
    }

    #[test]
    fn spool_series_parses_filename() {
        assert_eq!(
            spool_series(std::path::Path::new("/spool/12345-anthrocon.json")),
            "anthrocon"
        );
        // extra hyphens belong to the series slug, not the time_us prefix
        assert_eq!(
            spool_series(std::path::Path::new("/spool/99-further-confusion.json")),
            "further-confusion"
        );
    }

    #[tokio::test]
    async fn drain_reprocesses_and_reclaims_leftover_on_success() {
        let dir = scratch_dir();
        let spool = dir.join("123-testcon.json");
        std::fs::write(&spool, b"{}").unwrap();
        // `true` exits 0 -> the file is claimed (.inflight), processed, removed.
        drain_spool(
            &drain_opts(&dir, "true"),
            std::time::Duration::from_secs(3600),
        )
        .await;
        assert!(
            !spool.exists(),
            "a successfully-drained spool file must be reclaimed"
        );
        assert!(
            !dir.join("123-testcon.json.inflight").exists(),
            "the claim must be removed on success"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn drain_retains_leftover_on_nonzero_exit() {
        let dir = scratch_dir();
        let spool = dir.join("123-testcon.json");
        std::fs::write(&spool, b"{}").unwrap();
        // `false` exits 1 -> claimed then un-claimed (renamed back to .json) for retry
        drain_spool(
            &drain_opts(&dir, "false"),
            std::time::Duration::from_secs(3600),
        )
        .await;
        assert!(
            spool.exists(),
            "a non-zero worker exit must retain the spool file as .json for retry"
        );
        assert!(
            !dir.join("123-testcon.json.inflight").exists(),
            "the .inflight claim must be released back to .json"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn drain_skips_files_past_age_bound() {
        let dir = scratch_dir();
        let spool = dir.join("123-testcon.json");
        std::fs::write(&spool, b"{}").unwrap();
        // max_age 0: the just-written file is already "too old" -> never claimed/run
        drain_spool(&drain_opts(&dir, "true"), std::time::Duration::ZERO).await;
        assert!(
            spool.exists(),
            "a file past the age bound must be skipped, not reprocessed forever"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn drain_ignores_inflight_files() {
        // A claimed (.inflight) file is owned by a live worker in this process and
        // must never be picked up by the drain (which scans only .json). This
        // replaces the old min-age heuristic and closes the double-spawn race (CON-39).
        let dir = scratch_dir();
        let inflight = dir.join("123-testcon.json.inflight");
        std::fs::write(&inflight, b"{}").unwrap();
        drain_spool(
            &drain_opts(&dir, "true"),
            std::time::Duration::from_secs(3600),
        )
        .await;
        assert!(
            inflight.exists(),
            "an in-flight (claimed) file must not be drained"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn reclaim_orphaned_inflight_renames_back_to_json() {
        // A prior crash leaves a .inflight file; on startup it's an orphan (no live
        // worker) and must be released back to .json so the drain reprocesses it.
        let dir = scratch_dir();
        let inflight = dir.join("123-testcon.json.inflight");
        std::fs::write(&inflight, b"{}").unwrap();
        reclaim_orphaned_inflight(&drain_opts(&dir, "true")).await;
        assert!(
            !inflight.exists(),
            "the orphaned .inflight must be renamed away"
        );
        assert!(
            dir.join("123-testcon.json").exists(),
            "it must be released back to .json for the drain to retry"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn claim_then_unclaim_roundtrips() {
        let dir = scratch_dir();
        let spool = dir.join("123-testcon.json");
        std::fs::write(&spool, b"{}").unwrap();
        let inflight = claim_spool(&spool).expect("claim a fresh file");
        assert!(
            !spool.exists() && inflight.exists(),
            "claim renames .json -> .inflight"
        );
        // a gone (already-claimed) file can't be claimed again
        assert!(
            claim_spool(&spool).is_none(),
            "a missing file can't be claimed"
        );
        unclaim_spool(&inflight);
        assert!(
            spool.exists() && !inflight.exists(),
            "unclaim renames .inflight -> .json"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn wait_and_reap_kills_and_unclaims_on_timeout() {
        // a worker that runs far past the timeout must be killed and its file
        // un-claimed for retry, so one hung worker can't wedge the drain (CON-39).
        let dir = scratch_dir();
        let spool = dir.join("123-testcon.json");
        std::fs::write(&spool, b"{}").unwrap();
        let inflight = claim_spool(&spool).expect("claim");
        let child = tokio::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        wait_and_reap(
            "testcon",
            &inflight,
            child,
            std::time::Duration::from_millis(50),
        )
        .await;
        assert!(
            spool.exists(),
            "a timed-out worker must un-claim the file for retry"
        );
        assert!(!inflight.exists(), "the .inflight claim must be released");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn periodic_drain_retries_file_that_appears_after_start() {
        let dir = scratch_dir();
        // Start the periodic drainer on an empty dir; a fast interval so the
        // test doesn't wait 10 minutes. First tick fires immediately.
        let opts = std::sync::Arc::new(drain_opts(&dir, "true"));
        let task = tokio::spawn(periodic_drain(
            opts,
            std::time::Duration::from_millis(20),
            std::time::Duration::from_secs(3600),
        ));
        // A file spooled *after* the drainer started (i.e. after "recovery")
        // must be picked up on a later pass without any restart.
        let spool = dir.join("123-testcon.json");
        std::fs::write(&spool, b"{}").unwrap();
        for _ in 0..50 {
            if !spool.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        task.abort();
        assert!(
            !spool.exists(),
            "periodic drain must retry a file that appears after start, no restart needed"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn drain_ignores_non_json_and_missing_dir() {
        let dir = scratch_dir();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        // non-.json entries are left untouched...
        drain_spool(
            &drain_opts(&dir, "false"),
            std::time::Duration::from_secs(3600),
        )
        .await;
        assert!(dir.join("notes.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
        // ...and a missing spool dir is a clean no-op, not a panic
        drain_spool(
            &drain_opts(&dir, "true"),
            std::time::Duration::from_secs(3600),
        )
        .await;
    }
}
