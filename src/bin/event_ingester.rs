use furcons_bsky_labeler::*;

use atrium_api::types::{Collection as _, TryFromUnknown as _, TryIntoUnknown as _};
use futures::StreamExt as _;
use icalendar::{Component as _, EventLike as _};
use sqlx::Acquire as _;

#[derive(serde::Deserialize)]
struct Config {
    ingester_bind: std::net::SocketAddr,
    bsky_username: String,
    bsky_password: String,
    bsky_endpoint: String,
    ui_endpoint: String,
    jetstream_endpoint: String,
    ics_url: String,
    postgres_url: String,
    keypair_path: String,
    label_sync_delay_secs: u64,
    google_maps_api_key: String,
}

#[derive(Debug)]
struct ICSEvent {
    uid: String,
    url: String,
    summary: String,
    location: String,
    dtstart: chrono::NaiveDate,
    dtend: chrono::NaiveDate,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Geocoded {
    country: Option<String>,
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
    year: u32,
    date: String,
    location: String,
    url: String,
    geocoded: Option<Geocoded>,
}

#[derive(thiserror::Error, Debug)]
enum EventParseError {
    #[error("invalid or missing field: {0}")]
    InvalidOrMissingField(&'static str),
}

impl ICSEvent {
    fn from_icalendar_event(event: &icalendar::Event) -> Result<ICSEvent, EventParseError> {
        Ok(ICSEvent {
            uid: event
                .get_uid()
                .ok_or(EventParseError::InvalidOrMissingField("UID"))?
                .to_string(),
            url: event
                .get_url()
                .ok_or(EventParseError::InvalidOrMissingField("URL"))?
                .to_string(),
            summary: event
                .get_summary()
                .ok_or(EventParseError::InvalidOrMissingField("SUMMARY"))?
                .to_string(),
            location: event
                .get_location()
                .ok_or(EventParseError::InvalidOrMissingField("LOCATION"))?
                .to_string(),
            dtstart: event
                .get_start()
                .ok_or(EventParseError::InvalidOrMissingField("DTSTART"))?
                .date_naive(),
            dtend: event
                .get_end()
                .ok_or(EventParseError::InvalidOrMissingField("DTEND"))?
                .date_naive(),
        })
    }
}

fn fixup_event(mut event: ICSEvent) -> ICSEvent {
    event.url = htmlize::unescape(event.url).to_string();
    event.location = htmlize::unescape(event.location).to_string();
    event.summary = htmlize::unescape(event.summary).to_string();
    event
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
    url: String,
    name: String,
    year: u32,
    location: String,
    start_date: chrono::NaiveDate,
    end_date: chrono::NaiveDate,
    geocoded: Option<Geocoded>,
    rkey: Option<Option<atrium_api::types::string::RecordKey>>,
}

impl Event {
    fn end_time(&self) -> chrono::DateTime<chrono_tz::Tz> {
        self.end_date
            .and_time(chrono::NaiveTime::MIN)
            .and_local_timezone(
                self.geocoded
                    .as_ref()
                    .and_then(|g| g.timezone)
                    .unwrap_or(chrono_tz::UTC),
            )
            .unwrap()
    }
}

async fn fetch_events(
    ics_url: &str,
) -> Result<std::collections::HashMap<u64, Event>, anyhow::Error> {
    let calendar: icalendar::Calendar = reqwest::get(ics_url)
        .await?
        .text()
        .await?
        .parse()
        .map_err(|e| anyhow::format_err!("{e}"))?;

    let events = calendar
        .components
        .iter()
        .flat_map(|component| {
            let event = component.as_event()?;

            match ICSEvent::from_icalendar_event(event) {
                Ok(event) => Some(event),
                Err(e) => {
                    log::error!("failed to parse {:?}, skipping: {}", event, e);
                    None
                }
            }
        })
        .map(|event| {
            let id = event
                .uid
                .split_once("-")
                .ok_or(anyhow::anyhow!("malformed event uid"))?
                .0
                .parse()?;
            let event = fixup_event(event);

            let (name, year) = event
                .summary
                .rsplit_once(" ")
                .ok_or(anyhow::anyhow!("could not split year"))?;

            let year = year.parse()?;

            Ok::<_, anyhow::Error>((
                id,
                Event {
                    url: event.url,
                    name: name.to_string(),
                    year,
                    location: event.location,
                    start_date: event.dtstart,
                    end_date: event.dtend,
                    geocoded: None,
                    rkey: None,
                },
            ))
        })
        .collect::<Result<std::collections::HashMap<_, _>, _>>()?;

    if events.is_empty() {
        return Err(anyhow::anyhow!("calendar is empty"));
    }

    Ok(events)
}

const EXTRA_DATA_POST_RKEY: &str = "fbl_postRkey";
const EXTRA_DATA_EVENT_INFO: &str = "fbl_eventInfo";

#[derive(Debug)]
struct OldEvent {
    rkey: Option<atrium_api::types::string::RecordKey>,
    location: String,
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
                            location: info
                                .as_ref()
                                .map(|info| info.location.to_string())
                                .unwrap_or_else(|| "".to_string()),
                            geocoded: info.and_then(|info| info.geocoded),
                        },
                    ))
                })
                .collect::<std::collections::HashMap<_, _>>()
        }))
}

