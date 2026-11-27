//! The application menu (plan 220 S2.6a): `apps/desktop/src/main/app-menu.ts`
//! as plain data, so the shipped shape is tested here and `videorc-app` only
//! turns it into AppKit menus.
//!
//! macOS gets a real menu bar: the App menu (About, Settings…, Services,
//! Hide, Hide Others, Show All, Quit), Edit from the standard roles (AppKit
//! delivers ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z through the menu's key equivalents, so
//! the Edit menu is load-bearing for every text field, the app's and a native
//! panel's), View (the pages on their digits, Toggle Full Screen), Window
//! (the windows on their own shortcuts, Minimize, Zoom, Close, Bring All to
//! Front) and Help (Release Notes). Windows and Linux get no menu bar, as the
//! packaged Electron app has none.
//!
//! Two departures from Electron, both forced by the Rust app:
//!
//! - **No Reload, Force Reload or Toggle Developer Tools.** They exist in
//!   Electron's development builds for the web page; the Rust app has none.
//! - **Enabled states.** Electron's items are always enabled because every
//!   page and window exists. Here an item whose page or window the Rust app
//!   does not have yet is disabled ([`MenuAvailability`]), never a click that
//!   does nothing; Phase 3 turns them on as the screens land.

use std::collections::BTreeSet;

/// A key the View menu and the page chords open (`PageKey` in
/// `shared/sidebar-pages.ts`): ⌘1–⌘9 and ⌘0, ⇧⌘ and a letter, ⌘, Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PageKey {
    Digit(u8),
    /// An upper-case ASCII letter, pressed with ⇧⌘ (Images ⇧⌘G, Sounds ⇧⌘S).
    Letter(u8),
    /// ⌘, Settings.
    Settings,
}

impl PageKey {
    /// The key as Electron forwards it (`'1'`…`'9'`, `','`).
    pub fn as_char(self) -> char {
        match self {
            PageKey::Digit(digit) => char::from(b'0' + digit),
            PageKey::Letter(letter) => char::from(letter),
            PageKey::Settings => ',',
        }
    }

    /// `pageKeyAccelerator`: ⌘ and the key, ⇧⌘ and a letter.
    pub fn accelerator(self) -> String {
        match self {
            PageKey::Letter(letter) => format!("CmdOrCtrl+Shift+{}", char::from(letter)),
            other => format!("CmdOrCtrl+{}", other.as_char()),
        }
    }
}

/// One page in the View menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MenuPage {
    pub key: PageKey,
    pub title: &'static str,
}

/// The visible sidebar's pages and keys, grouped for the View menu.
/// Settings keeps its separate App-menu item.
pub fn page_groups(guests_shown: bool) -> Vec<Vec<MenuPage>> {
    crate::nav::ZONES
        .iter()
        .map(|(_, pages)| {
            pages
                .iter()
                .filter_map(|page| {
                    let key = page.key(guests_shown)?;
                    (key != PageKey::Settings).then_some(MenuPage {
                        key,
                        title: page.label(),
                    })
                })
                .collect()
        })
        .filter(|group: &Vec<MenuPage>| !group.is_empty())
        .collect()
}

/// The windows the Window menu toggles (`AppMenuWindowId`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum WindowId {
    Preview,
    Notes,
    StreamManager,
    Captions,
}

impl WindowId {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowId::Preview => "preview",
            WindowId::Notes => "notes",
            WindowId::StreamManager => "stream-manager",
            WindowId::Captions => "captions",
        }
    }
}

/// One window in the Window menu: its name (`WINDOW_NAMES`) and the chord its
/// own shortcut already uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MenuWindow {
    pub id: WindowId,
    pub title: &'static str,
    pub accelerator: &'static str,
}

