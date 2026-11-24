//! The Stream Manager's live data (plan 055, D7): `shared/live-dashboard.ts`.
//! Electron's Studio renderer builds it from `recording.status`,
//! `stream.viewers`, `stream.audience`, `liveChat.totals` and
//! `stream.targets` and relays it to the window; here the core builds it the
//! same way and the window reads it. Every field of another session is
//! dropped when a new session starts; a terminal status keeps the finished
//! session's data until the next one.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use videorc_protocol::{RecordingState, RecordingStatus};

use crate::studio::session::session_is_live;

/// `stream.viewers`: one platform's count.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerPlatformCount {
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub count: u64,
}

/// `ViewerSample`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerSample {
    pub session_id: String,
    #[serde(default)]
    pub platforms: Vec<ViewerPlatformCount>,
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub at: String,
}

/// `PlatformAudience`, as far as the stats bar reads it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAudience {
    #[serde(default)]
    pub platform: String,
    /// `followers` or `subscribers`.
    #[serde(default)]
    pub metric: String,
    /// `available`, `delta-only`, `pending`, `hidden`, `needs-reconnect`,
    /// `unavailable`.
    #[serde(default)]
    pub capability: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscribers: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscriber_points: Option<u64>,
    /// S3.2c: the session's first reading (`delta` is `total - baseline`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<u64>,
    /// S3.2c, Twitch only: false when follow alerts and the sub count need
    /// a reconnect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audience_scopes: Option<bool>,
    /// S3.2c, Twitch only: false when Power-ups and channel points need a
    /// reconnect (plan 162).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bits_points_scopes: Option<bool>,
    /// S3.2c: followers gained this stream, one per read that set a new
    /// high, oldest first (Activity's unnamed follows).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub follower_gains: Vec<FollowerGain>,
    /// S3.2c: since when a follow event subscription names each new
    /// follower (plan 071), and when it stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub named_follows_since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub named_follows_until: Option<String>,
}

/// `FollowerGain`: new followers one audience read saw, never named.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowerGain {
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub count: u64,
}

/// `AudienceSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudienceSnapshot {
    pub session_id: String,
    #[serde(default)]
    pub platforms: Vec<PlatformAudience>,
    #[serde(default)]
    pub updated_at: String,
}

/// One currency's tips (`SessionChatTipTotal`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TipTotal {
    pub currency: String,
    pub amount_micros: u64,
}

/// The session's confirmed chat totals (`SessionChatTotals`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum SessionChatTotals {
    Available {
        #[serde(rename = "sessionId")]
        session_id: String,
        revision: u64,
        #[serde(rename = "messageCount")]
        message_count: u64,
        chatters: u64,
        follows: u64,
        supporters: u64,
        bits: u64,
        raids: u64,
        platforms: Vec<String>,
        tips: Vec<TipTotal>,
    },
    LegacyUnavailable {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

impl SessionChatTotals {
    pub fn session_id(&self) -> &str {
        match self {
            SessionChatTotals::Available { session_id, .. }
            | SessionChatTotals::LegacyUnavailable { session_id } => session_id,
        }
    }
}

/// One destination's runtime state (`StreamTargetRuntime`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardTarget {
    pub target_id: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `stream.targets`' payload.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardTargets {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub targets: Vec<DashboardTarget>,
}

/// A destination's failure or its recovery this session (S5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationEvent {
    pub id: String,
    /// `failed` or `recovered`.
    pub kind: &'static str,
    pub target_id: String,
    pub platform: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub at: String,
}

/// `LiveDashboardSessionState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SessionState {
    #[default]
    OffAir,
    Recording,
    Live,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::OffAir => "off-air",
            SessionState::Recording => "recording",
            SessionState::Live => "live",
        }
    }
}

