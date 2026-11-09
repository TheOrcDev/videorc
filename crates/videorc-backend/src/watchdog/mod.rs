//! The stream watchdog (plan 223): Videorc sees what viewers see.
//!
//! The backend owns the alerts (D2). Once a second while the session
//! streams, from the session's `audio.levels` task, the runtime gathers the
//! signals that already exist (the master mix, the applied mute, the
//! encoder's stall notices, plan 161's destination states, the platforms'
//! answers, the runner's `program` block, chat) and runs the checks. Every
//! transition becomes a health event, the `watchdog.alerts` event, and for a
//! critical or warning alert a phone push (D2). The renderer draws the cards
//! and asks main for the system notification; a hidden renderer never
//! silences a check.
//!
//! A record-only session never ticks (plan 221 Q7: "warn while only
//! recording: not in v1"); the one check it keeps is the 1064 microphone
//! silence report, which the recording's own sampler sends in. The tick
//! itself touches no lock but the watchdog's and reads no database: the
//! takeover it guards on is a cache the Screens transition refreshes.

pub mod alerts;
pub mod chat_signals;
pub mod checks;
pub mod luma;
pub mod push;
pub mod settings;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::protocol::{HealthLevel, StreamScreen, StreamScreenStatus};
use crate::state::AppState;
use crate::streaming::{StreamTargetRuntime, StreamTargetState};

pub use alerts::{
    AlertSeverity, SnoozeScope, Transition, WatchdogAlert, WatchdogCheck, WatchdogState,
};
pub use checks::{
    AudioWindow, ChatDecision, CloudSignal, DestinationPhase, DestinationSignal,
    PlatformHealthKind, PlatformHealthSignal, Signals, TakeoverSignal, Thresholds,
};
pub use settings::{WatchdogSettings, WatchdogSettingsPatch};

pub type WatchdogSlot = Arc<Mutex<WatchdogRuntime>>;

/// Plan 223 A4, A9: Kick has no health API; its liveness alert counts
/// `is_live` misses after once live. How fast that flips after the ingest
/// drops is UNVERIFIED, so the alert waits for A9's measurement (a live
/// Kick test with the owner) before it ships: off until then.
pub const KICK_LIVENESS_ALERTS: bool = false;
/// Misses in a row (60 s polls) before Kick reads as offline, once on.
pub const KICK_LIVENESS_MISSES: u32 = 3;

/// The `watchdog.alerts` event and the `watchdog.alerts.list` answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogAlertsView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub alerts: Vec<WatchdogAlert>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertIdParams {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertSnoozeParams {
    pub id: String,
    pub scope: SnoozeScope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleReportParams {
    pub idle_seconds: u64,
}

/// What the session's own facts look like to the tick, gathered under the
/// recording lock by the caller and handed over without it.
#[derive(Debug, Clone, Default)]
pub struct SessionFacts {
    pub live: bool,
    pub mic_muted: bool,
    pub targets: Vec<StreamTargetRuntime>,
    /// The runner's legs carry this session (a cloud show).
    pub cloud_show: bool,
    pub cloud: Option<CloudSignal>,
    pub takeover: Option<(String, String)>,
}

/// The per-session watch.
struct SessionWatch {
    session_id: String,
    started: Instant,
    /// The session streams (set by the tick; the 1064 adoption reads it).
    live: bool,
    state: WatchdogState,
    checks: checks::Checks,
    window: AudioWindow,
    stream_stalled_since: Option<Instant>,
    render_stalled_since: Option<Instant>,
    screen_degraded: bool,
    bitrate_floor_since: Option<Instant>,
    black_since: Option<Instant>,
    last_luma_at: Option<Instant>,
    destination_since: BTreeMap<String, (DestinationPhase, Instant)>,
    platform_health: BTreeMap<String, PlatformHealthSignal>,
    chat: chat_signals::ChatWindow,
    takeover: Option<ActiveTakeover>,
    push: push::PushLedger,
    ai_refused: bool,
    last_view: Option<WatchdogAlertsView>,
}

#[derive(Debug, Clone)]
struct ActiveTakeover {
    screen_id: String,
    since: Instant,
    activated_at: chrono::DateTime<chrono::Utc>,
    luma: Option<u8>,
}

impl SessionWatch {
    fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            started: Instant::now(),
            live: false,
            state: WatchdogState::new(),
            checks: checks::Checks::new(),
            window: AudioWindow::default(),
            stream_stalled_since: None,
            render_stalled_since: None,
            screen_degraded: false,
            bitrate_floor_since: None,
            black_since: None,
            last_luma_at: None,
            destination_since: BTreeMap::new(),
            platform_health: BTreeMap::new(),
            chat: chat_signals::ChatWindow::new(),
            takeover: None,
            push: push::PushLedger::default(),
            ai_refused: false,
            last_view: None,
        }
    }

    fn view(&self) -> WatchdogAlertsView {
        WatchdogAlertsView {
            session_id: Some(self.session_id.clone()),
            alerts: self.state.alerts(),
        }
    }
}

