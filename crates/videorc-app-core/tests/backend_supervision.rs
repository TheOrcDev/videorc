//! Plan 220 S2.1a: the core alone, no window, against the real debug backend
//! in an isolated temp profile.
//!
//! Needs `cargo build -p videorc-backend` first (or `VIDEORC_BACKEND_BINARY`),
//! so both tests are `#[ignore]`d in the workspace run (CI tests the plan 260
//! crates before it builds the backend). Run them with `--ignored`.
//! The two tests share one lock so only one backend runs at a time.

use std::path::{Path, PathBuf};
use std::time::Duration;

use videorc_app_core::crash_log::read_crash_log;
use videorc_app_core::ledger::OwnedProcessLedger;
use videorc_app_core::supervisor::STOP_GRACE;
use videorc_app_core::{
    AppPaths, BackendLaunch, BackendState, Logger, Supervisor, SupervisorConfig, process_is_alive,
};

static ONE_BACKEND_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const READY_TIMEOUT: Duration = Duration::from_secs(120);

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("the workspace root exists")
}

fn backend_binary(root: &Path) -> PathBuf {
    if let Some(explicit) = std::env::var_os("VIDEORC_BACKEND_BINARY") {
        return PathBuf::from(explicit);
    }
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target"))
        .join("debug")
        .join(videorc_app_core::process::backend_binary_name())
}

fn config(profile: &Path) -> SupervisorConfig {
    let root = workspace_root();
    let binary = backend_binary(&root);
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
        // Echoed to stderr so a failing run shows the supervisor's lines.
        logger: Logger::new(None, true),
        stop_grace: STOP_GRACE,
    }
}

