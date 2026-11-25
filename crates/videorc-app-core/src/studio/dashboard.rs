//! The Studio's live dashboard driver (plan 260): Electron's
//! `live-dashboard-relay.ts`. Folds `recording.status`, viewers, audience,
//! health, targets, chat totals, cloud and watchdog alerts into one
//! [`LiveDashboard`], pushes it at most once a second, and exposes it as a
//! watch store the Stream Manager mirrors.
//!
//! Alerts the window shows reuse [`super::screen_views::watchdog_card`] with
//! `compact: true`.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::watch;
use videorc_protocol::{RecordingState, RecordingStatus};

use super::session::{session_is_live, session_is_replay_only};
use super::{Studio, StudioBackend};
use crate::guests::session::{
    LiveStartedAt, TalkShowFacts, TalkShowSessionState, talk_show_live_started_at,
    talk_show_session_view,
};
use crate::livestream::cloud_status::CloudStatus;
use crate::livestream::watchdog::WatchdogAlertsView;
use crate::stream_manager::dashboard::{
    AudienceSnapshot, DashboardTarget, DashboardTargets, LiveDashboard, SessionChatTotals,
    SessionState, ViewerSample,
};

/// `stream.viewers`.
pub const VIEWERS_EVENT: &str = "stream.viewers";
/// `stream.audience`.
pub const AUDIENCE_EVENT: &str = "stream.audience";
/// `liveChat.totals`.
pub const CHAT_TOTALS_EVENT: &str = "liveChat.totals";
/// Backfill methods the first on-air sighting runs.
pub const VIEWERS_LIST: &str = "sessions.viewers.list";
pub const AUDIENCE_SNAPSHOT: &str = "stream.audience.snapshot";
pub const COMMENTS_TOTALS: &str = "sessions.comments.totals";
/// `cloud.status` (same string as `studio::cloud`).
const CLOUD_STATUS: &str = "cloud.status";
/// At most one push a second (Electron's coalescer).
pub const PUSH_INTERVAL_MS: u64 = 1_000;

/// A buffer-only session never owns the window (plan 181).
fn session_runs_for_the_window(status: &RecordingStatus) -> bool {
    matches!(
        status.state,
        RecordingState::Recording | RecordingState::Streaming
    ) && !session_is_replay_only(status)
}

fn talk_show_facts(status: &CloudStatus) -> TalkShowFacts {
    serde_json::from_value(json!({
        "phase": status.phase,
        "show": status.show.as_ref().map(|show| json!({
            "id": show.id,
            "kind": show.kind,
            "resumable": show.resumable,
        })),
        "room": status.room,
        "recording": status.recording,
        "liveSeconds": status.live_seconds,
        "stoppedBy": status.stopped_by,
        "onAir": status.on_air.as_ref().map(|on_air| json!({
            "thisDevice": on_air.this_device,
            "waiting": on_air.waiting,
        })),
    }))
    .unwrap_or_default()
}

fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn idle_status() -> RecordingStatus {
    RecordingStatus {
        state: RecordingState::Idle,
        session_id: None,
        output_path: None,
        stream_url: None,
        started_at: None,
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: None,
        replay_only: false,
        accepts_live_scene_edits: None,
    }
}

fn recording_from_talk_show(
    view: &crate::guests::session::TalkShowSessionView,
    started_at: Option<String>,
) -> RecordingStatus {
    let (state, stream_url) = match view.state {
        TalkShowSessionState::Streaming => (
            RecordingState::Streaming,
            view.stream_url.map(str::to_string),
        ),
        TalkShowSessionState::Recording => (RecordingState::Recording, None),
    };
    let started_at = started_at.or_else(|| {
        view.started_at.as_ref().map(|started| match started {
            LiveStartedAt::Stamp(stamp) => stamp.clone(),
            LiveStartedAt::EpochMs(ms) => iso_from_ms(*ms),
        })
    });
    RecordingStatus {
        state,
        session_id: Some(view.session_id.clone()),
        output_path: None,
        stream_url,
        started_at,
        audio_tracks: Vec::new(),
        pipeline: None,
        duration_ms: None,
        message: None,
        replay_only: false,
        accepts_live_scene_edits: None,
    }
}

