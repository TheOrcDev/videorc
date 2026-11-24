//! The Cloud tab's local program archive (plan 260 S1.6f, from Electron's
//! `components/tabs/library-cloud-archive.tsx`): a local copy of the cloud
//! show's program, fed by cloud egress over this computer's network. It is
//! enabled before cloud Record starts and is bounded per enablement.
//!
//! The section reads `cloud.archive.status` every 2 s while it shows. It
//! asks `cloud.archive.availability` for the open cloud room's show, and
//! acts by name through [`LibraryBackend`].

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::LibraryBackend;
use crate::client::RpcError;

pub const TITLE: &str = "Local program archive";
pub const DESCRIPTION: &str = "A local copy supplied by cloud egress and your network. It cannot protect against losing that connection. Enable first, then start cloud Record separately. Up to five minutes and 256 MiB per enablement; cloud usage is bounded to 0.10 account-currency units.";
/// Before a cloud room is open (and while its answer is pending).
pub const OPEN_A_ROOM: &str = "Open a cloud room to check archive availability.";
pub const UNCONFIRMED: &str = "Archive availability could not be confirmed.";
pub const ORIENTATION_LABEL: &str = "Archive orientation";
pub const HORIZONTAL: &str = "Horizontal";
pub const VERTICAL: &str = "Vertical";
pub const ENABLE: &str = "Enable local archive";
pub const STOP: &str = "Stop archive";
pub const CANCEL: &str = "Cancel archive";
pub const RESUME: &str = "Resume archive";
pub const DISCARD: &str = "Discard staging files";
pub const ACTION_FAILED: &str =
    "The archive action could not finish. Check its status before retrying.";

/// How often the section reads the jobs while it shows.
pub const STATUS_POLL_MS: u64 = 2_000;

/// `CloudArchiveView['state']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveState {
    Waiting,
    Copying,
    Finalizing,
    Interrupted,
    Partial,
    Corrupt,
    Cancelled,
    Complete,
}

impl ArchiveState {
    /// The word the job line shows (the wire's own).
    pub fn id(self) -> &'static str {
        match self {
            ArchiveState::Waiting => "waiting",
            ArchiveState::Copying => "copying",
            ArchiveState::Finalizing => "finalizing",
            ArchiveState::Interrupted => "interrupted",
            ArchiveState::Partial => "partial",
            ArchiveState::Corrupt => "corrupt",
            ArchiveState::Cancelled => "cancelled",
            ArchiveState::Complete => "complete",
        }
    }

    /// Waiting, copying or finalizing: Stop and Cancel apply, and no second
    /// archive may be enabled.
    pub fn running(self) -> bool {
        matches!(
            self,
            ArchiveState::Waiting | ArchiveState::Copying | ArchiveState::Finalizing
        )
    }
}

/// `CloudArchiveView`: one archive job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudArchiveView {
    pub id: String,
    pub show_id: String,
    pub state: ArchiveState,
    pub reason: String,
    pub bytes: f64,
    pub segments: u64,
    pub local_session_id: Option<String>,
}

/// `cloud.archive.availability`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ArchiveAvailability {
    pub available: bool,
    pub reason: String,
}

impl ArchiveAvailability {
    /// No room open, or its answer is not in yet.
    pub fn no_room() -> Self {
        Self {
            available: false,
            reason: OPEN_A_ROOM.into(),
        }
    }
}

/// What a job's row offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveCommand {
    Stop,
    Cancel,
    Resume,
    Discard,
}

impl ArchiveCommand {
    pub fn label(self) -> &'static str {
        match self {
            ArchiveCommand::Stop => STOP,
            ArchiveCommand::Cancel => CANCEL,
            ArchiveCommand::Resume => RESUME,
            ArchiveCommand::Discard => DISCARD,
        }
    }

    fn method(self) -> &'static str {
        match self {
            ArchiveCommand::Stop => "cloud.archive.stop",
            ArchiveCommand::Cancel => "cloud.archive.cancel",
            ArchiveCommand::Resume => "cloud.archive.resume",
            ArchiveCommand::Discard => "cloud.archive.discard",
        }
    }
}

/// A job's buttons: Stop and Cancel while it runs; otherwise Resume (when
/// interrupted) and Discard.
pub fn job_commands(job: &CloudArchiveView) -> Vec<ArchiveCommand> {
    if job.state.running() {
        vec![ArchiveCommand::Stop, ArchiveCommand::Cancel]
    } else if job.state == ArchiveState::Interrupted {
        vec![ArchiveCommand::Resume, ArchiveCommand::Discard]
    } else {
        vec![ArchiveCommand::Discard]
    }
}

/// The job's line: "copying · 12 segments · 3.4 MiB".
pub fn job_line(job: &CloudArchiveView) -> String {
    format!(
        "{} · {} segments · {:.1} MiB",
        job.state.id(),
        job.segments,
        job.bytes / 1_048_576.0
    )
}

/// Enable is off without an available room, while an action runs, and while
/// an archive runs.
pub fn enable_disabled(
    availability: &ArchiveAvailability,
    busy: bool,
    jobs: &[CloudArchiveView],
) -> bool {
    !availability.available || busy || jobs.iter().any(|job| job.state.running())
}