pub struct WatchdogRuntime {
    pub settings: WatchdogSettings,
    thresholds: Thresholds,
    session: Option<SessionWatch>,
    /// The renderer's last `watchdog.idle.report`, and when it arrived.
    system_idle: Option<(Duration, Instant)>,
    /// The active takeover (screen id, image path) as the Screens
    /// transition last applied it: seeded from the store at startup and
    /// refreshed by `observe_takeover`, so the tick never reads SQLite on
    /// a runtime thread.
    takeover: Option<(String, String)>,
}

impl WatchdogRuntime {
    pub fn new(settings: WatchdogSettings, takeover: Option<(String, String)>) -> Self {
        let thresholds = thresholds_for(&settings);
        Self {
            settings,
            thresholds,
            session: None,
            system_idle: None,
            takeover,
        }
    }

    pub fn view(&self) -> WatchdogAlertsView {
        self.session
            .as_ref()
            .map(SessionWatch::view)
            .unwrap_or_default()
    }

    fn watch_mut(&mut self, session_id: &str) -> Option<&mut SessionWatch> {
        self.session
            .as_mut()
            .filter(|watch| watch.session_id == session_id)
    }

    fn watch_or_start(&mut self, session_id: &str) -> &mut SessionWatch {
        if self
            .session
            .as_ref()
            .is_none_or(|watch| watch.session_id != session_id)
        {
            self.session = Some(SessionWatch::new(session_id));
        }
        self.session.as_mut().expect("just set")
    }
}

fn thresholds_for(settings: &WatchdogSettings) -> Thresholds {
    Thresholds::defaults(settings).with_overrides(crate::compositor::packaged_build(), |name| {
        std::env::var(name).ok()
    })
}

pub fn new_slot(settings: WatchdogSettings, takeover: Option<(String, String)>) -> WatchdogSlot {
    Arc::new(Mutex::new(WatchdogRuntime::new(settings, takeover)))
}

/// The persisted active takeover, read once at startup to seed the cache;
/// from then on `observe_takeover` keeps it current.
pub fn load_takeover(database: &crate::storage::Database) -> Option<(String, String)> {
    match database.active_stream_screen() {
        Ok(screen) => takeover_of(screen.as_ref()),
        Err(error) => {
            tracing::warn!("Could not read the active Screen for the watchdog: {error:#}");
            None
        }
    }
}

/// A takeover the viewers see: a Ready screen with an image. A missing or
/// retired screen draws nothing, so it guards nothing.
fn takeover_of(screen: Option<&StreamScreen>) -> Option<(String, String)> {
    screen
        .filter(|screen| {
            screen.status == StreamScreenStatus::Ready && !screen.image_path.is_empty()
        })
        .map(|screen| (screen.id.clone(), screen.image_path.clone()))
}

pub fn load_settings(database: &crate::storage::Database) -> WatchdogSettings {
    match database.load_setting::<WatchdogSettings>(settings::WATCHDOG_SETTINGS_KEY) {
        Ok(Some(settings)) => settings.normalized(),
        Ok(None) => WatchdogSettings::default(),
        Err(error) => {
            tracing::warn!("Could not load the watchdog settings: {error:#}");
            WatchdogSettings::default()
        }
    }
}

fn lock(slot: &WatchdogSlot) -> std::sync::MutexGuard<'_, WatchdogRuntime> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// --- Settings -------------------------------------------------------------

pub fn get_settings(state: &AppState) -> WatchdogSettings {
    lock(&state.watchdog).settings.clone()
}

pub fn set_settings(
    state: &AppState,
    patch: WatchdogSettingsPatch,
) -> Result<WatchdogSettings, String> {
    let next = {
        let runtime = lock(&state.watchdog);
        runtime.settings.apply(patch)?
    };
    state
        .database
        .save_setting(settings::WATCHDOG_SETTINGS_KEY, &next)
        .map_err(|error| format!("Could not save the watchdog settings: {error:#}"))?;
    let mut runtime = lock(&state.watchdog);
    runtime.thresholds = thresholds_for(&next);
    runtime.settings = next.clone();
    Ok(next)
}

// --- Observations ---------------------------------------------------------

/// The Screens transition applied this takeover to the output (main.rs
/// `apply_active_screen_output`: activate, clear, delete, retire, and the
/// rollback of a failed persist). The tick reads this cache instead of the
/// store.
pub fn observe_takeover(state: &AppState, screen: Option<&StreamScreen>) {
    lock(&state.watchdog).takeover = takeover_of(screen);
}

