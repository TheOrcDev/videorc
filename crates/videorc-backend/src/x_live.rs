use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::streaming::{PlatformAccount, StreamPlatform};

const X_PRODUCER_DOCS_URL: &str = "https://help.x.com/en/using-x/how-to-use-live-producer";
const X_API_OVERVIEW_URL: &str = "https://docs.x.com/x-api/overview";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XNativeLiveCapabilityParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XPrepareParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum XNativeLiveCapabilityState {
    PartnerApiRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XNativeLiveCapability {
    pub platform: StreamPlatform,
    pub state: XNativeLiveCapabilityState,
    pub native_available: bool,
    pub manual_rtmp_available: bool,
    pub oauth_connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    pub message: String,
    pub evidence: Vec<String>,
    pub docs_url: String,
    pub api_overview_url: String,
}

pub fn x_native_live_capability(account: Option<&PlatformAccount>) -> XNativeLiveCapability {
    XNativeLiveCapability {
        platform: StreamPlatform::X,
        state: XNativeLiveCapabilityState::PartnerApiRequired,
        native_available: false,
        manual_rtmp_available: true,
        oauth_connected: account.is_some(),
        account_id: account.map(|account| account.account_id.clone()),
        account_label: account.map(|account| account.account_label.clone()),
        message: "X Media Studio Producer supports RTMP/HLS sources and broadcasts, but the public X API documentation does not expose a self-serve live-video source/broadcast creation endpoint. Native X livestream preparation requires the partner/API path before Videorc can create broadcasts or resolve ingest keys automatically. Switch the X destination to Manual RTMP with a Media Studio Producer stream key, or disable X to go live without it.".to_string(),
        evidence: vec![
            "Media Studio Producer documents RTMP/HLS sources, broadcasts, titles, public/private audience, and encoder-provided RTMP URL/stream key.".to_string(),
            "The current public X API index documents posts, users, spaces, media upload, and data streaming APIs, but not live-video broadcast/source creation endpoints.".to_string(),
            "Manual RTMP must remain an explicit user-selected fallback until the native partner/API path is available.".to_string(),
        ],
        docs_url: X_PRODUCER_DOCS_URL.to_string(),
        api_overview_url: X_API_OVERVIEW_URL.to_string(),
    }
}

pub fn ensure_x_native_live_available(capability: &XNativeLiveCapability) -> Result<()> {
    if capability.native_available {
        return Ok(());
    }

    anyhow::bail!("{}", capability.message)
}

pub fn select_x_account<'a>(
    accounts: &'a [PlatformAccount],
    account_id: Option<&str>,
) -> Result<Option<&'a PlatformAccount>> {
    let account = accounts.iter().find(|account| {
        account.platform == StreamPlatform::X
            && account_id.is_none_or(|account_id| {
                account.account_id == account_id || account.id == account_id
            })
    });
    if account_id.is_some() {
        account.context("No connected X OAuth account matched the requested account id.")?;
    }

    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming::{PlatformAccountStatus, StreamPlatform};

    #[test]
    fn capability_reports_partner_api_gap_without_hiding_manual_rtmp() {
        let account = PlatformAccount {
            id: "x".to_string(),
            platform: StreamPlatform::X,
            account_id: "x-123".to_string(),
            account_label: "Videorc".to_string(),
            account_handle: Some("@videorc".to_string()),
            avatar_url: None,
            scopes: vec!["tweet.read".to_string(), "users.read".to_string()],
            access_token_present: true,
            refresh_token_present: true,
            stream_key_present: false,
            expires_at: None,
            connected_at: "2026-06-03T00:00:00Z".to_string(),
            updated_at: "2026-06-03T00:00:00Z".to_string(),
            status: PlatformAccountStatus::Connected,
        };

        let capability = x_native_live_capability(Some(&account));

        assert_eq!(capability.platform, StreamPlatform::X);
        assert_eq!(
            capability.state,
            XNativeLiveCapabilityState::PartnerApiRequired
        );
        assert!(!capability.native_available);
        assert!(capability.manual_rtmp_available);
        assert!(capability.oauth_connected);
        assert_eq!(capability.account_id.as_deref(), Some("x-123"));
        assert!(capability.message.contains("partner/API path"));
        assert!(capability.evidence.iter().any(|item| item.contains("RTMP")));
        assert!(ensure_x_native_live_available(&capability).is_err());
    }

    #[test]
    fn selecting_x_account_honors_requested_provider_or_backend_id() {
        let account = PlatformAccount {
            id: "backend-id".to_string(),
            platform: StreamPlatform::X,
            account_id: "provider-id".to_string(),
            account_label: "Videorc".to_string(),
            account_handle: None,
            avatar_url: None,
            scopes: Vec::new(),
            access_token_present: true,
            refresh_token_present: false,
            stream_key_present: false,
            expires_at: None,
            connected_at: "2026-06-03T00:00:00Z".to_string(),
            updated_at: "2026-06-03T00:00:00Z".to_string(),
            status: PlatformAccountStatus::Connected,
        };
        let accounts = vec![account];

        assert_eq!(
            select_x_account(&accounts, Some("provider-id"))
                .unwrap()
                .unwrap()
                .account_id,
            "provider-id"
        );
        assert_eq!(
            select_x_account(&accounts, Some("backend-id"))
                .unwrap()
                .unwrap()
                .id,
            "backend-id"
        );
        assert!(select_x_account(&accounts, Some("missing")).is_err());
    }
}
