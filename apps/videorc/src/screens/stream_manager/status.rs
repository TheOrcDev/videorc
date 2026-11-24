//! The status bar (P1007–P1022): platform chat state, hints, Keep on top,
//! Hide from stream and the rest. This slice wires Keep on top and Hide from
//! stream; the other actions land with their drivers.

use gpui::{AnyElement, App, ClickEvent, IntoElement, Window, div, prelude::*};
use videorc_app_core::desktop::capture_protection::HideMethod;
use videorc_app_core::stream_manager::copy::{
    CAPTURE_PROTECTION_UNSUPPORTED, HIDDEN_FROM_STREAM_FOOTER, HIDE_FROM_STREAM,
    hide_from_stream_hint,
};
use videorc_kit::{
    pin_window_button::PinWindowButton,
    shortcut_keys::ShortcutKeys,
    status_bar::{StatusBar, StatusBarHint},
    status_bar_action::StatusBarAction,
};

/// The status bar under the panes.
pub fn status_bar(
    notices: gpui::Entity<crate::screens::notifications::Centre>,
    pinned: bool,
    hidden: bool,
    hide_method: HideMethod,
    on_pin: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
    on_hide: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let unsupported = hide_method == HideMethod::Unsupported;
    let hide_hint = if unsupported {
        CAPTURE_PROTECTION_UNSUPPORTED.to_string()
    } else {
        hide_from_stream_hint(hide_method == HideMethod::ContentProtection)
    };
    let footer = if hidden && !unsupported {
        Some(HIDDEN_FROM_STREAM_FOOTER)
    } else {
        None
    };
    let mut bar = StatusBar::new();
    if let Some(words) = footer {
        bar = bar.leading(div().child(words));
    }
    bar.child(
        StatusBarHint::new("search", "Search", ShortcutKeys::keystrokes("cmd-f"))
            .on_click(|_, _, _| {}),
    )
    .child(
        StatusBarHint::new("write", "Write", ShortcutKeys::keystrokes("cmd-l"))
            .on_click(|_, _, _| {}),
    )
    .child(
        StatusBarHint::new("sidekick", "Sidekick", ShortcutKeys::keystrokes("cmd-j"))
            .on_click(|_, _, _| {}),
    )
    .child(
        PinWindowButton::new("keep-on-top")
            .status_bar()
            .pinned(pinned)
            .on_pinned_change(on_pin),
    )
    .child(
        StatusBarAction::new("hide-from-stream", HIDE_FROM_STREAM)
            .text(HIDE_FROM_STREAM)
            .hint(hide_hint)
            .pressed(hidden)
            .disabled(unsupported)
            .on_click(move |ev, window, app| on_hide(!hidden, ev, window, app)),
    )
    .child(notices)
    .into_any_element()
}
