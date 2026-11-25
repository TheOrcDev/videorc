//! The status bar (P1007–P1022): hints, Keep on top, Hide from stream, and
//! the remaining window actions as shells (Clip, Clear, Commands, Preview,
//! Highlight position, Banners, Sounds, Hide screen, More).

use std::rc::Rc;

use gpui::{AnyElement, App, ClickEvent, IntoElement, Window, div, prelude::*};
use videorc_app_core::desktop::capture_protection::HideMethod;
use videorc_app_core::stream_manager::copy::{
    CAPTURE_PROTECTION_UNSUPPORTED, HIDDEN_FROM_STREAM_FOOTER, HIDE_FROM_STREAM,
    HIGHLIGHT_POSITION, MORE_ACTIONS, SHOW_HIGHLIGHTS_IN, hide_from_stream_hint, open_preview,
};
use videorc_app_core::studio::clips::clip_length_label;
use videorc_kit::{
    button::{Button, ButtonSize, ButtonVariant},
    dropdown_menu::{DropdownMenu, Menu, MenuItem},
    pin_window_button::PinWindowButton,
    shortcut_keys::ShortcutKeys,
    status_bar::{StatusBar, StatusBarHint},
    status_bar_action::StatusBarAction,
};

use super::layout::{Tier, full_labels};

const HIDE_SCREEN: &str = "Hide screen";
const CLEAR: &str = "Clear";
const CLEAR_VIEW: &str = "Clear view";
const BANNERS: &str = "Banners";
const SOUNDS: &str = "Sounds";
const COMMANDS: &str = "Commands";
const COMMANDS_HINT: &str = "Add or change the !commands viewers type";
const CLEAR_HINT: &str = "Clear view (keeps Library history)";
const BANNERS_HINT: &str = "Show or hide your banners (or type /banner)";
const SOUNDS_HINT: &str = "Play a sound (or type /sound)";

/// The status bar under the panes.
pub fn status_bar(
    notices: gpui::Entity<crate::screens::notifications::Centre>,
    pinned: bool,
    hidden: bool,
    hide_method: HideMethod,
    width: f32,
    on_pin: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
    on_hide: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
    on_clear: impl Fn(&mut Window, &mut App) + 'static,
    on_clip: impl Fn(u32, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let tier = Tier::of(width);
    let labels = full_labels(width);
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

    let clip_short = format!("Clip {}", clip_length_label(30));
    let clip_long = clip_length_label(60);
    let preview = open_preview();
    let actions_wide = tier != Tier::Narrow;
    let on_clear = Rc::new(on_clear);
    let on_clip = Rc::new(on_clip);

    bar = bar
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
        );

    if actions_wide {
        bar = bar
            .child(
                StatusBarAction::new("hide-screen", HIDE_SCREEN)
                    .text(HIDE_SCREEN)
                    .hint(
                        "Cover your screen with a frosted picture on the recording and every stream",
                    )
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
            .child(
                DropdownMenu::new("highlight-position")
                    .trigger(
                        StatusBarAction::new("highlight-position", HIGHLIGHT_POSITION)
                            .hint(format!("{HIGHLIGHT_POSITION}: Top left")),
                    )
                    .menu(|_, _| {
                        Menu::new()
                            .label(SHOW_HIGHLIGHTS_IN)
                            .item(MenuItem::new("Top left").on_select(|_, _| {}))
                            .item(MenuItem::new("Top right").on_select(|_, _| {}))
                            .item(MenuItem::new("Bottom left").on_select(|_, _| {}))
                            .item(MenuItem::new("Bottom right").on_select(|_, _| {}))
                    }),
            )
            .child(
                StatusBarAction::new("clip-30", "Save a 30-second clip")
                    .text(clip_short)
                    .hint("Save the last 30 seconds as a clip")
                    .on_click({
                        let clip = on_clip.clone();
                        move |_, window, app| clip(30, window, app)
                    }),
            )
            .child(
                StatusBarAction::new("clip-60", "Save a 1-minute clip")
                    .text(clip_long.clone())
                    .hint("Save the last minute as a clip")
                    .on_click({
                        let clip = on_clip.clone();
                        move |_, window, app| clip(60, window, app)
                    }),
            )
            .child(
                StatusBarAction::new("banners", BANNERS)
                    .text(BANNERS)
                    .hint(BANNERS_HINT)
                    .on_click(|_, _, _| {}),
            )
            .child(
                StatusBarAction::new("sounds", SOUNDS)
                    .text(SOUNDS)
                    .hint(SOUNDS_HINT)
                    .on_click(|_, _, _| {}),
            )
            .child(
                StatusBarAction::new("clear-view", CLEAR_VIEW)
                    .text(CLEAR)
                    .hint(CLEAR_HINT)
                    .on_click({
                        let clear = on_clear.clone();
                        move |_, window, app| clear(window, app)
                    }),
            );
        if labels {
            bar = bar.child(
                StatusBarAction::new("chat-commands", "Chat commands…")
                    .text(COMMANDS)
                    .hint(COMMANDS_HINT)
                    .on_click(|_, _, _| {}),
            );
        }
        bar = bar.child(
            StatusBarAction::new("open-preview", preview)
                .hint(open_preview())
                .on_click(|_, _, _| {}),
        );
    } else {
        let clip_short_menu = format!("Clip {}", clip_length_label(30));
        let clip_long_menu = format!("Clip {}", clip_length_label(60));
        let preview_menu = open_preview();
        bar = bar
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
            .child(
                DropdownMenu::new("more-actions")
                    .trigger(
                        Button::new("more-actions")
                            .label("⋯")
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::Xs)
                            .accessibility_label(MORE_ACTIONS),
                    )
                    .menu({
                        let clear = on_clear.clone();
                        let clip = on_clip.clone();
                        move |_, _| {
                            let clear = clear.clone();
                            let clip30 = clip.clone();
                            let clip60 = clip.clone();
                            Menu::new()
                                .item(MenuItem::new(HIDE_SCREEN).on_select(|_, _| {}))
                                .item(MenuItem::new(HIGHLIGHT_POSITION).on_select(|_, _| {}))
                                .item(
                                    MenuItem::new(clip_short_menu.clone())
                                        .on_select(move |window, app| clip30(30, window, app)),
                                )
                                .item(
                                    MenuItem::new(clip_long_menu.clone())
                                        .on_select(move |window, app| clip60(60, window, app)),
                                )
                                .item(MenuItem::new(BANNERS).on_select(|_, _| {}))
                                .item(MenuItem::new(format!("{SOUNDS}…")).on_select(|_, _| {}))
                                .item(MenuItem::new("Chat commands…").on_select(|_, _| {}))
                                .item(MenuItem::new(preview_menu.clone()).on_select(|_, _| {}))
                                .separator()
                                .item(
                                    MenuItem::new(CLEAR_VIEW)
                                        .on_select(move |window, app| clear(window, app)),
                                )
                        }
                    }),
            );
    }

    bar.child(notices).into_any_element()
}
