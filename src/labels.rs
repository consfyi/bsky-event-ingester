use sea_query_binder::SqlxBinder as _;
use sqlx::Row as _;

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

pub struct Emitter<'a, 'b> {
    tx: sqlx::PgTransaction<'a>,
    keypair: &'b atrium_crypto::keypair::Secp256k1Keypair,
}

impl<'a, 'b> Emitter<'a, 'b> {
    pub async fn new(
        conn: impl sqlx::Acquire<'a, Database = sqlx::Postgres>,
        keypair: &'b atrium_crypto::keypair::Secp256k1Keypair,
    ) -> Result<Self, sqlx::Error> {
        Ok(Self {
            tx: conn.begin().await?,
            keypair,
        })
    }

    pub async fn emit(
        &mut self,
        label: &atrium_api::com::atproto::label::defs::Label,
        extra_cols: impl IntoIterator<Item = (&'static str, sea_query::SimpleExpr)>,
    ) -> Result<i64, EmitError> {
        let mut cols = vec!["val", "uri", "neg", "payload"];
        let mut vals = vec![
            (&label.val).into(),
            (&label.uri).into(),
            label.neg.unwrap_or(false).into(),
            sign_to_payload(&self.keypair, label)?.into(),
        ];

        for (col, val) in extra_cols {
            cols.push(col);
            vals.push(val);
        }

        let (sql, values) = sea_query::Query::insert()
            .columns(cols)
            .values_panic(vals)
            .returning(sea_query::Query::returning().column("seq"))
            .build_sqlx(sea_query::PostgresQueryBuilder);

        let seq = sqlx::query_with(&sql, values)
            .fetch_one(&mut *self.tx)
            .await?
            .try_get::<i64, usize>(0)?;

        Ok(seq)
    }

    pub async fn commit(mut self) -> Result<(), sqlx::Error> {
        sqlx::query!("NOTIFY labels").execute(&mut *self.tx).await?;
        self.tx.commit().await?;
        Ok(())
    }
}
