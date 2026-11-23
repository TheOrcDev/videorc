//! Plan 260 spike S0.0, the model for every other spike.
//!
//! Question: can a GPUI window host the Videorc preview as a native video
//! layer that presents on its own thread (no GPUI frame per video frame),
//! with GPUI UI painted over the video?
//!
//! - macOS: a `CAMetalLayer` in an `NSView`, placed in the layout through
//!   GPUI's `NativeView`. A plain thread clears each drawable to a colour that
//!   cycles over time and presents it, as `videorc-preview`'s presenter does.
//! - Windows and Linux: GPUI has no native view there yet (that is WC-0.2 on
//!   Windows and S0.3 on Linux), so the pane is a colour GPUI itself repaints
//!   once a second. The frame, the overlays, the arguments and the summary are
//!   the same, so this build is what WC-0.1 (`spike-hello`) starts from.
//!
//! Over the video GPUI paints a translucent bordered box (an editor handle)
//! and a translucent pill with text. The spike closes itself after
//! `--seconds`, prints `[spike] summary <json>` and writes summary.json.

use gpui::{
    App, Bounds, Context, TitlebarOptions, Window, WindowBounds, WindowOptions, div, prelude::*,
    px, rgb, rgba, size,
};
use spike_summary::{Run, percentile, round};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

const SPIKE: &str = "spike-native-preview";

static RENDERS: AtomicU64 = AtomicU64::new(0);
/// Startup to the first frame after the first render, in microseconds (0 = not yet).
static FIRST_PAINT_US: AtomicU64 = AtomicU64::new(0);

/// What the presenter thread measured.
#[derive(Default)]
struct PresentStats {
    presents: u64,
    intervals_ms: Vec<f64>,
    drawable_px: Option<(u64, u64)>,
}

#[cfg(target_os = "macos")]
mod native {
    //! The macOS video layer and its presenter thread.

