//! Pure Notes helpers (`notes-window.tsx`, `notes-persistence` fields in
//! `notes-window.json`).

use serde_json::{Map, Value};

use crate::desktop::window_frames::WindowPrefsFile;
use crate::format::plural;

use super::copy;

/// Electron's `NotesFontScale`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FontScale {
    Sm,
    #[default]
    Md,
    Lg,
}

impl FontScale {
    pub fn id(self) -> &'static str {
        match self {
            Self::Sm => "sm",
            Self::Md => "md",
            Self::Lg => "lg",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Sm => copy::FONT_SM,
            Self::Md => copy::FONT_MD,
            Self::Lg => copy::FONT_LG,
        }
    }

    pub fn aria_label(self) -> &'static str {
        match self {
            Self::Sm => copy::FONT_SM_ARIA,
            Self::Md => copy::FONT_MD_ARIA,
            Self::Lg => copy::FONT_LG_ARIA,
        }
    }

    pub fn px(self) -> f32 {
        match self {
            Self::Sm => 18.,
            Self::Md => 24.,
            Self::Lg => 32.,
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "sm" => Some(Self::Sm),
            "md" => Some(Self::Md),
            "lg" => Some(Self::Lg),
            _ => None,
        }
    }
}

/// Electron's `NOTES_SAVE_LABELS` keys.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SaveState {
    #[default]
    Saved,
    Saving,
    Failed,
}

impl SaveState {
    pub fn words(self) -> &'static str {
        match self {
            Self::Saved => copy::SAVE_SAVED,
            Self::Saving => copy::SAVE_SAVING,
            Self::Failed => copy::SAVE_FAILED_LABEL,
        }
    }
}

/// Why Keep on top didn't take (`NotesPinError`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PinError {
    Failed,
    Unavailable,
}

impl PinError {
    pub fn words(self) -> &'static str {
        match self {
            Self::Failed => copy::PIN_FAILED,
            Self::Unavailable => copy::PIN_UNAVAILABLE,
        }
    }
}

/// `notesWordCount`: trimmed whitespace words.
pub fn word_count(text: &str) -> usize {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        0
    } else {
        trimmed.split_whitespace().count()
    }
}

/// Electron's `plural(n, 'word')` in the status bar.
pub fn words_label(count: usize) -> String {
    plural(count as i64, "word", None)
}

/// Clamp to `MAX_NOTES_TEXT_LENGTH` (char boundary safe).
pub fn clamp_text(text: &str) -> String {
    if text.chars().count() <= copy::MAX_TEXT_LENGTH {
        return text.to_string();
    }
    text.chars().take(copy::MAX_TEXT_LENGTH).collect()
}

/// Text and font scale from `notes-window.json`.
pub fn load(prefs: &WindowPrefsFile) -> Result<(String, FontScale), String> {
    let map = prefs.load();
    let text = clamp_text(map.get("text").and_then(Value::as_str).unwrap_or(""));
    let scale = map
        .get("fontScale")
        .and_then(Value::as_str)
        .and_then(FontScale::parse)
        .unwrap_or_default();
    Ok((text, scale))
}

/// Writes text and font scale; keeps other prefs.
pub fn save(prefs: &WindowPrefsFile, text: &str, scale: FontScale) -> Result<(), String> {
    let mut patch = Map::new();
    patch.insert("text".into(), Value::String(clamp_text(text)));
    patch.insert("fontScale".into(), Value::String(scale.id().into()));
    prefs.save(patch).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_count_matches_electron() {
        assert_eq!(word_count(""), 0);
        assert_eq!(word_count("  "), 0);
        assert_eq!(word_count("one"), 1);
        assert_eq!(word_count(" one  two "), 2);
        assert_eq!(words_label(0), "0 words");
        assert_eq!(words_label(1), "1 word");
        assert_eq!(words_label(2), "2 words");
    }

    #[test]
    fn save_and_pin_labels_match_electron() {
        assert_eq!(SaveState::Saved.words(), "Saved");
        assert_eq!(SaveState::Saving.words(), "Saving…");
        assert_eq!(SaveState::Failed.words(), "Not saved");
        assert_eq!(PinError::Failed.words(), "Couldn't keep on top");
        assert_eq!(PinError::Unavailable.words(), "Keep on top isn't available");
    }

    #[test]
    fn clamp_respects_the_million_char_bound() {
        let over: String = std::iter::repeat_n('a', copy::MAX_TEXT_LENGTH + 10).collect();
        assert_eq!(clamp_text(&over).chars().count(), copy::MAX_TEXT_LENGTH);
        assert_eq!(clamp_text("short"), "short");
    }
}
