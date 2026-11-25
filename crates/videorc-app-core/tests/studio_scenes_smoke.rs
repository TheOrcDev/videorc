//! Plan 260 S1.6b part 3c: the Studio's scene switch against the real debug
//! backend, in an isolated temp profile, with the synthetic test pattern
//! only (no camera, screen or microphone is opened; nothing records or
//! streams).
//!
//! The Studio bootstraps, a new profile's scenes are migrated, and the idle
//! switch puts "Camera only" on stream (`apply_saved_scene`): the backend's
//! scene layout changes and the library's `onStreamId` follows. A second
//! scene, set to show the test pattern first (its Screen pick, D2), goes on
//! the same way; then a scene that is not on stream is deleted.
//!
//! Camera only shows no screen, so it keeps the running capture (D18): with
//! the test pattern on, it commits the test pattern and no camera (none is
//! chosen in a new profile, and the Studio withholds device defaults). The
//! other scenes show the main display; one of them is changed to show the
//! test pattern before it goes on, so no screen capture is asked for.
//!
//! Needs `cargo build -p videorc-backend` first (or `VIDEORC_BACKEND_BINARY`).
//! The settings store is kept in memory ([`StoreBackend`]), as in
//! `studio_session.rs`; every other request goes to the real backend.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use videorc_app_core::StudioBackend;
use videorc_app_core::client::RpcError;
use videorc_app_core::client::methods::RemoteIntentAckParams;
use videorc_app_core::client::{BackendClient, ClientConfig, EventFilter};
use videorc_app_core::scenes::v2::SceneShows;
use videorc_app_core::studio::scene_switch::ApplyOptions;
use videorc_app_core::studio::{STUDIO_EVENTS, SessionPhase, Studio, StudioConfig, keys};
use videorc_app_core::supervisor::STOP_GRACE;
use videorc_app_core::{AppPaths, BackendLaunch, Logger, Supervisor, SupervisorConfig};
use videorc_protocol::ui_settings::{
    UiSettingsChange, UiSettingsGetParams, UiSettingsSetParams, UiSettingsSnapshot,
};
use videorc_protocol::{
    AudioProcessingUpdateParams, AudioProcessingUpdateResult, BackendHealth, DeviceList,
    PreviewScreenStartParams, PreviewScreenStatus, RecordingStatus, Scene, SessionDetailListParams,
    SessionHealthEventsPage, SessionListPage, SessionListParams, SessionLogsPage,
    SessionStopParams, StartSessionParams,
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
    /// The scene switch's requests (`scene.layout.apply_*`, `scene.get`,
    /// `compositor.status`, `diagnostics.stats`), to the real backend.
    async fn scene_request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        StudioBackend::scene_request(&*self.client, method, params).await
    }
}

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const SWITCH_TIMEOUT: Duration = Duration::from_secs(30);

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
            "no {what} within {timeout:?}; scenes: {:?}",
            studio.snapshot().scenes.on_stream_id
        )
    });
}

/// The library as stored (`videorc.scenes.v2`).
fn stored_library(backend: &StoreBackend) -> Value {
    let store = backend.store.lock().unwrap();
    let text = store
        .0
        .get(keys::SCENES)
        .and_then(Value::as_str)
        .expect("the library is stored")
        .to_string();
    serde_json::from_str(&text).expect("the stored library parses")
}

/// The layout the backend's compositor draws now.
async fn backend_preset(backend: &StoreBackend) -> Value {
    let status = backend
        .scene_request("compositor.status", Value::Null)
        .await
        .expect("compositor.status");
    status["sceneLayout"]["layoutPreset"].clone()
}

