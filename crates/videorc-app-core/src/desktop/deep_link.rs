//! `videorc://` links into the core (plan 220 S2.6a): what Electron main's
//! `open-url` / `second-instance` handlers and the renderer's callback
//! effects do, without either.
//!
//! Three links exist (`dispatchOAuthCallbackUrl` in `main/index.ts`):
//!
//! - **`videorc://buddy`** (plan 170 D18, "Open in Videorc" and "Make it
//!   Alive" on videorc.com), optionally `?alive=<library id>`:
//!   [`parse_buddy_link`] is `parseBuddyDeepLink` and
//!   [`DeepLinks::run_buddy`] is `runBuddyDeepLink` (show Buddy, sync the
//!   library, use the avatar, wait until Buddy wears it, open the creator).
//! - **`videorc://oauth/callback`**, a platform connect (YouTube, Twitch…):
//!   [`parse_provider_link`] is `callbackFromUrl`, [`ProviderLinkQueue`] is
//!   `ProviderOAuthCallbacks` (deduped by a hash of state, code and error,
//!   ten minutes to live, at most 32 waiting), and [`DeepLinks`] completes
//!   each through the backend's `platformAccounts.oauth.complete` the way
//!   the renderer's `completeProviderOAuthCallback` does: a retryable answer
//!   or a failed request is tried again on the renderer's schedule
//!   ([`provider_retry_delay_ms`]), any other answer retires the link.
//! - **`videorc://account/callback`**, the Videorc account sign-in:
//!   [`parse_account_link`] is `parseAccountCallbackUrl` with the v3 code's
//!   shape and expiry checks. A link only completes against the sign-in this
//!   app started (its state and PKCE verifier): since S3.0j the account
//!   ([`crate::account`]) takes it through an [`AccountLinkSink`], which
//!   matches it to its transaction and completes it through the backend.
//!   Without a sink, or with no sign-in that matches, the link is refused
//!   by name ([`LinkRejection::NoActiveSignIn`]), never silently.
//!
//! A link's URL carries a short-lived code: it is never logged, and the
//! state the smokes read ([`LinksSnapshot`]) names kinds, ids and outcomes
//! only. Electron seals the waiting links to disk (safeStorage) so a crash
//! keeps them; here they live in memory with Electron's ten minutes (P3-D8):
//! a crash means connecting or signing in again.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use url::Url;

use crate::client::{BackendClient, RpcError};
use crate::encoding::base64url;
use crate::log::Logger;

/// `OAUTH_CALLBACK_PROTOCOL`.
pub const SCHEME: &str = "videorc";
/// `PROVIDER_OAUTH_CALLBACK_TTL_MS`.
pub const PROVIDER_LINK_TTL_MS: u64 = 10 * 60 * 1000;
/// `DEFAULT_MAX_CALLBACKS`.
pub const PROVIDER_LINK_MAX: usize = 32;
/// `ACCOUNT_SIGN_IN_CODE_VERSION`.
pub const ACCOUNT_CODE_VERSION: &str = "v3";
/// `ACCOUNT_SIGN_IN_CODE_EXPIRY_PARAM`.
pub const ACCOUNT_CODE_EXPIRY_PARAM: &str = "code_expires_at_ms";
/// The longest link either parser reads.
const MAX_LINK_CHARS: usize = 16_384;

/// `BUDDY_OFFICIAL_SLUGS`: the official characters' wire ids.
pub const BUDDY_OFFICIAL_SLUGS: [&str; 5] = ["golem", "orc", "goblin", "pirate", "robot"];

/// Why a link was not taken. The words are for the log and the smokes; a
/// streamer never reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkRejection {
    /// Not a URL, or not this app's scheme.
    NotVideorc,
    /// A `videorc://` link this app has no use for (another host or path).
    Unknown,
    TooLarge,
    /// The right kind, the wrong shape (credentials, a port, a fragment).
    Invalid,
    /// A parameter missing or out of bounds.
    Incomplete,
    /// The account code's expiry is not the one the link names.
    ExpiryMismatch,
    /// No sign-in this app started matches the link.
    NoActiveSignIn,
    /// 32 connect links wait already.
    QueueFull,
    /// S3.0j: the account code expired, or names an expiry too far ahead.
    CodeExpired,
    /// S3.0j: the sign-in already holds a different code.
    DifferentCode,
}

impl LinkRejection {
    pub fn describe(self) -> &'static str {
        match self {
            LinkRejection::NotVideorc => "not a Videorc link",
            LinkRejection::Unknown => "a Videorc link this app has no use for",
            LinkRejection::TooLarge => "the link is too large",
            LinkRejection::Invalid => "the link has the wrong shape",
            LinkRejection::Incomplete => "the link is incomplete",
            LinkRejection::ExpiryMismatch => "the sign-in code and its expiry disagree",
            LinkRejection::NoActiveSignIn => "no sign-in this app started matches the link",
            LinkRejection::QueueFull => "too many connect links are waiting",
            LinkRejection::CodeExpired => "the sign-in code expired or is too far ahead",
            LinkRejection::DifferentCode => "this sign-in already holds a different code",
        }
    }
}

/// `videorc://buddy`, with the avatar "Make it Alive" was pressed on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuddyLink {
    pub alive: Option<String>,
}

/// A platform connect link, parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderLink {
    /// The normalized URL (never logged).
    pub url: String,
    pub state: String,
    /// `sha256(state \n code \n error)`, base64url: the dedupe key.
    pub id: String,
    pub code: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// An account sign-in link, parsed. Its `Debug` never prints the code.
#[derive(Clone, PartialEq, Eq)]
pub struct AccountLink {
    pub state: String,
    /// The short-lived authorization code (never logged).
    pub code: String,
    pub code_expires_at_ms: u64,
}

impl std::fmt::Debug for AccountLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountLink")
            .field("state", &self.state)
            .field("code", &"…")
            .field("code_expires_at_ms", &self.code_expires_at_ms)
            .finish()
    }
}

