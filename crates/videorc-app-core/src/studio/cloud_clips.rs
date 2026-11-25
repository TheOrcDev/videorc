//! Cloud Clips on the Output page while a room is open (plan 234 T3, wire
//! section 13.2), from `components/tabs/cloud-clips-section.tsx` and
//! `shared/cloud-clips.ts`: the same Clips actions with cloud ownership. It
//! never arms the native camera session.
//!
//! The page reads `cloud.clips.status` (for the open show) and
//! `cloud.clips.jobs` every two seconds; Enable asks for the program's
//! orientation and sends the recordings folder's capability (never a path);
//! each job offers Cancel while it runs, Retry when interrupted, and Dismiss
//! or Discard after.

use serde::Deserialize;
use serde_json::{Value, json};

use super::{Studio, StudioBackend};

pub const READ_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

pub mod copy {
    pub const TITLE: &str = "Clips";
    pub const DESCRIPTION: &str = "Save marked windows of the cloud program to Library. Enable first, then start cloud Record separately. The buffer keeps up to 90 seconds / 64 MiB, for at most five minutes per enablement. No recording starts automatically.";
    pub const UNCONFIRMED: &str = "Clips availability is unconfirmed. Reconnect to check again.";
    pub const COSTS: &str = "Opt-in cloud reads: up to 256 MiB and 0.10 account-currency units per enablement. Local staging is limited to 192 MiB; saved clips remain in Library until you delete them. Disabling clears the shared program buffer, including any archive using it.";
    pub const ORIENTATION_LABEL: &str = "Clip program orientation";
    pub const HORIZONTAL: &str = "Horizontal";
    pub const VERTICAL: &str = "Vertical";
    pub const ENABLE: &str = "Enable cloud Clips";
    pub const DISABLE: &str = "Disable Clips";
    pub const HOW_TO_SAVE: &str = "Use Save 30-second clip or Save 1-minute clip in Stream Manager. Without a confirmed media clock, the action saves a marker only.";
    pub const ACTION_FAILED: &str = "The clip action could not finish. Check the current buffer and job status before retrying.";
    pub const CANCEL: &str = "Cancel clip";
    pub const RETRY: &str = "Retry clip";
    pub const DISMISS: &str = "Dismiss job";
    pub const DISCARD: &str = "Discard staging files";
}

/// `CloudClipsStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudClipsStatus {
    pub available: bool,
    pub enabled: bool,
    pub generation: Option<String>,
    pub state: String,
    pub reason: String,
}

/// `CloudClipJob`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudClipJob {
    pub id: String,
    pub show_id: String,
    pub marker_id: String,
    /// `downloading`, `trimming`, `publishing`, `complete`, `interrupted`
    /// or `cancelled`.
    pub state: String,
    pub reason: String,
    pub local_session_id: Option<String>,
}

/// The program orientation the buffer keeps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Orientation {
    #[default]
    Horizontal,
    Vertical,
}

impl Orientation {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Horizontal => "h",
            Self::Vertical => "v",
        }
    }

    pub fn of_wire(value: &str) -> Option<Self> {
        match value {
            "h" => Some(Self::Horizontal),
            "v" => Some(Self::Vertical),
            _ => None,
        }
    }
}

/// One job's button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobAction {
    Cancel,
    Retry,
    /// `Dismiss job` for a complete one, else `Discard staging files`.
    Discard,
}

/// One job row: its line and its buttons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRow {
    pub id: String,
    pub marker_id: String,
    pub text: String,
    pub actions: Vec<(JobAction, &'static str)>,
}

fn running(state: &str) -> bool {
    matches!(state, "downloading" | "trimming" | "publishing")
}

/// The show's jobs, as the section lists them.
pub fn job_rows(jobs: &[CloudClipJob], show_id: &str) -> Vec<JobRow> {
    jobs.iter()
        .filter(|job| job.show_id == show_id)
        .map(|job| {
            let actions = if running(&job.state) {
                vec![(JobAction::Cancel, copy::CANCEL)]
            } else {
                let mut actions = Vec::new();
                if job.state == "interrupted" {
                    actions.push((JobAction::Retry, copy::RETRY));
                }
                actions.push((
                    JobAction::Discard,
                    if job.state == "complete" {
                        copy::DISMISS
                    } else {
                        copy::DISCARD
                    },
                ));
                actions
            };
            JobRow {
                id: job.id.clone(),
                marker_id: job.marker_id.clone(),
                text: format!("{} · {}", job.state, job.reason),
                actions,
            }
        })
        .collect()
}

