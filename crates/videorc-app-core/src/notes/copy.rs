//! Notes window words, byte for byte with Electron
//! (`components/notes-window.tsx`, `shared/notes-limits.ts`,
//! `shared/window-names.ts`).

/// `WINDOW_NAMES.notes`.
pub const WINDOW_NAME: &str = "Notes";

/// Textarea placeholder.
pub const PLACEHOLDER: &str = "Notes for this recording…";

/// Textarea `aria-label`.
pub const ARIA_LABEL: &str = "Notes for this recording";

/// Status-bar line while capture protection holds.
pub const HIDDEN_FROM_CAPTURE: &str = "Hidden from recordings and streams";

/// Capture-exposed alert title.
pub const CAPTURE_EXPOSED_TITLE: &str = "These notes can appear in your recording";

/// Capture-exposed alert body.
pub const CAPTURE_EXPOSED_BODY: &str = "Videorc couldn't hide this window from screen capture. Keep it off the screen you capture, or close it.";

/// Load-failure status line.
pub const LOAD_FAILED: &str = "Couldn't open your notes. Nothing was changed.";

/// Save-failure status line.
pub const SAVE_FAILED: &str = "Couldn't save your notes. Your text is still here.";

/// Retry on load or save failure.
pub const RETRY: &str = "Retry";

/// Segmented control accessibility name.
pub const TEXT_SIZE: &str = "Text size";

/// `NOTES_SAVE_LABELS.saved`.
pub const SAVE_SAVED: &str = "Saved";
/// `NOTES_SAVE_LABELS.saving`.
pub const SAVE_SAVING: &str = "Saving…";
/// `NOTES_SAVE_LABELS.failed` / visual "Not saved".
pub const SAVE_FAILED_LABEL: &str = "Not saved";

/// Font scale option labels (visible; aria names drop nothing but add " text").
pub const FONT_SM: &str = "Small";
pub const FONT_MD: &str = "Medium";
pub const FONT_LG: &str = "Large";
pub const FONT_SM_ARIA: &str = "Small text";
pub const FONT_MD_ARIA: &str = "Medium text";
pub const FONT_LG_ARIA: &str = "Large text";

/// `PIN_ERROR_LABELS.failed`.
pub const PIN_FAILED: &str = "Couldn't keep on top";
/// `PIN_ERROR_LABELS.unavailable`.
pub const PIN_UNAVAILABLE: &str = "Keep on top isn't available";

/// `MAX_NOTES_TEXT_LENGTH`.
pub const MAX_TEXT_LENGTH: usize = 1_000_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electron_strings_stay_exact() {
        assert_eq!(WINDOW_NAME, "Notes");
        assert_eq!(PLACEHOLDER, "Notes for this recording…");
        assert_eq!(ARIA_LABEL, "Notes for this recording");
        assert_eq!(HIDDEN_FROM_CAPTURE, "Hidden from recordings and streams");
        assert_eq!(
            CAPTURE_EXPOSED_TITLE,
            "These notes can appear in your recording"
        );
        assert_eq!(
            CAPTURE_EXPOSED_BODY,
            "Videorc couldn't hide this window from screen capture. Keep it off the screen you capture, or close it."
        );
        assert_eq!(
            LOAD_FAILED,
            "Couldn't open your notes. Nothing was changed."
        );
        assert_eq!(
            SAVE_FAILED,
            "Couldn't save your notes. Your text is still here."
        );
        assert_eq!(RETRY, "Retry");
        assert_eq!(TEXT_SIZE, "Text size");
        assert_eq!(SAVE_SAVED, "Saved");
        assert_eq!(SAVE_SAVING, "Saving…");
        assert_eq!(SAVE_FAILED_LABEL, "Not saved");
        assert_eq!(PIN_FAILED, "Couldn't keep on top");
        assert_eq!(PIN_UNAVAILABLE, "Keep on top isn't available");
        assert_eq!(MAX_TEXT_LENGTH, 1_000_000);
    }
}
