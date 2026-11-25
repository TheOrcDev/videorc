//! Sidekick → Voice (`BuddyVoiceCommands`).

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::livestream::PlatformsState;
use videorc_app_core::livestream::accounts::{
    AccountStatus, KICK_MODERATION_SCOPE, PlatformAccount, TWITCH_MODERATION_SCOPE,
    YOUTUBE_FORCE_SSL_SCOPE, platform_label,
};
use videorc_app_core::stream_manager::buddy::{self as sm_buddy, CohostSettingsView};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::chat_platform::ChatPlatform;
use videorc_kit::icon::icon;
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::segmented_control::{Segment, SegmentedControl};
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

use super::live::{LiveView, UnlockAction};
use super::{SaveSection, SidekickScreen};

const COMMANDS: &str = "Commands";
const WHAT_YOU_CAN_SAY: &str = "What you can say";
const REMOVE_MESSAGES: &str = "Remove messages";
const BEFORE_REMOVE: &str = "Before Sidekick removes a comment";
const WAKE_WORD_LABEL: &str = "Commands need “Sidekick” first";
const WAKE_WORD_DESCRIPTION: &str = "Off: “remove it from our chat” and “highlight the comment from coders X” also work without the name.";
const BUDDY_WAKE_WORDS_LINE: &str = "Start with “Sidekick”.";
const BUDDY_VOICE_COMMANDS_DESCRIPTION: &str =
    "Ask Sidekick to put a comment on stream, take it down, or remove it from chat.";
const BUDDY_VOICE_COMMANDS_OFF: &str = "Turn on Sidekick Live to use voice commands.";
const BUDDY_REMOVAL_FALLBACK: &str = "If the platform can't remove it, Sidekick hides it in Videorc and tells you viewers may still see it.";
const BUDDY_VOICE_PREMIUM: &str = "Voice commands are part of Videorc Premium. Remove from chat, in a comment's menu, is free for everyone.";
const BUDDY_REMOVE_MESSAGES_NO_ACCOUNT: &str =
    "Connect YouTube, Twitch, Kick or X in Destinations to remove their chat messages.";
const YOUTUBE_ALWAYS_CONFIRMS: &str = "YouTube always asks you to confirm.";
const GO_TO_OVERVIEW: &str = "Go to Overview";
const CONFIRM_FIRST: &str = "Confirm first";
const COUNTDOWN: &str = "5-second countdown";
const CONFIRM_DESC: &str = "A card asks first. Say “yes” or press Enter.";
const COUNTDOWN_DESC: &str = "Removes after 5 seconds unless you say “no” or press Esc.";
const LIMITS_CONFIRM: &str = "A removal waits 20 seconds for your answer, then nothing is removed. At most 10 removals a minute.";
const LIMITS_COUNTDOWN: &str = "A removal runs after 5 seconds unless you cancel; on YouTube it waits 20 seconds for your answer. At most 10 removals a minute.";

const VOICE_COMMANDS: &[(&str, &str, &[&str])] = &[
    (
        "Highlight",
        "Puts it on stream.",
        &[
            "Sidekick, highlight the comment from coders X",
            "Sidekick, put this one up",
            "Sidekick, show the last comment",
            "Sidekick, show coders X's question",
        ],
    ),
    (
        "Clear",
        "Takes it off stream.",
        &[
            "Sidekick, take it down",
            "Sidekick, clear the highlight",
            "Sidekick, remove it from the screen",
        ],
    ),
    (
        "Remove",
        "Shows it first. Removes it when you confirm.",
        &[
            "This one is toxic. Remove it from our chat.",
            "Sidekick, delete the comment from coders X",
        ],
    ),
    (
        "Answer",
        "Confirms or stops a removal.",
        &["Yes", "Do it", "Remove it", "No", "Cancel", "Never mind"],
    ),
    (
        "Banners",
        "Shows or hides your banners by name.",
        &[
            "Sidekick, show the sponsor banner",
            "Sidekick, take the sponsor banner down",
            "Sidekick, hide the banners",
        ],
    ),
    (
        "On stream",
        "Puts your avatar on the stream, or takes it off.",
        &[
            "Sidekick, show up",
            "Sidekick, come on screen",
            "Sidekick, hide",
            "Sidekick, go away",
        ],
    ),
    (
        "Marker",
        "Marks this moment in your recording, under the title you say.",
        &[
            "Sidekick, make a marker here for the Q&A",
            "Sidekick, add a marker called Q&A",
            "Sidekick, mark this as Q&A",
        ],
    ),
];

const REMOVE_MESSAGES_READY: &str = "Ready";
const REMOVE_MESSAGES_NEEDS_ACCESS: &str = "Needs access";

/// One "Remove messages" row (`RemoveMessagesRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoveMessagesRow {
    pub platform: &'static str,
    pub label: &'static str,
    pub account_label: Option<String>,
    pub ready: bool,
    /// The fix as a sentence: the button's name and tooltip.
    pub message: String,
    /// "Reconnect" or "Authorize X Live"; None when ready.
    pub action: Option<&'static str>,
}

