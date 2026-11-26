//! Plan 220 S3.1d: the Studio's Audio section as data. The Microphone and
//! System audio on one Mixer scale (plan 201 D1), as the renderer decides
//! them: `lib/system-audio.ts` (the switch's view, the idle line, the issue
//! words, a remote's target), `lib/system-audio-session.ts` (what the session
//! mixes, the join latch, a health event's issue), `lib/mic-meter-input.ts`
//! and `mic-visual-gate.ts` (what drives a meter and the microphone's state
//! word), `components/ui/level-meter.tsx` (the segmented meter's 24 segments
//! on −60 to 0 dB, the zones and the `peak` ballistics) and
//! `components/audio/gain-faders.tsx` (the Gain ranges and their reset).

use std::time::Instant;

use videorc_protocol::{AudioTrack, AudioTrackSource, Device, DeviceKind, DeviceStatus};

/// The section's words (P3-D2: Electron's exactly).
pub mod copy {
    pub const AUDIO: &str = "Audio";
    pub const MICROPHONE: &str = "Microphone";
    pub const SYSTEM_AUDIO: &str = "System audio";
    pub const GAIN: &str = "Gain";
    pub const MUTED: &str = "Muted";
    pub const MUTE_MICROPHONE: &str = "Mute microphone";
    pub const UNMUTE_MICROPHONE: &str = "Unmute microphone";
    pub const MICROPHONE_LEVEL: &str = "Microphone level";
    pub const SYSTEM_AUDIO_LEVEL: &str = "System audio level";
    pub const MICROPHONE_GAIN: &str = "Microphone gain";
    pub const SYSTEM_AUDIO_GAIN: &str = "System audio gain";
    /// `SYSTEM_AUDIO_PERMISSION_REASON`.
    pub const PERMISSION_REASON: &str = "System audio needs Screen Recording permission.";
    /// `SYSTEM_AUDIO_IDLE_LINE`.
    pub const IDLE_LINE: &str = "Level shows while you record, go live, or keep Clips on.";
    /// `MIC_SESSION_LEVEL_UNAVAILABLE_COPY`.
    pub const SESSION_LEVEL_UNAVAILABLE: &str =
        "Level unavailable. The meter shows only what your recording and stream hear.";
    pub const OPEN_PERMISSIONS: &str = "Open Permissions";
    pub const RESUME: &str = "Resume";
    /// `micSignalLabel`'s words.
    pub const RECEIVING: &str = "Receiving";
    pub const SILENT: &str = "Silent";
    pub const NO_SIGNAL: &str = "No signal";
}

/// `SYSTEM_AUDIO_DEVICE_ID`.
pub const SYSTEM_AUDIO_DEVICE_ID: &str = "system-audio:default";

/// `SystemAudioIssue`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemAudioIssue {
    Lost,
    Unavailable,
    Bypassed,
    Echo,
}

/// `systemAudioIssueFromHealthEvent`: every code is `system-audio-<suffix>`.
pub fn system_audio_issue_from_code(code: &str) -> Option<SystemAudioIssue> {
    match code.strip_prefix("system-audio-")? {
        "mic-fallback-bypass" => Some(SystemAudioIssue::Bypassed),
        "echo-paused" => Some(SystemAudioIssue::Echo),
        "lost" => Some(SystemAudioIssue::Lost),
        "unavailable" => Some(SystemAudioIssue::Unavailable),
        _ => None,
    }
}

/// `confirmedSystemAudioMix`: what the running session mixes, `None` while
/// no track reports its mix.
pub fn confirmed_system_audio_mix(tracks: &[AudioTrack]) -> Option<bool> {
    let reporting: Vec<&AudioTrack> = tracks
        .iter()
        .filter(|track| !track.mix_sources.is_empty())
        .collect();
    if reporting.is_empty() {
        return None;
    }
    Some(
        reporting
            .iter()
            .any(|track| track.mix_sources.contains(&AudioTrackSource::SystemAudio)),
    )
}

/// `SystemAudioJoin`: the session still opens the System audio it started
/// with (its first statuses mix the microphone only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemAudioJoin {
    pub session_id: String,
    pub requested: bool,
    pub settled: bool,
}

/// `nextSystemAudioJoin`.
pub fn next_system_audio_join(
    current: Option<&SystemAudioJoin>,
    session_id: Option<&str>,
    requested: bool,
    confirmed: Option<bool>,
    issue: bool,
) -> Option<SystemAudioJoin> {
    let session_id = session_id?;
    let settles = confirmed == Some(true) || issue;
    match current {
        Some(current) if current.session_id == session_id => {
            if current.settled || (!settles && requested == current.requested) {
                Some(current.clone())
            } else {
                Some(SystemAudioJoin {
                    settled: true,
                    ..current.clone()
                })
            }
        }
        _ => Some(SystemAudioJoin {
            session_id: session_id.to_string(),
            requested,
            settled: settles,
        }),
    }
}