    use super::PresentStats;
    use gpui::{App, NativeView, Window};
    use objc2::{MainThreadMarker, MainThreadOnly, rc::Retained};
    use objc2_app_kit::NSView;
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use objc2_metal::{
        MTLClearColor, MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue,
        MTLCreateSystemDefaultDevice, MTLDevice, MTLLoadAction, MTLPixelFormat,
        MTLRenderPassDescriptor, MTLStoreAction, MTLTexture,
    };
    use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};
    use std::{
        ptr::NonNull,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        time::Instant,
    };

    struct SendLayer(Retained<CAMetalLayer>);
    // The layer is only touched by the presenter thread after hand-over;
    // CAMetalLayer's nextDrawable is documented as thread-safe.
    unsafe impl Send for SendLayer {}

    fn start_presenter(layer: SendLayer, stop: Arc<AtomicBool>, stats: Arc<Mutex<PresentStats>>) {
        std::thread::Builder::new()
            .name("presenter".into())
            .spawn(move || {
                let layer = layer;
                let Some(device) = layer.0.device() else {
                    spike_summary::error("the CAMetalLayer has no device");
                    return;
                };
                let Some(queue) = device.newCommandQueue() else {
                    spike_summary::error("no Metal command queue");
                    return;
                };
                let start = Instant::now();
                let mut last: Option<Instant> = None;
                while !stop.load(Ordering::Relaxed) {
                    objc2::rc::autoreleasepool(|_| {
                        // Follow the layout: GPUI sizes the NSView, and the
                        // layer's bounds follow it, but its drawable does not.
                        let bounds = layer.0.bounds();
                        let scale = layer.0.contentsScale();
                        let want = NSSize::new(
                            (bounds.size.width * scale).round().max(1.0),
                            (bounds.size.height * scale).round().max(1.0),
                        );
                        let have = layer.0.drawableSize();
                        if have.width != want.width || have.height != want.height {
                            layer.0.setDrawableSize(want);
                        }
                        // Blocks until a drawable is free: this paces the
                        // thread to the display, as the real presenter is.
                        let Some(drawable) = layer.0.nextDrawable() else {
                            return;
                        };
                        let texture = drawable.texture();
                        let t = start.elapsed().as_secs_f64();
                        let rpd = MTLRenderPassDescriptor::new();
                        let ca = unsafe { rpd.colorAttachments().objectAtIndexedSubscript(0) };
                        ca.setTexture(Some(&texture));
                        ca.setLoadAction(MTLLoadAction::Clear);
                        ca.setStoreAction(MTLStoreAction::Store);
                        ca.setClearColor(MTLClearColor {
                            red: 0.5 + 0.5 * (t * 1.3).sin(),
                            green: 0.5 + 0.5 * (t * 0.7 + 2.0).sin(),
                            blue: 0.5 + 0.5 * (t * 0.9 + 4.0).sin(),
                            alpha: 1.0,
                        });
                        let Some(cb) = queue.commandBuffer() else {
                            return;
                        };
                        let Some(enc) = cb.renderCommandEncoderWithDescriptor(&rpd) else {
                            return;
                        };
                        enc.endEncoding();
                        cb.presentDrawable(objc2::runtime::ProtocolObject::from_ref(&*drawable));
                        cb.commit();
                        let now = Instant::now();
                        if let Ok(mut s) = stats.lock() {
                            s.presents += 1;
                            if let Some(prev) = last {
                                s.intervals_ms.push((now - prev).as_secs_f64() * 1000.0);
                            }
                            s.drawable_px = Some((texture.width() as u64, texture.height() as u64));
                        }
                        last = Some(now);
                    });
                }
            })
            .expect("spawn presenter thread");
    }

    /// Builds the layer-hosting NSView, wraps it in a `NativeView` and starts
    /// the presenter. `None` (with an error reported) when any step fails.
    pub fn preview(
        window: &mut Window,
        cx: &mut App,
        stop: Arc<AtomicBool>,
        stats: Arc<Mutex<PresentStats>>,
    ) -> Option<NativeView> {
        let mtm = MainThreadMarker::new()?;
        let Some(device) = MTLCreateSystemDefaultDevice() else {
            spike_summary::error("no Metal device");
            return None;
        };
        let layer = CAMetalLayer::new();
        layer.setDevice(Some(&device));
        layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
        layer.setFramebufferOnly(true);
        layer.setOpaque(true);
        layer.setContentsScale(window.scale_factor() as f64);
        let view = NSView::initWithFrame(
            NSView::alloc(mtm),
            NSRect::new(NSPoint::new(0., 0.), NSSize::new(800., 450.)),
        );
        // A layer-hosting view: set the layer first, then wantsLayer.
        view.setLayer(Some(&layer));
        view.setWantsLayer(true);
        // GPUI retains the view; keep ours alive for the whole run too.
        let preview = match unsafe { NativeView::new(NonNull::from(&*view).cast(), window, cx) } {
            Ok(v) => v,
            Err(e) => {
                spike_summary::error(format!("NativeView::new failed: {e:#}"));
                return None;
            }
        };
        std::mem::forget(view);
        start_presenter(SendLayer(layer), stop, stats);
        Some(preview)
    }
}

struct Spike {
    #[cfg(target_os = "macos")]
    preview: Option<gpui::NativeView>,
    /// Seconds since start, for the GPUI-painted pane on Windows and Linux.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    tick: u64,
}

