//! `lib/health-checks.test.ts`, `lib/backend-crash-view.test.ts` and
//! `lib/studio-health.test.ts`'s cases, and the guard that every field the
//! page reads is one the backend writes.

use std::time::Instant;

use serde_json::{Value, json};
use videorc_protocol::{
    BackendHealth, RecordingContainer, RecordingFinalizationState, RecordingPipelineStage,
    RecordingPipelineStageState, RecordingPipelineStageStatus, RecordingPipelineStatus, ToolStatus,
};

use super::*;
use crate::studio::health::{DIAGNOSTICS_STATS_EVENT, HealthSummary, HealthTelemetry};

fn check(id: &'static str, label: &'static str, tone: Tone) -> HealthCheck {
    HealthCheck {
        id,
        label,
        value: "Value".to_string(),
        tone,
    }
}

fn f(value: &Value) -> Fields<'_> {
    Fields::of(Some(value))
}

#[test]
fn the_verdict_says_healthy_when_nothing_is_amber_or_red() {
    assert_eq!(
        health_verdict(
            &[
                check("recording", "Recording", Tone::Good),
                check("memory", "Memory", Tone::Neutral)
            ],
            &[],
            None
        ),
        HealthVerdict {
            variant: VerdictVariant::Success,
            title: "Everything looks healthy".to_string(),
            description: None,
        }
    );
}

#[test]
fn the_verdict_counts_and_names_what_needs_attention_warnings_first() {
    assert_eq!(
        health_verdict(
            &[
                check("encoder", "Encoder", Tone::Warn),
                check("rendering", "Rendering", Tone::Good),
                check("destinations", "Destinations", Tone::Warn),
            ],
            &["Camera permission".to_string()],
            Some("Lower the bitrate.".to_string())
        ),
        HealthVerdict {
            variant: VerdictVariant::Warning,
            title: "3 things need attention: Camera permission, Encoder, Destinations".to_string(),
            description: Some("Lower the bitrate.".to_string()),
        }
    );
    let red = health_verdict(&[check("recording", "Recording", Tone::Error)], &[], None);
    assert_eq!(red.variant, VerdictVariant::Destructive);
    assert_eq!(red.title, "1 thing needs attention: Recording");
    assert!(!check_needs_attention(Tone::Neutral));
    assert!(!check_needs_attention(Tone::Good));
    assert!(check_needs_attention(Tone::Warn));
    assert!(check_needs_attention(Tone::Error));
}

#[test]
fn the_check_words_match_the_renderers() {
    assert_eq!(slowdown_check("audio"), words("Microphone", Tone::Warn));
    assert_eq!(
        slowdown_check("unknown"),
        words("Measuring…", Tone::Neutral)
    );
    assert_eq!(slowdown_check("none"), words("None found", Tone::Good));
    assert_eq!(slowdown_advice("none"), None);
    assert!(
        slowdown_advice("encoder")
            .unwrap()
            .contains("slower than real time")
    );
    assert!(RECORDING_AT_RISK_ADVICE.contains("Technical details"));

    let none = Value::Null;
    assert_eq!(
        encoder_check(f(&json!({"droppedFrames": 12})), f(&none)),
        words("12 dropped frames", Tone::Warn)
    );
    assert_eq!(
        encoder_check(f(&json!({"droppedFrames": 1})), f(&none)).value,
        "1 dropped frame"
    );
    assert_eq!(
        encoder_check(f(&json!({"droppedFrames": 0, "encoderSpeed": 1})), f(&none)),
        words("1.00×", Tone::Good)
    );
    assert_eq!(
        encoder_check(f(&json!({"droppedFrames": 0})), f(&none)),
        words("Idle", Tone::Neutral)
    );

    // Transitional states are neutral, not amber (I-4).
    assert_eq!(
        file_repair_check(f(&json!({"ffmpegMaintenanceRunning": true}))),
        words("Running", Tone::Neutral)
    );
    assert_eq!(
        preview_check("connecting", "live", "live"),
        words("Connecting…", Tone::Neutral)
    );
    assert_eq!(
        preview_check("unavailable", "live", "live").tone,
        Tone::Warn
    );
    assert_eq!(
        preview_source_check("source-missing"),
        words("Not running", Tone::Neutral)
    );
    assert_eq!(
        preview_source_check("permission-needed"),
        words("Needs permission", Tone::Error)
    );
    assert_eq!(
        pipeline_state_words(&RecordingPipelineStageState::Starting),
        words("Starting…", Tone::Neutral)
    );
    assert_eq!(
        pipeline_state_words(&RecordingPipelineStageState::Finalizing),
        words("Finishing…", Tone::Neutral)
    );
    assert_eq!(
        pipeline_state_words(&RecordingPipelineStageState::Failed),
        words("Failed", Tone::Error)
    );
}

