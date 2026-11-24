//! A report's clip moments (`ClipMoment`) and the label a moment reads by
//! (`momentLabel` in `lib/buddy-report-view.ts`). Shared by the report
//! (`reports`, still to land) and Clean cut's review (its pins).

use serde::Deserialize;

/// `BUDDY_MOMENT_VOICE_LABEL`: a voice mark with no phrase of its own.
pub const VOICE_LABEL: &str = "You said 'clip that'";
/// `BUDDY_MOMENT_MANUAL_LABEL`.
pub const MANUAL_LABEL: &str = "Marked";
/// A chat peak with no reason from the backend.
pub const CHAT_LABEL: &str = "Chat got busy";

/// One clip moment: `source` is `voice`, `manual` or `chat` (absent is chat).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Moment {
    pub source: Option<String>,
    pub reason: String,
    pub excerpt: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// `momentLabel`: marks say who placed them; a chat peak keeps the
/// backend's reason; a voice mark keeps its own phrase.
pub fn moment_label(moment: &Moment) -> String {
    let reason = moment.reason.trim();
    match moment.source.as_deref().unwrap_or("chat") {
        "voice" if reason.is_empty() => VOICE_LABEL.into(),
        "voice" => reason.into(),
        "manual" => MANUAL_LABEL.into(),
        _ if reason.is_empty() => CHAT_LABEL.into(),
        _ => reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_moment_reads_as_electron_labels_it() {
        let at = |source: Option<&str>, reason: &str| Moment {
            source: source.map(str::to_owned),
            reason: reason.into(),
            ..Moment::default()
        };
        assert_eq!(moment_label(&at(Some("voice"), " ")), VOICE_LABEL);
        assert_eq!(
            moment_label(&at(Some("voice"), "You said 'clip it'")),
            "You said 'clip it'"
        );
        assert_eq!(moment_label(&at(Some("manual"), "ignored")), MANUAL_LABEL);
        assert_eq!(moment_label(&at(None, "")), CHAT_LABEL);
        assert_eq!(moment_label(&at(Some("chat"), "Hype train")), "Hype train");
        let view =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/buddy-report-view.ts");
        assert!(view.contains(&format!("BUDDY_MOMENT_VOICE_LABEL = \"{VOICE_LABEL}\"")));
        assert!(view.contains(&format!("BUDDY_MOMENT_MANUAL_LABEL = '{MANUAL_LABEL}'")));
        assert!(view.contains(&format!("reason || '{CHAT_LABEL}'")));
    }
}
