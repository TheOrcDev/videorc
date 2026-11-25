//! The Videorc account in the app (plan 260 S1.6f, L4): the core's
//! [`Accounts`] on this backend, and the doors every page uses.
//!
//! - Reads and the callback's completion go on the client's renderer
//!   socket; the intent, sign-out and refresh on an admin socket of their
//!   own, as Electron main's `requestBackendAdmin` does (the backend refuses
//!   them on the renderer's credential).
//! - [`start`] follows the backend's events: every `backend.ready` reads the
//!   account again, `account.changed` and `entitlements.updated` update it.
//!   Account links (`videorc://account/callback`) reach it through the deep
//!   links' sink.
//! - [`sign_in`] is `beginVideorcSignIn`: the page opens in the system
//!   browser; a refusal is a toast, never dropped. [`sign_out`] is the
//!   menu's Sign out.
//!
//! Nothing here logs a URL with a state or a code: the sign-in page's URL
//! goes to the browser only.

use std::sync::Arc;
use std::time::Duration;

use gpui::{App, Global};
use serde_json::Value;
use tokio::runtime::Handle;
use tokio::sync::{broadcast::error::RecvError, watch};
use videorc_app_core::accounts::{Accounts, AccountsBackend, AccountsEvent, WebLinks, copy};
use videorc_app_core::client::{BackendSocket, RpcError};
use videorc_app_core::notices::{NoticeAction, NoticeCommand, ToastRequest};
use videorc_app_core::user_error::{Failure, UserErrorContext, toast_user_error};
use videorc_app_core::{BackendClient, BackendEvent, BackendState, Studio};

/// `requestBackendAdmin`'s deadline for the intent and sign-out (45 s), and
/// the refresh broker's (10 s).
const ADMIN_TIMEOUT: Duration = Duration::from_secs(45);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(10);

/// The account toasts' ids (`notifyOnce`'s keys).
const SIGN_IN_TOAST_ID: &str = "account-sign-in";
const CALLBACK_TOAST_ID: &str = "account-callback-retry";

/// The backend as the account uses it.
pub struct Backend {
    client: Arc<BackendClient>,
    backend: watch::Receiver<BackendState>,
}

impl AccountsBackend for Backend {
    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.client.request(method, params).await
    }

    async fn admin_request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let bootstrap = self.backend.borrow().bootstrap().cloned();
        let Some(bootstrap) = bootstrap else {
            return Err(RpcError::new(
                method,
                "not-connected",
                "Videorc's engine isn't running.",
            ));
        };
        let timeout = if method == videorc_app_core::accounts::methods::REFRESH {
            REFRESH_TIMEOUT
        } else {
            ADMIN_TIMEOUT
        };
        let socket = BackendSocket::connect(&bootstrap.admin(), timeout, timeout)
            .await
            .map_err(|_| {
                RpcError::new(method, "not-connected", "Videorc's engine isn't connected.")
            })?;
        let result = socket.request_with_timeout(method, params, timeout).await;
        socket.close().await;
        result
    }
}

pub type AppAccounts = Arc<Accounts<Backend>>;

/// What the pages reach the account through.
#[derive(Clone)]
pub struct Shared {
    pub accounts: AppAccounts,
    pub studio: Arc<Studio<BackendClient>>,
    pub runtime: Handle,
    pub web: WebLinks,
    /// A development build: the sign-in page may be a local videorc-web.
    pub development: bool,
}

impl Global for Shared {}

/// The web pages for this build: production in a release build; a local
/// videorc-web (or `VIDEORC_API_BASE_URL`, the backend's own override) in a
/// development one, as Electron's `VIDEORC_WEB_ORIGIN` does.
pub fn web_links(development: bool) -> WebLinks {
    if development {
        WebLinks::development(std::env::var("VIDEORC_API_BASE_URL").ok().as_deref())
    } else {
        WebLinks::production()
    }
}

/// The account, following the backend: read at every `backend.ready`,
/// updated by its events. Its toasts go through the Studio's notices.
pub fn start(
    runtime: &Handle,
    client: Arc<BackendClient>,
    backend: watch::Receiver<BackendState>,
    studio: Arc<Studio<BackendClient>>,
) -> AppAccounts {
    let mut events = client.subscribe();
    let accounts = Accounts::new(Arc::new(Backend { client, backend }));
    let follower = accounts.clone();
    runtime.spawn(async move {
        follower.hydrate().await;
        loop {
            match events.recv().await {
                Ok(BackendEvent::Ready(_))
                | Ok(BackendEvent::EventsLagged(_))
                | Ok(BackendEvent::ClientLagged { .. })
                | Err(RecvError::Lagged(_)) => follower.hydrate().await,
                Ok(event) => follower.on_event(&event),
                Err(RecvError::Closed) => break,
            }
        }
    });
    let mut account_events = accounts.events();
    runtime.spawn(async move {
        loop {
            let event = match account_events.recv().await {
                Ok(event) => event,
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            };
            let toast = match event {
                AccountsEvent::SignInRetrying => ToastRequest::info(copy::FINISHING_SIGN_IN)
                    .id(CALLBACK_TOAST_ID)
                    .finish(),
                AccountsEvent::SignInFailed { message } => ToastRequest::error(message)
                    .id(CALLBACK_TOAST_ID)
                    .description(copy::SIGN_IN_AGAIN)
                    .action(copy::SIGN_IN, NoticeAction::SignIn)
                    .finish(),
                AccountsEvent::Changed { .. } => continue,
            };
            studio.post_notices(vec![NoticeCommand::Show(toast)]);
        }
    });
    accounts
}

