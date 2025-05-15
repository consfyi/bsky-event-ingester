# furcons-bsky-labeler

This is the code behind https://furcons.bsky.social/.

## First-time setup

### 1. Create config file

Create a config file named `config.toml` with at least these lines.

```toml
bsky_username = "your.bsky.username"
bsky_password = "your-app-password"
```

### 2. Generate keypair

A keypair is required for signing labels.

```sh
cargo run --bin generate_keypair
```

This will generate a signing keypair with the filename `signing.key`.

### 3. Update PLC

Add the following temporary lines to your `config.toml`:

```toml
bsky_plc_password = "YOUR ACTUAL PASSWORD"
pds = "https://mushroom.us-west.host.bsky.network"  # Change this to the PDS your account is hosted on.
labeler_endpoint = "https://endpoint.to.your.labeler"
```

Then perform the PLC update operation. Note this will send you an email with a PLC operation token that you will need to interactively enter.

```sh
cargo run --bin update_plc
```

## Running

Run `furcons-bsky-labeler`. This will start the labeler server, as well as start ingestion of events and sync the labeler record with the ICS file from furrycons.com.