/// S3.0j: who takes an account link (the account's sign-in transactions).
/// `accept` matches the link to the sign-in this app started and starts its
/// completion; a refusal names why.
pub trait AccountLinkSink: Send + Sync + 'static {
    fn accept(&self, link: AccountLink) -> Result<(), LinkRejection>;
}

/// Which link it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    Buddy(BuddyLink),
    Provider(ProviderLink),
    Account(AccountLink),
}

impl DeepLink {
    pub fn kind(&self) -> LinkKind {
        match self {
            DeepLink::Buddy(_) => LinkKind::Buddy,
            DeepLink::Provider(_) => LinkKind::Connect,
            DeepLink::Account(_) => LinkKind::Account,
        }
    }
}

/// A link's kind, for the log and the smokes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkKind {
    Buddy,
    /// `videorc://oauth/callback`.
    Connect,
    /// `videorc://account/callback`.
    Account,
    Unknown,
}

/// Where a link came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkSource {
    /// The OS's open-URL Apple Event (`kAEGetURL`), the way a bundled app
    /// receives every link on macOS.
    AppleEvent,
    /// This process's command line (Windows and Linux protocol launches).
    CommandLine,
    /// A second launch handed it over and exited.
    SecondInstance,
}

fn parse_url(raw: &str) -> Result<Url, LinkRejection> {
    let url = Url::parse(raw).map_err(|_| LinkRejection::NotVideorc)?;
    if url.scheme() != SCHEME {
        return Err(LinkRejection::NotVideorc);
    }
    Ok(url)
}

/// No user, password or port: what every `videorc://` link refuses.
fn plain_authority(url: &Url) -> bool {
    url.username().is_empty() && url.password().is_none() && url.port().is_none()
}

/// The first value of `name` (`URLSearchParams.get`).
fn param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// Any of the three links, or why not.
pub fn parse_link(raw: &str) -> Result<DeepLink, LinkRejection> {
    let url = parse_url(raw)?;
    if let Some(link) = parse_buddy_link(raw) {
        return Ok(DeepLink::Buddy(link));
    }
    match (url.host_str(), url.path()) {
        (Some("oauth"), "/callback") => parse_provider_link(raw).map(DeepLink::Provider),
        (Some("account"), "/callback") => parse_account_link(raw).map(DeepLink::Account),
        _ => Err(LinkRejection::Unknown),
    }
}

/// `isBuddyUserAvatarId`: the web's lowercase hyphenated uuid.
fn is_user_avatar_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
}

/// `isBuddyLibraryId`: a user avatar, or `official:<slug>` for a slug this
/// app knows.
pub fn is_buddy_library_id(value: &str) -> bool {
    is_user_avatar_id(value)
        || value
            .strip_prefix("official:")
            .is_some_and(|slug| BUDDY_OFFICIAL_SLUGS.contains(&slug))
}

