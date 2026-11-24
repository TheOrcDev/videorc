//! The Studio's state and view-models without a UI (plan 260 S1.6a, L7),
//! from `videorc-rust`'s app-core Studio, caught up with today's
//! `apps/desktop/src/renderer/src/hooks/use-studio.tsx`.
//!
//! S1.6a lands this area in parts:
//!
//! - [`session`]: the session state machine (idle, starting, recording,
//!   live, stopping, failed), the start and stop flows' pure halves, the
//!   stop door and the failure notices.
//! - [`latency`]: the record click-to-status samples.
//! - [`settings`]: the persisted UI settings (`UiSettingsCache`, the write
//!   journal, `StudioSettings` from `videorc.settings`), with
//!   [`capture_config`] (`lib/capture.ts`'s loader, repairs and writer),
//!   [`families`] (every other key family), [`camera_background`] (plan
//!   258's normalizers), [`js_value`] (JavaScript's value rules the loaders
//!   need) and [`ui_local`] (this device's conveniences). The wire shapes
//!   wait in [`ui_settings_wire`] until L2's S1.4 adds them to the protocol.
//! - [`health`] and [`health_page`]: `health.ping`, the health events and
//!   the Health page's telemetry, checks, verdict and metric groups, with
//!   [`virtual_camera`] (Videorc Camera's words) and [`timecode`]
//!   (`shared/timecode.ts`).
//! - [`start_blocked_copy`] and [`support_bundle_copy`]: the start's and
//!   the support bundle's words. The session's toasts are
//!   [`crate::notices`], a failed action's words [`crate::user_error`].
//! - [`preview_scene`]: the scene reload rule L1's preview feed reads (S1.6s,
//!   L4), and its Studio half (`preview_scene_request`, the camera's look
//!   on the layout).
//! - [`sources`]: the devices and the committed scene as the backend reports
//!   them; [`source_selection`] the pickers, the builders and the reconcile;
//!   [`live_sources`] and [`source_actions`] (S1.6b part 5a) a pick, idle or
//!   inside a session, on plan 231's scenes.
//! - [`scenes`] (S1.6b): plan 231's scene library as the Studio holds it,
//!   read once the settings snapshot is in (the #1706 repair, the v1
//!   migration, the working setup over the capture config, the scene on
//!   stream), named on the main display, and its edits; [`scene_switch`]
//!   (part 3b) switches them (`requestLayoutTransaction`, the saved scene
//!   apply, a layout on the scene on stream, the delete flow).
//! - [`backend`]: the requests the Studio makes, as a trait, so the driver
//!   runs against a scripted fake in tests and the typed client in the app.
//! - [`Studio`]: the driver. It takes the typed client's events, runs the
//!   renderer's bootstrap on every connection (health, devices, status,
//!   scene and settings in parallel, then the recovery of a session that ran
//!   while the Studio was away, then Health's reads), applies events to the
//!   state, and offers the user's intents (Record, Go Live, Stop with its
//!   question, the microphone mute, settings writes, Hide from stream's
//!   capture filter, the support bundle). The whole state is one
//!   [`StudioSnapshot`] behind a `watch`; what the UI must *do* arrives as
//!   [`SessionEffect`]s, and the toasts as [`NoticeCommand`]s.
//!
//! The other areas join the driver as they land (S1.6b to S1.6e): each adds
//! its state to the snapshot, its events to [`STUDIO_EVENTS`] and its reads
//! to the bootstrap. Nothing here knows the UI framework.

pub mod backend;
pub mod camera_background;
pub mod camera_background_migration;
pub mod camera_background_view;
pub mod camera_frame_rate;
pub mod capture_config;
pub mod families;
pub mod health;
pub mod health_page;
pub mod js_value;
pub mod latency;
pub mod linux_desktop;
pub mod live_sources;
pub mod preview_scene;
pub mod scene_editor;
pub mod scene_switch;
pub mod scenes;
pub mod session;
pub mod settings;
pub mod source_actions;
pub mod source_selection;
pub mod sources;
pub mod timecode;
pub mod ui_local;
pub mod ui_settings_wire;
pub mod vertical_stream;
pub mod virtual_camera;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, broadcast, watch};
use videorc_protocol::streaming::StreamingSettings;
use videorc_protocol::{
    ClipMarkedEvent, OutputSettings, PreviewScreenStartParams, PreviewScreenState,
    RecordingFinalizationEvent, RecordingState, RecordingStatus, ReplaySaveFailedEvent,
    ReplaySavedEvent, ReplayStateEvent, SessionDetailListParams, SessionListParams, SessionPurpose,
    SessionStopParams, SourceSelection, StartSessionParams, VideoSettings,
};

use ui_settings_wire::{UiSettingsGetParams, UiSettingsSnapshot};

pub use backend::StudioBackend;
pub use capture_config::CaptureConfigView;
pub use families::UiFamilies;
pub use health::{
    HealthSummary, HealthTelemetry, HealthTone, RECORDING_STOP_FINALIZE_OVERRUN_CODE,
};
pub use latency::{LatencyKind, RecordLatency};
pub use session::{
    RecordingFailedNotice, SessionActivity, SessionEffect, SessionPhase, SessionStartFailure,
    SessionStartFailureKind, SessionStartIntent, SessionState, StopConfirmation, StopExit,
    StopOrigin, StopRequest, session_is_replay_only,
};
pub use settings::{
    CaptureConfig, SettingWrite, SettingsJournal, StudioSettings, UiSettingsCache, keys,
};
pub use sources::{SelectionProblem, SourcesState};

use crate::client::{BackendEvent, RpcError};
use crate::log::Logger;
use crate::notices::{
    self, MicrophoneNotice, NoticeCommand, RuntimeRecovery, SessionContext, SessionNotices,
    StreamTargetsSnapshot,
};

/// `lib/start-blocked-copy.ts`: why a start waits, in the streamer's words
/// (plan 174 B-22).
pub mod start_blocked_copy {
    /// `connectionBlockedReason('waiting' | 'connecting')`.
    pub const ENGINE_STARTING: &str = "Starting Videorc's capture engine…";
    /// `connectionBlockedReason` for every other non-connected status.
    pub const RECONNECTING: &str = "Videorc is reconnecting. Try again in a moment.";
    /// `START_BLOCKED_COPY.sessionRunning`.
    pub const SESSION_RUNNING: &str = "A recording or livestream is already running.";
    /// `START_BLOCKED_COPY.noOutput`.
    pub const NO_OUTPUT: &str = "Turn on Save local recording in Output, or go live.";
    /// `START_BLOCKED_COPY.destinationSetup` (#1357: the page is
    /// Destinations): a destination on that is not ready to start.
    pub const DESTINATION_SETUP: &str =
        "Finish setting up your destination in Destinations before you go live.";
    /// `START_BLOCKED_COPY.noDestination`: a livestream with no destination
    /// turned on.
    pub const NO_DESTINATION: &str = "Turn on a destination in Destinations before you go live.";
    /// `START_BLOCKED_COPY.checkingRecorder`.
    pub const CHECKING_RECORDER: &str = "Checking the recorder…";
    /// `START_BLOCKED_COPY.recorderMissing`.
    pub const RECORDER_MISSING: &str =
        "Videorc's recorder isn't available. Export a support bundle from Health.";
}

/// The support bundle's words (`exportSupportBundle` in `use-studio.tsx`,
/// and `reportError`'s `userErrorMessage` for its failures: `couldNotTitle`
/// and `UNKNOWN_REASON` in `lib/user-error.ts`).
pub mod support_bundle_copy {
    pub const EXPORTED: &str = "Support bundle exported";
    pub const EXPORT_FAILED: &str = "Couldn't export a support bundle";
    pub const REVEAL_FAILED: &str = "Couldn't show the support bundle";
    /// `UNKNOWN_REASON`: the next step when Videorc doesn't know why.
    pub const UNKNOWN_REASON: &str =
        "Try again. If it keeps happening, export a support bundle from Health.";
}

const EFFECT_CHANNEL_CAPACITY: usize = 64;

const NOTICE_CHANNEL_CAPACITY: usize = 64;

/// The events the Studio reads: the include list for its client socket
/// (`backend.ready` always arrives, before any filter). The other areas add
/// theirs as they land (S1.6b to S1.6e).
pub const STUDIO_EVENTS: [&str; 19] = [
    crate::client::names::RECORDING_STATUS,
    crate::client::names::SCENE_CHANGED,
    crate::client::names::DEVICES_CHANGED,
    crate::client::names::HEALTH_EVENT,
    ui_settings_wire::UI_SETTINGS_CHANGED_EVENT,
    crate::client::names::RECORDING_FINALIZATION,
    // The toasts' news.
    crate::client::names::STREAM_TARGETS,
    crate::client::names::REPLAY_STATE,
    crate::client::names::REPLAY_SAVED,
    crate::client::names::REPLAY_SAVE_FAILED,
    crate::client::names::CLIP_MARKED,
    // What the Health page reads.
    health::DIAGNOSTICS_STATS_EVENT,
    health::STREAM_HEALTH_EVENT,
    health::PREVIEW_LIVE_STATUS_EVENT,
    health::PREVIEW_CAMERA_STATUS_EVENT,
    health::PREVIEW_SCREEN_STATUS_EVENT,
    health::PREVIEW_SURFACE_STATUS_EVENT,
    // The mic sliver's bars (its view lands with the Session section).
    AUDIO_LEVELS_EVENT,
    // S1.6b part 5a: the session's sources changed; read them again.
    live_sources::SOURCES_CHANGED_EVENT,
];

/// `agents.stop`, the Session line's Stop.
pub const AGENTS_STOP_METHOD: &str = "agents.stop";
/// The bus's levels, about 20 a second (`audio.levels`).
pub const AUDIO_LEVELS_EVENT: &str = "audio.levels";

/// `requestRemoteMicrophoneMute`'s mode: a deck key's explicit mute or
/// unmute, or its toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicrophoneMode {
    Mute,
    Unmute,
    Toggle,
}

/// How the Studio is set up.
#[derive(Clone)]
pub struct StudioConfig {
    pub logger: Logger,
    /// This window's id on `ui.settings.set`, so its own echo is skipped.
    pub writer_id: String,
    /// S3.0d: where settings writes the store has not confirmed wait, so
    /// they land after a restart too (`AppPaths::ui_settings_journal_file`).
    /// `None` keeps them in memory only.
    pub settings_journal: Option<PathBuf>,
    /// S3.0d: `new Date().toISOString()`, for the timestamps the capture
    /// config's loader gives the default stream cards (tests pin it).
    pub clock: fn() -> String,
    /// S3.0g: the app's version, for the support bundle (`appVersion`;
    /// `None` lets the backend name its own).
    pub app_version: Option<String>,
    /// S3.1c: the reconcile picks no first device for a slot nobody chose
    /// ([`source_selection::ReconcileOptions`]). On by default, so a test or
    /// a harness never opens a real device on its own; the app turns it off
    /// except under the smoke command server.
    pub withhold_device_defaults: bool,
}

impl Default for StudioConfig {
    fn default() -> Self {
        Self {
            logger: Logger::silent(),
            writer_id: format!("studio:{}", uuid::Uuid::new_v4()),
            settings_journal: None,
            clock: now_iso,
            app_version: None,
            withhold_device_defaults: true,
        }
    }
}

