//! A cloud take's separate files under its Cloud tab row (plan 260 S1.6f,
//! from Electron's plan 249 S22, `components/tabs/library-cloud-iso.tsx`).
//!
//! The files' logic (`lib/cloud-iso-view.ts`: the manifest, each file's
//! state, the import journal) is shared with the talk show's room, so it
//! belongs with the room's port (S1.6d). The Cloud tab reaches it through
//! [`CloudTakeFiles`]. Until then [`NoCloudTakeFiles`] shows no section,
//! which is what Electron shows for a take with no separate files. The tab's
//! own rule, which shows to ask about, is here ([`shows_to_ask`]).

use std::future::Future;

use super::cloud::{CloudAvailability, CloudRecordingItem, cloud_recording_availability};
use crate::client::RpcError;

/// `ISO_SHOWS_PER_LOAD`: at most this many shows are asked about their
/// separate files per load.
pub const SHOWS_PER_LOAD: usize = 8;

/// `showsToAsk`: the newest shows' ids, in the list's order (newest first),
/// each once, skipping recordings the cloud no longer keeps.
pub fn shows_to_ask(recordings: &[CloudRecordingItem], now_ms: i64) -> Vec<String> {
    let mut shows: Vec<String> = Vec::new();
    for recording in recordings {
        if cloud_recording_availability(recording, now_ms) != CloudAvailability::Available {
            continue;
        }
        if recording.show_id.is_empty() || shows.contains(&recording.show_id) {
            continue;
        }
        shows.push(recording.show_id.clone());
        if shows.len() == SHOWS_PER_LOAD {
            break;
        }
    }
    shows
}

/// A cloud take's separate files, as the room's port (S1.6d) provides them:
/// `useCloudIsoLibrary`'s `takes`, `importTake` and `cancelImport`.
pub trait CloudTakeFiles: Send + Sync + 'static {
    /// One take's section (`CloudIsoLibraryTake` with its import state), as
    /// the room's port draws it.
    type Take: Clone + Send;

    /// Reads the separate files of these shows ([`shows_to_ask`]), with
    /// Output's folder for the imports.
    fn load(&self, show_ids: &[String]) -> impl Future<Output = ()> + Send;

    /// The section under this cloud recording's row, if its take has
    /// separate files.
    fn take_for(&self, recording_id: &str) -> Option<Self::Take>;

    /// "Import": the take's files into the Library.
    fn import(&self, take: &Self::Take) -> impl Future<Output = Result<(), RpcError>> + Send;

    /// Cancels a running import.
    fn cancel_import(&self, job_id: &str) -> impl Future<Output = Result<(), RpcError>> + Send;
}

/// No separate files yet: no section under any row.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoCloudTakeFiles;

impl CloudTakeFiles for NoCloudTakeFiles {
    type Take = ();

    async fn load(&self, _show_ids: &[String]) {}

    fn take_for(&self, _recording_id: &str) -> Option<()> {
        None
    }

    async fn import(&self, _take: &()) -> Result<(), RpcError> {
        Ok(())
    }

    async fn cancel_import(&self, _job_id: &str) -> Result<(), RpcError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recording(id: &str, show: &str, expires_at: &str) -> CloudRecordingItem {
        CloudRecordingItem {
            id: id.into(),
            show_id: show.into(),
            expires_at: expires_at.into(),
            ..CloudRecordingItem::default()
        }
    }

    #[test]
    fn the_newest_available_shows_once_each_up_to_eight() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-24T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let kept = "2026-12-24T12:00:00Z";
        let mut rows = vec![
            recording("r1", "show_a", kept),
            recording("r2", "show_a", kept),
            recording("r3", "", kept),
            recording("r4", "show_gone", "2026-11-01T00:00:00Z"),
            recording("r5", "show_b", kept),
        ];
        assert_eq!(shows_to_ask(&rows, now), ["show_a", "show_b"]);
        for index in 0..10 {
            rows.push(recording(
                &format!("x{index}"),
                &format!("show_{index}"),
                kept,
            ));
        }
        let asked = shows_to_ask(&rows, now);
        assert_eq!(asked.len(), SHOWS_PER_LOAD);
        assert_eq!(asked[..3], ["show_a", "show_b", "show_0"]);
    }

    #[tokio::test]
    async fn without_the_rooms_port_no_take_has_a_section() {
        let files = NoCloudTakeFiles;
        files.load(&["show_a".into()]).await;
        assert_eq!(files.take_for("r1"), None);
        assert!(files.import(&()).await.is_ok());
    }

    /// The rule and its limit are still Electron's.
    #[test]
    fn the_rule_is_the_renderers() {
        let source = include_str!(
            "../../../../apps/desktop/src/renderer/src/components/tabs/library-cloud-iso.tsx"
        );
        assert!(source.contains("const ISO_SHOWS_PER_LOAD = 8\n"));
        assert!(
            source.contains("if (cloudRecordingAvailability(recording) !== 'available') continue")
        );
        assert!(
            source.contains("if (!recording.showId || shows.includes(recording.showId)) continue")
        );
    }
}
