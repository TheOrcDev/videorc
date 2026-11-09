//! The checks (plan 223 D1, D4, D9 and the catalogue): pure state machines
//! fed one `Signals` snapshot a second. Every threshold, guard and fold
//! lives here, with the card's exact words; the runtime only gathers the
//! signals and announces the transitions.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use super::alerts::{
    AlertFix, AlertSeverity, AlertSource, AlertSpec, Clock, FixKind, Transition, WatchdogCheck,
    WatchdogState, alert_key, format_clock,
};
use super::settings::WatchdogSettings;

/// Master mix under this is silence (the catalogue: `program-silent`).
pub const PROGRAM_SILENT_FLOOR_DB: f32 = -60.0;
/// A bed (system audio or a sound) above this is "music playing".
pub const MUSIC_BED_FLOOR_DB: f32 = -40.0;
/// `pcm_has_voice`'s floor (captions.rs): a 50 ms window above it is voice.
pub const VOICE_FLOOR_DB: f32 = -45.0;
/// `no-voice` clears after this much voice.
pub const VOICE_CLEARS_AFTER: Duration = Duration::from_secs(2);
/// Mean luma under 16/255 is video black (BT.601 limited range).
pub const BLACK_LUMA: u8 = 16;
/// A takeover whose own image averages under this (and is not black) is
/// dark by design and suppresses `picture-black` while it is active.
pub const DARK_TAKEOVER_LUMA: u8 = 48;
/// The runner's `frozenSeconds` reads as a stopped picture at this (C1).
pub const CLOUD_FROZEN_AFTER: Duration = Duration::from_secs(3);
/// `av-drift` (cloud only): skew above this, for the threshold.
pub const AV_DRIFT_SKEW_MS: f64 = 300.0;
/// The content checks (silence, black) start counting this long into a
/// session: the bus and the first frames take a moment, and a stream that
/// really starts dead still alarms a few seconds later.
pub const STARTUP_GRACE: Duration = Duration::from_secs(5);

/// Every threshold, with the dev-build overrides (D4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thresholds {
    pub mic_muted: Duration,
    pub no_voice: Duration,
    pub program_silent: Duration,
    pub picture_black: Duration,
    pub picture_stopped: Duration,
    /// Three stalled `compositor-render` windows (capture_health.rs: 2 s each).
    pub render_stopped: Duration,
    pub destination_down: Duration,
    pub bitrate_floor: Duration,
    pub av_drift: Duration,
    pub brb_long: Duration,
    pub still_there: Duration,
}

impl Thresholds {
    pub fn defaults(settings: &WatchdogSettings) -> Self {
        Self {
            mic_muted: Duration::from_secs(u64::from(settings.mic_muted_after_seconds)),
            no_voice: Duration::from_secs(5 * 60),
            program_silent: Duration::from_secs(20),
            picture_black: Duration::from_secs(10),
            picture_stopped: Duration::from_secs(5),
            render_stopped: Duration::from_secs(6),
            destination_down: Duration::from_secs(20),
            bitrate_floor: Duration::from_secs(2 * 60),
            av_drift: Duration::from_secs(10),
            brb_long: Duration::from_secs(10 * 60),
            still_there: Duration::from_secs(10 * 60),
        }
    }

    /// `VIDEORC_WATCHDOG_<CHECK>_AFTER_MS` from `lookup`, dev builds only:
    /// a packaged build refuses them like every other dev switch.
    pub fn with_overrides(
        mut self,
        packaged: bool,
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Self {
        if packaged {
            return self;
        }
        let read = |check: WatchdogCheck, slot: &mut Duration| {
            if let Some(ms) = lookup(&check.threshold_env())
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|ms| *ms > 0)
            {
                *slot = Duration::from_millis(ms);
            }
        };
        read(WatchdogCheck::MicMuted, &mut self.mic_muted);
        read(WatchdogCheck::NoVoice, &mut self.no_voice);
        read(WatchdogCheck::ProgramSilent, &mut self.program_silent);
        read(WatchdogCheck::PictureBlack, &mut self.picture_black);
        read(WatchdogCheck::PictureStopped, &mut self.picture_stopped);
        read(WatchdogCheck::DestinationDown, &mut self.destination_down);
        read(WatchdogCheck::BitrateFloor, &mut self.bitrate_floor);
        read(WatchdogCheck::AvDrift, &mut self.av_drift);
        read(WatchdogCheck::BrbLong, &mut self.brb_long);
        read(WatchdogCheck::StillThere, &mut self.still_there);
        self
    }
}

/// The last second of the `audio.levels` sampler, folded (the runtime keeps
/// the loudest 50 ms reading of each line; a line that never read is None).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct AudioWindow {
    /// The loudest RMS of the mix written to the stream this second.
    pub master_rms_db: Option<f32>,
    /// The loudest post-gain microphone RMS this second.
    pub microphone_rms_db: Option<f32>,
    /// The loudest system-audio or soundboard RMS this second.
    pub bed_rms_db: Option<f32>,
}

impl AudioWindow {
    fn silent(&self) -> bool {
        self.master_rms_db
            .is_some_and(|rms| rms < PROGRAM_SILENT_FLOOR_DB)
    }

    fn music_playing(&self) -> bool {
        self.bed_rms_db.is_some_and(|rms| rms > MUSIC_BED_FLOOR_DB)
    }

