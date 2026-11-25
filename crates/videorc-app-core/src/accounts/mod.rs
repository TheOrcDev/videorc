//! Accounts in the core (plan 260 S1.6f, L4): the Videorc account and the
//! connected providers, as the pages read them and the shell drives them.
//! The shared interface the account row and menu, the Avatar's and
//! Sidekick's Sign in, the Destinations card's Connect, the YouTube consent,
//! the Schedule dialog and the Go Live sign-in doors build on.
//!
//! **The Videorc account** ([`Accounts`]) mirrors Electron:
//!
//! - `account.get` is the account as the backend holds it; `account.changed`
//!   ([`AccountChangedEvent`]) says when it changed and why. The UI reads it
//!   as [`Account`] (`accountFromSnapshot`): signed in only with a username.
//! - Sign in (`beginVideorcSignIn` → main's `account:begin-sign-in`): the
//!   backend's `account.auth.begin_intent` (admin) answers a generation; the
//!   app makes a transaction (random state and PKCE verifier, ten minutes),
//!   and opens `/desktop/authorize/v2?state=…&code_challenge=…` in the
//!   system browser. The web answers with `videorc://account/callback`,
//!   which [`crate::desktop::deep_link`] parses and hands to the account
//!   through [`AccountLinkSink`]; the account matches it to its transaction
//!   and completes it with `account.complete_sign_in` (renderer), retrying on
//!   `accountCallbackRetryDelayMs`. `account-sign-in-superseded` retires it.
//! - Sign out (`account:sign-out`): `account.sign_out` (admin), then every
//!   transaction is retired. Locked while recording or live.
//! - Refresh (`account:refresh`): `account.refresh` (admin).
//!
//! **The providers** (YouTube, Twitch, X, Kick…) stay where the Studio keeps
//! them, one list for every page: [`Providers`] on `Studio::platforms()`,
//! connected with `Studio::start_platform_sign_in` (the backend's
//! `platformAccounts.oauth.startProvider`, its loopback callback, the page
//! it answers opened in the browser; a `videorc://oauth/callback` link is
//! completed by the deep links) and removed with `Studio::disconnect_platform`.
//! [`needs_consent`] and [`connect_scopes`] are the rules every Connect
//! follows.
//!
//! Nothing here logs or keeps a token: the backend holds the session, a
//! callback's code is never printed (`AccountLink`'s `Debug`), and the state
//! the UI and the smokes read names no secret.
//!
//! Step 1 (this file) is the interface with minimal bodies: the state, the
//! events and `account.get` / `account.changed` work; sign-in, sign-out and
//! refresh answer [`AccountsError::NotYet`] until step 2.

use std::future::Future;
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};

pub use videorc_protocol::{
    AccountChangeReason, AccountChangedEvent, AccountStatus, EntitlementPlan, EntitlementTier,
    VideorcAccountSnapshot,
};

pub use crate::livestream::PlatformsState as Providers;
pub use crate::livestream::accounts::{
    AccountStatus as ProviderStatus, PlatformAccount as ProviderAccount,
};

use crate::client::{BackendEvent, RpcError};
use crate::desktop::deep_link::{AccountLink, AccountLinkSink, LinkRejection};

/// The backend's account methods and event.
pub mod methods {
    /// The account as the backend holds it (renderer).
    pub const GET: &str = "account.get";
    /// A new sign-in intent's generation (admin).
    pub const BEGIN_INTENT: &str = "account.auth.begin_intent";
    /// A callback's code, state, verifier and generation (renderer).
    pub const COMPLETE_SIGN_IN: &str = "account.complete_sign_in";
    /// Signs out (admin).
    pub const SIGN_OUT: &str = "account.sign_out";
    /// Reads the account again from the web (admin).
    pub const REFRESH: &str = "account.refresh";
    /// The account changed, and why.
    pub const CHANGED_EVENT: &str = "account.changed";
    /// The completion's answer when a newer sign-in or a sign-out won.
    pub const SIGN_IN_SUPERSEDED: &str = "account-sign-in-superseded";
}

