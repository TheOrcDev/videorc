//! Plan 260 spike WC-0.2 (route (a) on Windows), checked by the Windows
//! testing plan's S0.2a.
//!
//! Question: can a GPUI window on Windows show video as a native view, a
//! DirectComposition visual beneath GPUI's own, laid out by a GPUI element,
//! presented by a thread of its own, with GPUI drawing over it and not
//! redrawing per video frame?
//!
//! spike-hello's frame, with the pane's colour replaced by `gpui::NativeView`
//! (the patched `gpui-pre-windows`, `../patches/gpui-pre-windows`). The view's
//! content is a swap chain from `IDXGIFactory2::CreateSwapChainForComposition`
//! on the spike's own D3D11 device. A plain thread (`presenter`) waits for the
//! swap chain's frame-latency object, keeps its buffers at the size GPUI laid
//! the view out at, clears them to a colour that changes over time, and
//! presents with vsync, as the backend's presenter does.
//!
//! Over the video GPUI draws a translucent bordered box (an editor handle), an
//! opaque square and a translucent pill. A magenta box is painted *before*
//! the view, under it: seeing it means the renderer did not erase what was
//! drawn before the view. GPUI has no timer, so it renders only at startup and
//! when the layout changes. `--layout-test` moves and resizes the view every
//! two seconds.
//!
//! The spike closes itself after `--seconds`, prints `[spike] summary <json>`
//! and writes summary.json (`../SUMMARY.md`).

use gpui::{
    AnyElement, App, Bounds, Context, TitlebarOptions, Window, WindowBounds, WindowOptions, div,
    prelude::*, px, rgb, rgba, size,
};
use spike_summary::{Run, percentile, round};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

const SPIKE: &str = "spike-native-view-windows";

/// The sidebar's width in logical pixels, and its width in `--layout-test`'s
/// other step.
const SIDEBAR_PX: [f32; 2] = [280., 400.];
/// The padding around the video, in logical pixels, per layout step.
const PANE_PADDING_PX: [f32; 2] = [24., 64.];
/// The window's logical size, spike-hello's: it fits 1920 × 1080 at 150 %.
const WINDOW_SIZE: (f32, f32) = (1100., 640.);
/// The video's corner radius in logical pixels.
const CORNER_RADIUS_PX: f32 = 10.;
/// What shows where the video has not caught up with a resize yet.
const VIDEO_BACKGROUND: u32 = 0x1b1b1f;

static RENDERS: AtomicU64 = AtomicU64::new(0);
/// Startup to the first frame after the first render, in microseconds (0 = not yet).
static FIRST_PAINT_US: AtomicU64 = AtomicU64::new(0);
/// Startup to `open_window`, in microseconds (0 = not yet).
static OPEN_WINDOW_US: AtomicU64 = AtomicU64::new(0);

/// What the presenter thread measured.
#[derive(Default)]
struct PresentStats {
    presents: u64,
    intervals_ms: Vec<f64>,
    drawable_px: Option<(u32, u32)>,
    /// Times the presenter resized its buffers to follow the layout.
    resizes: u64,
    /// Waits for a free buffer that took over a second (a hidden window).
    waits_timed_out: u64,
}

/// What the window looked like, as `render` last saw it.
#[derive(Default)]
struct WindowStats {
    scale_factor: Option<f32>,
    viewport_px: Option<(f32, f32)>,
    viewport_changes: u64,
}

#[cfg(target_os = "windows")]
mod native {
    //! The video's swap chain, its presenter thread, and the native view.