fn pids_gone(pids: &[u32]) -> bool {
    pids.iter().all(|pid| !process_is_alive(*pid))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the debug backend: cargo build -p videorc-backend, then cargo test -p videorc-app-core --test backend_supervision -- --ignored"]
async fn the_core_starts_sees_ready_stops_and_leaves_no_stray() {
    let _serial = ONE_BACKEND_AT_A_TIME.lock().await;
    let profile = tempfile::Builder::new()
        .prefix("videorc-app-core-")
        .tempdir()
        .unwrap();
    let config = config(profile.path());
    let paths = config.paths.clone();
    let root = config.workspace_root.clone();

    let supervisor = Supervisor::start(config);
    let bootstrap = supervisor
        .wait_ready(READY_TIMEOUT)
        .await
        .expect("the backend becomes ready");
    assert_eq!(bootstrap.host, "127.0.0.1");
    assert!(
        process_is_alive(bootstrap.pid),
        "the ready backend is alive"
    );
    assert!(supervisor.current().is_ready());
    assert!(
        supervisor
            .current()
            .status_text()
            .starts_with("Backend ready"),
        "status text: {}",
        supervisor.current().status_text()
    );

    // The ledger holds exactly the PIDs this generation owns, with identity.
    let ledger = OwnedProcessLedger::new(paths.owned_process_ledger(&root));
    let records = ledger.records().unwrap();
    assert!(
        records.iter().any(|record| record.pid == bootstrap.pid),
        "ledger {records:?} lacks the backend pid {}",
        bootstrap.pid
    );
    assert!(records.iter().all(|record| record.identity.is_some()));

    // Everything the backend wrote stayed inside the profile.
    assert!(paths.user_data_dir.join("videorc.sqlite3").exists());

    let outcome = supervisor.stop().await;
    let report = outcome
        .report
        .expect("a backend was running when we stopped");
    assert!(
        outcome.stray_pids.is_empty(),
        "stray pids after stop: {:?}",
        outcome.stray_pids
    );
    assert!(
        report.reaped_pids.contains(&bootstrap.pid),
        "reaped {:?} lacks {}",
        report.reaped_pids,
        bootstrap.pid
    );
    assert!(
        pids_gone(&report.reaped_pids),
        "a reaped pid is still alive"
    );
    assert!(
        report.preparation.is_some(),
        "the shutdown handshake was answered: {:?}",
        report.preparation_error
    );
    assert!(
        ledger.records().unwrap().is_empty(),
        "the ledger is empty after a clean stop"
    );
    assert!(
        read_crash_log(&paths.backend_crash_log_file()).is_empty(),
        "a clean stop records no crash"
    );
    let _ = std::fs::remove_dir_all(profile.path());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the debug backend: cargo build -p videorc-backend, then cargo test -p videorc-app-core --test backend_supervision -- --ignored"]
async fn a_killed_backend_is_restarted_and_the_crash_recorded() {
    let _serial = ONE_BACKEND_AT_A_TIME.lock().await;
    let profile = tempfile::Builder::new()
        .prefix("videorc-app-core-")
        .tempdir()
        .unwrap();
    let config = config(profile.path());
    let paths = config.paths.clone();

    let supervisor = Supervisor::start(config);
    let first = supervisor.wait_ready(READY_TIMEOUT).await.unwrap();
    let mut state = supervisor.state();
    state.mark_unchanged();

    // Kill OUR backend's recorded PID, nothing else.
    // SAFETY: an exact PID this test's supervisor spawned and reported.
    unsafe {
        libc::kill(first.pid as libc::pid_t, libc::SIGKILL);
    }

    // The supervisor notices, schedules attempt 1 (500 ms) and comes back.
    let mut saw_restarting = false;
    let second = tokio::time::timeout(READY_TIMEOUT, async {
        loop {
            state.changed().await.expect("the supervisor is alive");
            let current = state.borrow_and_update().clone();
            match current {
                BackendState::Restarting { attempt, exit, .. } => {
                    assert_eq!(attempt, 1);
                    assert_eq!(exit.signal.as_deref(), Some("SIGKILL"));
                    saw_restarting = true;
                }
                BackendState::Ready { bootstrap, .. } if bootstrap.pid != first.pid => {
                    break bootstrap;
                }
                BackendState::Failed { reason, .. } => panic!("supervisor failed: {reason}"),
                _ => {}
            }
        }
    })
    .await
    .expect("a new generation becomes ready");
    assert!(saw_restarting, "the Restarting state was published");
    assert!(!process_is_alive(first.pid), "the killed backend is gone");
    assert!(process_is_alive(second.pid), "the replacement is alive");

    let crashes = read_crash_log(&paths.backend_crash_log_file());
    assert_eq!(crashes.len(), 1, "one crash record: {crashes:?}");
    assert_eq!(crashes[0].generation, 1);
    assert_eq!(crashes[0].signal.as_deref(), Some("SIGKILL"));
    assert_eq!(crashes[0].attempt, Some(1));
    assert!(!crashes[0].intentional);

    let outcome = supervisor.stop().await;
    assert!(
        outcome.stray_pids.is_empty(),
        "strays: {:?}",
        outcome.stray_pids
    );
    assert!(!process_is_alive(second.pid));
    let _ = std::fs::remove_dir_all(profile.path());
}

/// S2.6b: a permission grant's restart, under the backend's own
/// interruption lease (the real `/interruption/lease` routes), replaces the
/// generation without counting a crash, and a recording would refuse it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the debug backend: cargo build -p videorc-backend, then cargo test -p videorc-app-core --test backend_supervision -- --ignored"]
async fn a_permission_restart_takes_the_lease_and_replaces_the_backend() {
    use std::sync::Arc;
    use videorc_app_core::desktop::capture_state::MainCaptureState;
    use videorc_app_core::desktop::permission_restart::{PermissionRestarts, SupervisorRestarter};
    use videorc_app_core::interruption::LoopbackHttp;

    let _serial = ONE_BACKEND_AT_A_TIME.lock().await;
    let profile = tempfile::Builder::new()
        .prefix("videorc-app-core-")
        .tempdir()
        .unwrap();
    let config = config(profile.path());
    let paths = config.paths.clone();

    let supervisor = Supervisor::start(config);
    let first = supervisor.wait_ready(READY_TIMEOUT).await.unwrap();
    let logs = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let logged = logs.clone();
    let restarts = PermissionRestarts::new(
        Arc::new(SupervisorRestarter {
            restart: supervisor.restarter(),
            transport: Arc::new(LoopbackHttp),
        }),
        Arc::new(move |_, message| logged.lock().unwrap().push(message)),
    );

    // While capture is busy the restart waits.
    restarts.capture_changed(MainCaptureState::Recording);
    let deferred = restarts
        .request("Restarting capture backend after camera permission became available.".into())
        .await
        .unwrap();
    assert!(!deferred.restarted);
    assert_eq!(
        deferred.stale_backend.as_ref().unwrap().pid,
        Some(first.pid)
    );
    assert!(process_is_alive(first.pid));

    // Idle: the waiting restart runs once, under the lease.
    let reason = restarts
        .capture_changed(MainCaptureState::Idle)
        .expect("the deferred restart flushes at idle");
    let mut state = supervisor.state();
    let done = restarts.run(reason).await.expect("the restart ran");
    assert!(done.restarted, "logs: {:?}", logs.lock().unwrap());
    assert_eq!(done.stale_backend.unwrap().pid, Some(first.pid));
    let second = tokio::time::timeout(READY_TIMEOUT, async {
        loop {
            if let BackendState::Ready { bootstrap, .. } = &*state.borrow_and_update()
                && bootstrap.pid != first.pid
            {
                break bootstrap.clone();
            }
            state.changed().await.expect("the supervisor is alive");
        }
    })
    .await
    .expect("a new generation becomes ready");
    assert!(!process_is_alive(first.pid), "the old backend is gone");
    assert!(process_is_alive(second.pid));
    assert_eq!(restarts.capture_changed(MainCaptureState::Idle), None);
    assert!(
        read_crash_log(&paths.backend_crash_log_file()).is_empty(),
        "a permission restart is not a crash"
    );

    let outcome = supervisor.stop().await;
    assert!(
        outcome.stray_pids.is_empty(),
        "strays: {:?}",
        outcome.stray_pids
    );
    let _ = std::fs::remove_dir_all(profile.path());
}
