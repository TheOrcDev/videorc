use anyhow::Result;
use sha2::{Digest, Sha256};
use std::future::Future;

use crate::protocol::{AccountStatus, VideorcAccountSnapshot};
use crate::secrets;
use crate::videorc_api::{SessionRefresh, SessionStatus, VerifiedSession, VideorcApiClient};

// Real web auth: complete_sign_in exchanges a state + PKCE-bound authorization code with
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
const LAST_SIGN_IN_BINDING_SECRET: &str = "account:videorc:last-sign-in-binding";
const LEGACY_LAST_SIGN_IN_STATE_SECRET: &str = "account:videorc:last-sign-in-state";
const SIGN_IN_INTENT_GENERATION_SECRET: &str = "account:videorc:sign-in-intent-generation";
const MAX_SIGN_IN_INTENT_GENERATION: u64 = 9_007_199_254_740_991;
// The last server-minted signed entitlement token (Ed25519, verified before
// every use) — persisting it gives a premium user offline grace across
// restarts until the token's own expiry.
const ENTITLEMENT_TOKEN_SECRET: &str = "account:videorc:entitlement-token";

#[derive(Debug, thiserror::Error)]
#[error("Desktop account sign-in was superseded by a newer account intent.")]
pub struct AccountSignInSuperseded;

pub fn is_sign_in_superseded(error: &anyhow::Error) -> bool {
    error.downcast_ref::<AccountSignInSuperseded>().is_some()
}

fn parse_sign_in_intent_generation(raw: Option<&str>) -> Result<u64> {
    let Some(raw) = raw else {
        return Ok(0);
    };
    let generation = raw
        .parse::<u64>()
        .map_err(|_| anyhow::anyhow!("Stored account sign-in intent generation was invalid."))?;
    if generation.to_string() != raw {
        anyhow::bail!("Stored account sign-in intent generation was invalid.");
    }
    if generation > MAX_SIGN_IN_INTENT_GENERATION {
        anyhow::bail!("Stored account sign-in intent generation was invalid.");
    }
    Ok(generation)
}

pub fn current_sign_in_intent_generation() -> Result<u64> {
    let raw = secrets::try_get_secret(SIGN_IN_INTENT_GENERATION_SECRET)?;
    parse_sign_in_intent_generation(raw.as_deref())
}

fn next_sign_in_intent_generation() -> Result<u64> {
    let current = current_sign_in_intent_generation()?;
    if current >= MAX_SIGN_IN_INTENT_GENERATION {
        anyhow::bail!("Account sign-in intent generation was exhausted.");
    }
    Ok(current + 1)
}

pub fn advance_sign_in_intent_generation() -> Result<u64> {
    let generation = next_sign_in_intent_generation()?;
    let serialized = generation.to_string();
    secrets::put_secret(SIGN_IN_INTENT_GENERATION_SECRET, &serialized)?;
    Ok(generation)
}

fn ensure_current_sign_in_intent(generation: u64) -> Result<()> {
    ensure_sign_in_intent_matches(generation, current_sign_in_intent_generation()?)
}

fn ensure_sign_in_intent_matches(generation: u64, current_generation: u64) -> Result<()> {
    if generation == 0 || current_generation != generation {
        return Err(AccountSignInSuperseded.into());
    }
    Ok(())
}

async fn await_for_sign_in_intent_with<T>(
    generation: u64,
    current_generation: impl Fn() -> Result<u64>,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    ensure_sign_in_intent_matches(generation, current_generation()?)?;
    let value = future.await?;
    // The network exchange is the only await between the two checks. The
    // command handler also holds AppState.account_auth_transition through the
    // eventual secret commit, closing the post-check TOCTOU window.
    ensure_sign_in_intent_matches(generation, current_generation()?)?;
    Ok(value)
}

async fn await_for_current_sign_in_intent<T>(
    generation: u64,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    await_for_sign_in_intent_with(generation, current_sign_in_intent_generation, future).await
}

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

// Resolve a dev-only mock token into an account so the sign-in UI remains
// exercisable without the companion web service. The real deep-link path uses
// `complete_sign_in` below and never accepts this shortcut in release builds.
pub fn complete_mock_sign_in(token: &str, dev_build: bool) -> Option<VideorcAccountSnapshot> {
    let token = token.trim();
    if dev_build && !token.is_empty() {
        return Some(signed_in_mock(token));
    }
    None
}

