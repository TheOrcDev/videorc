//! UI driver gap 3, window capture (plan 260 Phase 3, L6): `capture-page`,
//! `comments-window-capture-page` and `preview-surface-sample` on the GPUI
//! app. The commands, their parameters and their answers are
//! `videorc_app_core::smoke::capture`'s; `main-window-id` is the shell's
//! (C1's #2133).
//!
//! A capture is the composited window, as `screencapture -l <windowNumber>`
//! sees it on macOS (the window's own pixels, its glass and the native
//! preview layer included; never a page render, which GPUI only offers to
//! tests). It runs off GPUI's foreground; the window number and geometry
//! are read on it. Other platforms answer by name that they have no capture
//! yet.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{AnyWindowHandle, App};
use serde_json::{Map, Value, json};
use videorc_app_core::smoke::capture::{
    Bitmap, CAPTURE_COMMANDS, COMMENTS_CAPTURE_SIZE, PixelOrder, contain, mean_rects,
    parse_normalized_rects, stage_capture_rect,
};
use videorc_app_core::smoke::security::{UiWindow, capture_page_file_name, ui_window};
use videorc_app_core::smoke::{CommandFuture, SmokeCommandHandler};
use videorc_preview::lifecycle::WindowMode;

use super::{MAIN_WINDOW_NOT_READY, UiThread, shell};
use crate::platform;

/// How long a resized window gets to draw before it is captured.
const SETTLE: Duration = Duration::from_millis(300);

pub struct CaptureCommands {
    ui: UiThread,
    /// Where a capture writes (`VIDEORC_SMOKE_OUTPUT_DIR`, or the temp
    /// directory as Electron's `app.getPath('temp')`).
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
                "capture-page" => self.capture_page(&params).await,
                "comments-window-capture-page" => self.capture_comments(&params).await,
                "preview-surface-sample" => self.sample_preview(&params).await,
                other => Err(format!("{other} is not a capture command.")),
            }
        })
    }
}

impl CaptureCommands {
    /// `capture-page {name?, window?}` → `{file}`.
    async fn capture_page(&self, params: &Map<String, Value>) -> Result<Value, String> {
        let which = ui_window(params)?;
        let file = self.output_dir.join(capture_page_file_name(params));
        let id = self
            .ui
            .run(move |cx| {
                let handle = shell(cx)?
                    .window(which, cx)
                    .ok_or_else(|| closed_window(which))?;
                window_number(handle, cx)
            })
            .await??;
        capture(id, &file, Format::Png).await?;
        Ok(json!({ "file": file }))
    }

