//! S3.5a: the platform accounts as the Studio runs them (use-studio's
//! platform accounts, ~2863–2900, `connectPlatformAccount`,
//! `disconnectPlatformAccount`, `refreshYouTubeChannels`,
//! `selectYouTubeChannel`, `refreshXNativeCapability`, `authorizeXLive`,
//! `patchStreamingTarget`, `saveManualStreamKey`,
//! `restorePreviousStreamKey`).
//!
//! The accounts live apart from the snapshot ([`PlatformsState`] on their
//! own watch), so a validation or a channel list never redraws the Studio.
//! A destination's edit goes through the capture config (S3.0d), and a
//! stream key only through the backend's secrets: the config never holds
//! one.

use serde_json::{Value, json};

use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::livestream::accounts::{
    AccountValidation, PlatformAccount, ProviderCredentials, StoredKey, XCapability,
    YouTubeChannel, connect_optional_scopes, is_oauth_available, platform_label,
};
use crate::livestream::targets::{self, TargetPatch};
use crate::livestream::x_categories::{XLiveCategoriesResult, XLiveCategoriesStatus};
use crate::livestream::x_live_edit::{self, XBroadcastUpdated, XLiveChanges};
use crate::livestream::{ACCOUNTS_CHANGED_EVENT, PlatformsState, copy, methods};
use crate::notices::{NoticeAction, NoticeCommand, NoticeLifetime, ToastRequest};
use crate::user_error::UserErrorContext;

/// `BROWSER_APPROVAL_TOAST_ID`: one waiting-browser toast at a time; it goes
/// once the accounts change.
pub const BROWSER_APPROVAL_TOAST_ID: &str = "oauth-authorization-link";
/// `showBrowserApproval`'s line.
pub const BROWSER_APPROVAL_DESCRIPTION: &str =
    "Signed in on a different browser? Copy the link and open it there instead.";

/// A context for a failure toast.
fn context(action: &'static str, object: &'static str) -> UserErrorContext {
    UserErrorContext { action, object }
}

/// The platform's name as a `'static` object for a toast's title.
fn platform_object(platform: &str) -> &'static str {
    platform_label(platform)
}

/// `shouldAutoRefreshYouTubeChannels`: a connected account the last check
/// did not refuse.
fn should_auto_refresh_youtube(
    account: &PlatformAccount,
    validations: &[AccountValidation],
) -> bool {
    use crate::livestream::accounts::{AccountStatus, ValidationState};
    account.status == AccountStatus::Connected
        && !validations.iter().any(|v| {
            v.platform == "youtube"
                && matches!(
                    v.state,
                    ValidationState::NeedsReconnect | ValidationState::Missing
                )
        })
}

impl<B: StudioBackend> Studio<B> {
    /// S3.5a: the platform accounts, as they change.
    pub fn platforms(&self) -> tokio::sync::watch::Receiver<PlatformsState> {
        self.platforms_tx.subscribe()
    }

    /// The platform accounts as they are now.
    pub fn platforms_now(&self) -> PlatformsState {
        self.platforms_tx.borrow().clone()
    }

    fn edit_platforms(&self, edit: impl FnOnce(&mut PlatformsState)) {
        self.platforms_tx.send_if_modified(|state| {
            let before = state.clone();
            edit(state);
            *state != before
        });
    }

