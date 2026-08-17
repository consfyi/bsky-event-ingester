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
//! module is what would have moved us to another host after three short
//! connections — about two minutes at that cadence.

/// How the caller should proceed after a connection ended.
#[derive(Debug, PartialEq, Eq)]
pub struct Next {
    /// Wait this long before dialing again.
    pub delay: std::time::Duration,
    /// The endpoint changed; rewind the cursor slightly (see `REWIND_US`) so
    /// the two instances' small ingestion skew can't open a gap.
    pub switched: bool,
}

/// Cursor rewind applied by callers on a host switch, in microseconds.
pub const REWIND_US: i64 = 5_000_000;

impl Next {
    /// The cursor to resume from: rewound by `REWIND_US` only when the host
    /// changed (instances ingest with slightly different lag), untouched on a
    /// plain reconnect. `None` (no cursor yet) stays `None`. Floors at 0; a
    /// negative cursor is meaningless to Jetstream.
    pub fn rewind(&self, cursor: Option<i64>) -> Option<i64> {
        if self.switched {
            cursor.map(|c| c.saturating_sub(REWIND_US).max(0))
        } else {
            cursor
        }
    }
}

/// Which side ended the connection — decides whether it counts against the
/// host. Callers map their own exit paths onto this; `classify` maps errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The consumer ended it on purpose (e.g. the con_posts watchlist
    /// changed): paced, not punished.
    CleanExit,
    /// Something on our side failed (Postgres): back off, but the host did
    /// nothing wrong, so it must not count toward failover — otherwise a
    /// DB outage rotates through every endpoint for no reason.
    LocalError,
    /// The host dropped us, or we could not tell: counts toward failover.
    HostError,
}