/// `talkShowDashboardStatus`: a talk show room as the window's session, or
/// `None` when no room is open.
pub fn talk_show_dashboard_status(
    status: &CloudStatus,
    current: &LiveDashboard,
    now_ms: i64,
) -> Option<RecordingStatus> {
    let room = status.room.as_ref()?;
    let phase = room.get("phase").and_then(Value::as_str)?;
    if phase == "closed" {
        return None;
    }
    let facts = talk_show_facts(status);
    let view = match talk_show_session_view(Some(&facts), None) {
        Some(view) => view,
        None => return Some(idle_status()),
    };
    if view.state != TalkShowSessionState::Streaming {
        return Some(recording_from_talk_show(&view, None));
    }
    let kept = match (
        room.get("liveSince").and_then(Value::as_str),
        current.session_id.as_deref(),
        view.session_id.as_str(),
        current.session,
    ) {
        (None, Some(current_id), show_id, SessionState::Live) if current_id == show_id => {
            current.started_at.clone()
        }
        _ => None,
    };
    let started = kept.or_else(|| {
        Some(match talk_show_live_started_at(Some(&facts), now_ms) {
            LiveStartedAt::Stamp(stamp) => stamp,
            LiveStartedAt::EpochMs(ms) => iso_from_ms(ms),
        })
    });
    Some(recording_from_talk_show(&view, started))
}

/// Coalesces pushes to at most one per [`PUSH_INTERVAL_MS`]: the first
/// change goes out at once, later ones as one trailing push.
#[derive(Debug)]
pub struct DashboardPushCoalescer {
    last_push_at: i64,
    pending: Option<LiveDashboard>,
    due_at: Option<i64>,
    /// Bumped each time a trailing push is due, so only the newest timer
    /// fires it.
    timer: u64,
}

impl Default for DashboardPushCoalescer {
    fn default() -> Self {
        Self {
            last_push_at: i64::MIN / 4,
            pending: None,
            due_at: None,
            timer: 0,
        }
    }
}

impl DashboardPushCoalescer {
    /// Schedules `state`. Returns the state to push now, if any.
    pub fn schedule(&mut self, state: LiveDashboard, now_ms: i64) -> Option<LiveDashboard> {
        self.pending = Some(state);
        if self.due_at.is_some() {
            return None;
        }
        let wait = self.last_push_at + PUSH_INTERVAL_MS as i64 - now_ms;
        if wait <= 0 {
            return self.flush(now_ms);
        }
        self.due_at = Some(now_ms + wait);
        self.timer += 1;
        None
    }

    /// When the trailing push is due, and the timer that owns it.
    pub fn due(&self) -> Option<(i64, u64)> {
        self.due_at.map(|due| (due, self.timer))
    }

    /// The timer armed for the trailing push fired (Electron's
    /// `setTimeout(send, wait)`): it pushes unless a flush or a dispose came
    /// first. It never waits on the wall clock again, so a sleep that ends a
    /// moment early still pushes.
    pub fn fire(&mut self, timer: u64, now_ms: i64) -> Option<LiveDashboard> {
        if timer != self.timer || self.due_at.is_none() {
            return None;
        }
        self.flush(now_ms)
    }

    /// Pushes the pending state when its timer is due.
    pub fn tick(&mut self, now_ms: i64) -> Option<LiveDashboard> {
        match self.due_at {
            Some(due) if now_ms >= due => self.flush(now_ms),
            _ => None,
        }
    }

    pub fn flush(&mut self, now_ms: i64) -> Option<LiveDashboard> {
        self.due_at = None;
        let state = self.pending.take()?;
        self.last_push_at = now_ms;
        Some(state)
    }

    pub fn dispose(&mut self) {
        self.pending = None;
        self.due_at = None;
    }
}

/// Electron's `createLiveDashboardRelay`: folds events into one state.
#[derive(Debug)]
pub struct DashboardRelay {
    state: LiveDashboard,
    confirmed_session_id: Option<String>,
    pending_totals: Option<SessionChatTotals>,
    room_owns_session: bool,
}

impl DashboardRelay {
    pub fn new(now: &str) -> Self {
        Self {
            state: LiveDashboard {
                updated_at: now.to_string(),
                ..LiveDashboard::default()
            },
            confirmed_session_id: None,
            pending_totals: None,
            room_owns_session: false,
        }
    }