    async fn livestream_call(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, RpcError> {
        self.backend.livestream_request(method, params).await
    }

    /// `refreshPlatformAccountsForClient` then `validatePlatformAccounts`:
    /// the bootstrap's read. A backend without them leaves the last list.
    pub(super) async fn read_platforms(&self) {
        self.edit_platforms(|state| state.hints_asked.clear());
        // S3.5c: YouTube's quota status (plan 094); none answers as not paused.
        if let Ok(status) = self
            .livestream_call(methods::YOUTUBE_QUOTA_STATUS, Value::Null)
            .await
        {
            self.take_youtube_quota(&status);
        }
        self.refresh_platform_accounts().await;
        self.validate_platform_accounts().await;
        self.follow_platform_accounts().await;
        self.hydrate_key_hints().await;
    }

    /// Keys saved before hints existed (or by an older build, or read back
    /// from the store, which keeps no hint) say which key is saved once the
    /// backend answers (`streamTargets.manualKey.inspect`). Cosmetic: a
    /// failure stays silent, and each key is asked once per connection.
    pub async fn hydrate_key_hints(&self) {
        let list = targets::targets(&self.snapshot().settings.capture_doc);
        let asked = self.platforms_now().hints_asked;
        let pending: Vec<String> = list
            .into_iter()
            .filter(|t| t.stream_key_present && t.stream_key_hint.is_none())
            .map(|t| t.id)
            .filter(|id| !asked.contains(id))
            .collect();
        for id in pending {
            self.edit_platforms(|state| state.hints_asked.push(id.clone()));
            let Ok(stored) = self
                .livestream_call(methods::MANUAL_KEY_INSPECT, json!({ "targetId": id }))
                .await
                .and_then(|value| {
                    super::backend::read_json::<StoredKey>(methods::MANUAL_KEY_INSPECT, value)
                })
            else {
                return;
            };
            let now = (self.config.clock)();
            let _ = self
                .update_capture_config(|config| {
                    targets::apply_stored_key(config, &id, &stored, &now)
                })
                .await;
        }
    }

    /// `platformAccounts.list` and `.oauth.providerCredentials`.
    pub async fn refresh_platform_accounts(&self) {
        let (accounts, credentials) = tokio::join!(
            self.livestream_call(methods::ACCOUNTS_LIST, Value::Null),
            self.livestream_call(methods::PROVIDER_CREDENTIALS, Value::Null),
        );
        let accounts = accounts
            .ok()
            .and_then(|v| serde_json::from_value::<Vec<PlatformAccount>>(v).ok());
        let credentials = credentials
            .ok()
            .and_then(|v| serde_json::from_value::<Vec<ProviderCredentials>>(v).ok());
        self.edit_platforms(|state| {
            if let Some(accounts) = accounts {
                state.accounts = accounts;
                state.loaded = true;
            }
            if let Some(credentials) = credentials {
                state.credentials = credentials;
            }
        });
    }

    /// `platformAccounts.validate`.
    pub async fn validate_platform_accounts(&self) {
        if let Ok(value) = self
            .livestream_call(methods::ACCOUNTS_VALIDATE, Value::Null)
            .await
            && let Ok(validations) = serde_json::from_value::<Vec<AccountValidation>>(value)
        {
            self.edit_platforms(|state| state.validations = validations);
        }
    }

    /// The effects on the accounts: YouTube's channels for a connected
    /// account, X Live's capability for an X account (each only then).
    async fn follow_platform_accounts(&self) {
        let state = self.platforms_now();
        match state.account("youtube") {
            Some(account) if should_auto_refresh_youtube(account, &state.validations) => {
                self.refresh_youtube_channels(Some(account.account_id.clone()), true)
                    .await;
            }
            _ => self.edit_platforms(|state| state.youtube_channels.clear()),
        }
        match state.account("x") {
            Some(account) => {
                self.refresh_x_capability(Some(account.account_id.clone()))
                    .await;
            }
            None => {
                self.edit_platforms(|state| state.x_capability = None);
                self.clear_x_live_categories();
            }
        }
    }

    /// `platformAccounts.changed`: the whole list; the waiting-browser toast
    /// goes. True when the event was the accounts'.
    pub(super) async fn handle_platforms_event(&self, event: &str, payload: &Value) -> bool {
        if event == crate::livestream::OAUTH_CALLBACK_EVENT {
            self.handle_oauth_callback(payload).await;
            return true;
        }
        if event == crate::livestream::YOUTUBE_QUOTA_EVENT {
            self.take_youtube_quota(payload);
            return true;
        }
        if event != ACCOUNTS_CHANGED_EVENT {
            return false;
        }
        self.post(vec![NoticeCommand::Dismiss(
            BROWSER_APPROVAL_TOAST_ID.to_string(),
        )]);
        match serde_json::from_value::<Vec<PlatformAccount>>(payload.clone()) {
            Ok(accounts) => {
                self.edit_platforms(|state| {
                    state.accounts = accounts;
                    state.loaded = true;
                });
                // Never validated again here: a validation re-announces the
                // accounts (its stamps change), so validating on the
                // announcement loops on `channels.list` (Electron validates at
                // the bootstrap, after a connect, a channel pick and before Go
                // Live only).
                self.follow_platform_accounts().await;
            }
            Err(error) => self
                .config
                .logger
                .warn(format!("Studio: \"{event}\" did not read ({error}).")),
        }
        true
    }

    /// S3.5c: YouTube's quota status (`youtube.quota`, `youtube.quota.status`):
    /// the pause the cards and Go Live read.
    fn take_youtube_quota(&self, status: &Value) {
        let paused = status
            .get("pausedUntil")
            .and_then(Value::as_str)
            .filter(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok())
            .map(str::to_string);
        self.edit_platforms(|state| state.youtube_quota_paused_until = paused);
    }

    /// S3.5c: `platformAccounts.oauth.callback` (`showOAuthCallbackResult`,
    /// one toast per platform that replaces the last): Connected, X Live is
    /// on, or why it couldn't finish; a connected account is read again.
    async fn handle_oauth_callback(&self, payload: &Value) {
        let platform = payload.get("platform").and_then(Value::as_str);
        let status = payload.get("status").and_then(Value::as_str);
        let id = format!("oauth-callback:{}", platform.unwrap_or("provider"));
        let name = platform.map(platform_label).unwrap_or(copy::THE_ACCOUNT);
        let connected = payload.get("accountConnected").and_then(Value::as_bool) == Some(true);
        let token = payload.get("tokenStored").and_then(Value::as_bool) == Some(true);
        let notice = match status {
            Some("success") if connected => Some(
                ToastRequest::success(if platform.is_some() {
                    copy::connected_platform(name)
                } else {
                    copy::ACCOUNT_CONNECTED.to_string()
                })
                .id(id.clone())
                .finish(),
            ),
            Some("success") if platform == Some("x") && token => Some(
                ToastRequest::success(copy::X_LIVE_ON)
                    .id(id.clone())
                    .finish(),
            ),
            Some("success") => None,
            _ => {
                let retry_at = payload.get("retryAt").and_then(Value::as_str);
                let description = match (payload.get("reason").and_then(Value::as_str), retry_at) {
                    (Some("youtube-quota"), Some(at)) => copy::youtube_connect_paused(
                        &copy::format_resume_time(at, chrono::Local::now()),
                    ),
                    _ => payload
                        .get("message")
                        .and_then(Value::as_str)
                        .or(status)
                        .unwrap_or(copy::CONNECTION_NOT_COMPLETED)
                        .to_string(),
                };
                Some(
                    ToastRequest::error(copy::couldnt_finish_connecting(name))
                        .id(id.clone())
                        .description(description)
                        .finish(),
                )
            }
        };
        match notice {
            Some(notice) => self.post(vec![NoticeCommand::Show(notice)]),
            None => self.post(vec![NoticeCommand::Dismiss(id)]),
        }
        if status == Some("success") && connected {
            self.refresh_platform_accounts().await;
            self.validate_platform_accounts().await;
        } else if status == Some("success") && platform == Some("x") && token {
            let account = self
                .platforms_now()
                .account("x")
                .map(|a| a.account_id.clone());
            self.refresh_x_capability(account).await;
        }
    }

    /// `connectPlatformAccount(platform, options)`: the sign-in starts in
    /// the backend (`platformAccounts.oauth.startProvider`, the loopback
    /// callback for every provider) and answers its page, which the caller
    /// opens in the browser. `None` when it never got that far (the reason
    /// is toasted; a platform that can't sign in says so on its card).
    pub async fn start_platform_sign_in(
        &self,
        platform: &str,
        optional_scopes: Vec<&'static str>,
    ) -> Option<String> {
        if !is_oauth_available(platform) {
            return None;
        }
        let ctx = context(copy::ACTION_CONNECT, platform_object(platform));
        if !self.is_connected() {
            self.post(vec![crate::user_error::toast_offline(ctx)]);
            return None;
        }
        let mut params = json!({ "platform": platform });
        if !optional_scopes.is_empty() {
            params["optionalScopes"] = json!(optional_scopes);
        }
        match self
            .livestream_call(methods::OAUTH_START_PROVIDER, params)
            .await
        {
            Ok(result) => result
                .get("authUrl")
                .and_then(Value::as_str)
                .map(str::to_string),
            Err(error) => {
                self.report_error(&error, ctx);
                None
            }
        }
    }

    /// Connect's scopes (`platformConnectOptions`).
    pub fn connect_scopes(platform: &str) -> Vec<&'static str> {
        connect_optional_scopes(platform)
    }

