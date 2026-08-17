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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOptions {
    pub wanted_collections: Vec<atrium_api::types::string::Nsid>,
    pub wanted_dids: Vec<atrium_api::types::string::Did>,
    pub max_message_size_bytes: u32,
    pub cursor: Option<i64>,
    pub compress: bool,
    /// Cap on the dial (TCP + TLS + WebSocket handshake); `None` = 15s.
    /// A blackholed host otherwise hangs in the kernel SYN retry (~127s),
    /// which is longer than the reconnect policy's `healthy_after` — every
    /// hung dial would count as a healthy connection and failover would
    /// never trip. Not a query parameter, hence `skip`.
    #[serde(skip)]
    pub connect_timeout: Option<std::time::Duration>,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            wanted_collections: Vec::new(),
            wanted_dids: Vec::new(),
            // Ask the server to drop oversized events before the wire; the
            // client enforces the same cap on what it will buffer.
            max_message_size_bytes: MAX_MESSAGE_BYTES as u32,
            cursor: None,
            compress: false,
            connect_timeout: None,
        }
    }
}

/// Default for `ConnectOptions::connect_timeout`; must stay well under
/// `reconnect::Policy::healthy_after` (60s).
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Largest WebSocket message (and frame) the client accepts; a Jetstream
/// event is ~1 KB. Without this, tungstenite's default is 64 MiB per
/// message, so the relay bound below would be 32768 × 64 MiB.
pub const MAX_MESSAGE_BYTES: usize = 1 << 20;