/// S3.0d: a settings write the store will not take: the snapshot is not in
/// (a window that rendered past the hydrate deadline read the defaults, and
/// must never write them over the profile).
pub const SETTINGS_NOT_HYDRATED: &str = "ui-settings-not-hydrated";

/// S3.0d: a settings write past the store's limits (`migrationRefusal`).
pub const SETTINGS_REFUSED: &str = "ui-settings-refused";

/// S3.0d: the write is kept and journaled; the engine is away, so it is sent
/// once Videorc answers again.
pub const SETTINGS_PENDING: &str = "ui-settings-pending";

/// Whether a failed settings write still holds: it waits in the journal and
/// lands later (every failure but a refusal or a missing snapshot).
pub fn settings_write_kept(error: &RpcError) -> bool {
    error.code != SETTINGS_NOT_HYDRATED && error.code != SETTINGS_REFUSED
}

/// The connection as the Studio sees it (`wsStatus`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Connection {
    /// No backend yet.
    Waiting,
    Connected {
        pid: u32,
    },
    Disconnected {
        reason: String,
    },
}

/// The session, for the UI.
#[derive(Debug, Clone)]
pub struct SessionView {
    pub phase: SessionPhase,
    pub status: RecordingStatus,
    /// What the running session does, or what the last one did.
    pub activity: SessionActivity,
    pub intent: Option<SessionStartIntent>,
    /// `startRequestPending`: Record and Go Live are disabled.
    pub start_pending: bool,
    /// `stopRequestPending`.
    pub stop_pending: bool,
    pub stop_overrun: bool,
    /// The End livestream question, while it waits.
    pub stop_confirmation: Option<StopConfirmation>,
    /// The refused start, until the next attempt or a dismiss.
    pub start_failure: Option<SessionStartFailure>,
    /// The persistent "stopped unexpectedly" notice.
    pub notice: Option<RecordingFailedNotice>,
    /// S3.0f: the microphone notice (`microphone-input-lost`), while it is
    /// up; the failure outranks it.
    pub microphone_notice: Option<MicrophoneNotice>,
    /// The last `recording.finalization` for the last session: the MP4
    /// export's progress after a stop.
    pub finalization: Option<RecordingFinalizationEvent>,
    /// S3.1a: the destinations the last livestream start went to (the Go
    /// live sheet's are not saved), for the Session section's Livestream row.
    pub live_streaming: Option<StreamingSettings>,
}

/// The persisted settings, as the pages read them (S3.0d).
#[derive(Debug, Clone)]
pub struct SettingsView {
    /// `ui.settings.get` has answered. Before that every value is a default
    /// and no write is taken.
    pub hydrated: bool,
    pub revision: u64,
    pub studio: StudioSettings,
    /// The capture config, typed (the test pattern is this run's switch).
    pub capture: CaptureConfig,
    /// The capture config as the Studio holds it: Electron's `captureConfig`
    /// state, loaded then edited ([`capture_config`]).
    pub capture_doc: Value,
    /// The sections of the capture config that read as their defaults.
    pub capture_issues: Vec<String>,
    /// `videorc.theme` as stored (`dark`, `light`, `system`), `None` for
    /// the default.
    pub theme: Option<String>,
    /// Every other key family.
    pub families: UiFamilies,
    /// Keys with a write the store has not confirmed yet.
    pub pending: Vec<String>,
}

impl Default for SettingsView {
    /// Before the snapshot: every value a default.
    fn default() -> Self {
        let capture = CaptureMemory::new(now_iso);
        Self {
            hydrated: false,
            revision: 0,
            studio: StudioSettings::default(),
            capture: capture.view.config,
            capture_doc: capture.config,
            capture_issues: Vec::new(),
            theme: None,
            families: UiFamilies::default(),
            pending: Vec::new(),
        }
    }
}

/// Plan 220 S2.6c: the backend's capture filter as the Studio drives it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CaptureExclusionView {
    /// The window ids to leave out of Videorc's own captures, as the app's
    /// windows say right now (sorted, no repeats).
    pub wanted: Vec<u32>,
    /// The last list sent with `preview.screen.start`, and the answer.
    pub last: Option<CaptureExclusionAnswer>,
}

/// One `preview.screen.start` that carried the exclusion list.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureExclusionAnswer {
    pub ids: Vec<u32>,
    /// Why it was sent: `"session-start"` (the capture a session is about to
    /// use starts with the list) or `"in-session"` (a running capture takes
    /// the new list in place).
    pub reason: &'static str,
    /// The capture's state after it, or `None` when the request failed.
    pub screen_state: Option<PreviewScreenState>,
    /// The backend's message (it says when the list was applied to the
    /// running capture in place), or the request's error.
    pub message: Option<String>,
}

/// Everything the Studio knows, as one value. The other areas add their
/// state as they land (S1.6b to S1.6e).
#[derive(Debug, Clone)]
pub struct StudioSnapshot {
    pub connection: Connection,
    /// How many times `backend.ready` arrived. A new number is a new
    /// connection, whose backend holds nothing published on the last one.
    pub connection_generation: u64,
    /// The bootstrap reads finished on this connection.
    pub bootstrapped: bool,
    pub session: SessionView,
    pub sources: SourcesState,
    pub health: HealthSummary,
    pub settings: SettingsView,
    /// `lastError`: the last request that failed, as a sentence.
    pub last_error: Option<String>,
    /// Hide from stream through the backend's capture filter.
    pub capture_exclusion: CaptureExclusionView,
    /// The last click-to-status samples (Health's Start and stop).
    pub record_latency: RecordLatency,
    /// S1.6b: the scene library and the scene on stream.
    pub scenes: scenes::ScenesView,
    /// S1.6b part 5a: a source change while a session runs
    /// (`sourceSelectionState`).
    pub live_sources: live_sources::LiveSourcesView,
    /// S1.6b part 5a: why each picker waits (`sourceSwitchReason`): capture,
    /// camera and microphone.
    pub source_reasons: [Option<String>; 3],
}

/// What a start did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartOutcome {
    /// The session runs.
    Started,
    /// The backend refused or the request failed; the reason is in the
    /// snapshot (the status message, or `start_failure`).
    Refused { message: String },
    /// A session is active or a start is in flight.
    Busy,
}

/// S3.1a: a start on its way, and how a second caller hears its answer.
struct InFlightStart {
    intent: SessionStartIntent,
    streaming: Option<StreamingSettings>,
    answer: watch::Receiver<Option<StartOutcome>>,
}

/// Clears the start (or stop) in flight when it ends.
struct ClearInFlight<'a, T>(&'a Mutex<Option<T>>);

impl<T> Drop for ClearInFlight<'_, T> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// What a stop request did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopOutcome {
    /// `session.stop` ran; true when it answered.
    Stopped(bool),
    /// The hotkey is armed for a second press.
    Armed,
    /// The End livestream question waits in the snapshot.
    Confirm(StopConfirmation),
}

struct Inner {
    connection: Connection,
    bootstrapped: bool,
    bootstrap_generation: u64,
    session: SessionState,
    sources: SourcesState,
    health: HealthSummary,
    settings: UiSettingsCache,
    /// The writes the store has not confirmed, and their retry.
    journal: SettingsJournal,
    settings_retry_step: usize,
    settings_retry_due: Option<Instant>,
    /// The capture config as the Studio holds it.
    capture: CaptureMemory,
    /// The other settings views, read again only when the cache changed.
    views: Option<(u64, StudioSettings, UiFamilies)>,
    finalization: Option<RecordingFinalizationEvent>,
    last_error: Option<String>,
    /// The destinations the last livestream start went to (the Go live
    /// sheet's destination is not saved to the capture config), so the End
    /// livestream question names them.
    live_streaming: Option<StreamingSettings>,
    exclusion: Exclusion,
    /// The toasts' memory between events.
    notices: SessionNotices,
    /// The record click-to-status clock.
    latency: latency::LatencyTracker,
    /// S1.6b: the scenes' memory between events.
    scenes: scenes::ScenesCore,
    /// S1.6b part 5a: the live source switch, its proof timer (when, for
    /// which epoch, and whether it counts a proof read), why each picker
    /// waits, and the returned picks already offered (`kind:id`).
    live_sources: live_sources::LiveSources,
    live_due: Option<(Instant, u64, bool)>,
    source_reasons: [Option<String>; 3],
    announced_returns: Vec<String>,
}

/// S2.6c: the exclusion list's bookkeeping.
#[derive(Default)]
struct Exclusion {
    wanted: Vec<u32>,
    /// The list each backend generation (by pid) holds from this Studio: its
    /// screen capture keeps the last list `preview.screen.start` carried and
    /// starts a session's capture with it. A backend that never had one
    /// holds none.
    sent: Option<(u32, Vec<u32>)>,
    /// The sources and video the current session's screen capture started
    /// with (`None` when it captures no screen or window).
    session_capture: Option<(SourceSelection, VideoSettings)>,
    last: Option<CaptureExclusionAnswer>,
}

impl Exclusion {
    fn held_by(&self, pid: u32) -> &[u32] {
        match &self.sent {
            Some((sent_pid, ids)) if *sent_pid == pid => ids,
            _ => &[],
        }
    }
}

/// S3.0d: Electron's `captureConfig` state. Loaded from the store
/// ([`capture_config::load_capture_config`]) and reloaded whenever the
/// stored value changes under it (another writer, a smoke's seed); this
/// Studio's own edits change it in place and store
/// `persistableCaptureConfig` of it, so the edited object (an unclamped value
/// included, as in the renderer) stays what the pages read until the next
/// launch. The test pattern is this run's switch: never stored, it survives
/// a reload.
struct CaptureMemory {
    /// The stored value this config was loaded from or written as (`None`
    /// inside: the key was absent); `None` before the first load.
    seen: Option<Option<Value>>,
    config: Value,
    view: CaptureConfigView,
    clock: fn() -> String,
}

impl CaptureMemory {
    fn new(clock: fn() -> String) -> Self {
        let config = capture_config::load_capture_config(None, &clock());
        Self {
            seen: None,
            view: CaptureConfigView::from_loaded(&config),
            config,
            clock,
        }
    }

    /// Reloads when the stored value is not the one this config came from.
    fn sync(&mut self, stored: Option<&Value>) {
        if self.seen.as_ref().map(Option::as_ref) == Some(stored) {
            return;
        }
        let test_pattern = self.config["sources"]["testPattern"] == Value::Bool(true);
        let mut config = capture_config::load_capture_config(stored, &(self.clock)());
        if test_pattern {
            capture_config::set_path(&mut config, &["sources", "testPattern"], Some(json!(true)));
        }
        self.set(config, stored.cloned());
    }

    fn set(&mut self, config: Value, stored: Option<Value>) {
        self.view = CaptureConfigView::from_loaded(&config);
        self.config = config;
        self.seen = Some(stored);
    }

    /// S1.6b: the config as the Studio holds it, changed without a write
    /// (the working setup laid over it at launch, as the renderer's first
    /// state is): the stored value it came from stays the one it syncs on.
    fn replace_config(&mut self, config: Value) {
        self.view = CaptureConfigView::from_loaded(&config);
        self.config = config;
    }
}

