use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::Utc;

use crate::ffmpeg_work::FfmpegWorkSnapshot;
use crate::frame_store::FrameStoreStats;
use crate::protocol::{
    CompositorBackend, DiagnosticBottleneck, DiagnosticStats, PermissionPane, PreviewCameraStatus,
    PreviewImagePollCounts, PreviewScreenStatus, PreviewSurfaceBacking, PreviewTransport,
    StreamHealth,
};
use crate::source_registry::SourceRegistrySnapshot;

/// Process-global request counters for the HTTP image-polling preview transports.
/// A truly OBS-native preview consumes the compositor surface directly and never hits
/// these routes, so a recording session in which these counters climb is — by
/// definition — NOT native (the transport-honesty gate). The "native-surface" label is
/// reserved for the real Metal layer; Electron proof surfaces report their own transport
/// so the badge cannot claim OBS-native parity early. Const-constructible, so it needs no
/// runtime init.
#[derive(Debug)]
pub struct PreviewTransportCounters {
    camera_png: AtomicU64,
    screen_png: AtomicU64,
    live_jpeg: AtomicU64,
    live_mjpeg: AtomicU64,
}

impl PreviewTransportCounters {
    const fn new() -> Self {
        Self {
            camera_png: AtomicU64::new(0),
            screen_png: AtomicU64::new(0),
            live_jpeg: AtomicU64::new(0),
            live_mjpeg: AtomicU64::new(0),
        }
    }

