//! Plan 260 S1.6c (from plan 220 S2.1b): the typed client against today's
//! debug backend, in an
//! isolated temp profile, with the synthetic test pattern only (no camera,
//! screen or microphone is opened, and nothing records or streams).
//!
//! Needs `cargo build -p videorc-backend` first (or `VIDEORC_BACKEND_BINARY`),
//! so it is `#[ignore]`d in the workspace run; run it with `--ignored`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::sync::broadcast;
use videorc_app_core::client::methods::{
    CompositorStatusGet, HealthPing, PreviewSurfaceCreate, PreviewSurfaceDestroy,
    PreviewSurfaceStatusGet, RecordingStatusGet, SceneLoadFromCaptureConfig,
};
use videorc_app_core::client::{
    BackendClient, BackendEvent, ClientConfig, ConnectionState, EventFilter, names,
};
use videorc_app_core::supervisor::STOP_GRACE;
use videorc_app_core::{AppPaths, BackendLaunch, Logger, Supervisor, SupervisorConfig};
use videorc_protocol::{
    PreviewSurfaceBounds, PreviewSurfaceCreateParams, PreviewSurfaceSource, PreviewSurfaceState,
    RecordingState, SceneConfigParams, SourceSelection, VideoPreset, VideoSettings,
    default_layout_settings,
};

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const EVENT_TIMEOUT: Duration = Duration::from_secs(30);

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

