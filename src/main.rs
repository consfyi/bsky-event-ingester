use atrium_api::types::{Collection as _, TryFromUnknown as _, TryIntoUnknown as _};
use axum::response::IntoResponse as _;
use bsky_event_ingester::*;
use futures::StreamExt as _;
use sqlx::Acquire as _;

#[derive(serde::Deserialize, Debug)]
struct Config {
    bsky_username: String,
    bsky_password: String,
    bsky_endpoint: String,
    ui_endpoint: String,
    jetstream_endpoint: String,
    events_url: String,
    postgres_url: String,
    keypair_path: String,
    ingester_bind: std::net::SocketAddr,
    commit_firehose_cursor_every_secs: u64,
}

struct EventsState {
    rkeys_to_ids: std::collections::HashMap<atrium_api::types::string::RecordKey, String>,
    events: std::collections::HashMap<String, AssociatedEvent>,
}

async fn list_all_records(
    agent: &atrium_api::agent::Agent<
        atrium_api::agent::atp_agent::CredentialSession<
            atrium_api::agent::atp_agent::store::MemorySessionStore,
            atrium_xrpc_client::reqwest::ReqwestClient,
        >,
    >,
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
struct IngestedEvent {
    id: String,
    name: String,
    venue: String,
    address: Option<String>,
    country: Option<String>,
    start_date: chrono::NaiveDate,
    end_date: chrono::NaiveDate,
    timezone: Option<String>,
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
        let tz = self
            .timezone
            .as_ref()
            .and_then(|tz| tz.parse().ok())
            .unwrap_or(chrono_tz::UTC);

        date.and_time(chrono::NaiveTime::MIN)
            .and_local_timezone(tz)
            .earliest()
            .unwrap_or_else(|| {
                // Some timezones (e.g. America/Santiago going into DST have no
                // midnight, so we pick 1am here)
                date.and_time(chrono::NaiveTime::MIN + chrono::Duration::hours(1))
                    .and_local_timezone(tz)
                    .earliest()
                    .unwrap()
            })
            .to_utc()
    }
}