fn guess_language_for_region(
    region: icu_locale::subtags::Region,
) -> icu_locale::LanguageIdentifier {
    const LOCALE_EXPANDER: icu_locale::LocaleExpander = icu_locale::LocaleExpander::new_common();
    let mut langid = icu_locale::LanguageIdentifier::UNKNOWN;
    langid.region = Some(region);
    LOCALE_EXPANDER.maximize(&mut langid);
    langid
}

fn slugify(s: &str, langid: &icu_locale::LanguageIdentifier) -> String {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[^\p{L}\p{N}\s]+").unwrap());
    const CASE_MAPPER: icu_casemap::CaseMapperBorrowed<'static> = icu_casemap::CaseMapper::new();

    CASE_MAPPER
        .lowercase_to_string(&RE.replace_all(s, ""), langid)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

async fn sync_labels(
    ics_url: &str,
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

    let mut events = fetch_events(ics_url).await?;

    events = events
        .into_iter()
        .filter(|(_, event)| {
            // Somewhat obnoxiously we have to do this in UTC, because otherwise we have to geocode to find the timezone.
            now < event.end_date.and_time(chrono::NaiveTime::MIN).and_utc()
                    + chrono::Days::new(1) // Add an extra day to compensate for very ahead timezones, like Pacific/Auckland.
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
                        .filter(|e| e.location == event.location)
                        .and_then(|e| e.geocoded.as_ref())
                    {
                        // Already have geocoding data, ignore.
                        geocoded.clone()
                    } else {
                        // Need to geocode and get timezone from Google Maps.
                        if let Some(geocoding) = google_maps_client
                            .geocoding()
                            .with_address(&event.location)
                            .execute()
                            .await?
                            .results
                            .into_iter()
                            .next()
                        {
                            let tz = google_maps_client
                                .time_zone(
                                    geocoding.geometry.location,
                                    event.start_date.and_time(chrono::NaiveTime::MIN).and_utc(),
                                )
                                .execute()
                                .await?;

                            Geocoded {
                                country: geocoding
                                    .address_components
                                    .into_iter()
                                    .find(|c| c.types.contains(&google_maps::PlaceType::Country))
                                    .map(|c| c.short_name),
                                timezone: tz.time_zone_id,
                            }
                        } else {
                            Geocoded {
                                country: None,
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

        for (id, event) in sorted_events.iter_mut() {
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
                let text = format!("{} {}", event.name, event.year);

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
                                                "{}/cons/{}",
                                                ui_endpoint,
                                                base26::encode(**id)
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
                                // The "DTEND" property for a "VEVENT" calendar component specifies the non-inclusive end of the event.
                                let end_date = event.end_date - chrono::Days::new(1);

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
                                        name: format!("{} {}", event.name, event.year),
                                        description: format!(
                                            "📅 {start_date} – {end_date}\n📍 {location}",
                                            location = event.location,
                                            start_date = event.start_date,
                                            end_date = end_date
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

                                let langid = event
                                    .geocoded
                                    .as_ref()
                                    .and_then(|g| g.country.as_ref())
                                    .and_then(|c| c.parse().ok())
                                    .map(|region| guess_language_for_region(region))
                                    .unwrap_or(icu_locale::LanguageIdentifier::UNKNOWN);

                                extra_data.insert(
                                    EXTRA_DATA_EVENT_INFO.to_string(),
                                    ipld_core::serde::to_ipld(LabelerEventInfo {
                                        slug: format!("{}-{}", slugify(&event.name, &langid), event.year),
                                        name: event.name.clone(),
                                        year: event.year,
                                        date: format!(
                                            "{}/{}",
                                            event.start_date.format("%Y-%m-%d"),
                                            end_date
                                        ),
                                        location: event.location.clone(),
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
                writes,
            }
            .into(),
        )
        .await?;

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

    metrics::gauge!("label_sync_time").set(chrono::Utc::now().timestamp_micros() as f64);

    Ok(())
}

async fn service_jetstream(
    db_pool: &sqlx::PgPool,
    did: &atrium_api::types::string::Did,
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    events_state: std::sync::Arc<tokio::sync::Mutex<EventsState>>,
    jetstream_endpoint: &str,
) -> Result<(), anyhow::Error> {
    let mut cursor = {
        let mut db_conn = db_pool.acquire().await?;
        sqlx::query!(r#"SELECT cursor FROM jetstream_cursor"#)
            .fetch_optional(&mut *db_conn)
            .await?
            .map(|d| d.cursor)
    };

    loop {
        cursor = service_jetstream_once(
            db_pool,
            did,
            keypair,
            events_state.clone(),
            jetstream_endpoint,
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
    mut cursor: Option<i64>,
) -> Result<Option<i64>, anyhow::Error> {
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
                                    .with_timezone(&chrono_tz::UTC)
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
                    let seq = labels::emit(keypair, &mut tx, label, &commit.info.rkey).await?;
                    tx.commit().await?;

                    metrics::gauge!("label_seq").set(seq as f64);
                }
                jetstream_oxide::events::commit::CommitEvent::Delete { info, commit } => {
                    let uri = info.did.to_string();

                    let Some(val) = sqlx::query!(
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
                    .map(|v| v.val) else {
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
                    let seq = labels::emit(keypair, &mut tx, label, &commit.rkey).await?;
                    tx.commit().await?;

                    metrics::gauge!("label_seq").set(seq as f64);
                }
                _ => {}
            }

            Ok::<_, anyhow::Error>(())
        }
        .await?;

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

        metrics::gauge!("jetstream_cursor").set(next_cursor as f64);

        cursor = Some(next_cursor);
    }

    Ok(cursor)
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    metrics::describe_gauge!(
        "jetstream_cursor",
        metrics::Unit::Microseconds,
        "jetstream cursor location"
    );
    metrics::describe_gauge!("label_seq", "sequence number of currently emitted label");
    metrics::describe_gauge!(
        "label_sync_time",
        metrics::Unit::Microseconds,
        "last label sync time"
    );

    env_logger::init();

    let config: Config = config::Config::builder()
        .add_source(config::File::with_name("config.toml"))
        .set_default("bsky_endpoint", "https://bsky.social")?
        .set_default("ics_url", "https://furrycons.com/calendar/furrycons.ics")?
        .set_default("keypair_path", "signing.key")?
        .set_default("ui_endpoint", "https://cons.furryli.st")?
        .set_default(
            "jetstream_endpoint",
            String::from(jetstream_oxide::DefaultJetstreamEndpoints::USEastOne),
        )?
        .set_default("label_sync_delay_secs", 60 * 60)?
        .set_default("ingester_bind", "127.0.0.1:3002")?
        .set_default("google_maps_api_key", "")?
        .build()?
        .try_deserialize()?;

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

    let listener = tokio::net::TcpListener::bind(&config.ingester_bind).await?;

    let metrics_handle =
        metrics_exporter_prometheus::PrometheusBuilder::new().install_recorder()?;

    let google_maps_client = if !config.google_maps_api_key.is_empty() {
        Some(google_maps::Client::try_new(config.google_maps_api_key)?)
    } else {
        None
    };

    log::info!("syncing initial labels");

    sync_labels(
        &config.ics_url,
        &config.ui_endpoint,
        &did,
        &agent,
        google_maps_client.as_ref(),
        events_state.clone(),
    )
    .await?;

    let app = axum::Router::new()
        .route(
            "/metrics",
            axum::routing::get(|| async move { metrics_handle.render() }),
        )
        .route("/", axum::routing::get(|| async { ">:3" }));

    tokio::try_join!(
        async {
            // Sync labels.
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(config.label_sync_delay_secs))
                    .await;

                log::info!("syncing labels");
                if let Err(e) = sync_labels(
                    &config.ics_url,
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
