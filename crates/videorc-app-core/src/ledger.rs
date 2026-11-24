//! The durable owned-process ledger (`backend-owned-processes.ts`): every
//! PID this app spawned or the backend reported, with the process's exact
//! identity (kernel start time and executable path), in
//! `userData/owned-processes/rust-<workspace key>.json`.
//!
//! On the next launch, a record left behind by a supervisor that died is
//! reaped only when the PID still carries the recorded identity; a PID that
//! now belongs to another process is pruned without a signal; a PID that
//! cannot be probed stays in the ledger and blocks a replacement backend
//! (Electron refuses startup the same way). Nothing here scans the process
//! table: every probe names one exact PID.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::process::{Signal, process_is_alive, signal_pids};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    /// The kernel's start time for the PID, as the platform prints it.
    pub birth_token: String,
    pub executable_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedProcessRecord {
    pub pid: u32,
    pub label: String,
    /// ISO 8601 UTC.
    pub started_at: String,
    /// Missing only on ledgers written before identity-safe reaping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<ProcessIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeResult {
    Dead,
    Live(ProcessIdentity),
    Unprobeable,
}

/// What a startup reap found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReapReport {
    /// Live records with a matching identity that were signalled.
    pub attempted: Vec<OwnedProcessRecord>,
    pub confirmed_dead: Vec<OwnedProcessRecord>,
    /// PIDs that now belong to another process: pruned, never signalled.
    pub identity_mismatches: Vec<OwnedProcessRecord>,
    /// Still live or unprobeable after the deadline: kept, and they block a
    /// replacement backend.
    pub unconfirmed: Vec<OwnedProcessRecord>,
}

pub struct OwnedProcessLedger {
    path: PathBuf,
    current_pid: u32,
}

impl OwnedProcessLedger {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            current_pid: std::process::id(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Records a live PID with its identity. Fails when the process is
    /// already dead or its identity cannot be read (after three tries), so
    /// the caller knows the ledger does not cover it.
    pub fn record(&self, pid: u32, label: &str) -> Result<()> {
        if pid <= 1 || pid == self.current_pid {
            return Ok(());
        }
        let mut probe = probe_process(pid);
        for _ in 0..2 {
            if probe != ProbeResult::Unprobeable {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
            probe = probe_process(pid);
        }
        let identity = match probe {
            ProbeResult::Live(identity) => identity,
            ProbeResult::Dead => {
                bail!("could not record {label} process {pid}: it is already dead")
            }
            ProbeResult::Unprobeable => {
                bail!(
                    "could not record {label} process {pid}: exact process identity is unavailable"
                )
            }
        };
        let mut records: Vec<OwnedProcessRecord> = self
            .read()?
            .into_iter()
            .filter(|record| record.pid != pid)
            .collect();
        records.push(OwnedProcessRecord {
            pid,
            label: label.to_string(),
            started_at: crate::log::iso8601_utc_now(),
            identity: Some(identity),
        });
        self.write(&records)
    }

    /// Re-stamps a record whose executable path changed after `exec` (the
    /// rustup proxy becomes the toolchain cargo). The birth token must match;
    /// anything else means the PID was reused and the record stays.
    pub fn refresh_identity(&self, pid: u32) -> Result<bool> {
        let records = self.read()?;
        let Some(record) = records.iter().find(|record| record.pid == pid) else {
            return Ok(false);
        };
        let ProbeResult::Live(identity) = probe_process(pid) else {
            return Ok(false);
        };
        let Some(recorded) = &record.identity else {
            return Ok(false);
        };
        if recorded.birth_token != identity.birth_token || *recorded == identity {
            return Ok(false);
        }
        let updated: Vec<OwnedProcessRecord> = records
            .into_iter()
            .map(|mut record| {
                if record.pid == pid {
                    record.identity = Some(identity.clone());
                }
                record
            })
            .collect();
        self.write(&updated)?;
        Ok(true)
    }

    pub fn remove(&self, pid: u32) -> Result<()> {
        let records: Vec<OwnedProcessRecord> = self
            .read()?
            .into_iter()
            .filter(|record| record.pid != pid)
            .collect();
        self.write(&records)
    }

    pub fn records(&self) -> Result<Vec<OwnedProcessRecord>> {
        self.read()
    }

    /// Reaps what a dead supervisor left behind: SIGTERM, `kill_grace`,
    /// SIGKILL, `confirm_timeout` (Electron: 1.5 s each; Windows collapses
    /// into one hard kill). Only identity-matched PIDs are signalled.
    pub fn reap_stale(
        &self,
        kill_grace: Duration,
        confirm_timeout: Duration,
    ) -> Result<ReapReport> {
        let stale: Vec<OwnedProcessRecord> = dedupe(
            self.read()?
                .into_iter()
                .filter(|record| record.pid > 1 && record.pid != self.current_pid)
                .collect(),
        );
        let mut report = ReapReport::default();
        if stale.is_empty() {
            return Ok(report);
        }
        let mut dead = Vec::new();
        let mut mismatched = Vec::new();
        let mut unprobeable = Vec::new();
        let mut matching = classify(&stale, &mut dead, &mut mismatched, &mut unprobeable);
        report.attempted = matching.clone();
        if cfg!(windows) {
            signal_pids(matching.iter().map(|record| record.pid), Signal::Kill);
            matching = wait_for_exit(
                matching,
                confirm_timeout,
                &mut dead,
                &mut mismatched,
                &mut unprobeable,
            );
        } else {
            signal_pids(matching.iter().map(|record| record.pid), Signal::Terminate);
            matching = wait_for_exit(
                matching,
                kill_grace,
                &mut dead,
                &mut mismatched,
                &mut unprobeable,
            );
            signal_pids(matching.iter().map(|record| record.pid), Signal::Kill);
            matching = wait_for_exit(
                matching,
                confirm_timeout,
                &mut dead,
                &mut mismatched,
                &mut unprobeable,
            );
        }
        report.confirmed_dead = dead;
        report.identity_mismatches = mismatched;
        report.unconfirmed = unprobeable.into_iter().chain(matching).collect();
        // Retain evidence unless the process is confirmed dead or the PID is
        // confirmed to belong to someone else.
        self.write(&report.unconfirmed)?;
        Ok(report)
    }

    fn read(&self) -> Result<Vec<OwnedProcessRecord>> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "could not read the owned process ledger {}",
                        self.path.display()
                    )
                });
            }
        };
        let records: Vec<OwnedProcessRecord> = serde_json::from_str(&text).with_context(|| {
            format!(
                "could not parse the owned process ledger {}",
                self.path.display()
            )
        })?;
        Ok(dedupe(records))
    }

    fn write(&self, records: &[OwnedProcessRecord]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }
        let text = serde_json::to_string_pretty(records)?;
        std::fs::write(&self.path, format!("{text}\n"))
            .with_context(|| format!("could not write {}", self.path.display()))
    }
}

