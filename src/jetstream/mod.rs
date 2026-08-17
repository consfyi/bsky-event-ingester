use futures::{SinkExt as _, StreamExt as _};

pub mod event;
pub mod reconnect;

/// Public Jetstream hosts, in dial order. All speak the v1 wire at
/// `/subscribe` with portable unix-microsecond cursors, so any of them can
/// take over from any other. The v2 hosts (launched 2026-08-14) come first;
/// the legacy `jetstream{1,2}` hosts are the fallbacks and Bluesky has said
/// they will be retired eventually. Regions alternate so a regional problem
/// is skipped after one failover.
pub const DEFAULT_ENDPOINTS: &[&str] = &[
    "wss://jetstream.us-east.bsky.network/subscribe",
    "wss://jetstream.us-west.bsky.network/subscribe",
    "wss://jetstream1.us-east.bsky.network/subscribe",
    "wss://jetstream1.us-west.bsky.network/subscribe",
    "wss://jetstream2.us-east.bsky.network/subscribe",
    "wss://jetstream2.us-west.bsky.network/subscribe",
];

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOptions {
    pub wanted_collections: Vec<atrium_api::types::string::Nsid>,
    pub wanted_dids: Vec<atrium_api::types::string::Did>,
    pub max_message_size_bytes: u32,
    pub cursor: Option<i64>,
    pub compress: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("tungstenite: {0}")]
    Tungstenite(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("serde_json: {0}")]
    SerdeJson(#[from] serde_json::Error),

    #[error("serde_html_form: {0}")]
    SerdeHtmlForm(#[from] serde_html_form::ser::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

static ZSTD_DICTIONARY: std::sync::LazyLock<zstd::dict::DecoderDictionary<'static>> =
    std::sync::LazyLock::new(|| {
        zstd::dict::DecoderDictionary::copy(include_bytes!("./zstd_dictionary"))
    });

pub async fn connect(
    endpoint: &url::Url,
    options: ConnectOptions,
) -> Result<impl futures::Stream<Item = Result<event::Event, Error>>, Error> {
    let mut url = endpoint.clone();
    url.set_query(Some(&serde_html_form::to_string(&options)?));

    let (ws, _) = tokio_tungstenite::connect_async(url).await?;

    // Pings are answered by a dedicated task rather than inline: the v2
    // Jetstream hosts hard-close a connection whose Pong is more than 5s
    // late, and inline handling only ran while the consumer was polling —
    // a slow DB write or a spawned worker could sit longer than that.
    let (mut sink, mut source) = ws.split();
    let (tx, rx) = tokio::sync::mpsc::channel(PONG_TASK_BUFFER);
    tokio::spawn(async move {
        while let Some(message) = source.next().await {
            match message {
                Ok(tokio_tungstenite::tungstenite::Message::Ping(body)) => {
                    if sink
                        .send(tokio_tungstenite::tungstenite::Message::Pong(body))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
                other => {
                    // Consumer dropped the stream: stop reading.
                    if tx.send(other).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    Ok(async_stream::try_stream! {
        let mut rx = rx;
        while let Some(message) = rx.recv().await {
            match message? {
                tokio_tungstenite::tungstenite::Message::Binary(body) => {
                    // Compressed.
                    yield serde_json::from_reader(zstd::stream::Decoder::with_prepared_dictionary(
                        &mut &body[..],
                        &ZSTD_DICTIONARY,
                    )?)?;
                }
                tokio_tungstenite::tungstenite::Message::Text(body) => {
                    // Uncompressed.
                    yield serde_json::from_str(&body)?;
                }
                _ => {}
            }
        }
    })
}

/// Messages buffered between the socket task and the consumer. Pings keep
/// being answered while the consumer is busy until this fills.
const PONG_TASK_BUFFER: usize = 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use atrium_api::types::Collection as _;

    // Talks to the public network; run on demand with `cargo test -- --ignored`.
    // Proves each default host still speaks the v1 wire at /subscribe and
    // that the split reader/ponger delivers events.
    #[tokio::test]
    #[ignore]
    async fn live_default_endpoints_deliver_events() {
        for endpoint in DEFAULT_ENDPOINTS {
            let stream = connect(
                &url::Url::parse(endpoint).unwrap(),
                ConnectOptions {
                    wanted_collections: vec![atrium_api::app::bsky::feed::Like::nsid()],
                    compress: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap_or_else(|e| panic!("{endpoint}: {e}"));
            futures::pin_mut!(stream);
            let first = tokio::time::timeout(std::time::Duration::from_secs(15), stream.next())
                .await
                .unwrap_or_else(|_| panic!("{endpoint}: no event within 15s"));
            match first {
                Some(Ok(event)) => assert!(event.time_us > 0, "{endpoint}"),
                Some(Err(e)) => panic!("{endpoint}: {e}"),
                None => panic!("{endpoint}: stream ended"),
            }
        }
    }
}
