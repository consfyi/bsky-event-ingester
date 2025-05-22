# furcons-bsky-labeler

This is the code behind [@cons.furryli.st](https://bsky.app/profile/cons.furryli.st).

## First-time setup

### 1. Create config file

Create a config file named `config.toml` with at least these lines.

```toml
bsky_username = "your.bsky.username"
bsky_password = "your-app-password"
postgres_url = "postgres:///fbl"
```

### 2. Initialize database

Use the provided schema to create the database.

```sh
psql -f schema.sql fbl
```

### 3. Generate keypair

A keypair is required for signing labels.

```sh
cargo run --bin generate_keypair
```

This will generate a signing keypair with the filename `signing.key`.

### 4. Update PLC

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

There are two components:

- **event_ingester:** This polls the ICS file from furrycons.com and updates the labeler service, as well as listens to Jetstream to write new labels to Postgres.
- **labeler_server:** This implements `com.atproto.label.subscribeLabels`. It reads new labels from Postgres and emits them to subscribers. This is a generic service that can be used to emit labels for any labeler that follows the schema.

Make sure you run both of them!

## Design

furcons-bsky-labeler consists of two parts: the labeler itself and the UI.

### Labeler

The labeler does three things:
- Retrieves calendar data from furrycons.com and materializes the labeler service record.
- Reads events from Jetstream (likes on posts) and labels users.
- Provides a `com.atproto.label.subscribeLabels` endpoint for AppViews to subscribe to.

We only store the log of labels in the database, as they must be able to be replayed. Everything else is stored in Bluesky.

### UI

The UI is an SPA that doesn't need a dedicated backend – it just reads all its data from Bluesky.
