//! The platform accounts as the backend reports them (`platformAccounts.list`,
//! `.validate`, `.oauth.providerCredentials`, `.youtube.channels`,
//! `streamTargets.x.capability`), and the rules the destination card reads
//! from them: `accountStatus`, `missingPermissionsRow` and
//! `shared/platform-scopes.ts`' connect options.
//!
//! The wire types read leniently (every optional field defaults): a field a
//! newer backend adds is ignored, and a missing one never fails the list.

use serde::{Deserialize, Serialize};

use super::copy;

/// `PlatformAccountStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AccountStatus {
    #[default]
    Connected,
    NeedsReconnect,
    Disconnected,
}

/// `PlatformAccount` (the renderer's view: no secret, no token).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAccount {
    #[serde(default)]
    pub id: String,
    pub platform: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub account_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub status: AccountStatus,
}

/// `PlatformAccountValidationState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ValidationState {
    Valid,
    Refreshed,
    NeedsReconnect,
    Missing,
}

/// `PlatformAccountValidation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountValidation {
    pub platform: String,
    pub state: ValidationState,
    #[serde(default)]
    pub message: String,
}

/// `OAuthProviderCredentialStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentials {
    pub platform: String,
    pub ready: bool,
    #[serde(default)]
    pub client_id_source: String,
    #[serde(default)]
    pub message: String,
}

/// `YouTubeChannel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChannel {
    pub channel_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
}

impl YouTubeChannel {
    /// `youtubeChannelLabel`: its title, and its handle when it has one.
    pub fn label(&self) -> String {
        match &self.handle {
            Some(handle) => format!("{} ({handle})", self.title),
            None => self.title.clone(),
        }
    }
}

/// `XNativeLiveCapability` (the fields the card reads).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct XCapability {
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub native_available: bool,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub docs_url: String,
    #[serde(default)]
    pub api_overview_url: String,
}

impl XCapability {
    /// The badge's word.
    pub fn badge(capability: Option<&XCapability>) -> &'static str {
        match capability {
            Some(capability) if capability.native_available => copy::X_LIVE_READY,
            Some(capability) => match capability.state.as_str() {
                "needs-authorization" => copy::X_AUTHORIZATION_NEEDED,
                "missing-credentials" => copy::X_CREDENTIALS_NEEDED,
                "account-mismatch" => copy::X_ACCOUNT_MISMATCH,
                _ => copy::X_NOT_CHECKED,
            },
            None => copy::X_NOT_CHECKED,
        }
    }
}

/// `StoreManualStreamKeyResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoredKey {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_key_secret_ref: Option<String>,
    #[serde(default)]
    pub stream_key_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_key_hint: Option<String>,
    #[serde(default)]
    pub previous_stream_key_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_stream_key_hint: Option<String>,
}

/// The signed-in account's one status (plan 080 S6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    Unchecked,
    Reconnect,
}

/// `accountStatus`.
pub fn account_status(account: &PlatformAccount, validation: Option<&AccountValidation>) -> Status {
    if account.status != AccountStatus::Connected
        || validation.is_some_and(|v| v.state == ValidationState::NeedsReconnect)
    {
        return Status::Reconnect;
    }
    match validation.map(|v| v.state) {
        Some(ValidationState::Valid | ValidationState::Refreshed) => Status::Ok,
        _ => Status::Unchecked,
    }
}

// --- `shared/platform-scopes.ts` ----------------------------------------

pub const TWITCH_AUDIENCE_SCOPES: [&str; 2] =
    ["moderator:read:followers", "channel:read:subscriptions"];
pub const TWITCH_BITS_POINTS_SCOPES: [&str; 2] = ["bits:read", "channel:read:redemptions"];
pub const TWITCH_MODERATION_SCOPE: &str = "moderator:manage:chat_messages";
pub const KICK_MODERATION_SCOPE: &str = "moderation:chat_message:manage";
pub const YOUTUBE_FORCE_SSL_SCOPE: &str = "https://www.googleapis.com/auth/youtube.force-ssl";

/// `TWITCH_OPTIONAL_SCOPES`.
pub fn twitch_optional_scopes() -> Vec<&'static str> {
    let mut scopes = TWITCH_AUDIENCE_SCOPES.to_vec();
    scopes.push(TWITCH_MODERATION_SCOPE);
    scopes.extend(TWITCH_BITS_POINTS_SCOPES);
    scopes
}

/// `platformConnectOptions`: Connect asks for all of Twitch's optional
/// permissions (plan 071 S2, plan 140 S5); nothing extra elsewhere.
pub fn connect_optional_scopes(platform: &str) -> Vec<&'static str> {
    if platform == "twitch" {
        twitch_optional_scopes()
    } else {
        Vec::new()
    }
}

/// `permissionReconnectOptions`: the permission row asks for every optional
/// permission (the only place Kick's moderation permission is asked for).
pub fn permission_reconnect_scopes(platform: &str) -> Vec<&'static str> {
    match platform {
        "twitch" => twitch_optional_scopes(),
        "kick" => vec![KICK_MODERATION_SCOPE],
        _ => Vec::new(),
    }
}

