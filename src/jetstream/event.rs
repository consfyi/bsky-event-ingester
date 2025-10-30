#![allow(dead_code)]

#[derive(serde::Deserialize, Debug)]
pub struct Event {
    pub did: atrium_api::types::string::Did,
    pub time_us: u64,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventKind {
    Commit { commit: Commit },
    Identity { identity: Identity },
    Account { account: Account },
}

#[derive(serde::Deserialize, Debug)]
pub struct Commit {
    pub rev: String,
    pub collection: atrium_api::types::string::Nsid,
    pub rkey: String,
    #[serde(flatten)]
    pub operation: CommitOperation,
}

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum CommitOperation {
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
    pub handle: Option<String>,
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
