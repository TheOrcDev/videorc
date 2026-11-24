//! Plan 260 spike WC-0.1 (`spike-hello`), checked by the Windows testing
//! plan's S0.2a.
//!
//! Question: does GPUI build and run on a Windows PC, and what does its
//! frame cost there?
//!
//! The frame every later Windows spike starts from: a 280-pixel sidebar and a
//! content pane. The pane is a colour GPUI repaints once a second; over it
//! GPUI draws a translucent bordered box (an editor handle) and a translucent
//! pill with text. Nothing else changes, so the run also shows what an idle
//! GPUI window costs. It builds and runs on macOS and Linux too, where it is
//! the same frame without anything platform-specific.
//!
//! The spike closes itself after `--seconds`, prints `[spike] summary <json>`
//! and writes summary.json (`../SUMMARY.md`).

use gpui::{
    App, Bounds, Context, Size, TitlebarOptions, Window, WindowBounds, WindowOptions, div,
    prelude::*, px, rgb, rgba, size,
};
use spike_summary::{Run, round};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

const SPIKE: &str = "spike-hello";

/// The sidebar's width in logical pixels (the Windows code plan's WC-0.1).
const SIDEBAR_PX: f32 = 280.;

/// The window's logical size. 1100 × 640 fits a 1920 × 1080 display at 150 %
/// (1650 × 960 device pixels) with room for the taskbar.
const WINDOW_SIZE: (f32, f32) = (1100., 640.);

static RENDERS: AtomicU64 = AtomicU64::new(0);
/// Startup to the first frame after the first render, in microseconds (0 = not yet).
static FIRST_PAINT_US: AtomicU64 = AtomicU64::new(0);
/// Startup to `open_window`, in microseconds (0 = not yet).
static OPEN_WINDOW_US: AtomicU64 = AtomicU64::new(0);

/// What the window looked like, as `render` last saw it.
#[derive(Default)]
struct WindowStats {
    scale_factor: Option<f32>,
    viewport: Option<Size<f32>>,
    /// Times the viewport's size differed from the previous render's: a
    /// resize by dragging an edge, a maximise, or a move to a display with
    /// another scale.
    viewport_changes: u64,
    /// Every scale factor the window had, in order, without repeats.
    scale_factors_seen: Vec<f32>,
}

struct Hello {
    /// Seconds since the window opened; the pane's colour follows it.
    tick: u64,
    stats: Arc<Mutex<WindowStats>>,
}

impl Hello {
    fn new(cx: &mut Context<Self>, stats: Arc<Mutex<WindowStats>>) -> Self {
        // The pane's colour steps once a second: the only thing that asks
        // GPUI for a new frame.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let alive = this
                    .update(cx, |hello, cx| {
                        hello.tick += 1;
                        cx.notify();
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            }
        })
        .detach();
        Self { tick: 0, stats }
    }

    /// Records the window's scale and size, counting changes.
    fn observe(&self, window: &Window) {
        let Ok(mut stats) = self.stats.lock() else {
            return;
        };
        let scale = window.scale_factor();
        if stats.scale_factors_seen.last() != Some(&scale) {
            stats.scale_factors_seen.push(scale);
        }
        stats.scale_factor = Some(scale);
        let viewport = window.viewport_size();
        let viewport = size(f32::from(viewport.width), f32::from(viewport.height));
        if let Some(previous) = stats.viewport
            && previous != viewport
        {
            stats.viewport_changes += 1;
        }
        stats.viewport = Some(viewport);
    }
}

/// The pane's colour after `tick` seconds (the same palette as the other spikes).
fn pane_color(tick: u64) -> u32 {
    let t = tick as f64;
    let c = |phase: f64, speed: f64| ((0.5 + 0.5 * (t * speed + phase).sin()) * 255.0) as u32;
    (c(0.0, 1.3) << 16) | (c(2.0, 0.7) << 8) | c(4.0, 0.9)
}

impl Render for Hello {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let n = RENDERS.fetch_add(1, Ordering::Relaxed) + 1;
        if n == 1 {
            window.on_next_frame(|_, _| {
                let us = (spike_summary::elapsed_ms() * 1000.0) as u64;
                FIRST_PAINT_US.store(us.max(1), Ordering::Relaxed);
            });
        }
        self.observe(window);
        let scale = window.scale_factor();
        let viewport = window.viewport_size();
        div()
            .size_full()
            .flex()
            .bg(rgb(0x0f0f11))
            .text_color(rgb(0xededed))
            .child(
                div()
                    .w(px(SIDEBAR_PX))
                    .h_full()
                    .flex_none()
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .border_r_1()
                    .border_color(rgb(0x2a2a2e))
                    .child("GPUI sidebar")
                    .child(format!("Renders so far: {n}"))
                    .child(format!("Seconds open: {}", self.tick))
                    .child(format!(
                        "Window: {:.0} × {:.0} at {:.0} %",
                        f32::from(viewport.width),
                        f32::from(viewport.height),
                        scale * 100.0
                    ))
                    .child(
                        div()
                            .text_color(rgb(0x9a9aa2))
                            .child("The pane's colour changes once a second; nothing else does."),
                    ),
            )
            .child(
                div().flex_1().h_full().p_6().child(
                    div()
                        .relative()
                        .size_full()
                        .rounded_md()
                        .overflow_hidden()
                        .bg(rgb(pane_color(self.tick)))
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
                                .child("A translucent box over the pane (an editor handle)"),
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
    let stats = Arc::new(Mutex::new(WindowStats::default()));
    let run = Arc::new(Mutex::new(run));

    gpui_platform::application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(WINDOW_SIZE.0), px(WINDOW_SIZE.1)), cx);
        let stats2 = stats.clone();
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
            move |_window, cx| cx.new(|cx| Hello::new(cx, stats2)),
        );
        if let Err(e) = opened {
            spike_summary::error(format!("open_window failed: {e:#}"));
            run.lock().expect("run").finish();
        }
        cx.activate(true);

        let (stats3, run3) = (stats.clone(), run.clone());
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_secs(seconds))
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
            if renders == 0 {
                spike_summary::error("GPUI never called render");
            }
            let stats = stats3.lock().expect("stats");
            if let Some(scale) = stats.scale_factor {
                run.set("scale_factor", round(f64::from(scale), 3));
            }
            if let Some(viewport) = stats.viewport {
                let scale = stats.scale_factor.unwrap_or(1.0);
                run.set(
                    "viewport_px",
                    format!("{:.0}x{:.0}", viewport.width, viewport.height),
                );
                run.set(
                    "viewport_device_px",
                    format!(
                        "{:.0}x{:.0}",
                        viewport.width * scale,
                        viewport.height * scale
                    ),
                );
            }
            run.set("viewport_changes", stats.viewport_changes);
            run.set(
                "scale_factors_seen",
                stats
                    .scale_factors_seen
                    .iter()
                    .map(|s| round(f64::from(*s), 3))
                    .collect::<Vec<_>>(),
            );
            drop(stats);
            run.finish();
        })
        .detach();
    });
}
