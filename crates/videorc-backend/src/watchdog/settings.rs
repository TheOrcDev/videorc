//! The watchdog's settings (plan 223 D7): every check on by default, the
//! muted-microphone clock, system notifications, the phone push and the AI
//! chat read. Persisted in `app_settings` like the cloud's and Buddy's.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::alerts::WatchdogCheck;

pub const WATCHDOG_SETTINGS_KEY: &str = "watchdogSettings";

/// The "Alert me after" choices for `mic-muted` (D4, owner answer 1: 30 s).
pub const MIC_MUTED_AFTER_CHOICES: [u32; 4] = [15, 30, 60, 120];
pub const DEFAULT_MIC_MUTED_AFTER_SECONDS: u32 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSetting {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogSettings {
    /// Keyed by the check's id; a check missing from the map is on.
    #[serde(default)]
    pub checks: BTreeMap<String, CheckSetting>,
    #[serde(default = "default_mic_muted_after")]
    pub mic_muted_after_seconds: u32,
    #[serde(default = "default_true")]
    pub system_notifications: bool,
    #[serde(default = "default_true")]
    pub phone_push: bool,
    /// B2: "AI reads chat for problems", Premium (owner answer 5: on).
    #[serde(default = "default_true")]
    pub ai_chat_read: bool,
}

fn default_true() -> bool {
    true
}

fn default_mic_muted_after() -> u32 {
    DEFAULT_MIC_MUTED_AFTER_SECONDS
}

impl Default for WatchdogSettings {
    fn default() -> Self {
        Self {
            checks: WatchdogCheck::ALL
                .iter()
                .map(|check| (check.id().to_string(), CheckSetting { enabled: true }))
                .collect(),
            mic_muted_after_seconds: DEFAULT_MIC_MUTED_AFTER_SECONDS,
            system_notifications: true,
            phone_push: true,
            ai_chat_read: true,
        }
    }
}

/// `watchdog.settings.set`: every field optional, the checks merged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<BTreeMap<String, CheckSetting>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_muted_after_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_notifications: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone_push: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_chat_read: Option<bool>,
}

impl WatchdogSettings {
    pub fn enabled(&self, check: WatchdogCheck) -> bool {
        self.checks
            .get(check.id())
            .map(|setting| setting.enabled)
            .unwrap_or(true)
    }

    /// The saved row with every known check present and the clock on one of
    /// its choices, whatever an older row or a hand edit left.
    pub fn normalized(mut self) -> Self {
        for check in WatchdogCheck::ALL {
            self.checks
                .entry(check.id().to_string())
                .or_insert(CheckSetting { enabled: true });
        }
        self.checks
            .retain(|id, _| WatchdogCheck::parse(id).is_some());
        if !MIC_MUTED_AFTER_CHOICES.contains(&self.mic_muted_after_seconds) {
            self.mic_muted_after_seconds = DEFAULT_MIC_MUTED_AFTER_SECONDS;
        }
        self
    }

    pub fn apply(&self, patch: WatchdogSettingsPatch) -> Result<Self, String> {
        let mut next = self.clone();
        if let Some(checks) = patch.checks {
            for (id, setting) in checks {
                if WatchdogCheck::parse(&id).is_none() {
                    return Err(format!("{id} is not a watchdog check."));
                }
                next.checks.insert(id, setting);
            }
        }
        if let Some(after) = patch.mic_muted_after_seconds {
            if !MIC_MUTED_AFTER_CHOICES.contains(&after) {
                return Err("micMutedAfterSeconds must be 15, 30, 60 or 120.".to_string());
            }
            next.mic_muted_after_seconds = after;
        }
        if let Some(on) = patch.system_notifications {
            next.system_notifications = on;
        }
        if let Some(on) = patch.phone_push {
            next.phone_push = on;
        }
        if let Some(on) = patch.ai_chat_read {
            next.ai_chat_read = on;
        }
        Ok(next.normalized())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_check_is_on_by_default_and_an_empty_row_means_the_defaults() {
        let settings = WatchdogSettings::default();
        for check in WatchdogCheck::ALL {
            assert!(settings.enabled(check), "{} must default on", check.id());
        }
        let empty: WatchdogSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.normalized(), settings);
        assert_eq!(settings.mic_muted_after_seconds, 30);
        assert!(settings.phone_push && settings.system_notifications && settings.ai_chat_read);
    }

    #[test]
    fn a_patch_merges_and_refuses_unknown_checks_and_odd_clocks() {
        let settings = WatchdogSettings::default();
        let next = settings
            .apply(WatchdogSettingsPatch {
                checks: Some(BTreeMap::from([(
                    "still-there".to_string(),
                    CheckSetting { enabled: false },
                )])),
                mic_muted_after_seconds: Some(60),
                phone_push: Some(false),
                ..Default::default()
            })
            .unwrap();
        assert!(!next.enabled(WatchdogCheck::StillThere));
        assert!(next.enabled(WatchdogCheck::MicMuted));
        assert_eq!(next.mic_muted_after_seconds, 60);
        assert!(!next.phone_push);
        assert!(
            settings
                .apply(WatchdogSettingsPatch {
                    mic_muted_after_seconds: Some(45),
                    ..Default::default()
                })
                .is_err()
        );
        assert!(
            settings
                .apply(WatchdogSettingsPatch {
                    checks: Some(BTreeMap::from([(
                        "nope".to_string(),
                        CheckSetting { enabled: false }
                    )])),
                    ..Default::default()
                })
                .is_err()
        );
        let hand_edited: WatchdogSettings = serde_json::from_str(
            r#"{"micMutedAfterSeconds":7,"checks":{"old":{"enabled":false}}}"#,
        )
        .unwrap();
        let normalized = hand_edited.normalized();
        assert_eq!(normalized.mic_muted_after_seconds, 30);
        assert!(!normalized.checks.contains_key("old"));
    }
}