#[test]
fn the_camera_format_and_the_stream_delivery_rows_read_as_electron_writes_them() {
    let stats = json!({
        "previewCameraSelectedFormatWidth": 1280,
        "previewCameraSelectedFormatHeight": 720,
        "previewCameraCapturePixelFormat": " NV12 ",
        "previewCameraSelectedFormatMaxFps": 29.97,
        "streamDelivery": {"deliveredFps": 28.6, "targetFps": 30, "windowSeconds": 5,
                           "bitrateKbps": 4800, "chosenBitrateKbps": 6000}
    });
    assert_eq!(
        camera_format_facts(f(&stats)).as_deref(),
        Some("1280 × 720 NV12 · 30 fps")
    );
    assert_eq!(
        camera_format_facts(f(&json!({"previewCameraSelectedFormatWidth": 640, "previewCameraSelectedFormatHeight": 480}))).as_deref(),
        Some("640 × 480")
    );
    assert_eq!(camera_format_facts(f(&json!({}))), None);
    let delivery = f(&stats).object("streamDelivery");
    assert_eq!(
        format_delivered_fps(delivery).as_deref(),
        Some("29 of 30 fps")
    );
    assert_eq!(
        format_lowered_bitrate(delivery).as_deref(),
        Some("4.8 of 6 Mbps")
    );
    let back = json!({"bitrateKbps": 6000, "chosenBitrateKbps": 6000, "deliveredFps": 30, "targetFps": 30, "windowSeconds": 0});
    assert_eq!(format_lowered_bitrate(f(&back)), None);
    assert_eq!(format_delivered_fps(f(&back)), None, "no window yet");
}

#[test]
fn a_live_camera_held_under_its_rate_is_named_with_its_rate() {
    use crate::studio::camera_frame_rate::CameraLowFrameRate;
    let low = Some(CameraLowFrameRate {
        fps: 14.6,
        expected_fps: 30.0,
    });
    let live = json!({"state": "live"});
    assert_eq!(
        camera_check(f(&live), low),
        words("15 of 30 fps", Tone::Warn)
    );
    // No video outranks the rate; a camera that isn't live has none.
    let silent = json!({"state": "live", "noVideo": true});
    assert_eq!(camera_check(f(&silent), low), words("No video", Tone::Warn));
    assert_eq!(
        camera_check(f(&json!({"state": "starting"})), low),
        preview_source_check("starting")
    );
    assert_eq!(
        camera_low_frame_rate_advice(f(&live), low, Some("C920")).as_deref(),
        Some("C920 is sending 15 of 30 fps. More light usually helps.")
    );
    assert_eq!(
        camera_low_frame_rate_advice(f(&silent), low, Some("C920")),
        None
    );
}

#[test]
fn a_camera_that_is_on_but_sends_no_video_is_named() {
    let silent = json!({"state": "live", "noVideo": true});
    assert_eq!(
        camera_check(f(&silent), None),
        words("No video", Tone::Warn)
    );
    assert_eq!(
        camera_check(f(&json!({"state": "live"})), None),
        preview_source_check("live")
    );
    assert_eq!(
        camera_check(f(&json!({"state": "starting", "noVideo": true})), None),
        preview_source_check("starting")
    );
    assert_eq!(
        camera_no_video_advice(f(&silent), Some("MacBook Pro Camera")).as_deref(),
        Some(
            "MacBook Pro Camera isn't sending video. Close other apps that use it, or choose another camera in Sources."
        )
    );
    assert!(
        camera_no_video_advice(f(&silent), None)
            .unwrap()
            .starts_with("Your camera isn't sending video.")
    );
    assert_eq!(
        camera_no_video_advice(f(&json!({"state": "live"})), Some("MacBook Pro Camera")),
        None
    );
}

#[test]
fn destinations_are_counted_in_glossary_words() {
    assert_eq!(destinations_check(&[]), words("Idle", Tone::Neutral));
    assert_eq!(
        destinations_check(&["live", "ready"]),
        words("1 of 2 on air", Tone::Good)
    );
    assert_eq!(
        destinations_check(&["connecting"]),
        words("1 connecting", Tone::Neutral)
    );
    assert_eq!(destinations_check(&["failed", "live"]).tone, Tone::Warn);
}