/// `APP_MENU_WINDOWS`.
pub const WINDOWS: [MenuWindow; 4] = [
    MenuWindow {
        id: WindowId::Preview,
        title: "Preview",
        accelerator: "CmdOrCtrl+P",
    },
    MenuWindow {
        id: WindowId::Notes,
        title: "Notes",
        accelerator: "CmdOrCtrl+Shift+N",
    },
    MenuWindow {
        id: WindowId::StreamManager,
        title: "Stream Manager",
        accelerator: "CmdOrCtrl+Shift+J",
    },
    MenuWindow {
        id: WindowId::Captions,
        title: "Captions reader",
        accelerator: "CmdOrCtrl+Shift+C",
    },
];

/// The App menu's Settings item.
pub const SETTINGS_TITLE: &str = "Settings…";
pub const SETTINGS_ACCELERATOR: &str = "CmdOrCtrl+,";
/// Help's one item.
pub const RELEASE_NOTES_TITLE: &str = "Release Notes";

/// `appMenuReleaseNotesUrl`: this version's page.
pub fn release_notes_url(version: &str) -> String {
    format!("https://www.videorc.com/releases/{version}")
}

/// What an app item does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MenuCommand {
    /// Bring the main window up on a page (⌘1–⌘9, ⌘,).
    ShowPage(PageKey),
    /// Open the window, or close it when it is open: what its shortcut does.
    ToggleWindow(WindowId),
    OpenReleaseNotes,
}

/// A standard item AppKit (or the app's quit) carries out: Electron's roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MenuRole {
    About,
    Services,
    Hide,
    HideOthers,
    Unhide,
    /// Quits through the app's own exit, so a livestream asks first and the
    /// backend stops cleanly (never `NSApp terminate:`, which exits at once).
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    PasteAndMatchStyle,
    Delete,
    SelectAll,
    StartSpeaking,
    StopSpeaking,
    ToggleFullScreen,
    Minimize,
    Zoom,
    Close,
    Front,
}

impl MenuRole {
    /// Electron's role name (`MenuItemConstructorOptions.role`).
    pub fn name(self) -> &'static str {
        match self {
            MenuRole::About => "about",
            MenuRole::Services => "services",
            MenuRole::Hide => "hide",
            MenuRole::HideOthers => "hideOthers",
            MenuRole::Unhide => "unhide",
            MenuRole::Quit => "quit",
            MenuRole::Undo => "undo",
            MenuRole::Redo => "redo",
            MenuRole::Cut => "cut",
            MenuRole::Copy => "copy",
            MenuRole::Paste => "paste",
            MenuRole::PasteAndMatchStyle => "pasteAndMatchStyle",
            MenuRole::Delete => "delete",
            MenuRole::SelectAll => "selectAll",
            MenuRole::StartSpeaking => "startSpeaking",
            MenuRole::StopSpeaking => "stopSpeaking",
            MenuRole::ToggleFullScreen => "togglefullscreen",
            MenuRole::Minimize => "minimize",
            MenuRole::Zoom => "zoom",
            MenuRole::Close => "close",
            MenuRole::Front => "front",
        }
    }

    /// The title AppKit's own menus give the role (Electron's role labels on
    /// macOS). `Services` and the App menu's items name the app.
    pub fn title(self, app_name: &str) -> String {
        match self {
            MenuRole::About => format!("About {app_name}"),
            MenuRole::Services => "Services".to_string(),
            MenuRole::Hide => format!("Hide {app_name}"),
            MenuRole::HideOthers => "Hide Others".to_string(),
            MenuRole::Unhide => "Show All".to_string(),
            MenuRole::Quit => format!("Quit {app_name}"),
            MenuRole::Undo => "Undo".to_string(),
            MenuRole::Redo => "Redo".to_string(),
            MenuRole::Cut => "Cut".to_string(),
            MenuRole::Copy => "Copy".to_string(),
            MenuRole::Paste => "Paste".to_string(),
            MenuRole::PasteAndMatchStyle => "Paste and Match Style".to_string(),
            MenuRole::Delete => "Delete".to_string(),
            MenuRole::SelectAll => "Select All".to_string(),
            MenuRole::StartSpeaking => "Start Speaking".to_string(),
            MenuRole::StopSpeaking => "Stop Speaking".to_string(),
            MenuRole::ToggleFullScreen => "Toggle Full Screen".to_string(),
            MenuRole::Minimize => "Minimize".to_string(),
            MenuRole::Zoom => "Zoom".to_string(),
            MenuRole::Close => "Close Window".to_string(),
            MenuRole::Front => "Bring All to Front".to_string(),
        }
    }

    /// The chord Electron gives the role on macOS, as an accelerator.
    pub fn accelerator(self) -> Option<&'static str> {
        Some(match self {
            MenuRole::Hide => "CmdOrCtrl+H",
            MenuRole::HideOthers => "Alt+CmdOrCtrl+H",
            MenuRole::Quit => "CmdOrCtrl+Q",
            MenuRole::Undo => "CmdOrCtrl+Z",
            MenuRole::Redo => "Shift+CmdOrCtrl+Z",
            MenuRole::Cut => "CmdOrCtrl+X",
            MenuRole::Copy => "CmdOrCtrl+C",
            MenuRole::Paste => "CmdOrCtrl+V",
            MenuRole::PasteAndMatchStyle => "Alt+Shift+CmdOrCtrl+V",
            MenuRole::SelectAll => "CmdOrCtrl+A",
            MenuRole::ToggleFullScreen => "Control+CmdOrCtrl+F",
            MenuRole::Minimize => "CmdOrCtrl+M",
            MenuRole::Close => "CmdOrCtrl+W",
            _ => return None,
        })
    }

    /// The Edit roles: the app routes them to the focused text field of its
    /// own key window, and hands them down the responder chain anywhere else
    /// (a native panel's field).
    pub fn is_edit(self) -> bool {
        matches!(
            self,
            MenuRole::Undo
                | MenuRole::Redo
                | MenuRole::Cut
                | MenuRole::Copy
                | MenuRole::Paste
                | MenuRole::PasteAndMatchStyle
                | MenuRole::Delete
                | MenuRole::SelectAll
        )
    }
}

