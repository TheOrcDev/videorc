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
use videorc_app_core::studio::sources::copy::{HIDE_SCREEN, SHOW_SCREEN};
use videorc_kit::{
    button::{Button, ButtonSize, ButtonVariant},
    dropdown_menu::{DropdownMenu, Menu, MenuItem},
    pin_window_button::PinWindowButton,
    shortcut_keys::ShortcutKeys,
    status_bar::{StatusBar, StatusBarHint},
    status_bar_action::StatusBarAction,
};

use super::layout::{Tier, full_labels};

const CLEAR: &str = "Clear";
const CLEAR_VIEW: &str = "Clear view";
const BANNERS: &str = "Banners";
const SOUNDS: &str = "Sounds";
const COMMANDS: &str = "Commands";
const COMMANDS_HINT: &str = "Add or change the !commands viewers type";
const CLEAR_HINT: &str = "Clear view (keeps Library history)";
const BANNERS_HINT: &str = "Show or hide your banners (or type /banner)";
const SOUNDS_HINT: &str = "Play a sound (or type /sound)";
const HIDE_ALL_BANNERS: &str = "Hide all banners";
const LOADING_BANNERS: &str = "Loading banners…";
const IMPORT_BANNERS: &str = "Import banners in Images";
const STOP_ALL_SOUNDS: &str = "Stop all sounds";
const LOADING_SOUNDS: &str = "Loading sounds…";
const IMPORT_SOUNDS: &str = "Import sounds in Sounds";

/// One banner row for the Banners menu (id, name, shown).
#[derive(Clone, Debug)]
pub struct BannerRow {
    pub id: String,
    pub name: String,
    pub shown: bool,
}

/// One sound row for the Sounds menu (id, name).
#[derive(Clone, Debug)]
pub struct SoundRow {
    pub id: String,
    pub name: String,
}
const HIDE_SCREEN_HINT: &str =
    "Cover your screen with a frosted picture on the recording and every stream";
const SHOW_SCREEN_HINT: &str = "Show your screen to viewers again";

