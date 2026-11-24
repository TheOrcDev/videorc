//! The Settings page (plan 220 S3.11a): `components/tabs/settings-tab.tsx`,
//! `lib/settings-tabs.ts`, `components/settings/general-settings.tsx` (with
//! `seventv-emotes-field.tsx`, `usage-stats-field.tsx` and
//! `lib/seventv-status.ts`) and `permissions-settings.tsx` (with
//! `components/system-access-list.tsx`), as values the app shows.
//!
//! - **The tabs** ([`TABS`]): General, Permissions, Shortcuts, Remote and
//!   About in the strip, as Electron's; a tab the Rust app has not got yet
//!   ([`SettingsTab::ported`]) holds its place. The tab used last is this
//!   device's (`ui-local.json`'s `videorc.settingsTab`, P3-D5).
//! - **General** ([`general_view`]): Appearance (Theme, Retro LCD, the row to
//!   the Scene page's Animate scene changes), Chat (Chat in Studio, Open
//!   Stream Manager when you go live, 7TV emotes and Twitch GIFs from the
//!   backend's `liveChat.emotes` row), Setup (Run setup again…), Import
//!   (OBS, [`obs_import`]), Privacy (the backend's `usageStats`) and
//!   Elsewhere (the pages the other settings live on). Notifications has no
//!   section: idle news waits behind the bell, quiet or not (#1909).
//! - **Permissions** ([`permissions_view`]): the system access rows S2.6b
//!   computes, each with its chip, purpose, detail and one action; Change a
//!   permission; Linux's empty state.
//! - **Remote** ([`remote`]): Remote control and Phone remote; its Agents
//!   column is [`agents`].

pub mod about;
pub mod agents;
pub mod remote;

/// The events the page follows: the chat rows' backend row
/// (`liveChat.emotes`, as `useChatEmoteSettings` listens).
pub const SETTINGS_EVENTS: [&str; 1] = ["liveChat.emotes"];

use serde::Deserialize;

use crate::desktop::permissions::{MediaAccessSnapshot, PermissionPlatform, SystemPermissionPane};
use crate::desktop::system_access::{
    SystemAccessContext, SystemAccessInput, SystemAccessRowId, os_settings_name, row_action,
    system_access_action_label, system_access_rows, system_access_status,
    system_access_visible_detail,
};
use crate::nav::{PageId, ThemeChoice};
use videorc_protocol::Device;

/// A Settings tab (`SETTINGS_TABS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsTab {
    General,
    Permissions,
    Shortcuts,
    Remote,
    About,
}

/// The strip, in order.
pub const TABS: [SettingsTab; 5] = [
    SettingsTab::General,
    SettingsTab::Permissions,
    SettingsTab::Shortcuts,
    SettingsTab::Remote,
    SettingsTab::About,
];

/// The tabs the Rust app has (S3.11a: General and Permissions; S3.11c About
/// and Remote's Agents section, whose Remote control S3.11b adds; S3.11b
/// Shortcuts).
pub const PORTED_TABS: &[SettingsTab] = &[
    SettingsTab::General,
    SettingsTab::Permissions,
    SettingsTab::Remote,
    SettingsTab::About,
];

impl SettingsTab {
    pub fn id(self) -> &'static str {
        match self {
            SettingsTab::General => "general",
            SettingsTab::Permissions => "permissions",
            SettingsTab::Shortcuts => "shortcuts",
            SettingsTab::Remote => "remote",
            SettingsTab::About => "about",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SettingsTab::General => "General",
            SettingsTab::Permissions => "Permissions",
            SettingsTab::Shortcuts => "Shortcuts",
            SettingsTab::Remote => "Remote",
            SettingsTab::About => "About",
        }
    }

    /// The tab with this id (a retired one as the tab that replaced it).
    pub fn parse(id: &str) -> Option<SettingsTab> {
        let id = crate::nav::sub_tabs::migrate_settings_tab_id(id)?;
        TABS.into_iter().find(|tab| tab.id() == id)
    }

    pub fn index(self) -> usize {
        TABS.iter().position(|tab| *tab == self).unwrap_or(0)
    }

    pub fn ported(self) -> bool {
        PORTED_TABS.contains(&self)
    }
}

