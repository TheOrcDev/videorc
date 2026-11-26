//! Saved window frames (plan 260 S2.6a), from videorc-rust's
//! `app_windows` (plan 220 S2.6c), as Electron main keeps them:
//!
//! - [`Rect`] and [`Display`]: frames in points, top-left origin of the
//!   primary display (Electron's `Rectangle`, whole points on disk).
//! - [`clamp_frame_to_work_area`] (`clampFrameToWorkArea`): a remembered
//!   frame comes back inside the display it overlaps most, no larger than
//!   its work area (a display unplugged, a window parked at an edge).
//! - [`WindowPrefsFile`]: one window's JSON file in the data directory,
//!   merged the way `savePreviewWindowPrefs` merges it (keys this app does
//!   not know are kept): Electron's `preview-window.json` and
//!   `comments-window.json`, and the main window's `main-window.json`
//!   (videorc-rust's own: Electron opens the main window at 1180x780 every
//!   launch). Smoke and probe runs neither read nor write them
//!   ([`persistence_enabled`]).
//! - [`PreviewWindowPrefs`] and [`close_prefs`]: the detached Preview's
//!   remembered state, for its window (L1).
//! - [`conform_content_to_aspect`] and [`preview_min_content_size`]: the
//!   floating Preview follows the output's aspect (a vertical preset makes
//!   it portrait), as Electron's `applyPreviewWindowAspect` does.
//!
//! Hide from stream is `desktop::capture_protection`'s; Keep on top's
//! levels are the platform's (`apps/videorc/src/platform/`). Pure data and
//! files: the app applies them to its windows.

use std::path::{Path, PathBuf};

use serde_json::{Map, Number, Value, json};

// --- frames ---

/// A window frame in points, top-left origin (Electron's `Rectangle`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn right(&self) -> f64 {
        self.x + self.width
    }

    fn bottom(&self) -> f64 {
        self.y + self.height
    }

    fn intersection_area(&self, other: &Rect) -> f64 {
        let width = self.right().min(other.right()) - self.x.max(other.x);
        let height = self.bottom().min(other.bottom()) - self.y.max(other.y);
        if width > 0.0 && height > 0.0 {
            width * height
        } else {
            0.0
        }
    }

    /// The distance from a point to this rect (0 inside).
    fn distance_to(&self, x: f64, y: f64) -> f64 {
        let dx = (self.x - x).max(0.0).max(x - self.right());
        let dy = (self.y - y).max(0.0).max(y - self.bottom());
        (dx * dx + dy * dy).sqrt()
    }

    /// A saved frame, or `None` when the value is not one (missing, not
    /// finite, empty).
    pub fn from_json(value: &Value) -> Option<Rect> {
        let number = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite())
        };
        let rect = Rect::new(
            number("x")?,
            number("y")?,
            number("width")?,
            number("height")?,
        );
        (rect.width > 0.0 && rect.height > 0.0).then_some(rect)
    }

    /// Electron's `Rectangle`: whole points.
    pub fn to_json(self) -> Value {
        let whole = |v: f64| Value::Number(Number::from(v.round() as i64));
        json!({
            "x": whole(self.x),
            "y": whole(self.y),
            "width": whole(self.width),
            "height": whole(self.height),
        })
    }
}

/// One display: its bounds and its work area (without the menu bar and
/// the Dock), points, top-left origin of the primary display.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Display {
    pub bounds: Rect,
    pub work_area: Rect,
}

/// `screen.getDisplayMatching`: the display the frame overlaps most, or the
/// one nearest its centre when it overlaps none.
pub fn display_matching<'a>(frame: &Rect, displays: &'a [Display]) -> Option<&'a Display> {
    let best = displays
        .iter()
        .map(|display| (display, frame.intersection_area(&display.bounds)))
        .filter(|(_, area)| *area > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(display, _)| display);
    best.or_else(|| {
        let cx = frame.x + frame.width / 2.0;
        let cy = frame.y + frame.height / 2.0;
        displays.iter().min_by(|a, b| {
            a.bounds
                .distance_to(cx, cy)
                .total_cmp(&b.bounds.distance_to(cx, cy))
        })
    })
}

/// `clampFrameToWorkArea`: a remembered frame can be off screen (a display
/// unplugged, a window parked at an edge); it comes back no larger than the
/// matching display's work area and inside it. With no display known the
/// frame is kept.
pub fn clamp_frame_to_work_area(frame: Rect, displays: &[Display]) -> Rect {
    let Some(display) = display_matching(&frame, displays) else {
        return frame;
    };
    let area = display.work_area;
    let width = frame.width.min(area.width);
    let height = frame.height.min(area.height);
    Rect {
        width,
        height,
        x: frame.x.max(area.x).min(area.right() - width),
        y: frame.y.max(area.y).min(area.bottom() - height),
    }
}