/// The cached active takeover: (screen id, image path).
pub fn takeover_snapshot(state: &AppState) -> Option<(String, String)> {
    lock(&state.watchdog).takeover.clone()
}

/// Every 50 ms from the session's `audio.levels` sampler while it streams:
/// the loudest reading of each line this second.
pub fn observe_levels(
    state: &AppState,
    session_id: &str,
    levels: &crate::session_audio::BusLevels,
) {
    let mut runtime = lock(&state.watchdog);
    let watch = runtime.watch_or_start(session_id);
    let loudest = |slot: &mut Option<f32>, reading: Option<&crate::protocol::AudioLevelReading>| {
        if let Some(reading) = reading {
            *slot = Some(slot.map_or(reading.rms_db, |current| current.max(reading.rms_db)));
        }
    };
    loudest(&mut watch.window.master_rms_db, levels.master.as_ref());
    loudest(
        &mut watch.window.microphone_rms_db,
        levels.microphone.as_ref(),
    );
    loudest(&mut watch.window.bed_rms_db, levels.system_audio.as_ref());
    loudest(&mut watch.window.bed_rms_db, levels.sounds.as_ref());
}

/// Every health event passes here (from `recording::emit_health_event`):
/// the encoder's stall and bitrate notices and the 1064 silence watchdog
/// are signals; the watchdog's own events are not.
pub fn observe_health_event(state: &AppState, session_id: Option<&str>, code: &str, message: &str) {
    if code.starts_with("watchdog-") {
        return;
    }
    let Some(session_id) = session_id else {
        return;
    };
    let now = Instant::now();
    let announce = {
        let mut runtime = lock(&state.watchdog);
        // Issue 1064: the microphone's silence report is adopted for every
        // session, a record-only one too. That session never ticks (plan
        // 221 Q7), so the report starts its watch; a live session's watch
        // already exists, and a stale report never replaces another
        // session's.
        let watch = match code {
            crate::recording::MICROPHONE_SILENT_CODE if runtime.session.is_none() => {
                runtime.watch_or_start(session_id)
            }
            _ => match runtime.watch_mut(session_id) {
                Some(watch) => watch,
                None => return,
            },
        };
        match code {
            crate::encoder_bridge::STREAM_OUTPUT_STALLED_CODE => {
                // The notice fires once the stall is 2 s old (eb:134).
                watch
                    .stream_stalled_since
                    .get_or_insert(now - Duration::from_secs(2));
                Vec::new()
            }
            crate::encoder_bridge::STREAM_OUTPUT_RESUMED_CODE => {
                watch.stream_stalled_since = None;
                Vec::new()
            }
            crate::encoder_bridge::STREAM_BITRATE_FLOOR_CODE => {
                watch.bitrate_floor_since.get_or_insert(now);
                Vec::new()
            }
            crate::encoder_bridge::STREAM_BITRATE_RESTORED_CODE => {
                watch.bitrate_floor_since = None;
                Vec::new()
            }
            crate::recording::MICROPHONE_SILENT_CODE => {
                let spec = checks::mic_silent_spec(watch.live, message);
                let key = alerts::alert_key(WatchdogCheck::MicSilent, None);
                watch
                    .state
                    .open(WatchdogCheck::MicSilent, &key, spec, alerts::Clock::now())
                    .into_iter()
                    .collect()
            }
            crate::recording::MICROPHONE_SIGNAL_RECOVERED_CODE => {
                let key = alerts::alert_key(WatchdogCheck::MicSilent, None);
                watch.state.clear(&key).into_iter().collect()
            }
            _ => Vec::new(),
        }
    };
    announce_transitions(state, session_id, announce);
}

/// A capture-health stage changed (compositor.rs): `compositor-render`
/// stalling is a picture that stopped; `screen-delivery` alone is a still
/// screen and only sharpens the detail (D1).
pub fn observe_capture_stage(
    state: &AppState,
    stage: crate::capture_health::CaptureStage,
    degraded: bool,
) {
    let now = Instant::now();
    let mut runtime = lock(&state.watchdog);
    let Some(watch) = runtime.session.as_mut() else {
        return;
    };
    match stage {
        crate::capture_health::CaptureStage::CompositorRender => {
            if degraded {
                // Declared after three 2 s windows; the stall began then.
                watch
                    .render_stalled_since
                    .get_or_insert(now - Duration::from_secs(6));
            } else {
                watch.render_stalled_since = None;
            }
        }
        crate::capture_health::CaptureStage::ScreenDelivery => watch.screen_degraded = degraded,
        crate::capture_health::CaptureStage::CameraDelivery => {}
    }
}