/// Map a per-connection error to an `Outcome`. Only a `sqlx::Error` in the
/// chain is local; everything else defaults to `HostError`, since a miss
/// there can only over-rotate (harmless: every host carries the same cursor
/// space), never leave us pinned to a dead host.
pub fn classify(e: &anyhow::Error) -> Outcome {
    if e.chain().any(|c| c.downcast_ref::<sqlx::Error>().is_some()) {
        Outcome::LocalError
    } else {
        Outcome::HostError
    }
}

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
    /// Random spread on every delay: scaled by a factor in
    /// `[1 - jitter, 1 + jitter]`, applied after the cap. The labeler and
    /// con_posts share this policy and were reset together on 2026-08-16;
    /// without jitter they redial in lockstep forever.
    pub jitter: f64,
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
            jitter: 0.1,
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

    /// Record that the current connection ended after `lived` with `outcome`
    /// and decide what to do next. A connection that lived long enough is
    /// healthy whatever ended it: streak and backoff reset.
    pub fn after(&mut self, outcome: Outcome, lived: std::time::Duration) -> Next {
        if lived >= self.policy.healthy_after {
            self.short_streak = 0;
            self.delay = None;
            return Next {
                delay: self.jittered(self.policy.min_delay),
                switched: false,
            };
        }
        if outcome == Outcome::CleanExit {
            // Not a failure: no streak, no backoff, no switch. Just pace the
            // redial.
            return Next {
                delay: self.jittered(self.policy.min_delay),
                switched: false,
            };
        }

        let delay = match self.delay {
            None => self.policy.min_delay,
            Some(d) => (d * 2).min(self.policy.max_delay),
        };
        self.delay = Some(delay);
        let delay = self.jittered(delay);

        if outcome == Outcome::LocalError {
            // Backs off (the local fault needs time too) but says nothing
            // about the host: no streak, no switch.
            return Next {
                delay,
                switched: false,
            };
        }

        self.short_streak += 1;
        let switched = self.endpoints.len() > 1 && self.short_streak >= self.policy.failover_after;
        if switched {
            self.index = (self.index + 1) % self.endpoints.len();
            self.short_streak = 0;
        }

        Next { delay, switched }
    }

    /// Scale by a factor in `[1 - jitter, 1 + jitter]`. `RandomState` is
    /// OS-seeded per instance: enough entropy to break lockstep, and no new
    /// dependency.
    fn jittered(&self, delay: std::time::Duration) -> std::time::Duration {
        use std::hash::{BuildHasher as _, Hasher as _};
        if self.policy.jitter == 0.0 {
            return delay;
        }
        let unit = std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish() as f64
            / u64::MAX as f64;
        delay.mul_f64(1.0 - self.policy.jitter + 2.0 * self.policy.jitter * unit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Exact-delay assertions below need the spread off.
    fn exact() -> Policy {
        Policy {
            jitter: 0.0,
            ..Policy::default()
        }
    }

    fn urls(n: usize) -> Vec<url::Url> {
        (1..=n)
            .map(|i| url::Url::parse(&format!("wss://js{i}.example/subscribe")).unwrap())
            .collect()
    }

    #[test]
    fn empty_endpoint_list_is_an_error() {
        assert!(Reconnector::new(vec![], Policy::default()).is_err());
    }

    #[test]
    fn backoff_doubles_and_caps() {
        let mut r = Reconnector::new(urls(1), exact()).unwrap();
        let short = Duration::from_secs(45);
        let delays: Vec<_> = (0..9)
            .map(|_| r.after(Outcome::HostError, short).delay)
            .collect();
        assert_eq!(
            delays,
            [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]
                .map(Duration::from_millis)
                .to_vec()
        );
    }

    #[test]
    fn single_endpoint_never_switches() {
        let mut r = Reconnector::new(urls(1), Policy::default()).unwrap();
        for _ in 0..10 {
            assert!(!r.after(Outcome::HostError, Duration::from_secs(1)).switched);
        }
        assert_eq!(r.endpoint().host_str(), Some("js1.example"));
    }

    // The 2026-08-16 shape: server resets every ~45s, no event flow.
    #[test]
    fn rotates_after_three_short_connections_and_wraps() {
        let mut r = Reconnector::new(urls(2), exact()).unwrap();
        let short = Duration::from_secs(45);
        assert!(!r.after(Outcome::HostError, short).switched);
        assert!(!r.after(Outcome::HostError, short).switched);
        let n = r.after(Outcome::HostError, short);
        assert!(n.switched);
        assert_eq!(r.endpoint().host_str(), Some("js2.example"));
        // Streak restarts on the new host; delay keeps growing.
        assert!(!r.after(Outcome::HostError, short).switched);
        assert!(!r.after(Outcome::HostError, short).switched);
        let n = r.after(Outcome::HostError, short);
        assert!(n.switched);
        assert_eq!(r.endpoint().host_str(), Some("js1.example"));
        assert_eq!(n.delay, Duration::from_millis(8000));
    }

    #[test]
    fn healthy_connection_resets_backoff_and_streak() {
        let mut r = Reconnector::new(urls(2), exact()).unwrap();
        let short = Duration::from_secs(45);
        r.after(Outcome::HostError, short);
        r.after(Outcome::HostError, short);
        // A long-lived session, then a drop: back to min delay, streak 0.
        let n = r.after(Outcome::HostError, Duration::from_secs(3600));
        assert_eq!(n.delay, Duration::from_millis(250));
        assert!(!n.switched);
        assert!(!r.after(Outcome::HostError, short).switched);
        assert!(!r.after(Outcome::HostError, short).switched);
        assert!(r.after(Outcome::HostError, short).switched);
    }

    // A connection that merely connects (a few seconds) must not reset the
    // backoff — that is exactly what the stall looked like.
    #[test]
    fn brief_connect_does_not_count_as_healthy() {
        let mut r = Reconnector::new(urls(1), exact()).unwrap();
        r.after(Outcome::HostError, Duration::from_secs(45));
        r.after(Outcome::HostError, Duration::from_secs(45));
        assert_eq!(
            r.after(Outcome::HostError, Duration::from_secs(59)).delay,
            Duration::from_millis(1000)
        );
    }

    // A clean exit is paced, not punished: the streak keeps whatever it
    // was and the next real failure carries on from there.
    #[test]
    fn clean_exit_does_not_touch_backoff_or_streak() {
        let mut r = Reconnector::new(urls(2), exact()).unwrap();
        let short = Duration::from_secs(45);
        r.after(Outcome::HostError, short);
        r.after(Outcome::HostError, short);
        let n = r.after(Outcome::CleanExit, Duration::from_secs(5));
        assert_eq!(n.delay, Duration::from_millis(250));
        assert!(!n.switched);
        assert_eq!(r.endpoint().host_str(), Some("js1.example"));
        // Third short failure still trips the failover, at the doubled delay.
        let n = r.after(Outcome::HostError, short);
        assert!(n.switched);
        assert_eq!(n.delay, Duration::from_millis(1000));
    }

    // A clean exit after a long-lived connection is as healthy as a
    // disconnect after one: streak and backoff reset.
    #[test]
    fn long_clean_exit_resets_backoff_and_streak() {
        let mut r = Reconnector::new(urls(2), exact()).unwrap();
        let short = Duration::from_secs(45);
        r.after(Outcome::HostError, short);
        r.after(Outcome::HostError, short);
        let n = r.after(Outcome::CleanExit, Duration::from_secs(3600));
        assert_eq!(n.delay, Duration::from_millis(250));
        assert!(!n.switched);
        // Streak restarted: two more short failures don't switch, the third does.
        assert!(!r.after(Outcome::HostError, short).switched);
        assert_eq!(
            r.after(Outcome::HostError, short).delay,
            Duration::from_millis(500)
        );
        assert!(r.after(Outcome::HostError, short).switched);
    }

    // A local (Postgres) failure backs off like a host failure but never
    // rotates: the host did nothing wrong.
    #[test]
    fn local_error_backs_off_but_never_switches() {
        let mut r = Reconnector::new(urls(2), exact()).unwrap();
        let short = Duration::from_secs(5);
        let mut delays = Vec::new();
        for _ in 0..10 {
            let n = r.after(Outcome::LocalError, short);
            assert!(!n.switched);
            delays.push(n.delay);
        }
        assert_eq!(delays[0], Duration::from_millis(250));
        assert_eq!(delays[1], Duration::from_millis(500));
        assert_eq!(delays[9], Duration::from_secs(30));
        assert_eq!(r.endpoint().host_str(), Some("js1.example"));
        // Long-lived, then a local error: back to min delay.
        assert_eq!(
            r.after(Outcome::LocalError, Duration::from_secs(3600))
                .delay,
            Duration::from_millis(250)
        );
    }

    // Local errors are transparent to the failover streak: a host error
    // before and after still trips it on the third host error.
    #[test]
    fn local_error_does_not_disturb_short_streak() {
        let mut r = Reconnector::new(urls(2), exact()).unwrap();
        let short = Duration::from_secs(45);
        assert!(!r.after(Outcome::HostError, short).switched);
        for _ in 0..4 {
            assert!(!r.after(Outcome::LocalError, short).switched);
        }
        assert!(!r.after(Outcome::HostError, short).switched);
        assert!(r.after(Outcome::HostError, short).switched);
        assert_eq!(r.endpoint().host_str(), Some("js2.example"));
    }

    #[test]
    fn classify_sqlx_is_local_everything_else_is_host() {
        let local = anyhow::Error::from(sqlx::Error::PoolTimedOut);
        assert_eq!(classify(&local), Outcome::LocalError);
        // Wrapped with context: still local.
        let local = local.context("acquiring a connection");
        assert_eq!(classify(&local), Outcome::LocalError);
        let host = anyhow::Error::from(crate::jetstream::Error::ConnectTimeout(
            Duration::from_secs(15),
        ));
        assert_eq!(classify(&host), Outcome::HostError);
        assert_eq!(classify(&anyhow::anyhow!("no events")), Outcome::HostError);
    }

    // Jitter spreads each delay within ±10%, including past the cap.
    #[test]
    fn jitter_stays_within_bounds() {
        let mut r = Reconnector::new(urls(1), Policy::default()).unwrap();
        let short = Duration::from_secs(45);
        let n = r.after(Outcome::HostError, short);
        assert!(
            (Duration::from_millis(225)..=Duration::from_millis(275)).contains(&n.delay),
            "{n:?}"
        );
        for _ in 0..10 {
            r.after(Outcome::HostError, short);
        }
        let n = r.after(Outcome::HostError, short);
        assert!(
            (Duration::from_secs(27)..=Duration::from_secs(33)).contains(&n.delay),
            "{n:?}"
        );
    }

    #[test]
    fn rewind_only_on_switch() {
        let stay = Next {
            delay: Duration::ZERO,
            switched: false,
        };
        let switch = Next {
            delay: Duration::ZERO,
            switched: true,
        };
        assert_eq!(stay.rewind(Some(10_000_000)), Some(10_000_000));
        assert_eq!(
            switch.rewind(Some(10_000_000)),
            Some(10_000_000 - REWIND_US)
        );
        assert_eq!(stay.rewind(None), None);
        assert_eq!(switch.rewind(None), None);
        // Floors at 0 on a tiny cursor, never underflows.
        assert_eq!(switch.rewind(Some(1)), Some(0));
        assert_eq!(switch.rewind(Some(i64::MIN)), Some(0));
    }
}
