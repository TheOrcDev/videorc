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
//! itself touches no lock but the watchdog's, reads no database and decodes
//! no image: the takeover it guards on is a cache the Screens transition
//! refreshes, with the image's mean luma (the dark-takeover guard) read
//! there, off the runtime, and kept beside the path.

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
/// A platform's word (A4) ages out after three missed 60 s polls plus a
/// poll's own timeout (L6): a watch that stopped answering (live chat
/// stopped mid-stream, a token that died) no longer holds its card open
/// for the rest of the stream.
pub const PLATFORM_HEALTH_STALE_AFTER: Duration = Duration::from_secs(3 * 60 + 30);

/// The `watchdog.alerts` event and the `watchdog.alerts.list` answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogAlertsView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub alerts: Vec<WatchdogAlert>,
    /// Ids that left the list in this update without a recovery (M2): a
    /// fold, a replace, the session's end. The renderer drops their toasts
    /// instead of saying "is back". Only on the event, never in the RPC's
    /// answer; absent when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub withdrawn: Vec<String>,
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
    pub takeover: Option<CachedTakeover>,
}

/// The active takeover as the Screens transition last applied it: the
/// screen, its image, and the image's mean luma (D10's dark-takeover
/// guard), decoded once there and never on the tick. `luma` is None when
/// the image did not decode; the guard then never suppresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedTakeover {
    pub screen_id: String,
    pub image_path: String,
    pub luma: Option<u8>,
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
    /// The platforms' words, with when each last arrived (L6).
    platform_health: BTreeMap<String, (PlatformHealthSignal, Instant)>,
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
            withdrawn: Vec::new(),
        }
    }
}

pub struct WatchdogRuntime {
    pub settings: WatchdogSettings,
    thresholds: Thresholds,
    session: Option<SessionWatch>,
    /// The renderer's last `watchdog.idle.report`, and when it arrived.
    system_idle: Option<(Duration, Instant)>,
    /// The active takeover as the Screens transition last applied it, with
    /// its image's luma: seeded from the store at startup and refreshed by
    /// `observe_takeover`, so the tick never reads SQLite or decodes a PNG
    /// on a runtime thread.
    takeover: Option<CachedTakeover>,
}

