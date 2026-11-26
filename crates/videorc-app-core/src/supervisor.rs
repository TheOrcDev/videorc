//! `Videorc` supervises the backend the way Electron main does
//! (`index.ts`: `startBackend`, `finalizeBackendRuntimeExit`,
//! `scheduleBackendRestart`, `stopBackend`): one generation at a time, each
//! spawned with a fresh ownership token, recorded in the durable ledger,
//! restarted with backoff when it dies on its own, and stopped with the
//! shutdown handshake when the app quits. The state is published on a
//! `watch` channel; the UI reads it, never the processes.
//!
//! The supervisor runs as one tokio task. [`Supervisor::start`] must be
//! called inside a tokio runtime.

use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::crash_log::{
    CrashRecord, append_crash_record, classify_exit, describe_crash_record, read_crash_log,
    should_record_exit, stderr_tail_for_record,
};
use crate::ledger::OwnedProcessLedger;
use crate::log::Logger;
use crate::paths::AppPaths;
use crate::process::{
    BackendBootstrap, BackendLaunch, BackendProcess, BackendStopReport, OwnershipRecorder,
    SpawnOptions,
};
use crate::restart::{RestartDecision, RestartPolicy};

/// Electron: 30 s for the backend to finish its ordered shutdown after the
/// prepare handshake, then a hard kill.
pub const STOP_GRACE: Duration = Duration::from_secs(30);
/// How long a PID that outlived its generation's exit may take to disappear
/// after our kill before it is reported as a stray.
const REAP_AFTER_EXIT_DEADLINE: Duration = Duration::from_secs(10);
/// Electron's startup reap: SIGTERM, 1.5 s, SIGKILL, 1.5 s.
const STARTUP_REAP_GRACE: Duration = Duration::from_millis(1_500);

/// How a backend generation ended, for the status line and the crash record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitSummary {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

impl ExitSummary {
    fn from_status(status: Option<ExitStatus>) -> Self {
        let Some(status) = status else {
            return Self {
                code: None,
                signal: None,
            };
        };
        Self {
            code: status.code(),
            signal: signal_name(status),
        }
    }

    fn describe(&self) -> String {
        match (&self.signal, self.code) {
            (Some(signal), _) => format!("signal {signal}"),
            (None, Some(code)) => format!("code {code}"),
            (None, None) => "no exit status".to_string(),
        }
    }
}

#[cfg(unix)]
fn signal_name(status: ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    let number = status.signal()?;
    let known: &[(i32, &str)] = &[
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGINT, "SIGINT"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGILL, "SIGILL"),
        (libc::SIGTRAP, "SIGTRAP"),
        (libc::SIGABRT, "SIGABRT"),
        (libc::SIGBUS, "SIGBUS"),
        (libc::SIGFPE, "SIGFPE"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGSEGV, "SIGSEGV"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGTERM, "SIGTERM"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGUSR2, "SIGUSR2"),
    ];
    Some(
        known
            .iter()
            .find(|(value, _)| *value == number)
            .map(|(_, name)| (*name).to_string())
            .unwrap_or_else(|| format!("signal {number}")),
    )
}

#[cfg(not(unix))]
fn signal_name(_status: ExitStatus) -> Option<String> {
    None
}

/// The `Failed` reason when the restart ladder gave up (Electron's
/// `backend:lifecycle` `failed`; every other `Failed` is its `lost`).
pub const GAVE_UP_REASON: &str =
    "Backend crashed repeatedly; automatic restarts stopped. Restart Videorc to recover.";

/// The backend as the app sees it. `status_text` is the status bar's copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendState {
    Starting {
        generation: u32,
        /// The restart attempt this start is, or none for the first start.
        attempt: Option<u32>,
    },
    Ready {
        generation: u32,
        bootstrap: BackendBootstrap,
    },
    Restarting {
        generation: u32,
        attempt: u32,
        delay: Duration,
        exit: ExitSummary,
    },
    /// Not coming back on its own: the crash budget is spent, or a stale
    /// owned process blocks a replacement. The reason is user-facing.
    Failed {
        generation: u32,
        reason: String,
    },
    Stopping {
        generation: u32,
    },
    Stopped {
        stray_pids: Vec<u32>,
    },
}