    fn voice(&self) -> bool {
        self.microphone_rms_db
            .is_some_and(|rms| rms > VOICE_FLOOR_DB)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TakeoverSignal {
    pub since: Instant,
    /// The wall clock of `since`, for "since 12:04".
    pub activated_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Mean luma of its own image (D10's guard), from the watchdog's cache:
    /// the Screens transition decodes it, the tick reads it every second.
    pub luma: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DestinationPhase {
    Live,
    Connecting,
    Reconnecting,
    /// Plan 161's `warning`: the platform says it is not receiving.
    NotReceiving,
    Failed,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationSignal {
    pub target_id: String,
    pub label: String,
    pub platform: String,
    pub phase: DestinationPhase,
    /// When the leg entered its phase.
    pub since: Instant,
    /// The runner's leg (a cloud show): Reconnect is a real fix (D8).
    pub cloud: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformHealthKind {
    NoAudio,
    NoVideo,
    /// X: the broadcast's `state` is `ENDED` while we stream.
    Ended,
    Problem,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformHealthSignal {
    pub target_id: String,
    pub label: String,
    pub platform: String,
    pub kind: PlatformHealthKind,
    pub critical: bool,
    pub description: Option<String>,
    pub dashboard_url: Option<String>,
}

/// The runner's `program` block as the desktop reads it (C1, C3), plus the
/// hold flag the readers need and the feed's bitrate ratio.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CloudSignal {
    pub hold_active: bool,
    pub audio_silent_seconds: Option<u64>,
    pub black_seconds: Option<u64>,
    pub frozen_seconds: Option<u64>,
    pub av_skew_ms: Option<f64>,
    /// When the feed's kbps fell under half the chosen bitrate.
    pub feed_low_since: Option<Instant>,
}

/// A chat decision from `chat_signals` (B1, B2): the class, how many
/// distinct people, and their lines for the card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatDecision {
    pub class: super::chat_signals::ChatClass,
    pub people: usize,
    pub quotes: Vec<String>,
    /// B2: one author plus a confident AI answer.
    pub ai: bool,
}

/// One tick's worth of signals.
#[derive(Debug, Clone, Default)]
pub struct Signals<'a> {
    pub live: bool,
    /// How long the session has run; the content checks wait out
    /// [`STARTUP_GRACE`].
    pub session_age: Duration,
    pub mic_muted: bool,
    pub takeover: Option<TakeoverSignal>,
    pub audio: AudioWindow,
    pub stream_stalled_since: Option<Instant>,
    pub render_stalled_since: Option<Instant>,
    /// `screen-delivery` collapsed too: "The screen hasn't changed either."
    pub screen_still: bool,
    /// The desktop's 1 Hz luma sample read black (A7).
    pub black_since: Option<Instant>,
    pub bitrate_floor_since: Option<Instant>,
    pub destinations: &'a [DestinationSignal],
    pub platform_health: &'a [PlatformHealthSignal],
    pub cloud: Option<CloudSignal>,
    pub system_idle: Option<Duration>,
    pub chat: &'a [ChatDecision],
}

/// The checks' own clocks between ticks.
#[derive(Debug, Default)]
pub struct Checks {
    mic_muted_since: Option<Instant>,
    program_silent_since: Option<Instant>,
    last_voice: Option<Instant>,
    voice_since: Option<Instant>,
    no_voice_armed_at: Option<Instant>,
    av_drift_since: Option<Instant>,
    chat_last_opened: BTreeMap<super::chat_signals::ChatClass, Instant>,
    still_there_quiet_since: Option<Instant>,
}

/// At most one `chat-says` alert per class per ten minutes.
pub const CHAT_SAYS_COOLDOWN: Duration = Duration::from_secs(10 * 60);

impl Checks {
    pub fn new() -> Self {
        Self::default()
    }

    /// One tick. Opens, refreshes and clears alerts in `state`; returns the
    /// transitions the runtime announces.
    pub fn tick(
        &mut self,
        signals: &Signals<'_>,
        thresholds: &Thresholds,
        settings: &WatchdogSettings,
        state: &mut WatchdogState,
        clock: Clock,
    ) -> Vec<Transition> {
        let mut out = Vec::new();
        if !signals.live {
            // D3: not live means no new check. Anything a live span opened
            // clears with it; the 1064 adoption (mic-silent) is the runtime's.
            self.reset_clocks();
            for check in WatchdogCheck::ALL {
                if check != WatchdogCheck::MicSilent {
                    out.extend(state.clear_prefix(check.id()));
                }
            }
            return out;
        }
        let now = clock.now;
        let takeover = signals.takeover;
        let music = signals.audio.music_playing();
        let warming_up = signals.session_age < STARTUP_GRACE;

        // --- program silence clock (shared by mic-muted's fold) ---
        if signals.audio.silent() && !warming_up {
            self.program_silent_since.get_or_insert(now);
        } else if signals.audio.master_rms_db.is_some() || warming_up {
            self.program_silent_since = None;
        }
        let program_silent_for = self
            .program_silent_since
            .map(|since| now.saturating_duration_since(since))
            .filter(|held| *held >= thresholds.program_silent);

        // --- mic-muted ---
        let mic_key = alert_key(WatchdogCheck::MicMuted, None);
        if signals.mic_muted && takeover.is_none() && settings.enabled(WatchdogCheck::MicMuted) {
            let since = *self.mic_muted_since.get_or_insert(now);
            let held = now.saturating_duration_since(since);
            if held >= thresholds.mic_muted {
                let severity = if music {
                    AlertSeverity::Notice
                } else {
                    AlertSeverity::Critical
                };
                let mut detail = if music {
                    format!(
                        "Muted for {}. Viewers hear your system audio.",
                        format_clock(held)
                    )
                } else {
                    format!("Muted for {}. Viewers hear no voice.", format_clock(held))
                };
                if !music && program_silent_for.is_some() {
                    detail.push_str(" Nothing else is playing.");
                }
                let spec = AlertSpec::new(
                    severity,
                    "Your microphone is muted on the livestream",
                    detail,
                )
                .fix(AlertFix::new(FixKind::Unmute, "Unmute"));
                out.extend(state.open(WatchdogCheck::MicMuted, &mic_key, spec, clock));
            }
        } else {
            self.mic_muted_since = None;
            // Unmuted is a recovery; a takeover over a muted mic, or the
            // switch, is not (M2): the card leaves quietly.
            out.extend(if signals.mic_muted {
                state.withdraw(&mic_key)
            } else {
                state.clear(&mic_key)
            });
        }
        let mic_muted_open = state.is_open(&mic_key);

        // --- program-silent (desktop and cloud, D9 dedupe) ---
        let silent_key = alert_key(WatchdogCheck::ProgramSilent, None);
        let cloud_silent = signals.cloud.and_then(|cloud| {
            (!cloud.hold_active)
                .then_some(cloud.audio_silent_seconds)
                .flatten()
                .map(Duration::from_secs)
                .filter(|held| *held >= thresholds.program_silent)
        });
        let desktop_silent = program_silent_for;
        // A muted microphone explains the silence: the mic check owns the
        // clock and the card (its detail says nothing else is playing), so
        // the mute's own threshold is never preempted. A takeover is the
        // exception: there the silence is a notice of its own.
        let mute_explains =
            signals.mic_muted && takeover.is_none() && settings.enabled(WatchdogCheck::MicMuted);
        if settings.enabled(WatchdogCheck::ProgramSilent)
            && !mic_muted_open
            && !mute_explains
            && (desktop_silent.is_some() || cloud_silent.is_some())
        {
            // The cloud reading wins the detail: it is what left our servers.
            let (held, source) = match (cloud_silent, desktop_silent) {
                (Some(held), _) => (held, AlertSource::Cloud),
                (None, Some(held)) => (held, AlertSource::Desktop),
                (None, None) => unreachable!(),
            };
            let (severity, detail) = if takeover.is_some() {
                (
                    AlertSeverity::Notice,
                    format!("Be right back has been silent for {}.", format_clock(held)),
                )
            } else {
                (
                    AlertSeverity::Critical,
                    format!("No sound has left the stream for {}.", format_clock(held)),
                )
            };
            let fix = if signals.mic_muted {
                AlertFix::new(FixKind::Unmute, "Unmute")
            } else {
                AlertFix::new(FixKind::OpenAudio, "Open Audio")
            };
            let spec = AlertSpec::new(severity, "Viewers hear nothing", detail)
                .source(source)
                .fix(fix);
            out.extend(state.open(WatchdogCheck::ProgramSilent, &silent_key, spec, clock));
        } else if desktop_silent.is_some() || cloud_silent.is_some() {
            // Still silent: the mic card carries it now, or the check is
            // off. "Sound is back" would be false (M2).
            out.extend(state.withdraw(&silent_key));
        } else {
            out.extend(state.clear(&silent_key));
        }

        // --- no-voice ---
        let voice_key = alert_key(WatchdogCheck::NoVoice, None);
        let no_voice_guarded = signals.mic_muted || takeover.is_some() || music || mic_muted_open;
        if signals.audio.voice() {
            self.last_voice = Some(now);
            self.voice_since.get_or_insert(now);
        } else if signals.audio.microphone_rms_db.is_some() {
            self.voice_since = None;
        }
        if no_voice_guarded || !settings.enabled(WatchdogCheck::NoVoice) {
            self.no_voice_armed_at = None;
            // A mute, a takeover, music or the switch explains it: no voice
            // came back (M2).
            out.extend(state.withdraw(&voice_key));
        } else {
            let armed = *self.no_voice_armed_at.get_or_insert(now);
            let quiet_since = self.last_voice.unwrap_or(armed).max(armed);
            let quiet_for = now.saturating_duration_since(quiet_since);
            let voice_held = self
                .voice_since
                .map(|since| now.saturating_duration_since(since))
                .unwrap_or_default();
            if state.is_open(&voice_key) && voice_held >= VOICE_CLEARS_AFTER {
                out.extend(state.clear(&voice_key));
            } else if quiet_for >= thresholds.no_voice && !state.is_open(&voice_key) {
                let spec = AlertSpec::new(
                    AlertSeverity::Warning,
                    "No voice for 5 minutes",
                    "The microphone is on, but nothing is reaching it. Check the device and its level.",
                )
                .fix(AlertFix::new(FixKind::OpenAudio, "Open Audio"));
                out.extend(state.open(WatchdogCheck::NoVoice, &voice_key, spec, clock));
            }
        }

        // --- picture-black (desktop if A7 shipped it, cloud) ---
        let black_key = alert_key(WatchdogCheck::PictureBlack, None);
        // The guard is the active takeover's own luma, read every tick: a
        // direct A→B switch guards on B's image, never on A's verdict (M3).
        let dark_takeover = takeover
            .and_then(|takeover| takeover.luma)
            .is_some_and(|luma| (BLACK_LUMA..DARK_TAKEOVER_LUMA).contains(&luma));
        // The sampler may have read black since the first frame; the clock
        // counts from the end of the grace, like the silence clock.
        let grace_end = (!warming_up)
            .then(|| now.checked_sub(signals.session_age - STARTUP_GRACE))
            .flatten();
        let desktop_black = signals
            .black_since
            .filter(|_| !warming_up)
            .map(|since| grace_end.map_or(since, |end| since.max(end)))
            .map(|since| now.saturating_duration_since(since))
            .filter(|held| *held >= thresholds.picture_black);
        let cloud_black = signals.cloud.and_then(|cloud| {
            (!cloud.hold_active)
                .then_some(cloud.black_seconds)
                .flatten()
                .map(Duration::from_secs)
                .filter(|held| *held >= thresholds.picture_black)
        });
        if settings.enabled(WatchdogCheck::PictureBlack)
            && !dark_takeover
            && (desktop_black.is_some() || cloud_black.is_some())
        {
            let (held, source) = match (cloud_black, desktop_black) {
                (Some(held), _) => (held, AlertSource::Cloud),
                (None, Some(held)) => (held, AlertSource::Desktop),
                (None, None) => unreachable!(),
            };
            let fix = if takeover.is_some() {
                AlertFix::new(FixKind::EndTakeover, "End takeover")
            } else {
                AlertFix::new(FixKind::SwitchScene, "Switch scene")
            };
            let spec = AlertSpec::new(
                AlertSeverity::Critical,
                "Viewers see a black picture",
                format!("The stream has been black for {}.", format_clock(held)),
            )
            .source(source)
            .fix(fix);
            out.extend(state.open(WatchdogCheck::PictureBlack, &black_key, spec, clock));
        } else if desktop_black.is_some() || cloud_black.is_some() {
            // Still black, under a dark card by design or with the check
            // off: not "Picture is back" (M2).
            out.extend(state.withdraw(&black_key));
        } else {
            out.extend(state.clear(&black_key));
        }

        // --- picture-stopped (D1: frame progress only, never pixels) ---
        let stopped_key = alert_key(WatchdogCheck::PictureStopped, None);
        let stream_stalled = signals
            .stream_stalled_since
            .map(|since| now.saturating_duration_since(since))
            .filter(|held| *held >= thresholds.picture_stopped);
        let render_stalled = signals
            .render_stalled_since
            .map(|since| now.saturating_duration_since(since))
            .filter(|held| *held >= thresholds.render_stopped);
        let cloud_frozen = signals.cloud.and_then(|cloud| {
            (!cloud.hold_active)
                .then_some(cloud.frozen_seconds)
                .flatten()
                .map(Duration::from_secs)
                .filter(|held| *held >= CLOUD_FROZEN_AFTER)
        });
        let desktop_stopped = stream_stalled.or(render_stalled);
        if settings.enabled(WatchdogCheck::PictureStopped)
            && (desktop_stopped.is_some() || cloud_frozen.is_some())
        {
            let (held, source) = match (cloud_frozen, desktop_stopped) {
                (Some(held), _) => (held, AlertSource::Cloud),
                (None, Some(held)) => (held, AlertSource::Desktop),
                (None, None) => unreachable!(),
            };
            let mut detail = format!(
                "No new frame has reached the stream for {}. A still screen is fine; this is the pipeline.",
                format_clock(held)
            );
            if signals.screen_still && desktop_stopped.is_some() {
                detail.push_str(" The screen hasn't changed either.");
            }
            let spec = AlertSpec::new(AlertSeverity::Critical, "The picture has stopped", detail)
                .source(source)
                .fix(AlertFix::new(FixKind::SwitchScene, "Switch scene"))
                .fix(AlertFix::new(FixKind::OpenHealth, "Open Health"));
            out.extend(state.open(WatchdogCheck::PictureStopped, &stopped_key, spec, clock));
        } else if desktop_stopped.is_some() || cloud_frozen.is_some() {
            out.extend(state.withdraw(&stopped_key));
        } else {
            out.extend(state.clear(&stopped_key));
        }

        // --- destination-down (one per destination; every one down folds) ---
        self.tick_destinations(signals, thresholds, settings, state, clock, &mut out);

        // --- platform-health ---
        let mut health_keys = Vec::new();
        if !settings.enabled(WatchdogCheck::PlatformHealth) {
            out.extend(state.withdraw_prefix(WatchdogCheck::PlatformHealth.id()));
        } else {
            for signal in signals.platform_health {
                let key = alert_key(WatchdogCheck::PlatformHealth, Some(&signal.target_id));
                health_keys.push(key.clone());
                let title = match signal.kind {
                    PlatformHealthKind::NoAudio => format!("{} reports no audio", signal.label),
                    PlatformHealthKind::NoVideo => format!("{} reports no video", signal.label),
                    PlatformHealthKind::Ended => format!("{} ended the broadcast", signal.label),
                    PlatformHealthKind::Problem => format!("{} reports a problem", signal.label),
                };
                let detail = signal
                    .description
                    .clone()
                    .filter(|text| !text.trim().is_empty())
                    .unwrap_or_else(|| format!("Check {}'s live dashboard.", signal.label));
                let mut spec = AlertSpec::new(
                    if signal.critical {
                        AlertSeverity::Critical
                    } else {
                        AlertSeverity::Warning
                    },
                    title,
                    detail,
                )
                .source(AlertSource::Platform)
                .platform(Some(signal.platform.clone()))
                .target(Some(signal.target_id.clone()));
                if let Some(url) = &signal.dashboard_url {
                    spec = spec.fix(
                        AlertFix::new(
                            FixKind::OpenPlatformDashboard,
                            format!("Open {} dashboard", signal.label),
                        )
                        .with_url(url.clone()),
                    );
                }
                out.extend(state.open(WatchdogCheck::PlatformHealth, &key, spec, clock));
            }
        }
        let stale: Vec<String> = state
            .alerts()
            .iter()
            .filter(|alert| alert.check == WatchdogCheck::PlatformHealth)
            .map(|alert| alert_key(WatchdogCheck::PlatformHealth, alert.target_id.as_deref()))
            .filter(|key| !health_keys.contains(key))
            .collect();
        for key in stale {
            out.extend(state.clear(&key));
        }

        // --- bitrate-floor ---
        let floor_key = alert_key(WatchdogCheck::BitrateFloor, None);
        let desktop_floor = signals
            .bitrate_floor_since
            .map(|since| now.saturating_duration_since(since))
            .filter(|held| *held >= thresholds.bitrate_floor);
        let cloud_floor = signals
            .cloud
            .and_then(|cloud| cloud.feed_low_since)
            .map(|since| now.saturating_duration_since(since))
            .filter(|held| *held >= thresholds.bitrate_floor);
        if settings.enabled(WatchdogCheck::BitrateFloor)
            && (desktop_floor.is_some() || cloud_floor.is_some())
        {
            let source = if desktop_floor.is_some() {
                AlertSource::Desktop
            } else {
                AlertSource::Cloud
            };
            let spec = AlertSpec::new(
                AlertSeverity::Warning,
                "Connection too slow for 2 minutes",
                "The stream is at half its bitrate and viewers still see skipping. Fewer destinations or a wired connection would help.",
            )
            .source(source)
            .fix(AlertFix::new(FixKind::OpenHealth, "Open Health"));
            out.extend(state.open(WatchdogCheck::BitrateFloor, &floor_key, spec, clock));
        } else if desktop_floor.is_some() || cloud_floor.is_some() {
            out.extend(state.withdraw(&floor_key));
        } else {
            out.extend(state.clear(&floor_key));
        }

        // --- av-drift (cloud only) ---
        let drift_key = alert_key(WatchdogCheck::AvDrift, None);
        let skew = signals
            .cloud
            .filter(|cloud| !cloud.hold_active)
            .and_then(|cloud| cloud.av_skew_ms);
        match skew {
            Some(skew) if skew.abs() > AV_DRIFT_SKEW_MS => {
                let since = *self.av_drift_since.get_or_insert(now);
                if settings.enabled(WatchdogCheck::AvDrift)
                    && now.saturating_duration_since(since) >= thresholds.av_drift
                {
                    let spec = AlertSpec::new(
                        AlertSeverity::Warning,
                        "Sound and picture are drifting apart",
                        format!(
                            "Videorc Cloud measures {:.1} s between them.",
                            skew.abs() / 1000.0
                        ),
                    )
                    .source(AlertSource::Cloud)
                    .fix(AlertFix::new(FixKind::OpenHealth, "Open Health"));
                    out.extend(state.open(WatchdogCheck::AvDrift, &drift_key, spec, clock));
                }
            }
            _ => {
                self.av_drift_since = None;
                out.extend(state.clear(&drift_key));
            }
        }

        // --- chat-says ---
        self.tick_chat(signals, settings, state, clock, &mut out);

        // --- brb-long ---
        let brb_key = alert_key(WatchdogCheck::BrbLong, None);
        match takeover {
            Some(takeover)
                if settings.enabled(WatchdogCheck::BrbLong)
                    && now.saturating_duration_since(takeover.since) >= thresholds.brb_long =>
            {
                let since = time_of_day(takeover.activated_at.unwrap_or_else(|| {
                    clock.wall
                        - chrono::Duration::from_std(now.saturating_duration_since(takeover.since))
                            .unwrap_or_default()
                }));
                let minutes = now.saturating_duration_since(takeover.since).as_secs() / 60;
                let spec = AlertSpec::new(
                    AlertSeverity::Notice,
                    format!("Be right back for {minutes} minutes"),
                    format!("Viewers have seen the takeover since {since}."),
                )
                .fix(AlertFix::new(FixKind::EndTakeover, "End takeover"))
                .repeat_every(thresholds.brb_long);
                out.extend(state.open(WatchdogCheck::BrbLong, &brb_key, spec, clock));
            }
            _ => out.extend(state.clear(&brb_key)),
        }

        // --- still-there (D4: a notice, never a push) ---
        let still_key = alert_key(WatchdogCheck::StillThere, None);
        let idle_long = signals
            .system_idle
            .is_some_and(|idle| idle >= thresholds.still_there);
        let quiet_long = {
            let armed = *self.still_there_quiet_since.get_or_insert(now);
            let last = self.last_voice.unwrap_or(armed).max(armed);
            now.saturating_duration_since(last) >= thresholds.still_there
        };
        if settings.enabled(WatchdogCheck::StillThere)
            && takeover.is_none()
            && idle_long
            && quiet_long
        {
            let spec = AlertSpec::new(
                AlertSeverity::Notice,
                "Still there?",
                "No voice and no input for 10 minutes.",
            )
            .fix(AlertFix::new(FixKind::ShowBrb, "Show Be right back"));
            out.extend(state.open(WatchdogCheck::StillThere, &still_key, spec, clock));
        } else if idle_long && quiet_long {
            // Be right back is up, or the check is off: nobody came back.
            out.extend(state.withdraw(&still_key));
        } else {
            out.extend(state.clear(&still_key));
        }

        out.extend(state.tick(clock));
        out
    }

    fn tick_destinations(
        &mut self,
        signals: &Signals<'_>,
        thresholds: &Thresholds,
        settings: &WatchdogSettings,
        state: &mut WatchdogState,
        clock: Clock,
        out: &mut Vec<Transition>,
    ) {
        let check = WatchdogCheck::DestinationDown;
        if !settings.enabled(check) {
            out.extend(state.withdraw_prefix(check.id()));
            return;
        }
        let now = clock.now;
        let counted: Vec<&DestinationSignal> = signals
            .destinations
            .iter()
            .filter(|destination| destination.phase != DestinationPhase::Other)
            .collect();
        struct Down<'a> {
            destination: &'a DestinationSignal,
            spec: AlertSpec,
        }
        let mut down: Vec<Down<'_>> = Vec::new();
        for destination in &counted {
            let held = now.saturating_duration_since(destination.since);
            let label = destination.label.as_str();
            let spec = match destination.phase {
                DestinationPhase::Reconnecting if destination.cloud => AlertSpec::new(
                    AlertSeverity::Warning,
                    format!("{label} has been down for {}", format_clock(held)),
                    "Videorc Cloud is retrying. Reconnect starts it over.",
                )
                .source(AlertSource::Cloud)
                .fix(AlertFix::new(
                    FixKind::ReconnectDestination,
                    format!("Reconnect {label}"),
                )),
                DestinationPhase::Failed if destination.cloud => AlertSpec::new(
                    AlertSeverity::Warning,
                    format!("{label} has been down for {}", format_clock(held)),
                    "Videorc Cloud is retrying. Reconnect starts it over.",
                )
                .source(AlertSource::Cloud)
                .fix(AlertFix::new(
                    FixKind::ReconnectDestination,
                    format!("Reconnect {label}"),
                )),
                DestinationPhase::Reconnecting => {
                    if held < thresholds.destination_down {
                        continue;
                    }
                    AlertSpec::new(
                        AlertSeverity::Warning,
                        format!("{label} has been down for {}", format_clock(held)),
                        "Videorc is retrying every 2 seconds. Viewers there see nothing until it's back.",
                    )
                }
                DestinationPhase::Failed => AlertSpec::new(
                    AlertSeverity::Warning,
                    format!("Streaming to {label} stopped"),
                    format!(
                        "Videorc can't reconnect {label} without a gap on the others. Keep going, or end the livestream and go live again."
                    ),
                )
                .fix(AlertFix::new(FixKind::OpenLivestream, "Open Livestream")),
                DestinationPhase::NotReceiving => AlertSpec::new(
                    AlertSeverity::Warning,
                    format!("{label} isn't receiving your stream"),
                    "Videorc is still sending it. Check the platform's live dashboard.",
                )
                .source(AlertSource::Platform),
                DestinationPhase::Live | DestinationPhase::Connecting | DestinationPhase::Other => {
                    continue;
                }
            };
            let spec = spec
                .platform(Some(destination.platform.clone()))
                .target(Some(destination.target_id.clone()));
            down.push(Down { destination, spec });
        }
        let all_down = !counted.is_empty()
            && counted.iter().all(|destination| {
                !matches!(
                    destination.phase,
                    DestinationPhase::Live | DestinationPhase::Connecting
                )
            })
            && down.len() == counted.len();
        let all_key = alert_key(check, Some("all"));
        let mut keep = Vec::new();
        if all_down {
            // Every per-destination card folds into the one critical card.
            let first = &down[0];
            let reason = first.spec.detail.clone();
            let fix = if first.destination.cloud {
                AlertFix::new(
                    FixKind::ReconnectDestination,
                    format!("Reconnect {}", first.destination.label),
                )
            } else {
                AlertFix::new(FixKind::OpenLivestream, "Open Livestream")
            };
            let spec = AlertSpec::new(
                AlertSeverity::Critical,
                "Nobody is receiving your stream",
                format!("Every destination is down. {reason}"),
            )
            .source(first.spec.source)
            .target(Some("all".to_string()))
            .fix(fix);
            keep.push(all_key.clone());
            out.extend(state.open(check, &all_key, spec, clock));
        } else {
            for Down { destination, spec } in down {
                let key = alert_key(check, Some(&destination.target_id));
                keep.push(key.clone());
                out.extend(state.open(check, &key, spec, clock));
            }
        }
        let stale: Vec<String> = state
            .alerts()
            .iter()
            .filter(|alert| alert.check == check)
            .map(|alert| alert_key(check, alert.target_id.as_deref()))
            .filter(|key| !keep.contains(key))
            .collect();
        for key in stale {
            // The fold (every leg down: the per-leg cards go into one) and
            // the unfold (one leg back: the one card goes back to per-leg
            // cards) are quiet; nothing came back (M2). A leg that is live
            // again, or every leg back, is a recovery.
            let fold = all_down && key != all_key;
            let unfold = key == all_key && !keep.is_empty();
            out.extend(if fold || unfold {
                state.withdraw(&key)
            } else {
                state.clear(&key)
            });
        }
    }

    fn tick_chat(
        &mut self,
        signals: &Signals<'_>,
        settings: &WatchdogSettings,
        state: &mut WatchdogState,
        clock: Clock,
        out: &mut Vec<Transition>,
    ) {
        use super::chat_signals::ChatClass;
        let check = WatchdogCheck::ChatSays;
        if !settings.enabled(check) {
            out.extend(state.withdraw_prefix(check.id()));
            return;
        }
        let now = clock.now;
        let mut keep = Vec::new();
        for decision in signals.chat {
            let key = alert_key(check, Some(decision.class.id()));
            if !state.is_open(&key)
                && self
                    .chat_last_opened
                    .get(&decision.class)
                    .is_some_and(|last| now.saturating_duration_since(*last) < CHAT_SAYS_COOLDOWN)
            {
                continue;
            }
            keep.push(key.clone());
            let title = match decision.class {
                ChatClass::Audio => "Chat says they can't hear you",
                ChatClass::Video => "Chat says the stream is frozen",
                ChatClass::Lag => "Chat says the stream is lagging",
            };
            let people = match decision.people {
                1 => "1 person".to_string(),
                n => format!("{n} people"),
            };
            let quotes = decision
                .quotes
                .iter()
                .map(|quote| format!("\u{201c}{quote}\u{201d}"))
                .collect::<Vec<_>>()
                .join(", ");
            let detail = if quotes.is_empty() {
                format!("{people} in the last 2 minutes.")
            } else {
                format!("{people} in the last 2 minutes: {quotes}.")
            };
            let mut spec = AlertSpec::new(AlertSeverity::Warning, title, detail)
                .target(Some(decision.class.id().to_string()));
            spec = match decision.class {
                ChatClass::Audio => spec.fix(if signals.mic_muted {
                    AlertFix::new(FixKind::Unmute, "Unmute")
                } else {
                    AlertFix::new(FixKind::OpenAudio, "Open Audio")
                }),
                ChatClass::Video => spec.fix(AlertFix::new(FixKind::SwitchScene, "Switch scene")),
                ChatClass::Lag => spec.fix(AlertFix::new(FixKind::OpenHealth, "Open Health")),
            };
            match state.open(check, &key, spec, clock) {
                Some(Transition::Opened(alert)) => {
                    self.chat_last_opened.insert(decision.class, now);
                    out.push(Transition::Opened(alert));
                }
                Some(transition) => out.push(transition),
                None => {}
            }
        }
        let stale: Vec<String> = state
            .alerts()
            .iter()
            .filter(|alert| alert.check == check)
            .map(|alert| alert_key(check, alert.target_id.as_deref()))
            .filter(|key| !keep.contains(key))
            .collect();
        for key in stale {
            out.extend(state.clear(&key));
        }
    }

    fn reset_clocks(&mut self) {
        *self = Self::default();
    }
}

/// "12:04", the local wall clock of an instant in the card's words.
fn time_of_day(wall: chrono::DateTime<chrono::Utc>) -> String {
    wall.with_timezone(&chrono::Local)
        .format("%H:%M")
        .to_string()
}

/// The 1064 silence watchdog adopted into the alert model (A2): the notice
/// copy unchanged, the backend's line as the detail, Open Audio as the fix.
pub fn mic_silent_spec(live: bool, message: &str) -> AlertSpec {
    AlertSpec::new(
        AlertSeverity::Critical,
        if live {
            "Your microphone is silent on the livestream"
        } else {
            "Your microphone is silent in the recording"
        },
        message,
    )
    .fix(AlertFix::new(FixKind::OpenAudio, "Open Audio"))
}

#[cfg(test)]
mod tests {
    use super::super::chat_signals::ChatClass;
    use super::*;

    fn clock() -> Clock {
        Clock {
            now: Instant::now(),
            wall: chrono::DateTime::parse_from_rfc3339("2026-11-08T12:04:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        }
    }

    fn settings() -> WatchdogSettings {
        WatchdogSettings::default()
    }

    fn thresholds() -> Thresholds {
        Thresholds::defaults(&settings())
    }

    /// Runs `seconds` one-second ticks of `signals`, returning everything.
    fn run(
        checks: &mut Checks,
        state: &mut WatchdogState,
        start: Clock,
        seconds: u64,
        signals: &Signals<'_>,
    ) -> Vec<Transition> {
        let mut out = Vec::new();
        for second in 0..seconds {
            out.extend(checks.tick(
                signals,
                &thresholds(),
                &settings(),
                state,
                start.plus(Duration::from_secs(second)),
            ));
        }
        out
    }

    fn live() -> Signals<'static> {
        Signals {
            live: true,
            session_age: Duration::from_secs(60),
            audio: AudioWindow {
                master_rms_db: Some(-30.0),
                microphone_rms_db: Some(-30.0),
                bed_rms_db: None,
            },
            ..Default::default()
        }
    }

    fn opened(out: &[Transition]) -> Vec<(WatchdogCheck, AlertSeverity)> {
        out.iter()
            .filter_map(|transition| match transition {
                Transition::Opened(alert) => Some((alert.check, alert.severity)),
                _ => None,
            })
            .collect()
    }

    fn cleared(out: &[Transition]) -> Vec<WatchdogCheck> {
        out.iter()
            .filter_map(|transition| match transition {
                Transition::Cleared(alert) => Some(alert.check),
                _ => None,
            })
            .collect()
    }

    fn withdrawn(out: &[Transition]) -> Vec<(WatchdogCheck, Option<String>)> {
        out.iter()
            .filter_map(|transition| match transition {
                Transition::Withdrawn(alert) => Some((alert.check, alert.target_id.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn muted_29_seconds_opens_nothing_and_30_opens_critical() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.mic_muted = true;
        signals.audio.master_rms_db = Some(-90.0);
        signals.audio.microphone_rms_db = Some(-120.0);
        let out = run(&mut checks, &mut state, start, 30, &signals);
        assert!(opened(&out).is_empty(), "29 s muted is a cough: {out:?}");
        let out = checks.tick(
            &signals,
            &thresholds(),
            &settings(),
            &mut state,
            start.plus(Duration::from_secs(30)),
        );
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::MicMuted, AlertSeverity::Critical)]
        );
        let alert = state.open_alert("mic-muted").unwrap();
        assert_eq!(alert.title, "Your microphone is muted on the livestream");
        assert_eq!(
            alert.detail, "Muted for 0:30. Viewers hear no voice. Nothing else is playing.",
            "program-silent folds into the mic card"
        );
        assert_eq!(alert.fixes[0].kind, FixKind::Unmute);
        assert!(
            !state.is_open("program-silent"),
            "one card, never two, while the mic is muted"
        );
        // Unmute: cleared within one tick, and the clock starts over.
        signals.mic_muted = false;
        signals.audio.master_rms_db = Some(-30.0);
        let out = checks.tick(
            &signals,
            &thresholds(),
            &settings(),
            &mut state,
            start.plus(Duration::from_secs(31)),
        );
        assert_eq!(cleared(&out), vec![WatchdogCheck::MicMuted]);
        signals.mic_muted = true;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(32)),
            29,
            &signals,
        );
        assert!(opened(&out).is_empty(), "unmute reset the clock: {out:?}");
    }

    #[test]
    fn music_above_minus_40_turns_the_mute_into_a_notice() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let mut signals = live();
        signals.mic_muted = true;
        signals.audio.bed_rms_db = Some(-20.0);
        let out = run(&mut checks, &mut state, clock(), 31, &signals);
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::MicMuted, AlertSeverity::Notice)]
        );
        assert_eq!(
            state.open_alert("mic-muted").unwrap().detail,
            "Muted for 0:30. Viewers hear your system audio."
        );
    }

    #[test]
    fn a_takeover_suppresses_mic_muted_and_makes_silence_a_notice() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.mic_muted = true;
        signals.audio.master_rms_db = Some(-90.0);
        signals.takeover = Some(TakeoverSignal {
            since: start.now,
            activated_at: Some(start.wall),
            luma: Some(128),
        });
        let out = run(&mut checks, &mut state, start, 40, &signals);
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::ProgramSilent, AlertSeverity::Notice)],
            "no mic-muted behind a takeover; the silence is by design"
        );
        let silent = state.open_alert("program-silent").unwrap();
        assert_eq!(silent.title, "Viewers hear nothing");
        assert_eq!(silent.detail, "Be right back has been silent for 0:39.");
        assert_eq!(silent.fixes[0].kind, FixKind::Unmute, "the mic is muted");
        // Ten minutes in, Be right back is a reminder with the activation time.
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(40)),
            561,
            &signals,
        );
        let brb: Vec<_> = opened(&out)
            .into_iter()
            .filter(|(check, _)| *check == WatchdogCheck::BrbLong)
            .collect();
        assert_eq!(brb, vec![(WatchdogCheck::BrbLong, AlertSeverity::Notice)]);
        let brb = state.open_alert("brb-long").unwrap();
        assert_eq!(brb.title, "Be right back for 10 minutes");
        assert_eq!(
            brb.detail,
            format!(
                "Viewers have seen the takeover since {}.",
                time_of_day(start.wall)
            )
        );
        // The takeover ends: both clear, and the mute clock starts fresh.
        signals.takeover = None;
        signals.audio.master_rms_db = Some(-30.0);
        let out = checks.tick(
            &signals,
            &thresholds(),
            &settings(),
            &mut state,
            start.plus(Duration::from_secs(700)),
        );
        let mut gone = cleared(&out);
        gone.sort();
        assert_eq!(
            gone,
            vec![WatchdogCheck::ProgramSilent, WatchdogCheck::BrbLong]
        );
    }

    #[test]
    fn program_silence_with_the_mic_on_is_its_own_critical_card() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let mut signals = live();
        signals.audio.master_rms_db = Some(-70.0);
        signals.audio.microphone_rms_db = Some(-70.0);
        let out = run(&mut checks, &mut state, clock(), 20, &signals);
        assert!(opened(&out).is_empty(), "19 s is not yet 20: {out:?}");
        let out = run(
            &mut checks,
            &mut state,
            clock().plus(Duration::from_secs(20)),
            1,
            &signals,
        );
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::ProgramSilent, AlertSeverity::Critical)]
        );
        let alert = state.open_alert("program-silent").unwrap();
        assert_eq!(alert.detail, "No sound has left the stream for 0:20.");
        assert_eq!(alert.fixes[0].kind, FixKind::OpenAudio);
        assert_eq!(alert.source, AlertSource::Desktop);
    }

    #[test]
    fn no_voice_waits_five_minutes_and_clears_on_two_seconds_of_voice() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.audio.microphone_rms_db = Some(-60.0);
        let out = run(&mut checks, &mut state, start, 300, &signals);
        assert!(opened(&out).is_empty(), "{out:?}");
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(300)),
            1,
            &signals,
        );
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::NoVoice, AlertSeverity::Warning)]
        );
        assert_eq!(
            state.open_alert("no-voice").unwrap().title,
            "No voice for 5 minutes"
        );
        signals.audio.microphone_rms_db = Some(-20.0);
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(301)),
            2,
            &signals,
        );
        assert!(
            cleared(&out).is_empty(),
            "one second of voice is a cough: {out:?}"
        );
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(303)),
            1,
            &signals,
        );
        assert_eq!(cleared(&out), vec![WatchdogCheck::NoVoice]);
    }

    #[test]
    fn a_still_screen_opens_nothing_and_a_stall_opens_at_five_seconds() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        // Screen delivery collapsed, the compositor renders, the encoder moves.
        let mut signals = live();
        signals.screen_still = true;
        let out = run(&mut checks, &mut state, start, 600, &signals);
        assert!(opened(&out).is_empty(), "a still editor is fine: {out:?}");

        // The encoder stalled (stream-output-stalled at 2 s): open at 5 s.
        signals.stream_stalled_since = Some(start.now);
        let out = run(&mut checks, &mut state, start, 5, &signals);
        assert!(opened(&out).is_empty(), "{out:?}");
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(5)),
            1,
            &signals,
        );
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::PictureStopped, AlertSeverity::Critical)]
        );
        let alert = state.open_alert("picture-stopped").unwrap();
        assert_eq!(
            alert.detail,
            "No new frame has reached the stream for 0:05. A still screen is fine; this is the pipeline. The screen hasn't changed either."
        );
        assert_eq!(alert.fixes.len(), 2);
        signals.stream_stalled_since = None;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(6)),
            1,
            &signals,
        );
        assert_eq!(cleared(&out), vec![WatchdogCheck::PictureStopped]);

        // A stalled render (three windows, 6 s) opens it too, without the
        // screen line when the screen is moving.
        signals.screen_still = false;
        signals.render_stalled_since = Some(start.now);
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(6)),
            1,
            &signals,
        );
        assert_eq!(opened(&out).len(), 1);
        assert!(
            !state
                .open_alert("picture-stopped")
                .unwrap()
                .detail
                .contains("hasn't changed")
        );
    }

    fn destination(
        id: &str,
        phase: DestinationPhase,
        since: Instant,
        cloud: bool,
    ) -> DestinationSignal {
        DestinationSignal {
            target_id: id.to_string(),
            label: match id {
                "youtube" => "YouTube".to_string(),
                "twitch" => "Twitch".to_string(),
                other => other.to_string(),
            },
            platform: id.to_string(),
            phase,
            since,
            cloud,
            message: None,
        }
    }

    #[test]
    fn destinations_down_wait_twenty_seconds_and_fold_when_every_one_is_down() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let legs = [
            destination("youtube", DestinationPhase::Reconnecting, start.now, false),
            destination("twitch", DestinationPhase::Live, start.now, false),
        ];
        let mut signals = live();
        signals.destinations = &legs;
        let out = run(&mut checks, &mut state, start, 20, &signals);
        assert!(opened(&out).is_empty(), "{out:?}");
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(20)),
            1,
            &signals,
        );
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::DestinationDown, AlertSeverity::Warning)]
        );
        let alert = state.open_alert("destination-down:youtube").unwrap();
        assert_eq!(alert.title, "YouTube has been down for 0:20");
        assert_eq!(
            alert.detail,
            "Videorc is retrying every 2 seconds. Viewers there see nothing until it's back."
        );
        assert!(alert.fixes.is_empty(), "FFmpeg is already doing the work");

        // A failed direct leg: the honest copy and Open Livestream (D8).
        let legs = [
            destination("youtube", DestinationPhase::Failed, start.now, false),
            destination("twitch", DestinationPhase::Live, start.now, false),
        ];
        signals.destinations = &legs;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(21)),
            1,
            &signals,
        );
        assert!(
            matches!(out.as_slice(), [Transition::Updated(_)]),
            "{out:?}"
        );
        let alert = state.open_alert("destination-down:youtube").unwrap();
        assert_eq!(alert.title, "Streaming to YouTube stopped");
        assert_eq!(alert.fixes[0].kind, FixKind::OpenLivestream);

        // Both down: one critical card, the per-destination one gone.
        let legs = [
            destination("youtube", DestinationPhase::Failed, start.now, false),
            destination("twitch", DestinationPhase::Reconnecting, start.now, false),
        ];
        signals.destinations = &legs;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(22)),
            1,
            &signals,
        );
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::DestinationDown, AlertSeverity::Critical)]
        );
        // M2: the fold is quiet. YouTube is not back.
        assert!(cleared(&out).is_empty(), "{out:?}");
        assert_eq!(
            withdrawn(&out),
            vec![(WatchdogCheck::DestinationDown, Some("youtube".to_string()))]
        );
        let all = state.open_alert("destination-down:all").unwrap();
        assert_eq!(all.title, "Nobody is receiving your stream");
        assert!(
            all.detail
                .starts_with("Every destination is down. Videorc can't reconnect YouTube")
        );
        assert_eq!(state.alerts().len(), 1);

        // Twitch comes back: the fold unfolds quietly (YouTube is still
        // down, so "Destinations are back" would be false), YouTube's own
        // card returns.
        let legs = [
            destination("youtube", DestinationPhase::Failed, start.now, false),
            destination("twitch", DestinationPhase::Live, start.now, false),
        ];
        signals.destinations = &legs;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(23)),
            1,
            &signals,
        );
        assert_eq!(opened(&out).len(), 1);
        assert!(cleared(&out).is_empty(), "{out:?}");
        assert_eq!(
            withdrawn(&out),
            vec![(WatchdogCheck::DestinationDown, Some("all".to_string()))]
        );
        assert!(state.is_open("destination-down:youtube"));
        assert!(!state.is_open("destination-down:all"));

        // Every leg back: a recovery, "YouTube is back".
        let legs = [
            destination("youtube", DestinationPhase::Live, start.now, false),
            destination("twitch", DestinationPhase::Live, start.now, false),
        ];
        signals.destinations = &legs;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(24)),
            1,
            &signals,
        );
        assert_eq!(cleared(&out), vec![WatchdogCheck::DestinationDown]);
        assert!(withdrawn(&out).is_empty());
        assert!(state.alerts().is_empty());

        // Both down from the start, then both back: the one card clears,
        // "Destinations are back".
        let legs = [
            destination("youtube", DestinationPhase::Failed, start.now, false),
            destination("twitch", DestinationPhase::Failed, start.now, false),
        ];
        signals.destinations = &legs;
        run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(25)),
            1,
            &signals,
        );
        assert!(state.is_open("destination-down:all"));
        signals.destinations = &[];
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(26)),
            1,
            &signals,
        );
        assert_eq!(cleared(&out), vec![WatchdogCheck::DestinationDown]);
    }

    /// M2: the replace is quiet too. Silence with the mic on is its own
    /// card; a mute hands it to the mic card without "Sound is back", and
    /// a takeover over the muted mic takes the mic card without
    /// "Microphone unmuted". The unmute, with sound, is the one recovery.
    #[test]
    fn a_replace_withdraws_the_old_card_without_a_recovery() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.audio.master_rms_db = Some(-90.0);
        signals.audio.microphone_rms_db = Some(-90.0);
        run(&mut checks, &mut state, start, 21, &signals);
        assert!(state.is_open("program-silent"));

        signals.mic_muted = true;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(21)),
            1,
            &signals,
        );
        assert!(cleared(&out).is_empty(), "the mute is not a recovery: {out:?}");
        assert_eq!(
            withdrawn(&out),
            vec![(WatchdogCheck::ProgramSilent, None)]
        );
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(22)),
            30,
            &signals,
        );
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::MicMuted, AlertSeverity::Critical)]
        );

        signals.takeover = Some(TakeoverSignal {
            since: start.now + Duration::from_secs(52),
            activated_at: None,
            luma: Some(128),
        });
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(52)),
            1,
            &signals,
        );
        assert!(cleared(&out).is_empty(), "{out:?}");
        assert_eq!(withdrawn(&out), vec![(WatchdogCheck::MicMuted, None)]);

        signals.takeover = None;
        signals.mic_muted = false;
        signals.audio.master_rms_db = Some(-30.0);
        signals.audio.microphone_rms_db = Some(-30.0);
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(53)),
            1,
            &signals,
        );
        assert!(withdrawn(&out).is_empty(), "{out:?}");
        assert!(state.alerts().is_empty());
    }

    #[test]
    fn a_cloud_leg_offers_reconnect_at_once() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let legs = [
            destination("youtube", DestinationPhase::Reconnecting, start.now, true),
            destination("twitch", DestinationPhase::Live, start.now, true),
        ];
        let mut signals = live();
        signals.destinations = &legs;
        let out = run(&mut checks, &mut state, start, 1, &signals);
        assert_eq!(opened(&out).len(), 1);
        let alert = state.open_alert("destination-down:youtube").unwrap();
        assert_eq!(alert.source, AlertSource::Cloud);
        assert_eq!(
            alert.detail,
            "Videorc Cloud is retrying. Reconnect starts it over."
        );
        assert_eq!(alert.fixes[0].kind, FixKind::ReconnectDestination);
        assert_eq!(alert.fixes[0].label, "Reconnect YouTube");
        assert_eq!(alert.target_id.as_deref(), Some("youtube"));
    }

    #[test]
    fn cloud_and_desktop_readings_dedupe_into_one_card_with_the_cloud_detail() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.audio.master_rms_db = Some(-80.0);
        signals.cloud = Some(CloudSignal {
            hold_active: false,
            audio_silent_seconds: Some(25),
            ..Default::default()
        });
        let out = run(&mut checks, &mut state, start, 21, &signals);
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::ProgramSilent, AlertSeverity::Critical)],
            "both sources, one alert"
        );
        let alert = state.open_alert("program-silent").unwrap();
        assert_eq!(alert.source, AlertSource::Cloud);
        assert_eq!(alert.detail, "No sound has left the stream for 0:25.");
        assert_eq!(state.alerts().len(), 1);

        // During a hold the runner's counters climb by design: no alert.
        signals.audio.master_rms_db = Some(-30.0);
        signals.cloud = Some(CloudSignal {
            hold_active: true,
            audio_silent_seconds: Some(90),
            black_seconds: Some(90),
            frozen_seconds: Some(9),
            ..Default::default()
        });
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(21)),
            1,
            &signals,
        );
        assert_eq!(cleared(&out), vec![WatchdogCheck::ProgramSilent]);
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(22)),
            30,
            &signals,
        );
        assert!(opened(&out).is_empty(), "the hold guard: {out:?}");

        // Off hold, a frozen feed and a black picture open from the cloud.
        signals.cloud = Some(CloudSignal {
            hold_active: false,
            black_seconds: Some(12),
            frozen_seconds: Some(4),
            av_skew_ms: Some(420.0),
            ..Default::default()
        });
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(60)),
            11,
            &signals,
        );
        let mut checks_opened: Vec<_> = opened(&out).into_iter().map(|(check, _)| check).collect();
        checks_opened.sort();
        assert_eq!(
            checks_opened,
            vec![
                WatchdogCheck::PictureBlack,
                WatchdogCheck::PictureStopped,
                WatchdogCheck::AvDrift
            ]
        );
        assert_eq!(
            state.open_alert("picture-black").unwrap().source,
            AlertSource::Cloud
        );
        assert_eq!(
            state.open_alert("av-drift").unwrap().detail,
            "Videorc Cloud measures 0.4 s between them."
        );
    }

    #[test]
    fn a_dark_takeover_suppresses_black_and_a_black_one_does_not() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.black_since = Some(start.now);
        signals.takeover = Some(TakeoverSignal {
            since: start.now,
            activated_at: None,
            luma: Some(30),
        });
        let out = run(&mut checks, &mut state, start, 30, &signals);
        assert!(opened(&out).is_empty(), "a dark card is by design: {out:?}");
        // The takeover ends and the sampler still reads black: that is a
        // black picture, with Switch scene as the fix.
        signals.takeover = None;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(30)),
            1,
            &signals,
        );
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::PictureBlack, AlertSeverity::Critical)]
        );
        assert_eq!(
            state.open_alert("picture-black").unwrap().fixes[0].kind,
            FixKind::SwitchScene
        );
        // A black takeover (luma under 16) is not a dark one: the card stays,
        // and its fix becomes End takeover.
        signals.takeover = Some(TakeoverSignal {
            since: start.now,
            activated_at: None,
            luma: Some(4),
        });
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(31)),
            1,
            &signals,
        );
        assert!(
            matches!(out.as_slice(), [Transition::Updated(_)]),
            "{out:?}"
        );
        assert_eq!(
            state.open_alert("picture-black").unwrap().fixes[0].kind,
            FixKind::EndTakeover
        );
    }

    /// Plan 223 M3 (the review): the dark-takeover guard follows the
    /// takeover on screen. A dark card A suppresses the black sampler; a
    /// direct switch to a bright card B, with the program still black,
    /// alarms within the threshold with End takeover; a switch back to a
    /// dark card C suppresses again, and the alert leaves the list.
    #[test]
    fn a_direct_takeover_switch_reads_the_new_cards_luma() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.black_since = Some(start.now);
        let card = |luma: u8| TakeoverSignal {
            since: start.now,
            activated_at: None,
            luma: Some(luma),
        };
        signals.takeover = Some(card(30));
        let out = run(&mut checks, &mut state, start, 30, &signals);
        assert!(opened(&out).is_empty(), "a dark card is by design: {out:?}");

        signals.takeover = Some(card(200));
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(30)),
            1,
            &signals,
        );
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::PictureBlack, AlertSeverity::Critical)],
            "a bright card over a black program alarms at once (the sampler has read black for 30 s)"
        );
        assert_eq!(
            state.open_alert("picture-black").unwrap().fixes[0].kind,
            FixKind::EndTakeover
        );

        signals.takeover = Some(card(40));
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(31)),
            1,
            &signals,
        );
        assert!(
            !state.is_open("picture-black"),
            "a dark card suppresses again: {out:?}"
        );
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(32)),
            30,
            &signals,
        );
        assert!(opened(&out).is_empty(), "{out:?}");
    }

    #[test]
    fn chat_decisions_open_one_card_per_class_with_a_ten_minute_cooldown() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let decisions = [ChatDecision {
            class: ChatClass::Audio,
            people: 3,
            quotes: vec![
                "no sound??".to_string(),
                "cant hear u".to_string(),
                "sin audio".to_string(),
            ],
            ai: false,
        }];
        let mut signals = live();
        signals.chat = &decisions;
        let out = run(&mut checks, &mut state, start, 1, &signals);
        assert_eq!(
            opened(&out),
            vec![(WatchdogCheck::ChatSays, AlertSeverity::Warning)]
        );
        let alert = state.open_alert("chat-says:audio").unwrap();
        assert_eq!(alert.title, "Chat says they can't hear you");
        assert_eq!(
            alert.detail,
            "3 people in the last 2 minutes: \u{201c}no sound??\u{201d}, \u{201c}cant hear u\u{201d}, \u{201c}sin audio\u{201d}."
        );
        assert_eq!(alert.fixes[0].kind, FixKind::OpenAudio);
        signals.chat = &[];
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(1)),
            1,
            &signals,
        );
        assert_eq!(cleared(&out), vec![WatchdogCheck::ChatSays]);
        signals.chat = &decisions;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(2)),
            1,
            &signals,
        );
        assert!(opened(&out).is_empty(), "once per class per ten minutes");
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(600)),
            1,
            &signals,
        );
        assert_eq!(opened(&out).len(), 1);
    }

    #[test]
    fn still_there_needs_no_voice_and_no_input_for_ten_minutes() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.audio.microphone_rms_db = Some(-70.0);
        signals.system_idle = Some(Duration::from_secs(700));
        let out = run(&mut checks, &mut state, start, 600, &signals);
        assert!(
            opened(&out)
                .iter()
                .all(|(check, _)| *check == WatchdogCheck::NoVoice)
        );
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(600)),
            1,
            &signals,
        );
        assert!(opened(&out).contains(&(WatchdogCheck::StillThere, AlertSeverity::Notice)));
        assert_eq!(
            state.open_alert("still-there").unwrap().fixes[0].kind,
            FixKind::ShowBrb
        );
        signals.system_idle = Some(Duration::from_secs(1));
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(601)),
            1,
            &signals,
        );
        assert!(cleared(&out).contains(&WatchdogCheck::StillThere));
    }

    #[test]
    fn going_off_air_clears_every_live_alert() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.mic_muted = true;
        run(&mut checks, &mut state, start, 31, &signals);
        assert!(state.is_open("mic-muted"));
        signals.live = false;
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(31)),
            1,
            &signals,
        );
        assert_eq!(cleared(&out), vec![WatchdogCheck::MicMuted]);
        let out = run(
            &mut checks,
            &mut state,
            start.plus(Duration::from_secs(32)),
            60,
            &signals,
        );
        assert!(opened(&out).is_empty(), "recording only: no new check (D3)");
    }

    #[test]
    fn the_first_seconds_of_a_session_never_read_as_silence_or_black() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let start = clock();
        let mut signals = live();
        signals.audio.master_rms_db = Some(-90.0);
        signals.black_since = Some(start.now);
        for second in 0..30 {
            signals.session_age = Duration::from_secs(second);
            let out = checks.tick(
                &signals,
                &thresholds(),
                &settings(),
                &mut state,
                start.plus(Duration::from_secs(second)),
            );
            let opened = opened(&out);
            if second < 15 {
                assert!(opened.is_empty(), "second {second}: {opened:?}");
            } else if second < 25 {
                assert!(
                    opened
                        .iter()
                        .all(|(check, _)| *check == WatchdogCheck::PictureBlack),
                    "second {second}: {opened:?}"
                );
            }
        }
        // 5 s of grace, then the 10 s black clock (15 s) and the 20 s silence
        // clock (25 s), both counted from the end of the grace.
        assert!(state.is_open("program-silent"));
        assert!(state.is_open("picture-black"));
    }

    #[test]
    fn a_switched_off_check_opens_nothing() {
        let mut checks = Checks::new();
        let mut state = WatchdogState::new();
        let mut settings = settings();
        settings.checks.insert(
            "mic-muted".to_string(),
            super::super::settings::CheckSetting { enabled: false },
        );
        let mut signals = live();
        signals.mic_muted = true;
        let start = clock();
        for second in 0..40 {
            let out = checks.tick(
                &signals,
                &Thresholds::defaults(&settings),
                &settings,
                &mut state,
                start.plus(Duration::from_secs(second)),
            );
            assert!(opened(&out).is_empty(), "{out:?}");
        }
    }

    #[test]
    fn dev_overrides_apply_only_off_a_packaged_build() {
        let lookup = |name: &str| {
            (name == "VIDEORC_WATCHDOG_MIC_MUTED_AFTER_MS").then(|| "3000".to_string())
        };
        let dev = Thresholds::defaults(&settings()).with_overrides(false, lookup);
        assert_eq!(dev.mic_muted, Duration::from_secs(3));
        let packaged = Thresholds::defaults(&settings()).with_overrides(true, lookup);
        assert_eq!(packaged.mic_muted, Duration::from_secs(30));
        let bad =
            Thresholds::defaults(&settings()).with_overrides(false, |_| Some("0".to_string()));
        assert_eq!(bad.mic_muted, Duration::from_secs(30), "a zero is ignored");
    }

    #[test]
    fn the_adopted_silence_watchdog_keeps_its_notice_copy() {
        let spec = mic_silent_spec(true, "Microphone \"Desk Mic\" has sent only silence.");
        assert_eq!(spec.title, "Your microphone is silent on the livestream");
        assert_eq!(spec.severity, AlertSeverity::Critical);
        assert_eq!(spec.fixes[0].kind, FixKind::OpenAudio);
        assert_eq!(
            mic_silent_spec(false, "x").title,
            "Your microphone is silent in the recording"
        );
    }
}