/// The status bar under the panes.
pub fn status_bar(
    notices: gpui::Entity<crate::screens::notifications::Centre>,
    pinned: bool,
    hidden: bool,
    hide_method: HideMethod,
    screen_hidden: bool,
    screen_blocked: Option<String>,
    width: f32,
    on_pin: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
    on_hide: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
    on_clear: impl Fn(&mut Window, &mut App) + 'static,
    on_clip: impl Fn(u32, &mut Window, &mut App) + 'static,
    on_screen: impl Fn(bool, &mut Window, &mut App) + 'static,
    anchor: super::chat::HighlightAnchor,
    on_anchor: impl Fn(super::chat::HighlightAnchor, &mut Window, &mut App) + 'static,
    banners: Option<Vec<BannerRow>>,
    on_banner: impl Fn(String, bool, &mut Window, &mut App) + 'static,
    on_banner_hide_all: impl Fn(&mut Window, &mut App) + 'static,
    sounds: Option<Vec<SoundRow>>,
    on_sound: impl Fn(String, &mut Window, &mut App) + 'static,
    on_sound_stop_all: impl Fn(&mut Window, &mut App) + 'static,
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
    let on_screen = Rc::new(on_screen);
    let on_banner = Rc::new(on_banner);
    let on_banner_hide_all = Rc::new(on_banner_hide_all);
    let on_sound = Rc::new(on_sound);
    let on_sound_stop_all = Rc::new(on_sound_stop_all);
    let screen_label = if screen_hidden {
        SHOW_SCREEN
    } else {
        HIDE_SCREEN
    };
    let screen_hint = if screen_hidden {
        SHOW_SCREEN_HINT.to_string()
    } else {
        HIDE_SCREEN_HINT.to_string()
    };
    let screen_disabled = screen_blocked.is_some();
    let screen_hint = screen_blocked.unwrap_or(screen_hint);

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
                StatusBarAction::new("hide-screen", screen_label)
                    .text(screen_label)
                    .hint(screen_hint.clone())
                    .pressed(screen_hidden)
                    .disabled(screen_disabled)
                    .on_click({
                        let screen = on_screen.clone();
                        move |_, window, app| screen(!screen_hidden, window, app)
                    }),
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
                            .hint(format!("{HIGHLIGHT_POSITION}: {}", anchor.label())),
                    )
                    .menu({
                        let on_anchor = std::rc::Rc::new(on_anchor);
                        move |_, _| {
                            let mut menu = Menu::new().label(SHOW_HIGHLIGHTS_IN);
                            for corner in super::chat::HighlightAnchor::ALL {
                                let on_anchor = on_anchor.clone();
                                menu = menu.radio(
                                    corner.label(),
                                    corner == anchor,
                                    move |window, app| on_anchor(corner, window, app),
                                );
                            }
                            menu
                        }
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
                DropdownMenu::new("banners")
                    .trigger(
                        StatusBarAction::new("banners", BANNERS)
                            .text(BANNERS)
                            .hint(BANNERS_HINT),
                    )
                    .menu({
                        let banners = banners.clone();
                        let on_banner = on_banner.clone();
                        let hide_all = on_banner_hide_all.clone();
                        move |_, _| {
                            banners_menu(banners.as_ref(), on_banner.clone(), hide_all.clone())
                        }
                    }),
            )
            .child(
                DropdownMenu::new("sounds")
                    .trigger(
                        StatusBarAction::new("sounds", SOUNDS)
                            .text(SOUNDS)
                            .hint(SOUNDS_HINT),
                    )
                    .menu({
                        let sounds = sounds.clone();
                        let on_sound = on_sound.clone();
                        let stop_all = on_sound_stop_all.clone();
                        move |_, _| sounds_menu(sounds.as_ref(), on_sound.clone(), stop_all.clone())
                    }),
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
                        let screen = on_screen.clone();
                        let banners = banners.clone();
                        let on_banner = on_banner.clone();
                        let hide_all = on_banner_hide_all.clone();
                        let sounds = sounds.clone();
                        let on_sound = on_sound.clone();
                        let stop_all = on_sound_stop_all.clone();
                        let screen_item = screen_label.to_string();
                        let screen_off = screen_disabled;
                        move |_, _| {
                            let clear = clear.clone();
                            let clip30 = clip.clone();
                            let clip60 = clip.clone();
                            let screen = screen.clone();
                            Menu::new()
                                .item(
                                    MenuItem::new(screen_item.clone())
                                        .disabled(screen_off)
                                        .on_select(move |window, app| {
                                            screen(!screen_hidden, window, app)
                                        }),
                                )
                                .item(MenuItem::new(HIGHLIGHT_POSITION).on_select(|_, _| {}))
                                .item(
                                    MenuItem::new(clip_short_menu.clone())
                                        .on_select(move |window, app| clip30(30, window, app)),
                                )
                                .item(
                                    MenuItem::new(clip_long_menu.clone())
                                        .on_select(move |window, app| clip60(60, window, app)),
                                )
                                .submenu(
                                    BANNERS,
                                    banners_menu(
                                        banners.as_ref(),
                                        on_banner.clone(),
                                        hide_all.clone(),
                                    ),
                                )
                                .submenu(
                                    format!("{SOUNDS}…"),
                                    sounds_menu(
                                        sounds.as_ref(),
                                        on_sound.clone(),
                                        stop_all.clone(),
                                    ),
                                )
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

fn banners_menu(
    banners: Option<&Vec<BannerRow>>,
    on_banner: Rc<dyn Fn(String, bool, &mut Window, &mut App)>,
    hide_all: Rc<dyn Fn(&mut Window, &mut App)>,
) -> Menu {
    let mut menu = Menu::new();
    match banners {
        None => {
            menu = menu.item(MenuItem::new(LOADING_BANNERS).disabled(true));
        }
        Some(list) if list.is_empty() => {
            menu = menu.item(MenuItem::new(IMPORT_BANNERS).disabled(true));
        }
        Some(list) => {
            let any_shown = list.iter().any(|b| b.shown);
            for banner in list {
                let id = banner.id.clone();
                let shown = banner.shown;
                let toggle = on_banner.clone();
                menu = menu.checkbox(banner.name.clone(), shown, move |next, window, app| {
                    toggle(id.clone(), next, window, app)
                });
            }
            menu = menu.separator().item(
                MenuItem::new(HIDE_ALL_BANNERS)
                    .disabled(!any_shown)
                    .on_select(move |window, app| hide_all(window, app)),
            );
        }
    }
    menu
}

fn sounds_menu(
    sounds: Option<&Vec<SoundRow>>,
    on_sound: Rc<dyn Fn(String, &mut Window, &mut App)>,
    stop_all: Rc<dyn Fn(&mut Window, &mut App)>,
) -> Menu {
    let mut menu = Menu::new();
    match sounds {
        None => {
            menu = menu.item(MenuItem::new(LOADING_SOUNDS).disabled(true));
        }
        Some(list) if list.is_empty() => {
            menu = menu.item(MenuItem::new(IMPORT_SOUNDS).disabled(true));
        }
        Some(list) => {
            for sound in list {
                let id = sound.id.clone();
                let play = on_sound.clone();
                menu = menu.item(
                    MenuItem::new(sound.name.clone())
                        .on_select(move |window, app| play(id.clone(), window, app)),
                );
            }
            menu = menu.separator().item(
                MenuItem::new(STOP_ALL_SOUNDS).on_select(move |window, app| stop_all(window, app)),
            );
        }
    }
    menu
}