/// The next event `pick` accepts; fails on a frame-ready event (the filter
/// keeps that lane out) or after the timeout.
async fn wait_for<T>(
    events: &mut broadcast::Receiver<BackendEvent>,
    what: &str,
    mut pick: impl FnMut(BackendEvent) -> Option<T>,
) -> T {
    tokio::time::timeout(EVENT_TIMEOUT, async {
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => panic!("the client ended"),
            };
            assert!(
                !matches!(event, BackendEvent::PreviewFrameReady(_)),
                "preview.frameReady is outside the include list"
            );
            if let BackendEvent::Unreadable { event, error, .. } = &event {
                panic!("{event} did not match its type: {error}");
            }
            if let Some(found) = pick(event) {
                return found;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {what} within {EVENT_TIMEOUT:?}"))
}

fn test_pattern_scene() -> SceneConfigParams {
    SceneConfigParams {
        sources: SourceSelection {
            screen_id: None,
            window_id: None,
            camera_id: None,
            microphone_id: None,
            test_pattern: true,
        },
        layout: default_layout_settings(),
        video: Some(VideoSettings {
            preset: VideoPreset::Custom,
            width: 640,
            height: 360,
            fps: 30,
            bitrate_kbps: 2_000,
        }),
        background: None,
        protected_overlay_window_ids: Vec::new(),
        transition_ms: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the debug backend: cargo build -p videorc-backend, then cargo test -p videorc-app-core --test typed_client -- --ignored"]
async fn the_typed_client_round_trips_ready_health_and_status_events() {
    let profile = tempfile::Builder::new()
        .prefix("videorc-typed-client-")
        .tempdir()
        .unwrap();
    let supervisor = Supervisor::start(supervisor_config(profile.path()));
    let bootstrap = supervisor
        .wait_ready(READY_TIMEOUT)
        .await
        .expect("the backend becomes ready");

    let logger = Logger::silent();
    let (client, mut events) = BackendClient::start(
        supervisor.state(),
        ClientConfig {
            filter: EventFilter::include([
                names::SCENE_CHANGED,
                names::COMPOSITOR_STATUS,
                names::PREVIEW_SURFACE_STATUS,
                names::RECORDING_STATUS,
            ]),
            logger: logger.clone(),
            ..ClientConfig::default()
        },
    );

    // backend.ready: the renderer credential, typed.
    let ready = wait_for(&mut events, "backend.ready", |event| match event {
        BackendEvent::Ready(ready) => Some(ready),
        _ => None,
    })
    .await;
    assert_eq!(ready.host, "127.0.0.1");
    assert_eq!(ready.port, bootstrap.port);
    assert_eq!(ready.pid, bootstrap.pid);
    assert_eq!(ready.token, bootstrap.token, "the renderer credential");
    assert_ne!(ready.token, bootstrap.admin_token);
    assert!(matches!(
        client.current_state(),
        ConnectionState::Connected { generation: 1, .. }
    ));

    // health.ping, typed: today's backend answers in the protocol's shape.
    let health = client.call::<HealthPing>(&()).await.expect("health.ping");
    assert_eq!(health.status, "ok");
    assert!(!health.version.is_empty());

    // The session status, typed: idle, and nothing starts here.
    let status = client.call::<RecordingStatusGet>(&()).await.unwrap();
    assert!(matches!(status.state, RecordingState::Idle), "{status:?}");
    // Typed, whatever state the idle compositor is in.
    client
        .call::<CompositorStatusGet>(&())
        .await
        .expect("compositor.status");

    // The test-pattern scene: the typed commit and `scene.changed`.
    let commit = client
        .call::<SceneLoadFromCaptureConfig>(&test_pattern_scene())
        .await
        .expect("scene.load_from_capture_config");
    assert!(commit.applied, "{commit:?}");
    let scene = wait_for(&mut events, "scene.changed", |event| match event {
        BackendEvent::SceneChanged(scene) => Some(scene),
        _ => None,
    })
    .await;
    assert!(
        scene
            .outputs
            .iter()
            .any(|output| output.width == 640 && output.height == 360),
        "{scene:?}"
    );

    // The synthetic preview surface: typed answers and the status event.
    let created = client
        .call::<PreviewSurfaceCreate>(&PreviewSurfaceCreateParams {
            bounds: PreviewSurfaceBounds {
                width: 640.0,
                height: 360.0,
                scale_factor: 1.0,
                visible: Some(true),
                ..PreviewSurfaceBounds::default()
            },
            target_fps: 30,
            source: PreviewSurfaceSource::Synthetic,
        })
        .await
        .expect("preview.surface.create");
    assert_eq!(created.source, PreviewSurfaceSource::Synthetic);
    assert!(
        matches!(
            created.state,
            PreviewSurfaceState::Live | PreviewSurfaceState::Starting
        ),
        "{created:?}"
    );
    eprintln!(
        "[typed-client] preview.surface.create: {:?} {}x{} at {} fps",
        created.state, created.width, created.height, created.target_fps
    );
    let surface = wait_for(&mut events, "preview.surface.status", |event| match event {
        BackendEvent::PreviewSurfaceStatus(status) => Some(status),
        _ => None,
    })
    .await;
    assert_eq!(surface.target_fps, 30);
    let polled = client.call::<PreviewSurfaceStatusGet>(&()).await.unwrap();
    assert_eq!(polled.source, PreviewSurfaceSource::Synthetic);
    let destroyed = client.call::<PreviewSurfaceDestroy>(&()).await.unwrap();
    assert!(
        matches!(
            destroyed.state,
            PreviewSurfaceState::Stopped | PreviewSurfaceState::Unavailable
        ),
        "{destroyed:?}"
    );

    // An untyped request still works.
    let health = client
        .request("health.ping", serde_json::Value::Null)
        .await
        .unwrap();
    assert_eq!(health["status"], "ok");

    #[cfg(unix)]
    {
        // The backend dies (our recorded PID only); the supervisor brings up
        // generation 2 and the client follows it on its own.
        // SAFETY: an exact PID this test's supervisor spawned and reported.
        unsafe {
            libc::kill(bootstrap.pid as libc::pid_t, libc::SIGKILL);
        }
        let closed = wait_for(&mut events, "connection.closed", |event| match event {
            BackendEvent::ConnectionClosed { reason } => Some(reason),
            _ => None,
        })
        .await;
        assert!(!closed.is_empty());
        let second = tokio::time::timeout(READY_TIMEOUT, async {
            loop {
                match events.recv().await {
                    Ok(BackendEvent::Ready(ready)) => break ready,
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => panic!("the client ended"),
                }
            }
        })
        .await
        .expect("the client reconnects to the next generation");
        assert_ne!(second.pid, bootstrap.pid);
        assert!(matches!(
            client.current_state(),
            ConnectionState::Connected { generation: 2, .. }
        ));
        // A typed call on the new connection.
        let again = client.call::<HealthPing>(&()).await.unwrap();
        assert_eq!(again.status, "ok");
    }

    client.close().await;
    let outcome = supervisor.stop().await;
    assert!(
        outcome.stray_pids.is_empty(),
        "stray pids after stop: {:?}",
        outcome.stray_pids
    );
    let unreadable: Vec<_> = logger
        .recent()
        .into_iter()
        .filter(|line| {
            line.message.contains("did not match") || line.message.contains("unreadable")
        })
        .collect();
    assert!(unreadable.is_empty(), "{unreadable:?}");
    let _ = std::fs::remove_dir_all(profile.path());
}
