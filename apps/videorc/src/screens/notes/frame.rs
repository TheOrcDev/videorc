//! The Notes window's saved frame (`openNotesWindow`): Electron's
//! `notes-window.json` frame and `open` bit. Text and font scale live in
//! the same file (`videorc_app_core::notes`).

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use gpui::{App, Bounds, Pixels, Window, WindowBounds};
use serde_json::{Map, Value};
use videorc_app_core::desktop::window_frames::{
    NOTES_WINDOW_PREFS_FILE, Rect, WindowPrefsFile, clamp_frame_to_work_area, close_prefs,
    persistence_enabled,
};
use videorc_app_core::{Level, Logger};

use crate::app::frames::{bounds_of, displays, rect_of};

pub const DEFAULT_WIDTH: f64 = 640.;
pub const DEFAULT_HEIGHT: f64 = 420.;
pub const MIN_WIDTH: f32 = 360.;
pub const MIN_HEIGHT: f32 = 240.;

pub fn reopens(prefs: &Map<String, Value>) -> bool {
    prefs.get("open") == Some(&Value::Bool(true))
}

/// The window's frame file, and the last windowed frame it had.
#[derive(Clone)]
pub struct NotesFrame {
    inner: Rc<RefCell<Inner>>,
}

struct Inner {
    prefs: WindowPrefsFile,
    logger: Logger,
    last: Option<Rect>,
}

impl NotesFrame {
    pub fn new(user_data_dir: &Path, logger: Logger) -> Self {
        let enabled = persistence_enabled(|name| std::env::var(name).ok());
        Self {
            inner: Rc::new(RefCell::new(Inner {
                prefs: WindowPrefsFile::new(user_data_dir, NOTES_WINDOW_PREFS_FILE, enabled),
                logger,
                last: None,
            })),
        }
    }

    pub fn prefs(&self) -> WindowPrefsFile {
        self.inner.borrow().prefs.clone()
    }

    pub fn reopens(&self) -> bool {
        reopens(&self.inner.borrow().prefs.load())
    }

    pub fn always_on_top(&self) -> bool {
        let prefs = self.inner.borrow().prefs.load();
        prefs
            .get("alwaysOnTopPreferenceVersion")
            .and_then(Value::as_u64)
            == Some(2)
            && prefs.get("alwaysOnTop") == Some(&Value::Bool(true))
    }

    pub fn set_always_on_top(&self, on: bool) {
        let mut patch = Map::new();
        patch.insert("alwaysOnTop".into(), Value::Bool(on));
        patch.insert("alwaysOnTopPreferenceVersion".into(), Value::from(2u64));
        self.write(patch);
    }

    pub fn opening(&self, cx: &App) -> Option<Bounds<Pixels>> {
        let saved = self
            .inner
            .borrow()
            .prefs
            .load()
            .get("frame")
            .and_then(Rect::from_json);
        let mut patch = Map::new();
        patch.insert("open".into(), Value::Bool(true));
        self.write(patch);
        let inner = self.inner.borrow();
        let remembered = inner.last.or(saved)?;
        let frame = clamp_frame_to_work_area(remembered, &displays(cx));
        inner.logger.log(
            Level::Info,
            &format!("[windows] notes frame restored: {frame:?} (saved {remembered:?})"),
        );
        Some(bounds_of(frame))
    }

    pub fn moved(&self, window: &Window) {
        let WindowBounds::Windowed(bounds) = window.window_bounds() else {
            return;
        };
        let frame = rect_of(bounds);
        if frame.width > 0.0 && frame.height > 0.0 {
            self.inner.borrow_mut().last = Some(frame);
        }
    }

    pub fn closed(&self, app_quitting: bool) {
        let last = self.inner.borrow().last;
        self.write(close_prefs(last, app_quitting));
    }

    fn write(&self, patch: Map<String, Value>) {
        let inner = self.inner.borrow();
        if let Err(error) = inner.prefs.save(patch) {
            inner.logger.log(
                Level::Warn,
                &format!(
                    "[windows] the notes frame was not saved to {}: {error}",
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

    fn prefs(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn only_a_window_left_open_reopens_at_launch() {
        assert!(reopens(&prefs(json!({ "open": true }))));
        assert!(!reopens(&prefs(json!({ "open": false }))));
        assert!(!reopens(&Map::new()));
    }
}