impl WatchdogRuntime {
    pub fn new(settings: WatchdogSettings, takeover: Option<CachedTakeover>) -> Self {
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

pub fn new_slot(settings: WatchdogSettings, takeover: Option<CachedTakeover>) -> WatchdogSlot {
    Arc::new(Mutex::new(WatchdogRuntime::new(settings, takeover)))
}

/// The persisted active takeover, read once at startup to seed the cache
/// (its image decoded once there too, before the runtime serves anything);
/// from then on `observe_takeover` keeps it current.
pub fn load_takeover(database: &crate::storage::Database) -> Option<CachedTakeover> {
    match database.active_stream_screen() {
        Ok(screen) => takeover_of(screen.as_ref()).map(|(screen_id, image_path)| {
            let luma = luma::mean_luma_png(std::path::Path::new(&image_path));
            CachedTakeover {
                screen_id,
                image_path,
                luma,
            }
        }),
        Err(error) => {
            tracing::warn!("Could not read the active Screen for the watchdog: {error:#}");
            None
        }
    }
}

/// The image a takeover draws, when it draws one (a Ready screen with an
/// image); what `read_takeover_luma` decodes.
pub fn takeover_image_path(screen: Option<&StreamScreen>) -> Option<String> {
    takeover_of(screen).map(|(_, image_path)| image_path)
}

/// The mean luma of a takeover's image, decoded on a blocking thread (a
/// 4K PNG is tens of milliseconds), for the cache `observe_takeover` fills.
/// None when the image does not decode: the guard then never suppresses.
pub async fn read_takeover_luma(image_path: String) -> Option<u8> {
    tokio::task::spawn_blocking(move || luma::mean_luma_png(std::path::Path::new(&image_path)))
        .await
        .ok()
        .flatten()
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
/// rollback of a failed persist), with the image's luma it read through
/// `read_takeover_luma`. The tick reads this cache instead of the store.
pub fn observe_takeover(state: &AppState, screen: Option<&StreamScreen>, luma: Option<u8>) {
    lock(&state.watchdog).takeover =
        takeover_of(screen).map(|(screen_id, image_path)| CachedTakeover {
            screen_id,
            image_path,
            luma,
        });
}

/// The cached active takeover.
pub fn takeover_snapshot(state: &AppState) -> Option<CachedTakeover> {
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
            watch
                .platform_health
                .insert(target_id.to_string(), (signal, Instant::now()));
        }
        None => {
            watch.platform_health.remove(target_id);
        }
    }
}

/// Backdates every platform signal by `by` (the ageing test).
#[cfg(test)]
pub(crate) fn age_platform_health(state: &AppState, session_id: &str, by: Duration) {
    let mut runtime = lock(&state.watchdog);
    if let Some(watch) = runtime.watch_mut(session_id) {
        for (_, at) in watch.platform_health.values_mut() {
            *at = at.checked_sub(by).unwrap_or(*at);
        }
    }
}

/// One delivered chat message (B1): the streamer's own and Buddy's never
/// count; everything else goes into the window with its class.
pub fn observe_chat(state: &AppState, message: &crate::live_chat::LiveChatMessage) {
    if message.is_deleted || is_streamers_own_row(message) {
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

/// The streamer's own row: the connectors normalize the broadcaster to the
/// `owner` role (YouTube's chat owner, Twitch's and Kick's broadcaster
/// badge, X's host); `broadcaster` is kept for a raw badge or an older
/// row, as `cohost_greetings` and `community_service` read it.
fn is_streamers_own_row(message: &crate::live_chat::LiveChatMessage) -> bool {
    message
        .author_roles
        .iter()
        .chain(message.author_badges.iter())
        .any(|role| {
            matches!(
                role.trim().to_ascii_lowercase().as_str(),
                "owner" | "broadcaster"
            )
        })
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

        // The takeover: a new screen starts its clock; the luma is the
        // cache's (decoded by the Screens transition, M4), read every tick
        // so a direct A→B switch guards on B's image (M3).
        match facts.takeover.as_ref() {
            Some(cached) => match watch.takeover.as_mut() {
                Some(active) if active.screen_id == cached.screen_id => {
                    active.luma = cached.luma;
                }
                _ => {
                    watch.takeover = Some(ActiveTakeover {
                        screen_id: cached.screen_id.clone(),
                        since: now,
                        activated_at: clock.wall,
                        luma: cached.luma,
                    });
                }
            },
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

        // L6: a platform's word that stopped arriving no longer holds its
        // card; the card leaves quietly (nothing said it was fine).
        let mut transitions = Vec::new();
        let stale: Vec<String> = watch
            .platform_health
            .iter()
            .filter(|(_, (_, at))| now.saturating_duration_since(*at) > PLATFORM_HEALTH_STALE_AFTER)
            .map(|(target, _)| target.clone())
            .collect();
        for target in stale {
            watch.platform_health.remove(&target);
            transitions.extend(watch.state.withdraw(&alerts::alert_key(
                WatchdogCheck::PlatformHealth,
                Some(&target),
            )));
        }
        let platform_health: Vec<PlatformHealthSignal> = watch
            .platform_health
            .values()
            .map(|(signal, _)| signal.clone())
            .collect();
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
        transitions.extend(watch.checks.tick(
            &signals,
            &thresholds,
            &settings,
            &mut watch.state,
            clock,
        ));

        // B2: the AI read, when the free match saw a candidate.
        let ai_read = if facts.live
            && settings.ai_chat_read
            && !watch.ai_refused
            && crate::cohost::premium_entitled()
        {
            watch
                .chat
                .ai_read_due(now)
                .map(|lines| ai_read_messages(&lines))
                .filter(|messages| !messages.is_empty())
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

/// The web's chat platforms (`COHOST_PLATFORMS` in `lib/ai/cohost.ts`):
/// the strict request schema refuses any other.
const AI_READ_PLATFORMS: [&str; 4] = ["twitch", "youtube", "x", "kick"];
/// The web's `MAX_WATCHDOG_CHAT_TEXT_CHARS`.
const AI_READ_TEXT_CHARS: usize = 500;

/// The AI read's `messages` (B2), exactly the web's strict
/// `watchdogChatMessageSchema`: the text (trimmed, never empty, at most
/// 500 chars), the platform (one the web knows) and a per-call author
/// index (0 to 19; the same number is the same person in this call only),
/// never an id or a name; the last 20 lines at most, oldest first.
pub(crate) fn ai_read_messages(lines: &[&chat_signals::ChatLine]) -> Vec<serde_json::Value> {
    let kept: Vec<&&chat_signals::ChatLine> = lines
        .iter()
        .filter(|line| AI_READ_PLATFORMS.contains(&line.platform.as_str()))
        .filter(|line| !line.text.trim().is_empty())
        .collect();
    let start = kept.len().saturating_sub(chat_signals::AI_READ_MESSAGES);
    let mut authors: Vec<&str> = Vec::new();
    kept[start..]
        .iter()
        .map(|line| {
            let author = match authors.iter().position(|known| *known == line.author) {
                Some(index) => index,
                None => {
                    authors.push(&line.author);
                    authors.len() - 1
                }
            };
            json!({
                "author": author.min(chat_signals::AI_READ_MESSAGES - 1),
                "platform": line.platform,
                "text": truncate_chars(line.text.trim(), AI_READ_TEXT_CHARS),
            })
        })
        .collect()
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The session is gone: its alerts die with it, withdrawn, never "back"
/// (history is persisted: an info event closes each row).
pub fn session_ended(state: &AppState, session_id: &str) {
    let withdrawn = {
        let mut runtime = lock(&state.watchdog);
        match runtime.session.as_mut() {
            Some(watch) if watch.session_id == session_id => {
                let withdrawn = watch.state.withdraw_all();
                runtime.session = None;
                Some(withdrawn)
            }
            _ => None,
        }
    };
    if let Some(withdrawn) = withdrawn {
        for transition in &withdrawn {
            if let Some(code) = alerts::health_code(transition) {
                let _ = crate::recording::emit_health_event(
                    state,
                    Some(session_id),
                    HealthLevel::Info,
                    &code,
                    &withdrawn_message(transition.alert()),
                );
            }
        }
        state.emit_event(
            "watchdog.alerts",
            WatchdogAlertsView {
                withdrawn: withdrawn
                    .iter()
                    .map(|transition| transition.alert().id.clone())
                    .collect(),
                ..Default::default()
            },
        );
    }
}

/// The session log's line for a quiet departure (M2): never "is back".
fn withdrawn_message(alert: &WatchdogAlert) -> String {
    format!(
        "{}. Withdrawn without a recovery.",
        alert.title.trim_end_matches('.')
    )
}

/// Whether this session has a watch (a tick or a 1064 report started it).
#[cfg(test)]
pub(crate) fn watching(state: &AppState, session_id: &str) -> bool {
    lock(&state.watchdog)
        .session
        .as_ref()
        .is_some_and(|watch| watch.session_id == session_id)
}

/// How many chat lines the session's window holds (B1's exclusions).
#[cfg(test)]
pub(crate) fn chat_lines(state: &AppState, session_id: &str) -> usize {
    lock(&state.watchdog)
        .session
        .as_ref()
        .filter(|watch| watch.session_id == session_id)
        .map_or(0, |watch| watch.chat.len())
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

/// The luma the session's watch guards on, as the last tick saw it.
#[cfg(test)]
pub(crate) fn watched_takeover_luma(state: &AppState, session_id: &str) -> Option<u8> {
    lock(&state.watchdog)
        .session
        .as_ref()
        .filter(|watch| watch.session_id == session_id)
        .and_then(|watch| watch.takeover.as_ref())
        .and_then(|active| active.luma)
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
    // L5: the phone hears about a stream, never about a recording alone.
    let live = lock(&state.watchdog)
        .session
        .as_ref()
        .is_some_and(|watch| watch.session_id == session_id && watch.live);
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
                Transition::Withdrawn(_) => withdrawn_message(alert),
                // L4: chat quotes stay on the card; the record (the health
                // event, the session log, the support bundle) keeps the
                // count and the class, as the push does.
                _ if alert.check == WatchdogCheck::ChatSays => push::chat_says_record(alert),
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
        if let Some(body) = push::notify_body(transition, live) {
            spawn_push(state.clone(), session_id.to_string(), body);
        }
    }
    if emit_view || !transitions.is_empty() {
        let mut view = alerts_view(state);
        view.withdrawn = transitions
            .iter()
            .filter_map(|transition| match transition {
                Transition::Withdrawn(alert) => Some(alert.id.clone()),
                _ => None,
            })
            .collect();
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
        assert_eq!(alerts.withdrawn, vec!["watchdog:destination-down:twitch:4"]);
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

    /// A `sessions` row, so the health log's foreign key holds and the
    /// tests can read the lines back.
    fn persist_session(state: &AppState, session_id: &str) {
        state
            .database
            .create_session(&crate::storage::NewSession {
                id: session_id.to_string(),
                title: "Watchdog test".to_string(),
                started_at: "2026-11-09T10:00:00Z".to_string(),
                mode: "record+stream".to_string(),
                output_path: Some("/tmp/watchdog-test.mp4".to_string()),
                container: Some("mp4".to_string()),
                stream_preset: None,
                sources: serde_json::from_str("{}").unwrap(),
                layout: crate::protocol::default_layout_settings(),
                output: serde_json::from_value(json!({
                    "recordEnabled": true,
                    "streamEnabled": true,
                    "video": {
                        "preset": "tutorial-1080p30",
                        "width": 1920,
                        "height": 1080,
                        "fps": 30,
                        "bitrateKbps": 6000
                    },
                    "rtmp": { "preset": "custom", "serverUrl": "", "streamKey": "" }
                }))
                .unwrap(),
            })
            .unwrap();
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

        observe_takeover(&state, Some(&ready_screen("brb", "/tmp/brb.png")), Some(30));
        assert_eq!(
            takeover_snapshot(&state),
            Some(CachedTakeover {
                screen_id: "brb".to_string(),
                image_path: "/tmp/brb.png".to_string(),
                luma: Some(30),
            })
        );

        let mut missing = ready_screen("gone", "");
        missing.status = StreamScreenStatus::Missing;
        observe_takeover(&state, Some(&missing), None);
        assert_eq!(
            takeover_snapshot(&state),
            None,
            "a missing image draws nothing"
        );

        observe_takeover(&state, Some(&ready_screen("brb", "/tmp/brb.png")), None);
        observe_takeover(&state, None, None);
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
        assert_eq!(seeded.screen_id, screen.id);
        assert_eq!(seeded.image_path, screen.image_path);
        assert_eq!(seeded.luma, None, "a file that is not an image reads None");
        database.clear_active_stream_screen().unwrap();
        assert_eq!(load_takeover(&database), None);
    }

    /// Plan 223 L8 (the review): the AI read's body against the web's
    /// strict schema (`lib/ai/watchdog-chat.ts`): the five top-level keys
    /// and nothing else, consent `true`, 1 to 20 messages of exactly
    /// `author` (0 to 19), `platform` (twitch, youtube, x, kick) and `text`
    /// (trimmed, 1 to 500 chars); a platform the web does not know and an
    /// empty line never go; the same person keeps one index.
    #[test]
    fn the_ai_read_body_fits_the_webs_strict_schema() {
        let at = Instant::now();
        let line = |author: &str, platform: &str, text: &str| chat_signals::ChatLine {
            author: author.to_string(),
            text: text.to_string(),
            platform: platform.to_string(),
            at,
            class: None,
        };
        let long = "x".repeat(600);
        let mut lines = vec![
            line("twitch:a", "twitch", "  no sound??  "),
            line("youtube:b", "youtube", &long),
            line("custom:c", "custom", "never sent"),
            line("x:d", "x", "   "),
            line("kick:e", "kick", "lag"),
            line("twitch:a", "twitch", "still no sound"),
        ];
        for index in 0..30 {
            lines.push(line(
                &format!("twitch:v{index}"),
                "twitch",
                &format!("line {index}"),
            ));
        }
        let refs: Vec<&chat_signals::ChatLine> = lines.iter().collect();
        let messages = ai_read_messages(&refs);
        assert_eq!(
            messages.len(),
            chat_signals::AI_READ_MESSAGES,
            "the last 20 go"
        );
        let body = crate::videorc_api::watchdog_chat_request("session-1", messages.clone());
        let mut keys: Vec<&String> = body.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "clientVersion",
                "consentToProcessChat",
                "messages",
                "seq",
                "sessionClientId"
            ]
        );
        assert_eq!(body["consentToProcessChat"], json!(true));
        assert_eq!(body["seq"], json!(0));
        let version = body["clientVersion"].as_str().unwrap();
        assert!(!version.trim().is_empty() && version.len() <= 64);
        assert!(body["sessionClientId"].as_str().unwrap().len() <= 128);
        for message in body["messages"].as_array().unwrap() {
            let mut keys: Vec<&String> = message.as_object().unwrap().keys().collect();
            keys.sort();
            assert_eq!(keys, ["author", "platform", "text"]);
            let author = message["author"].as_u64().unwrap();
            assert!(author < chat_signals::AI_READ_MESSAGES as u64);
            assert!(AI_READ_PLATFORMS.contains(&message["platform"].as_str().unwrap()));
            let text = message["text"].as_str().unwrap();
            assert!(!text.is_empty() && text.chars().count() <= 500);
            assert_eq!(text, text.trim());
            assert_ne!(text, "never sent");
        }
        // The window's first six lines, alone: the same person keeps one
        // index, the long line is cut, the unknown platform and the blank
        // line never go.
        let head: Vec<&chat_signals::ChatLine> = lines[..6].iter().collect();
        let messages = ai_read_messages(&head);
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["text"], "no sound??");
        assert_eq!(messages[0]["author"], 0);
        assert_eq!(messages[1]["text"].as_str().unwrap().chars().count(), 500);
        assert_eq!(messages[1]["author"], 1);
        assert_eq!(messages[2]["platform"], "kick");
        assert_eq!(messages[3]["author"], 0, "the same person, the same index");
        assert!(ai_read_messages(&[]).is_empty());
    }

    /// Plan 223 L6 (the review): a platform's word holds its card only
    /// while it keeps arriving; three missed polls later the card leaves,
    /// withdrawn (the platform never said it was fine). A fresh word keeps
    /// it; a withdrawn word (`None`) clears it.
    #[tokio::test(flavor = "current_thread")]
    async fn a_platform_health_card_ages_out_with_its_signal() {
        let state = test_state();
        persist_session(&state, "live");
        let facts = || SessionFacts {
            live: true,
            ..Default::default()
        };
        tick(&state, "live", facts());
        let signal = || PlatformHealthSignal {
            target_id: "youtube".to_string(),
            label: "YouTube".to_string(),
            platform: "youtube".to_string(),
            kind: PlatformHealthKind::NoAudio,
            critical: true,
            description: Some("The stream has no audio.".to_string()),
            dashboard_url: None,
        };
        observe_platform_health(&state, "live", "youtube", Some(signal()));
        tick(&state, "live", facts());
        assert_eq!(alerts_view(&state).alerts.len(), 1);
        assert_eq!(
            alerts_view(&state).alerts[0].check,
            WatchdogCheck::PlatformHealth
        );

        // Two polls late: still fresh.
        age_platform_health(&state, "live", Duration::from_secs(150));
        tick(&state, "live", facts());
        assert_eq!(
            alerts_view(&state).alerts.len(),
            1,
            "two missed polls keep the card"
        );

        // A fresh word resets the age.
        observe_platform_health(&state, "live", "youtube", Some(signal()));
        age_platform_health(&state, "live", Duration::from_secs(150));
        tick(&state, "live", facts());
        assert_eq!(alerts_view(&state).alerts.len(), 1);

        // Past the stale line: withdrawn, not cleared.
        age_platform_health(
            &state,
            "live",
            PLATFORM_HEALTH_STALE_AFTER + Duration::from_secs(1),
        );
        tick(&state, "live", facts());
        assert!(alerts_view(&state).alerts.is_empty(), "the card aged out");
        let codes: Vec<String> = state
            .database
            .list_health_events("live")
            .unwrap()
            .into_iter()
            .map(|event| event.code)
            .collect();
        assert!(
            codes.contains(&"watchdog-platform-health-withdrawn".to_string()),
            "{codes:?}"
        );
        assert!(
            !codes.contains(&"watchdog-platform-health-cleared".to_string()),
            "{codes:?}"
        );

        // The platform says it is fine: a clear.
        observe_platform_health(&state, "live", "youtube", Some(signal()));
        tick(&state, "live", facts());
        observe_platform_health(&state, "live", "youtube", None);
        tick(&state, "live", facts());
        let codes: Vec<String> = state
            .database
            .list_health_events("live")
            .unwrap()
            .into_iter()
            .map(|event| event.code)
            .collect();
        assert!(
            codes.contains(&"watchdog-platform-health-cleared".to_string()),
            "{codes:?}"
        );
        session_ended(&state, "live");
    }

    /// Plan 223 M2 (the review): a quiet departure rides the event as
    /// `withdrawn` and the log as an info `-withdrawn` line, never as a
    /// clear; the session's end withdraws everything the same way.
    #[tokio::test(flavor = "current_thread")]
    async fn a_withdrawal_rides_the_event_and_the_log_and_never_reads_as_a_clear() {
        let state = test_state();
        persist_session(&state, "live");
        let mut events = state.events.subscribe();
        tick(
            &state,
            "live",
            SessionFacts {
                live: true,
                ..Default::default()
            },
        );
        observe_health_event(
            &state,
            Some("live"),
            crate::recording::MICROPHONE_SILENT_CODE,
            "The microphone has been silent for 20 seconds.",
        );
        let id = alerts_view(&state).alerts[0].id.clone();
        session_ended(&state, "live");
        let mut saw_withdrawn = false;
        while let Ok(event) = events.try_recv() {
            if event.event == "watchdog.alerts" && event.payload["withdrawn"] == json!([id.clone()])
            {
                saw_withdrawn = true;
                assert_eq!(event.payload["alerts"], json!([]));
            }
            assert_ne!(
                event.payload["code"],
                json!("watchdog-mic-silent-cleared"),
                "the session's end is not a recovery"
            );
        }
        assert!(saw_withdrawn, "the empty view names the withdrawn id");
        let events = state.database.list_health_events("live").unwrap();
        let codes: Vec<&str> = events.iter().map(|event| event.code.as_str()).collect();
        assert!(
            codes.contains(&"watchdog-mic-silent-withdrawn"),
            "{codes:?}"
        );
        assert!(!codes.contains(&"watchdog-mic-silent-cleared"), "{codes:?}");
        let withdrawn = events
            .iter()
            .find(|event| event.code == "watchdog-mic-silent-withdrawn")
            .unwrap();
        assert!(matches!(withdrawn.level, HealthLevel::Info));
        assert!(withdrawn.message.ends_with("Withdrawn without a recovery."));
    }

    /// Plan 223 M4 (the review): the takeover's luma is decoded off the
    /// runtime by the Screens transition and travels in the cache; the tick
    /// never opens the file. A switch to another screen brings that
    /// screen's luma (M3).
    #[tokio::test(flavor = "current_thread")]
    async fn the_takeover_luma_is_decoded_once_off_the_tick_and_follows_a_switch() {
        let dir = crate::test_temp_dir::TestTempDir::new("watchdog-takeover-luma");
        let dark = dir.join("dark.png");
        image::RgbaImage::from_pixel(8, 8, image::Rgba([30, 30, 30, 255]))
            .save(&dark)
            .unwrap();
        assert_eq!(
            read_takeover_luma(dark.to_string_lossy().into_owned()).await,
            Some(30)
        );
        assert_eq!(
            read_takeover_luma(dir.join("missing.png").to_string_lossy().into_owned()).await,
            None,
            "a file that does not decode reads None"
        );

        let state = test_state();
        let facts = |takeover: Option<CachedTakeover>| SessionFacts {
            live: true,
            takeover,
            ..Default::default()
        };
        observe_takeover(&state, Some(&ready_screen("a", "/tmp/a.png")), Some(30));
        tick(&state, "live", facts(takeover_snapshot(&state)));
        assert_eq!(watched_takeover(&state, "live").as_deref(), Some("a"));
        assert_eq!(watched_takeover_luma(&state, "live"), Some(30));
        // A direct switch: B's luma, not A's verdict.
        observe_takeover(&state, Some(&ready_screen("b", "/tmp/b.png")), Some(200));
        tick(&state, "live", facts(takeover_snapshot(&state)));
        assert_eq!(watched_takeover(&state, "live").as_deref(), Some("b"));
        assert_eq!(watched_takeover_luma(&state, "live"), Some(200));
        session_ended(&state, "live");
    }

    /// Plan 223 M1 (the review): the streamer's own line never counts, in
    /// the role each connector writes: YouTube's chat owner, Twitch's and
    /// Kick's broadcaster badge (normalized to `owner`, the raw badge kept),
    /// X's host, and the fake echo's `owner`. A raw `broadcaster` on an
    /// older row is excluded too; a moderator's and a viewer's line count.
    #[tokio::test(flavor = "current_thread")]
    async fn the_streamers_own_line_never_counts_on_any_platform() {
        use crate::streaming::StreamPlatform;
        let state = test_state();
        tick(
            &state,
            "live",
            SessionFacts {
                live: true,
                ..Default::default()
            },
        );
        let line = |platform, roles: &[&str], badges: &[&str], text: &str| {
            let mut message = crate::live_chat::fake_message("live", platform, None, 7);
            message.author_roles = roles.iter().map(|role| role.to_string()).collect();
            message.author_badges = badges.iter().map(|badge| badge.to_string()).collect();
            message.message_text = text.to_string();
            message
        };
        let own = [
            (
                "youtube",
                line(
                    StreamPlatform::Youtube,
                    &["owner"],
                    &[],
                    "no sound today, sorry",
                ),
            ),
            (
                "twitch",
                line(
                    StreamPlatform::Twitch,
                    &["owner"],
                    &["broadcaster"],
                    "cant hear u",
                ),
            ),
            (
                "kick",
                line(
                    StreamPlatform::Kick,
                    &["owner", "member"],
                    &["broadcaster"],
                    "no audio",
                ),
            ),
            ("x", line(StreamPlatform::X, &["owner"], &[], "sin audio")),
            (
                "legacy",
                line(StreamPlatform::Twitch, &[" Broadcaster "], &[], "no sound"),
            ),
        ];
        for (shape, message) in &own {
            observe_chat(&state, message);
            assert_eq!(
                chat_lines(&state, "live"),
                0,
                "{shape}: the streamer's own line counted"
            );
        }
        let echo = crate::live_chat::fake_echo_message_for_tests(
            "live",
            StreamPlatform::Twitch,
            "no sound??",
        );
        assert_eq!(echo.author_roles, vec!["owner".to_string()]);
        observe_chat(&state, &echo);
        assert_eq!(
            chat_lines(&state, "live"),
            0,
            "the fake echo is the streamer's own line"
        );

        observe_chat(
            &state,
            &line(StreamPlatform::Youtube, &["moderator"], &[], "no sound??"),
        );
        observe_chat(
            &state,
            &line(StreamPlatform::Kick, &[], &["subscriber"], "cant hear u"),
        );
        assert_eq!(
            chat_lines(&state, "live"),
            2,
            "a moderator's and a viewer's line count"
        );
        session_ended(&state, "live");
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
