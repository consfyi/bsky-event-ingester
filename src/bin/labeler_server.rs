use futures::{SinkExt as _, StreamExt as _};

#[derive(serde::Deserialize)]
struct Config {
    labeler_bind: std::net::SocketAddr,
    postgres_url: String,
}

fn encode_message(seq: i64, raw: &[u8]) -> Result<Vec<u8>, anyhow::Error> {
    let mut writer = minicbor::Encoder::new(vec![]);

    // {"t": "#labels", "op": 1}
    writer
        .map(2)?
        //
        .str("t")?
        .str("#labels")?
        //
        .str("op")?
        .i64(1)?;

    // com.atproto.label.subscribeLabels#labels
    writer
        .map(2)?
        //
        .str("seq")?
        .i64(seq)?
        //
        .str("labels")?
        .array(1)?;
    writer.writer_mut().extend(raw);

    Ok(writer.into_writer())
}

async fn subscribe_labels(
    axum::extract::State(app_state): axum::extract::State<AppState>,
    ws: axum::extract::ws::WebSocketUpgrade,
    axum_extra::extract::Query(params): axum_extra::extract::Query<
        atrium_api::com::atproto::label::subscribe_labels::ParametersData,
    >,
) -> axum::response::Response {
    ws.on_upgrade(move |socket: axum::extract::ws::WebSocket| async move {
        log::info!("got websocket subscriber, cursor = {:?}", params.cursor);
        metrics::gauge!("num_subscriptions").increment(1);

        let (mut sink, mut stream) = socket.split();

        let mut notify_recv = app_state.notify_recv.clone();
        notify_recv.mark_changed();

        match async {
            let mut seq = {
                if let Some(cursor) = params.cursor {
                    cursor
                } else {
                    let mut db_conn = app_state.db_pool.acquire().await?;
                    sqlx::query!(
                        r#"
                        SELECT COALESCE((SELECT MAX(seq) FROM labels), 0) AS "seq!"
                        "#
                    )
                    .fetch_one(&mut *db_conn)
                    .await?
                    .seq
                }
            };

            loop {
                tokio::select! {
                    msg = stream.next() => {
                        let Some(msg) = msg else {
                            break;
                        };
                        let _ = msg?;
                    }
                    msg = notify_recv.changed() => {
                        let _ = msg?;
                        let mut db_conn = app_state.db_pool.acquire().await?;

                        let mut rows = sqlx::query!(
                            r#"
                            SELECT seq, payload
                            FROM labels
                            WHERE seq > $1
                            "#,
                            seq
                        )
                        .fetch(&mut *db_conn);

                        while let Some(row) = rows.next().await {
                            let row = row?;

                            sink.send(axum::extract::ws::Message::Binary(
                                encode_message(row.seq, &row.payload)?.into(),
                            ))
                            .await?;

                            seq = row.seq;
                        }
                    }
                };
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

        log::info!("websocket subscriber disconnected");
        metrics::gauge!("num_subscriptions").decrement(1);
    })
}

#[derive(Clone)]
struct AppState {
    db_pool: sqlx::PgPool,
    notify_recv: tokio::sync::watch::Receiver<()>,
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    metrics::describe_gauge!("num_subscriptions", "number of active subscriptions");

    env_logger::init();

    let config: Config = config::Config::builder()
        .add_source(config::File::with_name("config.toml"))
        .set_default("labeler_bind", "127.0.0.1:3001")?
        .build()?
        .try_deserialize()?;

    let (notify_send, notify_recv) = tokio::sync::watch::channel(());

    let db_pool = sqlx::PgPool::connect(&config.postgres_url).await?;

    let mut pg_listener = sqlx::postgres::PgListener::connect_with(
        &sqlx::pool::PoolOptions::<sqlx::Postgres>::new()
            .max_connections(1)
            .max_lifetime(None)
            .idle_timeout(None)
            .connect_with((*db_pool.connect_options()).clone())
            .await?,
    )
    .await?;
    pg_listener.ignore_pool_close_event(true);
    pg_listener.listen("labels").await?;

    let listener = tokio::net::TcpListener::bind(&config.labeler_bind).await?;

    let metrics_handle =
        metrics_exporter_prometheus::PrometheusBuilder::new().install_recorder()?;

    let app = axum::Router::new()
        .nest(
            "/xrpc",
            axum::Router::new().route(
                &format!(
                    "/{}",
                    atrium_api::com::atproto::label::subscribe_labels::NSID
                ),
                axum::routing::get(subscribe_labels),
            ),
        )
        .route(
            "/metrics",
            axum::routing::get(|| async move { metrics_handle.render() }),
        )
        .route("/", axum::routing::get(|| async { ">:3" }))
        .with_state(AppState {
            db_pool: db_pool.clone(),
            notify_recv,
        });

    tokio::try_join!(
        async {
            loop {
                pg_listener.recv().await?;
                notify_send.send(())?;
            }

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
