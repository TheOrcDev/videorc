//! Plan 260 S0.3: the Linux preview under GPUI's wgpu window.
//!
//! One GPUI window (a 240 px sidebar, a toolbar, the preview slot inset
//! 16 px and contain-fit 16:9) whose slot is a transparent hole in GPUI's
//! own surface. Plan 220's Linux presenter (`presenter.rs`, from
//! `videorc-rust:crates/videorc-preview/src/linux.rs`) puts the frames of a
//! shared-memory ring (`videorc-preview-ring`) on the screen through the
//! display server:
//!
//! - Wayland: a `wl_subsurface` of GPUI's `wl_surface`, placed BELOW it
//!   (`--above` puts it over, as the Slint spike did), fed by `wl_shm`
//!   buffers over the ring's memfd.
//! - X11: a child window of GPUI's window fed by MIT-SHM over the ring
//!   (X11 stacks a child over its parent's own drawing: no "below").
//!
//! GPUI draws an editor handle, a label pill and a popup panel over the
//! slot. The frames come from a writer process (this binary,
//! `--writer`) that writes a moving test pattern into the ring at the
//! camera's rate, as the backend's CPU preview does.
//!
//! Phases: warm-up, live (frames flowing), still (the writer pauses; the
//! last frame stays), resize (the window stepped between two sizes).

use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui::{
    App, Bounds, Context, Hsla, Window, WindowBackgroundAppearance, WindowBounds, WindowOptions,
    canvas, div, hsla, prelude::*, px, rgb, size,
};
use gpui_platform::application;
use videorc_preview_ring::{RingHandle, RingReader, RingWriter, Wait, now_micros};

use crate::presenter::{LayerRect, Placement, Presenter, PresenterClient, RingMapping};

static GPUI_PAINTS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
struct Args {
    writer: bool,
    width: u32,
    height: u32,
    fps: u32,
    warmup: f64,
    live: f64,
    still: f64,
    resize: f64,
    overlay: bool,
    above: bool,
    presentation: bool,
    report: Option<String>,
    compositor_pids: Vec<u32>,
    label: String,
    hold: f64,
    /// `native` (the presenter: subsurface or child window) or `image`
    /// (route d: each frame copied into a GPUI `RenderImage`).
    route: String,
    /// X11: GPUI's overlay in a second, override-redirect window over the
    /// slot (the child window covers anything the main window draws).
    overlay_window: bool,
}

fn parse_args() -> Args {
    let mut args = Args {
        writer: false,
        width: 1920,
        height: 1080,
        fps: 30,
        warmup: 3.0,
        live: 60.0,
        still: 20.0,
        resize: 0.0,
        overlay: true,
        above: false,
        presentation: false,
        report: None,
        compositor_pids: Vec::new(),
        label: "run".to_string(),
        hold: 0.0,
        route: "native".to_string(),
        overlay_window: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().expect("a value");
        match arg.as_str() {
            "--writer" => args.writer = true,
            "--resolution" => {
                let v = value();
                let (w, h) = v.split_once('x').expect("WxH");
                args.width = w.parse().unwrap();
                args.height = h.parse().unwrap();
            }
            "--fps" => args.fps = value().parse().unwrap(),
            "--warmup" => args.warmup = value().parse().unwrap(),
            "--live" | "--seconds" => args.live = value().parse().unwrap(),
            "--still" => args.still = value().parse().unwrap(),
            "--resize" => args.resize = value().parse().unwrap(),
            "--hold" => args.hold = value().parse().unwrap(),
            "--no-overlay" => args.overlay = false,
            "--above" => args.above = true,
            "--presentation" => args.presentation = true,
            "--report" | "--out" => args.report = Some(value()),
            "--compositor-pid" => args.compositor_pids.push(value().parse().unwrap()),
            "--label" => args.label = value(),
            "--route" => args.route = value(),
            "--overlay-window" => args.overlay_window = true,
            other => panic!("unknown argument {other}"),
        }
    }
    args
}

pub fn main() {
    let args = parse_args();
    if args.writer {
        run_writer(&args);
        return;
    }
    run_app(args);
}

// ---------------------------------------------------------------- writer

/// The frame source: a ring writer at a fixed rate, paused and resumed on
/// stdin ("pause", "resume", "quit"). Pattern: a hue that drifts, a white
/// bar that moves 8 px a frame, and the frame number in binary blocks.
fn run_writer(args: &Args) {
    let mut writer = RingWriter::create(1, args.width, args.height, 3).expect("ring");
    let handle = writer.handle().clone();
    println!("RING {} {} {}", handle.kind, handle.name, handle.bytes);
    std::io::stdout().flush().unwrap();
    let paused = Arc::new(AtomicBool::new(false));
    let quit = Arc::new(AtomicBool::new(false));
    {
        let paused = paused.clone();
        let quit = quit.clone();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                match line.as_deref().map(str::trim) {
                    Ok("pause") => paused.store(true, Ordering::SeqCst),
                    Ok("resume") => paused.store(false, Ordering::SeqCst),
                    Ok("quit") | Err(_) => break,
                    _ => {}
                }
            }
            quit.store(true, Ordering::SeqCst);
        });
    }
    let period = Duration::from_secs_f64(1.0 / f64::from(args.fps));
    let mut next = Instant::now();
    let mut sequence = 0_u64;
    let (w, h) = (args.width as usize, args.height as usize);
    while !quit.load(Ordering::SeqCst) {
        next += period;
        if !paused.load(Ordering::SeqCst) {
            sequence += 1;
            if let Some(mut slot) = writer.begin() {
                let pixels = slot.pixels_mut();
                // SAFETY: BGRA8 rows, the slot is page-aligned.
                let (_, words, _) = unsafe { pixels.align_to_mut::<u32>() };
                paint_pattern(words, w, h, sequence);
                slot.publish(sequence, now_micros());
            }
        }
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
    }
    eprintln!(
        "[writer] frames written {} skipped {}",
        writer.frames_written(),
        writer.frames_skipped()
    );
    writer.retire();
}

