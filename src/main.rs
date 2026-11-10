use atrium_api::types::{Collection as _, TryFromUnknown as _, TryIntoUnknown as _};
use axum::response::IntoResponse as _;
use bsky_event_ingester::*;
use futures::StreamExt as _;
use sqlx::Acquire as _;

#[derive(serde::Deserialize)]
struct Config {
    bsky_username: String,
    bsky_password: String,
    bsky_endpoint: String,
    ui_endpoint: String,
    // Dial order for the Jetstream firehose; see jetstream::DEFAULT_ENDPOINTS.
    // The consumer fails over to the next entry after repeated short-lived
    // connections. `jetstream_endpoint` (singular, the pre-failover key) is a
    // dial-order preference, not exclusivity: it is dialed first, but after
    // repeated short connections the consumer rotates onto
    // `jetstream_endpoints`. To pin exclusively, set `jetstream_endpoints = []`
    // alongside the pin. `jetstream_endpoints = []` with no pin disables the
    // firehose: both consumers log a warning and return instead of running.
    jetstream_endpoints: Vec<url::Url>,
    jetstream_endpoint: Option<url::Url>,
    events_url: String,
    postgres_url: String,
    keypair_path: String,
    ingester_bind: std::net::SocketAddr,
    commit_firehose_cursor_every_secs: u64,
    // Key-date detection: unset = feature off. See src/con_posts.rs.
    con_posts_spool_dir: Option<std::path::PathBuf>,
    keydates_worker_cmd: Option<String>,
    con_post_debounce_secs: u64,
    con_posts_daily_cap: u32,
    // Key-date announcements: see src/keydates_announce.rs. Dry run by
    // default; messages are logged (and the snapshot advances) until
    // telegram_dry_run is explicitly set to false.
    telegram_bot_token: Option<String>,
    telegram_chat_id: Option<String>,
    telegram_dry_run: bool,
    keydates_announce_cap: u32,
}

// Manual Debug so the startup config log can never leak credentials.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("bsky_username", &self.bsky_username)
            .field("bsky_password", &"<redacted>")
            .field("bsky_endpoint", &self.bsky_endpoint)
            .field("ui_endpoint", &self.ui_endpoint)
            .field("jetstream_endpoints", &self.jetstream_endpoints)
            .field("jetstream_endpoint", &self.jetstream_endpoint)
            .field("events_url", &self.events_url)
            .field("postgres_url", &"<redacted>")
            .field("keypair_path", &self.keypair_path)
            .field("ingester_bind", &self.ingester_bind)
            .field(
                "commit_firehose_cursor_every_secs",
                &self.commit_firehose_cursor_every_secs,
            )
            .field("con_posts_spool_dir", &self.con_posts_spool_dir)
            .field("keydates_worker_cmd", &self.keydates_worker_cmd)
            .field("con_post_debounce_secs", &self.con_post_debounce_secs)
            .field("con_posts_daily_cap", &self.con_posts_daily_cap)
            .field(
                "telegram_bot_token",
                &self.telegram_bot_token.as_ref().map(|_| "<redacted>"),
            )
            .field("telegram_chat_id", &self.telegram_chat_id)
            .field("telegram_dry_run", &self.telegram_dry_run)
            .field("keydates_announce_cap", &self.keydates_announce_cap)
            .finish()
    }
}

struct EventsState {
    rkeys_to_ids: std::collections::HashMap<atrium_api::types::string::RecordKey, String>,
    events: std::collections::HashMap<String, AssociatedEvent>,
}

fn id_to_label(s: &str) -> String {
    static NUMBERS_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\d+").unwrap());
    NUMBERS_RE
        .replace_all(&s.to_ascii_lowercase(), |caps: &regex::Captures| {
            roman::to_roman(caps[0].parse().unwrap()).to_ascii_lowercase()
        })
        .to_string()
}

async fn list_all_records(
    agent: &bsky_session::BskyAgent,
    did: &atrium_api::types::string::Did,
) -> Result<
    Vec<atrium_api::com::atproto::repo::list_records::Record>,
    atrium_api::xrpc::Error<atrium_api::com::atproto::repo::list_records::Error>,
