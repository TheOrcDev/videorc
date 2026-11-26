//! Studio → Soundboard (`soundboard-section.tsx`, `lib/sounds.ts`,
//! `lib/sound-keys.ts`): who hears a press, the pad labels, and the 1–9 keys.

use videorc_protocol::{Sound, SoundMode, SoundVoice};

use super::copy;

/// `soundboardDescription`: where a press goes right now.
pub fn description(
    session_active: bool,
    monitor: bool,
    session_without_sounds: bool,
) -> &'static str {
    if !session_active {
        return copy::IDLE_DESCRIPTION;
    }
    if session_without_sounds {
        return copy::SOUNDS_CANT_REACH_SESSION;
    }
    if monitor {
        copy::SESSION_DESCRIPTION_MONITOR
    } else {
        copy::SESSION_DESCRIPTION_NO_MONITOR
    }
}

/// `pressStops`: a press stops a playing Play/stop or Loop sound.
pub fn press_stops(mode: SoundMode, playing: bool) -> bool {
    playing && matches!(mode, SoundMode::Toggle | SoundMode::Loop)
}

/// Digit 1–9 from a keystroke's printed key (GPUI has no physical `code`).
pub fn sound_key_digit(key: &str) -> Option<&str> {
    matches!(key, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9").then_some(key)
}

/// The sound bound to `key`, if any.
pub fn sound_for_key<'a, T: AsSoundHotkey>(key: &str, sounds: &'a [T]) -> Option<&'a T> {
    sound_key_digit(key)?;
    sounds.iter().find(|sound| sound.hotkey() == Some(key))
}

/// Enough of a sound to resolve a hotkey.
pub trait AsSoundHotkey {
    fn hotkey(&self) -> Option<&str>;
}

impl AsSoundHotkey for Sound {
    fn hotkey(&self) -> Option<&str> {
        self.hotkey.as_deref()
    }
}

/// Newest voice per sound id (pad progress).
pub fn voice_by_sound(voices: &[SoundVoice]) -> std::collections::BTreeMap<String, SoundVoice> {
    let mut map = std::collections::BTreeMap::new();
    for voice in voices {
        map.insert(voice.sound_id.clone(), voice.clone());
    }
    map
}

/// Disconnected line under the pads: "{reason} Sounds play once Videorc is connected."
pub fn disconnected_line(reason: &str) -> String {
    format!("{reason} {}", copy::SOUNDS_ONCE_CONNECTED)
}

/// Empty title with the period Electron's EmptyTitle uses.
pub fn empty_title() -> &'static str {
    copy::STUDIO_NO_SOUNDS
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_protocol::SoundMode;

    #[test]
    fn description_matches_electron() {
        assert_eq!(
            description(false, true, false),
            "Only you hear sounds until you record or go live."
        );
        assert_eq!(
            description(true, true, true),
            "Sounds can't reach this recording or stream. Only you hear them."
        );
        assert_eq!(
            description(true, true, false),
            "Sounds play in your recording and stream."
        );
        assert_eq!(
            description(true, false, false),
            "Sounds play in your recording and stream. You don't hear them yourself."
        );
    }

    #[test]
    fn keys_and_press_stops() {
        assert_eq!(sound_key_digit("5"), Some("5"));
        assert_eq!(sound_key_digit("0"), None);
        assert!(press_stops(SoundMode::Toggle, true));
        assert!(!press_stops(SoundMode::OneShot, true));
        assert!(!press_stops(SoundMode::Hold, true));
    }
}
