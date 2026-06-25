use anyhow::Result;

use crate::protocol::{AccountStatus, VideorcAccountSnapshot};
use crate::secrets;
use crate::videorc_api::{SessionRefresh, SessionStatus, VerifiedSession, VideorcApiClient};

// Real web auth: complete_sign_in exchanges the deep-link one-time token with
// videorc-web for a durable session token (stored in the secrets file) and the
// account identity. Two dev-only stand-ins remain for offline local work, neither
// of which can affect a production build:
//   * VIDEORC_MOCK_ACCOUNT=username — a dev/debug-only env override (mock_account_from_env).
//   * complete_mock_sign_in — a dev/debug-only fallback when the exchange fails.
// Release builds ignore both and stay signed-out, so production can never be
// spoofed into a signed-in state.
pub const MOCK_ACCOUNT_ENV_VAR: &str = "VIDEORC_MOCK_ACCOUNT";

// Persisted across restarts in the local secrets store (0600 JSON file). The
// durable session token is sent as a Bearer to the Videorc API; the snapshot is
// the cached identity so the app can show the signed-in user at boot offline.
const SESSION_TOKEN_SECRET: &str = "account:videorc:session";
const ACCOUNT_SNAPSHOT_SECRET: &str = "account:videorc:snapshot";

// Resolve the effective account: an explicit in-memory session override wins
// (set by the deep-link sign-in or by Sign out); otherwise fall back to the
// dev-only env mock, otherwise signed-out.
pub fn current_account(
    session_override: Option<&VideorcAccountSnapshot>,
) -> VideorcAccountSnapshot {
    match session_override {
        Some(snapshot) => snapshot.clone(),
        None => mock_account_from_env(
            std::env::var(MOCK_ACCOUNT_ENV_VAR).ok().as_deref(),
            cfg!(debug_assertions),
        ),
    }
}

fn mock_account_from_env(value: Option<&str>, dev_build: bool) -> VideorcAccountSnapshot {
    match value.map(str::trim).filter(|username| !username.is_empty()) {
        Some(username) if dev_build => signed_in_mock(username),
        _ => signed_out_account(),
    }
}

// Resolve a session token delivered by the account deep-link into an account.
// Real resolution exchanges the token with videorc.com (not built); dev builds
// accept a mock token (the token string is used as the username) so the sign-in
// flow is exercisable. Release builds resolve nothing → caller stays signed-out.
pub fn complete_mock_sign_in(token: &str, dev_build: bool) -> Option<VideorcAccountSnapshot> {
    let token = token.trim();
    if dev_build && !token.is_empty() {
        return Some(signed_in_mock(token));
    }
    None
}

// Resolve the deep-link one-time token into a real account by exchanging it with
// videorc-web for a durable session token. On failure, dev builds fall back to
// the mock (so offline local dev still works) and release builds stay signed-out.
pub async fn complete_sign_in(one_time_token: &str, dev_build: bool) -> VideorcAccountSnapshot {
    let one_time_token = one_time_token.trim();
    if one_time_token.is_empty() {
        return signed_out_account();
    }
    match exchange_one_time_token(one_time_token).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            // Never log the token — only the error context.
            eprintln!("videorc sign-in failed: {error:#}");
            if dev_build {
                complete_mock_sign_in(one_time_token, true).unwrap_or_else(signed_out_account)
            } else {
                signed_out_account()
            }
        }
    }
}

async fn exchange_one_time_token(one_time_token: &str) -> Result<VideorcAccountSnapshot> {
    let client = VideorcApiClient::new()?;
    let verified = client.verify_one_time_token(one_time_token).await?;
    let snapshot = signed_in_from_verified(&verified);
    persist_account(&verified.session_token, &snapshot)?;
    Ok(snapshot)
}

fn signed_in_from_verified(verified: &VerifiedSession) -> VideorcAccountSnapshot {
    snapshot_from_identity(verified.name.clone(), verified.email.clone())
}

fn snapshot_from_identity(name: Option<String>, email: String) -> VideorcAccountSnapshot {
    VideorcAccountSnapshot {
        status: AccountStatus::SignedIn,
        username: Some(name.clone().unwrap_or_else(|| email.clone())),
        display_name: name,
        email: Some(email),
    }
}

fn persist_account(session_token: &str, snapshot: &VideorcAccountSnapshot) -> Result<()> {
    secrets::put_secret(SESSION_TOKEN_SECRET, session_token)?;
    secrets::put_secret(ACCOUNT_SNAPSHOT_SECRET, &serde_json::to_string(snapshot)?)?;
    Ok(())
}

// Restore the signed-in account from the local secrets store at startup (no
// network). Returns None when there is no stored token.
pub fn restore_persisted_account() -> Option<VideorcAccountSnapshot> {
    let token = secrets::try_get_secret(SESSION_TOKEN_SECRET).ok().flatten()?;
    if token.trim().is_empty() {
        return None;
    }
    let raw = secrets::try_get_secret(ACCOUNT_SNAPSHOT_SECRET).ok().flatten()?;
    serde_json::from_str(&raw).ok()
}