fn paint_pattern(words: &mut [u32], w: usize, h: usize, n: u64) {
    let hue = (n as f32 * 0.01) % 1.0;
    let bg = hsv_to_bgra(hue, 0.55, 0.55);
    words[..w * h].fill(bg);
    let bar_x = ((n * 8) as usize) % w.saturating_sub(64).max(1);
    for row in 0..h {
        let start = row * w + bar_x;
        words[start..start + 64].fill(0xFFFF_FFFF);
    }
    // The frame number, 24 bits, as 40 px blocks along the top.
    for bit in 0..24 {
        let on = (n >> bit) & 1 == 1;
        let color = if on { 0xFFFF_FFFF } else { 0xFF00_0000 };
        let x0 = 40 + bit * 48;
        for row in 40..80 {
            let start = row * w + x0;
            if start + 40 <= words.len() {
                words[start..start + 40].fill(color);
            }
        }
    }
}

fn hsv_to_bgra(h: f32, s: f32, v: f32) -> u32 {
    let i = (h * 6.0).floor();
    let f = h * 6.0 - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - f * s), v * (1.0 - (1.0 - f) * s));
    let (r, g, b) = match i as i32 % 6 {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    let c = |x: f32| (x * 255.0).round() as u32;
    0xFF00_0000 | (c(r) << 16) | (c(g) << 8) | c(b)
}

// ---------------------------------------------------------------- stats

#[derive(Default, Clone)]
struct FrameSample {
    frame_id: u64,
    captured_at: u64,
    leased_at: u64,
    committed_at: u64,
    reported_at: u64,
    released: bool,
    shown: bool,
    error: bool,
}

#[derive(Default)]
struct Feed {
    samples: Vec<FrameSample>,
    leases_missed: u64,
}

fn percentile(values: &mut [f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let rank = ((p / 100.0) * (values.len() as f64 - 1.0)).round() as usize;
    Some(values[rank.min(values.len() - 1)])
}

fn round2(v: Option<f64>) -> serde_json::Value {
    match v {
        Some(v) => serde_json::json!((v * 100.0).round() / 100.0),
        None => serde_json::Value::Null,
    }
}

fn rusage_self_micros() -> u64 {
    // SAFETY: a zeroed rusage is a valid out-parameter.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: getrusage into a local.
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let tv = |t: libc::timeval| t.tv_sec as u64 * 1_000_000 + t.tv_usec as u64;
    tv(usage.ru_utime) + tv(usage.ru_stime)
}

/// utime + stime of another process, in microseconds.
fn proc_cpu_micros(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = stat.rsplit_once(')')?.1;
    let fields: Vec<&str> = after.split_whitespace().collect();
    let ticks: u64 = fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?;
    // SAFETY: sysconf has no preconditions.
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as u64;
    Some(ticks * 1_000_000 / hz)
}

fn rss_mb() -> f64 {
    let statm = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let pages: f64 = statm
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);
    pages * 4096.0 / 1_048_576.0
}

#[derive(Clone)]
struct Mark {
    at: Instant,
    at_micros: u64,
    cpu: u64,
    writer_cpu: Option<u64>,
    compositor_cpu: Vec<(u32, Option<u64>)>,
    paints: u64,
    written: u64,
}

struct Marks {
    reader: Arc<RingReader>,
    writer_pid: u32,
    compositor_pids: Vec<u32>,
}

impl Marks {
    fn take(&self) -> Mark {
        Mark {
            at: Instant::now(),
            at_micros: now_micros(),
            cpu: rusage_self_micros(),
            writer_cpu: proc_cpu_micros(self.writer_pid),
            compositor_cpu: self
                .compositor_pids
                .iter()
                .map(|pid| (*pid, proc_cpu_micros(*pid)))
                .collect(),
            paints: GPUI_PAINTS.load(Ordering::SeqCst),
            written: self.reader.frames_written(),
        }
    }
}

