//! The Windows pilot feed: who may read it, and when it is asked.
//!
//! A port of `windows-pilot-update.ts` with its tests. Electron's config
//! also switches off differential downloads for the pilot feed; the Rust
//! updater never does them, so that field is gone.

use std::collections::HashMap;
use std::fmt;

pub const WINDOWS_PILOT_UPDATE_URL: &str = "https://www.videorc.com/api/updates/windows-pilot/";

/// Set to `1` to pin every check to the pilot feed (operator mode).
pub const WINDOWS_PILOT_UPDATE_ENV: &str = "VIDEORC_WINDOWS_PILOT_UPDATE";
/// The operator's bearer for the pilot feed.
pub const WINDOWS_PILOT_UPDATE_TOKEN_ENV: &str = "VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN";
/// Set to `1` to switch off the silent background checks.
pub const DISABLE_AUTO_UPDATE_ENV: &str = "VIDEORC_DISABLE_AUTO_UPDATE";

/// How the pilot feed is read.
#[derive(Clone, PartialEq, Eq)]
pub struct WindowsPilotUpdaterConfig {
    /// The `Authorization` header: `Bearer` and the token.
    pub authorization: String,
    pub url: &'static str,
}

impl fmt::Debug for WindowsPilotUpdaterConfig {
    /// The bearer never reaches a log, a panic message or a support bundle.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsPilotUpdaterConfig")
            .field("authorization", &"Bearer <hidden>")
            .field("url", &self.url)
            .finish()
    }
}

/// Why the pilot override was refused. The updater fails closed on each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PilotConfigError {
    Mode,
    Platform,
    Token,
}

impl fmt::Display for PilotConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Mode => "VIDEORC_WINDOWS_PILOT_UPDATE must be 1 when configured.",
            Self::Platform => "The pilot updater override is Windows-only.",
            Self::Token => {
                "VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN must contain 32-256 visible ASCII characters."
            }
        })
    }
}

impl std::error::Error for PilotConfigError {}

fn is_visible_ascii(text: &str) -> bool {
    text.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

/// The operator's pilot config, from the two variables' values. `None` when
/// the override is not set.
pub fn windows_pilot_updater_config(
    mode: Option<&str>,
    token: Option<&str>,
    on_windows: bool,
) -> Result<Option<WindowsPilotUpdaterConfig>, PilotConfigError> {
    let mode = mode.map(str::trim).unwrap_or_default();
    if mode.is_empty() {
        return Ok(None);
    }
    if mode != "1" {
        return Err(PilotConfigError::Mode);
    }
    if !on_windows {
        return Err(PilotConfigError::Platform);
    }
    let token = token.map(str::trim).unwrap_or_default();
    if !(32..=256).contains(&token.len()) || !is_visible_ascii(token) {
        return Err(PilotConfigError::Token);
    }
    Ok(Some(WindowsPilotUpdaterConfig {
        authorization: format!("Bearer {token}"),
        url: WINDOWS_PILOT_UPDATE_URL,
    }))
}

/// The variables an updater reads at startup, and can remove.
pub trait UpdaterEnvironment {
    fn get(&self, name: &str) -> Option<String>;
    fn remove(&mut self, name: &str);
}

impl UpdaterEnvironment for HashMap<String, String> {
    fn get(&self, name: &str) -> Option<String> {
        HashMap::get(self, name).cloned()
    }

    fn remove(&mut self, name: &str) {
        HashMap::remove(self, name);
    }
}

/// What the updater starts with on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsUpdaterStartupConfig {
    pub background_updates_disabled: bool,
    pub pilot: Option<WindowsPilotUpdaterConfig>,
}

/// Reads the startup config and removes the token from the environment,
/// whatever the answer. The configured updater owns the only copy that is
/// needed. The bearer must never reach the backend, a helper, FFmpeg or a
/// support bundle, even when background checks are disabled or the config
/// is invalid.
pub fn consume_windows_updater_startup_config(
    environment: &mut impl UpdaterEnvironment,
    on_windows: bool,
) -> Result<WindowsUpdaterStartupConfig, PilotConfigError> {
    let mode = environment.get(WINDOWS_PILOT_UPDATE_ENV);
    let token = environment.get(WINDOWS_PILOT_UPDATE_TOKEN_ENV);
    environment.remove(WINDOWS_PILOT_UPDATE_TOKEN_ENV);
    let pilot = windows_pilot_updater_config(mode.as_deref(), token.as_deref(), on_windows)?;
    Ok(WindowsUpdaterStartupConfig {
        background_updates_disabled: environment.get(DISABLE_AUTO_UPDATE_ENV).as_deref()
            == Some("1"),
        pilot,
    })
}

