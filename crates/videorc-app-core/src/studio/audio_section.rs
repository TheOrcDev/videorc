//! Plan 260 S1.6b part 5c: the Studio's Audio section as data
//! (`components/studio/audio-section.tsx`), from `videorc-rust`'s S3.1d
//! port, caught up with Electron: the Microphone row (the mute with its key
//! and its chip, "Muted for takeover" while a takeover holds the voice with
//! its line under the meter, the picker, the level, Gain, the line when a
//! session's bus sends no level) and the System audio row (its state chip
//! and switch, while On the level and Gain, the idle line, an issue with
//! its one action). The meters move apart from this view
//! ([`AudioMeters`]): they change about twenty times a second.
//!
//! The section has no "Audio" title (plan 235 D3): the Mixer keeps the name
//! for screen readers ([`AudioSectionView::label`]). "Open Audio" lands on
//! the section ([`STUDIO_AUDIO_FOCUS`]) and focuses the picker, never the
//! mute ([`FocusControl::Picker`]): a stray Space there would mute a live
//! microphone. The doors themselves are the shell's.
//!
//! The mute goes through [`super::Studio::request_microphone_mute`]
//! (`requestRemoteMicrophoneMute`).

use std::time::Instant;

use serde_json::Value;

use super::audio_levels::MicLevels;
use super::audio_mixer::{
    self, Chip, MeterBallistics, MeterView, MicMonitorState, SwitchInput, SystemAudioIssue,
    copy as words,
};
use super::live_sources::{SwitchStatusLine, switch_status_line};
use super::source_selection::{
    PickerInput, PickerView, SourceKind, microphone_picker_devices, picker_view,
};
use super::takeover_microphone::{
    TAKEOVER_MUTED_LABEL, TakeoverMicrophoneHold, takeover_microphone_hold, takeover_muted_hint,
};
use super::{Connection, StudioSnapshot};

/// `useSectionFocus('studio-audio')`: where "Open Audio" lands.
pub const STUDIO_AUDIO_FOCUS: &str = "studio-audio";

/// What a section door focuses inside its row (`data-section-focus-control`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FocusControl {
    /// The device picker, never the mute in the header.
    #[default]
    Picker,
}

/// The Microphone row.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MicrophoneRowView {
    pub picker: PickerView,
    pub disabled_reason: Option<String>,
    pub status: Option<SwitchStatusLine>,
    pub muted: bool,
    /// The header's chip: "Muted for takeover" while a takeover holds the
    /// voice, else "Muted" while muted, else none.
    pub mute_chip: Option<&'static str>,
    /// What the takeover does to the voice, and its line under the meter
    /// (`TAKEOVER_MUTED_HINT[hold]`).
    pub takeover_hold: Option<TakeoverMicrophoneHold>,
    pub takeover_hint: Option<&'static str>,
    /// The bound mute key (`globalShortcuts.micToggle`), none when unbound.
    pub mute_accelerator: Option<String>,
    pub gain_text: String,
    pub gain_db: i32,
    /// "Reset to 0.0 dB" while the gain is off its default.
    pub gain_reset: Option<String>,
    /// `micSignalLabel`: Receiving, Muted, Silent or No signal (the meter's
    /// value for a screen reader).
    pub signal: &'static str,
    /// Issue 1064: a session's bus sends no level.
    pub level_unavailable: bool,
    /// "Open Audio" focuses this (the picker).
    pub focus_control: FocusControl,
}

/// What the issue's button does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueAction {
    OpenPermissions,
    Resume,
}

/// The System audio row (none where System audio can't run).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SystemAudioRowView {
    pub checked: bool,
    pub disabled: bool,
    pub permission_required: bool,
    pub chip: Option<Chip>,
    pub toggle_accelerator: Option<String>,
    pub show_level: bool,
    pub idle_line: bool,
    pub show_gain: bool,
    pub gain_text: String,
    pub gain_db: i32,
    pub gain_reset: Option<String>,
    pub issue: Option<String>,
    pub issue_action: Option<IssueAction>,
    /// `data-videorc-studio-system-audio-issue`: `permission` or the issue.
    pub issue_kind: Option<&'static str>,
}

/// The Audio section.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AudioSectionView {
    /// The Mixer's name for screen readers (`aria-label="Audio"`), never a
    /// heading (plan 235 D3).
    pub label: &'static str,
    /// Where "Open Audio" lands (`data-section-focus`).
    pub focus: &'static str,
    pub microphone: MicrophoneRowView,
    pub system_audio: Option<SystemAudioRowView>,
}

