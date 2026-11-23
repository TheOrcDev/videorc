//! Plan 260 S0.1: the macOS preview inside GPUI with the real backend.
//!
//! `videorc-preview`'s element (the S0.2h presenter: a `CAMetalLayer` presented
//! on its own thread from the backend's IOSurface ring, the lease loop, the
//! first-frame watchdog) hosted in a GPUI `NativeView`, against the real
//! `videorc-backend` composing the test pattern at a pinned 4K60 canvas. GPUI
//! paints the scene editor's handles, a scrim and labels over the video.
//!
//! The run is scripted and measures itself (getrusage per phase, GPUI redraw
//! counts, the feed's report, the compositor's copy counters), then stops the
//! backend by its own PID and quits:
//!
//!   live (overlay on) -> live (overlay off) -> still (overlay off) ->
//!   still (overlay on) -> evidence shots -> floating window (live) ->
//!   floating evidence shots -> docked again -> report
//!
//! Usage:
//!   spike-preview-backend --backend <videorc-backend> --workspace <videorc checkout>
//!     --profile <dir> --report <json> [--canvas 3840x2160@60] [--live 600]
//!     [--live-compare 60] [--still 60] [--floating 60] [--shots <dir>]
//!     [--keep-on-top]

use std::{
    cell::RefCell,
    ffi::c_void,
    path::PathBuf,
    ptr::NonNull,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result, bail};
use gpui::{
    App, AsyncApp, Bounds, Context, NativeView, Pixels, WeakEntity, Window, WindowBounds,
    WindowHandle, WindowKind, WindowOptions, canvas, div, point, prelude::*, px, rgb, rgba, size,
};
use objc2::{
    ClassType, MainThreadMarker, MainThreadOnly, msg_send, rc::Retained, runtime::AnyObject,
};
use objc2_app_kit::NSView;
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize};
use objc2_quartz_core::{CAAutoresizingMask, CALayer, CAMetalLayer, CATransaction};
use raw_window_handle::{
    AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle as RawHandle,
};
use serde_json::{Value, json};
use videorc_app_core::process::BackendLaunch;
use videorc_app_core::{AppPaths, BackendState, Level, Logger, Supervisor, SupervisorConfig};
use videorc_preview::LayerRect;
use videorc_preview::bounds::{Canvas, WindowGeometry};
use videorc_preview::element::{ElementConfig, PreviewElement, UiRequest};
use videorc_preview::feed::{FeedConfig, FrameSource, SceneFeed};
use videorc_protocol::{
    PreviewSurfaceSource, SceneConfigParams, SourceSelection, VideoPreset, VideoSettings,
};

const SLOT_RADIUS: f64 = 12.0;
const SIDEBAR: f32 = 240.0;

// ---------------------------------------------------------------------------
// Arguments

#[derive(Clone)]
struct Args {
    backend: PathBuf,
    workspace: PathBuf,
    profile: PathBuf,
    report: PathBuf,
    shots: Option<PathBuf>,
    width: u32,
    height: u32,
    fps: u32,
    live: f64,
    live_compare: f64,
    still: f64,
    floating: f64,
    ab: u32,
    keep_on_top: bool,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        backend: PathBuf::new(),
        workspace: PathBuf::new(),
        profile: PathBuf::from("/tmp/videorc-s0-1"),
        report: PathBuf::from("/tmp/videorc-s0-1/report.json"),
        shots: None,
        width: 3840,
        height: 2160,
        fps: 60,
        live: 600.0,
        live_compare: 60.0,
        still: 60.0,
        floating: 60.0,
        ab: 0,
        keep_on_top: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().with_context(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--backend" => args.backend = value()?.into(),
            "--workspace" => args.workspace = value()?.into(),
            "--profile" => args.profile = value()?.into(),
            "--report" => args.report = value()?.into(),
            "--shots" => args.shots = Some(value()?.into()),
            "--canvas" => {
                let text = value()?;
                let (size, fps) = text.split_once('@').unwrap_or((&text, "60"));
                let (w, h) = size.split_once('x').context("--canvas wants WxH[@fps]")?;
                args.width = w.parse()?;
                args.height = h.parse()?;
                args.fps = fps.parse()?;
            }
            "--live" => args.live = value()?.parse()?,
            "--live-compare" => args.live_compare = value()?.parse()?,
            "--still" => args.still = value()?.parse()?,
            "--floating" => args.floating = value()?.parse()?,
            "--ab" => args.ab = value()?.parse()?,
            "--keep-on-top" => args.keep_on_top = true,
            other => bail!("unknown flag {other}"),
        }
    }
    if !args.backend.is_file() {
        bail!("--backend {} is not a file", args.backend.display());
    }
    if !args.workspace.is_dir() {
        bail!(
            "--workspace {} is not a directory",
            args.workspace.display()
        );
    }
    Ok(args)
}

