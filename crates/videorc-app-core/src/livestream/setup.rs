//! Livestream → Setup as data (`StreamingSetup`, `DestinationCard`,
//! `OAuthAccountPanel`, `StreamQualityControl`, `StreamFailureBanner`): the
//! app hands the window what this builds and never re-derives a rule.
//!
//! The page's own memory (which cards are open, what is typed into a key
//! field, a sign-in waiting in the browser) is [`PageMemory`]; everything
//! else comes from the capture config, the platform accounts
//! ([`super::PlatformsState`]), the running destinations and the plan.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::PlatformsState;
use super::accounts::{
    self, PlatformAccount, Status, XCapability, account_status, destination_label,
    missing_permissions_row, oauth_unavailable_reason, platform_label,
    stream_key_platform_mismatch, stream_key_tail_hint,
};
use super::copy;
use super::targets::{
    self, QualityView, Setup, Target, destination_quality_tag, destination_setup,
    manual_key_guidance, quality_view, shared_account_label, stream_server_url_issue,
};
use crate::account::entitlements::{
    EntitlementGate, entitlement_disabled_reason, streaming_destination_cap,
    streaming_destination_enable_gate,
};
use videorc_protocol::{EntitlementsSnapshot, FeatureId};

/// A badge's tone (`BadgeTone`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Success,
    Warning,
    Destructive,
    Live,
    Outline,
}

/// One running destination (`StreamTargetRuntime`, from `stream.targets`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Runtime {
    pub target_id: String,
    pub label: String,
    pub state: String,
    pub message: Option<String>,
    pub uplink_overflows: u64,
}

impl Runtime {
    /// The telemetry's `stream.targets` rows.
    pub fn read(rows: &[Value]) -> Vec<Runtime> {
        rows.iter()
            .filter_map(|row| {
                Some(Runtime {
                    target_id: row.get("targetId")?.as_str()?.to_string(),
                    label: row
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    state: row.get("state")?.as_str()?.to_string(),
                    message: row
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    uplink_overflows: row
                        .get("uplinkOverflows")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                })
            })
            .collect()
    }
}

/// A sign-in waiting in the browser (D-16): it belongs to the account as it
/// was at the click, so an account that comes back changed ends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInWait {
    pub from: String,
    pub url: Option<String>,
    pub copied: bool,
}

/// The page's own memory.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PageMemory {
    /// Cards the streamer (or the readiness list) opened or closed.
    pub expanded: BTreeMap<String, bool>,
    /// What is typed into a key field, and a full URL field, per target.
    pub key_drafts: BTreeMap<String, String>,
    pub url_drafts: BTreeMap<String, UrlDraft>,
    /// A server URL checked: saved with an issue when the page opened, or its
    /// field left once (D-19). Its issue shows from then on, while typing too.
    pub url_checked: BTreeSet<String>,
    /// A full URL refused at Save.
    pub full_url_issue: BTreeMap<String, String>,
    /// Sign-ins waiting, by platform.
    pub sign_in: BTreeMap<String, SignInWait>,
    /// "Continue streaming" dismissed this set of problems.
    pub dismissed_problems: Option<String>,
}

/// A full URL field's draft (`fullUrlDraft`): what is typed, over the saved
/// server URL it started from. A new saved URL starts the field again.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UrlDraft {
    pub saved: String,
    pub text: String,
}

impl PageMemory {
    /// The page opens (the cards mount): the URL fields start from what is
    /// saved, and a saved bad server URL says so at once (D-19).
    pub fn page_opened(&mut self, capture: &Value) {
        self.url_drafts.clear();
        self.full_url_issue.clear();
        self.url_checked = targets::targets(capture)
            .iter()
            .filter(|t| !t.full_url() && stream_server_url_issue(&t.server_url, false).is_some())
            .map(|t| t.id.clone())
            .collect();
    }

    /// The server field changed. A full URL is a draft until Save; a server
    /// URL is the destination's (the screen patches `serverUrl`).
    pub fn server_edited(&mut self, target: &Target, value: &str) {
        if target.full_url() {
            self.url_drafts.insert(
                target.id.clone(),
                UrlDraft {
                    saved: target.server_url.clone(),
                    text: value.to_string(),
                },
            );
            self.full_url_issue.remove(&target.id);
        }
    }

