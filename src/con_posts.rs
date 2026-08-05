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
    jetstream_endpoint: &url::Url,
    options: Options,
) -> Result<(), anyhow::Error> {
    std::fs::create_dir_all(&options.spool_dir)?;

    // Shared so the periodic drain task can read spool_dir/worker_cmd alongside
    // the firehose loop below.
    let options = std::sync::Arc::new(options);

    // Reprocess spool files left behind by prior non-zero worker exits (CON-35).
    // Run as a PERIODIC background task, NOT a blocking startup drain: a file
    // retained during an outage is retried automatically once the backend
    // recovers, with no operator restart, and the drain never delays firehose
    // resume past the jetstream cursor backfill window. The 7-day age bound
    // survives as a backstop for a genuinely-stuck file.
    tokio::spawn(periodic_drain(
        options.clone(),
        std::time::Duration::from_secs(600),
        std::time::Duration::from_secs(7 * 24 * 3600),
    ));

    let mut cursor = read_cursor(db_pool).await?;
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

        match service_once(
            db_pool,
            &watchlist,
            &dids_snapshot,
            jetstream_endpoint,
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
                log::error!("con_posts: Jetstream disconnected: {e}");
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
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
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
        let mut parts = cmd.split_whitespace();
        let Some(program) = parts.next() else {
            return;
        };
        let mut command = tokio::process::Command::new(program);
        command.args(parts).arg(&path);
        match command.spawn() {
            Ok(mut child) => {
                let series = series.clone();
                tokio::spawn(async move {
                    reap_worker(&series, &path, child.wait().await).await;
                });
            }
            Err(e) => {
                log::error!("con_posts: failed to spawn worker for {series}: {e}");
            }
        }
    }
}

/// Log a finished worker's exit and reclaim its spool file only on success.
///
/// A NON-ZERO exit is logged at warn (not info) and the spool file is RETAINED:
/// the worker signals a wholesale backend/extraction outage that way (CON-35),
/// and the old unconditional exit-0 delete lost 4 days of spooled posts during a
/// silent provider outage. A retained file is reprocessed by `drain_spool` on the
/// next ingester start, once the backend has recovered.
async fn reap_worker(
    series: &str,
    path: &std::path::Path,
    wait: Result<std::process::ExitStatus, std::io::Error>,
) {
    match wait {
        Ok(status) if status.success() => {
            log::info!("con_posts: worker for {series} exited: {status}");
            if let Err(e) = tokio::fs::remove_file(path).await {
                log::warn!(
                    "con_posts: could not remove spool file {}: {e}",
                    path.display()
                );
            }
        }
        Ok(status) => {
            log::warn!(
                "con_posts: worker for {series} exited non-zero ({status}); retaining spool file {} for retry",
                path.display()
            );
        }
        Err(e) => log::error!("con_posts: worker for {series} failed: {e}"),
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
/// the realtime path only removes a file on a successful exit, so anything still
/// on disk is a retry. Run the worker on each once, sequentially.
///
/// Safety bound: a file whose mtime is older than `max_age` is skipped (and left
/// in place), so a permanently-failing entry can't be reprocessed on every
/// restart forever.
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
    while let Ok(Some(entry)) = dir.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
            paths.push(path);
        }
    }
    paths.sort(); // deterministic, oldest time_us first

    for path in paths {
        let series = spool_series(&path);
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
        let mut parts = cmd.split_whitespace();
        let Some(program) = parts.next() else {
            return;
        };
        let mut command = tokio::process::Command::new(program);
        command.args(parts).arg(&path);
        log::info!("con_posts: draining leftover spool file {}", path.display());
        match command.spawn() {
            Ok(mut child) => reap_worker(&series, &path, child.wait().await).await,
            Err(e) => log::error!("con_posts: failed to spawn drain worker for {series}: {e}"),
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
        let dir = std::env::temp_dir().join(format!(
            "con_posts_drain_test_{}_{n}",
            std::process::id()
        ));
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
        // `true` exits 0 -> the leftover file is reprocessed and reclaimed
        drain_spool(&drain_opts(&dir, "true"), std::time::Duration::from_secs(3600)).await;
        assert!(
            !spool.exists(),
            "a successfully-drained spool file must be reclaimed"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn drain_retains_leftover_on_nonzero_exit() {
        let dir = scratch_dir();
        let spool = dir.join("123-testcon.json");
        std::fs::write(&spool, b"{}").unwrap();
        // `false` exits 1 -> retained for the next start's drain (no data loss)
        drain_spool(&drain_opts(&dir, "false"), std::time::Duration::from_secs(3600)).await;
        assert!(
            spool.exists(),
            "a non-zero worker exit must retain the spool file for retry"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn drain_skips_files_past_age_bound() {
        let dir = scratch_dir();
        let spool = dir.join("123-testcon.json");
        std::fs::write(&spool, b"{}").unwrap();
        // max_age 0: the just-written file is already "too old" -> the worker
        // (which would delete it on success) must never run, so it survives
        drain_spool(&drain_opts(&dir, "true"), std::time::Duration::ZERO).await;
        assert!(
            spool.exists(),
            "a file past the age bound must be skipped, not reprocessed forever"
        );
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
        drain_spool(&drain_opts(&dir, "false"), std::time::Duration::from_secs(3600)).await;
        assert!(dir.join("notes.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
        // ...and a missing spool dir is a clean no-op, not a panic
        drain_spool(&drain_opts(&dir, "true"), std::time::Duration::from_secs(3600)).await;
    }
}
