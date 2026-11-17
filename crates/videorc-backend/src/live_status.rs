//! Ephemeral, allowlisted status for the account's live page (plan 241).
use crate::protocol::{RecordingStatus, ServerEvent};
use crate::state::AppState;
use crate::stream_report_email::{LiveTracker, WebAccess, web_access};
use crate::streaming::StreamTargetsSnapshot;
use crate::watchdog::WatchdogAlertsView;
use std::time::Duration;
use tokio::time::Instant;

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
    /// Plan 249 S25: the cloud show this beat speaks for, and this
    /// computer's controller epoch for it (S24), so the web combines the
    /// show's real legs with the context of its current controller only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    show_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    controller_epoch: Option<u64>,
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
    pub show_id: Option<&'a str>,
    pub controller_epoch: Option<u64>,
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
        show_id: snapshot.show_id.map(str::to_string),
        controller_epoch: snapshot.controller_epoch,
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

const PATH: &str = "/api/desktop/live-status";
const CHANGE_GAP: Duration = Duration::from_secs(3);
const HEARTBEAT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct Latest {
    tracker: LiveTracker,
    clocks: StateClocks,
    status: Option<RecordingStatus>,
    targets: Option<StreamTargetsSnapshot>,
    alerts: WatchdogAlertsView,
    cloud_session: Option<String>,
    cloud_bound: bool,
    /// Plan 249 S25: the show the cloud state names, and its open live
    /// interval when it is a talk show this computer controls.
    cloud_show: Option<String>,
    room: Option<RoomBeat>,
}

/// A talk show live on the cloud: no local session, its legs are the
/// cloud's, its time is the server's interval.
#[derive(Debug, Clone)]
struct RoomBeat {
    show_id: String,
    interval_id: String,
    live_since: DateTime<Utc>,
    legs: Vec<StreamTargetRuntime>,
    recording: bool,
}

fn room_beat(status: &crate::cloud_show::CloudStatus) -> Option<RoomBeat> {
    let show = status.show.as_ref()?;
    if show.kind.as_deref() != Some("talk") || !crate::cloud_controller::ownership_allows(&show.id)
    {
        return None;
    }
    let interval = status.live_interval.as_ref()?;
    if interval.ended_at.is_some() || interval.id.trim().is_empty() {
        return None;
    }
    let live_since = DateTime::parse_from_rfc3339(interval.live_since.as_deref()?)
        .ok()?
        .with_timezone(&Utc);
    Some(RoomBeat {
        show_id: show.id.clone(),
        interval_id: interval.id.clone(),
        live_since,
        legs: status.legs.clone(),
        recording: status.recording.as_ref().is_some_and(|r| r.active),
    })
}

fn held_epoch(show_id: Option<&str>) -> Option<u64> {
    show_id
        .and_then(crate::cloud_controller::held_for)
        .map(|held| held.epoch)
}

impl Latest {
    fn observe(&mut self, event: &ServerEvent, now: DateTime<Utc>) {
        self.tracker.observe(event, now);
        match event.event.as_str() {
            "recording.status" => {
                if let Ok(status) = serde_json::from_value(event.payload.clone()) {
                    self.status = Some(status);
                }
            }
            "stream.targets" => {
                if let Ok(targets) =
                    serde_json::from_value::<StreamTargetsSnapshot>(event.payload.clone())
                {
                    if self
                        .targets
                        .as_ref()
                        .is_none_or(|old| old.session_id != targets.session_id)
                    {
                        self.clocks = StateClocks::default();
                    }
                    self.clocks.observe(&targets.targets, now);
                    self.targets = Some(targets);
                }
            }
            "watchdog.alerts" => {
                if let Ok(alerts) = serde_json::from_value(event.payload.clone()) {
                    self.alerts = alerts;
                }
            }
            "cloud.state" => {
                self.cloud_session = event
                    .payload
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                self.cloud_bound = event.payload.get("show").is_some_and(|v| !v.is_null());
                self.cloud_show = event
                    .payload
                    .get("show")
                    .and_then(|show| show.get("id"))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                let room = crate::cloud_show::CloudStatus::deserialize(&event.payload)
                    .ok()
                    .and_then(|status| room_beat(&status));
                if room.as_ref().map(|r| &r.interval_id)
                    != self.room.as_ref().map(|r| &r.interval_id)
                {
                    self.clocks = StateClocks::default();
                }
                self.room = room;
            }
            _ => {}
        }
    }

