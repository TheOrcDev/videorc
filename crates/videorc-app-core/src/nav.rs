//! The main window's pages (plan 260 S1.6f, from `videorc-rust`'s plan 220
//! S3.0e, caught up with Electron on 2026-11-24): `components/workspace-nav.tsx`,
//! `shared/sidebar-pages.ts`, `lib/workspace-navigation.ts`,
//! `lib/shell-shortcuts.ts` and `lib/theme-choice.ts` as plain data, so the
//! shell's shape is tested here and the app only shows it.
//!
//! - **The pages** ([`PageId`]): Electron's ids, each with its label, its
//!   legacy trigger id (the `data-videorc-tab-trigger` value the smokes and
//!   deep links use: Scene is `layout`, Destinations `streaming`), its
//!   sidebar zone and its key.
//! - **The sidebar** ([`SIDEBAR_ORDER`], [`ZONES`]): Studio; Setup (Sources,
//!   Scene, Captions, Output); Livestream (Destinations, Guests, Avatar,
//!   Sidekick); Assets (Images, Sounds); then Library and Settings in the
//!   bottom block. Guests shows only with talk shows; Health has no row.
//! - **The keys** ([`page_key`]): the fixed keys first (Images ⇧⌘G, Sounds
//!   ⇧⌘S, Library ⌘0, Settings ⌘,), then ⌘1–⌘9 down the remaining rows
//!   (`assignPageKeys`), as the View menu's (`desktop::menu`).
//! - **Navigation from outside a page** ([`Navigation`],
//!   [`read_workspace_navigation`]): a page with the Settings tab, Sidekick
//!   tab, Avatar tab, Destinations view or destination, or Library session it
//!   was asked for; a sub-tab that does not exist opens the page on its
//!   remembered tab, a page that does not exist is dropped. "Run setup
//!   again" ([`FirstRunSetupRequest`]) returns to Settings unless it names a
//!   page.
//! - **The shell's chords** ([`shell_shortcut_action`]) and **the theme
//!   toggle** ([`next_toggled_theme`]).
//! - **What the GPUI app has** ([`PORTED`]): the one set every way to a page
//!   reads (the sidebar, the keys, the View menu). A page outside it stays
//!   listed and disabled, never hidden; each screen slice (Phase 3) adds its
//!   page here.

use serde_json::Value;

use crate::desktop::menu::{MenuAvailability, PageKey, WindowId};

/// A page of the main window (`WorkspaceTab`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PageId {
    Studio,
    Sources,
    /// Scene (legacy trigger `layout`).
    Layouts,
    Captions,
    /// Output.
    Recording,
    /// Destinations (legacy trigger `streaming`).
    Live,
    /// The talk show's room; its row shows only with talk shows, its key stays.
    Guests,
    Avatar,
    /// Sidekick. Its id is `ai`, the id deep links and the smokes use.
    Ai,
    /// Images (the page that was Assets keeps the id).
    Assets,
    Sounds,
    Library,
    Settings,
    /// Health: no sidebar row and no key.
    Diagnostics,
}

/// A sidebar zone (`SidebarZoneId`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageGroup {
    /// Studio, at the top.
    Stage,
    /// "Setup": the pages you configure between sessions.
    Setup,
    /// "Livestream".
    Livestream,
    /// "Assets": Images and Sounds.
    Assets,
    /// The bottom block: Library and Settings (and Health, which has no row).
    System,
}

impl PageGroup {
    /// The zone's `SectionLabel`; Stage and System carry none.
    pub fn label(self) -> Option<&'static str> {
        match self {
            PageGroup::Setup => Some("Setup"),
            PageGroup::Livestream => Some("Livestream"),
            PageGroup::Assets => Some("Assets"),
            PageGroup::Stage | PageGroup::System => None,
        }
    }
}

/// Every page, in Electron's declaration order (`WORKSPACE_TABS`, then
/// `STUDIO_PANELS`).
pub const PAGES: [PageId; 14] = [
    PageId::Studio,
    PageId::Avatar,
    PageId::Guests,
    PageId::Ai,
    PageId::Library,
    PageId::Settings,
    PageId::Diagnostics,
    PageId::Sources,
    PageId::Layouts,
    PageId::Assets,
    PageId::Sounds,
    PageId::Captions,
    PageId::Recording,
    PageId::Live,
];

/// `SIDEBAR_LAYOUT`: the zones, top to bottom, and their pages.
pub const ZONES: [(PageGroup, &[PageId]); 5] = [
    (PageGroup::Stage, &[PageId::Studio]),
    (
        PageGroup::Setup,
        &[
            PageId::Sources,
            PageId::Layouts,
            PageId::Captions,
            PageId::Recording,
        ],
    ),
    (
        PageGroup::Livestream,
        &[PageId::Live, PageId::Guests, PageId::Avatar, PageId::Ai],
    ),
    (PageGroup::Assets, &[PageId::Assets, PageId::Sounds]),
    (PageGroup::System, &[PageId::Library, PageId::Settings]),
];

