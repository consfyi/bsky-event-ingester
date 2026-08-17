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
    //
    // The channel is unbounded so a stalled consumer can never park this
    // task on `send` and starve the Pong. Memory is still bounded, by the
    // server: it disconnects a client whose outbox fills, and the old
    // inline code was dropped in exactly that way under a long stall.
    let (mut sink, mut source) = ws.split();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let message = tokio::select! {
                // Consumer dropped the stream: tell the server (best effort)
                // and stop reading, so the socket doesn't outlive its reader.
                _ = tx.closed() => {
                    let _ = sink.send(tokio_tungstenite::tungstenite::Message::Close(None)).await;
                    break;
                }
                message = source.next() => match message {
                    Some(m) => m,
                    None => break,
                },
            };
            match message {
                Ok(tokio_tungstenite::tungstenite::Message::Ping(body)) => {
                    if let Err(e) = sink
                        .send(tokio_tungstenite::tungstenite::Message::Pong(body))
                        .await
                    {
                        // Surface the failure to the consumer instead of ending
                        // the stream as if the server closed cleanly.
                        let _ = tx.send(Err(e));
                        break;
                    }
                }
                Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
                other => {
                    if tx.send(other).is_err() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use atrium_api::types::Collection as _;
    use tokio_tungstenite::tungstenite::Message;

    type ServerWs = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// A local Jetstream stand-in: `connect()` dials it, the test drives the
    /// server side by hand. Returns the client stream and the accepted socket.
    async fn local_pair() -> (
        impl futures::Stream<Item = Result<event::Event, Error>>,
        ServerWs,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = url::Url::parse(&format!(
            "ws://{}/subscribe",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let accept = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(tcp).await.unwrap()
        });
        let client = connect(&url, ConnectOptions::default()).await.unwrap();
        (client, accept.await.unwrap())
    }

    /// Reads server-side until a Pong arrives (or the socket ends).
    async fn expect_pong(server: &mut ServerWs) {
        let deadline = std::time::Duration::from_secs(5);
        tokio::time::timeout(deadline, async {
            while let Some(m) = server.next().await {
                if let Ok(Message::Pong(_)) = m {
                    return;
                }
            }
            panic!("socket ended without a Pong");
        })
        .await
        .expect("no Pong within 5s");
    }

    // Pongs must go out even when nobody is polling the stream.
    #[tokio::test]
    async fn pong_is_sent_while_consumer_is_not_polling() {
        let (client, mut server) = local_pair().await;
        server.send(Message::Ping(vec![1, 2, 3])).await.unwrap();
        expect_pong(&mut server).await;
        drop(client);
    }

    // A stalled consumer must never back-pressure the reader into
    // missing a Ping — the channel is unbounded for exactly this reason.
    #[tokio::test]
    async fn pong_is_sent_after_a_backlog_the_consumer_never_drains() {
        let (client, mut server) = local_pair().await;
        for i in 0..2500 {
            server
                .send(Message::Text(format!("{{\"n\":{i}}}")))
                .await
                .unwrap();
        }
        server.send(Message::Ping(vec![])).await.unwrap();
        expect_pong(&mut server).await;
        drop(client);
    }

    // Dropping the stream must end the upstream socket, not leak it.
    #[tokio::test]
    async fn dropping_the_stream_closes_the_socket() {
        let (client, mut server) = local_pair().await;
        drop(client);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match server.next().await {
                    None | Some(Ok(Message::Close(_))) | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await
        .expect("server did not observe a close within 5s");
    }

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
