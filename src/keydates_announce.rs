//! Announce published key-date changes.
//!
//! Runs after each label sync (which happens after every data deploy via
//! /trigger): diffs each upcoming event's `keyDates` from current.jsonl
//! against a Postgres snapshot and sends one message per changed con to a
//! Telegram channel. Only merged, published data ever reaches this point —
//! unreviewed bot-PR proposals never appear in current.jsonl.
//!
//! First run against an empty snapshot seeds it silently (no announcement
//! storm for pre-existing dates). With `telegram_dry_run` (the default) the
//! messages are logged instead of sent, but the snapshot still advances —
//! run in dry-run mode for a while, then flip it off.

pub struct Announcer {
    pub db_pool: sqlx::PgPool,
    pub reqwest_client: reqwest::Client,
    pub ui_endpoint: String,
    pub bot_token: Option<String>,
    pub chat_id: Option<String>,
    pub dry_run: bool,
    pub cap_per_sync: u32,
}

pub struct EventKeyDates {
    pub event_id: String,
    pub name: String,
    pub key_dates: Option<serde_json::Value>,
}

struct Change {
    category: &'static str,
    kind: &'static str,
    date: String,
    source: Option<String>,
}

/// Filter hashtag on every con key-date update message. Site-level
/// announcements (not produced here yet) are reserved `#SiteNews` so channel
/// searches can tell the two apart (CON-15).
const CON_UPDATE_HASHTAG: &str = "#ConUpdate";

const CATEGORY_LABELS: [(&str, &str); 7] = [
    ("registration", "Registration"),
    ("hotel", "Hotel block"),
    ("dealers", "Dealers/artist alley"),
    ("panels", "Panel submissions"),
    ("performances", "Performance signups"),
    ("djs", "DJ applications"),
    ("volunteers", "Volunteer signups"),
];

fn leaf<'a>(v: &'a serde_json::Value, category: &str, kind: &str) -> Option<&'a serde_json::Value> {
    v.get(category)?.get(kind)
}

/// New or changed upcoming (date >= today) leaves in `new` vs `old`.
fn diff(old: Option<&serde_json::Value>, new: &serde_json::Value) -> Vec<Change> {
    let today = chrono::Utc::now().date_naive().to_string();
    let mut changes = vec![];
    for (category, _) in CATEGORY_LABELS {
        for kind in ["opens", "closes"] {
            let Some(new_leaf) = leaf(new, category, kind) else {
                continue;
            };
            let Some(date) = new_leaf.get("date").and_then(|d| d.as_str()) else {
                continue;
            };
            // compare dates, not whole leaves: a source-citation or confidence
            // refresh with the same date is not news to subscribers
            if old
                .and_then(|o| leaf(o, category, kind))
                .and_then(|o| o.get("date"))
                .and_then(|d| d.as_str())
                == Some(date)
            {
                continue;
            }
            if *date < *today {
                continue; // only announce dates that haven't passed
            }
            changes.push(Change {
                category,
                kind,
                date: date.to_string(),
                source: new_leaf
                    .get("source")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string()),
            });
        }
    }
    changes
}

fn human_date(iso: &str) -> String {
    chrono::NaiveDate::parse_from_str(iso, "%Y-%m-%d")
        .map(|d| d.format("%b %-d, %Y").to_string())
        .unwrap_or_else(|_| iso.to_string())
}

/// Escape text for Telegram's HTML parse mode, which rejects the whole message
/// on a stray `<`, `>` or `&`. Also escapes `"` so it's safe in an href.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Rendered as HTML (sent with `parse_mode: HTML`) so each source shows as a
/// short "link" instead of a long Bluesky URL (CON-67).
fn render_message(ui_endpoint: &str, ev: &EventKeyDates, changes: &[Change]) -> String {
    let mut lines = vec![format!("📅 {} — key date update:", html_escape(&ev.name))];
    for c in changes {
        let label = CATEGORY_LABELS
            .iter()
            .find(|(k, _)| *k == c.category)
            .map(|(_, l)| *l)
            .unwrap_or(c.category);
        let mut line = format!(
            "• {} {} {}",
            html_escape(label),
            c.kind,
            html_escape(&human_date(&c.date))
        );
        if let Some(source) = &c.source {
            if source.starts_with("https://") || source.starts_with("http://") {
                line.push_str(&format!(" (<a href=\"{}\">link</a>)", html_escape(source)));
            } else {
                line.push_str(&format!(" ({})", html_escape(source)));
            }
        }
        lines.push(line);
    }
    lines.push(format!(
        "{}/{} — always confirm on the official site",
        html_escape(ui_endpoint),
        html_escape(&ev.event_id)
    ));
    lines.push(CON_UPDATE_HASHTAG.to_string());
    lines.join("\n")
}

/// `render_message` output is HTML, so it only renders right with `parse_mode`.
fn send_message_body(chat_id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": true,
    })
}

impl Announcer {
    async fn send(&self, text: &str) -> Result<(), anyhow::Error> {
        if self.dry_run {
            log::info!("keydates_announce (dry run):\n{text}");
            return Ok(());
        }
        let (Some(token), Some(chat_id)) = (&self.bot_token, &self.chat_id) else {
            log::info!("keydates_announce (no telegram configured):\n{text}");
            return Ok(());
        };
        // The bot token is a path segment of the request URL, and reqwest
        // errors include the URL in their Display output — strip it so a
        // failed send can't leak the token into the logs.
        self.reqwest_client
            .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
            .json(&send_message_body(chat_id, text))
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?;
        Ok(())
    }