    pub fn record_camera_png(&self) {
        self.camera_png.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_screen_png(&self) {
        self.screen_png.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_live_jpeg(&self) {
        self.live_jpeg.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_live_mjpeg(&self) {
        self.live_mjpeg.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> PreviewImagePollCounts {
        PreviewImagePollCounts {
            camera_png: self.camera_png.load(Ordering::Relaxed),
            screen_png: self.screen_png.load(Ordering::Relaxed),
            live_jpeg: self.live_jpeg.load(Ordering::Relaxed),
            live_mjpeg: self.live_mjpeg.load(Ordering::Relaxed),
        }
    }
}

/// The single process-wide instance, incremented by the preview HTTP handlers and read
/// into every emitted [`DiagnosticStats`] by [`apply_runtime_resource_snapshot`].
pub static PREVIEW_POLL_COUNTS: PreviewTransportCounters = PreviewTransportCounters::new();

pub fn idle_diagnostics() -> DiagnosticStats {
    DiagnosticStats {
        session_id: None,
        active_output_mode: None,
        active_scene_revision: None,
        target_fps: None,
        capture_fps: None,
        render_fps: None,
        skipped_frames: 0,
        dropped_frames: 0,
        encoder_speed: None,
        encoder_bridge_queue_depth: 0,
        encoder_bridge_input_fps: None,
        encoder_bridge_dropped_frames: 0,
        encoder_bridge_repeated_frames: 0,
        encoder_bridge_synthetic_frames: 0,
        encoder_bridge_source_age_ms: None,
        encoder_bridge_error: None,
        encode_backend: None,
        compositor_backend: None,
        compositor_fallback_reason: None,
        compositor_cpu_fallback_frames: 0,
        preview_image_poll_counts: PreviewImagePollCounts::default(),
        preview_target_fps: None,
        preview_frame_age_ms: None,
        preview_transport: PreviewTransport::Unavailable,
        preview_source_fps: Default::default(),
        preview_surface_backing: PreviewSurfaceBacking::None,
        preview_present_fps: None,
        preview_input_to_present_latency_ms: None,
        preview_render_frame_time_p50_ms: None,
        preview_render_frame_time_p95_ms: None,
        preview_render_frame_time_p99_ms: None,
        preview_repeated_frames: 0,
        preview_surface_resize_count: 0,
        preview_latency_ms: None,
        preview_dropped_frames: 0,
        preview_camera_frame_age_ms: None,
        preview_camera_source_fps: None,
        preview_camera_dropped_frames: 0,
        preview_screen_frame_age_ms: None,
        preview_screen_source_fps: None,
        preview_screen_dropped_frames: 0,
        preview_source_frame_buffer_count: 0,
        preview_source_frame_bytes: 0,
        preview_source_frame_dropped_frames: 0,
        mic_captured_frames: None,
        mic_dropped_frames: 0,
        mic_capture_coverage: None,
        device_disconnected: false,
        backend_rss_bytes: None,
        active_ffmpeg_processes: 0,
        active_ffprobe_processes: 0,
        ffmpeg_capture_active: false,
        ffmpeg_finalizing_active: false,
        ffmpeg_maintenance_running: false,
        ffmpeg_maintenance_cancel_requested: false,
        ffmpeg_maintenance_deferred_reason: None,
        duplicate_capture_sources: Vec::new(),
        source_registry: SourceRegistrySnapshot::default(),
        bottleneck: DiagnosticBottleneck::None,
        recording_at_risk: false,
        recording_risk_reasons: Vec::new(),
        recording_protected: false,
        recording_startup_barrier_state: None,
        recording_startup_barrier_wait_ms: None,
        recording_startup_barrier_timeout_reason: None,
        first_source_frame_ms: None,
        first_full_resolution_compositor_frame_ms: None,
        first_encoded_frame_ms: None,
        updated_at: Utc::now().to_rfc3339(),
    }
}

pub fn apply_runtime_diagnostics_snapshot(
    stats: DiagnosticStats,
    snapshot: FfmpegWorkSnapshot,
) -> DiagnosticStats {
    apply_runtime_resource_snapshot(apply_ffmpeg_work_snapshot(stats, snapshot))
}

pub fn apply_ffmpeg_work_snapshot(
    mut stats: DiagnosticStats,
    snapshot: FfmpegWorkSnapshot,
) -> DiagnosticStats {
    stats.ffmpeg_capture_active = snapshot.capture_active;
    stats.ffmpeg_finalizing_active = snapshot.finalizing_active;
    stats.ffmpeg_maintenance_running = snapshot.maintenance_running;
    stats.ffmpeg_maintenance_cancel_requested = snapshot.maintenance_cancel_requested;
    stats.ffmpeg_maintenance_deferred_reason = snapshot
        .current_deferral()
        .map(|deferral| deferral.message().to_string());
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_runtime_resource_snapshot(mut stats: DiagnosticStats) -> DiagnosticStats {
    let snapshot = collect_runtime_resource_snapshot();
    stats.backend_rss_bytes = snapshot.backend_rss_bytes;
    stats.active_ffmpeg_processes = snapshot.active_ffmpeg_processes;
    stats.active_ffprobe_processes = snapshot.active_ffprobe_processes;
    stats.preview_image_poll_counts = PREVIEW_POLL_COUNTS.snapshot();
    let (at_risk, reasons) = classify_recording_risk(&stats);
    stats.recording_at_risk = at_risk;
    stats.recording_risk_reasons = reasons;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

/// Encoder must keep at least this fraction of real-time speed.
const RISK_ENCODER_SPEED_MIN: f64 = 0.98;
/// Mic capture coverage below this fraction during a run is a capture gap.
const RISK_MIC_COVERAGE_MIN: f64 = 0.95;

/// Whether an active recording session is currently being compromised, and why. Pure and
/// deterministic over the diagnostics, so it is unit-tested directly. Returns `(false, [])`
/// when no record/stream session is active — risk is only meaningful during capture.
///
/// Most signals here are cumulative over the run (dropped/duplicate/synthetic frames, mic
/// drops): once a recording HAS taken on a frame defect, it stays "at risk" so the app can
/// never silently present a compromised file as ready. `encoder_speed` and
/// `mic_capture_coverage` are point-in-time and reflect the current state.
pub fn classify_recording_risk(stats: &DiagnosticStats) -> (bool, Vec<String>) {
    let mut reasons = Vec::new();
    let recording = stats.active_output_mode.as_deref().is_some_and(|mode| {
        mode.contains("record") || mode.contains("stream") || mode == "encoder-bridge"
    });
    if !recording {
        return (false, reasons);
    }

    if let Some(speed) = stats.encoder_speed
        && speed < RISK_ENCODER_SPEED_MIN
    {
        reasons.push(format!("encoder behind real-time ({speed:.2}x)"));
    }
    if stats.dropped_frames > 0 {
        reasons.push(format!("encoder dropped {} frame(s)", stats.dropped_frames));
    }
    if stats.encoder_bridge_repeated_frames > 0 {
        reasons.push(format!(
            "{} duplicate frame(s) re-fed to the encoder (compositor under-run)",
            stats.encoder_bridge_repeated_frames
        ));
    }
    if stats.encoder_bridge_synthetic_frames > 0 {
        reasons.push(format!(
            "{} synthetic filler frame(s) fed (no real source ready)",
            stats.encoder_bridge_synthetic_frames
        ));
    }
    if stats.mic_dropped_frames > 0 {
        reasons.push(format!(
            "microphone dropped {} frame(s)",
            stats.mic_dropped_frames
        ));
    }
    if let Some(coverage) = stats.mic_capture_coverage
        && coverage < RISK_MIC_COVERAGE_MIN
    {
        reasons.push(format!(
            "microphone capture gap (coverage {:.0}%)",
            coverage * 100.0
        ));
    }
    if !stats.duplicate_capture_sources.is_empty() {
        reasons.push(format!(
            "duplicate capture of {}",
            stats.duplicate_capture_sources.join(", ")
        ));
    }

    (!reasons.is_empty(), reasons)
}

pub fn apply_duplicate_capture_sources(
    mut stats: DiagnosticStats,
    sources: Vec<String>,
) -> DiagnosticStats {
    stats.duplicate_capture_sources = sources;
    if !stats.duplicate_capture_sources.is_empty()
        && matches!(
            stats.bottleneck,
            DiagnosticBottleneck::None | DiagnosticBottleneck::Unknown
        )
    {
        stats.bottleneck = DiagnosticBottleneck::Capture;
    }
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_source_registry_snapshot(
    mut stats: DiagnosticStats,
    snapshot: SourceRegistrySnapshot,
) -> DiagnosticStats {
    stats.source_registry = snapshot;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn starting_diagnostics(
    session_id: &str,
    target_fps: u32,
    active_output_mode: &str,
) -> DiagnosticStats {
    DiagnosticStats {
        session_id: Some(session_id.to_string()),
        active_output_mode: Some(active_output_mode.to_string()),
        target_fps: Some(f64::from(target_fps)),
        bottleneck: DiagnosticBottleneck::Unknown,
        updated_at: Utc::now().to_rfc3339(),
        ..idle_diagnostics()
    }
}

pub fn apply_active_scene_revision(
    mut stats: DiagnosticStats,
    scene_revision: Option<u64>,
) -> DiagnosticStats {
    stats.active_scene_revision = scene_revision;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_stream_health(
    mut stats: DiagnosticStats,
    health: &StreamHealth,
    target_fps: u32,
) -> DiagnosticStats {
    stats.session_id = Some(health.session_id.clone());
    stats.target_fps = Some(f64::from(target_fps));
    if let Some(fps) = health.fps {
        stats.capture_fps = Some(fps);
        stats.render_fps = Some(fps);
    }
    if let Some(dropped_frames) = health.dropped_frames {
        stats.dropped_frames = dropped_frames;
        stats.skipped_frames = dropped_frames;
    }
    stats.encoder_speed = health.speed;
    stats.bottleneck = classify_bottleneck(
        stats.capture_fps,
        stats.render_fps,
        stats.encoder_speed,
        stats.dropped_frames,
        stats.mic_dropped_frames,
        target_fps,
        stats.device_disconnected,
    );
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

#[derive(Debug, Clone, PartialEq)]
pub struct EncoderBridgeDiagnosticSnapshot {
    pub queue_depth: u64,
    pub input_fps: Option<f64>,
    pub dropped_frames: u64,
    pub encoder_speed: Option<f64>,
    pub repeated_fed_frames: u64,
    pub synthetic_fallback_frames: u64,
    pub source_to_encode_age_ms: Option<u64>,
    pub error: Option<String>,
}

pub fn apply_encoder_bridge_stats(
    mut stats: DiagnosticStats,
    bridge: EncoderBridgeDiagnosticSnapshot,
    target_fps: u32,
) -> DiagnosticStats {
    stats.encoder_bridge_queue_depth = bridge.queue_depth;
    stats.encoder_bridge_input_fps = bridge.input_fps;
    stats.encoder_bridge_dropped_frames = bridge.dropped_frames;
    stats.encoder_bridge_repeated_frames = bridge.repeated_fed_frames;
    stats.encoder_bridge_synthetic_frames = bridge.synthetic_fallback_frames;
    stats.encoder_bridge_source_age_ms = bridge.source_to_encode_age_ms;
    stats.encoder_bridge_error = bridge.error;
    stats.capture_fps = stats.encoder_bridge_input_fps;
    stats.dropped_frames = bridge.dropped_frames;
    stats.skipped_frames = bridge.dropped_frames;
    if bridge.encoder_speed.is_some() {
        stats.encoder_speed = bridge.encoder_speed;
    }
    stats.bottleneck = classify_bottleneck(
        stats.capture_fps,
        stats.render_fps,
        stats.encoder_speed,
        stats.dropped_frames,
        stats.mic_dropped_frames,
        target_fps,
        stats.device_disconnected,
    );
    if stats.encoder_bridge_error.is_some() {
        stats.bottleneck = DiagnosticBottleneck::Encoder;
    }
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingStartupBarrierDiagnosticSnapshot {
    pub state: String,
    pub wait_ms: u64,
    pub timeout_reason: Option<String>,
    pub first_source_frame_ms: Option<u64>,
    pub first_full_resolution_compositor_frame_ms: Option<u64>,
    pub first_encoded_frame_ms: Option<u64>,
}

pub fn apply_recording_startup_barrier_stats(
    mut stats: DiagnosticStats,
    barrier: RecordingStartupBarrierDiagnosticSnapshot,
) -> DiagnosticStats {
    stats.recording_startup_barrier_state = Some(barrier.state);
    stats.recording_startup_barrier_wait_ms = Some(barrier.wait_ms);
    stats.recording_startup_barrier_timeout_reason = barrier.timeout_reason;
    stats.first_source_frame_ms = barrier.first_source_frame_ms;
    stats.first_full_resolution_compositor_frame_ms =
        barrier.first_full_resolution_compositor_frame_ms;
    stats.first_encoded_frame_ms = barrier.first_encoded_frame_ms;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_preview_camera_source_stats(
    mut stats: DiagnosticStats,
    status: &PreviewCameraStatus,
) -> DiagnosticStats {
    stats.preview_camera_frame_age_ms = status.frame_age_ms;
    stats.preview_camera_source_fps = status.source_fps;
    stats.preview_camera_dropped_frames = status.dropped_frames;
    if status.dropped_frames > 0 {
        stats.bottleneck = DiagnosticBottleneck::Capture;
    }
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_preview_screen_source_stats(
    mut stats: DiagnosticStats,
    status: &PreviewScreenStatus,
) -> DiagnosticStats {
    stats.preview_screen_frame_age_ms = status.frame_age_ms;
    stats.preview_screen_source_fps = status.source_fps;
    stats.preview_screen_dropped_frames = status.dropped_frames;
    if status.dropped_frames > 0 {
        stats.bottleneck = DiagnosticBottleneck::Capture;
    }
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_preview_source_frame_store_stats(
    mut stats: DiagnosticStats,
    camera: FrameStoreStats,
    screen: FrameStoreStats,
) -> DiagnosticStats {
    stats.preview_source_frame_buffer_count =
        camera.buffer_count.saturating_add(screen.buffer_count);
    stats.preview_source_frame_bytes = camera.bytes_retained.saturating_add(screen.bytes_retained);
    stats.preview_source_frame_dropped_frames =
        camera.frames_dropped.saturating_add(screen.frames_dropped);
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_preview_stats(
    mut stats: DiagnosticStats,
    preview_latency_ms: Option<u64>,
    preview_dropped_frames: u64,
    preview_target_fps: Option<f64>,
    preview_transport: PreviewTransport,
) -> DiagnosticStats {
    stats.preview_latency_ms = preview_latency_ms;
    stats.preview_dropped_frames = preview_dropped_frames;
    stats.preview_target_fps = preview_target_fps;
    stats.preview_transport = preview_transport;
    if let Some(preview_latency_ms) = preview_latency_ms {
        let fps = 1000.0 / preview_latency_ms.max(1) as f64;
        stats
            .preview_source_fps
            .insert("fallback-composite".to_string(), fps);
        stats.preview_render_frame_time_p50_ms = Some(preview_latency_ms as f64);
        stats.preview_render_frame_time_p95_ms = Some(preview_latency_ms as f64);
        stats.preview_render_frame_time_p99_ms = Some(preview_latency_ms as f64);
    }
    if preview_dropped_frames > 0 {
        stats.bottleneck = DiagnosticBottleneck::Preview;
    }
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_preview_frame_age(
    mut stats: DiagnosticStats,
    preview_frame_age_ms: u64,
    preview_present_fps: Option<f64>,
    preview_repeated_frames: u64,
) -> DiagnosticStats {
    stats.preview_frame_age_ms = Some(preview_frame_age_ms);
    stats.preview_input_to_present_latency_ms = Some(preview_frame_age_ms);
    stats.preview_present_fps = preview_present_fps;
    stats.preview_repeated_frames = preview_repeated_frames;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_preview_surface_resize(
    mut stats: DiagnosticStats,
    resize_count: u64,
) -> DiagnosticStats {
    stats.preview_surface_resize_count = resize_count;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

#[allow(clippy::too_many_arguments)]
pub fn apply_compositor_stats(
    mut stats: DiagnosticStats,
    target_fps: u32,
    preview_transport: PreviewTransport,
    preview_surface_backing: PreviewSurfaceBacking,
    compositor_backend: CompositorBackend,
    compositor_fallback_reason: Option<String>,
    compositor_cpu_fallback_frames: u64,
    render_fps: f64,
    frame_age_ms: u64,
    repeated_frames: u64,
    dropped_frames: u64,
    render_frame_time_p50_ms: f64,
    render_frame_time_p95_ms: f64,
    render_frame_time_p99_ms: f64,
) -> DiagnosticStats {
    stats.preview_target_fps = Some(f64::from(target_fps));
    stats.preview_frame_age_ms = Some(frame_age_ms);
    stats.preview_transport = preview_transport;
    stats.preview_surface_backing = preview_surface_backing;
    stats.compositor_backend = Some(compositor_backend);
    stats.compositor_fallback_reason = compositor_fallback_reason;
    stats.compositor_cpu_fallback_frames = compositor_cpu_fallback_frames;
    stats
        .preview_source_fps
        .insert("synthetic-compositor".to_string(), render_fps);
    stats.render_fps = Some(render_fps);
    stats.preview_present_fps = Some(render_fps);
    stats.preview_input_to_present_latency_ms = Some(frame_age_ms);
    stats.preview_render_frame_time_p50_ms = Some(render_frame_time_p50_ms);
    stats.preview_render_frame_time_p95_ms = Some(render_frame_time_p95_ms);
    stats.preview_render_frame_time_p99_ms = Some(render_frame_time_p99_ms);
    stats.preview_repeated_frames = repeated_frames;
    stats.preview_latency_ms = Some(frame_age_ms);
    stats.preview_dropped_frames = dropped_frames;
    stats.bottleneck = if render_fps < f64::from(target_fps) * 0.9 || dropped_frames > 0 {
        DiagnosticBottleneck::Preview
    } else {
        DiagnosticBottleneck::None
    };
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

/// Coverage at or below this fraction of real-time is treated as a mic capture gap.
const AUDIO_COVERAGE_MIN: f64 = 0.9;

pub fn apply_audio_stats(
    mut stats: DiagnosticStats,
    captured_frames: u64,
    dropped_frames: u64,
    capture_coverage: Option<f64>,
) -> DiagnosticStats {
    stats.mic_captured_frames = Some(captured_frames);
    stats.mic_dropped_frames = dropped_frames;
    // Only overwrite coverage when the sampler has a meaningful value (post-warmup), so a
    // final at-stop snapshot (None) preserves the last live reading.
    if capture_coverage.is_some() {
        stats.mic_capture_coverage = capture_coverage;
    }
    let coverage_gap = capture_coverage.is_some_and(|coverage| coverage < AUDIO_COVERAGE_MIN);
    if dropped_frames > 0 || coverage_gap {
        stats.bottleneck = DiagnosticBottleneck::Audio;
    }
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn classify_bottleneck(
    capture_fps: Option<f64>,
    render_fps: Option<f64>,
    encoder_speed: Option<f64>,
    dropped_frames: u64,
    mic_dropped_frames: u64,
    target_fps: u32,
    device_disconnected: bool,
) -> DiagnosticBottleneck {
    if device_disconnected {
        return DiagnosticBottleneck::Device;
    }
    if mic_dropped_frames > 0 {
        return DiagnosticBottleneck::Audio;
    }
    if encoder_speed.is_some_and(|speed| speed < 0.98) {
        return DiagnosticBottleneck::Encoder;
    }
    if capture_fps.is_some_and(|fps| fps < f64::from(target_fps) * 0.9) {
        return DiagnosticBottleneck::Capture;
    }
    if render_fps.is_some_and(|fps| fps < f64::from(target_fps) * 0.9) {
        return DiagnosticBottleneck::Render;
    }
    if dropped_frames > 0 {
        return DiagnosticBottleneck::Encoder;
    }
    if capture_fps.is_some() || render_fps.is_some() || encoder_speed.is_some() {
        return DiagnosticBottleneck::None;
    }

    DiagnosticBottleneck::Unknown
}

pub fn permission_pane_for_log(code: &str, message: &str) -> Option<PermissionPane> {
    let normalized = format!("{code} {message}").to_lowercase();
    if normalized.contains("screen")
        || normalized.contains("screencapture")
        || normalized.contains("screen capture")
        || normalized.contains("screen recording")
    {
        return Some(PermissionPane::ScreenRecording);
    }
    if normalized.contains("camera") || normalized.contains("video device") {
        return Some(PermissionPane::Camera);
    }
    if normalized.contains("microphone")
        || normalized.contains("mic")
        || normalized.contains("audio device")
    {
        return Some(PermissionPane::Microphone);
    }
    if normalized.contains("permission") || normalized.contains("privacy") {
        return Some(PermissionPane::Privacy);
    }

    None
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct RuntimeResourceSnapshot {
    backend_rss_bytes: Option<u64>,
    active_ffmpeg_processes: u64,
    active_ffprobe_processes: u64,
}

fn collect_runtime_resource_snapshot() -> RuntimeResourceSnapshot {
    RuntimeResourceSnapshot {
        backend_rss_bytes: backend_rss_bytes(),
        active_ffmpeg_processes: active_media_process_count("ffmpeg"),
        active_ffprobe_processes: active_media_process_count("ffprobe"),
    }
}

fn backend_rss_bytes() -> Option<u64> {
    let pid = std::process::id().to_string();
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let rss_kib = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(rss_kib.saturating_mul(1024))
}

fn active_media_process_count(name: &str) -> u64 {
    let output = match Command::new("ps").args(["-axo", "comm="]).output() {
        Ok(output) if output.status.success() => output,
        _ => return 0,
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| {
            Path::new(line.trim())
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .is_some_and(|file_name| file_name.eq_ignore_ascii_case(name))
        })
        .count() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_transport_counters_track_each_route_independently() {
        let counters = PreviewTransportCounters::new();
        counters.record_camera_png();
        counters.record_camera_png();
        counters.record_screen_png();
        counters.record_live_jpeg();
        counters.record_live_mjpeg();
        counters.record_live_mjpeg();
        counters.record_live_mjpeg();
        let snapshot = counters.snapshot();
        assert_eq!(snapshot.camera_png, 2);
        assert_eq!(snapshot.screen_png, 1);
        assert_eq!(snapshot.live_jpeg, 1);
        assert_eq!(snapshot.live_mjpeg, 3);
    }

    #[test]
    fn stream_health_updates_stats_and_classifies_encoder_lag() {
        let stats = apply_stream_health(
            idle_diagnostics(),
            &StreamHealth {
                session_id: "session".to_string(),
                fps: Some(29.7),
                dropped_frames: Some(4),
                speed: Some(0.82),
                created_at: "now".to_string(),
            },
            30,
        );

        assert_eq!(stats.session_id.as_deref(), Some("session"));
        assert_eq!(stats.capture_fps, Some(29.7));
        assert_eq!(stats.dropped_frames, 4);
        assert_eq!(stats.skipped_frames, 4);
        assert_eq!(stats.bottleneck, DiagnosticBottleneck::Encoder);
    }

    #[test]
    fn audio_drops_take_priority_over_video_stats() {
        let stats = apply_audio_stats(idle_diagnostics(), 48_000, 128, None);

        assert_eq!(stats.mic_captured_frames, Some(48_000));
        assert_eq!(stats.mic_dropped_frames, 128);
        assert_eq!(stats.bottleneck, DiagnosticBottleneck::Audio);
    }

    #[test]
    fn low_audio_capture_coverage_is_an_audio_bottleneck_even_without_drops() {
        let healthy = apply_audio_stats(idle_diagnostics(), 48_000, 0, Some(1.0));
        assert_eq!(healthy.mic_capture_coverage, Some(1.0));
        assert_ne!(healthy.bottleneck, DiagnosticBottleneck::Audio);

        let gap = apply_audio_stats(idle_diagnostics(), 24_000, 0, Some(0.5));
        assert_eq!(gap.mic_capture_coverage, Some(0.5));
        assert_eq!(gap.bottleneck, DiagnosticBottleneck::Audio);
    }

    #[test]
    fn recording_risk_is_off_when_idle_and_on_for_real_problems() {
        // Idle: never at risk.
        let (idle, reasons) = classify_recording_risk(&idle_diagnostics());
        assert!(!idle);
        assert!(reasons.is_empty());

        // Active record, clean: not at risk.
        let mut clean = starting_diagnostics("s", 30, "record");
        clean.encoder_speed = Some(1.0);
        let (risk, reasons) = classify_recording_risk(&clean);
        assert!(!risk, "clean run flagged: {reasons:?}");

        // Duplicate frames re-fed to the encoder → at risk.
        let mut compromised = starting_diagnostics("s", 30, "record");
        compromised.encoder_speed = Some(1.0);
        compromised.encoder_bridge_repeated_frames = 5;
        let (risk, reasons) = classify_recording_risk(&compromised);
        assert!(risk);
        assert!(reasons.iter().any(|reason| reason.contains("duplicate")));

        // Microphone capture gap → at risk.
        let mut gappy = starting_diagnostics("s", 30, "record");
        gappy.encoder_speed = Some(1.0);
        gappy.mic_capture_coverage = Some(0.5);
        let (risk, reasons) = classify_recording_risk(&gappy);
        assert!(risk);
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("microphone capture gap"))
        );
    }

    #[test]
    fn startup_barrier_stats_are_recorded_in_diagnostics() {
        let stats = apply_recording_startup_barrier_stats(
            starting_diagnostics("s", 30, "record"),
            RecordingStartupBarrierDiagnosticSnapshot {
                state: "ready".to_string(),
                wait_ms: 42,
                timeout_reason: None,
                first_source_frame_ms: Some(10),
                first_full_resolution_compositor_frame_ms: Some(20),
                first_encoded_frame_ms: Some(43),
            },
        );

        assert_eq!(
            stats.recording_startup_barrier_state.as_deref(),
            Some("ready")
        );
        assert_eq!(stats.recording_startup_barrier_wait_ms, Some(42));
        assert_eq!(stats.recording_startup_barrier_timeout_reason, None);
        assert_eq!(stats.first_source_frame_ms, Some(10));
        assert_eq!(stats.first_full_resolution_compositor_frame_ms, Some(20));
        assert_eq!(stats.first_encoded_frame_ms, Some(43));
    }

    #[test]
    fn permission_logs_map_to_specific_panes() {
        assert_eq!(
            permission_pane_for_log("screen-capture-fallback", "permission denied"),
            Some(PermissionPane::ScreenRecording)
        );
        assert_eq!(
            permission_pane_for_log("camera-source-unavailable", "camera permission denied"),
            Some(PermissionPane::Camera)
        );
        assert_eq!(
            permission_pane_for_log("audio-device", "microphone permission denied"),
            Some(PermissionPane::Microphone)
        );
    }

    #[test]
    fn idle_diagnostics_include_resource_and_preview_source_defaults() {
        let stats = idle_diagnostics();

        assert_eq!(stats.active_output_mode, None);
        assert_eq!(stats.active_scene_revision, None);
        assert_eq!(stats.encoder_bridge_queue_depth, 0);
        assert_eq!(stats.encoder_bridge_input_fps, None);
        assert_eq!(stats.encoder_bridge_dropped_frames, 0);
        assert_eq!(stats.encoder_bridge_error, None);
        assert_eq!(stats.compositor_backend, None);
        assert_eq!(stats.compositor_fallback_reason, None);
        assert_eq!(stats.compositor_cpu_fallback_frames, 0);
        assert_eq!(stats.preview_camera_frame_age_ms, None);
        assert_eq!(stats.preview_camera_source_fps, None);
        assert_eq!(stats.preview_camera_dropped_frames, 0);
        assert_eq!(stats.preview_screen_frame_age_ms, None);
        assert_eq!(stats.preview_screen_source_fps, None);
        assert_eq!(stats.preview_screen_dropped_frames, 0);
        assert_eq!(stats.preview_source_frame_buffer_count, 0);
        assert_eq!(stats.preview_source_frame_bytes, 0);
        assert_eq!(stats.preview_source_frame_dropped_frames, 0);
        assert_eq!(stats.backend_rss_bytes, None);
        assert_eq!(stats.active_ffmpeg_processes, 0);
        assert_eq!(stats.active_ffprobe_processes, 0);
        assert!(stats.duplicate_capture_sources.is_empty());
        assert!(stats.source_registry.entries.is_empty());
    }

    #[test]
    fn diagnostics_track_active_output_mode_and_scene_revision() {
        let stats = starting_diagnostics("session", 30, "record+stream");

        assert_eq!(stats.session_id.as_deref(), Some("session"));
        assert_eq!(stats.active_output_mode.as_deref(), Some("record+stream"));
        assert_eq!(stats.active_scene_revision, None);

        let stats = apply_active_scene_revision(stats, Some(42));

        assert_eq!(stats.active_output_mode.as_deref(), Some("record+stream"));
        assert_eq!(stats.active_scene_revision, Some(42));
    }

    #[test]
    fn compositor_stats_record_backend_and_fallback_reason() {
        let stats = apply_compositor_stats(
            idle_diagnostics(),
            30,
            PreviewTransport::ElectronProofSurface,
            PreviewSurfaceBacking::ElectronBrowserWindow,
            CompositorBackend::CpuFallback,
            Some("VIDEORC_METAL_COMPOSITOR disabled".to_string()),
            12,
            29.9,
            17,
            0,
            0,
            4.0,
            8.0,
            12.0,
        );

        assert_eq!(
            stats.compositor_backend,
            Some(CompositorBackend::CpuFallback)
        );
        assert_eq!(
            stats.compositor_fallback_reason.as_deref(),
            Some("VIDEORC_METAL_COMPOSITOR disabled")
        );
        assert_eq!(stats.compositor_cpu_fallback_frames, 12);
        assert_eq!(
            stats.preview_surface_backing,
            PreviewSurfaceBacking::ElectronBrowserWindow
        );
    }

    #[test]
    fn encoder_bridge_stats_feed_capture_and_encoder_health() {
        let stats = apply_encoder_bridge_stats(
            starting_diagnostics("bridge", 30, "encoder-bridge"),
            EncoderBridgeDiagnosticSnapshot {
                queue_depth: 1,
                input_fps: Some(29.8),
                dropped_frames: 0,
                encoder_speed: Some(1.02),
                repeated_fed_frames: 0,
                synthetic_fallback_frames: 0,
                source_to_encode_age_ms: None,
                error: None,
            },
            30,
        );

        assert_eq!(stats.encoder_bridge_queue_depth, 1);
        assert_eq!(stats.encoder_bridge_input_fps, Some(29.8));
        assert_eq!(stats.capture_fps, Some(29.8));
        assert_eq!(stats.encoder_speed, Some(1.02));
        assert_eq!(stats.bottleneck, DiagnosticBottleneck::None);

        let lagging = apply_encoder_bridge_stats(
            stats,
            EncoderBridgeDiagnosticSnapshot {
                queue_depth: 2,
                input_fps: Some(28.0),
                dropped_frames: 3,
                encoder_speed: Some(0.5),
                repeated_fed_frames: 5,
                synthetic_fallback_frames: 1,
                source_to_encode_age_ms: Some(40),
                error: None,
            },
            30,
        );

        assert_eq!(lagging.encoder_bridge_dropped_frames, 3);
        assert_eq!(lagging.encoder_bridge_repeated_frames, 5);
        assert_eq!(lagging.encoder_bridge_synthetic_frames, 1);
        assert_eq!(lagging.encoder_bridge_source_age_ms, Some(40));
        assert_eq!(lagging.bottleneck, DiagnosticBottleneck::Encoder);
    }
}