    pub fn current(&self) -> &LiveDashboard {
        &self.state
    }

    pub fn confirmed_session_id(&self) -> Option<&str> {
        self.confirmed_session_id.as_deref()
    }

    /// Adopts a cached state after a relaunch mid-session.
    pub fn seed(&mut self, seeded: LiveDashboard) -> bool {
        if self.state.session_id.is_some() {
            return false;
        }
        self.state = seeded;
        true
    }

    pub fn recording(&mut self, status: &RecordingStatus, now: &str) -> bool {
        if self.room_owns_session {
            return false;
        }
        if let (Some(session_id), Some(confirmed)) = (
            status.session_id.as_deref(),
            self.confirmed_session_id.as_deref(),
        ) {
            if matches!(status.state, RecordingState::Idle | RecordingState::Failed)
                && session_id != confirmed
            {
                return false;
            }
        }
        if status.session_id.is_some() && session_runs_for_the_window(status) {
            self.confirmed_session_id = status.session_id.clone();
        }
        let before = self.state.clone();
        self.state.apply_recording(status, now);
        if let Some(pending) = self.pending_totals.take() {
            if Some(pending.session_id()) == self.confirmed_session_id.as_deref() {
                self.state.apply_chat_totals(pending, now);
            }
        }
        self.state != before
    }

    pub fn viewers(&mut self, sample: Option<ViewerSample>, now: &str) -> bool {
        let accept = match &sample {
            Some(sample) => {
                Some(sample.session_id.as_str()) == self.confirmed_session_id.as_deref()
            }
            None => !self.room_owns_session,
        };
        if !accept {
            return false;
        }
        let before = self.state.clone();
        self.state.apply_viewers(sample, now);
        self.state != before
    }

    pub fn audience(&mut self, snapshot: AudienceSnapshot, now: &str) -> bool {
        if Some(snapshot.session_id.as_str()) != self.confirmed_session_id.as_deref() {
            return false;
        }
        let before = self.state.clone();
        self.state.apply_audience(snapshot, now);
        self.state != before
    }

    pub fn health(&mut self, health: Value, now: &str) -> bool {
        let session = health.get("sessionId").and_then(Value::as_str);
        if session != self.confirmed_session_id.as_deref() {
            return false;
        }
        let before = self.state.clone();
        self.state.apply_health(health, now);
        self.state != before
    }

    pub fn targets(&mut self, snapshot: DashboardTargets, now: &str) -> bool {
        if snapshot.session_id.as_deref() != self.confirmed_session_id.as_deref() {
            return false;
        }
        let before = self.state.clone();
        self.state.apply_targets(snapshot, now);
        self.state != before
    }

    pub fn chat_totals(&mut self, totals: SessionChatTotals, now: &str) -> bool {
        if Some(totals.session_id()) != self.confirmed_session_id.as_deref() {
            if let Some(SessionChatTotals::Available {
                session_id: pending_id,
                revision: pending_rev,
                ..
            }) = &self.pending_totals
            {
                if pending_id == totals.session_id() {
                    match &totals {
                        SessionChatTotals::Available { revision, .. } if revision > pending_rev => {
                        }
                        _ => return false,
                    }
                }
            }
            self.pending_totals = Some(totals);
            return false;
        }
        let before = self.state.clone();
        self.state.apply_chat_totals(totals, now);
        self.state != before
    }