/// What the section reads that the snapshot doesn't hold.
#[derive(Debug, Clone, Copy, Default)]
pub struct AudioInputs {
    /// A takeover is on air (`activeScreen !== null`); app-core holds no
    /// takeovers yet, so the app says.
    pub takeover_active: bool,
    /// A room is open (`cloudStatus.room.phase === 'open'`); rooms don't
    /// exist in app-core, so false.
    pub room_open: bool,
}

fn whole(db: f32) -> i32 {
    db.round() as i32
}

/// A bound key from `settings.globalShortcuts` (`micToggle`,
/// `systemAudioToggle`), none when unbound.
pub fn bound_accelerator(shortcuts: &Value, key: &str) -> Option<String> {
    shortcuts
        .get(key)
        .and_then(Value::as_str)
        .filter(|accelerator| !accelerator.is_empty())
        .map(str::to_string)
}

/// `useTakeoverMicrophoneHold`, over the snapshot.
pub fn takeover_hold_of(
    snapshot: &StudioSnapshot,
    inputs: AudioInputs,
) -> Option<TakeoverMicrophoneHold> {
    let active = inputs.takeover_active;
    takeover_microphone_hold(
        active,
        inputs.room_open,
        snapshot.settings.capture.audio.microphone_muted,
        snapshot
            .takeover_mute_ownership
            .filter(|_| active && !inputs.room_open),
    )
}

/// The microphone's header chip: the takeover's word while it holds the
/// voice, else "Muted" while muted.
pub fn mute_chip(muted: bool, hold: Option<TakeoverMicrophoneHold>) -> Option<&'static str> {
    if hold.is_some() {
        Some(TAKEOVER_MUTED_LABEL)
    } else if muted {
        Some(words::MUTED)
    } else {
        None
    }
}