/// `isScopeReconnectPlatform`.
fn is_scope_reconnect_platform(platform: &str) -> bool {
    matches!(platform, "twitch" | "kick")
}

/// `removeMessagesReadiness(platform, account) === 'missing-scope'`.
fn remove_messages_missing(platform: &str, account: &PlatformAccount) -> bool {
    let connected = account.status == AccountStatus::Connected;
    let holds = |scope: &str| connected && account.scopes.iter().any(|s| s == scope);
    match platform {
        "twitch" => !holds(TWITCH_MODERATION_SCOPE),
        "kick" => !holds(KICK_MODERATION_SCOPE),
        _ => false,
    }
}

/// `missingPermissionsRow`: what a reconnect would add, or `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionsRow {
    pub message: String,
    pub action: String,
}

pub fn missing_permissions_row(
    platform: &str,
    account: &PlatformAccount,
) -> Option<PermissionsRow> {
    let lacks = |scopes: &[&str]| {
        platform == "twitch"
            && !scopes
                .iter()
                .all(|scope| account.scopes.iter().any(|s| s == scope))
    };
    let audience_missing = lacks(&TWITCH_AUDIENCE_SCOPES);
    let bits_missing = lacks(&TWITCH_BITS_POINTS_SCOPES);
    let activity_missing = audience_missing || bits_missing;
    if is_scope_reconnect_platform(platform) && remove_messages_missing(platform, account) {
        let remove = copy::remove_messages_reconnect(platform_label(platform));
        let message = if activity_missing {
            let what = if audience_missing && bits_missing {
                copy::ACTIVITY_ALL
            } else if audience_missing {
                copy::ACTIVITY_AUDIENCE
            } else {
                copy::ACTIVITY_BITS
            };
            copy::alongside(&remove, what)
        } else {
            remove
        };
        return Some(PermissionsRow {
            message,
            action: copy::RECONNECT.to_string(),
        });
    }
    if activity_missing {
        let what = if audience_missing && bits_missing {
            copy::WHAT_ALL
        } else if audience_missing {
            copy::WHAT_AUDIENCE
        } else {
            copy::ACTIVITY_BITS
        };
        return Some(PermissionsRow {
            message: copy::one_more_twitch_permission(what),
            action: copy::RECONNECT_TWITCH.to_string(),
        });
    }
    None
}

// --- `lib/platform-copy.ts` and `lib/capture.ts` ------------------------

/// `platformLabel`: one name per streaming platform (D-36).
pub fn platform_label(platform: &str) -> &'static str {
    match platform {
        "youtube" => "YouTube",
        "twitch" => "Twitch",
        "kick" => "Kick",
        "x" => "X",
        "facebook" => "Facebook",
        "tiktok" => "TikTok",
        "instagram" => "Instagram",
        "custom" => "Custom RTMP",
        _ => "",
    }
}

/// `destinationLabel`: a retired default reads as its platform.
pub fn destination_label(label: &str) -> String {
    crate::notices::destination_label(label).to_string()
}

/// `metadataPlatformLabel`: the platform's name in the card's sentences.
pub fn metadata_platform_label(platform: &str) -> &'static str {
    platform_label(platform)
}

/// `oauthUnavailableReason`.
pub fn oauth_unavailable_reason(platform: &str) -> Option<String> {
    match platform {
        "facebook" => Some(copy::FACEBOOK_SIGN_IN_UNAVAILABLE.to_string()),
        "custom" => Some(copy::CUSTOM_SIGN_IN_UNAVAILABLE.to_string()),
        "tiktok" | "instagram" => {
            Some(copy::key_only_sign_in_unavailable(platform_label(platform)))
        }
        _ => None,
    }
}

/// `isPlatformOAuthAvailable`.
pub fn is_oauth_available(platform: &str) -> bool {
    oauth_unavailable_reason(platform).is_none()
}

// --- `lib/stream-key-format.ts` -----------------------------------------

/// `detectStreamKeyPlatform`: best-effort, only a confident match.
pub fn detect_stream_key_platform(key: &str) -> Option<&'static str> {
    let key = key.trim();
    if is_twitch_key(key) {
        Some("twitch")
    } else if is_youtube_key(key) {
        Some("youtube")
    } else if is_kick_key(key) {
        Some("kick")
    } else {
        None
    }
}

/// `/^live_\d+_[A-Za-z0-9]+$/`.
fn is_twitch_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("live_") else {
        return false;
    };
    let Some((digits, tail)) = rest.split_once('_') else {
        return false;
    };
    !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit())
        && !tail.is_empty()
        && tail.chars().all(|c| c.is_ascii_alphanumeric())
}

