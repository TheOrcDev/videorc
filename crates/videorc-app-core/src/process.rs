//! Spawning, bootstrapping and stopping one backend process the way Electron
//! main does it (`apps/desktop/src/main/index.ts`, `backend-bootstrap.ts`).
//!
//! The backend prints two private lines on stdout before anything else:
//! `OWNERSHIP {token, pid, parentPid}` as soon as it starts (authenticated by
//! the token this process put in `VIDEORC_BACKEND_OWNERSHIP_TOKEN`; in a
//! `cargo run` chain the spawned child is only the wrapper, so this is the
//! only way to learn the real backend's PID before READY), then
//! `READY {host, port, token, adminToken, pid, ...}` once the listener is up.
//!
//! Stopping mirrors `stopBackend`: `POST /process/shutdown/prepare` with the
//! admin credential (the backend latches shutdown and finalizes any capture),
//! then SIGTERM, a bounded wait, SIGKILL, and an exact liveness check of
//! every owned PID. Nothing here scans the process table.
//!
//! Every owned PID is recorded the moment it is known (the spawned child
//! right after spawn, the real backend on `OWNERSHIP`), so a crash of this
//! app mid-startup leaves them for the next launch to reap. Only the spawned
//! child, while unreaped, is signalled directly; any other PID only after
//! its recorded identity is read again (`signalRecordedOwnership`), so a PID
//! the OS handed to an unrelated process is never signalled.
//!
//! Moved here from `videorc-dev-client` in plan 220 S2.1a; the supervisor
//! ([`crate::supervisor`]) drives one of these per backend generation.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::TcpStream;
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::ledger::{
    ProbeResult, ProcessIdentity, probe_process_retrying, recorded_is_alive, signal_recorded,
};

const OWNERSHIP_PREFIX: &str = "OWNERSHIP ";
const READY_PREFIX: &str = "READY ";
const OWNERSHIP_TOKEN_ENV: &str = "VIDEORC_BACKEND_OWNERSHIP_TOKEN";
/// Who hosts the talk show's room (the backend's `room_host::CLIENT_ROOM_ENV`).
pub const ROOM_HOST_ENV: &str = "VIDEORC_ROOM_HOST";
/// This app holds no room itself: the backend does.
pub const ROOM_HOST_BACKEND: &str = "backend";
const STDERR_TAIL_LINES: usize = 60;

/// Variables T3 Code and release tooling leak into every child; Electron main
/// strips the same set (`scripts/lib/smoke-env.mjs`, `release-authority-env.ts`).
const STRIPPED_ENV: &[&str] = &["ELECTRON_RUN_AS_NODE", "T3CODE_THREAD_ID"];
const STRIPPED_ENV_PREFIXES: &[&str] = &[
    "AZURE_",
    "APPLE_",
    "CSC_",
    "WIN_CSC_",
    "VIDEORC_DOWNLOAD_",
    "VIDEORC_RELEASE_UPLOAD_",
    "VIDEORC_WINDOWS_SIGNING_",
];

/// A line of the backend's stderr, as it arrived (trimmed, non-empty).
pub type StderrSink = Arc<dyn Fn(&str) + Send + Sync>;

/// One loopback credential: the renderer's or main's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    pub host: String,
    pub port: u16,
    pub token: String,
}

impl Credential {
    pub fn websocket_url(&self) -> String {
        // Tokens are UUIDs (validated below), so they need no escaping.
        format!("ws://{}:{}/ws?token={}", self.host, self.port, self.token)
    }
}

/// The `READY` line: both credentials and the backend's process identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendBootstrap {
    pub host: String,
    pub port: u16,
    /// Renderer-scoped credential.
    pub token: String,
    /// Main-process credential: frame leases and shutdown preparation need it.
    /// Never print it.
    pub admin_token: String,
    pub pid: u32,
    pub parent_pid: Option<u32>,
    /// S3.0i: the backend's Screens, Banners and Sounds folders, where the
    /// pictures and sounds it hands over by name live. Main-only, like the
    /// admin token: never in a log line or a marker.
    pub managed_asset_roots: Option<ManagedAssetRoots>,
}

/// `ManagedAssetRoots` (`backend-bootstrap.ts`): the backend's own folders
/// (release test 146, plan 0005); on Linux they are not under the app's data
/// folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAssetRoots {
    pub screens: PathBuf,
    pub banners: PathBuf,
    /// Absent from an older backend; the sounds then fall back to the app's
    /// data folder alone.
    pub sounds: Option<PathBuf>,
}

impl ManagedAssetRoots {
    /// `parseManagedAssetRoots`: an absent or malformed value only costs the
    /// fallback to the app's data folder; it never rejects the backend.
    pub fn parse(value: Option<&Value>) -> Option<Self> {
        let object = value?.as_object()?;
        let absolute = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        Some(Self {
            screens: absolute("screens")?,
            banners: absolute("banners")?,
            sounds: absolute("sounds"),
        })
    }
}

impl BackendBootstrap {
    /// Mirrors `parseBackendBootstrap` in `backend-bootstrap.ts`.
    pub fn parse(value: &Value) -> Result<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| anyhow!("backend bootstrap must be an object"))?;
        let host = object
            .get("host")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("backend bootstrap has no host"))?;
        if host != "127.0.0.1" {
            bail!("backend bootstrap host {host} is not loopback");
        }
        let port = object
            .get("port")
            .and_then(Value::as_u64)
            .filter(|port| (1..=65_535).contains(port))
            .ok_or_else(|| anyhow!("backend bootstrap port is invalid"))?;
        let token = object.get("token").and_then(Value::as_str).unwrap_or("");
        let admin_token = object
            .get("adminToken")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !valid_secret(token) || !valid_secret(admin_token) || token == admin_token {
            bail!("backend bootstrap credentials are invalid");
        }
        let pid = object
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or_else(|| anyhow!("backend bootstrap has no pid"))?;
        let parent_pid = object
            .get("parentPid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok());
        Ok(Self {
            host: host.to_string(),
            port: port as u16,
            token: token.to_string(),
            admin_token: admin_token.to_string(),
            pid,
            parent_pid,
            managed_asset_roots: ManagedAssetRoots::parse(object.get("managedAssetRoots")),
        })
    }

    pub fn renderer(&self) -> Credential {
        Credential {
            host: self.host.clone(),
            port: self.port,
            token: self.token.clone(),
        }
    }

    pub fn admin(&self) -> Credential {
        Credential {
            host: self.host.clone(),
            port: self.port,
            token: self.admin_token.clone(),
        }
    }
}