/// A 1 Hz mean-luma sample of the stream leg's program frame (A7).
pub fn observe_program_luma(state: &AppState, luma: u8) {
    let now = Instant::now();
    let mut runtime = lock(&state.watchdog);
    let Some(watch) = runtime.session.as_mut() else {
        return;
    };
    watch.last_luma_at = Some(now);
    if luma < checks::BLACK_LUMA {
        watch.black_since.get_or_insert(now);
    } else {
        watch.black_since = None;
    }
}

/// Whether the stream leg's bridge should sample now (once a second).
pub fn program_luma_due(state: &AppState) -> bool {
    let runtime = lock(&state.watchdog);
    runtime.session.as_ref().is_some_and(|watch| {
        watch
            .last_luma_at
            .is_none_or(|at| at.elapsed() >= Duration::from_secs(1))
    })
}

/// A platform's own word (A4): YouTube's health, X's `ENDED`. `None`
/// withdraws it.
pub fn observe_platform_health(
    state: &AppState,
    session_id: &str,
    target_id: &str,
    signal: Option<PlatformHealthSignal>,
) {
    let mut runtime = lock(&state.watchdog);
    let Some(watch) = runtime.watch_mut(session_id) else {
        return;
    };
    match signal {
        Some(signal) => {
            watch.platform_health.insert(target_id.to_string(), signal);
        }
        None => {
            watch.platform_health.remove(target_id);
        }
    }
}

/// One delivered chat message (B1): the streamer's own and Buddy's never
/// count; everything else goes into the window with its class.
pub fn observe_chat(state: &AppState, message: &crate::live_chat::LiveChatMessage) {
    if message.is_deleted
        || message
            .author_roles
            .iter()
            .chain(message.author_badges.iter())
            .any(|role| role.eq_ignore_ascii_case("broadcaster"))
    {
        return;
    }
    let text = message.message_text.trim();
    if text.is_empty() {
        return;
    }
    let author = match &message.author_id {
        Some(id) => format!(
            "{}:{id}",
            crate::streaming::stream_platform_id(message.platform)
        ),
        None => format!(
            "{}:name:{}",
            crate::streaming::stream_platform_id(message.platform),
            message.author_name
        ),
    };
    let line = chat_signals::ChatLine {
        author,
        text: text.to_string(),
        platform: crate::streaming::stream_platform_id(message.platform).to_string(),
        at: Instant::now(),
        class: chat_signals::match_message(text).map(|found| found.class),
    };
    let mut runtime = lock(&state.watchdog);
    let Some(watch) = runtime.watch_mut(&message.session_id) else {
        return;
    };
    watch.chat.push(line);
}

/// `watchdog.idle.report` from the renderer (main's `powerMonitor`).
pub fn report_system_idle(state: &AppState, idle: Duration) {
    lock(&state.watchdog).system_idle = Some((idle, Instant::now()));
}

/// B2: the AI's answer for this stream's window.
pub fn ai_answered(
    state: &AppState,
    session_id: &str,
    probabilities: &[(chat_signals::ChatClass, f64)],
) {
    let mut runtime = lock(&state.watchdog);
    if let Some(watch) = runtime.watch_mut(session_id) {
        watch.chat.ai_answered(probabilities, Instant::now());
    }
}

fn ai_refused(state: &AppState, session_id: &str) {
    let mut runtime = lock(&state.watchdog);
    if let Some(watch) = runtime.watch_mut(session_id) {
        watch.ai_refused = true;
    }
}

// --- The tick -------------------------------------------------------------

