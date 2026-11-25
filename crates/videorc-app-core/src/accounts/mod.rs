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
//! callback's code is never printed (`AccountLink`'s `Debug`), the sign-in
//! transaction (state, verifier, code) has no `Debug` at all, and the state
//! the UI and the smokes read names no secret.
//!
//! Electron seals the transaction to disk (safeStorage), so a crash between
//! the browser and the callback keeps it; here it lives in memory, as the
//! deep links' connect queue does (P3-D8): a crash means signing in again.
//! For the same reason the Linux keyring is not needed to start a sign-in.

use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

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

/// The events the account follows: add them to the client's filter.
pub const EVENTS: [&str; 2] = [
    methods::CHANGED_EVENT,
    crate::captions::methods::ENTITLEMENTS_EVENT,
];

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
    /// A provider's Connect, while its page waits in the browser.
    pub const APPROVE_CONNECTION: &str = "Approve the connection in your browser";
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
    /// The plan badge's tier and plan (`entitlements.get`,
    /// `entitlements.updated`); none reads as Basic.
    pub tier: Option<EntitlementTier>,
    pub plan: Option<EntitlementPlan>,
}

impl AccountsState {
    /// The plan badge: "Basic", "Premium", "Max" or "Developer".
    pub fn tier_label(&self) -> &'static str {
        tier_label(self.tier, self.plan)
    }
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
    /// The retries ran out ("Couldn't finish signing in").
    SignInFailed { message: String },
}

/// Why an account action did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountsError {
    /// Sign out while recording or live.
    Locked,
    /// The authorize page is not one the app signs in with.
    UnexpectedAuthorizeUrl,
    /// The backend's intent had no generation.
    InvalidIntent,
    /// The OS gave no random bytes for the sign-in's state.
    NoRandom,
    /// The backend refused (or was not connected).
    Backend(RpcError),
}

impl AccountsError {
    pub fn message(&self) -> String {
        match self {
            Self::Locked => copy::SIGN_OUT_LOCKED.to_string(),
            Self::UnexpectedAuthorizeUrl => {
                "Desktop account authorization URL has an unexpected origin or path.".to_string()
            }
            Self::InvalidIntent => {
                "Desktop account sign-in intent generation was invalid.".to_string()
            }
            Self::NoRandom => "This computer couldn't make a sign-in key.".to_string(),
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

/// `DEFAULT_TRANSACTION_TTL_MS`: how long a sign-in waits for its callback.
pub const TRANSACTION_TTL_MS: u64 = 10 * 60 * 1000;
/// `ACCOUNT_SIGN_IN_CALLBACK_TTL_MS`: how long a callback is completed.
pub const CALLBACK_TTL_MS: u64 = 2 * 60 * 1000;
/// `ACCOUNT_SIGN_IN_CODE_TTL_MS`.
pub const CODE_TTL_MS: u64 = 3 * 60 * 1000;
/// `ACCOUNT_SIGN_IN_CODE_CLOCK_SKEW_MS`.
pub const CODE_CLOCK_SKEW_MS: u64 = 5 * 1000;
/// `account-callback-retry.ts`.
const FAST_RETRY_DELAYS_MS: [u64; 6] = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
const COOLDOWN_RETRY_MS: u64 = 10_000;

/// `accountCallbackRetryDelayMs`: 0.5 s doubling to 10 s, then every 10 s,
/// until the callback's two minutes (or its code) run out; `None` then.
pub fn callback_retry_delay_ms(
    received_at_ms: u64,
    expires_at_ms: u64,
    retries: u32,
    now_ms: u64,
) -> Option<u64> {
    let deadline = expires_at_ms.min(received_at_ms.saturating_add(CALLBACK_TTL_MS));
    let fast_total: u64 = FAST_RETRY_DELAYS_MS.iter().sum();
    let max_retries = FAST_RETRY_DELAYS_MS.len() as u64
        + (CALLBACK_TTL_MS - fast_total).div_ceil(COOLDOWN_RETRY_MS);
    if deadline <= received_at_ms || u64::from(retries) >= max_retries || now_ms >= deadline {
        return None;
    }
    let delay = FAST_RETRY_DELAYS_MS
        .get(retries as usize)
        .copied()
        .unwrap_or(COOLDOWN_RETRY_MS);
    Some(delay.min(deadline - now_ms))
}

/// The sign-in this app started. No `Debug`: it holds the verifier and,
/// once the callback came, the code.
struct Transaction {
    state: String,
    verifier: String,
    intent_generation: u64,
    expires_at_ms: u64,
    callback: Option<Callback>,
}

struct Callback {
    /// `sha256(state \n code \n expiry)`, base64url: a re-delivered link is
    /// the same one.
    id: String,
    code: String,
    received_at_ms: u64,
    expires_at_ms: u64,
}

fn callback_id(link: &AccountLink) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(link.state.as_bytes());
    hash.update(b"\n");
    hash.update(link.code.as_bytes());
    hash.update(b"\n");
    hash.update(link.code_expires_at_ms.to_string().as_bytes());
    crate::encoding::base64url(&hash.finalize())
}

/// 32 random bytes, base64url (`randomBytes(32).toString('base64url')`).
fn random_token() -> Result<String, AccountsError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| AccountsError::NoRandom)?;
    Ok(crate::encoding::base64url(&bytes))
}