#[test]
fn the_preview_path_is_never_native_through_a_fallback_window() {
    assert_eq!(
        preview_path_check(
            Some("native-surface"),
            Some("cametal-layer"),
            None,
            "darwin"
        ),
        words("Native", Tone::Good)
    );
    assert_eq!(
        preview_path_check(Some("native-surface"), Some("none"), None, "darwin"),
        words("Native, unconfirmed", Tone::Warn)
    );
    assert_eq!(
        preview_path_check(
            Some("electron-proof-surface"),
            Some("electron-browser-window"),
            None,
            "win32"
        ),
        words("Fallback window", Tone::Warn)
    );
    assert_eq!(
        preview_path_check(None, None, None, "darwin"),
        words("Off", Tone::Neutral)
    );
}

/// Plan 220 S4.1d: the CPU preview over shared memory is named for what it
/// is, on its platform: never native, never a fallback from something better.
#[test]
fn the_cpu_preview_is_named_and_never_native() {
    let check = preview_path_check(
        Some("cpu-shared-memory"),
        Some("slint-image"),
        Some("in-process"),
        "linux",
    );
    assert_eq!(check.tone, Tone::Neutral);
    assert!(
        check.value == "Linux CPU preview" || check.value == "Windows CPU preview",
        "{}",
        check.value
    );
    assert!(!is_native_preview_capability(
        Some("cpu-shared-memory"),
        Some("slint-image"),
        Some("in-process"),
        "linux"
    ));
    assert!(!is_native_preview_capability(
        Some("cpu-shared-memory"),
        Some("slint-image"),
        Some("in-process"),
        "win32"
    ));
}

#[test]
fn memory_stages_logs_and_cuts_read_in_words() {
    assert_eq!(memory_check(None), words(NO_VALUE, Tone::Neutral));
    assert_eq!(
        memory_check(Some(3.0 * 1024.0 * 1024.0 * 1024.0)).tone,
        Tone::Error
    );
    assert_eq!(
        pipeline_stage_label(&RecordingPipelineStage::Muxer),
        "File writer"
    );
    assert_eq!(
        pipeline_stage_label(&RecordingPipelineStage::VideoEncoder),
        "Video encoder"
    );
    assert_eq!(log_level_label("info"), "Info");
    assert_eq!(log_level_label("warn"), "Warning");
    assert_eq!(log_level_label("error"), "Error");
    assert_eq!(log_level_label("debug-trace"), "Debug trace");
    assert_eq!(
        log_truncation_note(120, 342).as_deref(),
        Some("Showing the last 120 of 342 lines.")
    );
    assert_eq!(log_truncation_note(40, 40), None);
    assert_eq!(group_thousands(1_204), "1,204");
    assert_eq!(group_thousands(999), "999");
    assert_eq!(plural(1, "drop"), "1 drop");
    assert_eq!(plural(1_204, "viewer"), "1,204 viewers");
}

#[test]
fn sources_read_the_drop_window_never_the_run_totals() {
    let healthy = json!({
        "deviceDisconnected": false,
        "duplicateCaptureSources": [],
        "previewCameraDroppedFrames": 0,
        "previewScreenDroppedFrames": 5_065,
        "captureFps": 30,
        "targetFps": 30,
    });
    assert_eq!(
        sources_check(f(&healthy), false),
        words("Healthy", Tone::Good)
    );
    assert_eq!(
        sources_check(f(&healthy), true),
        words("Dropping frames", Tone::Warn)
    );
    let mut disconnected = healthy.clone();
    disconnected["deviceDisconnected"] = json!(true);
    assert_eq!(
        sources_check(f(&disconnected), true),
        words("Device disconnected", Tone::Error)
    );
    let mut twice = healthy.clone();
    twice["duplicateCaptureSources"] = json!(["Screen"]);
    assert_eq!(
        sources_check(f(&twice), true),
        words("Captured twice", Tone::Warn)
    );
    let mut slow = healthy;
    slow["captureFps"] = json!(20);
    assert_eq!(
        sources_check(f(&slow), false),
        words("Capture slow", Tone::Warn)
    );
}

fn crash(signal: Option<&str>, code: Option<i32>, tail: &[&str]) -> CrashRecord {
    CrashRecord {
        at: "2026-11-09T10:00:00Z".to_string(),
        generation: 3,
        code,
        signal: signal.map(str::to_string),
        attempt: Some(1),
        uptime_ms: 125_000,
        intentional: false,
        windows_status: None,
        stderr_tail: tail.iter().map(|line| line.to_string()).collect(),
    }
}