/// Every page the sidebar shows, top to bottom (Health has no row).
pub const SIDEBAR_ORDER: [PageId; 13] = [
    PageId::Studio,
    PageId::Sources,
    PageId::Layouts,
    PageId::Captions,
    PageId::Recording,
    PageId::Live,
    PageId::Guests,
    PageId::Avatar,
    PageId::Ai,
    PageId::Assets,
    PageId::Sounds,
    PageId::Library,
    PageId::Settings,
];

/// `PAGE_FIXED_KEYS`: the keys that do not follow the digit run.
const FIXED_KEYS: [(PageId, PageKey); 4] = [
    (PageId::Assets, PageKey::Letter(b'G')),
    (PageId::Sounds, PageKey::Letter(b'S')),
    (PageId::Library, PageKey::Digit(0)),
    (PageId::Settings, PageKey::Settings),
];

/// The page routes installed by the GPUI app. This is availability, not a
/// claim of visual/runtime parity in docs/gpui/parity.md.
pub const PORTED: &[PageId] = &[
    PageId::Studio,
    PageId::Sources,
    PageId::Live,
    PageId::Guests,
    PageId::Settings,
    PageId::Diagnostics,
];

impl PageId {
    /// The page's id, as Electron names it.
    pub fn id(self) -> &'static str {
        match self {
            PageId::Studio => "studio",
            PageId::Sources => "sources",
            PageId::Layouts => "layouts",
            PageId::Captions => "captions",
            PageId::Recording => "recording",
            PageId::Live => "live",
            PageId::Guests => "guests",
            PageId::Avatar => "avatar",
            PageId::Ai => "ai",
            PageId::Assets => "assets",
            PageId::Sounds => "sounds",
            PageId::Library => "library",
            PageId::Settings => "settings",
            PageId::Diagnostics => "diagnostics",
        }
    }

    /// `isWorkspaceTab`: the page with this id.
    pub fn parse(id: &str) -> Option<PageId> {
        PAGES.into_iter().find(|page| page.id() == id)
    }

    /// `workspaceTabLabel` (`SIDEBAR_PAGE_LABELS`): the sidebar's and the
    /// toolbar's words.
    pub fn label(self) -> &'static str {
        match self {
            PageId::Studio => "Studio",
            PageId::Sources => "Sources",
            PageId::Layouts => "Scene",
            PageId::Captions => "Captions",
            PageId::Recording => "Output",
            PageId::Live => "Destinations",
            PageId::Guests => "Guests",
            PageId::Avatar => "Avatar",
            PageId::Ai => "Sidekick",
            PageId::Assets => "Images",
            PageId::Sounds => "Sounds",
            PageId::Library => "Library",
            PageId::Settings => "Settings",
            PageId::Diagnostics => "Health",
        }
    }

    /// The `data-videorc-tab-trigger` value: a panel's `legacyTabId`, every
    /// other page's own id.
    pub fn trigger_id(self) -> &'static str {
        match self {
            PageId::Layouts => "layout",
            PageId::Live => "streaming",
            other => other.id(),
        }
    }

    /// The page a smoke's `open-tab {tab}` names: a trigger id or, for a page
    /// without a sidebar row (Health), its own id.
    pub fn from_tab_param(tab: &str) -> Option<PageId> {
        PAGES
            .into_iter()
            .find(|page| page.trigger_id() == tab)
            .or_else(|| PageId::parse(tab))
    }

    /// The page's zone; Health sits with the bottom block, without a row.
    pub fn group(self) -> PageGroup {
        ZONES
            .iter()
            .find(|(_, pages)| pages.contains(&self))
            .map(|(group, _)| *group)
            .unwrap_or(PageGroup::System)
    }

    /// `isStudioPanel`: a page that opens as a Studio panel (`STUDIO_PANELS`).
    pub fn is_studio_panel(self) -> bool {
        matches!(
            self,
            PageId::Sources
                | PageId::Layouts
                | PageId::Assets
                | PageId::Sounds
                | PageId::Live
                | PageId::Captions
                | PageId::Recording
        )
    }

    /// The page's key (`pageKeyFor`), none for Health.
    pub fn key(self) -> Option<PageKey> {
        page_keys()
            .into_iter()
            .find(|(page, _)| *page == self)
            .map(|(_, key)| key)
    }

    /// The key main forwards for the page (`'1'`, `','`, `'G'`), as
    /// `videorc-rust` named it.
    pub fn shortcut_key(self) -> Option<char> {
        self.key().map(PageKey::as_char)
    }

    /// The page's chord as an accelerator (`pageShortcutFor`).
    pub fn accelerator(self) -> Option<String> {
        self.key().map(PageKey::accelerator)
    }

    /// `sidebarOrderFor`: the row's position down the sidebar (0 for Health).
    pub fn sidebar_order(self) -> usize {
        SIDEBAR_ORDER
            .iter()
            .position(|page| *page == self)
            .unwrap_or(0)
    }

    /// The page a View menu item (or its key equivalent) opens.
    pub fn from_menu_key(key: PageKey) -> Option<PageId> {
        page_keys()
            .into_iter()
            .find(|(_, candidate)| *candidate == key)
            .map(|(page, _)| page)
    }

    /// Whether the GPUI app has this page yet ([`PORTED`]).
    pub fn ported(self) -> bool {
        PORTED.contains(&self)
    }
}

