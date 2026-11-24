//! The Stream Manager window's saved frame (`openCommentsWindow`,
//! `main/stream-manager-frame.ts`), in Electron's `comments-window.json`:
//!
//! - The window used to be a 420 × 640 chat reader. A frame the user never
//!   resized (that old default) moves to 1120 × 720 once; any frame the user
//!   sized is kept. `layoutVersion` 2 says the move happened.
//! - Opening saves `open: true`; closing saves the last frame and
//!   `open: false`, unless the quit closed it (`previewWindowClosePrefs`).
//! - The frame is clamped into today's displays, as the main window's is.
//!
//! Smoke and probe runs neither restore nor save (`persistence_enabled`).

use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;

use gpui::{App, Bounds, Pixels, Window, WindowBounds};
use serde_json::{Map, Value};
use videorc_app_core::desktop::window_frames::{
    COMMENTS_WINDOW_PREFS_FILE, Rect, WindowPrefsFile, clamp_frame_to_work_area, close_prefs,
    persistence_enabled,
};
use videorc_app_core::{Level, Logger};

use crate::app::frames::{bounds_of, displays, rect_of};

pub const DEFAULT_WIDTH: f64 = 1120.;
pub const DEFAULT_HEIGHT: f64 = 720.;
const LEGACY_WIDTH: f64 = 420.;
const LEGACY_HEIGHT: f64 = 640.;
pub const LAYOUT_VERSION: u64 = 2;

/// `migrateStreamManagerFrame`, and the patch the open writes when the saved
/// layout is older (`frame` when it has one, and `layoutVersion`).
pub fn migrate(prefs: &Map<String, Value>) -> (Option<Rect>, Option<Map<String, Value>>) {
    let frame = prefs.get("frame").and_then(Rect::from_json);
    let current = prefs.get("layoutVersion").and_then(Value::as_u64) == Some(LAYOUT_VERSION);
    if current {
        return (frame, None);
    }
    let frame = frame.map(|frame| {
        if frame.width == LEGACY_WIDTH && frame.height == LEGACY_HEIGHT {
            Rect::new(frame.x, frame.y, DEFAULT_WIDTH, DEFAULT_HEIGHT)
        } else {
            frame
        }
    });
    let mut patch = Map::new();
    if let Some(frame) = frame {
        patch.insert("frame".into(), frame.to_json());
    }
    patch.insert("layoutVersion".into(), Value::from(LAYOUT_VERSION));
    (frame, Some(patch))
}

pub fn reopens(prefs: &Map<String, Value>) -> bool {
    prefs.get("open") == Some(&Value::Bool(true))
}

/// The window's frame file, and the last windowed frame it had.
#[derive(Clone)]
pub struct StreamManagerFrame {
    inner: Rc<RefCell<Inner>>,
}

struct Inner {
    prefs: WindowPrefsFile,
    logger: Logger,
    /// `commentsWindowLastFrame`: kept across a close, so a reopen in the
    /// same run comes back where it was.
    last: Option<Rect>,
}

impl StreamManagerFrame {
    pub fn new(user_data_dir: &Path, logger: Logger) -> Self {
        let enabled = persistence_enabled(|name| std::env::var(name).ok());
        Self {
            inner: Rc::new(RefCell::new(Inner {
                prefs: WindowPrefsFile::new(user_data_dir, COMMENTS_WINDOW_PREFS_FILE, enabled),
                logger,
                last: None,
            })),
        }
    }

    /// The window was open when the app last quit (`restoreCommentsWindowOnLaunch`:
    /// `open === true`, never a missing key).
    pub fn reopens(&self) -> bool {
        reopens(&self.inner.borrow().prefs.load())
    }

    /// Keep on top (`commentsWindowAlwaysOnTopPreference`: version 1).
    pub fn always_on_top(&self) -> bool {
        let prefs = self.inner.borrow().prefs.load();
        prefs
            .get("alwaysOnTopPreferenceVersion")
            .and_then(Value::as_u64)
            == Some(1)
            && prefs.get("alwaysOnTop") == Some(&Value::Bool(true))
    }

    pub fn set_always_on_top(&self, on: bool) {
        let mut patch = Map::new();
        patch.insert("alwaysOnTop".into(), Value::Bool(on));
        patch.insert("alwaysOnTopPreferenceVersion".into(), Value::from(1u64));
        self.write(patch);
    }

    /// Hide from stream (`commentsWindowHiddenFromStreamPreference`: version 1).
    pub fn hidden_from_stream(&self) -> bool {
        let prefs = self.inner.borrow().prefs.load();
        prefs
            .get("hiddenFromStreamPreferenceVersion")
            .and_then(Value::as_u64)
            == Some(1)
            && prefs.get("hiddenFromStream") == Some(&Value::Bool(true))
    }