/// Once a second, with the session's facts gathered by the caller.
pub fn tick(state: &AppState, session_id: &str, facts: SessionFacts) {
    let clock = alerts::Clock::now();
    let now = clock.now;
    let (transitions, ai_read, view_changed) = {
        let mut runtime = lock(&state.watchdog);
        let settings = runtime.settings.clone();
        let thresholds = runtime.thresholds.clone();
        let system_idle = runtime
            .system_idle
            .map(|(idle, at)| idle + now.saturating_duration_since(at));
        let watch = runtime.watch_or_start(session_id);
        watch.live = facts.live;

        // The takeover: a new one reads its own image's luma once.
        match facts.takeover.as_ref() {
            Some((screen_id, image_path)) => {
                if watch
                    .takeover
                    .as_ref()
                    .is_none_or(|active| &active.screen_id != screen_id)
                {
                    watch.takeover = Some(ActiveTakeover {
                        screen_id: screen_id.clone(),
                        since: now,
                        activated_at: clock.wall,
                        luma: luma::mean_luma_png(std::path::Path::new(image_path)),
                    });
                }
            }
            None => watch.takeover = None,
        }
        let takeover = watch.takeover.as_ref().map(|active| TakeoverSignal {
            since: active.since,
            activated_at: Some(active.activated_at),
            luma: active.luma,
        });

        // Destinations: the phase and when it began.
        let mut destinations = Vec::new();
        let mut seen = Vec::new();
        for target in &facts.targets {
            if crate::recording::is_cloud_feed_target(&target.target_id)
                || target.state == StreamTargetState::NotConfigured
                || target.state == StreamTargetState::Ready
            {
                continue;
            }
            let phase = match target.state {
                StreamTargetState::Live => DestinationPhase::Live,
                StreamTargetState::Connecting => DestinationPhase::Connecting,
                StreamTargetState::Reconnecting => DestinationPhase::Reconnecting,
                StreamTargetState::Warning => DestinationPhase::NotReceiving,
                StreamTargetState::Failed | StreamTargetState::Stopped => DestinationPhase::Failed,
                StreamTargetState::NotConfigured | StreamTargetState::Ready => {
                    DestinationPhase::Other
                }
            };
            seen.push(target.target_id.clone());
            let since = match watch.destination_since.get(&target.target_id) {
                Some((known, since)) if *known == phase => *since,
                _ => {
                    watch
                        .destination_since
                        .insert(target.target_id.clone(), (phase, now));
                    now
                }
            };
            destinations.push(DestinationSignal {
                target_id: target.target_id.clone(),
                label: target.label.clone(),
                platform: crate::streaming::stream_platform_id(target.platform).to_string(),
                phase,
                since,
                cloud: facts.cloud_show,
                message: target.message.clone(),
            });
        }
        watch.destination_since.retain(|id, _| seen.contains(id));

        let platform_health: Vec<PlatformHealthSignal> =
            watch.platform_health.values().cloned().collect();
        let chat: Vec<ChatDecision> = watch
            .chat
            .decide(now)
            .into_iter()
            .map(|signal| ChatDecision {
                class: signal.class,
                people: signal.people,
                quotes: signal.quotes,
                ai: signal.ai,
            })
            .collect();
        // A luma sample older than three seconds no longer says black.
        if watch
            .last_luma_at
            .is_none_or(|at| now.saturating_duration_since(at) > Duration::from_secs(3))
        {
            watch.black_since = None;
        }

        let window = std::mem::take(&mut watch.window);
        let signals = Signals {
            live: facts.live,
            session_age: now.saturating_duration_since(watch.started),
            mic_muted: facts.mic_muted,
            takeover,
            audio: window,
            stream_stalled_since: watch.stream_stalled_since,
            render_stalled_since: watch.render_stalled_since,
            screen_still: watch.screen_degraded,
            black_since: watch.black_since,
            bitrate_floor_since: watch.bitrate_floor_since,
            destinations: &destinations,
            platform_health: &platform_health,
            cloud: facts.cloud,
            system_idle,
            chat: &chat,
        };
        let transitions =
            watch
                .checks
                .tick(&signals, &thresholds, &settings, &mut watch.state, clock);

        // B2: the AI read, when the free match saw a candidate.
        let ai_read = if facts.live
            && settings.ai_chat_read
            && !watch.ai_refused
            && crate::cohost::premium_entitled()
        {
            watch.chat.ai_read_due(now).map(|lines| {
                let mut authors: Vec<String> = Vec::new();
                lines
                    .iter()
                    .map(|line| {
                        let author = match authors.iter().position(|known| known == &line.author) {
                            Some(index) => index,
                            None => {
                                authors.push(line.author.clone());
                                authors.len() - 1
                            }
                        };
                        json!({
                            "author": author.min(chat_signals::AI_READ_MESSAGES - 1),
                            "platform": line.platform,
                            "text": truncate_chars(&line.text, 500),
                        })
                    })
                    .collect::<Vec<_>>()
            })
        } else {
            None
        };

        let view = watch.view();
        let view_changed = watch.last_view.as_ref() != Some(&view);
        if view_changed {
            watch.last_view = Some(view);
        }
        (transitions, ai_read, view_changed)
    };
    announce_transitions_with_view(state, session_id, transitions, view_changed);
    if let Some(messages) = ai_read {
        spawn_ai_read(state.clone(), session_id.to_string(), messages);
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The session is gone: its alerts die with it (history is persisted).
pub fn session_ended(state: &AppState, session_id: &str) {
    let ended = {
        let mut runtime = lock(&state.watchdog);
        match runtime.session.as_ref() {
            Some(watch) if watch.session_id == session_id => {
                runtime.session = None;
                true
            }
            _ => false,
        }
    };
    if ended {
        state.emit_event("watchdog.alerts", WatchdogAlertsView::default());
    }
}

/// Whether this session has a watch (a tick or a 1064 report started it).
#[cfg(test)]
pub(crate) fn watching(state: &AppState, session_id: &str) -> bool {
    lock(&state.watchdog)
        .session
        .as_ref()
        .is_some_and(|watch| watch.session_id == session_id)
}

/// The takeover the session's watch guards on, as the last tick saw it.
#[cfg(test)]
pub(crate) fn watched_takeover(state: &AppState, session_id: &str) -> Option<String> {
    lock(&state.watchdog)
        .session
        .as_ref()
        .filter(|watch| watch.session_id == session_id)
        .and_then(|watch| watch.takeover.as_ref())
        .map(|active| active.screen_id.clone())
}

// --- RPCs -----------------------------------------------------------------

pub fn alerts_view(state: &AppState) -> WatchdogAlertsView {
    lock(&state.watchdog).view()
}

pub fn acknowledge(state: &AppState, id: &str) -> Result<WatchdogAlertsView, String> {
    let (session_id, transition) = {
        let mut runtime = lock(&state.watchdog);
        let Some(watch) = runtime.session.as_mut() else {
            return Err("No alert is open.".to_string());
        };
        let Some(transition) = watch.state.acknowledge(id) else {
            return Err("That alert is no longer open.".to_string());
        };
        (watch.session_id.clone(), transition)
    };
    announce_transitions(state, &session_id, vec![transition]);
    Ok(alerts_view(state))
}

pub fn snooze(
    state: &AppState,
    id: &str,
    scope: SnoozeScope,
) -> Result<WatchdogAlertsView, String> {
    let (session_id, transition) = {
        let mut runtime = lock(&state.watchdog);
        let Some(watch) = runtime.session.as_mut() else {
            return Err("No alert is open.".to_string());
        };
        let Some(transition) = watch.state.snooze(id, scope, alerts::Clock::now()) else {
            return Err("That alert is no longer open.".to_string());
        };
        (watch.session_id.clone(), transition)
    };
    announce_transitions(state, &session_id, vec![transition]);
    Ok(alerts_view(state))
}

// --- Announcing -----------------------------------------------------------

fn announce_transitions(state: &AppState, session_id: &str, transitions: Vec<Transition>) {
    announce_transitions_with_view(state, session_id, transitions, true);
}

/// Health events (D13), the wire, the push (D2) and Buddy's bubble (D6),
/// all outside the watchdog lock.
fn announce_transitions_with_view(
    state: &AppState,
    session_id: &str,
    transitions: Vec<Transition>,
    emit_view: bool,
) {
    for transition in &transitions {
        if let Some(code) = alerts::health_code(transition) {
            let alert = transition.alert();
            let level = match transition {
                Transition::Opened(_) => match alert.severity {
                    AlertSeverity::Critical => HealthLevel::Error,
                    AlertSeverity::Warning | AlertSeverity::Notice => HealthLevel::Warn,
                },
                _ => HealthLevel::Info,
            };
            let message = match transition {
                Transition::Cleared(_) => alerts::cleared_toast(alert),
                _ => format!("{}. {}", alert.title.trim_end_matches('.'), alert.detail),
            };
            let _ = crate::recording::emit_health_event(
                state,
                Some(session_id),
                level,
                &code,
                &message,
            );
        }
        if let Transition::Opened(alert) = transition
            && alert.check == WatchdogCheck::ChatSays
            && crate::buddy_overlay::overlay_enabled(state)
        {
            // D6: Buddy may say the card's title in its bubble, never a post.
            let say_state = state.clone();
            let params = crate::protocol::CohostSayParams {
                session_id: String::new(),
                text: alert.title.clone(),
                state: None,
            };
            tokio::spawn(async move {
                let _ = crate::cohost::say_utterance(&say_state, params).await;
            });
        }
        if let Some(body) = push::notify_body(transition) {
            spawn_push(state.clone(), session_id.to_string(), body);
        }
    }
    if emit_view || !transitions.is_empty() {
        let view = alerts_view(state);
        state.emit_event("watchdog.alerts", view);
    }
}

fn spawn_push(state: AppState, session_id: String, body: serde_json::Value) {
    let (enabled, already_logged) = {
        let runtime = lock(&state.watchdog);
        let logged = runtime
            .session
            .as_ref()
            .filter(|watch| watch.session_id == session_id)
            .is_some_and(|watch| watch.push.failure_logged);
        (
            push::push_enabled(
                runtime.settings.phone_push,
                crate::cohost::premium_entitled(),
            ),
            logged,
        )
    };
    if !enabled {
        return;
    }
    tokio::spawn(async move {
        let outcome = async {
            let bearer =
                crate::account::stored_session_token().ok_or_else(|| "signed out".to_string())?;
            let client = crate::videorc_api::VideorcApiClient::new()
                .map_err(|error| format!("{error:#}"))?;
            client.post_alert_notify(&bearer, &body).await
        }
        .await;
        match outcome {
            Ok(()) => {
                let mut runtime = lock(&state.watchdog);
                if let Some(watch) = runtime.watch_mut(&session_id) {
                    watch.push.sent += 1;
                }
            }
            Err(problem) => {
                let mut runtime = lock(&state.watchdog);
                if let Some(watch) = runtime.watch_mut(&session_id)
                    && !watch.push.failure_logged
                {
                    watch.push.failure_logged = true;
                    drop(runtime);
                    // Once per stream, in the session log only: the phone is
                    // the fallback, never the primary.
                    let _ = state.database.add_session_log(
                        &session_id,
                        HealthLevel::Warn,
                        "watchdog-push-failed",
                        &format!("The phone alert could not be sent: {problem}"),
                        None,
                    );
                } else if !already_logged {
                    tracing::debug!("watchdog push not sent: {problem}");
                }
            }
        }
    });
}

fn spawn_ai_read(state: AppState, session_id: String, messages: Vec<serde_json::Value>) {
    tokio::spawn(async move {
        use crate::videorc_api::WatchdogChatError;
        let outcome = async {
            let bearer = crate::account::stored_session_token()
                .ok_or_else(|| WatchdogChatError::Other("signed out".to_string()))?;
            let client = crate::videorc_api::VideorcApiClient::new()
                .map_err(|error| WatchdogChatError::Other(format!("{error:#}")))?;
            client
                .post_watchdog_chat(&bearer, &session_id, messages)
                .await
        }
        .await;
        match outcome {
            Ok(probabilities) => ai_answered(&state, &session_id, &probabilities),
            Err(crate::videorc_api::WatchdogChatError::Refused(reason)) => {
                tracing::info!("watchdog chat read is off for this stream: {reason}");
                ai_refused(&state, &session_id);
            }
            Err(crate::videorc_api::WatchdogChatError::Other(problem)) => {
                tracing::debug!("watchdog chat read failed: {problem}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_view_skips_the_session_when_nothing_runs() {
        let view = WatchdogAlertsView::default();
        assert_eq!(
            serde_json::to_value(&view).unwrap(),
            json!({ "alerts": [] })
        );
    }

    /// Plan 223: the fixture the TypeScript contract test reads too. The
    /// wire shape round-trips field for field, an absent field is never
    /// `null`, and the rejected shapes never parse.
    #[test]
    fn shared_watchdog_fixture_round_trips_without_nulls() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../protocol-fixtures/watchdog.json"))
                .unwrap();
        fn no_nulls(value: &serde_json::Value, path: &str) {
            match value {
                serde_json::Value::Null => panic!("{path} is null"),
                serde_json::Value::Object(map) => {
                    for (key, inner) in map {
                        no_nulls(inner, &format!("{path}/{key}"));
                    }
                }
                serde_json::Value::Array(items) => {
                    for (index, inner) in items.iter().enumerate() {
                        no_nulls(inner, &format!("{path}/{index}"));
                    }
                }
                _ => {}
            }
        }
        no_nulls(&fixture, "");
        let alerts: WatchdogAlertsView = serde_json::from_value(fixture["alerts"].clone()).unwrap();
        assert_eq!(alerts.alerts.len(), 3);
        assert_eq!(alerts.alerts[1].source, alerts::AlertSource::Cloud);
        assert_eq!(serde_json::to_value(&alerts).unwrap(), fixture["alerts"]);
        let empty: WatchdogAlertsView =
            serde_json::from_value(fixture["emptyAlerts"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&empty).unwrap(),
            fixture["emptyAlerts"]
        );
        let settings: WatchdogSettings =
            serde_json::from_value(fixture["settings"].clone()).unwrap();
        assert!(!settings.enabled(WatchdogCheck::StillThere));
        assert_eq!(
            serde_json::to_value(&settings).unwrap(),
            fixture["settings"]
        );
        let patch: WatchdogSettingsPatch =
            serde_json::from_value(fixture["settingsPatch"].clone()).unwrap();
        assert_eq!(patch.mic_muted_after_seconds, Some(60));
        let snooze: AlertSnoozeParams =
            serde_json::from_value(fixture["snoozeParams"].clone()).unwrap();
        assert_eq!(snooze.scope, SnoozeScope::TenMinutes);
        let devices: push::AlertDevicesView =
            serde_json::from_value(fixture["devices"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&devices).unwrap(), fixture["devices"]);
        for key in ["program", "frozenProgram"] {
            let program: crate::cloud_show::CloudProgram =
                serde_json::from_value(fixture[key].clone()).unwrap();
            assert_eq!(
                serde_json::to_value(program).unwrap(),
                fixture[key],
                "{key}"
            );
        }
        for (index, rejected) in fixture["rejected"]["alerts"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            assert!(
                serde_json::from_value::<WatchdogAlert>(rejected.clone()).is_err(),
                "rejected alert {index} parsed"
            );
        }
    }

    #[test]
    fn settings_round_trip_the_store() {
        let database = crate::storage::Database::open_in_memory_for_tests();
        assert_eq!(load_settings(&database), WatchdogSettings::default());
        let saved = WatchdogSettings {
            phone_push: false,
            mic_muted_after_seconds: 120,
            ..Default::default()
        };
        database
            .save_setting(settings::WATCHDOG_SETTINGS_KEY, &saved)
            .unwrap();
        assert_eq!(load_settings(&database), saved);
    }

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    fn ready_screen(id: &str, image_path: &str) -> StreamScreen {
        StreamScreen {
            id: id.to_string(),
            name: format!("Screen {id}"),
            image_path: image_path.to_string(),
            thumbnail_path: None,
            sort_order: 1,
            status: StreamScreenStatus::Ready,
            created_at: "2026-11-09T00:00:00Z".to_string(),
            updated_at: "2026-11-09T00:00:00Z".to_string(),
        }
    }

    /// The tick's takeover is the cache the Screens transition fills, and
    /// only a Ready screen with an image counts as one.
    #[tokio::test(flavor = "current_thread")]
    async fn the_takeover_cache_follows_the_screens_transition() {
        let state = test_state();
        assert_eq!(
            takeover_snapshot(&state),
            None,
            "a fresh store has no takeover"
        );

        observe_takeover(&state, Some(&ready_screen("brb", "/tmp/brb.png")));
        assert_eq!(
            takeover_snapshot(&state),
            Some(("brb".to_string(), "/tmp/brb.png".to_string()))
        );

        let mut missing = ready_screen("gone", "");
        missing.status = StreamScreenStatus::Missing;
        observe_takeover(&state, Some(&missing));
        assert_eq!(
            takeover_snapshot(&state),
            None,
            "a missing image draws nothing"
        );

        observe_takeover(&state, Some(&ready_screen("brb", "/tmp/brb.png")));
        observe_takeover(&state, None);
        assert_eq!(takeover_snapshot(&state), None, "clear ends the takeover");
    }

    /// At startup the cache is seeded from the store once, so a takeover
    /// that survives a relaunch guards the first stream's ticks too.
    #[test]
    fn the_takeover_cache_is_seeded_from_the_store_at_startup() {
        let database = crate::storage::Database::open_in_memory_for_tests();
        assert_eq!(load_takeover(&database), None);
        let dir = crate::test_temp_dir::TestTempDir::new("watchdog-takeover");
        let source = dir.join("brb.png");
        std::fs::write(&source, b"not a real image").unwrap();
        let screen = database
            .import_screen_image_with_optimizer(source.to_str().unwrap(), |_, destination| {
                std::fs::write(destination, b"optimized").unwrap();
                Ok(())
            })
            .unwrap();
        database.activate_stream_screen(&screen.id).unwrap();
        let seeded = load_takeover(&database).expect("the active screen seeds the cache");
        assert_eq!(seeded.0, screen.id);
        assert_eq!(seeded.1, screen.image_path);
        database.clear_active_stream_screen().unwrap();
        assert_eq!(load_takeover(&database), None);
    }

    /// Issue 1064 on a record-only session: no tick ever starts its watch
    /// (plan 221 Q7), so the microphone's silence report starts one with the
    /// recording's wording, the recovery clears it, and a report naming
    /// another session never replaces the watch.
    #[tokio::test(flavor = "current_thread")]
    async fn a_record_only_mic_silent_report_opens_and_clears_without_a_tick() {
        let state = test_state();
        assert!(!watching(&state, "take"));
        observe_health_event(
            &state,
            Some("take"),
            crate::recording::MICROPHONE_SILENT_CODE,
            "The microphone has been silent for 20 seconds.",
        );
        let view = alerts_view(&state);
        assert_eq!(view.session_id.as_deref(), Some("take"));
        assert_eq!(view.alerts.len(), 1);
        assert_eq!(view.alerts[0].check, WatchdogCheck::MicSilent);
        assert_eq!(
            view.alerts[0].title,
            "Your microphone is silent in the recording"
        );

        observe_health_event(
            &state,
            Some("other"),
            crate::recording::MICROPHONE_SILENT_CODE,
            "stale",
        );
        assert!(
            watching(&state, "take"),
            "a stale report never replaces the watch"
        );
        assert!(!watching(&state, "other"));

        observe_health_event(
            &state,
            Some("take"),
            crate::recording::MICROPHONE_SIGNAL_RECOVERED_CODE,
            "Sound is back.",
        );
        assert!(alerts_view(&state).alerts.is_empty());

        session_ended(&state, "take");
        assert!(!watching(&state, "take"));
    }
}
