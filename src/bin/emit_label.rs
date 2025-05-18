use furcons_bsky_labeler::*;
use sqlx::Connection as _;

#[derive(serde::Deserialize)]
struct Config {
    keypair_path: String,
    postgres_url: String,
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    env_logger::init();

    let [rkey] = &std::env::args().skip(1).collect::<Vec<_>>()[..] else {
        return Err(anyhow::anyhow!("not enough arguments"));
    };
    let rkey = atrium_api::types::string::RecordKey::new(rkey.to_string()).unwrap();

    let label = serde_json::from_reader(std::io::stdin())?;

    let config: Config = config::Config::builder()
        .add_source(config::File::with_name("config.toml"))
        .set_default("keypair_path", "signing.key")?
        .build()?
        .try_deserialize()?;

    let keypair =
        atrium_crypto::keypair::Secp256k1Keypair::import(&std::fs::read(&config.keypair_path)?)?;

    let mut db_conn = sqlx::PgConnection::connect(&config.postgres_url).await?;

    let mut tx = db_conn.begin().await?;
    let seq = labels::emit(&keypair, &mut tx, label, &rkey).await?;
    tx.commit().await?;

    println!("{seq}");

    Ok(())
}
