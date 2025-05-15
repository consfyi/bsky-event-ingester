use std::str::FromStr as _;

use atrium_api::types::{Collection as _, TryFromUnknown as _, TryIntoUnknown as _};
use base64::Engine as _;
use futures::{SinkExt as _, StreamExt as _};
use icalendar::Component as _;
use rusqlite::{OptionalExtension as _, ToSql as _};
use serde::Serialize as _;

struct AppError(anyhow::Error);

impl axum::response::IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        log::error!("{}", self.0);
        reqwest::StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

#[derive(serde::Deserialize)]
struct Config {
    bsky_username: String,
    bsky_password: String,
    bsky_endpoint: String,
    jetstream_endpoint: String,
    ics_url: String,
    bind: std::net::SocketAddr,
    db_path: String,
    keypair_path: String,
}

#[derive(Debug)]
struct Event {
    val: String,
    url: String,
    summary: String,
    location: String,
    dtstart: chrono::NaiveDate,
    dtend: chrono::NaiveDate,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS labels
( seq INTEGER PRIMARY KEY AUTOINCREMENT
, cts TEXT NOT NULL
, exp TEXT
, cid TEXT
, sig BLOB
, uri TEXT NOT NULL
, val TEXT NOT NULL
, neg INTEGER NOT NULL DEFAULT 0
, like_rkey TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS labels_uri ON labels (uri);

CREATE INDEX IF NOT EXISTS labels_like_rkey ON labels (like_rkey) WHERE NOT neg;

CREATE TABLE IF NOT EXISTS jetstream_cursor
( id INTEGER PRIMARY KEY CHECK (id = 0)
, cursor INTEGER NOT NULL
) STRICT;
";

const ALPHABETICAL_ENCODING: data_encoding::Encoding = data_encoding_macro::new_encoding! {
    symbols: "abcdefghijklmnop",
    translate_from: "ABCDEFGHIJKLMNOP",
    translate_to: "abcdefghijklmnop",
};

impl Event {
    fn from_icalendar_event(event: &icalendar::Event) -> Option<Event> {
        let mut uid = None;
        let mut url = None;
        let mut summary = None;
        let mut location = None;
        let mut dtstart = None;
        let mut dtend = None;

        for (_, property) in event.properties() {
            match property.key() {
                "UID" => {
                    uid = Some(property.value());
                }
                "URL" => {
                    url = Some(html_escape::decode_html_entities(property.value()));
                }
                "LOCATION" => {
                    location = Some(html_escape::decode_html_entities(property.value()));
                }
                "DTSTART" => {
                    dtstart = chrono::NaiveDate::parse_from_str(property.value(), "%Y%m%d").ok();
                }
                "DTEND" => {
                    dtend = chrono::NaiveDate::parse_from_str(property.value(), "%Y%m%d").ok();
                }
                "SUMMARY" => {
                    summary = Some(html_escape::decode_html_entities(property.value()));
                }
                _ => continue,
            }
        }

        Some(Event {
            val: ALPHABETICAL_ENCODING.encode(uid?.to_string().as_bytes()),
            url: url?.to_string(),
            summary: summary?.to_string(),
            location: location?.to_string(),
            dtstart: dtstart?,
            dtend: dtend?,
        })
    }
}

async fn sync_labels(ics_url: &str, app_state: &AppState) -> Result<(), anyhow::Error> {
    // Lock the entire events state while labels are syncing.
    //
    // This means that we hold the mutex while events are being created, such that any likes on those posts must wait until the mutex is unlocked.
    // This ensures that we don't get into a state where if someone likes a post but we haven't saved it into the events state yet we end up missing their like.
    let mut events_state = app_state.events_state.lock().await;

    const EXTRA_DATA_POST_RKEY: &str = "fbl_postRkey";
    const EXTRA_DATA_LABEL_VAL: &str = "fbl_labelVal";
    const EXTRA_DATA_EVENT_INFO: &str = "fbl_eventInfo";

    let mut writes = vec![];

    let calendar: icalendar::Calendar = reqwest::get(ics_url)
        .await?
        .text()
        .await?
        .parse()
        .map_err(|e| anyhow::format_err!("{e}"))?;

    let today = chrono::Utc::now().date_naive();

    let events = calendar
        .components
        .iter()
        .flat_map(|component| Some(Event::from_icalendar_event(component.as_event()?)?))
        .filter(|e| e.dtend + chrono::Days::new(1) >= today)
        // .filter(|_| false)
        .collect::<Vec<_>>();

    let next_events = events
        .iter()
        .map(|event| (event.val.clone(), event))
        .collect::<std::collections::HashMap<_, _>>();

    let original_record = match app_state
        .agent
        .api
        .com
        .atproto
        .repo
        .get_record(
            atrium_api::com::atproto::repo::get_record::ParametersData {
                collection: atrium_api::app::bsky::labeler::Service::nsid(),
                repo: app_state.did.clone().into(),
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
    });

    if original_record.is_some() {
        writes.push(
            atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Delete(Box::new(
                atrium_api::com::atproto::repo::apply_writes::DeleteData {
                    collection: atrium_api::app::bsky::labeler::Service::nsid(),
                    rkey: atrium_api::types::string::RecordKey::new("self".to_string()).unwrap(),
                }
                .into(),
            )),
        );
    }

    let mut current_events = original_record
        .map(|record| {
            record
                .policies
                .data
                .label_value_definitions
                .as_ref()
                .map(|defs| {
                    defs.iter()
                        .flat_map(|v| {
                            Some((
                                v.identifier.clone(),
                                match v.extra_data.get(EXTRA_DATA_POST_RKEY).ok()?? {
                                    ipld_core::ipld::Ipld::String(v) => {
                                        atrium_api::types::string::RecordKey::new(v.clone())
                                            .unwrap()
                                    }
                                    _ => {
                                        return None;
                                    }
                                },
                            ))
                        })
                        .collect::<std::collections::HashMap<_, _>>()
                })
                .unwrap_or_default()
        })
        .unwrap_or_default();

    // Delete events.
    for (val, rkey) in current_events.clone() {
        if next_events.contains_key(&val) {
            continue;
        }

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
        current_events.remove(&val);
    }

    let mut now = chrono::Utc::now();

    // Create new events.
    for event in events.iter() {
        if current_events.contains_key(&event.val) {
            continue;
        }

        let rkey = atrium_api::types::string::RecordKey::new(
            atrium_api::types::string::Tid::from_datetime(0.try_into().unwrap(), now).to_string(),
        )
        .unwrap();

        {
            let mut record: atrium_api::app::bsky::feed::post::Record =
                atrium_api::app::bsky::feed::post::RecordData {
                    created_at: atrium_api::types::string::Datetime::new(now.fixed_offset()),
                    embed: None,
                    entities: None,
                    facets: Some(vec![atrium_api::app::bsky::richtext::facet::MainData {
                        features: vec![atrium_api::types::Union::Refs(
                            atrium_api::app::bsky::richtext::facet::MainFeaturesItem::Link(
                                Box::new(
                                    atrium_api::app::bsky::richtext::facet::LinkData {
                                        uri: event.url.clone(),
                                    }
                                    .into(),
                                ),
                            ),
                        )],
                        index: atrium_api::app::bsky::richtext::facet::ByteSliceData {
                            byte_start: 0,
                            byte_end: event.summary.bytes().len(),
                        }
                        .into(),
                    }
                    .into()]),
                    labels: None,
                    langs: Some(vec![atrium_api::types::string::Language::new(
                        "en".to_string(),
                    )
                    .unwrap()]),
                    reply: None,
                    tags: None,
                    text: format!(
                        "{summary}\n\n📅 {dtstart} – {dtend}\n📍 {location}",
                        summary = event.summary,
                        location = event.location,
                        dtstart = event.dtstart,
                        dtend = event.dtend
                    ),
                }
                .into();
            let ipld_core::ipld::Ipld::Map(extra_data) = &mut record.extra_data else {
                unreachable!()
            };
            extra_data.insert(
                EXTRA_DATA_LABEL_VAL.to_string(),
                ipld_core::ipld::Ipld::String(event.val.clone()),
            );

            writes.push(
                atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Create(Box::new(
                    atrium_api::com::atproto::repo::apply_writes::CreateData {
                        collection: atrium_api::app::bsky::feed::Post::nsid(),
                        rkey: Some(rkey.clone()),
                        value: record.try_into_unknown().unwrap(),
                    }
                    .into(),
                )),
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
                        app_state.did.to_string(),
                        atrium_api::app::bsky::feed::Post::NSID,
                        rkey.to_string()
                    ),
                }
                .into();

            writes.push(
                atrium_api::com::atproto::repo::apply_writes::InputWritesItem::Create(Box::new(
                    atrium_api::com::atproto::repo::apply_writes::CreateData {
                        collection: atrium_api::app::bsky::feed::Threadgate::nsid(),
                        rkey: Some(rkey.clone()),
                        value: record.try_into_unknown().unwrap(),
                    }
                    .into(),
                )),
            );
        }

        app_state
            .agent
            .api
            .com
            .atproto
            .repo
            .delete_record(
                atrium_api::com::atproto::repo::delete_record::InputData {
                    collection: atrium_api::app::bsky::feed::Post::nsid(),
                    repo: app_state.did.clone().into(),
                    rkey: rkey.clone(),
                    swap_commit: None,
                    swap_record: None,
                }
                .into(),
            )
            .await?;

        current_events.insert(event.val.clone(), rkey);

        // https://github.com/bluesky-social/atproto/issues/2468#issuecomment-2100947405
        now += chrono::Duration::milliseconds(1);
    }

    {
        let record: atrium_api::app::bsky::labeler::service::Record =
            atrium_api::app::bsky::labeler::service::RecordData {
                created_at: atrium_api::types::string::Datetime::now(),
                labels: None,
                policies: atrium_api::app::bsky::labeler::defs::LabelerPoliciesData {
                    label_values: events.iter().map(|event| event.val.clone()).collect(),
                    label_value_definitions: Some(
                        events
                            .iter()
                            .map(|event| {
                                let mut def: atrium_api::com::atproto::label::defs::LabelValueDefinition = atrium_api::com::atproto::label::defs::LabelValueDefinitionData {
                                    adult_only: Some(false),
                                    blurs: "none".to_string(),
                                    default_setting: Some("warn".to_string()),
                                    identifier: event.val.clone(),
                                    locales: vec![atrium_api::com::atproto::label::defs::LabelValueDefinitionStringsData {
                                        lang: atrium_api::types::string::Language::new(
                                            "en".to_string(),
                                        )
                                        .unwrap(),
                                        name: event.summary.clone(),
                                        description: format!(
                                            "📅 {dtstart} – {dtend}\n📍 {location}",
                                            location = event.location,
                                            dtstart = event.dtstart,
                                            dtend = event.dtend
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
                                    ipld_core::ipld::Ipld::String(
                                        current_events
                                            .get(&event.val)
                                            .cloned()
                                            .unwrap()
                                            .to_string(),
                                    ),
                                );
                                extra_data.insert(
                                    EXTRA_DATA_EVENT_INFO.to_string(),
                                    ipld_core::ipld::Ipld::Map(std::collections::BTreeMap::from([
                                        (
                                            "date".to_string(),
                                            ipld_core::ipld::Ipld::String(format!(
                                                "{}/{}",
                                                event.dtstart.format("%Y%m%d"),
                                                event.dtend.format("%Y%m%d")
                                            )),
                                        ),
                                        (
                                            "location".to_string(),
                                            ipld_core::ipld::Ipld::String(event.location.clone()),
                                        ),
                                    ])),
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

    events_state.events = events
        .into_iter()
        .map(|event| (event.val.clone(), event))
        .collect();

    events_state.rkeys_to_label_vals = current_events
        .into_iter()
        .map(|(val, rkey)| (rkey, val))
        .collect();

    app_state
        .agent
        .api
        .com
        .atproto
        .repo
        .apply_writes(
            atrium_api::com::atproto::repo::apply_writes::InputData {
                repo: app_state.did.clone().into(),
                swap_commit: None,
                validate: Some(true),
                writes,
            }
            .into(),
        )
        .await?;

    metrics::gauge!("label_sync_time").set(chrono::Utc::now().timestamp_micros() as f64);

    Ok(())
}

fn row_to_label(
    did: &atrium_api::types::string::Did,
    row: &rusqlite::Row,
) -> Result<(i64, atrium_api::com::atproto::label::defs::Label), anyhow::Error> {
    let seq = row.get::<_, i64>(0)?;
    let cts = atrium_api::types::string::Datetime::new(chrono::DateTime::parse_from_rfc3339(
        &row.get::<_, String>(1)?,
    )?);
    let exp = row
        .get::<_, Option<String>>(2)?
        .map(|exp| {
            chrono::DateTime::parse_from_rfc3339(&exp).map(atrium_api::types::string::Datetime::new)
        })
        .map_or(Ok(None), |v| v.map(Some))?;
    let cid = row
        .get::<_, Option<String>>(3)?
        .map(|cid| atrium_api::types::string::Cid::from_str(&cid))
        .map_or(Ok(None), |v| v.map(Some))?;
    let sig = row.get::<_, Option<Vec<u8>>>(4)?;
    let uri = row.get::<_, String>(5)?;
    let val = row.get::<_, String>(6)?;
    let neg = if row.get::<_, i64>(7)? == 0 {
        None
    } else {
        Some(true)
    };

    Ok((
        seq,
        atrium_api::com::atproto::label::defs::LabelData {
            cid: cid,
            cts: cts,
            exp: exp,
            neg: neg,
            src: did.clone(),
            uri,
            val,
            ver: Some(1),
            sig,
        }
        .into(),
    ))
}

async fn subscribe_labels(
    axum::extract::State(app_state): axum::extract::State<AppState>,
    ws: axum::extract::ws::WebSocketUpgrade,
    axum_extra::extract::Query(params): axum_extra::extract::Query<
        atrium_api::com::atproto::label::subscribe_labels::ParametersData,
    >,
) -> axum::response::Response {
    ws.on_upgrade(move |socket: axum::extract::ws::WebSocket| async move {
        {
            let (sink, mut stream) = socket.split();

            let subscriber = std::sync::Arc::new(tokio::sync::Mutex::new(Subscriber::new(sink)));
            let cloned_subscriber = subscriber.clone();

            // 1. Lock the subscriber first, so no other thread is allowed to write to it.
            // 2. Insert the subscriber into the map of subscribers, so any new writes will be queued.
            // 3. If there is a cursor, catch up the subscriber.
            // 4. Unlock the subscriber.
            let mut subscriber = subscriber.lock().await;

            let subscriber_id = {
                let mut subscribers_state = app_state.subscribers_state.lock().await;
                let subscriber_id = subscribers_state.next_subscriber_id;
                subscribers_state.next_subscriber_id += 1;

                subscribers_state
                    .subscribers
                    .insert(subscriber_id, cloned_subscriber);

                metrics::gauge!("num_subscriptions")
                    .set(subscribers_state.subscribers.len() as f64);

                subscriber_id
            };

            match async {
                {
                    if let Some(cursor) = params.cursor {
                        let db_conn = app_state.db_pool.get()?;

                        let mut pending = vec![];

                        {
                            let mut stmt = db_conn.prepare(
                                "
                                SELECT seq, cts, exp, cid, sig, uri, val, neg
                                FROM labels
                                WHERE seq > ?
                                ",
                            )?;

                            let mut rows = stmt.query(rusqlite::params![cursor])?;

                            while let Some(row) = rows.next()? {
                                let (seq, label) = row_to_label(&app_state.did, &row)?;

                                pending.push(
                                    atrium_api::com::atproto::label::subscribe_labels::LabelsData {
                                        seq,
                                        labels: vec![label],
                                    }
                                    .into(),
                                );
                            }
                        }

                        for labels in pending {
                            subscriber.send(&labels).await?;
                        }
                    }
                }

                drop(subscriber);

                while let Some(msg) = stream.next().await {
                    let _ = msg?;
                }
                Ok::<_, anyhow::Error>(())
            }
            .await
            {
                Ok(_) => {}
                Err(err) => {
                    log::error!("subscribeLabels error: {err}");
                }
            }

            {
                let mut subscribers_state = app_state.subscribers_state.lock().await;
                subscribers_state.subscribers.remove(&subscriber_id);
                metrics::gauge!("num_subscriptions")
                    .set(subscribers_state.subscribers.len() as f64);
            }
        }
    })
}

#[derive(Debug, serde::Serialize)]
struct QueryLabelsLabel {
    #[serde(flatten)]
    label: atrium_api::com::atproto::label::defs::Label,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_query_labels_label_sig"
    )]
    sig: Option<Vec<u8>>,
}

fn serialize_query_labels_label_sig<S>(v: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let Some(v) = v else {
        return Option::<Vec<u8>>::None.serialize(s);
    };

    #[derive(serde::Serialize)]
    struct BytesWrapper {
        #[serde(rename = "$bytes")]
        bytes: String,
    }

    BytesWrapper {
        bytes: base64::engine::general_purpose::STANDARD_NO_PAD.encode(v),
    }
    .serialize(s)
}

#[derive(serde::Serialize)]
struct QueryLabelsOutputData {
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    labels: Vec<QueryLabelsLabel>,
}

async fn query_labels(
    axum::extract::State(app_state): axum::extract::State<AppState>,
    axum_extra::extract::Query(params): axum_extra::extract::Query<
        atrium_api::com::atproto::label::query_labels::ParametersData,
    >,
) -> Result<axum::response::Json<QueryLabelsOutputData>, AppError> {
    if !params
        .sources
        .as_ref()
        .map(|sources| sources.contains(&app_state.did))
        .unwrap_or(true)
    {
        return Ok(axum::response::Json(QueryLabelsOutputData {
            cursor: None,
            labels: vec![],
        }));
    }

    let mut labels = vec![];

    let mut out_cursor = None;

    {
        let db_conn = app_state.db_pool.get()?;

        let limit = params.limit.map(|v| v.into()).unwrap_or(250u8);

        let mut stmt = db_conn.prepare(&format!(
            "
            SELECT seq, cts, exp, cid, sig, uri, val, neg
            FROM labels
            WHERE seq > ? AND ({})
            LIMIT ?
            ",
            {
                let mut buf = "uri LIKE ? ESCAPE '\\'".to_string();
                for _ in 0..params.uri_patterns.len() - 1 {
                    buf.push_str(" OR uri LIKE ? ESCAPE '\\'");
                }
                buf
            }
        ))?;
        let mut query_params = vec![];

        let cursor = params.cursor.unwrap_or_else(|| "0".to_string());
        query_params.push(cursor.to_sql()?);

        let sql_uri_patterns = params
            .uri_patterns
            .iter()
            .map(|pattern| pattern.replace("%", "\\%").replace("*", "%"))
            .collect::<Vec<_>>();

        for sql_uri_pattern in sql_uri_patterns.iter() {
            query_params.push(sql_uri_pattern.to_sql()?);
        }

        query_params.push(limit.to_sql()?);

        let mut rows = stmt.query(rusqlite::params_from_iter(query_params.iter()))?;

        while let Some(row) = rows.next()? {
            let (seq, mut label) = row_to_label(&app_state.did, &row)?;
            out_cursor = Some(seq);
            let mut sig = None;
            std::mem::swap(&mut sig, &mut label.sig);
            let label = QueryLabelsLabel { sig, label };
            labels.push(label);
        }
    }

    Ok(axum::response::Json(QueryLabelsOutputData {
        cursor: out_cursor.map(|c| c.to_string()),
        labels,
    }))
}

struct EventsState {
    rkeys_to_label_vals: std::collections::HashMap<atrium_api::types::string::RecordKey, String>,
    events: std::collections::HashMap<String, Event>,
}

struct SubscribersState {
    next_subscriber_id: usize,
    subscribers: std::collections::HashMap<usize, std::sync::Arc<tokio::sync::Mutex<Subscriber>>>,
}

#[derive(Clone)]
struct AppState {
    keypair: std::sync::Arc<atrium_crypto::keypair::Secp256k1Keypair>,
    agent: std::sync::Arc<
        atrium_api::agent::Agent<
            atrium_api::agent::atp_agent::CredentialSession<
                atrium_api::agent::atp_agent::store::MemorySessionStore,
                atrium_xrpc_client::reqwest::ReqwestClient,
            >,
        >,
    >,
    did: atrium_api::types::string::Did,
    db_pool: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
    subscribers_state: std::sync::Arc<tokio::sync::Mutex<SubscribersState>>,
    events_state: std::sync::Arc<tokio::sync::Mutex<EventsState>>,
}

#[derive(Debug)]
struct PendingLabel {
    cts: chrono::DateTime<chrono::Utc>,
    exp: Option<chrono::DateTime<chrono::Utc>>,
    cid: Option<cid::Cid>,
    neg: bool,
    uri: String,
    val: String,
}

fn sign_label(
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    mut label: atrium_api::com::atproto::label::defs::Label,
) -> Result<atrium_api::com::atproto::label::defs::Label, anyhow::Error> {
    label.sig = None;

    let encoded_label = serde_ipld_dagcbor::to_vec(&label)?;
    label.sig = Some(keypair.sign(&encoded_label)?);

    Ok(label)
}

impl AppState {
    async fn add_label(&self, label: PendingLabel, like_rkey: &str) -> Result<(), anyhow::Error> {
        let signed_label = sign_label(
            &self.keypair,
            atrium_api::com::atproto::label::defs::LabelData {
                cid: None,
                cts: atrium_api::types::string::Datetime::new(label.cts.fixed_offset()),
                exp: label
                    .exp
                    .map(|exp| atrium_api::types::string::Datetime::new(exp.fixed_offset()))
                    .clone(),
                neg: if label.neg { Some(true) } else { None },
                src: self.did.clone(),
                uri: label.uri.clone(),
                val: label.val.clone(),
                ver: Some(1),
                sig: None,
            }
            .into(),
        )?;

        let seq = {
            let db_conn = self.db_pool.get()?;
            let cts = label
                .cts
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
            let exp = label
                .exp
                .as_ref()
                .map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Micros, true));
            let cid = label.cid.as_ref().map(|v| v.to_string());
            db_conn.query_row(
                "
                INSERT INTO labels (cts, exp, cid, sig, uri, val, neg, like_rkey)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING seq
                ",
                rusqlite::params![
                    cts,
                    exp,
                    cid,
                    signed_label.sig,
                    label.uri,
                    label.val,
                    label.neg,
                    like_rkey,
                ],
                |row| row.get(0),
            )?
        };

        metrics::gauge!("label_seq").set(seq as f64);

        let labels: atrium_api::com::atproto::label::subscribe_labels::Labels =
            atrium_api::com::atproto::label::subscribe_labels::LabelsData {
                labels: vec![signed_label],
                seq,
            }
            .into();

        let subscribers = self
            .subscribers_state
            .lock()
            .await
            .subscribers
            .values()
            .cloned()
            .collect::<Vec<_>>();

        futures::future::join_all(subscribers.into_iter().map(move |subscriber| {
            let labels = labels.clone();
            async move {
                let _ = subscriber.lock().await.send(&labels).await;
            }
        }))
        .await;

        Ok(())
    }
}

struct Subscriber {
    sink: futures::prelude::stream::SplitSink<
        axum::extract::ws::WebSocket,
        axum::extract::ws::Message,
    >,
}

impl Subscriber {
    fn new(
        sink: futures::prelude::stream::SplitSink<
            axum::extract::ws::WebSocket,
            axum::extract::ws::Message,
        >,
    ) -> Self {
        Self { sink }
    }

    async fn send(
        &mut self,
        labels: &atrium_api::com::atproto::label::subscribe_labels::Labels,
    ) -> Result<(), anyhow::Error> {
        let mut buf = vec![];

        #[derive(serde::Serialize)]
        struct Header {
            t: String,
            op: i64,
        }
        buf.extend(serde_ipld_dagcbor::to_vec(&Header {
            t: "#labels".to_string(),
            op: 1,
        })?);
        buf.extend(serde_ipld_dagcbor::to_vec(labels)?);

        self.sink
            .send(axum::extract::ws::Message::Binary(buf.into()))
            .await?;

        Ok(())
    }
}

async fn service_jetstream(
    app_state: &AppState,
    jetstream_endpoint: &str,
) -> Result<(), anyhow::Error> {
    let jetstream = jetstream_oxide::JetstreamConnector::new(jetstream_oxide::JetstreamConfig {
        endpoint: jetstream_endpoint.to_string(),
        compression: jetstream_oxide::JetstreamCompression::Zstd,
        wanted_collections: vec![atrium_api::app::bsky::feed::Like::nsid()],
        cursor: {
            let db_conn = app_state.db_pool.get()?;
            let cursor = db_conn.query_row(
                "SELECT COALESCE((SELECT cursor FROM jetstream_cursor WHERE id = 0), NULL)",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )?;
            cursor.map(|d| chrono::DateTime::from_timestamp_micros(d).unwrap())
        },
        ..Default::default()
    })?;

    let receiver = jetstream.connect().await?;

    while let Ok(event) = receiver.recv_async().await {
        let jetstream_oxide::events::JetstreamEvent::Commit(commit) = event else {
            continue;
        };

        let cursor = match &commit {
            jetstream_oxide::events::commit::CommitEvent::Create { info, .. }
            | jetstream_oxide::events::commit::CommitEvent::Update { info, .. }
            | jetstream_oxide::events::commit::CommitEvent::Delete { info, .. } => info.time_us,
        };

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

                    let Some(&[did, collection, rkey]) = parts.as_ref().map(|v| &v[..]) else {
                        return Ok(());
                    };

                    if did != app_state.did.to_string() {
                        return Ok(());
                    }

                    if collection != atrium_api::app::bsky::feed::Post::NSID {
                        return Ok(());
                    }

                    let events_state = app_state.events_state.lock().await;

                    let Some(val) = events_state
                        .rkeys_to_label_vals
                        .get(&atrium_api::types::string::RecordKey::new(rkey.to_string()).unwrap())
                        .cloned()
                    else {
                        return Ok(());
                    };

                    let event = events_state.events.get(&val).unwrap();

                    let pending = PendingLabel {
                        cts: chrono::DateTime::from_timestamp_micros(info.time_us as i64).unwrap(),
                        exp: Some(
                            (event.dtend + chrono::Duration::days(1))
                                .and_time(chrono::NaiveTime::MIN)
                                .and_utc(),
                        ),
                        cid: None,
                        neg: false,
                        uri: info.did.to_string(),
                        val: val,
                    };

                    log::info!("applying label: {:?}", pending);
                    app_state.add_label(pending, &commit.info.rkey).await?;
                }
                jetstream_oxide::events::commit::CommitEvent::Delete { info, commit } => {
                    let db_conn = app_state.db_pool.get()?;

                    let uri = info.did.to_string();

                    let mut stmt = db_conn.prepare(
                        "
                        SELECT val FROM labels
                        WHERE like_rkey = ? AND uri = ? AND NOT neg
                        ",
                    )?;

                    let Some(val) = stmt
                        .query_row(rusqlite::params![commit.rkey, uri], |row| {
                            row.get::<_, String>(0)
                        })
                        .optional()?
                    else {
                        return Ok(());
                    };

                    let pending = PendingLabel {
                        cts: chrono::DateTime::from_timestamp_micros(info.time_us as i64).unwrap(),
                        exp: None,
                        cid: None,
                        neg: true,
                        uri: uri,
                        val: val,
                    };

                    log::info!("removing label: {:?}", pending);
                    app_state.add_label(pending, &commit.rkey).await?;
                }
                _ => {}
            }

            Ok::<_, anyhow::Error>(())
        }
        .await?;

        let db_conn = app_state.db_pool.get()?;

        metrics::gauge!("jetstream_cursor").set(cursor as f64);

        db_conn.execute(
            "
            INSERT OR REPLACE INTO jetstream_cursor (id, cursor)
            VALUES (0, ?)
            ",
            [cursor],
        )?;
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    metrics::describe_gauge!(
        "jetstream_cursor",
        metrics::Unit::Microseconds,
        "jetstream cursor location"
    );

    metrics::describe_gauge!("label_seq", "sequence number of currently emitted label");

    metrics::describe_gauge!("num_subscriptions", "number of active subscriptions");

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
        .set_default("bind", "127.0.0.1:3001")?
        .set_default("db_path", "db.db")?
        .set_default("keypair_path", "signing.key")?
        .set_default(
            "jetstream_endpoint",
            String::from(jetstream_oxide::DefaultJetstreamEndpoints::USEastOne),
        )?
        .build()?
        .try_deserialize()?;

    let session = atrium_api::agent::atp_agent::CredentialSession::new(
        atrium_xrpc_client::reqwest::ReqwestClient::new(&config.bsky_endpoint),
        atrium_api::agent::atp_agent::store::MemorySessionStore::default(),
    );
    session
        .login(&config.bsky_username, &config.bsky_password)
        .await?;
    let agent = std::sync::Arc::new(atrium_api::agent::Agent::new(session));

    let did = agent.did().await.unwrap();

    let db_pool = r2d2::Pool::new(
        r2d2_sqlite::SqliteConnectionManager::file(&config.db_path)
            .with_init(|c| c.execute_batch("PRAGMA journal_mode=WAL;")),
    )
    .unwrap();

    db_pool.get().unwrap().execute_batch(SCHEMA).unwrap();

    let keypair =
        atrium_crypto::keypair::Secp256k1Keypair::import(&std::fs::read(&config.keypair_path)?)?;

    let app_state = AppState {
        keypair: std::sync::Arc::new(keypair),
        agent: agent.clone(),
        did,
        db_pool,
        subscribers_state: std::sync::Arc::new(tokio::sync::Mutex::new(SubscribersState {
            next_subscriber_id: 0,
            subscribers: std::collections::HashMap::new(),
        })),
        events_state: std::sync::Arc::new(tokio::sync::Mutex::new(EventsState {
            rkeys_to_label_vals: std::collections::HashMap::new(),
            events: std::collections::HashMap::new(),
        })),
    };

    let handle = metrics_exporter_prometheus::PrometheusBuilder::new().install_recorder()?;

    let app = axum::Router::new()
        .nest(
            "/xrpc",
            axum::Router::new()
                .route(
                    &format!(
                        "/{}",
                        atrium_api::com::atproto::label::subscribe_labels::NSID
                    ),
                    axum::routing::get(subscribe_labels),
                )
                .route(
                    &format!("/{}", atrium_api::com::atproto::label::query_labels::NSID),
                    axum::routing::get(query_labels),
                ),
        )
        .route(
            "/metrics",
            axum::routing::get(move || async move { handle.render() }),
        )
        .route("/", axum::routing::get(|| async { ">:3" }))
        .with_state(app_state.clone());

    log::info!("syncing initial labels");
    sync_labels(&config.ics_url, &app_state).await?;

    let listener = tokio::net::TcpListener::bind(&config.bind).await?;

    tokio::try_join!(
        async {
            // Sync labels.
            let app_state = app_state.clone();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60 * 60 * 12)).await;
                log::info!("syncing labels");
                sync_labels(&config.ics_url, &app_state).await?;
            }

            #[allow(unreachable_code)]
            Ok::<_, anyhow::Error>(())
        },
        async {
            // Wait on events.
            let app_state = app_state.clone();
            service_jetstream(&app_state, &config.jetstream_endpoint).await?;
            Ok(())
        },
        async {
            // Serve labeler.
            axum::serve(listener, app).await?;
            Ok(())
        }
    )?;

    Ok(())
}