fn dedupe(records: Vec<OwnedProcessRecord>) -> Vec<OwnedProcessRecord> {
    let mut seen = std::collections::BTreeSet::new();
    records
        .into_iter()
        .filter(|record| seen.insert(record.pid))
        .collect()
}

fn classify(
    records: &[OwnedProcessRecord],
    dead: &mut Vec<OwnedProcessRecord>,
    mismatched: &mut Vec<OwnedProcessRecord>,
    unprobeable: &mut Vec<OwnedProcessRecord>,
) -> Vec<OwnedProcessRecord> {
    let mut matching = Vec::new();
    for record in records {
        match probe_process(record.pid) {
            ProbeResult::Dead => dead.push(record.clone()),
            ProbeResult::Unprobeable => unprobeable.push(record.clone()),
            ProbeResult::Live(identity) => match &record.identity {
                None => unprobeable.push(record.clone()),
                Some(recorded) if *recorded != identity => mismatched.push(record.clone()),
                Some(_) => matching.push(record.clone()),
            },
        }
    }
    matching
}

fn wait_for_exit(
    records: Vec<OwnedProcessRecord>,
    timeout: Duration,
    dead: &mut Vec<OwnedProcessRecord>,
    mismatched: &mut Vec<OwnedProcessRecord>,
    unprobeable: &mut Vec<OwnedProcessRecord>,
) -> Vec<OwnedProcessRecord> {
    let deadline = Instant::now() + timeout;
    let mut remaining = classify(&records, dead, mismatched, unprobeable);
    while !remaining.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
        remaining = classify(&remaining, dead, mismatched, unprobeable);
    }
    remaining
}

/// What the platform said about one PID before liveness is re-checked.
enum RawProbe {
    Live(ProcessIdentity),
    /// Answers `kill(pid, 0)` until its parent waits on it, but can never run
    /// again: dead for every purpose here. Windows has no zombies.
    #[cfg_attr(windows, allow(dead_code))]
    Zombie,
    Unreadable,
}