    /// The server field lost focus: a server URL's issue shows from now on.
    pub fn server_left(&mut self, target: &Target) {
        if !target.full_url() {
            self.url_checked.insert(target.id.clone());
        }
    }

    /// The full URL was stored: the field empties (`saveAndClearDraft`).
    pub fn full_url_saved(&mut self, target: &Target) {
        self.url_drafts.insert(
            target.id.clone(),
            UrlDraft {
                saved: target.server_url.clone(),
                text: String::new(),
            },
        );
    }

    /// The full URL field's text: the draft while the saved URL it started
    /// from is still the saved one, else the saved URL.
    pub fn full_url_draft(&self, target: &Target) -> String {
        match self.url_drafts.get(&target.id) {
            Some(draft) if draft.saved == target.server_url => draft.text.clone(),
            _ => target.server_url.clone(),
        }
    }
}

/// What the page reads besides its memory.
pub struct SetupInput<'a> {
    pub capture: &'a Value,
    pub platforms: &'a PlatformsState,
    pub runtimes: &'a [Runtime],
    pub entitlements: Option<&'a EntitlementsSnapshot>,
    pub session_active: bool,
    /// The Go Live question or a partial setup is up (S3.5c).
    pub go_live_pending: bool,
    /// A development build: the card says when an env var overrides the
    /// bundled OAuth client.
    pub development: bool,
}

/// A link in the card (an external page, D-20).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub label: String,
    pub url: String,
}

/// `SignInPending`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingView {
    pub has_url: bool,
    pub copy_label: String,
    pub other_browser: String,
}

/// The YouTube channel field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelView {
    pub options: Vec<(String, String)>,
    pub selected: i32,
    pub placeholder: String,
    pub enabled: bool,
    pub refresh_enabled: bool,
    pub loading: bool,
}

/// X Live's block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XLiveView {
    pub badge: String,
    pub ready: bool,
    pub check_label: String,
    pub check_enabled: bool,
    pub message: Option<String>,
    pub authorize: bool,
    pub use_key_instead: bool,
    pub links: Vec<Link>,
}

/// `OAuthAccountPanel`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OAuthView {
    /// No account: the line and Connect, or the wait.
    SignIn {
        connect_label: String,
        connect_enabled: bool,
        environment_override: bool,
        pending: Option<PendingView>,
    },
    Account(Box<AccountView>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountView {
    pub label: String,
    pub handle: String,
    pub initials: String,
    pub avatar_url: Option<String>,
    pub ok: bool,
    pub reconnect: bool,
    /// The provider's own words, one hover away.
    pub validation_message: String,
    pub can_disconnect: bool,
    pub pending: Option<PendingView>,
    pub permissions: Option<(String, String)>,
    pub shared_line: Option<String>,
    pub channel: Option<ChannelView>,
    pub x_live: Option<XLiveView>,
}

/// The stream-key fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualView {
    pub full_url: bool,
    pub server_label: String,
    pub server_placeholder: String,
    pub server_value: String,
    pub server_issue: Option<String>,
    pub save_url: bool,
    pub clear_url: bool,
    pub server_description: Option<String>,
    pub key_placeholder: String,
    pub key_value: String,
    pub save_key: bool,
    pub clear_key: bool,
    pub key_description: Option<String>,
    pub restore: Option<String>,
}

/// One destination (`DestinationCard`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationView {
    pub id: String,
    pub platform: String,
    pub label: String,
    pub context: String,
    pub badge: Option<(Tone, String)>,
    pub falling_behind: bool,
    pub quality_tag: Option<String>,
    pub enabled: bool,
    pub switch_enabled: bool,
    pub switch_label: String,
    /// Why the switch is off (the cap notice's words), for its description.
    pub switch_reason: String,
    pub status_message: Option<String>,
    pub uplink_line: Option<String>,
    pub expanded: bool,
    pub disabled: bool,
    // The open card.
    pub lock_reason: Option<String>,
    pub quality: QualityView,
    pub url_mode: Option<i32>,
    pub auth_mode: Option<(Vec<String>, i32)>,
    pub key_only_line: Option<String>,
    pub guidance: Option<(String, Option<Link>)>,
    pub oauth: Option<OAuthView>,
    pub manual: Option<ManualView>,
    /// S3.5c: YouTube's API is paused (plan 094): what is off and until when
    /// (the card offers the stream key).
    pub quota_paused: Option<String>,
}