    /// `comments-window-capture-page {width?, height?, name?}` → `{file,
    /// width, height}`: the Stream Manager at that size, then captured.
    async fn capture_comments(&self, params: &Map<String, Value>) -> Result<Value, String> {
        let side = |key: &str, default: f64| match params.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(value) => value
                .as_f64()
                .filter(|side| side.is_finite() && *side > 0.0)
                .ok_or_else(|| {
                    format!("comments-window-capture-page's {key} is a size in points.")
                }),
        };
        let width = side("width", COMMENTS_CAPTURE_SIZE.0)?;
        let height = side("height", COMMENTS_CAPTURE_SIZE.1)?;
        let name = match params.get("name") {
            Some(Value::String(_)) => {
                let mut named = Map::new();
                named.insert("name".into(), params["name"].clone());
                capture_page_file_name(&named)
            }
            _ => "videorc-ui-comments-window.png".to_string(),
        };
        let file = self.output_dir.join(name);
        self.ui
            .run(move |cx| {
                let handle = crate::screens::stream_manager::window::handle(cx)
                    .ok_or("Chat window is not open.")?;
                handle
                    .update(cx, |_, window, _| {
                        // The window's frame, where it is (`Window::resize`
                        // left the Stream Manager at its own size).
                        let bounds = window.bounds();
                        let placed = platform::current().set_window_frame(
                            window,
                            crate::platform::ScreenFrame {
                                x: f64::from(f32::from(bounds.origin.x)),
                                y: f64::from(f32::from(bounds.origin.y)),
                                width,
                                height,
                            },
                        );
                        window.activate_window();
                        placed
                    })
                    .map_err(|_| "Chat window is not open.".to_string())?
            })
            .await??;
        tokio::time::sleep(SETTLE).await;
        let (id, drawn) = self
            .ui
            .run(|cx| {
                let handle = crate::screens::stream_manager::window::handle(cx)
                    .ok_or("Chat window is not open.")?;
                let id = window_number(handle, cx)?;
                let size = handle
                    .update(cx, |_, window, _| window.viewport_size())
                    .map_err(|_| "Chat window is not open.".to_string())?;
                Ok::<_, String>((id, size))
            })
            .await??;
        capture(id, &file, Format::Png).await?;
        Ok(json!({
            "file": file,
            "width": f32::from(drawn.width),
            "height": f32::from(drawn.height),
        }))
    }

    /// `preview-surface-sample {rects}`: the preview's stage in the window
    /// that shows it, captured, and the mean colour of each rect's middle
    /// fifth (Electron's `meanRectsFromBitmap`).
    async fn sample_preview(&self, params: &Map<String, Value>) -> Result<Value, String> {
        let rects = parse_normalized_rects(params)?;
        let seen = self.ui.run(read_preview).await??;
        let mut base = seen.base;
        let Some(target) = seen.target else {
            return Ok(base);
        };
        let file = self
            .output_dir
            .join(format!("videorc-preview-sample-{}.png", std::process::id()));
        // PNG, never BMP: a BMP carries no colour profile, so ImageIO
        // converts the display's values on the way (about +60 per channel on
        // bca6ce49b), while a PNG keeps what the screen shows.
        capture(target.id, &file, Format::Png).await?;
        let bytes = std::fs::read(&file);
        let _ = std::fs::remove_file(&file);
        let bytes = bytes.map_err(|error| format!("The capture is unreadable: {error}"))?;
        let bitmap = decode_png(&bytes)?;
        // The capture is in device pixels; the stage is in window points.
        let scale = bitmap.width as f64 / target.viewport.0;
        // `screencapture -l` takes the whole window frame: a titled window's
        // title bar sits above its content (the Preview window's 28 points),
        // while the stage is measured from the content's top.
        let title_bar = (bitmap.height as f64 / scale - target.viewport.1).max(0.0);
        let stage = target.stage;
        let Some(pixels) = stage_capture_rect(
            stage.0 * scale,
            (stage.1 + title_bar) * scale,
            stage.2 * scale,
            stage.3 * scale,
            (bitmap.width as f64, bitmap.height as f64),
        ) else {
            base["error"] = json!("stage-not-on-screen");
            return Ok(base);
        };
        base["titleBar"] = json!(title_bar);
        let Some(stage_bitmap) = bitmap.crop(pixels) else {
            base["error"] = json!("empty-capture");
            return Ok(base);
        };
        let samples = mean_rects(
            &stage_bitmap.bgra,
            stage_bitmap.width,
            stage_bitmap.height,
            PixelOrder::Bgra,
            &rects,
        )?;
        base["capturedAt"] = json!(now_ms());
        base["width"] = json!(stage_bitmap.width);
        base["height"] = json!(stage_bitmap.height);
        base["liveLayers"] = json!([]);
        base["samples"] = Value::Array(
            samples
                .into_iter()
                .map(|mean| json!({ "r": mean.r, "g": mean.g, "b": mean.b }))
                .collect(),
        );
        Ok(base)
    }
}

/// A PNG capture as top-down BGRA (the core's [`Bitmap`]).
fn decode_png(bytes: &[u8]) -> Result<Bitmap, String> {
    let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|error| format!("The capture is not a readable PNG: {error}"))?
        .to_rgba8();
    let (width, height) = (image.width() as usize, image.height() as usize);
    let mut bgra = image.into_raw();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Ok(Bitmap {
        width,
        height,
        bgra,
    })
}

/// Where the preview is to be captured.
struct Target {
    id: u32,
    /// The window's content size in points.
    viewport: (f64, f64),
    /// The canvas contain-fit into the slot, in window points.
    stage: (f64, f64, f64, f64),
}

struct PreviewSeen {
    /// Electron's `base`: what the preview is, before any capture.
    base: Value,
    target: Option<Target>,
}

