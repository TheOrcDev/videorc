//! The Sources page's Audio column as data (plan 220 S3.4b, caught up in
//! plan 260 S1.6b part 5c): `components/sources/sources-audio-mixer.tsx`
//! with `microphoneStatus` and `systemAudioStatus` (`lib/source-status.ts`),
//! `mic-meter-input.ts`'s lines, `keepMicrophoneReadyHint`,
//! `noiseReductionSwitchView` and the takeover's hold
//! (`lib/takeover-microphone.ts`).
//!
//! The column holds three source items in one group: Microphone (Mute in
//! the header, the More chevron; the picker, "No microphone selected.", the
//! level, Gain, the level's line, Noise reduction; folded into More:
//! Microphone sync and Keep microphone ready), System audio (its switch in
//! the header; what it captures, while On the level or the idle line and
//! Gain, an issue with its one action; in More the echo guard and the three
//! facts) and Sounds (the level or its idle line, Level, Hear sounds
//! yourself). The rows' shared state is the Studio's Audio section
//! ([`super::audio_section`]): the picker, the mute, the gains, the System
//! audio switch and its chip are the same values.
//!
//! "Open Sources" on an audio notification lands on its row
//! ([`MICROPHONE_FOCUS`], [`SYSTEM_AUDIO_FOCUS`]); the doors are the shell's.
//! Rooms (the room microphone mode and its Alert, plan 249) don't exist in
//! app-core.

use std::time::Instant;

use serde_json::Value;
use videorc_protocol::{DeviceStatus, MicrophoneNoiseSuppression};

use super::StudioSnapshot;
use super::audio_actions::{is_backend_metered_microphone_id, is_core_audio_microphone_id};
use super::audio_levels::MicLevels;
use super::audio_mixer::{self, MicMonitorState};
use super::audio_section::{
    AudioInputs, AudioSectionView, IssueAction, MicrophoneRowView, SystemAudioRowView,
    takeover_hold_of,
};
use super::source_selection::SourceKind;
use super::sources_page::{ChipTone, SelectedDevice, SourceStatus, selected_device_status};
use super::takeover_microphone::takeover_microphone_status;

/// `useSectionFocus('sources-microphone')`.
pub const MICROPHONE_FOCUS: &str = "sources-microphone";
/// `useSectionFocus('sources-system-audio')`.
pub const SYSTEM_AUDIO_FOCUS: &str = "sources-system-audio";

/// The column's words (P3-D2: Electron's exactly).
pub mod copy {
    pub const AUDIO: &str = "Audio";
    pub const AUDIO_DESCRIPTION: &str =
        "What your recording and stream hear, after gain. Nothing is processed automatically.";
    pub const NO_MICROPHONE: &str = "No microphone selected.";
    pub const MORE_MICROPHONE: &str = "More microphone settings";
    pub const MORE_SYSTEM_AUDIO: &str = "More System audio settings";
    pub const NOISE_REDUCTION: &str = "Noise reduction";
    pub const MICROPHONE_SYNC: &str = "Microphone sync";
    /// The offset is split once at session start (`recording.rs`).
    pub const SYNC_SESSION: &str = " Applies from the next recording or stream.";
    pub const KEEP_READY: &str = "Keep microphone ready";
    pub const ECHO_GUARD: &str = "Pause if your stream echoes back";
    pub const SOUNDS: &str = "Sounds";
    pub const SOUNDS_LEVEL: &str = "Sounds level";
    pub const SOUNDS_IDLE: &str = "Level shows while recording or live.";
    pub const LEVEL: &str = "Level";
    pub const HEAR_SOUNDS: &str = "Hear sounds yourself";
    pub const HEAR_SOUNDS_DESCRIPTION: &str =
        "Use headphones, or your microphone may pick the sound up again.";
    pub const PERMISSION_HINT: &str = "Uses the Screen Recording permission. Turn it on above.";
    /// `micLevelUnavailableCopy(undefined | 'unknown')`: the standing-by
    /// microphone could not open.
    pub const LEVEL_UNAVAILABLE: &str = "Live level unavailable. Recording still works.";
    pub const SWITCHING: &str = "Switching";
    pub const NEEDS_PERMISSION: &str = "Needs permission";
    pub const NOT_FOUND: &str = "Not found";
    pub const NOT_FOUND_HINT: &str = "It isn't connected. Reconnect it, or choose another.";
    /// The echo guard's facts, the third on macOS only.
    pub const TAB_NOTE: &str = "Your own stream open in a browser tab is captured too. Mute that tab: headphones don't stop it.";
    pub const HEADPHONES_NOTE: &str =
        "Use headphones so your microphone doesn't pick up your speakers.";
}