    /// `disconnectPlatformAccount`: the account goes, and so does every
    /// destination's hold on it; "Disconnected {platform}".
    pub async fn disconnect_platform(&self, platform: &str) -> bool {
        let ctx = context(copy::ACTION_DISCONNECT, platform_object(platform));
        if !self.is_connected() {
            self.post(vec![crate::user_error::toast_offline(ctx)]);
            return false;
        }
        match self
            .livestream_call(methods::DISCONNECT, json!({ "platform": platform }))
            .await
        {
            Ok(_) => {
                self.refresh_platform_accounts().await;
                let platform_owned = platform.to_string();
                let _ = self
                    .update_capture_config(|config| {
                        targets::forget_account(config, &platform_owned)
                    })
                    .await;
                self.post(vec![NoticeCommand::Show(
                    ToastRequest::success(copy::disconnected(platform_label(platform))).finish(),
                )]);
                true
            }
            Err(error) => {
                self.report_error(&error, ctx);
                false
            }
        }
    }

    /// `patchStreamingTarget`: the destination's edit, saved.
    pub async fn patch_stream_target(&self, target_id: &str, patch: TargetPatch) {
        let now = (self.config.clock)();
        let id = target_id.to_string();
        let _ = self
            .update_capture_config(|config| targets::patch_target(config, &id, &patch, &now))
            .await;
    }

