//! The menu bar (plan 260 S2.6a): the core's template
//! (`videorc_app_core::desktop::menu::app_menu_template`, Electron's
//! `appMenuTemplate`) as GPUI menus, with each item's chord bound in GPUI's
//! keymap so the menu shows it and the key runs it.
//!
//! An item is enabled when its action has a handler: the roles always do,
//! a page only once it is ported (`nav::PORTED`, the same set the sidebar
//! and the keys read), a window only once it exists. A disabled item stays
//! listed, never hidden.
//!
//! GPUI's `OsAction` covers Undo, Redo, Cut, Copy, Paste and Select All; the
//! template's other Edit roles (Paste and Match Style, Delete, Speech) wait
//! for it and are left out of the menu meanwhile.

use gpui::{Action, App, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType, actions};
use videorc_app_core::desktop::menu::{
    MenuCommand, MenuEntry, MenuPlatform, MenuRole, PageKey, WindowId, app_menu_template,
    release_notes_url,
};
use videorc_app_core::nav;

actions!(
    videorc,
    [
        Quit,
        About,
        HideApp,
        HideOthers,
        ShowAll,
        Undo,
        Redo,
        Cut,
        Copy,
        Paste,
        SelectAll,
        ToggleFullScreen,
        Minimize,
        Zoom,
        CloseWindow,
        BringAllToFront,
        ShowPage1,
        ShowPage2,
        ShowPage3,
        ShowPage4,
        ShowPage5,
        ShowPage6,
        ShowPage7,
        ShowPage8,
        ShowPage9,
        ShowPage0,
        ShowImages,
        ShowSounds,
        ShowSettings,
        ShowShortcuts,
        TogglePreview,
        ToggleNotes,
        ToggleStreamManager,
        ToggleCaptions,
        OpenReleaseNotes,
        ToggleSearch,
    ]
);

/// The app's name in its menus.
pub const APP_NAME: &str = "Videorc";