/// The section's state line: the backend's reason, or that nobody knows.
pub fn status_line(status: Option<&CloudClipsStatus>) -> &str {
    status.map_or(copy::UNCONFIRMED, |status| status.reason.as_str())
}

/// Enable waits for an available, not yet enabled buffer.
pub fn can_enable(status: Option<&CloudClipsStatus>) -> bool {
    status.is_some_and(|status| status.available && !status.enabled)
}

/// Disable needs the enabled buffer's generation.
pub fn disable_generation(status: Option<&CloudClipsStatus>) -> Option<&str> {
    status
        .filter(|status| status.enabled)
        .and_then(|status| status.generation.as_deref())
}

/// `cloud.clips.enable`'s params: consent is the press.
pub fn enable_params(
    show_id: &str,
    orientation: Orientation,
    request_id: &str,
    folder_capability: Option<&str>,
) -> Value {
    let mut params = json!({
        "showId": show_id,
        "consent": true,
        "orientation": orientation.wire(),
        "requestId": request_id,
    });
    if let Some(capability) = folder_capability {
        params["outputDirectoryCapability"] = json!(capability);
    }
    params
}

type Answer<T> = Result<T, String>;

fn failed<E>(_: E) -> String {
    copy::ACTION_FAILED.to_string()
}

impl<B: StudioBackend> Studio<B> {
    async fn cloud_clips_call(&self, method: &'static str, params: Value) -> Answer<Value> {
        self.backend
            .clips_request(method, params)
            .await
            .map_err(|error| {
                self.config
                    .logger
                    .warn(format!("Cloud Clips: {method} failed: {}", error.message));
                copy::ACTION_FAILED.to_string()
            })
    }

    /// The section's two reads, together: the show's status and every job.
    /// A failed read leaves the status unknown.
    pub async fn cloud_clips_read(
        &self,
        show_id: &str,
    ) -> Option<(CloudClipsStatus, Vec<CloudClipJob>)> {
        let status = self
            .backend
            .clips_request("cloud.clips.status", json!({ "showId": show_id }));
        let jobs = self.backend.clips_request("cloud.clips.jobs", Value::Null);
        let (status, jobs) = tokio::join!(status, jobs);
        let status = serde_json::from_value(status.ok()?).ok()?;
        let jobs = serde_json::from_value(jobs.ok()?).ok()?;
        Some((status, jobs))
    }

    /// "Enable cloud Clips": the recordings folder's capability first (a
    /// chosen folder that can't be authorized refuses), then the request.
    pub async fn cloud_clips_enable(
        &self,
        show_id: &str,
        orientation: Orientation,
    ) -> Answer<CloudClipsStatus> {
        let folder = self.recordings_folder_capability().await?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let params = enable_params(show_id, orientation, &request_id, folder.as_deref());
        let answer = self.cloud_clips_call("cloud.clips.enable", params).await?;
        serde_json::from_value(answer).map_err(failed)
    }

    pub async fn cloud_clips_disable(
        &self,
        show_id: &str,
        generation: &str,
    ) -> Answer<CloudClipsStatus> {
        let answer = self
            .cloud_clips_call(
                "cloud.clips.disable",
                json!({ "showId": show_id, "generation": generation }),
            )
            .await?;
        serde_json::from_value(answer).map_err(failed)
    }

    /// "Retry clip": saves the marker again from the current buffer.
    pub async fn cloud_clips_retry(
        &self,
        show_id: &str,
        marker_id: &str,
        generation: &str,
    ) -> Answer<()> {
        let folder = self.recordings_folder_capability().await?;
        let mut params = json!({
            "showId": show_id,
            "markerId": marker_id,
            "generation": generation,
        });
        if let Some(capability) = folder {
            params["outputDirectoryCapability"] = json!(capability);
        }
        self.cloud_clips_call("cloud.clips.save", params)
            .await
            .map(drop)
    }

