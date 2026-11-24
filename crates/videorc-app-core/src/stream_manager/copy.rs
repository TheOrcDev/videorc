//! The Stream Manager's words, byte for byte as Electron writes them
//! (`components/stream-manager/stream-manager.tsx`, `stats-bar.tsx`,
//! `chat-pane.tsx`, `chat-on-stream-switch.tsx`,
//! `stream-manager-status-bar.tsx`, `components/comments-header.tsx`,
//! `components/pin-window-button.tsx`, `components/comment-row.tsx`,
//! `lib/stream-manager-stats.ts`, `shared/window-names.ts`,
//! `shared/capture-protection.ts`, use-studio's window effects and main's
//! window state).

/// `WINDOW_NAMES.streamManager`: the window's title and its one name.
pub const WINDOW_NAME: &str = "Stream Manager";
/// `WINDOW_NAMES.preview`.
pub const PREVIEW_NAME: &str = "Preview";

// --- the stats bar (`stats-bar.tsx`) ---

/// The bar's region name (`aria-label="Stream stats"`).
pub const STATS_REGION: &str = "Stream stats";
/// The live chip (owner call, 2026-09-24: the broadcast convention).
pub const ON_AIR_CHIP: &str = "ON AIR";
pub const RECORDING_CHIP: &str = "Recording";
pub const HISTORY_CHIP: &str = "History";

// --- the chat pane (`chat-pane.tsx`) ---

/// The pane's region name (`aria-label="Chat"`).
pub const CHAT_PANE: &str = "Chat";
/// The list's name.
pub const CHAT_MESSAGES: &str = "Chat messages";
/// `OffAir`: no livestream, no rows.
pub const START_A_LIVESTREAM: &str = "Start a livestream to see chat here.";
/// `OffAir` while live: no destination has chat.
pub const NO_CHAT: &str = "No destination on this livestream has chat.";
/// `OffAir` while live: chat is connected, nothing said yet.
pub const CONNECTED: &str = "Chat is connected. New messages appear here.";
/// `CHAT_ON_STREAM_LABEL` (plan 215 G, D5).
pub const CHAT_ON_STREAM: &str = "Chat on stream";

// --- the history bar (`stream-manager.tsx`) ---

/// The history bar's way back.
pub const BACK_TO_LIVE: &str = "Back to live";

// --- a row (`comment-row.tsx`) ---

/// `ROLE_LABELS`.
pub const ROLE_HOST: &str = "Host";
pub const ROLE_MOD: &str = "Mod";
pub const ROLE_VIP: &str = "VIP";
pub const ROLE_MEMBER: &str = "Member";
/// A viewer's first message here.
pub const FIRST_CHAT: &str = "First chat";
/// A message that names the streamer's own account.
pub const MENTION: &str = "@you";
/// `EventStatus`'s chips.
pub const MODERATION: &str = "Moderation";
pub const SYSTEM: &str = "System";
/// A Twitch GIF's tag, beside its title.
pub const GIF_TAG: &str = "GIF";
/// `X_VERIFIED_LABEL` (`lib/x-mark.ts`): what each X check means.
pub const VERIFIED_BLUE: &str = "Verified on X";
pub const VERIFIED_BUSINESS: &str = "Verified organization on X";
pub const VERIFIED_GOVERNMENT: &str = "Government account on X";
/// `AffiliationBadge`'s hint when X names no organization.
pub const AFFILIATED_ORGANIZATION: &str = "Affiliated organization";

// --- the status bar (`stream-manager-status-bar.tsx`) ---