/// `StreamFailureBanner`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureBanner {
    pub lines: Vec<String>,
    pub key: String,
}

/// The page's notices (the lead column's top).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Notices {
    /// Livestreaming is off for this plan, and its one action.
    pub entitlement: Option<(String, Option<String>)>,
    pub failure: Option<FailureBanner>,
    pub session_lock: Option<String>,
    /// Destinations tied to a scheduled event: (target id, line).
    pub scheduled: Vec<(String, String)>,
    pub scheduled_enabled: bool,
}

/// Setup as a whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupView {
    pub notices: Notices,
    pub destinations_description: String,
    pub cap_notice: Option<String>,
    pub destinations: Vec<DestinationView>,
    pub controls_disabled: bool,
    /// The right column's Output quality.
    pub quality: QualityView,
    pub quality_enabled: bool,
}

/// `initials` of a name (the avatar's fallback).
pub fn initials(name: &str) -> String {
    let words: Vec<&str> = name.split_whitespace().collect();
    let pick = |word: &str| word.chars().next().map(|c| c.to_uppercase().to_string());
    match words.as_slice() {
        [] => String::new(),
        [one] => one.chars().take(2).collect::<String>().to_uppercase(),
        [first, .., last] => format!(
            "{}{}",
            pick(first).unwrap_or_default(),
            pick(last).unwrap_or_default()
        ),
    }
}

/// The account's version a sign-in waits from (`accountVersion`).
pub fn account_version(account: Option<&PlatformAccount>) -> String {
    match account {
        Some(account) => format!(
            "{:?}|{}|{}",
            account.status,
            account.updated_at,
            account.scopes.join(" ")
        ),
        None => "none".to_string(),
    }
}

fn runtime_badge(state: &str) -> (Tone, String) {
    let tone = match state {
        "live" => Tone::Live,
        "connecting" | "reconnecting" | "warning" | "not-configured" => Tone::Warning,
        "failed" => Tone::Destructive,
        _ => Tone::Outline,
    };
    (tone, super::on_air::destination_state_label(state))
}

/// `idleDestinationBadge`.
fn idle_badge(target: &Target, account: Option<&PlatformAccount>) -> Option<(Tone, String)> {
    if let Some(state) = target.status.as_ref().map(|s| s.state.as_str())
        && !state.is_empty()
        && state != "not-configured"
    {
        return Some(match state {
            "ready" => (Tone::Success, copy::PREPARED.to_string()),
            "connecting" => (Tone::Warning, copy::UPDATING.to_string()),
            "live" | "failed" | "stopped" => runtime_badge(state),
            "warning" => (Tone::Warning, copy::REVIEW.to_string()),
            _ => (Tone::Outline, copy::IDLE.to_string()),
        });
    }
    (target.enabled && destination_setup(target, account) != Setup::Ready)
        .then(|| (Tone::Warning, copy::NEEDS_SETUP.to_string()))
}

fn pending(wait: Option<&SignInWait>, from: &str, platform_name: &str) -> Option<PendingView> {
    let wait = wait.filter(|wait| wait.from == from)?;
    Some(PendingView {
        has_url: wait.url.is_some(),
        copy_label: if wait.copied {
            copy::COPIED
        } else {
            copy::COPY_LINK
        }
        .to_string(),
        other_browser: copy::other_browser(platform_name),
    })
}