/// The line under the section after a failed action: a full list says what
/// to do (`archive-full`); other refusals keep the generic line.
pub fn action_error(error: &RpcError) -> String {
    if error.code == "archive-full" {
        error.message.clone()
    } else {
        ACTION_FAILED.into()
    }
}

/// `cloud.archive.status`. A failure keeps the last confirmed jobs (the
/// caller does not replace them).
pub async fn archive_status(
    backend: &impl LibraryBackend,
) -> Result<Vec<CloudArchiveView>, RpcError> {
    let answer = backend
        .library_request("cloud.archive.status", Value::Null)
        .await?;
    serde_json::from_value(answer)
        .map_err(|error| RpcError::new("cloud.archive.status", "invalid_result", error.to_string()))
}

/// `cloud.archive.availability` for the open room's show; a failure reads
/// as unconfirmed.
pub async fn archive_availability(
    backend: &impl LibraryBackend,
    show_id: &str,
) -> ArchiveAvailability {
    backend
        .library_request("cloud.archive.availability", json!({ "showId": show_id }))
        .await
        .ok()
        .and_then(|answer| serde_json::from_value(answer).ok())
        .unwrap_or_else(|| ArchiveAvailability {
            available: false,
            reason: UNCONFIRMED.into(),
        })
}

/// "Enable local archive": consent is the press. `output_directory_capability`
/// is Output's folder as the desktop layer issued it (the caller refuses
/// when the folder is unavailable).
pub async fn start_archive(
    backend: &impl LibraryBackend,
    show_id: &str,
    vertical: bool,
    output_directory_capability: Option<&str>,
) -> Result<(), RpcError> {
    let mut params = json!({
        "consent": true,
        "showId": show_id,
        "orientation": if vertical { "v" } else { "h" },
    });
    if let Some(capability) = output_directory_capability {
        params["outputDirectoryCapability"] = json!(capability);
    }
    backend
        .library_request("cloud.archive.start", params)
        .await
        .map(drop)
}

/// A job's button.
pub async fn run_archive_command(
    backend: &impl LibraryBackend,
    command: ArchiveCommand,
    job_id: &str,
) -> Result<(), RpcError> {
    backend
        .library_request(command.method(), json!({ "id": job_id }))
        .await
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(state: ArchiveState) -> CloudArchiveView {
        CloudArchiveView {
            id: "a1".into(),
            show_id: "show_1".into(),
            state,
            reason: String::new(),
            bytes: 3.5 * 1_048_576.0,
            segments: 12,
            local_session_id: None,
        }
    }

    #[test]
    fn a_running_job_stops_or_cancels_and_holds_enable() {
        let open = ArchiveAvailability {
            available: true,
            reason: "Ready.".into(),
        };
        for state in [
            ArchiveState::Waiting,
            ArchiveState::Copying,
            ArchiveState::Finalizing,
        ] {
            assert_eq!(
                job_commands(&job(state)),
                [ArchiveCommand::Stop, ArchiveCommand::Cancel]
            );
            assert!(enable_disabled(&open, false, &[job(state)]));
        }
        assert_eq!(
            job_commands(&job(ArchiveState::Interrupted)),
            [ArchiveCommand::Resume, ArchiveCommand::Discard]
        );
        for state in [
            ArchiveState::Partial,
            ArchiveState::Corrupt,
            ArchiveState::Cancelled,
            ArchiveState::Complete,
        ] {
            assert_eq!(job_commands(&job(state)), [ArchiveCommand::Discard]);
            assert!(!enable_disabled(&open, false, &[job(state)]));
        }
        assert!(enable_disabled(&open, true, &[]));
        assert!(enable_disabled(&ArchiveAvailability::no_room(), false, &[]));
    }

    #[test]
    fn the_job_line_and_the_errors() {
        assert_eq!(
            job_line(&job(ArchiveState::Copying)),
            "copying · 12 segments · 3.5 MiB"
        );
        let full = RpcError::new("cloud.archive.start", "archive-full", "Discard one first.");
        assert_eq!(action_error(&full), "Discard one first.");
        let other = RpcError::new("cloud.archive.start", "failed", "raw");
        assert_eq!(action_error(&other), ACTION_FAILED);
        let view: CloudArchiveView = serde_json::from_value(json!({
            "id": "a1", "showId": "s", "state": "interrupted", "reason": "Network",
            "bytes": 10, "segments": 1, "localSessionId": null
        }))
        .unwrap();
        assert_eq!(view.state, ArchiveState::Interrupted);
    }

    /// The words are still Electron's.
    #[test]
    fn every_constant_is_still_in_the_renderer() {
        let sources = [include_str!(
            "../../../../apps/desktop/src/renderer/src/components/tabs/library-cloud-archive.tsx"
        )];
        let this = include_str!("cloud_archive.rs");
        let this = &this[..this.find("#[cfg(test)]").unwrap()];
        let (checked, missing) = super::super::copy::tests::unseen_constants(this, &sources);
        assert!(
            checked >= 13,
            "found {checked} constants; the scan is broken"
        );
        assert!(
            missing.is_empty(),
            "not in the renderer any more: {missing:?}"
        );
    }
}