/// `assignPageKeys(SIDEBAR_LAYOUT, PAGE_FIXED_KEYS)`: the fixed keys first,
/// then ⌘1–⌘9 and ⌘0 down the remaining rows, minus any digit a fixed key
/// takes.
pub fn page_keys() -> Vec<(PageId, PageKey)> {
    let mut digits: Vec<u8> = (1..=9).chain([0]).collect();
    digits.retain(|digit| {
        !FIXED_KEYS
            .iter()
            .any(|(_, key)| *key == PageKey::Digit(*digit))
    });
    let mut digits = digits.into_iter();
    SIDEBAR_ORDER
        .iter()
        .filter_map(|page| {
            let fixed = FIXED_KEYS
                .iter()
                .find(|(candidate, _)| candidate == page)
                .map(|(_, key)| *key);
            fixed
                .or_else(|| digits.next().map(PageKey::Digit))
                .map(|key| (*page, key))
        })
        .collect()
}

/// `workspaceWindowTitle`: "Studio – Videorc", read by Mission Control, the
/// Windows taskbar and screen readers. An en dash (the copy rules).
pub fn window_title(page: PageId) -> String {
    format!("{} – Videorc", page.label())
}

/// The key main forwards on `shortcut:navigate` ('1'–'9', '0', ',' or an
/// upper-case letter), as a page key.
pub fn forwarded_key(key: char) -> Option<PageKey> {
    match key {
        ',' => Some(PageKey::Settings),
        '0'..='9' => key.to_digit(10).map(|digit| PageKey::Digit(digit as u8)),
        'A'..='Z' => Some(PageKey::Letter(key as u8)),
        _ => None,
    }
}

/// `navigationShortcutTab`: the page a forwarded key opens, or none: an
/// unknown key, or a dialog that owns the keyboard.
pub fn navigation_shortcut_tab(key: char, modal_open: bool) -> Option<PageId> {
    if modal_open {
        return None;
    }
    forwarded_key(key).and_then(PageId::from_menu_key)
}

/// The View menu's and the App menu's page items, and the Window menu's
/// windows, from [`PORTED`].
pub fn menu_availability(windows: &[WindowId]) -> MenuAvailability {
    MenuAvailability {
        pages: PORTED.iter().filter_map(|page| page.key()).collect(),
        windows: windows.iter().copied().collect(),
    }
}

/// The sub-tab ids a navigation may name, as the pages define them
/// (`lib/settings-tabs.ts`, `buddy-tabs.ts`, `avatar-tabs.ts`,
/// `livestream-tabs.ts`); a test reads those files.
pub mod sub_tabs {
    /// `SETTINGS_TABS`.
    pub const SETTINGS_TABS: [&str; 5] = ["general", "permissions", "shortcuts", "remote", "about"];
    /// `RETIRED_SETTINGS_TABS`: Settings → Recording is gone (plan 174 S3.6).
    pub const RETIRED_SETTINGS_TABS: [(&str, &str); 1] = [("recording", "general")];
    /// `BUDDY_TABS` (Sidekick's tabs).
    pub const BUDDY_TABS: [&str; 6] =
        ["live", "chat", "community", "voice", "reports", "clean-cut"];
    /// `AVATAR_TABS`.
    pub const AVATAR_TABS: [&str; 2] = ["profile", "greetings"];
    /// `LIVESTREAM_VIEWS` (Destinations' views).
    pub const LIVESTREAM_VIEWS: [&str; 3] = ["setup", "upcoming", "discord"];