/// The page's words (the components' JSX).
pub mod copy {
    pub const TABS_LABEL: &str = "Settings sections";

    pub const APPEARANCE: &str = "Appearance";
    pub const APPEARANCE_DESCRIPTION: &str = "How Videorc looks on this device.";
    pub const THEME: &str = "Theme";
    pub const THEME_LIGHT: &str = "Light";
    pub const THEME_DARK: &str = "Dark";
    pub const THEME_SYSTEM: &str = "System";
    pub const RETRO_LCD: &str = "Retro LCD";
    pub const RETRO_LCD_DESCRIPTION: &str =
        "Draws the Studio's controls on LCD screens, like a hardware recorder.";
    pub const ANIMATE_SCENE_CHANGES: &str = "Animate scene changes";

    pub const CHAT: &str = "Chat";
    pub const CHAT_DESCRIPTION: &str =
        "Your livestream's chat, in the Studio and in the Stream Manager.";
    pub const CHAT_IN_STUDIO: &str = "Chat in Studio";
    pub const CHAT_IN_STUDIO_DESCRIPTION: &str = "While you're on air, the Studio shows your chat under Session. Click a message to show it on stream.";
    pub const OPEN_STREAM_MANAGER: &str = "Open Stream Manager when you go live";
    pub const OPEN_STREAM_MANAGER_DESCRIPTION: &str =
        "Chat, viewers, followers and activity for the whole stream, in their own window.";
    pub const SEVEN_TV: &str = "Show 7TV emotes in chat";
    pub const SEVEN_TV_DESCRIPTION: &str =
        "Your channel's 7TV emotes, in Twitch, Kick and YouTube chat.";
    pub const TWITCH_GIFS: &str = "GIFs in Twitch chat";
    pub const TWITCH_GIFS_DESCRIPTION: &str = "GIFs Tier 2 and Tier 3 subscribers send from Twitch's GIF Keyboard. Still shows one frame; Off keeps the GIF's title only.";
    pub const GIF_ANIMATED: &str = "Animated";
    pub const GIF_STILL: &str = "Still";
    pub const GIF_OFF: &str = "Off";
    pub const CHAT_READ_FAILED: &str =
        "Couldn't read the chat settings. Reopen Settings to try again.";
    pub const CHAT_SAVE_FAILED: &str = "Couldn't save the chat settings. Try again.";

    pub const SETUP: &str = "Setup";
    pub const SETUP_DESCRIPTION: &str = "The steps from the first time Videorc opened.";
    pub const FIRST_RUN_SETUP: &str = "First-run setup";
    pub const RUN_SETUP_AGAIN: &str = "Run setup again…";
    /// `FIRST_RUN_REPLAY_LOCKED_REASON`.
    pub const REPLAY_LOCKED: &str = "Finish your recording or livestream first.";

    pub const IMPORT: &str = "Import";
    pub const IMPORT_DESCRIPTION: &str =
        "Coming from OBS Studio? Bring your scenes and settings across.";
    pub const OBS_STUDIO: &str = "OBS Studio";
    pub const OBS_DESCRIPTION: &str =
        "You see what comes across, and what doesn't, before anything changes.";
    pub const IMPORT_FROM_OBS: &str = "Import from OBS…";

    pub const PRIVACY: &str = "Privacy";
    pub const PRIVACY_DESCRIPTION: &str = "What Videorc shares about how you use it.";
    pub const USAGE_STATS: &str = "Share anonymous usage stats";
    /// `USAGE_STATS_DESCRIPTION`.
    pub const USAGE_STATS_DESCRIPTION: &str = "When a recording or livestream starts and stops, Videorc sends a random ID for this install, how long it ran and which platforms you streamed to, so we can count how many people stream each week. Never stream keys, titles, chat or anything you record. If you're signed in, it's linked to your account.";
    pub const USAGE_STATS_ENV: &str =
        "Turned off when Videorc started. Reopen Videorc to change it.";
    pub const USAGE_READ_FAILED: &str =
        "Couldn't read the privacy settings. Reopen Settings to try again.";
    pub const USAGE_SAVE_FAILED: &str = "Couldn't save the privacy settings. Try again.";