    fn project(
        &self,
        title: &str,
        clocks: &mut StateClocks,
        now: DateTime<Utc>,
    ) -> Option<LiveStatus> {
        let Some((id, started_at)) = self.tracker.active_live() else {
            return self.project_room(title, clocks, now);
        };
        let targets = self
            .targets
            .as_ref()
            .filter(|t| t.session_id == id)
            .map_or(&[][..], |t| t.targets.as_slice());
        let alerts = if self.alerts.session_id.as_deref() == Some(id) {
            &self.alerts.alerts[..]
        } else {
            &[]
        };
        Some(build(
            &Snapshot {
                session_id: id,
                started_at,
                title,
                app_version: &crate::performance_check::desktop_app_version(),
                recording: self
                    .status
                    .as_ref()
                    .filter(|s| s.session_id.as_deref() == Some(id))
                    .is_some_and(|s| s.output_path.is_some()),
                cloud: self.cloud_bound && self.cloud_session.as_deref() == Some(id),
                targets,
                alerts,
                show_id: self
                    .cloud_show
                    .as_deref()
                    .filter(|_| self.cloud_bound && self.cloud_session.as_deref() == Some(id)),
                controller_epoch: held_epoch(
                    self.cloud_show
                        .as_deref()
                        .filter(|_| self.cloud_bound && self.cloud_session.as_deref() == Some(id)),
                ),
            },
            clocks,
            0,
            now,
        ))
    }

    /// Plan 249 S25: a talk show live on the cloud beats from its interval,
    /// with the cloud's legs, while this computer controls it.
    fn project_room(
        &self,
        title: &str,
        clocks: &mut StateClocks,
        now: DateTime<Utc>,
    ) -> Option<LiveStatus> {
        let room = self.room.as_ref()?;
        let alerts = if self.alerts.session_id.as_deref() == Some(room.show_id.as_str()) {
            &self.alerts.alerts[..]
        } else {
            &[]
        };
        Some(build(
            &Snapshot {
                session_id: &room.interval_id,
                started_at: room.live_since,
                title,
                app_version: &crate::performance_check::desktop_app_version(),
                recording: room.recording,
                cloud: true,
                targets: &room.legs,
                alerts,
                show_id: Some(&room.show_id),
                controller_epoch: held_epoch(Some(&room.show_id)),
            },
            clocks,
            0,
            now,
        ))
    }
}

#[derive(Default)]
struct Sender {
    session: Option<String>,
    account: Option<String>,
    stopped: bool,
    seq: u64,
    last: Option<Instant>,
    retry_at: Option<Instant>,
    previous: Option<LiveStatus>,
}

impl Sender {
    async fn tick(
        &mut self,
        client: &reqwest::Client,
        web: Option<&WebAccess>,
        body: Option<LiveStatus>,
        now: Instant,
    ) {
        let id = body.as_ref().map(|b| b.session_id.clone());
        if id != self.session {
            if let (Some(old), Some(account), Some(web)) = (&self.session, &self.account, web)
                && account.eq_ignore_ascii_case(&web.email)
                && !self.stopped
            {
                let _ = client
                    .delete(format!("{}{PATH}", web.base_url))
                    .bearer_auth(&web.token)
                    .json(&serde_json::json!({"sessionId":old}))
                    .send()
                    .await;
            }
            *self = Self {
                session: id,
                ..Self::default()
            };
        }
        let Some(mut body) = body else {
            return;
        };
        let Some(web) = web else {
            if self.account.is_some() {
                self.stopped = true;
            }
            return;
        };
        if self
            .account
            .as_ref()
            .is_some_and(|a| !a.eq_ignore_ascii_case(&web.email))
        {
            self.stopped = true;
        }
        if self.stopped {
            return;
        }
        self.account.get_or_insert_with(|| web.email.clone());
        if self.retry_at.is_some_and(|at| now < at) {
            return;
        }
        if let Some(last) = self.last {
            let elapsed = now.saturating_duration_since(last);
            if elapsed < CHANGE_GAP
                || (self.previous.as_ref() == Some(&body) && elapsed < HEARTBEAT)
            {
                return;
            }
        }
        self.seq += 1;
        self.previous = Some(body.clone());
        body.seq = self.seq;
        self.last = Some(now);
        if let Ok(response) = client
            .put(format!("{}{PATH}", web.base_url))
            .bearer_auth(&web.token)
            .json(&body)
            .send()
            .await
        {
            match response.status().as_u16() {
                401 => self.stopped = true,
                429 => {
                    let seconds = response
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(5);
                    let received_at = Instant::now();
                    self.retry_at = received_at
                        .checked_add(Duration::from_secs(seconds))
                        .or_else(|| received_at.checked_add(HEARTBEAT));
                }
                _ => {}
            }
        }
    }
}