impl Spike {
    fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        stop: Arc<AtomicBool>,
        stats: Arc<Mutex<PresentStats>>,
    ) -> Self {
        #[cfg(target_os = "macos")]
        {
            let preview = native::preview(window, cx, stop, stats);
            Self { preview, tick: 0 }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (window, stop, stats);
            // No native view here: GPUI repaints the pane once a second.
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    let alive = this
                        .update(cx, |spike, cx| {
                            spike.tick += 1;
                            cx.notify();
                        })
                        .is_ok();
                    if !alive {
                        break;
                    }
                }
            })
            .detach();
            Self { tick: 0 }
        }
    }

    fn video(&self) -> gpui::AnyElement {
        #[cfg(target_os = "macos")]
        if let Some(preview) = &self.preview {
            return preview.clone().into_any_element();
        }
        // A colour that steps once a second (the same palette as the macOS layer).
        let t = self.tick as f64;
        let c = |phase: f64, speed: f64| ((0.5 + 0.5 * (t * speed + phase).sin()) * 255.0) as u32;
        let color = (c(0.0, 1.3) << 16) | (c(2.0, 0.7) << 8) | c(4.0, 0.9);
        div().size_full().bg(rgb(color)).into_any_element()
    }

    fn route(&self) -> &'static str {
        #[cfg(target_os = "macos")]
        if self.preview.is_some() {
            return "CAMetalLayer in an NSView via NativeView, presented on its own thread";
        }
        "No native view on this platform yet: GPUI paints this colour once a second"
    }
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let n = RENDERS.fetch_add(1, Ordering::Relaxed) + 1;
        if n == 1 {
            window.on_next_frame(|_, _| {
                let us = (spike_summary::elapsed_ms() * 1000.0) as u64;
                FIRST_PAINT_US.store(us.max(1), Ordering::Relaxed);
            });
        }
        div()
            .size_full()
            .flex()
            .bg(rgb(0x0f0f11))
            .text_color(rgb(0xededed))
            .child(
                div()
                    .w(px(280.))
                    .h_full()
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .border_r_1()
                    .border_color(rgb(0x2a2a2e))
                    .child("GPUI sidebar")
                    .child(format!("GPUI renders so far: {n}"))
                    .child(format!("Video: {}", self.route())),
            )
            .child(
                div().flex_1().h_full().p_6().child(
                    div()
                        .relative()
                        .size_full()
                        .child(self.video())
                        .child(
                            div()
                                .absolute()
                                .top(px(120.))
                                .left(px(160.))
                                .w(px(480.))
                                .h(px(270.))
                                .border_2()
                                .border_color(rgb(0x3b82f6))
                                .bg(rgba(0x3b82f640))
                                .rounded_md()
                                .p_2()
                                .child("GPUI element painted over the video (editor handle)"),
                        )
                        .child(
                            div()
                                .absolute()
                                .bottom(px(16.))
                                .left(px(16.))
                                .px_3()
                                .py_1()
                                .rounded_full()
                                .bg(rgba(0x000000b0))
                                .child("Live · GPUI text over the video"),
                        ),
                ),
            )
    }
}

fn main() {
    let run = Run::start(SPIKE);
    let seconds = run.args.seconds;
    let stop = Arc::new(AtomicBool::new(false));
    let stats = Arc::new(Mutex::new(PresentStats::default()));
    let run = Arc::new(Mutex::new(run));

    gpui_platform::application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1650.), px(962.)), cx);
        let (stop2, stats2) = (stop.clone(), stats.clone());
        let opened = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(SPIKE.into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            move |window, cx| cx.new(|cx| Spike::new(window, cx, stop2, stats2)),
        );
        if let Err(e) = opened {
            spike_summary::error(format!("open_window failed: {e:#}"));
            run.lock().expect("run").finish();
        }
        cx.activate(true);

        let (stop3, stats3, run3) = (stop.clone(), stats.clone(), run.clone());
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_secs(seconds))
                .await;
            stop3.store(true, Ordering::Relaxed);
            // Let the presenter's last frame finish before reading its stats.
            cx.background_executor()
                .timer(Duration::from_millis(100))
                .await;
            let mut run = run3.lock().expect("run");
            let elapsed_s = spike_summary::elapsed_ms() / 1000.0;
            let renders = RENDERS.load(Ordering::Relaxed);
            run.set("renders", renders);
            run.set(
                "ui_redraws_per_second_idle",
                round(renders as f64 / elapsed_s.max(0.001), 2),
            );
            let first_paint_us = FIRST_PAINT_US.load(Ordering::Relaxed);
            if first_paint_us > 0 {
                run.set(
                    "startup_to_first_paint_ms",
                    round(first_paint_us as f64 / 1000.0, 1),
                );
            }
            let stats = stats3.lock().expect("stats");
            run.set(
                "native_view",
                cfg!(target_os = "macos") && stats.presents > 0,
            );
            if stats.presents > 0 {
                run.set("presents", stats.presents);
                run.set(
                    "presents_per_second",
                    round(stats.presents as f64 / elapsed_s.max(0.001), 1),
                );
                if let Some(p95) = percentile(&stats.intervals_ms, 95.0) {
                    run.set("present_interval_p95_ms", round(p95, 2));
                }
                if let Some((w, h)) = stats.drawable_px {
                    run.set("drawable_px", format!("{w}x{h}"));
                }
                // The presenter clears GPU textures; no frame touches the CPU.
                run.set("cpu_copies_per_frame", 0);
            }
            #[cfg(target_os = "macos")]
            if stats.presents == 0 {
                spike_summary::error("the presenter never presented a frame");
            }
            drop(stats);
            run.finish();
        })
        .detach();
    });
}
