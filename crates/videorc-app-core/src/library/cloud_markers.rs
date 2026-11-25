//! Library → Cloud → Show markers (P1363, `cloud-markers-dialog.tsx`): the
//! server's marks on a cloud show's timeline, with Save clip for a clip
//! mark (`cloud.clips.save` under the show's Clips generation), Remove
//! (`cloud.marker.delete`) and Refresh. Show marks are shared metadata:
//! this view never creates a Library session or an extraction range.
//!
//! The Studio reads and changes them (`studio::cloud_clips`); this module
//! holds the words, the lenient wire shapes and the rows.

use serde::Deserialize;

use super::copy::UNTITLED_MARKER;
use super::markers::marker_time;
use crate::studio::cloud_clips::CloudClipsStatus;

pub const LIST_METHOD: &str = "cloud.markers.list";
pub const DELETE_METHOD: &str = "cloud.marker.delete";
/// A new mark on a show: an open dialog for that show reads again.
pub const CREATED_EVENT: &str = "cloud.marker.created";

pub const TITLE: &str = "Show markers";
pub const DESCRIPTION: &str = "Times show when the server saved each mark on this room’s timeline. No media to extract until a recording clock is confirmed.";
pub const REFRESH: &str = "Refresh";
pub const LOADING: &str = "Loading markers…";
pub const EMPTY: &str = "No markers saved on this show.";
pub const LIST_LABEL: &str = "Show moments";
pub const SAVE_CLIP: &str = "Save clip";
pub const REMOVE: &str = "Remove";
pub const CLIP_MARKER: &str = "Clip marker";
pub const RECORDING_ASSOCIATED: &str = "Recording associated; clock unconfirmed";
pub const NO_RECORDING: &str = "No recording associated";
pub const RECONNECT: &str = "Reconnect to load show markers.";
pub const LOAD_FAILED: &str =
    "Could not load show markers. The show may have expired. Try again after reconnecting.";
pub const SAVE_FAILED: &str =
    "No clip was saved. The marked window may have expired or its media clock is unconfirmed.";
pub const REMOVE_FAILED: &str = "Could not remove the marker. Try again.";

/// `CloudMarker`, read leniently: what the dialog draws and sends.
#[derive(Debug, Clone, PartialEq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudMarker {
    pub id: String,
    pub show_id: String,
    pub at_seconds: f64,
    /// `marker` or `clip`.
    pub kind: String,
    pub label: Option<String>,
    /// `manual`, `voice`, `remote` or `agent`.
    pub source: String,
    pub target: MarkerTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MarkerTarget {
    pub take_ids: Vec<String>,
}

/// `cloud.markers.list`'s page.
#[derive(Debug, Clone, PartialEq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MarkersPage {
    pub markers: Vec<CloudMarker>,
}

/// One row of the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerRow {
    pub id: String,
    pub title: String,
    /// `markerTime(atSeconds) · source`.
    pub context: String,
    pub meta: &'static str,
    /// A clip mark offers Save clip.
    pub clip: bool,
}

pub fn marker_row(marker: &CloudMarker) -> MarkerRow {
    let clip = marker.kind == "clip";
    let title = match marker.label.as_deref() {
        Some(label) => label.to_string(),
        None if clip => CLIP_MARKER.to_string(),
        None => UNTITLED_MARKER.to_string(),
    };
    MarkerRow {
        id: marker.id.clone(),
        title,
        context: format!("{} · {}", marker_time(marker.at_seconds), marker.source),
        meta: if marker.target.take_ids.is_empty() {
            NO_RECORDING
        } else {
            RECORDING_ASSOCIATED
        },
        clip,
    }
}

/// Save clip works while nothing is pending and the show's cloud Clips are
/// on under a generation; that generation goes with the save.
pub fn save_generation(pending: bool, clips: Option<&CloudClipsStatus>) -> Option<&str> {
    if pending {
        return None;
    }
    clips
        .filter(|clips| clips.enabled)
        .and_then(|clips| clips.generation.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_name_the_mark_its_time_and_whether_a_recording_holds_it() {
        let page: MarkersPage = serde_json::from_value(json!({
            "markers": [
                { "id": "m1", "showId": "s", "atSeconds": 75, "kind": "clip", "label": null,
                  "source": "voice", "target": { "kind": "cloud-show", "showId": "s", "takeIds": ["t"] } },
                { "id": "m2", "showId": "s", "atSeconds": 5, "kind": "marker", "label": null,
                  "source": "manual", "target": { "takeIds": [] } },
                { "id": "m3", "showId": "s", "atSeconds": 0, "kind": "marker", "label": "Intro",
                  "source": "agent" },
            ]
        }))
        .unwrap();
        let rows: Vec<MarkerRow> = page.markers.iter().map(marker_row).collect();
        assert_eq!(rows[0].title, "Clip marker");
        assert!(rows[0].clip);
        assert_eq!(rows[0].meta, RECORDING_ASSOCIATED);
        assert!(rows[0].context.ends_with(" · voice"));
        assert_eq!(rows[1].title, "Untitled marker");
        assert!(!rows[1].clip);
        assert_eq!(rows[1].meta, NO_RECORDING);
        assert_eq!(rows[2].title, "Intro");
    }

    #[test]
    fn save_clip_needs_the_shows_clips_on_under_a_generation() {
        let on = CloudClipsStatus {
            available: true,
            enabled: true,
            generation: Some("g1".into()),
            state: "ready".into(),
            reason: String::new(),
        };
        assert_eq!(save_generation(false, Some(&on)), Some("g1"));
        assert_eq!(save_generation(true, Some(&on)), None);
        assert_eq!(save_generation(false, None), None);
        let off = CloudClipsStatus {
            enabled: false,
            ..on.clone()
        };
        assert_eq!(save_generation(false, Some(&off)), None);
        let unbound = CloudClipsStatus {
            generation: None,
            ..on
        };
        assert_eq!(save_generation(false, Some(&unbound)), None);
    }
}