/// Which top-level menu AppKit should treat as its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmenuRole {
    /// The application menu, titled with the app's name.
    App,
    Edit,
    View,
    /// `NSApp.windowsMenu`: AppKit lists the open windows in it.
    Window,
    /// `NSApp.helpMenu`: AppKit adds the help search field.
    Help,
    /// A plain submenu (Speech).
    Plain,
}

/// One menu entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuEntry {
    Separator,
    Role(MenuRole),
    Item {
        title: String,
        accelerator: Option<String>,
        command: MenuCommand,
        enabled: bool,
    },
    Submenu {
        title: String,
        role: SubmenuRole,
        items: Vec<MenuEntry>,
    },
}

impl MenuEntry {
    fn item(title: &str, accelerator: Option<&str>, command: MenuCommand, enabled: bool) -> Self {
        MenuEntry::Item {
            title: title.to_string(),
            accelerator: accelerator.map(str::to_string),
            command,
            enabled,
        }
    }

    fn submenu(title: &str, role: SubmenuRole, items: Vec<MenuEntry>) -> Self {
        MenuEntry::Submenu {
            title: title.to_string(),
            role,
            items,
        }
    }

    /// The title a person reads (`None` for a separator).
    pub fn title(&self, app_name: &str) -> Option<String> {
        match self {
            MenuEntry::Separator => None,
            MenuEntry::Role(role) => Some(role.title(app_name)),
            MenuEntry::Item { title, .. } | MenuEntry::Submenu { title, .. } => Some(title.clone()),
        }
    }

    /// The chord, as an accelerator.
    pub fn accelerator(&self) -> Option<String> {
        match self {
            MenuEntry::Role(role) => role.accelerator().map(str::to_string),
            MenuEntry::Item { accelerator, .. } => accelerator.clone(),
            _ => None,
        }
    }

    pub fn items(&self) -> &[MenuEntry] {
        match self {
            MenuEntry::Submenu { items, .. } => items,
            _ => &[],
        }
    }
}