#[test]
fn the_engines_last_exit_reads_as_backend_crash_view() {
    let killed = crash(Some("SIGKILL"), None, &["one", "two"]);
    assert_eq!(crash_exit_label(&killed), "signal SIGKILL");
    assert_eq!(crash_exit_label(&crash(None, Some(101), &[])), "code 101");
    let mut windows = crash(None, Some(-1_073_741_819), &[]);
    windows.windows_status = Some("STATUS_ACCESS_VIOLATION".to_string());
    assert_eq!(
        crash_exit_label(&windows),
        "code 0xC0000005 STATUS_ACCESS_VIOLATION"
    );
    assert_eq!(crash_exit_label(&crash(None, None, &[])), "unknown exit");
    assert_eq!(format_backend_uptime(450), "450ms");
    assert_eq!(format_backend_uptime(12_300), "12.3s");
    assert_eq!(format_backend_uptime(125_000), "2min");
    assert_eq!(format_backend_uptime(5_400_000), "1.5h");
    assert_eq!(crash_headline(&killed).as_deref(), Some("two"));
    let panicked = crash(
        None,
        Some(101),
        &[
            r#"{"panic":"index out of bounds","location":"src/main.rs:12:5","thread":"main"}"#,
            "after",
        ],
    );
    assert_eq!(
        crash_headline(&panicked).as_deref(),
        Some("panic: index out of bounds (src/main.rs:12:5)")
    );
    let note = crash_note(&killed);
    assert!(
        note.title
            .starts_with("Videorc's engine stopped unexpectedly at ")
    );
    assert_eq!(
        note.description,
        "Run 3 · signal SIGKILL · after 2min · restart 1\ntwo\nThe support bundle includes its last 2 output lines."
    );
    assert_eq!(
        crash_note(&crash(None, None, &[]))
            .description
            .lines()
            .nth(1),
        Some(copy::ENGINE_PRINTED_NOTHING)
    );
}

#[test]
fn the_studio_capture_alert_reads_degraded_on_the_cpu_fallback() {
    let fallback = json!({"compositorBackend": "cpu-fallback"});
    let health = studio_health(f(&fallback), false, "darwin", None);
    assert_eq!(health.tone, Tone::Error);
    assert_eq!(health.value, "Degraded");
    assert!(health.detail.unwrap().contains("without the graphics card"));
    let frames = json!({"compositorBackend": "metal", "compositorCpuFallbackFrames": 3,
        "previewTransport": "native-surface", "previewSurfaceBacking": "cametal-layer"});
    assert_eq!(
        studio_health(f(&frames), true, "darwin", None).value,
        "Degraded"
    );
    assert_eq!(
        studio_health(f(&frames), false, "darwin", None).value,
        "Ready"
    );
    let polling = json!({"compositorBackend": "metal", "previewTransport": "latest-jpeg-polling"});
    assert_eq!(
        studio_health(f(&polling), false, "darwin", None).value,
        "Fallback"
    );
    assert_eq!(
        studio_health(f(&polling), false, "linux", None).value,
        "Ready"
    );
    let lagging = json!({"compositorBackend": "metal", "previewTransport": "native-surface",
        "previewSurfaceBacking": "cametal-layer", "previewInputToPresentLatencyP95Ms": 80});
    assert_eq!(
        studio_health(f(&lagging), true, "darwin", None).value,
        "Lagging"
    );
    assert_eq!(
        studio_health(f(&json!({})), false, "darwin", None).value,
        "Idle"
    );
}

fn summary(ffmpeg: bool) -> HealthSummary {
    let mut summary = HealthSummary::default();
    summary.set_backend(BackendHealth {
        status: "ok".to_string(),
        version: "0.0.0".to_string(),
        platform: "macos".to_string(),
        ffmpeg: ToolStatus {
            path: "ffmpeg".to_string(),
            available: ffmpeg,
            version: Some("7.1".to_string()),
            message: None,
        },
        database_path: String::new(),
        secret_store_backend: "test".to_string(),
    });
    summary
}