impl AudioSectionView {
    /// `AudioSection`, over the Studio's snapshot and the levels' liveness.
    pub fn from_snapshot(
        snapshot: &StudioSnapshot,
        levels: &MicLevels,
        now: Instant,
        inputs: AudioInputs,
    ) -> Self {
        let devices = &snapshot.sources.devices.devices;
        let capture = &snapshot.settings.capture;
        let audio = &capture.audio;
        let sources = snapshot
            .settings
            .capture_doc
            .get("sources")
            .cloned()
            .unwrap_or(Value::Null);
        let text = |key: &str| {
            sources
                .get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        let discovery_pending = !matches!(snapshot.connection, Connection::Connected { .. })
            || !snapshot.sources.devices_known;
        let microphone_id = text("microphoneId");
        let picker = picker_view(&PickerInput {
            kind: SourceKind::Microphone,
            devices: microphone_picker_devices(devices),
            value: microphone_id.clone(),
            selected_name: text("microphoneName"),
            selected_device: microphone_id
                .as_ref()
                .and_then(|id| devices.iter().find(|device| &device.id == id)),
            discovery_pending,
            none_label: Some(super::sources_section::copy::OFF),
            selection_label: None,
            group_by_kind: false,
        });
        let session = &snapshot.session;
        let owns = session.phase.is_active() && !session.status.replay_only;
        let session_active = owns || session.start_pending || session.stop_pending;
        let bus_active = snapshot.system_audio.audio_bus_active;
        let live = levels.live_at(now);
        let selected = capture.sources.microphone_id.is_some();
        let muted = audio.microphone_muted;
        let signal_live = !muted && live;
        let state = audio_mixer::mic_monitor_state(
            session_active,
            signal_live,
            muted && selected,
            selected && live && levels.microphone_silent,
        );
        let shortcuts = snapshot.settings.studio.global_shortcuts();
        let hold = takeover_hold_of(snapshot, inputs);
        let microphone_reason = snapshot.source_reasons[2].clone();
        let microphone = MicrophoneRowView {
            picker,
            status: switch_status_line(
                SourceKind::Microphone,
                &snapshot.live_sources,
                devices,
                microphone_reason.as_deref(),
            ),
            disabled_reason: microphone_reason,
            muted,
            mute_chip: mute_chip(muted, hold),
            takeover_hold: hold,
            takeover_hint: hold.map(takeover_muted_hint),
            mute_accelerator: bound_accelerator(&shortcuts, "micToggle"),
            gain_text: audio_mixer::format_db(audio.microphone_gain_db),
            gain_db: whole(audio.microphone_gain_db),
            gain_reset: audio_mixer::gain_reset_label(
                audio.microphone_gain_db,
                audio_mixer::MICROPHONE_GAIN_DEFAULT,
            ),
            signal: if state == MicMonitorState::Muted || selected {
                audio_mixer::mic_signal_label(state)
            } else {
                words::NO_SIGNAL
            },
            level_unavailable: bus_active && selected && !muted && !live,
            focus_control: FocusControl::Picker,
        };
        let status = audio_mixer::system_audio_row_status(
            devices,
            snapshot.sources.devices_known,
            cfg!(target_os = "macos"),
        );
        let facts = &snapshot.system_audio;
        let view = audio_mixer::system_audio_switch_view(&SwitchInput {
            status,
            requested: audio.system_audio_enabled,
            session_active,
            audio_bus_active: bus_active,
            confirmed: facts.confirmed,
            issue: facts.issue,
            joining: facts.joining,
        });
        let system_audio = view.visible.then(|| {
            system_audio_row(
                &view,
                audio.system_audio_enabled,
                audio.system_audio_gain_db,
                session_active,
                bus_active,
                &shortcuts,
            )
        });
        Self {
            label: words::AUDIO,
            focus: STUDIO_AUDIO_FOCUS,
            microphone,
            system_audio,
        }
    }
}

/// The System audio row from its switch's view.
///
/// Without the Screen Recording permission the switch still shows what the
/// user asked for and stays theirs to flip (owner, 2026-11-27): while it is
/// off the row is its icon, name and switch, with no chip, Gain or warning
/// for a feature that is off; turned on, it says what is missing, with the
/// way to the fix, and still no level or Gain, which have nothing to show.
fn system_audio_row(
    view: &audio_mixer::SwitchView,
    requested: bool,
    gain: f32,
    session_active: bool,
    bus_active: bool,
    shortcuts: &Value,
) -> SystemAudioRowView {
    let macos = cfg!(target_os = "macos");
    let needs_permission = view.permission_required;
    let checked = if needs_permission {
        requested
    } else {
        view.checked
    };
    // What the row says is missing, only while the user wants it on.
    let warns = needs_permission && checked;
    let working = checked && !needs_permission;
    let issue = if warns {
        Some(words::PERMISSION_REASON.to_string())
    } else if needs_permission {
        None
    } else {
        view.issue.map(|issue| {
            audio_mixer::system_audio_issue_copy(issue, audio_mixer::this_computer_word())
        })
    };
    let issue_action = if warns || (view.issue == Some(SystemAudioIssue::Unavailable) && macos) {
        Some(IssueAction::OpenPermissions)
    } else if view.issue == Some(SystemAudioIssue::Echo) {
        Some(IssueAction::Resume)
    } else {
        None
    };
    SystemAudioRowView {
        checked,
        disabled: view.disabled && !needs_permission,
        permission_required: needs_permission,
        chip: (!needs_permission || checked)
            .then(|| audio_mixer::system_audio_status(view, session_active))
            .flatten(),
        toggle_accelerator: bound_accelerator(shortcuts, "systemAudioToggle"),
        show_level: working,
        idle_line: audio_mixer::system_audio_idle_line(working, bus_active, false),
        show_gain: working,
        gain_text: audio_mixer::format_db(gain),
        gain_db: whole(gain),
        gain_reset: working
            .then(|| audio_mixer::gain_reset_label(gain, audio_mixer::SYSTEM_AUDIO_GAIN_DEFAULT))
            .flatten(),
        issue,
        issue_action,
        issue_kind: if warns {
            Some("permission")
        } else {
            view.issue.map(|issue| match issue {
                SystemAudioIssue::Lost => "lost",
                SystemAudioIssue::Unavailable => "unavailable",
                SystemAudioIssue::Bypassed => "bypassed",
                SystemAudioIssue::Echo => "echo",
            })
        },
    }
}

/// The meters' ballistics, stepped by the app as the levels arrive and
/// while a meter still falls.
#[derive(Debug, Clone, Default)]
pub struct AudioMeters {
    microphone: MeterBallistics,
    system_audio: MeterBallistics,
    /// The Sources page's Sounds.
    sounds: MeterBallistics,
}

/// What the meters show.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AudioMetersView {
    pub microphone: MeterView,
    pub system_audio: MeterView,
    /// The soundboard's sounds as mixed (`soundsMeterInput`: only while a
    /// session runs and the levels arrive).
    pub sounds: MeterView,
}