pub(crate) fn spawn(state: &AppState) {
    if crate::stream_report_email::env_disables(
        std::env::var("VIDEORC_LIVE_STATUS").ok().as_deref(),
    ) {
        return;
    }
    let state = state.clone();
    let mut events = state.events.subscribe();
    let (latest_tx, mut latest_rx) = tokio::sync::watch::channel(Latest::default());
    // The observer never waits for HTTP; only the latest snapshot is retained.
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event)
                    if matches!(
                        event.event.as_str(),
                        "recording.status" | "stream.targets" | "watchdog.alerts" | "cloud.state"
                    ) =>
                {
                    latest_tx.send_modify(|latest| latest.observe(&event, Utc::now()))
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
    tokio::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .user_agent(crate::performance_check::desktop_user_agent())
            .build()
        else {
            return;
        };
        let mut sender = Sender::default();

        let mut beat = tokio::time::interval(Duration::from_secs(1));
        beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! { _ = beat.tick() => {}, changed = latest_rx.changed() => { if changed.is_err() { break; } } }
            let web = web_access(&state).await;
            let body = {
                let latest = latest_rx.borrow_and_update();
                let id = latest.tracker.active_live().map(|(id, _)| id.to_string());
                let title = id
                    .as_ref()
                    .and_then(|id| {
                        state
                            .database
                            .lock()
                            .ok()?
                            .query_row("SELECT title FROM sessions WHERE id = ?1", [id], |row| {
                                row.get::<_, String>(0)
                            })
                            .ok()
                    })
                    .unwrap_or_default();
                latest.project(&title, &mut latest.clocks.clone(), Utc::now())
            };
            sender
                .tick(&client, web.as_ref(), body, Instant::now())
                .await;
        }
    });
}