/// `removeMessagesReadiness(platform, account) === 'ready'`.
fn removes_messages(platform: &str, account: &PlatformAccount, x_live_authorized: bool) -> bool {
    let connected = account.status == AccountStatus::Connected;
    let holds = |scope: &str| connected && account.scopes.iter().any(|held| held == scope);
    match platform {
        "youtube" => holds(YOUTUBE_FORCE_SSL_SCOPE),
        "twitch" => holds(TWITCH_MODERATION_SCOPE),
        "kick" => holds(KICK_MODERATION_SCOPE),
        "x" => connected && x_live_authorized,
        _ => false,
    }
}

/// `removeMessagesRows`: each connected platform that can remove a chat
/// message, in the Destinations order, ready or with its one fix.
pub fn remove_messages_rows(platforms: &PlatformsState) -> Vec<RemoveMessagesRow> {
    let x_live_authorized = platforms
        .x_capability
        .as_ref()
        .is_some_and(|capability| capability.native_available);
    ["youtube", "twitch", "kick", "x"]
        .into_iter()
        .filter_map(|platform| {
            let account = platforms
                .accounts
                .iter()
                .find(|account| account.platform == platform)?;
            let label = platform_label(platform);
            let ready = removes_messages(platform, account, x_live_authorized);
            let account_label = Some(account.account_label.trim().to_string())
                .filter(|account_label| !account_label.is_empty());
            let (message, action) = if ready {
                (REMOVE_MESSAGES_READY.to_string(), None)
            } else if platform == "x" {
                (
                    "Authorize X Live to let Sidekick remove messages.".to_string(),
                    Some("Authorize X Live"),
                )
            } else {
                (
                    format!("Reconnect {label} to let Sidekick remove messages."),
                    Some("Reconnect"),
                )
            };
            Some(RemoveMessagesRow {
                platform,
                label,
                account_label,
                ready,
                message,
                action,
            })
        })
        .collect()
}

fn chat_platform(platform: &str) -> ChatPlatform {
    match platform {
        "youtube" => ChatPlatform::Youtube,
        "twitch" => ChatPlatform::Twitch,
        "kick" => ChatPlatform::Kick,
        _ => ChatPlatform::X,
    }
}