/// `systemAudioJoining`.
pub fn system_audio_joining(
    join: Option<&SystemAudioJoin>,
    requested: bool,
    confirmed: Option<bool>,
) -> bool {
    join.is_some_and(|join| !join.settled) && requested && confirmed == Some(false)
}

/// `systemAudioDevice` / `systemAudioRowDevice`: the backend's one System
/// audio device; on a Mac an Available stand-in until the first list.
pub fn system_audio_row_status(
    devices: &[Device],
    devices_known: bool,
    macos: bool,
) -> Option<DeviceStatus> {
    devices
        .iter()
        .find(|device| device.id == SYSTEM_AUDIO_DEVICE_ID)
        .or_else(|| {
            devices
                .iter()
                .find(|device| device.kind == DeviceKind::SystemAudio)
        })
        .map(|device| device.status.clone())
        .or_else(|| {
            (macos && (!devices_known || devices.is_empty())).then_some(DeviceStatus::Available)
        })
}

/// `SystemAudioSwitchInput`.
#[derive(Debug, Clone)]
pub struct SwitchInput {
    pub status: Option<DeviceStatus>,
    pub requested: bool,
    pub session_active: bool,
    pub audio_bus_active: bool,
    pub confirmed: Option<bool>,
    pub issue: Option<SystemAudioIssue>,
    pub joining: bool,
}

/// `SystemAudioSwitchView['pending']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pending {
    On,
    Off,
}

/// `SystemAudioSwitchView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchView {
    pub visible: bool,
    pub permission_required: bool,
    pub checked: bool,
    pub disabled: bool,
    pub pending: Option<Pending>,
    pub issue: Option<SystemAudioIssue>,
    pub meter: bool,
    pub state_label: &'static str,
}

impl Default for SwitchView {
    fn default() -> Self {
        Self {
            visible: false,
            permission_required: false,
            checked: false,
            disabled: true,
            pending: None,
            issue: None,
            meter: false,
            state_label: "Off",
        }
    }
}

/// `systemAudioSwitchView`: what the session confirms, else the request.
pub fn system_audio_switch_view(input: &SwitchInput) -> SwitchView {
    let hidden = SwitchView::default();
    match input.status {
        None | Some(DeviceStatus::Unavailable) => return hidden,
        Some(DeviceStatus::PermissionRequired) => {
            return SwitchView {
                visible: true,
                permission_required: true,
                ..hidden
            };
        }
        Some(DeviceStatus::Available) => {}
    }
    if !input.audio_bus_active {
        return SwitchView {
            visible: true,
            checked: input.requested,
            disabled: false,
            state_label: if input.requested { "On" } else { "Off" },
            ..hidden
        };
    }
    let issue = input
        .issue
        .filter(|_| input.requested && input.confirmed != Some(true));
    if let Some(issue) = issue {
        return SwitchView {
            visible: true,
            checked: true,
            disabled: false,
            issue: Some(issue),
            state_label: if issue == SystemAudioIssue::Echo {
                "Paused"
            } else {
                "On"
            },
            ..hidden
        };
    }
    if input.joining && input.requested && input.confirmed == Some(false) {
        return SwitchView {
            visible: true,
            checked: true,
            disabled: false,
            state_label: "On",
            ..hidden
        };
    }
    let mixed = input.confirmed.unwrap_or(input.requested);
    let pending = match input.confirmed {
        None => None,
        Some(confirmed) if confirmed == input.requested => None,
        Some(_) if input.requested => Some(Pending::On),
        Some(_) => Some(Pending::Off),
    };
    SwitchView {
        visible: true,
        checked: mixed,
        disabled: false,
        pending,
        meter: mixed && pending.is_none(),
        state_label: match pending {
            Some(Pending::On) => "Turning on…",
            Some(Pending::Off) => "Turning off…",
            None if mixed => "On",
            None => "Off",
        },
        ..hidden
    }
}

/// `systemAudioIssueLabel`: the chip's word for an issue.
pub fn system_audio_issue_label(issue: SystemAudioIssue) -> &'static str {
    match issue {
        SystemAudioIssue::Echo => "Paused",
        SystemAudioIssue::Lost => "Stopped",
        SystemAudioIssue::Bypassed => "Off until you stop",
        SystemAudioIssue::Unavailable => "Couldn't start",
    }
}

/// `platformCopy`'s word for this computer: "Mac" on macOS, "PC" on
/// Windows, "computer" on Linux.
pub fn this_computer_word() -> &'static str {
    if cfg!(target_os = "macos") {
        "Mac"
    } else if cfg!(target_os = "linux") {
        "computer"
    } else {
        "PC"
    }
}

