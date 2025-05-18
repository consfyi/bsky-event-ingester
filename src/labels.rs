pub async fn emit(
    keypair: &atrium_crypto::keypair::Secp256k1Keypair,
    tx: &mut sqlx::PgTransaction<'_>,
    mut label: atrium_api::com::atproto::label::defs::Label,
    like_rkey: &str,
) -> Result<i64, anyhow::Error> {
    assert!(label.sig.is_none());

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