    pub const ELSEWHERE: &str = "Elsewhere";
    pub const ELSEWHERE_DESCRIPTION: &str = "Settings that live with the page they change.";
    pub const ELSEWHERE_LABEL: &str = "Settings on other pages";
    pub const ACCOUNT_AND_PREMIUM: &str = "Account and Premium";
    pub const SIGN_IN: &str = "Sign in";
    pub const SIDEKICK_ROW: &str = "Sidekick, chat posting and Clean cut";
    pub const AVATAR_ROW: &str = "Your avatar, its look and greetings";
    pub const OUTPUT_ROW: &str = "Recording quality and files";
    pub const LIVESTREAM_ROW: &str = "Destinations and stream details";
    pub const HEALTH_ROW: &str = "Checks and the support bundle";

    pub const SYSTEM_ACCESS: &str = "System access";
    pub const REFRESH: &str = "Refresh";
    pub const CHANGE_A_PERMISSION: &str = "Change a permission";
    pub const CHECKING_PERMISSION: &str = "Checking permission…";
    pub const NOTHING_TO_GRANT: &str = "Nothing to grant here";
    pub const NOTHING_TO_GRANT_DESCRIPTION: &str = "Linux keeps no capture permissions for apps. Your desktop may ask when Videorc starts capturing the screen.";

    /// `System follows your ${deviceNoun}'s light or dark appearance.`
    pub fn theme_description(device_noun: &str) -> String {
        format!("System follows your {device_noun}'s light or dark appearance.")
    }

    /// `What ${settingsName} lets Videorc capture right now.`
    pub fn system_access_description(settings_name: &str) -> String {
        format!("What {settings_name} lets Videorc capture right now.")
    }

    /// `Grants live in ${settingsName}. Come back here after changing one: …`
    pub fn change_description(settings_name: &str) -> String {
        format!(
            "Grants live in {settings_name}. Come back here after changing one: the rows update on their own."
        )
    }

    /// `Open ${settingsName}…`
    pub fn open_settings(settings_name: &str) -> String {
        format!("Open {settings_name}…")
    }

    /// The row's button's name: `${row.label}: ${actionLabel}`.
    pub fn row_action_name(label: &str, action: &str) -> String {
        format!("{label}: {action}")
    }
}

/// `TwitchGifMode`, in `TWITCH_GIF_MODE_OPTIONS`' order.
pub const GIF_MODES: [(&str, &str); 3] = [
    ("animated", copy::GIF_ANIMATED),
    ("still", copy::GIF_STILL),
    ("off", copy::GIF_OFF),
];

/// `SevenTvStatus`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SevenTvStatus {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub emote_count: Option<u64>,
    #[serde(default)]
    pub set_name: Option<String>,
}

/// `ChatEmotesSettings` (`liveChat.emotes.get`, `.set` and the
/// `liveChat.emotes` event).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEmotes {
    #[serde(default)]
    pub seven_tv: bool,
    #[serde(default)]
    pub seven_tv_status: SevenTvStatus,
    #[serde(default)]
    pub twitch_gifs: Option<String>,
}

/// `UsageStatsState` (`usageStats.get` and `.set`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub env_disabled: bool,
}

/// `plural(count, 'emote')`.
fn plural_emotes(count: u64) -> String {
    crate::format::plural(i64::try_from(count).unwrap_or(i64::MAX), "emote", None)
}

