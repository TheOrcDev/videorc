//! Room sounds and room audio routing (`room-sounds.tsx`,
//! `room-audio-routing.tsx`, `lib/room-audio-routing.ts`): pure status and
//! labels. The screen holds the live values and calls the backend.

use std::collections::BTreeMap;

/// Aux track state on the wire (`RoomAuxStatus.state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AuxState {
    #[default]
    Off,
    Blocked,
    Queued,
    Published,
}

impl AuxState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Blocked => "blocked",
            Self::Queued => "queued",
            Self::Published => "published",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "blocked" => Self::Blocked,
            "queued" => Self::Queued,
            "published" => Self::Published,
            _ => Self::Off,
        }
    }
}

/// System capture state (`roomAudioRouting.systemState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SystemState {
    #[default]
    Off,
    Opening,
    Capturing,
    Blocked,
}

impl SystemState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Opening => "opening",
            Self::Capturing => "capturing",
            Self::Blocked => "blocked",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "opening" => Self::Opening,
            "capturing" => Self::Capturing,
            "blocked" => Self::Blocked,
            _ => Self::Off,
        }
    }
}

/// Room sounds consent and aux status (`RoomAuxStatus`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RoomAux {
    pub enabled: bool,
    pub state: AuxState,
    pub reason: Option<String>,
    pub queued_voices: Vec<String>,
    pub track_sid: Option<String>,
    pub observed: BTreeMap<String, i64>,
}

impl RoomAux {
    /// Fresh consent off when the room opens (`use-talk-show-room.ts`).
    pub fn closed_room_default() -> Self {
        Self::default()
    }

    /// Status line under "Room sounds · Preview".
    pub fn status_line(&self) -> String {
        let body = if let Some(reason) = self.reason.as_deref() {
            reason.to_string()
        } else if self.state == AuxState::Published {
            let heard = self.observed.len();
            if heard == 0 {
                "Auxiliary track published. Audibility unconfirmed.".into()
            } else {
                format!(
                    "Auxiliary track published. Audio observed by {heard} consumer{}.",
                    if heard == 1 { "" } else { "s" }
                )
            }
        } else {
            format!("{} voices queued.", self.queued_voices.len())
        };
        format!("{body} Live acceptance has not run. Your speaker monitor is separate.")
    }

    pub fn toggle_label(&self) -> &'static str {
        if self.enabled {
            super::copy::TURN_OFF_ROOM_SOUNDS
        } else {
            super::copy::TRY_ROOM_SOUNDS
        }
    }
}

/// Program speech / auxiliary gains (`ProgramAudioSettings`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProgramAudio {
    pub speech_gain: f32,
    pub auxiliary_gain: f32,
    pub speech_muted: bool,
    pub auxiliary_muted: bool,
}

impl Default for ProgramAudio {
    fn default() -> Self {
        Self {
            speech_gain: 1.0,
            auxiliary_gain: 1.0,
            speech_muted: false,
            auxiliary_muted: false,
        }
    }
}

/// Room system audio (`roomAudioRouting.system`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SystemAudio {
    pub enabled: bool,
    pub gain_db: i32,
    pub muted: bool,
}

impl SystemAudio {
    pub const GAIN_MIN: i32 = -24;
    pub const GAIN_MAX: i32 = 12;

    pub fn clamp_gain(gain_db: i32) -> i32 {
        gain_db.clamp(Self::GAIN_MIN, Self::GAIN_MAX)
    }
}

/// Whole routing snapshot the Studio section draws.
#[derive(Debug, Clone, PartialEq)]
pub struct RoomAudioRouting {
    pub takeover: bool,
    pub system: SystemAudio,
    pub program: ProgramAudio,
    pub system_state: SystemState,
    pub reason: Option<String>,
}

impl Default for RoomAudioRouting {
    fn default() -> Self {
        Self {
            takeover: false,
            system: SystemAudio::default(),
            program: ProgramAudio::default(),
            system_state: SystemState::Off,
            reason: None,
        }
    }
}

impl RoomAudioRouting {
    pub fn system_status_line(&self) -> String {
        let body = self
            .reason
            .as_deref()
            .unwrap_or("Off. Audio from other apps can be shared with the room when enabled.");
        format!("{body} Native system audio is an unqualified development preview.")
    }

    pub fn system_share_label(&self) -> &'static str {
        if self.system.enabled {
            super::copy::STOP_SHARING_SYSTEM_AUDIO
        } else {
            super::copy::SHARE_SYSTEM_AUDIO
        }
    }

    pub fn system_mute_label(&self) -> &'static str {
        if self.system.muted {
            super::copy::UNMUTE_SYSTEM_AUDIO
        } else {
            super::copy::MUTE_SYSTEM_AUDIO
        }
    }

    pub fn speech_mute_label(&self) -> &'static str {
        if self.program.speech_muted {
            super::copy::UNMUTE_PROGRAM_SPEECH
        } else {
            super::copy::MUTE_PROGRAM_SPEECH
        }
    }

    pub fn auxiliary_mute_label(&self) -> &'static str {
        if self.program.auxiliary_muted {
            super::copy::UNMUTE_PROGRAM_AUX
        } else {
            super::copy::MUTE_PROGRAM_AUX
        }
    }

    pub fn system_gain_label(&self) -> String {
        format!("System gain · {} dB", self.system.gain_db)
    }

    pub fn speech_gain_label(&self) -> String {
        format!(
            "Program speech · {}%",
            (self.program.speech_gain * 100.0).round() as i32
        )
    }

    pub fn auxiliary_gain_label(&self) -> String {
        format!(
            "Program music and sounds · {}%",
            (self.program.auxiliary_gain * 100.0).round() as i32
        )
    }

    pub fn program_footnote(&self) -> String {
        let mut parts = String::new();
        if self.takeover {
            parts.push_str(super::copy::TAKEOVER_SILENCES);
            parts.push(' ');
        }
        parts.push_str(super::copy::PROGRAM_ROUTING_FOOTNOTE);
        parts
    }

    /// Params for `cloud.room.aux.set`.
    pub fn aux_set_params(sounds: bool, system: SystemAudio) -> serde_json::Value {
        serde_json::json!({
            "sounds": sounds,
            "system": {
                "enabled": system.enabled,
                "gainDb": system.gain_db,
                "muted": system.muted,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_status_and_labels() {
        let mut aux = RoomAux::default();
        assert!(aux.status_line().contains("0 voices queued."));
        assert_eq!(aux.toggle_label(), "Try room sounds for this room");
        aux.enabled = true;
        aux.state = AuxState::Published;
        aux.observed.insert("a".into(), 1);
        assert!(aux.status_line().contains("1 consumer."));
        assert_eq!(aux.toggle_label(), "Turn off room sounds");

        let routing = RoomAudioRouting::default();
        assert!(routing.system_status_line().contains("Off."));
        assert_eq!(
            routing.system_share_label(),
            "Share system audio for this room"
        );
        assert_eq!(SystemAudio::clamp_gain(99), 12);
        assert_eq!(SystemAudio::clamp_gain(-99), -24);
    }
}
