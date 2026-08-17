//! Reconnect policy for a Jetstream consumer: exponential backoff plus
//! failover across a list of endpoints.
//!
//! Jetstream cursors are unix-microsecond timestamps, so the same cursor is
//! valid on every public instance ("you can use the same cursor for multiple
//! instances to get roughly the same data" — jetstream README). That makes
//! switching hosts safe as long as the caller rewinds the cursor a few
//! seconds on a switch, which the README also recommends.
//!
//! On 2026-08-16 the single configured host reset both of our connections
//! every ~45s for 2h35m; `sleep(1)` retried the same host ~200 times. This
//! module is what would have moved us to another host after a minute.

/// How the caller should proceed after a connection ended.
#[derive(Debug, PartialEq, Eq)]
pub struct Next {
    /// Wait this long before dialing again.
    pub delay: std::time::Duration,
    /// The endpoint changed; rewind the cursor slightly (see `REWIND`) so
    /// the two instances' small ingestion skew can't open a gap.
    pub switched: bool,
}

/// Cursor rewind applied by callers on a host switch, in microseconds.
pub const REWIND_US: i64 = 5_000_000;

#[derive(Debug, Clone)]
pub struct Policy {
    /// First retry delay; doubles per consecutive short-lived connection.
    pub min_delay: std::time::Duration,
    /// Backoff ceiling.
    pub max_delay: std::time::Duration,
    /// A connection that lived at least this long counts as healthy: the
    /// backoff and the failure streak reset. Deliberately NOT "delivered an
    /// event" — the con_posts consumer watches ~80 accounts and legitimately
    /// sees nothing for minutes on a perfectly good connection.
    pub healthy_after: std::time::Duration,
    /// Rotate to the next endpoint after this many consecutive short-lived
    /// connections on the current one.
    pub failover_after: u32,
}

impl Default for Policy {
    fn default() -> Self {
        // Mirrors the official Go client (250ms→30s, doubling), plus
        // failover, which no client we surveyed does.
        Self {
            min_delay: std::time::Duration::from_millis(250),
            max_delay: std::time::Duration::from_secs(30),
            healthy_after: std::time::Duration::from_secs(60),
            failover_after: 3,
        }
    }
}

pub struct Reconnector {
    endpoints: Vec<url::Url>,
    index: usize,
    short_streak: u32,
    delay: Option<std::time::Duration>,
    policy: Policy,
}

impl Reconnector {
    pub fn new(endpoints: Vec<url::Url>, policy: Policy) -> Result<Self, anyhow::Error> {
        anyhow::ensure!(!endpoints.is_empty(), "no jetstream endpoints configured");
        Ok(Self {
            endpoints,
            index: 0,
            short_streak: 0,
            delay: None,
            policy,
        })
    }

    /// The endpoint to dial next.
    pub fn endpoint(&self) -> &url::Url {
        &self.endpoints[self.index]
    }

    /// Record that the current connection ended after `lived` and decide
    /// what to do next.
    pub fn on_disconnect(&mut self, lived: std::time::Duration) -> Next {
        if lived >= self.policy.healthy_after {
            self.short_streak = 0;
            self.delay = None;
            return Next {
                delay: self.policy.min_delay,
                switched: false,
            };
        }

        self.short_streak += 1;
        let delay = match self.delay {
            None => self.policy.min_delay,
            Some(d) => (d * 2).min(self.policy.max_delay),
        };
        self.delay = Some(delay);

        let switched = self.endpoints.len() > 1 && self.short_streak >= self.policy.failover_after;
        if switched {
            self.index = (self.index + 1) % self.endpoints.len();
            self.short_streak = 0;
        }

        Next { delay, switched }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn urls(n: usize) -> Vec<url::Url> {
        (1..=n)
            .map(|i| url::Url::parse(&format!("wss://js{i}.example/subscribe")).unwrap())
            .collect()
    }

    fn policy() -> Policy {
        Policy {
            min_delay: Duration::from_millis(250),
            max_delay: Duration::from_secs(30),
            healthy_after: Duration::from_secs(60),
            failover_after: 3,
        }
    }

    #[test]
    fn empty_endpoint_list_is_an_error() {
        assert!(Reconnector::new(vec![], policy()).is_err());
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let mut r = Reconnector::new(urls(1), policy()).unwrap();
        let short = Duration::from_secs(45);
        let delays: Vec<_> = (0..9).map(|_| r.on_disconnect(short).delay).collect();
        assert_eq!(
            delays,
            [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]
                .map(Duration::from_millis)
                .to_vec()
        );
    }

    #[test]
    fn single_endpoint_never_switches() {
        let mut r = Reconnector::new(urls(1), policy()).unwrap();
        for _ in 0..10 {
            assert!(!r.on_disconnect(Duration::from_secs(1)).switched);
        }
        assert_eq!(r.endpoint().host_str(), Some("js1.example"));
    }

    // The 2026-08-16 shape: server resets every ~45s, no event flow.
    #[test]
    fn rotates_after_three_short_connections_and_wraps() {
        let mut r = Reconnector::new(urls(2), policy()).unwrap();
        let short = Duration::from_secs(45);
        assert!(!r.on_disconnect(short).switched);
        assert!(!r.on_disconnect(short).switched);
        let n = r.on_disconnect(short);
        assert!(n.switched);
        assert_eq!(r.endpoint().host_str(), Some("js2.example"));
        // Streak restarts on the new host; delay keeps growing.
        assert!(!r.on_disconnect(short).switched);
        assert!(!r.on_disconnect(short).switched);
        let n = r.on_disconnect(short);
        assert!(n.switched);
        assert_eq!(r.endpoint().host_str(), Some("js1.example"));
        assert_eq!(n.delay, Duration::from_millis(8000));
    }

    #[test]
    fn healthy_connection_resets_backoff_and_streak() {
        let mut r = Reconnector::new(urls(2), policy()).unwrap();
        let short = Duration::from_secs(45);
        r.on_disconnect(short);
        r.on_disconnect(short);
        // A long-lived session, then a drop: back to min delay, streak 0.
        let n = r.on_disconnect(Duration::from_secs(3600));
        assert_eq!(n.delay, Duration::from_millis(250));
        assert!(!n.switched);
        assert!(!r.on_disconnect(short).switched);
        assert!(!r.on_disconnect(short).switched);
        assert!(r.on_disconnect(short).switched);
    }

    // A connection that merely connects (a few seconds) must not reset the
    // backoff — that is exactly what the stall looked like.
    #[test]
    fn brief_connect_does_not_count_as_healthy() {
        let mut r = Reconnector::new(urls(1), policy()).unwrap();
        r.on_disconnect(Duration::from_secs(45));
        r.on_disconnect(Duration::from_secs(45));
        assert_eq!(
            r.on_disconnect(Duration::from_secs(59)).delay,
            Duration::from_millis(1000)
        );
    }
}