/// The `OWNERSHIP` line: the real backend's PID, authenticated by our token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendOwnership {
    pub pid: u32,
    pub parent_pid: Option<u32>,
}

impl BackendOwnership {
    /// Mirrors `parseBackendProcessOwnership` in `backend-bootstrap.ts`.
    pub fn parse(value: &Value, expected_token: &str) -> Result<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| anyhow!("backend ownership must be an object"))?;
        if !valid_secret(expected_token)
            || object.get("token").and_then(Value::as_str) != Some(expected_token)
        {
            bail!("backend ownership token does not match this generation");
        }
        let pid = object
            .get("pid")
            .and_then(Value::as_u64)
            .filter(|pid| *pid > 1)
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or_else(|| anyhow!("backend ownership pid is invalid"))?;
        let parent_pid = match object.get("parentPid") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .filter(|pid| *pid >= 1)
                    .and_then(|pid| u32::try_from(pid).ok())
                    .ok_or_else(|| anyhow!("backend ownership parentPid is invalid"))?,
            ),
        };
        Ok(Self { pid, parent_pid })
    }
}

fn valid_secret(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte == b'-' || byte.is_ascii_hexdigit())
}

/// Where the backend keeps its data.
///
/// Electron's rule (`backend-isolation.ts`) is all or nothing: a harness that
/// moves the app's data directory moves the backend's sqlite, secrets and
/// recordings with it; otherwise the backend resolves its own defaults
/// (`~/Library/Application Support/Videorc`, `~/Movies/Videorc/Recordings`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Isolation {
    /// Everything under `data_dir`: sqlite, secrets, recordings, logs,
    /// thumbnails. Smokes, probes, tests and `--profile` runs.
    Profile,
    /// The owner's real data: the backend picks its own database, secrets and
    /// recordings paths; only logs and thumbnails live under `data_dir`, as
    /// Electron passes them from `userData`.
    RealUserData,
}

/// Where an isolated backend ([`Isolation::Profile`]) keeps its sqlite,
/// secrets and recordings: all under the app's data directory, as the smoke
/// launcher sets them for Electron (`smokeAppEnv`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolatedBackendPaths {
    pub database: PathBuf,
    pub secrets: PathBuf,
    pub recordings: PathBuf,
}

impl IsolatedBackendPaths {
    pub fn under(data_dir: &Path) -> Self {
        Self {
            database: data_dir.join("videorc.sqlite3"),
            secrets: data_dir.join("videorc-secrets.json"),
            recordings: data_dir.join("recordings"),
        }
    }
}

/// How to start the backend.
#[derive(Clone)]
pub struct BackendLaunch {
    /// The executable: the built backend, or `cargo` for the dev chain.
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// The app's data directory (Electron's `userData`). With
    /// [`Isolation::Profile`] everything the backend writes lives under it.
    pub data_dir: PathBuf,
    pub isolation: Isolation,
    pub extra_env: Vec<(String, String)>,
    /// Prepended to the child's `PATH` (Electron adds `~/.cargo/bin` and the
    /// bundled FFmpeg directory).
    pub path_prepend: Vec<PathBuf>,
    /// `VIDEORC_APP_VERSION`: the desktop app's version, which keys the
    /// performance check. `None` leaves it unset.
    pub app_version: Option<String>,
    pub ready_timeout: Duration,
    /// Echo the backend's stderr lines to this process's stderr.
    pub echo_stderr: bool,
    /// Every stderr line also goes here (the app log).
    pub stderr_sink: Option<StderrSink>,
}

impl std::fmt::Debug for BackendLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackendLaunch")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("cwd", &self.cwd)
            .field("data_dir", &self.data_dir)
            .field("isolation", &self.isolation)
            .field("extra_env", &self.extra_env)
            .field("path_prepend", &self.path_prepend)
            .field("app_version", &self.app_version)
            .field("ready_timeout", &self.ready_timeout)
            .field("echo_stderr", &self.echo_stderr)
            .field("stderr_sink", &self.stderr_sink.is_some())
            .finish()
    }
}

impl BackendLaunch {
    /// The debug binary `cargo build -p videorc-backend` produced.
    pub fn debug_binary(workspace_root: &Path, data_dir: PathBuf) -> Self {
        Self::binary(
            workspace_root
                .join("target")
                .join("debug")
                .join(backend_binary_name()),
            workspace_root,
            data_dir,
        )
    }

    /// An isolated backend at `program` with every data path under `data_dir`.
    pub fn binary(program: PathBuf, workspace_root: &Path, data_dir: PathBuf) -> Self {
        Self {
            program,
            args: Vec::new(),
            cwd: workspace_root.to_path_buf(),
            data_dir,
            isolation: Isolation::Profile,
            extra_env: Vec::new(),
            path_prepend: Vec::new(),
            app_version: None,
            ready_timeout: Duration::from_secs(90),
            echo_stderr: false,
            stderr_sink: None,
        }
    }