/// `systemAudioIssueCopy`: what happened, and what still works. `computer`
/// is [`this_computer_word`].
pub fn system_audio_issue_copy(issue: SystemAudioIssue, computer: &str) -> String {
    match issue {
        SystemAudioIssue::Lost => {
            "System audio stopped. Your recording or livestream keeps going.".to_string()
        }
        SystemAudioIssue::Bypassed => {
            "System audio is off until you stop, because the microphone is on a fallback input."
                .to_string()
        }
        SystemAudioIssue::Echo => format!(
            "Paused: your stream is playing on this {computer} and coming back as an echo. Mute that tab, then resume."
        ),
        SystemAudioIssue::Unavailable => "System audio couldn't start.".to_string(),
    }
}

/// A chip's word and tone (`SourceStatus`): neutral, good or warn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chip {
    pub label: &'static str,
    pub tone: &'static str,
}

/// `systemAudioStatus(view, sessionActive)`.
pub fn system_audio_status(view: &SwitchView, session_active: bool) -> Option<Chip> {
    if view.permission_required {
        return Some(Chip {
            label: "Needs permission",
            tone: "warn",
        });
    }
    if let Some(issue) = view.issue {
        return Some(Chip {
            label: system_audio_issue_label(issue),
            tone: "warn",
        });
    }
    match view.pending {
        Some(Pending::On) => {
            return Some(Chip {
                label: "Turning on…",
                tone: "neutral",
            });
        }
        Some(Pending::Off) => {
            return Some(Chip {
                label: "Turning off…",
                tone: "neutral",
            });
        }
        None => {}
    }
    if !view.checked {
        return None;
    }
    Some(if session_active && view.meter {
        Chip {
            label: copy::RECEIVING,
            tone: "good",
        }
    } else {
        Chip {
            label: "On",
            tone: "neutral",
        }
    })
}

/// `systemAudioIdleReason`: the line under a resting meter while Clips is
/// off (the Rust app arms no Clips ring yet, S3.6a: `clips_armed` false).
pub fn system_audio_idle_line(checked: bool, audio_bus_active: bool, clips_armed: bool) -> bool {
    checked && !audio_bus_active && !clips_armed
}

/// `systemAudioTarget`: a key's or a remote's target, `None` when the device
/// can't run.
pub fn system_audio_target(mode: &str, status: Option<&DeviceStatus>, shown: bool) -> Option<bool> {
    if status != Some(&DeviceStatus::Available) {
        return None;
    }
    match mode {
        "toggle" => Some(!shown),
        "on" => Some(true),
        _ => Some(false),
    }
}

// ── The microphone's state word ──────────────────────────────────────────

/// `MicMonitorState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicMonitorState {
    Live,
    Monitoring,
    Muted,
    Silent,
    Idle,
}

/// `audioMixerMonitorState`.
pub fn mic_monitor_state(
    session_active: bool,
    signal_live: bool,
    muted: bool,
    silent: bool,
) -> MicMonitorState {
    if muted {
        MicMonitorState::Muted
    } else if silent {
        MicMonitorState::Silent
    } else if !signal_live {
        MicMonitorState::Idle
    } else if session_active {
        MicMonitorState::Live
    } else {
        MicMonitorState::Monitoring
    }
}

/// `micSignalLabel`.
pub fn mic_signal_label(state: MicMonitorState) -> &'static str {
    match state {
        MicMonitorState::Live | MicMonitorState::Monitoring => copy::RECEIVING,
        MicMonitorState::Muted => copy::MUTED,
        MicMonitorState::Silent => copy::SILENT,
        MicMonitorState::Idle => copy::NO_SIGNAL,
    }
}

// ── Gain ─────────────────────────────────────────────────────────────────

/// The Gain faders' ranges (`MicrophoneGainFader`, `SystemAudioGainFader`).
pub const MICROPHONE_GAIN_RANGE: (f32, f32) = (-24.0, 24.0);
pub const MICROPHONE_GAIN_DEFAULT: f32 = 0.0;
pub const SYSTEM_AUDIO_GAIN_RANGE: (f32, f32) = (-24.0, 12.0);
pub const SYSTEM_AUDIO_GAIN_DEFAULT: f32 = -6.0;

/// `formatDb`: one decimal, a true minus sign or a plus ("−6.0 dB",
/// "0.0 dB", "+6.0 dB").
pub fn format_db(db: f32) -> String {
    let rounded = (db * 10.0).round() / 10.0;
    let text = format!("{:.1} dB", rounded.abs());
    if rounded == 0.0 {
        text
    } else if rounded < 0.0 {
        format!("\u{2212}{text}")
    } else {
        format!("+{text}")
    }
}