// Resolve the deep-link authorization code into a real account by exchanging it with
// videorc-web for a durable session token. On failure, dev builds fall back to
// the mock (so offline local dev still works) and release builds stay signed-out.
pub async fn complete_sign_in(
    code: &str,
    state: &str,
    verifier: &str,
    intent_generation: u64,
    dev_build: bool,
) -> Result<VideorcAccountSnapshot> {
    let code = code.trim();
    let state = state.trim();
    let verifier = verifier.trim();
    if code.is_empty() || state.is_empty() || verifier.is_empty() {
        anyhow::bail!("Desktop authorization callback was incomplete.");
    }
    ensure_current_sign_in_intent(intent_generation)?;
    let replay_binding = sign_in_replay_binding(code, state);
    if secrets::try_get_secret(LAST_SIGN_IN_BINDING_SECRET)
        .ok()
        .flatten()
        .is_some_and(|completed_binding| completed_binding == replay_binding)
        && let Some(snapshot) = restore_persisted_account()
    {
        ensure_current_sign_in_intent(intent_generation)?;
        return Ok(snapshot);
    }
    match exchange_desktop_authorization(code, state, verifier, intent_generation, &replay_binding)
        .await
    {
        Ok(snapshot) => Ok(snapshot),
        Err(error) if is_sign_in_superseded(&error) => Err(error),
        Err(error) => {
            // Never log the authorization code or verifier — only the error context.
            eprintln!("videorc sign-in failed: {error:#}");
            if dev_build {
                Ok(complete_mock_sign_in(state, true).unwrap_or_else(signed_out_account))
            } else {
                Err(error)
            }
        }
    }
}

async fn exchange_desktop_authorization(
    code: &str,
    state: &str,
    verifier: &str,
    intent_generation: u64,
    replay_binding: &str,
) -> Result<VideorcAccountSnapshot> {
    let client = VideorcApiClient::new()?;
    let verified = await_for_current_sign_in_intent(
        intent_generation,
        client.verify_desktop_authorization(code, state, verifier),
    )
    .await?;
    let snapshot = signed_in_from_verified(&verified);
    persist_account_with_replay_binding(&verified.session_token, &snapshot, replay_binding)?;
    Ok(snapshot)
}

fn sign_in_replay_binding(code: &str, state: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(state.as_bytes());
    digest.update([0]);
    digest.update(code.as_bytes());
    format!("{:x}", digest.finalize())
}

fn signed_in_from_verified(verified: &VerifiedSession) -> VideorcAccountSnapshot {
    snapshot_from_identity(
        verified.name.clone(),
        verified.email.clone(),
        verified.image.clone(),
    )
}

fn snapshot_from_identity(
    name: Option<String>,
    email: String,
    avatar_url: Option<String>,
) -> VideorcAccountSnapshot {
    VideorcAccountSnapshot {
        status: AccountStatus::SignedIn,
        username: Some(name.clone().unwrap_or_else(|| email.clone())),
        display_name: name,
        email: Some(email),
        avatar_url,
    }
}

fn persist_account(session_token: &str, snapshot: &VideorcAccountSnapshot) -> Result<()> {
    let snapshot_json = serde_json::to_string(snapshot)?;
    secrets::put_secrets(&[
        (SESSION_TOKEN_SECRET, session_token),
        (ACCOUNT_SNAPSHOT_SECRET, snapshot_json.as_str()),
    ])
}

fn persist_account_with_replay_binding(
    session_token: &str,
    snapshot: &VideorcAccountSnapshot,
    replay_binding: &str,
) -> Result<()> {
    let snapshot_json = serde_json::to_string(snapshot)?;
    secrets::put_secrets(&[
        (SESSION_TOKEN_SECRET, session_token),
        (ACCOUNT_SNAPSHOT_SECRET, snapshot_json.as_str()),
        (LAST_SIGN_IN_BINDING_SECRET, replay_binding),
    ])
}

// Restore the signed-in account from the local secrets store at startup (no
// network). Returns None when there is no stored token.
pub fn restore_persisted_account() -> Option<VideorcAccountSnapshot> {
    let token = secrets::try_get_secret(SESSION_TOKEN_SECRET)
        .ok()
        .flatten()?;
    if token.trim().is_empty() {
        return None;
    }
    let raw = secrets::try_get_secret(ACCOUNT_SNAPSHOT_SECRET)
        .ok()
        .flatten()?;
    serde_json::from_str(&raw).ok()
}

// Clear the stored token + snapshot (Sign out). Tolerant of already-absent keys.
pub fn clear_persisted_account() {
    let _ = secrets::delete_secrets(&[
        SESSION_TOKEN_SECRET,
        ACCOUNT_SNAPSHOT_SECRET,
        LAST_SIGN_IN_BINDING_SECRET,
        LEGACY_LAST_SIGN_IN_STATE_SECRET,
        ENTITLEMENT_TOKEN_SECRET,
    ]);
}