/// Exact identity of one PID, or dead, or unprobeable.
pub fn probe_process(pid: u32) -> ProbeResult {
    if !process_is_alive(pid) {
        return ProbeResult::Dead;
    }
    match probe_identity(pid) {
        RawProbe::Live(identity) => ProbeResult::Live(identity),
        RawProbe::Zombie => ProbeResult::Dead,
        RawProbe::Unreadable if process_is_alive(pid) => ProbeResult::Unprobeable,
        RawProbe::Unreadable => ProbeResult::Dead,
    }
}

#[cfg(target_os = "linux")]
fn probe_identity(pid: u32) -> RawProbe {
    for _ in 0..2 {
        let Ok(stat_before) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return RawProbe::Unreadable;
        };
        if linux_stat_state(&stat_before) == Some("Z") {
            return RawProbe::Zombie;
        }
        let Some(before) = linux_birth_token(&stat_before) else {
            return RawProbe::Unreadable;
        };
        let executable_path = match std::fs::read_link(format!("/proc/{pid}/exe")) {
            Ok(path) => path,
            // S4.2a (ogre): for about a millisecond after a signal the process
            // still reads `R` in stat while `/proc/<pid>/exe` is already gone,
            // before it turns `Z`. The first look the reaper takes after the
            // signal landed in that window and dropped the record as
            // unprobeable. A process without its image can never run again:
            // dead for every purpose here, like a zombie. Any other error (a
            // foreign process after PID reuse: EACCES) stays unreadable.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return RawProbe::Zombie;
            }
            Err(_) => return RawProbe::Unreadable,
        };
        let executable_path = executable_path.to_string_lossy().into_owned();
        let after = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| linux_birth_token(&stat));
        if after.as_deref() == Some(before.as_str()) && !executable_path.is_empty() {
            return RawProbe::Live(ProcessIdentity {
                birth_token: before,
                executable_path,
            });
        }
    }
    RawProbe::Unreadable
}

#[cfg(target_os = "linux")]
fn linux_stat_fields(stat: &str) -> Option<Vec<&str>> {
    let end = stat.rfind(')')?;
    Some(stat[end + 1..].split_whitespace().collect())
}

/// The process state letter (stat field 3): R, S, D, Z, T, X, …
#[cfg(target_os = "linux")]
fn linux_stat_state(stat: &str) -> Option<&str> {
    linux_stat_fields(stat)?.first().copied()
}

/// `starttime` (stat field 22): clock ticks after boot.
#[cfg(target_os = "linux")]
fn linux_birth_token(stat: &str) -> Option<String> {
    linux_stat_fields(stat)?
        .get(19)
        .map(|token| token.to_string())
}

#[cfg(target_os = "macos")]
fn probe_identity(pid: u32) -> RawProbe {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args([
            "-p",
            &pid.to_string(),
            "-o",
            "stat=",
            "-o",
            "lstart=",
            "-o",
            "comm=",
        ])
        .stdin(std::process::Stdio::null())
        .output()
    else {
        return RawProbe::Unreadable;
    };
    if !output.status.success() {
        return RawProbe::Unreadable;
    }
    parse_darwin_ps(String::from_utf8_lossy(&output.stdout).trim())
}

/// `stat` is one token (`Z` first for a zombie), `lstart` a fixed
/// 24-character date, and `comm` follows after whitespace.
#[cfg(any(test, target_os = "macos"))]
fn parse_darwin_ps(line: &str) -> RawProbe {
    let Some((stat, rest)) = line.trim_start().split_once(char::is_whitespace) else {
        return RawProbe::Unreadable;
    };
    if stat.starts_with('Z') {
        return RawProbe::Zombie;
    }
    let rest = rest.trim_start();
    if rest.chars().count() <= 25 {
        return RawProbe::Unreadable;
    }
    let Some(split) = rest.char_indices().nth(24).map(|(index, _)| index) else {
        return RawProbe::Unreadable;
    };
    let (birth, comm) = rest.split_at(split);
    let executable_path = comm.trim();
    if birth.trim().is_empty() || executable_path.is_empty() {
        return RawProbe::Unreadable;
    }
    RawProbe::Live(ProcessIdentity {
        birth_token: birth.to_string(),
        executable_path: executable_path.to_string(),
    })
}

#[cfg(windows)]
fn probe_identity(pid: u32) -> RawProbe {
    let script = format!(
        "$target = Get-Process -Id {pid} -ErrorAction Stop; $identity = [PSCustomObject]@{{ birthToken = $target.StartTime.ToUniversalTime().Ticks.ToString(); executablePath = $target.Path }}; $identity | ConvertTo-Json -Compress"
    );
    for powershell in windows_powershell_executables() {
        let Ok(output) = std::process::Command::new(&powershell)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ])
            .stdin(std::process::Stdio::null())
            .output()
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        if let Ok(identity) =
            serde_json::from_str::<ProcessIdentity>(String::from_utf8_lossy(&output.stdout).trim())
            && !identity.birth_token.is_empty()
            && !identity.executable_path.is_empty()
        {
            return RawProbe::Live(identity);
        }
    }
    RawProbe::Unreadable
}