    pub fn cloud(&mut self, status: &CloudStatus, now: &str, now_ms: i64) -> bool {
        let mut changed = false;
        if let Some(room) = talk_show_dashboard_status(status, &self.state, now_ms) {
            self.room_owns_session = true;
            let was_on_air = self.state.session != SessionState::OffAir;
            if room.session_id.is_some() && session_runs_for_the_window(&room) {
                self.confirmed_session_id = room.session_id.clone();
            }
            let before = self.state.clone();
            self.state.apply_recording(&room, now);
            changed |= self.state != before;
            if was_on_air && self.state.session == SessionState::OffAir {
                let before = self.state.clone();
                self.state.apply_viewers(None, now);
                changed |= self.state != before;
            }
            if let Some(confirmed) = self.confirmed_session_id.clone() {
                if let Some(pending) = self.pending_totals.take() {
                    if pending.session_id() == confirmed {
                        let before = self.state.clone();
                        self.state.apply_chat_totals(pending, now);
                        changed |= self.state != before;
                    } else {
                        self.pending_totals = Some(pending);
                    }
                }
            }
            if room.session_id.is_some() && session_is_live(&room) && !status.legs.is_empty() {
                let targets: Vec<DashboardTarget> = status
                    .legs
                    .iter()
                    .map(|leg| DashboardTarget {
                        target_id: leg.target_id.clone(),
                        platform: leg.platform.clone(),
                        label: leg.label.clone(),
                        state: leg.state.clone(),
                        message: leg.message.clone(),
                    })
                    .collect();
                if targets != self.state.targets {
                    let before = self.state.clone();
                    self.state.apply_targets(
                        DashboardTargets {
                            session_id: room.session_id.clone(),
                            targets,
                        },
                        now,
                    );
                    changed |= self.state != before;
                }
            }
        } else if self.room_owns_session {
            self.room_owns_session = false;
            let before = self.state.clone();
            self.state.apply_recording(&idle_status(), now);
            self.state.apply_viewers(None, now);
            changed |= self.state != before;
        }
        let cloud_json = json!({
            "sessionId": status.session_id,
            "phase": status.phase,
            "hold": status.hold.as_ref().map(|hold| json!({
                "active": hold.active,
                "remainingSeconds": hold.remaining_seconds,
            })),
        });
        let before = self.state.clone();
        self.state.apply_cloud(&cloud_json, now);
        changed || self.state != before
    }

    pub fn alerts(&mut self, view: &WatchdogAlertsView, now: &str) -> bool {
        let alerts: Vec<Value> = view
            .alerts
            .iter()
            .map(|alert| {
                json!({
                    "id": alert.id,
                    "title": alert.title,
                    "detail": alert.detail,
                    "state": alert.state,
                    "severity": alert.severity,
                })
            })
            .collect();
        let payload = json!({
            "sessionId": view.session_id,
            "alerts": alerts,
            "withdrawn": view.withdrawn,
        });
        let before = self.state.clone();
        self.state.apply_alerts(&payload, now);
        self.state != before
    }

    pub fn backfill_viewers(
        &mut self,
        session_id: &str,
        samples: &[ViewerSample],
        now: &str,
    ) -> bool {
        if Some(session_id) != self.confirmed_session_id.as_deref() {
            return false;
        }
        let before = self.state.clone();
        self.state.merge_viewer_history(session_id, samples, now);
        self.state != before
    }
}

/// The Studio's dashboard half.
pub(super) struct DashboardInner {
    pub relay: DashboardRelay,
    pub coalescer: DashboardPushCoalescer,
    pub hydrated_session_id: Option<String>,
    pub cloud_state_seen: bool,
    /// A lag's totals refresh is out (single-flight).
    pub totals_refreshing: bool,
}

/// Ends the totals refresh however its task ends.
struct TotalsRefreshDone(Arc<Mutex<DashboardInner>>);

impl Drop for TotalsRefreshDone {
    fn drop(&mut self) {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .totals_refreshing = false;
    }
}

impl DashboardInner {
    pub fn new(now: &str) -> Self {
        Self {
            relay: DashboardRelay::new(now),
            coalescer: DashboardPushCoalescer::default(),
            hydrated_session_id: None,
            cloud_state_seen: false,
            totals_refreshing: false,
        }
    }
}

impl<B: StudioBackend> Studio<B> {
    pub fn dashboard(&self) -> watch::Receiver<LiveDashboard> {
        self.dashboard_tx.subscribe()
    }

    pub fn dashboard_now(&self) -> LiveDashboard {
        self.dashboard_tx.borrow().clone()
    }

    /// Compact watchdog cards for the stats-bar chip (P946).
    pub fn dashboard_alert_cards(&self) -> Vec<crate::studio::screen_views::WatchdogCardView> {
        self.dashboard_now()
            .alerts
            .iter()
            .filter_map(|alert| {
                serde_json::from_value::<crate::livestream::watchdog::WatchdogAlert>(alert.clone())
                    .ok()
            })
            .map(|alert| crate::studio::screen_views::watchdog_card(&alert, true))
            .collect()
    }

