//! Quitting or closing the main window while on air asks first (plan 260
//! S2.6a part 7): the core's [`LiveExitGuard`] (Electron's
//! `main/exit-guard.ts`, plan 174 S3.1 D2) on the backend's events, holding
//! the exits this app can hold.
//!
//! - **Held:** the app's Quit (⌘Q and the menu), the main window's close
//!   button, and Close Window (⌘W) on the main window.
//! - **Asked by:** whatever shows the End livestream question, registered
//!   with [`ExitGuard::set_answerer`] (the Studio, #1893). It ends the
//!   livestream (or hands a managed show off) and answers with
//!   [`ExitGuard::exit_after_livestream_ended`], which lets that one exit
//!   through. With nothing registered, or the main window gone, an exit
//!   proceeds as it always did, as Electron's does without a renderer.
//! - **Not held (a gap, `docs/gpui/parity.md`):** the Dock's Quit, a
//!   logout and a restart reach `NSApplication terminate:`, which GPUI
//!   answers without asking the app (it implements only
//!   `applicationWillTerminate:`). The fix is a GPUI patch for
//!   `applicationShouldTerminate:` returning "later" while the question is
//!   up.
//!
//! A recording quits as it always did: the backend's shutdown drains its
//! finalization.

use std::rc::Rc;
use std::sync::{Arc, Mutex};

use gpui::{AnyWindowHandle, App, Global, Window};
use tokio::sync::broadcast;
use videorc_app_core::BackendEvent;
use videorc_app_core::desktop::exit_guard::{AppExitKind, LiveExitGuard};

/// The `cloud.state` event a hosted talk show's room arrives on.
pub const CLOUD_STATE: &str = "cloud.state";

/// Shows the End livestream question for an exit.
pub type Answerer = Rc<dyn Fn(AppExitKind, &mut App)>;

/// The guard, the main window and whoever asks.
pub struct ExitGuard {
    guard: Arc<Mutex<LiveExitGuard>>,
    answerer: Option<Answerer>,
    main_window: Option<AnyWindowHandle>,
}

impl Global for ExitGuard {}

impl ExitGuard {
    /// Follows `recording.status`, `cloud.state` and the connection on the
    /// core's runtime.
    pub fn install(
        cx: &mut App,
        runtime: &tokio::runtime::Handle,
        mut events: broadcast::Receiver<BackendEvent>,
    ) {
        let guard = Arc::new(Mutex::new(LiveExitGuard::default()));
        let follower = guard.clone();
        runtime.spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let mut guard = follower.lock().unwrap_or_else(|p| p.into_inner());
                match event {
                    BackendEvent::RecordingStatus(status) => {
                        guard.observe_recording_status(&status)
                    }
                    BackendEvent::Untyped { event, payload } if event == CLOUD_STATE => {
                        guard.observe_cloud_status(&payload)
                    }
                    BackendEvent::ConnectionClosed { .. } => guard.transport_lost(),
                    _ => {}
                }
            }
        });
        cx.set_global(Self {
            guard,
            answerer: None,
            main_window: None,
        });
    }

    /// The main window: its close button asks while on air.
    pub fn watch_main_window(window: &Window, cx: &mut App) {
        if !cx.has_global::<Self>() {
            return;
        }
        cx.global_mut::<Self>().main_window = Some(window.window_handle());
        window.on_window_should_close(cx, |_, cx| Self::may_exit(AppExitKind::Close, cx));
    }

    /// The End livestream question's owner (the Studio page).
    #[allow(dead_code)]
    pub fn set_answerer(answerer: Answerer, cx: &mut App) {
        if cx.has_global::<Self>() {
            cx.global_mut::<Self>().answerer = Some(answerer);
        }
    }

    /// `exitAfterLivestreamEnded`: the question was answered (the
    /// livestream ended, or the show was handed off); this exit goes.
    #[allow(dead_code)]
    pub fn exit_after_livestream_ended(kind: AppExitKind, cx: &mut App) {
        let main = cx.has_global::<Self>().then(|| {
            let this = cx.global_mut::<Self>();
            this.lock().allow(kind);
            this.main_window
        });
        match kind {
            AppExitKind::Quit => cx.quit(),
            AppExitKind::Close => {
                if let Some(main) = main.flatten() {
                    let _ = main.update(cx, |_, window, _| window.remove_window());
                }
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LiveExitGuard> {
        self.guard.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Whether `kind` may go now. While on air, with someone to ask and
    /// the main window there, it waits: the main window comes to the front
    /// and the question goes up.
    pub fn may_exit(kind: AppExitKind, cx: &mut App) -> bool {
        if !cx.has_global::<Self>() {
            return true;
        }
        let (answerer, main) = {
            let this = cx.global::<Self>();
            (this.answerer.clone(), this.main_window)
        };
        let main_open = main.is_some_and(|main| main.update(cx, |_, _, _| ()).is_ok());
        let can_answer = answerer.is_some() && main_open;
        if !cx.global::<Self>().lock().should_ask(kind, can_answer) {
            return true;
        }
        if let Some(main) = main {
            let _ = main.update(cx, |_, window, _| window.activate_window());
        }
        cx.activate(true);
        if let Some(answerer) = answerer {
            answerer(kind, cx);
        }
        false
    }

    /// The app's Quit (⌘Q, the menu).
    pub fn request_quit(cx: &mut App) {
        if Self::may_exit(AppExitKind::Quit, cx) {
            cx.quit();
        }
    }

    /// Close Window (⌘W): the main window asks first; any other window
    /// closes.
    pub fn close_active_window(cx: &mut App) {
        let Some(active) = cx.active_window() else {
            return;
        };
        let is_main = cx.has_global::<Self>() && cx.global::<Self>().main_window == Some(active);
        if is_main && !Self::may_exit(AppExitKind::Close, cx) {
            return;
        }
        let _ = active.update(cx, |_, window, _| window.remove_window());
    }
}