fn phrases_label(phrases: &[&str]) -> String {
    phrases
        .iter()
        .map(|phrase| format!("“{phrase}”"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn commands_description() -> String {
    format!(
        "{BUDDY_WAKE_WORDS_LINE} {BUDDY_VOICE_COMMANDS_DESCRIPTION} {}",
        sm_buddy::acts_on_ask_copy()
    )
}

pub fn render_voice(
    view: &LiveView,
    settings: Option<&CohostSettingsView>,
    paused: &[&'static str],
    rows: &[RemoveMessagesRow],
    window: &mut Window,
    cx: &mut Context<SidekickScreen>,
) -> AnyElement {
    let theme = theme::resolve(None, window, cx);
    let muted = hsla(theme.muted_foreground);
    let locked = view.unlock.is_some();
    let enabled = settings.map(|s| s.enabled).unwrap_or(false);
    let off = !locked && !enabled;
    let entity = cx.entity();

    let wake = settings
        .and_then(|s| s.raw.get("wakeWordRequired"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let remove_confirm = settings
        .and_then(|s| s.raw.get("removeConfirm"))
        .and_then(|v| v.as_str())
        .unwrap_or("confirm");
    let remove_desc = if remove_confirm == "countdown" {
        format!("{COUNTDOWN_DESC} {YOUTUBE_ALWAYS_CONFIRMS}")
    } else {
        format!("{CONFIRM_DESC} {YOUTUBE_ALWAYS_CONFIRMS}")
    };
    let limits = if remove_confirm == "countdown" {
        LIMITS_COUNTDOWN
    } else {
        LIMITS_CONFIRM
    };

    let mut lead = div().flex().flex_col().gap(px(8.)).p(px(size::GUTTER));
    if let Some(unlock) = view.unlock.as_ref() {
        let mut alert = Alert::new("sidekick-voice-unlock")
            .variant(AlertVariant::Warning)
            .title(unlock.reason.clone());
        if let Some(action) = unlock.action {
            let label = match action {
                UnlockAction::SignIn => words::SIGN_IN,
                UnlockAction::ViewPremium => words::VIEW_PREMIUM,
            };
            alert = alert.action(
                Button::new("voice-unlock-action")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(label)
                    .on_click(move |_, _, cx| match action {
                        UnlockAction::SignIn => {
                            eprintln!("[videorc-app] Sidekick Voice: Sign in (account UI next)")
                        }
                        UnlockAction::ViewPremium => cx.open_url("https://videorc.com/premium"),
                    }),
            );
        }
        lead = lead.child(alert);
    }
    if off {
        let entity = entity.clone();
        lead = lead.child(
            Alert::new("sidekick-voice-off")
                .variant(AlertVariant::Quiet)
                .title(BUDDY_VOICE_COMMANDS_OFF)
                .action(
                    Button::new("voice-go-overview")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(GO_TO_OVERVIEW)
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |screen, cx| screen.select_tab(0, cx));
                        }),
                ),
        );
    }
    for (index, line) in paused.iter().enumerate() {
        lead = lead.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .type_scale(text::META)
                .text_color(muted)
                .child(StatusDot::new(("voice-paused", index)).tone(StatusTone::Warn))
                .child(*line),
        );
    }

    let mut command_list = GroupedList::new().label(WHAT_YOU_CAN_SAY);
    for (title, result, _) in VOICE_COMMANDS {
        command_list = command_list.row(
            ListRow::new(format!("voice-cmd-{title}"), *title)
                .compact(true)
                .context(*result),
        );
    }
    let mut phrases = div().flex().flex_col().gap(px(8.)).pt(px(4.));
    for (title, _, list) in VOICE_COMMANDS {
        phrases = phrases.child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .type_scale(text::META)
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(*title),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(phrases_label(list)),
                ),
        );
    }

    let commands = PanelSection::new("sidekick-voice-commands")
        .title(COMMANDS)
        .description(commands_description())
        .child(command_list)
        .child(phrases)
        .child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("wake-word", WAKE_WORD_LABEL)
                        .description(WAKE_WORD_DESCRIPTION)
                        .child(
                            Switch::new("wake-word")
                                .accessibility_label(WAKE_WORD_LABEL)
                                .checked(wake)
                                .disabled(locked)
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        entity.update(cx, |screen, cx| {
                                            screen.patch_section(
                                                serde_json::json!({ "wakeWordRequired": value }),
                                                SaveSection::Voice,
                                                cx,
                                            );
                                        });
                                    }
                                }),
                        ),
                )
                .row(
                    SettingsRow::new("remove-confirm", BEFORE_REMOVE)
                        .description(remove_desc)
                        .child(
                            SegmentedControl::new("remove-confirm")
                                .small(true)
                                .accessibility_label(BEFORE_REMOVE)
                                .value(Some(remove_confirm))
                                .disabled(locked)
                                .option(Segment::new("confirm", CONFIRM_FIRST))
                                .option(Segment::new("countdown", COUNTDOWN))
                                .on_change({
                                    let entity = entity.clone();
                                    move |value, _, cx| {
                                        let mode = value.to_string();
                                        entity.update(cx, |screen, cx| {
                                            screen.patch_section(
                                                serde_json::json!({ "removeConfirm": mode }),
                                                SaveSection::Voice,
                                                cx,
                                            );
                                        });
                                    }
                                }),
                        ),
                ),
        );

    let mut platform_rows = GroupedList::new().label(REMOVE_MESSAGES);
    if rows.is_empty() {
        platform_rows = platform_rows.row(
            ListRow::new("remove-messages-empty", BUDDY_REMOVE_MESSAGES_NO_ACCOUNT).compact(true),
        );
    }
    for row in rows {
        let mark = chat_platform(row.platform);
        let status = if row.ready {
            REMOVE_MESSAGES_READY
        } else {
            REMOVE_MESSAGES_NEEDS_ACCESS
        };
        let mut list_row = ListRow::new(format!("remove-messages-{}", row.platform), row.label)
            .compact(true)
            .icon(icon(mark.icon(), 14., mark.tint_hsla(theme)))
            .status_icon(
                StatusDot::new(format!("remove-messages-status-{}", row.platform))
                    .tone(if row.ready {
                        StatusTone::Good
                    } else {
                        StatusTone::Warn
                    })
                    .label(status),
            );
        if let Some(account) = row.account_label.as_ref() {
            list_row = list_row.context(account.clone());
        }
        if let Some(action) = row.action {
            let platform = row.platform;
            list_row = list_row.child(
                Button::new(format!("remove-messages-fix-{platform}"))
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(action)
                    .accessibility_label(row.message.clone())
                    .tooltip(row.message.clone())
                    .on_click(move |_, _, _| {
                        // Reconnecting opens the platform's sign-in: the
                        // GPUI app has no accounts yet (plan 260 open gap).
                        eprintln!(
                            "[videorc-app] Sidekick Voice: {platform} reconnect (accounts next)"
                        );
                    }),
            );
        }
        platform_rows = platform_rows.row(list_row);
    }

    let remove = PanelSection::new("sidekick-remove-messages")
        .title(REMOVE_MESSAGES)
        .description(format!(
            "{limits} {BUDDY_REMOVAL_FALLBACK} {BUDDY_VOICE_PREMIUM}"
        ))
        .child(platform_rows);

    let show_lead = view.unlock.is_some() || off || !paused.is_empty();

    div()
        .flex()
        .flex_col()
        .child(if show_lead { lead } else { div() })
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(size::GUTTER))
                .p(px(size::GUTTER))
                .child(commands)
                .child(remove),
        )
        .into_any_element()
}