fn phase_json(name: &str, from: &Mark, to: &Mark, feed: &Feed) -> serde_json::Value {
    let wall = to.at.duration_since(from.at).as_secs_f64();
    let pct = |a: Option<u64>, b: Option<u64>| match (a, b) {
        (Some(a), Some(b)) => Some((b - a) as f64 / 1e4 / wall),
        _ => None,
    };
    let in_phase: Vec<&FrameSample> = feed
        .samples
        .iter()
        .filter(|s| s.leased_at >= from.at_micros && s.leased_at < to.at_micros)
        .collect();
    let shown: Vec<&&FrameSample> = in_phase.iter().filter(|s| s.shown).collect();
    let mut commit_intervals: Vec<f64> = shown
        .windows(2)
        .map(|w| (w[1].committed_at as f64 - w[0].committed_at as f64) / 1000.0)
        .collect();
    let mut age_at_commit: Vec<f64> = shown
        .iter()
        .map(|s| (s.committed_at as f64 - s.captured_at as f64) / 1000.0)
        .collect();
    let mut lease_held: Vec<f64> = in_phase
        .iter()
        .map(|s| (s.reported_at as f64 - s.leased_at as f64) / 1000.0)
        .collect();
    let captured: std::collections::HashMap<u64, u64> = feed
        .samples
        .iter()
        .map(|s| (s.frame_id, s.captured_at))
        .collect();
    let log = crate::presenter::PRESENTATION.lock().unwrap();
    let presented: Vec<&(u64, u64, u32, u32)> = log
        .presented
        .iter()
        .filter(|p| p.1 >= from.at_micros && p.1 < to.at_micros)
        .collect();
    let mut present_intervals: Vec<f64> = presented
        .windows(2)
        .map(|w| (w[1].1 as f64 - w[0].1 as f64) / 1000.0)
        .collect();
    let mut age_at_present: Vec<f64> = presented
        .iter()
        .filter_map(|p| {
            captured
                .get(&p.0)
                .map(|c| (p.1 as f64 - *c as f64) / 1000.0)
        })
        .collect();
    serde_json::json!({
        "phase": name,
        "seconds": (wall * 100.0).round() / 100.0,
        "uiCpuPercentOfOneCore": round2(Some((to.cpu - from.cpu) as f64 / 1e4 / wall)),
        "writerCpuPercent": round2(pct(from.writer_cpu, to.writer_cpu)),
        "compositorCpuPercent": from
            .compositor_cpu
            .iter()
            .zip(to.compositor_cpu.iter())
            .map(|((pid, a), (_, b))| serde_json::json!({"pid": pid, "comm": std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default().trim(), "percent": round2(pct(*a, *b))}))
            .collect::<Vec<_>>(),
        "gpuiPaints": to.paints - from.paints,
        "framesWritten": to.written - from.written,
        "framesLeased": in_phase.len(),
        "framesShown": shown.len(),
        "framesReleasedInTime": in_phase.iter().filter(|s| s.released).count(),
        "presentErrors": in_phase.iter().filter(|s| s.error).count(),
        "shownPerSecond": round2(Some(shown.len() as f64 / wall)),
        "commitIntervalMs": {"p50": round2(percentile(&mut commit_intervals, 50.0)), "p95": round2(percentile(&mut commit_intervals, 95.0)), "max": round2(percentile(&mut commit_intervals, 100.0))},
        "ageAtCommitMs": {"p50": round2(percentile(&mut age_at_commit, 50.0)), "p95": round2(percentile(&mut age_at_commit, 95.0))},
        "leaseHeldMs": {"p50": round2(percentile(&mut lease_held, 50.0)), "p95": round2(percentile(&mut lease_held, 95.0))},
        "wpPresentation": {
            "presented": presented.len(),
            "presentedPerSecond": round2(Some(presented.len() as f64 / wall)),
            "intervalMs": {"p50": round2(percentile(&mut present_intervals, 50.0)), "p95": round2(percentile(&mut present_intervals, 95.0)), "max": round2(percentile(&mut present_intervals, 100.0))},
            "ageAtPresentMs": {"p50": round2(percentile(&mut age_at_present, 50.0)), "p95": round2(percentile(&mut age_at_present, 95.0))},
        },
    })
}