/// `sevenTvStatusLine`: the line under the 7TV row; `None` while off.
pub fn seven_tv_status_line(status: &SevenTvStatus) -> Option<String> {
    match status.state.as_str() {
        "idle" => Some("Loads when you go live.".to_string()),
        "loading" => Some("Loading your 7TV emotes…".to_string()),
        "linked" => {
            let emotes = plural_emotes(status.emote_count.unwrap_or(0));
            Some(match &status.set_name {
                Some(name) if !name.is_empty() => format!("“{name}” · {emotes}"),
                _ => emotes,
            })
        }
        "notLinked" => {
            Some("No 7TV account is linked to your Twitch, Kick or YouTube channel.".to_string())
        }
        "error" => Some("7TV couldn't be reached. Chat works without its emotes.".to_string()),
        _ => None,
    }
}

/// `firstRunReplayDescription`: setup starts with the permissions except
/// on Linux, which has none.
pub fn first_run_replay_description(platform: &str) -> &'static str {
    if platform == "linux" {
        "Go through the welcome steps again."
    } else {
        "Go through the welcome steps again, starting with permissions."
    }
}

/// A backend row the page reads (the chat rows, Privacy): `None` until it
/// answered, and the one failure the rows wait under.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Loaded<T> {
    pub value: Option<T>,
    pub error: Option<&'static str>,
}

/// What General is built from.
pub struct GeneralInput<'a> {
    /// `runtimeInfo.platform`: darwin, win32 or linux.
    pub platform: &'a str,
    pub theme: ThemeChoice,
    pub retro_lcd: bool,
    pub studio_chat: bool,
    pub open_stream_manager_on_live: bool,
    /// `runtimeInfo.commentsWindowEnabled !== false`.
    pub stream_manager_enabled: bool,
    pub chat: &'a Loaded<ChatEmotes>,
    pub usage: &'a Loaded<UsageStats>,
    /// `firstRunReplayLocked`: a recording or livestream starts, runs or
    /// stops (the Clips ring alone is no session).
    pub session_active: bool,
    /// The first-run setup is in this build (S3.12a).
    pub first_run_ported: bool,
    /// The signed-in account's name, `None` signed out.
    pub account_name: Option<String>,
}

/// One row of Elsewhere.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElsewhereRow {
    /// `account`, or the page's id.
    pub id: &'static str,
    pub label: &'static str,
    pub value: String,
    /// The page (or the account door) is in this build.
    pub enabled: bool,
}

/// General, as one value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneralView {
    pub theme_index: usize,
    pub theme_description: String,
    pub retro_lcd: bool,
    pub scene_ported: bool,
    pub studio_chat: bool,
    pub stream_manager_row: bool,
    pub open_stream_manager_on_live: bool,
    pub chat_error: Option<&'static str>,
    /// The chat rows wait for the backend's row.
    pub chat_loaded: bool,
    pub seven_tv: bool,
    pub seven_tv_line: Option<String>,
    pub gif_index: usize,
    pub setup_description: &'static str,
    /// Why Run setup again… is held, `None` when it runs.
    pub setup_held: Option<&'static str>,
    pub usage_error: Option<&'static str>,
    pub usage_loaded: bool,
    pub usage_enabled: bool,
    pub usage_env_disabled: bool,
    pub elsewhere: Vec<ElsewhereRow>,
}

/// The shell's word for what this build has not got yet.
pub const NOT_IN_THIS_BUILD: &str = "Not in this build yet.";

