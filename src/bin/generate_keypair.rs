use atrium_crypto::keypair::{Did as _, Export as _};

fn main() -> Result<(), anyhow::Error> {
    let keypair = atrium_crypto::keypair::Secp256k1Keypair::create(&mut rand::thread_rng());
    std::fs::write("signing.key", keypair.export())?;
    println!("{}", keypair.did());
    Ok(())
}