/// `parseBuddyDeepLink`: `videorc://buddy` or `videorc://buddy/library`, with
/// an optional `alive` that is kept only when it is a library id (the link
/// still opens Buddy without it).
pub fn parse_buddy_link(raw: &str) -> Option<BuddyLink> {
    let url = parse_url(raw).ok()?;
    if url.host_str() != Some("buddy") || !plain_authority(&url) {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    if !path.is_empty() && path != "/library" {
        return None;
    }
    let alive = param(&url, "alive").filter(|alive| is_buddy_library_id(alive));
    Some(BuddyLink { alive })
}

/// `callbackFromUrl` in `provider-oauth-callbacks.ts`.
pub fn parse_provider_link(raw: &str) -> Result<ProviderLink, LinkRejection> {
    if raw.chars().count() > MAX_LINK_CHARS {
        return Err(LinkRejection::TooLarge);
    }
    let url = parse_url(raw)?;
    if url.host_str() != Some("oauth")
        || url.path() != "/callback"
        || !plain_authority(&url)
        || url.fragment().is_some()
    {
        return Err(LinkRejection::Invalid);
    }
    let trimmed = |name: &str| {
        param(&url, name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let state = trimmed("state");
    let code = trimmed("code");
    let error = trimmed("error");
    let Some(state) = state else {
        return Err(LinkRejection::Incomplete);
    };
    let state_chars = state.chars().count();
    if !(8..=2048).contains(&state_chars) || (code.is_none() && error.is_none()) {
        return Err(LinkRejection::Incomplete);
    }
    if code
        .as_ref()
        .is_some_and(|code| code.chars().count() > 8192)
        || error
            .as_ref()
            .is_some_and(|error| error.chars().count() > 1024)
    {
        return Err(LinkRejection::TooLarge);
    }
    let mut hash = Sha256::new();
    hash.update(format!(
        "{state}\n{}\n{}",
        code.as_deref().unwrap_or_default(),
        error.as_deref().unwrap_or_default()
    ));
    Ok(ProviderLink {
        url: url.to_string(),
        id: base64url(&hash.finalize()),
        error_description: param(&url, "error_description"),
        state,
        code,
        error,
    })
}

fn bounded(value: &Option<String>, min: usize, max: usize) -> bool {
    value
        .as_ref()
        .is_some_and(|value| (min..=max).contains(&value.chars().count()))
}

fn base64url_text(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// `parseCodeExpiresAtMs`: `v3.<expiry ms>.<16>.<1..8192>.<22>`.
fn code_expires_at_ms(code: &str) -> Option<u64> {
    let segments: Vec<&str> = code.split('.').collect();
    let [version, expiry, nonce, body, tag] = segments.as_slice() else {
        return None;
    };
    let expires_at: u64 = expiry.parse().ok()?;
    let digits_ok = !expiry.is_empty()
        && expiry.len() <= 16
        && expiry.bytes().all(|byte| byte.is_ascii_digit())
        && expires_at.to_string() == *expiry
        && expires_at <= 9_007_199_254_740_991;
    (*version == ACCOUNT_CODE_VERSION
        && digits_ok
        && nonce.len() == 16
        && base64url_text(nonce)
        && (1..=8192).contains(&body.chars().count())
        && base64url_text(body)
        && tag.len() == 22
        && base64url_text(tag))
    .then_some(expires_at)
}

/// `parseAccountCallbackUrl` (the link as the web sends it, no verifier).
pub fn parse_account_link(raw: &str) -> Result<AccountLink, LinkRejection> {
    if raw.chars().count() > MAX_LINK_CHARS {
        return Err(LinkRejection::TooLarge);
    }
    let url = parse_url(raw)?;
    if url.host_str() != Some("account")
        || url.path() != "/callback"
        || !plain_authority(&url)
        || url.fragment().is_some()
    {
        return Err(LinkRejection::Invalid);
    }
    let trimmed = |name: &str| param(&url, name).map(|value| value.trim().to_string());
    let state = trimmed("state");
    let code = trimmed("code");
    let expiry = trimmed(ACCOUNT_CODE_EXPIRY_PARAM);
    let mut keys: Vec<String> = url.query_pairs().map(|(key, _)| key.into_owned()).collect();
    keys.sort();
    let expected = ["code", ACCOUNT_CODE_EXPIRY_PARAM, "state"];
    if !bounded(&state, 32, 128) || !bounded(&code, 32, 8192) || keys != expected {
        return Err(LinkRejection::Incomplete);
    }
    let code_expires_at_ms =
        code_expires_at_ms(code.as_deref().unwrap_or_default()).ok_or(LinkRejection::Invalid)?;
    if expiry.as_deref() != Some(code_expires_at_ms.to_string().as_str()) {
        return Err(LinkRejection::ExpiryMismatch);
    }
    Ok(AccountLink {
        state: state.unwrap_or_default(),
        code: code.unwrap_or_default(),
        code_expires_at_ms,
    })
}

/// A connect link waiting for the backend (`OAuthCallbackEnvelope`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEnvelope {
    pub link: ProviderLink,
    pub received_at_ms: u64,
    pub expires_at_ms: u64,
}

/// `ProviderOAuthCallbacks`, in memory: accept dedupes by id and refuses
/// past the cap, expired links are purged, a completed one is acknowledged.
#[derive(Debug, Clone)]
pub struct ProviderLinkQueue {
    waiting: Vec<ProviderEnvelope>,
    ttl_ms: u64,
    max: usize,
}

impl Default for ProviderLinkQueue {
    fn default() -> Self {
        Self::new(PROVIDER_LINK_TTL_MS, PROVIDER_LINK_MAX)
    }
}

impl ProviderLinkQueue {
    pub fn new(ttl_ms: u64, max: usize) -> Self {
        Self {
            waiting: Vec::new(),
            ttl_ms,
            max,
        }
    }

    /// The envelope for `link`: the waiting one when the same link arrived
    /// before, a new one otherwise.
    pub fn accept(
        &mut self,
        link: ProviderLink,
        now_ms: u64,
    ) -> Result<(ProviderEnvelope, bool), LinkRejection> {
        self.purge(now_ms);
        if let Some(existing) = self
            .waiting
            .iter()
            .find(|envelope| envelope.link.id == link.id)
        {
            return Ok((existing.clone(), false));
        }
        if self.waiting.len() >= self.max {
            return Err(LinkRejection::QueueFull);
        }
        let envelope = ProviderEnvelope {
            link,
            received_at_ms: now_ms,
            expires_at_ms: now_ms + self.ttl_ms,
        };
        self.waiting.push(envelope.clone());
        Ok((envelope, true))
    }

    pub fn pending(&mut self, now_ms: u64) -> Vec<ProviderEnvelope> {
        self.purge(now_ms);
        self.waiting.clone()
    }

    pub fn acknowledge(&mut self, id: &str) -> bool {
        let before = self.waiting.len();
        self.waiting.retain(|envelope| envelope.link.id != id);
        self.waiting.len() != before
    }

    fn purge(&mut self, now_ms: u64) {
        self.waiting
            .retain(|envelope| envelope.expires_at_ms >= now_ms);
    }
}

/// `FAST_RETRY_COUNT`, `COOLDOWN_RETRY_MS` and the deadline of
/// `provider-oauth-retry.ts`.
const FAST_RETRY_COUNT: u32 = 6;
const COOLDOWN_RETRY_MS: u64 = 20_000;
const FAST_RETRY_TOTAL_MS: u64 = 500 + 1_000 + 2_000 + 4_000 + 8_000 + 10_000;

fn max_retry_count() -> u32 {
    FAST_RETRY_COUNT
        + (PROVIDER_LINK_TTL_MS - FAST_RETRY_TOTAL_MS).div_ceil(COOLDOWN_RETRY_MS) as u32
}

/// `providerOAuthRetryDelayMs`: 0.5 s doubling to 10 s for six tries, then
/// every 20 s, never past the link's ten minutes; `None` when it is over.
pub fn provider_retry_delay_ms(received_at_ms: u64, retries: u32, now_ms: u64) -> Option<u64> {
    let age = now_ms.saturating_sub(received_at_ms);
    if retries >= max_retry_count() || age >= PROVIDER_LINK_TTL_MS {
        return None;
    }
    let delay = if retries < FAST_RETRY_COUNT {
        (500_u64 << retries.min(5)).min(10_000)
    } else {
        COOLDOWN_RETRY_MS
    };
    Some(delay.min(PROVIDER_LINK_TTL_MS - age))
}

/// The backend, as the links use it: one untyped request on the renderer
/// credential (the methods are the renderer's).
pub trait LinkBackend: Send + Sync + 'static {
    fn request(
        &self,
        method: &str,
        params: Value,
    ) -> impl Future<Output = Result<Value, RpcError>> + Send;
}

impl LinkBackend for BackendClient {
    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        BackendClient::request(self, method, params).await
    }
}

/// What the UI must do for a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkEffect {
    /// Bring the main window up (a second launch, any link).
    ShowMainWindow,
    /// Open Buddy; `open_creator` also opens the creator on the avatar.
    ShowBuddy { open_creator: bool },
}

