//! Destinations → Watchdog settings as the Studio runs them
//! (`watchdog.settings.get` / `.set`, `watchdog.phone.devices`).
//!
//! Pure view rules live in [`crate::livestream::watchdog_section`]. This
//! module holds the saved settings and phone device count on a watch
//! channel. An older backend never answers: `settings` stays `None` and
//! the section stays away. L2 fills any protocol typing gaps; the RPC
//! names here match Electron.

use serde_json::{Value, json};
use tokio::sync::watch;

use super::{Studio, StudioBackend};
use crate::livestream::watchdog_section::{self, Settings};

pub const SETTINGS_GET: &str = "watchdog.settings.get";
pub const SETTINGS_SET: &str = "watchdog.settings.set";
pub const PHONE_DEVICES: &str = "watchdog.phone.devices";

/// What Destinations' Watchdog section reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WatchdogSettingsStore {
    /// `None` until `watchdog.settings.get` answers (or forever on an
    /// older backend).
    pub settings: Option<Settings>,
    /// How many phone devices take alerts; `None` while unread or locked.
    pub phone_devices: Option<usize>,
    /// The QR / link row is open.
    pub show_code: bool,
    /// "Copied" flash after Copy link.
    pub copied: bool,
}

impl<B: StudioBackend> Studio<B> {
    pub fn watchdog_settings(&self) -> watch::Receiver<WatchdogSettingsStore> {
        self.watchdog_settings_tx.subscribe()
    }

    pub fn watchdog_settings_now(&self) -> WatchdogSettingsStore {
        self.watchdog_settings_tx.borrow().clone()
    }

    fn edit_watchdog_settings(&self, edit: impl FnOnce(&mut WatchdogSettingsStore) -> bool) {
        self.watchdog_settings_tx.send_if_modified(edit);
    }

    /// Bootstrap / page open: `watchdog.settings.get`. Silence on failure
    /// (the section stays away, as Electron).
    pub(super) async fn read_watchdog_settings(&self) {
        match self
            .backend
            .livestream_request(SETTINGS_GET, Value::Null)
            .await
            .and_then(|value| super::backend::read_json::<Settings>(SETTINGS_GET, value))
        {
            Ok(settings) => {
                self.edit_watchdog_settings(|store| {
                    store.settings = Some(settings);
                    true
                });
            }
            Err(_) => {}
        }
    }

    /// Premium: `watchdog.phone.devices` for the Phone row's count.
    pub async fn refresh_watchdog_phone_devices(&self) {
        match self
            .backend
            .livestream_request(PHONE_DEVICES, Value::Null)
            .await
        {
            Ok(view) => {
                let count = watchdog_section::device_count(&view);
                self.edit_watchdog_settings(|store| {
                    if store.phone_devices != count {
                        store.phone_devices = count;
                        true
                    } else {
                        false
                    }
                });
            }
            Err(_) => {
                self.edit_watchdog_settings(|store| {
                    if store.phone_devices.take().is_some() {
                        true
                    } else {
                        false
                    }
                });
            }
        }
    }

    /// `watchdog.settings.set`: the patch for one control; the answer
    /// replaces the store.
    pub async fn set_watchdog_settings(&self, patch: Value) {
        match self
            .backend
            .livestream_request(SETTINGS_SET, patch)
            .await
            .and_then(|value| super::backend::read_json::<Settings>(SETTINGS_SET, value))
        {
            Ok(settings) => {
                self.edit_watchdog_settings(|store| {
                    store.settings = Some(settings);
                    true
                });
            }
            Err(error) => {
                self.config
                    .logger
                    .warn(format!("Studio: {SETTINGS_SET} did not save ({error})."));
            }
        }
    }

    pub fn set_watchdog_show_code(&self, show: bool) {
        self.edit_watchdog_settings(|store| {
            if store.show_code == show && !store.copied {
                return false;
            }
            store.show_code = show;
            store.copied = false;
            true
        });
    }

    pub fn note_watchdog_link_copied(&self) {
        self.edit_watchdog_settings(|store| {
            if store.copied {
                return false;
            }
            store.copied = true;
            true
        });
    }

    /// Convenience patches the Destinations screen sends.
    pub async fn set_watchdog_check(&self, id: &str, enabled: bool) {
        self.set_watchdog_settings(watchdog_section::check_patch(id, enabled))
            .await;
    }

    pub async fn set_watchdog_mic_muted_after(&self, seconds: u32) {
        self.set_watchdog_settings(watchdog_section::mic_muted_after_patch(seconds))
            .await;
    }

    pub async fn set_watchdog_system_notifications(&self, on: bool) {
        self.set_watchdog_settings(watchdog_section::system_notifications_patch(on))
            .await;
    }

    pub async fn set_watchdog_phone_push(&self, on: bool) {
        self.set_watchdog_settings(watchdog_section::phone_push_patch(on))
            .await;
    }

    pub async fn set_watchdog_ai_chat_read(&self, on: bool) {
        self.set_watchdog_settings(watchdog_section::ai_chat_read_patch(on))
            .await;
    }
}

/// Re-export so callers can build a patch without naming the livestream module.
pub fn check_patch(id: &str, enabled: bool) -> Value {
    watchdog_section::check_patch(id, enabled)
}

pub fn empty_patch() -> Value {
    json!({})
}