/// `gainReset`: "Reset to 0.0 dB" while the gain is off its default.
pub fn gain_reset_label(gain_db: f32, default_db: f32) -> Option<String> {
    ((gain_db - default_db).abs() > f32::EPSILON)
        .then(|| format!("Reset to {}", format_db(default_db)))
}

// ── The segmented meter ──────────────────────────────────────────────────

/// `DEFAULT_SEGMENTS`, and the Mixer's scale (`minDb −60`, `maxDb 0`).
pub const METER_SEGMENTS: u8 = 24;
pub const METER_MIN_DB: f64 = -60.0;
pub const METER_MAX_DB: f64 = 0.0;
/// `DEFAULT_ZONES`: amber from −20 dB, red from −9 dB.
pub const WARN_FROM_DB: f64 = -20.0;
pub const CLIP_FROM_DB: f64 = -9.0;

/// The zone of segment `index` (0-based): `ok`, `warn` or `clip`, by where
/// it starts on the linear taper.
pub fn segment_zone(index: u8) -> &'static str {
    let start =
        METER_MIN_DB + f64::from(index) * (METER_MAX_DB - METER_MIN_DB) / f64::from(METER_SEGMENTS);
    if start >= CLIP_FROM_DB {
        "clip"
    } else if start >= WARN_FROM_DB {
        "warn"
    } else {
        "ok"
    }
}

/// How many segments a level lights (the linear taper, a segment lit once
/// the level reaches into it).
pub fn lit_segments(db: f64) -> u8 {
    if !db.is_finite() || db <= METER_MIN_DB {
        return 0;
    }
    let position = ((db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)).clamp(0.0, 1.0);
    (position * f64::from(METER_SEGMENTS)).ceil() as u8
}

/// `BALLISTICS.peak`.
const ATTACK_MS: f64 = 15.0;
const RELEASE_MS: f64 = 350.0;
const PEAK_HOLD_MS: f64 = 1200.0;
const PEAK_RELEASE_MS: f64 = 600.0;
/// `SILENCE_DB`: the floor a released meter settles to.
pub const SILENCE_DB: f64 = -120.0;

/// One meter's `peak` ballistics: a fast attack, a slower release, and a
/// held peak that waits, then falls.
#[derive(Debug, Clone)]
pub struct MeterBallistics {
    db: f64,
    hold_db: f64,
    hold_since: Option<Instant>,
    at: Option<Instant>,
}

impl Default for MeterBallistics {
    fn default() -> Self {
        Self {
            db: SILENCE_DB,
            hold_db: SILENCE_DB,
            hold_since: None,
            at: None,
        }
    }
}

fn smooth(current: f64, target: f64, elapsed_ms: f64, tau: f64) -> f64 {
    if tau <= 0.0 {
        return target;
    }
    current + (target - current) * (1.0 - (-elapsed_ms / tau).exp())
}

impl MeterBallistics {
    /// One reading (`None`: no reading, the meter falls) at `now`.
    pub fn step(&mut self, input_db: Option<f64>, now: Instant) -> MeterView {
        let target = input_db.filter(|db| db.is_finite()).unwrap_or(SILENCE_DB);
        let elapsed = self.at.map_or(0.0, |at| {
            now.saturating_duration_since(at).as_secs_f64() * 1000.0
        });
        self.at = Some(now);
        let tau = if target > self.db {
            ATTACK_MS
        } else {
            RELEASE_MS
        };
        // The first reading lands at once; after it, the time constants.
        self.db = if elapsed > 0.0 {
            smooth(self.db, target, elapsed, tau)
        } else if target > self.db {
            target
        } else {
            self.db
        };
        if self.db >= self.hold_db {
            self.hold_db = self.db;
            self.hold_since = Some(now);
        } else if let Some(since) = self.hold_since {
            let held = now.saturating_duration_since(since).as_secs_f64() * 1000.0;
            if held > PEAK_HOLD_MS {
                self.hold_db = smooth(self.hold_db, self.db, elapsed, PEAK_RELEASE_MS);
            }
        }
        self.view()
    }

    /// What the meter shows now.
    pub fn view(&self) -> MeterView {
        let lit = lit_segments(self.db);
        let hold = lit_segments(self.hold_db);
        MeterView {
            lit,
            hold: if hold > lit { hold } else { 0 },
        }
    }

    /// Settled: nothing moves until the next reading.
    pub fn settled(&self) -> bool {
        self.view() == MeterView::default()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// A meter as drawn: lit segments from the left, and the held peak's
/// segment (0 for none).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MeterView {
    pub lit: u8,
    pub hold: u8,
}

#[cfg(test)]
#[path = "audio_mixer_tests.rs"]
mod tests;