/// The PKCE challenge: `sha256(verifier)`, base64url.
fn code_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    crate::encoding::base64url(&Sha256::digest(verifier.as_bytes()))
}

/// `url.searchParams.set` for the sign-in's three parameters.
fn with_sign_in_params(authorize_url: &str, state: &str, challenge: &str) -> Option<String> {
    const KEYS: [&str; 3] = ["state", "code_challenge", "code_challenge_method"];
    let mut url = url::Url::parse(authorize_url).ok()?;
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| !KEYS.contains(&&**key))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(kept)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    Some(url.to_string())
}

fn system_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// The Videorc account: its state, its events, and the actions the menu and
/// the Sign in doors run.
pub struct Accounts<B: AccountsBackend> {
    backend: Arc<B>,
    me: Weak<Self>,
    state: watch::Sender<AccountsState>,
    events: broadcast::Sender<AccountsEvent>,
    /// One sign-in at a time: a newer one replaces it (`begin`).
    sign_in: Mutex<Option<Transaction>>,
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl<B: AccountsBackend> Accounts<B> {
    pub fn new(backend: Arc<B>) -> Arc<Self> {
        Self::with_clock(backend, system_now_ms)
    }

    /// A fixed clock, for tests.
    pub fn with_clock(
        backend: Arc<B>,
        clock: impl Fn() -> u64 + Send + Sync + 'static,
    ) -> Arc<Self> {
        let (state, _) = watch::channel(AccountsState::default());
        let (events, _) = broadcast::channel(16);
        Arc::new_cyclic(|me| Self {
            backend,
            me: me.clone(),
            state,
            events,
            sign_in: Mutex::new(None),
            clock: Box::new(clock),
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

    fn transaction(&self) -> MutexGuard<'_, Option<Transaction>> {
        self.sign_in
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Drops a sign-in whose time ran out.
    fn purge(slot: &mut Option<Transaction>, now: u64) {
        if slot.as_ref().is_some_and(|tx| tx.expires_at_ms < now) {
            *slot = None;
        }
    }

    fn take_account(&self, account: Account) {
        self.state.send_modify(|state| {
            state.account = account;
            state.loaded = true;
        });
    }

    fn take_entitlements(&self, value: &Value) {
        let snapshot = crate::account::entitlements::read_snapshot(value);
        let tier = snapshot.as_ref().map(|s| s.tier);
        let plan = snapshot.and_then(|s| s.plan);
        self.state.send_if_modified(|state| {
            let changed = state.tier != tier || state.plan != plan;
            state.tier = tier;
            state.plan = plan;
            changed
        });
    }

    async fn read_entitlements(&self) {
        if let Ok(value) = self
            .backend
            .request(crate::captions::methods::ENTITLEMENTS_GET, Value::Null)
            .await
        {
            self.take_entitlements(&value);
        }
    }

    /// `account.get` and `entitlements.get`, at every connection. A failed
    /// read keeps the last.
    pub async fn hydrate(&self) {
        if let Ok(value) = self.backend.request(methods::GET, json!({})).await {
            self.take_account(Account::from_value(&value));
        }
        self.read_entitlements().await;
    }

    /// A backend event: `account.changed` takes the new account,
    /// `entitlements.updated` the plan; any other is ignored.
    pub fn on_event(&self, event: &BackendEvent) {
        let BackendEvent::Untyped { event, payload } = event else {
            return;
        };
        if event == crate::captions::methods::ENTITLEMENTS_EVENT {
            self.take_entitlements(payload);
            return;
        }
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

    /// `account:begin-sign-in`: the backend's intent (admin), a new
    /// transaction (state, PKCE verifier, ten minutes) that replaces any
    /// older one, and the page to open in the system browser.
    pub async fn begin_sign_in(
        &self,
        authorize_url: &str,
        allow_loopback: bool,
    ) -> Result<String, AccountsError> {
        if !authorize_url_allowed(authorize_url, allow_loopback) {
            return Err(AccountsError::UnexpectedAuthorizeUrl);
        }
        let intent = self
            .backend
            .admin_request(methods::BEGIN_INTENT, json!({}))
            .await
            .map_err(AccountsError::Backend)?;
        let intent_generation = intent
            .get("intentGeneration")
            .and_then(Value::as_u64)
            .filter(|generation| *generation > 0)
            .ok_or(AccountsError::InvalidIntent)?;
        let state = random_token()?;
        let verifier = random_token()?;
        let page = with_sign_in_params(authorize_url, &state, &code_challenge(&verifier))
            .ok_or(AccountsError::UnexpectedAuthorizeUrl)?;
        *self.transaction() = Some(Transaction {
            state,
            verifier,
            intent_generation,
            expires_at_ms: (self.clock)().saturating_add(TRANSACTION_TTL_MS),
            callback: None,
        });
        self.state
            .send_modify(|state| state.sign_in = SignInPhase::Browser);
        Ok(page)
    }

    /// Stops showing the wait. The transaction stays until it expires, so
    /// a callback that still comes completes.
    pub fn cancel_sign_in(&self) {
        self.state
            .send_if_modified(|state| std::mem::take(&mut state.sign_in) != SignInPhase::Idle);
    }

    /// The waiting callback's completion parameters, its times and id.
    fn pending_completion(&self) -> Option<(Value, u64, u64, String)> {
        let mut slot = self.transaction();
        Self::purge(&mut slot, (self.clock)());
        let tx = slot.as_ref()?;
        let callback = tx.callback.as_ref()?;
        Some((
            json!({
                "code": callback.code,
                "state": tx.state,
                "verifier": tx.verifier,
                "intentGeneration": tx.intent_generation,
            }),
            callback.received_at_ms,
            callback.expires_at_ms,
            callback.id.clone(),
        ))
    }

    /// `acknowledge`: the callback is done with; so is its sign-in.
    fn retire(&self, id: &str) {
        let mut slot = self.transaction();
        let done = slot
            .as_ref()
            .and_then(|tx| tx.callback.as_ref())
            .is_some_and(|callback| callback.id == id);
        if done {
            *slot = None;
        }
    }

    /// `completeAccountSignIn` on the renderer's retry schedule: the backend
    /// exchanges the code; only then is the callback retired. A superseded
    /// sign-in retires at once; anything else is tried again until the
    /// callback expires.
    async fn complete(self: Arc<Self>) {
        let mut retries = 0u32;
        loop {
            let Some((params, received_at_ms, expires_at_ms, id)) = self.pending_completion()
            else {
                self.state.send_if_modified(|state| {
                    std::mem::take(&mut state.sign_in) != SignInPhase::Idle
                });
                return;
            };
            match self
                .backend
                .request(methods::COMPLETE_SIGN_IN, params)
                .await
            {
                Ok(value) => {
                    self.retire(&id);
                    let account = Account::from_value(&value);
                    self.state.send_modify(|state| {
                        state.account = account;
                        state.loaded = true;
                        state.sign_in = SignInPhase::Idle;
                    });
                    self.read_entitlements().await;
                    return;
                }
                Err(error) if error.code == methods::SIGN_IN_SUPERSEDED => {
                    self.retire(&id);
                    self.state
                        .send_modify(|state| state.sign_in = SignInPhase::Idle);
                    return;
                }
                Err(_) => {
                    let now = (self.clock)();
                    match callback_retry_delay_ms(received_at_ms, expires_at_ms, retries, now) {
                        Some(delay) => {
                            if retries == 0 {
                                let _ = self.events.send(AccountsEvent::SignInRetrying);
                            }
                            retries += 1;
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                        None => {
                            self.state
                                .send_modify(|state| state.sign_in = SignInPhase::Idle);
                            let _ = self.events.send(AccountsEvent::SignInFailed {
                                message: copy::SIGN_IN_FAILED.to_string(),
                            });
                            return;
                        }
                    }
                }
            }
        }
    }

    /// `account:sign-out`: the backend signs out (admin), then every sign-in
    /// this app started is retired. Locked while recording or live.
    pub async fn sign_out(&self, live: bool) -> Result<(), AccountsError> {
        if sign_out_disabled(&self.now().account, live) {
            return Err(AccountsError::Locked);
        }
        let value = self
            .backend
            .admin_request(methods::SIGN_OUT, json!({}))
            .await
            .map_err(AccountsError::Backend)?;
        *self.transaction() = None;
        let account = Account::from_value(&value);
        self.state.send_modify(|state| {
            state.account = account;
            state.loaded = true;
            state.sign_in = SignInPhase::Idle;
        });
        self.read_entitlements().await;
        Ok(())
    }

    /// `account:refresh`: the backend reads the account again from the web
    /// (admin).
    pub async fn refresh(&self) -> Result<(), AccountsError> {
        let value = self
            .backend
            .admin_request(methods::REFRESH, json!({}))
            .await
            .map_err(AccountsError::Backend)?;
        self.take_account(Account::from_value(&value));
        Ok(())
    }
}

/// A `videorc://account/callback` from the deep links
/// (`AccountSignInTransactions.accept`): it must match the sign-in this app
/// started, before it expired, with a code inside its three minutes. The
/// same link again is taken once; another code for the same sign-in is
/// refused. Completion runs on the caller's Tokio runtime.
impl<B: AccountsBackend> AccountLinkSink for Accounts<B> {
    fn accept(&self, link: AccountLink) -> Result<(), LinkRejection> {
        let now = (self.clock)();
        let mut slot = self.transaction();
        Self::purge(&mut slot, now);
        let Some(tx) = slot.as_mut().filter(|tx| tx.state == link.state) else {
            return Err(LinkRejection::NoActiveSignIn);
        };
        if link.code_expires_at_ms < now
            || link.code_expires_at_ms > now + CODE_TTL_MS + CODE_CLOCK_SKEW_MS
        {
            return Err(LinkRejection::CodeExpired);
        }
        let id = callback_id(&link);
        if let Some(existing) = &tx.callback {
            return if existing.id == id {
                Ok(())
            } else {
                Err(LinkRejection::DifferentCode)
            };
        }
        let expires_at_ms = (now + CALLBACK_TTL_MS).min(link.code_expires_at_ms);
        tx.expires_at_ms = expires_at_ms;
        tx.callback = Some(Callback {
            id,
            code: link.code,
            received_at_ms: now,
            expires_at_ms,
        });
        drop(slot);
        self.state
            .send_modify(|state| state.sign_in = SignInPhase::Finishing);
        if let Some(me) = self.me.upgrade() {
            tokio::spawn(me.complete());
        }
        Ok(())
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

    // --- The sign-in flow ---------------------------------------------------

    const NOW: u64 = 1_900_000_000_000;

    /// The backend: answers by method, and records every call.
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<(String, Value, bool)>>,
        complete: Mutex<Vec<Result<Value, RpcError>>>,
    }

    impl Fake {
        fn answer(&self, method: &str, params: Value, admin: bool) -> Result<Value, RpcError> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params, admin));
            match method {
                methods::BEGIN_INTENT => Ok(json!({ "intentGeneration": 7 })),
                methods::COMPLETE_SIGN_IN => self
                    .complete
                    .lock()
                    .unwrap()
                    .pop()
                    .unwrap_or_else(|| Ok(signed_in_json())),
                methods::SIGN_OUT | methods::GET => Ok(json!({ "status": "signed-out" })),
                methods::REFRESH => Ok(signed_in_json()),
                _ => Err(RpcError::new(method, "unknown-method", "no")),
            }
        }

        fn methods(&self) -> Vec<(String, bool)> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|(method, _, admin)| (method.clone(), *admin))
                .collect()
        }
    }

    impl AccountsBackend for Fake {
        async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
            self.answer(method, params, false)
        }
        async fn admin_request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
            self.answer(method, params, true)
        }
    }

    fn signed_in_json() -> Value {
        json!({ "status": "signed-in", "username": "orc", "displayName": "Orc" })
    }

    fn accounts(fake: Arc<Fake>) -> Arc<Accounts<Fake>> {
        Accounts::with_clock(fake, || NOW)
    }

    fn query(page: &str, key: &str) -> String {
        url::Url::parse(page)
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default()
    }

    fn link(state: &str, code: &str, expires: u64) -> AccountLink {
        AccountLink {
            state: state.to_string(),
            code: code.to_string(),
            code_expires_at_ms: expires,
        }
    }

    async fn settled(accounts: &Accounts<Fake>) {
        let mut watch = accounts.watch();
        while watch.borrow_and_update().sign_in != SignInPhase::Idle {
            if watch.changed().await.is_err() {
                return;
            }
        }
    }

    #[tokio::test]
    async fn a_sign_in_opens_the_pkce_page_on_the_backends_intent() {
        let fake = Arc::new(Fake::default());
        let accounts = accounts(fake.clone());
        let page = accounts
            .begin_sign_in(&WebLinks::production().desktop_authorize(), false)
            .await
            .unwrap();
        assert!(page.starts_with("https://www.videorc.com/desktop/authorize/v2?"));
        assert_eq!(query(&page, "code_challenge_method"), "S256");
        let (state, verifier, generation) = {
            let slot = accounts.transaction();
            let tx = slot.as_ref().unwrap();
            (tx.state.clone(), tx.verifier.clone(), tx.intent_generation)
        };
        assert_eq!(query(&page, "state"), state);
        assert_eq!(query(&page, "code_challenge"), code_challenge(&verifier));
        assert!(
            !page.contains(&verifier),
            "the verifier never leaves the app"
        );
        assert_eq!(state.len(), 43);
        assert_eq!(generation, 7);
        assert_eq!(fake.methods(), [(methods::BEGIN_INTENT.to_string(), true)]);
        assert_eq!(accounts.now().sign_in, SignInPhase::Browser);
        assert_eq!(
            accounts
                .begin_sign_in("https://evil.test/desktop/authorize/v2", false)
                .await,
            Err(AccountsError::UnexpectedAuthorizeUrl)
        );
    }

    #[tokio::test]
    async fn only_the_sign_in_this_app_started_completes() {
        let fake = Arc::new(Fake::default());
        let accounts = accounts(fake.clone());
        assert_eq!(
            accounts.accept(link("x".repeat(43).as_str(), "c", NOW + 60_000)),
            Err(LinkRejection::NoActiveSignIn)
        );
        accounts
            .begin_sign_in(&WebLinks::production().desktop_authorize(), false)
            .await
            .unwrap();
        let (state, verifier) = {
            let slot = accounts.transaction();
            let tx = slot.as_ref().unwrap();
            (tx.state.clone(), tx.verifier.clone())
        };
        assert_eq!(
            accounts.accept(link(&state, "code", NOW - 1)),
            Err(LinkRejection::CodeExpired)
        );
        assert_eq!(
            accounts.accept(link(
                &state,
                "code",
                NOW + CODE_TTL_MS + CODE_CLOCK_SKEW_MS + 1
            )),
            Err(LinkRejection::CodeExpired)
        );
        // The completion runs at the next await (a current-thread runtime),
        // so the same link again and another code are checked against the
        // waiting callback.
        assert_eq!(accounts.accept(link(&state, "code", NOW + 60_000)), Ok(()));
        assert_eq!(accounts.accept(link(&state, "code", NOW + 60_000)), Ok(()));
        assert_eq!(
            accounts.accept(link(&state, "other", NOW + 60_000)),
            Err(LinkRejection::DifferentCode)
        );
        settled(&accounts).await;
        let calls = fake.calls.lock().unwrap().clone();
        let (_, params, admin) = calls
            .iter()
            .find(|(method, _, _)| method == methods::COMPLETE_SIGN_IN)
            .unwrap();
        assert!(!admin);
        assert_eq!(
            *params,
            json!({ "code": "code", "state": state, "verifier": verifier, "intentGeneration": 7 })
        );
        assert!(accounts.now().account.is_signed_in());
        assert!(accounts.transaction().is_none(), "the sign-in is retired");
    }

    #[tokio::test]
    async fn a_superseded_sign_in_retires_at_once() {
        let fake = Arc::new(Fake::default());
        fake.complete.lock().unwrap().push(Err(RpcError::new(
            methods::COMPLETE_SIGN_IN,
            methods::SIGN_IN_SUPERSEDED,
            "newer",
        )));
        let accounts = accounts(fake.clone());
        accounts
            .begin_sign_in(&WebLinks::production().desktop_authorize(), false)
            .await
            .unwrap();
        let state = accounts.transaction().as_ref().unwrap().state.clone();
        accounts.accept(link(&state, "code", NOW + 60_000)).unwrap();
        settled(&accounts).await;
        assert!(!accounts.now().account.is_signed_in());
        assert!(accounts.transaction().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_failing_completion_retries_then_says_so() {
        let fake = Arc::new(Fake::default());
        for _ in 0..40 {
            fake.complete.lock().unwrap().push(Err(RpcError::new(
                methods::COMPLETE_SIGN_IN,
                "not-connected",
                "offline",
            )));
        }
        let accounts = accounts(fake.clone());
        let mut events = accounts.events();
        accounts
            .begin_sign_in(&WebLinks::production().desktop_authorize(), false)
            .await
            .unwrap();
        let state = accounts.transaction().as_ref().unwrap().state.clone();
        accounts.accept(link(&state, "code", NOW + 60_000)).unwrap();
        settled(&accounts).await;
        assert_eq!(events.recv().await.unwrap(), AccountsEvent::SignInRetrying);
        assert_eq!(
            events.recv().await.unwrap(),
            AccountsEvent::SignInFailed {
                message: copy::SIGN_IN_FAILED.to_string()
            }
        );
    }

    #[test]
    fn the_retry_schedule_is_the_renderers() {
        let received = 1_000;
        let expires = received + CALLBACK_TTL_MS;
        assert_eq!(
            callback_retry_delay_ms(received, expires, 0, received),
            Some(500)
        );
        assert_eq!(
            callback_retry_delay_ms(received, expires, 5, received),
            Some(10_000)
        );
        assert_eq!(
            callback_retry_delay_ms(received, expires, 15, received),
            Some(10_000)
        );
        assert_eq!(
            callback_retry_delay_ms(received, expires, 16, received),
            None
        );
        // Never past the deadline, and none once it passed.
        assert_eq!(
            callback_retry_delay_ms(received, expires, 3, expires - 100),
            Some(100)
        );
        assert_eq!(callback_retry_delay_ms(received, expires, 0, expires), None);
        // The code's own expiry wins when it is sooner.
        assert_eq!(
            callback_retry_delay_ms(received, received + 300, 2, received),
            Some(300)
        );
    }

    #[tokio::test]
    async fn sign_out_is_admin_and_locked_while_live() {
        let fake = Arc::new(Fake::default());
        let accounts = accounts(fake.clone());
        accounts.refresh().await.unwrap();
        assert!(accounts.now().account.is_signed_in());
        assert_eq!(accounts.sign_out(true).await, Err(AccountsError::Locked));
        accounts.sign_out(false).await.unwrap();
        assert!(!accounts.now().account.is_signed_in());
        assert!(
            fake.methods()
                .contains(&(methods::SIGN_OUT.to_string(), true))
        );
        assert!(
            fake.methods()
                .contains(&(methods::REFRESH.to_string(), true))
        );
    }
}