/// The common `summary.json` (SUMMARY.md's names) from the spike's own
/// report, which goes in whole under `linux`.
fn fill_summary(
    run: &mut spike_summary::Run,
    args: &Args,
    report: &serde_json::Value,
    slot: &Arc<Mutex<(LayerRect, f64)>>,
) {
    let phase = |name: &str| {
        report["phases"]
            .as_array()
            .and_then(|phases| phases.iter().find(|p| p["phase"] == name))
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };
    let live = phase("live");
    let still = phase("still");
    let native = args.route != "image";
    let backing = report["backing"].as_str().unwrap_or_default();
    if backing.starts_with("no presenter") && native {
        spike_summary::error(backing.to_string());
    }
    let route = if !native {
        "d"
    } else if backing.starts_with("wl_subsurface") {
        "wl-subsurface"
    } else {
        "x11-child-window"
    };
    run.set("route", route);
    run.set("backing", backing);
    run.set("session", report["session"].clone());
    run.set("native_view", native);
    run.set(
        "video_below_gpui",
        // X11 stacks a child window over its parent's own drawing.
        native && route == "wl-subsurface" && report["subsurfaceBelowGpui"] == true || !native,
    );
    run.set("overlay_window", args.overlay_window);
    run.set("resolution", format!("{}x{}", args.width, args.height));
    run.set("fps", args.fps);
    let (rect, scale) = *slot.lock().unwrap();
    run.set(
        "drawable_px",
        format!(
            "{}x{}",
            (rect.width * scale).round(),
            (rect.height * scale).round()
        ),
    );
    let live_seconds = live["seconds"].as_f64().unwrap_or(1.0);
    run.set("presents", live["framesShown"].clone());
    run.set("presents_per_second", live["shownPerSecond"].clone());
    let presented = live["wpPresentation"]["presented"].as_u64().unwrap_or(0);
    run.set(
        "present_interval_p95_ms",
        if presented > 0 {
            live["wpPresentation"]["intervalMs"]["p95"].clone()
        } else {
            live["commitIntervalMs"]["p95"].clone()
        },
    );
    run.set(
        "present_interval_source",
        if presented > 0 {
            "wp_presentation (on screen)"
        } else if native && route == "x11-child-window" {
            "ShmCompletion after put + composite (server)"
        } else if native {
            "commit (wl_surface.commit)"
        } else {
            "GPUI notify (image route)"
        },
    );
    run.set("ui_cpu_percent_live", live["uiCpuPercentOfOneCore"].clone());
    run.set(
        "ui_cpu_percent_still",
        still["uiCpuPercentOfOneCore"].clone(),
    );
    let paints = live["gpuiPaints"].as_u64().unwrap_or(0);
    run.set("renders", GPUI_PAINTS.load(Ordering::SeqCst));
    run.set(
        "ui_redraws_per_second_live",
        spike_summary::round(paints as f64 / live_seconds, 2),
    );
    run.set(
        "ui_redraws_per_second_idle",
        spike_summary::round(
            still["gpuiPaints"].as_u64().unwrap_or(0) as f64
                / still["seconds"].as_f64().unwrap_or(1.0),
            2,
        ),
    );
    // The app copies nothing on the native routes: the display server reads
    // the ring's memory (and uploads it: wl_shm or MIT-SHM). Route (d)
    // copies the frame out of the ring, and GPUI uploads it to its atlas.
    run.set("cpu_copies_per_frame", if native { 1 } else { 2 });
    run.set("cpu_copies_per_frame_in_app", if native { 0 } else { 1 });
    let written = live["framesWritten"].as_u64().unwrap_or(0);
    let shown = live["framesShown"].as_u64().unwrap_or(0);
    run.set("dropped_frames", written.saturating_sub(shown));
    run.set("linux", report.clone());
}

// ---------------------------------------------------------------- feed

/// The reader thread: the latest frame, leased, handed to the presenter,
/// the lease kept until the server gives the buffer back.
fn spawn_feed(reader: Arc<RingReader>, client: PresenterClient, feed: Arc<Mutex<Feed>>) {
    std::thread::Builder::new()
        .name("spike-feed".into())
        .spawn(move || {
            let mut last = 0_u64;
            loop {
                match reader.wait_newer(last, Duration::from_millis(250)) {
                    Wait::Retired => break,
                    Wait::Timeout => continue,
                    Wait::NewFrame(_) => {}
                }
                let Some(frame) = reader.lease_latest() else {
                    feed.lock().unwrap().leases_missed += 1;
                    continue;
                };
                last = frame.frame_id;
                let leased_at = now_micros();
                let reply = client.present(frame.slot(), frame.frame_id);
                let report = reply.recv_timeout(Duration::from_secs(2));
                let reported_at = now_micros();
                let sample = match report {
                    Ok(report) => FrameSample {
                        frame_id: frame.frame_id,
                        captured_at: frame.captured_at_micros,
                        leased_at,
                        committed_at: report
                            .committed_at
                            .map(|at| {
                                leased_at
                                    + at.saturating_duration_since(report.started_at).as_micros()
                                        as u64
                            })
                            .unwrap_or(0),
                        reported_at,
                        released: report.released,
                        shown: report.shown,
                        error: report.error.is_some(),
                    },
                    Err(_) => FrameSample {
                        frame_id: frame.frame_id,
                        captured_at: frame.captured_at_micros,
                        leased_at,
                        reported_at,
                        error: true,
                        ..Default::default()
                    },
                };
                drop(frame);
                feed.lock().unwrap().samples.push(sample);
            }
        })
        .expect("feed thread");
}

/// Route (d): the latest frame copied out of the ring into a GPUI image
/// (one CPU copy), handed to the UI thread, which redraws the window.
fn spawn_image_feed(
    reader: Arc<RingReader>,
    feed: Arc<Mutex<Feed>>,
    tx: futures::channel::mpsc::UnboundedSender<(Arc<gpui::RenderImage>, FrameSample)>,
) {
    std::thread::Builder::new()
        .name("spike-image-feed".into())
        .spawn(move || {
            let mut last = 0_u64;
            loop {
                match reader.wait_newer(last, Duration::from_millis(250)) {
                    Wait::Retired => break,
                    Wait::Timeout => continue,
                    Wait::NewFrame(_) => {}
                }
                let Some(frame) = reader.lease_latest() else {
                    feed.lock().unwrap().leases_missed += 1;
                    continue;
                };
                last = frame.frame_id;
                let leased_at = now_micros();
                let bytes = frame.pixels().to_vec();
                let (w, h) = (frame.width(), frame.height());
                let sample = FrameSample {
                    frame_id: frame.frame_id,
                    captured_at: frame.captured_at_micros,
                    leased_at,
                    ..Default::default()
                };
                drop(frame);
                let buffer = image::RgbaImage::from_raw(w, h, bytes).expect("frame size");
                let render = gpui::RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]);
                if tx.unbounded_send((Arc::new(render), sample)).is_err() {
                    break;
                }
            }
        })
        .expect("image feed thread");
}