// ---------------------------------------------------------------------------
// Measurement helpers

fn process_cpu_time() -> Duration {
    // SAFETY: getrusage fills a plain C struct of the size it is given.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return Duration::ZERO;
    }
    let tv = |tv: libc::timeval| {
        Duration::from_secs(tv.tv_sec.max(0) as u64)
            + Duration::from_micros(tv.tv_usec.max(0) as u64)
    };
    tv(usage.ru_utime) + tv(usage.ru_stime)
}

fn load_averages() -> [f64; 3] {
    let mut loads = [0f64; 3];
    // SAFETY: getloadavg writes at most `nelem` doubles.
    unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) };
    loads
}

static PROCESS_START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
static MAIN_RENDERS: AtomicU64 = AtomicU64::new(0);
static FLOATING_RENDERS: AtomicU64 = AtomicU64::new(0);

struct Mark {
    at: Instant,
    cpu: Duration,
    main_renders: u64,
    floating_renders: u64,
    layer_presented: u64,
    load: [f64; 3],
}

fn phase_json(name: &str, note: &str, start: &Mark, end: &Mark) -> Value {
    let wall = end.at.duration_since(start.at).as_secs_f64();
    let cpu = end.cpu.saturating_sub(start.cpu).as_secs_f64();
    let presented = end.layer_presented.saturating_sub(start.layer_presented);
    let value = json!({
        "phase": name,
        "note": note,
        "seconds": wall,
        "cpuPercentOfOneCore": 100.0 * cpu / wall.max(1e-9),
        "gpuiMainRenders": end.main_renders - start.main_renders,
        "gpuiFloatingRenders": end.floating_renders - start.floating_renders,
        "layerPresented": presented,
        "layerPresentedPerSecond": presented as f64 / wall.max(1e-9),
        "loadAtStart": start.load,
        "loadAtEnd": end.load,
    });
    println!("[s0.1] phase {name}: {value}");
    value
}

// ---------------------------------------------------------------------------
// The NSView the element's layer lives in

/// A host for `VideoLayer::attach`: the raw handle of a plain `NSView` (the
/// NativeView's own view), not of the window's GPUI view.
struct ViewHost(NonNull<c_void>);

impl HasWindowHandle for ViewHost {
    fn window_handle(&self) -> Result<RawHandle<'_>, HandleError> {
        let handle = AppKitWindowHandle::new(self.0);
        // SAFETY: the view outlives this borrow (the caller keeps it retained).
        Ok(unsafe { RawHandle::borrow_raw(RawWindowHandle::AppKit(handle)) })
    }
}

/// A layer-hosting `NSView` whose root layer is flipped (top-left origin), so
/// the element's sublayer keeps its place whatever height GPUI gives the view.
fn make_host_view(mtm: MainThreadMarker) -> Retained<NSView> {
    let view = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0., 0.), NSSize::new(640., 360.)),
    );
    let root = CALayer::new();
    root.setGeometryFlipped(true);
    view.setLayer(Some(&root));
    view.setWantsLayer(true);
    view
}

/// After `PreviewElement::attach`: the element's `CAMetalLayer` (the host's
/// sublayer) follows the host's bounds in the same Core Animation transaction
/// GPUI moves the view in, and gets the slot's rounded corners.
fn tune_video_layer(host: &NSView, radius: f64) -> bool {
    let Some(root) = host.layer() else {
        return false;
    };
    let Some(sublayers) = (unsafe { root.sublayers() }) else {
        return false;
    };
    let mut found = false;
    for layer in sublayers.iter() {
        if layer.isKindOfClass(CAMetalLayer::class()) {
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            layer.setAutoresizingMask(
                CAAutoresizingMask::LayerWidthSizable | CAAutoresizingMask::LayerHeightSizable,
            );
            layer.setCornerRadius(radius);
            layer.setMasksToBounds(radius > 0.0);
            CATransaction::commit();
            found = true;
        }
    }
    found
}

/// The window's `NSWindow` (through the GPUI view's raw handle).
fn ns_window_of(window: &Window) -> Option<*mut AnyObject> {
    let handle = HasWindowHandle::window_handle(window).ok()?;
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return None;
    };
    let ns_view = appkit.ns_view.as_ptr().cast::<AnyObject>();
    // SAFETY: the GPUI view is live while the window is; main thread.
    let ns_window: *mut AnyObject = unsafe { msg_send![ns_view, window] };
    (!ns_window.is_null()).then_some(ns_window)
}

fn window_number(ns_window: *mut AnyObject) -> isize {
    // SAFETY: a live NSWindow; main thread.
    unsafe { msg_send![ns_window, windowNumber] }
}