/// The platform the menu is built for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuPlatform {
    Mac,
    Windows,
    Linux,
}

impl MenuPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            MenuPlatform::Mac
        } else if cfg!(target_os = "windows") {
            MenuPlatform::Windows
        } else {
            MenuPlatform::Linux
        }
    }
}

/// What the Rust app has so far: the pages and windows a menu item may open.
/// A window it does not have leaves the Window menu (Electron's
/// `windowsEnabled`); a page it does not have stays listed but disabled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuAvailability {
    pub pages: BTreeSet<PageKey>,
    pub windows: BTreeSet<WindowId>,
}

impl MenuAvailability {
    /// Phase 2: the Studio page and the Preview window.
    pub fn phase_2() -> Self {
        Self {
            pages: BTreeSet::from([PageKey::Digit(1)]),
            windows: BTreeSet::from([WindowId::Preview]),
        }
    }

    /// Everything (Electron's shape, for the tests that mirror it).
    pub fn everything() -> Self {
        let pages = page_groups(true)
            .iter()
            .flat_map(|group| group.iter().map(|page| page.key))
            .chain([PageKey::Settings])
            .collect();
        Self {
            pages,
            windows: WINDOWS.iter().map(|window| window.id).collect(),
        }
    }

    pub fn command_enabled(&self, command: MenuCommand) -> bool {
        match command {
            MenuCommand::ShowPage(key) => self.pages.contains(&key),
            MenuCommand::ToggleWindow(id) => self.windows.contains(&id),
            MenuCommand::OpenReleaseNotes => true,
        }
    }
}

/// `appMenuTemplate`: the menu for this platform, or `None` for no menu bar
/// at all. Pure, so the shipped shape is tested: always the Edit roles on
/// macOS, every chord once.
pub fn app_menu_template(
    platform: MenuPlatform,
    app_name: &str,
    availability: &MenuAvailability,
    guests_shown: bool,
) -> Option<Vec<MenuEntry>> {
    if platform != MenuPlatform::Mac {
        return None;
    }
    let enabled = |command| availability.command_enabled(command);

    let mut pages = Vec::new();
    for (index, group) in page_groups(guests_shown).iter().enumerate() {
        if index > 0 {
            pages.push(MenuEntry::Separator);
        }
        for page in group.iter() {
            let command = MenuCommand::ShowPage(page.key);
            let accelerator = page.key.accelerator();
            pages.push(MenuEntry::item(
                page.title,
                Some(&accelerator),
                command,
                enabled(command),
            ));
        }
    }
    let windows: Vec<MenuEntry> = WINDOWS
        .iter()
        .filter(|window| availability.windows.contains(&window.id))
        .map(|window| {
            MenuEntry::item(
                window.title,
                Some(window.accelerator),
                MenuCommand::ToggleWindow(window.id),
                true,
            )
        })
        .collect();
    let settings = MenuCommand::ShowPage(PageKey::Settings);

    let app = MenuEntry::submenu(
        app_name,
        SubmenuRole::App,
        vec![
            MenuEntry::Role(MenuRole::About),
            MenuEntry::Separator,
            MenuEntry::item(
                SETTINGS_TITLE,
                Some(SETTINGS_ACCELERATOR),
                settings,
                enabled(settings),
            ),
            MenuEntry::Separator,
            MenuEntry::Role(MenuRole::Services),
            MenuEntry::Separator,
            MenuEntry::Role(MenuRole::Hide),
            MenuEntry::Role(MenuRole::HideOthers),
            MenuEntry::Role(MenuRole::Unhide),
            MenuEntry::Separator,
            MenuEntry::Role(MenuRole::Quit),
        ],
    );
    let edit = MenuEntry::submenu(
        "Edit",
        SubmenuRole::Edit,
        vec![
            MenuEntry::Role(MenuRole::Undo),
            MenuEntry::Role(MenuRole::Redo),
            MenuEntry::Separator,
            MenuEntry::Role(MenuRole::Cut),
            MenuEntry::Role(MenuRole::Copy),
            MenuEntry::Role(MenuRole::Paste),
            MenuEntry::Role(MenuRole::PasteAndMatchStyle),
            MenuEntry::Role(MenuRole::Delete),
            MenuEntry::Role(MenuRole::SelectAll),
            MenuEntry::Separator,
            MenuEntry::submenu(
                "Speech",
                SubmenuRole::Plain,
                vec![
                    MenuEntry::Role(MenuRole::StartSpeaking),
                    MenuEntry::Role(MenuRole::StopSpeaking),
                ],
            ),
        ],
    );
    let mut view_items = pages;
    view_items.push(MenuEntry::Separator);
    view_items.push(MenuEntry::Role(MenuRole::ToggleFullScreen));
    let view = MenuEntry::submenu("View", SubmenuRole::View, view_items);
    let mut window_items = windows;
    window_items.extend([
        MenuEntry::Separator,
        MenuEntry::Role(MenuRole::Minimize),
        MenuEntry::Role(MenuRole::Zoom),
        MenuEntry::Role(MenuRole::Close),
        MenuEntry::Separator,
        MenuEntry::Role(MenuRole::Front),
    ]);
    let window = MenuEntry::submenu("Window", SubmenuRole::Window, window_items);
    let help = MenuEntry::submenu(
        "Help",
        SubmenuRole::Help,
        vec![MenuEntry::item(
            RELEASE_NOTES_TITLE,
            None,
            MenuCommand::OpenReleaseNotes,
            true,
        )],
    );
    Some(vec![app, edit, view, window, help])
}