/// A switch, its proof and the Studio's state settled.
async fn switch_to(studio: &Arc<Studio<StoreBackend>>, id: &str) {
    let result = tokio::time::timeout(
        SWITCH_TIMEOUT,
        studio.apply_saved_scene(id, None, ApplyOptions::default()),
    )
    .await
    .unwrap_or_else(|_| panic!("the switch to {id} never answered"));
    assert!(result.ok, "the switch to {id} failed: {result:?}");
    wait_until(studio, "the switch settled", SWITCH_TIMEOUT, |snapshot| {
        !snapshot.scenes.transaction_pending
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the debug backend: cargo build -p videorc-backend, then cargo test -p videorc-app-core --test studio_scenes_smoke -- --ignored"]
async fn the_studio_switches_scenes_on_the_real_backend() {
    let profile = tempfile::Builder::new()
        .prefix("videorc-studio-scenes-")
        .tempdir()
        .unwrap();
    let supervisor = Supervisor::start(supervisor_config(profile.path()));
    supervisor
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
    let mut notices = studio.notices();
    let driver = tokio::spawn(studio.clone().drive(events));

    // Bootstrapped, and a new profile's scenes migrated and stored once.
    wait_until(&studio, "the scenes", READY_TIMEOUT, |snapshot| {
        snapshot.bootstrapped && snapshot.scenes.loaded
    })
    .await;
    let snapshot = studio.snapshot();
    assert_eq!(snapshot.session.phase, SessionPhase::Idle);
    let ids: Vec<String> = snapshot
        .scenes
        .scenes
        .iter()
        .map(|scene| scene.id.clone())
        .collect();
    eprintln!(
        "[scenes-smoke] bootstrapped: scenes {ids:?}, on stream {:?}, backend draws {}",
        snapshot.scenes.on_stream_id,
        backend_preset(&backend).await
    );
    for id in ["default-camera-only", "default-screen-only"] {
        assert!(ids.iter().any(|scene| scene == id), "{id} is in {ids:?}");
    }
    assert!(
        snapshot.settings.capture.sources.camera_id.is_none(),
        "a new profile chooses no camera"
    );
    // The synthetic test pattern is this run's capture (never stored).
    studio
        .set_test_pattern(true)
        .await
        .expect("the test pattern switch");

    // 1. Idle, Camera only goes on stream: it shows no screen, so it keeps
    // the (test pattern) capture and opens no device.
    switch_to(&studio, "default-camera-only").await;
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot.scenes.on_stream_id.as_deref(),
        Some("default-camera-only")
    );
    assert_eq!(
        snapshot.settings.capture_doc["layout"]["layoutPreset"],
        "camera-only"
    );
    assert_eq!(backend_preset(&backend).await, "camera-only");
    assert_eq!(
        stored_library(&backend)["onStreamId"],
        "default-camera-only"
    );
    eprintln!("[scenes-smoke] Camera only is on stream; the backend draws camera-only");

    // 2. Screen only, changed to show the test pattern first (its Screen
    // pick, D2), goes on the same way.
    assert!(
        studio
            .set_scene_shows("default-screen-only", SceneShows::TestPattern)
            .await,
        "the Screen pick is written"
    );
    switch_to(&studio, "default-screen-only").await;
    let snapshot = studio.snapshot();
    assert_eq!(
        snapshot.scenes.on_stream_id.as_deref(),
        Some("default-screen-only")
    );
    assert_eq!(backend_preset(&backend).await, "screen-only");
    assert_eq!(
        stored_library(&backend)["onStreamId"],
        "default-screen-only"
    );
    let scene = client
        .scene_request("scene.get", Value::Null)
        .await
        .expect("scene.get");
    eprintln!(
        "[scenes-smoke] Screen only is on stream; the backend draws screen-only with sources {}",
        scene["sources"]
    );
    assert!(
        scene["sources"]
            .as_array()
            .is_some_and(
                |sources| sources.iter().all(|source| source["kind"] != "screen"
                    && source["kind"] != "window"
                    && source["kind"] != "camera")
            ),
        "no screen, window or camera was asked for: {}",
        scene["sources"]
    );

    // 3. A scene that is not on stream is deleted, with no switch.
    let deleted = ids
        .iter()
        .find(|id| *id != "default-screen-only" && *id != "default-camera-only")
        .expect("a third scene")
        .clone();
    assert!(studio.delete_scene(&deleted).await, "{deleted} is deleted");
    let library = stored_library(&backend);
    assert!(
        library["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|scene| scene["id"] != deleted.as_str()),
        "{deleted} is gone from the stored library"
    );
    assert_eq!(library["onStreamId"], "default-screen-only");
    assert_eq!(
        studio.snapshot().scenes.on_stream_id.as_deref(),
        Some("default-screen-only")
    );
    assert_eq!(backend_preset(&backend).await, "screen-only");
    eprintln!("[scenes-smoke] {deleted} deleted; Screen only stays on stream");

    // Nothing the switches said was an error.
    let said: Vec<String> = std::iter::from_fn(|| notices.try_recv().ok())
        .filter_map(|command| command.notice().map(|notice| notice.title.clone()))
        .collect();
    eprintln!("[scenes-smoke] notices: {said:?}");
    assert!(said.is_empty(), "the switches said {said:?}");

    driver.abort();
    let _ = driver.await;
    drop(studio);
    drop(backend);
    let client = Arc::try_unwrap(client)
        .ok()
        .expect("the studio released the client");
    client.close().await;
    let outcome = supervisor.stop().await;
    assert!(
        outcome.stray_pids.is_empty(),
        "stray pids after stop: {:?}",
        outcome.stray_pids
    );
    let _ = std::fs::remove_dir_all(profile.path());
}
