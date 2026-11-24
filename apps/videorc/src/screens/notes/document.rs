//! The Notes document and save words (`notes-window.tsx`,
//! `notes-persistence.ts`): text, font scale and the footer's labels.

use serde_json::{Map, Value};
use videorc_app_core::desktop::window_frames::WindowPrefsFile;

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
            Self::Sm => "Small",
            Self::Md => "Medium",
            Self::Lg => "Large",
        }
    }

    pub fn aria_label(self) -> &'static str {
        match self {
            Self::Sm => "Small text",
            Self::Md => "Medium text",
            Self::Lg => "Large text",
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

/// Electron's `NOTES_SAVE_LABELS`.
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
            Self::Saved => "Saved",
            Self::Saving => "Saving…",
            Self::Failed => "Not saved",
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

/// Electron's `plural(n, 'word')`.
pub fn words_label(count: usize) -> String {
    match count {
        1 => "1 word".into(),
        n => format!("{n} words"),
    }
}

pub const PLACEHOLDER: &str = "Notes for this recording…";
pub const ARIA_LABEL: &str = "Notes for this recording";
pub const HIDDEN_FROM_CAPTURE: &str = "Hidden from recordings and streams";
pub const CAPTURE_EXPOSED_TITLE: &str = "These notes can appear in your recording";
pub const CAPTURE_EXPOSED_BODY: &str = "Videorc couldn't hide this window from screen capture. Keep it off the screen you capture, or close it.";
pub const LOAD_FAILED: &str = "Couldn't open your notes. Nothing was changed.";
pub const SAVE_FAILED: &str = "Couldn't save your notes. Your text is still here.";
pub const RETRY: &str = "Retry";
pub const TEXT_SIZE: &str = "Text size";
pub const WINDOW_NAME: &str = "Notes";

/// Text and font scale from `notes-window.json`.
pub fn load(prefs: &WindowPrefsFile) -> Result<(String, FontScale), String> {
    let map = prefs.load();
    let text = map
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
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
    patch.insert("text".into(), Value::String(text.into()));
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
    fn save_labels_match_electron() {
        assert_eq!(SaveState::Saved.words(), "Saved");
        assert_eq!(SaveState::Saving.words(), "Saving…");
        assert_eq!(SaveState::Failed.words(), "Not saved");
    }
}