/// `VIEWER_HISTORY_POINTS`, `VIEWER_HISTORY_WINDOW_MS`.
pub const VIEWER_HISTORY_POINTS: usize = 120;
pub const VIEWER_HISTORY_WINDOW_MS: i64 = 60 * 60_000;
/// `DESTINATION_EVENTS_LIMIT`.
pub const DESTINATION_EVENTS_LIMIT: usize = 100;

/// `LiveDashboardState`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LiveDashboard {
    pub session_id: Option<String>,
    pub session: SessionState,
    pub started_at: Option<String>,
    pub latest_viewers: Option<ViewerSample>,
    pub peak_viewers: Option<u64>,
    /// Up to an hour of totals, oldest first: `(at, total)`.
    pub viewer_history: Vec<(String, u64)>,
    pub audience: Option<AudienceSnapshot>,
    pub targets: Vec<DashboardTarget>,
    pub destination_events: Vec<DestinationEvent>,
    pub chat_totals: Option<SessionChatTotals>,
    /// `health`: the stream's health and its bitrate history, kept as sent
    /// so a round trip never drops it.
    pub health: Option<Value>,
    /// `cloud`: the Videorc Cloud show carrying this session (plan 184 C7).
    pub cloud: Option<DashboardCloud>,
    /// `alerts`: the stream watchdog's open alerts for this session (plan
    /// 223 A6), as the backend sent them.
    pub alerts: Vec<Value>,
    pub updated_at: String,
}

/// `LiveDashboardCloud`: a cloud show's phase while it carries the session
/// (never `off`), the seconds left while viewers see Be right back (D12),
/// and the upload the cloud measures over the connected feeds.
#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardCloud {
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_remaining_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed_kbps: Option<f64>,
}

/// `CLOUD_PHASES`: the phases in which a show carries a session.
pub const CLOUD_PHASES: [&str; 6] = ["connecting", "live", "hold", "resuming", "ending", "failed"];

/// `dashboardCloudFromStatus`: the show while it carries `session_id`, read
/// from a `cloud.state` status (`CloudStatus`); none for another session's,
/// an off show, or no session.
pub fn dashboard_cloud_from_status(
    status: &Value,
    session_id: Option<&str>,
) -> Option<DashboardCloud> {
    let carried = status.get("sessionId").and_then(Value::as_str)?;
    if Some(carried) != session_id {
        return None;
    }
    let phase = status.get("phase").and_then(Value::as_str)?;
    if !CLOUD_PHASES.contains(&phase) {
        return None;
    }
    let hold = status.get("hold");
    let hold_remaining_seconds = hold
        .filter(|hold| hold.get("active").and_then(Value::as_bool) == Some(true))
        .and_then(|hold| hold.get("remainingSeconds"))
        .and_then(Value::as_u64);
    let feed_kbps: f64 = status
        .get("feeds")
        .and_then(Value::as_array)
        .map(|feeds| {
            feeds
                .iter()
                .filter(|feed| feed.get("connected").and_then(Value::as_bool) == Some(true))
                .filter_map(|feed| feed.get("kbps").and_then(Value::as_f64))
                .sum::<f64>()
        })
        .unwrap_or(0.0);
    Some(DashboardCloud {
        phase: phase.to_owned(),
        hold_remaining_seconds,
        feed_kbps: (feed_kbps > 0.0).then_some(feed_kbps),
    })
}

/// The fields `reduceDashboardAlerts` compares two alerts by.
const ALERT_KEYS: [&str; 5] = ["id", "title", "detail", "state", "severity"];

fn parse_ms(at: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|at| at.timestamp_millis())
}

impl LiveDashboard {
    /// `forSession`: another session's fields are dropped (its session
    /// state kept until the status says otherwise).
    fn for_session(&mut self, session_id: &str) {
        if self.session_id.as_deref() == Some(session_id) {
            return;
        }
        *self = LiveDashboard {
            session_id: Some(session_id.to_string()),
            session: self.session,
            started_at: self.started_at.clone(),
            ..LiveDashboard::default()
        };
    }

