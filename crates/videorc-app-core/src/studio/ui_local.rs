//! The per-device conveniences (plan 220 P3-D5, S3.0d): what Electron keeps
//! in Chromium's `localStorage` because it belongs to this device only (the
//! Settings, Sidekick, Avatar and Destinations tabs used last, a collapsed section, a
//! source row's More). The Rust app can't read Chromium's storage, so it
//! keeps its own `ui-local.json` in its data directory and the conveniences
//! start fresh at the switch.
//!
//! The file holds the same keys and string values `localStorage` held
//! (`videorc.settingsTab: "general"`), and each reader repairs a value the
//! way its TypeScript reader does (`lib/settings-tabs.ts`,
//! `lib/buddy-tabs.ts`, `lib/livestream-tabs.ts`, `lib/avatar-tabs.ts`,
//! `source-item.tsx`). A missing or unreadable file reads as nothing stored;
//! a write that fails is named and changes nothing else (a convenience
//! never breaks a page).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The keys, as `STORAGE_KEYS` and the components name them.
pub mod keys {
    pub const SETTINGS_TAB: &str = "videorc.settingsTab";
    /// Keeps its old name (plan 170 D22).
    pub const BUDDY_TAB: &str = "videorc.orcleTab";
    pub const LIVESTREAM_VIEW: &str = "videorc.livestreamView";
    /// Plan 239: the Avatar page's tab used last (`STORAGE_KEYS.avatarTab`).
    pub const AVATAR_TAB: &str = "videorc.avatarTab";
    /// A prefix: one key per source row (`videorc.sources.more.<id>`).
    pub const SOURCE_MORE_PREFIX: &str = "videorc.sources.more.";
    /// S3.0e: this device's copy of the theme, next-themes' own under the
    /// same key (`storageKey`), which paints the first frame before the
    /// settings store answers; the store's `videorc.theme` wins after.
    pub const THEME: &str = "videorc.theme";
}

/// The file's name in the data directory.
pub const UI_LOCAL_FILE: &str = "ui-local.json";

/// `SETTINGS_TABS`, in strip order; `DEFAULT_SETTINGS_TAB` first.
pub const SETTINGS_TABS: [&str; 5] = ["general", "permissions", "shortcuts", "remote", "about"];
/// `BUDDY_TABS` (the Sidekick page's), in strip order; `DEFAULT_BUDDY_TAB`
/// (`live`, labelled Overview) first. Plan 225 added Community.
pub const BUDDY_TABS: [&str; 6] = ["live", "chat", "community", "voice", "reports", "clean-cut"];
/// `LIVESTREAM_VIEWS` (the Destinations page's); `DEFAULT_LIVESTREAM_VIEW`
/// first. #1591 added Discord.
pub const LIVESTREAM_VIEWS: [&str; 3] = ["setup", "upcoming", "discord"];
/// Plan 239: `AVATAR_TABS`; `DEFAULT_AVATAR_TAB` (`profile`) first.
pub const AVATAR_TABS: [&str; 2] = ["profile", "greetings"];

/// `migrateSettingsTabId`: a current tab as is, a retired one (`recording`,
/// plan 174 S3.6) as the tab that replaced it, anything else `None`.
pub fn migrate_settings_tab_id(value: &str) -> Option<&'static str> {
    if let Some(tab) = SETTINGS_TABS.iter().find(|tab| **tab == value) {
        return Some(tab);
    }
    (value == "recording").then_some("general")
}

/// The conveniences, as read from and written to `ui-local.json`.
#[derive(Debug, Clone)]
pub struct UiLocal {
    path: PathBuf,
    values: BTreeMap<String, String>,
}

impl UiLocal {
    /// `<data dir>/ui-local.json`.
    pub fn in_dir(data_dir: &Path) -> Self {
        Self::open(data_dir.join(UI_LOCAL_FILE))
    }

