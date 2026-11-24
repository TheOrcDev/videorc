//! The status bar (P1007–P1022): platform chat state, hints, Keep on top,
//! Hide from stream and the rest. This slice draws the hints and the pin;
//! the other actions wire in as their drivers land.

use gpui::{AnyElement, App, ClickEvent, IntoElement, Window, prelude::*};
use videorc_kit::{
    pin_window_button::PinWindowButton,
    shortcut_keys::ShortcutKeys,
    status_bar::{StatusBar, StatusBarHint},
};

/// The status bar under the panes.
pub fn status_bar(
    notices: gpui::Entity<crate::screens::notifications::Centre>,
    pinned: bool,
    on_pin: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    StatusBar::new()
        .child(
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
        .child(notices)
        .into_any_element()
}
