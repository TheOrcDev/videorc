//! Plan 220 S2.4a, the Done-when: the Studio drives a session from idle to
//! recording to stopped against the real debug backend, in an isolated temp
//! profile whose recordings directory is inside the temp dir, with the
//! synthetic test pattern only (no camera, screen or microphone is opened;
//! nothing streams). The recording finalises, the file exists and is not
//! empty, and the test deletes it.
//!
//! Needs `cargo build -p videorc-backend` first (or `VIDEORC_BACKEND_BINARY`).
//!
//! Plan 260 S1.6a: today's backend has no `ui.settings.*` yet (L2's S1.4
//! adds it), so the test's backend is the real client with the settings
//! store kept in memory ([`StoreBackend`]); every other request goes to the
//! real backend.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use videorc_app_core::StudioBackend;
use videorc_app_core::client::RpcError;
use videorc_app_core::client::methods::RemoteIntentAckParams;
use videorc_app_core::client::{BackendClient, ClientConfig, EventFilter};
use videorc_app_core::studio::ui_settings_wire::{
    UiSettingsChange, UiSettingsGetParams, UiSettingsSetParams, UiSettingsSnapshot,
};
use videorc_app_core::studio::{
    Connection, STUDIO_EVENTS, SessionEffect, SessionPhase, StartOutcome, StopOrigin, StopOutcome,
    Studio, StudioConfig, keys,
};
use videorc_app_core::supervisor::STOP_GRACE;
use videorc_app_core::{AppPaths, BackendLaunch, Logger, Supervisor, SupervisorConfig};
use videorc_protocol::{
    AudioProcessingUpdateParams, AudioProcessingUpdateResult, BackendHealth, DeviceList,
    PreviewScreenStartParams, PreviewScreenStatus, RecordingFinalizationState, RecordingStatus,
    Scene, SessionDetailListParams, SessionHealthEventsPage, SessionListPage, SessionListParams,
    SessionLogsPage, SessionStopParams, StartSessionParams,
};

/// The real backend for every request but the UI settings store, which
/// today's backend does not have: a store in memory with the backend's
/// answers (a revision per landed batch).
struct StoreBackend {
    client: Arc<BackendClient>,
    store: Mutex<(BTreeMap<String, Value>, u64)>,
}

impl StudioBackend for StoreBackend {
    async fn health(&self) -> Result<BackendHealth, RpcError> {
        StudioBackend::health(&*self.client).await
    }
    async fn devices(&self) -> Result<DeviceList, RpcError> {
        StudioBackend::devices(&*self.client).await
    }
    async fn recording_status(&self) -> Result<RecordingStatus, RpcError> {
        StudioBackend::recording_status(&*self.client).await
    }
    async fn scene(&self) -> Result<Scene, RpcError> {
        StudioBackend::scene(&*self.client).await
    }
    async fn settings_get(&self, _: UiSettingsGetParams) -> Result<UiSettingsSnapshot, RpcError> {
        let store = self.store.lock().unwrap();
        Ok(UiSettingsSnapshot {
            entries: store.0.clone(),
            revision: store.1,
            local_storage_migrated: true,
        })
    }
    async fn settings_set(
        &self,
        params: UiSettingsSetParams,
    ) -> Result<UiSettingsChange, RpcError> {
        let mut store = self.store.lock().unwrap();
        for (key, value) in &params.put {
            store.0.insert(key.clone(), value.clone());
        }
        for key in &params.delete {
            store.0.remove(key);
        }
        store.1 += 1;
        Ok(UiSettingsChange {
            revision: store.1,
            put: params.put,
            delete: params.delete,
            writer: params.writer,
        })
    }
    async fn session_start(&self, params: StartSessionParams) -> Result<RecordingStatus, RpcError> {
        StudioBackend::session_start(&*self.client, params).await
    }
    async fn session_stop(&self, params: SessionStopParams) -> Result<RecordingStatus, RpcError> {
        StudioBackend::session_stop(&*self.client, params).await
    }
    async fn audio_processing_update(
        &self,
        params: AudioProcessingUpdateParams,
    ) -> Result<AudioProcessingUpdateResult, RpcError> {
        StudioBackend::audio_processing_update(&*self.client, params).await
    }
    async fn remote_intent_ack(&self, params: RemoteIntentAckParams) -> Result<(), RpcError> {
        StudioBackend::remote_intent_ack(&*self.client, params).await
    }
    async fn remote_surface_publish(&self, snapshot: Value) -> Result<(), RpcError> {
        StudioBackend::remote_surface_publish(&*self.client, snapshot).await
    }
    async fn preview_screen_start(
        &self,
        params: PreviewScreenStartParams,
    ) -> Result<PreviewScreenStatus, RpcError> {
        StudioBackend::preview_screen_start(&*self.client, params).await
    }
    async fn sessions_list(&self, params: SessionListParams) -> Result<SessionListPage, RpcError> {
        StudioBackend::sessions_list(&*self.client, params).await
    }
    async fn session_health_events(
        &self,
        params: SessionDetailListParams,
    ) -> Result<SessionHealthEventsPage, RpcError> {
        StudioBackend::session_health_events(&*self.client, params).await
    }
    async fn session_logs(
        &self,
        params: SessionDetailListParams,
    ) -> Result<SessionLogsPage, RpcError> {
        StudioBackend::session_logs(&*self.client, params).await
    }
    async fn telemetry_read(&self, method: &'static str) -> Result<Value, RpcError> {
        StudioBackend::telemetry_read(&*self.client, method).await
    }
}

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const PHASE_TIMEOUT: Duration = Duration::from_secs(90);
const FINALIZATION_TIMEOUT: Duration = Duration::from_secs(180);
const RECORD_FOR: Duration = Duration::from_secs(4);

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("the workspace root exists")
}