    /// `migrateSettingsTabId`: a current id as is, a retired one as the tab
    /// that replaced it, anything else as none.
    pub fn migrate_settings_tab_id(value: &str) -> Option<&'static str> {
        SETTINGS_TABS
            .iter()
            .copied()
            .find(|tab| *tab == value)
            .or_else(|| {
                RETIRED_SETTINGS_TABS
                    .iter()
                    .find(|(retired, _)| *retired == value)
                    .map(|(_, current)| *current)
            })
    }

    pub(crate) fn known(list: &[&'static str], value: &str) -> Option<&'static str> {
        list.iter().copied().find(|known| *known == value)
    }
}

/// A page asked for from outside it (`WorkspaceNavigation`), with the
/// sub-tab, view, destination or session it names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Navigation {
    Settings {
        settings_tab: Option<&'static str>,
    },
    /// The Sidekick page (`ai`) on `buddyTab`.
    Sidekick {
        buddy_tab: Option<&'static str>,
    },
    Avatar {
        avatar_tab: Option<&'static str>,
    },
    /// Destinations (`live`) on a view, or on one destination's card, which
    /// lives in Setup (plan 250 S4).
    Destinations {
        view: Option<&'static str>,
        destination_id: Option<String>,
    },
    Library {
        session_id: Option<String>,
    },
    Plain(PageId),
}

impl Navigation {
    /// The page it opens.
    pub fn page(&self) -> PageId {
        match self {
            Navigation::Settings { .. } => PageId::Settings,
            Navigation::Sidekick { .. } => PageId::Ai,
            Navigation::Avatar { .. } => PageId::Avatar,
            Navigation::Destinations { .. } => PageId::Live,
            Navigation::Library { .. } => PageId::Library,
            Navigation::Plain(page) => *page,
        }
    }

    /// `openWorkspaceTab(tab, subTab?)`'s detail, read back.
    pub fn open(page: PageId, sub_tab: Option<&str>) -> Option<Navigation> {
        let mut detail = serde_json::Map::new();
        detail.insert("tab".into(), Value::String(page.id().into()));
        if let Some(sub) = sub_tab {
            let key = match page {
                PageId::Settings => Some("settingsTab"),
                PageId::Ai => Some("buddyTab"),
                PageId::Avatar => Some("avatarTab"),
                PageId::Live => Some("livestreamView"),
                PageId::Library => Some("sessionId"),
                _ => None,
            };
            if let Some(key) = key {
                detail.insert(key.into(), Value::String(sub.into()));
            }
        }
        read_workspace_navigation(&Value::Object(detail))
    }

    /// The detail as `openWorkspaceTab` sends it (`{tab, settingsTab?…}`).
    pub fn to_json(&self) -> Value {
        let mut detail = serde_json::Map::new();
        detail.insert("tab".into(), Value::String(self.page().id().into()));
        let mut put = |key: &str, value: &str| {
            detail.insert(key.into(), Value::String(value.into()));
        };
        match self {
            Navigation::Settings {
                settings_tab: Some(tab),
            } => put("settingsTab", tab),
            Navigation::Sidekick {
                buddy_tab: Some(tab),
            } => put("buddyTab", tab),
            Navigation::Avatar {
                avatar_tab: Some(tab),
            } => put("avatarTab", tab),
            Navigation::Destinations {
                view,
                destination_id,
            } => {
                if let Some(view) = view {
                    put("livestreamView", view);
                }
                if let Some(id) = destination_id {
                    put("destinationId", id);
                }
            }
            Navigation::Library {
                session_id: Some(id),
            } => put("sessionId", id),
            _ => {}
        }
        Value::Object(detail)
    }
}

/// `readWorkspaceNavigation`: the page an event asks for, or `None` for a
/// page that does not exist. A retired Settings tab opens the tab that
/// replaced it; a sub-tab that does not exist opens the page on its
/// remembered tab; a named destination opens its card in Setup.
pub fn read_workspace_navigation(detail: &Value) -> Option<Navigation> {
    use sub_tabs::{AVATAR_TABS, BUDDY_TABS, LIVESTREAM_VIEWS, known, migrate_settings_tab_id};
    let detail = detail.as_object()?;
    let tab = detail.get("tab").and_then(Value::as_str)?;
    let text = |key: &str| detail.get(key).and_then(Value::as_str);
    match tab {
        "settings" => Some(Navigation::Settings {
            settings_tab: text("settingsTab").and_then(migrate_settings_tab_id),
        }),
        "ai" => Some(Navigation::Sidekick {
            buddy_tab: text("buddyTab").and_then(|tab| known(&BUDDY_TABS, tab)),
        }),
        "avatar" => Some(Navigation::Avatar {
            avatar_tab: text("avatarTab").and_then(|tab| known(&AVATAR_TABS, tab)),
        }),
        "live" => match text("destinationId").filter(|id| !id.is_empty()) {
            Some(id) => Some(Navigation::Destinations {
                view: Some("setup"),
                destination_id: Some(id.to_string()),
            }),
            None => Some(Navigation::Destinations {
                view: text("livestreamView").and_then(|view| known(&LIVESTREAM_VIEWS, view)),
                destination_id: None,
            }),
        },
        "library" => Some(Navigation::Library {
            session_id: text("sessionId").map(str::to_string),
        }),
        other => PageId::parse(other).map(Navigation::Plain),
    }
}

