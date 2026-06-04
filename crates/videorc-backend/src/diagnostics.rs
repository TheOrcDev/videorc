use std::path::Path;
use std::process::Command;

use chrono::Utc;

use crate::ffmpeg_work::FfmpegWorkSnapshot;
use crate::frame_store::FrameStoreStats;
use crate::protocol::{
    DiagnosticBottleneck, DiagnosticStats, PermissionPane, PreviewCameraStatus,
    PreviewScreenStatus, PreviewTransport, StreamHealth,
};
use crate::source_registry::SourceRegistrySnapshot;

pub fn idle_diagnostics() -> DiagnosticStats {
    DiagnosticStats {
        session_id: None,
        target_fps: None,
        capture_fps: None,
        render_fps: None,
        skipped_frames: 0,
        dropped_frames: 0,
        encoder_speed: None,
        preview_target_fps: None,
        preview_frame_age_ms: None,
        preview_transport: PreviewTransport::Unavailable,
        preview_source_fps: Default::default(),
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
    stats.updated_at = Utc::now().to_rfc3339();
    stats
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

pub fn starting_diagnostics(session_id: &str, target_fps: u32) -> DiagnosticStats {
    DiagnosticStats {
        session_id: Some(session_id.to_string()),
        target_fps: Some(f64::from(target_fps)),
        bottleneck: DiagnosticBottleneck::Unknown,
        updated_at: Utc::now().to_rfc3339(),
        ..idle_diagnostics()
    }
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
    stats.preview_transport = PreviewTransport::NativeSurface;
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

pub fn apply_audio_stats(
    mut stats: DiagnosticStats,
    captured_frames: u64,
    dropped_frames: u64,
) -> DiagnosticStats {
    stats.mic_captured_frames = Some(captured_frames);
    stats.mic_dropped_frames = dropped_frames;
    if dropped_frames > 0 {
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
        let stats = apply_audio_stats(idle_diagnostics(), 48_000, 128);

        assert_eq!(stats.mic_captured_frames, Some(48_000));
        assert_eq!(stats.mic_dropped_frames, 128);
        assert_eq!(stats.bottleneck, DiagnosticBottleneck::Audio);
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
}