> {
    let mut cursor = None;

    let mut records = vec![];

    loop {
        let resp = agent
            .api
            .com
            .atproto
            .repo
            .list_records(
                atrium_api::com::atproto::repo::list_records::ParametersData {
                    collection: atrium_api::app::bsky::feed::Post::nsid(),
                    limit: Some(100.try_into().unwrap()),
                    cursor: cursor.clone(),
                    repo: did.clone().into(),
                    reverse: None,
                }
                .into(),
            )
            .await?;

        records.extend(resp.data.records);

        if resp.data.cursor.is_none() {
            break;
        }

        cursor = resp.data.cursor;
    }

    Ok(records)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlueskyRef {
    did: String,
    #[allow(dead_code)]
    handle: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IngestedEvent {
    id: String,
    name: String,
    venue: String,
    locale: String,
    address: Option<String>,
    start_date: chrono::NaiveDate,
    end_date: chrono::NaiveDate,
    timezone: Option<String>,
    #[serde(default)]
    series_id: Option<String>,
    #[serde(default)]
    bluesky: Option<BlueskyRef>,
    #[serde(default)]
    key_dates: Option<serde_json::Value>,
}

#[derive(Debug)]
struct AssociatedEvent {
    event: IngestedEvent,
    rkey: Option<atrium_api::types::string::RecordKey>,
    label_id: String,
}

impl IngestedEvent {
    fn end_time(&self) -> chrono::DateTime<chrono::Utc> {
        let date = self.end_date + chrono::Days::new(1);
        let timezone = self
            .timezone
            .as_ref()
            .and_then(|tz| tz.parse().ok())
            .unwrap_or(chrono_tz::UTC);

        date.and_time(chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap())
            .and_local_timezone(timezone)
            .earliest()
            .or_else(|| {
                self.end_date
                    .and_time(chrono::NaiveTime::from_hms_opt(1, 0, 0).unwrap())
                    .and_local_timezone(timezone)
                    .earliest()
            })
            .unwrap()
            .to_utc()
    }
}

async fn fetch_events(
    reqwest_client: &reqwest::Client,
    events_url: &str,
) -> Result<std::collections::HashMap<String, AssociatedEvent>, anyhow::Error> {
    reqwest_client
        .get(events_url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?
        .lines()
        .map(|line| {
            let event = serde_json::from_str::<IngestedEvent>(line)?;
            Ok::<_, anyhow::Error>((
                event.id.clone(),
                AssociatedEvent {
                    rkey: None,
                    label_id: id_to_label(&event.id),
                    event,
                },
            ))
        })
        .collect::<Result<_, _>>()
}

const EXTRA_DATA_POST_RKEY: &str = "fbl_postRkey";
const EXTRA_DATA_EVENT_ID: &str = "fbl_eventId";

#[derive(Debug)]
struct OldEvent {
    rkey: Option<atrium_api::types::string::RecordKey>,
    id: String,
}

const EXPIRY_DATE_GRACE_PERIOD: chrono::Days = chrono::Days::new(7);

async fn fetch_old_events(
    did: &atrium_api::types::string::Did,
    agent: &bsky_session::BskyAgent,
) -> Result<Option<std::collections::HashMap<String, OldEvent>>, anyhow::Error> {
    let Some(record) = match agent
        .api
        .com
        .atproto
        .repo
        .get_record(
            atrium_api::com::atproto::repo::get_record::ParametersData {
                collection: atrium_api::app::bsky::labeler::Service::nsid(),
                repo: did.clone().into(),
                rkey: atrium_api::types::string::RecordKey::new("self".to_string()).unwrap(),
                cid: None,
            }
            .into(),
        )
        .await
    {
        Ok(record) => Some(record),
        Err(atrium_api::xrpc::Error::XrpcResponse(atrium_api::xrpc::error::XrpcError {
            error:
                Some(atrium_api::xrpc::error::XrpcErrorKind::Custom(
                    atrium_api::com::atproto::repo::get_record::Error::RecordNotFound(..),
                )),
            ..
        })) => None,
        Err(err) => {
            return Err(err.into());
        }
    }
    .and_then(|record| {
        atrium_api::app::bsky::labeler::service::Record::try_from_unknown(record.data.value).ok()
    }) else {
        return Ok(None);
    };

    Ok(record
        .policies
        .data
        .label_value_definitions
        .as_ref()
        .map(|defs| {
            defs.iter()
                .flat_map(|v| {
                    let rkey = match v.extra_data.get(EXTRA_DATA_POST_RKEY).unwrap().unwrap() {
                        ipld_core::ipld::Ipld::Null => None,
                        ipld_core::ipld::Ipld::String(s) => {
                            Some(atrium_api::types::string::RecordKey::new(s.clone()).unwrap())
                        }
                        _ => {
                            unreachable!();
                        }
                    };

                    let id = match v.extra_data.get(EXTRA_DATA_EVENT_ID).unwrap().unwrap() {
                        ipld_core::ipld::Ipld::Null => {
                            return None;
                        }
                        ipld_core::ipld::Ipld::String(s) => s.clone(),
                        _ => {
                            unreachable!();
                        }
                    };

                    Some((v.identifier.clone(), OldEvent { rkey, id }))
                })
                .collect::<std::collections::HashMap<_, _>>()
        }))
}

#[allow(clippy::too_many_arguments)]
async fn sync_labels(
    reqwest_client: &reqwest::Client,
    events_url: &str,
    ui_endpoint: &str,
    did: &atrium_api::types::string::Did,
    agent: &bsky_session::BskyAgent,
    events_state: std::sync::Arc<tokio::sync::Mutex<EventsState>>,
    watchlist: con_posts::Watchlist,
    announcer: Option<&keydates_announce::Announcer>,
) -> Result<(), anyhow::Error> {
    // Lock the entire events state while labels are syncing.
    //
    // This means that we hold the mutex while events are being created, such that any likes on those posts must wait until the mutex is unlocked.
    // This ensures that we don't get into a state where if someone likes a post but we haven't saved it into the events state yet we end up missing their like.
    let mut events_state = events_state.lock().await;

    let now = chrono::Utc::now();

    let mut events = fetch_events(reqwest_client, events_url).await?;

    let mut writes = vec![];

    let mut old_events = fetch_old_events(did, agent).await?.unwrap_or_default();

    let record_rkeys = list_all_records(agent, did)
        .await?
        .into_iter()
        .map(|record| {
            let parts = record
                .uri
                .strip_prefix("at://")
                .map(|v| v.splitn(3, '/').collect::<Vec<_>>());

            let Some(&[_, _, rkey]) = parts.as_ref().map(|v| &v[..]) else {
                unreachable!();
            };

            atrium_api::types::string::RecordKey::new(rkey.to_string()).unwrap()
        })
        .collect::<std::collections::HashSet<atrium_api::types::string::RecordKey>>();

    old_events.retain(|_, oe| {
        if let Some(rkey) = oe.rkey.as_ref() {
            if !record_rkeys.contains(rkey) {
                log::info!("could not find {}, will recreate", rkey.as_str());
                return false;
            }
        }
        true
    });

    // Delete old events if we don't see them in our retrieved events.
    for (label_id, oe) in old_events.into_iter() {
        if let Some(event) = events.get_mut(&oe.id) {
            event.rkey = oe.rkey.clone();
            event.label_id = label_id;
            continue;
        }

        if let Some(rkey) = oe.rkey {
            writes.push(
                atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Delete(Box::new(
                    atrium_api::com::atproto::repo::apply_writes::DeleteData {
                        collection: atrium_api::app::bsky::feed::Post::nsid(),
                        rkey: rkey.clone(),
                    }
                    .into(),
                )),
            );
            writes.push(
                atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Delete(Box::new(
                    atrium_api::com::atproto::repo::apply_writes::DeleteData {
                        collection: atrium_api::app::bsky::feed::Threadgate::nsid(),
                        rkey: rkey.clone(),
                    }
                    .into(),
                )),
            );
        }
    }

    // Create new events.
    let mut sorted_events = events.iter_mut().collect::<Vec<_>>();
    sorted_events.sort_by_key(|(_, assoc_event)| {
        (
            assoc_event.event.start_date,
            assoc_event.event.end_date,
            assoc_event.event.id.clone(),
        )
    });
    {
        let mut created_at = now;

        for (_, assoc_event) in sorted_events.iter_mut() {
            if assoc_event.rkey.is_some() {
                continue;
            }

            let rkey = atrium_api::types::string::RecordKey::new(
                atrium_api::types::string::Tid::from_datetime(0.try_into().unwrap(), created_at)
                    .to_string(),
            )
            .unwrap();

            assoc_event.rkey = Some(rkey.clone());

            {
                let text = assoc_event.event.name.to_string();

                let record: atrium_api::app::bsky::feed::post::Record =
                    atrium_api::app::bsky::feed::post::RecordData {
                        created_at: atrium_api::types::string::Datetime::new(
                            created_at.fixed_offset(),
                        ),
                        embed: None,
                        entities: None,
                        labels: None,
                        langs: Some(vec![atrium_api::types::string::Language::new(
                            "en".to_string(),
                        )
                        .unwrap()]),
                        reply: None,
                        tags: None,
                        facets: Some(vec![atrium_api::app::bsky::richtext::facet::MainData {
                            features: vec![atrium_api::types::Union::Refs(
                                atrium_api::app::bsky::richtext::facet::MainFeaturesItem::Link(
                                    Box::new(
                                        atrium_api::app::bsky::richtext::facet::LinkData {
                                            uri: format!(
                                                "{}/{}",
                                                ui_endpoint, assoc_event.event.id
                                            ),
                                        }
                                        .into(),
                                    ),
                                ),
                            )],
                            index: atrium_api::app::bsky::richtext::facet::ByteSliceData {
                                byte_start: 0,
                                byte_end: text.len(),
                            }
                            .into(),
                        }
                        .into()]),
                        text,
                    }
                    .into();

                writes.push(
                    atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Create(
                        Box::new(
                            atrium_api::com::atproto::repo::apply_writes::CreateData {
                                collection: atrium_api::app::bsky::feed::Post::nsid(),
                                rkey: Some(rkey.clone()),
                                value: record.try_into_unknown().unwrap(),
                            }
                            .into(),
                        ),
                    ),
                );
            }

            {
                let record: atrium_api::app::bsky::feed::threadgate::Record =
                    atrium_api::app::bsky::feed::threadgate::RecordData {
                        created_at: atrium_api::types::string::Datetime::new(now.fixed_offset()),
                        allow: Some(vec![]),
                        hidden_replies: None,
                        post: format!(
                            "at://{}/{}/{}",
                            did.as_str(),
                            atrium_api::app::bsky::feed::Post::NSID,
                            rkey.as_str()
                        ),
                    }
                    .into();

                writes.push(
                    atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Create(
                        Box::new(
                            atrium_api::com::atproto::repo::apply_writes::CreateData {
                                collection: atrium_api::app::bsky::feed::Threadgate::nsid(),
                                rkey: Some(rkey.clone()),
                                value: record.try_into_unknown().unwrap(),
                            }
                            .into(),
                        ),
                    ),
                );
            }

            // https://github.com/bluesky-social/atproto/issues/2468#issuecomment-2100947405
            created_at += chrono::Duration::milliseconds(1);
        }
    }

    // Update the record.
    {
        let record: atrium_api::app::bsky::labeler::service::Record =
            atrium_api::app::bsky::labeler::service::RecordData {
                created_at: atrium_api::types::string::Datetime::new(now.fixed_offset()),
                labels: None,
                policies: atrium_api::app::bsky::labeler::defs::LabelerPoliciesData {
                    label_values: sorted_events.iter().filter(|(_, event)| {
                        event.rkey.as_ref().is_some()
                    }).map(|(_, event)| event.label_id.clone()).collect(),
                    label_value_definitions: Some(
                        sorted_events.iter()
                            .map(|(_, assoc_event)| {
                                let mut location = assoc_event.event.venue.clone();
                                if let Some(address) = &assoc_event.event.address {
                                    location.push_str(", ");
                                    location.push_str(address);
                                }
                                let mut def: atrium_api::com::atproto::label::defs::LabelValueDefinition = atrium_api::com::atproto::label::defs::LabelValueDefinitionData {
                                    adult_only: Some(false),
                                    blurs: "none".to_string(),
                                    default_setting: Some("warn".to_string()),
                                    identifier: assoc_event.label_id.clone(),
                                    locales: vec![atrium_api::com::atproto::label::defs::LabelValueDefinitionStringsData {
                                        lang: atrium_api::types::string::Language::new(
                                            assoc_event.event.locale.clone()
                                        )
                                        .unwrap(),
                                        name: assoc_event.event.name.clone(),
                                        description: format!(
                                            "📅 {start_date} – {end_date}\n📍 {location}",
                                            location = location,
                                            start_date = assoc_event.event.start_date,
                                            end_date = assoc_event.event.end_date
                                        ),
                                    }
                                    .into()],
                                    severity: "inform".to_string(),
                                }
                                .into();

                                let ipld_core::ipld::Ipld::Map(extra_data) = &mut def.extra_data
                                else {
                                    unreachable!()
                                };

                                extra_data.insert(
                                    EXTRA_DATA_POST_RKEY.to_string(),
                                    if let Some(rkey) = assoc_event.rkey.as_ref() {
                                        ipld_core::serde::to_ipld(rkey.to_string()).unwrap()
                                    } else {
                                        ipld_core::ipld::Ipld::Null
                                    },
                                );
                                extra_data.insert(
                                    EXTRA_DATA_EVENT_ID.to_string(),
                                    ipld_core::serde::to_ipld(&assoc_event.event.id).unwrap()
                                );

                                def
                            })
                            .collect(),
                    ),
                }
                .into(),
                reason_types: None,
                subject_collections: None,
                subject_types: None,
            }
            .into();

        writes.push(
            atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Update(Box::new(
                atrium_api::com::atproto::repo::apply_writes::UpdateData {
                    collection: atrium_api::app::bsky::labeler::Service::nsid(),
                    rkey: atrium_api::types::string::RecordKey::new("self".to_string()).unwrap(),
                    value: record.try_into_unknown().unwrap(),
                }
                .into(),
            )),
        );
    }

    log::info!("applying {} write(s)", writes.len());
    log::debug!("applying writes:\n{writes:#?}");

    const CHUNK_SIZE: usize = 200;
    for chunk in writes.chunks(CHUNK_SIZE) {
        agent
            .api
            .com
            .atproto
            .repo
            .apply_writes(
                atrium_api::com::atproto::repo::apply_writes::InputData {
                    repo: did.clone().into(),
                    swap_commit: None,
                    validate: Some(true),
                    writes: chunk.to_vec(),
                }
                .into(),
            )
            .await?;
    }

    events_state.rkeys_to_ids = sorted_events
        .iter()
        .flat_map(|(key, event)| {
            event
                .rkey
                .as_ref()
                .map(|rkey| (rkey.clone(), (*key).clone()))
        })
        .collect();

    // Rebuild the con-post watchlist (did -> series id) for key-date detection.
    {
        let mut watchlist = watchlist.write().await;
        watchlist.clear();
        for assoc_event in events.values() {
            if let (Some(series_id), Some(bluesky)) = (
                assoc_event.event.series_id.as_ref(),
                assoc_event.event.bluesky.as_ref(),
            ) {
                watchlist.insert(bluesky.did.clone(), series_id.clone());
            }
        }
        log::info!(
            "watching {} con accounts for key-date posts",
            watchlist.len()
        );
    }

    // Announce newly published key dates (post-merge data only) and advance
    // the snapshot. Failures are logged inside run(), never propagated.
    if let Some(announcer) = announcer {
        let announce_events = events
            .values()
            .map(|assoc_event| keydates_announce::EventKeyDates {
                event_id: assoc_event.event.id.clone(),
                name: assoc_event.event.name.clone(),
                key_dates: assoc_event.event.key_dates.clone(),
            })
            .collect::<Vec<_>>();
        announcer.run(&announce_events).await;
    }

    events_state.events = events;

    Ok(())
}

async fn read_jetstream_cursor(db_pool: &sqlx::PgPool) -> Result<Option<i64>, anyhow::Error> {
    let mut db_conn = db_pool.acquire().await?;
    Ok(
        sqlx::query_scalar!(r#"SELECT cursor FROM jetstream_cursor"#)
            .fetch_optional(&mut *db_conn)
            .await?,
    )
}

async fn service_jetstream(
    db_pool: &sqlx::PgPool,
    did: &atrium_api::types::string::Did,
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    events_state: std::sync::Arc<tokio::sync::Mutex<EventsState>>,
    jetstream_endpoints: Vec<url::Url>,
    commit_firehose_cursor_every: std::time::Duration,
) -> Result<(), anyhow::Error> {
    let mut cursor = read_jetstream_cursor(db_pool).await?;
    if jetstream_endpoints.is_empty() {
        log::warn!("no jetstream endpoints configured, won't service jetstream events");
        return Ok(());
    }
    let mut reconnector = jetstream::reconnect::Reconnector::new(
        jetstream_endpoints,
        jetstream::reconnect::Policy::default(),
    )?;

    loop {
        let endpoint = reconnector.endpoint().clone();
        let started = std::time::Instant::now();
        let mut lifetime = None;
        let result = service_jetstream_once(
            db_pool,
            did,
            keypair,
            events_state.clone(),
            &endpoint,
            commit_firehose_cursor_every,
            cursor,
            &mut lifetime,
        )
        .await;
        // Sample before the post-mortem below: a pool acquire in
        // `read_jetstream_cursor` can wait up to 30s and would let a bad 35s
        // connection pass as healthy, resetting the failure streak forever.
        // Prefer the socket's own lifetime: the relay buffer can stretch the
        // consumer's view of a 45s connection past `healthy_after` too.
        let lived = lifetime
            .as_ref()
            .and_then(|l| l.ended_after())
            .unwrap_or_else(|| started.elapsed());
        let next = match result {
            Ok(next_cursor) => {
                // Only the server ends this stream, so a clean close is still
                // a disconnect for backoff/failover purposes — a host that
                // politely closes every 45s is as unusable as one that resets.
                cursor = next_cursor;
                reconnector.after(jetstream::reconnect::Outcome::HostError, lived)
            }
            Err(e) => {
                log::error!("Jetstream disconnected ({endpoint}): {e}");
                let outcome = jetstream::reconnect::classify(&e);
                // The in-memory cursor is only updated on clean exits, so after
                // an error it can be hours stale — reconnecting from it replays
                // already-committed events and drags jetstream_cursor backward.
                // Resume from the persisted cursor (committed every few seconds)
                // instead.
                match read_jetstream_cursor(db_pool).await {
                    Ok(persisted) => cursor = persisted,
                    Err(e) => log::error!("could not re-read cursor: {e}"),
                }
                let next = reconnector.after(outcome, lived);
                if outcome == jetstream::reconnect::Outcome::LocalError {
                    log::error!(
                        "Jetstream: local error, retrying same host in {:?}",
                        next.delay
                    );
                }
                next
            }
        };
        // Rewind on a host switch only (see Next::rewind); a replay re-emits
        // labels as duplicate rows (a few seconds on a legacy host, up to an
        // hour on a v2 host — see DEFAULT_ENDPOINTS), harmless to set-based
        // label consumers.
        cursor = next.rewind(cursor);
        if next.switched {
            log::error!(
                "Jetstream: repeated short connections to {endpoint}, failing over to {}",
                reconnector.endpoint()
            );
        }
        tokio::time::sleep(next.delay).await;
    }
}

/// Longest the labeler tolerates between events before treating the host as
/// dead. 30s: far above any real gap on the like firehose, and under
/// `reconnect::Policy::healthy_after` (300s) so a host that connects, says
/// nothing and gets cut here can never be scored healthy.
const EVENT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

// The `lifetime` out-param tips this over clippy's limit; bundling the
// arguments into a struct for that alone isn't worth it.
#[allow(clippy::too_many_arguments)]
async fn service_jetstream_once(
    db_pool: &sqlx::PgPool,
    did: &atrium_api::types::string::Did,
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    events_state: std::sync::Arc<tokio::sync::Mutex<EventsState>>,
    jetstream_endpoint: &url::Url,
    commit_firehose_cursor_every: std::time::Duration,
    mut cursor: Option<i64>,
    // Out-param so the caller can read the socket's lifetime on the error
    // path too (the error type carries nothing).
    lifetime: &mut Option<jetstream::SocketLifetime>,
) -> Result<Option<i64>, anyhow::Error> {
    let (js, socket_lifetime) = jetstream::connect(
        jetstream_endpoint,
        jetstream::ConnectOptions {
            wanted_collections: vec![atrium_api::app::bsky::feed::Like::nsid()],
            cursor,
            compress: true,
            ..Default::default()
        },
    )
    .await?;
    *lifetime = Some(socket_lifetime);
    futures::pin_mut!(js);

    let mut last_firehose_commit_time = std::time::SystemTime::now();

    // Bounded: the unfiltered like firehose runs hundreds of events/s, so
    // silence for EVENT_DEADLINE is a dead host, not a lull. The bail is a
    // HostError to `reconnect::classify`, so it counts toward failover.
    // (con_posts watches ~80 accounts and legitimately idles; no deadline
    // there.)
    while let Some(event) = tokio::time::timeout(EVENT_DEADLINE, js.next())
        .await
        .map_err(|_| {
            anyhow::anyhow!("no events for {EVENT_DEADLINE:?} on an unfiltered like subscription")
        })?
    {
        let event = event?;

        let jetstream::event::EventKind::Commit { commit } = event.kind else {
            continue;
        };

        let mut db_conn = db_pool.acquire().await?;

        async {
            match commit.operation {
                jetstream::event::CommitOperation::Create { record, .. } => {
                    let atrium_api::record::KnownRecord::AppBskyFeedLike(like) = record else {
                        return Ok(());
                    };

                    let Some(target_rkey) = liked_post_rkey(&like.subject.uri, did.as_str()) else {
                        return Ok(());
                    };

                    let events_state = events_state.lock().await;

                    let Some(id) = events_state.rkeys_to_ids.get(&target_rkey).cloned() else {
                        return Ok(());
                    };

                    let assoc_event = events_state.events.get(&id).unwrap();

                    let Some(cts) = event_time(event.time_us) else {
                        return Ok(());
                    };

                    let label: atrium_api::com::atproto::label::defs::Label =
                        atrium_api::com::atproto::label::defs::LabelData {
                            cts: atrium_api::types::string::Datetime::new(cts.fixed_offset()),
                            exp: Some(atrium_api::types::string::Datetime::new(
                                (assoc_event.event.end_time() + EXPIRY_DATE_GRACE_PERIOD)
                                    .to_utc()
                                    .fixed_offset(),
                            )),
                            src: did.clone(),
                            cid: None,
                            neg: None,
                            uri: event.did.to_string(),
                            val: assoc_event.label_id.clone(),
                            sig: None,
                            ver: Some(1),
                        }
                        .into();

                    log::info!("applying label: {:?}", label);

                    let mut tx = db_conn.begin().await?;
                    labels::emit(keypair, &mut tx, &label, &commit.rkey).await?;
                    tx.commit().await?;
                }
                jetstream::event::CommitOperation::Delete { .. } => {
                    let uri = event.did.to_string();

                    let Some(val) = sqlx::query_scalar!(
                        r#"
                        SELECT val FROM labels
                        WHERE like_rkey = $1 AND uri = $2 AND NOT neg
                        ORDER BY seq DESC
                        LIMIT 1
                        "#,
                        commit.rkey,
                        uri
                    )
                    .fetch_optional(&mut *db_conn)
                    .await?
                    else {
                        return Ok(());
                    };

                    let Some(cts) = event_time(event.time_us) else {
                        return Ok(());
                    };

                    let label: atrium_api::com::atproto::label::defs::Label =
                        atrium_api::com::atproto::label::defs::LabelData {
                            cts: atrium_api::types::string::Datetime::new(cts.fixed_offset()),
                            exp: None,
                            src: did.clone(),
                            cid: None,
                            neg: Some(true),
                            uri,
                            val,
                            sig: None,
                            ver: Some(1),
                        }
                        .into();

                    log::info!("removing label: {:?}", label);

                    let mut tx = db_conn.begin().await?;
                    labels::emit(keypair, &mut tx, &label, &commit.rkey).await?;
                    tx.commit().await?;
                }
                _ => {}
            }

            Ok::<_, anyhow::Error>(())
        }
        .await?;

        let Some(event_cursor) = event_cursor(event.time_us) else {
            continue;
        };

        let now = std::time::SystemTime::now();
        if now >= last_firehose_commit_time + commit_firehose_cursor_every {
            let mut tx = db_conn.begin().await?;
            sqlx::query!(r#"SET LOCAL synchronous_commit TO OFF"#)
                .execute(&mut *tx)
                .await?;
            sqlx::query!(
                r#"
                INSERT INTO jetstream_cursor (cursor) VALUES ($1)
                ON CONFLICT ((true)) DO UPDATE SET cursor = excluded.cursor
                "#,
                event_cursor,
            )
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            last_firehose_commit_time = now;
        }

        cursor = Some(event_cursor);
    }

    Ok(cursor)
}

/// The event's Jetstream timestamp, or `None` (logged) when `time_us` is out
/// of range. A panic or an error would take down or replay the connection,
/// so the caller skips the event instead.
fn event_time(time_us: u64) -> Option<chrono::DateTime<chrono::Utc>> {
    let time = parse_time_us(time_us);
    if time.is_none() {
        log::warn!("skipping event with out-of-range time_us {time_us}");
    }
    time
}

/// `time_us` as a timestamp, if it is one we can use. `as i64` would wrap
/// values above `i64::MAX` to a pre-1970 date, and atrium's `Datetime::new`
/// panics outside the i64-nanosecond range (about 1677 to 2262), which is
/// much narrower than chrono's.
fn parse_time_us(time_us: u64) -> Option<chrono::DateTime<chrono::Utc>> {
    i64::try_from(time_us)
        .ok()
        .and_then(chrono::DateTime::from_timestamp_micros)
        .filter(|time| time.timestamp_nanos_opt().is_some())
}

/// The cursor to save after an event, or `None` to leave it where it is.
/// An unusable `time_us` must not become the cursor: the next reconnect
/// would resume from it.
fn event_cursor(time_us: u64) -> Option<i64> {
    parse_time_us(time_us).map(|time| time.timestamp_micros())
}

/// The rkey of the post in `did`'s repo that a like's subject URI points at,
/// or `None` when the like is for anything else.
fn liked_post_rkey(subject_uri: &str, did: &str) -> Option<atrium_api::types::string::RecordKey> {
    // Runs on every like in the firehose, nearly all for other repos, so
    // reject on the DID before doing anything that allocates.
    let (collection, target_rkey) = subject_uri
        .strip_prefix("at://")?
        .strip_prefix(did)?
        .strip_prefix('/')?
        .split_once('/')?;

    if collection != atrium_api::app::bsky::feed::Post::NSID {
        return None;
    }

    // Anyone can put any string in a like's subject URI, so a bad rkey is
    // skipped, not unwrapped: a panic here would take the ingester down, and
    // an error would reconnect and replay the same event from the cursor.
    match atrium_api::types::string::RecordKey::new(target_rkey.to_string()) {
        Ok(rkey) => Some(rkey),
        Err(err) => {
            let shown = target_rkey.chars().take(64).collect::<String>();
            log::warn!("skipping like with malformed subject rkey {shown:?}: {err}");
            None
        }
    }
}

/// A pinned `jetstream_endpoint` goes first; the list follows, minus any
/// duplicate of the pin, so failover still has somewhere to go. Pin plus an
/// empty list is the exclusive pin: `[pin]`, which never switches.
fn jetstream_dial_order(pinned: Option<&url::Url>, list: &[url::Url]) -> Vec<url::Url> {
    // Dedupe the whole order, not just against the pin: a repeated host
    // would make the policy "fail over" (and rewind the cursor) onto the
    // same dead endpoint.
    let mut out: Vec<url::Url> = Vec::with_capacity(list.len() + 1);
    for u in pinned.into_iter().chain(list) {
        if !out.contains(u) {
            out.push(u.clone());
        }
    }
    out
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    env_logger::init();

    let config: Config = config::Config::builder()
        .add_source(config::File::with_name("config.toml"))
        .set_default("bsky_endpoint", "https://bsky.social")?
        .set_default("events_url", "https://data.cons.fyi/current.jsonl")?
        .set_default("keypair_path", "signing.key")?
        .set_default("ui_endpoint", "https://cons.fyi")?
        .set_default("jetstream_endpoints", jetstream::DEFAULT_ENDPOINTS.to_vec())?
        .set_default("label_sync_delay_secs", 60 * 60)?
        .set_default("ingester_bind", "127.0.0.1:3002")?
        .set_default("commit_firehose_cursor_every_secs", 5)?
        .set_default("con_post_debounce_secs", 15 * 60)?
        .set_default("con_posts_daily_cap", 30)?
        .set_default("telegram_dry_run", true)?
        .set_default("keydates_announce_cap", 10)?
        .build()?
        .try_deserialize()?;
    log::info!("config: {config:?}");

    let keypair =
        atrium_crypto::keypair::Secp256k1Keypair::import(&std::fs::read(&config.keypair_path)?)?;

    let events_state = std::sync::Arc::new(tokio::sync::Mutex::new(EventsState {
        rkeys_to_ids: std::collections::HashMap::new(),
        events: std::collections::HashMap::new(),
    }));

    let reqwest_client = reqwest::Client::new();

    let agent = std::sync::Arc::new(bsky_session::BskyAgent::new(
        atrium_xrpc_client::reqwest::ReqwestClientBuilder::new(&config.bsky_endpoint)
            .client(reqwest_client.clone())
            .build(),
        atrium_api::agent::atp_agent::store::MemorySessionStore::default(),
    ));
    agent
        .login(&config.bsky_username, &config.bsky_password)
        .await?;

    let did = agent.did().await.unwrap();

    let db_pool = sqlx::PgPool::connect(&config.postgres_url).await?;

    let watchlist: con_posts::Watchlist =
        std::sync::Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));

    let announcer = std::sync::Arc::new(keydates_announce::Announcer {
        db_pool: db_pool.clone(),
        reqwest_client: reqwest_client.clone(),
        ui_endpoint: config.ui_endpoint.clone(),
        bot_token: config.telegram_bot_token.clone(),
        chat_id: config.telegram_chat_id.clone(),
        dry_run: config.telegram_dry_run,
        cap_per_sync: config.keydates_announce_cap,
    });

    log::info!("syncing initial labels");

    bsky_session::with_session(&agent, &config.bsky_username, &config.bsky_password, || {
        sync_labels(
            &reqwest_client,
            &config.events_url,
            &config.ui_endpoint,
            &did,
            &agent,
            events_state.clone(),
            watchlist.clone(),
            Some(&announcer),
        )
    })
    .await?;

    let listener = tokio::net::TcpListener::bind(&config.ingester_bind).await?;

    let app = axum::Router::new().route(
        "/trigger",
        axum::routing::post({
            let did = did.clone();
            let events_state = events_state.clone();
            let watchlist = watchlist.clone();
            let announcer = announcer.clone();
            let triggering = std::sync::Arc::new(tokio::sync::Mutex::new(()));
            || async move {
                let Ok(_guard) = triggering.try_lock() else {
                    return (axum::http::StatusCode::CONFLICT, "already in progress!")
                        .into_response();
                };

                match bsky_session::with_session(
                    &agent,
                    &config.bsky_username,
                    &config.bsky_password,
                    || {
                        sync_labels(
                            &reqwest_client,
                            &config.events_url,
                            &config.ui_endpoint,
                            &did,
                            &agent,
                            events_state.clone(),
                            watchlist.clone(),
                            Some(&announcer),
                        )
                    },
                )
                .await
                {
                    Ok(_) => (axum::http::StatusCode::OK, "ok :)").into_response(),
                    Err(e) => {
                        log::error!("Failed to sync labels: {e}");
                        (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "uh oh :(").into_response()
                    }
                }
            }
        }),
    );

    let jetstream_endpoints = jetstream_dial_order(
        config.jetstream_endpoint.as_ref(),
        &config.jetstream_endpoints,
    );
    let con_posts_endpoints = jetstream_endpoints.clone();
    let con_posts_options =
        config
            .con_posts_spool_dir
            .clone()
            .map(|spool_dir| con_posts::Options {
                spool_dir,
                worker_cmd: config.keydates_worker_cmd.clone(),
                debounce: std::time::Duration::from_secs(config.con_post_debounce_secs),
                daily_cap: config.con_posts_daily_cap,
                commit_cursor_every: std::time::Duration::from_secs(
                    config.commit_firehose_cursor_every_secs,
                ),
            });

    tokio::try_join!(
        async {
            // Wait on events. Returns only when no endpoints are configured
            // (firehose off).
            service_jetstream(
                &db_pool,
                &did,
                &keypair,
                events_state.clone(),
                jetstream_endpoints,
                std::time::Duration::from_secs(config.commit_firehose_cursor_every_secs),
            )
            .await?;
            Ok::<_, anyhow::Error>(())
        },
        async {
            // Serve labeler.
            axum::serve(listener, app).await?;
            unreachable!();

            #[allow(unreachable_code)]
            Ok::<_, anyhow::Error>(())
        },
        async {
            // Watch con accounts for key-date posts (second Jetstream
            // connection; the like connection must stay unfiltered by DID).
            let Some(options) = con_posts_options else {
                log::info!("con_posts_spool_dir not configured, key-date detection off");
                return Ok(());
            };

            // Returns only when no endpoints are configured (firehose off).
            con_posts::service(&db_pool, watchlist.clone(), con_posts_endpoints, options).await?;
            Ok::<_, anyhow::Error>(())
        }
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    // A silent host cut by the deadline must never be scored healthy.
    #[test]
    fn event_deadline_is_under_healthy_after() {
        assert!(EVENT_DEADLINE < jetstream::reconnect::Policy::default().healthy_after);
        // ...and long enough that it can't fire before a dial could: a tiny
        // value would put the labeler into a bail/rotate storm.
        assert!(EVENT_DEADLINE > jetstream::CONNECT_TIMEOUT);
    }

    #[test]
    fn default_endpoints_parse() {
        for e in jetstream::DEFAULT_ENDPOINTS {
            assert_eq!(u(e).path(), "/subscribe", "{e}");
        }
    }

    // Legacy hosts honour a timestamp cursor exactly; the v2 hosts clamp a
    // fresh cursor to the start of their active log segment (up to an hour
    // of replay per connect), so they must never be dialed first.
    #[test]
    fn default_dial_order_is_legacy_first_v2_last() {
        let hosts: Vec<&str> = jetstream::DEFAULT_ENDPOINTS
            .iter()
            .map(|e| u(e).host_str().unwrap().to_owned())
            .map(|h| Box::leak(h.into_boxed_str()) as &str)
            .collect();
        let (legacy, v2): (Vec<_>, Vec<_>) = hosts
            .iter()
            .partition(|h| h.starts_with("jetstream1.") || h.starts_with("jetstream2."));
        assert_eq!(legacy.len(), 4);
        assert_eq!(v2.len(), 2);
        assert!(
            hosts[..4].iter().all(|h| legacy.contains(&h)),
            "v2 host dialed before a legacy host: {hosts:?}"
        );
        // Regions alternate so one failover skips a regional problem.
        let region = |h: &str| {
            if h.contains(".us-east.") {
                "east"
            } else {
                "west"
            }
        };
        for pair in hosts.windows(2) {
            assert_ne!(
                region(pair[0]),
                region(pair[1]),
                "same region twice in a row: {hosts:?}"
            );
        }
    }

    // The defaults path hands `config` a Vec<&str>; make sure it comes back
    // out as Vec<Url> in dial order.
    #[test]
    fn default_endpoints_survive_the_config_builder() {
        let got: Vec<url::Url> = config::Config::builder()
            .set_default("jetstream_endpoints", jetstream::DEFAULT_ENDPOINTS.to_vec())
            .unwrap()
            .build()
            .unwrap()
            .get("jetstream_endpoints")
            .unwrap();
        let want: Vec<url::Url> = jetstream::DEFAULT_ENDPOINTS.iter().map(|e| u(e)).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn pinned_endpoint_dials_first_without_duplicate() {
        let list = [u("wss://a/subscribe"), u("wss://b/subscribe")];
        assert_eq!(
            jetstream_dial_order(Some(&u("wss://b/subscribe")), &list),
            vec![u("wss://b/subscribe"), u("wss://a/subscribe")]
        );
        assert_eq!(
            jetstream_dial_order(Some(&u("wss://c/subscribe")), &list),
            vec![
                u("wss://c/subscribe"),
                u("wss://a/subscribe"),
                u("wss://b/subscribe")
            ]
        );
        assert_eq!(jetstream_dial_order(None, &list), list.to_vec());
        // Pin + empty list = exclusive pin (single endpoint, never switches).
        assert_eq!(
            jetstream_dial_order(Some(&u("wss://c/subscribe")), &[]),
            vec![u("wss://c/subscribe")]
        );
        // A repeated host in the list collapses to one entry.
        assert_eq!(
            jetstream_dial_order(None, &[u("wss://a/subscribe"), u("wss://a/subscribe")]),
            vec![u("wss://a/subscribe")]
        );
    }

    const DID: &str = "did:plc:labeler";

    fn uri(did: &str, collection: &str, rkey: &str) -> String {
        format!("at://{did}/{collection}/{rkey}")
    }

    #[test]
    fn liked_post_rkey_returns_valid_rkey() {
        let rkey = liked_post_rkey(&uri(DID, "app.bsky.feed.post", "3kabc2xyz"), DID).unwrap();
        assert_eq!(rkey.as_str(), "3kabc2xyz");
    }

    #[test]
    fn liked_post_rkey_skips_malformed_rkey() {
        // The subject URI is whatever the liker wrote; none of these is a
        // valid rkey, and none may take the process down.
        for bad in ["", ".", "..", "a/b", "has space", "a#b", &"x".repeat(513)] {
            assert!(
                liked_post_rkey(&uri(DID, "app.bsky.feed.post", bad), DID).is_none(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn event_time_skips_out_of_range_time_us() {
        // Wraps negative through `as i64`.
        assert!(event_time(u64::MAX).is_none());
        assert!(event_time(i64::MAX as u64 + 1).is_none());
        // Fits in i64 but is past chrono's range.
        assert!(event_time(i64::MAX as u64).is_none());
        // In chrono's range but one microsecond past i64 nanoseconds, where
        // atrium's Datetime::new panics.
        assert!(event_time(9_223_372_036_854_776).is_none());
    }

    #[test]
    fn event_time_accepts_last_nanosecond_representable_time_us() {
        let time = event_time(9_223_372_036_854_775).unwrap();
        // The label path must not panic on it.
        let cts = atrium_api::types::string::Datetime::new(time.fixed_offset());
        assert_eq!(cts.as_str(), "2262-04-11T23:47:16.854775Z");
    }

    #[test]
    fn event_cursor_only_advances_on_usable_time_us() {
        assert_eq!(
            event_cursor(1_700_000_000_123_456),
            Some(1_700_000_000_123_456)
        );
        assert_eq!(
            event_cursor(9_223_372_036_854_775),
            Some(9_223_372_036_854_775)
        );
        for bad in [
            u64::MAX,
            i64::MAX as u64 + 1,
            i64::MAX as u64,
            9_223_372_036_854_776,
        ] {
            assert_eq!(event_cursor(bad), None, "{bad}");
        }
    }

    #[test]
    fn event_time_converts_valid_time_us() {
        assert_eq!(
            event_time(1_700_000_000_123_456).unwrap().to_rfc3339(),
            "2023-11-14T22:13:20.123456+00:00"
        );
    }

    #[test]
    fn liked_post_rkey_ignores_other_subjects() {
        assert!(
            liked_post_rkey(&uri("did:plc:other", "app.bsky.feed.post", "3kabc"), DID).is_none()
        );
        assert!(liked_post_rkey(&uri(DID, "app.bsky.feed.like", "3kabc"), DID).is_none());
        // A DID that merely starts with ours is someone else's repo.
        assert!(
            liked_post_rkey(&uri("did:plc:labelerx", "app.bsky.feed.post", "3kabc"), DID).is_none()
        );
        assert!(liked_post_rkey("https://example.com/x", DID).is_none());
        assert!(liked_post_rkey(&format!("at://{DID}/app.bsky.feed.post"), DID).is_none());
    }

    /// A one-shot Jetstream host on localhost: accepts one connection, sends
    /// `frames` as uncompressed text, then closes.
    async fn fake_jetstream(frames: Vec<String>) -> url::Url {
        use futures::SinkExt as _;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            for frame in frames {
                ws.send(tokio_tungstenite::tungstenite::Message::Text(frame))
                    .await
                    .unwrap();
            }
            let _ = ws.close(None).await;
            while ws.next().await.is_some() {}
        });
        url::Url::parse(&format!("ws://{addr}/subscribe")).unwrap()
    }

    /// A like delete as Jetstream sends it.
    fn unlike_event(time_us: u64, like_rkey: &str) -> String {
        serde_json::json!({
            "did": "did:plc:liker",
            "time_us": time_us,
            "kind": "commit",
            "commit": {
                "rev": "3kaaaaaaaaa22",
                "operation": "delete",
                "collection": "app.bsky.feed.like",
                "rkey": like_rkey,
            },
        })
        .to_string()
    }

    /// A like commit as Jetstream sends it.
    fn like_event(time_us: u64, subject_uri: &str) -> String {
        serde_json::json!({
            "did": "did:plc:liker",
            "time_us": time_us,
            "kind": "commit",
            "commit": {
                "rev": "3kaaaaaaaaa22",
                "operation": "create",
                "collection": "app.bsky.feed.like",
                "rkey": "3kbbbbbbbbb22",
                "cid": "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
                "record": {
                    "$type": "app.bsky.feed.like",
                    "subject": {
                        "uri": subject_uri,
                        "cid": "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
                    },
                    "createdAt": "2026-01-01T00:00:00Z",
                },
            },
        })
        .to_string()
    }

    // The event loop end to end, against a fake Jetstream host and a fresh
    // Postgres database. A like with a malformed subject is skipped, but the
    // cursor still moves past it, to the same value in memory and in the
    // database. Two events with an unusable time_us follow: a like of a
    // tracked post, and the delete of a like that already has a label. Both
    // are skipped at the label timestamp check, so neither writes a label or
    // moves the cursor. No event drops the connection.
    //
    // Needs Postgres: CI's "sqlx cache up to date" job runs it. Locally, set
    // DATABASE_URL and run `cargo test pg_ -- --ignored`.
    #[sqlx::test(migrations = false)]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn pg_event_loop_skips_bad_events_and_saves_the_cursor(pool: sqlx::PgPool) {
        sqlx::raw_sql(include_str!("../schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        // The label an earlier like produced, so the delete gets past its
        // lookup and reaches the label timestamp check.
        sqlx::query(
            "INSERT INTO labels (val, uri, payload, like_rkey) \
             VALUES ('testcon', 'did:plc:liker', '\\x00', '3klabeled22')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let good_time_us: u64 = 1_700_000_000_123_456;
        let malformed = uri(DID, "app.bsky.feed.post", "has space");
        let tracked = uri(DID, "app.bsky.feed.post", "3kpost222");
        let endpoint = fake_jetstream(vec![
            like_event(good_time_us, &malformed),
            like_event(u64::MAX, &tracked),
            unlike_event(u64::MAX, "3klabeled22"),
        ])
        .await;

        let did: atrium_api::types::string::Did = DID.parse().unwrap();
        let keypair = atrium_crypto::keypair::Secp256k1Keypair::import(&[7u8; 32]).unwrap();
        // The second like targets this event's post, so it gets past the
        // rkey lookups and reaches the label timestamp check.
        let post_rkey: atrium_api::types::string::RecordKey = "3kpost222".parse().unwrap();
        let event: IngestedEvent = serde_json::from_value(serde_json::json!({
            "id": "testcon-2026",
            "name": "TestCon 2026",
            "venue": "Hall",
            "locale": "en",
            "startDate": "2026-01-01",
            "endDate": "2026-01-02",
        }))
        .unwrap();
        let events_state = std::sync::Arc::new(tokio::sync::Mutex::new(EventsState {
            rkeys_to_ids: [(post_rkey.clone(), "testcon-2026".to_string())].into(),
            events: [(
                "testcon-2026".to_string(),
                AssociatedEvent {
                    event,
                    rkey: Some(post_rkey),
                    label_id: "testcon".to_string(),
                },
            )]
            .into(),
        }));
        let mut lifetime = None;

        let cursor = service_jetstream_once(
            &pool,
            &did,
            &keypair,
            events_state,
            &endpoint,
            // Save the cursor after every event.
            std::time::Duration::ZERO,
            Some(1),
            &mut lifetime,
        )
        .await
        .expect("the loop should skip both events and end cleanly on Close");

        let want = Some(i64::try_from(good_time_us).unwrap());
        assert_eq!(cursor, want, "returned cursor");
        assert_eq!(
            read_jetstream_cursor(&pool).await.unwrap(),
            want,
            "saved cursor"
        );
        let labels: i64 = sqlx::query_scalar("SELECT count(*) FROM labels")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(labels, 1, "no label beyond the seeded one");
    }

    /// A frame that doesn't decode, between two good events, must not end the
    /// connection: the cursor moves past it to the event after it (CON-77).
    /// Before the fix the loop returned an error here, and every reconnect
    /// resumed before the bad frame and failed on it again.
    #[sqlx::test(migrations = false)]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn pg_event_loop_skips_an_undecodable_frame(pool: sqlx::PgPool) {
        sqlx::raw_sql(include_str!("../schema.sql"))
            .execute(&pool)
            .await
            .unwrap();

        let first_time_us: u64 = 1_700_000_000_000_001;
        let second_time_us: u64 = 1_700_000_000_000_002;
        let elsewhere = uri("did:plc:other", "app.bsky.feed.post", "3kpost222");
        let endpoint = fake_jetstream(vec![
            like_event(first_time_us, &elsewhere),
            "not json".to_string(),
            like_event(second_time_us, &elsewhere),
        ])
        .await;

        let did: atrium_api::types::string::Did = DID.parse().unwrap();
        let keypair = atrium_crypto::keypair::Secp256k1Keypair::import(&[7u8; 32]).unwrap();
        let events_state = std::sync::Arc::new(tokio::sync::Mutex::new(EventsState {
            rkeys_to_ids: Default::default(),
            events: Default::default(),
        }));
        let mut lifetime = None;

        let cursor = service_jetstream_once(
            &pool,
            &did,
            &keypair,
            events_state,
            &endpoint,
            // Save the cursor after every event.
            std::time::Duration::ZERO,
            Some(1),
            &mut lifetime,
        )
        .await
        .expect("the loop should skip the bad frame and end cleanly on Close");

        let want = Some(i64::try_from(second_time_us).unwrap());
        assert_eq!(cursor, want, "returned cursor");
        assert_eq!(
            read_jetstream_cursor(&pool).await.unwrap(),
            want,
            "saved cursor"
        );
    }

    /// A valid unlike negates the label its like produced, for that liker
    /// only: someone else's unlike with the same like rkey must not touch it
    /// (CON-78).
    #[sqlx::test(migrations = false)]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn pg_event_loop_negates_the_label_on_unlike(pool: sqlx::PgPool) {
        sqlx::raw_sql(include_str!("../schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        // The label did:plc:liker's like produced.
        sqlx::query(
            "INSERT INTO labels (val, uri, payload, like_rkey) \
             VALUES ('testcon', 'did:plc:liker', '\\x00', '3klabeled22')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let other_time_us: u64 = 1_700_000_000_000_001;
        let unlike_time_us: u64 = 1_700_000_000_000_002;
        let endpoint = fake_jetstream(vec![
            unlike_event(other_time_us, "3klabeled22")
                .replace("did:plc:liker", "did:plc:someoneelse"),
            unlike_event(unlike_time_us, "3klabeled22"),
        ])
        .await;

        let did: atrium_api::types::string::Did = DID.parse().unwrap();
        let keypair = atrium_crypto::keypair::Secp256k1Keypair::import(&[7u8; 32]).unwrap();
        let events_state = std::sync::Arc::new(tokio::sync::Mutex::new(EventsState {
            rkeys_to_ids: Default::default(),
            events: Default::default(),
        }));
        let mut lifetime = None;

        let cursor = service_jetstream_once(
            &pool,
            &did,
            &keypair,
            events_state,
            &endpoint,
            std::time::Duration::ZERO,
            Some(1),
            &mut lifetime,
        )
        .await
        .expect("the loop should process both unlikes and end cleanly on Close");

        assert_eq!(cursor, Some(i64::try_from(unlike_time_us).unwrap()));
        let negs: Vec<(String, String, String)> =
            sqlx::query_as("SELECT val, uri, like_rkey FROM labels WHERE neg ORDER BY seq")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            negs,
            vec![(
                "testcon".to_string(),
                "did:plc:liker".to_string(),
                "3klabeled22".to_string()
            )],
            "exactly one negation, for the liker who unliked"
        );
    }
}