/// The preview's state and, when it shows, where its stage is.
fn read_preview(cx: &mut App) -> Result<PreviewSeen, String> {
    let shell = shell(cx)?;
    let Some(preview) = shell.preview_entity() else {
        return Ok(PreviewSeen {
            base: json!({ "error": "no-preview" }),
            target: None,
        });
    };
    let state = preview.read(cx).smoke_state();
    let mode = preview.read(cx).mode();
    let slot = preview.read(cx).smoke_slot();
    let canvas = preview.read(cx).smoke_canvas();
    let shown = if mode == WindowMode::Floating {
        state["floatingOpen"] == true
    } else {
        state["dockedShown"] == true && state["closed"] != true
    };
    let mut base = json!({
        "transport": "gpui-native",
        "backing": null,
        "state": state["phase"],
        "hostKind": state["mode"],
        "presenter": null,
        "sceneRevision": null,
        "sceneKinds": [],
        "proofWindowVisible": shown,
        "canvas": canvas.map(|(width, height)| json!({ "width": width, "height": height })),
    });
    if !shown {
        base["error"] = json!("preview-hidden");
        return Ok(PreviewSeen { base, target: None });
    }
    let handle = match mode {
        WindowMode::Floating => preview.read(cx).floating_window(),
        WindowMode::Docked => shell.window(UiWindow::Main, cx),
    }
    .ok_or(MAIN_WINDOW_NOT_READY)?;
    let Some(slot) = slot else {
        base["error"] = json!("stage-not-on-screen");
        return Ok(PreviewSeen { base, target: None });
    };
    let id = window_number(handle, cx)?;
    let viewport = handle
        .update(cx, |_, window, _| {
            let size = window.viewport_size();
            (
                f64::from(f32::from(size.width)),
                f64::from(f32::from(size.height)),
            )
        })
        .map_err(|_| MAIN_WINDOW_NOT_READY.to_string())?;
    let slot = (
        f64::from(f32::from(slot.origin.x)),
        f64::from(f32::from(slot.origin.y)),
        f64::from(f32::from(slot.size.width)),
        f64::from(f32::from(slot.size.height)),
    );
    let stage = match canvas {
        Some(canvas) => contain(slot, canvas),
        None => slot,
    };
    base["stage"] = json!({ "left": stage.0, "top": stage.1, "width": stage.2, "height": stage.3 });
    Ok(PreviewSeen {
        base,
        target: Some(Target {
            id,
            viewport,
            stage,
        }),
    })
}

fn closed_window(which: UiWindow) -> String {
    match which {
        UiWindow::Main => MAIN_WINDOW_NOT_READY.to_string(),
        other => format!("capture-page: the {other:?} window is not open."),
    }
}

/// The window's number in the OS's capture APIs.
fn window_number(handle: AnyWindowHandle, cx: &mut App) -> Result<u32, String> {
    handle
        .update(cx, |_, window, _| {
            platform::current().capture_window_id(window)
        })
        .map_err(|_| "The window closed.".to_string())?
        .ok_or_else(|| {
            format!(
                "capture-page: this platform ({}) names no window for a capture yet.",
                std::env::consts::OS
            )
        })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Copy)]
enum Format {
    Png,
}

/// How long a woken window gets to draw before the capture that counts.
const WAKE_TO_CAPTURE: Duration = Duration::from_millis(700);

/// The composited window `id` into `file`, fresh: GPUI redraws a covered
/// window only once something reads its pixels, so one capture alone can show
/// the screen before (L4's gallery found it lagging one screen behind). A
/// first capture wakes the window and is thrown away; the second, a moment
/// later, is the one kept.
#[cfg(target_os = "macos")]
async fn capture(id: u32, file: &Path, format: Format) -> Result<(), String> {
    capture_once(id, file, format).await?;
    tokio::time::sleep(WAKE_TO_CAPTURE).await;
    capture_once(id, file, format).await
}

#[cfg(target_os = "macos")]
async fn capture_once(id: u32, file: &Path, format: Format) -> Result<(), String> {
    if let Some(directory) = file.parent() {
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("The capture folder can't be made: {error}"))?;
    }
    let kind = match format {
        Format::Png => "png",
    };
    // -x: no sound; -o: no shadow; -l: this window only. A blocking call,
    // so it runs on tokio's blocking pool, never the server's task.
    let path = file.to_path_buf();
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("/usr/sbin/screencapture")
            .arg("-x")
            .arg("-o")
            .arg(format!("-l{id}"))
            .arg("-t")
            .arg(kind)
            .arg(&path)
            .output()
    })
    .await
    .map_err(|error| format!("screencapture did not finish: {error}"))?
    .map_err(|error| format!("screencapture did not start: {error}"))?;
    if !output.status.success() || !file.exists() {
        return Err(format!(
            "screencapture failed ({}): {} (the app needs Screen Recording access)",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
async fn capture(_id: u32, _file: &Path, _format: Format) -> Result<(), String> {
    Err(format!(
        "The window capture isn't written for {} yet (plan 260 gap 3).",
        std::env::consts::OS
    ))
}
