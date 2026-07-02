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
                    match child.wait().await {
                        Ok(status) => {
                            log::info!("con_posts: worker for {series} exited: {status}")
                        }
                        Err(e) => log::error!("con_posts: worker for {series} failed: {e}"),
                    }
                });
            }
            Err(e) => {
                log::error!("con_posts: failed to spawn worker for {series}: {e}");
            }
        }
    }
}
