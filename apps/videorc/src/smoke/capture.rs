//! UI driver gap 3, window capture (plan 260 Phase 3, L6): `capture-page`,
//! `comments-window-capture-page` and `preview-surface-sample` on the GPUI
//! app. The commands, their parameters and their answers are
//! `videorc_app_core::smoke::capture`'s; `main-window-id` is the shell's
//! (C1's #2133).
//!
//! This is the interface stub other lanes write against (C1's `smoke:screens`,
//! C4's `probe:comments-window`): the captures check their parameters and
//! then answer [`CAPTURE_PENDING`] by name until the composited window
//! capture lands (L6's next PR).

use std::path::PathBuf;

use serde_json::{Map, Value};
use videorc_app_core::smoke::capture::{
    CAPTURE_COMMANDS, COMMENTS_CAPTURE_SIZE, parse_normalized_rects,
};
use videorc_app_core::smoke::security::ui_window;
use videorc_app_core::smoke::{CommandFuture, SmokeCommandHandler};

use super::UiThread;

/// What a capture answers until the composited capture lands.
pub const CAPTURE_PENDING: &str = "The GPUI app's window capture is not written yet (plan 260 \
     gap 3, L6's next PR); this command's parameters and answer are \
     videorc_app_core::smoke::capture's.";

pub struct CaptureCommands {
    /// Where the capture runs (GPUI's foreground), once it is written.
    #[allow(dead_code)]
    ui: UiThread,
    /// Where a capture writes (`VIDEORC_SMOKE_OUTPUT_DIR`, or the temp
    /// directory as Electron's `app.getPath('temp')`).
    #[allow(dead_code)]
    output_dir: PathBuf,
}

impl CaptureCommands {
    pub fn new(ui: UiThread, output_dir: PathBuf) -> Self {
        Self { ui, output_dir }
    }
}

impl SmokeCommandHandler for CaptureCommands {
    fn handles(&self, command: &str) -> bool {
        CAPTURE_COMMANDS.contains(&command)
    }

    fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a> {
        Box::pin(async move {
            match command {
                "capture-page" => {
                    ui_window(&params)?;
                    Err(CAPTURE_PENDING.into())
                }
                "comments-window-capture-page" => {
                    let size = |key: &str, default: f64| match params.get(key) {
                        None | Some(Value::Null) => Ok(default),
                        Some(value) => value
                            .as_f64()
                            .filter(|size| size.is_finite() && *size > 0.0)
                            .ok_or_else(|| {
                                format!("comments-window-capture-page's {key} is a size in points.")
                            }),
                    };
                    size("width", COMMENTS_CAPTURE_SIZE.0)?;
                    size("height", COMMENTS_CAPTURE_SIZE.1)?;
                    Err(CAPTURE_PENDING.into())
                }
                "preview-surface-sample" => {
                    parse_normalized_rects(&params)?;
                    Err(CAPTURE_PENDING.into())
                }
                other => Err(format!("{other} is not a capture command.")),
            }
        })
    }
}