/// `PIN_WINDOW_LABEL`: Keep on top's one name in every window.
pub const KEEP_ON_TOP: &str = "Keep on top";
/// `HIDE_FROM_STREAM_LABEL`.
pub const HIDE_FROM_STREAM: &str = "Hide from stream";
/// `hideFromStreamAction`'s hint: the platform's own promise.
pub const HIDE_FROM_STREAM_BASE: &str = "Keep this window out of your recordings and streams.";
pub const HIDE_FROM_STREAM_FILTER: &str = "Your own screenshots and other apps still see it.";
pub const HIDE_FROM_STREAM_PROTECTION: &str = "Other capture apps and screenshots lose it too.";
/// `CAPTURE_PROTECTION_UNSUPPORTED_REASON`.
pub const CAPTURE_PROTECTION_UNSUPPORTED: &str =
    "This system cannot hide a window from screen capture.";
/// `HIDDEN_FROM_STREAM_FOOTER`: the footer while the window is out of the capture.
pub const HIDDEN_FROM_STREAM_FOOTER: &str = "Hidden from your stream";
/// The corner menu's name, and its label inside.
pub const HIGHLIGHT_POSITION: &str = "Highlight position";
pub const SHOW_HIGHLIGHTS_IN: &str = "Show highlighted messages in";
/// Below 640 px every control folds into one menu.
pub const MORE_ACTIONS: &str = "More Stream Manager actions";

// --- the window's state (main's `commentsWindowState`) ---

/// A window command while the window is closed.
pub const NOT_OPEN: &str = "Chat window is not open.";

/// The Open Preview action's name (`Open ${WINDOW_NAMES.preview}`).
pub fn open_preview() -> String {
    format!("Open {PREVIEW_NAME}")
}