/// The web's origin in a packaged build (`VIDEORC_WEB_ORIGIN`).
pub const WEB_ORIGIN: &str = "https://www.videorc.com";
/// A development build's default origin: a local videorc-web.
pub const DEVELOPMENT_WEB_ORIGIN: &str = "http://localhost:3000";
/// The desktop sign-in page's path.
pub const DESKTOP_AUTHORIZE_PATH: &str = "/desktop/authorize/v2";

/// The web pages the account menu opens (`VIDEORC_WEB_LINKS`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebLinks {
    pub origin: String,
}

impl WebLinks {
    /// A packaged build: always production.
    pub fn production() -> Self {
        Self {
            origin: WEB_ORIGIN.to_string(),
        }
    }

    /// A development build: the override (`VITE_VIDEORC_WEB_ORIGIN`'s twin),
    /// else a local videorc-web.
    pub fn development(origin_override: Option<&str>) -> Self {
        let origin = origin_override
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .unwrap_or(DEVELOPMENT_WEB_ORIGIN)
            .trim_end_matches('/');
        Self {
            origin: origin.to_string(),
        }
    }

    pub fn desktop_authorize(&self) -> String {
        format!("{}{DESKTOP_AUTHORIZE_PATH}", self.origin)
    }
    pub fn account(&self) -> String {
        format!("{}/account", self.origin)
    }
    pub fn premium(&self) -> String {
        format!("{}/premium", self.origin)
    }
}

/// `AccountSignInTransactions.begin`'s check: the authorize page is
/// production's, or a loopback host in a development build, at
/// [`DESKTOP_AUTHORIZE_PATH`], with no credentials in the URL.
pub fn authorize_url_allowed(raw: &str, allow_loopback: bool) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    let production = url.origin().ascii_serialization() == WEB_ORIGIN;
    let loopback = allow_loopback
        && matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    url.username().is_empty()
        && url.password().is_none()
        && url.path() == DESKTOP_AUTHORIZE_PATH
        && (production || loopback)
}

/// The Videorc account as the UI reads it (`VideorcAccount`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Account {
    #[default]
    SignedOut,
    SignedIn {
        username: String,
        display_name: Option<String>,
        email: Option<String>,
        /// Loaded through the app's avatar cache, never hot-linked.
        avatar_url: Option<String>,
    },
}

impl Account {
    /// `accountFromSnapshot`: anything but a signed-in snapshot with a
    /// username reads as signed out, so the UI never shows half an account.
    pub fn from_snapshot(snapshot: Option<&VideorcAccountSnapshot>) -> Self {
        let Some(snapshot) = snapshot.filter(|s| s.status == AccountStatus::SignedIn) else {
            return Self::SignedOut;
        };
        let Some(username) = snapshot.username.clone().filter(|u| !u.is_empty()) else {
            return Self::SignedOut;
        };
        Self::SignedIn {
            username,
            display_name: snapshot.display_name.clone(),
            email: snapshot.email.clone(),
            avatar_url: snapshot.avatar_url.clone(),
        }
    }

    /// An `account.get` answer, leniently: one that doesn't read is signed
    /// out.
    pub fn from_value(value: &Value) -> Self {
        let snapshot = serde_json::from_value::<VideorcAccountSnapshot>(value.clone()).ok();
        Self::from_snapshot(snapshot.as_ref())
    }

    pub fn is_signed_in(&self) -> bool {
        matches!(self, Self::SignedIn { .. })
    }

    /// `accountDisplayName`: "Sign in" signed out; the display name, else
    /// the username.
    pub fn display_name(&self) -> String {
        match self {
            Self::SignedOut => copy::SIGN_IN.to_string(),
            Self::SignedIn {
                username,
                display_name,
                ..
            } => display_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(username.as_str())
                .to_string(),
        }
    }
}