/// Messages buffered between the socket reader and the consumer, reserved
/// before each read so a stalled consumer parks the reader instead of
/// growing memory without limit (TCP backpressure then fills the server's
/// outbox and it disconnects us). Memory ≤ RELAY_BUFFER × MAX_MESSAGE_BYTES
/// = 32 GiB worst case; ~tens of MB in practice at ~1 KB/event, which is
/// ~15-30s of the like firehose — long enough for Pings to keep being
/// answered through the slow-DB-write case the relay task exists for.
pub const RELAY_BUFFER: usize = 32_768;

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

    #[error("connect timed out after {0:?}")]
    ConnectTimeout(std::time::Duration),

    #[error("pong write timed out after {0:?}")]
    WriteTimeout(std::time::Duration),
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

    let connect_timeout = options.connect_timeout.unwrap_or(CONNECT_TIMEOUT);
    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..Default::default()
    };
    let (ws, _) = tokio::time::timeout(
        connect_timeout,
        tokio_tungstenite::connect_async_with_config(url, Some(ws_config), false),
    )
    .await
    .map_err(|_| Error::ConnectTimeout(connect_timeout))??;

    // Pings are answered by a dedicated task rather than inline: the v2
    // Jetstream hosts hard-close a connection whose Pong is more than 5s
    // late, and inline handling only ran while the consumer was polling —
    // a slow DB write or a spawned worker could sit longer than that.
    //
    // The task reserves a relay slot *before* reading the next message so
    // that a stalled consumer parks the reader (see RELAY_BUFFER). Both the
    // reserve and the read race `tx.closed()`: a consumer that drops the
    // stream while the socket is idle must still end the socket, or the
    // task and socket leak until the next inbound frame — never, on a
    // silent host.
    let (mut sink, mut source) = ws.split();
    let (tx, rx) = tokio::sync::mpsc::channel(RELAY_BUFFER);
    tokio::spawn(async move {
        // Consumer dropped the stream: tell the server (best effort, bounded
        // so a wedged socket can't pin this task) and stop reading.
        async fn close_best_effort<S>(sink: &mut S)
        where
            S: futures::Sink<tokio_tungstenite::tungstenite::Message> + Unpin,
        {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                sink.send(tokio_tungstenite::tungstenite::Message::Close(None)),
            )
            .await;
        }
        loop {
            let permit = tokio::select! {
                _ = tx.closed() => {
                    close_best_effort(&mut sink).await;
                    break;
                }
                permit = tx.reserve() => match permit {
                    Ok(p) => p,
                    Err(_) => {
                        close_best_effort(&mut sink).await;
                        break;
                    }
                },
            };
            let message = tokio::select! {
                _ = tx.closed() => {
                    close_best_effort(&mut sink).await;
                    break;
                }
                next = source.next() => match next {
                    Some(m) => m,
                    None => break,
                },
            };
            match message {
                Ok(tokio_tungstenite::tungstenite::Message::Ping(body)) => {
                    // A Pong the server never reads is as fatal as a write
                    // error — its 5s deadline passes either way — so bound the
                    // write and surface it rather than hang here.
                    const PONG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
                    match tokio::time::timeout(
                        PONG_TIMEOUT,
                        sink.send(tokio_tungstenite::tungstenite::Message::Pong(body)),
                    )
                    .await
                    {
                        // Ping consumed no frame slot: drop the permit unused.
                        Ok(Ok(())) => {}
                        // Surface the failure to the consumer instead of ending
                        // the stream as if the server closed cleanly.
                        Ok(Err(e)) => {
                            permit.send(Err(e.into()));
                            break;
                        }
                        Err(_) => {
                            permit.send(Err(Error::WriteTimeout(PONG_TIMEOUT)));
                            break;
                        }
                    }
                }
                Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
                other => permit.send(other.map_err(Error::from)),
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

    // A stalled consumer must not back-pressure the reader into missing a
    // Ping while the relay buffer still has room (backlog < RELAY_BUFFER).
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

    // Once the buffer is full the reader must stop reading (that is the
    // memory bound), and nothing may be lost or reordered: after the
    // consumer drains, every frame arrives in order and a Ping is answered
    // again. Frames are real events so the consumer side can count them.
    #[tokio::test]
    async fn full_buffer_parks_the_reader_without_losing_frames() {
        let (client, mut server) = local_pair().await;
        futures::pin_mut!(client);
        // The overshoot past RELAY_BUFFER must dwarf what the kernel socket
        // buffers (up to ~8MB on macOS loopback) and tungstenite's read
        // buffer can absorb, or a reader that never parks would pass.
        let total = 3 * RELAY_BUFFER;
        let pad = "x".repeat(512);
        let event = move |i: usize| {
            format!(
                "{{\"did\":\"did:plc:x\",\"time_us\":{i},\"kind\":\"identity\",\
                 \"identity\":{{\"did\":\"did:plc:x\",\"seq\":1,\"time\":\"2026-01-01T00:00:00Z\"}},\
                 \"pad\":\"{pad}\"}}"
            )
        };
        // The server side sends from its own task so a parked reader stalls
        // it (observable via `sent`) without stalling the test.
        let sent = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sender = tokio::spawn({
            let sent = sent.clone();
            async move {
                for i in 0..total {
                    server.send(Message::Text(event(i))).await.unwrap();
                    sent.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                server
            }
        });
        // With nobody polling, the sender must stall short of `total`
        // (buffer + the one frame the reader holds + socket buffers) and
        // then stop moving entirely — two samples a second apart must match,
        // or the reader is merely slow, not parked. It must also have got
        // at least RELAY_BUFFER frames in, or the buffer has shrunk.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let sample = sent.load(std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let stalled_at = sent.load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(sample, stalled_at, "reader is still draining frames");
        assert!(
            stalled_at < total,
            "reader drained {total} frames with a stalled consumer"
        );
        assert!(
            stalled_at >= RELAY_BUFFER,
            "reader parked after only {stalled_at} frames (buffer is {RELAY_BUFFER})"
        );
        // Now drain: everything arrives, in order, with nothing lost.
        for i in 0..total {
            let e = client.next().await.unwrap().unwrap();
            assert_eq!(e.time_us as usize, i);
        }
        let mut server = sender.await.unwrap();
        server.send(Message::Ping(vec![])).await.unwrap();
        expect_pong(&mut server).await;
    }

    // A server-side Close ends the stream cleanly (None), not with an error.
    #[tokio::test]
    async fn server_close_ends_the_stream_cleanly() {
        let (client, mut server) = local_pair().await;
        futures::pin_mut!(client);
        server.send(Message::Close(None)).await.unwrap();
        let end = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
            .await
            .expect("stream did not end within 5s");
        assert!(end.is_none(), "expected clean end, got {end:?}");
    }

    // A message over MAX_MESSAGE_BYTES must surface as an error, not be
    // buffered: the relay bound is in messages, so this is the byte ceiling.
    #[tokio::test]
    async fn oversized_message_is_an_error() {
        let (client, mut server) = local_pair().await;
        futures::pin_mut!(client);
        // The client may drop the connection mid-write once the frame header
        // exceeds the cap, so the server-side send can fail (BrokenPipe);
        // the assertion is on what the client yields.
        let _ = server
            .send(Message::Text("x".repeat(MAX_MESSAGE_BYTES + 1)))
            .await;
        let next = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
            .await
            .expect("stream did not yield within 5s");
        assert!(
            matches!(next, Some(Err(Error::Tungstenite(_)))),
            "expected a tungstenite capacity error, got {next:?}"
        );
    }

    // The dial cap must trip before a hung dial could count as healthy.
    #[test]
    fn connect_timeout_is_under_healthy_after() {
        assert!(CONNECT_TIMEOUT < reconnect::Policy::default().healthy_after);
    }

    // A host that accepts TCP but never completes the handshake must fail
    // the dial promptly, well inside `healthy_after`, or failover never trips.
    #[tokio::test]
    async fn hung_handshake_times_out() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = url::Url::parse(&format!(
            "ws://{}/subscribe",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let hold = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
            drop(tcp);
        });
        let started = std::time::Instant::now();
        let result = connect(
            &url,
            ConnectOptions {
                connect_timeout: Some(std::time::Duration::from_millis(200)),
                ..Default::default()
            },
        )
        .await;
        hold.abort();
        assert!(
            matches!(result, Err(Error::ConnectTimeout(_))),
            "expected ConnectTimeout"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    // Dropping the stream must end the upstream socket, not leak it — even
    // when the relay task is parked in a socket read on a silent host. The
    // Ping/Pong round-trip first proves the task is running and parked in
    // the read (not still racing for its first permit) before the drop.
    #[tokio::test]
    async fn dropping_the_stream_closes_the_socket() {
        let (client, mut server) = local_pair().await;
        server.send(Message::Ping(vec![])).await.unwrap();
        expect_pong(&mut server).await;
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
                Some(Ok(event)) => {
                    // Leave a trail for the manual run (`--nocapture`).
                    println!("{endpoint}: first event time_us={}", event.time_us);
                    assert!(event.time_us > 0, "{endpoint}");
                }
                Some(Err(e)) => panic!("{endpoint}: {e}"),
                None => panic!("{endpoint}: stream ended"),
            }
        }
    }
}