fn geometry_of(window: &Window, slot: Bounds<Pixels>, cx: &App) -> WindowGeometry {
    let bounds = window.bounds();
    let screen_height = window
        .display(cx)
        .map(|display| f64::from(display.bounds().size.height))
        .unwrap_or(0.0);
    WindowGeometry {
        screen_x: f64::from(bounds.origin.x) + f64::from(slot.origin.x),
        screen_y: f64::from(bounds.origin.y) + f64::from(slot.origin.y),
        content_width: f64::from(window.viewport_size().width),
        content_height: f64::from(window.viewport_size().height),
        screen_height,
        scale_factor: f64::from(window.scale_factor()),
    }
}

fn capture(args: &[&str]) -> Value {
    let out = std::process::Command::new("/usr/sbin/screencapture")
        .args(args)
        .output();
    match out {
        Ok(out) => json!({
            "args": args,
            "status": out.status.code(),
            "stderr": String::from_utf8_lossy(&out.stderr).trim(),
        }),
        Err(error) => json!({ "args": args, "error": error.to_string() }),
    }
}

// ---------------------------------------------------------------------------
// The docked Studio window

#[derive(Clone, Copy, PartialEq, Eq)]
enum Host {
    Docked,
    Floating,
}

struct Studio {
    args: Args,
    preview: NativeView,
    host_view: Retained<NSView>,
    element: Option<PreviewElement>,
    host: Host,
    overlay: bool,
    phase: String,
    floating: Option<WindowHandle<FloatingPreview>>,
    floating_view: Option<Retained<NSView>>,
    main_window_number: isize,
    runtime: tokio::runtime::Handle,
    supervisor: Rc<RefCell<Option<Supervisor>>>,
    phases: Vec<Value>,
    evidence: Vec<Value>,
}

impl Studio {
    fn new(
        args: Args,
        runtime: tokio::runtime::Handle,
        supervisor: Rc<RefCell<Option<Supervisor>>>,
        state: tokio::sync::watch::Receiver<BackendState>,
        logger: Logger,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mtm = MainThreadMarker::new().expect("main thread");
        let host_view = make_host_view(mtm);
        // SAFETY: a live NSView in no hierarchy; GPUI retains it.
        let preview = unsafe {
            NativeView::new(NonNull::from(&*host_view).cast(), window, cx).expect("native view")
        };
        preview.set_background(rgb(0x000000), cx);
        let ns_window = ns_window_of(window).expect("NSWindow");
        let main_window_number = window_number(ns_window);
        if args.keep_on_top {
            // NSFloatingWindowLevel: a covered window is throttled by the
            // window server and measures nothing (plan 220's method).
            let _: () = unsafe { msg_send![ns_window, setLevel: 3isize] };
        }
        println!("[s0.1] main window number {main_window_number}");

        let (requests_tx, mut requests_rx) = tokio::sync::mpsc::unbounded_channel::<UiRequest>();
        let notify: Arc<dyn Fn(UiRequest) + Send + Sync> = Arc::new(move |request| {
            let _ = requests_tx.send(request);
        });
        let params = SceneConfigParams {
            sources: SourceSelection {
                screen_id: None,
                window_id: None,
                camera_id: None,
                microphone_id: None,
                test_pattern: true,
            },
            layout: videorc_app_core::studio::CaptureConfig::default().layout,
            video: Some(VideoSettings {
                preset: VideoPreset::Custom,
                width: args.width,
                height: args.height,
                fps: args.fps,
                bitrate_kbps: 40_000,
            }),
            background: None,
            protected_overlay_window_ids: Vec::new(),
            transition_ms: None,
        };
        let config = ElementConfig {
            feed: FeedConfig {
                frame_source: FrameSource::NativeLease,
                scene: SceneFeed::fixed(params),
                source: PreviewSurfaceSource::Synthetic,
                target_fps: args.fps,
                record_stats: true,
                logger: logger.clone(),
            },
            canvas: Canvas::Pinned {
                width: args.width,
                height: args.height,
            },
            corner_radius: SLOT_RADIUS,
            notify,
            texture: None,
            logger,
        };
        let mut element = PreviewElement::start(&runtime, state, config).expect("preview element");
        element
            .attach(&ViewHost(NonNull::from(&*host_view).cast()))
            .expect("attach the layer to the NativeView's NSView");
        println!(
            "[s0.1] layer tuned (autoresize + corners): {}",
            tune_video_layer(&host_view, SLOT_RADIUS)
        );

        // The watchdog's requests, on the UI thread.
        cx.spawn(async move |this: WeakEntity<Studio>, cx: &mut AsyncApp| {
            while let Some(request) = requests_rx.recv().await {
                let _ = this.update(cx, |studio, _cx| studio.on_request(request));
            }
        })
        .detach();

        // The scripted run.
        cx.spawn(async move |this: WeakEntity<Studio>, cx: &mut AsyncApp| {
            if let Err(error) = run_script(this.clone(), cx).await {
                eprintln!("[s0.1] the run failed: {error:#}");
            }
            let _ = this.update(cx, |studio, cx| studio.finish(cx));
        })
        .detach();

        Self {
            args,
            preview,
            host_view,
            element: Some(element),
            host: Host::Docked,
            overlay: true,
            phase: "starting".into(),
            floating: None,
            floating_view: None,
            main_window_number,
            runtime,
            supervisor,
            phases: Vec::new(),
            evidence: Vec::new(),
        }
    }