/// `/^[a-z0-9]{4}(?:-[a-z0-9]{4}){3,5}$/i`.
fn is_youtube_key(key: &str) -> bool {
    let groups: Vec<&str> = key.split('-').collect();
    (4..=6).contains(&groups.len())
        && groups
            .iter()
            .all(|group| group.len() == 4 && group.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// `/^sk_[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+_[A-Za-z0-9]+$/`.
fn is_kick_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("sk_") else {
        return false;
    };
    let parts: Vec<&str> = rest.split('_').collect();
    if parts.len() != 3 {
        return false;
    }
    let region: Vec<&str> = parts[0].split('-').collect();
    let alnum = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric());
    region.len() == 3
        && region[0].len() == 2
        && region[0].chars().all(|c| c.is_ascii_lowercase())
        && !region[1].is_empty()
        && region[1].chars().all(|c| c.is_ascii_lowercase())
        && region[2].len() == 1
        && region[2].chars().all(|c| c.is_ascii_digit())
        && alnum(parts[1])
        && alnum(parts[2])
}

/// `streamKeyPlatformMismatch`.
pub fn stream_key_platform_mismatch(field_platform: &str, key: &str) -> Option<String> {
    let detected = detect_stream_key_platform(key)?;
    (detected != field_platform)
        .then(|| copy::key_mismatch(platform_label(detected), platform_label(field_platform)))
}

/// `streamKeyTailHint`: the backend's masked tail.
pub fn stream_key_tail_hint(key: &str) -> String {
    let key = key.trim();
    let chars: Vec<char> = key.chars().collect();
    if chars.len() < 8 {
        return copy::NO_HINT.to_string();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}{tail}", copy::NO_HINT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(platform: &str, scopes: &[&str]) -> PlatformAccount {
        PlatformAccount {
            platform: platform.into(),
            account_id: "acct".into(),
            account_label: "Orc".into(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            ..PlatformAccount::default()
        }
    }

    #[test]
    fn keys_are_told_apart_only_on_a_confident_match() {
        assert_eq!(
            detect_stream_key_platform("live_123456_AbCdEf"),
            Some("twitch")
        );
        assert_eq!(
            detect_stream_key_platform("abcd-efgh-ijkl-mnop"),
            Some("youtube")
        );
        assert_eq!(
            detect_stream_key_platform("sk_us-west-2_AbCd_EfGh"),
            Some("kick")
        );
        assert_eq!(detect_stream_key_platform("abcd-efgh-ijkl"), None);
        assert_eq!(detect_stream_key_platform("hunter2"), None);
        assert_eq!(
            stream_key_platform_mismatch("youtube", " live_1_x "),
            Some(
                "This looks like a Twitch stream key, but you're saving it to YouTube.".to_string()
            )
        );
        assert_eq!(stream_key_platform_mismatch("twitch", "live_1_x"), None);
    }

    #[test]
    fn the_tail_hint_masks_all_but_four() {
        assert_eq!(stream_key_tail_hint("short"), "••••");
        assert_eq!(stream_key_tail_hint("  abcdefgh1234 "), "••••1234");
    }

    #[test]
    fn the_permissions_row_names_what_a_reconnect_adds() {
        let all = twitch_optional_scopes();
        assert_eq!(
            missing_permissions_row("twitch", &account("twitch", &all)),
            None
        );
        let row = missing_permissions_row("twitch", &account("twitch", &[])).unwrap();
        assert_eq!(
            row.message,
            "Reconnect Twitch to let Sidekick remove messages. Follow alerts, the sub count, Power-ups and channel points need it too."
        );
        assert_eq!(row.action, "Reconnect");
        let mut some = all.clone();
        some.retain(|s| *s != "bits:read");
        let row = missing_permissions_row("twitch", &account("twitch", &some)).unwrap();
        assert_eq!(
            row.message,
            "Power-ups and channel points need one more Twitch permission."
        );
        assert_eq!(row.action, "Reconnect Twitch");
        let row = missing_permissions_row("kick", &account("kick", &[])).unwrap();
        assert_eq!(
            row.message,
            "Reconnect Kick to let Sidekick remove messages."
        );
        assert_eq!(
            missing_permissions_row("youtube", &account("youtube", &[])),
            None
        );
    }

    #[test]
    fn an_account_reads_ok_only_once_checked() {
        let mut acct = account("youtube", &[]);
        let valid = AccountValidation {
            platform: "youtube".into(),
            state: ValidationState::Valid,
            message: String::new(),
        };
        assert_eq!(account_status(&acct, None), Status::Unchecked);
        assert_eq!(account_status(&acct, Some(&valid)), Status::Ok);
        acct.status = AccountStatus::NeedsReconnect;
        assert_eq!(account_status(&acct, Some(&valid)), Status::Reconnect);
    }

    #[test]
    fn the_wire_reads_leniently() {
        let accounts: Vec<PlatformAccount> = serde_json::from_value(serde_json::json!([{
            "id": "a", "platform": "twitch", "accountId": "1", "accountLabel": "Orc",
            "scopes": [], "accessTokenPresent": true, "refreshTokenPresent": true,
            "streamKeyPresent": false, "connectedAt": "t", "updatedAt": "t",
            "status": "needs-reconnect", "somethingNew": 1
        }]))
        .unwrap();
        assert_eq!(accounts[0].status, AccountStatus::NeedsReconnect);
    }
}
