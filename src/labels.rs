#[derive(thiserror::Error, Debug)]
pub enum SignError {
    #[error("already signed")]
    AlreadySigned,

    #[error("atrium_crypto: {0}")]
    AtriumCrypto(#[from] atrium_crypto::Error),

    #[error("serde_ipld_dagcbor: {0}")]
    SerdeIpldDagcbor(#[from] serde_ipld_dagcbor::EncodeError<std::collections::TryReserveError>),
}

pub fn sign_to_payload(
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    label: &atrium_api::com::atproto::label::defs::Label,
) -> Result<Vec<u8>, SignError> {
    if label.sig.is_some() {
        return Err(SignError::AlreadySigned);
    }
    let mut label = label.clone();
    label.sig = Some(keypair.sign(&serde_ipld_dagcbor::to_vec(&label)?)?);
    Ok(serde_ipld_dagcbor::to_vec(&label)?)
}

#[derive(thiserror::Error, Debug)]
pub enum EmitError {
    #[error("sign: {0}")]
    Sign(#[from] SignError),

    #[error("sign: {0}")]
    Sqlx(#[from] sqlx::Error),
}

pub async fn emit(
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    tx: &mut sqlx::PgTransaction<'_>,
    label: &atrium_api::com::atproto::label::defs::Label,
    like_rkey: &str,
) -> Result<i64, EmitError> {
    let seq = sqlx::query_scalar!(
        r#"
        INSERT INTO labels (val, uri, neg, payload, like_rkey)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING seq
        "#,
        label.val,
        label.uri,
        label.neg.unwrap_or(false),
        sign_to_payload(keypair, label)?,
        like_rkey,
    )
    .fetch_one(&mut **tx)
    .await?;

    sqlx::query!("NOTIFY labels").execute(&mut **tx).await?;

    Ok(seq)
}
