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