/// Every entry at every depth.
pub fn every_entry(entries: &[MenuEntry]) -> Vec<&MenuEntry> {
    entries
        .iter()
        .flat_map(|entry| std::iter::once(entry).chain(every_entry(entry.items())))
        .collect()
}

/// One spelling per chord (`Command+H` and `CmdOrCtrl+H` compare equal):
/// the parts sorted, the command key named once.
pub fn chord(accelerator: &str) -> String {
    let mut parts: Vec<String> = accelerator
        .split('+')
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            match lower.as_str() {
                "command" | "cmd" | "commandorcontrol" | "cmdorctrl" => "Cmd".to_string(),
                "option" | "alt" => "Alt".to_string(),
                "control" | "ctrl" => "Ctrl".to_string(),
                _ if part.chars().count() == 1 => part.to_uppercase(),
                _ => part.to_string(),
            }
        })
        .collect();
    parts.sort();
    parts.join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = "Videorc";

    fn template() -> Vec<MenuEntry> {
        app_menu_template(
            MenuPlatform::Mac,
            APP,
            &MenuAvailability::everything(),
            true,
        )
        .unwrap()
    }

    fn top<'a>(template: &'a [MenuEntry], title: &str) -> &'a [MenuEntry] {
        template
            .iter()
            .find(|entry| entry.title(APP).as_deref() == Some(title))
            .map(MenuEntry::items)
            .unwrap_or_else(|| panic!("no {title} menu"))
    }

    /// Electron's test spelling: a role's name, else the label, else "separator".
    fn shape(entries: &[MenuEntry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| match entry {
                MenuEntry::Separator => "separator".to_string(),
                MenuEntry::Role(role) => role.name().to_string(),
                other => other.title(APP).unwrap(),
            })
            .collect()
    }

    #[test]
    fn visible_page_menu_updates_names_keys_and_commands() {
        for shown in [false, true, false] {
            let menu = app_menu_template(
                MenuPlatform::Mac,
                APP,
                &MenuAvailability::everything(),
                shown,
            )
            .unwrap();
            let view = menu
                .iter()
                .find_map(|entry| match entry {
                    MenuEntry::Submenu { title, items, .. } if title == "View" => Some(items),
                    _ => None,
                })
                .unwrap();
            let text = format!("{view:?}");
            assert_eq!(text.contains("Guests"), shown);
            for (title, digit) in [
                ("Avatar", if shown { 8 } else { 7 }),
                ("Sidekick", if shown { 9 } else { 8 }),
            ] {
                let expected = MenuEntry::item(
                    title,
                    Some(&PageKey::Digit(digit).accelerator()),
                    MenuCommand::ShowPage(PageKey::Digit(digit)),
                    true,
                );
                assert!(view.contains(&expected));
            }
        }
    }

    #[test]
    fn builds_the_edit_menu_from_roles_so_the_editing_keys_reach_every_text_field() {
        let template = template();
        assert_eq!(
            shape(top(&template, "Edit")),
            [
                "undo",
                "redo",
                "separator",
                "cut",
                "copy",
                "paste",
                "pasteAndMatchStyle",
                "delete",
                "selectAll",
                "separator",
                "Speech"
            ]
        );
    }

    #[test]
    fn opens_settings_on_command_comma_from_the_app_menu_beside_about_hide_and_quit() {
        let template = template();
        let app = top(&template, APP);
        assert_eq!(
            shape(app),
            [
                "about",
                "separator",
                "Settings…",
                "separator",
                "services",
                "separator",
                "hide",
                "hideOthers",
                "unhide",
                "separator",
                "quit"
            ]
        );
        let settings = &app[2];
        assert_eq!(settings.accelerator().as_deref(), Some("CmdOrCtrl+,"));
        assert!(matches!(
            settings,
            MenuEntry::Item {
                command: MenuCommand::ShowPage(PageKey::Settings),
                ..
            }
        ));
    }

    #[test]
    fn lists_the_pages_in_sidebar_order_on_their_keys() {
        let template = template();
        let view = top(&template, "View");
        let pages: Vec<String> = view
            .iter()
            .filter_map(|entry| match entry {
                MenuEntry::Item {
                    title,
                    accelerator: Some(accelerator),
                    command: MenuCommand::ShowPage(PageKey::Digit(_) | PageKey::Letter(_)),
                    ..
                } => Some(format!("{title} {accelerator}")),
                _ => None,
            })
            .collect();
        assert_eq!(
            pages,
            [
                "Studio CmdOrCtrl+1",
                "Sources CmdOrCtrl+2",
                "Scene CmdOrCtrl+3",
                "Captions CmdOrCtrl+4",
                "Output CmdOrCtrl+5",
                "Destinations CmdOrCtrl+6",
                "Guests CmdOrCtrl+7",
                "Avatar CmdOrCtrl+8",
                "Sidekick CmdOrCtrl+9",
                "Images CmdOrCtrl+Shift+G",
                "Sounds CmdOrCtrl+Shift+S",
                "Library CmdOrCtrl+0"
            ]
        );
        assert_eq!(
            view.last(),
            Some(&MenuEntry::Role(MenuRole::ToggleFullScreen))
        );
        // No Reload, Force Reload or developer tools: the Rust app has no page
        // to reload.
        for entry in every_entry(&template) {
            if let Some(title) = entry.title(APP) {
                assert!(!title.contains("Reload"), "{title}");
                assert!(!title.contains("Developer"), "{title}");
            }
        }
    }

    #[test]
    fn toggles_each_window_on_its_shortcut_and_leaves_out_a_window_the_app_lacks() {
        let template = template();
        let window = top(&template, "Window");
        let windows: Vec<String> = window
            .iter()
            .filter_map(|entry| match entry {
                MenuEntry::Item {
                    title,
                    accelerator: Some(accelerator),
                    ..
                } => Some(format!("{title} {accelerator}")),
                _ => None,
            })
            .collect();
        assert_eq!(
            windows,
            [
                "Preview CmdOrCtrl+P",
                "Notes CmdOrCtrl+Shift+N",
                "Stream Manager CmdOrCtrl+Shift+J",
                "Captions reader CmdOrCtrl+Shift+C"
            ]
        );
        let roles: Vec<&str> = window
            .iter()
            .filter_map(|entry| match entry {
                MenuEntry::Role(role) => Some(role.name()),
                _ => None,
            })
            .collect();
        assert_eq!(roles, ["minimize", "zoom", "close", "front"]);

        let mut without_notes = MenuAvailability::everything();
        without_notes.windows.remove(&WindowId::Notes);
        let template = app_menu_template(MenuPlatform::Mac, APP, &without_notes, true).unwrap();
        let titles: Vec<String> = top(&template, "Window")
            .iter()
            .filter_map(|entry| entry.title(APP))
            .collect();
        assert!(!titles.contains(&"Notes".to_string()), "{titles:?}");
    }

    #[test]
    fn opens_the_release_notes_from_help() {
        let template = template();
        let help = top(&template, "Help");
        assert_eq!(shape(help), ["Release Notes"]);
        assert!(matches!(
            help[0],
            MenuEntry::Item {
                command: MenuCommand::OpenReleaseNotes,
                enabled: true,
                ..
            }
        ));
        assert_eq!(
            release_notes_url("0.20.1"),
            "https://www.videorc.com/releases/0.20.1"
        );
    }

    #[test]
    fn uses_each_chord_once_and_never_one_the_app_keeps_for_itself() {
        let template = template();
        let chords: Vec<String> = every_entry(&template)
            .into_iter()
            .filter_map(MenuEntry::accelerator)
            .map(|accelerator| chord(&accelerator))
            .collect();
        let unique: BTreeSet<&String> = chords.iter().collect();
        assert_eq!(unique.len(), chords.len(), "{chords:?}");
        // ⌘K search, ⌘J Sidekick, ⌘F chat search, ⌘S a clean cut, ⌘N a greeting
        // variant and ⌘↵ submit stay the pages' own.
        for own in [
            "CmdOrCtrl+K",
            "CmdOrCtrl+J",
            "CmdOrCtrl+F",
            "CmdOrCtrl+S",
            "CmdOrCtrl+N",
            "CmdOrCtrl+Enter",
        ] {
            assert!(!chords.contains(&chord(own)), "{own}");
        }
        assert_eq!(chord("Command+Alt+H"), chord("Alt+CmdOrCtrl+H"));
    }

    #[test]
    fn shows_no_menu_bar_on_windows_and_linux() {
        for platform in [MenuPlatform::Windows, MenuPlatform::Linux] {
            assert_eq!(
                app_menu_template(platform, APP, &MenuAvailability::everything(), true),
                None
            );
        }
    }

    #[test]
    fn phase_2_enables_only_what_the_rust_app_has() {
        let template =
            app_menu_template(MenuPlatform::Mac, APP, &MenuAvailability::phase_2(), true).unwrap();
        let enabled: Vec<(String, bool)> = every_entry(&template)
            .into_iter()
            .filter_map(|entry| match entry {
                MenuEntry::Item { title, enabled, .. } => Some((title.clone(), *enabled)),
                _ => None,
            })
            .collect();
        let on: Vec<&str> = enabled
            .iter()
            .filter(|(_, on)| *on)
            .map(|(title, _)| title.as_str())
            .collect();
        assert_eq!(on, ["Studio", "Preview", "Release Notes"]);
        // Every page stays listed (disabled), Settings… too; the windows the
        // app lacks leave the menu.
        assert!(enabled.iter().any(|(title, on)| title == "Library" && !on));
        assert!(
            enabled
                .iter()
                .any(|(title, on)| title == "Settings…" && !on)
        );
        assert!(!enabled.iter().any(|(title, _)| title == "Notes"));
    }

    #[test]
    fn the_edit_roles_are_the_routed_ones() {
        let edit: Vec<MenuRole> = every_entry(&template())
            .into_iter()
            .filter_map(|entry| match entry {
                MenuEntry::Role(role) if role.is_edit() => Some(*role),
                _ => None,
            })
            .collect();
        assert_eq!(edit.len(), 8);
        assert!(!MenuRole::StartSpeaking.is_edit());
        assert_eq!(MenuRole::Close.title(APP), "Close Window");
        assert_eq!(MenuRole::Quit.title(APP), "Quit Videorc");
    }
}
