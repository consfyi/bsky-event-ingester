#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("already signed")]
    AlreadySigned,

    #[error("atrium_crypto: {0}")]
    AtriumCrypto(#[from] atrium_crypto::Error),

    #[error("serde_ipld_dagcbor: {0}")]
    SerdeIpldDagcbor(#[from] serde_ipld_dagcbor::EncodeError<std::collections::TryReserveError>),

    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
}

pub async fn emit(
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    tx: &mut sqlx::PgTransaction<'_>,
    mut label: atrium_api::com::atproto::label::defs::Label,
    like_rkey: &str,
) -> Result<i64, Error> {
    if label.sig.is_some() {
        return Err(Error::AlreadySigned);
    }

    label.sig = Some(keypair.sign(&serde_ipld_dagcbor::to_vec(&label)?)?);

    let seq = {
        sqlx::query!(
            r#"
            INSERT INTO labels (val, uri, neg, payload, like_rkey)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING seq
            "#,
            label.val,
            label.uri,
            label.neg.unwrap_or(false),
            serde_ipld_dagcbor::to_vec(&label)?,
            like_rkey,
        )
        .fetch_one(&mut **tx)
        .await?
        .seq
    };

    sqlx::query!("NOTIFY labels").execute(&mut **tx).await?;

    Ok(seq)
}