    fn on_request(&mut self, request: UiRequest) {
        let Some(element) = self.element.as_mut() else {
            return;
        };
        match request {
            UiRequest::Status(status) => println!("[s0.1] preview status: {}", status.describe()),
            UiRequest::Kick => element.kick(),
            UiRequest::ResetNativePath => {
                let view = match self.host {
                    Host::Docked => self.host_view.clone(),
                    Host::Floating => match &self.floating_view {
                        Some(view) => view.clone(),
                        None => return,
                    },
                };
                let result = element.reset_native_path(&ViewHost(NonNull::from(&*view).cast()));
                println!("[s0.1] reset-native-path: {result:?}");
                tune_video_layer(&view, self.radius());
            }
        }
    }

    fn radius(&self) -> f64 {
        match self.host {
            Host::Docked => SLOT_RADIUS,
            Host::Floating => 0.0,
        }
    }

    fn place(&mut self, host: Host, slot: Bounds<Pixels>, geometry: WindowGeometry) {
        if self.host != host {
            return;
        }
        if let Some(element) = self.element.as_mut() {
            element.place(
                LayerRect {
                    x: 0.0,
                    y: 0.0,
                    width: f64::from(slot.size.width),
                    height: f64::from(slot.size.height),
                },
                geometry,
            );
        }
    }

    fn mark(&self) -> Mark {
        Mark {
            at: Instant::now(),
            cpu: process_cpu_time(),
            main_renders: MAIN_RENDERS.load(Ordering::Relaxed),
            floating_renders: FLOATING_RENDERS.load(Ordering::Relaxed),
            layer_presented: self
                .element
                .as_ref()
                .map(|element| element.telemetry().layer_presented)
                .unwrap_or(0),
            load: load_averages(),
        }
    }

    fn move_layer(&mut self, host: Host) {
        let view = match host {
            Host::Docked => self.host_view.clone(),
            Host::Floating => self.floating_view.clone().expect("floating view"),
        };
        self.host = host;
        let radius = self.radius();
        if let Some(element) = self.element.as_mut() {
            element.set_corner_radius(radius);
            element
                .attach(&ViewHost(NonNull::from(&*view).cast()))
                .expect("move the layer");
        }
        tune_video_layer(&view, radius);
    }

    fn finish(&mut self, cx: &mut Context<Self>) {
        let mut report = json!({
            "slice": "plan 260 S0.1",
            "canvas": format!("{}x{}@{}", self.args.width, self.args.height, self.args.fps),
            "phases": self.phases,
            "evidence": self.evidence,
            "mainWindowNumber": self.main_window_number,
        });
        if let Some(element) = self.element.as_ref() {
            if let Some(feed) = element.report_blocking() {
                for line in feed.text() {
                    println!("[s0.1] {line}");
                }
                report["feed"] = feed.json();
            }
            let status = self.runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(5), element.read_compositor_status()).await
            });
            report["compositorStatus"] = match status {
                Ok(Ok(Ok(status))) => serde_json::to_value(status).unwrap_or(Value::Null),
                other => json!(format!("{other:?}")),
            };
            report["telemetry"] = json!(format!("{:?}", element.telemetry()));
        }
        if let Some(element) = self.element.take() {
            element.stop();
        }
        if let Some(supervisor) = self.supervisor.borrow_mut().take() {
            let outcome = self.runtime.block_on(supervisor.stop());
            println!(
                "[s0.1] backend stopped; stray pids {:?}",
                outcome.stray_pids
            );
            report["backendStop"] = json!({
                "strayPids": outcome.stray_pids,
                "report": format!("{:?}", outcome.report),
            });
        }
        if let Some(parent) = self.args.report.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(
            &self.args.report,
            serde_json::to_string_pretty(&report).unwrap_or_default(),
        );
        println!("[s0.1] report written to {}", self.args.report.display());
        cx.quit();
    }
}