    /// `withStreamQuality`: the default stream quality.
    pub async fn set_stream_quality(&self, preset: &str) {
        let preset = preset.to_string();
        let _ = self
            .update_capture_config(|config| targets::set_stream_quality(config, &preset))
            .await;
    }

    /// `saveManualStreamKey`: the key into the backend's secrets, and the
    /// row takes its hint (the row is the confirmation, J2-11). An empty key
    /// removes it (kept as the previous one). True once stored.
    pub async fn save_manual_stream_key(&self, target_id: &str, stream_key: &str) -> bool {
        let ctx = crate::user_error::SAVE_THE_STREAM_KEY;
        if !self.is_connected() {
            self.post(vec![crate::user_error::toast_offline(ctx)]);
            return false;
        }
        let answer = self
            .livestream_call(
                methods::MANUAL_KEY_STORE,
                json!({ "targetId": target_id, "streamKey": stream_key }),
            )
            .await;
        self.apply_key_answer(target_id, answer, ctx).await
    }

    /// `restorePreviousStreamKey`: the archived key swaps back in.
    pub async fn restore_previous_stream_key(&self, target_id: &str) -> bool {
        let ctx = crate::user_error::RESTORE_THE_PREVIOUS_STREAM_KEY;
        if !self.is_connected() {
            self.post(vec![crate::user_error::toast_offline(ctx)]);
            return false;
        }
        let answer = self
            .livestream_call(
                methods::MANUAL_KEY_RESTORE,
                json!({ "targetId": target_id }),
            )
            .await;
        self.apply_key_answer(target_id, answer, ctx).await
    }

    async fn apply_key_answer(
        &self,
        target_id: &str,
        answer: Result<Value, RpcError>,
        ctx: UserErrorContext,
    ) -> bool {
        match answer.and_then(|value| {
            super::backend::read_json::<StoredKey>("streamTargets.manualKey", value)
        }) {
            Ok(stored) => {
                let now = (self.config.clock)();
                let id = target_id.to_string();
                let _ = self
                    .update_capture_config(|config| {
                        targets::apply_stored_key(config, &id, &stored, &now)
                    })
                    .await;
                true
            }
            Err(error) => {
                self.report_error(&error, ctx);
                false
            }
        }
    }