impl AudioMeters {
    /// One step: `micMeterInput` (no microphone or muted: no level; the
    /// backend's while they arrive) and `systemAudioMeterInput` (only while
    /// a running bus mixes it).
    pub fn step(
        &mut self,
        snapshot: &StudioSnapshot,
        levels: &MicLevels,
        now: Instant,
    ) -> AudioMetersView {
        let live = levels.live_at(now);
        let audio = &snapshot.settings.capture.audio;
        let selected = snapshot.settings.capture.sources.microphone_id.is_some();
        let microphone = (selected && !audio.microphone_muted && live)
            .then_some(levels.microphone_peak_db)
            .flatten();
        let facts = &snapshot.system_audio;
        let mixed = facts.confirmed.unwrap_or(audio.system_audio_enabled) && facts.issue.is_none();
        let system = (facts.audio_bus_active && mixed && live && audio.system_audio_enabled)
            .then_some(levels.system_audio_peak_db)
            .flatten();
        let session = &snapshot.session;
        let owns = session.phase.is_active() && !session.status.replay_only;
        let session_active = owns || session.start_pending || session.stop_pending;
        let sounds = (session_active && live)
            .then_some(levels.sounds_peak_db)
            .flatten();
        let microphone = self.microphone.step(microphone, now);
        let system_audio = self.system_audio.step(system, now);
        let sounds = self.sounds.step(sounds, now);
        AudioMetersView {
            microphone,
            system_audio,
            sounds,
        }
    }

    /// Every meter rests: nothing to step until the next reading.
    pub fn settled(&self) -> bool {
        self.microphone.settled() && self.system_audio.settled() && self.sounds.settled()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use videorc_protocol::DeviceStatus;

    use super::*;

    #[test]
    fn the_chip_says_the_takeover_before_the_mute() {
        assert_eq!(mute_chip(false, None), None);
        assert_eq!(mute_chip(true, None), Some("Muted"));
        assert_eq!(
            mute_chip(true, Some(TakeoverMicrophoneHold::Microphone)),
            Some("Muted for takeover")
        );
        assert_eq!(
            mute_chip(false, Some(TakeoverMicrophoneHold::Stream)),
            Some("Muted for takeover"),
            "a room's hold leaves the microphone setting alone"
        );
    }

    #[test]
    fn only_a_bound_key_is_shown() {
        let shortcuts = json!({"micToggle": "Control+Alt+M", "systemAudioToggle": ""});
        assert_eq!(
            bound_accelerator(&shortcuts, "micToggle").as_deref(),
            Some("Control+Alt+M")
        );
        assert_eq!(bound_accelerator(&shortcuts, "systemAudioToggle"), None);
        assert_eq!(bound_accelerator(&json!({}), "micToggle"), None);
    }

    fn row(status: DeviceStatus, requested: bool) -> SystemAudioRowView {
        let view = audio_mixer::system_audio_switch_view(&SwitchInput {
            status: Some(status),
            requested,
            session_active: false,
            audio_bus_active: false,
            confirmed: None,
            issue: None,
            joining: false,
        });
        system_audio_row(&view, requested, -6.0, false, false, &json!({}))
    }

    #[test]
    fn system_audio_off_is_only_its_switch_even_without_the_permission() {
        for status in [DeviceStatus::PermissionRequired, DeviceStatus::Available] {
            let off = row(status.clone(), false);
            assert!(
                !off.checked && !off.disabled,
                "{status:?}: the switch is the user's"
            );
            assert_eq!(off.chip, None, "{status:?}");
            assert!(
                !off.show_gain && !off.show_level && !off.idle_line,
                "{status:?}"
            );
            assert_eq!(off.issue, None, "{status:?}");
            assert_eq!(off.issue_action, None, "{status:?}");
            assert_eq!(off.issue_kind, None, "{status:?}");
        }
    }

    #[test]
    fn system_audio_on_without_the_permission_says_so_with_the_way_to_the_fix() {
        let on = row(DeviceStatus::PermissionRequired, true);
        assert!(on.checked && !on.disabled && on.permission_required);
        assert_eq!(on.chip.map(|chip| chip.label), Some("Needs permission"));
        assert_eq!(
            on.issue.as_deref(),
            Some("System audio needs Screen Recording permission.")
        );
        assert_eq!(on.issue_action, Some(IssueAction::OpenPermissions));
        assert_eq!(on.issue_kind, Some("permission"));
        assert!(
            !on.show_gain && !on.show_level && !on.idle_line,
            "nothing to level or mix until the permission is there"
        );
    }

    #[test]
    fn system_audio_on_with_the_permission_keeps_its_chip_level_and_gain() {
        let on = row(DeviceStatus::Available, true);
        assert!(on.checked && !on.permission_required);
        assert_eq!(on.chip.map(|chip| chip.label), Some("On"));
        assert!(on.show_gain && on.show_level && on.idle_line);
        assert_eq!(on.gain_text, audio_mixer::format_db(-6.0));
        assert_eq!(on.issue, None);
    }
}
