#![allow(dead_code)]

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Commit(CommitEvent),
    Identity(IdentityEvent),
    Account(AccountEvent),
}

#[derive(serde::Deserialize, Debug)]
pub struct CommitEvent {
    pub did: atrium_api::types::string::Did,
    pub time_us: u64,
    pub commit: Commit,
}

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum Commit {
    Create {
        rev: String,
        rkey: String,
        collection: atrium_api::types::string::Nsid,
        cid: atrium_api::types::string::Cid,
        record: atrium_api::record::KnownRecord,
    },
    Update {
        rev: String,
        rkey: String,
        collection: atrium_api::types::string::Nsid,
        record: atrium_api::record::KnownRecord,
    },
    Delete {
        rev: String,
        rkey: String,
        collection: atrium_api::types::string::Nsid,
    },
}

#[derive(serde::Deserialize, Debug)]
pub struct IdentityEvent {
    pub did: atrium_api::types::string::Did,
    pub time_us: u64,
    pub handle: Option<atrium_api::types::string::Handle>,
    pub seq: u64,
    pub time: chrono::DateTime<chrono::Utc>,
}

#[derive(serde::Deserialize, Debug)]
pub struct AccountEvent {
    pub active: bool,
    pub did: atrium_api::types::string::Did,
    pub time_us: u64,
    pub seq: u64,
    pub time: chrono::DateTime<chrono::Utc>,
    pub status: Option<AccountStatus>,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum AccountStatus {
    Deactivated,
    Deleted,
    Suspended,
    TakenDown,
}