// Signed-in pilot access. While Windows is in pilot, /account/download hands
// every signed-in user the pilot installer, so a signed-in install follows
// the pilot feed too. The backend exchanges the account session for a
// short-lived token that reads only this feed; the session never reaches
// the app.

/// A short-lived token for the pilot feed.
#[derive(Clone, PartialEq, Eq)]
pub struct WindowsPilotUpdateGrant {
    pub token: String,
    pub expires_at: String,
}

impl fmt::Debug for WindowsPilotUpdateGrant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WindowsPilotUpdateGrant")
            .field("token", &"<hidden>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// Whether a grant is well formed: `wpu1.` and 1 to 507 visible ASCII
/// characters.
pub fn is_windows_pilot_update_grant(grant: &WindowsPilotUpdateGrant) -> bool {
    match grant.token.strip_prefix("wpu1.") {
        Some(rest) => (1..=507).contains(&rest.len()) && is_visible_ascii(rest),
        None => false,
    }
}

/// How the pilot feed is read with an account's grant: through the branded
/// proxy, never anywhere else.
pub fn account_pilot_updater_config(grant: &WindowsPilotUpdateGrant) -> WindowsPilotUpdaterConfig {
    WindowsPilotUpdaterConfig {
        authorization: format!("Bearer {}", grant.token),
        url: WINDOWS_PILOT_UPDATE_URL,
    }
}

/// What the public feed answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicFeedOutcome {
    Available,
    NotAvailable,
    MissingFeed,
    Failed,
}