impl Inner {
    /// The settings as the pages read them (the capture config synced with
    /// the store first).
    fn settings_view(&mut self) -> SettingsView {
        self.capture.sync(self.settings.get(keys::CAPTURE_CONFIG));
        // S1.6b: the library, read once the snapshot is in (the working
        // setup laid over the capture config with it).
        self.sync_scenes();
        let generation = self.settings.generation();
        if self.views.as_ref().map(|(seen, ..)| *seen) != Some(generation) {
            self.views = Some((
                generation,
                StudioSettings::load(self.settings.get(keys::SETTINGS)),
                UiFamilies::read(&self.settings),
            ));
        }
        let (_, studio, families) = self.views.clone().expect("set above");
        SettingsView {
            hydrated: self.settings.hydrated(),
            revision: self.settings.revision(),
            studio,
            capture: self.capture.view.config.clone(),
            capture_doc: self.capture.config.clone(),
            capture_issues: self.capture.view.issues.clone(),
            theme: families.theme.clone(),
            families,
            pending: self.journal.keys().into_iter().collect(),
        }
    }

    /// Stages `writes` (S3.0d): refused as a whole before the snapshot is in
    /// or when one is past the store's limits; otherwise each lands in the
    /// cache at once and waits in the journal until the store confirms it.
    fn stage_writes(&mut self, writes: &[SettingWrite], logger: &Logger) -> Result<(), RpcError> {
        if let Some(write) = writes.first()
            && !self.settings.hydrated()
        {
            return Err(RpcError::new(
                "ui.settings.set",
                SETTINGS_NOT_HYDRATED,
                format!(
                    "\"{}\" was not saved: the store has no snapshot yet, so this window's value may be a default.",
                    write.key()
                ),
            ));
        }
        for write in writes {
            let value = match write {
                SettingWrite::Put { value, .. } => Some(value),
                SettingWrite::Delete { .. } => None,
            };
            if let Some(reason) = settings::write_refusal(write.key(), value) {
                return Err(RpcError::new(
                    "ui.settings.set",
                    SETTINGS_REFUSED,
                    format!("UI setting \"{}\" was not saved: {reason}", write.key()),
                ));
            }
        }
        for write in writes {
            match write {
                SettingWrite::Put { key, value } => {
                    self.settings.put_local(key, value.clone());
                    self.journal.put(key, value.clone());
                }
                SettingWrite::Delete { key } => {
                    self.settings.delete_local(key);
                    self.journal.delete(key);
                }
            }
        }
        if let Err(error) = self.journal.save() {
            logger.warn(format!(
                "Studio: could not journal the pending settings writes: {error}"
            ));
        }
        Ok(())
    }
}

/// `new Date().toISOString()`.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A screen or window source: the capture the filter applies to.
fn captures_screen(sources: &SourceSelection) -> bool {
    sources.screen_id.is_some() || sources.window_id.is_some()
}

/// The driver. See the module docs.
pub struct Studio<B: StudioBackend> {
    backend: Arc<B>,
    config: StudioConfig,
    inner: Mutex<Inner>,
    snapshot: watch::Sender<StudioSnapshot>,
    effects: broadcast::Sender<SessionEffect>,
    /// The toasts, as they happen.
    notices: broadcast::Sender<NoticeCommand>,
    /// The Health page's telemetry. Apart from the snapshot:
    /// `diagnostics.stats` arrives four times a second, and only the Health
    /// page reads it.
    telemetry: watch::Sender<HealthTelemetry>,
    /// One support bundle export at a time.
    support_bundle: tokio::sync::Mutex<()>,
    /// The start in flight, which a second caller asking for the same start
    /// joins (`sessionStartInFlightRef`).
    in_flight: Mutex<Option<InFlightStart>>,
    /// Held while a start runs; a stop waits for it (the renderer joins the
    /// in-flight start promise before stopping).
    start_lock: tokio::sync::Mutex<()>,
    /// One stop at a time.
    stop_lock: tokio::sync::Mutex<()>,
    /// The stop in flight, whose answer a second Stop gets
    /// (`stopSessionInFlightPromiseRef`).
    stop_in_flight: Mutex<Option<watch::Receiver<Option<bool>>>>,
    /// One exclusion request at a time, each with the newest list.
    exclusion_lock: tokio::sync::Mutex<()>,
    /// One settings batch in flight at a time.
    settings_flush: tokio::sync::Mutex<()>,
    /// The settings retry's deadline moved; the driver looks again.
    settings_retry: Notify,
    /// A live source read ended (or was dropped): a refresh that found it
    /// running waits for it, as Electron's `refresh()` returns the read in
    /// flight.
    live_read_done: Notify,
}

impl<B: StudioBackend> Studio<B> {
    pub fn new(backend: Arc<B>, config: StudioConfig) -> Self {
        let mut inner = Inner {
            connection: Connection::Waiting,
            bootstrapped: false,
            bootstrap_generation: 0,
            session: SessionState::new(),
            sources: SourcesState::default(),
            health: HealthSummary::default(),
            settings: UiSettingsCache::new(),
            journal: SettingsJournal::open(config.settings_journal.clone()),
            settings_retry_step: 0,
            settings_retry_due: None,
            capture: CaptureMemory::new(config.clock),
            views: None,
            finalization: None,
            last_error: None,
            live_streaming: None,
            exclusion: Exclusion::default(),
            notices: SessionNotices::new(),
            latency: latency::LatencyTracker::new(),
            scenes: scenes::ScenesCore::default(),
            live_sources: live_sources::LiveSources::default(),
            live_due: None,
            source_reasons: [None, None, None],
            announced_returns: Vec::new(),
        };
        // Writes a previous run journaled wait in the cache until the
        // snapshot is in; then they are sent.
        for (key, value) in inner.journal.puts().clone() {
            inner.settings.put_local(&key, value);
        }
        for key in inner.journal.deletes().clone() {
            inner.settings.delete_local(&key);
        }
        let (snapshot, _) = watch::channel(Self::snapshot_of(&mut inner));
        let (effects, _) = broadcast::channel(EFFECT_CHANNEL_CAPACITY);
        let (notices, _) = broadcast::channel(NOTICE_CHANNEL_CAPACITY);
        let (telemetry, _) = watch::channel(HealthTelemetry::default());
        Self {
            backend,
            config,
            inner: Mutex::new(inner),
            snapshot,
            effects,
            notices,
            telemetry,
            support_bundle: tokio::sync::Mutex::new(()),
            in_flight: Mutex::new(None),
            stop_in_flight: Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
            stop_lock: tokio::sync::Mutex::new(()),
            exclusion_lock: tokio::sync::Mutex::new(()),
            settings_flush: tokio::sync::Mutex::new(()),
            settings_retry: Notify::new(),
            live_read_done: Notify::new(),
        }
    }

    /// The state, as it changes.
    pub fn watch(&self) -> watch::Receiver<StudioSnapshot> {
        self.snapshot.subscribe()
    }

    pub fn snapshot(&self) -> StudioSnapshot {
        self.snapshot.borrow().clone()
    }

    /// What the UI must do, as it happens.
    pub fn effects(&self) -> broadcast::Receiver<SessionEffect> {
        self.effects.subscribe()
    }

    /// S3.0f: the toasts to show and dismiss, as they happen.
    pub fn notices(&self) -> broadcast::Receiver<NoticeCommand> {
        self.notices.subscribe()
    }

    pub fn backend(&self) -> &Arc<B> {
        &self.backend
    }

    /// S3.0g: the Health page's telemetry, as it changes.
    pub fn telemetry(&self) -> watch::Receiver<HealthTelemetry> {
        self.telemetry.subscribe()
    }

    /// S3.1a: the telemetry as it is now.
    pub fn telemetry_now(&self) -> HealthTelemetry {
        self.telemetry.borrow().clone()
    }

