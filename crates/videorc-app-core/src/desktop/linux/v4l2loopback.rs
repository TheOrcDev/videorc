//! Videorc Camera on Linux: loading v4l2loopback (plan 214 D1), from
//! `main/virtual-camera-linux-setup.ts`.
//!
//! The backend detects the module (installed, loaded, the device by name)
//! and reports `needs-setup` with the distribution's install command; the
//! one step that needs the desktop session is polkit's password dialog. The
//! app runs `pkexec modprobe …` with an argv array, never a shell string
//! (`apps/videorc/src/platform/linux/v4l2loopback.rs`), and this module turns
//! the run into a plain result the Output page shows: loaded, cancelled, not
//! installed, Secure Boot refused it, or what modprobe said. The backend's
//! next probe (within a second) settles the status. No kernel module is
//! bundled, built or signed (D9).

use std::time::Duration;

pub const MODULE: &str = "v4l2loopback";
/// `card_label`, shared with the backend's `VIRTUAL_CAMERA_LINUX_CARD_LABEL`.
pub const CARD_LABEL: &str = "Videorc Camera";
/// `video_nr`, shared with the backend's `VIRTUAL_CAMERA_LINUX_VIDEO_NR`.
pub const VIDEO_NR: u32 = 42;
pub const PKEXEC: &str = "pkexec";
/// polkit's dialog waits for the person; two minutes is plenty.
pub const TIMEOUT: Duration = Duration::from_secs(120);
/// The longest stderr line a message carries.
pub const STDERR_DETAIL_MAX: usize = 300;

/// `LOAD_MODULE_ARGS`: `modprobe`'s argv, one array. kmod quotes a value
/// with a space on its own, so `card_label=Videorc Camera` reaches the
/// kernel as `card_label="Videorc Camera"`.
pub fn load_args() -> Vec<String> {
    vec![
        "modprobe".into(),
        MODULE.into(),
        "exclusive_caps=1".into(),
        format!("card_label={CARD_LABEL}"),
        format!("video_nr={VIDEO_NR}"),
    ]
}

/// `LOAD_MODULE_TERMINAL_LINE`: the same load as a terminal line, for the
/// fallback copy.
pub fn terminal_line() -> String {
    format!(
        "sudo modprobe {MODULE} exclusive_caps=1 card_label=\"{CARD_LABEL}\" video_nr={VIDEO_NR}"
    )
}

/// `LinuxLoadModuleOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Loaded,
    /// The person dismissed polkit's dialog (pkexec exits 126).
    Cancelled,
    /// polkit refused: no admin, a wrong password three times, or no agent (127).
    NotAuthorized,
    /// modprobe found no module for this kernel: install the package first.
    NotInstalled,
    /// The kernel refused the unsigned module under Secure Boot or lockdown.
    SecureBoot,
    /// No `pkexec` on this box.
    NoPkexec,
    TimedOut,
    NotLinux,
    Failed,
}

/// `LinuxLoadModuleResult`: `message` is the Output page's error line when
/// the load did not happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadResult {
    pub outcome: Outcome,
    pub message: Option<String>,
}

impl LoadResult {
    pub fn ok(&self) -> bool {
        self.outcome == Outcome::Loaded
    }

    fn refused(outcome: Outcome, message: String) -> Self {
        Self {
            outcome,
            message: Some(message),
        }
    }

    /// Off Linux the load never runs.
    pub fn not_linux() -> Self {
        Self::refused(
            Outcome::NotLinux,
            "Videorc Camera's module load runs on Linux only.".into(),
        )
    }
}

/// `LoadModuleRun`: what one `pkexec modprobe` run came back with.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Run {
    /// The spawn failed: `NotFound` (no pkexec) or the error's words.
    pub spawn_error: Option<SpawnError>,
    pub exit_code: Option<i32>,
    /// The signal's name when a signal ended it (`SIGKILL`).
    pub signal: Option<String>,
    /// The runner killed it at [`TIMEOUT`].
    pub timed_out: bool,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnError {
    NotFound,
    Other(String),
}

/// The last non-empty stderr line (what modprobe or pkexec said), capped.
fn last_line(stderr: &str) -> String {
    let line = stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("");
    if line.chars().count() > STDERR_DETAIL_MAX {
        let cut: String = line.chars().take(STDERR_DETAIL_MAX - 1).collect();
        format!("{cut}…")
    } else {
        line.to_string()
    }
}