    fn lock_dashboard(&self) -> std::sync::MutexGuard<'_, DashboardInner> {
        self.dashboard
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn schedule_dashboard_locked(
        &self,
        inner: &mut DashboardInner,
        changed: bool,
        now_ms: i64,
    ) -> Option<LiveDashboard> {
        if !changed {
            return None;
        }
        schedule_push(&self.dashboard, &self.dashboard_tx, inner, now_ms)
    }

    fn publish_dashboard(&self, state: Option<LiveDashboard>) {
        if let Some(state) = state {
            let _ = self.dashboard_tx.send(state);
        }
    }

    /// Drains a due coalesced push (the Studio's tick, or a test's clock).
    pub fn tick_dashboard(&self, now_ms: i64) {
        let push = self.lock_dashboard().coalescer.tick(now_ms);
        self.publish_dashboard(push);
    }

    pub(super) fn handle_dashboard_event(&self, event: &str, payload: &Value) -> bool {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let now_ms = chrono::Utc::now().timestamp_millis();
        let mut hydrate: Option<String> = None;
        let mut refresh_totals: Option<String> = None;
        let (handled, push) = {
            let mut inner = self.lock_dashboard();
            let changed = match event {
                crate::client::names::RECORDING_STATUS => {
                    match serde_json::from_value::<RecordingStatus>(payload.clone()) {
                        Ok(status) => {
                            if status.session_id.is_some() && session_runs_for_the_window(&status) {
                                hydrate = status.session_id.clone();
                            }
                            let changed = inner.relay.recording(&status, &now);
                            // Session over: the viewer chip clears, never
                            // freezes (`use-studio.tsx`, rider V2).
                            let ended = matches!(
                                status.state,
                                RecordingState::Idle | RecordingState::Failed
                            ) && inner.relay.viewers(None, &now);
                            changed || ended
                        }
                        Err(error) => {
                            self.config.logger.warn(format!(
                                "Studio: dashboard \"{event}\" did not read ({error})."
                            ));
                            false
                        }
                    }
                }
                VIEWERS_EVENT => {
                    match serde_json::from_value::<Option<ViewerSample>>(payload.clone()) {
                        Ok(sample) => inner.relay.viewers(sample, &now),
                        Err(error) => {
                            self.config.logger.warn(format!(
                                "Studio: dashboard \"{event}\" did not read ({error})."
                            ));
                            false
                        }
                    }
                }
                AUDIENCE_EVENT => {
                    match serde_json::from_value::<AudienceSnapshot>(payload.clone()) {
                        Ok(snapshot) => inner.relay.audience(snapshot, &now),
                        Err(error) => {
                            self.config.logger.warn(format!(
                                "Studio: dashboard \"{event}\" did not read ({error})."
                            ));
                            false
                        }
                    }
                }
                super::health::STREAM_HEALTH_EVENT => inner.relay.health(payload.clone(), &now),
                crate::client::names::STREAM_TARGETS => {
                    match serde_json::from_value::<DashboardTargets>(payload.clone()) {
                        Ok(snapshot) => inner.relay.targets(snapshot, &now),
                        Err(error) => {
                            self.config.logger.warn(format!(
                                "Studio: dashboard \"{event}\" did not read ({error})."
                            ));
                            false
                        }
                    }
                }
                CHAT_TOTALS_EVENT => {
                    match serde_json::from_value::<SessionChatTotals>(payload.clone()) {
                        Ok(totals) => inner.relay.chat_totals(totals, &now),
                        Err(error) => {
                            self.config.logger.warn(format!(
                                "Studio: dashboard \"{event}\" did not read ({error})."
                            ));
                            false
                        }
                    }
                }
                crate::client::names::EVENTS_LAGGED => {
                    // `refreshTotals(relay.current().sessionId)`: nothing
                    // changed yet; the answer is what may.
                    refresh_totals = inner.relay.current().session_id.clone();
                    false
                }
                _ => return false,
            };
            (
                true,
                self.schedule_dashboard_locked(&mut inner, changed, now_ms),
            )
        };
        self.publish_dashboard(push);
        if let Some(session_id) = hydrate {
            self.kick_dashboard_hydrate(session_id);
        }
        if let Some(session_id) = refresh_totals {
            self.kick_dashboard_totals(session_id);
        }
        handled
    }

