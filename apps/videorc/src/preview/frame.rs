//! The floating Preview window's remembered state (P1549, P132): Electron's
//! `preview-window.json` on the core's rules (`desktop::window_frames`).
//!
//! - **frame**: the floating window's last windowed frame, clamped back on
//!   screen when it opens. A docked placement is never saved.
//! - **mode** and **open**: a Preview left floating floats again at launch
//!   (`restorePreviewWindowOnLaunch`, `initialPreviewWindowMode`: a saved
//!   mode wins; without one an install that ran before floats and a new one
//!   docks). Show here docks it. Close Preview, or closing the window,
//!   closes it (P131, `open: false`): the Studio says so, and the next
//!   launch opens it closed.
//! - **alwaysOnTop**: Keep on top of other apps, off unless turned on.
//!
//! Smoke and probe runs neither restore nor save (`persistence_enabled`).
//! Electron's own keys in the file are kept.

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use gpui::{App, Bounds, Pixels, Window, WindowBounds, px, size};
use serde_json::{Map, Value};
use videorc_app_core::desktop::window_frames::{
    PREVIEW_WINDOW_PREFS_FILE, PreviewWindowPrefs, Rect, WindowPrefsFile, clamp_frame_to_work_area,
    close_prefs, persistence_enabled,
};
use videorc_app_core::{Level, Logger};

use crate::app::frames::{bounds_of, displays, rect_of};

/// Electron's Preview window: 960×568 at first, at least 320×208.
pub const DEFAULT_WIDTH: f32 = 960.;
pub const DEFAULT_HEIGHT: f32 = 568.;
pub const MIN_WIDTH: f32 = 320.;
pub const MIN_HEIGHT: f32 = 208.;

/// `initialPreviewWindowMode` and `restorePreviewWindowOnLaunch`: whether a
/// launch opens the Preview in its own window.
pub fn floats_at_launch(prefs: &PreviewWindowPrefs) -> bool {
    starts_floating(prefs) && prefs.restore_on_launch()
}

/// A floating Preview left closed (`open: false`): the launch shows it
/// closed, as Electron's Studio does when `restorePreviewWindowOnLaunch`
/// opens nothing.
pub fn closed_at_launch(prefs: &PreviewWindowPrefs) -> bool {
    starts_floating(prefs) && !prefs.restore_on_launch()
}

fn starts_floating(prefs: &PreviewWindowPrefs) -> bool {
    match prefs.mode.as_deref() {
        Some("floating") => true,
        Some("docked") => false,
        _ => prefs.existing_install,
    }
}

/// The Preview window's file, and the last windowed frame it had.
#[derive(Clone)]
pub struct PreviewFrame {
    inner: Rc<RefCell<Inner>>,
}

struct Inner {
    prefs: WindowPrefsFile,
    logger: Logger,
    last: Option<Rect>,
}

impl PreviewFrame {
    pub fn new(user_data_dir: &Path, logger: Logger) -> Self {
        let enabled = persistence_enabled(|name| std::env::var(name).ok());
        Self {
            inner: Rc::new(RefCell::new(Inner {
                prefs: WindowPrefsFile::new(user_data_dir, PREVIEW_WINDOW_PREFS_FILE, enabled),
                logger,
                last: None,
            })),
        }
    }

    fn load(&self) -> PreviewWindowPrefs {
        PreviewWindowPrefs::from_json(&self.inner.borrow().prefs.load())
    }

    /// Whether this launch floats the Preview (never in a smoke run).
    pub fn floats_at_launch(&self) -> bool {
        self.inner.borrow().prefs.enabled() && floats_at_launch(&self.load())
    }

    /// Whether this launch shows the Preview closed (never in a smoke run).
    pub fn closed_at_launch(&self) -> bool {
        self.inner.borrow().prefs.enabled() && closed_at_launch(&self.load())
    }

    /// Keep on top of other apps.
    pub fn always_on_top(&self) -> bool {
        self.load().always_on_top
    }