/// How a Buddy link ended (`BuddyDeepLinkOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuddyOutcome {
    Synced,
    Opened,
    Failed,
}

/// One link the core received, for the log and the smokes (never its URL).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedLink {
    pub source: LinkSource,
    pub kind: LinkKind,
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection: Option<LinkRejection>,
    /// A connect link's dedupe id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub received_at_ms: u64,
}

/// What the backend said about one connect link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOutcome {
    pub id: String,
    pub attempts: u32,
    /// The answer's `status` (`success`, `failed`, `expired`,
    /// `unknown-state`), or none while no answer came.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub retryable: bool,
    /// The link was retired (answered, not retryable).
    pub completed: bool,
    /// The retries ran out; the link waits until it expires.
    pub exhausted: bool,
    /// The last failed request's code, when the request itself failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_error: Option<String>,
}

/// Everything the links did, as the smokes read it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinksSnapshot {
    pub received: Vec<ReceivedLink>,
    pub connect_waiting: Vec<String>,
    pub connect_outcomes: Vec<ConnectOutcome>,
    pub buddy_outcomes: Vec<BuddyOutcome>,
}

/// How long the Buddy follow-up polls (`runBuddyDeepLink`'s options).
#[derive(Debug, Clone, Copy)]
pub struct BuddyTiming {
    pub poll: Duration,
    pub timeout: Duration,
}

impl Default for BuddyTiming {
    fn default() -> Self {
        Self {
            poll: Duration::from_millis(500),
            timeout: Duration::from_secs(90),
        }
    }
}

#[derive(Debug, Default)]
struct LinksState {
    queue: ProviderLinkQueue,
    snapshot: LinksSnapshot,
    in_flight: Vec<String>,
}

const HISTORY: usize = 64;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn push_bounded<T>(list: &mut Vec<T>, item: T) {
    list.push(item);
    if list.len() > HISTORY {
        list.remove(0);
    }
}