/// "Run setup again…" (plan 203 S5): Continue or Skip for now return to
/// `return_to`, Settings unless the request names a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirstRunSetupRequest {
    pub return_to: PageId,
}

/// `readFirstRunSetupRequest`: an unknown page returns to Settings.
pub fn read_first_run_setup_request(detail: &Value) -> FirstRunSetupRequest {
    let return_to = detail
        .get("returnTo")
        .and_then(Value::as_str)
        .and_then(PageId::parse)
        .unwrap_or(PageId::Settings);
    FirstRunSetupRequest { return_to }
}

/// `ShellShortcutAction`: the main window's chords other than the pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellShortcutAction {
    ToggleSearch,
    CloseSearch,
    TogglePreview,
    ToggleNotes,
    ShowStreamManager,
    ToggleStreamManager,
    ToggleCaptions,
    /// ⇧⌘B: the list behind the bell (plan 250).
    ToggleNotifications,
    OpenShortcuts,
}

/// What `shellShortcutAction` knows about the window at the press.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ShellShortcutContext {
    /// ⌘ is the command key (macOS); elsewhere Ctrl.
    pub mac: bool,
    pub modal_open: bool,
    pub search_open: bool,
    /// The list behind the bell is open: its key closes it.
    pub notifications_open: bool,
    pub notes_window_enabled: bool,
    pub comments_window_enabled: bool,
}

/// A key press as the shell reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ShellKey<'a> {
    pub key: &'a str,
    pub meta: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

/// `shellShortcutAction`: what a key press in the main window does, or
/// `None` when it is not one of the shell's chords. Under a dialog or a menu
/// nothing runs except ⌘K closing Search and ⇧⌘B closing Notifications
/// (each is the open surface's own key).
pub fn shell_shortcut_action(
    event: ShellKey<'_>,
    context: ShellShortcutContext,
) -> Option<ShellShortcutAction> {
    // `isCommandKey`: ⌘ alone on a Mac, Ctrl alone elsewhere.
    let command = if context.mac {
        event.meta && !event.ctrl
    } else {
        event.ctrl && !event.meta
    };
    if !command || event.alt {
        return None;
    }
    let key = event.key.to_lowercase();
    if context.modal_open {
        if key == "b" && event.shift && context.notifications_open {
            return Some(ShellShortcutAction::ToggleNotifications);
        }
        return (key == "k" && !event.shift && context.search_open)
            .then_some(ShellShortcutAction::CloseSearch);
    }
    if event.shift {
        return match key.as_str() {
            "b" => Some(ShellShortcutAction::ToggleNotifications),
            "n" => context
                .notes_window_enabled
                .then_some(ShellShortcutAction::ToggleNotes),
            "j" => context
                .comments_window_enabled
                .then_some(ShellShortcutAction::ToggleStreamManager),
            "c" => Some(ShellShortcutAction::ToggleCaptions),
            _ => None,
        };
    }
    match key.as_str() {
        "k" => Some(ShellShortcutAction::ToggleSearch),
        "p" => Some(ShellShortcutAction::TogglePreview),
        "j" => context
            .comments_window_enabled
            .then_some(ShellShortcutAction::ShowStreamManager),
        "/" => Some(ShellShortcutAction::OpenShortcuts),
        _ => None,
    }
}

/// `ThemeChoice`: what the theme setting stores. Dark unless light or
/// system is stored (`defaultTheme="dark"` in `App.tsx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeChoice {
    Light,
    Dark,
    System,
}

impl ThemeChoice {
    /// The stored value read back; anything else (nothing stored, a value
    /// this build does not know) is Dark.
    pub fn parse(stored: Option<&str>) -> ThemeChoice {
        match stored {
            Some("light") => ThemeChoice::Light,
            Some("system") => ThemeChoice::System,
            _ => ThemeChoice::Dark,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ThemeChoice::Light => "light",
            ThemeChoice::Dark => "dark",
            ThemeChoice::System => "system",
        }
    }

    /// next-themes' `resolvedTheme`: dark or light, System following the
    /// computer.
    pub fn resolved_dark(self, system_dark: bool) -> bool {
        match self {
            ThemeChoice::Light => false,
            ThemeChoice::Dark => true,
            ThemeChoice::System => system_dark,
        }
    }
}

