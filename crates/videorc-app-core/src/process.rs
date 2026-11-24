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
//! Moved here from `videorc-dev-client` in plan 220 S2.1a; the supervisor
//! ([`crate::supervisor`]) drives one of these per backend generation.

use std::collections::{BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

const OWNERSHIP_PREFIX: &str = "OWNERSHIP ";
const READY_PREFIX: &str = "READY ";
const OWNERSHIP_TOKEN_ENV: &str = "VIDEORC_BACKEND_OWNERSHIP_TOKEN";
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

/// One running backend generation and every PID it owns.
pub struct BackendProcess {
    child: Child,
    wrapper_pid: u32,
    ownership: BackendOwnership,
    bootstrap: BackendBootstrap,
    owned_pids: BTreeSet<u32>,
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

impl BackendProcess {
    /// Spawns the backend and waits for `OWNERSHIP` and `READY`.
    pub async fn spawn(launch: BackendLaunch) -> Result<Self> {
        std::fs::create_dir_all(&launch.data_dir)
            .with_context(|| format!("could not create {}", launch.data_dir.display()))?;
        let logs_dir = launch.data_dir.join("logs");
        std::fs::create_dir_all(&logs_dir)?;
        let ownership_token = uuid::Uuid::new_v4().to_string();
        let started_at = Instant::now();

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
            .env(OWNERSHIP_TOKEN_ENV, &ownership_token);
        if let Some(version) = &launch.app_version {
            command.env("VIDEORC_APP_VERSION", version);
        }
        if std::env::var_os("RUST_LOG").is_none() {
            command.env("RUST_LOG", "videorc_backend=info");
        }
        for (name, value) in &launch.extra_env {
            command.env(name, value);
        }

        let mut child = command.spawn().with_context(|| {
            format!(
                "could not start the backend {} {}",
                launch.program.display(),
                launch.args.join(" ")
            )
        })?;
        let wrapper_pid = child
            .id()
            .ok_or_else(|| anyhow!("the backend child has no pid"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("the backend child has no stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("the backend child has no stderr"))?;

        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
        let stderr_task = tokio::spawn(drain_stderr(
            stderr,
            stderr_tail.clone(),
            launch.echo_stderr,
            launch.stderr_sink.clone(),
        ));

        let mut stdout_lines = BufReader::new(stdout).lines();
        let deadline = Instant::now() + launch.ready_timeout;
        let mut ownership: Option<BackendOwnership> = None;
        let bootstrap = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let tail = stderr_tail
                    .lock()
                    .map(|tail| tail.iter().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                kill_pids(
                    std::iter::once(wrapper_pid).chain(ownership.map(|ownership| ownership.pid)),
                );
                let _ = child.wait().await;
                bail!(
                    "the backend did not print READY within {:?}; stderr tail:\n{}",
                    launch.ready_timeout,
                    tail.join("\n")
                );
            }
            let line = match tokio::time::timeout(remaining, stdout_lines.next_line()).await {
                Ok(Ok(Some(line))) => line,
                Ok(Ok(None)) => {
                    let status = child.wait().await.ok();
                    let tail = stderr_tail
                        .lock()
                        .map(|tail| tail.iter().cloned().collect::<Vec<_>>())
                        .unwrap_or_default();
                    bail!(
                        "the backend exited before READY ({}); stderr tail:\n{}",
                        status
                            .map(|status| status.to_string())
                            .unwrap_or_else(|| "no exit status".to_string()),
                        tail.join("\n")
                    );
                }
                Ok(Err(error)) => bail!("could not read the backend's stdout: {error}"),
                Err(_) => continue,
            };
            let trimmed = line.trim();
            if let Some(json) = trimmed.strip_prefix(OWNERSHIP_PREFIX) {
                let value: Value =
                    serde_json::from_str(json).context("the OWNERSHIP line is not JSON")?;
                let parsed = BackendOwnership::parse(&value, &ownership_token)?;
                if let Some(previous) = ownership
                    && previous.pid != parsed.pid
                {
                    bail!(
                        "two backend PIDs claimed one generation ({} and {})",
                        previous.pid,
                        parsed.pid
                    );
                }
                ownership = Some(parsed);
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
        let Some(ownership) = ownership else {
            kill_pids([wrapper_pid]);
            let _ = child.wait().await;
            bail!("the backend printed READY without an OWNERSHIP marker");
        };
        if bootstrap.pid != ownership.pid {
            kill_pids([wrapper_pid, ownership.pid, bootstrap.pid]);
            let _ = child.wait().await;
            bail!(
                "READY pid {} does not match the OWNERSHIP pid {}",
                bootstrap.pid,
                ownership.pid
            );
        }
        // Lineage: a direct binary is the child itself; the cargo chain's
        // backend is the wrapper's child (backendOwnershipLineageMatches).
        if ownership.pid != wrapper_pid && ownership.parent_pid != Some(wrapper_pid) {
            kill_pids([wrapper_pid, ownership.pid]);
            let _ = child.wait().await;
            bail!(
                "backend pid {} is not the spawned process {} nor its child (parent {:?})",
                ownership.pid,
                wrapper_pid,
                ownership.parent_pid
            );
        }

        let echo = launch.echo_stderr;
        let stdout_task = tokio::spawn(async move {
            while let Ok(Some(line)) = stdout_lines.next_line().await {
                if echo && !line.trim().is_empty() {
                    eprintln!("[backend stdout] {}", line.trim());
                }
            }
        });

        let mut owned_pids = BTreeSet::new();
        owned_pids.insert(wrapper_pid);
        owned_pids.insert(ownership.pid);
        Ok(Self {
            child,
            wrapper_pid,
            ownership,
            bootstrap,
            owned_pids,
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
        self.wrapper_pid
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
        self.owned_pids.iter().copied()
    }

    /// Records a PID the backend reported as its own (a child it started).
    pub fn record_owned_pid(&mut self, pid: u32) {
        if pid > 1 {
            self.owned_pids.insert(pid);
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
        Ok(status)
    }

    /// After [`Self::wait_exit`]: confirms every owned PID is gone, killing
    /// the ones that outlived the child (the cargo chain's real backend) and
    /// probing until ESRCH or `deadline`. Exact PIDs only.
    pub async fn reap_after_exit(mut self, deadline: Duration) -> BackendReapReport {
        self.settled = true;
        let mut report = BackendReapReport::default();
        let pids: Vec<u32> = self
            .owned_pids
            .iter()
            .copied()
            .filter(|pid| *pid != self.wrapper_pid || self.exit_status.is_none())
            .collect();
        let alive: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| process_is_alive(*pid))
            .collect();
        if !alive.is_empty() {
            signal_pids(alive.iter().copied(), Signal::Kill);
            report.killed_pids = alive;
        }
        report.stray_pids = wait_until_gone(&pids, deadline).await;
        report.reaped_pids = self
            .owned_pids
            .iter()
            .copied()
            .filter(|pid| !report.stray_pids.contains(pid))
            .collect();
        self.finish_tasks().await;
        report
    }

    /// `POST /process/shutdown/prepare` with the admin credential, then
    /// SIGTERM, wait `grace`, SIGKILL, and an exact liveness check of every
    /// owned PID (`kill(pid, 0)` until ESRCH, never a process-table scan).
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
                Ok(Ok((status, body))) => {
                    let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    if let Some(pid) = payload
                        .get("backendPid")
                        .and_then(Value::as_u64)
                        .and_then(|pid| u32::try_from(pid).ok())
                    {
                        self.record_owned_pid(pid);
                    }
                    if status == 200 {
                        report.preparation = Some(payload);
                    } else {
                        report.preparation_error = Some(format!(
                            "shutdown preparation answered HTTP {status}: {body}"
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
        signal_pids(self.owned_pids.iter().copied(), Signal::Terminate);
        let status = match self.exit_status {
            Some(status) => Some(status),
            None => match tokio::time::timeout(grace, self.child.wait()).await {
                Ok(result) => result.ok(),
                Err(_) => {
                    report.forced = true;
                    signal_pids(self.owned_pids.iter().copied(), Signal::Kill);
                    tokio::time::timeout(Duration::from_secs(10), self.child.wait())
                        .await
                        .ok()
                        .and_then(Result::ok)
                }
            },
        };
        report.exit_status = status;

        // The child is reaped by `wait`; a backend behind a cargo wrapper is
        // not our child, so confirm it by probing until ESRCH.
        let pids: Vec<u32> = self
            .owned_pids
            .iter()
            .copied()
            .filter(|pid| *pid != self.wrapper_pid || status.is_none())
            .collect();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut killed_once = false;
        loop {
            let alive: Vec<u32> = pids
                .iter()
                .copied()
                .filter(|pid| process_is_alive(*pid))
                .collect();
            if alive.is_empty() {
                break;
            }
            if Instant::now() >= deadline {
                report.stray_pids = alive;
                break;
            }
            if !killed_once {
                signal_pids(alive.iter().copied(), Signal::Kill);
                killed_once = true;
                report.forced = true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        report.reaped_pids = self
            .owned_pids
            .iter()
            .copied()
            .filter(|pid| !report.stray_pids.contains(pid))
            .collect();

        self.finish_tasks().await;
        report.stderr_tail = self.stderr_tail();
        Ok(report)
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
        // wrapper would not. A PID whose exit `wait` observed is never
        // signalled again (it may already belong to someone else).
        let exited_wrapper = self.exit_status.map(|_| self.wrapper_pid);
        signal_pids(
            self.owned_pids
                .iter()
                .copied()
                .filter(|pid| Some(*pid) != exited_wrapper),
            Signal::Kill,
        );
        self.stderr_task.abort();
        if let Some(task) = self.stdout_task.take() {
            task.abort();
        }
    }
}

/// Probes `pids` until none is alive or `deadline` passes; returns the ones
/// still alive.
async fn wait_until_gone(pids: &[u32], deadline: Duration) -> Vec<u32> {
    let until = Instant::now() + deadline;
    loop {
        let alive: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| process_is_alive(*pid))
            .collect();
        if alive.is_empty() || Instant::now() >= until {
            return alive;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
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

/// Signals exact PIDs: ones this process spawned or the backend reported.
/// Never a process-table scan.
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

fn kill_pids(pids: impl IntoIterator<Item = u32>) {
    signal_pids(pids, Signal::Kill);
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
/// Small enough that the app does not need an HTTP client crate.
async fn http_post(host: &str, port: u16, path_and_query: &str) -> Result<(u16, String)> {
    let mut stream = TcpStream::connect((host, port))
        .await
        .with_context(|| format!("could not connect to {host}:{port}"))?;
    let request = format!(
        "POST {path_and_query} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| anyhow!("malformed HTTP response: {text}"))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("malformed HTTP status line: {head}"))?;
    let chunked = head
        .lines()
        .any(|line| line.to_ascii_lowercase().trim() == "transfer-encoding: chunked");
    let body = if chunked {
        decode_chunked(body)
    } else {
        body.to_string()
    };
    Ok((status, body))
}

fn decode_chunked(body: &str) -> String {
    let mut decoded = String::new();
    let mut rest = body;
    while let Some((size_line, after)) = rest.split_once("\r\n") {
        let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("0"), 16)
            .unwrap_or(0);
        if size == 0 || after.len() < size {
            break;
        }
        decoded.push_str(&after[..size]);
        rest = after[size..].strip_prefix("\r\n").unwrap_or("");
    }
    decoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bootstrap_parse_mirrors_electron_main() {
        let value = json!({
            "host": "127.0.0.1", "port": 50000,
            "token": "11111111-2222-3333-4444-555555555555",
            "adminToken": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "pid": 4242, "parentPid": 4241,
            "managedAssetRoots": {"screens": "/x", "banners": "/y"}
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
                screens: PathBuf::from("/x"),
                banners: PathBuf::from("/y"),
                sounds: None,
            })
        );
        let mut relative = value.clone();
        relative["managedAssetRoots"] = json!({"screens": "x", "banners": "/y", "sounds": "/z"});
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
    fn chunked_bodies_decode() {
        assert_eq!(decode_chunked("5\r\nhello\r\n0\r\n\r\n"), "hello");
        assert_eq!(decode_chunked("2\r\n{}\r\n0\r\n\r\n"), "{}");
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