// ---------------------------------------------------------------- the window

const SIDEBAR: f32 = 240.0;
const TOOLBAR: f32 = 44.0;
const INSET: f32 = 16.0;

fn slot_rect(viewport: gpui::Size<gpui::Pixels>, ratio: f32) -> LayerRect {
    let (vw, vh) = (f32::from(viewport.width), f32::from(viewport.height));
    let area_x = SIDEBAR + INSET;
    let area_y = TOOLBAR + INSET;
    let area_w = (vw - SIDEBAR - 2.0 * INSET).max(16.0);
    let area_h = (vh - TOOLBAR - 2.0 * INSET).max(9.0);
    let (w, h) = if area_w / area_h > ratio {
        (area_h * ratio, area_h)
    } else {
        (area_w, area_w / ratio)
    };
    LayerRect {
        x: f64::from((area_x + (area_w - w) / 2.0).round()),
        y: f64::from((area_y + (area_h - h) / 2.0).round()),
        width: f64::from(w.round()),
        height: f64::from(h.round()),
    }
}

/// GPUI's drawing over the slot: an editor selection with handles, a
/// label pill and a popup panel that crosses the slot's right edge. The
/// slot's rect is in the coordinates of the element it is drawn in.
fn overlay_layer(x: f32, y: f32, w: f32, h: f32) -> gpui::Div {
    let handle = |left: f32, top: f32| {
        div()
            .absolute()
            .left(px(left - 5.))
            .top(px(top - 5.))
            .size(px(10.))
            .bg(rgb(0xffffff))
            .border_1()
            .border_color(rgb(0x3b82f6))
    };
    let (bx, by, bw, bh) = (x + w * 0.22, y + h * 0.28, w * 0.4, h * 0.42);
    div()
        .absolute()
        .left(px(0.))
        .top(px(0.))
        .size_full()
        // The editor's selection: a translucent bordered box with
        // four corner handles.
        .child(
            div()
                .absolute()
                .left(px(bx))
                .top(px(by))
                .w(px(bw))
                .h(px(bh))
                .border_2()
                .border_color(rgb(0x3b82f6))
                .bg(hsla(0.6, 0.9, 0.6, 0.22)),
        )
        .child(handle(bx, by))
        .child(handle(bx + bw, by))
        .child(handle(bx, by + bh))
        .child(handle(bx + bw, by + bh))
        // A label pill.
        .child(
            div()
                .absolute()
                .left(px(x + 14.))
                .top(px(y + h - 44.))
                .px_3()
                .py_1()
                .rounded_full()
                .bg(hsla(0.0, 0.0, 0.0, 0.55))
                .child("Camera · GPUI over the video"),
        )
        // A popup panel that crosses the slot's right edge.
        .child(
            div()
                .absolute()
                .left(px(x + w - 140.))
                .top(px(y + 24.))
                .w(px(220.))
                .p_2()
                .rounded_lg()
                .bg(hsla(0.67, 0.08, 0.13, 0.94))
                .border_1()
                .border_color(rgb(0x3a3a44))
                .flex()
                .flex_col()
                .gap_1()
                .child("Popup over the slot")
                .child(div().text_color(rgb(0xa0a0b0)).child("Bring forward"))
                .child(div().text_color(rgb(0xa0a0b0)).child("Hide source")),
        )
}

const OVERLAY_MARGIN: f32 = 100.0;

/// The overlay window's view: the overlay alone, on a transparent window
/// that sits over the slot with a margin (the popup crosses the edge).
struct OverlayView {
    /// The main window's slot, as its last render laid it out.
    slot: Arc<Mutex<(LayerRect, f64)>>,
}

impl Render for OverlayView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let (rect, _) = *self.slot.lock().unwrap();
        let (width, height) = (rect.width as f32, rect.height as f32);
        div()
            .size_full()
            .relative()
            .text_color(rgb(0xe8e8ee))
            .text_sm()
            .child(overlay_layer(OVERLAY_MARGIN, OVERLAY_MARGIN, width, height))
            .child(
                canvas(
                    |_, _, _| (),
                    |_, _, _, _| {
                        GPUI_PAINTS.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .absolute()
                .size(px(1.)),
            )
    }
}

fn x11_window_id(window: &Window) -> Option<u32> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xcb(xcb) => Some(xcb.window.get()),
        RawWindowHandle::Xlib(xlib) => Some(xlib.window as u32),
        _ => None,
    }
}