/// `hideFromStreamAction`'s hint for this platform's way of hiding.
pub fn hide_from_stream_hint(content_protection: bool) -> String {
    if content_protection {
        format!("{HIDE_FROM_STREAM_BASE} {HIDE_FROM_STREAM_PROTECTION}")
    } else {
        format!("{HIDE_FROM_STREAM_BASE} {HIDE_FROM_STREAM_FILTER}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW_NAMES: &str = include_str!("../../../../apps/desktop/src/shared/window-names.ts");
    const CAPTURE_PROTECTION: &str =
        include_str!("../../../../apps/desktop/src/shared/capture-protection.ts");
    const STATS_BAR: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/stream-manager/stats-bar.tsx"
    );
    const CHAT_PANE_TSX: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/stream-manager/chat-pane.tsx"
    );
    const CHAT_ON_STREAM_SWITCH: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/stream-manager/chat-on-stream-switch.tsx"
    );
    const STATUS_BAR: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/stream-manager/stream-manager-status-bar.tsx"
    );
    const STREAM_MANAGER: &str = include_str!(
        "../../../../apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx"
    );
    const COMMENTS_HEADER: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/components/comments-header.tsx");
    const PIN_WINDOW_BUTTON: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/components/pin-window-button.tsx");
    const COMMENT_ROW: &str =
        include_str!("../../../../apps/desktop/src/renderer/src/components/comment-row.tsx");
    const X_MARK: &str = include_str!("../../../../apps/desktop/src/renderer/src/lib/x-mark.ts");

    #[track_caller]
    fn says(file: &str, name: &str, words: &str) {
        assert!(
            file.contains(words),
            "Electron's {name} no longer says {words:?}"
        );
    }

    #[test]
    fn the_stream_manager_words_match_electron() {
        says(
            WINDOW_NAMES,
            "window-names.ts",
            &format!("streamManager: '{WINDOW_NAME}'"),
        );
        says(
            WINDOW_NAMES,
            "window-names.ts",
            &format!("preview: '{PREVIEW_NAME}'"),
        );
        says(
            STATS_BAR,
            "stats-bar.tsx",
            &format!("aria-label=\"{STATS_REGION}\""),
        );
        for chip in [ON_AIR_CHIP, RECORDING_CHIP, HISTORY_CHIP] {
            says(STATS_BAR, "stats-bar.tsx", chip);
        }
        says(
            CHAT_PANE_TSX,
            "chat-pane.tsx",
            &format!("aria-label=\"{CHAT_PANE}\""),
        );
        says(
            CHAT_PANE_TSX,
            "chat-pane.tsx",
            &format!("aria-label=\"{CHAT_MESSAGES}\""),
        );
        for line in [START_A_LIVESTREAM, NO_CHAT, CONNECTED] {
            says(CHAT_PANE_TSX, "chat-pane.tsx", line);
        }
        says(STREAM_MANAGER, "stream-manager.tsx", BACK_TO_LIVE);
        says(
            CHAT_ON_STREAM_SWITCH,
            "chat-on-stream-switch.tsx",
            &format!("CHAT_ON_STREAM_LABEL = '{CHAT_ON_STREAM}'"),
        );
        says(
            PIN_WINDOW_BUTTON,
            "pin-window-button.tsx",
            &format!("'{KEEP_ON_TOP}'"),
        );
        says(
            STATUS_BAR,
            "stream-manager-status-bar.tsx",
            &format!("HIDE_FROM_STREAM_LABEL = '{HIDE_FROM_STREAM}'"),
        );
        says(
            STATUS_BAR,
            "stream-manager-status-bar.tsx",
            &format!("HIDDEN_FROM_STREAM_FOOTER = '{HIDDEN_FROM_STREAM_FOOTER}'"),
        );
        for (protection, tail) in [
            (true, HIDE_FROM_STREAM_PROTECTION),
            (false, HIDE_FROM_STREAM_FILTER),
        ] {
            assert_eq!(
                hide_from_stream_hint(protection),
                format!("{HIDE_FROM_STREAM_BASE} {tail}")
            );
            says(
                STATUS_BAR,
                "stream-manager-status-bar.tsx",
                &format!("`${{base}} {tail}`"),
            );
        }
        says(
            STATUS_BAR,
            "stream-manager-status-bar.tsx",
            &format!("const base = '{HIDE_FROM_STREAM_BASE}'"),
        );
        says(
            CAPTURE_PROTECTION,
            "capture-protection.ts",
            CAPTURE_PROTECTION_UNSUPPORTED,
        );
        says(
            STATUS_BAR,
            "stream-manager-status-bar.tsx",
            &format!("label=\"{HIGHLIGHT_POSITION}\""),
        );
        says(
            STATUS_BAR,
            "stream-manager-status-bar.tsx",
            &format!("aria-label=\"{MORE_ACTIONS}\""),
        );
        says(
            STATUS_BAR,
            "stream-manager-status-bar.tsx",
            "`Open ${WINDOW_NAMES.preview}`",
        );
        assert_eq!(open_preview(), "Open Preview");
        says(COMMENTS_HEADER, "comments-header.tsx", SHOW_HIGHLIGHTS_IN);
        for role in [ROLE_HOST, ROLE_MOD, ROLE_VIP, ROLE_MEMBER] {
            says(COMMENT_ROW, "comment-row.tsx", &format!(": '{role}'"));
        }
        for word in [FIRST_CHAT, MENTION, GIF_TAG] {
            says(COMMENT_ROW, "comment-row.tsx", word);
        }
        says(
            COMMENT_ROW,
            "comment-row.tsx",
            &format!("<Badge>{MODERATION}</Badge>"),
        );
        says(
            COMMENT_ROW,
            "comment-row.tsx",
            &format!("<Badge>{SYSTEM}</Badge>"),
        );
        says(
            COMMENT_ROW,
            "comment-row.tsx",
            &format!("'{AFFILIATED_ORGANIZATION}'"),
        );
        for label in [VERIFIED_BLUE, VERIFIED_BUSINESS, VERIFIED_GOVERNMENT] {
            says(X_MARK, "x-mark.ts", &format!("'{label}'"));
        }
        // NOT_OPEN is main/index.ts's `commentsWindowState` words; that file
        // stays out of the Rust reads (ci-change-scope keeps it app-only).
    }
}
