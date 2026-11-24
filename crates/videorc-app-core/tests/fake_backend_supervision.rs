//! Plan 260 S1.6s: supervision against fake backends (shell scripts), so the
//! handshake, a quit during startup, restarts and stragglers run in the
//! normal `cargo test` with no backend binary.
//!
//! `backend.sh` speaks the backend's two stdout lines (`OWNERSHIP` with this
//! generation's token, then `READY`); `wrapper.sh` runs it as a child the way
//! `cargo run` does (it forwards no signal, so the real backend outlives a
//! killed wrapper). The shutdown handshake is answered by a listener in the
//! test. Unix only: the scripts need `/bin/sh`.

#![cfg(unix)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use videorc_app_core::crash_log::read_crash_log;
use videorc_app_core::ledger::OwnedProcessLedger;
use videorc_app_core::process::BackendProcess;
use videorc_app_core::{
    AppPaths, BackendLaunch, BackendState, Logger, Supervisor, SupervisorConfig, process_is_alive,
};

const BACKEND: &str = r#"#!/bin/sh
# A fake videorc-backend. $1 picks the behaviour.
printf 'OWNERSHIP {"token":"%s","pid":%s,"parentPid":%s}\n' "$VIDEORC_BACKEND_OWNERSHIP_TOKEN" "$$" "$PPID"
case "$1" in
  hang) while :; do sleep 0.1; done ;;
  malformed) printf 'READY {not json}\n'; while :; do sleep 0.1; done ;;
esac
printf 'READY {"host":"127.0.0.1","port":%s,"token":"11111111-2222-3333-4444-555555555555","adminToken":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","pid":%s,"parentPid":%s}\n' "$FAKE_PORT" "$$" "$PPID"
case "$1" in
  crash-once)
    if [ ! -e "$FAKE_STATE/crashed" ]; then
      : > "$FAKE_STATE/crashed"
      sleep 0.3
      exit 3
    fi
    ;;
esac
while :; do sleep 0.1; done
"#;

/// `cargo run`: the backend is its child; nothing is forwarded.
const WRAPPER: &str = r#"#!/bin/sh
/bin/sh "$FAKE_DIR/backend.sh" "$@"
exit $?
"#;

/// A wrapper that dies on its own while its backend keeps running.
const WRAPPER_DIES: &str = r#"#!/bin/sh
/bin/sh "$FAKE_DIR/backend.sh" "$@" &
sleep 1
exit 4
"#;

struct Fake {
    dir: tempfile::TempDir,
    profile: tempfile::TempDir,
    port: u16,
    prepares: Arc<AtomicUsize>,
}

impl Fake {
    async fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("videorc-fake-backend-")
            .tempdir()
            .unwrap();
        for (name, text) in [
            ("backend.sh", BACKEND),
            ("wrapper.sh", WRAPPER),
            ("wrapper-dies.sh", WRAPPER_DIES),
        ] {
            std::fs::write(dir.path().join(name), text).unwrap();
        }
        let profile = tempfile::Builder::new()
            .prefix("videorc-fake-profile-")
            .tempdir()
            .unwrap();
        // Answers `POST /process/shutdown/prepare` as the backend does.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let prepares = Arc::new(AtomicUsize::new(0));
        let counted = prepares.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let counted = counted.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0_u8; 1024];
                    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                        match stream.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => request.extend_from_slice(&buffer[..read]),
                        }
                    }
                    if String::from_utf8_lossy(&request)
                        .starts_with("POST /process/shutdown/prepare?")
                    {
                        counted.fetch_add(1, Ordering::SeqCst);
                    }
                    let body = r#"{"prepared":true}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Self {
            dir,
            profile,
            port,
            prepares,
        }
    }

    fn paths(&self) -> AppPaths {
        AppPaths::profile(self.profile.path())
    }

    /// `script` is `backend.sh` (a direct binary: the spawned child is the
    /// backend) or one of the wrappers.
    fn launch(&self, script: &str, mode: &str, ready_timeout: Duration) -> BackendLaunch {
        let mut launch = BackendLaunch::binary(
            PathBuf::from("/bin/sh"),
            self.dir.path(),
            self.paths().user_data_dir.clone(),
        );
        launch.args = vec![
            self.dir.path().join(script).display().to_string(),
            mode.to_string(),
        ];
        launch.ready_timeout = ready_timeout;
        launch.extra_env = vec![
            (
                "FAKE_DIR".to_string(),
                self.dir.path().display().to_string(),
            ),
            ("FAKE_PORT".to_string(), self.port.to_string()),
            (
                "FAKE_STATE".to_string(),
                self.dir.path().display().to_string(),
            ),
        ];
        launch
    }

    fn config(&self, launch: BackendLaunch) -> SupervisorConfig {
        SupervisorConfig {
            launch,
            paths: self.paths(),
            workspace_root: self.dir.path().to_path_buf(),
            logger: Logger::new(None, true),
            stop_grace: Duration::from_secs(5),
        }
    }

    fn ledger(&self) -> OwnedProcessLedger {
        OwnedProcessLedger::new(self.paths().owned_process_ledger(self.dir.path()))
    }

    fn ledger_pids(&self) -> Vec<u32> {
        self.ledger()
            .records()
            .unwrap_or_default()
            .iter()
            .map(|record| record.pid)
            .collect()
    }
}