    /// The dev chain Electron uses: `cargo run --quiet -p videorc-backend`.
    /// The spawned child is then the cargo wrapper; the `OWNERSHIP` line
    /// names the real backend.
    pub fn cargo_run(workspace_root: &Path, data_dir: PathBuf) -> Self {
        let mut launch = Self::binary(PathBuf::from("cargo"), workspace_root, data_dir);
        launch.args = [
            "run",
            "--quiet",
            "-p",
            "videorc-backend",
            "--bin",
            "videorc-backend",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        launch
    }

    /// The label the owned-process ledger records the spawned child under
    /// (`backend-owned-processes.ts`: `videorc-backend` for a binary,
    /// `cargo-run-videorc-backend` for the dev chain).
    pub fn wrapper_label(&self) -> &'static str {
        if self.program.file_stem().is_some_and(|stem| stem == "cargo") {
            "cargo-run-videorc-backend"
        } else {
            "videorc-backend"
        }
    }
}

/// `videorc-backend` or `videorc-backend.exe`.
pub fn backend_binary_name() -> &'static str {
    if cfg!(windows) {
        "videorc-backend.exe"
    } else {
        "videorc-backend"
    }
}

/// What `stop` observed.
#[derive(Debug, Clone)]
pub struct BackendStopReport {
    /// The shutdown preparation response, when the backend answered.
    pub preparation: Option<Value>,
    pub preparation_error: Option<String>,
    pub exit_status: Option<ExitStatus>,
    pub forced: bool,
    /// Owned PIDs this process signalled and confirmed gone.
    pub reaped_pids: Vec<u32>,
    /// Owned PIDs still alive after the kill deadline. Must be empty.
    pub stray_pids: Vec<u32>,
    pub stderr_tail: Vec<String>,
}

/// What was left after a backend exited on its own and its owned PIDs were
/// checked ([`BackendProcess::reap_after_exit`]).
#[derive(Debug, Clone, Default)]
pub struct BackendReapReport {
    pub reaped_pids: Vec<u32>,
    /// PIDs this generation owned that outlived the exit and were killed.
    pub killed_pids: Vec<u32>,
    pub stray_pids: Vec<u32>,
}

/// Persists one PID a generation owns the moment it is known and returns
/// the identity it recorded (`recordBackendOwnedProcess`: the spawned child
/// right after spawn, the real backend on `OWNERSHIP`). An error ends the
/// generation: a backend the ledger does not cover must not keep running.
pub type OwnershipRecorder =
    Arc<dyn Fn(u32, &str) -> Result<Option<ProcessIdentity>> + Send + Sync>;

/// Electron's `BACKEND_PRE_BOOTSTRAP_SHUTDOWN_KILL_GRACE_MS`: a startup the
/// app abandons before READY gets SIGTERM, this long, then SIGKILL.
pub const PRE_BOOTSTRAP_KILL_GRACE: Duration = Duration::from_secs(5);
/// How long the SIGKILL of an abandoned startup may take to be confirmed
/// (Electron's 10 s pre-bootstrap timeout, less the grace).
const PRE_BOOTSTRAP_KILL_CONFIRM: Duration = Duration::from_secs(5);

/// How [`BackendProcess::spawn_with`] records and stops a startup.
#[derive(Clone, Default)]
pub struct SpawnOptions {
    /// Persists each owned PID as soon as it is known. Without one, nothing
    /// is persisted, but every PID's identity is still read for the signals.
    pub recorder: Option<OwnershipRecorder>,
    /// Turns true when the app quits: a startup still waiting for READY is
    /// abandoned at once (SIGTERM, [`PRE_BOOTSTRAP_KILL_GRACE`], SIGKILL)
    /// instead of running out its ready timeout.
    pub cancel: Option<watch::Receiver<bool>>,
}

/// A startup that never reached READY, and what it left behind. Every PID
/// it owned was signalled (the spawned child directly, any other PID only
/// through its recorded identity) before this is returned.
#[derive(Debug)]
pub struct StartupError {
    pub error: anyhow::Error,
    /// `cancel` turned true before READY: the app is quitting.
    pub cancelled: bool,
    /// Owned PIDs confirmed gone: the caller clears them from its ledger.
    pub reaped_pids: Vec<u32>,
    /// Owned PIDs still alive or unprobeable after the kill: they stay
    /// recorded, so the next launch reaps them.
    pub stray_pids: Vec<u32>,
}

impl StartupError {
    fn nothing_spawned(error: anyhow::Error) -> Self {
        Self {
            error,
            cancelled: false,
            reaped_pids: Vec::new(),
            stray_pids: Vec::new(),
        }
    }
}

impl std::fmt::Display for StartupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.error)?;
        if !self.stray_pids.is_empty() {
            write!(
                f,
                "; owned pid(s) {} are still running",
                join_pids(&self.stray_pids)
            )?;
        }
        Ok(())
    }
}

impl std::error::Error for StartupError {}

