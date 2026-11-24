//! Destinations → Watchdog (plan 223 D7: `streaming/watchdog-section.tsx`) as
//! data: every check as a row with its switch, "Alert me after" for the muted
//! microphone, System notifications, the phone (Premium: the link and QR to
//! videorc.com/live and the device count) and "AI reads chat for problems"
//! (Premium). Every check is on by default; an empty list never means
//! silence.
//!
//! The settings are the backend's (`watchdog.settings.get`, `.set`,
//! `watchdog.phone.devices`). `videorc-protocol` has no types for them yet,
//! so they are read leniently here.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const TITLE: &str = "Watchdog";
pub const DESCRIPTION: &str = "While you're live, Videorc notices what viewers see and you don't, and tells you where you'll see it.";

/// `WATCHDOG_CHECK_ROWS`: (id, label, description), in the catalogue's order.
pub const CHECK_ROWS: [(&str, &str, &str); 15] = [
    ("mic-muted", "Microphone muted", "You muted and forgot."),
    (
        "mic-silent",
        "Microphone silent",
        "The device sends only silence.",
    ),
    (
        "no-voice",
        "No voice",
        "Nothing has reached the microphone for 5 minutes.",
    ),
    (
        "program-silent",
        "Viewers hear nothing",
        "No sound leaves the stream for 20 seconds.",
    ),
    (
        "picture-black",
        "Black picture",
        "The stream is black for 10 seconds.",
    ),
    (
        "picture-stopped",
        "Picture stopped",
        "No new frame reaches the stream. A still screen is fine.",
    ),
    (
        "destination-down",
        "Destination down",
        "A platform stops receiving the stream.",
    ),
    (
        "platform-health",
        "Platform reports a problem",
        "YouTube's own health report, X's broadcast state.",
    ),
    (
        "bitrate-floor",
        "Connection too slow",
        "The stream sits at half its bitrate for 2 minutes.",
    ),
    (
        "av-drift",
        "Sound and picture drift",
        "Videorc Cloud measures them apart (cloud shows).",
    ),
    (
        "chat-says",
        "Chat says there is a problem",
        "Two people report no sound, a frozen picture or lag.",
    ),
    (
        "brb-long",
        "Long Be right back",
        "A takeover has been up for 10 minutes.",
    ),
    (
        "still-there",
        "Still there?",
        "No voice and no input for 10 minutes. A quiet reminder.",
    ),
    (
        "program-unreported",
        "Cloud program not reporting",
        "A cloud room output stops reporting what viewers see and hear.",
    ),
    (
        "contribution-missing",
        "Not reaching the room",
        "Your microphone or camera stops reaching a cloud room.",
    ),
];

pub const ALERT_ME_AFTER: &str = "Alert me after";
pub const ALERT_ME_AFTER_DESCRIPTION: &str = "How long a muted microphone waits before the alert.";
/// `MIC_MUTED_AFTER_OPTIONS`: (seconds, label).
pub const MIC_MUTED_AFTER_OPTIONS: [(u32, &str); 4] =
    [(15, "15 s"), (30, "30 s"), (60, "1 min"), (120, "2 min")];
pub const SYSTEM_NOTIFICATIONS: &str = "System notifications";
pub const SYSTEM_NOTIFICATIONS_DESCRIPTION: &str =
    "When Videorc isn't the front window, or a critical alert stays open.";
pub const PHONE: &str = "Phone";
pub const PHONE_PREMIUM_REASON: &str = "Alerts on your phone come with Premium.";
pub const PHONE_LOCKED_DESCRIPTION: &str =
    "A push to your phone when something is wrong, from videorc.com/live.";
pub const SHOW_QR_CODE: &str = "Show QR code";
pub const HIDE_CODE: &str = "Hide code";
pub const COPY_LINK: &str = "Copy link";
pub const COPIED: &str = "Copied";
pub const QR_CODE_LABEL: &str = "Phone alerts QR code";
pub const AI_CHAT_READ: &str = "AI reads chat for problems";
pub const AI_CHAT_READ_DESCRIPTION: &str = "When the phrase list isn't sure, AI reads the last messages for a sound, picture or lag report. Sidekick never posts about it.";
/// `toastUserError`'s object when a save fails.
pub const SAVE_OBJECT: &str = "the watchdog settings";

/// `VIDEORC_WEB_LINKS.live` on the production origin.
pub const LIVE_URL: &str = "https://www.videorc.com/live";

/// `WatchdogSettings`. A field the backend left out reads as Electron shows
/// it: a switch off, no "Alert me after" option chosen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub checks: BTreeMap<String, CheckSettings>,
    pub mic_muted_after_seconds: Option<u32>,
    pub system_notifications: bool,
    pub phone_push: bool,
    pub ai_chat_read: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckSettings {
    pub enabled: bool,
}

impl Default for CheckSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl Settings {
    /// A check missing from the list is on.
    pub fn check_enabled(&self, id: &str) -> bool {
        self.checks.get(id).is_none_or(|check| check.enabled)
    }
}

/// `watchdog.phone.devices`: how many devices take alerts.
pub fn device_count(view: &Value) -> Option<usize> {
    view["devices"].as_array().map(Vec::len)
}

/// `WatchdogSettingsPatch`es, one per control.
pub fn check_patch(id: &str, enabled: bool) -> Value {
    json!({ "checks": { id: { "enabled": enabled } } })
}
pub fn mic_muted_after_patch(seconds: u32) -> Value {
    json!({ "micMutedAfterSeconds": seconds })
}
pub fn system_notifications_patch(on: bool) -> Value {
    json!({ "systemNotifications": on })
}
pub fn phone_push_patch(on: bool) -> Value {
    json!({ "phonePush": on })
}
pub fn ai_chat_read_patch(on: bool) -> Value {
    json!({ "aiChatRead": on })
}