    /// `reduceDashboardRecording`. Starting and stopping keep the last state;
    /// a buffer-only session is off air.
    pub fn apply_recording(&mut self, status: &RecordingStatus, now: &str) {
        let state = if status.replay_only {
            SessionState::OffAir
        } else if session_is_live(status) {
            SessionState::Live
        } else {
            match status.state {
                RecordingState::Recording => SessionState::Recording,
                RecordingState::Idle | RecordingState::Failed => SessionState::OffAir,
                _ => return,
            }
        };
        if state == SessionState::OffAir {
            if self.session != SessionState::OffAir {
                self.session = SessionState::OffAir;
                self.targets.clear();
                self.updated_at = now.to_string();
            }
            return;
        }
        let Some(session_id) = status.session_id.as_deref() else {
            return;
        };
        self.for_session(session_id);
        let started_at = status.started_at.clone().or(self.started_at.clone());
        if self.session != state || self.started_at != started_at {
            self.session = state;
            self.started_at = started_at;
            self.updated_at = now.to_string();
        }
    }

    /// `reduceDashboardViewers`; `None` clears the chip.
    pub fn apply_viewers(&mut self, sample: Option<ViewerSample>, now: &str) {
        let Some(sample) = sample else {
            if self.latest_viewers.take().is_some() {
                self.updated_at = now.to_string();
            }
            return;
        };
        self.for_session(&sample.session_id.clone());
        self.viewer_history.push((sample.at.clone(), sample.total));
        self.trim_viewer_history(sample.at.as_str());
        self.peak_viewers = Some(self.peak_viewers.unwrap_or(0).max(sample.total));
        self.latest_viewers = Some(sample);
        self.updated_at = now.to_string();
    }

    /// `mergeDashboardViewerHistory`: backfill from `sessions.viewers.list`.
    /// Points already held win; the peak covers the whole session.
    pub fn merge_viewer_history(&mut self, session_id: &str, samples: &[ViewerSample], now: &str) {
        if self.session_id.as_deref() != Some(session_id) || samples.is_empty() {
            return;
        }
        let known: std::collections::HashSet<&str> = self
            .viewer_history
            .iter()
            .map(|(at, _)| at.as_str())
            .collect();
        let mut merged: Vec<(String, u64)> = samples
            .iter()
            .filter(|sample| sample.session_id == session_id && !known.contains(sample.at.as_str()))
            .map(|sample| (sample.at.clone(), sample.total))
            .chain(self.viewer_history.iter().cloned())
            .collect();
        merged.sort_by(|left, right| left.0.cmp(&right.0));
        let latest_at = merged
            .last()
            .map(|(at, _)| at.as_str())
            .unwrap_or(now)
            .to_string();
        let peak = samples
            .iter()
            .map(|sample| sample.total)
            .chain(self.peak_viewers)
            .max();
        self.viewer_history = merged;
        self.trim_viewer_history(&latest_at);
        if !self.viewer_history.is_empty() {
            self.peak_viewers = peak;
        }
        self.updated_at = now.to_string();
    }

    fn trim_viewer_history(&mut self, latest_at: &str) {
        if let Some(latest) = parse_ms(latest_at) {
            let cutoff = latest - VIEWER_HISTORY_WINDOW_MS;
            self.viewer_history
                .retain(|(at, _)| parse_ms(at).is_none_or(|at| at >= cutoff));
        }
        let over = self
            .viewer_history
            .len()
            .saturating_sub(VIEWER_HISTORY_POINTS);
        self.viewer_history.drain(..over);
    }