fn x_live_view(capability: Option<&XCapability>, loading: bool, disabled: bool) -> XLiveView {
    let ready = capability.is_some_and(|c| c.native_available);
    let open = capability.filter(|c| !c.native_available);
    XLiveView {
        badge: XCapability::badge(capability).to_string(),
        ready,
        check_label: if loading {
            copy::CHECKING
        } else {
            copy::CHECK_AGAIN
        }
        .to_string(),
        check_enabled: !disabled && !loading,
        message: open
            .map(|c| c.message.clone())
            .filter(|message| !message.is_empty()),
        authorize: open
            .is_some_and(|c| c.state == "needs-authorization" || c.state == "account-mismatch"),
        use_key_instead: open.is_some(),
        links: capability
            .map(|c| {
                vec![
                    Link {
                        label: copy::X_PRODUCER_DOCS.into(),
                        url: c.docs_url.clone(),
                    },
                    Link {
                        label: copy::X_API_OVERVIEW.into(),
                        url: c.api_overview_url.clone(),
                    },
                ]
            })
            .unwrap_or_default(),
    }
}

fn oauth_view(
    target: &Target,
    list: &[Target],
    input: &SetupInput<'_>,
    memory: &PageMemory,
    disabled: bool,
) -> OAuthView {
    let platform = target.platform.as_str();
    let platforms = input.platforms;
    let account = platforms.account(platform);
    let platform_name = platform_label(platform);
    let from = account_version(account);
    let wait = pending(memory.sign_in.get(platform), &from, platform_name);
    let credentials = platforms.credentials(platform);
    let Some(account) = account else {
        return OAuthView::SignIn {
            connect_label: copy::connect_platform(platform_name),
            connect_enabled: !disabled && credentials.is_none_or(|c| c.ready),
            environment_override: input.development
                && credentials.is_some_and(|c| c.client_id_source == "environment"),
            pending: wait,
        };
    };
    let validation = platforms.validation(platform);
    let status = account_status(account, validation);
    let shared = shared_account_label(list, target);
    let permissions = if status == Status::Reconnect {
        None
    } else {
        missing_permissions_row(platform, account).map(|row| (row.message, row.action))
    };
    let channel = (shared.is_none() && platform == "youtube").then(|| {
        let mut options: Vec<(String, String)> = Vec::new();
        if !platforms
            .youtube_channels
            .iter()
            .any(|channel| channel.channel_id == account.account_id)
        {
            options.push((
                account.account_id.clone(),
                accounts::YouTubeChannel {
                    channel_id: account.account_id.clone(),
                    title: account.account_label.clone(),
                    handle: account.account_handle.clone(),
                }
                .label(),
            ));
        }
        options.extend(
            platforms
                .youtube_channels
                .iter()
                .map(|channel| (channel.channel_id.clone(), channel.label())),
        );
        let loading = platforms.youtube_channels_loading;
        ChannelView {
            selected: options
                .iter()
                .position(|(id, _)| *id == account.account_id)
                .map_or(-1, |i| i as i32),
            placeholder: if loading {
                copy::LOADING_CHANNELS
            } else if options.is_empty() {
                copy::REFRESH_TO_LOAD_CHANNELS
            } else {
                copy::CHOOSE_A_CHANNEL
            }
            .to_string(),
            enabled: !disabled && !loading && !options.is_empty(),
            refresh_enabled: !disabled && !loading,
            loading,
            options,
        }
    });
    let x_live = (platform == "x").then(|| {
        x_live_view(
            platforms.x_capability.as_ref(),
            platforms.x_capability_loading,
            disabled,
        )
    });
    OAuthView::Account(Box::new(AccountView {
        label: account.account_label.clone(),
        handle: account
            .account_handle
            .clone()
            .unwrap_or_else(|| account.account_id.clone()),
        initials: initials(&account.account_label),
        avatar_url: account.avatar_url.clone(),
        ok: status == Status::Ok,
        reconnect: status == Status::Reconnect,
        validation_message: validation.map(|v| v.message.clone()).unwrap_or_default(),
        can_disconnect: shared.is_none(),
        pending: wait,
        permissions,
        shared_line: shared.as_deref().map(copy::same_account_as),
        channel,
        x_live,
    }))
}