/// `entitlementTierLabel`: the plan badge. Max is Premium with the Max plan.
pub fn tier_label(tier: Option<EntitlementTier>, plan: Option<EntitlementPlan>) -> &'static str {
    match tier {
        Some(EntitlementTier::Premium) if plan == Some(EntitlementPlan::Max) => "Max",
        Some(EntitlementTier::Premium) => "Premium",
        Some(EntitlementTier::Developer) => "Developer",
        Some(EntitlementTier::Basic) | None => "Basic",
    }
}

/// `AccountMenuItem`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuItem {
    Account,
    SignIn,
    SignOut,
    ViewPremium,
    Health,
    Settings,
}

/// `accountMenuItems`: the Videorc account's rows in order; no provider
/// account ever appears here.
pub fn menu_items(account: &Account) -> Vec<MenuItem> {
    let mut items = if account.is_signed_in() {
        vec![MenuItem::Account, MenuItem::SignOut]
    } else {
        vec![MenuItem::SignIn]
    };
    items.extend([MenuItem::ViewPremium, MenuItem::Health, MenuItem::Settings]);
    items
}

/// `isSignOutDisabled`: locked while recording or live.
pub fn sign_out_disabled(account: &Account, live: bool) -> bool {
    account.is_signed_in() && live
}

/// The account menu's words.
pub mod copy {
    pub const SIGN_IN: &str = "Sign in";
    pub const NOT_SIGNED_IN: &str = "Not signed in";
    pub const ACCOUNT: &str = "Account";
    pub const VIEW_PREMIUM: &str = "View Premium";
    pub const HEALTH: &str = "Health";
    pub const SETTINGS: &str = "Settings";
    pub const SIGN_OUT: &str = "Sign out";
    pub const SIGN_OUT_LOCKED: &str = "Sign out is locked while you're recording or live.";
    pub const FINISHING_SIGN_IN: &str = "Finishing sign-in…";
    pub const SIGN_IN_FAILED: &str = "Couldn't finish signing in";
    pub const SIGN_IN_AGAIN: &str = "Sign in again from the account menu.";
    pub const LINK_DID_NOT_MATCH: &str = "The sign-in link didn't match. Sign in again.";
}

/// `connectPlatformAccount`'s first step: YouTube shows its consent ("Connect
/// YouTube to Videorc", reset each time it opens) before Google's page.
pub fn needs_consent(platform: &str) -> bool {
    platform == "youtube"
}

/// The optional scopes a Connect asks for (`platformConnectOptions`).
pub fn connect_scopes(platform: &str) -> Vec<&'static str> {
    crate::livestream::accounts::connect_optional_scopes(platform)
}

/// Where a Videorc sign-in stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SignInPhase {
    #[default]
    Idle,
    /// The browser is open on the sign-in page.
    Browser,
    /// A callback came; the backend is completing it.
    Finishing,
}

/// What the pages read.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AccountsState {
    pub account: Account,
    /// `account.get` has answered on this connection.
    pub loaded: bool,
    pub sign_in: SignInPhase,
}

/// What happened, for the toasts and the pages that refresh on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountsEvent {
    /// `account.changed`.
    Changed {
        account: Account,
        reason: AccountChangeReason,
    },
    /// A callback is being completed again ("Finishing sign-in…").
    SignInRetrying,
    /// The retries ran out, or the link did not match.
    SignInFailed { message: String },
}

/// Why an account action did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountsError {
    /// Step 2 has not landed.
    NotYet,
    /// No backend connection.
    Offline,
    /// Sign out while recording or live.
    Locked,
    /// The authorize page is not one the app signs in with.
    UnexpectedAuthorizeUrl,
    /// The backend refused.
    Backend(RpcError),
}

