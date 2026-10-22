//! Which destinations a post links, with which URL, and whose name it is sent
//! under (plan 187 E10, D8, D12). One builder serves both the Discord
//! section's preview and the live session, so what the section shows is what
//! gets posted.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::client::Sender;
use super::machine::{Confirm, LegPlan};
use crate::protocol::{AccountStatus, VideorcAccountSnapshot};
use crate::streaming::{
    PlatformAccount, PlatformAccountStatus, StreamAuthMode, StreamOutputOrientation,
    StreamPlatform, StreamPrivacy, StreamTargetSettings, stream_platform_label,
};

/// Longest typed link accepted.
pub const MAX_TYPED_LINK_LEN: usize = 512;

/// A destination as the preview sees it (the renderer's configured list).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkTarget {
    pub id: String,
    pub platform: StreamPlatform,
    pub label: String,
    pub auth_mode: StreamAuthMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_orientation: Option<StreamOutputOrientation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_broadcast_id: Option<String>,
}

impl From<&StreamTargetSettings> for LinkTarget {
    fn from(target: &StreamTargetSettings) -> Self {
        Self {
            id: target.id.clone(),
            platform: target.platform,
            label: target.label.clone(),
            auth_mode: target.auth_mode,
            account_id: target.account_id.clone(),
            output_orientation: target.output_orientation,
            platform_broadcast_id: target.platform_broadcast_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LinkKind {
    /// Built from the connected account.
    Auto,
    /// Typed by the streamer in the Discord section.
    Typed,
    /// Made when the stream goes live (a YouTube broadcast, an X share link).
    AtGoLive,
    /// Unknown: type one to include this destination.
    None,
}

/// One row of the Discord section's link list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub target_id: String,
    pub label: String,
    pub link_kind: LinkKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// Ticked: not excluded and linkable.
    pub included: bool,
}

/// The built link for a destination before any typed override.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AutoLink {
    Url(String),
    AtGoLive,
    None,
}

fn is_youtube_oauth(target: &LinkTarget) -> bool {
    target.platform == StreamPlatform::Youtube && target.auth_mode == StreamAuthMode::Oauth
}

fn is_x_oauth(target: &LinkTarget) -> bool {
    target.platform == StreamPlatform::X && target.auth_mode == StreamAuthMode::Oauth
}

/// The account a destination uses: its own id, else the platform's account
/// (the renderer pairs them the same way).
pub fn account_for<'a>(
    target: &LinkTarget,
    accounts: &'a [PlatformAccount],
) -> Option<&'a PlatformAccount> {
    let connected = |account: &&PlatformAccount| {
        account.platform == target.platform && account.status != PlatformAccountStatus::Disconnected
    };
    target
        .account_id
        .as_deref()
        .and_then(|wanted| {
            accounts
                .iter()
                .filter(connected)
                .find(|account| account.id == wanted || account.account_id == wanted)
        })
        .or_else(|| accounts.iter().find(connected))
}