    use super::{CORNER_RADIUS_PX, PresentStats, VIDEO_BACKGROUND};
    use gpui::{App, NativeView, Window, rgb};
    use gpui_windows::{NativeVisual, NativeVisualSize};
    use std::{
        ptr::NonNull,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        time::Instant,
    };
    use windows::{
        Win32::{
            Foundation::{HANDLE, HMODULE, HWND, WAIT_OBJECT_0},
            Graphics::{
                Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0},
                Direct3D11::*,
                Dwm::{DWM_TIMING_INFO, DwmGetCompositionTimingInfo},
                Dxgi::{Common::*, *},
            },
            System::Threading::WaitForSingleObjectEx,
        },
        core::{IUnknown, Interface},
    };

    /// The size the swap chain starts at, before GPUI lays the view out.
    const FIRST_SIZE: (u32, u32) = (640, 360);
    const SWAP_CHAIN_FLAGS: DXGI_SWAP_CHAIN_FLAG =
        DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;

    struct Presenter {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        swap_chain: IDXGISwapChain2,
        frame_ready: HANDLE,
    }

    // SAFETY: after `preview` hands the presenter to its thread, only that
    // thread uses the device, its immediate context and the swap chain. GPUI
    // holds its own reference to the swap chain, but only as composition
    // content, which DirectComposition reads safely while another thread
    // presents.
    unsafe impl Send for Presenter {}

    fn create_presenter() -> windows::core::Result<Presenter> {
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
            let device = device.ok_or_else(windows::core::Error::empty)?;
            let context = context.ok_or_else(windows::core::Error::empty)?;
            let factory: IDXGIFactory2 = device.cast::<IDXGIDevice>()?.GetAdapter()?.GetParent()?;
            let desc = DXGI_SWAP_CHAIN_DESC1 {
                Width: FIRST_SIZE.0,
                Height: FIRST_SIZE.1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                Stereo: false.into(),
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                BufferCount: 2,
                // The only scaling a composition swap chain takes; the
                // presenter keeps its buffers at the laid-out size instead.
                Scaling: DXGI_SCALING_STRETCH,
                SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                AlphaMode: DXGI_ALPHA_MODE_IGNORE,
                Flags: SWAP_CHAIN_FLAGS.0 as u32,
            };
            let swap_chain: IDXGISwapChain2 = factory
                .CreateSwapChainForComposition(&device, &desc, None)?
                .cast()?;
            swap_chain.SetMaximumFrameLatency(1)?;
            let frame_ready = swap_chain.GetFrameLatencyWaitableObject();
            Ok(Presenter {
                device,
                context,
                swap_chain,
                frame_ready,
            })
        }
    }

    fn present_until_stopped(
        presenter: Presenter,
        size: Arc<NativeVisualSize>,
        stop: Arc<AtomicBool>,
        stats: Arc<Mutex<PresentStats>>,
    ) -> windows::core::Result<()> {
        let Presenter {
            device,
            context,
            swap_chain,
            frame_ready,
        } = presenter;
        let start = Instant::now();
        let mut last: Option<Instant> = None;
        let mut current = FIRST_SIZE;
        let mut target: Option<ID3D11RenderTargetView> = None;
        while !stop.load(Ordering::Relaxed) {
            // Blocks until the compositor has taken the last frame: this
            // paces the thread to the display.
            if unsafe { WaitForSingleObjectEx(frame_ready, 1000, true) } != WAIT_OBJECT_0 {
                if let Ok(mut s) = stats.lock() {
                    s.waits_timed_out += 1;
                }
                continue;
            }
            if let Some(laid_out) = size.laid_out()
                && laid_out != current
            {
                target = None;
                unsafe {
                    context.OMSetRenderTargets(None, None);
                    context.Flush();
                    swap_chain.ResizeBuffers(
                        0,
                        laid_out.0,
                        laid_out.1,
                        DXGI_FORMAT_UNKNOWN,
                        SWAP_CHAIN_FLAGS,
                    )?;
                }
                current = laid_out;
                if let Ok(mut s) = stats.lock() {
                    s.resizes += 1;
                }
            }
            if target.is_none() {
                let buffer: ID3D11Texture2D = unsafe { swap_chain.GetBuffer(0) }?;
                unsafe { device.CreateRenderTargetView(&buffer, None, Some(&mut target)) }?;
            }
            let t = start.elapsed().as_secs_f64();
            let color = [
                (0.5 + 0.5 * (t * 1.3).sin()) as f32,
                (0.5 + 0.5 * (t * 0.7 + 2.0).sin()) as f32,
                (0.5 + 0.5 * (t * 0.9 + 4.0).sin()) as f32,
                1.0,
            ];
            if let Some(target) = &target {
                unsafe { context.ClearRenderTargetView(target, &color) };
            }
            unsafe { swap_chain.Present(1, DXGI_PRESENT(0)) }.ok()?;
            let now = Instant::now();
            if let Ok(mut s) = stats.lock() {
                s.presents += 1;
                if let Some(prev) = last {
                    s.intervals_ms.push((now - prev).as_secs_f64() * 1000.0);
                }
                s.drawable_px = Some(current);
            }
            last = Some(now);
        }
        Ok(())
    }

    /// Builds the swap chain, wraps it in a `NativeView` and starts the
    /// presenter. `None` (with an error reported) when any step fails.
    pub fn preview(
        window: &mut Window,
        cx: &mut App,
        stop: Arc<AtomicBool>,
        stats: Arc<Mutex<PresentStats>>,
    ) -> Option<NativeView> {
        let presenter = match create_presenter() {
            Ok(presenter) => presenter,
            Err(e) => {
                spike_summary::error(format!("creating the composition swap chain failed: {e}"));
                return None;
            }
        };
        let size = Arc::new(NativeVisualSize::default());
        let content: IUnknown = match presenter.swap_chain.cast() {
            Ok(content) => content,
            Err(e) => {
                spike_summary::error(format!("the swap chain has no IUnknown: {e}"));
                return None;
            }
        };
        let visual = NativeVisual {
            content,
            corner_radius: CORNER_RADIUS_PX,
            size: size.clone(),
        };
        // SAFETY: on Windows `view` points to a `NativeVisual`, which lives
        // until `new` returns; GPUI keeps its own references.
        let view = match unsafe { NativeView::new(NonNull::from(&visual).cast(), window, cx) } {
            Ok(view) => view,
            Err(e) => {
                spike_summary::error(format!("NativeView::new failed: {e:#}"));
                return None;
            }
        };
        view.set_background(rgb(VIDEO_BACKGROUND), cx);
        let spawned = std::thread::Builder::new()
            .name("presenter".into())
            .spawn(move || {
                if let Err(e) = present_until_stopped(presenter, size, stop, stats) {
                    spike_summary::error(format!("the presenter stopped: {e}"));
                }
            });
        if let Err(e) = spawned {
            spike_summary::error(format!("spawning the presenter thread failed: {e}"));
            return None;
        }
        Some(view)
    }

    /// The display's refresh rate as the desktop compositor reports it.
    pub fn display_hz() -> Option<f64> {
        let mut info = DWM_TIMING_INFO {
            cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
            ..Default::default()
        };
        unsafe { DwmGetCompositionTimingInfo(HWND::default(), &mut info) }.ok()?;
        let rate = info.rateRefresh;
        (rate.uiDenominator != 0)
            .then(|| f64::from(rate.uiNumerator) / f64::from(rate.uiDenominator))
    }
}