/// Explicit desktop sign-out is also a durable account-intent tombstone. The
/// generation advance and credential deletion share one secret-store commit so
/// a crash cannot leave an acknowledged sign-out open to an older callback.
pub fn clear_persisted_account_and_advance_intent() -> Result<u64> {
    let generation = next_sign_in_intent_generation()?;
    let serialized = generation.to_string();
    secrets::update_secrets(
        &[(SIGN_IN_INTENT_GENERATION_SECRET, serialized.as_str())],
        &[
            SESSION_TOKEN_SECRET,
            ACCOUNT_SNAPSHOT_SECRET,
            LAST_SIGN_IN_BINDING_SECRET,
            LEGACY_LAST_SIGN_IN_STATE_SECRET,
            ENTITLEMENT_TOKEN_SECRET,
        ],
    )?;
    Ok(generation)
}

// Persist the latest verified signed entitlement token (best-effort: failing
// to persist only costs offline grace, never entitlement correctness).
pub fn persist_entitlement_token(token: &str) {
    if let Err(error) = secrets::put_secret(ENTITLEMENT_TOKEN_SECRET, token) {
        tracing::warn!("Could not persist the entitlement token: {error:#}");
    }
}

pub fn stored_entitlement_token() -> Option<String> {
    secrets::try_get_secret(ENTITLEMENT_TOKEN_SECRET)
        .ok()
        .flatten()
        .filter(|token| !token.trim().is_empty())
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
        SessionStatus::Active { name, email, image } => {
            let snapshot = snapshot_from_identity(name, email, image);
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
        avatar_url: None,
    }
}

pub fn signed_out_account() -> VideorcAccountSnapshot {
    VideorcAccountSnapshot {
        status: AccountStatus::SignedOut,
        username: None,
        display_name: None,
        email: None,
        avatar_url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn sign_in_replay_binding_requires_the_exact_state_and_code() {
        let binding = sign_in_replay_binding("code-a", "state-a");
        assert_eq!(binding, sign_in_replay_binding("code-a", "state-a"));
        assert_ne!(binding, sign_in_replay_binding("code-b", "state-a"));
        assert_ne!(binding, sign_in_replay_binding("code-a", "state-b"));
    }

    #[test]
    fn sign_in_intent_generation_is_canonical_bounded_and_never_zero_when_current() {
        assert_eq!(parse_sign_in_intent_generation(None).unwrap(), 0);
        assert_eq!(parse_sign_in_intent_generation(Some("7")).unwrap(), 7);
        assert!(parse_sign_in_intent_generation(Some("07")).is_err());
        assert!(parse_sign_in_intent_generation(Some("-1")).is_err());
        assert!(parse_sign_in_intent_generation(Some("9007199254740992")).is_err());
        assert!(is_sign_in_superseded(
            &ensure_sign_in_intent_matches(0, 0).unwrap_err()
        ));
        assert!(is_sign_in_superseded(
            &ensure_sign_in_intent_matches(6, 7).unwrap_err()
        ));
        ensure_sign_in_intent_matches(7, 7).unwrap();
    }

    #[tokio::test]
    async fn generation_advance_while_exchange_awaits_makes_completion_terminally_stale() {
        let generation = Arc::new(AtomicU64::new(1));
        let exchange_started = Arc::new(tokio::sync::Notify::new());
        let release_exchange = Arc::new(tokio::sync::Notify::new());
        let task_generation = generation.clone();
        let task_started = exchange_started.clone();
        let task_release = release_exchange.clone();
        let completion = tokio::spawn(async move {
            await_for_sign_in_intent_with(
                1,
                move || Ok(task_generation.load(Ordering::Acquire)),
                async move {
                    task_started.notify_one();
                    task_release.notified().await;
                    Ok("verified")
                },
            )
            .await
        });

        exchange_started.notified().await;
        generation.store(2, Ordering::Release);
        release_exchange.notify_one();

        let error = completion.await.unwrap().unwrap_err();
        assert!(is_sign_in_superseded(&error));
    }

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
            avatar_url: Some("https://example.public.blob.vercel-storage.com/a.png".to_string()),
        };
        let json = serde_json::to_string(&account).unwrap();
        assert!(json.contains("\"status\":\"signed-in\""));
        assert!(json.contains("\"displayName\":\"Orc Dev\""));
        assert!(json.contains("\"avatarUrl\""));
        let restored: VideorcAccountSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, account);
    }

    // Snapshots persisted before avatars existed must keep restoring (the
    // secrets file outlives releases) — a missing avatarUrl is simply None.
    #[test]
    fn pre_avatar_persisted_snapshots_still_restore() {
        let old_json = r#"{"status":"signed-in","username":"orc_dev","displayName":"Orc Dev","email":"orc@videorc.com"}"#;
        let restored: VideorcAccountSnapshot = serde_json::from_str(old_json).unwrap();
        assert_eq!(restored.avatar_url, None);
        assert_eq!(restored.display_name.as_deref(), Some("Orc Dev"));
    }
}