    pub(super) fn feed_dashboard_cloud(&self, status: &CloudStatus) {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let now_ms = chrono::Utc::now().timestamp_millis();
        let (push, hydrate) = {
            let mut inner = self.lock_dashboard();
            inner.cloud_state_seen = true;
            let changed = inner.relay.cloud(status, &now, now_ms);
            let session_id = inner.relay.current().session_id.clone();
            let off_air = inner.relay.current().session == SessionState::OffAir;
            let show_id = status.show.as_ref().map(|show| show.id.clone());
            if status.stopped_by.is_some() || off_air {
                if show_id
                    .as_deref()
                    .is_some_and(|id| inner.hydrated_session_id.as_deref() == Some(id))
                {
                    inner.hydrated_session_id = None;
                }
            }
            let push = self.schedule_dashboard_locked(&mut inner, changed, now_ms);
            let hydrate = if status.stopped_by.is_none() && !off_air {
                match (session_id, show_id) {
                    (Some(session_id), Some(show_id)) if session_id == show_id => Some(session_id),
                    _ => None,
                }
            } else {
                None
            };
            (push, hydrate)
        };
        self.publish_dashboard(push);
        if let Some(session_id) = hydrate {
            self.kick_dashboard_hydrate(session_id);
        }
    }

    pub(super) fn feed_dashboard_alerts(&self, view: &WatchdogAlertsView) {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let now_ms = chrono::Utc::now().timestamp_millis();
        let push = {
            let mut inner = self.lock_dashboard();
            let changed = inner.relay.alerts(view, &now);
            self.schedule_dashboard_locked(&mut inner, changed, now_ms)
        };
        self.publish_dashboard(push);
    }

    fn kick_dashboard_hydrate(&self, session_id: String) {
        let should = {
            let mut inner = self.lock_dashboard();
            if inner.hydrated_session_id.as_deref() == Some(session_id.as_str()) {
                false
            } else {
                inner.hydrated_session_id = Some(session_id.clone());
                true
            }
        };
        if !should {
            return;
        }
        let backend = Arc::clone(&self.backend);
        let dashboard = Arc::clone(&self.dashboard);
        let dashboard_tx = self.dashboard_tx.clone();
        let logger = self.config.logger.clone();
        tokio::spawn(async move {
            read_dashboard_backfill(backend, dashboard, dashboard_tx, logger, session_id).await;
        });
    }

    /// `refreshTotals`: the chat totals again after a lag, whether or not
    /// the session was hydrated; a refresh already out answers for this one.
    fn kick_dashboard_totals(&self, session_id: String) {
        {
            let mut inner = self.lock_dashboard();
            if inner.totals_refreshing {
                return;
            }
            inner.totals_refreshing = true;
        }
        let backend = Arc::clone(&self.backend);
        let dashboard = Arc::clone(&self.dashboard);
        let dashboard_tx = self.dashboard_tx.clone();
        tokio::spawn(async move {
            let _done = TotalsRefreshDone(Arc::clone(&dashboard));
            read_dashboard_totals(backend.as_ref(), &dashboard, &dashboard_tx, &session_id).await;
        });
    }

    /// Seed cloud once when the connection opens (Electron's mid-show reload).
    pub(super) async fn read_dashboard(&self) {
        let seen = self.lock_dashboard().cloud_state_seen;
        if seen {
            return;
        }
        if let Ok(status) = self
            .backend
            .livestream_request(CLOUD_STATUS, Value::Null)
            .await
        {
            if let Ok(status) = serde_json::from_value::<CloudStatus>(status) {
                self.feed_dashboard_cloud(&status);
            }
        }
    }
}