/// The status bar's colour cue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Busy,
    Ready,
    Failed,
    Stopped,
}

impl Tone {
    pub fn as_str(self) -> &'static str {
        match self {
            Tone::Busy => "busy",
            Tone::Ready => "ready",
            Tone::Failed => "failed",
            Tone::Stopped => "stopped",
        }
    }
}

impl BackendState {
    pub fn is_ready(&self) -> bool {
        matches!(self, BackendState::Ready { .. })
    }

    pub fn bootstrap(&self) -> Option<&BackendBootstrap> {
        match self {
            BackendState::Ready { bootstrap, .. } => Some(bootstrap),
            _ => None,
        }
    }

    pub fn tone(&self) -> Tone {
        match self {
            BackendState::Starting { .. }
            | BackendState::Restarting { .. }
            | BackendState::Stopping { .. } => Tone::Busy,
            BackendState::Ready { .. } => Tone::Ready,
            BackendState::Failed { .. } => Tone::Failed,
            BackendState::Stopped { stray_pids } if stray_pids.is_empty() => Tone::Stopped,
            BackendState::Stopped { .. } => Tone::Failed,
        }
    }

    /// The status bar line. Plain words, never a lie: a backend that is not
    /// ready is never called ready.
    pub fn status_text(&self) -> String {
        let ladder = RestartPolicy::ladder_len();
        match self {
            BackendState::Starting { attempt: None, .. } => "Starting the backend…".to_string(),
            BackendState::Starting {
                attempt: Some(attempt),
                ..
            } => format!("Restarting the backend (attempt {attempt} of {ladder})…"),
            BackendState::Ready { bootstrap, .. } => format!(
                "Backend ready · pid {} · {}:{}",
                bootstrap.pid, bootstrap.host, bootstrap.port
            ),
            BackendState::Restarting {
                attempt,
                delay,
                exit,
                ..
            } => format!(
                "Backend exited ({}); restarting in {} (attempt {attempt} of {ladder})",
                exit.describe(),
                format_delay(*delay)
            ),
            BackendState::Failed { reason, .. } => reason.clone(),
            BackendState::Stopping { .. } => "Stopping the backend…".to_string(),
            BackendState::Stopped { stray_pids } if stray_pids.is_empty() => {
                "Backend stopped".to_string()
            }
            BackendState::Stopped { stray_pids } => format!(
                "Backend stopped, but pid(s) {} are still running",
                stray_pids
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
}

fn format_delay(delay: Duration) -> String {
    if delay < Duration::from_secs(1) {
        format!("{} ms", delay.as_millis())
    } else {
        let secs = delay.as_secs_f64();
        if secs.fract() == 0.0 {
            format!("{} s", secs as u64)
        } else {
            format!("{secs:.1} s")
        }
    }
}

/// Everything the supervisor needs. The launch is cloned per generation.
pub struct SupervisorConfig {
    pub launch: BackendLaunch,
    pub paths: AppPaths,
    /// Keys the owned-process ledger, as Electron's does.
    pub workspace_root: PathBuf,
    pub logger: Logger,
    pub stop_grace: Duration,
}

/// What `stop` found.
#[derive(Debug, Clone, Default)]
pub struct StopOutcome {
    /// The handshake report, when a backend was running at the time.
    pub report: Option<BackendStopReport>,
    /// Owned PIDs still alive after everything. Must be empty.
    pub stray_pids: Vec<u32>,
}

pub struct Supervisor {
    state: watch::Receiver<BackendState>,
    stop_tx: watch::Sender<bool>,
    restart_tx: mpsc::UnboundedSender<RestartRequest>,
    task: JoinHandle<StopOutcome>,
}

/// One restart asked for, answered when the new generation is spawning (or
/// with the reason it was refused).
struct RestartRequest {
    reason: String,
    reply: oneshot::Sender<Result<(), String>>,
}

/// S2.6b: `restartBackend` (Electron main), for a permission grant: the
/// ready generation is stopped with the shutdown handshake and a fresh one
/// started, which is never counted as a crash. Cloneable, so the permission
/// flow can hold one while `main` keeps the [`Supervisor`] for the quit.
#[derive(Clone)]
pub struct SupervisorRestart {
    tx: mpsc::UnboundedSender<RestartRequest>,
    state: watch::Receiver<BackendState>,
}

/// Electron's refusal when the old backend did not confirm its exit.
pub const RESTART_REFUSED_UNCONFIRMED: &str =
    "Backend restart was refused because shutdown could not be confirmed.";

impl SupervisorRestart {
    /// Restarts the ready backend. Answers once the old generation is gone
    /// and the new one is starting; requests made while one runs share it.
    /// Refused when no backend is ready (there is nothing to restart).
    pub async fn restart(&self, reason: impl Into<String>) -> Result<(), String> {
        if !self.state.borrow().is_ready() {
            return Err("Nothing is running to restart.".to_string());
        }
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(RestartRequest {
                reason: reason.into(),
                reply,
            })
            .map_err(|_| "The supervisor has stopped.".to_string())?;
        answer
            .await
            .map_err(|_| "The supervisor stopped before the restart.".to_string())?
    }

    pub fn state(&self) -> watch::Receiver<BackendState> {
        self.state.clone()
    }
}

impl Supervisor {
    /// Spawns the supervisor task on the current tokio runtime.
    pub fn start(config: SupervisorConfig) -> Self {
        let (state_tx, state_rx) = watch::channel(BackendState::Starting {
            generation: 0,
            attempt: None,
        });
        let (stop_tx, stop_rx) = watch::channel(false);
        let (restart_tx, restart_rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(config, state_tx, stop_rx, restart_rx));
        Self {
            state: state_rx,
            stop_tx,
            restart_tx,
            task,
        }
    }

    /// A receiver that sees every state change.
    pub fn state(&self) -> watch::Receiver<BackendState> {
        self.state.clone()
    }

    /// S2.6b: the handle the permission flow restarts the backend with.
    pub fn restarter(&self) -> SupervisorRestart {
        SupervisorRestart {
            tx: self.restart_tx.clone(),
            state: self.state.clone(),
        }
    }

    pub fn current(&self) -> BackendState {
        self.state.borrow().clone()
    }

    /// Waits until the backend is ready, or fails on a terminal state or
    /// `timeout`.
    pub async fn wait_ready(&self, timeout: Duration) -> Result<BackendBootstrap> {
        let mut state = self.state.clone();
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        loop {
            match &*state.borrow_and_update() {
                BackendState::Ready { bootstrap, .. } => return Ok(bootstrap.clone()),
                BackendState::Failed { reason, .. } => return Err(anyhow!("{reason}")),
                BackendState::Stopped { .. } => return Err(anyhow!("the backend was stopped")),
                _ => {}
            }
            tokio::select! {
                changed = state.changed() => {
                    if changed.is_err() {
                        return Err(anyhow!("the supervisor ended"));
                    }
                }
                _ = &mut deadline => return Err(anyhow!("the backend was not ready within {timeout:?}")),
            }
        }
    }

    /// Stops the backend with the shutdown handshake and waits for the task.
    pub async fn stop(self) -> StopOutcome {
        let _ = self.stop_tx.send(true);
        match self.task.await {
            Ok(outcome) => outcome,
            Err(error) => {
                eprintln!("[backend:error] the supervisor task ended abnormally: {error}");
                StopOutcome::default()
            }
        }
    }
}

async fn wait_stop(stop_rx: &mut watch::Receiver<bool>) {
    while !*stop_rx.borrow_and_update() {
        if stop_rx.changed().await.is_err() {
            return;
        }
    }
}

struct Evidence {
    path: PathBuf,
    records: Vec<CrashRecord>,
}

impl Evidence {
    fn record(&mut self, logger: &Logger, record: CrashRecord) {
        let description = describe_crash_record(&record);
        match append_crash_record(&self.path, record.clone(), &self.records) {
            Ok(records) => {
                self.records = records;
                logger.warn(format!(
                    "Recorded backend crash evidence: {description}; {} stderr line(s) kept in {}.",
                    record.stderr_tail.len(),
                    self.path.display()
                ));
            }
            Err(error) => {
                // Keep the in-memory copy so this launch's bundle still carries it.
                let mut records = vec![record];
                records.append(&mut self.records);
                records.truncate(crate::crash_log::CRASH_LOG_LIMIT);
                self.records = records;
                logger.error(format!(
                    "Could not persist backend crash evidence to {}: {error:#}",
                    self.path.display()
                ));
            }
        }
    }
}

async fn run(
    config: SupervisorConfig,
    state_tx: watch::Sender<BackendState>,
    mut stop_rx: watch::Receiver<bool>,
    mut restart_rx: mpsc::UnboundedReceiver<RestartRequest>,
) -> StopOutcome {
    let logger = config.logger.clone();
    let set = |state: BackendState| {
        let _ = state_tx.send(state);
    };
    let ledger = Arc::new(OwnedProcessLedger::new(
        config.paths.owned_process_ledger(&config.workspace_root),
    ));
    let mut evidence = Evidence {
        path: config.paths.backend_crash_log_file(),
        records: read_crash_log(&config.paths.backend_crash_log_file()),
    };

    // A ledger a crash left unreadable would refuse every record, and with
    // it every cleanup: move it aside and start a fresh one.
    match ledger.recover_corrupt() {
        Ok(Some(aside)) => logger.warn(format!(
            "The owned process ledger {} could not be parsed; moved it to {} and started a fresh one. PIDs it named are not reaped.",
            ledger.path().display(),
            aside.display()
        )),
        Ok(None) => {}
        Err(error) => logger.warn(format!(
            "Could not check the owned process ledger: {error:#}"
        )),
    }

    // Owned processes a dead supervisor left behind (reapStaleBackendProcesses).
    {
        let ledger = ledger.clone();
        let reaped = tokio::task::spawn_blocking(move || {
            ledger.reap_stale(STARTUP_REAP_GRACE, STARTUP_REAP_GRACE)
        })
        .await;
        match reaped {
            Ok(Ok(report)) => {
                if !report.attempted.is_empty() {
                    logger.warn(format!(
                        "Confirmed {} stale owned process record(s) dead after reaping {} live pid(s): {}",
                        report.confirmed_dead.len(),
                        report.attempted.len(),
                        report
                            .attempted
                            .iter()
                            .map(|record| format!("{}:{}", record.label, record.pid))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if !report.identity_mismatches.is_empty() {
                    logger.warn(format!(
                        "Pruned {} stale owned process record(s) whose pid now belongs to a different process without signaling the current occupant: {}",
                        report.identity_mismatches.len(),
                        report
                            .identity_mismatches
                            .iter()
                            .map(|record| format!("{}:{}", record.label, record.pid))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if !report.unconfirmed.is_empty() {
                    let pids = report
                        .unconfirmed
                        .iter()
                        .map(|record| record.pid.to_string())
                        .collect::<Vec<_>>()
                        .join(", ");
                    logger.error(format!(
                        "Refusing backend startup because owned pid(s) {pids} remain live or unprobeable."
                    ));
                    let reason = format!(
                        "An earlier Videorc backend (pid {pids}) is still running and could not be stopped. Quit it, then restart Videorc."
                    );
                    set(BackendState::Failed {
                        generation: 0,
                        reason: reason.clone(),
                    });
                    wait_stop_refusing(&mut stop_rx, &mut restart_rx, &reason).await;
                    set(BackendState::Stopped {
                        stray_pids: report.unconfirmed.iter().map(|record| record.pid).collect(),
                    });
                    return StopOutcome {
                        report: None,
                        stray_pids: report.unconfirmed.iter().map(|record| record.pid).collect(),
                    };
                }
            }
            Ok(Err(error)) => {
                logger.warn(format!(
                    "Could not reap stale owned backend processes: {error:#}"
                ));
            }
            Err(error) => {
                logger.warn(format!(
                    "Could not reap stale owned backend processes: {error}"
                ));
            }
        }
    }

    // Each PID is in the ledger the moment it is known: the spawned child
    // right after spawn, the real backend on OWNERSHIP (Electron's
    // recordBackendOwnedProcess). A failed record ends the generation.
    let recorder: OwnershipRecorder = {
        let ledger = ledger.clone();
        Arc::new(move |pid, label| ledger.record(pid, label))
    };
    let mut policy = RestartPolicy::new();
    let mut generation: u32 = 0;
    let mut attempt: Option<u32> = None;
    loop {
        generation += 1;
        set(BackendState::Starting {
            generation,
            attempt,
        });
        // A restart asked for just as the last generation died: this start
        // is that restart.
        while let Ok(request) = restart_rx.try_recv() {
            let _ = request.reply.send(Ok(()));
        }
        let started_at = Instant::now();
        policy.started(started_at);
        logger.info(format!(
            "Launching backend generation {generation} from {} ({} {})",
            config.launch.cwd.display(),
            config.launch.program.display(),
            config.launch.args.join(" ")
        ));

        let options = SpawnOptions {
            recorder: Some(recorder.clone()),
            // A quit while the backend starts stops it now, not after the
            // ready timeout (Electron's stopPreBootstrapBackendProcess).
            cancel: Some(stop_rx.clone()),
        };
        let process = match BackendProcess::spawn_with(config.launch.clone(), options).await {
            Ok(process) => process,
            Err(startup) => {
                for pid in &startup.reaped_pids {
                    if let Err(error) = ledger.remove(*pid) {
                        logger.warn(format!(
                            "Could not update the owned process ledger: {error:#}"
                        ));
                    }
                }
                if !startup.stray_pids.is_empty() {
                    logger.error(format!(
                        "Owned pid(s) {:?} of generation {generation} survived the kill; they stay in the ledger {}.",
                        startup.stray_pids,
                        ledger.path().display()
                    ));
                }
                if startup.cancelled || *stop_rx.borrow() {
                    logger.info(format!(
                        "Backend generation {generation} stopped before READY: {startup}"
                    ));
                    set(BackendState::Stopped {
                        stray_pids: startup.stray_pids.clone(),
                    });
                    return StopOutcome {
                        report: None,
                        stray_pids: startup.stray_pids,
                    };
                }
                let error = startup;
                logger.error(format!(
                    "Backend generation {generation} exited before READY: {error}"
                ));
                let decision = policy.on_crash(Instant::now());
                let tail: Vec<String> = error.to_string().lines().map(str::to_string).collect();
                evidence.record(
                    &logger,
                    CrashRecord {
                        at: crate::log::iso8601_utc_now(),
                        generation,
                        code: None,
                        signal: None,
                        attempt: Some(decision.attempt()),
                        uptime_ms: started_at.elapsed().as_millis() as u64,
                        intentional: false,
                        windows_status: None,
                        stderr_tail: stderr_tail_for_record(&tail),
                    },
                );
                match handle_decision(
                    decision,
                    generation,
                    ExitSummary {
                        code: None,
                        signal: None,
                    },
                    &logger,
                    &set,
                    &mut stop_rx,
                    &mut restart_rx,
                )
                .await
                {
                    Flow::Restart(next_attempt) => {
                        attempt = Some(next_attempt);
                        continue;
                    }
                    Flow::Stopped(outcome) => return outcome,
                }
            }
        };

        logger.info(format!(
            "Backend generation {generation} spawned as pid {}.",
            process.wrapper_pid()
        ));
        refresh_wrapper_identity(&ledger, &logger, &process);
        let bootstrap = process.bootstrap().clone();
        logger.info(format!(
            "Backend generation {generation} ready: pid {} on {}:{} after {:.2}s.",
            bootstrap.pid,
            bootstrap.host,
            bootstrap.port,
            started_at.elapsed().as_secs_f64()
        ));

        if *stop_rx.borrow() {
            return stop_generation(process, generation, &config, &ledger, &logger, &set, true)
                .await;
        }
        set(BackendState::Ready {
            generation,
            bootstrap,
        });

        let mut process = process;
        let exit = tokio::select! {
            status = process.wait_exit() => status.ok(),
            _ = wait_stop(&mut stop_rx) => {
                return stop_generation(process, generation, &config, &ledger, &logger, &set, true)
                    .await;
            }
            Some(request) = restart_rx.recv() => {
                // S2.6b: a permission grant's restart. Every request waiting
                // now shares this one (Electron's `backendRestartInProgress`).
                let mut replies = vec![request.reply];
                while let Ok(also) = restart_rx.try_recv() {
                    replies.push(also.reply);
                }
                logger.info(&request.reason);
                // Not `Stopped`: a fresh generation follows, and `wait_ready`
                // takes `Stopped` as final.
                let outcome =
                    stop_generation(process, generation, &config, &ledger, &logger, &set, false)
                        .await;
                if !outcome.stray_pids.is_empty() || outcome.report.is_none() {
                    for reply in replies {
                        let _ = reply.send(Err(RESTART_REFUSED_UNCONFIRMED.to_string()));
                    }
                    logger.error(RESTART_REFUSED_UNCONFIRMED);
                    set(BackendState::Failed {
                        generation,
                        reason: RESTART_REFUSED_UNCONFIRMED.to_string(),
                    });
                    wait_stop_refusing(&mut stop_rx, &mut restart_rx, RESTART_REFUSED_UNCONFIRMED)
                        .await;
                    set(BackendState::Stopped {
                        stray_pids: outcome.stray_pids.clone(),
                    });
                    return outcome;
                }
                if *stop_rx.borrow() {
                    for reply in replies {
                        let _ = reply.send(Err("Videorc is quitting.".to_string()));
                    }
                    set(BackendState::Stopped {
                        stray_pids: outcome.stray_pids.clone(),
                    });
                    return outcome;
                }
                for reply in replies {
                    let _ = reply.send(Ok(()));
                }
                // A fresh start, never a crash: the ladder is untouched.
                attempt = None;
                continue;
            }
        };

        // The backend ended on its own.
        let summary = ExitSummary::from_status(exit);
        let uptime = started_at.elapsed();
        let stderr_tail = process.stderr_tail();
        let owned: Vec<u32> = process.owned_pids().collect();
        let reap = process.reap_after_exit(REAP_AFTER_EXIT_DEADLINE).await;
        for pid in &reap.reaped_pids {
            if let Err(error) = ledger.remove(*pid) {
                logger.warn(format!(
                    "Could not update the owned process ledger: {error:#}"
                ));
            }
        }
        if !reap.killed_pids.is_empty() {
            logger.warn(format!(
                "Backend generation {generation} exited while owned pid(s) {} remained live; killed them exactly.",
                reap.killed_pids
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !reap.stray_pids.is_empty() {
            logger.error(format!(
                "Owned pid(s) {} survived the kill after generation {generation} exited; they stay in the ledger {}.",
                reap.stray_pids
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", "),
                ledger.path().display()
            ));
        }
        logger.warn(format!(
            "Backend generation {generation} exited with code {} and signal {} (owned pids {:?})",
            summary
                .code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "null".to_string()),
            summary.signal.as_deref().unwrap_or("null"),
            owned
        ));

        if *stop_rx.borrow() {
            set(BackendState::Stopped {
                stray_pids: reap.stray_pids.clone(),
            });
            return StopOutcome {
                report: None,
                stray_pids: reap.stray_pids,
            };
        }

        let classification = classify_exit(
            false,
            summary.code,
            summary.signal.as_deref(),
            cfg!(windows),
        );
        let decision = policy.on_crash(Instant::now());
        if should_record_exit(classification.cause, summary.code) {
            evidence.record(
                &logger,
                CrashRecord {
                    at: crate::log::iso8601_utc_now(),
                    generation,
                    code: summary.code,
                    signal: summary.signal.clone(),
                    attempt: Some(decision.attempt()),
                    uptime_ms: uptime.as_millis() as u64,
                    intentional: classification.intentional,
                    windows_status: classification.windows_status,
                    stderr_tail: stderr_tail_for_record(&stderr_tail),
                },
            );
        }
        match handle_decision(
            decision,
            generation,
            summary,
            &logger,
            &set,
            &mut stop_rx,
            &mut restart_rx,
        )
        .await
        {
            Flow::Restart(next_attempt) => attempt = Some(next_attempt),
            Flow::Stopped(outcome) => return outcome,
        }
    }
}

#[allow(clippy::large_enum_variant)] // one per backend exit; not worth a Box
enum Flow {
    Restart(u32),
    Stopped(StopOutcome),
}

#[allow(clippy::too_many_arguments)]
async fn handle_decision(
    decision: RestartDecision,
    generation: u32,
    exit: ExitSummary,
    logger: &Logger,
    set: &impl Fn(BackendState),
    stop_rx: &mut watch::Receiver<bool>,
    restart_rx: &mut mpsc::UnboundedReceiver<RestartRequest>,
) -> Flow {
    match decision {
        RestartDecision::Restart { attempt, delay } => {
            logger.warn(format!(
                "Restarting backend in {}ms (attempt {attempt}/{}).",
                delay.as_millis(),
                RestartPolicy::ladder_len()
            ));
            set(BackendState::Restarting {
                generation,
                attempt,
                delay,
                exit,
            });
            tokio::select! {
                _ = tokio::time::sleep(delay) => Flow::Restart(attempt),
                _ = wait_stop(stop_rx) => {
                    set(BackendState::Stopped { stray_pids: Vec::new() });
                    Flow::Stopped(StopOutcome::default())
                }
            }
        }
        RestartDecision::GiveUp { .. } => {
            let reason = GAVE_UP_REASON.to_string();
            logger.error(&reason);
            set(BackendState::Failed {
                generation,
                reason: reason.clone(),
            });
            wait_stop_refusing(stop_rx, restart_rx, &reason).await;
            set(BackendState::Stopped {
                stray_pids: Vec::new(),
            });
            Flow::Stopped(StopOutcome::default())
        }
    }
}

/// The rustup proxy execs the toolchain cargo after spawn; READY is late
/// enough to re-stamp the wrapper's recorded path (refreshIdentity).
fn refresh_wrapper_identity(
    ledger: &OwnedProcessLedger,
    logger: &Logger,
    process: &BackendProcess,
) {
    let wrapper = process.wrapper_pid();
    match ledger.refresh_identity(wrapper) {
        Ok(true) => logger.info(format!(
            "Refreshed the recorded executable path of owned process {wrapper}."
        )),
        Ok(false) => {}
        Err(error) => logger.warn(format!(
            "Could not refresh owned process {wrapper}: {error:#}"
        )),
    }
}

/// Waits for the quit while no backend will come back on its own (the
/// restart budget is spent, or a stale or unconfirmed process blocks one),
/// refusing every restart asked for meanwhile, so none waits until the quit.
async fn wait_stop_refusing(
    stop_rx: &mut watch::Receiver<bool>,
    restart_rx: &mut mpsc::UnboundedReceiver<RestartRequest>,
    reason: &str,
) {
    loop {
        tokio::select! {
            _ = wait_stop(stop_rx) => return,
            request = restart_rx.recv() => match request {
                Some(request) => {
                    let _ = request.reply.send(Err(reason.to_string()));
                }
                None => {
                    wait_stop(stop_rx).await;
                    return;
                }
            },
        }
    }
}

/// Stops one generation with the shutdown handshake. `final_stop`: the app
/// is quitting, so `Stopped` is published; a restart publishes nothing after
/// `Stopping`, since the next generation's `Starting` follows.
async fn stop_generation(
    process: BackendProcess,
    generation: u32,
    config: &SupervisorConfig,
    ledger: &OwnedProcessLedger,
    logger: &Logger,
    set: &impl Fn(BackendState),
    final_stop: bool,
) -> StopOutcome {
    set(BackendState::Stopping { generation });
    logger.info(format!(
        "Stopping backend generation {generation}: shutdown preparation, then signals, then an exact liveness check."
    ));
    let owned: Vec<u32> = process.owned_pids().collect();
    let report = match process.stop(config.stop_grace).await {
        Ok(report) => report,
        Err(error) => {
            logger.error(format!(
                "Backend generation {generation} stop failed: {error:#}"
            ));
            if final_stop {
                set(BackendState::Stopped {
                    stray_pids: owned.clone(),
                });
            }
            return StopOutcome {
                report: None,
                stray_pids: owned,
            };
        }
    };
    if let Some(error) = &report.preparation_error {
        logger.warn(format!(
            "Backend generation {generation} shutdown preparation: {error}"
        ));
    }
    for pid in &report.reaped_pids {
        if let Err(error) = ledger.remove(*pid) {
            logger.warn(format!(
                "Could not update the owned process ledger: {error:#}"
            ));
        }
    }
    if report.stray_pids.is_empty() {
        logger.info(format!(
            "Backend generation {generation} stopped ({}{}); owned pids {:?} confirmed gone.",
            report
                .exit_status
                .map(|status| status.to_string())
                .unwrap_or_else(|| "no exit status".to_string()),
            if report.forced { ", forced" } else { "" },
            report.reaped_pids
        ));
    } else {
        logger.error(format!(
            "Backend generation {generation} stop left pid(s) {:?} alive; they stay in the ledger {}.",
            report.stray_pids,
            ledger.path().display()
        ));
    }
    let stray_pids = report.stray_pids.clone();
    if final_stop {
        set(BackendState::Stopped {
            stray_pids: stray_pids.clone(),
        });
    }
    StopOutcome {
        report: Some(report),
        stray_pids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bootstrap() -> BackendBootstrap {
        BackendBootstrap {
            host: "127.0.0.1".to_string(),
            port: 50123,
            token: "t".to_string(),
            admin_token: "a".to_string(),
            pid: 4242,
            parent_pid: None,
            managed_asset_roots: None,
        }
    }

    #[tokio::test]
    async fn a_restart_asked_for_while_nothing_will_come_back_is_refused_not_left_waiting() {
        let (stop_tx, mut stop_rx) = watch::channel(false);
        let (restart_tx, mut restart_rx) = mpsc::unbounded_channel();
        // Queued just as the backend died, before the budget ran out.
        let (reply, early) = oneshot::channel();
        restart_tx
            .send(RestartRequest {
                reason: "camera granted".to_string(),
                reply,
            })
            .unwrap();
        let waiting = tokio::spawn(async move {
            wait_stop_refusing(&mut stop_rx, &mut restart_rx, GAVE_UP_REASON).await;
        });
        assert_eq!(early.await.unwrap(), Err(GAVE_UP_REASON.to_string()));
        // And one asked for later.
        let (reply, late) = oneshot::channel();
        restart_tx
            .send(RestartRequest {
                reason: "microphone granted".to_string(),
                reply,
            })
            .unwrap();
        assert_eq!(late.await.unwrap(), Err(GAVE_UP_REASON.to_string()));
        stop_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn status_text_names_every_state_honestly() {
        assert_eq!(
            BackendState::Starting {
                generation: 1,
                attempt: None
            }
            .status_text(),
            "Starting the backend…"
        );
        assert_eq!(
            BackendState::Starting {
                generation: 2,
                attempt: Some(1)
            }
            .status_text(),
            "Restarting the backend (attempt 1 of 5)…"
        );
        let ready = BackendState::Ready {
            generation: 1,
            bootstrap: bootstrap(),
        };
        assert_eq!(
            ready.status_text(),
            "Backend ready · pid 4242 · 127.0.0.1:50123"
        );
        assert!(ready.is_ready());
        assert_eq!(ready.tone(), Tone::Ready);
        let restarting = BackendState::Restarting {
            generation: 1,
            attempt: 2,
            delay: Duration::from_millis(1000),
            exit: ExitSummary {
                code: None,
                signal: Some("SIGKILL".to_string()),
            },
        };
        assert_eq!(
            restarting.status_text(),
            "Backend exited (signal SIGKILL); restarting in 1 s (attempt 2 of 5)"
        );
        assert_eq!(restarting.tone(), Tone::Busy);
        assert_eq!(format_delay(Duration::from_millis(500)), "500 ms");
        assert_eq!(format_delay(Duration::from_millis(1500)), "1.5 s");
        assert_eq!(
            BackendState::Stopped {
                stray_pids: vec![7, 8]
            }
            .status_text(),
            "Backend stopped, but pid(s) 7, 8 are still running"
        );
        assert_eq!(
            BackendState::Stopped { stray_pids: vec![] }.tone(),
            Tone::Stopped
        );
        assert_eq!(
            BackendState::Failed {
                generation: 3,
                reason: "x".to_string()
            }
            .tone(),
            Tone::Failed
        );
    }
}
