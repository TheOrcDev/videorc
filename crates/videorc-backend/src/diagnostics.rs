use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use chrono::Utc;

use crate::ffmpeg_work::FfmpegWorkSnapshot;
use crate::frame_store::FrameStoreStats;
use crate::protocol::{
    CameraCapabilityFormat, CompositorBackend, DiagnosticBottleneck, DiagnosticStats,
    PermissionPane, PreviewCameraStatus, PreviewImagePollCounts, PreviewScreenStatus,
    PreviewSurfaceBacking, PreviewTransport, StreamHealth,
};
use crate::source_registry::SourceRegistrySnapshot;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CompositorSourceImportStats {
    pub iosurface_frames: u64,
    pub cvpixelbuffer_frames: u64,
    pub byte_upload_frames: u64,
    pub import_failures: u64,
    pub camera_iosurface_frames: u64,
    pub camera_cvpixelbuffer_frames: u64,
    pub camera_byte_upload_frames: u64,
    pub camera_import_failures: u64,
    pub screen_iosurface_frames: u64,
    pub screen_cvpixelbuffer_frames: u64,
    pub screen_byte_upload_frames: u64,
    pub screen_import_failures: u64,
    pub import_time_ms: f64,
}

impl CompositorSourceImportStats {
    pub fn merge(&mut self, other: Self) {
        self.iosurface_frames = self.iosurface_frames.saturating_add(other.iosurface_frames);
        self.cvpixelbuffer_frames = self
            .cvpixelbuffer_frames
            .saturating_add(other.cvpixelbuffer_frames);
        self.byte_upload_frames = self
            .byte_upload_frames
            .saturating_add(other.byte_upload_frames);
        self.import_failures = self.import_failures.saturating_add(other.import_failures);
        self.camera_iosurface_frames = self
            .camera_iosurface_frames
            .saturating_add(other.camera_iosurface_frames);
        self.camera_cvpixelbuffer_frames = self
            .camera_cvpixelbuffer_frames
            .saturating_add(other.camera_cvpixelbuffer_frames);
        self.camera_byte_upload_frames = self
            .camera_byte_upload_frames
            .saturating_add(other.camera_byte_upload_frames);
        self.camera_import_failures = self
            .camera_import_failures
            .saturating_add(other.camera_import_failures);
        self.screen_iosurface_frames = self
            .screen_iosurface_frames
            .saturating_add(other.screen_iosurface_frames);
        self.screen_cvpixelbuffer_frames = self
            .screen_cvpixelbuffer_frames
            .saturating_add(other.screen_cvpixelbuffer_frames);
        self.screen_byte_upload_frames = self
            .screen_byte_upload_frames
            .saturating_add(other.screen_byte_upload_frames);
        self.screen_import_failures = self
            .screen_import_failures
            .saturating_add(other.screen_import_failures);
        self.import_time_ms += other.import_time_ms;
    }
}

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
    production_png: AtomicU64,
    camera_bmp: AtomicU64,
    screen_bmp: AtomicU64,
    live_jpeg: AtomicU64,
    live_mjpeg: AtomicU64,
}