/// The legacy Windows PowerShell first (locked-down endpoints may ship only
/// one host), then whatever is on `PATH`.
#[cfg(windows)]
fn windows_powershell_executables() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = std::env::var_os("SystemRoot") {
        candidates.push(
            PathBuf::from(root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        );
    }
    candidates.push(PathBuf::from("powershell.exe"));
    candidates.push(PathBuf::from("pwsh.exe"));
    candidates
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn probe_identity(_pid: u32) -> RawProbe {
    RawProbe::Unreadable
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn darwin_ps_line_splits_at_the_fixed_date_width() {
        let RawProbe::Live(identity) =
            parse_darwin_ps("Ss   Sat Nov  8 12:00:01 2026 /Users/me/target/debug/videorc-backend")
        else {
            panic!("expected a live identity");
        };
        assert_eq!(identity.birth_token, "Sat Nov  8 12:00:01 2026");
        assert_eq!(
            identity.executable_path,
            "/Users/me/target/debug/videorc-backend"
        );
        assert!(matches!(
            parse_darwin_ps("Z    Sat Nov  8 12:00:01 2026 (sleep)"),
            RawProbe::Zombie
        ));
        assert!(matches!(parse_darwin_ps(""), RawProbe::Unreadable));
        assert!(matches!(
            parse_darwin_ps("S+   Sat Nov  8 12:00:01 2026"),
            RawProbe::Unreadable
        ));
    }

    #[test]
    fn this_process_probes_live_and_records_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let ledger =
            OwnedProcessLedger::new(dir.path().join("owned-processes").join("rust-x.json"));
        // Our own PID is never recorded.
        ledger.record(std::process::id(), "self").unwrap();
        assert!(ledger.records().unwrap().is_empty());

        // A child we own: `sleep` is alive long enough to probe.
        let mut child = std::process::Command::new(if cfg!(windows) { "timeout" } else { "sleep" })
            .arg("30")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        match probe_process(pid) {
            ProbeResult::Live(identity) => {
                assert!(!identity.birth_token.is_empty());
                assert!(!identity.executable_path.is_empty());
            }
            other => panic!("expected the child to be live and probeable, got {other:?}"),
        }
        ledger.record(pid, "sleep").unwrap();
        let records = ledger.records().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].pid, pid);
        assert!(records[0].identity.is_some());
        let text = std::fs::read_to_string(ledger.path()).unwrap();
        assert!(text.contains("\"birthToken\""));

        // A reap on the next "launch" signals exactly that PID and confirms it dead.
        let report = ledger
            .reap_stale(Duration::from_millis(1500), Duration::from_millis(1500))
            .unwrap();
        assert_eq!(
            report.attempted.len(),
            1,
            "recorded {records:?}, reap {report:?}"
        );
        // Our child is a zombie until `wait`; a zombie counts as dead.
        assert_eq!(report.confirmed_dead.len(), 1, "reap {report:?}");
        assert!(report.unconfirmed.is_empty());
        assert!(ledger.records().unwrap().is_empty());
        let _ = child.wait();

        // A dead PID is refused at record time, and a reused one is pruned.
        assert!(ledger.record(pid, "sleep").is_err());
    }

    #[test]
    fn identity_mismatch_is_pruned_without_a_signal() {
        let dir = tempfile::tempdir().unwrap();
        let ledger = OwnedProcessLedger::new(dir.path().join("rust-x.json"));
        let mut child = std::process::Command::new(if cfg!(windows) { "timeout" } else { "sleep" })
            .arg("30")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        ledger
            .write(&[OwnedProcessRecord {
                pid,
                label: "ghost".to_string(),
                started_at: "t".to_string(),
                identity: Some(ProcessIdentity {
                    birth_token: "someone else".to_string(),
                    executable_path: "/nowhere".to_string(),
                }),
            }])
            .unwrap();
        let report = ledger
            .reap_stale(Duration::from_millis(100), Duration::from_millis(100))
            .unwrap();
        assert_eq!(report.identity_mismatches.len(), 1);
        assert!(report.attempted.is_empty());
        assert!(process_is_alive(pid), "a mismatched PID is never signalled");
        assert!(ledger.records().unwrap().is_empty());
        let _ = child.kill();
        let _ = child.wait();
    }
}