fn manual_view(target: &Target, memory: &PageMemory) -> ManualView {
    let full = target.full_url();
    let id = target.id.as_str();
    let url_draft = memory.full_url_draft(target);
    let key_draft = memory
        .key_drafts
        .get(id)
        .cloned()
        .unwrap_or_else(|| target.stream_key.clone());
    // D-19: a saved bad URL says so at once; a typed one after the field is
    // left.
    let server_issue = if full {
        memory.full_url_issue.get(id).cloned()
    } else if memory.url_checked.contains(id) {
        stream_server_url_issue(&target.server_url, false).map(str::to_string)
    } else {
        None
    };
    let hint = target.stream_key_hint.as_deref().unwrap_or(copy::NO_HINT);
    let credential = if full {
        copy::CREDENTIAL_URL
    } else {
        copy::CREDENTIAL_KEY
    };
    ManualView {
        full_url: full,
        server_label: if full {
            copy::FULL_RTMP_URL
        } else {
            copy::SERVER_URL
        }
        .to_string(),
        server_placeholder: if full {
            if target.stream_key_present {
                copy::PLACEHOLDER_REPLACE_URL
            } else {
                copy::PLACEHOLDER_FULL_URL
            }
        } else {
            copy::PLACEHOLDER_SERVER_URL
        }
        .to_string(),
        server_value: if full {
            url_draft.clone()
        } else {
            target.server_url.clone()
        },
        server_issue,
        save_url: full && !url_draft.trim().is_empty(),
        clear_url: full && target.stream_key_present,
        server_description: full.then(|| {
            if target.stream_key_present {
                copy::saved_securely(hint)
            } else {
                copy::SAVED_FULL_URL_HINT.to_string()
            }
        }),
        key_placeholder: if target.stream_key_present {
            copy::PLACEHOLDER_REPLACE_KEY
        } else {
            copy::PLACEHOLDER_KEY
        }
        .to_string(),
        save_key: !full && !key_draft.trim().is_empty(),
        key_value: key_draft,
        clear_key: !full && target.stream_key_present,
        key_description: (!full && target.stream_key_present).then(|| copy::saved_securely(hint)),
        restore: target.previous_stream_key_present.then(|| {
            copy::restore_previous(credential, target.previous_stream_key_hint.as_deref())
        }),
    }
}

/// The problems a live destination has (`DESTINATION_PROBLEM_STATES`).
fn is_problem(state: &str) -> bool {
    matches!(
        state,
        "failed" | "reconnecting" | "warning" | "not-configured"
    )
}

/// `destinationsOnAir`: this computer's feed to Videorc Cloud
/// (`videorc-cloud-*`) is no destination.
fn destinations_on_air(runtimes: &[Runtime]) -> usize {
    runtimes
        .iter()
        .filter(|r| r.state == "live" && !super::on_air::is_cloud_feed_target(&r.target_id))
        .count()
}