impl PreviewTransportCounters {
    const fn new() -> Self {
        Self {
            camera_png: AtomicU64::new(0),
            screen_png: AtomicU64::new(0),
            production_png: AtomicU64::new(0),
            camera_bmp: AtomicU64::new(0),
            screen_bmp: AtomicU64::new(0),
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

    pub fn record_production_png(&self) {
        self.production_png.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_camera_bmp(&self) {
        self.camera_bmp.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_screen_bmp(&self) {
        self.screen_bmp.fetch_add(1, Ordering::Relaxed);
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
            production_png: self.production_png.load(Ordering::Relaxed),
            camera_bmp: self.camera_bmp.load(Ordering::Relaxed),
            screen_bmp: self.screen_bmp.load(Ordering::Relaxed),
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
        encoder_bridge_output_queue_oldest_frame_age_ms: None,
        encoder_bridge_output_queue_capacity_pressure_events: 0,
        encoder_bridge_output_queue_dropped_frames: 0,
        encoder_bridge_input_fps: None,
        encoder_bridge_dropped_frames: 0,
        encoder_bridge_repeated_frames: 0,
        encoder_bridge_repeated_frame_bursts: 0,
        encoder_bridge_max_repeated_frame_run: 0,
        encoder_bridge_synthetic_frames: 0,
        encoder_bridge_source_age_ms: None,
        encoder_bridge_source_age_p95_ms: None,
        encoder_bridge_repeated_frame_age_p95_ms: None,
        encoder_bridge_repeated_frame_age_max_ms: None,
        encoder_bridge_metal_target_frames: 0,
        encoder_bridge_raw_video_copied_frames: 0,
        encoder_bridge_metal_target_copied_frames: 0,
        encoder_bridge_metal_target_handle_frames: 0,
        encoder_bridge_zero_copy_frames: 0,
        encoder_bridge_video_toolbox_probe_frames: 0,
        encoder_bridge_video_toolbox_probe_bytes: 0,
        encoder_bridge_video_toolbox_probe_errors: 0,
        encoder_bridge_video_toolbox_output_frames: 0,
        encoder_bridge_video_toolbox_output_bytes: 0,
        encoder_bridge_video_toolbox_output_encode_ms: None,
        recording_output_width: None,
        recording_output_height: None,
        recording_output_fps: None,
        recording_output_bitrate_kbps: None,
        stream_output_width: None,
        stream_output_height: None,
        stream_output_fps: None,
        stream_output_bitrate_kbps: None,
        encoder_bridge_active_video_toolbox_output_encoders: 0,
        encoder_bridge_recording_video_toolbox_output_frames: 0,
        encoder_bridge_recording_video_toolbox_output_bytes: 0,
        encoder_bridge_stream_video_toolbox_output_frames: 0,
        encoder_bridge_stream_video_toolbox_output_bytes: 0,
        encoder_bridge_separate_output_encoders_active: false,
        encoder_bridge_compositor_wait_p95_ms: None,
        encoder_bridge_video_toolbox_submit_p95_ms: None,
        encoder_bridge_raw_video_fifo_write_p95_ms: None,
        encoder_bridge_video_toolbox_fifo_write_p95_ms: None,
        encoder_bridge_video_toolbox_fifo_enqueue_p95_ms: None,
        encoder_bridge_video_toolbox_fifo_enqueue_max_ms: None,
        encoder_bridge_writer_loop_p95_ms: None,
        encoder_bridge_writer_sleep_p95_ms: None,
        encoder_bridge_writer_active_p95_ms: None,
        encoder_bridge_deadline_lag_p95_ms: None,
        encoder_bridge_deadline_lag_max_ms: None,
        encoder_bridge_late_deadline_ticks: 0,
        encoder_bridge_schedule_skipped_ms: 0,
        encoder_bridge_recording_input_fps: None,
        encoder_bridge_stream_input_fps: None,
        encoder_bridge_recording_queue_depth: 0,
        encoder_bridge_recording_queue_oldest_frame_age_ms: None,
        encoder_bridge_recording_queue_capacity_pressure_events: 0,
        encoder_bridge_recording_queue_dropped_frames: 0,
        encoder_bridge_stream_queue_depth: 0,
        encoder_bridge_stream_queue_oldest_frame_age_ms: None,
        encoder_bridge_stream_queue_capacity_pressure_events: 0,
        encoder_bridge_stream_queue_dropped_frames: 0,
        encoder_bridge_recording_writer_loop_p95_ms: None,
        encoder_bridge_stream_writer_loop_p95_ms: None,
        encoder_bridge_recording_writer_active_p95_ms: None,
        encoder_bridge_stream_writer_active_p95_ms: None,
        encoder_bridge_recording_video_toolbox_fifo_enqueue_p95_ms: None,
        encoder_bridge_stream_video_toolbox_fifo_enqueue_p95_ms: None,
        encoder_bridge_recording_video_toolbox_fifo_enqueue_max_ms: None,
        encoder_bridge_stream_video_toolbox_fifo_enqueue_max_ms: None,
        encoder_bridge_error: None,
        encode_backend: None,
        compositor_backend: None,
        compositor_fallback_reason: None,
        compositor_cpu_fallback_frames: 0,
        websocket_transport: Default::default(),
        preview_image_poll_counts: PreviewImagePollCounts::default(),
        preview_target_fps: None,
        preview_frame_age_ms: None,
        preview_transport: PreviewTransport::Unavailable,
        preview_source_fps: Default::default(),
        preview_surface_backing: PreviewSurfaceBacking::None,
        preview_frame_polling_suppressed: false,
        preview_source_pixels_present: false,
        preview_present_fps: None,
        preview_input_to_present_latency_ms: None,
        preview_input_to_present_latency_p50_ms: None,
        preview_input_to_present_latency_p95_ms: None,
        preview_input_to_present_latency_p99_ms: None,
        preview_compositor_frame_lag: None,
        preview_render_frame_time_p50_ms: None,
        preview_render_frame_time_p95_ms: None,
        preview_render_frame_time_p99_ms: None,
        compositor_source_fetch_p95_ms: None,
        compositor_scene_snapshot_p95_ms: None,
        compositor_camera_frame_fetch_p95_ms: None,
        compositor_screen_frame_fetch_p95_ms: None,
        compositor_gpu_prepare_p95_ms: None,
        compositor_gpu_source_texture_p95_ms: None,
        compositor_source_iosurface_import_frames: 0,
        compositor_source_cvpixelbuffer_import_frames: 0,
        compositor_source_byte_upload_frames: 0,
        compositor_source_import_failures: 0,
        compositor_camera_source_iosurface_import_frames: 0,
        compositor_camera_source_cvpixelbuffer_import_frames: 0,
        compositor_camera_source_byte_upload_frames: 0,
        compositor_camera_source_import_failures: 0,
        compositor_screen_source_iosurface_import_frames: 0,
        compositor_screen_source_cvpixelbuffer_import_frames: 0,
        compositor_screen_source_byte_upload_frames: 0,
        compositor_screen_source_import_failures: 0,
        compositor_source_import_p95_ms: None,
        compositor_gpu_command_wait_p95_ms: None,
        compositor_gpu_total_p95_ms: None,
        compositor_frame_store_publish_p95_ms: None,
        compositor_tick_gap_p95_ms: None,
        compositor_tick_gap_max_ms: None,
        compositor_live_source_refresh_p95_ms: None,
        compositor_preview_surface_progress_p95_ms: None,
        compositor_status_progress_p95_ms: None,
        compositor_preview_surface_lock_contentions: 0,
        compositor_status_lock_contentions: 0,
        compositor_camera_source_try_lock_misses: 0,
        compositor_screen_source_try_lock_misses: 0,
        compositor_camera_source_blocking_refreshes: 0,
        compositor_screen_source_blocking_refreshes: 0,
        preview_repeated_frames: 0,
        preview_surface_resize_count: 0,
        preview_latency_ms: None,
        preview_dropped_frames: 0,
        preview_camera_frame_age_ms: None,
        preview_camera_source_fps: None,
        preview_camera_dropped_frames: 0,
        preview_camera_state: None,
        preview_camera_device_unique_id: None,
        preview_camera_status_message: None,
        preview_camera_requested_width: None,
        preview_camera_requested_height: None,
        preview_camera_actual_width: None,
        preview_camera_actual_height: None,
        preview_camera_selected_format_width: None,
        preview_camera_selected_format_height: None,
        preview_camera_selected_format_min_fps: None,
        preview_camera_selected_format_max_fps: None,
        preview_camera_capability_device_id: None,
        preview_camera_capability_formats: Vec::new(),
        preview_camera_capability_error: None,
        preview_camera_capture_gap_p95_ms: None,
        preview_camera_capture_gap_p99_ms: None,
        preview_camera_capture_gap_max_ms: None,
        preview_camera_sample_pts_gap_p95_ms: None,
        preview_camera_sample_pts_gap_p99_ms: None,
        preview_camera_sample_pts_gap_max_ms: None,
        preview_camera_pixel_buffer_lock_p95_ms: None,
        preview_camera_row_copy_p95_ms: None,
        preview_camera_publish_p95_ms: None,
        preview_camera_frame_bytes: 0,
        preview_screen_frame_age_ms: None,
        preview_screen_source_fps: None,
        preview_screen_dropped_frames: 0,
        preview_screen_message: None,
        preview_screen_native_width: None,
        preview_screen_native_height: None,
        preview_screen_requested_width: None,
        preview_screen_requested_height: None,
        preview_screen_actual_width: None,
        preview_screen_actual_height: None,
        preview_screen_iosurface_available: None,
        preview_screen_capture_gap_p95_ms: None,
        preview_screen_capture_gap_max_ms: None,
        preview_screen_pixel_buffer_lock_p95_ms: None,
        preview_screen_row_copy_p95_ms: None,
        preview_screen_publish_p95_ms: None,
        preview_screen_frame_bytes: 0,
        preview_screen_capture_queue_depth: 0,
        preview_source_frame_buffer_count: 0,
        preview_source_frame_bytes: 0,
        preview_source_frame_dropped_frames: 0,
        mic_captured_frames: None,
        mic_dropped_frames: 0,
        mic_capture_coverage: None,
        mic_live_level: None,
        mic_live_peak_db: None,
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

pub fn apply_websocket_transport_stats(
    mut stats: DiagnosticStats,
    websocket_transport: crate::protocol::WebSocketTransportDiagnosticStats,
) -> DiagnosticStats {
    stats.websocket_transport = websocket_transport;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
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
    let snapshot = runtime_resource_sampler().snapshot();
    apply_runtime_resource_snapshot_value(&mut stats, snapshot);
    stats.preview_image_poll_counts = PREVIEW_POLL_COUNTS.snapshot();
    let (at_risk, reasons) = classify_recording_risk(&stats);
    stats.recording_at_risk = at_risk;
    stats.recording_risk_reasons = reasons;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

fn apply_runtime_resource_snapshot_value(
    stats: &mut DiagnosticStats,
    snapshot: RuntimeResourceSnapshot,
) {
    stats.backend_rss_bytes = snapshot.backend_rss_bytes;
    stats.active_ffmpeg_processes = snapshot.active_ffmpeg_processes;
    stats.active_ffprobe_processes = snapshot.active_ffprobe_processes;
}

/// Encoder must keep at least this fraction of real-time speed.
const RISK_ENCODER_SPEED_MIN: f64 = 0.98;
/// Mic capture coverage below this fraction during a run is a capture gap.
const RISK_MIC_COVERAGE_MIN: f64 = 0.95;
/// Video cadence below this fraction of target FPS is user-visible stutter/freeze.
const RISK_VIDEO_FPS_MIN_RATIO: f64 = 0.80;
/// Strict post-recording analysis treats freezes longer than this as quality defects.
const RISK_FRAME_FRESHNESS_BUDGET_MS: f64 = 100.0;
/// Writer work above this p95 budget means encoding/output is blocking frame cadence.
const RISK_WRITER_LOOP_BUDGET_MS: f64 = 100.0;

fn push_ms_budget_risk(
    reasons: &mut Vec<String>,
    label: &str,
    budget_ms: f64,
    metrics: &[(&str, Option<f64>)],
) {
    if !metrics
        .iter()
        .any(|(_, value)| value.is_some_and(|ms| ms > budget_ms))
    {
        return;
    }

    let detail = metrics
        .iter()
        .filter_map(|(name, value)| value.map(|ms| format!("{name} {ms:.0}ms")))
        .collect::<Vec<_>>()
        .join(", ");
    reasons.push(format!("{label} over {budget_ms:.0}ms budget ({detail})"));
}

fn push_video_cadence_risk(
    reasons: &mut Vec<String>,
    label: &str,
    target_fps: Option<f64>,
    actual_fps: Option<f64>,
) {
    let Some(target_fps) = target_fps.filter(|fps| fps.is_finite() && *fps > 0.0) else {
        return;
    };
    let Some(actual_fps) = actual_fps.filter(|fps| fps.is_finite() && *fps >= 0.0) else {
        return;
    };
    let floor = target_fps * RISK_VIDEO_FPS_MIN_RATIO;
    if actual_fps < floor {
        reasons.push(format!(
            "{label} video cadence {actual_fps:.1}fps below {floor:.1}fps floor for {target_fps:.0}fps target"
        ));
    }
}

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
    push_video_cadence_risk(
        &mut reasons,
        "capture",
        stats.target_fps,
        stats.capture_fps.or(stats.encoder_bridge_input_fps),
    );
    push_video_cadence_risk(&mut reasons, "render", stats.target_fps, stats.render_fps);
    push_video_cadence_risk(
        &mut reasons,
        "recording output",
        stats
            .recording_output_fps
            .map(f64::from)
            .or(stats.target_fps),
        stats.encoder_bridge_recording_input_fps,
    );
    push_video_cadence_risk(
        &mut reasons,
        "stream output",
        stats.stream_output_fps.map(f64::from).or(stats.target_fps),
        stats.encoder_bridge_stream_input_fps,
    );
    if stats.dropped_frames > 0 {
        reasons.push(format!("encoder dropped {} frame(s)", stats.dropped_frames));
    }
    let recording_queue_dropped_frames = if stats.encoder_bridge_recording_queue_dropped_frames > 0
    {
        stats.encoder_bridge_recording_queue_dropped_frames
    } else if !stats.encoder_bridge_separate_output_encoders_active
        && stats
            .active_output_mode
            .as_deref()
            .is_some_and(|mode| mode.contains("record"))
    {
        stats.encoder_bridge_output_queue_dropped_frames
    } else {
        0
    };
    if recording_queue_dropped_frames > 0 {
        reasons.push(format!(
            "recording output queue dropped {recording_queue_dropped_frames} frame(s) before delivery"
        ));
    }
    if stats.encoder_bridge_repeated_frames > 0 {
        let burst_detail = if stats.encoder_bridge_repeated_frame_bursts > 0
            || stats.encoder_bridge_max_repeated_frame_run > 0
        {
            format!(
                " across {} burst(s), max run {}",
                stats.encoder_bridge_repeated_frame_bursts,
                stats.encoder_bridge_max_repeated_frame_run
            )
        } else {
            String::new()
        };
        reasons.push(format!(
            "{} duplicate frame(s) re-fed to the encoder{burst_detail} (compositor under-run)",
            stats.encoder_bridge_repeated_frames
        ));
    }
    if stats.encoder_bridge_synthetic_frames > 0 {
        reasons.push(format!(
            "{} synthetic filler frame(s) fed (no real source ready)",
            stats.encoder_bridge_synthetic_frames
        ));
    }
    push_ms_budget_risk(
        &mut reasons,
        "encoder source freshness",
        RISK_FRAME_FRESHNESS_BUDGET_MS,
        &[
            ("p95 age", stats.encoder_bridge_source_age_p95_ms),
            (
                "latest age",
                stats
                    .encoder_bridge_source_age_ms
                    .map(|age_ms| age_ms as f64),
            ),
        ],
    );
    push_ms_budget_risk(
        &mut reasons,
        "compositor tick cadence",
        RISK_FRAME_FRESHNESS_BUDGET_MS,
        &[
            ("p95 gap", stats.compositor_tick_gap_p95_ms),
            ("max gap", stats.compositor_tick_gap_max_ms),
        ],
    );
    push_ms_budget_risk(
        &mut reasons,
        "encoder writer deadline",
        RISK_FRAME_FRESHNESS_BUDGET_MS,
        &[
            ("p95 lag", stats.encoder_bridge_deadline_lag_p95_ms),
            ("max lag", stats.encoder_bridge_deadline_lag_max_ms),
        ],
    );
    push_ms_budget_risk(
        &mut reasons,
        "encoder writer loop",
        RISK_WRITER_LOOP_BUDGET_MS,
        &[
            ("p95 total", stats.encoder_bridge_writer_loop_p95_ms),
            ("p95 active", stats.encoder_bridge_writer_active_p95_ms),
            (
                "p95 FIFO enqueue",
                stats.encoder_bridge_video_toolbox_fifo_enqueue_p95_ms,
            ),
            (
                "max FIFO enqueue",
                stats.encoder_bridge_video_toolbox_fifo_enqueue_max_ms,
            ),
        ],
    );
    push_ms_budget_risk(
        &mut reasons,
        "recording encoder writer loop",
        RISK_WRITER_LOOP_BUDGET_MS,
        &[
            (
                "p95 total",
                stats.encoder_bridge_recording_writer_loop_p95_ms,
            ),
            (
                "p95 active",
                stats.encoder_bridge_recording_writer_active_p95_ms,
            ),
            (
                "p95 FIFO enqueue",
                stats.encoder_bridge_recording_video_toolbox_fifo_enqueue_p95_ms,
            ),
            (
                "max FIFO enqueue",
                stats.encoder_bridge_recording_video_toolbox_fifo_enqueue_max_ms,
            ),
        ],
    );
    push_ms_budget_risk(
        &mut reasons,
        "stream encoder writer loop",
        RISK_WRITER_LOOP_BUDGET_MS,
        &[
            ("p95 total", stats.encoder_bridge_stream_writer_loop_p95_ms),
            (
                "p95 active",
                stats.encoder_bridge_stream_writer_active_p95_ms,
            ),
            (
                "p95 FIFO enqueue",
                stats.encoder_bridge_stream_video_toolbox_fifo_enqueue_p95_ms,
            ),
            (
                "max FIFO enqueue",
                stats.encoder_bridge_stream_video_toolbox_fifo_enqueue_max_ms,
            ),
        ],
    );
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
    pub output_queue_oldest_frame_age_ms: Option<u64>,
    pub output_queue_capacity_pressure_events: u64,
    pub output_queue_dropped_frames: u64,
    pub input_fps: Option<f64>,
    pub dropped_frames: u64,
    pub encoder_speed: Option<f64>,
    pub repeated_fed_frames: u64,
    pub repeated_frame_bursts: u64,
    pub max_repeated_frame_run: u64,
    pub synthetic_fallback_frames: u64,
    pub source_to_encode_age_ms: Option<u64>,
    pub source_to_encode_age_p95_ms: Option<f64>,
    pub repeated_frame_age_p95_ms: Option<f64>,
    pub repeated_frame_age_max_ms: Option<u64>,
    pub metal_target_frames: u64,
    pub raw_video_copied_frames: u64,
    pub metal_target_copied_frames: u64,
    pub metal_target_handle_frames: u64,
    pub zero_copy_frames: u64,
    pub video_toolbox_probe_frames: u64,
    pub video_toolbox_probe_bytes: u64,
    pub video_toolbox_probe_errors: u64,
    pub video_toolbox_output_frames: u64,
    pub video_toolbox_output_bytes: u64,
    pub video_toolbox_output_encode_ms: Option<u64>,
    pub recording_output_width: Option<u32>,
    pub recording_output_height: Option<u32>,
    pub recording_output_fps: Option<u32>,
    pub recording_output_bitrate_kbps: Option<u32>,
    pub stream_output_width: Option<u32>,
    pub stream_output_height: Option<u32>,
    pub stream_output_fps: Option<u32>,
    pub stream_output_bitrate_kbps: Option<u32>,
    pub active_video_toolbox_output_encoders: u64,
    pub recording_video_toolbox_output_frames: u64,
    pub recording_video_toolbox_output_bytes: u64,
    pub stream_video_toolbox_output_frames: u64,
    pub stream_video_toolbox_output_bytes: u64,
    pub separate_output_encoders_active: bool,
    pub compositor_wait_p95_ms: Option<f64>,
    pub video_toolbox_submit_p95_ms: Option<f64>,
    pub raw_video_fifo_write_p95_ms: Option<f64>,
    pub video_toolbox_fifo_write_p95_ms: Option<f64>,
    pub video_toolbox_fifo_enqueue_p95_ms: Option<f64>,
    pub video_toolbox_fifo_enqueue_max_ms: Option<f64>,
    pub writer_loop_p95_ms: Option<f64>,
    pub writer_sleep_p95_ms: Option<f64>,
    pub writer_active_p95_ms: Option<f64>,
    pub deadline_lag_p95_ms: Option<f64>,
    pub deadline_lag_max_ms: Option<f64>,
    pub late_deadline_ticks: u64,
    pub schedule_skipped_ms: u64,
    pub recording_input_fps: Option<f64>,
    pub stream_input_fps: Option<f64>,
    pub recording_queue_depth: u64,
    pub recording_queue_oldest_frame_age_ms: Option<u64>,
    pub recording_queue_capacity_pressure_events: u64,
    pub recording_queue_dropped_frames: u64,
    pub stream_queue_depth: u64,
    pub stream_queue_oldest_frame_age_ms: Option<u64>,
    pub stream_queue_capacity_pressure_events: u64,
    pub stream_queue_dropped_frames: u64,
    pub recording_writer_loop_p95_ms: Option<f64>,
    pub stream_writer_loop_p95_ms: Option<f64>,
    pub recording_writer_active_p95_ms: Option<f64>,
    pub stream_writer_active_p95_ms: Option<f64>,
    pub recording_video_toolbox_fifo_enqueue_p95_ms: Option<f64>,
    pub stream_video_toolbox_fifo_enqueue_p95_ms: Option<f64>,
    pub recording_video_toolbox_fifo_enqueue_max_ms: Option<f64>,
    pub stream_video_toolbox_fifo_enqueue_max_ms: Option<f64>,
    pub error: Option<String>,
}

pub fn apply_encoder_bridge_stats(
    mut stats: DiagnosticStats,
    bridge: EncoderBridgeDiagnosticSnapshot,
    target_fps: u32,
) -> DiagnosticStats {
    stats.encoder_bridge_queue_depth = bridge.queue_depth;
    stats.encoder_bridge_output_queue_oldest_frame_age_ms = bridge.output_queue_oldest_frame_age_ms;
    stats.encoder_bridge_output_queue_capacity_pressure_events =
        bridge.output_queue_capacity_pressure_events;
    stats.encoder_bridge_output_queue_dropped_frames = bridge.output_queue_dropped_frames;
    stats.encoder_bridge_input_fps = bridge.input_fps;
    stats.encoder_bridge_dropped_frames = bridge.dropped_frames;
    stats.encoder_bridge_repeated_frames = bridge.repeated_fed_frames;
    stats.encoder_bridge_repeated_frame_bursts = bridge.repeated_frame_bursts;
    stats.encoder_bridge_max_repeated_frame_run = bridge.max_repeated_frame_run;
    stats.encoder_bridge_synthetic_frames = bridge.synthetic_fallback_frames;
    stats.encoder_bridge_source_age_ms = bridge.source_to_encode_age_ms;
    stats.encoder_bridge_source_age_p95_ms = bridge.source_to_encode_age_p95_ms;
    stats.encoder_bridge_repeated_frame_age_p95_ms = bridge.repeated_frame_age_p95_ms;
    stats.encoder_bridge_repeated_frame_age_max_ms = bridge.repeated_frame_age_max_ms;
    stats.encoder_bridge_metal_target_frames = bridge.metal_target_frames;
    stats.encoder_bridge_raw_video_copied_frames = bridge.raw_video_copied_frames;
    stats.encoder_bridge_metal_target_copied_frames = bridge.metal_target_copied_frames;
    stats.encoder_bridge_metal_target_handle_frames = bridge.metal_target_handle_frames;
    stats.encoder_bridge_zero_copy_frames = bridge.zero_copy_frames;
    stats.encoder_bridge_video_toolbox_probe_frames = bridge.video_toolbox_probe_frames;
    stats.encoder_bridge_video_toolbox_probe_bytes = bridge.video_toolbox_probe_bytes;
    stats.encoder_bridge_video_toolbox_probe_errors = bridge.video_toolbox_probe_errors;
    stats.encoder_bridge_video_toolbox_output_frames = bridge.video_toolbox_output_frames;
    stats.encoder_bridge_video_toolbox_output_bytes = bridge.video_toolbox_output_bytes;
    stats.encoder_bridge_video_toolbox_output_encode_ms = bridge.video_toolbox_output_encode_ms;
    stats.recording_output_width = bridge.recording_output_width;
    stats.recording_output_height = bridge.recording_output_height;
    stats.recording_output_fps = bridge.recording_output_fps;
    stats.recording_output_bitrate_kbps = bridge.recording_output_bitrate_kbps;
    stats.stream_output_width = bridge.stream_output_width;
    stats.stream_output_height = bridge.stream_output_height;
    stats.stream_output_fps = bridge.stream_output_fps;
    stats.stream_output_bitrate_kbps = bridge.stream_output_bitrate_kbps;
    stats.encoder_bridge_active_video_toolbox_output_encoders =
        bridge.active_video_toolbox_output_encoders;
    stats.encoder_bridge_recording_video_toolbox_output_frames =
        bridge.recording_video_toolbox_output_frames;
    stats.encoder_bridge_recording_video_toolbox_output_bytes =
        bridge.recording_video_toolbox_output_bytes;
    stats.encoder_bridge_stream_video_toolbox_output_frames =
        bridge.stream_video_toolbox_output_frames;
    stats.encoder_bridge_stream_video_toolbox_output_bytes =
        bridge.stream_video_toolbox_output_bytes;
    stats.encoder_bridge_separate_output_encoders_active = bridge.separate_output_encoders_active;
    stats.encoder_bridge_compositor_wait_p95_ms = bridge.compositor_wait_p95_ms;
    stats.encoder_bridge_video_toolbox_submit_p95_ms = bridge.video_toolbox_submit_p95_ms;
    stats.encoder_bridge_raw_video_fifo_write_p95_ms = bridge.raw_video_fifo_write_p95_ms;
    stats.encoder_bridge_video_toolbox_fifo_write_p95_ms = bridge.video_toolbox_fifo_write_p95_ms;
    stats.encoder_bridge_video_toolbox_fifo_enqueue_p95_ms =
        bridge.video_toolbox_fifo_enqueue_p95_ms;
    stats.encoder_bridge_video_toolbox_fifo_enqueue_max_ms =
        bridge.video_toolbox_fifo_enqueue_max_ms;
    stats.encoder_bridge_writer_loop_p95_ms = bridge.writer_loop_p95_ms;
    stats.encoder_bridge_writer_sleep_p95_ms = bridge.writer_sleep_p95_ms;
    stats.encoder_bridge_writer_active_p95_ms = bridge.writer_active_p95_ms;
    stats.encoder_bridge_deadline_lag_p95_ms = bridge.deadline_lag_p95_ms;
    stats.encoder_bridge_deadline_lag_max_ms = bridge.deadline_lag_max_ms;
    stats.encoder_bridge_late_deadline_ticks = bridge.late_deadline_ticks;
    stats.encoder_bridge_schedule_skipped_ms = bridge.schedule_skipped_ms;
    stats.encoder_bridge_recording_input_fps = bridge.recording_input_fps;
    stats.encoder_bridge_stream_input_fps = bridge.stream_input_fps;
    stats.encoder_bridge_recording_queue_depth = bridge.recording_queue_depth;
    stats.encoder_bridge_recording_queue_oldest_frame_age_ms =
        bridge.recording_queue_oldest_frame_age_ms;
    stats.encoder_bridge_recording_queue_capacity_pressure_events =
        bridge.recording_queue_capacity_pressure_events;
    stats.encoder_bridge_recording_queue_dropped_frames = bridge.recording_queue_dropped_frames;
    stats.encoder_bridge_stream_queue_depth = bridge.stream_queue_depth;
    stats.encoder_bridge_stream_queue_oldest_frame_age_ms = bridge.stream_queue_oldest_frame_age_ms;
    stats.encoder_bridge_stream_queue_capacity_pressure_events =
        bridge.stream_queue_capacity_pressure_events;
    stats.encoder_bridge_stream_queue_dropped_frames = bridge.stream_queue_dropped_frames;
    stats.encoder_bridge_recording_writer_loop_p95_ms = bridge.recording_writer_loop_p95_ms;
    stats.encoder_bridge_stream_writer_loop_p95_ms = bridge.stream_writer_loop_p95_ms;
    stats.encoder_bridge_recording_writer_active_p95_ms = bridge.recording_writer_active_p95_ms;
    stats.encoder_bridge_stream_writer_active_p95_ms = bridge.stream_writer_active_p95_ms;
    stats.encoder_bridge_recording_video_toolbox_fifo_enqueue_p95_ms =
        bridge.recording_video_toolbox_fifo_enqueue_p95_ms;
    stats.encoder_bridge_stream_video_toolbox_fifo_enqueue_p95_ms =
        bridge.stream_video_toolbox_fifo_enqueue_p95_ms;
    stats.encoder_bridge_recording_video_toolbox_fifo_enqueue_max_ms =
        bridge.recording_video_toolbox_fifo_enqueue_max_ms;
    stats.encoder_bridge_stream_video_toolbox_fifo_enqueue_max_ms =
        bridge.stream_video_toolbox_fifo_enqueue_max_ms;
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
    stats.preview_camera_state = Some(status.state.clone());
    stats.preview_camera_device_unique_id = status.device_unique_id.clone();
    stats.preview_camera_status_message = status.message.clone();
    stats.preview_camera_requested_width = status.requested_width;
    stats.preview_camera_requested_height = status.requested_height;
    stats.preview_camera_actual_width = status.actual_width;
    stats.preview_camera_actual_height = status.actual_height;
    stats.preview_camera_selected_format_width = status.selected_format_width;
    stats.preview_camera_selected_format_height = status.selected_format_height;
    stats.preview_camera_selected_format_min_fps = status.selected_format_min_fps;
    stats.preview_camera_selected_format_max_fps = status.selected_format_max_fps;
    if status.dropped_frames > 0 {
        stats.bottleneck = DiagnosticBottleneck::Capture;
    }
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_preview_camera_capability_stats(
    mut stats: DiagnosticStats,
    camera_id: Option<String>,
    formats: Vec<CameraCapabilityFormat>,
    error: Option<String>,
) -> DiagnosticStats {
    stats.preview_camera_capability_device_id = camera_id;
    stats.preview_camera_capability_formats = formats;
    stats.preview_camera_capability_error = error;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PreviewCameraCaptureTimingStats {
    pub capture_gap_p95_ms: Option<f64>,
    pub capture_gap_p99_ms: Option<f64>,
    pub capture_gap_max_ms: Option<f64>,
    pub sample_pts_gap_p95_ms: Option<f64>,
    pub sample_pts_gap_p99_ms: Option<f64>,
    pub sample_pts_gap_max_ms: Option<f64>,
    pub pixel_buffer_lock_p95_ms: Option<f64>,
    pub row_copy_p95_ms: Option<f64>,
    pub publish_p95_ms: Option<f64>,
    pub frame_bytes: u64,
}

pub fn apply_preview_camera_capture_timing_stats(
    mut stats: DiagnosticStats,
    timings: PreviewCameraCaptureTimingStats,
) -> DiagnosticStats {
    stats.preview_camera_capture_gap_p95_ms = timings.capture_gap_p95_ms;
    stats.preview_camera_capture_gap_p99_ms = timings.capture_gap_p99_ms;
    stats.preview_camera_capture_gap_max_ms = timings.capture_gap_max_ms;
    stats.preview_camera_sample_pts_gap_p95_ms = timings.sample_pts_gap_p95_ms;
    stats.preview_camera_sample_pts_gap_p99_ms = timings.sample_pts_gap_p99_ms;
    stats.preview_camera_sample_pts_gap_max_ms = timings.sample_pts_gap_max_ms;
    stats.preview_camera_pixel_buffer_lock_p95_ms = timings.pixel_buffer_lock_p95_ms;
    stats.preview_camera_row_copy_p95_ms = timings.row_copy_p95_ms;
    stats.preview_camera_publish_p95_ms = timings.publish_p95_ms;
    stats.preview_camera_frame_bytes = timings.frame_bytes;
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
    stats.preview_screen_message = status.message.clone();
    stats.preview_screen_native_width = status.native_width;
    stats.preview_screen_native_height = status.native_height;
    stats.preview_screen_requested_width = status.requested_width;
    stats.preview_screen_requested_height = status.requested_height;
    stats.preview_screen_actual_width = status.actual_width;
    stats.preview_screen_actual_height = status.actual_height;
    stats.preview_screen_iosurface_available = status.iosurface_available;
    if status.dropped_frames > 0 {
        stats.bottleneck = DiagnosticBottleneck::Capture;
    }
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PreviewScreenCaptureTimingStats {
    pub capture_gap_p95_ms: Option<f64>,
    pub capture_gap_max_ms: Option<f64>,
    pub pixel_buffer_lock_p95_ms: Option<f64>,
    pub row_copy_p95_ms: Option<f64>,
    pub publish_p95_ms: Option<f64>,
    pub frame_bytes: u64,
    pub capture_queue_depth: u32,
}

pub fn apply_preview_screen_capture_timing_stats(
    mut stats: DiagnosticStats,
    timings: PreviewScreenCaptureTimingStats,
) -> DiagnosticStats {
    stats.preview_screen_capture_gap_p95_ms = timings.capture_gap_p95_ms;
    stats.preview_screen_capture_gap_max_ms = timings.capture_gap_max_ms;
    stats.preview_screen_pixel_buffer_lock_p95_ms = timings.pixel_buffer_lock_p95_ms;
    stats.preview_screen_row_copy_p95_ms = timings.row_copy_p95_ms;
    stats.preview_screen_publish_p95_ms = timings.publish_p95_ms;
    stats.preview_screen_frame_bytes = timings.frame_bytes;
    stats.preview_screen_capture_queue_depth = timings.capture_queue_depth;
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
        stats.preview_input_to_present_latency_p50_ms = Some(preview_latency_ms);
        stats.preview_input_to_present_latency_p95_ms = Some(preview_latency_ms);
        stats.preview_input_to_present_latency_p99_ms = Some(preview_latency_ms);
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
    stats.preview_input_to_present_latency_p50_ms = Some(preview_frame_age_ms);
    stats.preview_input_to_present_latency_p95_ms = Some(preview_frame_age_ms);
    stats.preview_input_to_present_latency_p99_ms = Some(preview_frame_age_ms);
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
    let preview_presenting = preview_transport.is_surface();
    stats.preview_target_fps = preview_presenting.then_some(f64::from(target_fps));
    stats.preview_frame_age_ms = preview_presenting.then_some(frame_age_ms);
    stats.preview_transport = preview_transport;
    stats.preview_surface_backing = preview_surface_backing;
    if !preview_presenting {
        stats.preview_frame_polling_suppressed = false;
        stats.preview_source_pixels_present = false;
    }
    stats.compositor_backend = Some(compositor_backend);
    stats.compositor_fallback_reason = compositor_fallback_reason;
    stats.compositor_cpu_fallback_frames = compositor_cpu_fallback_frames;
    stats
        .preview_source_fps
        .insert("synthetic-compositor".to_string(), render_fps);
    stats.render_fps = Some(render_fps);
    stats.preview_present_fps = preview_presenting.then_some(render_fps);
    stats.preview_input_to_present_latency_ms = preview_presenting.then_some(frame_age_ms);
    stats.preview_input_to_present_latency_p50_ms = preview_presenting.then_some(frame_age_ms);
    stats.preview_input_to_present_latency_p95_ms = preview_presenting.then_some(frame_age_ms);
    stats.preview_input_to_present_latency_p99_ms = preview_presenting.then_some(frame_age_ms);
    stats.preview_render_frame_time_p50_ms = preview_presenting.then_some(render_frame_time_p50_ms);
    stats.preview_render_frame_time_p95_ms = preview_presenting.then_some(render_frame_time_p95_ms);
    stats.preview_render_frame_time_p99_ms = preview_presenting.then_some(render_frame_time_p99_ms);
    stats.preview_repeated_frames = if preview_presenting {
        repeated_frames
    } else {
        0
    };
    stats.preview_latency_ms = preview_presenting.then_some(frame_age_ms);
    stats.preview_dropped_frames = if preview_presenting {
        dropped_frames
    } else {
        0
    };
    stats.bottleneck =
        if preview_presenting && (render_fps < f64::from(target_fps) * 0.9 || dropped_frames > 0) {
            DiagnosticBottleneck::Preview
        } else {
            DiagnosticBottleneck::None
        };
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

#[allow(clippy::too_many_arguments)]
pub fn apply_compositor_timing_stats(
    mut stats: DiagnosticStats,
    source_fetch_p95_ms: f64,
    scene_snapshot_p95_ms: f64,
    camera_frame_fetch_p95_ms: f64,
    screen_frame_fetch_p95_ms: f64,
    gpu_prepare_p95_ms: f64,
    gpu_source_texture_p95_ms: f64,
    gpu_command_wait_p95_ms: f64,
    gpu_total_p95_ms: f64,
    frame_store_publish_p95_ms: f64,
    tick_gap_p95_ms: f64,
    tick_gap_max_ms: f64,
) -> DiagnosticStats {
    stats.compositor_source_fetch_p95_ms = Some(source_fetch_p95_ms);
    stats.compositor_scene_snapshot_p95_ms = Some(scene_snapshot_p95_ms);
    stats.compositor_camera_frame_fetch_p95_ms = Some(camera_frame_fetch_p95_ms);
    stats.compositor_screen_frame_fetch_p95_ms = Some(screen_frame_fetch_p95_ms);
    stats.compositor_gpu_prepare_p95_ms = Some(gpu_prepare_p95_ms);
    stats.compositor_gpu_source_texture_p95_ms = Some(gpu_source_texture_p95_ms);
    stats.compositor_gpu_command_wait_p95_ms = Some(gpu_command_wait_p95_ms);
    stats.compositor_gpu_total_p95_ms = Some(gpu_total_p95_ms);
    stats.compositor_frame_store_publish_p95_ms = Some(frame_store_publish_p95_ms);
    stats.compositor_tick_gap_p95_ms = Some(tick_gap_p95_ms);
    stats.compositor_tick_gap_max_ms = Some(tick_gap_max_ms);
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

pub fn apply_compositor_source_import_stats(
    mut stats: DiagnosticStats,
    source_import: CompositorSourceImportStats,
    source_import_p95_ms: f64,
) -> DiagnosticStats {
    stats.compositor_source_iosurface_import_frames = source_import.iosurface_frames;
    stats.compositor_source_cvpixelbuffer_import_frames = source_import.cvpixelbuffer_frames;
    stats.compositor_source_byte_upload_frames = source_import.byte_upload_frames;
    stats.compositor_source_import_failures = source_import.import_failures;
    stats.compositor_camera_source_iosurface_import_frames = source_import.camera_iosurface_frames;
    stats.compositor_camera_source_cvpixelbuffer_import_frames =
        source_import.camera_cvpixelbuffer_frames;
    stats.compositor_camera_source_byte_upload_frames = source_import.camera_byte_upload_frames;
    stats.compositor_camera_source_import_failures = source_import.camera_import_failures;
    stats.compositor_screen_source_iosurface_import_frames = source_import.screen_iosurface_frames;
    stats.compositor_screen_source_cvpixelbuffer_import_frames =
        source_import.screen_cvpixelbuffer_frames;
    stats.compositor_screen_source_byte_upload_frames = source_import.screen_byte_upload_frames;
    stats.compositor_screen_source_import_failures = source_import.screen_import_failures;
    stats.compositor_source_import_p95_ms = Some(source_import_p95_ms);
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

#[derive(Debug, Clone, Default)]
pub struct CompositorOutsideRenderTimingStats {
    pub live_source_refresh_p95_ms: Option<f64>,
    pub preview_surface_progress_p95_ms: Option<f64>,
    pub compositor_status_progress_p95_ms: Option<f64>,
    pub preview_surface_lock_contentions: u64,
    pub compositor_status_lock_contentions: u64,
}

pub fn apply_compositor_outside_render_timing_stats(
    mut stats: DiagnosticStats,
    timings: CompositorOutsideRenderTimingStats,
) -> DiagnosticStats {
    stats.compositor_live_source_refresh_p95_ms = timings.live_source_refresh_p95_ms;
    stats.compositor_preview_surface_progress_p95_ms = timings.preview_surface_progress_p95_ms;
    stats.compositor_status_progress_p95_ms = timings.compositor_status_progress_p95_ms;
    stats.compositor_preview_surface_lock_contentions = timings.preview_surface_lock_contentions;
    stats.compositor_status_lock_contentions = timings.compositor_status_lock_contentions;
    stats.updated_at = Utc::now().to_rfc3339();
    stats
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CompositorLiveSourceFetchStats {
    pub camera_try_lock_misses: u64,
    pub screen_try_lock_misses: u64,
    pub camera_blocking_refreshes: u64,
    pub screen_blocking_refreshes: u64,
}

pub fn apply_compositor_live_source_fetch_stats(
    mut stats: DiagnosticStats,
    fetch: CompositorLiveSourceFetchStats,
) -> DiagnosticStats {
    stats.compositor_camera_source_try_lock_misses = fetch.camera_try_lock_misses;
    stats.compositor_screen_source_try_lock_misses = fetch.screen_try_lock_misses;
    stats.compositor_camera_source_blocking_refreshes = fetch.camera_blocking_refreshes;
    stats.compositor_screen_source_blocking_refreshes = fetch.screen_blocking_refreshes;
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
    live_peak: Option<f32>,
) -> DiagnosticStats {
    stats.mic_captured_frames = Some(captured_frames);
    stats.mic_dropped_frames = dropped_frames;
    // Live meter reading for the Studio mixer: derived from frames the session
    // already captures (no extra device open). None clears the meter at stop.
    match live_peak {
        Some(peak) => {
            let peak_db = crate::audio::amplitude_to_db(peak);
            stats.mic_live_peak_db = Some(f64::from(peak_db));
            stats.mic_live_level = Some(crate::audio::db_to_level(peak_db));
        }
        None => {
            stats.mic_live_peak_db = None;
            stats.mic_live_level = None;
        }
    }
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

const RUNTIME_RESOURCE_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug)]
struct RuntimeResourceSampler {
    latest: Arc<RwLock<RuntimeResourceSnapshot>>,
}

impl RuntimeResourceSampler {
    fn start() -> Self {
        let latest = Arc::new(RwLock::new(RuntimeResourceSnapshot::default()));
        let writer = Arc::clone(&latest);
        std::thread::Builder::new()
            .name("videorc-resource-sampler".to_string())
            .spawn(move || {
                loop {
                    let next = collect_runtime_resource_snapshot();
                    *writer
                        .write()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
                    std::thread::sleep(RUNTIME_RESOURCE_SAMPLE_INTERVAL);
                }
            })
            .expect("runtime resource sampler thread should start");
        Self { latest }
    }

    fn snapshot(&self) -> RuntimeResourceSnapshot {
        self.latest
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

static RUNTIME_RESOURCE_SAMPLER: OnceLock<RuntimeResourceSampler> = OnceLock::new();

fn runtime_resource_sampler() -> &'static RuntimeResourceSampler {
    RUNTIME_RESOURCE_SAMPLER.get_or_init(RuntimeResourceSampler::start)
}

/// Starts the process-wide sampler before request handling begins. Runtime diagnostics then
/// perform only a cached read: preview-present reports never launch `ps` themselves.
pub fn start_runtime_resource_sampler() {
    let _ = runtime_resource_sampler();
}

fn collect_runtime_resource_snapshot() -> RuntimeResourceSnapshot {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,comm="])
        .output();
    let output = match output {
        Ok(output) if output.status.success() => output,
        _ => return RuntimeResourceSnapshot::default(),
    };
    parse_runtime_resource_snapshot(&String::from_utf8_lossy(&output.stdout), std::process::id())
}

#[derive(Debug)]
struct ProcessSampleRow {
    pid: u32,
    parent_pid: u32,
    rss_kib: u64,
    command: String,
}

fn parse_runtime_resource_snapshot(output: &str, backend_pid: u32) -> RuntimeResourceSnapshot {
    let rows = output
        .lines()
        .filter_map(parse_process_sample_row)
        .collect::<Vec<_>>();
    let mut owned_pids = std::collections::HashSet::from([backend_pid]);
    loop {
        let previous_len = owned_pids.len();
        for row in &rows {
            if owned_pids.contains(&row.parent_pid) {
                owned_pids.insert(row.pid);
            }
        }
        if owned_pids.len() == previous_len {
            break;
        }
    }

    let mut snapshot = RuntimeResourceSnapshot {
        backend_rss_bytes: rows
            .iter()
            .find(|row| row.pid == backend_pid)
            .map(|row| row.rss_kib.saturating_mul(1024)),
        ..RuntimeResourceSnapshot::default()
    };
    for row in rows
        .iter()
        .filter(|row| row.pid != backend_pid && owned_pids.contains(&row.pid))
    {
        let executable = std::path::Path::new(row.command.trim())
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if executable.eq_ignore_ascii_case("ffmpeg") {
            snapshot.active_ffmpeg_processes = snapshot.active_ffmpeg_processes.saturating_add(1);
        } else if executable.eq_ignore_ascii_case("ffprobe") {
            snapshot.active_ffprobe_processes = snapshot.active_ffprobe_processes.saturating_add(1);
        }
    }
    snapshot
}

fn parse_process_sample_row(line: &str) -> Option<ProcessSampleRow> {
    let mut fields = line.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    let parent_pid = fields.next()?.parse().ok()?;
    let rss_kib = fields.next()?.parse().ok()?;
    let command = fields.collect::<Vec<_>>().join(" ");
    (!command.is_empty()).then_some(ProcessSampleRow {
        pid,
        parent_pid,
        rss_kib,
        command,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{PreviewCameraState, PreviewScreenSourceKind, PreviewScreenState};

    #[test]
    fn preview_transport_counters_track_each_route_independently() {
        let counters = PreviewTransportCounters::new();
        counters.record_camera_png();
        counters.record_camera_png();
        counters.record_screen_png();
        counters.record_production_png();
        counters.record_camera_bmp();
        counters.record_screen_bmp();
        counters.record_live_jpeg();
        counters.record_live_mjpeg();
        counters.record_live_mjpeg();
        counters.record_live_mjpeg();
        let snapshot = counters.snapshot();
        assert_eq!(snapshot.camera_png, 2);
        assert_eq!(snapshot.screen_png, 1);
        assert_eq!(snapshot.production_png, 1);
        assert_eq!(snapshot.camera_bmp, 1);
        assert_eq!(snapshot.screen_bmp, 1);
        assert_eq!(snapshot.live_jpeg, 1);
        assert_eq!(snapshot.live_mjpeg, 3);
    }

    #[test]
    fn process_snapshot_uses_one_backend_owned_descendant_tree() {
        let snapshot = parse_runtime_resource_snapshot(
            " 100 1 4096 /opt/videorc-backend\n\
             101 100 1024 /opt/ffmpeg\n\
             102 101 512 /opt/ffprobe\n\
             200 1 9999 /other/ffmpeg\n\
             malformed row\n",
            100,
        );

        assert_eq!(snapshot.backend_rss_bytes, Some(4096 * 1024));
        assert_eq!(snapshot.active_ffmpeg_processes, 1);
        assert_eq!(snapshot.active_ffprobe_processes, 1);
    }

    #[test]
    fn applying_a_cached_resource_sample_never_collects_processes() {
        let mut stats = idle_diagnostics();
        apply_runtime_resource_snapshot_value(
            &mut stats,
            RuntimeResourceSnapshot {
                backend_rss_bytes: Some(42),
                active_ffmpeg_processes: 2,
                active_ffprobe_processes: 3,
            },
        );

        assert_eq!(stats.backend_rss_bytes, Some(42));
        assert_eq!(stats.active_ffmpeg_processes, 2);
        assert_eq!(stats.active_ffprobe_processes, 3);
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
        let stats = apply_audio_stats(idle_diagnostics(), 48_000, 128, None, None);

        assert_eq!(stats.mic_captured_frames, Some(48_000));
        assert_eq!(stats.mic_dropped_frames, 128);
        assert_eq!(stats.bottleneck, DiagnosticBottleneck::Audio);
    }

    #[test]
    fn low_audio_capture_coverage_is_an_audio_bottleneck_even_without_drops() {
        let healthy = apply_audio_stats(idle_diagnostics(), 48_000, 0, Some(1.0), Some(0.5));
        assert!(healthy.mic_live_level.is_some_and(|level| level > 0.0));
        assert!(healthy.mic_live_peak_db.is_some());
        let stopped = apply_audio_stats(healthy.clone(), 48_000, 0, None, None);
        assert!(stopped.mic_live_level.is_none(), "stop clears the meter");
        assert_eq!(healthy.mic_capture_coverage, Some(1.0));
        assert_ne!(healthy.bottleneck, DiagnosticBottleneck::Audio);

        let gap = apply_audio_stats(idle_diagnostics(), 24_000, 0, Some(0.5), None);
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

        let mut queue_drops = starting_diagnostics("s", 30, "record");
        queue_drops.encoder_bridge_recording_queue_dropped_frames = 3;
        let (risk, reasons) = classify_recording_risk(&queue_drops);
        assert!(risk);
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("recording output queue dropped 3"))
        );

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
    fn recording_risk_flags_sustained_freshness_stalls() {
        let mut healthy = starting_diagnostics("s", 30, "record");
        healthy.encoder_speed = Some(1.0);
        healthy.encoder_bridge_source_age_ms = Some(100);
        healthy.encoder_bridge_source_age_p95_ms = Some(100.0);
        healthy.compositor_tick_gap_p95_ms = Some(100.0);
        healthy.compositor_tick_gap_max_ms = Some(100.0);
        healthy.encoder_bridge_deadline_lag_p95_ms = Some(100.0);
        healthy.encoder_bridge_deadline_lag_max_ms = Some(100.0);

        let (risk, reasons) = classify_recording_risk(&healthy);
        assert!(!risk, "budget-bound run flagged: {reasons:?}");

        let mut stale_source = healthy.clone();
        stale_source.encoder_bridge_source_age_p95_ms = Some(141.0);
        let (risk, reasons) = classify_recording_risk(&stale_source);
        assert!(risk);
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("encoder source freshness"))
        );

        let mut stalled_compositor = healthy.clone();
        stalled_compositor.compositor_tick_gap_max_ms = Some(186.0);
        let (risk, reasons) = classify_recording_risk(&stalled_compositor);
        assert!(risk);
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("compositor tick cadence"))
        );

        let mut late_writer = healthy.clone();
        late_writer.encoder_bridge_deadline_lag_max_ms = Some(132.0);
        let (risk, reasons) = classify_recording_risk(&late_writer);
        assert!(risk);
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("encoder writer deadline"))
        );

        let mut idle = idle_diagnostics();
        idle.encoder_bridge_source_age_p95_ms = Some(250.0);
        idle.compositor_tick_gap_max_ms = Some(250.0);
        idle.encoder_bridge_deadline_lag_max_ms = Some(250.0);
        let (risk, reasons) = classify_recording_risk(&idle);
        assert!(!risk, "idle diagnostics flagged: {reasons:?}");
    }

    #[test]
    fn recording_risk_flags_incident_low_video_cadence() {
        let mut incident = starting_diagnostics("live", 30, "record+stream");
        incident.capture_fps = Some(8.88);
        incident.render_fps = Some(8.88);
        incident.encoder_bridge_input_fps = Some(8.88);
        incident.encoder_bridge_writer_loop_p95_ms = Some(662.57);
        incident.encoder_bridge_writer_active_p95_ms = Some(628.24);
        incident.encoder_bridge_compositor_wait_p95_ms = Some(0.0018);
        incident.encoder_bridge_video_toolbox_submit_p95_ms = Some(0.0907);
        incident.encoder_bridge_video_toolbox_fifo_write_p95_ms = Some(0.449);
        incident.encoder_bridge_deadline_lag_p95_ms = Some(6.10);
        incident.encoder_bridge_deadline_lag_max_ms = Some(6.10);
        incident.encoder_bridge_late_deadline_ticks = 1;
        incident.encoder_bridge_recording_video_toolbox_output_frames = 493;
        incident.encoder_bridge_stream_video_toolbox_output_frames = 1704;
        incident.encoder_bridge_separate_output_encoders_active = true;
        incident.mic_dropped_frames = 0;
        incident.mic_capture_coverage = Some(1.0);

        let (risk, reasons) = classify_recording_risk(&incident);
        assert!(risk, "incident diagnostics were not flagged: {reasons:?}");
        assert!(
            reasons
                .iter()
                .any(|reason| reason.contains("video cadence")),
            "risk reasons did not explain the cadence collapse: {reasons:?}"
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
        assert_eq!(stats.encoder_bridge_raw_video_copied_frames, 0);
        assert_eq!(stats.encoder_bridge_metal_target_copied_frames, 0);
        assert_eq!(stats.encoder_bridge_metal_target_handle_frames, 0);
        assert_eq!(stats.encoder_bridge_zero_copy_frames, 0);
        assert_eq!(stats.encoder_bridge_video_toolbox_probe_frames, 0);
        assert_eq!(stats.encoder_bridge_video_toolbox_probe_bytes, 0);
        assert_eq!(stats.encoder_bridge_video_toolbox_probe_errors, 0);
        assert_eq!(stats.encoder_bridge_video_toolbox_output_frames, 0);
        assert_eq!(stats.encoder_bridge_video_toolbox_output_bytes, 0);
        assert_eq!(stats.encoder_bridge_video_toolbox_output_encode_ms, None);
        assert_eq!(stats.encoder_bridge_error, None);
        assert_eq!(stats.compositor_backend, None);
        assert_eq!(stats.compositor_fallback_reason, None);
        assert_eq!(stats.compositor_cpu_fallback_frames, 0);
        assert_eq!(stats.compositor_source_iosurface_import_frames, 0);
        assert_eq!(stats.compositor_source_cvpixelbuffer_import_frames, 0);
        assert_eq!(stats.compositor_source_byte_upload_frames, 0);
        assert_eq!(stats.compositor_source_import_failures, 0);
        assert_eq!(stats.compositor_camera_source_iosurface_import_frames, 0);
        assert_eq!(
            stats.compositor_camera_source_cvpixelbuffer_import_frames,
            0
        );
        assert_eq!(stats.compositor_camera_source_byte_upload_frames, 0);
        assert_eq!(stats.compositor_camera_source_import_failures, 0);
        assert_eq!(stats.compositor_screen_source_iosurface_import_frames, 0);
        assert_eq!(
            stats.compositor_screen_source_cvpixelbuffer_import_frames,
            0
        );
        assert_eq!(stats.compositor_screen_source_byte_upload_frames, 0);
        assert_eq!(stats.compositor_screen_source_import_failures, 0);
        assert_eq!(stats.compositor_source_import_p95_ms, None);
        assert_eq!(stats.preview_compositor_frame_lag, None);
        assert!(!stats.preview_frame_polling_suppressed);
        assert!(!stats.preview_source_pixels_present);
        assert_eq!(stats.preview_camera_frame_age_ms, None);
        assert_eq!(stats.preview_camera_source_fps, None);
        assert_eq!(stats.preview_camera_dropped_frames, 0);
        assert_eq!(stats.preview_camera_state, None);
        assert_eq!(stats.preview_camera_device_unique_id, None);
        assert_eq!(stats.preview_camera_status_message, None);
        assert_eq!(stats.preview_camera_requested_width, None);
        assert_eq!(stats.preview_camera_requested_height, None);
        assert_eq!(stats.preview_camera_actual_width, None);
        assert_eq!(stats.preview_camera_actual_height, None);
        assert_eq!(stats.preview_camera_selected_format_width, None);
        assert_eq!(stats.preview_camera_selected_format_height, None);
        assert_eq!(stats.preview_camera_selected_format_min_fps, None);
        assert_eq!(stats.preview_camera_selected_format_max_fps, None);
        assert_eq!(stats.preview_camera_capability_device_id, None);
        assert!(stats.preview_camera_capability_formats.is_empty());
        assert_eq!(stats.preview_camera_capability_error, None);
        assert_eq!(stats.preview_screen_frame_age_ms, None);
        assert_eq!(stats.preview_screen_source_fps, None);
        assert_eq!(stats.preview_screen_dropped_frames, 0);
        assert_eq!(stats.preview_screen_native_width, None);
        assert_eq!(stats.preview_screen_native_height, None);
        assert_eq!(stats.preview_screen_requested_width, None);
        assert_eq!(stats.preview_screen_requested_height, None);
        assert_eq!(stats.preview_screen_actual_width, None);
        assert_eq!(stats.preview_screen_actual_height, None);
        assert_eq!(stats.preview_screen_iosurface_available, None);
        assert_eq!(stats.preview_screen_capture_gap_p95_ms, None);
        assert_eq!(stats.preview_screen_capture_gap_max_ms, None);
        assert_eq!(stats.preview_screen_pixel_buffer_lock_p95_ms, None);
        assert_eq!(stats.preview_screen_row_copy_p95_ms, None);
        assert_eq!(stats.preview_screen_publish_p95_ms, None);
        assert_eq!(stats.preview_screen_frame_bytes, 0);
        assert_eq!(stats.preview_screen_capture_queue_depth, 0);
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
    fn compositor_timing_stats_record_live_breakdown() {
        let stats = apply_compositor_timing_stats(
            idle_diagnostics(),
            46.8,
            1.2,
            12.3,
            34.5,
            0.4,
            3.9,
            4.9,
            7.2,
            0.1,
            33.6,
            72.0,
        );

        assert_eq!(stats.compositor_source_fetch_p95_ms, Some(46.8));
        assert_eq!(stats.compositor_scene_snapshot_p95_ms, Some(1.2));
        assert_eq!(stats.compositor_camera_frame_fetch_p95_ms, Some(12.3));
        assert_eq!(stats.compositor_screen_frame_fetch_p95_ms, Some(34.5));
        assert_eq!(stats.compositor_gpu_prepare_p95_ms, Some(0.4));
        assert_eq!(stats.compositor_gpu_source_texture_p95_ms, Some(3.9));
        assert_eq!(stats.compositor_gpu_command_wait_p95_ms, Some(4.9));
        assert_eq!(stats.compositor_gpu_total_p95_ms, Some(7.2));
        assert_eq!(stats.compositor_frame_store_publish_p95_ms, Some(0.1));
        assert_eq!(stats.compositor_tick_gap_p95_ms, Some(33.6));
        assert_eq!(stats.compositor_tick_gap_max_ms, Some(72.0));
    }

    #[test]
    fn compositor_source_import_stats_record_source_counters() {
        let stats = apply_compositor_source_import_stats(
            idle_diagnostics(),
            CompositorSourceImportStats {
                iosurface_frames: 11,
                cvpixelbuffer_frames: 7,
                byte_upload_frames: 5,
                import_failures: 2,
                camera_iosurface_frames: 1,
                camera_cvpixelbuffer_frames: 7,
                camera_byte_upload_frames: 3,
                camera_import_failures: 1,
                screen_iosurface_frames: 10,
                screen_cvpixelbuffer_frames: 0,
                screen_byte_upload_frames: 2,
                screen_import_failures: 1,
                import_time_ms: 4.5,
            },
            1.7,
        );

        assert_eq!(stats.compositor_source_iosurface_import_frames, 11);
        assert_eq!(stats.compositor_source_cvpixelbuffer_import_frames, 7);
        assert_eq!(stats.compositor_source_byte_upload_frames, 5);
        assert_eq!(stats.compositor_source_import_failures, 2);
        assert_eq!(stats.compositor_camera_source_iosurface_import_frames, 1);
        assert_eq!(
            stats.compositor_camera_source_cvpixelbuffer_import_frames,
            7
        );
        assert_eq!(stats.compositor_camera_source_byte_upload_frames, 3);
        assert_eq!(stats.compositor_camera_source_import_failures, 1);
        assert_eq!(stats.compositor_screen_source_iosurface_import_frames, 10);
        assert_eq!(
            stats.compositor_screen_source_cvpixelbuffer_import_frames,
            0
        );
        assert_eq!(stats.compositor_screen_source_byte_upload_frames, 2);
        assert_eq!(stats.compositor_screen_source_import_failures, 1);
        assert_eq!(stats.compositor_source_import_p95_ms, Some(1.7));
    }

    #[test]
    fn preview_screen_capture_timing_stats_record_source_cadence() {
        let stats = apply_preview_screen_capture_timing_stats(
            idle_diagnostics(),
            PreviewScreenCaptureTimingStats {
                capture_gap_p95_ms: Some(33.4),
                capture_gap_max_ms: Some(91.2),
                pixel_buffer_lock_p95_ms: Some(0.2),
                row_copy_p95_ms: Some(8.7),
                publish_p95_ms: Some(1.1),
                frame_bytes: 8_294_400,
                capture_queue_depth: 3,
            },
        );

        assert_eq!(stats.preview_screen_capture_gap_p95_ms, Some(33.4));
        assert_eq!(stats.preview_screen_capture_gap_max_ms, Some(91.2));
        assert_eq!(stats.preview_screen_pixel_buffer_lock_p95_ms, Some(0.2));
        assert_eq!(stats.preview_screen_row_copy_p95_ms, Some(8.7));
        assert_eq!(stats.preview_screen_publish_p95_ms, Some(1.1));
        assert_eq!(stats.preview_screen_frame_bytes, 8_294_400);
        assert_eq!(stats.preview_screen_capture_queue_depth, 3);
    }

    #[test]
    fn preview_screen_source_stats_record_dimension_evidence() {
        let stats = apply_preview_screen_source_stats(
            idle_diagnostics(),
            &PreviewScreenStatus {
                state: PreviewScreenState::Live,
                source_id: Some("screen:screencapturekit:1".to_string()),
                source_kind: Some(PreviewScreenSourceKind::Screen),
                target_fps: 30,
                width: Some(3840),
                height: Some(2160),
                native_width: Some(3840),
                native_height: Some(2160),
                requested_width: Some(3840),
                requested_height: Some(2160),
                actual_width: Some(3840),
                actual_height: Some(2160),
                iosurface_available: Some(true),
                source_fps: Some(30.0),
                frame_age_ms: Some(12),
                frames_captured: 90,
                dropped_frames: 0,
                sequence: Some(90),
                include_cursor: true,
                exclude_current_process_windows: true,
                updated_at: "2026-06-08T00:00:00Z".to_string(),
                message: Some("screen stream started".to_string()),
            },
        );

        assert_eq!(stats.preview_screen_native_width, Some(3840));
        assert_eq!(stats.preview_screen_native_height, Some(2160));
        assert_eq!(stats.preview_screen_requested_width, Some(3840));
        assert_eq!(stats.preview_screen_requested_height, Some(2160));
        assert_eq!(stats.preview_screen_actual_width, Some(3840));
        assert_eq!(stats.preview_screen_actual_height, Some(2160));
        assert_eq!(stats.preview_screen_iosurface_available, Some(true));
        assert_eq!(
            stats.preview_screen_message.as_deref(),
            Some("screen stream started")
        );
    }

    #[test]
    fn preview_camera_capture_timing_stats_record_source_cadence() {
        let stats = apply_preview_camera_capture_timing_stats(
            idle_diagnostics(),
            PreviewCameraCaptureTimingStats {
                capture_gap_p95_ms: Some(33.1),
                capture_gap_p99_ms: Some(48.9),
                capture_gap_max_ms: Some(72.4),
                sample_pts_gap_p95_ms: Some(33.3),
                sample_pts_gap_p99_ms: Some(50.0),
                sample_pts_gap_max_ms: Some(66.7),
                pixel_buffer_lock_p95_ms: Some(0.3),
                row_copy_p95_ms: Some(4.2),
                publish_p95_ms: Some(0.8),
                frame_bytes: 3_686_400,
            },
        );

        assert_eq!(stats.preview_camera_capture_gap_p95_ms, Some(33.1));
        assert_eq!(stats.preview_camera_capture_gap_p99_ms, Some(48.9));
        assert_eq!(stats.preview_camera_capture_gap_max_ms, Some(72.4));
        assert_eq!(stats.preview_camera_sample_pts_gap_p95_ms, Some(33.3));
        assert_eq!(stats.preview_camera_sample_pts_gap_p99_ms, Some(50.0));
        assert_eq!(stats.preview_camera_sample_pts_gap_max_ms, Some(66.7));
        assert_eq!(stats.preview_camera_pixel_buffer_lock_p95_ms, Some(0.3));
        assert_eq!(stats.preview_camera_row_copy_p95_ms, Some(4.2));
        assert_eq!(stats.preview_camera_publish_p95_ms, Some(0.8));
        assert_eq!(stats.preview_camera_frame_bytes, 3_686_400);
    }

    #[test]
    fn preview_camera_source_stats_record_format_and_state_evidence() {
        let stats = apply_preview_camera_source_stats(
            idle_diagnostics(),
            &PreviewCameraStatus {
                state: PreviewCameraState::Live,
                camera_id: Some("camera:avfoundation-native:abc".to_string()),
                device_unique_id: Some("device-abc".to_string()),
                target_fps: 60,
                width: Some(1920),
                height: Some(1080),
                requested_width: Some(3840),
                requested_height: Some(2160),
                actual_width: Some(1920),
                actual_height: Some(1080),
                selected_format_width: Some(1920),
                selected_format_height: Some(1080),
                selected_format_min_fps: Some(1.0),
                selected_format_max_fps: Some(60.0),
                source_fps: Some(59.94),
                frame_age_ms: Some(8),
                frames_captured: 120,
                dropped_frames: 0,
                sequence: Some(120),
                updated_at: "2026-06-08T00:00:00Z".to_string(),
                message: Some("Live".to_string()),
            },
        );

        assert_eq!(stats.preview_camera_state, Some(PreviewCameraState::Live));
        assert_eq!(
            stats.preview_camera_device_unique_id.as_deref(),
            Some("device-abc")
        );
        assert_eq!(stats.preview_camera_requested_width, Some(3840));
        assert_eq!(stats.preview_camera_requested_height, Some(2160));
        assert_eq!(stats.preview_camera_actual_width, Some(1920));
        assert_eq!(stats.preview_camera_actual_height, Some(1080));
        assert_eq!(stats.preview_camera_selected_format_width, Some(1920));
        assert_eq!(stats.preview_camera_selected_format_max_fps, Some(60.0));
    }

    #[test]
    fn preview_camera_capability_stats_record_format_matrix() {
        let stats = apply_preview_camera_capability_stats(
            idle_diagnostics(),
            Some("camera:avfoundation-native:abc".to_string()),
            vec![CameraCapabilityFormat {
                width: 3840,
                height: 2160,
                min_fps: 29.97,
                max_fps: 60.0,
            }],
            None,
        );

        assert_eq!(
            stats.preview_camera_capability_device_id.as_deref(),
            Some("camera:avfoundation-native:abc")
        );
        assert_eq!(stats.preview_camera_capability_formats.len(), 1);
        assert_eq!(stats.preview_camera_capability_formats[0].width, 3840);
        assert_eq!(stats.preview_camera_capability_error, None);
    }

    #[test]
    fn compositor_stats_clear_preview_present_metrics_without_surface() {
        let visible = apply_compositor_stats(
            idle_diagnostics(),
            30,
            PreviewTransport::ElectronProofSurface,
            PreviewSurfaceBacking::ElectronBrowserWindow,
            CompositorBackend::Metal,
            None,
            0,
            60.0,
            12,
            1,
            2,
            4.0,
            8.0,
            12.0,
        );

        let hidden = apply_compositor_stats(
            visible,
            30,
            PreviewTransport::Unavailable,
            PreviewSurfaceBacking::None,
            CompositorBackend::Metal,
            None,
            0,
            60.0,
            13,
            3,
            4,
            5.0,
            9.0,
            13.0,
        );

        assert_eq!(hidden.render_fps, Some(60.0));
        assert_eq!(hidden.preview_transport, PreviewTransport::Unavailable);
        assert_eq!(hidden.preview_surface_backing, PreviewSurfaceBacking::None);
        assert_eq!(hidden.preview_target_fps, None);
        assert_eq!(hidden.preview_frame_age_ms, None);
        assert_eq!(hidden.preview_present_fps, None);
        assert_eq!(hidden.preview_input_to_present_latency_p95_ms, None);
        assert_eq!(hidden.preview_input_to_present_latency_p99_ms, None);
        assert_eq!(hidden.preview_render_frame_time_p95_ms, None);
        assert_eq!(hidden.preview_repeated_frames, 0);
        assert_eq!(hidden.preview_latency_ms, None);
        assert_eq!(hidden.preview_dropped_frames, 0);
    }

    #[test]
    fn encoder_bridge_stats_feed_capture_and_encoder_health() {
        let stats = apply_encoder_bridge_stats(
            starting_diagnostics("bridge", 30, "encoder-bridge"),
            EncoderBridgeDiagnosticSnapshot {
                queue_depth: 1,
                output_queue_oldest_frame_age_ms: Some(10),
                output_queue_capacity_pressure_events: 0,
                output_queue_dropped_frames: 0,
                input_fps: Some(29.8),
                dropped_frames: 0,
                encoder_speed: Some(1.02),
                repeated_fed_frames: 0,
                repeated_frame_bursts: 0,
                max_repeated_frame_run: 0,
                synthetic_fallback_frames: 0,
                source_to_encode_age_ms: None,
                source_to_encode_age_p95_ms: None,
                repeated_frame_age_p95_ms: None,
                repeated_frame_age_max_ms: None,
                metal_target_frames: 0,
                raw_video_copied_frames: 0,
                metal_target_copied_frames: 0,
                metal_target_handle_frames: 0,
                zero_copy_frames: 0,
                video_toolbox_probe_frames: 0,
                video_toolbox_probe_bytes: 0,
                video_toolbox_probe_errors: 0,
                video_toolbox_output_frames: 0,
                video_toolbox_output_bytes: 0,
                video_toolbox_output_encode_ms: None,
                recording_output_width: None,
                recording_output_height: None,
                recording_output_fps: None,
                recording_output_bitrate_kbps: None,
                stream_output_width: None,
                stream_output_height: None,
                stream_output_fps: None,
                stream_output_bitrate_kbps: None,
                active_video_toolbox_output_encoders: 0,
                recording_video_toolbox_output_frames: 0,
                recording_video_toolbox_output_bytes: 0,
                stream_video_toolbox_output_frames: 0,
                stream_video_toolbox_output_bytes: 0,
                separate_output_encoders_active: false,
                compositor_wait_p95_ms: None,
                video_toolbox_submit_p95_ms: None,
                raw_video_fifo_write_p95_ms: None,
                video_toolbox_fifo_write_p95_ms: None,
                video_toolbox_fifo_enqueue_p95_ms: None,
                video_toolbox_fifo_enqueue_max_ms: None,
                writer_loop_p95_ms: None,
                writer_sleep_p95_ms: None,
                writer_active_p95_ms: None,
                deadline_lag_p95_ms: None,
                deadline_lag_max_ms: None,
                late_deadline_ticks: 0,
                schedule_skipped_ms: 0,
                recording_input_fps: None,
                stream_input_fps: None,
                recording_queue_depth: 1,
                recording_queue_oldest_frame_age_ms: Some(10),
                recording_queue_capacity_pressure_events: 0,
                recording_queue_dropped_frames: 0,
                stream_queue_depth: 0,
                stream_queue_oldest_frame_age_ms: None,
                stream_queue_capacity_pressure_events: 0,
                stream_queue_dropped_frames: 0,
                recording_writer_loop_p95_ms: None,
                stream_writer_loop_p95_ms: None,
                recording_writer_active_p95_ms: None,
                stream_writer_active_p95_ms: None,
                recording_video_toolbox_fifo_enqueue_p95_ms: None,
                stream_video_toolbox_fifo_enqueue_p95_ms: None,
                recording_video_toolbox_fifo_enqueue_max_ms: None,
                stream_video_toolbox_fifo_enqueue_max_ms: None,
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
                queue_depth: 5,
                output_queue_oldest_frame_age_ms: Some(180),
                output_queue_capacity_pressure_events: 4,
                output_queue_dropped_frames: 2,
                input_fps: Some(28.0),
                dropped_frames: 3,
                encoder_speed: Some(0.5),
                repeated_fed_frames: 5,
                repeated_frame_bursts: 3,
                max_repeated_frame_run: 2,
                synthetic_fallback_frames: 1,
                source_to_encode_age_ms: Some(40),
                source_to_encode_age_p95_ms: Some(24.0),
                repeated_frame_age_p95_ms: Some(35.0),
                repeated_frame_age_max_ms: Some(38),
                metal_target_frames: 24,
                raw_video_copied_frames: 80,
                metal_target_copied_frames: 24,
                metal_target_handle_frames: 24,
                zero_copy_frames: 0,
                video_toolbox_probe_frames: 12,
                video_toolbox_probe_bytes: 4096,
                video_toolbox_probe_errors: 1,
                video_toolbox_output_frames: 10,
                video_toolbox_output_bytes: 8192,
                video_toolbox_output_encode_ms: Some(43),
                recording_output_width: Some(3840),
                recording_output_height: Some(2160),
                recording_output_fps: Some(30),
                recording_output_bitrate_kbps: Some(30_000),
                stream_output_width: Some(1920),
                stream_output_height: Some(1080),
                stream_output_fps: Some(30),
                stream_output_bitrate_kbps: Some(6000),
                active_video_toolbox_output_encoders: 2,
                recording_video_toolbox_output_frames: 10,
                recording_video_toolbox_output_bytes: 8192,
                stream_video_toolbox_output_frames: 8,
                stream_video_toolbox_output_bytes: 4096,
                separate_output_encoders_active: true,
                compositor_wait_p95_ms: Some(5.0),
                video_toolbox_submit_p95_ms: Some(2.0),
                raw_video_fifo_write_p95_ms: Some(11.0),
                video_toolbox_fifo_write_p95_ms: Some(3.0),
                video_toolbox_fifo_enqueue_p95_ms: Some(7.0),
                video_toolbox_fifo_enqueue_max_ms: Some(14.0),
                writer_loop_p95_ms: Some(12.0),
                writer_sleep_p95_ms: Some(8.0),
                writer_active_p95_ms: Some(4.0),
                deadline_lag_p95_ms: Some(4.0),
                deadline_lag_max_ms: Some(9.0),
                late_deadline_ticks: 7,
                schedule_skipped_ms: 0,
                recording_input_fps: Some(29.0),
                stream_input_fps: Some(28.0),
                recording_queue_depth: 2,
                recording_queue_oldest_frame_age_ms: Some(180),
                recording_queue_capacity_pressure_events: 1,
                recording_queue_dropped_frames: 0,
                stream_queue_depth: 3,
                stream_queue_oldest_frame_age_ms: Some(90),
                stream_queue_capacity_pressure_events: 3,
                stream_queue_dropped_frames: 2,
                recording_writer_loop_p95_ms: Some(12.0),
                stream_writer_loop_p95_ms: Some(16.0),
                recording_writer_active_p95_ms: Some(4.0),
                stream_writer_active_p95_ms: Some(6.0),
                recording_video_toolbox_fifo_enqueue_p95_ms: Some(7.0),
                stream_video_toolbox_fifo_enqueue_p95_ms: Some(9.0),
                recording_video_toolbox_fifo_enqueue_max_ms: Some(14.0),
                stream_video_toolbox_fifo_enqueue_max_ms: Some(18.0),
                error: None,
            },
            30,
        );

        assert_eq!(lagging.encoder_bridge_dropped_frames, 3);
        assert_eq!(lagging.encoder_bridge_queue_depth, 5);
        assert_eq!(
            lagging.encoder_bridge_output_queue_oldest_frame_age_ms,
            Some(180)
        );
        assert_eq!(
            lagging.encoder_bridge_output_queue_capacity_pressure_events,
            4
        );
        assert_eq!(lagging.encoder_bridge_output_queue_dropped_frames, 2);
        assert_eq!(lagging.encoder_bridge_recording_queue_depth, 2);
        assert_eq!(
            lagging.encoder_bridge_recording_queue_oldest_frame_age_ms,
            Some(180)
        );
        assert_eq!(
            lagging.encoder_bridge_recording_queue_capacity_pressure_events,
            1
        );
        assert_eq!(lagging.encoder_bridge_recording_queue_dropped_frames, 0);
        assert_eq!(lagging.encoder_bridge_stream_queue_depth, 3);
        assert_eq!(
            lagging.encoder_bridge_stream_queue_oldest_frame_age_ms,
            Some(90)
        );
        assert_eq!(
            lagging.encoder_bridge_stream_queue_capacity_pressure_events,
            3
        );
        assert_eq!(lagging.encoder_bridge_stream_queue_dropped_frames, 2);
        assert_eq!(lagging.encoder_bridge_repeated_frames, 5);
        assert_eq!(lagging.encoder_bridge_repeated_frame_bursts, 3);
        assert_eq!(lagging.encoder_bridge_max_repeated_frame_run, 2);
        assert_eq!(lagging.encoder_bridge_synthetic_frames, 1);
        assert_eq!(lagging.encoder_bridge_source_age_ms, Some(40));
        assert_eq!(lagging.encoder_bridge_source_age_p95_ms, Some(24.0));
        assert_eq!(lagging.encoder_bridge_repeated_frame_age_p95_ms, Some(35.0));
        assert_eq!(lagging.encoder_bridge_repeated_frame_age_max_ms, Some(38));
        assert_eq!(lagging.encoder_bridge_metal_target_frames, 24);
        assert_eq!(lagging.encoder_bridge_raw_video_copied_frames, 80);
        assert_eq!(lagging.encoder_bridge_metal_target_copied_frames, 24);
        assert_eq!(lagging.encoder_bridge_metal_target_handle_frames, 24);
        assert_eq!(lagging.encoder_bridge_zero_copy_frames, 0);
        assert_eq!(lagging.encoder_bridge_video_toolbox_probe_frames, 12);
        assert_eq!(lagging.encoder_bridge_video_toolbox_probe_bytes, 4096);
        assert_eq!(lagging.encoder_bridge_video_toolbox_probe_errors, 1);
        assert_eq!(lagging.encoder_bridge_video_toolbox_output_frames, 10);
        assert_eq!(lagging.encoder_bridge_video_toolbox_output_bytes, 8192);
        assert_eq!(
            lagging.encoder_bridge_video_toolbox_output_encode_ms,
            Some(43)
        );
        assert_eq!(lagging.recording_output_width, Some(3840));
        assert_eq!(lagging.recording_output_height, Some(2160));
        assert_eq!(lagging.recording_output_fps, Some(30));
        assert_eq!(lagging.recording_output_bitrate_kbps, Some(30_000));
        assert_eq!(lagging.stream_output_width, Some(1920));
        assert_eq!(lagging.stream_output_height, Some(1080));
        assert_eq!(lagging.stream_output_fps, Some(30));
        assert_eq!(lagging.stream_output_bitrate_kbps, Some(6000));
        assert_eq!(
            lagging.encoder_bridge_active_video_toolbox_output_encoders,
            2
        );
        assert_eq!(
            lagging.encoder_bridge_recording_video_toolbox_output_frames,
            10
        );
        assert_eq!(
            lagging.encoder_bridge_recording_video_toolbox_output_bytes,
            8192
        );
        assert_eq!(lagging.encoder_bridge_stream_video_toolbox_output_frames, 8);
        assert_eq!(
            lagging.encoder_bridge_stream_video_toolbox_output_bytes,
            4096
        );
        assert!(lagging.encoder_bridge_separate_output_encoders_active);
        assert_eq!(
            lagging.encoder_bridge_raw_video_fifo_write_p95_ms,
            Some(11.0)
        );
        assert_eq!(lagging.encoder_bridge_deadline_lag_p95_ms, Some(4.0));
        assert_eq!(lagging.encoder_bridge_deadline_lag_max_ms, Some(9.0));
        assert_eq!(
            lagging.encoder_bridge_video_toolbox_fifo_enqueue_p95_ms,
            Some(7.0)
        );
        assert_eq!(
            lagging.encoder_bridge_video_toolbox_fifo_enqueue_max_ms,
            Some(14.0)
        );
        assert_eq!(lagging.encoder_bridge_writer_sleep_p95_ms, Some(8.0));
        assert_eq!(lagging.encoder_bridge_writer_active_p95_ms, Some(4.0));
        assert_eq!(lagging.encoder_bridge_late_deadline_ticks, 7);
        assert_eq!(lagging.encoder_bridge_recording_input_fps, Some(29.0));
        assert_eq!(lagging.encoder_bridge_stream_input_fps, Some(28.0));
        assert_eq!(
            lagging.encoder_bridge_recording_writer_loop_p95_ms,
            Some(12.0)
        );
        assert_eq!(lagging.encoder_bridge_stream_writer_loop_p95_ms, Some(16.0));
        assert_eq!(
            lagging.encoder_bridge_recording_writer_active_p95_ms,
            Some(4.0)
        );
        assert_eq!(
            lagging.encoder_bridge_stream_writer_active_p95_ms,
            Some(6.0)
        );
        assert_eq!(
            lagging.encoder_bridge_recording_video_toolbox_fifo_enqueue_p95_ms,
            Some(7.0)
        );
        assert_eq!(
            lagging.encoder_bridge_stream_video_toolbox_fifo_enqueue_p95_ms,
            Some(9.0)
        );
        assert_eq!(
            lagging.encoder_bridge_recording_video_toolbox_fifo_enqueue_max_ms,
            Some(14.0)
        );
        assert_eq!(
            lagging.encoder_bridge_stream_video_toolbox_fifo_enqueue_max_ms,
            Some(18.0)
        );
        let wire = serde_json::to_value(&lagging).expect("serialize diagnostics");
        assert_eq!(wire["encoderBridgeRawVideoFifoWriteP95Ms"], 11.0);
        assert_eq!(lagging.bottleneck, DiagnosticBottleneck::Encoder);
    }

    #[test]
    fn websocket_transport_snapshot_is_applied_without_resource_sampling() {
        let snapshot = crate::protocol::WebSocketTransportDiagnosticStats {
            reliable_response_queue: crate::protocol::WebSocketQueueDiagnosticStats {
                current_depth: 3,
                max_depth: 8,
                oldest_age_ms: Some(42),
                coalesced_count: 0,
                evicted_or_dropped_count: 1,
            },
            incoming_command_queue: crate::protocol::WebSocketQueueDiagnosticStats {
                current_depth: 2,
                max_depth: 5,
                oldest_age_ms: Some(21),
                coalesced_count: 0,
                evicted_or_dropped_count: 0,
            },
            coalesced_telemetry_queue: crate::protocol::WebSocketQueueDiagnosticStats {
                current_depth: 1,
                max_depth: 4,
                oldest_age_ms: Some(7),
                coalesced_count: 11,
                evicted_or_dropped_count: 2,
            },
            slow_pressure_disconnect_count: 6,
        };

        let stats = apply_websocket_transport_stats(idle_diagnostics(), snapshot.clone());

        assert_eq!(stats.websocket_transport, snapshot);
    }
}