/// `platformCopy(platform).deviceNoun`.
pub fn device_noun(platform: &str) -> &'static str {
    match platform {
        "darwin" => "Mac",
        "win32" => "PC",
        _ => "computer",
    }
}

/// `microphoneIndicatorCopy(platform)`.
pub fn microphone_indicator(platform: &str) -> &'static str {
    match platform {
        "darwin" => "macOS shows its microphone indicator",
        "win32" => "Windows shows its microphone indicator",
        _ => "Your system may show a microphone indicator",
    }
}

/// `keepMicrophoneReadyHint(platform)`.
pub fn keep_microphone_ready_hint(platform: &str) -> String {
    format!(
        "Opens the microphone while Studio is on screen, so Record starts at once. {} while it's open; hiding the window releases it.",
        microphone_indicator(platform)
    )
}

/// `noiseReductionSwitchView`: never On without a microphone; Off always.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NoiseReductionView {
    pub checked: bool,
    pub disabled: bool,
    pub description: String,
}

pub fn noise_reduction_view(
    value: MicrophoneNoiseSuppression,
    microphone_selected: bool,
) -> NoiseReductionView {
    let checked = value == MicrophoneNoiseSuppression::Rnnoise;
    let disabled = !checked && !microphone_selected;
    NoiseReductionView {
        checked,
        disabled,
        description: format!(
            "Cuts background noise while you record or go live. {}",
            if disabled {
                "Choose a microphone to turn it on."
            } else {
                "The level shows the cleaned sound only then."
            }
        ),
    }
}

/// `syncOffsetTag`: the header's tag while Sync is off its default.
pub fn sync_offset_tag(offset_ms: i32, user_set: bool) -> Option<String> {
    if !user_set || offset_ms == 0 {
        return None;
    }
    Some(format!(
        "Sync {}{} ms",
        if offset_ms > 0 { "+" } else { "−" },
        offset_ms.abs()
    ))
}

/// `MICROPHONE_SYNC_OFFSET_MIN_MS` and `_MAX_MS` (lib/capture.ts).
pub const SYNC_OFFSET_RANGE_MS: (i32, i32) = (-1000, 1000);

/// `microphoneStatus`: switching, permission and missing first, then a
/// takeover's hold (#1601), then muted; a working microphone says nothing
/// until a session runs (its meter already moves).
pub fn microphone_status(
    selected: bool,
    switching: bool,
    device: Option<&SelectedDevice>,
    muted: bool,
    takeover: Option<SourceStatus>,
    session_active: bool,
    silent: bool,
) -> Option<SourceStatus> {
    let chip = |label: &str, tone: ChipTone| SourceStatus {
        label: label.to_string(),
        tone,
        hint: None,
    };
    if switching {
        return Some(chip(copy::SWITCHING, ChipTone::Warn));
    }
    if !selected {
        return None;
    }
    match device {
        Some(SelectedDevice::Listed(DeviceStatus::PermissionRequired)) => {
            return Some(chip(copy::NEEDS_PERMISSION, ChipTone::Warn));
        }
        Some(SelectedDevice::Missing | SelectedDevice::Listed(DeviceStatus::Unavailable)) => {
            return Some(SourceStatus {
                hint: Some(copy::NOT_FOUND_HINT.to_string()),
                ..chip(copy::NOT_FOUND, ChipTone::Warn)
            });
        }
        _ => {}
    }
    if let Some(takeover) = takeover {
        return Some(takeover);
    }
    if muted {
        return Some(chip(audio_mixer::copy::MUTED, ChipTone::Neutral));
    }
    if silent {
        return Some(chip(audio_mixer::copy::SILENT, ChipTone::Warn));
    }
    session_active.then(|| chip(audio_mixer::copy::RECEIVING, ChipTone::Good))
}

/// Keep microphone ready (a CoreAudio input only).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KeepReadyView {
    pub checked: bool,
    pub description: String,
}