/// `classifyLoadModuleRun`: one run's outcome and the words for it.
pub fn classify(run: &Run) -> LoadResult {
    let line = terminal_line();
    match &run.spawn_error {
        Some(SpawnError::NotFound) => {
            return LoadResult::refused(
                Outcome::NoPkexec,
                format!(
                    "pkexec (polkit) isn't installed, so Videorc can't ask for your password. In a terminal: {line}"
                ),
            );
        }
        Some(SpawnError::Other(code)) => {
            return LoadResult::refused(
                Outcome::Failed,
                format!("Videorc couldn't run pkexec ({code}). In a terminal: {line}"),
            );
        }
        None => {}
    }
    if run.timed_out {
        return LoadResult::refused(
            Outcome::TimedOut,
            "The password dialog timed out. Choose Load module to try again.".into(),
        );
    }
    if run.exit_code == Some(0) {
        return LoadResult {
            outcome: Outcome::Loaded,
            message: None,
        };
    }
    let stderr = run.stderr.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| stderr.contains(needle));
    if has(&[
        "not found in directory",
        "module v4l2loopback not found",
        "could not resolve",
    ]) {
        return LoadResult::refused(
            Outcome::NotInstalled,
            "v4l2loopback is not installed for this kernel. Install it with the command above, then choose Load module.".into(),
        );
    }
    if has(&[
        "key was rejected",
        "required key not available",
        "lockdown",
        "secure boot",
    ]) {
        return LoadResult::refused(
            Outcome::SecureBoot,
            "Secure Boot refused the unsigned v4l2loopback module. Sign it with your Machine Owner Key (MOK) or turn Secure Boot off in firmware, then choose Load module.".into(),
        );
    }
    if run.exit_code == Some(126) {
        return LoadResult::refused(
            Outcome::Cancelled,
            "Loading was cancelled. Choose Load module to try again.".into(),
        );
    }
    if run.exit_code == Some(127) {
        return LoadResult::refused(
            Outcome::NotAuthorized,
            format!(
                "Linux didn't authorize the load (an administrator's password is needed). In a terminal: {line}"
            ),
        );
    }
    if let Some(signal) = &run.signal {
        return LoadResult::refused(
            Outcome::Failed,
            format!("pkexec ended by {signal}. Choose Load module to try again."),
        );
    }
    let detail = last_line(&run.stderr);
    LoadResult::refused(
        Outcome::Failed,
        if detail.is_empty() {
            let code = run
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "no code".into());
            format!("modprobe exited with {code}. In a terminal: {line}")
        } else {
            format!("modprobe failed: {detail}")
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exited(code: i32, stderr: &str) -> Run {
        Run {
            exit_code: Some(code),
            stderr: stderr.into(),
            ..Run::default()
        }
    }

    #[test]
    fn the_argv_is_one_array_with_the_card_label_unquoted() {
        assert_eq!(
            load_args(),
            [
                "modprobe",
                "v4l2loopback",
                "exclusive_caps=1",
                "card_label=Videorc Camera",
                "video_nr=42"
            ]
        );
        assert_eq!(
            terminal_line(),
            "sudo modprobe v4l2loopback exclusive_caps=1 card_label=\"Videorc Camera\" video_nr=42"
        );
    }

    #[test]
    fn each_run_reads_as_electron_says_it() {
        assert!(classify(&exited(0, "")).ok());
        let outcome = |run: Run| classify(&run).outcome;
        assert_eq!(
            outcome(Run {
                spawn_error: Some(SpawnError::NotFound),
                ..Run::default()
            }),
            Outcome::NoPkexec
        );
        assert_eq!(
            outcome(Run {
                timed_out: true,
                ..Run::default()
            }),
            Outcome::TimedOut
        );
        assert_eq!(
            outcome(exited(
                1,
                "modprobe: FATAL: Module v4l2loopback not found in directory /lib/modules/6.8"
            )),
            Outcome::NotInstalled
        );
        assert_eq!(
            outcome(exited(
                1,
                "modprobe: ERROR: could not insert 'v4l2loopback': Key was rejected by service"
            )),
            Outcome::SecureBoot
        );
        assert_eq!(outcome(exited(126, "")), Outcome::Cancelled);
        assert_eq!(outcome(exited(127, "")), Outcome::NotAuthorized);
        assert_eq!(
            classify(&exited(1, "first\n  modprobe: ERROR: busy  \n\n")).message,
            Some("modprobe failed: modprobe: ERROR: busy".into())
        );
        assert!(
            classify(&exited(3, ""))
                .message
                .unwrap()
                .starts_with("modprobe exited with 3. In a terminal: sudo modprobe")
        );
    }

    #[test]
    fn a_long_stderr_line_is_capped() {
        let long = "x".repeat(400);
        let message = classify(&exited(1, &long)).message.unwrap();
        let detail = message.strip_prefix("modprobe failed: ").unwrap();
        assert_eq!(detail.chars().count(), STDERR_DETAIL_MAX);
        assert!(detail.ends_with('…'));
    }
}
