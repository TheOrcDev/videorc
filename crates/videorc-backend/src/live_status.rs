//! Ephemeral, allowlisted status for the account's live page (plan 241).
use std::collections::BTreeMap;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::streaming::{StreamTargetRuntime, StreamTargetState, stream_platform_id};
use crate::watchdog::alerts::{AlertSeverity, AlertState, WatchdogAlert, WatchdogCheck};
use crate::watchdog::push::{chat_says_record, looks_like_host, platform_name, push_words};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveStatus {
    version: u8,
    session_id: String,
    seq: u64,
    started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    recording: bool,
    cloud: bool,
    destinations: Vec<Destination>,
    alerts: Vec<Alert>,
    app: App,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Destination {
    platform: String,
    label: String,
    state: String,
    since: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Alert {
    check: String,
    severity: String,
    title: String,
    body: String,
    since: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct App {
    version: String,
    os: String,
}

fn utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// One clock per target state, independent of heartbeat and reason changes.
#[derive(Clone, Default)]
pub(crate) struct StateClocks(BTreeMap<String, (StreamTargetState, String)>);

impl StateClocks {
    fn observe(&mut self, targets: &[StreamTargetRuntime], now: DateTime<Utc>) {
        self.0
            .retain(|id, _| targets.iter().any(|t| &t.target_id == id));
        for target in targets {
            let clock = self
                .0
                .entry(target.target_id.clone())
                .or_insert_with(|| (target.state, utc(now)));
            if clock.0 != target.state {
                *clock = (target.state, utc(now));
            }
        }
    }
}

pub(crate) struct Snapshot<'a> {
    pub session_id: &'a str,
    pub started_at: DateTime<Utc>,
    pub title: &'a str,
    pub app_version: &'a str,
    pub recording: bool,
    pub cloud: bool,
    pub targets: &'a [StreamTargetRuntime],
    pub alerts: &'a [WatchdogAlert],
}

pub(crate) fn build(
    snapshot: &Snapshot<'_>,
    clocks: &mut StateClocks,
    seq: u64,
    now: DateTime<Utc>,
) -> LiveStatus {
    clocks.observe(snapshot.targets, now);
    let destinations = snapshot
        .targets
        .iter()
        .filter_map(|target| {
            let clock = &clocks.0[&target.target_id];
            let (state, reason) = match target.state {
                StreamTargetState::Connecting => ("connecting", None),
                StreamTargetState::Live => {
                    let recent = target
                        .uplink_overflow_at
                        .as_deref()
                        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                        .is_some_and(|at| {
                            (0..60).contains(&(now - at.with_timezone(&Utc)).num_seconds())
                        });
                    ("live", recent.then_some("uplink"))
                }
                StreamTargetState::Warning => ("not-receiving", Some("not-receiving")),
                StreamTargetState::Reconnecting => ("reconnecting", Some("reconnecting")),
                StreamTargetState::Failed => ("failed", Some("connect")),
                _ => return None,
            };
            let platform = stream_platform_id(target.platform);
            let label = if looks_like_host(&target.label) {
                if platform == "custom" {
                    "Custom"
                } else {
                    platform_name(Some(platform))
                }
            } else {
                &target.label
            };
            Some(Destination {
                platform: platform.into(),
                label: label.chars().take(120).collect(),
                state: state.into(),
                since: clock.1.clone(),
                reason: reason.map(str::to_owned),
            })
        })
        .take(16)
        .collect();
    let alerts = snapshot
        .alerts
        .iter()
        .filter(|a| {
            matches!(a.state, AlertState::Open | AlertState::Acknowledged)
                && a.meant_to != Some(true)
                && a.severity.interrupts()
                && a.check != WatchdogCheck::StillThere
        })
        .filter_map(|a| {
            let (title, mut body) = push_words(a, false);
            // ChatSays cards contain quoted chat. Only its existing count/class
            // projection may leave the desktop, exactly as for phone pushes.
            if a.check == WatchdogCheck::ChatSays {
                body = chat_says_record(a);
            }
            let since = DateTime::parse_from_rfc3339(&a.since).ok()?;
            Some(Alert {
                check: a.check.id().into(),
                severity: match a.severity {
                    AlertSeverity::Critical => "critical",
                    _ => "warning",
                }
                .into(),
                title: title.chars().take(120).collect(),
                body: body.chars().take(240).collect(),
                since: utc(since.with_timezone(&Utc)),
                platform: a.platform.clone(),
            })
        })
        .take(12)
        .collect();
    let mut body = LiveStatus {
        version: 1,
        session_id: snapshot.session_id.into(),
        seq,
        started_at: utc(snapshot.started_at),
        title: crate::stream_report::report_title(snapshot.title),
        recording: snapshot.recording,
        cloud: snapshot.cloud,
        destinations,
        alerts,
        app: App {
            version: snapshot.app_version.into(),
            os: match std::env::consts::OS {
                "macos" => "macos",
                "windows" => "windows",
                "linux" => "linux",
                _ => "other",
            }
            .into(),
        },
    };
    // UTF-8 and JSON escaping can exceed the wire limit even with character
    // caps. Keep a valid latest projection rather than queue a refused beat.
    while serde_json::to_vec(&body).map_or(usize::MAX, |v| v.len()) > 8192 {
        if body.alerts.pop().is_some() {
            continue;
        }
        if body.destinations.pop().is_some() {
            continue;
        }
        break;
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming::StreamPlatform;
    use crate::watchdog::alerts::AlertSource;
    fn at() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-16T18:02:10Z")
            .unwrap()
            .with_timezone(&Utc)
    }
    fn target(state: StreamTargetState) -> StreamTargetRuntime {
        StreamTargetRuntime {
            target_id: "one".into(),
            platform: StreamPlatform::Custom,
            label: "my.server.tv:1935".into(),
            state,
            message: Some("secret rtmp://host/key".into()),
            redacted_url: Some("rtmp://host/redacted".into()),
            uplink_overflows: None,
            uplink_overflow_at: None,
        }
    }
    fn alert() -> WatchdogAlert {
        WatchdogAlert {
            id: "a".into(),
            check: WatchdogCheck::MicMuted,
            severity: AlertSeverity::Critical,
            state: AlertState::Open,
            since: utc(at()),
            last_repeat_at: None,
            title: "Your microphone is muted".into(),
            detail: "Muted for 0:42. Check it.".into(),
            source: AlertSource::Desktop,
            platform: None,
            target_id: None,
            fixes: vec![],
            snoozed_until: None,
            meant_to: None,
        }
    }
    fn body(targets: &[StreamTargetRuntime], alerts: &[WatchdogAlert]) -> LiveStatus {
        build(
            &Snapshot {
                session_id: "session",
                started_at: at(),
                title: &"a".repeat(200),
                app_version: "0.29.0",
                recording: true,
                cloud: false,
                targets,
                alerts,
            },
            &mut StateClocks::default(),
            1,
            at(),
        )
    }
    #[test]
    fn target_states_and_private_words() {
        use StreamTargetState::*;
        for (state, expected, reason) in [
            (Connecting, "connecting", None),
            (Live, "live", None),
            (Warning, "not-receiving", Some("not-receiving")),
            (Reconnecting, "reconnecting", Some("reconnecting")),
            (Failed, "failed", Some("connect")),
        ] {
            let value = body(&[target(state)], &[]);
            assert_eq!(value.destinations[0].state, expected);
            assert_eq!(value.destinations[0].reason.as_deref(), reason);
            assert_eq!(value.destinations[0].label, "Custom");
            assert_eq!(value.title.unwrap().chars().count(), 140);
            let wire = serde_json::to_string(&value.destinations).unwrap();
            assert!(
                !wire.contains("secret") && !wire.contains("rtmp") && !wire.contains("redacted")
            );
        }
        for state in [NotConfigured, Ready, Stopped] {
            assert!(body(&[target(state)], &[]).destinations.is_empty());
        }
    }
    #[test]
    fn alerts_filter_notices_snoozes_meant_to_and_still_there() {
        let mut list = vec![alert(); 6];
        list[1].severity = AlertSeverity::Notice;
        list[2].state = AlertState::Snoozed;
        list[3].meant_to = Some(true);
        list[4].check = WatchdogCheck::StillThere;
        list[5].state = AlertState::Acknowledged;
        assert_eq!(body(&[], &list).alerts.len(), 2);
        list[0].check = WatchdogCheck::ChatSays;
        list[0].detail = "3 people: secret chat words".into();
        assert!(
            !serde_json::to_string(&body(&[], &list))
                .unwrap()
                .contains("secret chat")
        );
    }
    #[test]
    fn clocks_and_uplink_expiry() {
        let mut clocks = StateClocks::default();
        let mut t = target(StreamTargetState::Live);
        t.uplink_overflow_at = Some(utc(at()));
        let targets = [t];
        let snapshot = Snapshot {
            session_id: "s",
            started_at: at(),
            title: "",
            app_version: "0.29.0",
            recording: false,
            cloud: false,
            targets: &targets,
            alerts: &[],
        };
        let first = build(&snapshot, &mut clocks, 1, at());
        let later = build(
            &snapshot,
            &mut clocks,
            2,
            at() + chrono::TimeDelta::seconds(60),
        );
        assert_eq!(first.destinations[0].since, later.destinations[0].since);
        assert_eq!(first.destinations[0].reason.as_deref(), Some("uplink"));
        assert_eq!(later.destinations[0].reason, None);
        assert!(serde_json::to_value(later).unwrap().get("title").is_none());
    }
    #[test]
    fn canonical_fixture_round_trips_a_constructed_body() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/live-status-v1.json")).unwrap();
        let mut constructed = body(&[], &[alert()]);
        constructed.session_id = "5f0c2a8e-7d1b-4c1e-9f5a-2b8e6d4c3a10".into();
        constructed.seq = 7;
        constructed.title = Some("Building a Rust TUI, part 3".into());
        constructed.app = App {
            version: "0.29.0".into(),
            os: "macos".into(),
        };
        constructed.destinations = vec![
            Destination {
                platform: "youtube".into(),
                label: "YouTube".into(),
                state: "live".into(),
                since: "2026-11-16T18:02:14Z".into(),
                reason: None,
            },
            Destination {
                platform: "twitch".into(),
                label: "Twitch".into(),
                state: "reconnecting".into(),
                since: "2026-11-16T18:43:01Z".into(),
                reason: Some("reconnecting".into()),
            },
            Destination {
                platform: "custom".into(),
                label: "Custom".into(),
                state: "failed".into(),
                since: "2026-11-16T18:40:00Z".into(),
                reason: Some("connect".into()),
            },
        ];
        constructed.alerts[0].since = "2026-11-16T18:44:02Z".into();
        constructed.alerts.push(Alert {
            check: "destination-down".into(),
            severity: "warning".into(),
            title: "Twitch is reconnecting".into(),
            body: "Reconnecting for 0:31.".into(),
            since: "2026-11-16T18:43:01Z".into(),
            platform: Some("twitch".into()),
        });
        assert_eq!(serde_json::to_value(&constructed).unwrap(), fixture);
        assert_eq!(
            serde_json::from_value::<LiveStatus>(fixture).unwrap(),
            constructed
        );
    }
}