/// `nextToggledTheme`: the D key and the theme button flip what the window
/// shows; landing on the look the computer already asks for hands control
/// back to System instead of dropping it for good.
pub fn next_toggled_theme(resolved_dark: bool, system_dark: bool) -> ThemeChoice {
    let target_dark = !resolved_dark;
    if target_dark == system_dark {
        ThemeChoice::System
    } else if target_dark {
        ThemeChoice::Dark
    } else {
        ThemeChoice::Light
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The Electron files this module mirrors. Listed in
    // `scripts/lib/ci-change-scope.mjs` so a change to one runs these tests.
    const SIDEBAR_PAGES_TS: &str =
        include_str!("../../../apps/desktop/src/shared/sidebar-pages.ts");
    const SETTINGS_TABS_TS: &str =
        include_str!("../../../apps/desktop/src/renderer/src/lib/settings-tabs.ts");
    const BUDDY_TABS_TS: &str =
        include_str!("../../../apps/desktop/src/renderer/src/lib/buddy-tabs.ts");
    const AVATAR_TABS_TS: &str =
        include_str!("../../../apps/desktop/src/renderer/src/lib/avatar-tabs.ts");
    const LIVESTREAM_TABS_TS: &str =
        include_str!("../../../apps/desktop/src/renderer/src/lib/livestream-tabs.ts");

    /// The labels, the layout and the keys are `shared/sidebar-pages.ts`'s.
    #[test]
    fn the_page_map_is_sidebar_pages_ts() {
        let source = SIDEBAR_PAGES_TS;
        for page in SIDEBAR_ORDER {
            assert!(
                source.contains(&format!("{}: '{}'", page.id(), page.label())),
                "{} is labelled {} in sidebar-pages.ts",
                page.id(),
                page.label()
            );
        }
        for (group, pages) in ZONES {
            let ids: Vec<String> = pages
                .iter()
                .map(|page| format!("'{}'", page.id()))
                .collect();
            assert!(
                source.contains(&format!("pages: [{}]", ids.join(", "))),
                "{group:?}: {ids:?}"
            );
            if let Some(label) = group.label() {
                assert!(source.contains(&format!("label: '{label}'")), "{label}");
            }
        }
        for (page, key) in FIXED_KEYS {
            let key = match key {
                PageKey::Letter(letter) => char::from(letter).to_string(),
                PageKey::Digit(digit) => digit.to_string(),
                PageKey::Settings => ",".to_string(),
            };
            assert!(
                source.contains(&format!("{}: '{key}'", page.id())),
                "{} on {key}",
                page.id()
            );
        }
    }

    #[test]
    fn the_keys_run_down_the_sidebar_after_the_fixed_ones() {
        let keys: Vec<String> = page_keys()
            .into_iter()
            .map(|(page, key)| format!("{} {}", page.label(), key.accelerator()))
            .collect();
        assert_eq!(
            keys,
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
                "Library CmdOrCtrl+0",
                "Settings CmdOrCtrl+,",
            ]
        );
        assert_eq!(PageId::Diagnostics.key(), None, "Health has no key");
    }

    /// The menu's View items and the shell's keys are one map.
    #[test]
    fn the_view_menu_shows_the_same_keys() {
        use crate::desktop::menu::PAGE_GROUPS;
        let menu: Vec<(String, PageKey)> = PAGE_GROUPS
            .iter()
            .flat_map(|group| group.iter())
            .map(|page| (page.title.to_string(), page.key))
            .collect();
        let shell: Vec<(String, PageKey)> = page_keys()
            .into_iter()
            .filter(|(page, _)| *page != PageId::Settings)
            .map(|(page, key)| (page.label().to_string(), key))
            .collect();
        assert_eq!(menu, shell);
    }

    #[test]
    fn keeps_legacy_trigger_ids_and_panels() {
        assert_eq!(PageId::Layouts.trigger_id(), "layout");
        assert_eq!(PageId::Live.trigger_id(), "streaming");
        assert_eq!(PageId::Sounds.trigger_id(), "sounds");
        assert_eq!(PageId::from_tab_param("layout"), Some(PageId::Layouts));
        assert_eq!(
            PageId::from_tab_param("diagnostics"),
            Some(PageId::Diagnostics)
        );
        let panels: Vec<PageId> = PAGES.into_iter().filter(|p| p.is_studio_panel()).collect();
        assert_eq!(
            panels,
            [
                PageId::Sources,
                PageId::Layouts,
                PageId::Assets,
                PageId::Sounds,
                PageId::Captions,
                PageId::Recording,
                PageId::Live
            ]
        );
        assert_eq!(window_title(PageId::Live), "Destinations – Videorc");
        assert_eq!(PageId::Diagnostics.group(), PageGroup::System);
        assert_eq!(PageId::Ai.group(), PageGroup::Livestream);
    }

    #[test]
    fn forwarded_keys_open_pages_but_not_from_under_a_dialog() {
        assert_eq!(navigation_shortcut_tab('1', false), Some(PageId::Studio));
        assert_eq!(navigation_shortcut_tab('7', false), Some(PageId::Guests));
        assert_eq!(navigation_shortcut_tab('G', false), Some(PageId::Assets));
        assert_eq!(navigation_shortcut_tab('S', false), Some(PageId::Sounds));
        assert_eq!(navigation_shortcut_tab('0', false), Some(PageId::Library));
        assert_eq!(navigation_shortcut_tab(',', false), Some(PageId::Settings));
        assert_eq!(navigation_shortcut_tab('L', false), None);
        assert_eq!(navigation_shortcut_tab('1', true), None);
    }

    /// The sub-tab ids are the page files' (`lib/*-tabs.ts`).
    #[test]
    fn the_sub_tab_ids_are_the_pages_files() {
        let check = |file: &str, source: &str, ids: &[&str]| {
            for id in ids {
                assert!(source.contains(&format!("{{ id: '{id}'")), "{file}: {id}");
            }
            assert_eq!(
                source.matches("{ id: '").count(),
                ids.len(),
                "{file} has other ids"
            );
        };
        check(
            "settings-tabs.ts",
            SETTINGS_TABS_TS,
            &sub_tabs::SETTINGS_TABS,
        );
        check("buddy-tabs.ts", BUDDY_TABS_TS, &sub_tabs::BUDDY_TABS);
        check("avatar-tabs.ts", AVATAR_TABS_TS, &sub_tabs::AVATAR_TABS);
        check(
            "livestream-tabs.ts",
            LIVESTREAM_TABS_TS,
            &sub_tabs::LIVESTREAM_VIEWS,
        );
        assert!(SETTINGS_TABS_TS.contains("recording: 'general'"));
    }

    #[test]
    fn opens_every_page_and_reads_back_the_same_page() {
        for page in PAGES {
            let navigation = Navigation::open(page, None).unwrap();
            assert_eq!(navigation.page(), page);
            assert_eq!(
                read_workspace_navigation(&navigation.to_json()),
                Some(navigation)
            );
        }
    }

    #[test]
    fn carries_each_pages_sub_tab_and_a_destination_and_session() {
        assert_eq!(
            Navigation::open(PageId::Settings, Some("recording")),
            Some(Navigation::Settings {
                settings_tab: Some("general")
            })
        );
        assert_eq!(
            Navigation::open(PageId::Ai, Some("clean-cut")),
            Some(Navigation::Sidekick {
                buddy_tab: Some("clean-cut")
            })
        );
        assert_eq!(
            Navigation::open(PageId::Avatar, Some("greetings")),
            Some(Navigation::Avatar {
                avatar_tab: Some("greetings")
            })
        );
        let card = read_workspace_navigation(
            &json!({"tab": "live", "destinationId": "d1", "livestreamView": "upcoming"}),
        );
        assert_eq!(
            card,
            Some(Navigation::Destinations {
                view: Some("setup"),
                destination_id: Some("d1".into())
            })
        );
        assert_eq!(
            read_workspace_navigation(&card.unwrap().to_json())
                .unwrap()
                .page(),
            PageId::Live
        );
        assert_eq!(
            read_workspace_navigation(&json!({"tab": "library", "sessionId": "s1"})),
            Some(Navigation::Library {
                session_id: Some("s1".into())
            })
        );
    }

    #[test]
    fn an_unknown_sub_tab_opens_the_remembered_one_and_an_unknown_page_nothing() {
        assert_eq!(
            read_workspace_navigation(&json!({"tab": "ai", "buddyTab": "nope"})),
            Some(Navigation::Sidekick { buddy_tab: None })
        );
        assert_eq!(
            read_workspace_navigation(
                &json!({"tab": "live", "livestreamView": "nope", "destinationId": ""})
            ),
            Some(Navigation::Destinations {
                view: None,
                destination_id: None
            })
        );
        assert_eq!(
            read_workspace_navigation(&json!({"tab": "streaming"})),
            None
        );
        assert_eq!(read_workspace_navigation(&json!({"tab": "buddy"})), None);
        assert_eq!(read_workspace_navigation(&json!("settings")), None);
    }

    #[test]
    fn run_setup_again_returns_to_settings_unless_it_names_a_page() {
        assert_eq!(
            read_first_run_setup_request(&json!({})).return_to,
            PageId::Settings
        );
        assert_eq!(
            read_first_run_setup_request(&json!({"returnTo": "sounds"})).return_to,
            PageId::Sounds
        );
        assert_eq!(
            read_first_run_setup_request(&json!({"returnTo": "nope"})).return_to,
            PageId::Settings
        );
    }

    fn mac() -> ShellShortcutContext {
        ShellShortcutContext {
            mac: true,
            notes_window_enabled: true,
            comments_window_enabled: true,
            ..Default::default()
        }
    }

    fn press(key: &str) -> ShellKey<'_> {
        ShellKey {
            key,
            meta: true,
            ..Default::default()
        }
    }

    fn shift(key: &str) -> ShellKey<'_> {
        ShellKey {
            shift: true,
            ..press(key)
        }
    }

    #[test]
    fn maps_the_shell_chords() {
        use ShellShortcutAction::*;
        let action = |key| shell_shortcut_action(key, mac());
        assert_eq!(action(press("k")), Some(ToggleSearch));
        assert_eq!(action(press("p")), Some(TogglePreview));
        assert_eq!(action(press("j")), Some(ShowStreamManager));
        assert_eq!(action(press("/")), Some(OpenShortcuts));
        assert_eq!(action(shift("N")), Some(ToggleNotes));
        assert_eq!(action(shift("J")), Some(ToggleStreamManager));
        assert_eq!(action(shift("C")), Some(ToggleCaptions));
        assert_eq!(action(shift("B")), Some(ToggleNotifications));
        assert_eq!(action(press("b")), None);
        assert_eq!(action(shift("K")), None);
        let off = ShellShortcutContext {
            notes_window_enabled: false,
            comments_window_enabled: false,
            ..mac()
        };
        assert_eq!(shell_shortcut_action(shift("n"), off), None);
        assert_eq!(shell_shortcut_action(press("j"), off), None);
    }

    #[test]
    fn takes_command_on_a_mac_and_ctrl_elsewhere_never_alt() {
        let ctrl = ShellKey {
            key: "k",
            ctrl: true,
            ..Default::default()
        };
        assert_eq!(shell_shortcut_action(ctrl, mac()), None);
        let windows = ShellShortcutContext {
            mac: false,
            ..mac()
        };
        assert_eq!(
            shell_shortcut_action(ctrl, windows),
            Some(ShellShortcutAction::ToggleSearch)
        );
        assert_eq!(shell_shortcut_action(press("k"), windows), None);
        let alt = ShellKey {
            alt: true,
            ..press("k")
        };
        assert_eq!(shell_shortcut_action(alt, mac()), None);
    }

    #[test]
    fn under_a_dialog_only_the_open_surfaces_own_key_acts() {
        let modal = ShellShortcutContext {
            modal_open: true,
            search_open: true,
            notifications_open: true,
            ..mac()
        };
        assert_eq!(
            shell_shortcut_action(press("k"), modal),
            Some(ShellShortcutAction::CloseSearch)
        );
        assert_eq!(
            shell_shortcut_action(shift("b"), modal),
            Some(ShellShortcutAction::ToggleNotifications)
        );
        assert_eq!(shell_shortcut_action(press("p"), modal), None);
        let closed = ShellShortcutContext {
            search_open: false,
            notifications_open: false,
            ..modal
        };
        assert_eq!(shell_shortcut_action(press("k"), closed), None);
        assert_eq!(shell_shortcut_action(shift("b"), closed), None);
    }

    /// `theme-choice.test.ts`'s cases.
    #[test]
    fn the_theme_toggle_hands_back_to_system() {
        assert_eq!(next_toggled_theme(true, false), ThemeChoice::System);
        assert_eq!(next_toggled_theme(false, true), ThemeChoice::System);
        assert_eq!(next_toggled_theme(true, true), ThemeChoice::Light);
        assert_eq!(next_toggled_theme(false, false), ThemeChoice::Dark);
        assert_eq!(ThemeChoice::parse(Some("system")), ThemeChoice::System);
        assert_eq!(ThemeChoice::parse(Some("sepia")), ThemeChoice::Dark);
        assert_eq!(ThemeChoice::parse(None), ThemeChoice::Dark);
        assert_eq!(ThemeChoice::Light.as_str(), "light");
        assert!(ThemeChoice::System.resolved_dark(true));
        assert!(!ThemeChoice::Light.resolved_dark(true));
    }

    #[test]
    fn installed_pages_are_reachable_but_health_has_no_sidebar_key() {
        assert!(PageId::Diagnostics.ported());
        assert!(PageId::Diagnostics.key().is_none());
        assert!(PageId::Live.ported());
        assert!(menu_availability(&[]).pages.contains(&PageKey::Settings));
    }
}
