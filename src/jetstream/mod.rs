use futures::{SinkExt as _, StreamExt as _};

pub mod event;

const ZSTD_DICTIONARY: std::sync::LazyLock<zstd::dict::DecoderDictionary<'static>> =
    std::sync::LazyLock::new(|| {
        zstd::dict::DecoderDictionary::copy(include_bytes!("./zstd_dictionary"))
    });

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOptions {
    pub wanted_collections: Vec<atrium_api::types::string::Nsid>,
    pub wanted_dids: Vec<atrium_api::types::string::Did>,
    pub max_message_size_bytes: u32,
    pub cursor: Option<i64>,
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

pub async fn connect(
    endpoint: &url::Url,
    options: ConnectOptions,
) -> Result<impl futures::Stream<Item = Result<event::Event, Error>>, Error> {
    let mut url = endpoint.clone();
    url.set_query(Some(&serde_html_form::to_string(&options)?));
    url.query_pairs_mut().append_pair("compress", "true");

    let (mut ws, _) = tokio_tungstenite::connect_async(url).await?;

    Ok(async_stream::try_stream! {
        while let Some(message) = ws.next().await {
            match message? {
                tokio_tungstenite::tungstenite::Message::Binary(body) => {
                    yield serde_json::from_reader(zstd::stream::Decoder::with_prepared_dictionary(
                        std::io::Cursor::new(body),
                        &ZSTD_DICTIONARY,
                    )?)?;
                }
                tokio_tungstenite::tungstenite::Message::Ping(body) => {
                    ws.send(tokio_tungstenite::tungstenite::Message::Pong(body))
                        .await?;
                }
                _ => {}
            }
        }
    })
}