    /// `refreshYouTubeChannels`.
    pub async fn refresh_youtube_channels(&self, account_id: Option<String>, background: bool) {
        self.edit_platforms(|state| state.youtube_channels_loading = true);
        let answer = self
            .livestream_call(
                methods::YOUTUBE_CHANNELS,
                json!({ "accountId": account_id }),
            )
            .await;
        let channels = answer.and_then(|value| {
            super::backend::read_json::<Value>(methods::YOUTUBE_CHANNELS, value).and_then(|v| {
                super::backend::read_json::<Vec<YouTubeChannel>>(
                    methods::YOUTUBE_CHANNELS,
                    v.get("channels").cloned().unwrap_or(Value::Null),
                )
            })
        });
        match channels {
            Ok(channels) => self.edit_platforms(|state| {
                state.youtube_channels = channels;
                state.youtube_channels_loading = false;
            }),
            Err(error) => {
                self.edit_platforms(|state| {
                    state.youtube_channels.clear();
                    state.youtube_channels_loading = false;
                });
                if !background {
                    self.report_error(&error, context("load", "your YouTube channels"));
                }
            }
        }
    }

    /// `selectYouTubeChannel`.
    pub async fn select_youtube_channel(&self, channel_id: &str, account_id: Option<String>) {
        let ctx = context("change", "the YouTube channel");
        if !self.is_connected() {
            self.post(vec![crate::user_error::toast_offline(ctx)]);
            return;
        }
        let answer = self
            .livestream_call(
                methods::YOUTUBE_SELECT_CHANNEL,
                json!({ "accountId": account_id, "channelId": channel_id }),
            )
            .await
            .and_then(|value| {
                super::backend::read_json::<PlatformAccount>(methods::YOUTUBE_SELECT_CHANNEL, value)
            });
        match answer {
            Ok(selected) => {
                self.refresh_platform_accounts().await;
                self.validate_platform_accounts().await;
                let chosen = selected.clone();
                let _ = self
                    .update_capture_config(|config| targets::take_youtube_channel(config, &chosen))
                    .await;
                self.refresh_youtube_channels(Some(selected.account_id), false)
                    .await;
            }
            Err(error) => self.report_error(&error, ctx),
        }
    }

    /// `refreshXNativeCapability`.
    pub async fn refresh_x_capability(&self, account_id: Option<String>) {
        self.edit_platforms(|state| state.x_capability_loading = true);
        let answer = self
            .livestream_call(methods::X_CAPABILITY, json!({ "accountId": account_id }))
            .await
            .and_then(|value| {
                super::backend::read_json::<XCapability>(methods::X_CAPABILITY, value)
            });
        match answer {
            Ok(capability) => {
                let ready = capability.native_available;
                self.edit_platforms(|state| {
                    state.x_capability = Some(capability);
                    state.x_capability_loading = false;
                });
                // `xLiveReady`'s effect: X's categories once X Live can go
                // live; back to idle (and empty) when it can't.
                if ready {
                    let status = self.platforms_now().x_live_categories_status;
                    if matches!(
                        status,
                        XLiveCategoriesStatus::Idle | XLiveCategoriesStatus::Failed
                    ) {
                        self.load_x_live_categories(false).await;
                    }
                } else {
                    self.clear_x_live_categories();
                }
            }
            Err(error) => {
                self.edit_platforms(|state| {
                    state.x_capability = None;
                    state.x_capability_loading = false;
                });
                self.clear_x_live_categories();
                // `reportError(error)`: no action named ("Videorc hit a
                // problem"), as the renderer's.
                if self.is_connected() {
                    let copy = crate::user_error::user_error_message(
                        crate::user_error::Failure::Rpc(&error),
                        None,
                    );
                    let toast = if copy.warning {
                        ToastRequest::warning(copy.title)
                    } else {
                        ToastRequest::error(copy.title)
                    };
                    self.post(vec![NoticeCommand::Show(
                        toast.description(copy.description).finish(),
                    )]);
                }
            }
        }
    }