/// The public feed always wins when it has something newer; the pilot feed
/// is only consulted when public has nothing for this install (no feed yet,
/// or already up to date with it). The pilot pointer can trail public after
/// a promotion, so it is never the only feed checked. A transport failure is
/// not a reason to probe: the check reports it as it is.
pub fn should_probe_account_pilot_feed(
    operator_pilot: bool,
    on_windows: bool,
    public_outcome: PublicFeedOutcome,
) -> bool {
    on_windows
        && !operator_pilot
        && matches!(
            public_outcome,
            PublicFeedOutcome::MissingFeed | PublicFeedOutcome::NotAvailable
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    fn grant(token: &str) -> WindowsPilotUpdateGrant {
        WindowsPilotUpdateGrant {
            token: token.to_string(),
            expires_at: "2026-11-14T12:00:00.000Z".to_string(),
        }
    }

    // getWindowsPilotUpdaterConfig

    #[test]
    fn uses_only_the_fixed_authenticated_pilot_route_when_explicitly_enabled() {
        let token = "a".repeat(32);
        assert_eq!(
            windows_pilot_updater_config(Some("1"), Some(&token), true),
            Ok(Some(WindowsPilotUpdaterConfig {
                authorization: format!("Bearer {token}"),
                url: WINDOWS_PILOT_UPDATE_URL,
            }))
        );
    }

    #[test]
    fn is_disabled_by_default_and_fails_closed_on_invalid_mode_host_or_token() {
        let token = "a".repeat(32);
        assert_eq!(windows_pilot_updater_config(None, None, true), Ok(None));
        assert_eq!(
            windows_pilot_updater_config(Some(" "), Some(&token), true),
            Ok(None)
        );
        assert_eq!(
            windows_pilot_updater_config(Some("true"), None, true),
            Err(PilotConfigError::Mode)
        );
        assert_eq!(
            windows_pilot_updater_config(Some("1"), Some(&token), false),
            Err(PilotConfigError::Platform)
        );
        assert_eq!(
            windows_pilot_updater_config(Some("1"), Some("short"), true),
            Err(PilotConfigError::Token)
        );
        assert_eq!(
            windows_pilot_updater_config(Some("1"), None, true),
            Err(PilotConfigError::Token)
        );
        // Beyond the original's cases: the edges of the token's shape.
        let spaced = format!("{} {}", "a".repeat(16), "a".repeat(16));
        let long = "a".repeat(257);
        let accented = "é".repeat(32);
        for bad in [spaced.as_str(), long.as_str(), accented.as_str()] {
            assert_eq!(
                windows_pilot_updater_config(Some("1"), Some(bad), true),
                Err(PilotConfigError::Token)
            );
        }
        assert!(windows_pilot_updater_config(Some("1"), Some(&"a".repeat(256)), true).is_ok());
    }

    #[test]
    fn keeps_pilot_routing_for_manual_checks_while_disabling_background_checks_and_scrubs_the_token()
     {
        let token = "b".repeat(32);
        let mut env = environment(&[
            (DISABLE_AUTO_UPDATE_ENV, "1"),
            (WINDOWS_PILOT_UPDATE_ENV, "1"),
            (WINDOWS_PILOT_UPDATE_TOKEN_ENV, &token),
        ]);
        let config = consume_windows_updater_startup_config(&mut env, true).unwrap();
        assert!(config.background_updates_disabled);
        assert_eq!(
            config.pilot.map(|pilot| pilot.authorization),
            Some(format!("Bearer {token}"))
        );
        assert!(!env.contains_key(WINDOWS_PILOT_UPDATE_TOKEN_ENV));
        // The rest of the environment is left alone.
        assert!(env.contains_key(WINDOWS_PILOT_UPDATE_ENV));
    }

    #[test]
    fn scrubs_an_invalid_pilot_token_before_failing_closed() {
        let mut env = environment(&[
            (WINDOWS_PILOT_UPDATE_ENV, "1"),
            (WINDOWS_PILOT_UPDATE_TOKEN_ENV, "short"),
        ]);
        assert_eq!(
            consume_windows_updater_startup_config(&mut env, true),
            Err(PilotConfigError::Token)
        );
        assert!(!env.contains_key(WINDOWS_PILOT_UPDATE_TOKEN_ENV));

        // The same when the override itself is refused, and when it is off.
        let token = "c".repeat(32);
        let mut env = environment(&[
            (WINDOWS_PILOT_UPDATE_ENV, "1"),
            (WINDOWS_PILOT_UPDATE_TOKEN_ENV, &token),
        ]);
        assert_eq!(
            consume_windows_updater_startup_config(&mut env, false),
            Err(PilotConfigError::Platform)
        );
        assert!(!env.contains_key(WINDOWS_PILOT_UPDATE_TOKEN_ENV));
        let mut env = environment(&[(WINDOWS_PILOT_UPDATE_TOKEN_ENV, &token)]);
        let config = consume_windows_updater_startup_config(&mut env, true).unwrap();
        assert_eq!(
            config,
            WindowsUpdaterStartupConfig {
                background_updates_disabled: false,
                pilot: None
            }
        );
        assert!(!env.contains_key(WINDOWS_PILOT_UPDATE_TOKEN_ENV));
    }

    #[test]
    fn never_prints_the_bearer() {
        let token = "d".repeat(40);
        let config = windows_pilot_updater_config(Some("1"), Some(&token), true)
            .unwrap()
            .unwrap();
        assert!(!format!("{config:?}").contains(&token));
        let grant = grant(&format!("wpu1.{token}"));
        assert!(!format!("{grant:?}").contains(&token));
    }

    // signed-in Windows pilot access

    #[test]
    fn accepts_only_a_well_formed_account_grant() {
        assert!(is_windows_pilot_update_grant(&grant("wpu1.abc")));
        assert!(is_windows_pilot_update_grant(&grant(&format!(
            "wpu1.{}",
            "a".repeat(507)
        ))));
        let long = format!("wpu1.{}", "a".repeat(508));
        for bad in [
            "",
            "wpu1.",
            "wpu2.abc",
            "abc",
            "wpu1.a b",
            "wpu1.é",
            long.as_str(),
        ] {
            assert!(!is_windows_pilot_update_grant(&grant(bad)), "{bad}");
        }
    }

    #[test]
    fn routes_an_account_grant_through_the_branded_pilot_proxy() {
        let config = account_pilot_updater_config(&grant("wpu1.abc"));
        assert_eq!(config.authorization, "Bearer wpu1.abc");
        assert_eq!(config.url, WINDOWS_PILOT_UPDATE_URL);
    }

    #[test]
    fn probes_the_pilot_feed_only_when_public_has_nothing_for_a_windows_install() {
        assert!(should_probe_account_pilot_feed(
            false,
            true,
            PublicFeedOutcome::MissingFeed
        ));
        assert!(should_probe_account_pilot_feed(
            false,
            true,
            PublicFeedOutcome::NotAvailable
        ));
        assert!(!should_probe_account_pilot_feed(
            false,
            true,
            PublicFeedOutcome::Available
        ));
        assert!(!should_probe_account_pilot_feed(
            false,
            true,
            PublicFeedOutcome::Failed
        ));
        // Operator mode already pins the pilot feed.
        assert!(!should_probe_account_pilot_feed(
            true,
            true,
            PublicFeedOutcome::MissingFeed
        ));
        assert!(!should_probe_account_pilot_feed(
            false,
            false,
            PublicFeedOutcome::MissingFeed
        ));
    }
}