#[test]
fn an_idle_test_pattern_reads_as_the_electron_baseline_does() {
    // S0.1a's profile: the test pattern, no camera, the preview unavailable.
    let now = Instant::now();
    let mut telemetry = HealthTelemetry::default();
    telemetry.apply(
        DIAGNOSTICS_STATS_EVENT,
        json!({"bottleneck": "none", "droppedFrames": 0, "skippedFrames": 0,
            "duplicateCaptureSources": [], "backendRssBytes": 104_857_600,
            "previewTransport": "unavailable", "previewSurfaceBacking": "none"}),
        now,
    );
    let summary = summary(true);
    let log = RecordingLog::default();
    let sources = json!({});
    let view = health_page(&PageInputs {
        telemetry: &telemetry,
        summary: &summary,
        capture_sources: f(&sources),
        native_preview_surface_enabled: true,
        platform: "darwin",
        development: true,
        pipeline: None,
        device_warnings: &[],
        recording_log: &log,
        app_log: &[],
        crash: None,
        record_latency: &Default::default(),
        camera: Default::default(),
        linux_keyring: None,
        linux_desktop: None,
        now,
    });
    assert_eq!(view.checks.len(), 13);
    assert_eq!(
        copy::show_all_checks(view.checks.len()),
        "Show all checks (13)"
    );
    let attention: Vec<(&str, &str)> = view
        .checks
        .iter()
        .filter(|check| check_needs_attention(check.tone))
        .map(|check| (check.label, check.value.as_str()))
        .collect();
    assert_eq!(attention, [("Preview", "Unavailable")]);
    assert_eq!(view.verdict.title, "1 thing needs attention: Preview");
    assert_eq!(view.verdict.variant, VerdictVariant::Warning);
    assert_eq!(view.ffmpeg_missing, None);
    let titles: Vec<&str> = view
        .groups
        .iter()
        .map(|group| group.title.as_str())
        .collect();
    assert_eq!(
        titles,
        [
            "Overview",
            "Start and stop",
            "App connection",
            "Preview",
            "Recording and encoder",
            "System and sources",
            "Pipeline",
            "Log of the last recording",
            "App log",
        ]
    );
    // The Preview group opens itself (the Preview check is amber).
    assert!(view.groups[3].attention);
    assert!(!view.groups[0].attention);
    assert_eq!(view.groups[6].empty, copy::NOTHING_RECORDING);
    assert_eq!(view.groups[7].empty, copy::NO_RECORDINGS);
    assert_eq!(view.groups[8].empty, copy::APP_LOG_EMPTY);
    assert_eq!(view.groups[8].meta, "0 lines");
    let encoder = &view.groups[4].metrics;
    assert_eq!(encoder[0], metric("FFmpeg", "Ready · 7.1"));
    let overview = &view.groups[0].metrics;
    assert_eq!(overview[0], metric("Output mode", "Idle"));
    // `0 || undefined`: no stream, so the placeholder.
    assert_eq!(
        overview
            .iter()
            .find(|metric| metric.label == "Dropped frames")
            .unwrap()
            .value,
        NO_VALUE
    );
}

#[test]
fn a_missing_recorder_says_so_and_opens_its_group() {
    let now = Instant::now();
    let telemetry = HealthTelemetry::default();
    let summary = summary(false);
    let log = RecordingLog::default();
    let sources = json!({"cameraId": "cam"});
    let pipeline = RecordingPipelineStatus {
        container: RecordingContainer::Mkv,
        finalization: RecordingFinalizationState::Finalizing,
        stages: vec![RecordingPipelineStageStatus {
            stage: RecordingPipelineStage::Muxer,
            state: RecordingPipelineStageState::Failed,
            detail: Some("disk full".to_string()),
        }],
    };
    let view = health_page(&PageInputs {
        telemetry: &telemetry,
        summary: &summary,
        capture_sources: f(&sources),
        native_preview_surface_enabled: true,
        platform: "darwin",
        development: false,
        pipeline: Some(&pipeline),
        device_warnings: &[
            "Camera permission is needed".to_string(),
            "A device went away".to_string(),
        ],
        recording_log: &log,
        app_log: &[],
        crash: None,
        record_latency: &Default::default(),
        camera: Default::default(),
        linux_keyring: None,
        linux_desktop: None,
        now,
    });
    assert_eq!(view.ffmpeg_missing, Some(copy::FFMPEG_MISSING_PACKAGED));
    let encoder = &view.groups[4];
    assert!(encoder.attention);
    assert_eq!(encoder.metrics[0], metric("FFmpeg", "Missing"));
    let system = &view.groups[5];
    assert_eq!(system.warnings, ["A device went away"]);
    assert!(system.attention);
    let stages = &view.groups[6];
    assert!(stages.attention);
    assert_eq!(
        stages.stages,
        [(
            "File writer".to_string(),
            "disk full".to_string(),
            words("Failed", Tone::Error)
        )]
    );
}