/// Keeps the overlay window over the main window's slot: follows the main
/// window's ConfigureNotify on a connection of its own, and gives the
/// overlay an empty input shape so clicks reach the main window.
fn spawn_x11_overlay_tracker(main: u32, overlay: u32, slot: Arc<Mutex<(LayerRect, f64)>>) {
    std::thread::Builder::new()
        .name("spike-x11-overlay".into())
        .spawn(move || {
            use x11rb::connection::Connection;
            use x11rb::protocol::Event;
            use x11rb::protocol::shape::{self, ConnectionExt as _};
            use x11rb::protocol::xproto::{self, ConnectionExt as _};
            let Ok((conn, screen)) = x11rb::connect(None) else {
                eprintln!("[spike] error x11 overlay tracker: no connection");
                return;
            };
            let root = conn.setup().roots[screen].root;
            let _ = conn.change_window_attributes(
                main,
                &xproto::ChangeWindowAttributesAux::new()
                    .event_mask(xproto::EventMask::STRUCTURE_NOTIFY),
            );
            let _ = conn.shape_rectangles(
                shape::SO::SET,
                shape::SK::INPUT,
                xproto::ClipOrdering::UNSORTED,
                overlay,
                0,
                0,
                &[],
            );
            let mut last = None;
            let mut place = |conn: &x11rb::rust_connection::RustConnection| {
                let Ok(Ok(at)) = conn
                    .translate_coordinates(main, root, 0, 0)
                    .map(|cookie| cookie.reply())
                else {
                    return;
                };
                let (rect, scale) = *slot.lock().unwrap();
                let m = f64::from(OVERLAY_MARGIN);
                let x = i32::from(at.dst_x) + ((rect.x - m) * scale).round() as i32;
                let y = i32::from(at.dst_y) + ((rect.y - m) * scale).round() as i32;
                let w = ((rect.width + 2.0 * m) * scale).round() as u32;
                let h = ((rect.height + 2.0 * m) * scale).round() as u32;
                if last == Some((x, y, w, h)) {
                    return;
                }
                last = Some((x, y, w, h));
                let _ = conn.configure_window(
                    overlay,
                    &xproto::ConfigureWindowAux::new()
                        .x(x)
                        .y(y)
                        .stack_mode(xproto::StackMode::ABOVE),
                );
                let _ = conn.flush();
                eprintln!("[spike] overlay window at {x},{y} {w}x{h}");
            };
            place(&conn);
            loop {
                match conn.wait_for_event() {
                    Ok(Event::ConfigureNotify(_)) | Ok(Event::MapNotify(_)) => place(&conn),
                    Ok(Event::DestroyNotify(_)) | Err(_) => break,
                    _ => {}
                }
            }
        })
        .expect("overlay tracker");
}

struct Spike {
    slot_shared: Arc<Mutex<(LayerRect, f64)>>,
    frame: Option<Arc<gpui::RenderImage>>,
    presenter: Rc<RefCell<Option<Presenter>>>,
    backing: String,
    overlay: bool,
    ratio: f32,
}