fn join_pids(pids: &[u32]) -> String {
    pids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Every PID one generation owns, and how each may be signalled
/// (`signalRecordedOwnership`): the spawned child directly while it is
/// unreaped (its PID cannot be reused before we wait on it); every other PID
/// only after its recorded identity is read again, so a PID the OS handed
/// to an unrelated process is never signalled.
#[derive(Debug, Default)]
struct OwnedPids {
    wrapper_pid: u32,
    /// The child's exit was observed and it is reaped: its PID is never
    /// signalled again (it may already belong to someone else).
    wrapper_exited: bool,
    /// PIDs that are not our child, with the identity read when they were
    /// recorded. `None`: the identity could not be read; never signalled.
    others: BTreeMap<u32, Option<ProcessIdentity>>,
}

impl OwnedPids {
    fn new(wrapper_pid: u32) -> Self {
        Self {
            wrapper_pid,
            wrapper_exited: false,
            others: BTreeMap::new(),
        }
    }

    fn all(&self) -> Vec<u32> {
        std::iter::once(self.wrapper_pid)
            .chain(self.others.keys().copied())
            .collect()
    }

    fn contains(&self, pid: u32) -> bool {
        pid == self.wrapper_pid || self.others.contains_key(&pid)
    }

    fn signal(&self, pids: &[u32], signal: Signal) {
        for &pid in pids {
            if pid == self.wrapper_pid {
                if !self.wrapper_exited {
                    signal_pids([pid], signal);
                }
            } else if let Some(Some(identity)) = self.others.get(&pid) {
                let _ = signal_recorded(pid, identity, signal);
            }
        }
    }

    /// Whether `pid` may still be ours and running. A reused PID counts as
    /// gone; an unprobeable one, or one whose identity was never read, as
    /// alive (never assumed gone).
    fn is_alive(&self, pid: u32) -> bool {
        if pid == self.wrapper_pid {
            return !self.wrapper_exited && process_is_alive(pid);
        }
        match self.others.get(&pid) {
            Some(Some(identity)) => recorded_is_alive(pid, identity),
            Some(None) => process_is_alive(pid),
            None => false,
        }
    }

    fn alive(&self) -> Vec<u32> {
        self.all()
            .into_iter()
            .filter(|pid| self.is_alive(*pid))
            .collect()
    }

    fn reaped(&self, strays: &[u32]) -> Vec<u32> {
        self.all()
            .into_iter()
            .filter(|pid| !strays.contains(pid))
            .collect()
    }
}

/// A generation between spawn and READY. Anything that ends it early goes
/// through [`Startup::abandon`]; a panic or a dropped future through `Drop`.
struct Startup {
    /// Always `Some` until [`Startup::into_process`] takes it.
    child: Option<Child>,
    owned: OwnedPids,
    ownership: Option<BackendOwnership>,
    settled: bool,
}

impl Startup {
    fn child(&mut self) -> &mut Child {
        self.child.as_mut().expect("a startup holds its child")
    }

    /// Reads `OWNERSHIP` and `READY`, recording the real backend the moment
    /// it names itself.
    async fn handshake(
        &mut self,
        lines: &mut Lines<BufReader<ChildStdout>>,
        launch: &BackendLaunch,
        ownership_token: &str,
        recorder: Option<&OwnershipRecorder>,
        stderr_tail: &Arc<Mutex<VecDeque<String>>>,
    ) -> Result<BackendBootstrap> {
        let deadline = Instant::now() + launch.ready_timeout;
        let bootstrap = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                bail!(
                    "the backend did not print READY within {:?}; stderr tail:\n{}",
                    launch.ready_timeout,
                    tail_text(stderr_tail)
                );
            }
            let line = match tokio::time::timeout(remaining, lines.next_line()).await {
                Ok(Ok(Some(line))) => line,
                Ok(Ok(None)) => {
                    let status = tokio::time::timeout(Duration::from_secs(2), self.child().wait())
                        .await
                        .ok()
                        .and_then(Result::ok);
                    if status.is_some() {
                        self.owned.wrapper_exited = true;
                    }
                    bail!(
                        "the backend exited before READY ({}); stderr tail:\n{}",
                        status
                            .map(|status| status.to_string())
                            .unwrap_or_else(|| "no exit status".to_string()),
                        tail_text(stderr_tail)
                    );
                }
                Ok(Err(error)) => bail!("could not read the backend's stdout: {error}"),
                Err(_) => continue,
            };
            let trimmed = line.trim();
            if let Some(json) = trimmed.strip_prefix(OWNERSHIP_PREFIX) {
                let value: Value =
                    serde_json::from_str(json).context("the OWNERSHIP line is not JSON")?;
                let parsed = BackendOwnership::parse(&value, ownership_token)?;
                match self.ownership {
                    Some(previous) if previous.pid != parsed.pid => bail!(
                        "two backend PIDs claimed one generation ({} and {})",
                        previous.pid,
                        parsed.pid
                    ),
                    Some(_) => continue,
                    None => {}
                }
                // Lineage (backendOwnershipLineageMatches): a direct binary is
                // the child itself; the cargo chain's backend is the
                // wrapper's child. A PID that is neither is not ours: it is
                // never recorded nor signalled.
                let wrapper_pid = self.owned.wrapper_pid;
                if parsed.pid != wrapper_pid && parsed.parent_pid != Some(wrapper_pid) {
                    bail!(
                        "backend pid {} is not the spawned process {} nor its child (parent {:?})",
                        parsed.pid,
                        wrapper_pid,
                        parsed.parent_pid
                    );
                }
                self.ownership = Some(parsed);
                if parsed.pid != wrapper_pid {
                    self.own_backend(parsed.pid, recorder)?;
                }
                continue;
            }
            if let Some(json) = trimmed.strip_prefix(READY_PREFIX) {
                let value: Value =
                    serde_json::from_str(json).context("the READY line is not JSON")?;
                break BackendBootstrap::parse(&value)?;
            }
            if launch.echo_stderr && !trimmed.is_empty() {
                eprintln!("[backend stdout] {trimmed}");
            }
        };
        let Some(ownership) = self.ownership else {
            bail!("the backend printed READY without an OWNERSHIP marker");
        };
        if bootstrap.pid != ownership.pid {
            // The READY PID is unverified: it is never signalled.
            bail!(
                "READY pid {} does not match the OWNERSHIP pid {}",
                bootstrap.pid,
                ownership.pid
            );
        }
        Ok(bootstrap)
    }

    /// Records the real backend behind a wrapper (Electron: on OWNERSHIP).
    /// Its identity is kept either way, so the cleanup can signal it safely
    /// even when the ledger could not take it; a failed record still ends
    /// the generation.
    fn own_backend(&mut self, pid: u32, recorder: Option<&OwnershipRecorder>) -> Result<()> {
        let recorded = match recorder {
            Some(recorder) => recorder(pid, "videorc-backend"),
            None => Ok(None),
        };
        let identity = match &recorded {
            Ok(Some(identity)) => Some(identity.clone()),
            _ => match probe_process_retrying(pid) {
                ProbeResult::Live(identity) => Some(identity),
                _ => None,
            },
        };
        self.owned.others.insert(pid, identity);
        recorded
            .map(|_| ())
            .with_context(|| format!("could not record the backend process {pid}"))
    }

    /// Ends a startup that never reached READY. A cancelled one gets
    /// SIGTERM and [`PRE_BOOTSTRAP_KILL_GRACE`] first; a failed one is
    /// killed at once. Then SIGKILL and an exact liveness check.
    async fn abandon(
        mut self,
        error: anyhow::Error,
        cancelled: bool,
        mut stderr_task: JoinHandle<()>,
    ) -> StartupError {
        self.settled = true;
        if cancelled {
            self.owned.signal(&self.owned.all(), Signal::Terminate);
            self.wait_gone(PRE_BOOTSTRAP_KILL_GRACE).await;
        }
        let alive = self.wait_gone(Duration::ZERO).await;
        if !alive.is_empty() {
            self.owned.signal(&alive, Signal::Kill);
        }
        let stray_pids = self.wait_gone(PRE_BOOTSTRAP_KILL_CONFIRM).await;
        if tokio::time::timeout(Duration::from_secs(1), &mut stderr_task)
            .await
            .is_err()
        {
            stderr_task.abort();
        }
        StartupError {
            error,
            cancelled,
            reaped_pids: self.owned.reaped(&stray_pids),
            stray_pids,
        }
    }

    /// Probes every owned PID until none is alive or `timeout` passes;
    /// returns the ones still alive. Reaps the child when it exits.
    async fn wait_gone(&mut self, timeout: Duration) -> Vec<u32> {
        let until = Instant::now() + timeout;
        loop {
            if !self.owned.wrapper_exited && matches!(self.child().try_wait(), Ok(Some(_))) {
                self.owned.wrapper_exited = true;
            }
            let alive = self.owned.alive();
            if alive.is_empty() || Instant::now() >= until {
                return alive;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for Startup {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        // A panic, or the spawn future dropped mid-handshake: the child dies
        // with `kill_on_drop`; the real backend behind a wrapper only by
        // this identity-checked kill.
        self.owned.signal(&self.owned.all(), Signal::Kill);
    }
}

fn tail_text(tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    tail.lock()
        .map(|tail| tail.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
        .join("\n")
}

/// Becomes ready when `cancel` turns true; never without one (or once its
/// sender is gone).
async fn cancelled(cancel: &mut Option<watch::Receiver<bool>>) {
    if let Some(cancel) = cancel {
        loop {
            if *cancel.borrow_and_update() {
                return;
            }
            if cancel.changed().await.is_err() {
                break;
            }
        }
    }
    std::future::pending::<()>().await
}

/// One running backend generation and every PID it owns.
pub struct BackendProcess {
    child: Child,
    owned: OwnedPids,
    ownership: BackendOwnership,
    bootstrap: BackendBootstrap,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stderr_task: JoinHandle<()>,
    stdout_task: Option<JoinHandle<()>>,
    data_dir: PathBuf,
    started_at: Instant,
    /// `stop` or `reap_after_exit` ran: `Drop` has nothing left to kill.
    settled: bool,
    /// `wait_exit` observed the child's exit.
    exit_status: Option<ExitStatus>,
}

fn backend_command(launch: &BackendLaunch, ownership_token: &str) -> Result<Command> {
    std::fs::create_dir_all(&launch.data_dir)
        .with_context(|| format!("could not create {}", launch.data_dir.display()))?;
    let logs_dir = launch.data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir)?;

    let mut command = Command::new(&launch.program);
    command
        .args(&launch.args)
        .current_dir(&launch.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (name, _) in std::env::vars_os() {
        let name_text = name.to_string_lossy();
        if STRIPPED_ENV.contains(&name_text.as_ref())
            || STRIPPED_ENV_PREFIXES
                .iter()
                .any(|prefix| name_text.starts_with(prefix))
        {
            command.env_remove(&name);
        }
    }
    if cfg!(target_os = "macos") {
        command.env("CARGO_INCREMENTAL", "0");
    }
    if !launch.path_prepend.is_empty() {
        let mut entries: Vec<PathBuf> = launch.path_prepend.clone();
        if let Some(existing) = std::env::var_os("PATH") {
            entries.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(entries) {
            command.env("PATH", joined);
        }
    }
    // Full isolation or none (backend-isolation.ts): sqlite, secrets and
    // recordings move together, never the owner's real profile.
    if launch.isolation == Isolation::Profile {
        let isolated = IsolatedBackendPaths::under(&launch.data_dir);
        command
            .env("VIDEORC_DATABASE_PATH", isolated.database)
            .env("VIDEORC_SECRETS_PATH", isolated.secrets)
            .env("VIDEORC_RECORDINGS_DIR", isolated.recordings);
    }
    command
        .env("VIDEORC_LOGS_DIR", &logs_dir)
        .env(
            "VIDEORC_MANAGED_THUMBNAIL_ROOT",
            launch.data_dir.join("scheduled-thumbnails"),
        )
        .env("VIDEORC_ENABLE_SMOKE_RPC", "0")
        // The backend's watchdog also exits when THIS process dies; the
        // ppid check alone misses the dev chain, where cargo is the parent.
        .env("VIDEORC_SUPERVISOR_PID", std::process::id().to_string())
        // Root of the process tree Windows system audio excludes.
        .env("VIDEORC_ELECTRON_MAIN_PID", std::process::id().to_string())
        // macOS system audio: this app plays no audio of its own (every
        // sound plays from the backend, which keeps its own out), so the
        // capture excludes no app. Excluding this app by its pid took every
        // sound already playing from its responsible process (a terminal's,
        // in dev and smokes) when System audio came on mid-take.
        .env("VIDEORC_SYSTEM_AUDIO_EXCLUDE_HOST_APP", "0")
        .env(OWNERSHIP_TOKEN_ENV, ownership_token)
        // Plan 260 S1.8 (L1): this app has no renderer room, so the backend
        // holds the talk show's room (macOS today: the SDK's other builds
        // are owed; elsewhere the backend has no room and ignores it).
        .env(ROOM_HOST_ENV, ROOM_HOST_BACKEND);
    if let Some(version) = &launch.app_version {
        command.env("VIDEORC_APP_VERSION", version);
    }
    if std::env::var_os("RUST_LOG").is_none() {
        command.env("RUST_LOG", "videorc_backend=info");
    }
    for (name, value) in &launch.extra_env {
        command.env(name, value);
    }
    Ok(command)
}

impl BackendProcess {
    /// Spawns the backend and waits for `OWNERSHIP` and `READY`, with no
    /// ledger and no cancel ([`Self::spawn_with`]).
    pub async fn spawn(launch: BackendLaunch) -> Result<Self, StartupError> {
        Self::spawn_with(launch, SpawnOptions::default()).await
    }

    /// Spawns the backend and waits for `OWNERSHIP` and `READY`. The
    /// spawned child is recorded right after spawn and the real backend on
    /// `OWNERSHIP`; a failed record, a bad line, the ready timeout or a
    /// cancel ends the startup and stops every PID it owned.
    pub async fn spawn_with(
        launch: BackendLaunch,
        options: SpawnOptions,
    ) -> Result<Self, StartupError> {
        let ownership_token = uuid::Uuid::new_v4().to_string();
        let started_at = Instant::now();
        let mut command =
            backend_command(&launch, &ownership_token).map_err(StartupError::nothing_spawned)?;
        let mut child = command
            .spawn()
            .with_context(|| {
                format!(
                    "could not start the backend {} {}",
                    launch.program.display(),
                    launch.args.join(" ")
                )
            })
            .map_err(StartupError::nothing_spawned)?;
        // `kill_on_drop` ends the child on every early return below.
        let Some(wrapper_pid) = child.id() else {
            return Err(StartupError::nothing_spawned(anyhow!(
                "the backend child has no pid"
            )));
        };
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err(StartupError::nothing_spawned(anyhow!(
                "the backend child has no stdout or stderr"
            )));
        };

        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
        let stderr_task = tokio::spawn(drain_stderr(
            stderr,
            stderr_tail.clone(),
            launch.echo_stderr,
            launch.stderr_sink.clone(),
        ));
        let mut startup = Startup {
            child: Some(child),
            owned: OwnedPids::new(wrapper_pid),
            ownership: None,
            settled: false,
        };

        // Recorded the moment it exists, so a crash of this app during a slow
        // startup (cargo compiling, a stalled device probe) leaves it in the
        // ledger for the next launch to reap.
        if let Some(recorder) = &options.recorder
            && let Err(error) = recorder(wrapper_pid, launch.wrapper_label())
        {
            let error = error.context(format!(
                "could not record the spawned backend process {wrapper_pid}"
            ));
            return Err(startup.abandon(error, false, stderr_task).await);
        }

        let mut stdout_lines = BufReader::new(stdout).lines();
        let mut cancel = options.cancel.clone();
        let handshake = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => None,
            result = startup.handshake(
                &mut stdout_lines,
                &launch,
                &ownership_token,
                options.recorder.as_ref(),
                &stderr_tail,
            ) => Some(result),
        };
        let bootstrap = match handshake {
            Some(Ok(bootstrap)) => bootstrap,
            Some(Err(error)) => return Err(startup.abandon(error, false, stderr_task).await),
            None => {
                let error = anyhow!("the app quit before the backend printed READY");
                return Err(startup.abandon(error, true, stderr_task).await);
            }
        };
        let ownership = startup
            .ownership
            .expect("the handshake checked the OWNERSHIP marker");

        let echo = launch.echo_stderr;
        let stdout_task = tokio::spawn(async move {
            while let Ok(Some(line)) = stdout_lines.next_line().await {
                if echo && !line.trim().is_empty() {
                    eprintln!("[backend stdout] {}", line.trim());
                }
            }
        });

        startup.settled = true;
        let child = startup.child.take().expect("a startup holds its child");
        let owned = std::mem::take(&mut startup.owned);
        Ok(Self {
            child,
            owned,
            ownership,
            bootstrap,
            stderr_tail,
            stderr_task,
            stdout_task: Some(stdout_task),
            data_dir: launch.data_dir,
            started_at,
            settled: false,
            exit_status: None,
        })
    }

    pub fn bootstrap(&self) -> &BackendBootstrap {
        &self.bootstrap
    }

    pub fn ownership(&self) -> BackendOwnership {
        self.ownership
    }

    /// The PID this process spawned (the backend, or the cargo wrapper).
    pub fn wrapper_pid(&self) -> u32 {
        self.owned.wrapper_pid
    }

    /// The real backend's PID from the `OWNERSHIP` line.
    pub fn backend_pid(&self) -> u32 {
        self.ownership.pid
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// When the child was spawned.
    pub fn started_at(&self) -> Instant {
        self.started_at
    }

    /// Every PID this generation owns: spawned by us or reported by the backend.
    pub fn owned_pids(&self) -> impl Iterator<Item = u32> + '_ {
        self.owned.all().into_iter()
    }

    /// Records a PID the backend reported as its own (a child it started).
    /// Its identity is read now; a PID whose identity cannot be read is
    /// refused (false), since it could never be signalled safely.
    pub fn record_owned_pid(&mut self, pid: u32) -> bool {
        if pid <= 1 || pid == std::process::id() {
            return false;
        }
        if self.owned.contains(pid) {
            return true;
        }
        match probe_process_retrying(pid) {
            ProbeResult::Live(identity) => {
                self.owned.others.insert(pid, Some(identity));
                true
            }
            _ => false,
        }
    }

    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail
            .lock()
            .map(|tail| tail.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Waits for the spawned child to exit on its own (a crash, or the
    /// backend's own ordered shutdown). Cancel-safe: dropping the future
    /// loses nothing. After it returns, [`Self::reap_after_exit`] settles the
    /// other owned PIDs.
    pub async fn wait_exit(&mut self) -> std::io::Result<ExitStatus> {
        if let Some(status) = self.exit_status {
            return Ok(status);
        }
        let status = self.child.wait().await?;
        self.exit_status = Some(status);
        self.owned.wrapper_exited = true;
        Ok(status)
    }

    /// After [`Self::wait_exit`]: confirms every owned PID is gone, killing
    /// the ones that outlived the child (the cargo chain's real backend,
    /// identity-checked) and probing until gone or `deadline`.
    pub async fn reap_after_exit(mut self, deadline: Duration) -> BackendReapReport {
        self.settled = true;
        let mut report = BackendReapReport::default();
        let alive = self.owned.alive();
        if !alive.is_empty() {
            self.owned.signal(&alive, Signal::Kill);
            report.killed_pids = alive;
        }
        report.stray_pids = self.wait_until_gone(deadline).await;
        report.reaped_pids = self.owned.reaped(&report.stray_pids);
        self.finish_tasks().await;
        report
    }

    /// `POST /process/shutdown/prepare` with the admin credential, then
    /// SIGTERM, wait `grace`, SIGKILL, and an exact liveness check of every
    /// owned PID (never a process-table scan). PIDs that are not our child
    /// are signalled only while they still carry their recorded identity.
    pub async fn stop(mut self, grace: Duration) -> Result<BackendStopReport> {
        self.settled = true;
        let mut report = BackendStopReport {
            preparation: None,
            preparation_error: None,
            exit_status: None,
            forced: false,
            reaped_pids: Vec::new(),
            stray_pids: Vec::new(),
            stderr_tail: Vec::new(),
        };
        if self.exit_status.is_none() {
            let request_id = uuid::Uuid::new_v4().to_string();
            let path = format!(
                "/process/shutdown/prepare?token={}&requestId={}",
                self.bootstrap.admin_token, request_id
            );
            match tokio::time::timeout(
                Duration::from_secs(20),
                http_post(&self.bootstrap.host, self.bootstrap.port, &path),
            )
            .await
            {
                // The answer's `backendPid` never adds a PID to signal:
                // Electron only trusts one it already owns, and every PID
                // this generation owns is already here.
                Ok(Ok(response)) => {
                    let payload: Value =
                        serde_json::from_str(&response.body).unwrap_or(Value::Null);
                    if response.status == 200 {
                        report.preparation = Some(payload);
                    } else {
                        report.preparation_error = Some(format!(
                            "shutdown preparation answered HTTP {}: {}",
                            response.status, response.body
                        ));
                    }
                }
                Ok(Err(error)) => {
                    report.preparation_error =
                        Some(format!("shutdown preparation failed: {error:#}"));
                }
                Err(_) => {
                    report.preparation_error =
                        Some("shutdown preparation timed out after 20s".to_string());
                }
            }
        }

        // SIGTERM reaches the backend's shutdown_signal; the cargo wrapper
        // forwards nothing, so signal every owned PID exactly.
        self.owned.signal(&self.owned.all(), Signal::Terminate);
        let status = match self.exit_status {
            Some(status) => Some(status),
            None => match tokio::time::timeout(grace, self.child.wait()).await {
                Ok(result) => result.ok(),
                Err(_) => {
                    report.forced = true;
                    self.owned.signal(&self.owned.all(), Signal::Kill);
                    tokio::time::timeout(Duration::from_secs(10), self.child.wait())
                        .await
                        .ok()
                        .and_then(Result::ok)
                }
            },
        };
        if status.is_some() {
            self.exit_status = status;
            self.owned.wrapper_exited = true;
        }
        report.exit_status = status;

        // The child is reaped by `wait`; a backend behind a cargo wrapper is
        // not our child, so confirm it by probing its identity.
        let alive = self.owned.alive();
        if !alive.is_empty() {
            report.forced = true;
            self.owned.signal(&alive, Signal::Kill);
        }
        report.stray_pids = self.wait_until_gone(Duration::from_secs(10)).await;
        report.reaped_pids = self.owned.reaped(&report.stray_pids);

        self.finish_tasks().await;
        report.stderr_tail = self.stderr_tail();
        Ok(report)
    }

    /// Probes every owned PID until none is alive or `deadline` passes;
    /// returns the ones still alive.
    async fn wait_until_gone(&self, deadline: Duration) -> Vec<u32> {
        let until = Instant::now() + deadline;
        loop {
            let alive = self.owned.alive();
            if alive.is_empty() || Instant::now() >= until {
                return alive;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    async fn finish_tasks(&mut self) {
        if let Some(task) = self.stdout_task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), &mut self.stderr_task).await;
    }
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        // A panic or an early return must not leave a backend behind. The
        // wrapper dies with `kill_on_drop`; the real backend behind a cargo
        // wrapper only by this identity-checked kill. A PID whose exit
        // `wait` observed is never signalled again.
        self.owned.signal(&self.owned.all(), Signal::Kill);
        self.stderr_task.abort();
        if let Some(task) = self.stdout_task.take() {
            task.abort();
        }
    }
}

async fn drain_stderr(
    stderr: tokio::process::ChildStderr,
    tail: Arc<Mutex<VecDeque<String>>>,
    echo: bool,
    sink: Option<StderrSink>,
) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if echo {
            eprintln!("[backend] {trimmed}");
        }
        if let Some(sink) = &sink {
            sink(trimmed);
        }
        if let Ok(mut tail) = tail.lock() {
            if tail.len() == STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(trimmed.to_string());
        }
    }
}

/// A signal for an exact PID this process owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Terminate,
    Kill,
}

/// Signals exact PIDs, unchecked: callers pass only this process's own
/// unreaped child, or a PID whose recorded identity they just re-read
/// ([`crate::ledger::signal_recorded`]). Never a process-table scan.
pub fn signal_pids(pids: impl IntoIterator<Item = u32>, signal: Signal) {
    for pid in pids {
        if pid <= 1 {
            continue;
        }
        #[cfg(unix)]
        {
            let signal = match signal {
                Signal::Terminate => libc::SIGTERM,
                Signal::Kill => libc::SIGKILL,
            };
            // SAFETY: kill(2) with an exact PID this process spawned or the
            // backend reported; no process-table scan.
            unsafe {
                libc::kill(pid as libc::pid_t, signal);
            }
        }
        #[cfg(not(unix))]
        {
            // Windows has no graceful signal: both collapse into one hard
            // kill of that exact PID (Electron's Node does the same).
            let _ = signal;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

/// Exact liveness: `kill(pid, 0)` answers ESRCH only once the process is gone
/// (a zombie still counts as alive until its parent reaps it).
pub fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 delivers nothing; it only checks the PID.
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if result == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(true)
    }
}

/// A bodyless HTTP/1.1 POST over loopback: the status code and the body.
async fn http_post(
    host: &str,
    port: u16,
    path_and_query: &str,
) -> Result<crate::http::HttpResponse> {
    let mut stream = TcpStream::connect((host, port))
        .await
        .with_context(|| format!("could not connect to {host}:{port}"))?;
    let request = format!(
        "POST {path_and_query} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await?;
    crate::http::parse_response(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bootstrap_parse_mirrors_electron_main() {
        // Roots must be absolute on the platform the test runs on.
        let (x, y, z) = if cfg!(windows) {
            (r"C:\x", r"C:\y", r"C:\z")
        } else {
            ("/x", "/y", "/z")
        };
        let value = json!({
            "host": "127.0.0.1", "port": 50000,
            "token": "11111111-2222-3333-4444-555555555555",
            "adminToken": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "pid": 4242, "parentPid": 4241,
            "managedAssetRoots": {"screens": x, "banners": y}
        });
        let bootstrap = BackendBootstrap::parse(&value).unwrap();
        assert_eq!(bootstrap.port, 50000);
        assert_eq!(bootstrap.pid, 4242);
        assert_eq!(bootstrap.parent_pid, Some(4241));
        assert_eq!(
            bootstrap.renderer().websocket_url(),
            "ws://127.0.0.1:50000/ws?token=11111111-2222-3333-4444-555555555555"
        );
        assert_ne!(bootstrap.admin().token, bootstrap.renderer().token);
        // Sounds joined later: without it the other two still count.
        assert_eq!(
            bootstrap.managed_asset_roots,
            Some(ManagedAssetRoots {
                screens: PathBuf::from(x),
                banners: PathBuf::from(y),
                sounds: None,
            })
        );
        let mut relative = value.clone();
        relative["managedAssetRoots"] = json!({"screens": "x", "banners": y, "sounds": z});
        assert_eq!(
            BackendBootstrap::parse(&relative)
                .unwrap()
                .managed_asset_roots,
            None
        );
        let mut absent = value.clone();
        absent.as_object_mut().unwrap().remove("managedAssetRoots");
        assert_eq!(
            BackendBootstrap::parse(&absent)
                .unwrap()
                .managed_asset_roots,
            None
        );

        let mut same = value.clone();
        same["adminToken"] = same["token"].clone();
        assert!(BackendBootstrap::parse(&same).is_err());
        let mut remote = value.clone();
        remote["host"] = json!("0.0.0.0");
        assert!(BackendBootstrap::parse(&remote).is_err());
    }

    #[test]
    fn ownership_parse_requires_this_generation_token() {
        let token = "11111111-2222-3333-4444-555555555555";
        let value = json!({"token": token, "pid": 77, "parentPid": 76});
        let ownership = BackendOwnership::parse(&value, token).unwrap();
        assert_eq!(ownership.pid, 77);
        assert_eq!(ownership.parent_pid, Some(76));
        assert!(BackendOwnership::parse(&value, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").is_err());
        assert!(BackendOwnership::parse(&json!({"token": token, "pid": 1}), token).is_err());
        let no_parent = BackendOwnership::parse(&json!({"token": token, "pid": 5}), token).unwrap();
        assert_eq!(no_parent.parent_pid, None);
    }

    #[test]
    fn this_process_is_alive() {
        assert!(process_is_alive(std::process::id()));
    }

    #[test]
    fn launch_labels_match_electron_ledger_labels() {
        let root = Path::new("/w");
        assert_eq!(
            BackendLaunch::debug_binary(root, PathBuf::from("/d")).wrapper_label(),
            "videorc-backend"
        );
        assert_eq!(
            BackendLaunch::cargo_run(root, PathBuf::from("/d")).wrapper_label(),
            "cargo-run-videorc-backend"
        );
        assert_eq!(
            BackendLaunch::binary(
                PathBuf::from("/x/videorc-backend.exe"),
                root,
                PathBuf::from("/d")
            )
            .wrapper_label(),
            "videorc-backend"
        );
    }
}