#[test]
fn logs_say_whose_they_are_and_when_they_were_cut() {
    let entry = |index: usize| videorc_protocol::SessionLogEntry {
        id: index.to_string(),
        session_id: "s".to_string(),
        level: videorc_protocol::HealthLevel::Warn,
        code: "encoder-slow".to_string(),
        message: format!("line {index}"),
        source_id: None,
        permission_pane: None,
        created_at: "2026-11-09T10:00:00Z".to_string(),
    };
    let log = RecordingLog {
        session_id: Some("s".to_string()),
        title: Some("Session 2026-11-09 10:00".to_string()),
        log_count: 342,
        current: true,
        loading: false,
        failed: false,
        entries: (0..150).map(entry).collect(),
    };
    let group = recording_log_group(&log);
    assert_eq!(group.title, copy::LOG_OF_THIS_RECORDING);
    assert_eq!(group.meta, "Session 2026-11-09 10:00");
    assert_eq!(group.logs.len(), RECORDING_LOG_LIMIT);
    assert_eq!(group.logs[0].message, "line 30");
    assert_eq!(group.logs[0].level, "Warning");
    assert_eq!(group.logs[0].badge, "warning");
    assert_eq!(group.logs[0].code, "encoder-slow");
    assert_eq!(group.note, "Showing the last 120 of 342 lines.");
    let failed = recording_log_group(&RecordingLog {
        failed: true,
        entries: Vec::new(),
        ..log
    });
    assert_eq!(failed.empty, copy::LOG_FAILED);
    assert!(failed.empty_warns);

    let lines: Vec<LogLine> = (0..90)
        .map(|index| LogLine {
            level: crate::log::Level::Info,
            message: format!("app {index}"),
            timestamp: "2026-11-09T10:00:00Z".to_string(),
        })
        .collect();
    let app = app_log_group(&lines, None);
    assert_eq!(app.logs.len(), APP_LOG_LIMIT);
    assert_eq!(app.logs[0].message, "app 10");
    assert_eq!(app.meta, "90 lines");
    assert_eq!(
        app.note,
        "Showing the last 80 lines. The support bundle keeps more."
    );
}

#[test]
fn the_formatters_write_what_the_renderer_writes() {
    assert_eq!(format_metric(Some(29.94), "fps"), "29.9 fps");
    assert_eq!(format_metric(Some(1.0), "x"), "1.00 x");
    assert_eq!(format_metric(None, "fps"), NO_VALUE);
    assert_eq!(format_bitrate(Some(6_000.0)).as_deref(), Some("6 Mbps"));
    assert_eq!(format_bitrate(Some(4_480.0)).as_deref(), Some("4.5 Mbps"));
    assert_eq!(format_bitrate(Some(-1.0)), None);
    assert_eq!(format_frame_rate(30.0), "30 fps");
    assert_eq!(format_frame_rate(29.97), "29.97 fps");
    assert_eq!(format_bytes(Some(307_200.0)), "300 KiB");
    assert_eq!(format_bytes(Some(13_107_200.0)), "12.5 MiB");
    assert_eq!(format_optional_counter(Some(1_204.4)), "1,204");
    assert_eq!(format_optional_counter(Some(-3.0)), "0");
    assert_eq!(format_ms(Some(12.6)), "13 ms");
    assert_eq!(status_word_from_value("device-missing"), "Device missing");
    assert_eq!(
        status_word_from_value("record_and_stream"),
        "Record and stream"
    );
    assert_eq!(
        format_web_socket_queue(f(&json!({"currentDepth": 1, "maxDepth": 8,
            "coalescedCount": 2, "evictedOrDroppedCount": 0}))),
        "1/8 current/max · – oldest · 2 coalesced · 0 evicted/dropped"
    );
    let timeline = json!({"kind": "start", "cold": true, "clickToOriginMs": 12, "totalMs": 840,
        "outcome": "recording", "marks": [{"phase": "barrier", "atMs": 100},
        {"phase": "encoder", "atMs": 700}]});
    assert_eq!(
        format_timeline_summary(f(&timeline)),
        "840 ms · recording · cold · 12 ms click→engine"
    );
    assert_eq!(format_slowest_phase(f(&timeline)), "encoder · 600 ms");
    assert_eq!(format_timeline_summary(Fields::of(None)), NO_VALUE);
    assert_eq!(format_slowest_phase(Fields::of(None)), NO_VALUE);
}