fn supervisor_config(profile: &Path) -> SupervisorConfig {
    let root = workspace_root();
    let binary = std::env::var_os("VIDEORC_BACKEND_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            root.join("target")
                .join("debug")
                .join(videorc_app_core::process::backend_binary_name())
        });
    assert!(
        binary.is_file(),
        "the debug backend {} is missing; run `cargo build -p videorc-backend` first (or set VIDEORC_BACKEND_BINARY)",
        binary.display()
    );
    let paths = AppPaths::profile(profile);
    let mut launch = BackendLaunch::binary(binary, &root, paths.user_data_dir.clone());
    launch.ready_timeout = READY_TIMEOUT;
    launch.app_version = Some("0.0.0-test".to_string());
    SupervisorConfig {
        launch,
        paths,
        workspace_root: root,
        logger: Logger::new(None, true),
        stop_grace: STOP_GRACE,
    }
}

/// Waits until the snapshot satisfies `done`, or fails after `timeout`.
async fn wait_until<B: StudioBackend>(
    studio: &Studio<B>,
    what: &str,
    timeout: Duration,
    mut done: impl FnMut(&videorc_app_core::StudioSnapshot) -> bool,
) {
    let mut watch = studio.watch();
    tokio::time::timeout(timeout, async {
        loop {
            if done(&watch.borrow_and_update()) {
                return;
            }
            watch.changed().await.expect("the studio lives");
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "no {what} within {timeout:?}; last snapshot: {:?}",
            studio.snapshot().session
        )
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the debug backend: cargo build -p videorc-backend, then cargo test -p videorc-app-core --test studio_session -- --ignored"]
async fn the_studio_records_the_test_pattern_from_idle_to_stopped() {
    let profile = tempfile::Builder::new()
        .prefix("videorc-studio-session-")
        .tempdir()
        .unwrap();
    let profile_dir = profile.path().canonicalize().unwrap();
    let supervisor = Supervisor::start(supervisor_config(profile.path()));
    let bootstrap = supervisor
        .wait_ready(READY_TIMEOUT)
        .await
        .expect("the backend becomes ready");

    let logger = Logger::new(None, true);
    let (client, events) = BackendClient::start(
        supervisor.state(),
        ClientConfig {
            filter: EventFilter::include(STUDIO_EVENTS),
            logger: logger.clone(),
            ..ClientConfig::default()
        },
    );
    let client = Arc::new(client);
    let backend = Arc::new(StoreBackend {
        client: client.clone(),
        store: Mutex::new((BTreeMap::new(), 0)),
    });
    let studio = Arc::new(Studio::new(
        backend.clone(),
        StudioConfig {
            logger: logger.clone(),
            ..StudioConfig::default()
        },
    ));
    let mut effects = studio.effects();
    let driver = tokio::spawn(studio.clone().drive(events));

    // Every phase change, in order, from a watcher that misses none.
    let phases = Arc::new(std::sync::Mutex::new(vec![studio.snapshot().session.phase]));
    let observer = {
        let phases = phases.clone();
        let mut watch = studio.watch();
        tokio::spawn(async move {
            while watch.changed().await.is_ok() {
                let phase = watch.borrow().session.phase;
                let mut phases = phases.lock().unwrap();
                if phases.last() != Some(&phase) {
                    phases.push(phase);
                }
            }
        })
    };

    // Connected and bootstrapped: health, devices, status, scene, settings.
    wait_until(&studio, "bootstrap", READY_TIMEOUT, |snapshot| {
        snapshot.bootstrapped
    })
    .await;
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot.connection,
        Connection::Connected { pid: bootstrap.pid }
    );
    assert_eq!(snapshot.session.phase, SessionPhase::Idle);
    assert!(snapshot.sources.devices_known);
    assert!(snapshot.sources.scene.is_some(), "scene.get answered");
    assert!(snapshot.settings.hydrated, "ui.settings.get answered");
    assert!(
        snapshot.health.ffmpeg_available(),
        "FFmpeg must be available to record: {:?}",
        snapshot.health.backend
    );
    eprintln!(
        "[studio-session] bootstrapped: {} device(s), health {:?}, settings revision {}",
        snapshot.sources.devices.devices.len(),
        snapshot.health.tone(),
        snapshot.settings.revision
    );

    // The capture config, through the persisted settings: the test pattern
    // at 640x360, 30 fps, no microphone.
    studio
        .put_setting(
            keys::CAPTURE_CONFIG,
            &json!({
                "video": {"preset": "custom", "width": 640, "height": 360, "fps": 30, "bitrateKbps": 2000},
                "recordEnabled": true,
                "streamEnabled": false
            }),
        )
        .await
        .expect("ui.settings.set");
    // The Clips ring is not part of this core yet (its arming lands with
    // Output), so this run's sessions are the streamer's own.
    // S3.0d: the test pattern is the Sources page's switch for this run,
    // never part of the stored config (as in the renderer).
    studio
        .set_test_pattern(true)
        .await
        .expect("the test pattern switch");
    let capture = studio.snapshot().settings.capture;
    assert!(capture.sources.test_pattern);
    assert_eq!((capture.video.width, capture.video.height), (640, 360));
    // Keep the capture MKV next to the exported MP4, so both files can be
    // checked after the export (the default removes the MKV).
    let mut settings = studio.snapshot().settings.studio;
    settings.set("keepOriginalRecording", json!(true));
    studio
        .set_studio_settings(&settings)
        .await
        .expect("ui.settings.set");
    assert!(studio.snapshot().settings.studio.keep_original_recording());

    // Record.
    let started = studio.start_recording().await;
    assert_eq!(
        started,
        StartOutcome::Started,
        "{:?}",
        studio.snapshot().session
    );
    wait_until(&studio, "recording", PHASE_TIMEOUT, |snapshot| {
        snapshot.session.phase == SessionPhase::Recording
    })
    .await;
    let running = studio.snapshot().session;
    let session_id = running
        .status
        .session_id
        .clone()
        .expect("a running session has an id");
    eprintln!(
        "[studio-session] recording: session {session_id}, output {:?}",
        running.status.output_path
    );
    assert!(!running.start_pending);
    assert!(running.start_failure.is_none());
    tokio::time::sleep(RECORD_FOR).await;

    // Stop: a recording stops at once, no question.
    let stopped = studio.request_stop(StopOrigin::Button).await;
    assert_eq!(
        stopped,
        StopOutcome::Stopped(true),
        "{:?}",
        studio.snapshot().session
    );
    wait_until(&studio, "idle after the stop", PHASE_TIMEOUT, |snapshot| {
        snapshot.session.phase == SessionPhase::Idle
    })
    .await;
    let ended = studio.snapshot().session;
    assert_eq!(
        ended.status.session_id.as_deref(),
        Some(session_id.as_str())
    );
    assert!(!ended.stop_pending);
    assert!(
        ended.notice.is_none(),
        "no failure notice: {:?}",
        ended.notice
    );
    let output_path = PathBuf::from(
        ended
            .status
            .output_path
            .clone()
            .expect("the terminal status names the file"),
    );
    let mkv_size_at_stop = std::fs::metadata(&output_path)
        .expect("the capture MKV exists when the stop answers")
        .len();
    assert!(mkv_size_at_stop > 0, "{} is empty", output_path.display());
    eprintln!(
        "[studio-session] stopped: {:?} ({mkv_size_at_stop} bytes), duration {:?} ms, pipeline {:?}",
        output_path, ended.status.duration_ms, ended.status.pipeline
    );

    // The recording finalises (the MP4 export runs in the background).
    wait_until(&studio, "finalization", FINALIZATION_TIMEOUT, |snapshot| {
        snapshot.session.finalization.as_ref().is_some_and(|event| {
            event.session_id == session_id
                && matches!(
                    event.state,
                    RecordingFinalizationState::Finalized | RecordingFinalizationState::Failed
                )
        })
    })
    .await;
    let finalization = studio
        .snapshot()
        .session
        .finalization
        .expect("the finalization");
    assert_eq!(
        finalization.state,
        RecordingFinalizationState::Finalized,
        "{finalization:?}"
    );

    // Both files exist, are not empty, and live inside the temp profile.
    let output_path = output_path
        .canonicalize()
        .expect("the kept capture MKV exists");
    assert!(
        output_path.starts_with(&profile_dir),
        "{} is outside the temp profile {}",
        output_path.display(),
        profile_dir.display()
    );
    let size = std::fs::metadata(&output_path).unwrap().len();
    assert!(size > 0, "{} is empty", output_path.display());
    let mp4 = PathBuf::from(
        finalization
            .mp4_path
            .as_deref()
            .expect("the export names the MP4"),
    )
    .canonicalize()
    .expect("the exported MP4 exists");
    assert!(
        mp4.starts_with(&profile_dir),
        "{} is outside the temp profile",
        mp4.display()
    );
    let mp4_size = std::fs::metadata(&mp4).unwrap().len();
    assert!(mp4_size > 0, "{} is empty", mp4.display());
    eprintln!(
        "[studio-session] finalized: {} ({size} bytes), mp4 {} ({mp4_size} bytes)",
        output_path.display(),
        mp4.display()
    );

    // S2.4b's Done-when: the recording passes the recording analyzer
    // (`scripts/analyze-recording.mjs`, the strict gates; exit 0 is a pass).
    // No microphone is selected, so the paced-silence track is not a
    // microphone that recorded nothing: `--no-expect-audio` says so (the
    // analyzer would otherwise infer one from the track's presence).
    let analyzer = std::process::Command::new("node")
        .arg(workspace_root().join("scripts/analyze-recording.mjs"))
        .arg(&mp4)
        .args(["--no-report", "--fps", "30", "--no-expect-audio"])
        .current_dir(workspace_root())
        .env_remove("T3CODE_THREAD_ID")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .output()
        .expect("run node scripts/analyze-recording.mjs (node on PATH)");
    let report = String::from_utf8_lossy(&analyzer.stdout);
    eprintln!("[studio-session] analyzer:\n{}", report.trim());
    assert!(
        analyzer.status.success(),
        "the recording analyzer failed ({:?}):\n{report}\n{}",
        analyzer.status.code(),
        String::from_utf8_lossy(&analyzer.stderr)
    );
    assert!(report.contains("PASS"), "{report}");
    std::fs::remove_file(&mp4).unwrap();
    std::fs::remove_file(&output_path).unwrap();
    assert!(!output_path.exists() && !mp4.exists());

    // The effects a UI acts on, in order.
    let mut seen = Vec::new();
    while let Ok(effect) = effects.try_recv() {
        seen.push(effect);
    }
    assert!(
        matches!(
            seen.first(),
            Some(SessionEffect::SessionStarted { session_id: Some(id) }) if *id == session_id
        ),
        "{seen:?}"
    );
    assert!(
        seen.iter().any(|effect| matches!(
            effect,
            SessionEffect::RecordingSaved { session_id: Some(id), output_path: Some(_) } if *id == session_id
        )),
        "{seen:?}"
    );
    assert!(
        !seen
            .iter()
            .any(|effect| matches!(effect, SessionEffect::RecordingFailed(_))),
        "{seen:?}"
    );

    // The driver holds the studio, the studio the client: end them in order.
    driver.abort();
    let _ = driver.await;
    drop(studio);
    observer.await.unwrap();
    drop(backend);
    let client = Arc::try_unwrap(client)
        .ok()
        .expect("the studio released the client");
    client.close().await;
    let phases = phases.lock().unwrap().clone();
    eprintln!("[studio-session] phases: {phases:?}");
    // `stopping` is pushed while the stop runs; whether the watcher sees it
    // before the terminal answer lands depends on the two lanes' timing.
    assert!(
        phases.starts_with(&[
            SessionPhase::Idle,
            SessionPhase::Starting,
            SessionPhase::Recording
        ]) && phases.last() == Some(&SessionPhase::Idle)
            && !phases.contains(&SessionPhase::Failed)
            && phases.len() <= 5,
        "{phases:?}"
    );

    let outcome = supervisor.stop().await;
    assert!(
        outcome.stray_pids.is_empty(),
        "stray pids after stop: {:?}",
        outcome.stray_pids
    );
    let _ = std::fs::remove_dir_all(profile.path());
}