// Clear the stored token + snapshot (Sign out). Tolerant of already-absent keys.
pub fn clear_persisted_account() {
    let _ = secrets::delete_secret(SESSION_TOKEN_SECRET);
    let _ = secrets::delete_secret(ACCOUNT_SNAPSHOT_SECRET);
}

// Read the stored durable session token (for Bearer-authed Videorc API calls).
pub fn stored_session_token() -> Option<String> {
    secrets::try_get_secret(SESSION_TOKEN_SECRET)
        .ok()
        .flatten()
        .filter(|token| !token.trim().is_empty())
}

// Validate the stored token against videorc-web and refresh the cached identity.
// A dead token (401 / no session) signs the user out; a transient network error
// keeps the cached account. A rotated token is persisted to avoid a future 401.
pub async fn refresh_account() -> VideorcAccountSnapshot {
    let Some(token) = stored_session_token() else {
        return signed_out_account();
    };
    let client = match VideorcApiClient::new() {
        Ok(client) => client,
        Err(_) => return restore_persisted_account().unwrap_or_else(signed_out_account),
    };
    match client.get_session(&token).await {
        Ok(refresh) => apply_session_refresh(token, refresh),
        Err(error) => {
            // Transient failure — keep the cached account rather than signing out.
            eprintln!("videorc session check failed: {error:#}");
            restore_persisted_account().unwrap_or_else(signed_out_account)
        }
    }
}

fn apply_session_refresh(current_token: String, refresh: SessionRefresh) -> VideorcAccountSnapshot {
    match refresh.status {
        SessionStatus::Unauthorized => {
            clear_persisted_account();
            signed_out_account()
        }
        SessionStatus::Active { name, email } => {
            let snapshot = snapshot_from_identity(name, email);
            let token = refresh.rotated_token.unwrap_or(current_token);
            let _ = persist_account(&token, &snapshot);
            snapshot
        }
    }
}

fn signed_in_mock(username: &str) -> VideorcAccountSnapshot {
    VideorcAccountSnapshot {
        status: AccountStatus::SignedIn,
        username: Some(username.to_string()),
        display_name: None,
        email: None,
    }
}

pub fn signed_out_account() -> VideorcAccountSnapshot {
    VideorcAccountSnapshot {
        status: AccountStatus::SignedOut,
        username: None,
        display_name: None,
        email: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_account_is_signed_out_without_an_override_or_mock_env() {
        // No override and no VIDEORC_MOCK_ACCOUNT in the test env -> signed-out.
        let account = current_account(None);
        assert_eq!(account.status, AccountStatus::SignedOut);
        assert!(account.username.is_none());
    }

    #[test]
    fn an_in_memory_session_override_wins_over_the_env_mock() {
        let signed_in = signed_in_mock("orc_dev");
        assert_eq!(current_account(Some(&signed_in)), signed_in);
        // An explicit signed-out override (from Sign out) also wins.
        assert_eq!(
            current_account(Some(&signed_out_account())).status,
            AccountStatus::SignedOut
        );
    }

    #[test]
    fn mock_account_signs_in_only_in_dev_builds_with_the_env_set() {
        let mocked = mock_account_from_env(Some("orc_dev"), true);
        assert_eq!(mocked.status, AccountStatus::SignedIn);
        assert_eq!(mocked.username.as_deref(), Some("orc_dev"));
    }

    #[test]
    fn release_builds_ignore_the_mock_env_and_stay_signed_out() {
        assert_eq!(
            mock_account_from_env(Some("orc_dev"), false),
            signed_out_account()
        );
        assert_eq!(mock_account_from_env(None, true), signed_out_account());
        assert_eq!(
            mock_account_from_env(Some("   "), true),
            signed_out_account()
        );
    }

    #[test]
    fn deep_link_token_resolves_to_an_account_only_in_dev_builds() {
        let resolved = complete_mock_sign_in("orc_dev", true).unwrap();
        assert_eq!(resolved.status, AccountStatus::SignedIn);
        assert_eq!(resolved.username.as_deref(), Some("orc_dev"));
        // Release builds have no resolver, and blank tokens never resolve.
        assert!(complete_mock_sign_in("orc_dev", false).is_none());
        assert!(complete_mock_sign_in("   ", true).is_none());
    }

    #[test]
    fn signed_out_account_omits_optional_fields_and_round_trips() {
        let json = serde_json::to_string(&signed_out_account()).unwrap();
        assert_eq!(json, r#"{"status":"signed-out"}"#);
        let restored: VideorcAccountSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, signed_out_account());
    }

    #[test]
    fn signed_in_account_serializes_identity_fields_in_camel_case() {
        let account = VideorcAccountSnapshot {
            status: AccountStatus::SignedIn,
            username: Some("orc_dev".to_string()),
            display_name: Some("Orc Dev".to_string()),
            email: Some("orc@videorc.com".to_string()),
        };
        let json = serde_json::to_string(&account).unwrap();
        assert!(json.contains("\"status\":\"signed-in\""));
        assert!(json.contains("\"displayName\":\"Orc Dev\""));
        let restored: VideorcAccountSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, account);
    }
}