fn failure_banner(runtimes: &[Runtime]) -> Option<FailureBanner> {
    let problems: Vec<&Runtime> = runtimes.iter().filter(|r| is_problem(&r.state)).collect();
    if problems.is_empty() {
        return None;
    }
    let key = problems
        .iter()
        .map(|r| format!("{}:{}", r.target_id, r.state))
        .collect::<Vec<_>>()
        .join("|");
    let on_air = destinations_on_air(runtimes);
    let names = |state: &str| {
        problems
            .iter()
            .filter(|r| r.state == state)
            .map(|r| destination_label(&r.label))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let still = crate::notices::other_destinations_line(on_air)
        .unwrap_or_else(|| copy::NOTHING_ELSE_ON_AIR.to_string());
    let label = super::on_air::destination_state_label;
    let mut lines = Vec::new();
    let failed = names("failed");
    if !failed.is_empty() {
        lines.push(format!("{}: {failed}. {still}", label("failed")));
    }
    let reconnecting = names("reconnecting");
    if !reconnecting.is_empty() {
        lines.push(copy::failure_reconnecting(&reconnecting));
    }
    let warning = names("warning");
    if !warning.is_empty() {
        lines.push(copy::failure_not_receiving(&label("warning"), &warning));
    }
    let skipped: Vec<String> = problems
        .iter()
        .filter(|r| r.state == "not-configured")
        .map(|r| match &r.message {
            Some(message) => format!("{} ({message})", destination_label(&r.label)),
            None => destination_label(&r.label),
        })
        .collect();
    if !skipped.is_empty() {
        lines.push(format!(
            "{}: {}.",
            label("not-configured"),
            skipped.join(", ")
        ));
    }
    Some(FailureBanner { lines, key })
}

/// `StreamingSetup` as data.
pub fn setup_view(input: &SetupInput<'_>, memory: &PageMemory) -> SetupView {
    let list = targets::targets(input.capture);
    let enabled_ids = targets::enabled_ids(&list);
    let entitlement_reason =
        entitlement_disabled_reason(input.entitlements, FeatureId::Livestreaming);
    let disabled = input.session_active || input.go_live_pending || entitlement_reason.is_some();
    let cap = streaming_destination_cap(input.entitlements, &enabled_ids);
    // D-14: only the first destination that needs setup opens on its own.
    let first_needs_setup = list
        .iter()
        .find(|t| {
            t.enabled && destination_setup(t, input.platforms.account(&t.platform)) != Setup::Ready
        })
        .map(|t| t.id.clone());
    let destinations = list
        .iter()
        .map(|target| {
            destination_view(
                target,
                &list,
                input,
                memory,
                disabled,
                &enabled_ids,
                cap.notice.as_deref(),
                first_needs_setup.as_deref() == Some(target.id.as_str()),
            )
        })
        .collect();
    let failure = if input.session_active {
        failure_banner(input.runtimes)
            .filter(|banner| memory.dismissed_problems.as_deref() != Some(banner.key.as_str()))
    } else {
        None
    };
    let scheduled = list
        .iter()
        .filter(|t| {
            t.scheduled_event_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
        })
        .map(|t| {
            (
                t.id.clone(),
                format!(
                    "{}: {}",
                    destination_label(&t.label),
                    t.scheduled_event_title.clone().unwrap_or_default()
                ),
            )
        })
        .collect();
    let notices = Notices {
        entitlement: entitlement_reason
            .filter(|_| !input.session_active)
            .map(|reason| {
                let action = crate::notices::is_premium_upgrade_message(&reason)
                    .then(|| copy::VIEW_PREMIUM.to_string());
                (reason, action)
            }),
        failure,
        session_lock: input
            .session_active
            .then(|| copy::session_lock_reason(copy::SETUP_LOCKS)),
        scheduled,
        scheduled_enabled: !input.session_active && !input.go_live_pending,
    };
    let youtube_on = list.iter().any(|t| t.enabled && t.platform == "youtube");
    SetupView {
        notices,
        destinations_description: copy::destinations_description(&cap.rule),
        cap_notice: cap.notice.filter(|_| !disabled),
        destinations,
        controls_disabled: disabled,
        quality: quality_view(
            &targets::default_output_preset(input.capture),
            youtube_on,
            false,
        ),
        quality_enabled: !input.session_active && !input.go_live_pending,
    }
}

#[allow(clippy::too_many_arguments)]
fn destination_view(
    target: &Target,
    list: &[Target],
    input: &SetupInput<'_>,
    memory: &PageMemory,
    disabled: bool,
    enabled_ids: &[String],
    cap_notice: Option<&str>,
    default_expanded: bool,
) -> DestinationView {
    let platform = target.platform.as_str();
    let native = platform != "custom";
    let platform_name = platform_label(platform);
    let account = input.platforms.account(platform);
    let credentials = input.platforms.credentials(platform);
    let key_only = oauth_unavailable_reason(platform).is_some();
    let unavailable = oauth_unavailable_reason(platform)
        .or_else(|| credentials.filter(|c| !c.ready).map(|c| c.message.clone()));
    let oauth_mode = native && target.oauth() && unavailable.is_none();
    let runtime = input
        .runtimes
        .iter()
        .find(|runtime| runtime.target_id == target.id);
    // S3.5c (plan 094): the OAuth path can't create a YouTube broadcast
    // while the API is paused; the stream key still can.
    let quota_paused = (target.platform == "youtube" && target.oauth())
        .then_some(input.platforms.youtube_quota_paused_until.as_deref())
        .flatten()
        .map(|until| {
            copy::youtube_destination_paused(&copy::format_resume_time(until, chrono::Local::now()))
        });
    let badge = match runtime {
        Some(runtime) => Some(runtime_badge(&runtime.state)),
        None if quota_paused.is_some() => Some((Tone::Warning, copy::API_PAUSED.to_string())),
        None => idle_badge(target, account),
    };
    let gate = streaming_destination_enable_gate(input.entitlements, enabled_ids, &target.id);
    let lock_gate = (!disabled && !target.enabled && !gate.allowed()).then_some(&gate);
    let label = destination_label(&target.label);
    // V-2: the vertical twin says 9:16 in words beside how it connects; a
    // signed-in row names the account the backend reports.
    let context = [
        target.vertical().then(|| copy::ROW_VERTICAL.to_string()),
        if oauth_mode {
            account
                .map(|a| a.account_label.clone())
                .filter(|label| !label.is_empty())
        } else {
            Some(copy::ROW_STREAM_KEY.to_string())
        },
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    let uplink_line = copy::uplink_line(runtime.map_or(0, |r| r.uplink_overflows));
    let expanded = memory
        .expanded
        .get(&target.id)
        .copied()
        .unwrap_or(default_expanded);
    let key_only_line = (native && unavailable.is_some()).then(|| {
        if platform == "facebook" {
            copy::FACEBOOK_SIGN_IN_UNAVAILABLE.to_string()
        } else if key_only {
            copy::uses_a_stream_key(platform_name)
        } else {
            copy::sign_in_not_in_build(platform_name)
        }
    });
    let guidance = (!oauth_mode).then(|| {
        let (line, link) = manual_key_guidance(platform);
        (
            line.to_string(),
            link.map(|(label, url)| Link {
                label: label.into(),
                url: url.into(),
            }),
        )
    });
    let auth_mode = (native && unavailable.is_none()).then(|| {
        let labels = if platform == "x" {
            vec![
                copy::X_AUTH_SIGN_IN.to_string(),
                copy::X_AUTH_STREAM_KEY.to_string(),
            ]
        } else {
            vec![
                copy::AUTH_SIGN_IN.to_string(),
                copy::AUTH_STREAM_KEY.to_string(),
            ]
        };
        (labels, if target.oauth() { 0 } else { 1 })
    });
    DestinationView {
        id: target.id.clone(),
        platform: platform.to_string(),
        label: label.clone(),
        context,
        badge,
        quota_paused,
        falling_behind: uplink_line.is_some(),
        quality_tag: destination_quality_tag(target),
        enabled: target.enabled,
        switch_enabled: !disabled && lock_gate.is_none(),
        switch_label: copy::enable_label(&label),
        switch_reason: lock_gate
            .and(cap_notice)
            .map(str::to_string)
            .unwrap_or_default(),
        status_message: runtime
            .and_then(|r| r.message.clone())
            .or_else(|| target.status.as_ref().and_then(|s| s.message.clone())),
        uplink_line,
        expanded,
        disabled,
        lock_reason: lock_gate.and_then(|gate| gate.reason().map(str::to_string)),
        quality: quality_view(
            target.output_preset.as_deref().unwrap_or("default"),
            platform == "youtube",
            true,
        ),
        url_mode: (platform == "custom").then(|| if target.full_url() { 1 } else { 0 }),
        auth_mode,
        key_only_line,
        guidance,
        oauth: oauth_mode.then(|| oauth_view(target, list, input, memory, disabled)),
        manual: (!oauth_mode).then(|| manual_view(target, memory)),
    }
}

/// A question the page asks before an action (one at a time).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Question {
    /// Replace a saved key, or save one that looks like another platform's.
    SaveKey {
        target_id: String,
        value: String,
        full_url: bool,
        warning: Option<String>,
    },
    RemoveKey {
        target_id: String,
    },
    Disconnect {
        platform: String,
    },
    YouTubeConsent,
    /// S3.5b: stop posting to a Discord webhook (`name` is Discord's).
    RemoveWebhook {
        webhook_id: String,
        name: Option<String>,
    },
}

/// The question's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionView {
    pub title: String,
    pub description: String,
    pub confirm: String,
    pub destructive: bool,
    pub warning: Option<String>,
}

