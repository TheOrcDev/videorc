//! OAuth access tokens for session tasks that run all stream long (plan 055,
//! B2). A connector used to capture its token once at session start. A Twitch
//! user token lasts about four hours and a Google one about an hour, so a long
//! stream silently lost chat and viewer counts on the first refusal.
//!
//! [`SessionToken`] keeps the task's current token. It renews the token when
//! the stored one nears expiry and after the provider refuses it. When no
//! renewal is possible (a fixture token, or a revoked refresh token), the
//! caller reports a clear `failed` state instead of going quiet.

use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};

use crate::state::AppState;
use crate::streaming::StreamPlatform;

/// How often a task re-checks the stored expiry before a call. The check reads
/// the account row, so it is not made on every chat poll.
const FRESHNESS_CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// Where a session task's access token comes from.
#[derive(Debug, Clone, Default)]
pub enum SessionTokenSource {
    /// Only the token the task started with: fixtures, smokes and tests.
    #[default]
    Fixed,
    /// A stored account: refreshed near expiry and after a refusal.
    Account {
        platform: StreamPlatform,
        account_id: Option<String>,
    },
    /// Test double: each renewal takes the next scripted outcome.
    #[cfg(test)]
    Scripted(std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<Result<String, String>>>>),
}

impl SessionTokenSource {
    pub fn account(platform: StreamPlatform, account_id: impl Into<String>) -> Self {
        Self::Account {
            platform,
            account_id: Some(account_id.into()),
        }
    }

    #[cfg(test)]
    pub fn scripted(renewals: Vec<Result<&str, &str>>) -> Self {
        Self::Scripted(std::sync::Arc::new(std::sync::Mutex::new(
            renewals
                .into_iter()
                .map(|outcome| outcome.map(str::to_string).map_err(str::to_string))
                .collect(),
        )))
    }
}

/// A task's current token and how to renew it.
#[derive(Debug, Clone)]
pub struct SessionToken {
    source: SessionTokenSource,
    current: String,
    checked_at: Option<Instant>,
}

impl SessionToken {
    pub fn new(initial: impl Into<String>, source: SessionTokenSource) -> Self {
        Self {
            source,
            current: initial.into(),
            checked_at: Some(Instant::now()),
        }
    }

    /// A token whose freshness is checked on the first `ensure_fresh`.
    pub fn unchecked(initial: impl Into<String>, source: SessionTokenSource) -> Self {
        Self {
            source,
            current: initial.into(),
            checked_at: None,
        }
    }

    pub fn current(&self) -> &str {
        &self.current
    }

    /// Before a call: takes a refreshed token when the stored one is near
    /// expiry (or another task already refreshed it). A failed check keeps
    /// the current token; the call itself then shows whether it still works.
    pub async fn ensure_fresh(&mut self, state: &AppState, client: &reqwest::Client) -> &str {
        let due = self
            .checked_at
            .is_none_or(|checked_at| checked_at.elapsed() >= FRESHNESS_CHECK_INTERVAL);
        if due
            && let SessionTokenSource::Account {
                platform,
                account_id,
            } = &self.source
        {
            self.checked_at = Some(Instant::now());
            if let Ok(token) = crate::session_platform_access_token(
                state,
                *platform,
                account_id.as_deref(),
                client,
                None,
            )
            .await
            {
                self.current = token;
            }
        }
        &self.current
    }

    /// After the provider refused the current token: renews it once. `Err`
    /// means the account must be reconnected (or the token is fixed).
    pub async fn renew_after_refusal(
        &mut self,
        state: &AppState,
        client: &reqwest::Client,
    ) -> Result<&str> {
        let renewed = match &self.source {
            SessionTokenSource::Fixed => Err(anyhow!("The access token cannot be renewed.")),
            SessionTokenSource::Account {
                platform,
                account_id,
            } => {
                crate::session_platform_access_token(
                    state,
                    *platform,
                    account_id.as_deref(),
                    client,
                    Some(&self.current),
                )
                .await
            }
            #[cfg(test)]
            SessionTokenSource::Scripted(renewals) => renewals
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err("No scripted renewal left.".to_string()))
                .map_err(|error| anyhow!(error)),
        }?;
        self.current = renewed;
        self.checked_at = Some(Instant::now());
        Ok(&self.current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(8);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    #[tokio::test]
    async fn a_fixed_token_is_never_renewed() {
        let state = test_state();
        let client = reqwest::Client::new();
        let mut token = SessionToken::new("fixture", SessionTokenSource::Fixed);
        assert_eq!(token.ensure_fresh(&state, &client).await, "fixture");
        assert!(token.renew_after_refusal(&state, &client).await.is_err());
        assert_eq!(token.current(), "fixture");
    }

    #[tokio::test]
    async fn scripted_renewals_replace_the_token_until_one_fails() {
        let state = test_state();
        let client = reqwest::Client::new();
        let mut token = SessionToken::new(
            "first",
            SessionTokenSource::scripted(vec![Ok("second"), Err("revoked")]),
        );
        assert_eq!(
            token.renew_after_refusal(&state, &client).await.unwrap(),
            "second"
        );
        assert!(token.renew_after_refusal(&state, &client).await.is_err());
        assert_eq!(token.current(), "second");
    }

    #[tokio::test]
    async fn an_account_without_stored_credentials_cannot_renew() {
        let state = test_state();
        let client = reqwest::Client::new();
        let mut token = SessionToken::new(
            "stale",
            SessionTokenSource::account(StreamPlatform::Twitch, "missing"),
        );
        let error = token
            .renew_after_refusal(&state, &client)
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("No connected Twitch OAuth account")
        );
        assert_eq!(token.current(), "stale");
    }
}
