use futures::{SinkExt as _, StreamExt as _};

pub mod event;
pub mod reconnect;

/// Public Jetstream hosts, in dial order. All speak the v1 wire at
/// `/subscribe` with portable unix-microsecond cursors, so any of them can
/// take over from any other. Regions alternate so a regional problem is
/// skipped after one failover.
///
/// The legacy `jetstream{1,2}` hosts come first because they honour a
/// timestamp cursor exactly. The v2 hosts (launched 2026-08-14) resolve a
/// timestamp cursor only against sealed log segments and clamp anything
/// newer to the start of the active segment (`translateTimeUSToSeq` in
/// bluesky-social/jetstream), so a fresh cursor replays 0-60 minutes of
/// firehose on every connect; on 2026-08-17 they also reset our connection
/// every ~100s. They stay in the list as last-resort fallbacks only.
pub const DEFAULT_ENDPOINTS: &[&str] = &[
    "wss://jetstream1.us-east.bsky.network/subscribe",
    "wss://jetstream1.us-west.bsky.network/subscribe",
    "wss://jetstream2.us-east.bsky.network/subscribe",
    "wss://jetstream2.us-west.bsky.network/subscribe",
    "wss://jetstream.us-east.bsky.network/subscribe",
    "wss://jetstream.us-west.bsky.network/subscribe",
];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOptions {
    pub wanted_collections: Vec<atrium_api::types::string::Nsid>,
    pub wanted_dids: Vec<atrium_api::types::string::Did>,
    pub max_message_size_bytes: u32,
    pub cursor: Option<i64>,
    pub compress: bool,
    /// Cap on the dial (TCP + TLS + WebSocket handshake); defaults to
    /// `CONNECT_TIMEOUT`. A blackholed host otherwise hangs in the kernel
    /// SYN retry (~127s), which is longer than the reconnect policy's
    /// `healthy_after` — every hung dial would count as a healthy connection
    /// and failover would never trip. Not a query parameter, hence `skip`.
    #[serde(skip)]
    pub connect_timeout: std::time::Duration,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            wanted_collections: Vec::new(),
            wanted_dids: Vec::new(),
            // Ask the server to drop oversized events before the wire. The
            // server checks its cap on the uncompressed body and silently
            // drops anything over it (no wire signal); the client cap below
            // applies to the (compressed) frame, so the two are not the same
            // cap — the client's is the hard memory ceiling.
            max_message_size_bytes: MAX_MESSAGE_BYTES as u32,
            cursor: None,
            compress: false,
            connect_timeout: CONNECT_TIMEOUT,
        }
    }
}

/// Default for `ConnectOptions::connect_timeout`; must stay well under
/// `reconnect::Policy::healthy_after` (300s).
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Largest WebSocket message (and frame) the client accepts; a Jetstream
/// event is ~1 KB. Without this, tungstenite's default is 64 MiB per
/// message, so the relay bound below would be 32768 × 64 MiB.
pub const MAX_MESSAGE_BYTES: usize = 1 << 20;

/// Largest decompressed body the client will read out of a compressed
/// (Binary) frame; see the decode branch in `connect`. 8× the frame cap is
/// far beyond any real event's zstd ratio (~3-4×).
pub const MAX_DECODED_BYTES: u64 = 8 << 20;

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

/// When the socket behind a `connect()` stream ended, measured by the relay
/// task itself. Up to `RELAY_BUFFER` messages can sit between the socket and
/// the consumer, so the consumer sees the end of the stream tens of seconds
/// after the socket actually closed; a reconnect policy timing the consumer's
/// view would count a host that resets every 45s as healthy.
#[derive(Clone, Debug, Default)]
pub struct SocketLifetime(std::sync::Arc<std::sync::OnceLock<std::time::Duration>>);

impl SocketLifetime {
    /// How long the socket was open after the handshake; `None` while it
    /// still is.
    pub fn ended_after(&self) -> Option<std::time::Duration> {
        self.0.get().copied()
    }
}

static ZSTD_DICTIONARY: std::sync::LazyLock<zstd::dict::DecoderDictionary<'static>> =
    std::sync::LazyLock::new(|| {
        zstd::dict::DecoderDictionary::copy(include_bytes!("./zstd_dictionary"))
    });