    /// `reduceDashboardHealth`: keep the latest sample and its bitrate
    /// history as JSON so a round trip never drops it.
    pub fn apply_health(&mut self, health: Value, now: &str) {
        let Some(session_id) = health.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        self.for_session(session_id);
        let previous = self
            .health
            .as_ref()
            .and_then(|health| health.get("bitrateHistory"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut bitrate_history = previous;
        if let Some(kbps) = health.get("bitrateKbps").and_then(Value::as_f64) {
            if kbps.is_finite() {
                let created = health
                    .get("createdAt")
                    .and_then(Value::as_str)
                    .unwrap_or(now);
                let mut point = json!({ "at": created, "kbps": kbps });
                if let Some(dropped) = health.get("droppedFrames").and_then(Value::as_u64) {
                    point["droppedFrames"] = json!(dropped);
                }
                bitrate_history.push(point);
                if let Some(latest) = parse_ms(created) {
                    let cutoff = latest - 10 * 60_000;
                    bitrate_history.retain(|point| {
                        point
                            .get("at")
                            .and_then(Value::as_str)
                            .and_then(parse_ms)
                            .is_none_or(|at| at >= cutoff)
                    });
                }
                let over = bitrate_history.len().saturating_sub(300);
                bitrate_history.drain(..over);
            }
        }
        self.health = Some(json!({
            "latest": health,
            "bitrateHistory": bitrate_history,
        }));
        self.updated_at = now.to_string();
    }

    /// `reduceDashboardAudience`.
    pub fn apply_audience(&mut self, snapshot: AudienceSnapshot, now: &str) {
        self.for_session(&snapshot.session_id.clone());
        self.audience = Some(snapshot);
        self.updated_at = now.to_string();
    }

    /// `reduceDashboardChatTotals`: totals never establish a session, and an
    /// older read never reverses live progress.
    pub fn apply_chat_totals(&mut self, totals: SessionChatTotals, now: &str) {
        if self.session_id.as_deref() != Some(totals.session_id()) {
            return;
        }
        if let Some(SessionChatTotals::Available {
            revision: previous, ..
        }) = &self.chat_totals
        {
            match &totals {
                SessionChatTotals::Available { revision, .. } if revision > previous => {}
                _ => return,
            }
        }
        self.chat_totals = Some(totals);
        self.updated_at = now.to_string();
    }

    /// `reduceDashboardTargets`: a destination entering `failed` records one
    /// `failed` event; its next `live` one `recovered`.
    pub fn apply_targets(&mut self, snapshot: DashboardTargets, now: &str) {
        let Some(session_id) = snapshot.session_id.as_deref() else {
            return;
        };
        self.for_session(session_id);
        let mut failed_before: Vec<String> = Vec::new();
        for event in &self.destination_events {
            let index = failed_before.iter().position(|id| *id == event.target_id);
            match (event.kind, index) {
                ("failed", None) => failed_before.push(event.target_id.clone()),
                ("recovered", Some(index)) => {
                    failed_before.remove(index);
                }
                _ => {}
            }
        }
        let mut events = Vec::new();
        for target in &snapshot.targets {
            let before = self
                .targets
                .iter()
                .find(|previous| previous.target_id == target.target_id);
            let sequence = self.destination_events.len();
            if target.state == "failed" && before.is_none_or(|before| before.state != target.state)
            {
                if !failed_before.contains(&target.target_id) {
                    events.push(destination_event("failed", target, now, sequence));
                }
            } else if target.state == "live" && failed_before.contains(&target.target_id) {
                events.push(destination_event("recovered", target, now, sequence));
            }
        }
        if !events.is_empty() {
            self.destination_events.extend(events);
            let over = self
                .destination_events
                .len()
                .saturating_sub(DESTINATION_EVENTS_LIMIT);
            self.destination_events.drain(..over);
        }
        self.targets = snapshot.targets;
        self.updated_at = now.to_string();
    }

    /// S3.2c: `normalizeLiveDashboardState`, for a smoke's seed
    /// (`comments-window-seed-dashboard`): the state Electron's window
    /// accepts, or `None` for anything it would refuse (a missing session
    /// state, viewers, targets or destination events, or chat totals of
    /// another session).
    pub fn from_json(value: &Value) -> Option<LiveDashboard> {
        let object = value.as_object()?;
        let session_id = match object.get("sessionId") {
            Some(Value::Null) => None,
            Some(Value::String(id)) => Some(id.clone()),
            _ => return None,
        };
        let updated_at = object.get("updatedAt")?.as_str()?.to_string();
        let session = object.get("session")?.as_object()?;
        let state = match session.get("state")?.as_str()? {
            "off-air" => SessionState::OffAir,
            "recording" => SessionState::Recording,
            "live" => SessionState::Live,
            _ => return None,
        };
        let viewers = object.get("viewers")?.as_object()?;
        let history = viewers.get("history")?.as_array()?;
        let targets = object.get("targets")?.as_array()?;
        let events = object.get("destinationEvents")?.as_array()?;
        let chat_totals = match object.get("chatTotals") {
            None | Some(Value::Null) => None,
            Some(totals) => {
                let totals = serde_json::from_value::<SessionChatTotals>(totals.clone()).ok()?;
                if Some(totals.session_id()) != session_id.as_deref() {
                    return None;
                }
                Some(totals)
            }
        };
        fn read<T: serde::de::DeserializeOwned>(value: &Value) -> Option<T> {
            serde_json::from_value(value.clone()).ok()
        }
        Some(LiveDashboard {
            session_id,
            session: state,
            started_at: session
                .get("startedAt")
                .and_then(Value::as_str)
                .map(str::to_string),
            latest_viewers: viewers.get("latest").and_then(read),
            peak_viewers: viewers.get("peak").and_then(Value::as_u64),
            viewer_history: history
                .iter()
                .filter_map(|point| {
                    Some((
                        point.get("at")?.as_str()?.to_string(),
                        point.get("total")?.as_u64()?,
                    ))
                })
                .collect(),
            audience: object.get("audience").and_then(read),
            targets: targets.iter().filter_map(read).collect(),
            destination_events: events
                .iter()
                .filter_map(|event| {
                    let kind = match event.get("kind")?.as_str()? {
                        "failed" => "failed",
                        "recovered" => "recovered",
                        _ => return None,
                    };
                    let field = |key: &str| {
                        event
                            .get(key)
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()
                    };
                    Some(DestinationEvent {
                        id: field("id"),
                        kind,
                        target_id: field("targetId"),
                        platform: field("platform"),
                        label: field("label"),
                        message: event
                            .get("message")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        at: field("at"),
                    })
                })
                .collect(),
            chat_totals,
            health: object
                .get("health")
                .filter(|health| !health.is_null())
                .cloned(),
            cloud: object.get("cloud").and_then(read),
            alerts: object
                .get("alerts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            updated_at,
        })
    }

    /// `reduceDashboardCloud` (plan 184 C7): the show while it carries this
    /// session. A status for another session, or none, clears it; the
    /// session never comes from here.
    pub fn apply_cloud(&mut self, status: &Value, now: &str) {
        let cloud = dashboard_cloud_from_status(status, self.session_id.as_deref());
        if cloud != self.cloud {
            self.cloud = cloud;
            self.updated_at = now.to_string();
        }
    }

    /// `reduceDashboardAlerts` (plan 223 A6): the open alerts while they
    /// belong to this session (`watchdog.alerts`'s `WatchdogAlertsView`).
    /// Another session's, or none, clears them.
    pub fn apply_alerts(&mut self, view: &Value, now: &str) {
        let view_session = view.get("sessionId").and_then(Value::as_str);
        let alerts: Vec<Value> = match (view_session, self.session_id.as_deref()) {
            (Some(view_session), Some(session)) if view_session == session => view
                .get("alerts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        let same = alerts.len() == self.alerts.len()
            && alerts.iter().zip(&self.alerts).all(|(next, previous)| {
                ALERT_KEYS
                    .iter()
                    .all(|key| next.get(key) == previous.get(key))
            });
        if !same {
            self.alerts = alerts;
            self.updated_at = now.to_string();
        }
    }

    /// The state as Electron's `LiveDashboardState` JSON.
    pub fn to_json(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "session": {
                "state": self.session.as_str(),
                "startedAt": self.started_at,
            },
            "viewers": {
                "latest": self.latest_viewers,
                "peak": self.peak_viewers,
                "history": self.viewer_history.iter().map(|(at, total)| json!({"at": at, "total": total})).collect::<Vec<_>>(),
            },
            "audience": self.audience,
            "health": self.health,
            "targets": self.targets,
            "destinationEvents": self.destination_events,
            "chatTotals": self.chat_totals,
            "cloud": self.cloud,
            "alerts": self.alerts,
            "updatedAt": self.updated_at,
        })
    }
}

fn destination_event(
    kind: &'static str,
    target: &DashboardTarget,
    at: &str,
    sequence: usize,
) -> DestinationEvent {
    DestinationEvent {
        id: format!("{}:{kind}:{at}:{sequence}", target.target_id),
        kind,
        target_id: target.target_id.clone(),
        platform: target.platform.clone(),
        label: target.label.clone(),
        message: target.message.clone(),
        at: at.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Electron's `reduceDashboardCloud` and `reduceDashboardAlerts`: only
    /// this session's show and alerts, and both survive a JSON round trip.
    #[test]
    fn the_cloud_show_and_the_watchdog_alerts_belong_to_this_session() {
        let mut dashboard = LiveDashboard {
            session_id: Some("s1".into()),
            updated_at: "t0".into(),
            ..LiveDashboard::default()
        };
        let status = json!({
            "sessionId": "s1", "phase": "hold",
            "hold": {"active": true, "remainingSeconds": 42},
            "feeds": [{"connected": true, "kbps": 4000.0}, {"connected": false, "kbps": 9.0}, {"connected": true, "kbps": 2000.0}]
        });
        dashboard.apply_cloud(&status, "t1");
        assert_eq!(
            dashboard.cloud,
            Some(DashboardCloud {
                phase: "hold".into(),
                hold_remaining_seconds: Some(42),
                feed_kbps: Some(6000.0)
            })
        );
        assert_eq!(dashboard.updated_at, "t1");
        dashboard.apply_cloud(&status, "t2");
        assert_eq!(
            dashboard.updated_at, "t1",
            "an unchanged show keeps the state"
        );
        dashboard.apply_cloud(&json!({"sessionId": "s2", "phase": "live"}), "t3");
        assert_eq!(dashboard.cloud, None);
        assert_eq!(
            dashboard_cloud_from_status(&json!({"sessionId": "s1", "phase": "off"}), Some("s1")),
            None
        );

        let alert = json!({"id": "a1", "title": "Twitch dropped", "detail": "x", "state": "open", "severity": "warning"});
        dashboard.apply_alerts(&json!({"sessionId": "s1", "alerts": [alert.clone()]}), "t4");
        assert_eq!(dashboard.alerts.len(), 1);
        dashboard.apply_alerts(&json!({"sessionId": "s9", "alerts": [alert.clone()]}), "t5");
        assert!(dashboard.alerts.is_empty());

        dashboard.apply_alerts(&json!({"sessionId": "s1", "alerts": [alert.clone()]}), "t6");
        dashboard.apply_cloud(&status, "t7");
        let back = LiveDashboard::from_json(&dashboard.to_json()).expect("round trip");
        assert_eq!(back.cloud, dashboard.cloud);
        assert_eq!(back.alerts, dashboard.alerts);
    }

    fn status(state: RecordingState, session: &str, stream: bool) -> RecordingStatus {
        let mut status: RecordingStatus = serde_json::from_value(json!({"state": "idle"})).unwrap();
        status.state = state;
        status.session_id = Some(session.to_string());
        status.started_at = Some("2026-11-11T10:00:00Z".to_string());
        if stream {
            status.stream_url = Some("rtmp://127.0.0.1/live/key".to_string());
        }
        status
    }

    fn sample(session: &str, at: &str, total: u64) -> ViewerSample {
        ViewerSample {
            session_id: session.into(),
            platforms: vec![ViewerPlatformCount {
                platform: "twitch".into(),
                count: total,
            }],
            total,
            at: at.into(),
        }
    }

    // `live-dashboard.test.ts`.
    #[test]
    fn a_session_scopes_every_field_and_a_new_one_drops_them() {
        let mut board = LiveDashboard::default();
        board.apply_recording(&status(RecordingState::Recording, "a", true), "t0");
        assert_eq!(board.session, SessionState::Live);
        assert_eq!(board.started_at.as_deref(), Some("2026-11-11T10:00:00Z"));
        board.apply_viewers(Some(sample("a", "2026-11-11T10:01:00Z", 12)), "t1");
        board.apply_viewers(Some(sample("a", "2026-11-11T10:02:00Z", 7)), "t2");
        assert_eq!(board.peak_viewers, Some(12));
        assert_eq!(board.viewer_history.len(), 2);
        board.apply_viewers(None, "t3");
        assert!(board.latest_viewers.is_none());
        board.apply_recording(&status(RecordingState::Idle, "a", false), "t4");
        assert_eq!(board.session, SessionState::OffAir);
        assert_eq!(
            board.peak_viewers,
            Some(12),
            "a finished session keeps its data"
        );
        board.apply_recording(&status(RecordingState::Recording, "b", false), "t5");
        assert_eq!(board.session, SessionState::Recording);
        assert!(board.viewer_history.is_empty(), "the next session drops it");
    }

    #[test]
    fn totals_never_establish_a_session_nor_go_back() {
        let totals = |session: &str, revision: u64| SessionChatTotals::Available {
            session_id: session.into(),
            revision,
            message_count: revision,
            chatters: 1,
            follows: 0,
            supporters: 0,
            bits: 0,
            raids: 0,
            platforms: vec!["twitch".into()],
            tips: vec![],
        };
        let mut board = LiveDashboard::default();
        board.apply_chat_totals(totals("a", 1), "t");
        assert!(board.chat_totals.is_none());
        board.apply_recording(&status(RecordingState::Recording, "a", true), "t");
        board.apply_chat_totals(totals("a", 2), "t");
        board.apply_chat_totals(totals("a", 1), "t");
        assert_eq!(board.chat_totals, Some(totals("a", 2)));
        let read: SessionChatTotals = serde_json::from_value(json!({
            "status": "available", "sessionId": "a", "revision": 3, "messageCount": 9,
            "chatters": 2, "follows": 0, "supporters": 1, "bits": 100, "raids": 0,
            "platforms": ["twitch"], "tips": [{"currency": "USD", "amountMicros": 5000000}]
        }))
        .unwrap();
        board.apply_chat_totals(read, "t");
        assert!(matches!(
            board.chat_totals,
            Some(SessionChatTotals::Available { revision: 3, .. })
        ));
    }

    #[test]
    fn a_failure_and_its_recovery_are_recorded_once() {
        let mut board = LiveDashboard::default();
        let targets = |state: &str| DashboardTargets {
            session_id: Some("a".into()),
            targets: vec![DashboardTarget {
                target_id: "tw".into(),
                platform: "twitch".into(),
                label: "Twitch".into(),
                state: state.into(),
                message: None,
            }],
        };
        board.apply_targets(targets("live"), "t0");
        board.apply_targets(targets("failed"), "t1");
        board.apply_targets(targets("failed"), "t2");
        board.apply_targets(targets("live"), "t3");
        let kinds: Vec<&str> = board.destination_events.iter().map(|e| e.kind).collect();
        assert_eq!(kinds, ["failed", "recovered"]);
    }
}