/// The core's link handler: parse, queue, complete, and the effects the UI
/// carries out.
pub struct DeepLinks<B: LinkBackend> {
    backend: Arc<B>,
    state: Mutex<LinksState>,
    /// S3.0j: the account's sign-in, once the app has one.
    account: Mutex<Option<Arc<dyn AccountLinkSink>>>,
    effects: broadcast::Sender<LinkEffect>,
    logger: Logger,
    buddy_timing: BuddyTiming,
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl<B: LinkBackend> DeepLinks<B> {
    pub fn new(backend: Arc<B>, logger: Logger) -> Self {
        let (effects, _) = broadcast::channel(16);
        Self {
            backend,
            state: Mutex::new(LinksState::default()),
            account: Mutex::new(None),
            effects,
            logger,
            buddy_timing: BuddyTiming::default(),
            clock: Box::new(now_ms),
        }
    }

    /// Faster Buddy polling, for tests.
    pub fn with_buddy_timing(mut self, timing: BuddyTiming) -> Self {
        self.buddy_timing = timing;
        self
    }

    /// A fixed clock, for tests.
    pub fn with_clock(mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.clock = Box::new(clock);
        self
    }

    /// S3.0j: account links go to `sink` from now on.
    pub fn set_account_sink(&self, sink: Arc<dyn AccountLinkSink>) {
        *self
            .account
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(sink);
    }

    pub fn effects(&self) -> broadcast::Receiver<LinkEffect> {
        self.effects.subscribe()
    }

    pub fn snapshot(&self) -> LinksSnapshot {
        let mut state = self.lock();
        let now = (self.clock)();
        state.snapshot.connect_waiting = state
            .queue
            .pending(now)
            .into_iter()
            .map(|envelope| envelope.link.id)
            .collect();
        state.snapshot.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LinksState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn emit(&self, effect: LinkEffect) {
        let _ = self.effects.send(effect);
    }

    /// A link arrived. Returns what was taken; the work it starts (the
    /// backend completion, the Buddy follow-up) runs on the caller's tokio
    /// runtime.
    pub fn receive(self: &Arc<Self>, raw: &str, source: LinkSource) -> ReceivedLink {
        let now = (self.clock)();
        let parsed = parse_link(raw);
        let kind = match &parsed {
            Ok(link) => link.kind(),
            Err(_) => match parse_url(raw) {
                Ok(url) => match url.host_str() {
                    Some("oauth") => LinkKind::Connect,
                    Some("account") => LinkKind::Account,
                    Some("buddy") => LinkKind::Buddy,
                    _ => LinkKind::Unknown,
                },
                Err(_) => LinkKind::Unknown,
            },
        };
        let mut received = ReceivedLink {
            source,
            kind,
            accepted: false,
            rejection: None,
            id: None,
            received_at_ms: now,
        };
        match parsed {
            Ok(DeepLink::Buddy(link)) => {
                received.accepted = true;
                let links = self.clone();
                tokio::spawn(async move {
                    let outcome = links.run_buddy(link).await;
                    push_bounded(&mut links.lock().snapshot.buddy_outcomes, outcome);
                });
            }
            Ok(DeepLink::Provider(link)) => {
                received.id = Some(link.id.clone());
                let accepted = self.lock().queue.accept(link, now);
                match accepted {
                    Ok((envelope, _)) => {
                        received.accepted = true;
                        self.emit(LinkEffect::ShowMainWindow);
                        self.start_completion(envelope);
                    }
                    Err(rejection) => received.rejection = Some(rejection),
                }
            }
            Ok(DeepLink::Account(link)) => {
                let sink = self
                    .account
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .clone();
                match sink.map_or(Err(LinkRejection::NoActiveSignIn), |sink| sink.accept(link)) {
                    Ok(()) => {
                        received.accepted = true;
                        self.emit(LinkEffect::ShowMainWindow);
                    }
                    Err(rejection) => received.rejection = Some(rejection),
                }
            }
            Err(rejection) => received.rejection = Some(rejection),
        }
        match received.rejection {
            None => self.logger.info(format!(
                "[links] {:?} link from {:?} taken",
                received.kind, received.source
            )),
            Some(rejection) => self.logger.warn(format!(
                "[links] {:?} link from {:?} refused: {}",
                received.kind,
                received.source,
                rejection.describe()
            )),
        }
        push_bounded(&mut self.lock().snapshot.received, received.clone());
        received
    }

    /// Completes every waiting connect link again (the renderer re-runs them
    /// on each connection).
    pub fn resume_waiting(self: &Arc<Self>) {
        let now = (self.clock)();
        let waiting = self.lock().queue.pending(now);
        for envelope in waiting {
            self.start_completion(envelope);
        }
    }

    fn start_completion(self: &Arc<Self>, envelope: ProviderEnvelope) {
        {
            let mut state = self.lock();
            if state.in_flight.contains(&envelope.link.id) {
                return;
            }
            state.in_flight.push(envelope.link.id.clone());
        }
        let links = self.clone();
        tokio::spawn(async move {
            let id = envelope.link.id.clone();
            links.complete_connect(envelope).await;
            links.lock().in_flight.retain(|other| *other != id);
        });
    }

    fn record_connect(&self, outcome: ConnectOutcome) {
        let mut state = self.lock();
        let outcomes = &mut state.snapshot.connect_outcomes;
        if let Some(existing) = outcomes.iter_mut().find(|other| other.id == outcome.id) {
            *existing = outcome;
        } else {
            push_bounded(outcomes, outcome);
        }
    }

    /// `completeProviderOAuthCallback` with the renderer's retry schedule:
    /// the backend consumes the pending state and stores the token; only
    /// then is the link retired.
    pub async fn complete_connect(&self, envelope: ProviderEnvelope) -> ConnectOutcome {
        let link = &envelope.link;
        let mut params = json!({ "state": link.state });
        if let Some(code) = &link.code {
            params["code"] = json!(code);
        }
        if let Some(error) = &link.error {
            params["error"] = json!(error);
        }
        if let Some(description) = &link.error_description {
            params["errorDescription"] = json!(description);
        }
        let mut outcome = ConnectOutcome {
            id: link.id.clone(),
            attempts: 0,
            status: None,
            retryable: false,
            completed: false,
            exhausted: false,
            request_error: None,
        };
        let mut retries = 0;
        loop {
            outcome.attempts += 1;
            match self
                .backend
                .request("platformAccounts.oauth.complete", params.clone())
                .await
            {
                Ok(answer) => {
                    outcome.status = answer
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    outcome.retryable = answer
                        .get("retryable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    outcome.request_error = None;
                    if !outcome.retryable {
                        self.lock().queue.acknowledge(&link.id);
                        outcome.completed = true;
                        self.logger.info(format!(
                            "[links] connect link answered: {}",
                            outcome.status.as_deref().unwrap_or("no status")
                        ));
                        self.record_connect(outcome.clone());
                        return outcome;
                    }
                }
                Err(error) => {
                    outcome.request_error = Some(error.code.clone());
                }
            }
            self.record_connect(outcome.clone());
            let Some(delay) =
                provider_retry_delay_ms(envelope.received_at_ms, retries, (self.clock)())
            else {
                outcome.exhausted = true;
                self.logger
                    .warn("[links] a connect link ran out of retries; it waits until it expires");
                self.record_connect(outcome.clone());
                return outcome;
            };
            retries += 1;
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    /// `runBuddyDeepLink`: open Buddy and sync the library at once; with an
    /// avatar, use it after the sync, wait until Buddy wears it, then open the
    /// creator. A failed or slow use never opens the creator.
    pub async fn run_buddy(&self, link: BuddyLink) -> BuddyOutcome {
        self.emit(LinkEffect::ShowBuddy {
            open_creator: false,
        });
        if let Err(error) = self
            .backend
            .request("cohost.library.sync", json!({ "reason": "deep-link" }))
            .await
        {
            self.logger.info(format!(
                "Buddy deep link: the library sync was refused ({}).",
                error.message
            ));
        }
        let Some(alive) = link.alive else {
            return BuddyOutcome::Synced;
        };
        if let Err(error) = self
            .backend
            .request("cohost.library.use", json!({ "avatarId": alive }))
            .await
        {
            self.logger.info(format!(
                "Buddy deep link: the avatar could not be used ({}).",
                error.message
            ));
            return BuddyOutcome::Failed;
        }
        let mut saw_use = false;
        let mut waited = Duration::ZERO;
        while waited <= self.buddy_timing.timeout {
            tokio::time::sleep(self.buddy_timing.poll).await;
            waited += self.buddy_timing.poll;
            let Ok(state) = self.backend.request("cohost.library.get", json!({})).await else {
                continue;
            };
            let busy = state.get("busy").filter(|busy| !busy.is_null());
            if busy.is_some_and(|busy| {
                busy.get("kind").and_then(Value::as_str) == Some("use")
                    && busy.get("avatarId").and_then(Value::as_str) == Some(alive.as_str())
            }) {
                saw_use = true;
            }
            let active = state.get("activeAvatarId").and_then(Value::as_str);
            if busy.is_none() && active == Some(alive.as_str()) {
                self.emit(LinkEffect::ShowBuddy { open_creator: true });
                return BuddyOutcome::Opened;
            }
            if busy.is_none()
                && saw_use
                && let Some(message) = state
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
            {
                self.logger.info(format!("Buddy deep link: {message}"));
                return BuddyOutcome::Failed;
            }
        }
        self.logger.info(
            "Buddy deep link: the avatar took too long to apply; the creator was not opened.",
        );
        BuddyOutcome::Failed
    }
}

/// The `videorc://` links on a command line (a Windows or Linux protocol
/// launch passes the link as an argument).
pub fn links_in_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    let prefix = format!("{SCHEME}://");
    args.into_iter()
        .filter(|arg| arg.to_ascii_lowercase().starts_with(&prefix))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    const UUID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    #[test]
    fn buddy_links_open_with_or_without_a_known_avatar() {
        assert_eq!(
            parse_buddy_link("videorc://buddy"),
            Some(BuddyLink { alive: None })
        );
        assert_eq!(
            parse_buddy_link("videorc://buddy/library/"),
            Some(BuddyLink { alive: None })
        );
        assert_eq!(
            parse_buddy_link(&format!("videorc://buddy?alive={UUID}"))
                .unwrap()
                .alive
                .as_deref(),
            Some(UUID)
        );
        assert_eq!(
            parse_buddy_link("videorc://buddy?alive=official:orc")
                .unwrap()
                .alive
                .as_deref(),
            Some("official:orc")
        );
        // An unknown id is dropped; the link still opens Buddy.
        for alive in [
            "official:dragon",
            "NOT-A-UUID",
            "0F8FAD5B-D9CB-469F-A165-70867728950E",
        ] {
            assert_eq!(
                parse_buddy_link(&format!("videorc://buddy?alive={alive}")),
                Some(BuddyLink { alive: None }),
                "{alive}"
            );
        }
        for other in [
            "videorc://buddy/elsewhere",
            "videorc://user:pw@buddy",
            "videorc://buddy:99",
            "videorc://oauth/callback",
            "https://buddy",
            "not a url",
        ] {
            assert_eq!(parse_buddy_link(other), None, "{other}");
        }
    }

    #[test]
    fn connect_links_are_checked_like_main_and_hashed_for_dedupe() {
        let link = parse_provider_link("videorc://oauth/callback?state=abcdefgh&code=xyz").unwrap();
        assert_eq!(link.state, "abcdefgh");
        assert_eq!(link.code.as_deref(), Some("xyz"));
        // sha256("abcdefgh\nxyz\n"), base64url without padding.
        let mut hash = Sha256::new();
        hash.update("abcdefgh\nxyz\n");
        assert_eq!(link.id, base64url(&hash.finalize()));
        assert_eq!(link.id.len(), 43);
        let denied = parse_provider_link(
            "videorc://oauth/callback?state=abcdefgh&error=access_denied&error_description=No+thanks",
        )
        .unwrap();
        assert_eq!(denied.error.as_deref(), Some("access_denied"));
        assert_eq!(denied.error_description.as_deref(), Some("No thanks"));
        assert_ne!(denied.id, link.id);

        let refusals = [
            (
                "videorc://oauth/callback?state=short&code=x",
                LinkRejection::Incomplete,
            ),
            (
                "videorc://oauth/callback?state=abcdefgh",
                LinkRejection::Incomplete,
            ),
            ("videorc://oauth/callback?code=x", LinkRejection::Incomplete),
            (
                "videorc://oauth/callback?state=abcdefgh&code=x#frag",
                LinkRejection::Invalid,
            ),
            (
                "videorc://me@oauth/callback?state=abcdefgh&code=x",
                LinkRejection::Invalid,
            ),
            (
                "videorc://oauth:1/callback?state=abcdefgh&code=x",
                LinkRejection::Invalid,
            ),
            (
                "videorc://oauth/other?state=abcdefgh&code=x",
                LinkRejection::Invalid,
            ),
            (
                "https://oauth/callback?state=abcdefgh&code=x",
                LinkRejection::NotVideorc,
            ),
        ];
        for (raw, rejection) in refusals {
            assert_eq!(parse_provider_link(raw), Err(rejection), "{raw}");
        }
        let long = format!(
            "videorc://oauth/callback?state=abcdefgh&code={}",
            "c".repeat(8193)
        );
        assert_eq!(parse_provider_link(&long), Err(LinkRejection::TooLarge));
    }

    fn account_code(expires: u64) -> String {
        format!(
            "v3.{expires}.{}.{}.{}",
            "n".repeat(16),
            "body_-".repeat(4),
            "t".repeat(22)
        )
    }

    #[test]
    fn account_links_are_parsed_and_refused_without_a_sign_in_this_app_started() {
        let state = "s".repeat(40);
        let code = account_code(1_900_000_000_000);
        let raw = format!(
            "videorc://account/callback?state={state}&code={code}&code_expires_at_ms=1900000000000"
        );
        assert_eq!(
            parse_account_link(&raw),
            Ok(AccountLink {
                state: state.clone(),
                code: code.clone(),
                code_expires_at_ms: 1_900_000_000_000
            })
        );
        // The code never reaches a log line through Debug.
        let printed = format!("{:?}", parse_account_link(&raw).unwrap());
        assert!(!printed.contains(&code), "{printed}");
        assert!(matches!(parse_link(&raw), Ok(DeepLink::Account(_))));
        let mismatch =
            format!("videorc://account/callback?state={state}&code={code}&code_expires_at_ms=1");
        assert_eq!(
            parse_account_link(&mismatch),
            Err(LinkRejection::ExpiryMismatch)
        );
        let extra = format!("{raw}&verifier={}", "v".repeat(40));
        assert_eq!(parse_account_link(&extra), Err(LinkRejection::Incomplete));
        let bad_code = format!(
            "videorc://account/callback?state={state}&code=v2.{}&code_expires_at_ms=1",
            "x".repeat(40)
        );
        assert_eq!(parse_account_link(&bad_code), Err(LinkRejection::Invalid));
        assert_eq!(
            parse_account_link(&format!(
                "videorc://account/callback?state=short&code={code}&code_expires_at_ms=1900000000000"
            )),
            Err(LinkRejection::Incomplete)
        );
    }

    #[test]
    fn the_queue_dedupes_caps_expires_and_acknowledges() {
        let mut queue = ProviderLinkQueue::new(1_000, 2);
        let link = |state: &str| {
            parse_provider_link(&format!("videorc://oauth/callback?state={state}&code=c")).unwrap()
        };
        let (first, new) = queue.accept(link("aaaaaaaa"), 10).unwrap();
        assert!(new);
        let (again, new) = queue.accept(link("aaaaaaaa"), 20).unwrap();
        assert!(!new);
        assert_eq!(again, first);
        queue.accept(link("bbbbbbbb"), 30).unwrap();
        assert_eq!(
            queue.accept(link("cccccccc"), 40),
            Err(LinkRejection::QueueFull)
        );
        assert!(queue.acknowledge(&first.link.id));
        assert!(!queue.acknowledge(&first.link.id));
        assert_eq!(queue.pending(500).len(), 1);
        assert!(queue.pending(1_031).is_empty(), "expired after its ttl");
    }

    #[test]
    fn the_retry_schedule_is_the_renderer_s() {
        let delays: Vec<Option<u64>> = (0..8)
            .map(|retries| provider_retry_delay_ms(0, retries, 0))
            .collect();
        assert_eq!(
            delays,
            [
                Some(500),
                Some(1_000),
                Some(2_000),
                Some(4_000),
                Some(8_000),
                Some(10_000),
                Some(20_000),
                Some(20_000)
            ]
        );
        assert_eq!(provider_retry_delay_ms(0, 0, PROVIDER_LINK_TTL_MS), None);
        assert_eq!(
            provider_retry_delay_ms(0, 7, PROVIDER_LINK_TTL_MS - 5_000),
            Some(5_000)
        );
        assert_eq!(provider_retry_delay_ms(0, max_retry_count(), 0), None);
    }

    #[test]
    fn links_on_a_command_line_are_found_by_scheme() {
        assert_eq!(
            links_in_args([
                "--profile".to_string(),
                "/tmp/x".to_string(),
                "VIDEORC://buddy".to_string(),
                "videorc://oauth/callback?state=x".to_string(),
                "https://videorc.com".to_string(),
            ]),
            ["VIDEORC://buddy", "videorc://oauth/callback?state=x"]
        );
    }

    /// A backend that answers each method from a script and records the
    /// requests.
    #[derive(Default)]
    struct ScriptedBackend {
        answers: Mutex<VecDeque<(String, Result<Value, RpcError>)>>,
        requests: Mutex<Vec<(String, Value)>>,
    }

    impl ScriptedBackend {
        fn answer(&self, method: &str, result: Result<Value, RpcError>) {
            self.answers
                .lock()
                .unwrap()
                .push_back((method.to_string(), result));
        }

        fn methods(&self) -> Vec<String> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .map(|(method, _)| method.clone())
                .collect()
        }
    }

    impl LinkBackend for ScriptedBackend {
        async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            let mut answers = self.answers.lock().unwrap();
            let index = answers.iter().position(|(m, _)| m == method);
            match index.and_then(|index| answers.remove(index)) {
                Some((_, result)) => result,
                None => Err(RpcError::new(method, "not-scripted", "no answer")),
            }
        }
    }

    fn make_links(backend: &Arc<ScriptedBackend>) -> Arc<DeepLinks<ScriptedBackend>> {
        Arc::new(
            DeepLinks::new(backend.clone(), Logger::silent())
                .with_buddy_timing(BuddyTiming {
                    poll: Duration::from_millis(1),
                    timeout: Duration::from_millis(200),
                })
                .with_clock(|| 1_000),
        )
    }

    #[tokio::test]
    async fn a_connect_link_reaches_the_backend_and_retires_on_a_final_answer() {
        let backend = Arc::new(ScriptedBackend::default());
        backend.answer(
            "platformAccounts.oauth.complete",
            Err(RpcError::new(
                "platformAccounts.oauth.complete",
                "not-connected",
                "",
            )),
        );
        backend.answer(
            "platformAccounts.oauth.complete",
            Ok(json!({ "status": "success", "retryable": true })),
        );
        backend.answer(
            "platformAccounts.oauth.complete",
            Ok(json!({ "status": "unknown-state", "retryable": false })),
        );
        let links = make_links(&backend);
        let mut effects = links.effects();
        let link = parse_provider_link(
            "videorc://oauth/callback?state=abcdefgh&code=xyz&error_description=x",
        )
        .unwrap();
        let (envelope, _) = links.lock().queue.accept(link, 1_000).unwrap();
        // Two retries on the renderer's schedule: 0.5 s, then 1 s.
        let outcome = links.complete_connect(envelope).await;
        assert_eq!(outcome.attempts, 3);
        assert!(outcome.completed);
        assert_eq!(outcome.status.as_deref(), Some("unknown-state"));
        let requests = backend.requests.lock().unwrap().clone();
        assert_eq!(
            requests[0].1,
            json!({ "state": "abcdefgh", "code": "xyz", "errorDescription": "x" })
        );
        assert!(links.snapshot().connect_waiting.is_empty());
        assert!(
            effects.try_recv().is_err(),
            "completion alone shows nothing"
        );
    }

    #[tokio::test]
    async fn receive_takes_a_connect_link_once_and_refuses_an_account_link_by_name() {
        let backend = Arc::new(ScriptedBackend::default());
        backend.answer(
            "platformAccounts.oauth.complete",
            Ok(json!({ "status": "unknown-state", "retryable": false })),
        );
        let links = make_links(&backend);
        let mut effects = links.effects();
        let raw = "videorc://oauth/callback?state=abcdefgh&code=xyz";
        let taken = links.receive(raw, LinkSource::AppleEvent);
        assert!(taken.accepted);
        assert_eq!(taken.kind, LinkKind::Connect);
        assert_eq!(effects.recv().await.unwrap(), LinkEffect::ShowMainWindow);
        for _ in 0..100 {
            if !links.snapshot().connect_outcomes.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let snapshot = links.snapshot();
        assert_eq!(snapshot.connect_outcomes.len(), 1);
        assert!(snapshot.connect_outcomes[0].completed);
        assert_eq!(backend.methods(), ["platformAccounts.oauth.complete"]);

        let state = "s".repeat(40);
        let code = account_code(1_900_000_000_000);
        let account = links.receive(
            &format!(
                "videorc://account/callback?state={state}&code={code}&code_expires_at_ms=1900000000000"
            ),
            LinkSource::SecondInstance,
        );
        assert!(!account.accepted);
        assert_eq!(account.kind, LinkKind::Account);
        assert_eq!(account.rejection, Some(LinkRejection::NoActiveSignIn));
        let unknown = links.receive("videorc://nowhere", LinkSource::CommandLine);
        assert_eq!(unknown.rejection, Some(LinkRejection::Unknown));
        assert_eq!(links.snapshot().received.len(), 3);
        // Nothing the smokes read carries the link's code.
        let text = serde_json::to_string(&links.snapshot()).unwrap();
        assert!(!text.contains("xyz"), "{text}");
    }

    #[tokio::test]
    async fn an_account_link_goes_to_the_sign_in_once_the_app_has_one() {
        struct Sink(Mutex<Vec<AccountLink>>);
        impl AccountLinkSink for Sink {
            fn accept(&self, link: AccountLink) -> Result<(), LinkRejection> {
                if link.state.starts_with('x') {
                    return Err(LinkRejection::NoActiveSignIn);
                }
                self.0.lock().unwrap().push(link);
                Ok(())
            }
        }
        let backend = Arc::new(ScriptedBackend::default());
        let links = make_links(&backend);
        let sink = Arc::new(Sink(Mutex::new(Vec::new())));
        links.set_account_sink(sink.clone());
        let mut effects = links.effects();
        let code = account_code(1_900_000_000_000);
        let raw = |state: &str| {
            format!(
                "videorc://account/callback?state={state}&code={code}&code_expires_at_ms=1900000000000"
            )
        };
        let taken = links.receive(&raw(&"s".repeat(40)), LinkSource::AppleEvent);
        assert!(taken.accepted, "{taken:?}");
        assert_eq!(effects.recv().await.unwrap(), LinkEffect::ShowMainWindow);
        let held = sink.0.lock().unwrap().clone();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].code, code);
        // The sink's refusal is the link's, by name.
        let refused = links.receive(&raw(&"x".repeat(40)), LinkSource::AppleEvent);
        assert_eq!(refused.rejection, Some(LinkRejection::NoActiveSignIn));
        // Nothing reached the backend: the sink completes it.
        assert!(backend.methods().is_empty());
        let text = serde_json::to_string(&links.snapshot()).unwrap();
        assert!(!text.contains(&code), "{text}");
    }

    #[tokio::test]
    async fn a_buddy_link_syncs_uses_the_avatar_and_opens_the_creator_once_it_is_worn() {
        let backend = Arc::new(ScriptedBackend::default());
        backend.answer("cohost.library.sync", Ok(json!({ "accepted": true })));
        backend.answer("cohost.library.use", Ok(json!({ "accepted": true })));
        backend.answer(
            "cohost.library.get",
            Ok(json!({ "activeAvatarId": null, "busy": { "kind": "use", "avatarId": UUID } })),
        );
        backend.answer(
            "cohost.library.get",
            Ok(json!({ "activeAvatarId": UUID, "busy": null })),
        );
        let links = make_links(&backend);
        let mut effects = links.effects();
        let outcome = links
            .run_buddy(BuddyLink {
                alive: Some(UUID.to_string()),
            })
            .await;
        assert_eq!(outcome, BuddyOutcome::Opened);
        assert_eq!(
            effects.try_recv().unwrap(),
            LinkEffect::ShowBuddy {
                open_creator: false
            }
        );
        assert_eq!(
            effects.try_recv().unwrap(),
            LinkEffect::ShowBuddy { open_creator: true }
        );
        let requests = backend.requests.lock().unwrap().clone();
        assert_eq!(requests[0].1, json!({ "reason": "deep-link" }));
        assert_eq!(requests[1].1, json!({ "avatarId": UUID }));
    }

    #[tokio::test]
    async fn a_buddy_link_without_an_avatar_only_syncs_and_a_failed_use_never_opens_the_creator() {
        let backend = Arc::new(ScriptedBackend::default());
        backend.answer(
            "cohost.library.sync",
            Err(RpcError::new(
                "cohost.library.sync",
                "signed-out",
                "Sign in first.",
            )),
        );
        let links = make_links(&backend);
        assert_eq!(
            links.run_buddy(BuddyLink { alive: None }).await,
            BuddyOutcome::Synced
        );

        let backend = Arc::new(ScriptedBackend::default());
        backend.answer("cohost.library.sync", Ok(json!({})));
        backend.answer("cohost.library.use", Ok(json!({ "accepted": true })));
        backend.answer(
            "cohost.library.get",
            Ok(json!({ "busy": { "kind": "use", "avatarId": UUID } })),
        );
        backend.answer(
            "cohost.library.get",
            Ok(json!({ "busy": null, "activeAvatarId": null, "error": { "code": "x", "message": "Couldn't use it." } })),
        );
        let links = make_links(&backend);
        let mut effects = links.effects();
        assert_eq!(
            links
                .run_buddy(BuddyLink {
                    alive: Some(UUID.to_string())
                })
                .await,
            BuddyOutcome::Failed
        );
        assert_eq!(
            effects.try_recv().unwrap(),
            LinkEffect::ShowBuddy {
                open_creator: false
            }
        );
        assert!(effects.try_recv().is_err(), "the creator never opens");
    }
}