impl Render for Studio {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        MAIN_RENDERS.fetch_add(1, Ordering::Relaxed);
        let this = cx.entity().downgrade();
        let docked = self.host == Host::Docked;
        let mut stage = div()
            .relative()
            .w_full()
            .flex_1()
            .rounded(px(SLOT_RADIUS as f32))
            .bg(rgb(0x000000))
            .child(self.preview.clone())
            // The slot's bounds drive the layer in the same frame (the
            // canvas is painted right after the native view's element).
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let geometry = geometry_of(window, bounds, cx);
                        let _ = this
                            .update(cx, |studio, _| studio.place(Host::Docked, bounds, geometry));
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        if !docked {
            stage = stage.child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(rgb(0x8a8a93))
                    .child("The Preview is in its own window"),
            );
        }
        if self.overlay && docked {
            stage = stage.child(editor_overlay());
        }
        div()
            .size_full()
            .flex()
            .bg(rgb(0x0f0f11))
            .text_color(rgb(0xededed))
            .text_sm()
            .child(
                div()
                    .w(px(SIDEBAR))
                    .h_full()
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .border_r_1()
                    .border_color(rgb(0x2a2a2e))
                    .child("Videorc · plan 260 S0.1")
                    .child(div().text_color(rgb(0x8a8a93)).child(format!("Phase: {}", self.phase)))
                    .child(div().text_color(rgb(0x8a8a93)).child(format!(
                        "Canvas {}x{} @ {} fps, test pattern from videorc-backend",
                        self.args.width, self.args.height, self.args.fps
                    )))
                    .child(div().text_color(rgb(0x8a8a93)).child(
                        "Video: videorc-preview's CAMetalLayer in a GPUI NativeView, presented on its own thread",
                    )),
            )
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(44.))
                            .px_4()
                            .flex()
                            .items_center()
                            .border_b_1()
                            .border_color(rgb(0x2a2a2e))
                            .child("Studio"),
                    )
                    .child(div().flex_1().p_4().flex().flex_col().child(stage)),
            )
    }
}

/// The scene editor's chrome over the video: a selected item with eight
/// handles and its label, a top scrim with the scene name, and a pill.
fn editor_overlay() -> impl IntoElement {
    let handle = |x: f32, y: f32| {
        div()
            .absolute()
            .left(px(x - 5.))
            .top(px(y - 5.))
            .w(px(10.))
            .h(px(10.))
            .rounded(px(2.))
            .bg(rgb(0xffffff))
            .border_1()
            .border_color(rgb(0x3b82f6))
    };
    let (x, y, w, h) = (180.0f32, 120.0f32, 480.0f32, 270.0f32);
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .right_0()
                .h(px(40.))
                .px_3()
                .flex()
                .items_center()
                .bg(rgba(0x000000a0))
                .child("Scene: Test pattern · editing"),
        )
        .child(
            div()
                .absolute()
                .left(px(x))
                .top(px(y))
                .w(px(w))
                .h(px(h))
                .border_2()
                .border_color(rgb(0x3b82f6))
                .bg(rgba(0x3b82f626))
                .child(
                    div()
                        .absolute()
                        .left(px(0.))
                        .top(px(-26.))
                        .px_2()
                        .py(px(2.))
                        .rounded(px(4.))
                        .bg(rgb(0x3b82f6))
                        .child("Camera · 1920×1080"),
                ),
        )
        .child(handle(x, y))
        .child(handle(x + w / 2., y))
        .child(handle(x + w, y))
        .child(handle(x, y + h / 2.))
        .child(handle(x + w, y + h / 2.))
        .child(handle(x, y + h))
        .child(handle(x + w / 2., y + h))
        .child(handle(x + w, y + h))
        .child(
            div()
                .absolute()
                .bottom(px(16.))
                .left(px(16.))
                .px_3()
                .py_1()
                .rounded_full()
                .bg(rgba(0x000000b0))
                .child("Live · GPUI text over the native layer"),
        )
}

// ---------------------------------------------------------------------------
// The floating Preview window

struct FloatingPreview {
    preview: NativeView,
    studio: WeakEntity<Studio>,
}