    pub fn set_hidden_from_stream(&self, hidden: bool) {
        let mut patch = Map::new();
        patch.insert("hiddenFromStream".into(), Value::Bool(hidden));
        patch.insert(
            "hiddenFromStreamPreferenceVersion".into(),
            Value::from(1u64),
        );
        self.write(patch);
    }

    /// The frame to open at, clamped into today's displays (`None` opens at
    /// the default, centred). Migrates an old layout and saves `open: true`.
    pub fn opening(&self, cx: &App) -> Option<Bounds<Pixels>> {
        let (saved, patch) = migrate(&self.inner.borrow().prefs.load());
        let mut patch = patch.unwrap_or_default();
        patch.insert("open".into(), Value::Bool(true));
        self.write(patch);
        let inner = self.inner.borrow();
        let remembered = inner.last.or(saved)?;
        let frame = clamp_frame_to_work_area(remembered, &displays(cx));
        inner.logger.log(
            Level::Info,
            &format!("[windows] stream manager frame restored: {frame:?} (saved {remembered:?})"),
        );
        Some(bounds_of(frame))
    }

    /// Remembers the window's windowed frame. Call from its
    /// `observe_window_bounds`; the file is written at close.
    pub fn moved(&self, window: &Window) {
        let WindowBounds::Windowed(bounds) = window.window_bounds() else {
            return;
        };
        let frame = rect_of(bounds);
        if frame.width > 0.0 && frame.height > 0.0 {
            self.inner.borrow_mut().last = Some(frame);
        }
    }

    /// Saves the last frame, and `open: false` unless the quit closed it.
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
                    "[windows] the stream manager's frame was not saved to {}: {error}",
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
    fn the_old_chat_reader_frame_moves_to_the_dashboard_default_once() {
        let (frame, patch) = migrate(&prefs(
            json!({ "frame": { "x": 40, "y": 60, "width": 420, "height": 640 } }),
        ));
        assert_eq!(frame, Some(Rect::new(40., 60., 1120., 720.)));
        let patch = patch.unwrap();
        assert_eq!(patch["layoutVersion"], json!(2));
        assert_eq!(Rect::from_json(&patch["frame"]), frame);
    }

    #[test]
    fn a_frame_the_user_sized_is_kept_and_the_version_still_moves() {
        let (frame, patch) = migrate(&prefs(
            json!({ "frame": { "x": 0, "y": 0, "width": 500, "height": 640 }, "layoutVersion": 1 }),
        ));
        assert_eq!(frame, Some(Rect::new(0., 0., 500., 640.)));
        assert_eq!(patch.unwrap()["layoutVersion"], json!(2));
    }

    #[test]
    fn a_current_layout_is_left_alone_even_at_420_by_640() {
        let (frame, patch) = migrate(&prefs(
            json!({ "frame": { "x": 0, "y": 0, "width": 420, "height": 640 }, "layoutVersion": 2 }),
        ));
        assert_eq!(frame, Some(Rect::new(0., 0., 420., 640.)));
        assert_eq!(patch, None);
    }

    #[test]
    fn only_a_window_left_open_reopens_at_launch() {
        assert!(reopens(&prefs(json!({ "open": true }))));
        assert!(!reopens(&prefs(json!({ "open": false }))));
        assert!(!reopens(&Map::new()));
    }

    #[test]
    fn a_first_open_writes_only_the_version() {
        let (frame, patch) = migrate(&Map::new());
        assert_eq!(frame, None);
        let patch = patch.unwrap();
        assert_eq!(patch.len(), 1);
        assert_eq!(patch["layoutVersion"], json!(2));
    }

    #[test]
    fn keep_on_top_needs_preference_version_one() {
        assert!(!always_on_top_pref(&prefs(json!({ "alwaysOnTop": true }))));
        assert!(!always_on_top_pref(&prefs(
            json!({ "alwaysOnTop": true, "alwaysOnTopPreferenceVersion": 2 })
        )));
        assert!(always_on_top_pref(&prefs(
            json!({ "alwaysOnTop": true, "alwaysOnTopPreferenceVersion": 1 })
        )));
    }

    #[test]
    fn hide_from_stream_needs_preference_version_one() {
        assert!(!hidden_from_stream_pref(&prefs(
            json!({ "hiddenFromStream": true })
        )));
        assert!(hidden_from_stream_pref(&prefs(json!({
            "hiddenFromStream": true,
            "hiddenFromStreamPreferenceVersion": 1
        }))));
    }

    fn always_on_top_pref(prefs: &Map<String, Value>) -> bool {
        prefs
            .get("alwaysOnTopPreferenceVersion")
            .and_then(Value::as_u64)
            == Some(1)
            && prefs.get("alwaysOnTop") == Some(&Value::Bool(true))
    }

    fn hidden_from_stream_pref(prefs: &Map<String, Value>) -> bool {
        prefs
            .get("hiddenFromStreamPreferenceVersion")
            .and_then(Value::as_u64)
            == Some(1)
            && prefs.get("hiddenFromStream") == Some(&Value::Bool(true))
    }
}