/// Every key the page reads (`.num("…")`, `.count("…")` and the rest) is a
/// field the backend's protocol writes, so a typo never reads as a
/// placeholder forever.
#[test]
fn every_field_the_page_reads_is_one_the_backend_writes() {
    const SOURCE: &str = include_str!("health_page.rs");
    const PROTOCOL: [&str; 3] = [
        include_str!("../../../videorc-protocol/src/lib.rs"),
        include_str!("../../../videorc-protocol/src/source_registry.rs"),
        include_str!("../../../videorc-protocol/src/source_status.rs"),
    ];
    /// Read from outside the protocol, each with where it comes from.
    const ELSEWHERE: [(&str, &str); 5] = [
        (
            "firstFrameContract",
            "Electron main's first-frame contract, on the surface status (Linux app window)",
        ),
        (
            "cameraName",
            "the capture config's sources (`lib/capture.ts`)",
        ),
        (
            "nativePreviewHostKind",
            "Electron main's field on the surface status; absent from the backend's",
        ),
        (
            "proofSourceFps",
            "Electron main's proof poller, on the surface status (Linux app window)",
        ),
        (
            "proofFrameLatencyP95Ms",
            "Electron main's proof poller, on the surface status (Linux app window)",
        ),
    ];
    let mut keys: Vec<String> = Vec::new();
    for name in [
        "num", "count", "text", "flag", "is_false", "strings", "object", "entries", "c", "ms", "n",
    ] {
        let needle = format!("{name}(\"");
        let mut from = 0;
        while let Some(at) = SOURCE[from..].find(&needle) {
            let start = from + at;
            from = start + needle.len();
            let before = SOURCE[..start].chars().next_back();
            if before.is_some_and(|ch| ch.is_alphanumeric() || ch == '_') {
                continue;
            }
            let end = SOURCE[from..].find('"').unwrap();
            keys.push(SOURCE[from..from + end].to_string());
        }
    }
    // The queue fields `overview_metrics` builds by role.
    for role in ["Recording", "Stream"] {
        for part in [
            "Depth",
            "OldestFrameAgeMs",
            "CapacityPressureEvents",
            "DroppedFrames",
        ] {
            keys.push(format!("encoderBridge{role}Queue{part}"));
        }
    }
    keys.sort();
    keys.dedup();
    assert!(keys.len() > 100, "found {} keys", keys.len());
    let snake = |key: &str| {
        let mut out = String::new();
        for (index, ch) in key.chars().enumerate() {
            if ch.is_ascii_uppercase() {
                if index > 0 {
                    out.push('_');
                }
                out.push(ch.to_ascii_lowercase());
            } else {
                out.push(ch);
            }
        }
        out
    };
    let missing: Vec<&String> = keys
        .iter()
        .filter(|key| {
            !ELSEWHERE.iter().any(|(name, _)| name == key)
                && !PROTOCOL.iter().any(|source| {
                    source.contains(&format!("pub {}:", snake(key)))
                        || source.contains(&format!("rename = \"{key}\""))
                })
        })
        .collect();
    assert!(
        missing.is_empty(),
        "fields the protocol does not write: {missing:?}"
    );
}