/// An Electron accelerator (`CmdOrCtrl+Shift+G`) as a GPUI keystroke
/// (`secondary-shift-g`).
pub fn keystroke(accelerator: &str) -> String {
    accelerator
        .split('+')
        .filter(|part| !part.is_empty())
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "commandorcontrol" => "secondary".to_string(),
            "cmd" | "command" | "super" | "meta" => "cmd".to_string(),
            "ctrl" | "control" => "ctrl".to_string(),
            "alt" | "option" => "alt".to_string(),
            "shift" => "shift".to_string(),
            "plus" => "+".to_string(),
            "return" => "enter".to_string(),
            "esc" => "escape".to_string(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("-")
}

/// The page key's action.
pub(crate) fn page_action(key: PageKey) -> Option<Box<dyn Action>> {
    Some(match key {
        PageKey::Digit(1) => Box::new(ShowPage1),
        PageKey::Digit(2) => Box::new(ShowPage2),
        PageKey::Digit(3) => Box::new(ShowPage3),
        PageKey::Digit(4) => Box::new(ShowPage4),
        PageKey::Digit(5) => Box::new(ShowPage5),
        PageKey::Digit(6) => Box::new(ShowPage6),
        PageKey::Digit(7) => Box::new(ShowPage7),
        PageKey::Digit(8) => Box::new(ShowPage8),
        PageKey::Digit(9) => Box::new(ShowPage9),
        PageKey::Digit(0) => Box::new(ShowPage0),
        PageKey::Letter(b'G') => Box::new(ShowImages),
        PageKey::Letter(b'S') => Box::new(ShowSounds),
        PageKey::Settings => Box::new(ShowSettings),
        _ => return None,
    })
}

fn window_action(window: WindowId) -> Box<dyn Action> {
    match window {
        WindowId::Preview => Box::new(TogglePreview),
        WindowId::Notes => Box::new(ToggleNotes),
        WindowId::StreamManager => Box::new(ToggleStreamManager),
        WindowId::Captions => Box::new(ToggleCaptions),
    }
}

/// A role's action, or how GPUI shows it.
enum RoleItem {
    Action(Box<dyn Action>),
    Os(Box<dyn Action>, OsAction),
    Services,
    /// No GPUI form yet.
    Skip,
}

fn role_item(role: MenuRole) -> RoleItem {
    match role {
        MenuRole::About => RoleItem::Action(Box::new(About)),
        MenuRole::Services => RoleItem::Services,
        MenuRole::Hide => RoleItem::Action(Box::new(HideApp)),
        MenuRole::HideOthers => RoleItem::Action(Box::new(HideOthers)),
        MenuRole::Unhide => RoleItem::Action(Box::new(ShowAll)),
        MenuRole::Quit => RoleItem::Action(Box::new(Quit)),
        MenuRole::Undo => RoleItem::Os(Box::new(Undo), OsAction::Undo),
        MenuRole::Redo => RoleItem::Os(Box::new(Redo), OsAction::Redo),
        MenuRole::Cut => RoleItem::Os(Box::new(Cut), OsAction::Cut),
        MenuRole::Copy => RoleItem::Os(Box::new(Copy), OsAction::Copy),
        MenuRole::Paste => RoleItem::Os(Box::new(Paste), OsAction::Paste),
        MenuRole::SelectAll => RoleItem::Os(Box::new(SelectAll), OsAction::SelectAll),
        MenuRole::ToggleFullScreen => RoleItem::Action(Box::new(ToggleFullScreen)),
        MenuRole::Minimize => RoleItem::Action(Box::new(Minimize)),
        MenuRole::Zoom => RoleItem::Action(Box::new(Zoom)),
        MenuRole::Close => RoleItem::Action(Box::new(CloseWindow)),
        MenuRole::Front => RoleItem::Action(Box::new(BringAllToFront)),
        _ => RoleItem::Skip,
    }
}

/// The menus and the keymap the template asks for.
pub struct MenuBar {
    pub menus: Vec<Menu>,
    pub bindings: Vec<KeyBinding>,
}

fn bind(
    cx: &App,
    bindings: &mut Vec<KeyBinding>,
    accelerator: Option<String>,
    action: &dyn Action,
) {
    if let Some(accelerator) = accelerator {
        let keys = keystroke(&accelerator);
        match KeyBinding::load(&keys, action.boxed_clone(), None, false, None, cx) {
            Ok(binding) => bindings.push(binding),
            Err(error) => {
                eprintln!("[videorc-app] menu key {accelerator} doesn't bind: {error:?}")
            }
        }
    }
}

fn items(cx: &App, entries: &[MenuEntry], bindings: &mut Vec<KeyBinding>) -> Vec<MenuItem> {
    let mut out = Vec::new();
    for entry in entries {
        let title = entry.title(APP_NAME).unwrap_or_default();
        match entry {
            MenuEntry::Separator => out.push(MenuItem::separator()),
            MenuEntry::Role(role) => match role_item(*role) {
                RoleItem::Action(action) => {
                    bind(cx, bindings, entry.accelerator(), action.as_ref());
                    out.push(MenuItem::Action {
                        name: title.into(),
                        action,
                        os_action: None,
                        checked: false,
                        disabled: false,
                    });
                }
                RoleItem::Os(action, os_action) => {
                    bind(cx, bindings, entry.accelerator(), action.as_ref());
                    out.push(MenuItem::Action {
                        name: title.into(),
                        action,
                        os_action: Some(os_action),
                        checked: false,
                        disabled: false,
                    });
                }
                RoleItem::Services => {
                    out.push(MenuItem::os_submenu(title, SystemMenuType::Services))
                }
                RoleItem::Skip => {}
            },
            MenuEntry::Item { command, .. } => {
                let action = match command {
                    MenuCommand::ShowPage(key) => page_action(*key),
                    MenuCommand::ToggleWindow(window) => Some(window_action(*window)),
                    MenuCommand::OpenReleaseNotes => Some(Box::new(OpenReleaseNotes) as _),
                };
                if let Some(action) = action {
                    bind(cx, bindings, entry.accelerator(), action.as_ref());
                    out.push(MenuItem::Action {
                        name: title.into(),
                        action,
                        os_action: None,
                        checked: false,
                        disabled: false,
                    });
                }
            }
            MenuEntry::Submenu {
                items: children, ..
            } => {
                out.push(MenuItem::submenu(Menu {
                    name: title.into(),
                    items: items(cx, children, bindings),
                    disabled: false,
                }));
            }
        }
    }
    out
}

/// The menu bar for this platform (`None` off macOS, where the window
/// carries no menu bar, as Electron's).
pub fn menu_bar(cx: &App, windows: &[WindowId]) -> Option<MenuBar> {
    let mut availability = nav::menu_availability(windows);
    availability.pages.insert(PageKey::Settings);
    let template = app_menu_template(MenuPlatform::current(), APP_NAME, &availability)?;
    let mut bindings = Vec::new();
    let mut menus = Vec::new();
    for entry in &template {
        if let MenuEntry::Submenu {
            items: children, ..
        } = entry
        {
            menus.push(Menu {
                name: entry.title(APP_NAME).unwrap_or_default().into(),
                items: items(cx, children, &mut bindings),
                disabled: false,
            });
        }
    }
    Some(MenuBar { menus, bindings })
}

/// The windows that exist; each handles its own command
/// (`screens::stream_manager::window::install`).
const WINDOWS: &[WindowId] = &[WindowId::StreamManager, WindowId::Notes];

/// The roles' handlers, and the commands that work now. Pages and windows
/// get theirs as they are ported.
pub fn install(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new(
            "secondary-k",
            ToggleSearch,
            Some("!Dialog && !Popover && !Select && !Menu"),
        ),
        KeyBinding::new("secondary-k", ToggleSearch, Some("CommandPalette")),
        KeyBinding::new("secondary-,", ShowSettings, None),
        KeyBinding::new("secondary-/", ShowShortcuts, None),
    ]);
    if let Some(bar) = menu_bar(cx, WINDOWS) {
        cx.bind_keys(bar.bindings);
        cx.set_menus(bar.menus);
    } else {
        cx.bind_keys([KeyBinding::new("secondary-q", Quit, None)]);
    }
    // Quit and Close Window on the main window ask first while on air.
    cx.on_action(|_: &Quit, cx| super::exit::ExitGuard::request_quit(cx));
    cx.on_action(|_: &HideApp, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &BringAllToFront, cx| cx.activate(true));
    cx.on_action(|_: &Minimize, cx| with_active_window(cx, |window| window.minimize_window()));
    cx.on_action(|_: &Zoom, cx| with_active_window(cx, |window| window.zoom_window()));
    cx.on_action(|_: &ToggleFullScreen, cx| {
        with_active_window(cx, |window| window.toggle_fullscreen())
    });
    cx.on_action(|_: &CloseWindow, cx| super::exit::ExitGuard::close_active_window(cx));
    cx.on_action(|_: &OpenReleaseNotes, cx| {
        cx.open_url(&release_notes_url(env!("CARGO_PKG_VERSION")))
    });
}

fn with_active_window(cx: &mut App, f: impl FnOnce(&mut gpui::Window)) {
    if let Some(window) = cx.active_window() {
        let _ = window.update(cx, |_, window, _| f(window));
    }
}

#[cfg(test)]
mod tests {
    use super::keystroke;

    #[test]
    fn electron_accelerators_read_as_gpui_keystrokes() {
        assert_eq!(keystroke("CmdOrCtrl+Shift+G"), "secondary-shift-g");
        assert_eq!(keystroke("CmdOrCtrl+,"), "secondary-,");
        assert_eq!(keystroke("Ctrl+Alt+Shift+1"), "ctrl-alt-shift-1");
        assert_eq!(keystroke("Command+Option+Esc"), "cmd-alt-escape");
        assert_eq!(keystroke("F13"), "f13");
    }
}