#[cfg(test)]
mod sender_tests {
    use super::*;
    use axum::{
        Json, Router,
        extract::State,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::put,
    };
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    #[derive(Clone, Default)]
    struct Web {
        requests: Arc<Mutex<Vec<(String, Value)>>>,
        code: Arc<Mutex<u16>>,
    }
    async fn fake() -> (WebAccess, Web, tokio::task::JoinHandle<()>) {
        let web = Web::default();
        *web.code.lock().unwrap() = 200;
        let app = Router::new()
            .route(
                PATH,
                put(
                    |State(w): State<Web>, headers: HeaderMap, Json(body): Json<Value>| async move {
                        assert_eq!(headers["authorization"], "Bearer fake-token");
                        w.requests.lock().unwrap().push(("PUT".into(), body));
                        (
                            StatusCode::from_u16(*w.code.lock().unwrap()).unwrap(),
                            [("retry-after", "9")],
                            Json(json!({"ok":true})),
                        )
                            .into_response()
                    },
                )
                .delete(
                    |State(w): State<Web>, Json(body): Json<Value>| async move {
                        w.requests.lock().unwrap().push(("DELETE".into(), body));
                        Json(json!({"ok":true}))
                    },
                ),
            )
            .with_state(web.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            WebAccess {
                base_url,
                token: "fake-token".into(),
                email: "ada@example.com".into(),
            },
            web,
            task,
        )
    }
    fn event(name: &str, payload: Value) -> ServerEvent {
        ServerEvent {
            event: name.into(),
            payload,
        }
    }
    fn body() -> LiveStatus {
        let mut latest = Latest::default();
        latest.observe(
            &event(
                "recording.status",
                json!({"state":"streaming","sessionId":"s","startedAt":"2026-11-16T18:02:10Z"}),
            ),
            Utc::now(),
        );
        latest
            .project("Title", &mut StateClocks::default(), Utc::now())
            .unwrap()
    }
    /// Plan 249 S25: a talk show has no local session; it beats from its
    /// live interval with the cloud's legs, and stops when the server ends it.
    #[test]
    fn a_talk_show_beats_from_its_live_interval_and_names_its_show() {
        let mut status = crate::cloud_show::CloudShowRuntime::default().status();
        status.show = Some(
            serde_json::from_value(
                json!({"id": "sh_s25_room", "nodeId": "managed", "resumable": false, "kind": "talk"}),
            )
            .unwrap(),
        );
        status.live_interval = Some(crate::cloud_show::CloudLiveInterval {
            id: "iv-s25-room".into(),
            requested_at: "2026-11-16T18:00:00Z".into(),
            live_since: Some("2026-11-16T18:00:30Z".into()),
            end_requested_at: None,
            ended_at: None,
        });
        status.legs = vec![StreamTargetRuntime {
            target_id: "yt".into(),
            platform: crate::streaming::StreamPlatform::Youtube,
            label: "Main channel".into(),
            state: StreamTargetState::Live,
            message: None,
            redacted_url: None,
            uplink_overflows: None,
            uplink_overflow_at: None,
        }];
        let mut latest = Latest::default();
        latest.observe(
            &event("cloud.state", serde_json::to_value(&status).unwrap()),
            Utc::now(),
        );
        let beat = latest
            .project("Room", &mut StateClocks::default(), Utc::now())
            .expect("a live talk show beats");
        assert_eq!(beat.session_id, "iv-s25-room");
        assert_eq!(beat.started_at, "2026-11-16T18:00:30Z");
        assert!(beat.cloud);
        assert_eq!(beat.show_id.as_deref(), Some("sh_s25_room"));
        assert_eq!(beat.destinations.len(), 1);
        // The server ended the interval: no beat (the sender deletes it).
        status.live_interval.as_mut().unwrap().ended_at = Some("2026-11-16T18:30:00Z".into());
        latest.observe(
            &event("cloud.state", serde_json::to_value(&status).unwrap()),
            Utc::now(),
        );
        assert!(
            latest
                .project("Room", &mut StateClocks::default(), Utc::now())
                .is_none()
        );
        // A solo show is beaten by its local session, as before.
        status.show.as_mut().unwrap().kind = Some("solo".into());
        status.live_interval.as_mut().unwrap().ended_at = None;
        latest.observe(
            &event("cloud.state", serde_json::to_value(&status).unwrap()),
            Utc::now(),
        );
        assert!(
            latest
                .project("Room", &mut StateClocks::default(), Utc::now())
                .is_none()
        );
    }
    #[tokio::test]
    async fn start_change_heartbeat_and_end_delete() {
        let (access, web, task) = fake().await;
        let client = reqwest::Client::new();
        let mut sender = Sender::default();
        let now = Instant::now();
        let first = body();
        sender
            .tick(&client, Some(&access), Some(first.clone()), now)
            .await;
        let mut changed = first.clone();
        changed.recording = true;
        sender
            .tick(
                &client,
                Some(&access),
                Some(changed.clone()),
                now + Duration::from_secs(2),
            )
            .await;
        assert_eq!(web.requests.lock().unwrap().len(), 1);
        sender
            .tick(
                &client,
                Some(&access),
                Some(changed.clone()),
                now + CHANGE_GAP,
            )
            .await;
        sender
            .tick(
                &client,
                Some(&access),
                Some(changed.clone()),
                now + Duration::from_secs(17),
            )
            .await;
        assert_eq!(web.requests.lock().unwrap().len(), 2);
        sender
            .tick(
                &client,
                Some(&access),
                Some(changed),
                now + Duration::from_secs(18),
            )
            .await;
        sender
            .tick(&client, Some(&access), None, now + Duration::from_secs(19))
            .await;
        let requests = web.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].1["seq"], 1);
        assert_eq!(requests[2].1["seq"], 3);
        assert_eq!(requests[3], ("DELETE".into(), json!({"sessionId":"s"})));
        task.abort();
    }
    #[tokio::test]
    async fn sign_out_and_unauthorized_stop_until_next_session() {
        let (access, web, task) = fake().await;
        let client = reqwest::Client::new();
        let now = Instant::now();
        let mut sender = Sender::default();
        let b = body();
        sender.tick(&client, None, Some(b.clone()), now).await;
        assert!(web.requests.lock().unwrap().is_empty());
        sender
            .tick(&client, Some(&access), Some(b.clone()), now)
            .await;
        sender
            .tick(&client, None, Some(b.clone()), now + HEARTBEAT)
            .await;
        sender
            .tick(&client, Some(&access), Some(b.clone()), now + HEARTBEAT * 2)
            .await;
        assert_eq!(web.requests.lock().unwrap().len(), 1);
        sender
            .tick(&client, Some(&access), None, now + HEARTBEAT * 3)
            .await;
        *web.code.lock().unwrap() = 401;
        sender
            .tick(&client, Some(&access), Some(b.clone()), now + HEARTBEAT * 4)
            .await;
        sender
            .tick(&client, Some(&access), Some(b.clone()), now + HEARTBEAT * 5)
            .await;
        assert_eq!(web.requests.lock().unwrap().len(), 2);
        sender
            .tick(&client, Some(&access), None, now + HEARTBEAT * 6)
            .await;
        *web.code.lock().unwrap() = 200;
        sender
            .tick(&client, Some(&access), Some(b), now + HEARTBEAT * 7)
            .await;
        assert_eq!(web.requests.lock().unwrap().len(), 3);
        task.abort();
    }
    #[tokio::test]
    async fn rate_limit_waits_and_failed_beats_are_not_queued() {
        let (access, web, task) = fake().await;
        let client = reqwest::Client::new();
        // Model an old request-start clock without delaying the test.
        let now = Instant::now() - Duration::from_secs(30);
        let mut sender = Sender::default();
        let b = body();
        *web.code.lock().unwrap() = 429;
        sender
            .tick(&client, Some(&access), Some(b.clone()), now)
            .await;
        let retry_at = sender.retry_at.unwrap();
        assert!(retry_at >= now + Duration::from_secs(39));
        let mut changed = b.clone();
        changed.recording = true;
        sender
            .tick(
                &client,
                Some(&access),
                Some(changed.clone()),
                retry_at - Duration::from_secs(1),
            )
            .await;
        assert_eq!(web.requests.lock().unwrap().len(), 1);
        *web.code.lock().unwrap() = 503;
        sender
            .tick(&client, Some(&access), Some(changed.clone()), retry_at)
            .await;
        changed.title = Some("latest".into());
        *web.code.lock().unwrap() = 200;
        sender
            .tick(&client, Some(&access), Some(changed), retry_at + CHANGE_GAP)
            .await;
        let requests = web.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[2].1["title"], "latest");
        task.abort();
    }
    #[test]
    fn tracker_excludes_record_only_and_accepts_early_targets() {
        let mut latest = Latest::default();
        let now = Utc::now();
        latest.observe(
            &event(
                "recording.status",
                json!({"state":"recording","sessionId":"r"}),
            ),
            now,
        );
        assert!(
            latest
                .project("", &mut StateClocks::default(), now)
                .is_none()
        );
        latest.observe(&event("stream.targets",json!({"sessionId":"s","targets":[{"targetId":"t","platform":"twitch","label":"Twitch","state":"live"}]})),now);
        latest.observe(
            &event(
                "recording.status",
                json!({"state":"recording","sessionId":"s","outputPath":"private"}),
            ),
            now,
        );
        let b = latest
            .project("", &mut StateClocks::default(), now)
            .unwrap();
        assert!(b.recording);
        assert_eq!(b.destinations.len(), 1);
        latest.observe(
            &event("recording.status", json!({"state":"idle","sessionId":"s"})),
            now,
        );
        assert!(
            latest
                .project("", &mut StateClocks::default(), now)
                .is_none()
        );
    }
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
                show_id: None,
                controller_epoch: None,
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
            show_id: None,
            controller_epoch: None,
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