    pub fn set_always_on_top(&self, on: bool) {
        let mut patch = Map::new();
        patch.insert("alwaysOnTop".into(), Value::Bool(on));
        self.write(patch);
    }

    /// The frame the window opens at: the one it last had (this run, or
    /// saved), on screen; else 960×568 in the middle. Opening says the
    /// Preview floats.
    pub fn opening(&self, cx: &App) -> Bounds<Pixels> {
        let saved = self.load().frame;
        let mut patch = Map::new();
        patch.insert("open".into(), Value::Bool(true));
        patch.insert("mode".into(), Value::from("floating"));
        self.write(patch);
        let inner = self.inner.borrow();
        let Some(remembered) = inner.last.or(saved) else {
            return Bounds::centered(None, size(px(DEFAULT_WIDTH), px(DEFAULT_HEIGHT)), cx);
        };
        let frame = clamp_frame_to_work_area(remembered, &displays(cx));
        inner.logger.log(
            Level::Info,
            &format!("[windows] preview frame restored: {frame:?} (saved {remembered:?})"),
        );
        bounds_of(frame)
    }

    /// The window moved or resized; only a windowed frame counts.
    pub fn moved(&self, window: &Window) {
        let WindowBounds::Windowed(bounds) = window.window_bounds() else {
            return;
        };
        let frame = rect_of(bounds);
        if frame.width > 0.0 && frame.height > 0.0 {
            self.inner.borrow_mut().last = Some(frame);
        }
    }

    /// Show here: the Preview is docked and open, and the floating frame it
    /// had is kept for next time.
    pub fn docked(&self) {
        let mut patch = self.frame_patch();
        patch.insert("mode".into(), Value::from("docked"));
        patch.insert("open".into(), Value::Bool(true));
        self.write(patch);
    }

    /// Close Preview, or the window closed by hand (P131): the frame it had
    /// and `open: false` (`previewWindowClosePrefs`); the mode stays.
    pub fn closed(&self) {
        let last = self.inner.borrow().last;
        self.write(close_prefs(last, false));
    }

    /// The app quits with the Preview floating: its frame is saved, and
    /// `open` and `mode` stay, so the next launch floats it again.
    pub fn quitting(&self) {
        self.write(self.frame_patch());
    }

    fn frame_patch(&self) -> Map<String, Value> {
        let mut patch = Map::new();
        if let Some(frame) = self.inner.borrow().last {
            patch.insert("frame".into(), frame.to_json());
        }
        patch
    }

    fn write(&self, patch: Map<String, Value>) {
        if patch.is_empty() {
            return;
        }
        let inner = self.inner.borrow();
        if let Err(error) = inner.prefs.save(patch) {
            inner.logger.log(
                Level::Warn,
                &format!(
                    "[windows] the preview frame was not saved to {}: {error}",
                    inner.prefs.path().display()
                ),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn prefs(value: Value) -> PreviewWindowPrefs {
        PreviewWindowPrefs::from_json(value.as_object().unwrap())
    }

    #[test]
    fn a_saved_mode_wins_and_a_new_install_docks() {
        assert!(floats_at_launch(&prefs(json!({ "mode": "floating" }))));
        assert!(!floats_at_launch(&prefs(json!({ "mode": "docked" }))));
        assert!(!floats_at_launch(&prefs(json!({}))));
        // An install that ran before, with no mode saved, floats.
        assert!(floats_at_launch(&prefs(json!({ "alwaysOnTop": false }))));
    }

    #[test]
    fn a_preview_closed_by_hand_stays_closed() {
        let closed = prefs(json!({ "mode": "floating", "open": false }));
        assert!(!floats_at_launch(&closed));
        assert!(closed_at_launch(&closed));
        // Docked, the slot shows it whatever `open` says.
        assert!(!closed_at_launch(&prefs(
            json!({ "mode": "docked", "open": false })
        )));
        assert!(!closed_at_launch(&prefs(json!({ "mode": "floating" }))));
    }
}