impl Render for FloatingPreview {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        FLOATING_RENDERS.fetch_add(1, Ordering::Relaxed);
        let studio = self.studio.clone();
        div()
            .size_full()
            .relative()
            .bg(rgb(0x000000))
            .child(self.preview.clone())
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let geometry = geometry_of(window, bounds, cx);
                        let _ = studio.update(cx, |studio, _| {
                            studio.place(Host::Floating, bounds, geometry)
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
    }
}

// ---------------------------------------------------------------------------
// The scripted run

async fn wait(cx: &mut AsyncApp, seconds: f64) {
    cx.background_executor()
        .timer(Duration::from_secs_f64(seconds.max(0.0)))
        .await;
}

async fn set_phase(
    this: &WeakEntity<Studio>,
    cx: &mut AsyncApp,
    phase: &str,
    overlay: bool,
) -> Result<Mark> {
    let phase = phase.to_string();
    let mark = this.update(cx, |studio, cx| {
        studio.phase = phase;
        studio.overlay = overlay;
        cx.notify();
        studio.mark()
    })?;
    Ok(mark)
}

async fn end_phase(
    this: &WeakEntity<Studio>,
    cx: &mut AsyncApp,
    name: &str,
    note: &str,
    start: Mark,
) -> Result<()> {
    let (name, note) = (name.to_string(), note.to_string());
    this.update(cx, |studio, _| {
        let end = studio.mark();
        let value = phase_json(&name, &note, &start, &end);
        studio.phases.push(value);
    })?;
    Ok(())
}

async fn run_script(this: WeakEntity<Studio>, cx: &mut AsyncApp) -> Result<()> {
    let args = this.update(cx, |studio, _| studio.args.clone())?;
    // The first frame.
    let started = Instant::now();
    loop {
        let presented = this.update(cx, |studio, _| {
            studio
                .element
                .as_ref()
                .map(|e| e.telemetry().layer_presented)
                .unwrap_or(0)
        })?;
        if presented > 0 {
            let since_start = PROCESS_START
                .get()
                .map(|t| t.elapsed().as_secs_f64())
                .unwrap_or(0.0);
            println!("[s0.1] first frame presented {since_start:.2} s after process start");
            this.update(cx, |studio, _| {
                studio
                    .evidence
                    .push(json!({"firstFrameSinceProcessStartSeconds": since_start}))
            })?;
            break;
        }
        if started.elapsed() > Duration::from_secs(60) {
            bail!("no frame presented within 60 s");
        }
        wait(cx, 0.25).await;
    }
    this.update(cx, |studio, _| {
        studio
            .evidence
            .push(json!({"firstFrameSeconds": started.elapsed().as_secs_f64()}))
    })?;
    wait(cx, 5.0).await;

    // 1. Live, docked, the editor overlay on: the 10-minute pass line.
    let mark = set_phase(&this, cx, "live 4K60, docked, editor overlay on", true).await?;
    wait(cx, 1.0).await; // the phase's own redraw settles before the clock starts
    let mark = Mark {
        ..this.update(cx, |s, _| s.mark())?
    }
    .with_load_of(&mark);
    wait(cx, args.live).await;
    end_phase(
        &this,
        cx,
        "live-overlay-on",
        "docked, 4K60 live, editor overlay painted over the video",
        mark,
    )
    .await?;
    // The feed's numbers for the live phase (the run's records so far).
    this.update(cx, |studio, _| {
        if let Some(feed) = studio.element.as_ref().and_then(|e| e.report_blocking()) {
            for line in feed.text() {
                println!("[s0.1] live: {line}");
            }
            studio.evidence.push(json!({"liveFeed": feed.json()}));
        }
    })?;

    // 2. Live, overlay off (the comparison).
    if args.live_compare > 0.0 {
        set_phase(&this, cx, "live 4K60, docked, editor overlay off", false).await?;
        wait(cx, 1.0).await;
        let mark = this.update(cx, |s, _| s.mark())?;
        wait(cx, args.live_compare).await;
        end_phase(
            &this,
            cx,
            "live-overlay-off",
            "docked, 4K60 live, no overlay",
            mark,
        )
        .await?;
    }

    // 2b. A/B: overlay off and on, back to back, `--ab` cycles of
    // `--live-compare` seconds each, so the live cost of the overlay is read
    // under the same load.
    for cycle in 0..args.ab {
        for overlay in [false, true] {
            let name = format!(
                "ab-{}-overlay-{}",
                cycle + 1,
                if overlay { "on" } else { "off" }
            );
            set_phase(
                &this,
                cx,
                &format!("A/B live, overlay {}", if overlay { "on" } else { "off" }),
                overlay,
            )
            .await?;
            wait(cx, 1.0).await;
            let mark = this.update(cx, |s, _| s.mark())?;
            wait(cx, args.live_compare).await;
            end_phase(&this, cx, &name, "A/B, docked, 4K60 live", mark).await?;
        }
    }

    // 3 and 4. Still frame: the surface suspended, the layer keeps its last
    // frame; overlay off, then on (the overlay's idle cost).
    if args.still > 0.0 {
        this.update(cx, |studio, _| {
            if let Some(element) = studio.element.as_ref() {
                element.suspend(true);
            }
        })?;
        set_phase(&this, cx, "still frame, editor overlay off", false).await?;
        wait(cx, 3.0).await;
        let mark = this.update(cx, |s, _| s.mark())?;
        wait(cx, args.still).await;
        end_phase(
            &this,
            cx,
            "still-overlay-off",
            "surface suspended, last frame on the layer, idle UI",
            mark,
        )
        .await?;

        set_phase(&this, cx, "still frame, editor overlay on", true).await?;
        wait(cx, 3.0).await;
        let mark = this.update(cx, |s, _| s.mark())?;
        wait(cx, args.still).await;
        end_phase(
            &this,
            cx,
            "still-overlay-on",
            "surface suspended, last frame on the layer, editor overlay painted, idle UI",
            mark,
        )
        .await?;

        this.update(cx, |studio, _| {
            if let Some(element) = studio.element.as_ref() {
                element.suspend(false);
            }
        })?;
        let resumed = Instant::now();
        loop {
            wait(cx, 0.1).await;
            let ok = this.update(cx, |s, _| {
                s.element
                    .as_ref()
                    .is_some_and(|e| e.presented_within(Duration::from_millis(100)))
            })?;
            if ok || resumed.elapsed() > Duration::from_secs(60) {
                let secs = resumed.elapsed().as_secs_f64();
                println!("[s0.1] presenting again {secs:.2} s after the resume (ok {ok})");
                this.update(cx, |s, _| {
                    s.evidence
                        .push(json!({"resumeToPresentingSeconds": secs, "resumed": ok}))
                })?;
                break;
            }
        }
        wait(cx, 3.0).await;
    }

    // 5. Evidence: the docked window, live, overlay on.
    set_phase(&this, cx, "evidence: docked, live, overlay on", true).await?;
    wait(cx, 2.0).await;
    if let Some(dir) = args.shots.clone() {
        let number = this.update(cx, |s, _| s.main_window_number)?;
        let window_shot = dir.join("gpui-s0-1-docked-overlay.png");
        let full_shot = dir.join("gpui-s0-1-docked-overlay-fullscreen.png");
        let w = capture(&[
            "-x",
            "-o",
            "-l",
            &number.to_string(),
            window_shot.to_str().unwrap(),
        ]);
        let f = capture(&["-x", full_shot.to_str().unwrap()]);
        this.update(cx, |s, _| s.evidence.push(json!({"dockedShots": [w, f]})))?;
    }

    // 6. The floating Preview window: the layer moves into it (no surface
    // restart), it is kept out of screen capture, live for a while.
    if args.floating > 0.0 {
        let studio_weak = this.clone();
        let floating = cx.update(|cx| {
            let bounds = Bounds::new(point(px(80.), px(80.)), size(px(960.), px(540.)));
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    kind: WindowKind::Floating,
                    ..Default::default()
                },
                move |window, cx| {
                    let mtm = MainThreadMarker::new().expect("main thread");
                    let view = make_host_view(mtm);
                    // SAFETY: a live NSView in no hierarchy; GPUI retains it.
                    let preview = unsafe {
                        NativeView::new(NonNull::from(&*view).cast(), window, cx)
                            .expect("native view")
                    };
                    preview.set_background(rgb(0x000000), cx);
                    let ns_window = ns_window_of(window).expect("NSWindow");
                    // Hide from stream: NSWindowSharingNone.
                    let _: () = unsafe { msg_send![ns_window, setSharingType: 0usize] };
                    let _: () = unsafe { msg_send![ns_window, setLevel: 3isize] };
                    let sharing: usize = unsafe { msg_send![ns_window, sharingType] };
                    let number = window_number(ns_window);
                    println!("[s0.1] floating window number {number}, sharingType {sharing}");
                    let _ = studio_weak.update(cx, |studio, _| {
                        studio.floating_view = Some(view);
                        studio.evidence.push(json!({
                            "floatingWindowNumber": number,
                            "floatingSharingTypeReadBack": sharing,
                        }));
                    });
                    cx.new(|_| FloatingPreview {
                        preview,
                        studio: studio_weak.clone(),
                    })
                },
            )
        })?;
        this.update(cx, |studio, cx| {
            studio.floating = Some(floating);
            studio.move_layer(Host::Floating);
            cx.notify();
        })?;
        set_phase(&this, cx, "floating Preview window, live", false).await?;
        wait(cx, 3.0).await;
        let mark = this.update(cx, |s, _| s.mark())?;
        wait(cx, args.floating).await;
        end_phase(
            &this,
            cx,
            "floating-live",
            "layer moved into the floating Preview window (sharingType none), 4K60 live",
            mark,
        )
        .await?;
        if let Some(dir) = args.shots.clone() {
            let number = this.update(cx, |s, _| {
                s.evidence
                    .iter()
                    .find_map(|v| v.get("floatingWindowNumber").and_then(Value::as_i64))
                    .unwrap_or(0)
            })?;
            let window_shot = dir.join("gpui-s0-1-floating-window-capture.png");
            let full_shot = dir.join("gpui-s0-1-floating-fullscreen.png");
            let w = capture(&[
                "-x",
                "-o",
                "-l",
                &number.to_string(),
                window_shot.to_str().unwrap(),
            ]);
            let f = capture(&["-x", full_shot.to_str().unwrap()]);
            this.update(cx, |s, _| s.evidence.push(json!({"floatingShots": [w, f]})))?;
            // Proof the floating window shows video: share it read-only for one
            // shot, then hide it from capture again.
            let visible_shot = dir.join("gpui-s0-1-floating-shared-for-proof-fullscreen.png");
            let floating = this.update(cx, |s, _| s.floating.clone())?;
            if let Some(floating) = floating {
                let _ = floating.update(cx, |_, window, _| {
                    if let Some(w) = ns_window_of(window) {
                        let _: () = unsafe { msg_send![w, setSharingType: 1usize] };
                    }
                });
                wait(cx, 0.5).await;
                let v = capture(&["-x", visible_shot.to_str().unwrap()]);
                let _ = floating.update(cx, |_, window, _| {
                    if let Some(w) = ns_window_of(window) {
                        let _: () = unsafe { msg_send![w, setSharingType: 0usize] };
                    }
                });
                this.update(cx, |s, _| {
                    s.evidence.push(json!({"floatingSharedProofShot": v}))
                })?;
            }
        }
        // Dock again and close the floating window.
        this.update(cx, |studio, cx| {
            studio.move_layer(Host::Docked);
            cx.notify();
        })?;
        let floating = this.update(cx, |studio, _| studio.floating.take())?;
        if let Some(floating) = floating {
            let _ = floating.update(cx, |_, window, _| window.remove_window());
        }
        this.update(cx, |studio, _| studio.floating_view = None)?;
        set_phase(&this, cx, "docked again, live", true).await?;
        wait(cx, 3.0).await;
        let docked_again = this.update(cx, |s, _| {
            s.element
                .as_ref()
                .map(|e| e.presented_within(Duration::from_millis(500)))
        })?;
        this.update(cx, |s, _| {
            s.evidence
                .push(json!({"dockedAgainPresenting": docked_again}))
        })?;
        println!("[s0.1] docked again, presenting: {docked_again:?}");
    }
    Ok(())
}