/// The Microphone item.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MicrophoneChannelView {
    /// The Studio's row: the picker, the mute, Gain, the signal word, the
    /// takeover's hold.
    pub row: MicrophoneRowView,
    pub chip: Option<SourceStatus>,
    pub selected: bool,
    /// The line under the meter: the level can't be read (idle) or the
    /// session's bus sends none.
    pub level_line: Option<&'static str>,
    pub noise_reduction: NoiseReductionView,
    pub sync_ms: i32,
    pub sync_tag: Option<String>,
    pub sync_description: String,
    pub keep_ready: Option<KeepReadyView>,
    /// Where "Open Sources" on a microphone notification lands.
    pub focus: &'static str,
}

/// The System audio item.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SystemAudioChannelView {
    /// The Studio's row: the switch, the chip's state, Gain.
    pub row: SystemAudioRowView,
    pub chip: Option<SourceStatus>,
    /// "Everything your Mac plays, except Videorc."
    pub facts: String,
    /// The issue's sentence (never the permission's: the page's alert
    /// carries the fix) and its one action.
    pub issue: Option<String>,
    pub issue_action: Option<IssueAction>,
    pub echo_guard: bool,
    pub echo_guard_description: String,
    pub notes: Vec<String>,
    /// Where "Open Sources" on a System audio notification lands.
    pub focus: &'static str,
}

/// The Sounds item (the soundboard's level and monitor).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SoundsChannelView {
    /// Videorc is reconnecting, or the board hasn't loaded.
    pub disabled: bool,
    /// A session mixes sounds and the levels arrive: the meter, else the
    /// idle line.
    pub show_level: bool,
    pub volume_db: i32,
    pub volume_text: String,
    pub volume_reset: Option<String>,
    pub monitor: bool,
}

/// The column, as one value.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SourcesAudioView {
    pub description: &'static str,
    pub microphone: MicrophoneChannelView,
    pub system_audio: Option<SystemAudioChannelView>,
    pub sounds: SoundsChannelView,
}

/// `SOUNDBOARD_VOLUME_DB_DEFAULT`.
pub const SOUNDS_VOLUME_DEFAULT: i32 = 0;

/// The soundboard Level's range, whole dB (`SOUNDBOARD_VOLUME_DB_MIN`,
/// `_MAX`).
pub const SOUNDS_VOLUME_RANGE: (i32, i32) = (-24, 12);

/// The soundboard's Level and monitor, as the board holds them (app-core
/// holds no soundboard yet: the app says).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SoundsBoard {
    pub volume_db: i32,
    pub monitor: bool,
}

/// What the column reads besides the Studio's snapshot and the levels.
#[derive(Debug, Clone, Copy, Default)]
pub struct SourcesAudioInputs<'a> {
    /// `runtimeInfo.platform`: `darwin`, `win32` or `linux`.
    pub platform: &'a str,
    /// The takeover on air and a room (see [`AudioInputs`]).
    pub audio: AudioInputs,
    /// The soundboard, once loaded.
    pub board: Option<SoundsBoard>,
    /// The standing-by microphone's last answer (`None` before any: it is
    /// not armed in app-core yet) and whether its device would not open.
    pub warm_microphone_armed: Option<bool>,
    pub warm_microphone_open_failed: bool,
}

fn text<'a>(sources: &'a Value, key: &str) -> Option<&'a str> {
    sources
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

