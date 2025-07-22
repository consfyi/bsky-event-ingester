use atrium_api::types::{Collection as _, TryFromUnknown as _, TryIntoUnknown as _};
use consfyi::*;
use futures::StreamExt as _;
use num_traits::ToPrimitive as _;
use sqlx::Acquire as _;
use std::str::FromStr as _;

#[derive(serde::Deserialize, Debug)]
struct Config {
    bsky_username: String,
    bsky_password: String,
    bsky_endpoint: String,
    ui_endpoint: String,
    jetstream_endpoint: String,
    calendar_url: String,
    postgres_url: String,
    keypair_path: String,
    label_sync_delay_secs: u64,
    google_maps_api_key: String,
    commit_firehose_cursor_every_secs: u64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Geocoded {
    lat_lng: Option<[String; 2]>,
    timezone: Option<chrono_tz::Tz>,
}

struct EventsState {
    rkeys_to_ids: std::collections::HashMap<atrium_api::types::string::RecordKey, u64>,
    events: std::collections::HashMap<u64, Event>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LabelerEventInfo {
    slug: String,
    name: String,
    date: String,
    address: String,
    country: String,
    url: String,
    geocoded: Option<Geocoded>,
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

#[derive(Debug)]
struct Event {
    slug: String,
    url: String,
    name: String,
    full_name: String,
    address: String,
    country: String,
    start_date: chrono::NaiveDate,
    end_date: chrono::NaiveDate,
    geocoded: Option<Geocoded>,
    rkey: Option<Option<atrium_api::types::string::RecordKey>>,
}

impl Event {
    fn end_time(&self) -> chrono::DateTime<chrono::Utc> {
        let date = self.end_date + chrono::Days::new(1);
        let tz = self
            .geocoded
            .as_ref()
            .and_then(|g| g.timezone)
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

#[derive(serde::Deserialize, Debug)]
struct JsonLd {
    #[serde(rename = "@context")]
    context: Option<serde_json::Value>,

    #[serde(rename = "@type")]
    r#type: Option<serde_json::Value>,

    #[serde(flatten)]
    properties: serde_json::Value,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SchemaOrgEvent {
    name: String,
    event_status: String,
    url: String,
    start_date: String,
    end_date: String,
    location: SchemaOrgEventLocation,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SchemaOrgEventLocation {
    name: String,
    address: SchemaOrgEventLocationAddress,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SchemaOrgEventLocationAddress {
    address_locality: Option<String>,
    address_region: Option<String>,
    address_country: String,
}

#[derive(serde::Deserialize, Debug)]
#[serde(untagged)]
enum JsonLdInput {
    Single(JsonLd),
    Multiple(Vec<JsonLd>),
}

impl JsonLdInput {
    fn into_vec(self) -> Vec<JsonLd> {
        match self {
            JsonLdInput::Single(item) => vec![item],
            JsonLdInput::Multiple(items) => items,
        }
    }
}

async fn fetch_events(
    calendar_url: &str,
) -> Result<std::collections::HashMap<u64, Event>, anyhow::Error> {
    let mut events = std::collections::HashMap::new();

    for element in scraper::Html::parse_document(
        &reqwest::get(calendar_url)
            .await?
            .error_for_status()?
            .text()
            .await?,
    )
    .select(&scraper::Selector::parse("script[type=\"application/ld+json\"]").unwrap())
    {
        for doc in serde_json::from_str::<JsonLdInput>(
            &htmlize::unescape(element.text().collect::<String>()).replace("\n", " "),
        )?
        .into_vec()
        {
            if !doc
                .context
                .as_ref()
                .and_then(|t| t.as_str())
                .map(|s| s == "http://schema.org")
                .unwrap_or(false)
                || !doc
                    .r#type
                    .as_ref()
                    .and_then(|t| t.as_str())
                    .map(|s| s == "Event")
                    .unwrap_or(false)
            {
                continue;
            }

            let event = serde_json::from_value::<SchemaOrgEvent>(doc.properties)?;

            if event.event_status != "https://schema.org/EventScheduled"
                && event.event_status != "https://schema.org/EventRescheduled"
            {
                continue;
            }

            let (name, year) = event
                .name
                .rsplit_once(" ")
                .ok_or(anyhow::anyhow!("could not split year"))?;
            let year: u32 = year.parse()?;

            let start_date = chrono::NaiveDate::parse_from_str(&event.start_date, "%Y-%m-%d")?;
            let end_date = chrono::NaiveDate::parse_from_str(&event.end_date, "%Y-%m-%d")?;

            let country = countries::find(&event.location.address.address_country)
                .ok_or(anyhow::anyhow!("could not find country code"))?;

            let address = vec![
                event.location.name.clone(),
                event
                    .location
                    .address
                    .address_locality
                    .clone()
                    .unwrap_or_default(),
                event
                    .location
                    .address
                    .address_region
                    .clone()
                    .unwrap_or_default(),
                event.location.address.address_country.clone(),
            ]
            .into_iter()
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join(", ");

            let langid = country
                .parse()
                .ok()
                .map(|region| slug::guess_language_for_region(region))
                .unwrap_or(icu_locale::LanguageIdentifier::UNKNOWN);

            let slug = format!("{}-{}", slug::slugify(&name, &langid), year);

            static ID_REGEX: std::sync::LazyLock<regex::Regex> =
                std::sync::LazyLock::new(|| regex::Regex::new(r#"/event/(\d+)/"#).unwrap());
            let id = ID_REGEX
                .captures(&event.url)
                .ok_or(anyhow::anyhow!("could not get ID"))?
                .get(1)
                .unwrap()
                .as_str()
                .parse()?;

            events.insert(
                id,
                Event {
                    url: event.url.to_string(),
                    name: name.to_string(),
                    full_name: format!("{} {}", name, year),
                    address,
                    country: country.to_string(),
                    start_date,
                    end_date,
                    slug,
                    geocoded: None,
                    rkey: None,
                },
            );
        }
    }

    if events.is_empty() {
        return Err(anyhow::format_err!("no events found"));
    }

    Ok(events)
}

const EXTRA_DATA_POST_RKEY: &str = "fbl_postRkey";
const EXTRA_DATA_EVENT_INFO: &str = "fbl_eventInfo";

#[derive(Debug)]
struct OldEvent {
    rkey: Option<atrium_api::types::string::RecordKey>,
    address: String,
    geocoded: Option<Geocoded>,
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
) -> Result<Option<std::collections::HashMap<u64, OldEvent>>, anyhow::Error> {
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

                    let info = v
                        .extra_data
                        .get(EXTRA_DATA_EVENT_INFO)
                        .ok()
                        .flatten()
                        .cloned()
                        .and_then(|v| ipld_core::serde::from_ipld::<LabelerEventInfo>(v).ok());

                    Some((
                        base26::decode(&v.identifier).unwrap(),
                        OldEvent {
                            rkey,
                            address: info
                                .as_ref()
                                .map(|info| info.address.to_string())
                                .unwrap_or_else(|| "".to_string()),
                            geocoded: info.and_then(|info| info.geocoded),
                        },
                    ))
                })
                .collect::<std::collections::HashMap<_, _>>()
        }))
}

async fn sync_labels(
    calendar_url: &str,
    ui_endpoint: &str,
    did: &atrium_api::types::string::Did,
    agent: &atrium_api::agent::Agent<
        atrium_api::agent::atp_agent::CredentialSession<
            atrium_api::agent::atp_agent::store::MemorySessionStore,
            atrium_xrpc_client::reqwest::ReqwestClient,
        >,
    >,
    google_maps_client: Option<&google_maps::Client>,
    events_state: std::sync::Arc<tokio::sync::Mutex<EventsState>>,
) -> Result<(), anyhow::Error> {
    // Lock the entire events state while labels are syncing.
    //
    // This means that we hold the mutex while events are being created, such that any likes on those posts must wait until the mutex is unlocked.
    // This ensures that we don't get into a state where if someone likes a post but we haven't saved it into the events state yet we end up missing their like.
    let mut events_state = events_state.lock().await;

    let now = chrono::Utc::now();

    let mut events = fetch_events(calendar_url).await?;

    events = events
        .into_iter()
        .filter(|(_, event)| {
            // Somewhat obnoxiously we have to do this in UTC, because otherwise we have to geocode to find the timezone.
            now < event.end_date.and_time(chrono::NaiveTime::MIN).and_utc()
                    + chrono::Days::new(2) // Add an extra 2 days to compensate for very ahead timezones, like Pacific/Auckland.
                    + EXPIRY_DATE_GRACE_PERIOD
        })
        .collect();

    let mut writes = vec![];

    let mut old_events = if let Some(old_events) = fetch_old_events(did, agent).await? {
        writes.push(
            atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Delete(Box::new(
                atrium_api::com::atproto::repo::apply_writes::DeleteData {
                    collection: atrium_api::app::bsky::labeler::Service::nsid(),
                    rkey: atrium_api::types::string::RecordKey::new("self".to_string()).unwrap(),
                }
                .into(),
            )),
        );

        old_events
    } else {
        std::collections::HashMap::new()
    };

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

    // Perform geocoding, if required.
    if let Some(google_maps_client) = google_maps_client.as_ref() {
        let old_events = &old_events;

        events =
            futures::future::try_join_all(events.into_iter().map(|(id, mut event)| async move {
                event.geocoded = Some(
                    if let Some(geocoded) = old_events
                        .get(&id)
                        .filter(|e| e.address == event.address)
                        .and_then(|e| e.geocoded.as_ref())
                        .filter(|g| g.timezone.is_none() || g.lat_lng.is_some())
                    {
                        geocoded.clone()
                    } else {
                        if let Some(geocoding) = google_maps_client
                            .geocoding()
                            .with_address(&event.address)
                            .execute()
                            .await?
                            .results
                            .into_iter()
                            .next()
                        {
                            let lat = geocoding.geometry.location.lat.to_f64().unwrap();
                            let lng = geocoding.geometry.location.lng.to_f64().unwrap();

                            let tz = geotz::lookup([lng, lat])
                                .ok()
                                .map(|v| v.into_iter().next())
                                .flatten()
                                .and_then(|v| chrono_tz::Tz::from_str(&v).ok());

                            Geocoded {
                                lat_lng: Some([lat.to_string(), lng.to_string()]),
                                timezone: tz,
                            }
                        } else {
                            Geocoded {
                                lat_lng: None,
                                timezone: None,
                            }
                        }
                    },
                );

                Ok::<_, anyhow::Error>((id, event))
            }))
            .await?
            .into_iter()
            .collect();
    }

    // Delete events.
    for (id, oe) in old_events.into_iter() {
        if let Some(event) = events.get_mut(&id) {
            if now < event.end_time() + EXPIRY_DATE_GRACE_PERIOD {
                // Event hasn't expired, no need to delete.
                event.rkey = Some(oe.rkey);
                continue;
            }

            event.rkey = Some(None);
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
    sorted_events.sort_by_key(|(_, event)| (event.start_date, event.end_date));

    {
        let mut created_at = now;

        for (_, event) in sorted_events.iter_mut() {
            if event.rkey.is_some() {
                continue;
            }

            let rkey = atrium_api::types::string::RecordKey::new(
                atrium_api::types::string::Tid::from_datetime(0.try_into().unwrap(), created_at)
                    .to_string(),
            )
            .unwrap();

            event.rkey = Some(Some(rkey.clone()));

            {
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
                                            uri: format!("{}/{}", ui_endpoint, event.slug),
                                        }
                                        .into(),
                                    ),
                                ),
                            )],
                            index: atrium_api::app::bsky::richtext::facet::ByteSliceData {
                                byte_start: 0,
                                byte_end: event.full_name.bytes().len(),
                            }
                            .into(),
                        }
                        .into()]),
                        text: event.full_name.clone(),
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

    {
        let record: atrium_api::app::bsky::labeler::service::Record =
            atrium_api::app::bsky::labeler::service::RecordData {
                created_at: atrium_api::types::string::Datetime::new(now.fixed_offset()),
                labels: None,
                policies: atrium_api::app::bsky::labeler::defs::LabelerPoliciesData {
                    label_values: sorted_events.iter().filter(|(_, event)| {
                        event.rkey.as_ref().unwrap().is_some()
                    }).map(|(id, _)| base26::encode(**id)).collect(),
                    label_value_definitions: Some(
                        sorted_events.iter()
                            .map(|(id, event)| {
                                let mut def: atrium_api::com::atproto::label::defs::LabelValueDefinition = atrium_api::com::atproto::label::defs::LabelValueDefinitionData {
                                    adult_only: Some(false),
                                    blurs: "none".to_string(),
                                    default_setting: Some("warn".to_string()),
                                    identifier: base26::encode(**id),
                                    locales: vec![atrium_api::com::atproto::label::defs::LabelValueDefinitionStringsData {
                                        lang: atrium_api::types::string::Language::new(
                                            "en".to_string(),
                                        )
                                        .unwrap(),
                                        name: event.full_name.clone(),
                                        description: format!(
                                            "📅 {start_date} – {end_date}\n📍 {location}",
                                            location = event.address,
                                            start_date = event.start_date,
                                            end_date = event.end_date
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
                                    if let Some(rkey) = event.rkey.as_ref().unwrap() {
                                        ipld_core::serde::to_ipld(rkey.to_string()).unwrap()
                                    } else {
                                        ipld_core::ipld::Ipld::Null
                                    },
                                );

                                extra_data.insert(
                                    EXTRA_DATA_EVENT_INFO.to_string(),
                                    ipld_core::serde::to_ipld(LabelerEventInfo {
                                        slug: event.slug.clone(),
                                        name: event.name.clone(),
                                        date: format!(
                                            "{}/{}",
                                            event.start_date.format("%Y-%m-%d"),
                                            event.end_date.format("%Y-%m-%d")
                                        ),
                                        address: event.address.clone(),
                                        country: event.country.clone(),
                                        url: event.url.clone(),
                                        geocoded: event.geocoded.clone(),
                                    }).unwrap(),
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
            atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Create(Box::new(
                atrium_api::com::atproto::repo::apply_writes::CreateData {
                    collection: atrium_api::app::bsky::labeler::Service::nsid(),
                    rkey: Some(
                        atrium_api::types::string::RecordKey::new("self".to_string()).unwrap(),
                    ),
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
        .flat_map(|(id, event)| {
            event
                .rkey
                .as_ref()
                .and_then(|rkey| rkey.as_ref())
                .map(|rkey| (rkey.clone(), **id))
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

                    let event = events_state.events.get(&id).unwrap();

                    let label: atrium_api::com::atproto::label::defs::Label =
                        atrium_api::com::atproto::label::defs::LabelData {
                            cts: atrium_api::types::string::Datetime::new(
                                chrono::DateTime::from_timestamp_micros(info.time_us as i64)
                                    .unwrap()
                                    .fixed_offset(),
                            ),
                            exp: Some(atrium_api::types::string::Datetime::new(
                                (event.end_time() + EXPIRY_DATE_GRACE_PERIOD)
                                    .to_utc()
                                    .fixed_offset(),
                            )),
                            src: did.clone(),
                            cid: None,
                            neg: None,
                            uri: info.did.to_string(),
                            val: base26::encode(id),
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
        .set_default("calendar_url", "https://furrycons.com/calendar/")?
        .set_default("keypair_path", "signing.key")?
        .set_default("ui_endpoint", "https://cons.fyi")?
        .set_default(
            "jetstream_endpoint",
            String::from(jetstream_oxide::DefaultJetstreamEndpoints::USEastOne),
        )?
        .set_default("label_sync_delay_secs", 60 * 60)?
        .set_default("ingester_bind", "127.0.0.1:3002")?
        .set_default("google_maps_api_key", "")?
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

    let session = atrium_api::agent::atp_agent::CredentialSession::new(
        atrium_xrpc_client::reqwest::ReqwestClient::new(&config.bsky_endpoint),
        atrium_api::agent::atp_agent::store::MemorySessionStore::default(),
    );
    session
        .login(&config.bsky_username, &config.bsky_password)
        .await?;
    let agent = std::sync::Arc::new(atrium_api::agent::Agent::new(session));

    let did = agent.did().await.unwrap();

    let db_pool = sqlx::PgPool::connect(&config.postgres_url).await?;

    let google_maps_client = if !config.google_maps_api_key.is_empty() {
        Some(google_maps::Client::try_new(config.google_maps_api_key)?)
    } else {
        None
    };

    log::info!("syncing initial labels");

    sync_labels(
        &config.calendar_url,
        &config.ui_endpoint,
        &did,
        &agent,
        google_maps_client.as_ref(),
        events_state.clone(),
    )
    .await?;

    tokio::try_join!(
        async {
            // Sync labels.
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(config.label_sync_delay_secs))
                    .await;

                log::info!("syncing labels");
                if let Err(e) = sync_labels(
                    &config.calendar_url,
                    &config.ui_endpoint,
                    &did,
                    &agent,
                    google_maps_client.as_ref(),
                    events_state.clone(),
                )
                .await
                {
                    log::error!("could not sync labels: {e}");
                }
            }

            #[allow(unreachable_code)]
            Ok::<_, anyhow::Error>(())
        },
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
        }
    )?;

    Ok(())
}