impl Mark {
    /// Keeps `self`'s counters but the load averages of `other` (the phase's
    /// own start).
    fn with_load_of(mut self, other: &Mark) -> Mark {
        self.load = other.load;
        self
    }
}

// ---------------------------------------------------------------------------

fn main() -> Result<()> {
    PROCESS_START.get_or_init(Instant::now);
    let args = parse_args()?;
    std::fs::create_dir_all(&args.profile)?;
    let paths = AppPaths::profile(args.profile.clone());
    let logger = Logger::new(None, true);
    let mut launch = BackendLaunch::binary(
        args.backend.clone(),
        &args.workspace,
        paths.user_data_dir.clone(),
    );
    launch.isolation = paths.isolation;
    launch.app_version = Some("0.37.1".to_string());
    launch.path_prepend = vec![videorc_app_core::paths::cargo_bin_dir()];
    let stderr_logger = logger.clone();
    launch.stderr_sink = Some(Arc::new(move |line: &str| {
        stderr_logger.log(Level::infer(line), line);
    }));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .thread_name("videorc-core")
        .build()
        .context("tokio runtime")?;
    let handle = runtime.handle().clone();
    let supervisor = {
        let _enter = runtime.enter();
        Supervisor::start(SupervisorConfig {
            launch,
            paths: paths.clone(),
            workspace_root: args.workspace.clone(),
            logger: logger.clone(),
            stop_grace: Duration::from_secs(5),
        })
    };
    let state = supervisor.state();
    println!(
        "[s0.1] pid {} · profile {}",
        std::process::id(),
        args.profile.display()
    );
    let supervisor = Rc::new(RefCell::new(Some(supervisor)));
    // The element's blocking helpers build Tokio timers on the UI thread.
    let _enter = runtime.enter();

    gpui_platform::application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1480.), px(860.)), cx);
        let (args, handle, supervisor, state, logger) = (
            args.clone(),
            handle.clone(),
            supervisor.clone(),
            state.clone(),
            logger.clone(),
        );
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            move |window, cx| {
                cx.new(|cx| Studio::new(args, handle, supervisor, state, logger, window, cx))
            },
        )
        .expect("open window");
        cx.activate(true);
    });
    drop(_enter);
    drop(runtime);
    Ok(())
}