async fn read_dashboard_backfill<B: StudioBackend>(
    backend: Arc<B>,
    dashboard: Arc<Mutex<DashboardInner>>,
    dashboard_tx: watch::Sender<LiveDashboard>,
    logger: crate::log::Logger,
    session_id: String,
) {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if let Ok(page) = backend
        .livestream_request(VIEWERS_LIST, json!({ "sessionId": session_id }))
        .await
    {
        let samples: Vec<ViewerSample> = page
            .get("samples")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|sample| serde_json::from_value(sample.clone()).ok())
            .collect();
        publish_if_changed(&dashboard, &dashboard_tx, |inner| {
            inner.relay.backfill_viewers(&session_id, &samples, &now)
        });
    } else {
        logger.warn(format!("Studio: dashboard \"{VIEWERS_LIST}\" failed."));
    }
    if let Ok(snapshot) = backend
        .livestream_request(AUDIENCE_SNAPSHOT, Value::Null)
        .await
    {
        if let Ok(snapshot) = serde_json::from_value::<AudienceSnapshot>(snapshot) {
            if snapshot.session_id == session_id {
                publish_if_changed(&dashboard, &dashboard_tx, |inner| {
                    inner.relay.audience(snapshot, &now)
                });
            }
        }
    }
    read_dashboard_totals(backend.as_ref(), &dashboard, &dashboard_tx, &session_id).await;
}

/// `sessions.comments.totals` for the session still on the dashboard.
async fn read_dashboard_totals<B: StudioBackend>(
    backend: &B,
    dashboard: &Arc<Mutex<DashboardInner>>,
    dashboard_tx: &watch::Sender<LiveDashboard>,
    session_id: &str,
) {
    let Ok(totals) = backend
        .livestream_request(COMMENTS_TOTALS, json!({ "sessionId": session_id }))
        .await
    else {
        return;
    };
    let Ok(totals) = serde_json::from_value::<SessionChatTotals>(totals) else {
        return;
    };
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    publish_if_changed(dashboard, dashboard_tx, |inner| {
        if inner.relay.current().session_id.as_deref() == Some(session_id) {
            inner.relay.chat_totals(totals, &now)
        } else {
            false
        }
    });
}

fn publish_if_changed(
    dashboard: &Arc<Mutex<DashboardInner>>,
    dashboard_tx: &watch::Sender<LiveDashboard>,
    edit: impl FnOnce(&mut DashboardInner) -> bool,
) {
    // The clock when the answer lands, not when the backfill began.
    let now_ms = chrono::Utc::now().timestamp_millis();
    let push = {
        let mut inner = dashboard
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let changed = edit(&mut inner);
        if changed {
            schedule_push(dashboard, dashboard_tx, &mut inner, now_ms)
        } else {
            None
        }
    };
    if let Some(state) = push {
        let _ = dashboard_tx.send(state);
    }
}

/// Schedules the relay's state on the coalescer. A trailing push gets a real
/// timer (Electron's `setTimeout(send, wait)`): without one, a second change
/// within a second left the push due forever and the store never moved
/// again.
fn schedule_push(
    dashboard: &Arc<Mutex<DashboardInner>>,
    dashboard_tx: &watch::Sender<LiveDashboard>,
    inner: &mut DashboardInner,
    now_ms: i64,
) -> Option<LiveDashboard> {
    let armed = inner.coalescer.due();
    let state = inner.relay.current().clone();
    let push = inner.coalescer.schedule(state, now_ms);
    if let (None, Some((due, timer))) = (armed, inner.coalescer.due()) {
        arm_push_timer(
            Arc::clone(dashboard),
            dashboard_tx.clone(),
            due - now_ms,
            timer,
        );
    }
    push
}

/// Sleeps until the trailing push is due, then sends it. The lock is never
/// held across the sleep. Without a runtime (a plain unit test) nothing is
/// armed and the test's clock drives `tick_dashboard`.
fn arm_push_timer(
    dashboard: Arc<Mutex<DashboardInner>>,
    dashboard_tx: watch::Sender<LiveDashboard>,
    wait_ms: i64,
    timer: u64,
) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    runtime.spawn(async move {
        let wait = std::time::Duration::from_millis(u64::try_from(wait_ms).unwrap_or(0));
        tokio::time::sleep(wait).await;
        let push = dashboard
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .coalescer
            .fire(timer, chrono::Utc::now().timestamp_millis());
        if let Some(state) = push {
            let _ = dashboard_tx.send(state);
        }
    });
}

#[cfg(test)]
mod tests;