/// General's view.
pub fn general_view(input: &GeneralInput<'_>) -> GeneralView {
    let chat = input.chat.value.as_ref();
    let mode = chat
        .and_then(|chat| chat.twitch_gifs.as_deref())
        .unwrap_or("animated");
    let device_noun = crate::format::device_noun(input.platform);
    let page_row = |page: PageId, label: &'static str| ElsewhereRow {
        id: page.id(),
        label,
        value: page.label().to_string(),
        enabled: page.ported(),
    };
    GeneralView {
        theme_index: match input.theme {
            ThemeChoice::Light => 0,
            ThemeChoice::Dark => 1,
            ThemeChoice::System => 2,
        },
        theme_description: copy::theme_description(device_noun),
        retro_lcd: input.retro_lcd,
        scene_ported: PageId::Layouts.ported(),
        studio_chat: input.studio_chat,
        stream_manager_row: input.stream_manager_enabled,
        open_stream_manager_on_live: input.open_stream_manager_on_live,
        chat_error: input.chat.error,
        chat_loaded: chat.is_some(),
        seven_tv: chat.is_some_and(|chat| chat.seven_tv),
        // The failure stands ahead of the rows; the status line steps aside.
        seven_tv_line: if input.chat.error.is_none() {
            chat.and_then(|chat| seven_tv_status_line(&chat.seven_tv_status))
        } else {
            None
        },
        gif_index: GIF_MODES
            .iter()
            .position(|(id, _)| *id == mode)
            .unwrap_or(0),
        setup_description: first_run_replay_description(input.platform),
        setup_held: if input.session_active {
            Some(copy::REPLAY_LOCKED)
        } else if !input.first_run_ported {
            Some(NOT_IN_THIS_BUILD)
        } else {
            None
        },
        usage_error: input.usage.error,
        usage_loaded: input.usage.value.is_some(),
        usage_enabled: input.usage.value.is_some_and(|usage| usage.enabled),
        usage_env_disabled: input.usage.value.is_some_and(|usage| usage.env_disabled),
        elsewhere: vec![
            ElsewhereRow {
                id: "account",
                label: copy::ACCOUNT_AND_PREMIUM,
                value: input
                    .account_name
                    .clone()
                    .unwrap_or_else(|| copy::SIGN_IN.to_string()),
                enabled: true,
            },
            page_row(PageId::Ai, copy::SIDEKICK_ROW),
            page_row(PageId::Avatar, copy::AVATAR_ROW),
            page_row(PageId::Recording, copy::OUTPUT_ROW),
            page_row(PageId::Live, copy::LIVESTREAM_ROW),
            page_row(PageId::Diagnostics, copy::HEALTH_ROW),
        ],
    }
}

/// What Permissions is built from.
pub struct PermissionsInput<'a> {
    pub platform: &'a str,
    pub os_release: Option<&'a str>,
    pub devices: &'a [Device],
    pub media_access: Option<&'a MediaAccessSnapshot>,
    pub pending_pane: Option<SystemPermissionPane>,
}

/// One system access row (`SystemAccessList`'s row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessRowView {
    pub id: SystemAccessRowId,
    /// The pane its action runs for, `None` for System audio (which rides
    /// the screen's).
    pub pane: Option<SystemPermissionPane>,
    pub label: &'static str,
    pub status: &'static str,
    pub tone: &'static str,
    pub spinning: bool,
    pub purpose: &'static str,
    pub detail: Option<String>,
    pub action_label: Option<String>,
    pub action_name: Option<String>,
}

/// Permissions, as one value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionsView {
    pub description: String,
    pub rows: Vec<AccessRowView>,
    pub change_description: String,
    pub open_settings: String,
}

fn permission_platform(platform: &str) -> PermissionPlatform {
    match platform {
        "darwin" => PermissionPlatform::MacOs,
        "win32" => PermissionPlatform::Windows,
        _ => PermissionPlatform::Other,
    }
}

