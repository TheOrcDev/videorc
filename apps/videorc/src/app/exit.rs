//! Quitting or closing the main window while on air asks first (plan 260
//! S2.6a part 7): the core's [`LiveExitGuard`] (Electron's
//! `main/exit-guard.ts`, plan 174 S3.1 D2) on the backend's events, holding
//! the exits this app can hold.
//!
//! - **Held:** the app's Quit (⌘Q and the menu), the main window's close
//!   button, Close Window (⌘W) on the main window, and on macOS the Dock's
//!   Quit, a logout and a restart (`NSApplication terminate:`, answered by
//!   `platform::macos::terminate`).
//! - **Asked by:** whatever shows the End livestream question, registered
//!   with [`ExitGuard::set_answerer`] (`main.rs`: the Studio's stop
//!   request, which the shell's End livestream dialog shows). It ends the
//!   livestream (or hands a managed show off) and answers with
//!   [`ExitGuard::exit_after_livestream_ended`], which lets that one exit
//!   through. With nothing registered, or the main window gone, an exit
//!   proceeds as it always did, as Electron's does without a renderer.
//! - **Never held:** a quit that isn't the person's ([`ExitGuard::quit_unasked`]:
//!   a smoke run's `--quit-after`, Reopen Videorc, a main window that never
//!   opened), as Electron allows those up front.
//!
//! A recording quits as it always did: the backend's shutdown drains its
//! finalization.

use std::rc::Rc;
use std::sync::{Arc, Mutex};

use gpui::{AnyWindowHandle, App, Global, Window};
use tokio::sync::broadcast;
use videorc_app_core::BackendEvent;
use videorc_app_core::desktop::exit_guard::{AppExitKind, LiveExitGuard};
use videorc_app_core::studio::session::StopExit;

/// The `cloud.state` event a hosted talk show's room arrives on.
pub const CLOUD_STATE: &str = "cloud.state";

/// Shows the End livestream question for an exit.
pub type Answerer = Rc<dyn Fn(AppExitKind, &mut App)>;

/// The exit a confirmed stop continues with (`StopExit`), as the guard's kind.
pub fn exit_kind(exit: StopExit) -> AppExitKind {
    match exit {
        StopExit::Quit => AppExitKind::Quit,
        StopExit::Close => AppExitKind::Close,
    }
}

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
        // The Dock's Quit, a logout and a restart ask the same question.
        #[cfg(target_os = "macos")]
        {
            let app = cx.to_async();
            let held = crate::platform::macos::terminate::hold_terminate(Box::new(move || {
                app.update(|cx| Self::may_exit(AppExitKind::Quit, cx))
            }));
            if let Err(error) = held {
                eprintln!("[videorc-app] the Dock's Quit can't ask first: {error}");
            }
        }
    }

    /// The main window: its close button asks while on air, and on macOS
    /// it hides instead of closing ([`Self::close_main`]).
    pub fn watch_main_window(window: &Window, cx: &mut App) {
        if !cx.has_global::<Self>() {
            return;
        }
        let main = window.window_handle();
        cx.global_mut::<Self>().main_window = Some(main);
        window.on_window_should_close(cx, move |_, cx| {
            if !Self::may_exit(AppExitKind::Close, cx) {
                return false;
            }
            if cfg!(target_os = "macos") {
                // Not inside the window's own close: the other windows and
                // this one go once the callback returns.
                cx.defer(move |cx| Self::close_main(main, cx));
                return false;
            }
            true
        });
    }

    /// The main window goes (P1513, P1514). On macOS the app stays in the
    /// Dock, as Electron's does (`window-all-closed` quits only elsewhere):
    /// the other windows close with it, as Electron's Studio `closed`
    /// handler closes the detached ones, and the main window hides until
    /// the Dock brings it back ([`Self::show_main_window`]). Elsewhere it
    /// closes, and the last window closing quits (`main.rs`).
    fn close_main(main: AnyWindowHandle, cx: &mut App) {
        #[cfg(target_os = "macos")]
        {
            for other in cx.windows() {
                if other != main {
                    let _ = other.update(cx, |_, window, _| window.remove_window());
                }
            }
            let _ = main.update(cx, |_, window, _| {
                crate::platform::macos::hide_window(window)
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = main.update(cx, |_, window, _| window.remove_window());
    }

    /// Electron's `watchdogLive`: the session streams, or this computer's
    /// cloud room is on air (a talk show has no local session).
    pub fn livestream_on_air(cx: &App) -> bool {
        cx.try_global::<Self>()
            .is_some_and(|this| this.lock().livestream_on_air())
    }

    /// The main window, once it is open.
    pub fn main_window(cx: &App) -> Option<AnyWindowHandle> {
        cx.try_global::<Self>().and_then(|this| this.main_window)
    }

    /// The Dock's click with no window showing (Electron's `activate`,
    /// P1513): the main window comes back where it was.
    pub fn show_main_window(cx: &mut App) {
        let main = cx
            .has_global::<Self>()
            .then(|| cx.global::<Self>().main_window)
            .flatten();
        if let Some(main) = main {
            let _ = main.update(cx, |_, window, _| window.activate_window());
            cx.activate(true);
        }
    }

    /// The End livestream question's owner (the Studio's stop request).
    pub fn set_answerer(answerer: Answerer, cx: &mut App) {
        if cx.has_global::<Self>() {
            cx.global_mut::<Self>().answerer = Some(answerer);
        }
    }

    /// `exitAfterLivestreamEnded`: the question was answered (the
    /// livestream ended, or the show was handed off); this exit goes.
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
                    Self::close_main(main, cx);
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

    /// A quit that isn't the person's: allowed up front, never asks.
    pub fn quit_unasked(cx: &mut App) {
        if cx.has_global::<Self>() {
            cx.global::<Self>().lock().allow(AppExitKind::Quit);
        }
        cx.quit();
    }

    /// Close Window (⌘W): the main window asks first and goes as its close
    /// button does ([`Self::close_main`]); any other window closes.
    pub fn close_active_window(cx: &mut App) {
        let Some(active) = cx.active_window() else {
            return;
        };
        let is_main = cx.has_global::<Self>() && cx.global::<Self>().main_window == Some(active);
        if is_main {
            if Self::may_exit(AppExitKind::Close, cx) {
                Self::close_main(active, cx);
            }
            return;
        }
        let _ = active.update(cx, |_, window, _| window.remove_window());
    }
}