/// `requestManualKeySave`: what a Save (or Return) does. `Ok(None)` saves at
/// once; `Ok(Some(question))` asks first; `Err(issue)` is a full URL that
/// can't work.
pub fn request_key_save(
    target: &Target,
    value: &str,
    full_url: bool,
) -> Result<Option<Question>, Option<String>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(None);
    }
    if full_url && let Some(issue) = stream_server_url_issue(trimmed, true) {
        return Err(Some(issue.to_string()));
    }
    let warning = if full_url {
        None
    } else {
        stream_key_platform_mismatch(&target.platform, trimmed)
    };
    if target.stream_key_present || warning.is_some() {
        return Ok(Some(Question::SaveKey {
            target_id: target.id.clone(),
            value: value.to_string(),
            full_url,
            warning,
        }));
    }
    Ok(None)
}

/// The words of a question about `target` (or a platform).
pub fn question_view(question: &Question, list: &[Target]) -> Option<QuestionView> {
    let find = |id: &str| list.iter().find(|t| t.id == id);
    match question {
        Question::SaveKey {
            target_id,
            value,
            full_url,
            warning,
        } => {
            let target = find(target_id)?;
            let label = destination_label(&target.label);
            let credential = if *full_url {
                copy::CREDENTIAL_URL
            } else {
                copy::CREDENTIAL_KEY
            };
            let tail = stream_key_tail_hint(value);
            Some(if target.stream_key_present {
                QuestionView {
                    title: copy::replace_title(&label, credential),
                    description: copy::replace_description(
                        credential,
                        target.stream_key_hint.as_deref(),
                        &tail,
                    ),
                    confirm: copy::replace_confirm(credential),
                    destructive: warning.is_some(),
                    warning: warning.clone(),
                }
            } else {
                QuestionView {
                    title: copy::save_title(credential, &label),
                    description: copy::save_description(&tail, &label),
                    confirm: copy::save_confirm(credential),
                    destructive: warning.is_some(),
                    warning: warning.clone(),
                }
            })
        }
        Question::RemoveKey { target_id } => {
            let target = find(target_id)?;
            let label = destination_label(&target.label);
            let credential = if target.full_url() {
                copy::CREDENTIAL_URL
            } else {
                copy::CREDENTIAL_KEY
            };
            Some(QuestionView {
                title: copy::remove_title(&label, credential),
                description: copy::remove_description(
                    credential,
                    target.stream_key_hint.as_deref(),
                ),
                confirm: copy::remove_confirm(credential),
                destructive: true,
                warning: None,
            })
        }
        Question::Disconnect { platform } => {
            let name = platform_label(platform);
            Some(QuestionView {
                title: copy::disconnect_title(name),
                description: if platform == "youtube" {
                    copy::DISCONNECT_YOUTUBE.to_string()
                } else {
                    copy::disconnect_description(name)
                },
                confirm: copy::disconnect_confirm(name),
                destructive: true,
                warning: None,
            })
        }
        Question::YouTubeConsent => Some(QuestionView {
            title: copy::YOUTUBE_CONSENT_TITLE.into(),
            description: copy::YOUTUBE_CONSENT_DESCRIPTION.into(),
            confirm: copy::CONTINUE_TO_GOOGLE.into(),
            destructive: false,
            warning: None,
        }),
        Question::RemoveWebhook { name, .. } => Some(QuestionView {
            title: match name {
                Some(name) => copy::remove_named_webhook(name),
                None => copy::REMOVE_DISCORD_WEBHOOK.to_string(),
            },
            description: copy::REMOVE_WEBHOOK_DESCRIPTION.into(),
            confirm: copy::REMOVE_WEBHOOK.into(),
            destructive: true,
            warning: None,
        }),
    }
}

/// `true` when a gate holds a destination's switch off.
pub fn gate_locked(gate: &EntitlementGate) -> bool {
    !gate.allowed()
}

#[cfg(test)]
mod tests;
