#![allow(dead_code)]

#[derive(serde::Deserialize, Debug)]
pub struct Event {
    pub did: atrium_api::types::string::Did,
    pub time_us: u64,
    #[serde(flatten)]
    pub body: EventBody,
}

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventBody {
    Commit(CommitEvent),
    Identity(IdentityEvent),
    Account(AccountEvent),
}

#[derive(serde::Deserialize, Debug)]
pub struct CommitEvent {
    pub commit: Commit,
}

#[derive(serde::Deserialize, Debug)]
pub struct IdentityEvent {
    pub identity: Identity,
}

#[derive(serde::Deserialize, Debug)]
pub struct AccountEvent {
    pub account: Account,
}

#[derive(serde::Deserialize, Debug)]
pub struct Commit {
    pub rev: String,
    pub collection: atrium_api::types::string::Nsid,
    pub rkey: String,
    #[serde(flatten)]
    pub body: CommitBody,
}

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum CommitBody {
    Create {
        record: atrium_api::record::KnownRecord,
        cid: atrium_api::types::string::Cid,
    },
    Update {
        record: atrium_api::record::KnownRecord,
        cid: atrium_api::types::string::Cid,
    },
    Delete {},
}

#[derive(serde::Deserialize, Debug)]
pub struct Identity {
    pub did: atrium_api::types::string::Did,
    pub handle: Option<atrium_api::types::string::Handle>,
    pub seq: u64,
    pub time: chrono::DateTime<chrono::Utc>,
}

#[derive(serde::Deserialize, Debug)]
pub struct Account {
    pub active: bool,
    pub did: atrium_api::types::string::Did,
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
