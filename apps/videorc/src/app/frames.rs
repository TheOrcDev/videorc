//! The main window's saved frame (plan 260 S2.6a), as videorc-rust's
//! `windows.rs` keeps it, on the core's rules (`desktop::window_frames`).
//!
//! - Restored when the window opens, clamped into the display it overlaps
//!   most (no larger than that display's work area), so an unplugged display
//!   never strands the window off screen.
//! - Saved to `main-window.json` in the data directory a moment after each
//!   move or resize, and at quit. A maximized or full-screen window keeps the
//!   last windowed frame saved.
//! - Smoke and probe runs neither restore nor save (`persistence_enabled`).
//!
//! A preference is a convenience: a file that can't be read is a first
//! launch, one that can't be written is logged and never breaks the app.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use gpui::{App, Bounds, Context, Pixels, Task, Window, WindowBounds, point, px, size};
use serde_json::Map;
use videorc_app_core::desktop::window_frames::{
    Display, MAIN_WINDOW_PREFS_FILE, Rect, WindowPrefsFile, clamp_frame_to_work_area,
    persistence_enabled,
};
use videorc_app_core::{Level, Logger};

/// How long after the last move or resize the frame is saved.
const SAVE_DELAY: Duration = Duration::from_millis(600);

/// The main window's frame file, and the save a move is waiting on.
#[derive(Clone)]
pub struct MainFrame {
    inner: Rc<RefCell<Inner>>,
}

struct Inner {
    prefs: WindowPrefsFile,
    logger: Logger,
    /// The save after the latest move or resize; a newer one replaces it.
    pending: Option<Task<()>>,
}

impl MainFrame {
    pub fn new(user_data_dir: &Path, logger: Logger) -> Self {
        let enabled = persistence_enabled(|name| std::env::var(name).ok());
        Self {
            inner: Rc::new(RefCell::new(Inner {
                prefs: WindowPrefsFile::new(user_data_dir, MAIN_WINDOW_PREFS_FILE, enabled),
                logger,
                pending: None,
            })),
        }
    }

    /// The saved frame, clamped into today's displays; `None` on a first
    /// launch (or a smoke run), which opens the window at its default.
    pub fn restored(&self, cx: &App) -> Option<Bounds<Pixels>> {
        let inner = self.inner.borrow();
        let saved = inner.prefs.load().get("frame").and_then(Rect::from_json)?;
        let frame = clamp_frame_to_work_area(saved, &displays(cx));
        inner.logger.log(
            Level::Info,
            &format!("[windows] main window frame restored: {frame:?} (saved {saved:?})"),
        );
        Some(bounds_of(frame))
    }

    /// Saves the frame [`SAVE_DELAY`] after the latest move or resize. Call
    /// from the window's `observe_window_bounds`.
    pub fn moved<T: 'static>(&self, window: &Window, cx: &Context<T>) {
        let frame = self.clone();
        let task = cx.spawn_in(window, async move |_, cx| {
            cx.background_executor().timer(SAVE_DELAY).await;
            let _ = cx.update(|window, _| frame.save(window));
        });
        self.inner.borrow_mut().pending = Some(task);
    }

    /// Saves the frame now (at quit, and after a move or resize). Only a
    /// windowed frame is saved.
    pub fn save(&self, window: &Window) {
        let WindowBounds::Windowed(bounds) = window.window_bounds() else {
            return;
        };
        let frame = rect_of(bounds);
        if frame.width <= 0.0 || frame.height <= 0.0 {
            return;
        }
        let inner = self.inner.borrow();
        let mut patch = Map::new();
        patch.insert("frame".into(), frame.to_json());
        if let Err(error) = inner.prefs.save(patch) {
            inner.logger.log(
                Level::Warn,
                &format!(
                    "[windows] the main window's frame was not saved to {}: {error}",
                    inner.prefs.path().display()
                ),
            );
        }
    }
}

/// Every display's bounds and work area (without the menu bar and the
/// Dock), in the same coordinates as a window's frame.
pub(crate) fn displays(cx: &App) -> Vec<Display> {
    cx.displays()
        .iter()
        .map(|display| Display {
            bounds: rect_of(display.bounds()),
            work_area: rect_of(display.visible_bounds()),
        })
        .collect()
}

pub(crate) fn rect_of(bounds: Bounds<Pixels>) -> Rect {
    Rect::new(
        f64::from(f32::from(bounds.origin.x)),
        f64::from(f32::from(bounds.origin.y)),
        f64::from(f32::from(bounds.size.width)),
        f64::from(f32::from(bounds.size.height)),
    )
}

pub(crate) fn bounds_of(frame: Rect) -> Bounds<Pixels> {
    Bounds {
        origin: point(px(frame.x as f32), px(frame.y as f32)),
        size: size(px(frame.width as f32), px(frame.height as f32)),
    }
}
