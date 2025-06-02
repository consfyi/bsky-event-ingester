use sqlx::Acquire as _;

#[derive(serde::Deserialize)]
struct Config {
    metrics_bind: std::net::SocketAddr,
    postgres_url: String,
}

struct AppError(#[allow(unused)] anyhow::Error);

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

impl axum::response::IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

async fn metrics(db_pool: sqlx::PgPool) -> Result<axum::response::Response, AppError> {
    let mut conn = db_pool.acquire().await?;
    let mut tx = conn.begin().await?;

    let label_seq = sqlx::query!(
        r#"
        SELECT COALESCE((SELECT MAX(seq) FROM labels), 0) AS "seq!"
        "#
    )
    .fetch_one(&mut *tx)
    .await?
    .seq;

    let jetstream_cursor = sqlx::query!(
        r#"
        SELECT COALESCE((SELECT cursor FROM jetstream_cursor), 0) AS "cursor!"
        "#
    )
    .fetch_one(&mut *tx)
    .await?
    .cursor;

    let current_timestamp = sqlx::query!(
        r#"
        SELECT CURRENT_TIMESTAMP AS "current_timestamp!"
        "#
    )
    .fetch_one(&mut *tx)
    .await?
    .current_timestamp
    .timestamp_micros();

    Ok(axum::http::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "text/plain")
        .body(axum::body::Body::from(format!(
            "\
# TYPE label_seq gauge
label_seq {label_seq}

# TYPE jetstream_cursor gauge
jetstream_cursor {jetstream_cursor}

# TYPE current_timestamp gauge
current_timestamp {current_timestamp}
"
        )))
        .unwrap())
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    env_logger::init();

    let config: Config = config::Config::builder()
        .add_source(config::File::with_name("config.toml"))
        .set_default("metrics_bind", "127.0.0.1:3002")?
        .build()?
        .try_deserialize()?;

    let db_pool = sqlx::PgPool::connect(&config.postgres_url).await?;

    let app = axum::Router::new().route("/metrics", axum::routing::get(move || metrics(db_pool)));

    let listener = tokio::net::TcpListener::bind(&config.metrics_bind).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