/// Makes the account reachable from every page.
pub fn install(cx: &mut App, shared: Shared) {
    cx.set_global(shared);
}

fn toast_failure(studio: &Studio<BackendClient>, message: &str, action: &'static str) {
    let context = UserErrorContext { action, object: "" };
    let failure = Failure::Sentence {
        text: message,
        warning: false,
    };
    if let Some(command) = toast_user_error(failure, context, SIGN_IN_TOAST_ID) {
        studio.post_notices(vec![command]);
    }
}

/// `beginVideorcSignIn`: the backend's intent, then the sign-in page in the
/// system browser. A refusal says why.
pub fn sign_in(cx: &mut App) {
    let Some(shared) = cx.try_global::<Shared>().cloned() else {
        eprintln!("[videorc-app] Sign in: the account is not installed");
        return;
    };
    let accounts = shared.accounts.clone();
    let authorize = shared.web.desktop_authorize();
    let development = shared.development;
    let job = shared
        .runtime
        .spawn(async move { accounts.begin_sign_in(&authorize, development).await });
    cx.spawn(async move |cx| match job.await {
        Ok(Ok(page)) => {
            let _ = cx.update(|cx| cx.open_url(&page));
        }
        Ok(Err(error)) => toast_failure(&shared.studio, &error.message(), "sign in"),
        Err(_) => {}
    })
    .detach();
}

/// The menu's Sign out; `live` is a recording or livestream running.
pub fn sign_out(cx: &mut App, live: bool) {
    let Some(shared) = cx.try_global::<Shared>().cloned() else {
        return;
    };
    let accounts = shared.accounts.clone();
    let studio = shared.studio.clone();
    shared.runtime.spawn(async move {
        if let Err(error) = accounts.sign_out(live).await {
            toast_failure(&studio, &error.message(), "sign out");
        }
    });
}

/// Opens a web page from the account menu (Account, View Premium).
pub fn open_web(cx: &mut App, page: impl FnOnce(&WebLinks) -> String) {
    let Some(shared) = cx.try_global::<Shared>() else {
        return;
    };
    let url = page(&shared.web);
    cx.open_url(&url);
}

/// `connectPlatformAccount(platform, options, flow)`: the backend starts the
/// provider's sign-in (`platformAccounts.oauth.startProvider`, its loopback
/// callback), its page opens in the system browser, and unless the caller
/// shows its own wait (`shows_browser_step`, the Destinations card and the
/// first run) a toast keeps the link to copy into the browser that is signed
/// in. `done` gets the page, or `None` when it never got that far (the
/// Studio toasted why). YouTube asks for its consent first
/// ([`videorc_app_core::accounts::needs_consent`]): that is the caller's.
pub fn connect_provider(
    cx: &mut App,
    platform: &str,
    optional_scopes: Vec<&'static str>,
    shows_browser_step: bool,
    done: impl FnOnce(Option<String>, &mut App) + 'static,
) {
    let Some(shared) = cx.try_global::<Shared>().cloned() else {
        done(None, cx);
        return;
    };
    let studio = shared.studio.clone();
    let platform = platform.to_string();
    let job = shared.runtime.spawn(async move {
        studio
            .start_platform_sign_in(&platform, optional_scopes)
            .await
    });
    cx.spawn(async move |cx| {
        let page = job.await.ok().flatten();
        let _ = cx.update(|cx| {
            if let Some(page) = &page {
                cx.open_url(page);
                if !shows_browser_step {
                    shared
                        .studio
                        .show_browser_approval(copy::APPROVE_CONNECTION, page);
                }
            }
            done(page, cx);
        });
    })
    .detach();
}

/// `disconnectPlatformAccount`: the account goes, and every destination's
/// hold on it ("Disconnected {platform}"). The caller asked first (P720).
pub fn disconnect_provider(cx: &mut App, platform: &str) {
    let Some(shared) = cx.try_global::<Shared>() else {
        return;
    };
    let studio = shared.studio.clone();
    let platform = platform.to_string();
    shared.runtime.spawn(async move {
        studio.disconnect_platform(&platform).await;
    });
}