struct Spike {
    #[cfg(target_os = "windows")]
    preview: Option<gpui::NativeView>,
    /// `--layout-test`'s step: which sidebar width and padding the frame has.
    layout_step: usize,
    stats: Arc<Mutex<WindowStats>>,
}

impl Spike {
    fn new(
        window: &mut Window,
        cx: &mut Context<Self>,
        stop: Arc<AtomicBool>,
        present_stats: Arc<Mutex<PresentStats>>,
        stats: Arc<Mutex<WindowStats>>,
        layout_test: bool,
    ) -> Self {
        if layout_test {
            // Moves and resizes the view every two seconds: the only thing,
            // in this mode, that asks GPUI for a new frame.
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(2)).await;
                    let alive = this
                        .update(cx, |spike, cx| {
                            spike.layout_step += 1;
                            cx.notify();
                        })
                        .is_ok();
                    if !alive {
                        break;
                    }
                }
            })
            .detach();
        }
        #[cfg(target_os = "windows")]
        {
            let preview = native::preview(window, cx, stop, present_stats);
            Self {
                preview,
                layout_step: 0,
                stats,
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (window, stop, present_stats);
            spike_summary::error("this spike is Windows only (plan 260 WC-0.2)");
            Self {
                layout_step: 0,
                stats,
            }
        }
    }

    fn video(&self) -> AnyElement {
        #[cfg(target_os = "windows")]
        if let Some(preview) = &self.preview {
            return preview.clone().into_any_element();
        }
        div()
            .size_full()
            .bg(rgb(VIDEO_BACKGROUND))
            .p_4()
            .child("No native view: see the summary's errors")
            .into_any_element()
    }

    fn route(&self) -> &'static str {
        #[cfg(target_os = "windows")]
        if self.preview.is_some() {
            return "a composition swap chain in a DirectComposition visual beneath GPUI, presented on its own thread";
        }
        "none"
    }

    fn observe(&self, window: &Window) {
        let Ok(mut stats) = self.stats.lock() else {
            return;
        };
        stats.scale_factor = Some(window.scale_factor());
        let viewport = window.viewport_size();
        let viewport = (f32::from(viewport.width), f32::from(viewport.height));
        if stats
            .viewport_px
            .is_some_and(|previous| previous != viewport)
        {
            stats.viewport_changes += 1;
        }
        stats.viewport_px = Some(viewport);
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
        self.observe(window);
        let step = self.layout_step % 2;
        div()
            .size_full()
            .flex()
            .bg(rgb(0x0f0f11))
            .text_color(rgb(0xededed))
            .child(
                div()
                    .w(px(SIDEBAR_PX[step]))
                    .h_full()
                    .flex_none()
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .border_r_1()
                    .border_color(rgb(0x2a2a2e))
                    .child("GPUI sidebar")
                    .child(format!("GPUI renders so far: {n}"))
                    .child(format!("Video: {}", self.route()))
                    .child(
                        div()
                            .text_color(rgb(0x9a9aa2))
                            .child("GPUI repaints only when the layout changes; the video presents on its own thread."),
                    ),
            )
            .child(
                div().flex_1().h_full().p(px(PANE_PADDING_PX[step])).child(
                    div()
                        .relative()
                        .size_full()
                        // Painted before the view, under it: visible only if
                        // the renderer failed to erase it.
                        .child(
                            div()
                                .absolute()
                                .top(px(40.))
                                .left(px(40.))
                                .right(px(40.))
                                .bottom(px(40.))
                                .bg(rgb(0xff00ff))
                                .p_4()
                                .child("Magenta: the renderer did not erase under the video"),
                        )
                        .child(self.video())
                        .child(
                            div()
                                .absolute()
                                .top(px(48.))
                                .left(px(48.))
                                .w(px(400.))
                                .h(px(225.))
                                .border_2()
                                .border_color(rgb(0x3b82f6))
                                .bg(rgba(0x3b82f640))
                                .rounded_md()
                                .p_2()
                                .child("A translucent box over the video (an editor handle)"),
                        )
                        .child(
                            div()
                                .absolute()
                                .top(px(48.))
                                .right(px(48.))
                                .w(px(96.))
                                .h(px(96.))
                                .bg(rgb(0xe5484d))
                                .p_2()
                                .child("Opaque"),
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
                                .child("Live · a translucent pill with text"),
                        ),
                ),
            )
    }
}