fn all_gone(pids: &[u32]) -> bool {
    pids.iter().all(|pid| !process_is_alive(*pid))
}

/// Waits until `check` holds, or fails the test after `timeout`.
async fn eventually(timeout: Duration, what: &str, mut check: impl FnMut() -> bool) {
    let until = Instant::now() + timeout;
    while !check() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_for_state(
    supervisor: &Supervisor,
    timeout: Duration,
    what: &str,
    matches: impl Fn(&BackendState) -> bool,
) -> BackendState {
    let mut state = supervisor.state();
    let until = tokio::time::Instant::now() + timeout;
    loop {
        {
            let current = state.borrow_and_update();
            if matches(&current) {
                return current.clone();
            }
        }
        match tokio::time::timeout_at(until, state.changed()).await {
            Ok(Ok(())) => {}
            _ => panic!(
                "timed out waiting for {what}; now {:?}",
                supervisor.current()
            ),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_handshake_behind_a_wrapper_then_stop_leaves_nothing_running() {
    let fake = Fake::new().await;
    let supervisor = Supervisor::start(fake.config(fake.launch(
        "wrapper.sh",
        "normal",
        Duration::from_secs(20),
    )));
    let bootstrap = supervisor
        .wait_ready(Duration::from_secs(20))
        .await
        .unwrap();
    assert_eq!(bootstrap.port, fake.port);
    let owned = fake.ledger_pids();
    assert_eq!(owned.len(), 2, "the wrapper and the backend: {owned:?}");
    assert!(owned.contains(&bootstrap.pid));
    assert!(
        fake.ledger()
            .records()
            .unwrap()
            .iter()
            .all(|record| record.identity.is_some())
    );

    let outcome = supervisor.stop().await;
    assert!(outcome.stray_pids.is_empty(), "{outcome:?}");
    let report = outcome.report.expect("a backend was running");
    assert_eq!(fake.prepares.load(Ordering::SeqCst), 1);
    assert!(report.preparation.is_some(), "{report:?}");
    assert!(all_gone(&owned), "owned {owned:?} must all be gone");
    assert!(fake.ledger_pids().is_empty(), "the ledger is cleared");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quitting_during_startup_stops_at_once_and_the_pids_were_recorded_before_ready() {
    let fake = Fake::new().await;
    // A backend that prints OWNERSHIP and then hangs, with a long timeout.
    let supervisor =
        Supervisor::start(fake.config(fake.launch("wrapper.sh", "hang", Duration::from_secs(90))));
    // Both PIDs are in the ledger while the backend is still starting: the
    // wrapper at spawn, the backend on OWNERSHIP.
    eventually(Duration::from_secs(10), "two ledger records", || {
        fake.ledger_pids().len() == 2
    })
    .await;
    assert!(
        matches!(supervisor.current(), BackendState::Starting { .. }),
        "{:?}",
        supervisor.current()
    );
    let owned = fake.ledger_pids();
    assert!(owned.iter().all(|pid| process_is_alive(*pid)));

    let started = Instant::now();
    let outcome = supervisor.stop().await;
    let took = started.elapsed();
    assert!(
        took < Duration::from_secs(8),
        "a quit during startup took {took:?}"
    );
    assert!(outcome.stray_pids.is_empty(), "{outcome:?}");
    assert!(all_gone(&owned), "owned {owned:?} must all be gone");
    assert!(fake.ledger_pids().is_empty(), "the ledger is cleared");
    assert_eq!(
        fake.prepares.load(Ordering::SeqCst),
        0,
        "no READY, no handshake"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_malformed_ready_behind_a_wrapper_kills_the_real_backend_too() {
    let fake = Fake::new().await;
    let launch = fake.launch("wrapper.sh", "malformed", Duration::from_secs(20));
    let Err(error) = BackendProcess::spawn(launch).await else {
        panic!("a malformed READY must fail the startup");
    };
    assert!(
        error.to_string().contains("READY line is not JSON"),
        "{error}"
    );
    assert!(!error.cancelled);
    assert_eq!(
        error.reaped_pids.len(),
        2,
        "the wrapper and the backend behind it: {error:?}"
    );
    assert!(error.stray_pids.is_empty(), "{error:?}");
    assert!(all_gone(&error.reaped_pids));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_restarts_and_clears_the_dead_generation_from_the_ledger() {
    let fake = Fake::new().await;
    let supervisor = Supervisor::start(fake.config(fake.launch(
        "wrapper.sh",
        "crash-once",
        Duration::from_secs(20),
    )));
    let first = supervisor
        .wait_ready(Duration::from_secs(20))
        .await
        .unwrap();
    let first_pids = fake.ledger_pids();
    let restarting = wait_for_state(&supervisor, Duration::from_secs(10), "the restart", |s| {
        matches!(s, BackendState::Restarting { .. })
    })
    .await;
    let BackendState::Restarting { attempt, exit, .. } = restarting else {
        unreachable!()
    };
    assert_eq!(attempt, 1);
    assert_eq!(exit.code, Some(3));
    let second = wait_for_state(&supervisor, Duration::from_secs(20), "generation 2", |s| {
        matches!(s, BackendState::Ready { generation: 2, .. })
    })
    .await;
    let second = second.bootstrap().unwrap().clone();
    assert_ne!(second.pid, first.pid);
    assert!(all_gone(&first_pids));
    let now = fake.ledger_pids();
    assert!(
        first_pids.iter().all(|pid| !now.contains(pid)),
        "generation 1's pids {first_pids:?} are cleared, ledger now {now:?}"
    );
    assert!(now.contains(&second.pid));
    let crashes = read_crash_log(&fake.paths().backend_crash_log_file());
    assert_eq!(crashes.len(), 1, "{crashes:?}");
    assert_eq!(crashes[0].code, Some(3));

    let outcome = supervisor.stop().await;
    assert!(outcome.stray_pids.is_empty(), "{outcome:?}");
    assert!(all_gone(&now));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backend_that_outlives_its_wrapper_is_killed_exactly() {
    let fake = Fake::new().await;
    let supervisor = Supervisor::start(fake.config(fake.launch(
        "wrapper-dies.sh",
        "normal",
        Duration::from_secs(20),
    )));
    let bootstrap = supervisor
        .wait_ready(Duration::from_secs(20))
        .await
        .unwrap();
    let owned = fake.ledger_pids();
    assert_eq!(owned.len(), 2, "{owned:?}");
    // The wrapper exits with 4; the backend behind it is still running until
    // the supervisor kills it by its recorded identity.
    let restarting = wait_for_state(&supervisor, Duration::from_secs(10), "the restart", |s| {
        matches!(s, BackendState::Restarting { .. })
    })
    .await;
    let BackendState::Restarting { exit, .. } = restarting else {
        unreachable!()
    };
    assert_eq!(exit.code, Some(4));
    assert!(
        !process_is_alive(bootstrap.pid),
        "the straggler {} is killed before the restart",
        bootstrap.pid
    );
    let now = fake.ledger_pids();
    assert!(owned.iter().all(|pid| !now.contains(pid)), "{now:?}");

    let outcome = supervisor.stop().await;
    assert!(outcome.stray_pids.is_empty(), "{outcome:?}");
    let left = fake.ledger_pids();
    assert!(all_gone(&left), "{left:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_permission_restart_never_reads_as_stopped() {
    let fake = Fake::new().await;
    let supervisor = Supervisor::start(fake.config(fake.launch(
        "backend.sh",
        "normal",
        Duration::from_secs(20),
    )));
    let first = supervisor
        .wait_ready(Duration::from_secs(20))
        .await
        .unwrap();
    // Every state the restart passes through.
    let mut states = supervisor.state();
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let record = seen.clone();
    let watcher = tokio::spawn(async move {
        while states.changed().await.is_ok() {
            let state = states.borrow_and_update().clone();
            let ready = state.is_ready();
            record.lock().unwrap().push(state);
            if ready {
                return;
            }
        }
    });
    let restarter = supervisor.restarter();
    let restart = tokio::spawn(async move { restarter.restart("camera granted").await });
    wait_for_state(&supervisor, Duration::from_secs(10), "Stopping", |s| {
        matches!(s, BackendState::Stopping { .. })
    })
    .await;
    // `wait_ready` asked mid-restart waits for the new generation.
    let second = supervisor
        .wait_ready(Duration::from_secs(20))
        .await
        .expect("wait_ready must not fail during a permission restart");
    assert_ne!(second.pid, first.pid);
    assert_eq!(restart.await.unwrap(), Ok(()));
    tokio::time::timeout(Duration::from_secs(5), watcher)
        .await
        .unwrap()
        .unwrap();
    let seen = seen.lock().unwrap().clone();
    assert!(
        !seen
            .iter()
            .any(|state| matches!(state, BackendState::Stopped { .. })),
        "{seen:?}"
    );
    assert!(!process_is_alive(first.pid));
    assert_eq!(fake.prepares.load(Ordering::SeqCst), 1);

    let outcome = supervisor.stop().await;
    assert!(outcome.stray_pids.is_empty(), "{outcome:?}");
    assert!(!process_is_alive(second.pid));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_corrupt_ledger_is_moved_aside_and_recording_works() {
    let fake = Fake::new().await;
    let ledger_path = fake.paths().owned_process_ledger(fake.dir.path());
    std::fs::create_dir_all(ledger_path.parent().unwrap()).unwrap();
    std::fs::write(&ledger_path, "[{\"pid\": 12, \"lab").unwrap();
    let supervisor = Supervisor::start(fake.config(fake.launch(
        "backend.sh",
        "normal",
        Duration::from_secs(20),
    )));
    let bootstrap = supervisor
        .wait_ready(Duration::from_secs(20))
        .await
        .unwrap();
    assert_eq!(fake.ledger_pids(), vec![bootstrap.pid]);
    let aside = std::fs::read_dir(ledger_path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"));
    assert!(aside, "the unreadable ledger is kept as evidence");

    let outcome = supervisor.stop().await;
    assert!(outcome.stray_pids.is_empty(), "{outcome:?}");
    assert!(fake.ledger_pids().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_spawn_the_ledger_cannot_record_ends_its_generation() {
    let fake = Fake::new().await;
    // A directory where the ledger file goes: every read and write fails.
    let ledger_path = fake.paths().owned_process_ledger(fake.dir.path());
    std::fs::create_dir_all(&ledger_path).unwrap();
    let supervisor = Supervisor::start(fake.config(fake.launch(
        "backend.sh",
        "normal",
        Duration::from_secs(20),
    )));
    wait_for_state(&supervisor, Duration::from_secs(10), "the restart", |s| {
        matches!(s, BackendState::Restarting { .. })
    })
    .await;
    let crashes = read_crash_log(&fake.paths().backend_crash_log_file());
    let tail = crashes
        .first()
        .map(|record| record.stderr_tail.join("\n"))
        .unwrap_or_default();
    let marker = "could not record the spawned backend process ";
    let pid: u32 = tail
        .split(marker)
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|digits| digits.parse().ok())
        .unwrap_or_else(|| panic!("the crash record names the unrecorded pid: {tail}"));
    assert!(
        !process_is_alive(pid),
        "an unrecorded backend {pid} must not keep running"
    );
    let outcome = supervisor.stop().await;
    assert!(outcome.stray_pids.is_empty(), "{outcome:?}");
}
