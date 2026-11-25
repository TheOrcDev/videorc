//! Sounds page words, byte for byte with Electron
//! (`tabs/sounds-tab.tsx`, `sounds-section.tsx`, `sounds-load-state.tsx`,
//! `lib/sounds.ts`).

pub const TITLE: &str = "Sounds";
pub const PAGE_DESCRIPTION: &str = "What the soundboard plays. Studio's Soundboard, Stream Manager and Search play them; Sources sets their level.";

pub const SECTION: &str = "Sounds";
pub const IMPORT: &str = "Import sounds…";
pub const CHOOSING: &str = "Choosing sounds…";
pub const IMPORTING: &str = "Importing…";
pub const NO_SOUNDS: &str = "No sounds yet";
pub const LOADING: &str = "Loading sounds…";
pub const LOAD_FAILED: &str = "Couldn't load sounds";
pub const RETRY: &str = "Retry";
pub const RESTORE_STARTERS: &str = "Restore starter sounds";
pub const RESTORING: &str = "Restoring…";

pub const RENAME_TITLE: &str = "Rename sound";
pub const NAME: &str = "Name";
pub const CANCEL: &str = "Cancel";
pub const SAVE: &str = "Save";
pub const RENAME_ELLIPSIS: &str = "Rename…";
pub const MOVE_UP: &str = "Move up";
pub const MOVE_DOWN: &str = "Move down";
pub const REMOVE: &str = "Remove";
pub const ALREADY_FIRST: &str = "This sound is already first.";
pub const ALREADY_LAST: &str = "This sound is already last.";
pub const NO_KEY: &str = "None";

pub const MODE_ONE_SHOT: &str = "Play once";
pub const MODE_TOGGLE: &str = "Play/stop";
pub const MODE_LOOP: &str = "Loop";
pub const MODE_HOLD: &str = "While held";

pub const SOUND_COUNT_LIMIT_REASON: &str = "You have 24 sounds. Remove one to add another.";
pub const SOUND_TOTAL_LIMIT_REASON: &str =
    "Your sounds add up to 5 minutes. Remove one to add another.";
pub const WAIT_FOR_IMPORT: &str = "Wait for this import to finish.";
pub const OFFLINE_LOCK: &str = "Videorc is reconnecting. These controls come back in a moment.";

pub const SOUND_MAX_COUNT: usize = 24;
pub const SOUND_VOLUME_DB_MIN: i32 = -24;
pub const SOUND_VOLUME_DB_MAX: i32 = 6;
pub const SOUND_NAME_MAX_CHARS: usize = 64;
pub const SOUND_HOTKEYS: [&str; 9] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

// Studio → Soundboard (`soundboard-section.tsx`, `lib/sounds.ts`).
pub const STUDIO_TITLE: &str = "Soundboard";
pub const STOP_ALL: &str = "Stop all";
pub const ADD_IN_SOUNDS: &str = "Add in Sounds";
pub const STUDIO_NO_SOUNDS: &str = "No sounds yet.";
pub const IDLE_DESCRIPTION: &str = "Only you hear sounds until you record or go live.";
pub const SOUNDS_CANT_REACH_SESSION: &str =
    "Sounds can't reach this recording or stream. Only you hear them.";
pub const SESSION_DESCRIPTION_MONITOR: &str = "Sounds play in your recording and stream.";
pub const SESSION_DESCRIPTION_NO_MONITOR: &str =
    "Sounds play in your recording and stream. You don't hear them yourself.";
pub const SOUNDS_ONCE_CONNECTED: &str = "Sounds play once Videorc is connected.";

// Room sounds / routing (`room-sounds.tsx`, `room-audio-routing.tsx`).
pub const ROOM_SOUNDS_LABEL: &str = "Room sounds · Preview";
pub const TRY_ROOM_SOUNDS: &str = "Try room sounds for this room";
pub const TURN_OFF_ROOM_SOUNDS: &str = "Turn off room sounds";
pub const SYSTEM_AUDIO_LABEL: &str = "System audio";
pub const SHARE_SYSTEM_AUDIO: &str = "Share system audio for this room";
pub const STOP_SHARING_SYSTEM_AUDIO: &str = "Stop sharing system audio";
pub const MUTE_SYSTEM_AUDIO: &str = "Mute system audio";
pub const UNMUTE_SYSTEM_AUDIO: &str = "Unmute system audio";
pub const MUTE_PROGRAM_SPEECH: &str = "Mute program speech";
pub const UNMUTE_PROGRAM_SPEECH: &str = "Unmute program speech";
pub const MUTE_PROGRAM_AUX: &str = "Mute program auxiliary audio";
pub const UNMUTE_PROGRAM_AUX: &str = "Unmute program auxiliary audio";
pub const TAKEOVER_SILENCES: &str =
    "Takeover silences program speech; deliberately enabled music and sounds continue.";
pub const PROGRAM_ROUTING_FOOTNOTE: &str = "Conversation audio is independent. Older program pages use all-program takeover silence. Program gain changes require a current routing-capable page.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_words_match_electron() {
        assert_eq!(TITLE, "Sounds");
        assert!(PAGE_DESCRIPTION.contains("What the soundboard plays"));
        assert_eq!(NO_SOUNDS, "No sounds yet");
        assert_eq!(LOADING, "Loading sounds…");
        assert_eq!(LOAD_FAILED, "Couldn't load sounds");
        assert_eq!(RESTORE_STARTERS, "Restore starter sounds");
        assert_eq!(MODE_ONE_SHOT, "Play once");
        assert_eq!(MODE_HOLD, "While held");
    }
}