fn main() {
    let run = Run::start(SPIKE);
    let seconds = run.args.seconds;
    let layout_test = run.args.flag("--layout-test");
    let stop = Arc::new(AtomicBool::new(false));
    let present_stats = Arc::new(Mutex::new(PresentStats::default()));
    let window_stats = Arc::new(Mutex::new(WindowStats::default()));
    let run = Arc::new(Mutex::new(run));

    gpui_platform::application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(WINDOW_SIZE.0), px(WINDOW_SIZE.1)), cx);
        let (stop2, present2, window2) =
            (stop.clone(), present_stats.clone(), window_stats.clone());
        let open_us = (spike_summary::elapsed_ms() * 1000.0) as u64;
        OPEN_WINDOW_US.store(open_us.max(1), Ordering::Relaxed);
        let opened = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(SPIKE.into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            move |window, cx| {
                cx.new(|cx| Spike::new(window, cx, stop2, present2, window2, layout_test))
            },
        );
        if let Err(e) = opened {
            spike_summary::error(format!("open_window failed: {e:#}"));
            run.lock().expect("run").finish();
        }
        cx.activate(true);

        let (stop3, present3, window3, run3) = (
            stop.clone(),
            present_stats.clone(),
            window_stats.clone(),
            run.clone(),
        );
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
            run.set("layout_test", layout_test);
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
                let open_us = OPEN_WINDOW_US.load(Ordering::Relaxed);
                if open_us > 0 && first_paint_us >= open_us {
                    run.set(
                        "window_open_to_first_paint_ms",
                        round((first_paint_us - open_us) as f64 / 1000.0, 1),
                    );
                }
            } else {
                spike_summary::error("GPUI never painted a frame");
            }
            let stats = present3.lock().expect("present stats");
            run.set("native_view", stats.presents > 0);
            #[cfg(target_os = "windows")]
            if let Some(hz) = native::display_hz() {
                run.set("display_hz", round(hz, 2));
            }
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
            run.set("drawable_resizes", stats.resizes);
            run.set("present_waits_timed_out", stats.waits_timed_out);
            // The presenter clears GPU buffers; no frame touches the CPU.
            run.set("cpu_copies_per_frame", 0);
            if stats.presents == 0 {
                spike_summary::error("the presenter never presented a frame");
            }
            drop(stats);
            let stats = window3.lock().expect("window stats");
            if let Some(scale) = stats.scale_factor {
                run.set("scale_factor", round(f64::from(scale), 3));
            }
            if let Some((w, h)) = stats.viewport_px {
                run.set("viewport_px", format!("{w:.0}x{h:.0}"));
            }
            run.set("viewport_changes", stats.viewport_changes);
            drop(stats);
            run.finish();
        })
        .detach();
    });
}