fn pane() -> Hsla {
    rgb(0x16161a).into()
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let rect = slot_rect(viewport, self.ratio);
        *self.slot_shared.lock().unwrap() = (rect, f64::from(window.scale_factor()));
        if let Some(presenter) = self.presenter.borrow_mut().as_mut() {
            presenter.set_placement(Placement {
                rect,
                scale: f64::from(window.scale_factor()),
            });
        }
        let (x, y, w, h) = (
            rect.x as f32,
            rect.y as f32,
            rect.width as f32,
            rect.height as f32,
        );
        let (vw, vh) = (f32::from(viewport.width), f32::from(viewport.height));
        let band = |left: f32, top: f32, width: f32, height: f32| {
            div()
                .absolute()
                .left(px(left))
                .top(px(top))
                .w(px(width.max(0.0)))
                .h(px(height.max(0.0)))
                .bg(pane())
        };
        let mut root = div()
            .size_full()
            .relative()
            .text_color(rgb(0xe8e8ee))
            .text_sm()
            // Sidebar.
            .child(
                div()
                    .absolute()
                    .left(px(0.))
                    .top(px(0.))
                    .w(px(SIDEBAR))
                    .h(px(vh))
                    .bg(rgb(0x202026))
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_4()
                    .child(div().text_lg().child("Videorc · S0.3"))
                    .child(div().text_color(rgb(0xa0a0b0)).child(self.backing.clone()))
                    .child(div().child("Scenes"))
                    .child(div().text_color(rgb(0xa0a0b0)).child("Camera + screen"))
                    .child(div().text_color(rgb(0xa0a0b0)).child("Just chatting")),
            )
            // Toolbar.
            .child(
                div()
                    .absolute()
                    .left(px(SIDEBAR))
                    .top(px(0.))
                    .w(px(vw - SIDEBAR))
                    .h(px(TOOLBAR))
                    .bg(rgb(0x1c1c21))
                    .flex()
                    .items_center()
                    .px_4()
                    .gap_3()
                    .child(div().child("Studio"))
                    .child(
                        div()
                            .px_3()
                            .py_1()
                            .rounded_md()
                            .bg(rgb(0xd92d3a))
                            .child("Record"),
                    ),
            )
            // The pane around the hole: four bands, the slot itself left
            // transparent so the video below shows through.
            .child(band(SIDEBAR, TOOLBAR, vw - SIDEBAR, y - TOOLBAR))
            .child(band(SIDEBAR, y + h, vw - SIDEBAR, vh - (y + h)))
            .child(band(SIDEBAR, y, x - SIDEBAR, h))
            .child(band(x + w, y, vw - (x + w), h))
            .children(self.frame.clone().map(|frame| {
                gpui::img(frame)
                    .absolute()
                    .left(px(x))
                    .top(px(y))
                    .w(px(w))
                    .h(px(h))
            }))
            // GPUI's paint counter: one paint per GPUI frame.
            .child(
                canvas(
                    |_, _, _| (),
                    |_, _, _, _| {
                        GPUI_PAINTS.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .absolute()
                .size(px(1.)),
            );
        if self.overlay {
            root = root.child(overlay_layer(x, y, w, h));
        }
        root
    }
}

fn run_app(args: Args) {
    let exe = std::env::current_exe().unwrap();
    let mut writer: Child = Command::new(exe)
        .args([
            "--writer",
            "--resolution",
            &format!("{}x{}", args.width, args.height),
            "--fps",
            &args.fps.to_string(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("writer");
    let writer_pid = writer.id();
    let mut line = String::new();
    BufReader::new(writer.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let parts: Vec<&str> = line.split_whitespace().collect();
    assert_eq!(parts.first(), Some(&"RING"), "writer said {line:?}");
    let handle = RingHandle {
        kind: "memfd-path",
        name: parts[2].to_string(),
        bytes: parts[3].parse().unwrap(),
    };
    let reader = Arc::new(RingReader::open(&handle).expect("open ring"));
    let writer_stdin: Rc<RefCell<Option<ChildStdin>>> = Rc::new(RefCell::new(writer.stdin.take()));
    let writer = Rc::new(RefCell::new(writer));

    crate::presenter::OPTIONS
        .set(crate::presenter::Options {
            below: !args.above,
            presentation: args.presentation,
        })
        .unwrap();

    let mut run = spike_summary::Run::start("spike-linux-preview");
    let started = Instant::now();
    application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1650.), px(1000.)), cx);
        let feed = Arc::new(Mutex::new(Feed::default()));
        let presenter_slot: Rc<RefCell<Option<Presenter>>> = Rc::new(RefCell::new(None));
        let backing_name = Rc::new(RefCell::new(String::new()));
        let slot_shared = Arc::new(Mutex::new((
            LayerRect { x: 0.0, y: 0.0, width: 1.0, height: 1.0 },
            1.0,
        )));
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_background: WindowBackgroundAppearance::Transparent,
                    app_id: Some("videorc-s0-3-spike".into()),
                    titlebar: None,
                    ..Default::default()
                },
                |window, cx| {
                    let attached = if args.route == "image" {
                        Err("route (d): frames as a GPUI image".to_string())
                    } else {
                        Presenter::attach(&*window)
                    };
                    let (backing, presenter) = match attached {
                        Ok(presenter) => {
                            let info = *reader.info();
                            let fd = reader.fd().try_clone_to_owned().expect("dup ring fd");
                            presenter.client().set_ring(Some(RingMapping { fd, info }));
                            spawn_feed(reader.clone(), presenter.client(), feed.clone());
                            (presenter.backing().as_str().to_string(), Some(presenter))
                        }
                        Err(error) => (format!("no presenter: {error}"), None),
                    };
                    eprintln!("[spike] backing: {backing}");
                    *backing_name.borrow_mut() = backing.clone();
                    *presenter_slot.borrow_mut() = presenter;
                    cx.new(|_| Spike {
                        slot_shared: slot_shared.clone(),
                        frame: None,
                        presenter: presenter_slot.clone(),
                        backing,
                        overlay: args.overlay && !args.overlay_window,
                        ratio: args.width as f32 / args.height as f32,
                    })
                },
            )
            .unwrap();
        cx.activate(true);
        eprintln!("[spike] window open after {:?}", started.elapsed());
        // X11: GPUI's overlay in its own override-redirect window over the
        // slot, opened once the main window has its real size. GPUI sizes it
        // (`Window::resize`); the tracker thread only moves it.
        let overlay_handle: Rc<RefCell<Option<gpui::WindowHandle<OverlayView>>>> =
            Rc::new(RefCell::new(None));
        if args.overlay_window && args.overlay {
            let overlay_handle = overlay_handle.clone();
            let slot_shared = slot_shared.clone();
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                let Ok((main_bounds, main_x11)) = window.update(cx, |_, window, _| {
                    (window.bounds(), x11_window_id(window))
                }) else {
                    return;
                };
                let (rect, _) = *slot_shared.lock().unwrap();
                let m = OVERLAY_MARGIN;
                let overlay_bounds = Bounds {
                    origin: gpui::point(
                        main_bounds.origin.x + px(rect.x as f32 - m),
                        main_bounds.origin.y + px(rect.y as f32 - m),
                    ),
                    size: size(
                        px(rect.width as f32 + 2.0 * m),
                        px(rect.height as f32 + 2.0 * m),
                    ),
                };
                let opened = cx.update(|cx| {
                    cx.open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(overlay_bounds)),
                            window_background: WindowBackgroundAppearance::Transparent,
                            kind: gpui::WindowKind::PopUp,
                            focus: false,
                            titlebar: None,
                            is_movable: false,
                            app_id: Some("videorc-s0-3-spike-overlay".into()),
                            ..Default::default()
                        },
                        |_, cx| {
                            cx.new(|_| OverlayView {
                                slot: slot_shared.clone(),
                            })
                        },
                    )
                });
                match opened {
                    Ok(overlay) => {
                        let overlay_x11 = overlay
                            .update(cx, |_, window, _| x11_window_id(window))
                            .ok()
                            .flatten();
                        eprintln!(
                            "[spike] overlay window: main x11 {main_x11:?} overlay x11 {overlay_x11:?}"
                        );
                        if let (Some(main), Some(over)) = (main_x11, overlay_x11) {
                            spawn_x11_overlay_tracker(main, over, slot_shared.clone());
                        }
                        *overlay_handle.borrow_mut() = Some(overlay);
                    }
                    Err(error) => spike_summary::error(format!("overlay window: {error}")),
                }
            })
            .detach();
        }
        if args.route == "image" {
            let (tx, mut rx) = futures::channel::mpsc::unbounded();
            spawn_image_feed(reader.clone(), feed.clone(), tx);
            let feed3 = feed.clone();
            cx.spawn(async move |cx| {
                use futures::StreamExt;
                while let Some((frame, mut sample)) = rx.next().await {
                    let result = window.update(cx, |view, window, cx| {
                        if let Some(old) = view.frame.replace(frame) {
                            let _ = window.drop_image(old);
                        }
                        cx.notify();
                    });
                    if result.is_err() {
                        break;
                    }
                    sample.committed_at = now_micros();
                    sample.reported_at = sample.committed_at;
                    sample.shown = true;
                    sample.released = true;
                    feed3.lock().unwrap().samples.push(sample);
                }
            })
            .detach();
        }

        let marks = Marks {
            reader: reader.clone(),
            writer_pid,
            compositor_pids: args.compositor_pids.clone(),
        };
        let args2 = args.clone();
        let feed2 = feed.clone();
        let presenter2 = presenter_slot.clone();
        let backing2 = backing_name.clone();
        let reader2 = reader.clone();
        let slot_for_summary = slot_shared.clone();
        let overlay_for_resize = overlay_handle.clone();
        let ratio = args.width as f32 / args.height as f32;
        cx.spawn(async move |cx| {
            let executor = cx.background_executor().clone();
            let timer = |s: f64| executor.timer(Duration::from_secs_f64(s));
            let send = |cmd: &str| {
                if let Some(stdin) = writer_stdin.borrow_mut().as_mut() {
                    let _ = writeln!(stdin, "{cmd}");
                    let _ = stdin.flush();
                }
            };
            timer(args2.warmup).await;
            let live_start = marks.take();
            eprintln!("[spike] live");
            timer(args2.live).await;
            let live_end = marks.take();
            send("pause");
            eprintln!("[spike] still");
            // Let the last in-flight frame land before the still phase.
            timer(0.5).await;
            let still_start = marks.take();
            timer(args2.still).await;
            let still_end = marks.take();
            send("resume");
            let mut phases = vec![
                ("live", live_start, live_end),
                ("still", still_start, still_end),
            ];
            if args2.resize > 0.0 {
                eprintln!("[spike] resize");
                let resize_start = marks.take();
                let steps = (args2.resize / 0.1) as usize;
                for step in 0..steps {
                    let size = if step % 2 == 0 {
                        size(px(1280.), px(800.))
                    } else {
                        size(px(1650.), px(1000.))
                    };
                    let _ = window.update(cx, |_, window, _| window.resize(size));
                    // The overlay window follows the slot's size (GPUI
                    // ignores a size set from outside).
                    let overlay = *overlay_for_resize.borrow();
                    if let Some(overlay) = overlay {
                        let viewport = size;
                        let rect = slot_rect(viewport, ratio);
                        let m = OVERLAY_MARGIN;
                        let _ = overlay.update(cx, |_, window, _| {
                            window.resize(gpui::size(
                                px(rect.width as f32 + 2.0 * m),
                                px(rect.height as f32 + 2.0 * m),
                            ))
                        });
                    }
                    timer(0.1).await;
                }
                let resize_end = marks.take();
                phases.push(("resize", resize_start, resize_end));
            }
            if args2.hold > 0.0 {
                eprintln!("[spike] hold");
                timer(args2.hold).await;
            }
            let text = {
                let feed = feed2.lock().unwrap();
                let phase_values: Vec<serde_json::Value> = phases
                    .iter()
                    .map(|(name, a, b)| phase_json(name, a, b, &feed))
                    .collect();
                let log = crate::presenter::PRESENTATION.lock().unwrap();
                let report = serde_json::json!({
                    "label": args2.label,
                    "session": if std::env::var_os("WAYLAND_DISPLAY").is_some() { "wayland" } else { "x11" },
                    "backing": *backing2.borrow(),
                    "subsurfaceBelowGpui": !args2.above,
                    "overlay": args2.overlay,
                    "overlayWindow": args2.overlay_window,
                    "route": args2.route,
                    "resolution": format!("{}x{}", args2.width, args2.height),
                    "fps": args2.fps,
                    "rssMb": (rss_mb() * 10.0).round() / 10.0,
                    "framesWritten": reader2.frames_written(),
                    "leasesMissed": feed.leases_missed,
                    "presentationClockId": log.clock_id,
                    "presentationDiscardedTotal": log.discarded,
                    "phases": phase_values,
                });
                serde_json::to_string_pretty(&report).unwrap()
            };
            let report: serde_json::Value = serde_json::from_str(&text).unwrap();
            fill_summary(&mut run, &args2, &report, &slot_for_summary);
            send("quit");
            drop(presenter2.borrow_mut().take());
            let _ = writer.borrow_mut().wait();
            cx.update(|cx| cx.quit());
            run.finish();
        })
        .detach();
    });
}
