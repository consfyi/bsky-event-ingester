//! Keeps the labeler account's Bluesky session alive across failed token refreshes.
//!
//! atrium's session manager refreshes the access token only when a request
//! comes back `ExpiredToken`. If that refresh fails for any reason, it clears
//! the session store and drops the error, so every later request goes out
//! without auth (401 `AuthMissing`) until the process restarts. `with_session`
//! logs in again whenever it finds the store empty.

use atrium_api::agent::atp_agent::{store::MemorySessionStore, AtpAgent};
use atrium_api::xrpc::XrpcClient;

pub type BskyAgent<T = atrium_xrpc_client::reqwest::ReqwestClient> =
    AtpAgent<MemorySessionStore, T>;

async fn login<T>(agent: &BskyAgent<T>, identifier: &str, password: &str) -> anyhow::Result<()>
where
    T: XrpcClient + Send + Sync,
{
    agent
        .login(identifier, password)
        .await
        .map_err(|e| anyhow::anyhow!("Bluesky login failed: {e}"))?;
    Ok(())
}

/// Runs `op` with a live session. Logs in first if the session is gone, and if
/// `op` fails because a refresh cleared the session partway through, logs in
/// again and retries `op` once.
pub async fn with_session<T, R, F, Fut>(
    agent: &BskyAgent<T>,
    identifier: &str,
    password: &str,
    mut op: F,
) -> anyhow::Result<R>
where
    T: XrpcClient + Send + Sync,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<R>>,
{
    if agent.get_session().await.is_none() {
        log::warn!("Bluesky session lost (a token refresh failed); logging in again");
        login(agent, identifier, password).await?;
    }

    match op().await {
        Err(e) if agent.get_session().await.is_none() => {
            log::warn!("Bluesky session lost during the operation ({e}); logging in again and retrying once");
            login(agent, identifier, password).await?;
            op().await
        }
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atrium_api::com::atproto::server::{create_session, get_session, refresh_session};
    use atrium_api::xrpc::http::{self, Request, Response};
    use atrium_api::xrpc::HttpClient;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};

    /// A fake PDS. Each `createSession` hands out the next access token from
    /// `logins` ("FAIL" rejects the login); `refreshSession` always fails, which
    /// is the incident. `getSession` stands in for any authenticated call.
    #[derive(Clone, Default)]
    struct FakePds {
        logins: Arc<Mutex<VecDeque<&'static str>>>,
        calls: Arc<Mutex<HashMap<String, usize>>>,
    }

    impl FakePds {
        fn new(logins: &[&'static str]) -> Self {
            Self {
                logins: Arc::new(Mutex::new(logins.iter().copied().collect())),
                ..Default::default()
            }
        }
        fn calls(&self, nsid: &str) -> usize {
            self.calls.lock().unwrap().get(nsid).copied().unwrap_or(0)
        }
    }

    fn error(status: http::StatusCode, name: &str) -> Response<Vec<u8>> {
        Response::builder()
            .status(status)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(
                serde_json::to_vec(&atrium_api::xrpc::error::ErrorResponseBody {
                    error: Some(name.into()),
                    message: None,
                })
                .unwrap(),
            )
            .unwrap()
    }

    fn ok(body: Vec<u8>) -> Response<Vec<u8>> {
        Response::builder()
            .status(http::StatusCode::OK)
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(body)
            .unwrap()
    }

    impl HttpClient for FakePds {
        async fn send_http(
            &self,
            request: Request<Vec<u8>>,
        ) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error + Send + Sync + 'static>> {
            let nsid = request
                .uri()
                .path()
                .trim_start_matches("/xrpc/")
                .to_string();
            *self.calls.lock().unwrap().entry(nsid.clone()).or_default() += 1;
            let token = request
                .headers()
                .get(http::header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .map(str::to_owned);

            Ok(match nsid.as_str() {
                create_session::NSID => match self.logins.lock().unwrap().pop_front() {
                    Some("FAIL") | None => {
                        error(http::StatusCode::UNAUTHORIZED, "AuthenticationRequired")
                    }
                    Some(access) => ok(serde_json::to_vec(&create_session::OutputData {
                        access_jwt: access.into(),
                        active: None,
                        did: "did:web:example.com".parse().unwrap(),
                        did_doc: None,
                        email: None,
                        email_auth_factor: None,
                        email_confirmed: None,
                        handle: "example.com".parse().unwrap(),
                        refresh_jwt: "refresh".into(),
                        status: None,
                    })?),
                },
                refresh_session::NSID => error(
                    http::StatusCode::INTERNAL_SERVER_ERROR,
                    "InternalServerError",
                ),
                get_session::NSID => match token.as_deref() {
                    Some("access") => ok(serde_json::to_vec(&get_session::OutputData {
                        active: None,
                        did: "did:web:example.com".parse().unwrap(),
                        did_doc: None,
                        email: None,
                        email_auth_factor: None,
                        email_confirmed: None,
                        handle: "example.com".parse().unwrap(),
                        status: None,
                    })?),
                    Some("expired") => error(http::StatusCode::BAD_REQUEST, "ExpiredToken"),
                    _ => error(http::StatusCode::UNAUTHORIZED, "AuthMissing"),
                },
                _ => error(http::StatusCode::NOT_FOUND, "MethodNotImplemented"),
            })
        }
    }

    impl XrpcClient for FakePds {
        fn base_uri(&self) -> String {
            "http://fake-pds.invalid".into()
        }
    }

    /// An authenticated call, counting how often it runs.
    async fn authed_call(agent: &BskyAgent<FakePds>, runs: &Mutex<usize>) -> anyhow::Result<()> {
        *runs.lock().unwrap() += 1;
        agent.api.com.atproto.server.get_session().await?;
        Ok(())
    }

    #[tokio::test]
    async fn relogs_in_after_a_failed_refresh_cleared_the_session() {
        // Login hands out a token that later expires; the refresh fails, so the
        // store is cleared and the call goes out unauthenticated, as in the incident.
        let pds = FakePds::new(&["expired", "access"]);
        let agent = BskyAgent::new(pds.clone(), MemorySessionStore::default());
        agent.login("user", "pw").await.unwrap();
        let runs = Mutex::new(0);
        let err = authed_call(&agent, &runs).await.unwrap_err();
        assert!(err.to_string().contains("AuthMissing"), "{err}");
        assert!(agent.get_session().await.is_none());
        *runs.lock().unwrap() = 0;

        with_session(&agent, "user", "pw", || authed_call(&agent, &runs))
            .await
            .unwrap();
        assert_eq!(pds.calls(create_session::NSID), 2);
        assert!(agent.get_session().await.is_some());
        // Logged in before running, so the operation ran once, not fail-then-retry.
        assert_eq!(*runs.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn retries_once_when_the_session_is_cleared_mid_operation() {
        let pds = FakePds::new(&["expired", "access"]);
        let agent = BskyAgent::new(pds.clone(), MemorySessionStore::default());
        agent.login("user", "pw").await.unwrap();
        let runs = Mutex::new(0);

        with_session(&agent, "user", "pw", || authed_call(&agent, &runs))
            .await
            .unwrap();
        assert_eq!(*runs.lock().unwrap(), 2);
        assert_eq!(pds.calls(create_session::NSID), 2);
    }

    #[tokio::test]
    async fn does_not_retry_a_failure_unrelated_to_the_session() {
        let pds = FakePds::new(&["access"]);
        let agent = BskyAgent::new(pds.clone(), MemorySessionStore::default());
        agent.login("user", "pw").await.unwrap();
        let runs = Mutex::new(0);

        let result: anyhow::Result<()> = with_session(&agent, "user", "pw", || async {
            *runs.lock().unwrap() += 1;
            anyhow::bail!("events fetch failed")
        })
        .await;
        assert!(result.is_err());
        assert_eq!(*runs.lock().unwrap(), 1);
        assert_eq!(pds.calls(create_session::NSID), 1);
    }

    #[tokio::test]
    async fn a_failed_relogin_errors_without_running_the_operation() {
        let pds = FakePds::new(&["expired", "FAIL"]);
        let agent = BskyAgent::new(pds.clone(), MemorySessionStore::default());
        agent.login("user", "pw").await.unwrap();
        let runs = Mutex::new(0);
        let _ = authed_call(&agent, &runs).await;
        *runs.lock().unwrap() = 0;

        let err = with_session(&agent, "user", "pw", || authed_call(&agent, &runs))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("login failed"), "{err}");
        assert_eq!(*runs.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn a_failed_relogin_mid_operation_errors_without_retrying() {
        let pds = FakePds::new(&["expired", "FAIL"]);
        let agent = BskyAgent::new(pds.clone(), MemorySessionStore::default());
        agent.login("user", "pw").await.unwrap();
        let runs = Mutex::new(0);

        let err = with_session(&agent, "user", "pw", || authed_call(&agent, &runs))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("login failed"), "{err}");
        assert_eq!(*runs.lock().unwrap(), 1);
        assert_eq!(pds.calls(create_session::NSID), 2);
    }

    #[tokio::test]
    async fn stops_after_one_retry_when_the_session_keeps_dying() {
        let pds = FakePds::new(&["expired", "expired", "expired"]);
        let agent = BskyAgent::new(pds.clone(), MemorySessionStore::default());
        agent.login("user", "pw").await.unwrap();
        let runs = Mutex::new(0);

        let result = with_session(&agent, "user", "pw", || authed_call(&agent, &runs)).await;
        assert!(result.is_err());
        assert_eq!(*runs.lock().unwrap(), 2);
        assert_eq!(pds.calls(create_session::NSID), 2);
    }
}