/// Permissions' view: the rows S2.6b computes, as the list shows them.
pub fn permissions_view(input: &PermissionsInput<'_>) -> PermissionsView {
    let platform = permission_platform(input.platform);
    let settings_name = os_settings_name(platform);
    let rows = system_access_rows(&SystemAccessInput {
        devices: input.devices,
        audio_meter: None,
        platform,
        os_release: input.os_release,
        permission_target_name: "Videorc",
        media_access: input.media_access,
        context: SystemAccessContext {
            pending_pane: input.pending_pane,
            ..SystemAccessContext::default()
        },
    });
    let rows = rows
        .iter()
        .map(|row| {
            let (status, tone) = system_access_status(row.state);
            let action = row_action(row, platform, input.media_access);
            let action_label = system_access_action_label(action, platform);
            let pane = (row.id != SystemAccessRowId::SystemAudio).then(|| row.id.pane());
            let action_label = action_label.filter(|_| pane.is_some());
            AccessRowView {
                id: row.id,
                pane,
                label: row.label,
                status,
                tone,
                spinning: row.checking
                    || row.state == crate::desktop::system_access::SystemAccessState::Waiting,
                purpose: row.purpose,
                detail: system_access_visible_detail(row).map(str::to_string),
                action_name: action_label
                    .as_ref()
                    .map(|label| copy::row_action_name(row.label, label)),
                action_label,
            }
        })
        .collect();
    PermissionsView {
        description: copy::system_access_description(settings_name),
        rows,
        change_description: copy::change_description(settings_name),
        open_settings: copy::open_settings(settings_name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::permissions::MediaAccessStatus;
    use serde_json::json;
    use videorc_protocol::DeviceKind;

    fn chat(value: serde_json::Value) -> Loaded<ChatEmotes> {
        Loaded {
            value: Some(serde_json::from_value(value).unwrap()),
            error: None,
        }
    }

    fn input<'a>(chat: &'a Loaded<ChatEmotes>, usage: &'a Loaded<UsageStats>) -> GeneralInput<'a> {
        GeneralInput {
            platform: "darwin",
            theme: ThemeChoice::Dark,
            retro_lcd: false,
            studio_chat: true,
            open_stream_manager_on_live: false,
            stream_manager_enabled: true,
            chat,
            usage,
            session_active: false,
            first_run_ported: false,
            account_name: None,
        }
    }

    #[test]
    fn the_tabs_keep_electrons_order_ids_and_retired_ids() {
        let labels: Vec<&str> = TABS.iter().map(|tab| tab.label()).collect();
        assert_eq!(
            labels,
            ["General", "Permissions", "Shortcuts", "Remote", "About"]
        );
        assert_eq!(SettingsTab::parse("recording"), Some(SettingsTab::General));
        assert_eq!(SettingsTab::parse("remote"), Some(SettingsTab::Remote));
        assert_eq!(SettingsTab::parse("buddy"), None);
        assert!(SettingsTab::General.ported() && SettingsTab::Permissions.ported());
        assert!(SettingsTab::About.ported() && SettingsTab::Remote.ported());
        assert!(!SettingsTab::Shortcuts.ported());
        let ids: Vec<&str> = TABS.iter().map(|tab| tab.id()).collect();
        assert_eq!(ids, crate::nav::sub_tabs::SETTINGS_TABS);
    }

    #[test]
    fn the_7tv_line_reads_each_state() {
        let status =
            |value: serde_json::Value| -> SevenTvStatus { serde_json::from_value(value).unwrap() };
        assert_eq!(seven_tv_status_line(&status(json!({"state": "off"}))), None);
        assert_eq!(
            seven_tv_status_line(&status(json!({"state": "idle"}))).as_deref(),
            Some("Loads when you go live.")
        );
        assert_eq!(
            seven_tv_status_line(&status(
                json!({"state": "linked", "emoteCount": 1, "setName": "Orc"})
            ))
            .as_deref(),
            Some("“Orc” · 1 emote")
        );
        assert_eq!(
            seven_tv_status_line(&status(json!({"state": "linked", "emoteCount": 42}))).as_deref(),
            Some("42 emotes")
        );
        assert!(
            seven_tv_status_line(&status(json!({"state": "notLinked"})))
                .unwrap()
                .starts_with("No 7TV account")
        );
    }

    #[test]
    fn general_waits_for_its_rows_and_says_why_once() {
        let waiting = Loaded::default();
        let usage = Loaded::default();
        let view = general_view(&input(&waiting, &usage));
        assert!(!view.chat_loaded && !view.usage_loaded);
        assert_eq!(view.theme_index, 1);
        assert_eq!(
            view.theme_description,
            "System follows your Mac's light or dark appearance."
        );
        assert_eq!(view.setup_held, Some(NOT_IN_THIS_BUILD));
        assert_eq!(
            view.setup_description,
            "Go through the welcome steps again, starting with permissions."
        );

        let loaded = chat(
            json!({"sevenTv": true, "sevenTvStatus": {"state": "idle"}, "twitchGifs": "still"}),
        );
        let usage = Loaded {
            value: Some(UsageStats {
                enabled: false,
                env_disabled: true,
            }),
            error: None,
        };
        let mut live = input(&loaded, &usage);
        live.session_active = true;
        live.first_run_ported = true;
        let view = general_view(&live);
        assert!(view.seven_tv);
        assert_eq!(
            view.seven_tv_line.as_deref(),
            Some("Loads when you go live.")
        );
        assert_eq!(view.gif_index, 1);
        assert_eq!(view.setup_held, Some(copy::REPLAY_LOCKED));
        assert!(view.usage_env_disabled);

        let failed = Loaded {
            value: loaded.value.clone(),
            error: Some(copy::CHAT_SAVE_FAILED),
        };
        let view = general_view(&input(&failed, &usage));
        assert_eq!(view.chat_error, Some(copy::CHAT_SAVE_FAILED));
        assert_eq!(view.seven_tv_line, None, "the failure steps the line aside");
    }

    #[test]
    fn elsewhere_names_the_pages_and_the_account() {
        let chat = Loaded::default();
        let usage = Loaded::default();
        let mut signed_in = input(&chat, &usage);
        signed_in.account_name = Some("Orc Dev".into());
        let rows: Vec<(String, String)> = general_view(&signed_in)
            .elsewhere
            .into_iter()
            .map(|row| (row.label.to_string(), row.value))
            .collect();
        assert_eq!(
            rows,
            [
                ("Account and Premium".into(), "Orc Dev".into()),
                (
                    "Sidekick, chat posting and Clean cut".into(),
                    "Sidekick".into()
                ),
                (
                    "Your avatar, its look and greetings".into(),
                    "Avatar".into()
                ),
                ("Recording quality and files".into(), "Output".into()),
                (
                    "Destinations and stream details".into(),
                    "Destinations".into()
                ),
                ("Checks and the support bundle".into(), "Health".into()),
            ]
        );
    }

    #[test]
    fn permissions_lists_each_row_with_its_one_action() {
        let screen: Device = serde_json::from_value(json!({
            "id": "screen:1", "name": "Display", "kind": "screen", "status": "available"
        }))
        .unwrap();
        let media = MediaAccessSnapshot {
            camera: MediaAccessStatus::Granted,
            microphone: MediaAccessStatus::Denied,
            screen: MediaAccessStatus::Granted,
        };
        let view = permissions_view(&PermissionsInput {
            platform: "darwin",
            os_release: Some("25.0.0"),
            devices: &[screen],
            media_access: Some(&media),
            pending_pane: None,
        });
        assert_eq!(
            view.description,
            "What System Settings lets Videorc capture right now."
        );
        assert_eq!(view.open_settings, "Open System Settings…");
        let microphone = view
            .rows
            .iter()
            .find(|row| row.id == SystemAccessRowId::Microphone)
            .unwrap();
        assert_eq!(microphone.status, "Not granted");
        assert_eq!(
            microphone.action_name.as_deref(),
            Some("Microphone: Open System Settings…")
        );
        let system = view
            .rows
            .iter()
            .find(|row| row.id == SystemAccessRowId::SystemAudio)
            .unwrap();
        assert_eq!(system.pane, None);
        assert_eq!(system.action_label, None, "System audio rides the screen's");
        let _ = DeviceKind::Screen;

        let linux = permissions_view(&PermissionsInput {
            platform: "linux",
            os_release: None,
            devices: &[],
            media_access: None,
            pending_pane: None,
        });
        assert!(linux.rows.is_empty());
    }
}