/// `conformPreviewWindowToAspect`: the floating Preview's content size for
/// the output's `ratio` (width / height). It keeps the width and derives
/// the video's height (plus `bar`, the strip above the video inside the
/// content); when that is taller than `room` (the most content height the
/// display's work area leaves), it takes `room` and derives the width.
/// `None` when the content already fits the ratio within a point, so an
/// unchanged aspect never resizes the window.
pub fn conform_content_to_aspect(
    content: (f64, f64),
    ratio: f64,
    bar: f64,
    room: f64,
) -> Option<(f64, f64)> {
    if !ratio.is_finite() || ratio <= 0.0 {
        return None;
    }
    let (content_width, content_height) = content;
    let mut width = content_width;
    let mut height = (width / ratio).round() + bar;
    if room > bar && height > room {
        height = room;
        width = ((height - bar) * ratio).round();
    }
    if (height - content_height).abs() <= 1.0 && (width - content_width).abs() <= 1.0 {
        return None;
    }
    Some((width, height))
}

/// The floating Preview's least content size for the output's `ratio`
/// (Electron's `setMinimumSize(320, round(320 / ratio) + bar)`).
pub fn preview_min_content_size(ratio: f64, bar: f64) -> (f64, f64) {
    const MIN_WIDTH: f64 = 320.0;
    let ratio = if ratio.is_finite() && ratio > 0.0 {
        ratio
    } else {
        16.0 / 9.0
    };
    (MIN_WIDTH, (MIN_WIDTH / ratio).round() + bar)
}

// --- the saved preferences ---

/// The Preview window's file (`previewWindowPrefsPath`).
pub const PREVIEW_WINDOW_PREFS_FILE: &str = "preview-window.json";
/// The main window's file (the Rust app's own; see the module docs).
pub const MAIN_WINDOW_PREFS_FILE: &str = "main-window.json";
/// The Stream Manager's file (`commentsWindowPrefsPath`), which holds its
/// Hide from stream switch.
pub const COMMENTS_WINDOW_PREFS_FILE: &str = "comments-window.json";
/// The Notes teleprompter's prefs and document (`notes-window.json`).
pub const NOTES_WINDOW_PREFS_FILE: &str = "notes-window.json";

/// `previewWindowAutoRestoreEnabled`: smoke and probe runs drive the
/// windows themselves, so they neither restore nor save (Electron's
/// switches, read the same way).
pub fn persistence_enabled(env: impl Fn(&str) -> Option<String>) -> bool {
    env("VIDEORC_DISABLE_AUTO_PREVIEW").as_deref() != Some("1")
        && env("VIDEORC_SMOKE_OUTPUT_DIR").is_none_or(|dir| dir.is_empty())
}

/// One window's JSON file in the data directory.
#[derive(Debug, Clone)]
pub struct WindowPrefsFile {
    path: PathBuf,
    enabled: bool,
}

impl WindowPrefsFile {
    /// `enabled` false (a smoke run) reads nothing and writes nothing.
    pub fn new(user_data_dir: &Path, name: &str, enabled: bool) -> Self {
        Self {
            path: user_data_dir.join(name),
            enabled,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// The file's object; missing, unreadable or not an object reads as
    /// empty (`loadPreviewWindowPrefs`'s catch).
    pub fn load(&self) -> Map<String, Value> {
        if !self.enabled {
            return Map::new();
        }
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| match value {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default()
    }

    /// `{ ...load(), ...patch }`, written whole. Keys this app does not know
    /// (Electron's own) are kept. A disabled file writes nothing.
    pub fn save(&self, patch: Map<String, Value>) -> std::io::Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let mut merged = self.load();
        merged.extend(patch);
        let text = serde_json::to_string(&Value::Object(merged)).map_err(std::io::Error::other)?;
        std::fs::write(&self.path, text)
    }
}

/// The Preview window's remembered state (`PreviewWindowPrefs`): the
/// FLOATING frame (a docked placement is never saved), Keep on top, the
/// open choice and the mode.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PreviewWindowPrefs {
    pub frame: Option<Rect>,
    /// `prefs.alwaysOnTop === true`.
    pub always_on_top: bool,
    /// `open`; the launch restores the window unless it is `false`.
    pub open: Option<bool>,
    /// `"docked"` or `"floating"`, as saved.
    pub mode: Option<String>,
    /// Any remembered Preview state means this Mac ran Videorc before
    /// (`existingInstall: Object.keys(prefs).length > 0`).
    pub existing_install: bool,
}

impl PreviewWindowPrefs {
    pub fn from_json(prefs: &Map<String, Value>) -> Self {
        Self {
            frame: prefs.get("frame").and_then(Rect::from_json),
            always_on_top: prefs.get("alwaysOnTop") == Some(&Value::Bool(true)),
            open: prefs.get("open").and_then(Value::as_bool),
            mode: prefs
                .get("mode")
                .and_then(Value::as_str)
                .map(str::to_string),
            existing_install: !prefs.is_empty(),
        }
    }