async fn fetch_events(
    reqwest_client: &reqwest::Client,
    events_url: &str,
) -> Result<std::collections::HashMap<String, AssociatedEvent>, anyhow::Error> {
    Ok(reqwest_client
        .get(events_url)
        .send()
        .await?
        .error_for_status()?
        .json::<Vec<IngestedEvent>>()
        .await?
        .into_iter()
        .map(|event| {
            let langid = event
                .country
                .as_ref()
                .and_then(|c| c.parse().ok())
                .map(|region| slug::guess_language_for_region(region))
                .unwrap_or(icu_locale::LanguageIdentifier::UNKNOWN);

            (
                event.id.clone(),
                AssociatedEvent {
                    rkey: None,
                    label_id: slug::slugify_for_label(&event.name, &langid),
                    event,
                },
            )
        })
        .collect())
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
    agent: &atrium_api::agent::Agent<
        atrium_api::agent::atp_agent::CredentialSession<
            atrium_api::agent::atp_agent::store::MemorySessionStore,
            atrium_xrpc_client::reqwest::ReqwestClient,
        >,
    >,
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

async fn sync_labels(
    reqwest_client: &reqwest::Client,
    events_url: &str,
    ui_endpoint: &str,
    did: &atrium_api::types::string::Did,
    agent: &atrium_api::agent::Agent<
        atrium_api::agent::atp_agent::CredentialSession<
            atrium_api::agent::atp_agent::store::MemorySessionStore,
            atrium_xrpc_client::reqwest::ReqwestClient,
        >,
    >,
    events_state: std::sync::Arc<tokio::sync::Mutex<EventsState>>,
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

    old_events = old_events
        .into_iter()
        .filter(|(_, oe)| {
            if let Some(rkey) = oe.rkey.as_ref() {
                if !record_rkeys.contains(rkey) {
                    log::info!("could not find {}, will recreate", rkey.as_str());
                    return false;
                }
            }
            true
        })
        .collect();

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
                let text = format!("{}", assoc_event.event.name);

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
                                byte_end: text.bytes().len(),
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
                            did.to_string(),
                            atrium_api::app::bsky::feed::Post::NSID,
                            rkey.to_string()
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
                                            "en".to_string(),
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

    log::info!("applying writes:\n{writes:#?}");

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

    events_state.events = events;

    Ok(())
}

async fn service_jetstream(
    db_pool: &sqlx::PgPool,
    did: &atrium_api::types::string::Did,
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    events_state: std::sync::Arc<tokio::sync::Mutex<EventsState>>,
    jetstream_endpoint: &str,
    commit_firehose_cursor_every: std::time::Duration,
) -> Result<(), anyhow::Error> {
    let mut cursor = {
        let mut db_conn = db_pool.acquire().await?;
        sqlx::query_scalar!(r#"SELECT cursor FROM jetstream_cursor"#)
            .fetch_optional(&mut *db_conn)
            .await?
    };

    loop {
        cursor = service_jetstream_once(
            db_pool,
            did,
            keypair,
            events_state.clone(),
            jetstream_endpoint,
            commit_firehose_cursor_every,
            cursor,
        )
        .await?;
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

async fn service_jetstream_once(
    db_pool: &sqlx::PgPool,
    did: &atrium_api::types::string::Did,
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    events_state: std::sync::Arc<tokio::sync::Mutex<EventsState>>,
    jetstream_endpoint: &str,
    commit_firehose_cursor_every: std::time::Duration,
    mut cursor: Option<i64>,
) -> Result<Option<i64>, anyhow::Error> {
    let mut last_firehose_commit_time = std::time::SystemTime::now();

    let jetstream = jetstream_oxide::JetstreamConnector::new(jetstream_oxide::JetstreamConfig {
        endpoint: jetstream_endpoint.to_string(),
        compression: jetstream_oxide::JetstreamCompression::Zstd,
        wanted_collections: vec![atrium_api::app::bsky::feed::Like::nsid()],
        cursor: cursor.map(|cursor| chrono::DateTime::from_timestamp_micros(cursor).unwrap()),

        // Do NOT let jetstream_oxide retry: this results in wonky cursor behavior!
        max_retries: 0,

        ..Default::default()
    })?;

    let mut stream = jetstream.connect().await?.into_stream();

    while let Some(event) = stream.next().await {
        let jetstream_oxide::events::JetstreamEvent::Commit(commit) = event else {
            continue;
        };

        let next_cursor = match &commit {
            jetstream_oxide::events::commit::CommitEvent::Create { info, .. }
            | jetstream_oxide::events::commit::CommitEvent::Update { info, .. }
            | jetstream_oxide::events::commit::CommitEvent::Delete { info, .. } => info.time_us,
        } as i64;

        let mut db_conn = db_pool.acquire().await?;

        async {
            match commit {
                jetstream_oxide::events::commit::CommitEvent::Create { info, commit } => {
                    let atrium_api::record::KnownRecord::AppBskyFeedLike(like) = commit.record
                    else {
                        return Ok(());
                    };

                    let parts = like
                        .subject
                        .uri
                        .strip_prefix("at://")
                        .map(|v| v.splitn(3, '/').collect::<Vec<_>>());

                    let Some(&[record_did, collection, rkey]) = parts.as_ref().map(|v| &v[..])
                    else {
                        return Ok(());
                    };

                    if record_did != did.to_string() {
                        return Ok(());
                    }

                    if collection != atrium_api::app::bsky::feed::Post::NSID {
                        return Ok(());
                    }

                    let events_state = events_state.lock().await;

                    let Some(id) = events_state
                        .rkeys_to_ids
                        .get(&atrium_api::types::string::RecordKey::new(rkey.to_string()).unwrap())
                        .cloned()
                    else {
                        return Ok(());
                    };

                    let assoc_event = events_state.events.get(&id).unwrap();

                    let label: atrium_api::com::atproto::label::defs::Label =
                        atrium_api::com::atproto::label::defs::LabelData {
                            cts: atrium_api::types::string::Datetime::new(
                                chrono::DateTime::from_timestamp_micros(info.time_us as i64)
                                    .unwrap()
                                    .fixed_offset(),
                            ),
                            exp: Some(atrium_api::types::string::Datetime::new(
                                (assoc_event.event.end_time() + EXPIRY_DATE_GRACE_PERIOD)
                                    .to_utc()
                                    .fixed_offset(),
                            )),
                            src: did.clone(),
                            cid: None,
                            neg: None,
                            uri: info.did.to_string(),
                            val: assoc_event.label_id.clone(),
                            sig: None,
                            ver: Some(1),
                        }
                        .into();

                    log::info!("applying label: {:?}", label);

                    let mut tx = db_conn.begin().await?;
                    labels::emit(keypair, &mut tx, &label, &commit.info.rkey).await?;
                    tx.commit().await?;
                }
                jetstream_oxide::events::commit::CommitEvent::Delete { info, commit } => {
                    let uri = info.did.to_string();

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

                    let label: atrium_api::com::atproto::label::defs::Label =
                        atrium_api::com::atproto::label::defs::LabelData {
                            cts: atrium_api::types::string::Datetime::new(
                                chrono::DateTime::from_timestamp_micros(info.time_us as i64)
                                    .unwrap()
                                    .fixed_offset(),
                            ),
                            exp: None,
                            src: did.clone(),
                            cid: None,
                            neg: Some(true),
                            uri: info.did.to_string(),
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
                next_cursor as i64,
            )
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            last_firehose_commit_time = now;
        }

        cursor = Some(next_cursor);
    }

    Ok(cursor)
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    env_logger::init();

    let config: Config = config::Config::builder()
        .add_source(config::File::with_name("config.toml"))
        .set_default("bsky_endpoint", "https://bsky.social")?
        .set_default("events_url", "https://data.cons.fyi/current.json")?
        .set_default("keypair_path", "signing.key")?
        .set_default("ui_endpoint", "https://cons.fyi")?
        .set_default(
            "jetstream_endpoint",
            String::from(jetstream_oxide::DefaultJetstreamEndpoints::USEastOne),
        )?
        .set_default("label_sync_delay_secs", 60 * 60)?
        .set_default("ingester_bind", "127.0.0.1:3002")?
        .set_default("commit_firehose_cursor_every_secs", 5)?
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

    let session = atrium_api::agent::atp_agent::CredentialSession::new(
        atrium_xrpc_client::reqwest::ReqwestClientBuilder::new(&config.bsky_endpoint)
            .client(reqwest_client.clone())
            .build(),
        atrium_api::agent::atp_agent::store::MemorySessionStore::default(),
    );
    session
        .login(&config.bsky_username, &config.bsky_password)
        .await?;
    let agent = std::sync::Arc::new(atrium_api::agent::Agent::new(session));

    let did = agent.did().await.unwrap();

    let db_pool = sqlx::PgPool::connect(&config.postgres_url).await?;

    log::info!("syncing initial labels");

    sync_labels(
        &reqwest_client,
        &config.events_url,
        &config.ui_endpoint,
        &did,
        &agent,
        events_state.clone(),
    )
    .await?;

    let listener = tokio::net::TcpListener::bind(&config.ingester_bind).await?;

    let app = axum::Router::new().route(
        "/trigger",
        axum::routing::post({
            let did = did.clone();
            let events_state = events_state.clone();
            let triggering = std::sync::Arc::new(tokio::sync::Mutex::new(()));
            || async move {
                let Ok(_guard) = triggering.try_lock() else {
                    return (axum::http::StatusCode::CONFLICT, "already in progress!")
                        .into_response();
                };

                match sync_labels(
                    &reqwest_client,
                    &config.events_url,
                    &config.ui_endpoint,
                    &did,
                    &agent,
                    events_state,
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

    tokio::try_join!(
        async {
            if config.jetstream_endpoint.is_empty() {
                log::warn!("no jetstream endpoint configured, won't service jetstream events");
                return Ok(());
            }

            // Wait on events.
            service_jetstream(
                &db_pool,
                &did,
                &keypair,
                events_state.clone(),
                &config.jetstream_endpoint,
                std::time::Duration::from_secs(config.commit_firehose_cursor_every_secs),
            )
            .await?;
            unreachable!();

            #[allow(unreachable_code)]
            Ok::<_, anyhow::Error>(())
        },
        async {
            // Serve labeler.
            axum::serve(listener, app).await?;
            unreachable!();

            #[allow(unreachable_code)]
            Ok::<_, anyhow::Error>(())
        }
    )?;

    Ok(())
}