/// The Phone row's description: what to do, how many devices, or the
/// locked line.
pub fn phone_description(premium: bool, devices: Option<usize>) -> String {
    if !premium {
        return PHONE_LOCKED_DESCRIPTION.to_string();
    }
    match devices {
        None => format!("Open {LIVE_URL} on your phone and tap Get alerts on this phone."),
        Some(0) => {
            format!("No phone yet. Open {LIVE_URL} on your phone and tap Get alerts on this phone.")
        }
        Some(1) => "Alerts reach 1 device.".to_string(),
        Some(count) => format!("Alerts reach {count} devices."),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRow {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub enabled: bool,
}

/// The section as the window draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionView {
    pub checks: Vec<CheckRow>,
    /// The selected "Alert me after" option, in seconds.
    pub mic_muted_after_seconds: Option<u32>,
    pub system_notifications: bool,
    /// The Premium lock above the phone rows ([`PHONE_PREMIUM_REASON`], View
    /// Premium).
    pub locked: bool,
    pub phone_push: bool,
    pub phone_description: String,
    /// The QR code and copy buttons (Premium only); the code when shown.
    pub phone_actions: bool,
    pub show_code: bool,
    pub show_code_label: &'static str,
    pub copy_label: &'static str,
    pub ai_chat_read: bool,
    /// The phone and AI switches only work with Premium.
    pub premium_switches_enabled: bool,
}

/// The section, or `None` before the backend answered (an older backend
/// never does, and the section stays away). `premium` is the cloud block's
/// `entitled || plan`.
pub fn section_view(
    settings: Option<&Settings>,
    premium: bool,
    devices: Option<usize>,
    show_code: bool,
    copied: bool,
) -> Option<SectionView> {
    let settings = settings?;
    Some(SectionView {
        checks: CHECK_ROWS
            .iter()
            .map(|(id, label, description)| CheckRow {
                id,
                label,
                description,
                enabled: settings.check_enabled(id),
            })
            .collect(),
        mic_muted_after_seconds: settings.mic_muted_after_seconds,
        system_notifications: settings.system_notifications,
        locked: !premium,
        phone_push: settings.phone_push,
        phone_description: phone_description(premium, devices),
        phone_actions: premium,
        show_code: premium && show_code,
        show_code_label: if show_code { HIDE_CODE } else { SHOW_QR_CODE },
        copy_label: if copied { COPIED } else { COPY_LINK },
        ai_chat_read: settings.ai_chat_read,
        premium_switches_enabled: premium,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_check_is_on_unless_turned_off() {
        let settings: Settings = serde_json::from_value(json!({
            "checks": { "mic-muted": { "enabled": false } },
            "micMutedAfterSeconds": 60,
            "systemNotifications": false,
        }))
        .unwrap();
        assert!(!settings.check_enabled("mic-muted"));
        assert!(settings.check_enabled("picture-black"));
        let view = section_view(Some(&settings), false, None, false, false).unwrap();
        assert_eq!(view.checks.len(), 15);
        assert_eq!(view.checks[0].label, "Microphone muted");
        assert!(!view.checks[0].enabled && view.checks[1].enabled);
        assert_eq!(view.mic_muted_after_seconds, Some(60));
        assert!(!view.system_notifications);
        assert!(section_view(None, true, None, false, false).is_none());
    }

    #[test]
    fn the_phone_is_premiums_and_says_how_many_devices_listen() {
        let settings = Settings::default();
        let locked = section_view(Some(&settings), false, Some(2), true, false).unwrap();
        assert!(locked.locked && !locked.phone_actions && !locked.show_code);
        assert!(!locked.premium_switches_enabled);
        assert_eq!(
            locked.phone_description,
            "A push to your phone when something is wrong, from videorc.com/live."
        );
        let premium = section_view(Some(&settings), true, Some(0), true, true).unwrap();
        assert!(premium.show_code && premium.phone_actions);
        assert_eq!(
            (premium.show_code_label, premium.copy_label),
            ("Hide code", "Copied")
        );
        assert_eq!(
            premium.phone_description,
            "No phone yet. Open https://www.videorc.com/live on your phone and tap Get alerts on this phone."
        );
        assert_eq!(phone_description(true, Some(1)), "Alerts reach 1 device.");
        assert_eq!(phone_description(true, Some(3)), "Alerts reach 3 devices.");
        assert_eq!(
            phone_description(true, None),
            "Open https://www.videorc.com/live on your phone and tap Get alerts on this phone."
        );
        assert_eq!(
            device_count(&json!({ "devices": [{ "id": "a" }, { "id": "b" }] })),
            Some(2)
        );
    }

    #[test]
    fn each_control_saves_its_own_patch() {
        assert_eq!(
            check_patch("brb-long", false),
            json!({ "checks": { "brb-long": { "enabled": false } } })
        );
        assert_eq!(
            mic_muted_after_patch(120),
            json!({ "micMutedAfterSeconds": 120 })
        );
        assert_eq!(phone_push_patch(true), json!({ "phonePush": true }));
        assert_eq!(ai_chat_read_patch(false), json!({ "aiChatRead": false }));
        assert_eq!(
            system_notifications_patch(true),
            json!({ "systemNotifications": true })
        );
    }
}