    /// `restorePreviewWindowOnLaunch`: `prefs.open !== false`.
    pub fn restore_on_launch(&self) -> bool {
        self.open != Some(false)
    }
}

/// `previewWindowClosePrefs`: the frame the window had, and `open: false`
/// unless quitting closed it (a window quitting closes comes back).
pub fn close_prefs(frame: Option<Rect>, app_quitting: bool) -> Map<String, Value> {
    let mut patch = Map::new();
    if let Some(frame) = frame {
        patch.insert("frame".into(), frame.to_json());
    }
    if !app_quitting {
        patch.insert("open".into(), Value::Bool(false));
    }
    patch
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(x: f64, y: f64, width: f64, height: f64, menu: f64) -> Display {
        Display {
            bounds: Rect::new(x, y, width, height),
            work_area: Rect::new(x, y + menu, width, height - menu),
        }
    }

    #[test]
    fn the_preview_conforms_to_the_output_aspect_as_electron_does() {
        let landscape = 1920.0 / 1080.0;
        let portrait = 1080.0 / 1920.0;
        // The default 960x540 video at 16:9: already conformed.
        assert_eq!(
            conform_content_to_aspect((960.0, 540.0), landscape, 0.0, 900.0),
            None
        );
        // A vertical preset: the width would need a 1707 pt tall video, more
        // than the work area leaves, so the height takes the room and the
        // width follows it (a portrait window).
        assert_eq!(
            conform_content_to_aspect((960.0, 540.0), portrait, 0.0, 900.0),
            Some((506.0, 900.0))
        );
        // Back to landscape: the narrow width stays, the height follows.
        assert_eq!(
            conform_content_to_aspect((506.0, 900.0), landscape, 0.0, 900.0),
            Some((506.0, 285.0))
        );
        // Electron's in-content bar counts in the height and not the video.
        assert_eq!(
            conform_content_to_aspect((960.0, 540.0), landscape, 28.0, 900.0),
            Some((960.0, 568.0))
        );
        // A tall enough display keeps the width.
        assert_eq!(
            conform_content_to_aspect((400.0, 225.0), portrait, 0.0, 2000.0),
            Some((400.0, 711.0))
        );
        // No ratio: nothing to conform to.
        assert_eq!(
            conform_content_to_aspect((960.0, 540.0), 0.0, 0.0, 900.0),
            None
        );
    }

    #[test]
    fn the_preview_min_size_follows_the_output_aspect() {
        assert_eq!(preview_min_content_size(16.0 / 9.0, 28.0), (320.0, 208.0));
        assert_eq!(preview_min_content_size(9.0 / 16.0, 0.0), (320.0, 569.0));
        assert_eq!(preview_min_content_size(f64::NAN, 0.0), (320.0, 180.0));
    }

    #[test]
    fn a_frame_comes_back_inside_the_display_it_overlaps_most() {
        // A 1512x982 built-in display with a 37 pt menu bar, and a 1920x1080
        // display to its right, a little higher.
        let displays = [
            display(0.0, 0.0, 1512.0, 982.0, 37.0),
            display(1512.0, -100.0, 1920.0, 1080.0, 25.0),
        ];
        // Inside: unchanged.
        let inside = Rect::new(100.0, 140.0, 1000.0, 700.0);
        assert_eq!(clamp_frame_to_work_area(inside, &displays), inside);
        // Under the menu bar: pushed down into the work area.
        assert_eq!(
            clamp_frame_to_work_area(Rect::new(100.0, 0.0, 1000.0, 700.0), &displays),
            Rect::new(100.0, 37.0, 1000.0, 700.0)
        );
        // Mostly on the second display: clamped into that one.
        assert_eq!(
            clamp_frame_to_work_area(Rect::new(3300.0, 500.0, 600.0, 400.0), &displays),
            Rect::new(2832.0, 500.0, 600.0, 400.0)
        );
        // A display that was unplugged: the nearest one, and no larger than
        // its work area.
        assert_eq!(
            clamp_frame_to_work_area(Rect::new(-5000.0, 200.0, 2000.0, 1200.0), &displays),
            Rect::new(0.0, 37.0, 1512.0, 945.0)
        );
        // No display known: kept.
        assert_eq!(clamp_frame_to_work_area(inside, &[]), inside);
    }

    #[test]
    fn frames_read_and_write_as_electrons_rectangle() {
        let rect = Rect::from_json(&json!({"x": 10.4, "y": -20, "width": 640, "height": 400}))
            .expect("a frame");
        assert_eq!(rect, Rect::new(10.4, -20.0, 640.0, 400.0));
        assert_eq!(
            rect.to_json(),
            json!({"x": 10, "y": -20, "width": 640, "height": 400})
        );
        for bad in [
            json!(null),
            json!({"x": 1, "y": 2, "width": 0, "height": 5}),
            json!({"x": 1, "y": 2, "width": 3}),
            json!({"x": "1", "y": 2, "width": 3, "height": 4}),
        ] {
            assert_eq!(Rect::from_json(&bad), None, "{bad}");
        }
    }

    #[test]
    fn the_prefs_file_merges_like_electron_and_survives_a_bad_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = WindowPrefsFile::new(dir.path(), PREVIEW_WINDOW_PREFS_FILE, true);
        // Missing: empty, a new install.
        assert!(file.load().is_empty());
        assert!(!PreviewWindowPrefs::from_json(&file.load()).existing_install);
        let patch = |value: Value| match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        };
        file.save(patch(json!({"open": true}))).expect("save");
        file.save(patch(json!({"mode": "floating", "alwaysOnTop": true})))
            .expect("save");
        file.save(close_prefs(
            Some(Rect::new(700.0, 300.0, 640.0, 400.0)),
            true,
        ))
        .expect("save");
        // An Electron key this app does not read is kept.
        let mut electron = file.load();
        electron.insert("someElectronKey".into(), json!(7));
        std::fs::write(file.path(), Value::Object(electron).to_string()).expect("write");
        file.save(patch(json!({"alwaysOnTop": false})))
            .expect("save");
        let saved = file.load();
        assert_eq!(saved.get("someElectronKey"), Some(&json!(7)));
        let prefs = PreviewWindowPrefs::from_json(&saved);
        assert_eq!(
            prefs,
            PreviewWindowPrefs {
                frame: Some(Rect::new(700.0, 300.0, 640.0, 400.0)),
                always_on_top: false,
                open: Some(true),
                mode: Some("floating".into()),
                existing_install: true,
            }
        );
        assert!(prefs.restore_on_launch());
        // A user's close says closed; quitting kept it open (above).
        file.save(close_prefs(None, false)).expect("save");
        assert!(!PreviewWindowPrefs::from_json(&file.load()).restore_on_launch());
        // A corrupt file reads as empty and the next save replaces it.
        std::fs::write(file.path(), "{not json").expect("write");
        assert!(file.load().is_empty());
        file.save(patch(json!({"mode": "docked"}))).expect("save");
        assert_eq!(file.load().get("mode"), Some(&json!("docked")));
        // A disabled file (a smoke run) neither reads nor writes.
        let off = WindowPrefsFile::new(dir.path(), PREVIEW_WINDOW_PREFS_FILE, false);
        assert!(off.load().is_empty());
        off.save(patch(json!({"mode": "floating"}))).expect("save");
        assert_eq!(file.load().get("mode"), Some(&json!("docked")));
        // `alwaysOnTop` counts only when exactly true.
        let forged = patch(json!({"alwaysOnTop": "true"}));
        assert!(!PreviewWindowPrefs::from_json(&forged).always_on_top);
    }

    #[test]
    fn persistence_follows_electrons_smoke_switches() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
            }
        };
        assert!(persistence_enabled(env(&[])));
        assert!(!persistence_enabled(env(&[(
            "VIDEORC_DISABLE_AUTO_PREVIEW",
            "1"
        )])));
        assert!(persistence_enabled(env(&[(
            "VIDEORC_DISABLE_AUTO_PREVIEW",
            "0"
        )])));
        assert!(!persistence_enabled(env(&[(
            "VIDEORC_SMOKE_OUTPUT_DIR",
            "/tmp/out"
        )])));
        assert!(persistence_enabled(env(&[(
            "VIDEORC_SMOKE_OUTPUT_DIR",
            ""
        )])));
    }
}