    /// `loadXLiveCategories`: X's live categories (sorted by viewership,
    /// changing rarely) for the Stream details picker. A failed read is the
    /// picker's to say, never a notification: nobody pressed anything.
    pub async fn load_x_live_categories(&self, refresh: bool) {
        let account_id = self
            .platforms_now()
            .account("x")
            .map(|account| account.account_id.clone());
        self.edit_platforms(|state| {
            state.x_live_categories_status = XLiveCategoriesStatus::Loading;
        });
        let mut params = json!({ "accountId": account_id });
        if refresh {
            params["refresh"] = json!(true);
        }
        let answer = self
            .livestream_call(methods::X_LIVE_CATEGORIES, params)
            .await
            .and_then(|value| {
                super::backend::read_json::<XLiveCategoriesResult>(
                    methods::X_LIVE_CATEGORIES,
                    value,
                )
            });
        match answer {
            Ok(result) => self.edit_platforms(|state| {
                state.x_live_categories = result.categories;
                state.x_live_categories_status = XLiveCategoriesStatus::Ready;
            }),
            Err(_) => {
                self.edit_platforms(|state| {
                    state.x_live_categories_status = XLiveCategoriesStatus::Failed;
                });
            }
        }
    }

    /// `updateXBroadcast`: the changes go to X now; X's answer, or the words
    /// for "X didn't take the change: …".
    pub async fn update_x_broadcast(
        &self,
        account_id: Option<String>,
        broadcast_id: String,
        changes: XLiveChanges,
    ) -> Result<XBroadcastUpdated, String> {
        if !self.is_connected() {
            return Err(x_live_edit::X_UPDATE_OFFLINE.to_string());
        }
        let mut params = json!({ "broadcastId": broadcast_id });
        if let Some(account_id) = account_id {
            params["accountId"] = json!(account_id);
        }
        if let Some(title) = changes.title {
            params["title"] = json!(title);
        }
        if let Some(category) = changes.live_category_id {
            params["liveCategoryId"] = json!(category);
        }
        self.livestream_call(methods::X_UPDATE_BROADCAST, params)
            .await
            .and_then(|value| {
                super::backend::read_json::<XBroadcastUpdated>(methods::X_UPDATE_BROADCAST, value)
            })
            .map_err(|error| error.message)
    }

    fn clear_x_live_categories(&self) {
        self.edit_platforms(|state| {
            state.x_live_categories.clear();
            state.x_live_categories_status = XLiveCategoriesStatus::Idle;
        });
    }

    /// `authorizeXLive`: the approval page, for the caller to open; the
    /// waiting-browser toast says so.
    pub async fn start_x_live_authorization(&self) -> Option<String> {
        let ctx = context("start", "X Live approval");
        if !self.is_connected() {
            self.post(vec![crate::user_error::toast_offline(ctx)]);
            return None;
        }
        match self
            .livestream_call(methods::X_START_LIVE_AUTHORIZATION, json!({}))
            .await
        {
            Ok(result) => {
                let url = result.get("authUrl").and_then(Value::as_str)?.to_string();
                self.show_browser_approval(copy::APPROVE_X_LIVE, &url);
                Some(url)
            }
            Err(error) => {
                self.report_error(&error, ctx);
                None
            }
        }
    }

    /// `reportError(error, context)`: the diagnostic record, the Premium
    /// upgrade for a Premium refusal, else `showBackendError`.
    pub(super) fn report_error(&self, error: &RpcError, context: UserErrorContext) {
        let connected = {
            let mut inner = self.lock();
            self.note_error(&mut inner, &error.method, error);
            matches!(inner.connection, super::Connection::Connected { .. })
        };
        self.publish();
        let message = error.message.trim();
        if crate::notices::is_premium_upgrade_message(message) {
            self.post(vec![NoticeCommand::Show(crate::notices::premium_upgrade(
                message, None,
            ))]);
            return;
        }
        if let Some(command) = crate::user_error::backend_error_toast(error, connected, context) {
            self.post(vec![command]);
        }
    }

    /// `showBrowserApproval`: until the accounts change, with the link to
    /// copy into the browser that is signed in.
    pub fn show_browser_approval(&self, title: &str, url: &str) {
        self.post(vec![NoticeCommand::Show(
            ToastRequest::info(title)
                .id(BROWSER_APPROVAL_TOAST_ID)
                .description(BROWSER_APPROVAL_DESCRIPTION)
                .duration(NoticeLifetime::UntilClosed)
                .action(
                    copy::COPY_LINK,
                    NoticeAction::Copy {
                        text: url.to_string(),
                    },
                )
                .finish(),
        )]);
    }
}