    /// Diff, announce (capped), and advance the snapshot. Never fails the
    /// caller: announcement problems are logged, not propagated, so a
    /// Telegram outage can't break label syncing.
    pub async fn run(&self, events: &[EventKeyDates]) {
        if let Err(e) = self.run_inner(events).await {
            log::error!("keydates_announce failed: {e}");
        }
    }

    async fn run_inner(&self, events: &[EventKeyDates]) -> Result<(), anyhow::Error> {
        if events.is_empty() {
            // a transient bad fetch must not wipe the snapshot below (an empty
            // table looks like first-run seeding and would swallow a whole
            // batch of real announcements)
            log::warn!("keydates_announce: no events; skipping");
            return Ok(());
        }
        let mut conn = self.db_pool.acquire().await?;

        let seeding = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM keydates_snapshot")
            .fetch_one(&mut *conn)
            .await?
            == 0;

        let mut announced = 0u32;
        for ev in events {
            let Some(new) = &ev.key_dates else {
                continue;
            };
            let stored: Option<String> =
                sqlx::query_scalar("SELECT key_dates FROM keydates_snapshot WHERE event_id = $1")
                    .bind(&ev.event_id)
                    .fetch_optional(&mut *conn)
                    .await?;
            let old = stored.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

            let changes = diff(old.as_ref(), new);
            if changes.is_empty() || seeding {
                // advance snapshot silently (seeding, or no upcoming change)
            } else if announced >= self.cap_per_sync {
                // over cap: leave the snapshot behind so this change is
                // announced on a later sync instead of dropped
                log::warn!(
                    "keydates_announce: cap ({}) reached, deferring {}",
                    self.cap_per_sync,
                    ev.event_id
                );
                continue;
            } else {
                // a failed send skips only this event's snapshot advance (so it
                // retries next sync) instead of wedging every event after it
                if let Err(e) = self
                    .send(&render_message(&self.ui_endpoint, ev, &changes))
                    .await
                {
                    log::error!("keydates_announce: send failed for {}: {e}", ev.event_id);
                    continue;
                }
                announced += 1;
            }

            sqlx::query(
                r#"
                INSERT INTO keydates_snapshot (event_id, key_dates) VALUES ($1, $2)
                ON CONFLICT (event_id) DO UPDATE SET key_dates = excluded.key_dates
                "#,
            )
            .bind(&ev.event_id)
            .bind(serde_json::to_string(new)?)
            .execute(&mut *conn)
            .await?;
        }

        if seeding {
            log::info!("keydates_announce: seeded snapshot silently");
        }

        // drop snapshot rows for events no longer in current.jsonl
        let ids = events
            .iter()
            .map(|e| e.event_id.clone())
            .collect::<Vec<_>>();
        sqlx::query("DELETE FROM keydates_snapshot WHERE NOT (event_id = ANY($1))")
            .bind(&ids)
            .execute(&mut *conn)
            .await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_message_ends_with_con_update_hashtag() {
        let ev = EventKeyDates {
            event_id: "examplecon-2026".to_string(),
            name: "ExampleCon 2026".to_string(),
            key_dates: None,
        };
        let changes = vec![Change {
            category: "registration",
            kind: "opens",
            date: "2026-08-01".to_string(),
            source: Some("https://example.com/post".to_string()),
        }];
        let msg = render_message("https://cons.fyi", &ev, &changes);
        // Core behavior under test: the filter hashtag is the last line.
        assert_eq!(msg.lines().last(), Some("#ConUpdate"));
        // Presence checks (not exact header formatting, which copy may tweak).
        assert!(msg.contains("ExampleCon 2026"));
        assert!(msg.contains(
            "• Registration opens Aug 1, 2026 (<a href=\"https://example.com/post\">link</a>)"
        ));
        assert!(
            msg.contains("https://cons.fyi/examplecon-2026 — always confirm on the official site")
        );
    }

    #[test]
    fn test_render_message_escapes_html_in_name_and_source() {
        let ev = EventKeyDates {
            event_id: "fur-and-loathing-2026".to_string(),
            name: "Fur & Loathing <2026>".to_string(),
            key_dates: None,
        };
        let changes = vec![Change {
            category: "hotel",
            kind: "opens",
            date: "2026-10-06".to_string(),
            source: Some("https://example.com/p?a=1&b=\"2\"".to_string()),
        }];
        let msg = render_message("https://cons.fyi", &ev, &changes);
        assert!(msg.contains("📅 Fur &amp; Loathing &lt;2026&gt; — key date update:"));
        assert!(
            msg.contains("(<a href=\"https://example.com/p?a=1&amp;b=&quot;2&quot;\">link</a>)")
        );
    }

    #[test]
    fn test_render_message_leaves_non_url_source_as_text() {
        let ev = EventKeyDates {
            event_id: "examplecon-2026".to_string(),
            name: "ExampleCon 2026".to_string(),
            key_dates: None,
        };
        let changes = vec![Change {
            category: "registration",
            kind: "opens",
            date: "2026-08-01".to_string(),
            source: Some("javascript:alert(1)".to_string()),
        }];
        let msg = render_message("https://cons.fyi", &ev, &changes);
        assert!(!msg.contains("<a "));
        assert!(msg.contains("(javascript:alert(1))"));
    }

    #[test]
    fn test_send_message_body_requests_html_parsing() {
        let body = send_message_body("-100123", "<a href=\"https://x\">link</a>");
        assert_eq!(body["parse_mode"], "HTML");
        assert_eq!(body["text"], "<a href=\"https://x\">link</a>");
    }
}