#[test]
fn linux_adds_its_desktop_rows_alerts_and_app_window_numbers() {
    // Plan 257 S18 (#1678) and S3 (#1690): Electron appends the Linux rows
    // after File repair, shows one alert per problem, and names the app
    // window's own preview numbers.
    let now = Instant::now();
    let mut telemetry = HealthTelemetry::default();
    telemetry.apply(
        DIAGNOSTICS_STATS_EVENT,
        json!({"bottleneck": "none", "backendRssBytes": 104_857_600,
            "previewTransport": "electron-proof-surface"}),
        now,
    );
    telemetry.preview_surface =
        Some(json!({"proofSourceFps": 29.96, "proofFrameLatencyP95Ms": 41.5}));
    let summary = summary(true);
    let log = RecordingLog::default();
    let sources = json!({});
    let keyring = crate::studio::linux_desktop::LinuxKeyringStatus {
        backend: "gnome_libsecret".to_string(),
        available: true,
        user_password_store: None,
    };
    let desktop = json!({
        "groups": [
            {"name": "video", "exists": true, "member": false, "accessible": 0, "devices": 1},
            {"name": "render", "exists": true, "member": true, "accessible": 1, "devices": 1}
        ],
        "portal": {"frontend": "running", "screenCastVersion": 5}
    });
    let latency = crate::studio::latency::RecordLatency::default();
    let inputs = |platform| PageInputs {
        telemetry: &telemetry,
        summary: &summary,
        capture_sources: f(&sources),
        native_preview_surface_enabled: false,
        platform,
        development: true,
        pipeline: None,
        device_warnings: &[],
        recording_log: &log,
        app_log: &[],
        crash: None,
        record_latency: &latency,
        camera: Default::default(),
        linux_keyring: Some(&keyring),
        linux_desktop: Some(&desktop),
        now,
    };
    let view = health_page(&inputs("linux"));
    let tail: Vec<(&str, &str)> = view.checks[13..]
        .iter()
        .map(|check| (check.label, check.value.as_str()))
        .collect();
    assert_eq!(
        tail,
        [
            ("Keyring", "Secret Service"),
            ("Device groups", "Not in video"),
            ("Screen portal", "Ready")
        ]
    );
    assert_eq!(view.checks[12].label, "File repair");
    let issues: Vec<&str> = view.linux_issues.iter().map(|issue| issue.id).collect();
    assert_eq!(issues, ["device-groups"]);
    let preview = view
        .groups
        .iter()
        .find(|group| group.id == "preview")
        .unwrap();
    let first: Vec<(&str, &str)> = preview.metrics[..3]
        .iter()
        .map(|m| (m.label.as_str(), m.value.as_str()))
        .collect();
    assert_eq!(
        first,
        [
            ("Preview mode", "App window"),
            ("Preview frames shown", "30.0 fps"),
            ("Preview latency (p95)", "42 ms")
        ]
    );

    let mac = health_page(&inputs("darwin"));
    assert_eq!(mac.checks.len(), 13);
    assert!(mac.linux_issues.is_empty());
    let preview = mac
        .groups
        .iter()
        .find(|group| group.id == "preview")
        .unwrap();
    assert_eq!(preview.metrics[0].value, "Fallback window");
    assert_eq!(preview.metrics[1].label, "Graphics");
}

#[test]
fn the_linux_app_window_is_its_own_preview_path_and_speed() {
    // Plan 257 S3 (#1690): on Linux the proof surface is the Preview,
    // "App window" and judged by what it shows; elsewhere it stays a fallback.
    assert_eq!(
        preview_path_check(
            Some("electron-proof-surface"),
            Some("electron-browser-window"),
            None,
            "linux"
        ),
        words("App window", Tone::Good)
    );
    assert_eq!(
        preview_path_check(
            Some("electron-proof-surface"),
            Some("electron-browser-window"),
            None,
            "win32"
        ),
        words("Fallback window", Tone::Warn)
    );
    let stats = json!({"previewTransport": "electron-proof-surface", "previewTargetFps": 30,
        "previewRenderFrameTimeP95Ms": 400, "previewDroppedFrames": 9});
    let camera = json!({"state": "live", "sourceFps": 30});
    let live = json!({"state": "live"});
    let speed = |platform, surface: &Value| {
        preview_speed_check(&PreviewInputs {
            stats: f(&stats),
            expects_camera: true,
            expects_screen: false,
            native_preview_surface_enabled: true,
            platform,
            camera: f(&camera),
            live: f(&live),
            screen: f(&Value::Null),
            surface: f(surface),
            camera_low: None,
        })
    };
    let smooth = json!({"source": "camera", "proofSourceFps": 29});
    // The Electron-path render and drop numbers don't judge the app window.
    assert_eq!(speed("linux", &smooth), words("Smooth", Tone::Good));
    assert_eq!(speed("win32", &smooth), words("Fallback", Tone::Warn));
    let slow = json!({"source": "camera", "proofSourceFps": 20});
    assert_eq!(speed("linux", &slow), words("Slow display", Tone::Warn));
    let hidden = json!({"source": "camera", "proofSourceFps": 0, "bounds": {"visible": false}});
    assert_eq!(speed("linux", &hidden), words("Smooth", Tone::Good));
    let suppressed =
        json!({"source": "camera", "proofSourceFps": 0, "framePollingSuppressed": true});
    assert_eq!(speed("linux", &suppressed), words("Smooth", Tone::Good));
    let stalled =
        json!({"source": "camera", "proofSourceFps": 29, "firstFrameContract": "fallback"});
    assert_eq!(speed("linux", &stalled), words("Stalled", Tone::Warn));
}
