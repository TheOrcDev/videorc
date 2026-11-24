//! The raw-text guard (Electron's `guardToastText` in `lib/toast.ts`, plan
//! 174 S2.4, a backstop behind typed copy): a provider's HTML, escaped
//! entities or a JSON blob never reach a toast or the notification list.
//! The raw text goes to the log and to Copy; the words say "Details were
//! saved for support.". S1.6a's toasts ported the guard; this module
//! re-exports it, and [`guard_text`] is the shape [`super::Store::set_guard`]
//! takes.

pub use super::toasts::copy::DETAILS_SAVED;
pub use super::toasts::{GuardedText, error_copy_text, guard_toast_text};

/// The guarded words alone: what the store and the toasts show.
pub fn guard_text(raw: &str) -> String {
    guard_toast_text(raw).text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_words_pass_and_raw_provider_text_never_does() {
        assert_eq!(
            guard_toast_text("Twitch is reconnecting"),
            GuardedText {
                text: "Twitch is reconnecting".into(),
                withheld: None
            }
        );
        let wrapped = guard_toast_text("Error invoking remote method 'x': Error: Disk full");
        assert_eq!(wrapped.text, "Disk full");
        assert!(wrapped.withheld.is_some());
        assert_eq!(
            guard_toast_text("<b>Quota</b> exceeded").text,
            "Quota exceeded"
        );
        assert_eq!(guard_toast_text("Tom &amp; Jerry").text, "Tom & Jerry");
        assert_eq!(
            guard_toast_text("&lt;a href=\"x\"&gt;link&lt;/a&gt;").text,
            "link"
        );
        assert_eq!(
            guard_toast_text(r#"{"error": "quotaExceeded"}"#).text,
            DETAILS_SAVED
        );
        assert_eq!(guard_toast_text("<br>").text, DETAILS_SAVED);
        assert_eq!(guard_text("a  b\n c"), "a b c");
    }

    #[test]
    fn copy_lists_the_words_then_what_was_withheld() {
        assert_eq!(
            error_copy_text("Couldn't save", Some("Disk full"), &["<b>raw</b>".into()]),
            "Couldn't save\nDisk full\nDetails: <b>raw</b>"
        );
        assert_eq!(error_copy_text("Title", Some(""), &[]), "Title");
    }

    /// The patterns are Electron's.
    #[test]
    fn the_guard_is_electrons() {
        const TOAST: &str = include_str!("../../../../apps/desktop/src/renderer/src/lib/toast.ts");
        assert!(TOAST.contains(&format!("TOAST_DETAILS_SAVED = '{DETAILS_SAVED}'")));
        assert!(TOAST.contains("const HTML_TAG = /<\\/?[a-zA-Z!][^>]*>/g"));
        assert!(
            TOAST.contains(
                "const ESCAPED_ENTITY = /&(?:lt|gt|quot|amp|apos|#\\d+|#x[0-9a-fA-F]+);/g"
            )
        );
    }
}