    /// The file at `path`; missing or unreadable is empty (string values
    /// only, as `localStorage` held).
    pub fn open(path: PathBuf) -> Self {
        let values = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| match value {
                Value::Object(object) => Some(
                    object
                        .into_iter()
                        .filter_map(|(key, value)| match value {
                            Value::String(text) => Some((key, text)),
                            _ => None,
                        })
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default();
        Self { path, values }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `localStorage.getItem(key)`.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    /// `localStorage.setItem(key, value)`, saved at once.
    pub fn set(&mut self, key: &str, value: &str) -> std::io::Result<()> {
        let previous = self.values.insert(key.to_string(), value.to_string());
        self.save_or_restore(key, previous)
    }

    /// `localStorage.removeItem(key)`, saved at once.
    pub fn remove(&mut self, key: &str) -> std::io::Result<()> {
        let previous = self.values.remove(key);
        self.save_or_restore(key, previous)
    }

    fn save_or_restore(&mut self, key: &str, previous: Option<String>) -> std::io::Result<()> {
        let saved = self.save();
        if saved.is_err() {
            match previous {
                Some(previous) => self.values.insert(key.to_string(), previous),
                None => self.values.remove(key),
            };
        }
        saved
    }

    fn save(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(&self.values).map_err(std::io::Error::other)?;
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, &self.path)
    }

    /// `readLastSettingsTab`: the tab used last (a retired one as its
    /// replacement), else General.
    pub fn settings_tab(&self) -> &'static str {
        self.get(keys::SETTINGS_TAB)
            .and_then(migrate_settings_tab_id)
            .unwrap_or(SETTINGS_TABS[0])
    }

    /// `writeLastSettingsTab`.
    pub fn set_settings_tab(&mut self, tab: &str) -> std::io::Result<()> {
        self.set(keys::SETTINGS_TAB, tab)
    }

    /// `readLastBuddyTab`: the tab used last, else Profile (`live`).
    pub fn buddy_tab(&self) -> &'static str {
        self.get(keys::BUDDY_TAB)
            .and_then(|stored| BUDDY_TABS.iter().find(|tab| **tab == stored))
            .copied()
            .unwrap_or(BUDDY_TABS[0])
    }

    pub fn set_buddy_tab(&mut self, tab: &str) -> std::io::Result<()> {
        self.set(keys::BUDDY_TAB, tab)
    }

    /// `readLastLivestreamView`: the view used last, else Setup.
    pub fn livestream_view(&self) -> &'static str {
        self.get(keys::LIVESTREAM_VIEW)
            .and_then(|stored| LIVESTREAM_VIEWS.iter().find(|view| **view == stored))
            .copied()
            .unwrap_or(LIVESTREAM_VIEWS[0])
    }

    pub fn set_livestream_view(&mut self, view: &str) -> std::io::Result<()> {
        self.set(keys::LIVESTREAM_VIEW, view)
    }

    /// Plan 239: `readLastAvatarTab`: the tab used last, else Profile.
    pub fn avatar_tab(&self) -> &'static str {
        self.get(keys::AVATAR_TAB)
            .and_then(|stored| AVATAR_TABS.iter().find(|tab| **tab == stored))
            .copied()
            .unwrap_or(AVATAR_TABS[0])
    }

    /// `writeLastAvatarTab`.
    pub fn set_avatar_tab(&mut self, tab: &str) -> std::io::Result<()> {
        self.set(keys::AVATAR_TAB, tab)
    }

    /// `readMoreOpen(id)`: `=== '1'`.
    pub fn source_more_open(&self, source_id: &str) -> bool {
        self.get(&format!("{}{source_id}", keys::SOURCE_MORE_PREFIX)) == Some("1")
    }

    /// `writeMoreOpen(id, open)`: `'1'`, or the key removed.
    pub fn set_source_more_open(&mut self, source_id: &str, open: bool) -> std::io::Result<()> {
        let key = format!("{}{source_id}", keys::SOURCE_MORE_PREFIX);
        if open {
            self.set(&key, "1")
        } else {
            self.remove(&key)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_convenience_reads_as_its_page_reads_it_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut local = UiLocal::in_dir(dir.path());
        assert_eq!(local.settings_tab(), "general");
        assert_eq!(local.buddy_tab(), "live");
        assert_eq!(local.livestream_view(), "setup");
        assert_eq!(local.avatar_tab(), "profile");
        assert!(!local.source_more_open("camera:cam-1"));

        local.set_settings_tab("recording").unwrap();
        assert_eq!(local.settings_tab(), "general", "a retired tab");
        local.set_settings_tab("not-a-tab").unwrap();
        assert_eq!(local.settings_tab(), "general", "not a Settings tab");
        local.set_settings_tab("remote").unwrap();
        local.set_buddy_tab("community").unwrap();
        local.set_livestream_view("discord").unwrap();
        local.set_avatar_tab("greetings").unwrap();
        local.set_source_more_open("camera:cam-1", true).unwrap();

        let reopened = UiLocal::in_dir(dir.path());
        assert_eq!(reopened.settings_tab(), "remote");
        assert_eq!(reopened.buddy_tab(), "community");
        assert_eq!(reopened.livestream_view(), "discord");
        assert_eq!(reopened.avatar_tab(), "greetings");
        assert!(reopened.source_more_open("camera:cam-1"));

        let mut local = reopened;
        local.set_avatar_tab("nonsense").unwrap();
        assert_eq!(local.avatar_tab(), "profile");
        local.set_source_more_open("camera:cam-1", false).unwrap();
        assert_eq!(local.get("videorc.sources.more.camera:cam-1"), None);
        local.set_buddy_tab("nonsense").unwrap();
        assert_eq!(local.buddy_tab(), "live");

        std::fs::write(local.path(), "not json").unwrap();
        assert_eq!(UiLocal::in_dir(dir.path()).settings_tab(), "general");
    }
}