    /// Show markers' Save clip reads the show's Clips status alone: its
    /// generation goes with the save. A failed read leaves it unknown.
    pub async fn cloud_clips_status(&self, show_id: &str) -> Option<CloudClipsStatus> {
        let status = self
            .backend
            .clips_request("cloud.clips.status", json!({ "showId": show_id }))
            .await
            .ok()?;
        serde_json::from_value(status).ok()
    }

    /// Show markers (P1363): `cloud.markers.list` for one show.
    pub async fn cloud_markers_list(
        &self,
        show_id: &str,
    ) -> Answer<Vec<crate::library::cloud_markers::CloudMarker>> {
        use crate::library::cloud_markers::{LIST_METHOD, LOAD_FAILED, MarkersPage};
        let page = self
            .backend
            .clips_request(LIST_METHOD, json!({ "showId": show_id }))
            .await
            .map_err(|_| LOAD_FAILED.to_string())?;
        serde_json::from_value::<MarkersPage>(page)
            .map(|page| page.markers)
            .map_err(|_| LOAD_FAILED.to_string())
    }

    /// Show markers' Remove: `cloud.marker.delete`.
    pub async fn cloud_marker_delete(&self, show_id: &str, marker_id: &str) -> Answer<()> {
        use crate::library::cloud_markers::{DELETE_METHOD, REMOVE_FAILED};
        self.backend
            .clips_request(
                DELETE_METHOD,
                json!({ "showId": show_id, "markerId": marker_id }),
            )
            .await
            .map(drop)
            .map_err(|_| REMOVE_FAILED.to_string())
    }

    pub async fn cloud_clips_cancel(&self, job_id: &str) -> Answer<()> {
        self.cloud_clips_call("cloud.clips.cancel", json!({ "id": job_id }))
            .await
            .map(drop)
    }

    pub async fn cloud_clips_discard(&self, job_id: &str) -> Answer<()> {
        self.cloud_clips_call("cloud.clips.discard", json!({ "id": job_id }))
            .await
            .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, show: &str, state: &str) -> CloudClipJob {
        serde_json::from_value(json!({
            "id": id,
            "showId": show,
            "markerId": format!("m-{id}"),
            "state": state,
            "reason": "why",
            "localSessionId": null,
        }))
        .expect("job")
    }

    #[test]
    fn each_job_offers_what_the_section_did() {
        let jobs = [
            job("a", "show", "trimming"),
            job("b", "show", "interrupted"),
            job("c", "show", "complete"),
            job("d", "show", "cancelled"),
            job("e", "other", "complete"),
        ];
        let rows = job_rows(&jobs, "show");
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].actions, [(JobAction::Cancel, copy::CANCEL)]);
        assert_eq!(rows[0].text, "trimming · why");
        assert_eq!(
            rows[1].actions,
            [
                (JobAction::Retry, copy::RETRY),
                (JobAction::Discard, copy::DISCARD)
            ]
        );
        assert_eq!(rows[2].actions, [(JobAction::Discard, copy::DISMISS)]);
        assert_eq!(rows[3].actions, [(JobAction::Discard, copy::DISCARD)]);
    }

    #[test]
    fn enable_and_disable_follow_the_buffer() {
        let status = |available: bool, enabled: bool, generation: Option<&str>| CloudClipsStatus {
            available,
            enabled,
            generation: generation.map(str::to_string),
            state: "idle".into(),
            reason: "Ready".into(),
        };
        assert!(!can_enable(None));
        assert_eq!(status_line(None), copy::UNCONFIRMED);
        assert!(can_enable(Some(&status(true, false, None))));
        assert!(!can_enable(Some(&status(false, false, None))));
        assert!(!can_enable(Some(&status(true, true, Some("g1")))));
        assert_eq!(
            disable_generation(Some(&status(true, true, Some("g1")))),
            Some("g1")
        );
        assert_eq!(disable_generation(Some(&status(true, true, None))), None);
    }

    #[test]
    fn enable_sends_consent_orientation_and_the_capability_never_a_path() {
        let params = enable_params("show", Orientation::Vertical, "req", Some("cap"));
        assert_eq!(
            params,
            json!({
                "showId": "show",
                "consent": true,
                "orientation": "v",
                "requestId": "req",
                "outputDirectoryCapability": "cap",
            })
        );
        assert!(
            enable_params("show", Orientation::Horizontal, "req", None)
                .get("outputDirectoryCapability")
                .is_none()
        );
    }
}