    /// Feeds the client's events until it closes, and runs the settings
    /// retries when they fall due.
    pub async fn drive(self: Arc<Self>, mut events: broadcast::Receiver<BackendEvent>) {
        loop {
            let (due, live_due) = {
                let inner = self.lock();
                (inner.settings_retry_due, inner.live_due.map(|(at, ..)| at))
            };
            let retry = async move {
                match due {
                    Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
                    None => std::future::pending().await,
                }
            };
            // S1.6b part 5a: the live switch's 250 ms proof read, and a new
            // session's first read of its sources.
            let live_read = async move {
                match live_due {
                    Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                received = events.recv() => match received {
                    Ok(event) => self.handle_event(event).await,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        self.handle_event(BackendEvent::ClientLagged { skipped })
                            .await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                () = retry => self.retry_settings().await,
                () = live_read => self.live_sources_due().await,
                () = self.settings_retry.notified() => {}
            }
        }
    }

    /// One event from the typed client.
    pub async fn handle_event(&self, event: BackendEvent) {
        match event {
            BackendEvent::Ready(connection) => {
                let generation = {
                    let mut inner = self.lock();
                    inner.connection = Connection::Connected {
                        pid: connection.pid,
                    };
                    inner.bootstrapped = false;
                    inner.bootstrap_generation += 1;
                    inner.bootstrap_generation
                };
                self.publish();
                self.bootstrap(generation).await;
            }
            BackendEvent::RecordingStatus(status) => {
                let (effects, state_changed) = {
                    let mut inner = self.lock();
                    let before = std::mem::discriminant(&inner.session.status().state);
                    let effects = inner.session.apply_reported_status(*status, Instant::now());
                    let after = std::mem::discriminant(&inner.session.status().state);
                    (effects, before != after)
                };
                self.publish();
                self.emit_all(effects);
                // S1.6b part 5a: a returned pick is offered only while a
                // session runs.
                self.announce_returning_sources().await;
                // The working sources follow the session's state, as
                // Electron's reconcile effect depends on `recording.state`:
                // a camera or screen that went missing while a session ran
                // is reconciled once it ends (the reconcile's own guard
                // skips an active session or a start on its way).
                if state_changed {
                    self.reconcile_working_sources().await;
                }
            }
            BackendEvent::SceneChanged(scene) => {
                self.lock().sources.set_scene(*scene);
                self.publish();
            }
            BackendEvent::DevicesChanged(devices) => {
                self.lock().sources.set_devices(*devices);
                self.publish();
                self.flush_scene_writes().await;
                // S1.6b part 5a: the working sources against the new list,
                // and a pick that came back.
                self.reconcile_working_sources().await;
                self.announce_returning_sources().await;
            }
            BackendEvent::HealthEvent(event) => {
                let commands = {
                    let mut guard = self.lock();
                    let inner = &mut *guard;
                    let commands = inner.notices.on_health_event(
                        &event,
                        session_context(&inner.session),
                        Instant::now(),
                    );
                    if inner.health.push_event(*event) {
                        inner.session.note_stop_overrun();
                    }
                    commands
                };
                self.publish();
                self.post(commands);
            }
            BackendEvent::RecordingFinalization(event) => {
                let commands = {
                    let mut inner = self.lock();
                    let commands = inner.notices.on_finalization(&event);
                    inner.finalization = Some(*event);
                    commands
                };
                self.publish();
                self.post(commands);
            }
            BackendEvent::EventsLagged(_) | BackendEvent::ClientLagged { .. } => {
                // State built from events must be read again.
                self.resync().await;
            }
            BackendEvent::ConnectionClosed { reason } => {
                {
                    let mut inner = self.lock();
                    inner.connection = Connection::Disconnected { reason };
                    inner.bootstrapped = false;
                    inner.health.clear_backend();
                    inner.sources.forget_devices();
                }
                self.publish();
            }
            // The remote executor runs these from its own subscription; the
            // Studio only holds the state they act on.
            BackendEvent::RemoteIntent(_) => {}
            // L2's S1.4 adds `ui.settings.changed`; the client passes it on
            // as JSON until the protocol names it.
            BackendEvent::Untyped { event, payload }
                if event == ui_settings_wire::UI_SETTINGS_CHANGED_EVENT =>
            {
                match serde_json::from_value::<ui_settings_wire::UiSettingsChange>(payload) {
                    Ok(change) => {
                        let applied = {
                            let mut inner = self.lock();
                            let pending = inner.journal.keys();
                            inner.settings.apply_change_keeping(
                                &change,
                                Some(&self.config.writer_id),
                                &pending,
                            )
                        };
                        if applied {
                            self.publish();
                        }
                    }
                    Err(error) => self
                        .config
                        .logger
                        .warn(format!("Studio: \"{event}\" did not read ({error}).")),
                }
            }
            // The mic sliver reads these (the Session section, part 5).
            BackendEvent::Untyped { event, .. } if event == AUDIO_LEVELS_EVENT => {}
            // S1.6b part 5a: the session's whole source authority, read again.
            BackendEvent::Untyped { event, .. } if event == live_sources::SOURCES_CHANGED_EVENT => {
                self.kick_live_sources_read().await;
            }
            BackendEvent::Untyped { event, payload } => {
                // The Health page's telemetry (`stream.targets` feeds both it
                // and the toasts).
                self.telemetry.send_if_modified(|telemetry| {
                    telemetry.apply(&event, payload.clone(), Instant::now())
                });
                let commands = self.untyped_notices(&event, payload);
                if !commands.is_empty() {
                    self.post(commands);
                }
            }
            BackendEvent::PreviewSurfaceStatus(status) => {
                if let Ok(payload) = serde_json::to_value(&*status) {
                    self.telemetry.send_modify(|telemetry| {
                        telemetry.apply(
                            health::PREVIEW_SURFACE_STATUS_EVENT,
                            payload,
                            Instant::now(),
                        );
                    });
                }
            }
            // The preview lane (L1) reads these.
            BackendEvent::CompositorStatus(_)
            | BackendEvent::PreviewFrameReady(_)
            | BackendEvent::Unreadable { .. } => {}
        }
    }

    /// The toasts for the events the client does not type. A payload that
    /// does not read is logged and toasts nothing.
    fn untyped_notices(&self, event: &str, payload: Value) -> Vec<NoticeCommand> {
        use crate::client::names;
        fn read<T: serde::de::DeserializeOwned>(
            logger: &Logger,
            event: &str,
            payload: Value,
        ) -> Option<T> {
            match serde_json::from_value(payload) {
                Ok(value) => Some(value),
                Err(error) => {
                    logger.warn(format!(
                        "Studio: \"{event}\" did not read for its toast ({error})."
                    ));
                    None
                }
            }
        }
        let logger = &self.config.logger;
        match event {
            names::STREAM_TARGETS => read::<StreamTargetsSnapshot>(logger, event, payload)
                .map(|snapshot| self.lock().notices.on_stream_targets(&snapshot.targets))
                .unwrap_or_default(),
            names::REPLAY_STATE => read::<ReplayStateEvent>(logger, event, payload)
                .map(|state| self.lock().notices.on_replay_state(&state))
                .unwrap_or_default(),
            names::REPLAY_SAVED => read::<ReplaySavedEvent>(logger, event, payload)
                .map(|saved| self.lock().notices.on_replay_saved(&saved))
                .unwrap_or_default(),
            names::REPLAY_SAVE_FAILED => read::<ReplaySaveFailedEvent>(logger, event, payload)
                .map(|failed| self.lock().notices.on_replay_save_failed(&failed))
                .unwrap_or_default(),
            names::CLIP_MARKED => read::<ClipMarkedEvent>(logger, event, payload)
                .map(|marked| {
                    let mut guard = self.lock();
                    let inner = &mut *guard;
                    inner.notices.on_clip_marked(
                        &marked,
                        inner.session.status(),
                        notices::OPEN_OUTPUT,
                    )
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    /// `recoverSessionRuntime`'s lookups: the Library's first page and,
    /// when a session needs them, its health events. A failed read is an
    /// empty one (the renderer's `catch(() => [])`).
    async fn recovery_lookups(
        &self,
        status: &RecordingStatus,
        prior: &session::PriorSession,
    ) -> Option<RuntimeRecovery> {
        let sessions = match self
            .backend
            .sessions_list(SessionListParams {
                cursor: None,
                limit: notices::SESSION_LIST_PAGE_LIMIT,
            })
            .await
        {
            Ok(page) => page.items,
            Err(error) => {
                self.config.logger.info(format!(
                    "Studio: the recovery read no Library rows ({}).",
                    error.message
                ));
                Vec::new()
            }
        };
        let plan = notices::session_runtime_recovery_plan(
            status,
            &sessions,
            prior.session_id.as_deref(),
            &prior.state,
        );
        let events = match &plan.health_session_id {
            Some(session_id) => self
                .backend
                .session_health_events(SessionDetailListParams {
                    session_id: session_id.clone(),
                    cursor: None,
                    limit: notices::SESSION_DETAIL_BUFFER_LIMIT,
                })
                .await
                .map(|page| page.events)
                .unwrap_or_default(),
            None => Vec::new(),
        };
        notices::complete_session_runtime_recovery(
            &plan,
            status,
            &events,
            &prior.state,
            prior.activity,
        )
    }

    /// The renderer's bootstrap effect: the reads in parallel, then the
    /// state in one go, then the recovery of what happened while away. A
    /// newer connection during the reads wins; these results are dropped.
    async fn bootstrap(&self, generation: u64) {
        let (health, devices, status, scene, settings) = tokio::join!(
            self.backend.health(),
            self.backend.devices(),
            self.backend.recording_status(),
            self.backend.scene(),
            self.settings_snapshot(),
        );
        let prior = self.lock().session.prior_session();
        let (effects, recover) = {
            let mut inner = self.lock();
            if inner.bootstrap_generation != generation {
                return;
            }
            let mut effects = Vec::new();
            let mut recover = None;
            match health {
                Ok(health) => inner.health.set_backend(health),
                Err(error) => self.note_error(&mut inner, "health.ping", &error),
            }
            match devices {
                Ok(devices) => inner.sources.set_devices(devices),
                Err(error) => self.note_error(&mut inner, "devices.list", &error),
            }
            match scene {
                Ok(scene) => inner.sources.set_scene(scene),
                Err(error) => self.note_error(&mut inner, "scene.get", &error),
            }
            match settings {
                Ok(snapshot) => {
                    let pending = inner.journal.keys();
                    inner.settings.hydrate_keeping(snapshot, &pending);
                    inner.settings_retry_step = 0;
                }
                Err(error) => {
                    self.note_error(&mut inner, "ui.settings.get", &error);
                    if !inner.settings.hydrated() {
                        self.schedule_settings_retry(&mut inner);
                    }
                }
            }
            match status {
                Ok(status) => {
                    // The renderer's bootstrap applies the status without the
                    // event handler's news: an Idle read after a reconnect
                    // never says "Recording saved" (a session that died
                    // while away comes back from the recovery below).
                    effects.extend(
                        inner
                            .session
                            .apply_reported_status(status.clone(), Instant::now())
                            .into_iter()
                            .filter(|effect| {
                                !matches!(
                                    effect,
                                    SessionEffect::SessionFinished { .. }
                                        | SessionEffect::RecordingSaved { .. }
                                )
                            }),
                    );
                    // A session ran, runs, or failed: what happened while the
                    // Studio was away is looked up below (S3.0f).
                    if prior.was_active
                        || matches!(
                            status.state,
                            RecordingState::Recording
                                | RecordingState::Streaming
                                | RecordingState::Failed
                        )
                    {
                        recover = Some(status);
                    }
                }
                Err(error) => self.note_error(&mut inner, "recording.status", &error),
            }
            (effects, recover)
        };
        // `recoverSessionRuntime`: the session that died while the Studio was
        // away (the status says so, or the Library row does), or the audio
        // input its session lost.
        let recovery = match &recover {
            Some(status) => self.recovery_lookups(status, &prior).await,
            None => None,
        };
        let (effects, commands) = {
            let mut guard = self.lock();
            if guard.bootstrap_generation != generation {
                return;
            }
            let inner = &mut *guard;
            let mut effects = effects;
            let mut commands = Vec::new();
            match recovery {
                Some(RuntimeRecovery::RecordingFailed { status, activity })
                    if !status.replay_only =>
                {
                    effects.extend(inner.session.recover_failure(
                        &status,
                        activity,
                        Instant::now(),
                    ));
                }
                Some(RuntimeRecovery::MicrophoneLost(event)) => {
                    commands.extend(
                        inner
                            .notices
                            .microphone_loss(&event, session_context(&inner.session)),
                    );
                }
                _ => {}
            }
            inner.bootstrapped = true;
            (effects, commands)
        };
        self.publish();
        self.emit_all(effects);
        self.post(commands);
        // Health's reads, as the renderer's bootstrap makes them.
        self.read_telemetry(generation).await;
        // The other areas' first reads (the agents line, takeovers and the
        // soundboard, chat, Sidekick, destinations, chat commands, scheduled
        // streams, the performance check, Hide screen, captions, the working
        // sources) land with them (S1.6b to S1.6e).
        // The writes made while the engine was away (or journaled by a
        // previous run) land now, after the snapshot.
        let _ = self.flush_settings().await;
        // S1.6b part 4: plan 258's D4 migration, once the scenes are read.
        self.settle_camera_background_migration().await;
        // S1.6b part 5a: the working sources against the first device list.
        if self.lock().bootstrap_generation == generation {
            self.reconcile_working_sources().await;
        }
    }

    /// S3.0g: `diagnostics.stats` and the four `preview.*.status` reads of
    /// the renderer's bootstrap, into the telemetry; the events keep them
    /// current after. A read that fails leaves the last value (a backend
    /// without them, a test fake, answers nothing).
    async fn read_telemetry(&self, generation: u64) {
        const READS: [&str; 5] = [
            health::DIAGNOSTICS_STATS_EVENT,
            health::PREVIEW_LIVE_STATUS_EVENT,
            health::PREVIEW_SURFACE_STATUS_EVENT,
            health::PREVIEW_CAMERA_STATUS_EVENT,
            health::PREVIEW_SCREEN_STATUS_EVENT,
        ];
        let (stats, live, surface, camera, screen) = tokio::join!(
            self.backend.telemetry_read(READS[0]),
            self.backend.telemetry_read(READS[1]),
            self.backend.telemetry_read(READS[2]),
            self.backend.telemetry_read(READS[3]),
            self.backend.telemetry_read(READS[4]),
        );
        if self.lock().bootstrap_generation != generation {
            return;
        }
        let now = Instant::now();
        self.telemetry.send_modify(|telemetry| {
            for (name, read) in READS
                .into_iter()
                .zip([stats, live, surface, camera, screen])
            {
                if let Ok(payload) = read {
                    telemetry.apply(name, payload, now);
                }
            }
        });
    }

    /// Videorc's engine answers now (S3.10b: Reports' offline state).
    pub fn is_connected(&self) -> bool {
        matches!(self.lock().connection, Connection::Connected { .. })
    }

    /// S3.1a: `noteRecordClick`: a person's Record, Space, stop button, End
    /// livestream confirm or remote key arms the latency clock.
    pub fn note_record_click(&self, kind: LatencyKind) {
        self.lock().latency.mark(
            kind,
            latency::LatencyOrigin::Click,
            Instant::now(),
            epoch_ms(),
        );
    }

    /// S3.0g: Health's recording log (`DiagnosticsTab`'s `logSession`): the
    /// current session, else the newest in the Library, and its log lines
    /// (`loadSessionDetails`'s `sessions.logs.list`).
    pub async fn recording_log(&self) -> health_page::RecordingLog {
        let current_id = self.lock().session.status().session_id.clone();
        let sessions = match self
            .backend
            .sessions_list(SessionListParams {
                cursor: None,
                limit: notices::SESSION_LIST_PAGE_LIMIT,
            })
            .await
        {
            Ok(page) => page.items,
            Err(_) => Vec::new(),
        };
        let current = current_id
            .as_deref()
            .and_then(|id| sessions.iter().find(|session| session.id == id));
        let Some(session) = current.or(sessions.first()) else {
            return health_page::RecordingLog::default();
        };
        let mut log = health_page::RecordingLog {
            session_id: Some(session.id.clone()),
            title: Some(session.title.clone()),
            log_count: session.session_log_count,
            current: current.is_some(),
            ..health_page::RecordingLog::default()
        };
        match self
            .backend
            .session_logs(SessionDetailListParams {
                session_id: session.id.clone(),
                cursor: None,
                limit: notices::SESSION_DETAIL_BUFFER_LIMIT,
            })
            .await
        {
            Ok(page) => log.entries = page.entries,
            Err(error) => {
                self.config.logger.info(format!(
                    "Studio: Health read no log for {} ({}).",
                    session.id, error.message
                ));
                log.failed = true;
            }
        }
        log
    }

    /// S3.0g: `exportSupportBundle`. Refused at once while the engine is
    /// away (`Couldn't export a support bundle`, the reconnecting words);
    /// one export at a time. The bundle's path, or the failure's toast.
    pub async fn export_support_bundle(
        &self,
        renderer_diagnostics: Value,
    ) -> Option<Result<String, NoticeCommand>> {
        if !matches!(self.lock().connection, Connection::Connected { .. }) {
            return Some(Err(notices::support_bundle_export_failed(true)));
        }
        let Ok(_one) = self.support_bundle.try_lock() else {
            return None;
        };
        let params = json!({
            "appVersion": self.config.app_version,
            "rendererDiagnostics": renderer_diagnostics,
        });
        Some(match self.backend.support_bundle_export(params).await {
            Ok(result) => match result.get("path").and_then(Value::as_str) {
                Some(path) => Ok(path.to_string()),
                None => Err(notices::support_bundle_export_failed(false)),
            },
            Err(error) => {
                self.config.logger.warn(format!(
                    "Studio: the support bundle was not exported ({}: {}).",
                    error.code, error.message
                ));
                Err(notices::support_bundle_export_failed(
                    error.code == crate::client::codes::NOT_CONNECTED,
                ))
            }
        })
    }

    /// Whether a support bundle export is running (`supportBundleExportPending`).
    pub fn support_bundle_pending(&self) -> bool {
        self.support_bundle.try_lock().is_err()
    }

    /// `ui.settings.get`, bounded by the renderer's hydrate deadline: past
    /// it the Studio carries on with the defaults (and takes no write) while
    /// the snapshot is retried.
    async fn settings_snapshot(&self) -> Result<UiSettingsSnapshot, RpcError> {
        match tokio::time::timeout(
            settings::HYDRATE_TIMEOUT,
            self.backend.settings_get(UiSettingsGetParams::default()),
        )
        .await
        {
            Ok(answer) => answer,
            Err(_) => Err(RpcError::new(
                "ui.settings.get",
                "ui-settings-hydrate-timeout",
                format!(
                    "The engine did not answer within {} ms; still waiting.",
                    settings::HYDRATE_TIMEOUT.as_millis()
                ),
            )),
        }
    }

    /// After a lag: the state built from events, read again.
    pub async fn resync(&self) {
        let (status, devices, scene) = tokio::join!(
            self.backend.recording_status(),
            self.backend.devices(),
            self.backend.scene(),
        );
        let effects = {
            let mut inner = self.lock();
            let mut effects = Vec::new();
            match status {
                Ok(status) => {
                    effects.extend(inner.session.apply_reported_status(status, Instant::now()));
                }
                Err(error) => self.note_error(&mut inner, "recording.status", &error),
            }
            match devices {
                Ok(devices) => inner.sources.set_devices(devices),
                Err(error) => self.note_error(&mut inner, "devices.list", &error),
            }
            match scene {
                Ok(scene) => inner.sources.set_scene(scene),
                Err(error) => self.note_error(&mut inner, "scene.get", &error),
            }
            effects
        };
        self.publish();
        self.emit_all(effects);
        self.flush_scene_writes().await;
        // S1.6b part 5a: the session's sources, and the working sources. The
        // chat (`recoverLiveChatSnapshot`) is read again with its area
        // (S1.6e).
        self.kick_live_sources_read().await;
        self.reconcile_working_sources().await;
    }

    /// `refreshDevices` and the scene: the Sources page's Refresh.
    pub async fn refresh_sources(&self) -> Result<(), RpcError> {
        let (devices, scene) = tokio::join!(self.backend.devices(), self.backend.scene());
        let result = {
            let mut inner = self.lock();
            let devices = devices.map(|devices| inner.sources.set_devices(devices));
            let scene = scene.map(|scene| inner.sources.set_scene(scene));
            if let Err(error) = &devices {
                self.note_error(&mut inner, "devices.list", error);
            }
            if let Err(error) = &scene {
                self.note_error(&mut inner, "scene.get", error);
            }
            devices.and(scene)
        };
        self.publish();
        self.flush_scene_writes().await;
        // S1.6b part 5a: the working sources against the list.
        self.reconcile_working_sources().await;
        result
    }

    /// Record: a local take, never a stream.
    pub async fn start_recording(&self) -> StartOutcome {
        self.start(SessionStartIntent::RECORD, None).await
    }

    /// Go Live to `streaming`'s enabled destinations (or the saved ones),
    /// recording too when the Output page says so (D19).
    pub async fn start_livestream(&self, streaming: Option<StreamingSettings>) -> StartOutcome {
        let also_record = self.snapshot().settings.capture.record_enabled;
        self.start(SessionStartIntent::livestream(also_record), streaming)
            .await
    }

    /// `retrySessionStart`: the exact start that failed.
    pub async fn retry_start(&self) -> StartOutcome {
        let Some(failure) = self.snapshot().session.start_failure else {
            return StartOutcome::Busy;
        };
        // `runStartSession`'s retry re-runs the exact start: Go Live to the
        // destinations it went to. The cloud's Resume and Go Live's preflight
        // (which reopens the dialog) arrive with S1.6c.
        let streaming = match failure.kind {
            SessionStartFailureKind::Record => None,
            SessionStartFailureKind::Live | SessionStartFailureKind::Resume => {
                self.lock().live_streaming.clone()
            }
        };
        self.start(failure.intent, streaming).await
    }

    /// `runStartSession` (`use-studio.tsx`): the optimistic
    /// `starting`, the request, the reconciled answer; on a rejection the
    /// persistent failure and back to Idle. The Go Live preflight (the
    /// destination health checks, the topology probe, the platform
    /// broadcasts) is Phase 3.
    pub async fn start(
        &self,
        intent: SessionStartIntent,
        streaming: Option<StreamingSettings>,
    ) -> StartOutcome {
        // S3.1a: a start already on its way answers a second caller asking
        // for the same start with its own answer (`sessionStartInFlightRef`);
        // any other start is busy at once (the renderer answers it false).
        // S1.6b part 3c (#1643): a scene change awaiting its proof has not
        // reached the capture config yet; started now, the session would
        // commit the scene it is leaving. The start waits for it, then holds
        // the scene it carries until its answer is applied, so a switch
        // asked for meanwhile waits and goes to the session it started.
        let (answer, joined, scene_hold) = loop {
            self.wait_for_layout_proof().await;
            let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            match in_flight.as_ref() {
                Some(start) if start.intent == intent && start.streaming == streaming => {
                    break (None, Some(start.answer.clone()), None);
                }
                Some(_) => return StartOutcome::Busy,
                None => {
                    // A switch minted since the wait: wait for it too.
                    let Some(hold) = self.hold_start_scene() else {
                        continue;
                    };
                    let (answer, heard) = watch::channel(None);
                    *in_flight = Some(InFlightStart {
                        intent,
                        streaming: streaming.clone(),
                        answer: heard,
                    });
                    break (Some(answer), None, Some(hold));
                }
            }
        };
        if let Some(mut heard) = joined {
            return match heard.wait_for(Option::is_some).await {
                Ok(outcome) => outcome.clone().unwrap_or(StartOutcome::Busy),
                Err(_) => StartOutcome::Busy,
            };
        }
        let answer = answer.expect("set above");
        // Cleared however this start ends, a dropped future included.
        let clear = ClearInFlight(&self.in_flight);
        let outcome = self.start_once(intent, streaming).await;
        // Every other way out (refused, failed, dropped) answers the hold.
        drop(scene_hold);
        drop(clear);
        answer.send_replace(Some(outcome.clone()));
        outcome
    }

    async fn start_once(
        &self,
        intent: SessionStartIntent,
        streaming: Option<StreamingSettings>,
    ) -> StartOutcome {
        let _running = self.start_lock.lock().await;
        let (params, attempted) = {
            let mut inner = self.lock();
            if !inner.session.begin_start(intent) {
                return StartOutcome::Busy;
            }
            // The session call arms the clock when no click did, and the
            // request carries the click's time (`requestedAtMs`).
            inner.latency.mark(
                LatencyKind::Start,
                latency::LatencyOrigin::SessionCall,
                Instant::now(),
                epoch_ms(),
            );
            // `noteSessionStartAttempt`: the last refusal's toast and the
            // runtime notices go.
            let attempted = inner.notices.start_attempted();
            inner.last_error = None;
            let view = inner.settings_view();
            let streaming = if intent.stream {
                streaming.or_else(|| view.capture.streaming.clone())
            } else {
                None
            };
            inner.live_streaming = streaming.clone();
            let requested_at_ms =
                inner
                    .latency
                    .take_click_epoch_ms(LatencyKind::Start, Instant::now(), epoch_ms());
            // #1643: read while this start holds its scene, so it is the
            // scene the last switch left, with that switch's background.
            let scene = inner.start_scene().unwrap_or_else(|error| {
                // The start goes on without the scene rather than with a
                // background the backend can't read.
                self.config.logger.warn(format!(
                    "[session-start] the working background isn't sendable: {error}"
                ));
                None
            });
            (
                build_start_params(&view.capture, &view.studio, intent, streaming).map(
                    |mut params| {
                        params.requested_at_ms = Some(requested_at_ms);
                        params.scene = scene;
                        params
                    },
                ),
                attempted,
            )
        };
        self.publish();
        self.post(attempted);
        let params = match params {
            Ok(params) => params,
            Err(message) => return self.refuse_start(message),
        };
        self.prepare_session_capture(&params.sources, &params.output.video)
            .await;
        match self.backend.session_start(params).await {
            Ok(status) => {
                let (resolution, effects) = {
                    let mut inner = self.lock();
                    inner.session.finish_start(status, Instant::now())
                };
                self.publish();
                // #1643: the start's scene is committed and the session's
                // state known: a scene change held for it now goes to the
                // session it started.
                self.release_start_scene();
                self.emit_all(effects);
                if resolution.session_active {
                    StartOutcome::Started
                } else {
                    StartOutcome::Refused {
                        message: resolution
                            .status
                            .message
                            .unwrap_or_else(|| "The session couldn't start.".to_string()),
                    }
                }
            }
            Err(error) => self.refuse_start(start_failure_message(&error)),
        }
    }

    /// The window ids the backend's ScreenCaptureKit filter must leave out
    /// right now: the app's on-screen windows whose rule says so
    /// (`app_windows::protected_overlay_window_ids`). During a session that
    /// captures a screen or window, the running capture takes the new list
    /// in place (`preview.screen.start` with the session's own source, as
    /// the renderer re-sends it when the list changes); otherwise the list
    /// waits for the next start. Returns once the backend answered, or at
    /// once when nothing had to be sent.
    pub async fn set_protected_overlay_window_ids(&self, ids: Vec<u32>) {
        let ids = normalized_window_ids(ids);
        {
            let mut inner = self.lock();
            if inner.exclusion.wanted == ids {
                return;
            }
            inner.exclusion.wanted = ids;
        }
        self.publish();
        let _one_at_a_time = self.exclusion_lock.lock().await;
        let request = {
            let inner = self.lock();
            let Connection::Connected { pid } = inner.connection else {
                return;
            };
            let capturing = matches!(
                inner.session.phase(),
                SessionPhase::Starting | SessionPhase::Recording | SessionPhase::Live
            );
            let Some((sources, video)) = inner.exclusion.session_capture.clone() else {
                return;
            };
            if !capturing || inner.exclusion.held_by(pid) == inner.exclusion.wanted.as_slice() {
                return;
            }
            let params = PreviewScreenStartParams {
                sources,
                video,
                protected_overlay_window_ids: inner.exclusion.wanted.clone(),
                ffmpeg_path: None,
            };
            (pid, params)
        };
        self.send_exclusion(request.0, request.1, "in-session")
            .await;
    }

    /// Before `session.start`: the renderer's screen preview start
    /// (`preview.screen.start` for the selected screen or window, with the
    /// list). The backend's session takes over the running capture and
    /// refuses to start on a screen that produced no frames, and the
    /// capture is built with the list, so a hidden window is out of the
    /// first frame. An already running capture of the same source is reused
    /// (and takes a changed list in place).
    async fn prepare_session_capture(&self, sources: &SourceSelection, video: &VideoSettings) {
        let _one_at_a_time = self.exclusion_lock.lock().await;
        let request = {
            let mut inner = self.lock();
            if !captures_screen(sources) {
                inner.exclusion.session_capture = None;
                return;
            }
            inner.exclusion.session_capture = Some((sources.clone(), video.clone()));
            let Connection::Connected { pid } = inner.connection else {
                return;
            };
            let params = PreviewScreenStartParams {
                sources: sources.clone(),
                video: video.clone(),
                protected_overlay_window_ids: inner.exclusion.wanted.clone(),
                ffmpeg_path: None,
            };
            (pid, params)
        };
        self.send_exclusion(request.0, request.1, "session-start")
            .await;
    }

    async fn send_exclusion(
        &self,
        pid: u32,
        params: PreviewScreenStartParams,
        reason: &'static str,
    ) {
        let ids = params.protected_overlay_window_ids.clone();
        let answer = self.backend.preview_screen_start(params).await;
        {
            let mut inner = self.lock();
            let last = match answer {
                Ok(status) => {
                    self.config.logger.info(format!(
                        "Studio: capture exclusion {ids:?} ({reason}): {:?}, {}",
                        status.state,
                        status.message.as_deref().unwrap_or("no message")
                    ));
                    inner.exclusion.sent = Some((pid, ids.clone()));
                    CaptureExclusionAnswer {
                        ids,
                        reason,
                        screen_state: Some(status.state),
                        message: status.message,
                    }
                }
                Err(error) => {
                    // The backend keeps its previous list; the next change
                    // or start sends again.
                    self.config.logger.warn(format!(
                        "Studio: capture exclusion {ids:?} ({reason}) failed: {} ({})",
                        error.message, error.code
                    ));
                    CaptureExclusionAnswer {
                        ids,
                        reason,
                        screen_state: None,
                        message: Some(error.message),
                    }
                }
            };
            inner.exclusion.last = Some(last);
        }
        self.publish();
    }

    fn refuse_start(&self, message: String) -> StartOutcome {
        let effects = {
            let mut inner = self.lock();
            inner.last_error = Some(message.clone());
            inner.session.fail_start(message.clone(), Instant::now())
        };
        self.publish();
        self.emit_all(effects);
        StartOutcome::Refused { message }
    }

    /// `requestStopSession`: a recording stops now; a livestream asks (the
    /// confirmation lands in the snapshot) or arms the hotkey.
    pub async fn request_stop(&self, origin: StopOrigin) -> StopOutcome {
        let request = {
            let mut inner = self.lock();
            // `requestStopSession` names the saved destinations that are on
            // (`captureConfigRef.current.streaming`), as the question shows.
            let platforms: Vec<String> = inner
                .settings_view()
                .capture
                .streaming
                .map(|streaming| stop_destination_labels(&streaming))
                .unwrap_or_default();
            inner
                .session
                .request_stop(origin, platforms, Instant::now())
        };
        self.publish();
        self.post(SessionNotices::stop_requested(&request));
        match request {
            StopRequest::Stop => StopOutcome::Stopped(self.stop().await),
            StopRequest::Armed => StopOutcome::Armed,
            StopRequest::Confirm(confirmation) => StopOutcome::Confirm(confirmation),
        }
    }

    /// `confirmStopSession`: "End livestream". Returns whether the stop
    /// answered and the exit the app continues with, if it was leaving.
    pub async fn confirm_stop(&self) -> (bool, Option<StopExit>) {
        let exit = {
            let mut inner = self.lock();
            let had_question = inner.session.stop_confirmation().is_some();
            let exit = inner.session.confirm_stop();
            if !had_question {
                return (false, None);
            }
            // The confirm is the person's stop: the clock arms here, not at
            // the click that only asked.
            inner.latency.mark(
                LatencyKind::Stop,
                latency::LatencyOrigin::Click,
                Instant::now(),
                epoch_ms(),
            );
            exit
        };
        self.publish();
        (self.stop().await, exit)
    }

    /// `cancelStopSession`: "Keep streaming".
    pub fn cancel_stop(&self) {
        self.lock().session.cancel_stop();
        self.publish();
    }

    /// `stopSession`: waits for a start in flight, then `session.stop`
    /// unless the session already ended. True when the stop answered (or
    /// nothing was running), false when the request failed.
    pub async fn stop(&self) -> bool {
        // A Stop while one is on its way answers with that stop's answer,
        // never a fresh `session.stop` after it failed
        // (`stopSessionInFlightPromiseRef`).
        let (answer, joined) = {
            let mut in_flight = self
                .stop_in_flight
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match in_flight.as_ref() {
                Some(heard) => (None, Some(heard.clone())),
                None => {
                    let (answer, heard) = watch::channel(None);
                    *in_flight = Some(heard);
                    (Some(answer), None)
                }
            }
        };
        if let Some(mut heard) = joined {
            return match heard.wait_for(Option::is_some).await {
                Ok(ok) => ok.unwrap_or(false),
                Err(_) => false,
            };
        }
        let answer = answer.expect("set above");
        // Cleared however this stop ends, a dropped future included.
        let clear = ClearInFlight(&self.stop_in_flight);
        let ok = self.stop_once().await;
        drop(clear);
        answer.send_replace(Some(ok));
        ok
    }

    async fn stop_once(&self) -> bool {
        let _after_start = self.start_lock.lock().await;
        let _one_at_a_time = self.stop_lock.lock().await;
        let requested_at_ms = {
            let mut inner = self.lock();
            if !inner.session.is_active() {
                return true;
            }
            if !inner.session.begin_stop() {
                return true;
            }
            inner.last_error = None;
            inner.latency.mark(
                LatencyKind::Stop,
                latency::LatencyOrigin::SessionCall,
                Instant::now(),
                epoch_ms(),
            );
            inner
                .latency
                .take_click_epoch_ms(LatencyKind::Stop, Instant::now(), epoch_ms())
        };
        self.publish();
        // X's broadcasts end before the stream does (S1.6c).
        let params = SessionStopParams {
            requested_at_ms: Some(requested_at_ms),
        };
        let result = self.backend.session_stop(params).await;
        let (ok, effects) = {
            let mut inner = self.lock();
            match result {
                Ok(status) => (true, inner.session.finish_stop(status, Instant::now())),
                Err(error) => {
                    inner.session.end_stop();
                    self.note_error(&mut inner, "session.stop", &error);
                    (false, Vec::new())
                }
            }
        };
        self.publish();
        self.emit_all(effects);
        // YouTube's broadcasts complete once the stream stopped (S1.6c).
        ok
    }

    pub fn dismiss_start_failure(&self) {
        self.lock().session.dismiss_start_failure();
        self.publish();
        self.post(SessionNotices::start_failure_dismissed());
    }

    /// `sessionOwnsTransport(recording)`: a session runs that is not the
    /// Clips ring alone. What a remote key's `sessionActive` reads.
    pub fn session_owns_transport(&self) -> bool {
        let inner = self.lock();
        inner.session.is_active() && !session_is_replay_only(inner.session.status())
    }

    /// `requestRemoteMicrophoneMute`: idle, the
    /// mute is written to the capture config and the next session starts
    /// with it; while a session runs, the session takes it through
    /// `audio.processing.update` and the config follows what it applied.
    /// True when the mute landed. The renderer's latest-wins audio sync
    /// queue (plan 069) is Phase 3: here one update is sent, and the
    /// microphone the session mixes is read from the capture config the
    /// start was built from.
    pub async fn set_microphone_muted(&self, mode: MicrophoneMode) -> bool {
        let (active, session_id, audio) = {
            let mut inner = self.lock();
            let view = inner.settings_view();
            (
                inner.session.is_active(),
                inner.session.status().session_id.clone(),
                view.capture.audio,
            )
        };
        let muted = match mode {
            MicrophoneMode::Mute => true,
            MicrophoneMode::Unmute => false,
            MicrophoneMode::Toggle => !audio.microphone_muted,
        };
        if !active {
            return self.commit_microphone_muted(muted).await;
        }
        let Some(session_id) = session_id else {
            return false;
        };
        let params = videorc_protocol::AudioProcessingUpdateParams {
            microphone_noise_suppression: Some(audio.microphone_noise_suppression),
            session_id: session_id.clone(),
            microphone_gain_db: audio.microphone_gain_db,
            microphone_muted: muted,
            system_audio_enabled: None,
            system_audio_gain_db: None,
            system_audio_echo_guard: None,
        };
        match self.backend.audio_processing_update(params).await {
            Ok(result) if result.applied && result.session_id == session_id => {
                // The live audio sync (S1.6b) holds it, so it is not sent
                // again, once it lands.
                self.commit_microphone_muted(result.microphone_muted).await
            }
            Ok(result) => {
                self.config.logger.warn(format!(
                    "Studio: audio.processing.update not applied for {} ({})",
                    result.session_id,
                    result.reason_code.as_deref().unwrap_or("no reason")
                ));
                false
            }
            Err(error) => {
                self.note_error(&mut self.lock(), "audio.processing.update", &error);
                self.publish();
                false
            }
        }
    }

    /// `setCaptureConfig(current => ({...current, audio: {...current.audio,
    /// microphoneMuted}}))`. True once the config holds it: landed, or
    /// journaled while the engine is away (the renderer's state changes at
    /// once too).
    async fn commit_microphone_muted(&self, muted: bool) -> bool {
        match self
            .update_capture_config(|config| {
                capture_config::set_path(
                    config,
                    &["audio", "microphoneMuted"],
                    Some(Value::Bool(muted)),
                );
            })
            .await
        {
            Ok(()) => true,
            Err(error) => settings_write_kept(&error),
        }
    }

    pub fn dismiss_notice(&self) {
        let commands = {
            let mut inner = self.lock();
            inner.session.dismiss_runtime_notice();
            inner.notices.dismiss_runtime_notice()
        };
        self.publish();
        self.post(commands);
    }

    /// A read straight from the cache.
    pub fn setting(&self, key: &str) -> Option<Value> {
        self.lock().settings.get(key).cloned()
    }

    /// `setCaptureConfig(edit)`: `edit` changes the capture config as the
    /// Studio holds it (Electron's state: loaded, then edited, the test
    /// pattern in `sources`), and the store gets
    /// `persistableCaptureConfig` of the result. Ok once the store took it;
    /// an error with [`settings_write_kept`] means it waits in the journal
    /// (the config already holds it); otherwise nothing changed.
    pub async fn update_capture_config(
        &self,
        edit: impl FnOnce(&mut Value),
    ) -> Result<(), RpcError> {
        {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let mut next = inner.capture.config.clone();
            edit(&mut next);
            let stored = capture_config::stored_capture_config(&next);
            inner.stage_writes(
                &[SettingWrite::Put {
                    key: keys::CAPTURE_CONFIG.to_string(),
                    value: stored.clone(),
                }],
                &self.config.logger,
            )?;
            inner.capture.set(next, Some(stored));
        }
        self.publish();
        self.flush_settings().await
    }

    /// The Sources page's development switch: the test pattern on (the
    /// screen and window picks cleared) or off. The flag is this run's; the
    /// cleared picks are stored.
    pub async fn set_test_pattern(&self, on: bool) -> Result<(), RpcError> {
        self.update_capture_config(|config| capture_config::set_test_pattern(config, on))
            .await
    }

    /// `setSettings(edit)`: the Studio's own settings as the renderer holds
    /// them, written back whole (`JSON.stringify(settings)`).
    pub async fn update_studio_settings(
        &self,
        edit: impl FnOnce(&mut StudioSettings),
    ) -> Result<(), RpcError> {
        {
            let mut inner = self.lock();
            let mut settings = StudioSettings::load(inner.settings.get(keys::SETTINGS));
            edit(&mut settings);
            inner.stage_writes(
                &[SettingWrite::Put {
                    key: keys::SETTINGS.to_string(),
                    value: settings.stored(),
                }],
                &self.config.logger,
            )?;
        }
        self.publish();
        self.flush_settings().await
    }

    /// The Studio's own settings, written back whole.
    pub async fn set_studio_settings(&self, settings: &StudioSettings) -> Result<(), RpcError> {
        let next = settings.clone();
        self.update_studio_settings(|current| *current = next).await
    }

    /// Writes `value` under `key` as JSON text (the convention of the
    /// families that store JSON).
    pub async fn put_setting(&self, key: &str, value: &impl Serialize) -> Result<(), RpcError> {
        self.write_settings(vec![SettingWrite::Put {
            key: key.to_string(),
            value: settings::encode(value),
        }])
        .await
    }

    pub async fn delete_setting(&self, key: &str) -> Result<(), RpcError> {
        self.write_settings(vec![SettingWrite::delete(key)]).await
    }

    /// A family's writes ([`families`]), in order: in the cache at once,
    /// then in one `ui.settings.set` batch with whatever else is pending;
    /// the answer moves the revision and every other window hears it. While
    /// the engine is away the writes wait in the journal and land after the
    /// reconnect (retried with the renderer's backoff,
    /// [`settings::RETRY_BACKOFF_MS`]). Refused at once before the snapshot
    /// is in ([`SETTINGS_NOT_HYDRATED`]) or past the store's limits
    /// ([`SETTINGS_REFUSED`]).
    pub async fn write_settings(&self, writes: Vec<SettingWrite>) -> Result<(), RpcError> {
        self.lock().stage_writes(&writes, &self.config.logger)?;
        self.publish();
        self.flush_settings().await
    }

    /// `flush()`: sends what is pending now and resolves when the store
    /// confirmed it. Ok at once when nothing is pending; an error (the write
    /// kept) when the engine is away or the send failed, and then a retry is
    /// scheduled.
    pub async fn flush_settings(&self) -> Result<(), RpcError> {
        let _one_batch = self.settings_flush.lock().await;
        loop {
            let params = {
                let inner = self.lock();
                if inner.journal.is_empty() {
                    return Ok(());
                }
                if !inner.settings.hydrated() {
                    return Err(RpcError::new(
                        "ui.settings.set",
                        SETTINGS_PENDING,
                        "The settings store has no snapshot yet; the change is saved once it answers.",
                    ));
                }
                if !matches!(inner.connection, Connection::Connected { .. }) {
                    return Err(RpcError::new(
                        "ui.settings.set",
                        SETTINGS_PENDING,
                        "Videorc is reconnecting; the change is saved once it answers.",
                    ));
                }
                inner.journal.batch(&self.config.writer_id)
            };
            match self.backend.settings_set(params.clone()).await {
                Ok(change) => {
                    {
                        let mut inner = self.lock();
                        inner.journal.landed(&params);
                        inner.settings.note_revision(change.revision);
                        inner.settings_retry_step = 0;
                        inner.settings_retry_due = None;
                        if let Err(error) = inner.journal.save() {
                            self.config.logger.warn(format!(
                                "Studio: could not journal the pending settings writes: {error}"
                            ));
                        }
                    }
                    self.publish();
                }
                Err(error) => {
                    {
                        let mut inner = self.lock();
                        self.config.logger.warn(format!(
                            "Studio: {} setting write(s) did not land (kept pending and journaled): {}",
                            params.put.len() + params.delete.len(),
                            error.message
                        ));
                        inner.last_error = Some(error.message.clone());
                        self.schedule_settings_retry(&mut inner);
                    }
                    self.publish();
                    return Err(error);
                }
            }
        }
    }

    /// `scheduleRetry`: the next try after the backoff's next step.
    fn schedule_settings_retry(&self, inner: &mut Inner) {
        if inner.settings_retry_due.is_some() {
            return;
        }
        let wait = settings::retry_delay(inner.settings_retry_step);
        inner.settings_retry_step += 1;
        inner.settings_retry_due = Some(Instant::now() + wait);
        self.settings_retry.notify_one();
    }

    /// When the scheduled retry has come up: the snapshot again if it never
    /// arrived, else the pending writes.
    pub async fn retry_settings(&self) {
        let hydrate = {
            let mut inner = self.lock();
            inner.settings_retry_due = None;
            !inner.settings.hydrated() && matches!(inner.connection, Connection::Connected { .. })
        };
        if !hydrate {
            let _ = self.flush_settings().await;
            return;
        }
        let snapshot = self.settings_snapshot().await;
        {
            let mut inner = self.lock();
            match snapshot {
                Ok(snapshot) => {
                    let pending = inner.journal.keys();
                    inner.settings.hydrate_keeping(snapshot, &pending);
                    inner.settings_retry_step = 0;
                }
                Err(error) => {
                    self.note_error(&mut inner, "ui.settings.get", &error);
                    self.schedule_settings_retry(&mut inner);
                }
            }
        }
        self.publish();
        let _ = self.flush_settings().await;
    }

    /// When the next settings retry is due, if one is scheduled.
    pub fn settings_retry_due(&self) -> Option<Instant> {
        self.lock().settings_retry_due
    }

    /// S3.10a: a read of the stored UI settings a page keeps by key
    /// (the Buddy's worn pack per persona, `videorc.buddyWornPack:<id>`).
    pub fn read_ui_settings<R>(&self, read: impl FnOnce(&UiSettingsCache) -> R) -> R {
        read(&self.lock().settings)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn note_error(&self, inner: &mut Inner, method: &str, error: &RpcError) {
        self.config.logger.warn(format!(
            "Studio: {method} failed: {} ({})",
            error.message, error.code
        ));
        inner.last_error = Some(error.message.clone());
    }

    fn publish(&self) {
        let start_in_flight = self.start_in_flight();
        let snapshot = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            // S1.6b part 5a: `sourceSelectionController.setSession` on every
            // status applied; a new session's sources are read at once.
            let session_status = inner.session.status().clone();
            if inner.live_sources.set_session(
                session_status.session_id.as_deref(),
                &session_status.state,
                session_status.replay_only,
            ) && inner.live_sources.readable()
            {
                let epoch = inner.live_sources.epoch;
                inner.live_due = Some((Instant::now(), epoch, false));
                self.settings_retry.notify_one();
            }
            let reasons = {
                let state: &Inner = inner;
                [
                    source_selection::SourceKind::Capture,
                    source_selection::SourceKind::Camera,
                    source_selection::SourceKind::Microphone,
                ]
                .map(|kind| source_actions::source_switch_reason_of(state, kind, start_in_flight))
            };
            inner.source_reasons = reasons;
            // Every status the Studio applied, through the clock.
            let status = inner.session.status().clone();
            if let Some(sample) = inner.latency.observe(&status, Instant::now()) {
                self.config.logger.info(sample.log_line());
            }
            let snapshot = Self::snapshot_of(inner);
            (snapshot, std::mem::take(&mut inner.scenes.notices))
        };
        let (snapshot, scene_notices) = snapshot;
        self.snapshot.send_replace(snapshot);
        self.post(scene_notices);
    }

    fn emit_all(&self, effects: Vec<SessionEffect>) {
        if effects.is_empty() {
            return;
        }
        let commands: Vec<NoticeCommand> = {
            let mut inner = self.lock();
            effects
                .iter()
                .flat_map(|effect| inner.notices.on_effect(effect))
                .collect()
        };
        for effect in effects {
            // No subscriber is not an error.
            let _ = self.effects.send(effect);
        }
        self.post(commands);
    }

    /// S3.0j: toasts raised outside the session (the account's), through
    /// the same toaster.
    pub fn post_notices(&self, commands: Vec<NoticeCommand>) {
        self.post(commands);
    }

    /// S3.0f: the toasts, in order.
    fn post(&self, commands: Vec<NoticeCommand>) {
        for command in commands {
            // No subscriber is not an error.
            let _ = self.notices.send(command);
        }
    }

    fn snapshot_of(inner: &mut Inner) -> StudioSnapshot {
        let settings = inner.settings_view();
        let session = &inner.session;
        StudioSnapshot {
            connection: inner.connection.clone(),
            connection_generation: inner.bootstrap_generation,
            bootstrapped: inner.bootstrapped,
            session: SessionView {
                phase: session.phase(),
                status: session.status().clone(),
                activity: session.activity(),
                intent: session.active_intent(),
                start_pending: session.start_pending(),
                stop_pending: session.stop_pending(),
                stop_overrun: session.stop_overrun(),
                stop_confirmation: session.stop_confirmation().cloned(),
                start_failure: session.start_failure().cloned(),
                notice: session.runtime_notice().cloned(),
                microphone_notice: inner.notices.microphone_notice().cloned(),
                finalization: inner.finalization.clone(),
                live_streaming: inner.live_streaming.clone(),
            },
            sources: inner.sources.clone(),
            health: inner.health.clone(),
            settings,
            last_error: inner.last_error.clone(),
            capture_exclusion: CaptureExclusionView {
                wanted: inner.exclusion.wanted.clone(),
                last: inner.exclusion.last.clone(),
            },
            record_latency: inner.latency.last.clone(),
            scenes: inner.scenes_view(),
            live_sources: inner.live_sources.view.clone(),
            source_reasons: inner.source_reasons.clone(),
        }
    }
}

/// What the toasts read about the session (S3.0f).
fn session_context(session: &SessionState) -> SessionContext<'_> {
    SessionContext {
        status: session.status(),
        last_session_id: session.last_session_id(),
        activity: session.activity(),
        failure_notice: session.runtime_notice().is_some(),
    }
}

/// The backend's normalisation (`normalized_protected_overlay_window_ids`):
/// no zero ids, sorted, no repeats, so equal sets compare equal.
fn normalized_window_ids(mut ids: Vec<u32>) -> Vec<u32> {
    ids.retain(|id| *id > 0);
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// `connectionBlockedReason(wsStatus)`: null while connected.
pub fn connection_blocked_reason(connection: &Connection) -> Option<&'static str> {
    match connection {
        Connection::Connected { .. } => None,
        Connection::Waiting => Some(start_blocked_copy::ENGINE_STARTING),
        Connection::Disconnected { .. } => Some(start_blocked_copy::RECONNECTING),
    }
}

/// `sessionStartFailureMessage`: a known refusal's copy (#1408: never the
/// backend's words, which may name a device), else the backend's reason,
/// never the transport's wrapper.
pub fn start_failure_message(error: &RpcError) -> String {
    if let Some(reason) = crate::user_error::known_error_reason(error) {
        return reason.to_string();
    }
    let message = error.message.trim();
    if message.is_empty() {
        "The session couldn't start.".to_string()
    } else {
        message.to_string()
    }
}

/// The End livestream question's destinations: each enabled target's
/// `label || platform` (the platform's wire id when the label is empty).
pub fn stop_destination_labels(streaming: &StreamingSettings) -> Vec<String> {
    streaming
        .targets
        .iter()
        .filter(|target| target.enabled)
        .map(|target| {
            if target.label.is_empty() {
                serde_json::to_value(target.platform)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string))
                    .unwrap_or_default()
            } else {
                target.label.clone()
            }
        })
        .collect()
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// `buildStartSessionParams` (`lib/session-params.ts`), the Phase 2 part:
/// the saved capture config with the intent's flags in place of the saved
/// mode. The legacy `rtmp` block is the config's `rtmpPreset`,
/// `rtmpServerUrl` and `streamKey` ([`CaptureConfig::rtmp`]), as the renderer
/// sends it.
/// The scene with its background is the start's (`Inner::start_scene`,
/// set by `start_once`); this leaves it `None`.
/// Camera looks, captions, simulcast, the
/// replay ring and the output-directory capability are Phase 3; the backend
/// records into its default directory (`VIDEORC_RECORDINGS_DIR` under an
/// isolated profile).
pub fn build_start_params(
    capture: &CaptureConfig,
    studio: &StudioSettings,
    intent: SessionStartIntent,
    streaming: Option<StreamingSettings>,
) -> Result<StartSessionParams, String> {
    // S3.1a: the start-blocking table's words (`START_BLOCKED_COPY`), as the
    // renderer refuses the same starts before it asks.
    if !intent.record && !intent.stream {
        return Err(start_blocked_copy::NO_OUTPUT.to_string());
    }
    let streaming = if intent.stream {
        let streaming = streaming
            .filter(|streaming| streaming.targets.iter().any(|target| target.enabled))
            .ok_or_else(|| start_blocked_copy::NO_DESTINATION.to_string())?;
        Some(streaming)
    } else {
        None
    };
    let separate_source_recordings = Some(capture.separate_source_recordings)
        .filter(|settings| intent.record && settings.enabled);
    let rtmp = capture.rtmp();
    // S3.1a: `cameraLookLayout`: the chosen camera's look from the settings
    // (`settings.cameraLooks`) replaces whatever look the layout held; no
    // look for that camera is the neutral one.
    // S1.6b part 4 (plan 258): the camera's background too, and its key once
    // the D4 migration settled (`cameraOutputLayout`).
    let layout = preview_scene::camera_output_layout(
        &capture.layout,
        capture.sources.camera_id.as_deref(),
        studio,
    );
    // `buildSimulcastParams` (the vertical leg from the on-stream scene's
    // 9:16 layout, #1543) lands with the scenes (S1.6b).
    let simulcast = None;
    Ok(StartSessionParams {
        sources: capture.sources.clone(),
        layout,
        scene: None,
        output: OutputSettings {
            record_enabled: intent.record,
            stream_enabled: intent.stream,
            output_directory: None,
            ffmpeg_path: None,
            keep_original_mkv: studio.keep_original_recording(),
            separate_source_recordings,
            video: capture.video.clone(),
            rtmp,
        },
        audio: capture.audio.clone(),
        streaming,
        captions: None,
        simulcast,
        requested_at_ms: Some(epoch_ms()),
        replay: None,
        purpose: SessionPurpose::Capture,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_protocol::streaming::{StreamMode, StreamTargetSettings};
    use videorc_protocol::{SeparateSourceRecordingsSettings, VideoPreset};

    fn target(enabled: bool) -> StreamTargetSettings {
        serde_json::from_value(serde_json::json!({
            "id": "twitch", "platform": "twitch", "label": "Twitch", "enabled": enabled,
            "serverUrl": "rtmp://live.twitch.tv/app", "streamKey": "k",
            "streamKeyPresent": true, "authMode": "manual-rtmp",
                "createdAt": "2026-11-08T00:00:00Z", "updatedAt": "2026-11-08T00:00:00Z"
        }))
        .unwrap()
    }

    fn streaming(enabled: bool) -> StreamingSettings {
        StreamingSettings {
            enabled: true,
            mode: StreamMode::Single,
            targets: vec![target(enabled)],
            selected_target_id: None,
            default_output_preset: VideoPreset::Tutorial1080p30,
            default_bitrate_kbps: 6_000,
            enabled_target_ids: Vec::new(),
        }
    }

    #[test]
    fn record_params_follow_the_intent_not_the_saved_mode() {
        let mut capture = CaptureConfig {
            record_enabled: false,
            stream_enabled: true,
            separate_source_recordings: SeparateSourceRecordingsSettings {
                enabled: true,
                keep_combined: true,
            },
            rtmp_preset: Some("twitch".to_string()),
            rtmp_server_url: " rtmp://live.twitch.tv/app ".to_string(),
            ..CaptureConfig::default()
        };
        capture.sources.test_pattern = true;
        let mut studio = StudioSettings::default();
        studio.set("keepOriginalRecording", Value::Bool(true));
        let params =
            build_start_params(&capture, &studio, SessionStartIntent::RECORD, None).unwrap();
        assert!(params.output.record_enabled);
        assert!(!params.output.stream_enabled);
        assert!(params.streaming.is_none());
        assert!(params.output.keep_original_mkv);
        assert!(params.output.separate_source_recordings.is_some());
        assert!(params.sources.test_pattern);
        assert!(params.layout.camera_look.is_neutral(), "no camera, no look");
        // S3.1a: the chosen camera's look rides the layout (`cameraLookLayout`).
        let mut with_camera = capture.clone();
        with_camera.sources.camera_id = Some("cam-1".to_string());
        studio.set(
            "cameraLooks",
            json!({"cam-1": {"brightness": 0.2, "contrast": 1.1, "saturation": 0.9}}),
        );
        let looked =
            build_start_params(&with_camera, &studio, SessionStartIntent::RECORD, None).unwrap();
        assert_eq!(looked.layout.camera_look.brightness, 0.2);
        assert_eq!(looked.layout.camera_look.contrast, 1.1);
        with_camera.sources.camera_id = Some("cam-2".to_string());
        let other =
            build_start_params(&with_camera, &studio, SessionStartIntent::RECORD, None).unwrap();
        assert!(
            other.layout.camera_look.is_neutral(),
            "another camera's look stays"
        );
        assert_eq!(params.output.rtmp.server_url, "rtmp://live.twitch.tv/app");
        assert!(matches!(
            params.output.rtmp.preset,
            videorc_protocol::RtmpPreset::Twitch
        ));
        assert!(params.requested_at_ms.is_some());
        let wire = serde_json::to_value(&params).unwrap();
        // Today's protocol writes `null` (no `skip_serializing_if` yet, L2);
        // the backend reads absent and `null` alike.
        assert!(
            wire["output"]
                .get("outputDirectory")
                .is_none_or(Value::is_null)
        );
        assert!(wire.get("captions").is_none_or(Value::is_null));
    }

    #[test]
    fn go_live_params_need_an_enabled_destination() {
        let capture = CaptureConfig::default();
        let studio = StudioSettings::default();
        let intent = SessionStartIntent::livestream(false);
        assert!(build_start_params(&capture, &studio, intent, None).is_err());
        assert!(build_start_params(&capture, &studio, intent, Some(streaming(false))).is_err());
        let params = build_start_params(&capture, &studio, intent, Some(streaming(true))).unwrap();
        assert!(params.output.stream_enabled);
        assert!(!params.output.record_enabled);
        assert!(params.streaming.is_some());
        assert!(
            params.output.separate_source_recordings.is_none(),
            "ISO files need a recording"
        );
        let both = build_start_params(
            &capture,
            &studio,
            SessionStartIntent::livestream(true),
            Some(streaming(true)),
        )
        .unwrap();
        assert!(both.output.record_enabled && both.output.stream_enabled);
        assert!(
            build_start_params(
                &capture,
                &studio,
                SessionStartIntent {
                    record: false,
                    stream: false
                },
                None
            )
            .is_err()
        );
    }

    #[test]
    fn the_failure_message_is_the_backend_reason() {
        assert_eq!(
            start_failure_message(&RpcError::new("session.start", "x", " No camera. ")),
            "No camera."
        );
        assert_eq!(
            start_failure_message(&RpcError::new("session.start", "x", "")),
            "The session couldn't start."
        );
        // #1408: a known refusal says its copy, never the backend's words.
        assert_eq!(
            start_failure_message(&RpcError::new(
                "session.start",
                "layout-camera-not-ready",
                "camera:FaceTime HD sent no frame"
            )),
            "Your camera isn't sending video. Check it in Sources, then try again."
        );
    }

    #[test]
    fn the_end_livestream_question_names_the_saved_destinations_that_are_on() {
        let mut youtube = target(true);
        youtube.label = String::new();
        let mut twitch = target(true);
        twitch.label = "My Twitch".to_string();
        let off = target(false);
        let streaming = StreamingSettings {
            targets: vec![youtube.clone(), twitch, off],
            ..streaming(true)
        };
        let platform = serde_json::to_value(youtube.platform).unwrap();
        assert_eq!(
            stop_destination_labels(&streaming),
            [
                platform.as_str().unwrap().to_string(),
                "My Twitch".to_string()
            ]
        );
    }
}