impl AccountsError {
    pub fn message(&self) -> String {
        match self {
            Self::NotYet => "Signing in from this build isn't ready yet.".to_string(),
            Self::Offline => "Videorc's engine isn't connected.".to_string(),
            Self::Locked => copy::SIGN_OUT_LOCKED.to_string(),
            Self::UnexpectedAuthorizeUrl => {
                "Desktop account authorization URL has an unexpected origin or path.".to_string()
            }
            Self::Backend(error) => error.message.clone(),
        }
    }
}

/// The backend, as the account uses it: the renderer credential for reads
/// and completion, the admin one for the intent, sign-out and refresh (the
/// backend refuses those on the renderer's).
pub trait AccountsBackend: Send + Sync + 'static {
    fn request(
        &self,
        method: &str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send;

    fn admin_request(
        &self,
        method: &str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send;
}

/// The Videorc account: its state, its events, and the actions the menu and
/// the Sign in doors run.
pub struct Accounts<B: AccountsBackend> {
    backend: Arc<B>,
    state: watch::Sender<AccountsState>,
    events: broadcast::Sender<AccountsEvent>,
}

impl<B: AccountsBackend> Accounts<B> {
    pub fn new(backend: Arc<B>) -> Arc<Self> {
        let (state, _) = watch::channel(AccountsState::default());
        let (events, _) = broadcast::channel(16);
        Arc::new(Self {
            backend,
            state,
            events,
        })
    }

    /// The state, as it changes.
    pub fn watch(&self) -> watch::Receiver<AccountsState> {
        self.state.subscribe()
    }

    /// The state as it is now.
    pub fn now(&self) -> AccountsState {
        self.state.borrow().clone()
    }

    pub fn events(&self) -> broadcast::Receiver<AccountsEvent> {
        self.events.subscribe()
    }

    /// `account.get`, at every connection. A failed read keeps the last.
    pub async fn hydrate(&self) {
        if let Ok(value) = self.backend.request(methods::GET, json!({})).await {
            let account = Account::from_value(&value);
            self.state.send_modify(|state| {
                state.account = account;
                state.loaded = true;
            });
        }
    }

    /// A backend event: `account.changed` takes the new account; any other
    /// is ignored.
    pub fn on_event(&self, event: &BackendEvent) {
        let BackendEvent::Untyped { event, payload } = event else {
            return;
        };
        if event != methods::CHANGED_EVENT {
            return;
        }
        let Ok(changed) = serde_json::from_value::<AccountChangedEvent>(payload.clone()) else {
            return;
        };
        let account = Account::from_snapshot(Some(&changed.account));
        self.state.send_modify(|state| {
            state.account = account.clone();
            state.loaded = true;
            if changed.reason == AccountChangeReason::SignedIn {
                state.sign_in = SignInPhase::Idle;
            }
        });
        let _ = self.events.send(AccountsEvent::Changed {
            account,
            reason: changed.reason,
        });
    }

    /// Starts a Videorc sign-in and answers the page to open in the
    /// browser. Step 2.
    pub async fn begin_sign_in(
        &self,
        authorize_url: &str,
        allow_loopback: bool,
    ) -> Result<String, AccountsError> {
        if !authorize_url_allowed(authorize_url, allow_loopback) {
            return Err(AccountsError::UnexpectedAuthorizeUrl);
        }
        Err(AccountsError::NotYet)
    }

    /// Stops waiting for the browser (the transaction expires on its own).
    pub fn cancel_sign_in(&self) {
        self.state
            .send_if_modified(|state| std::mem::take(&mut state.sign_in) != SignInPhase::Idle);
    }

    /// Signs out; `live` is a recording or livestream running. Step 2.
    pub async fn sign_out(&self, live: bool) -> Result<(), AccountsError> {
        if sign_out_disabled(&self.now().account, live) {
            return Err(AccountsError::Locked);
        }
        Err(AccountsError::NotYet)
    }

    /// Reads the account again from the web. Step 2.
    pub async fn refresh(&self) -> Result<(), AccountsError> {
        Err(AccountsError::NotYet)
    }
}

/// A `videorc://account/callback` from the deep links. Step 2 matches it to
/// the transaction and completes it; until then no sign-in is active.
impl<B: AccountsBackend> AccountLinkSink for Accounts<B> {
    fn accept(&self, _link: AccountLink) -> Result<(), LinkRejection> {
        Err(LinkRejection::NoActiveSignIn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(status: AccountStatus, username: Option<&str>) -> VideorcAccountSnapshot {
        VideorcAccountSnapshot {
            status,
            username: username.map(str::to_string),
            display_name: Some("  ".to_string()),
            email: None,
            avatar_url: None,
        }
    }

    #[test]
    fn only_a_signed_in_snapshot_with_a_username_is_signed_in() {
        assert_eq!(Account::from_snapshot(None), Account::SignedOut);
        assert_eq!(
            Account::from_snapshot(Some(&snapshot(AccountStatus::SignedIn, None))),
            Account::SignedOut
        );
        assert_eq!(
            Account::from_snapshot(Some(&snapshot(AccountStatus::SignedOut, Some("orc")))),
            Account::SignedOut
        );
        let account = Account::from_snapshot(Some(&snapshot(AccountStatus::SignedIn, Some("orc"))));
        assert!(account.is_signed_in());
        // A blank display name falls back to the username.
        assert_eq!(account.display_name(), "orc");
        assert_eq!(Account::SignedOut.display_name(), "Sign in");
        assert_eq!(Account::from_value(&json!({"nope": 1})), Account::SignedOut);
    }

    #[test]
    fn the_menu_and_its_lock_follow_electron() {
        let signed_in = Account::from_snapshot(Some(&snapshot(AccountStatus::SignedIn, Some("o"))));
        assert_eq!(
            menu_items(&signed_in),
            [
                MenuItem::Account,
                MenuItem::SignOut,
                MenuItem::ViewPremium,
                MenuItem::Health,
                MenuItem::Settings
            ]
        );
        assert_eq!(menu_items(&Account::SignedOut)[0], MenuItem::SignIn);
        assert!(sign_out_disabled(&signed_in, true));
        assert!(!sign_out_disabled(&signed_in, false));
        assert!(!sign_out_disabled(&Account::SignedOut, true));
    }

    #[test]
    fn the_plan_badge_names_max() {
        assert_eq!(tier_label(None, None), "Basic");
        assert_eq!(tier_label(Some(EntitlementTier::Premium), None), "Premium");
        assert_eq!(
            tier_label(Some(EntitlementTier::Premium), Some(EntitlementPlan::Max)),
            "Max"
        );
        assert_eq!(
            tier_label(Some(EntitlementTier::Developer), None),
            "Developer"
        );
    }

    #[test]
    fn only_the_desktop_authorize_page_signs_in() {
        let production = WebLinks::production().desktop_authorize();
        assert_eq!(production, "https://www.videorc.com/desktop/authorize/v2");
        assert!(authorize_url_allowed(&production, false));
        let local = WebLinks::development(None).desktop_authorize();
        assert!(!authorize_url_allowed(&local, false));
        assert!(authorize_url_allowed(&local, true));
        assert!(!authorize_url_allowed(
            "https://videorc.com/desktop/authorize/v2",
            true
        ));
        assert!(!authorize_url_allowed(
            "https://www.videorc.com/login",
            false
        ));
        assert!(!authorize_url_allowed(
            "https://u:p@www.videorc.com/desktop/authorize/v2",
            false
        ));
        assert!(!authorize_url_allowed(
            "http://evil.test/desktop/authorize/v2",
            true
        ));
    }

    #[test]
    fn youtube_alone_asks_for_consent_first() {
        assert!(needs_consent("youtube"));
        assert!(!needs_consent("twitch"));
    }
}
