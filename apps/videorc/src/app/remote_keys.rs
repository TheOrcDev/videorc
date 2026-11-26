//! The remote keys only the app can run (plan 260, L7): Stream Deck and the
//! phone's window keys (Electron's `openWindow` and
//! `frontOrCloseCommentsWindow`, `lib/studio-actions/windows.ts`), and what
//! the remotes see of the app's windows (`RemoteAppFacts`).
//!
//! The Studio hands each key over a channel with a one-shot answer
//! (`videorc_app_core::studio::remote_app`); this runs it on the main
//! thread and answers. The Studio waits a few seconds at most, so a busy
//! main thread never holds a key for good.
//!
//! The facts are reported whenever a window opens or closes, the Preview
//! changes, or the Stream Manager's Hide from stream flips; the same facts
//! twice are not sent.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{App, Entity, Global};
use tokio::sync::mpsc;
use videorc_app_core::client::BackendClient;
use videorc_app_core::studio::Studio;
use videorc_app_core::studio::remote::{
    RemoteAppFacts, RemoteWindows, ScreenMoves, accepted, copy, refused,
};
use videorc_app_core::studio::remote_app::{AppRemoteAction, AppRemoteIntent, RemoteWindow};
use videorc_preview::lifecycle::WindowMode;

use crate::preview::Preview;
use crate::screens::{notes, stream_manager};

type AppStudio = Studio<BackendClient>;

/// The Studio to report to, the Preview the keys open, and the facts last
/// reported.
struct RemoteKeys {
    studio: Arc<AppStudio>,
    preview: Rc<RefCell<Option<Entity<Preview>>>>,
    reported: RefCell<Option<RemoteAppFacts>>,
}

impl Global for RemoteKeys {}

/// Starts listening for the app's keys and reports the windows. Call once
/// the main window, Notes and the Stream Manager are installed.
pub fn install(
    cx: &mut App,
    studio: Arc<AppStudio>,
    preview: Rc<RefCell<Option<Entity<Preview>>>>,
) {
    let (listener, mut keys) = mpsc::unbounded_channel::<AppRemoteIntent>();
    let observed = preview.borrow().clone();
    cx.set_global(RemoteKeys {
        studio: studio.clone(),
        preview,
        reported: RefCell::new(None),
    });
    // Opened, closed or moved to its own window.
    if let Some(preview) = observed {
        cx.observe(&preview, |_, cx| report(cx)).detach();
    }
    // A window's own close handlers run first; the facts read after them.
    cx.on_window_closed(|cx, _| cx.defer(|cx| report(cx)))
        .detach();
    cx.spawn(async move |cx| {
        while let Some(key) = keys.recv().await {
            cx.update(|cx| run(key, cx));
        }
    })
    .detach();
    cx.observe_displays(|_, cx| report(cx)).detach();
    studio.set_remote_app_listener(Some(listener));
    report(cx);
}

/// One key, answered.
fn run(key: AppRemoteIntent, cx: &mut App) {
    let outcome = match &key.action {
        AppRemoteAction::StreamManagerScreenSwap {
            presenting,
            monitor,
        } => stream_manager::window::screen_swap(presenting, monitor, cx),
        action => {
            let done = match action {
                AppRemoteAction::WindowFront(window) => window_front(*window, cx),
                AppRemoteAction::StreamManagerFrontOrClose => {
                    stream_manager::window::front_or_close(cx)
                }
                AppRemoteAction::StreamManagerScreenSwap { .. } => unreachable!(),
            };
            if done {
                accepted()
            } else {
                refused(copy::WINDOW_MISSING)
            }
        }
    };
    key.answer(outcome);
    report(cx);
}

/// `openWindow`: the window to the front, opened when it is closed.
fn window_front(window: RemoteWindow, cx: &mut App) -> bool {
    match window {
        RemoteWindow::Notes => {
            notes::window::show(cx);
            notes::window::handle(cx).is_some()
        }
        // Electron's comments window is the Stream Manager.
        RemoteWindow::Comments => {
            stream_manager::window::show(cx);
            stream_manager::window::handle(cx).is_some()
        }
        RemoteWindow::Preview => {
            let preview = cx
                .try_global::<RemoteKeys>()
                .and_then(|keys| keys.preview.borrow().clone());
            let Some(preview) = preview else {
                return false;
            };
            preview.update(cx, |preview, cx| preview.open_or_show(cx));
            true
        }
    }
}

/// Remove the Preview before stopping it. `Entity::update` flushes deferred
/// window-close observers before returning, and those observers read this
/// slot through `facts`. An `if let slot.borrow_mut().take()` keeps the
/// mutable borrow alive through that callback and aborts a floating quit.
/// The callback form keeps the reentrant boundary covered by the test below.
pub(crate) fn stop_taken_preview<T>(slot: &RefCell<Option<T>>, stop: impl FnOnce(T)) {
    let taken = slot.borrow_mut().take();
    if let Some(preview) = taken {
        stop(preview);
    }
}

/// The app's windows and connected screens as the remotes see them.
fn facts(keys: &RemoteKeys, cx: &App) -> RemoteAppFacts {
    let preview = keys.preview.borrow().as_ref().is_some_and(|preview| {
        let preview = preview.read(cx);
        !preview.is_closed() && preview.mode() == WindowMode::Floating
    });
    RemoteAppFacts {
        windows: RemoteWindows {
            notes: notes::window::handle(cx).is_some(),
            comments: stream_manager::window::handle(cx).is_some(),
            preview,
        },
        stream_manager: stream_manager::window::remote_place(cx),
        screens: videorc_app_core::studio::remote_screens::screen_options(
            &super::frames::remote_displays(cx),
        ),
        screen_moves: screen_moves(),
    }
}

/// Tells the Studio the app's windows when they changed. Before
/// [`install`], nothing.
pub fn report(cx: &App) {
    let Some(keys) = cx.try_global::<RemoteKeys>() else {
        return;
    };
    let next = facts(keys, cx);
    if keys.reported.borrow().as_ref() == Some(&next) {
        return;
    }
    keys.studio.set_remote_app_facts(next.clone());
    *keys.reported.borrow_mut() = Some(next);
}

/// Wayland refuses placement with Electron's words; X11 supports it.
pub(crate) fn screen_moves() -> ScreenMoves {
    if cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some() {
        ScreenMoves::Wayland
    } else {
        ScreenMoves::Supported
    }
}

#[cfg(test)]
mod tests {
    use super::stop_taken_preview;
    use std::cell::{Cell, RefCell};

    #[test]
    fn floating_quit_observer_can_read_the_preview_slot_during_stop() {
        let slot = RefCell::new(Some("floating preview"));
        let stopped = Cell::new(0);
        stop_taken_preview(&slot, |preview| {
            assert_eq!(preview, "floating preview");
            // Preview.stop removes its window. GPUI flushes the remote
            // window-close observer inside Entity::update, before stop
            // returns. This is facts()'s reentrant read, not a later read.
            assert!(slot.borrow().is_none());
            stopped.set(stopped.get() + 1);
        });
        // A second shutdown cannot stop the removed Preview again.
        stop_taken_preview(&slot, |_| stopped.set(stopped.get() + 1));
        assert_eq!(stopped.get(), 1);
    }
}