impl SourcesAudioView {
    /// `SourcesAudioMixer`, over the Studio's snapshot and the levels.
    pub fn from_snapshot(
        snapshot: &StudioSnapshot,
        levels: &MicLevels,
        now: Instant,
        inputs: &SourcesAudioInputs<'_>,
    ) -> Self {
        let section = AudioSectionView::from_snapshot(snapshot, levels, now, inputs.audio);
        let devices = &snapshot.sources.devices.devices;
        let capture = &snapshot.settings.capture;
        let audio = &capture.audio;
        let sources = snapshot
            .settings
            .capture_doc
            .get("sources")
            .cloned()
            .unwrap_or(Value::Null);
        let session = &snapshot.session;
        let owns = session.phase.is_active() && !session.status.replay_only;
        let session_active = owns || session.start_pending || session.stop_pending;
        let bus_active = snapshot.system_audio.audio_bus_active;
        let live = levels.live_at(now);
        let platform = inputs.platform;

        // The microphone.
        let microphone_id = text(&sources, "microphoneId");
        let selected = microphone_id.is_some();
        let muted = audio.microphone_muted;
        let silent = audio_mixer::mic_monitor_state(
            session_active,
            !muted && live,
            muted && selected,
            selected && live && levels.microphone_silent,
        ) == MicMonitorState::Silent;
        let chip = microphone_status(
            selected,
            snapshot.live_sources.pending == Some(SourceKind::Microphone),
            selected_device_status(devices, microphone_id).as_ref(),
            muted,
            takeover_microphone_status(takeover_hold_of(snapshot, inputs.audio)),
            session_active,
            silent,
        );
        // `idleLevelUnavailableReason`: a backend-metered input is read by
        // the standing-by microphone; its open failing is the only idle line.
        let meter_reads = selected && !muted && live;
        let idle_unavailable = selected
            && !bus_active
            && !meter_reads
            && microphone_id.is_some_and(is_backend_metered_microphone_id)
            && inputs.warm_microphone_armed == Some(false)
            && inputs.warm_microphone_open_failed;
        let level_line = if idle_unavailable {
            Some(copy::LEVEL_UNAVAILABLE)
        } else if section.microphone.level_unavailable {
            Some(audio_mixer::copy::SESSION_LEVEL_UNAVAILABLE)
        } else {
            None
        };
        let sync_ms = audio.microphone_sync_offset_ms;
        let sync_user_set = snapshot
            .settings
            .capture_doc
            .pointer("/audio/microphoneSyncOffsetUserSet")
            == Some(&Value::Bool(true));
        let microphone = MicrophoneChannelView {
            row: section.microphone,
            chip,
            selected,
            level_line,
            noise_reduction: noise_reduction_view(audio.microphone_noise_suppression, selected),
            sync_ms,
            sync_tag: sync_offset_tag(sync_ms, sync_user_set),
            sync_description: format!(
                "Moves your voice later (+) or earlier (−) to line up with the video.{}",
                if session_active {
                    copy::SYNC_SESSION
                } else {
                    ""
                }
            ),
            keep_ready: microphone_id
                .is_some_and(is_core_audio_microphone_id)
                .then(|| KeepReadyView {
                    checked: snapshot.settings.studio.keep_microphone_warm(),
                    description: keep_microphone_ready_hint(platform),
                }),
            focus: MICROPHONE_FOCUS,
        };

        // System audio.
        let macos = platform == "darwin";
        let computer = device_noun(platform);
        let system_audio = section.system_audio.map(|row| {
            let chip = row.chip.map(|chip| SourceStatus {
                label: chip.label.to_string(),
                tone: match chip.tone {
                    "good" => ChipTone::Good,
                    "warn" => ChipTone::Warn,
                    _ => ChipTone::Neutral,
                },
                hint: row
                    .permission_required
                    .then(|| copy::PERMISSION_HINT.to_string()),
            });
            let (issue, issue_action) = if row.permission_required {
                (None, None)
            } else {
                (row.issue.clone(), row.issue_action)
            };
            let mut notes = vec![
                copy::TAB_NOTE.to_string(),
                copy::HEADPHONES_NOTE.to_string(),
            ];
            if macos {
                notes.push(format!(
                    "Your {computer}'s volume and mute don't change what's recorded."
                ));
            }
            SystemAudioChannelView {
                chip,
                facts: format!("Everything your {computer} plays, except Videorc."),
                issue,
                issue_action,
                echo_guard: audio.system_audio_echo_guard,
                echo_guard_description: format!(
                    "Stops System audio when your own stream plays on this {computer}."
                ),
                notes,
                focus: SYSTEM_AUDIO_FOCUS,
                row,
            }
        });

        // Sounds.
        let connected = matches!(snapshot.connection, super::Connection::Connected { .. });
        let volume_db = inputs
            .board
            .map_or(SOUNDS_VOLUME_DEFAULT, |board| board.volume_db);
        let disabled = !connected || inputs.board.is_none();
        let sounds = SoundsChannelView {
            disabled,
            show_level: session_active && live,
            volume_db,
            volume_text: audio_mixer::format_db(volume_db as f32),
            volume_reset: (!disabled)
                .then(|| {
                    audio_mixer::gain_reset_label(volume_db as f32, SOUNDS_VOLUME_DEFAULT as f32)
                })
                .flatten(),
            monitor: inputs.board.is_none_or(|board| board.monitor),
        };

        Self {
            description: copy::AUDIO_DESCRIPTION,
            microphone,
            system_audio,
            sounds,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio::takeover_microphone::TakeoverMicrophoneHold;

    #[test]
    fn noise_reduction_never_turns_on_without_a_microphone() {
        let off = noise_reduction_view(MicrophoneNoiseSuppression::Off, false);
        assert!(!off.checked && off.disabled);
        assert_eq!(
            off.description,
            "Cuts background noise while you record or go live. Choose a microphone to turn it on."
        );
        let on = noise_reduction_view(MicrophoneNoiseSuppression::Rnnoise, false);
        assert!(on.checked && !on.disabled, "Off always stays possible");
        assert_eq!(
            noise_reduction_view(MicrophoneNoiseSuppression::Off, true).description,
            "Cuts background noise while you record or go live. The level shows the cleaned sound only then."
        );
    }

    #[test]
    fn the_sync_tag_shows_only_off_its_default() {
        assert_eq!(sync_offset_tag(0, true), None);
        assert_eq!(sync_offset_tag(40, false), None);
        assert_eq!(sync_offset_tag(40, true).as_deref(), Some("Sync +40 ms"));
        assert_eq!(sync_offset_tag(-25, true).as_deref(), Some("Sync −25 ms"));
    }

    #[test]
    fn the_microphone_chip_puts_switching_permission_and_missing_ahead_of_mute() {
        let missing = SelectedDevice::Missing;
        let needs = SelectedDevice::Listed(DeviceStatus::PermissionRequired);
        let ok = SelectedDevice::Listed(DeviceStatus::Available);
        assert_eq!(
            microphone_status(false, false, None, false, None, false, false),
            None
        );
        assert_eq!(
            microphone_status(false, true, None, true, None, false, false).map(|chip| chip.label),
            Some("Switching".into())
        );
        assert_eq!(
            microphone_status(true, false, Some(&needs), true, None, false, false).map(|c| c.label),
            Some("Needs permission".into())
        );
        let gone =
            microphone_status(true, false, Some(&missing), true, None, false, false).unwrap();
        assert_eq!(gone.label, "Not found");
        assert_eq!(gone.hint.as_deref(), Some(copy::NOT_FOUND_HINT));
        assert_eq!(
            microphone_status(true, false, Some(&ok), true, None, true, false).map(|c| c.label),
            Some("Muted".into())
        );
        assert_eq!(
            microphone_status(true, false, Some(&ok), false, None, true, true)
                .map(|c| (c.label, c.tone)),
            Some(("Silent".into(), ChipTone::Warn))
        );
        assert_eq!(
            microphone_status(true, false, Some(&ok), false, None, true, false).map(|c| c.label),
            Some("Receiving".into())
        );
        assert_eq!(
            microphone_status(true, false, Some(&ok), false, None, false, false),
            None,
            "a working idle microphone says nothing: its meter moves"
        );
    }

    #[test]
    fn a_takeover_hold_comes_after_missing_and_before_muted() {
        // `source-status.test.ts`: the takeover's chip, from
        // `takeoverMicrophoneStatus`.
        let hold = || takeover_microphone_status(Some(TakeoverMicrophoneHold::Microphone));
        let ok = SelectedDevice::Listed(DeviceStatus::Available);
        let held = microphone_status(true, false, Some(&ok), true, hold(), true, false).unwrap();
        assert_eq!(held.label, "Muted for takeover");
        assert_eq!(held.tone, ChipTone::Neutral);
        assert_eq!(
            held.hint.as_deref(),
            Some("Your microphone comes back on when the takeover ends.")
        );
        assert_eq!(
            microphone_status(
                true,
                false,
                Some(&SelectedDevice::Missing),
                true,
                hold(),
                true,
                false
            )
            .map(|chip| chip.label),
            Some("Not found".into())
        );
        assert_eq!(
            microphone_status(true, true, Some(&ok), true, hold(), true, false)
                .map(|chip| chip.label),
            Some("Switching".into())
        );
    }

    #[test]
    fn the_platform_words() {
        assert_eq!(
            keep_microphone_ready_hint("darwin"),
            "Opens the microphone while Studio is on screen, so Record starts at once. macOS shows its microphone indicator while it's open; hiding the window releases it."
        );
        assert_eq!(device_noun("darwin"), "Mac");
        assert_eq!(device_noun("win32"), "PC");
        assert_eq!(device_noun("linux"), "computer");
    }
}
