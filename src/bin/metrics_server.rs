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

#[derive(Copy, Clone)]
#[allow(unused)]
enum MetricType {
    Gauge,
    Counter,
    Histogram,
    Summary,
}

impl MetricType {
    const fn as_str(&self) -> &str {
        match self {
            MetricType::Gauge => "gauge",
            MetricType::Counter => "counter",
            MetricType::Histogram => "histogram",
            MetricType::Summary => "summary",
        }
    }
}

struct Metric {
    name: &'static str,
    r#type: MetricType,
    fetch: for<'a, 'b> fn(
        &'b mut sqlx::Transaction<'a, sqlx::Postgres>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<f64, anyhow::Error>> + Send + 'b>,
    >,
}

impl Metric {
    fn format_output(&self, value: f64) -> String {
        format!(
            "# TYPE {} {}\n{} {}\n",
            self.name,
            self.r#type.as_str(),
            self.name,
            value
        )
    }
}

const METRICS: &[Metric] = &[
    Metric {
        name: "label_seq",
        r#type: MetricType::Gauge,
        fetch: |tx| {
            Box::pin(async move {
                let row = sqlx::query!(
                    r#"
                    SELECT COALESCE((SELECT MAX(seq) FROM labels), 0) AS "seq!"
                    "#
                )
                .fetch_one(&mut **tx)
                .await?;
                Ok(row.seq as f64)
            })
        },
    },
    Metric {
        name: "jetstream_cursor",
        r#type: MetricType::Gauge,
        fetch: |tx| {
            Box::pin(async move {
                let row = sqlx::query!(
                    r#"
                    SELECT COALESCE((SELECT cursor FROM jetstream_cursor), 0) AS "cursor!"
                    "#
                )
                .fetch_one(&mut **tx)
                .await?;
                Ok(row.cursor as f64)
            })
        },
    },
    Metric {
        name: "current_timestamp",
        r#type: MetricType::Gauge,
        fetch: |tx| {
            Box::pin(async move {
                let row = sqlx::query!(
                    r#"
                    SELECT CURRENT_TIMESTAMP AS "current_timestamp!"
                    "#
                )
                .fetch_one(&mut **tx)
                .await?;
                Ok(row.current_timestamp.timestamp_micros() as f64)
            })
        },
    },
];

async fn metrics(db_pool: sqlx::PgPool) -> Result<axum::response::Response, AppError> {
    let mut conn = db_pool.acquire().await?;
    let mut tx = conn.begin().await?;

    let mut output = String::new();

    for metric in METRICS {
        let value = (metric.fetch)(&mut tx).await?;
        output.push_str(&metric.format_output(value));
        output.push('\n');
    }

    Ok(axum::http::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "text/plain")
        .body(axum::body::Body::from(output))
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