fn auto_link(target: &LinkTarget, accounts: &[PlatformAccount]) -> AutoLink {
    if is_youtube_oauth(target) {
        return match target
            .platform_broadcast_id
            .as_deref()
            .filter(|id| valid_slug(id))
        {
            Some(id) => AutoLink::Url(format!("https://www.youtube.com/watch?v={id}")),
            None => AutoLink::AtGoLive,
        };
    }
    if is_x_oauth(target) {
        return AutoLink::AtGoLive;
    }
    let handle = account_for(target, accounts)
        .and_then(|account| account.account_handle.as_deref())
        .map(str::trim)
        .unwrap_or("");
    match target.platform {
        // YouTube serves `/@handle/live` only while a public stream runs.
        StreamPlatform::Youtube => match handle.strip_prefix('@') {
            Some(rest) if valid_slug(rest) => {
                AutoLink::Url(format!("https://www.youtube.com/@{rest}/live"))
            }
            _ => AutoLink::None,
        },
        StreamPlatform::Twitch => {
            let login = handle.trim_start_matches('@');
            if valid_slug(login) {
                AutoLink::Url(format!("https://www.twitch.tv/{}", login.to_lowercase()))
            } else {
                AutoLink::None
            }
        }
        StreamPlatform::Kick => {
            let slug = handle.trim_start_matches('@');
            if valid_slug(slug) {
                AutoLink::Url(format!("https://kick.com/{}", slug.to_lowercase()))
            } else {
                AutoLink::None
            }
        }
        StreamPlatform::X
        | StreamPlatform::Tiktok
        | StreamPlatform::Instagram
        | StreamPlatform::Custom => AutoLink::None,
    }
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// Typed links: absolute `https`, at most [`MAX_TYPED_LINK_LEN`], with a host.
pub fn validate_typed_link(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.len() > MAX_TYPED_LINK_LEN {
        return Err("That link is too long.".to_string());
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| "Type a full link that starts with https://".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) {
        return Err("Type a full link that starts with https://".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Links can't carry a username or password.".to_string());
    }
    Ok(url.to_string())
}

/// The button label: the platform, plus " · Vertical" for a vertical leg;
/// a custom destination keeps its own name.
pub fn button_label(target: &LinkTarget) -> String {
    let base = match target.platform {
        StreamPlatform::Custom => {
            let label = target.label.trim();
            if label.is_empty() {
                "Watch".to_string()
            } else {
                label.to_string()
            }
        }
        platform => stream_platform_label(platform).to_string(),
    };
    if target.output_orientation == Some(StreamOutputOrientation::Vertical) {
        format!("{base} · Vertical")
    } else {
        base
    }
}

pub fn preview(
    targets: &[LinkTarget],
    accounts: &[PlatformAccount],
    excluded: &[String],
    overrides: &BTreeMap<String, String>,
) -> Vec<LinkPreview> {
    targets
        .iter()
        .map(|target| {
            let (link_kind, link) = match overrides.get(&target.id) {
                Some(typed) => (LinkKind::Typed, Some(typed.clone())),
                None => match auto_link(target, accounts) {
                    AutoLink::Url(url) => (LinkKind::Auto, Some(url)),
                    AutoLink::AtGoLive => (LinkKind::AtGoLive, None),
                    AutoLink::None => (LinkKind::None, None),
                },
            };
            LinkPreview {
                target_id: target.id.clone(),
                label: button_label(target),
                included: link_kind != LinkKind::None && !excluded.contains(&target.id),
                link_kind,
                link,
            }
        })
        .collect()
}

/// The legs a live session may announce: ticked and linkable, in order.
/// `draft_youtube_privacy` is the stream info's YouTube privacy.
pub fn leg_plans(
    targets: &[LinkTarget],
    accounts: &[PlatformAccount],
    excluded: &[String],
    overrides: &BTreeMap<String, String>,
    draft_youtube_privacy: StreamPrivacy,
) -> Vec<LegPlan> {
    targets
        .iter()
        .filter(|target| !excluded.contains(&target.id))
        .filter_map(|target| {
            let typed = overrides.get(&target.id).cloned();
            let auto = auto_link(target, accounts);
            let link_typed = typed.is_some();
            let link = typed.or(match &auto {
                AutoLink::Url(url) => Some(url.clone()),
                AutoLink::AtGoLive | AutoLink::None => None,
            });
            let confirm = if is_youtube_oauth(target) {
                Confirm::YouTube {
                    broadcast_id: target
                        .platform_broadcast_id
                        .clone()
                        .filter(|id| valid_slug(id)),
                }
            } else if is_x_oauth(target) {
                Confirm::X
            } else {
                Confirm::Dwell
            };
            // A dwell leg needs its link now; YouTube and X bring theirs.
            if confirm == Confirm::Dwell && link.is_none() {
                return None;
            }
            Some(LegPlan {
                target_id: target.id.clone(),
                platform: target.platform,
                label: button_label(target),
                draft_privacy: matches!(confirm, Confirm::YouTube { .. })
                    .then_some(draft_youtube_privacy),
                confirm,
                link,
                link_typed,
            })
        })
        .collect()
}

/// "Post as" (D12).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PostAs {
    /// The first ticked destination's account, else the Videorc account,
    /// else the webhook's own name.
    #[default]
    Automatic,
    Platform {
        #[serde(rename = "accountId")]
        account_id: String,
    },
    Videorc,
    /// The name and avatar set on the webhook in Discord.
    Webhook,
}

/// An identity the picker offers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PostAsIdentity {
    pub post_as: PostAs,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<StreamPlatform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

pub fn identities(
    accounts: &[PlatformAccount],
    videorc: Option<&VideorcAccountSnapshot>,
) -> Vec<PostAsIdentity> {
    let mut list: Vec<PostAsIdentity> = accounts
        .iter()
        .filter(|account| account.status != PlatformAccountStatus::Disconnected)
        .filter(|account| !account.account_label.trim().is_empty())
        .map(|account| PostAsIdentity {
            post_as: PostAs::Platform {
                account_id: account.id.clone(),
            },
            name: account.account_label.trim().to_string(),
            platform: Some(account.platform),
            avatar_url: account.avatar_url.clone(),
        })
        .collect();
    if let Some(sender) = videorc_sender(videorc) {
        list.push(PostAsIdentity {
            post_as: PostAs::Videorc,
            name: sender.name,
            platform: None,
            avatar_url: sender.avatar_url,
        });
    }
    list
}

fn videorc_sender(videorc: Option<&VideorcAccountSnapshot>) -> Option<Sender> {
    let account = videorc.filter(|account| account.status == AccountStatus::SignedIn)?;
    let name = account
        .display_name
        .as_deref()
        .or(account.username.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    Some(Sender {
        name: name.to_string(),
        avatar_url: account.avatar_url.clone(),
    })
}

fn account_sender(account: &PlatformAccount) -> Option<Sender> {
    let name = account.account_label.trim();
    (!name.is_empty()).then(|| Sender {
        name: name.to_string(),
        avatar_url: account.avatar_url.clone(),
    })
}

/// Who the post is sent as. `None` = the webhook's own name and avatar.
/// `first_ticked` is the first destination the post will link.
pub fn resolve_sender(
    post_as: &PostAs,
    first_ticked: Option<&LinkTarget>,
    accounts: &[PlatformAccount],
    videorc: Option<&VideorcAccountSnapshot>,
) -> Option<Sender> {
    let automatic = || {
        first_ticked
            .and_then(|target| account_for(target, accounts))
            .and_then(account_sender)
            .or_else(|| videorc_sender(videorc))
    };
    match post_as {
        PostAs::Webhook => None,
        PostAs::Videorc => videorc_sender(videorc).or_else(automatic),
        PostAs::Platform { account_id } => accounts
            .iter()
            .filter(|account| account.status != PlatformAccountStatus::Disconnected)
            .find(|account| &account.id == account_id)
            .and_then(account_sender)
            .or_else(automatic),
        PostAs::Automatic => automatic(),
    }
}

#[cfg(test)]
#[path = "links_tests.rs"]
mod tests;