pub async fn connect(
    endpoint: &url::Url,
    options: ConnectOptions,
) -> Result<
    (
        impl futures::Stream<Item = Result<event::Event, Error>>,
        SocketLifetime,
    ),
    Error,
> {
    let mut url = endpoint.clone();
    url.set_query(Some(&serde_html_form::to_string(&options)?));

    let connect_timeout = options.connect_timeout;
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
    let connected_at = std::time::Instant::now();
    let lifetime = SocketLifetime::default();

    // Pings are answered by a dedicated task rather than inline: the v2
    // Jetstream hosts hard-close a connection whose Pong is more than 5s
    // late, and inline handling only ran while the consumer was polling —
    // a slow DB write or a spawned worker could sit longer than that.
    //
    // The task reserves a relay slot *before* reading the next message so
    // that a stalled consumer parks the reader (see RELAY_BUFFER). The read
    // races `tx.closed()` (the reserve fails on its own once the receiver
    // is gone): a consumer that drops the stream while the socket is idle
    // must still end the socket, or the task and socket leak until the next
    // inbound frame — never, on a silent host.
    let (mut sink, mut source) = ws.split();
    let (tx, rx) = tokio::sync::mpsc::channel(RELAY_BUFFER);
    tokio::spawn({
        let lifetime = lifetime.clone();
        async move {
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
            // The socket is done; every exit path records this (idempotent).
            let record = || {
                let _ = lifetime.0.set(connected_at.elapsed());
            };
            loop {
                // A parked reserve is the consumer falling behind, and the
                // server will soon disconnect us for not reading. Say so once
                // per episode, so that disconnect is not misread as the host's
                // fault in the logs.
                const BEHIND_WARN_AFTER: std::time::Duration = std::time::Duration::from_secs(5);
                let permit = match tokio::time::timeout(BEHIND_WARN_AFTER, tx.reserve()).await {
                    Ok(reserved) => reserved,
                    Err(_) => {
                        log::warn!(
                            "jetstream relay: consumer has been behind for >{BEHIND_WARN_AFTER:?}; \
                             a disconnect now is ours, not the host's"
                        );
                        tx.reserve().await
                    }
                };
                let permit = match permit {
                    Ok(p) => p,
                    Err(_) => {
                        close_best_effort(&mut sink).await;
                        break;
                    }
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
                                record();
                                permit.send(Err(e.into()));
                                break;
                            }
                            Err(_) => {
                                record();
                                permit.send(Err(Error::WriteTimeout(PONG_TIMEOUT)));
                                break;
                            }
                        }
                    }
                    Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
                    other => {
                        // A read error is terminal: record the lifetime before
                        // the consumer can see the error, so it never falls back
                        // to its own (drain-inflated) clock.
                        if other.is_err() {
                            record();
                        }
                        permit.send(other.map_err(Error::from));
                    }
                }
            }
            // Every exit path lands here: the socket is done, whatever the
            // consumer has yet to drain from the relay. (Idempotent for the
            // paths that already recorded it.)
            record();
        }
    });

    let stream = async_stream::try_stream! {
        let mut rx = rx;
        while let Some(message) = rx.recv().await {
            match message? {
                tokio_tungstenite::tungstenite::Message::Binary(body) => {
                    // Compressed. MAX_MESSAGE_BYTES bounds the frame, not its
                    // expansion: a compression bomb inside a 1 MiB frame would
                    // otherwise force an unbounded transient allocation. The
                    // `take` truncates the read instead, which surfaces as a
                    // serde_json error → reconnect.
                    let mut body = &body[..];
                    let mut decoder = zstd::stream::Decoder::with_prepared_dictionary(
                        &mut body,
                        &ZSTD_DICTIONARY,
                    )?;
                    // The frame header can otherwise demand up to libzstd's
                    // 128 MiB default window before `take` bounds a byte;
                    // 2^23 = 8 MiB matches MAX_DECODED_BYTES.
                    decoder.window_log_max(23)?;
                    yield serde_json::from_reader(std::io::Read::take(decoder, MAX_DECODED_BYTES))?;
                }
                tokio_tungstenite::tungstenite::Message::Text(body) => {
                    // Uncompressed.
                    yield serde_json::from_str(&body)?;
                }
                _ => {}
            }
        }
    };
    Ok((stream, lifetime))
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
        let (client, _lifetime, server) = local_pair_with_lifetime().await;
        (client, server)
    }

    async fn local_pair_with_lifetime() -> (
        impl futures::Stream<Item = Result<event::Event, Error>>,
        SocketLifetime,
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
        let (client, lifetime) = connect(&url, ConnectOptions::default()).await.unwrap();
        (client, lifetime, accept.await.unwrap())
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

    // Once the buffer is full the reader must stop reading (that is the
    // memory bound), and nothing may be lost or reordered: after the
    // consumer drains, every frame arrives in order and a Ping is answered
    // again. Frames are real events so the consumer side can count them.
    // A Ping behind a backlog the consumer has not drained but that still
    // fits the buffer must be answered without a drain: a merely slow
    // consumer must not park the reader.
    #[tokio::test]
    async fn full_buffer_parks_the_reader_without_losing_frames() {
        let (client, mut server) = local_pair().await;
        futures::pin_mut!(client);
        // The overshoot past RELAY_BUFFER must dwarf what the kernel socket
        // buffers (up to ~8MB on macOS loopback) and tungstenite's read
        // buffer can absorb, or a reader that never parks would pass.
        let total = 3 * RELAY_BUFFER;
        let backlog = 2500;
        let pad = "x".repeat(512);
        let event = move |i: usize| {
            format!(
                "{{\"did\":\"did:plc:x\",\"time_us\":{i},\"kind\":\"identity\",\
                 \"identity\":{{\"did\":\"did:plc:x\",\"seq\":1,\"time\":\"2026-01-01T00:00:00Z\"}},\
                 \"pad\":\"{pad}\"}}"
            )
        };
        for i in 0..backlog {
            server.send(Message::Text(event(i))).await.unwrap();
        }
        server.send(Message::Ping(vec![])).await.unwrap();
        expect_pong(&mut server).await;
        // The server side sends from its own task so a parked reader stalls
        // it (observable via `sent`) without stalling the test.
        let sent = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sender = tokio::spawn({
            let sent = sent.clone();
            async move {
                for i in backlog..total {
                    server.send(Message::Text(event(i))).await.unwrap();
                    sent.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                server
            }
        });
        // With nobody polling, the sender must stall short of `total`
        // (buffer + the one frame the reader holds + socket buffers) and
        // then all but stop — two samples 3s apart may differ only by a
        // small trickle (see below), or the reader is merely slow, not
        // parked (the 6s park also drives the >5s backpressure warn +
        // re-reserve path). It must also have got at least RELAY_BUFFER
        // frames in, or the buffer has shrunk.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let sample = sent.load(std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let stalled_at = sent.load(std::sync::atomic::Ordering::SeqCst);
        // Not exact equality: with the reader parked, TCP receive-buffer
        // autotuning still lets a few hundred more frames trickle into the
        // kernel over 3s (seen on macOS); a reader that is actually draining
        // moves tens of thousands. Slack of RELAY_BUFFER/16 = 2048.
        assert!(
            stalled_at - sample < RELAY_BUFFER / 16,
            "reader is still draining frames ({sample} -> {stalled_at})"
        );
        assert!(
            backlog + stalled_at < total,
            "reader drained {total} frames with a stalled consumer"
        );
        assert!(
            backlog + stalled_at >= RELAY_BUFFER,
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

    /// A Binary frame as the server would send it: zstd with the shared
    /// dictionary.
    fn compressed(json: &str) -> Message {
        let body = zstd::bulk::Compressor::with_dictionary(3, include_bytes!("./zstd_dictionary"))
            .unwrap()
            .compress(json.as_bytes())
            .unwrap();
        Message::Binary(body)
    }

    fn identity_event(pad: &str) -> String {
        format!(
            "{{\"did\":\"did:plc:x\",\"time_us\":7,\"kind\":\"identity\",\
             \"identity\":{{\"did\":\"did:plc:x\",\"seq\":1,\"time\":\"2026-01-01T00:00:00Z\"}},\
             \"pad\":\"{pad}\"}}"
        )
    }

    // The compressed path decodes a real event (otherwise only the ignored
    // live test covers it).
    #[tokio::test]
    async fn compressed_event_decodes() {
        let (client, mut server) = local_pair().await;
        futures::pin_mut!(client);
        server.send(compressed(&identity_event("x"))).await.unwrap();
        let e = client.next().await.unwrap().unwrap();
        assert_eq!(e.time_us, 7);
    }

    // A frame under MAX_MESSAGE_BYTES that inflates past MAX_DECODED_BYTES
    // must be an error, not an allocation: the decode is truncated and the
    // JSON parse fails.
    #[tokio::test]
    async fn compression_bomb_is_an_error() {
        let (client, mut server) = local_pair().await;
        futures::pin_mut!(client);
        let bomb = compressed(&identity_event(&"x".repeat(MAX_DECODED_BYTES as usize + 1)));
        assert!(bomb.len() < MAX_MESSAGE_BYTES, "frame is {}", bomb.len());
        server.send(bomb).await.unwrap();
        let next = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
            .await
            .expect("stream did not yield within 5s");
        assert!(
            matches!(next, Some(Err(Error::SerdeJson(_)))),
            "expected a truncated-JSON error, got {next:?}"
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
                connect_timeout: std::time::Duration::from_millis(200),
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

    // The lifetime must be the socket's, not the consumer's: with a backlog
    // in the relay, the consumer only learns of the close after draining it
    // — in production long enough to make a host that resets every 45s look
    // healthy. Here the socket ends behind a half-full, unpolled relay (half,
    // so the reader is parked in the read, not in the reserve — a reader
    // parked in the reserve can only see the close one consumer step later);
    // the recorded lifetime must be short and must not grow as the consumer
    // drains.
    #[tokio::test]
    async fn lifetime_is_the_sockets_not_the_consumers() {
        let (client, lifetime, mut server) = local_pair_with_lifetime().await;
        futures::pin_mut!(client);
        assert_eq!(lifetime.ended_after(), None, "socket is still open");
        let total = RELAY_BUFFER / 2;
        for i in 0..total {
            server
                .send(Message::Text(format!(
                    "{{\"did\":\"did:plc:x\",\"time_us\":{i},\"kind\":\"identity\",\
                     \"identity\":{{\"did\":\"did:plc:x\",\"seq\":1,\"time\":\"2026-01-01T00:00:00Z\"}}}}"
                )))
                .await
                .unwrap();
        }
        assert_eq!(lifetime.ended_after(), None, "socket is still open");
        server.close(None).await.unwrap();
        drop(server);
        // No polling of `client` here: the relay task alone must notice.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let ended = lifetime
            .ended_after()
            .expect("socket end not recorded while the relay is full");
        assert!(ended < std::time::Duration::from_millis(1500), "{ended:?}");
        // Draining afterwards must not stretch the recorded lifetime.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let mut n = 0;
        while let Some(e) = client.next().await {
            e.unwrap();
            n += 1;
        }
        assert_eq!(n, total);
        assert_eq!(lifetime.ended_after(), Some(ended));
    }

    // connect_timeout is client-side only and must not leak into the query.
    #[test]
    fn default_query_has_message_cap_and_no_connect_timeout() {
        let q = serde_html_form::to_string(ConnectOptions::default()).unwrap();
        assert!(q.contains("maxMessageSizeBytes=1048576"), "{q}");
        assert!(
            !q.contains("connectTimeout") && !q.contains("connect_timeout"),
            "{q}"
        );
    }

    // Talks to the public network; run on demand with `cargo test -- --ignored`.
    // Proves each default host still speaks the v1 wire at /subscribe and
    // that the split reader/ponger delivers events.
    #[tokio::test]
    #[ignore]
    async fn live_default_endpoints_deliver_events() {
        for endpoint in DEFAULT_ENDPOINTS {
            let (stream, _lifetime) = connect(
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
