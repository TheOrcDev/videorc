//! Plan 260 S1.8 (L1): commit a Studio scene into the backend's talk-show
//! room (`cloud.room.scene.commit`), port of the renderer's
//! `room-scene-backend.ts`. Pure: the GPUI `TalkShowRoomHost` sends the RPC
//! and listens for `cloud.room.presentation`; this module builds params,
//! maps a presentation scene status into a settle answer, and drives the
//! wait loop's generation filter.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::cloud_scene::adapter::RoomSceneCommitState;
use crate::cloud_scene::types::{
    BackgroundMime, CloudScene, SceneOrientation, SceneTransitionKind,
};
use crate::cloud_scene::{orientation_from_layout_preset, room_scene_transition};

/// How long the Studio waits for the room's program pages to draw a commit
/// (`BACKEND_SCENE_COMMIT_WAIT_MS`).
pub const BACKEND_SCENE_COMMIT_WAIT_MS: u64 = 5_000;
pub const BACKEND_SCENE_COMMIT_WAIT: Duration = Duration::from_millis(BACKEND_SCENE_COMMIT_WAIT_MS);

/// `cloud.room.scene.commit`.
pub const SCENE_COMMIT: &str = "cloud.room.scene.commit";
/// `cloud.scene.resolve` (Rust `scene_from_capture_config`, uncommitted).
pub const SCENE_RESOLVE: &str = "cloud.scene.resolve";

/// Default reason when no presentation scene status arrived in time.
pub const WAITING_REASON: &str = "Scene sent; waiting for each output to draw it.";

/// A background picture ready to send with a scene commit (S14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedBackgroundAsset {
    pub hash: String,
    pub mime: BackgroundMime,
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

/// What the room's program draws per orientation lane (`SceneContent`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneContent {
    pub h: Option<CloudScene>,
    pub v: Option<CloudScene>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition: Option<SceneContentTransition>,
}

/// Transition carried with [`SceneContent`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneContentTransition {
    pub kind: SceneTransitionKind,
    pub duration_ms: i64,
}

/// What `commit` answers: the rendered revisions, or why there are none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomSceneCommit {
    pub state: RoomSceneCommitState,
    pub reason: Option<String>,
    pub observed: BTreeMap<String, Value>,
}

/// A scene entry from `cloud.room.presentation` (the parts the wait loop
/// needs), read leniently.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationSceneStatus {
    #[serde(default)]
    pub enabled: bool,
    pub state: PresentationSceneState,
    #[serde(default)]
    pub reason: Option<String>,
    pub revision: u64,
    #[serde(default)]
    pub observed: BTreeMap<String, Value>,
}

/// Wire states for a presentation scene entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PresentationSceneState {
    Off,
    Preview,
    Waiting,
    Applied,
    Failed,
}

/// The commit's answer from a scene status, as the renderer's publisher
/// gave it (`sceneCommitFrom`).
pub fn scene_commit_from(status: &PresentationSceneStatus) -> Option<RoomSceneCommit> {
    if status.state == PresentationSceneState::Waiting {
        return None;
    }
    let state = match status.state {
        PresentationSceneState::Off => RoomSceneCommitState::Applied,
        PresentationSceneState::Preview => RoomSceneCommitState::Preview,
        PresentationSceneState::Applied => RoomSceneCommitState::Applied,
        PresentationSceneState::Failed => RoomSceneCommitState::Failed,
        PresentationSceneState::Waiting => unreachable!(),
    };
    Some(RoomSceneCommit {
        state,
        reason: status.reason.clone(),
        observed: status.observed.clone(),
    })
}

/// Standard (padded) base64 for a background asset's bytes.
pub fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn mime_wire(mime: BackgroundMime) -> &'static str {
    match mime {
        BackgroundMime::Webp => "image/webp",
        BackgroundMime::Jpeg => "image/jpeg",
        BackgroundMime::Png => "image/png",
    }
}

/// `cloud.room.scene.commit` params: `{ content, assets }`. `content: null`
/// returns the room to its own layouts; assets are omitted then.
pub fn scene_commit_params(
    content: Option<&SceneContent>,
    assets: &[PreparedBackgroundAsset],
) -> Value {
    let assets = content
        .map(|_| {
            assets
                .iter()
                .map(|asset| {
                    json!({
                        "hash": asset.hash,
                        "mime": mime_wire(asset.mime),
                        "width": asset.width,
                        "height": asset.height,
                        "base64": encode_base64(&asset.bytes),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "content": content,
        "assets": assets,
    })
}

/// Lane content for one orientation (the other lane stays null), with the
/// room transition for `animate`.
pub fn scene_content_for_orientation(
    orientation: SceneOrientation,
    scene: CloudScene,
    animate: bool,
) -> SceneContent {
    let (kind, duration_ms) = room_scene_transition(animate);
    let transition = Some(SceneContentTransition { kind, duration_ms });
    match orientation {
        SceneOrientation::H => SceneContent {
            h: Some(scene),
            v: None,
            transition,
        },
        SceneOrientation::V => SceneContent {
            h: None,
            v: Some(scene),
            transition,
        },
    }
}

/// Orientation from a layout preset string (adapter helper, re-exported for
/// the host's resolve path).
pub fn orientation_for_layout(layout_preset: &str) -> SceneOrientation {
    orientation_from_layout_preset(layout_preset)
}

/// A `cloud.room.presentation` payload's show and its `scene` entry, when
/// it has one.
pub fn presentation_scene(payload: &Value) -> Option<(String, PresentationSceneStatus)> {
    let show_id = payload.get("showId")?.as_str()?.to_string();
    let scene = serde_json::from_value(payload.get("scene")?.clone()).ok()?;
    Some((show_id, scene))
}

/// The RPC answer's held flag, generation, and standing status.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneCommitAnswer {
    #[serde(default)]
    pub held: bool,
    #[serde(default)]
    pub generation: Option<u64>,
    #[serde(default)]
    pub status: Option<PresentationSceneStatus>,
}

impl SceneCommitAnswer {
    pub fn from_value(value: &Value) -> Self {
        serde_json::from_value(value.clone()).unwrap_or(Self {
            held: false,
            generation: None,
            status: None,
        })
    }
}

/// Pure wait/settle for one commit generation over a stream of presentation
/// scene statuses (the renderer's wait loop without I/O or timers).
#[derive(Debug, Clone, Default)]
pub struct SceneCommitSettle {
    generation: Option<u64>,
    heard: Vec<PresentationSceneStatus>,
}

impl SceneCommitSettle {
    pub fn new() -> Self {
        Self::default()
    }

    /// The commit's generation from the RPC answer; an unchanged commit may
    /// also push its standing status here.
    pub fn begin(&mut self, generation: u64, standing: Option<PresentationSceneStatus>) {
        self.generation = Some(generation);
        if let Some(status) = standing.filter(|status| status.revision == generation) {
            self.heard.push(status);
        }
    }

    /// A scene entry heard on `cloud.room.presentation` (or early, before
    /// the RPC returns). Returns true when this generation has settled.
    pub fn note(&mut self, status: PresentationSceneStatus) -> bool {
        let generation = self.generation;
        self.heard.push(status);
        generation.is_some_and(|generation| {
            self.heard.last().is_some_and(|status| {
                status.revision == generation && status.state != PresentationSceneState::Waiting
            })
        })
    }

    pub fn generation(&self) -> Option<u64> {
        self.generation
    }

    /// Latest heard status of this commit's generation.
    pub fn mine(&self) -> Option<&PresentationSceneStatus> {
        let generation = self.generation?;
        self.heard
            .iter()
            .rev()
            .find(|status| status.revision == generation)
    }

    /// Still waiting for a non-`waiting` status of this generation.
    pub fn needs_wait(&self) -> bool {
        self.generation.is_some()
            && match self.mine() {
                None => true,
                Some(status) => status.state == PresentationSceneState::Waiting,
            }
    }

    /// Final settle answer (after the wait window, or as soon as settled).
    pub fn result(&self) -> RoomSceneCommit {
        match self.mine() {
            None => RoomSceneCommit {
                state: RoomSceneCommitState::Waiting,
                reason: Some(WAITING_REASON.to_string()),
                observed: BTreeMap::new(),
            },
            Some(status) => scene_commit_from(status).unwrap_or_else(|| RoomSceneCommit {
                state: RoomSceneCommitState::Waiting,
                reason: status
                    .reason
                    .clone()
                    .or_else(|| Some(WAITING_REASON.to_string())),
                observed: status.observed.clone(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(revision: u64, state: PresentationSceneState) -> PresentationSceneStatus {
        PresentationSceneStatus {
            enabled: true,
            state,
            reason: None,
            revision,
            observed: BTreeMap::new(),
        }
    }

    #[test]
    fn scene_commit_from_maps_off_to_applied() {
        let commit = scene_commit_from(&status(1, PresentationSceneState::Off)).expect("applied");
        assert_eq!(commit.state, RoomSceneCommitState::Applied);
        assert!(scene_commit_from(&status(1, PresentationSceneState::Waiting)).is_none());
    }

    #[test]
    fn settles_on_an_early_result_of_its_own_generation() {
        let mut settle = SceneCommitSettle::new();
        settle.note(status(3, PresentationSceneState::Applied));
        settle.note(status(4, PresentationSceneState::Preview));
        settle.begin(4, None);
        assert!(!settle.needs_wait());
        assert_eq!(settle.result().state, RoomSceneCommitState::Preview);
    }

    #[test]
    fn never_settles_on_another_generation() {
        let mut settle = SceneCommitSettle::new();
        settle.note(status(4, PresentationSceneState::Applied));
        settle.begin(5, None);
        assert!(settle.needs_wait());
        assert_eq!(settle.result().state, RoomSceneCommitState::Waiting);
    }

    #[test]
    fn answers_an_unchanged_commit_with_its_standing_result() {
        let mut settle = SceneCommitSettle::new();
        settle.begin(6, Some(status(6, PresentationSceneState::Applied)));
        assert!(!settle.needs_wait());
        assert_eq!(settle.result().state, RoomSceneCommitState::Applied);
    }

    #[test]
    fn commit_params_null_content_sends_no_assets() {
        let params = scene_commit_params(None, &[]);
        assert!(params.get("content").unwrap().is_null());
        assert_eq!(params.get("assets").unwrap().as_array().unwrap().len(), 0);
    }

    #[test]
    fn commit_params_encode_assets() {
        let content = SceneContent {
            h: None,
            v: None,
            transition: Some(SceneContentTransition {
                kind: SceneTransitionKind::Cut,
                duration_ms: 0,
            }),
        };
        let assets = [PreparedBackgroundAsset {
            hash: "abc".into(),
            mime: BackgroundMime::Png,
            width: 2,
            height: 1,
            bytes: b"hi".to_vec(),
        }];
        let params = scene_commit_params(Some(&content), &assets);
        let asset = &params["assets"][0];
        assert_eq!(asset["hash"], "abc");
        assert_eq!(asset["mime"], "image/png");
        assert_eq!(asset["base64"], encode_base64(b"hi"));
        assert_eq!(encode_base64(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn presentation_scene_reads_the_entry() {
        let payload = json!({
            "showId": "show-1",
            "scene": {
                "enabled": true,
                "state": "preview",
                "reason": null,
                "revision": 4,
                "observed": {}
            }
        });
        let (show, scene) = presentation_scene(&payload).expect("scene");
        assert_eq!(show, "show-1");
        assert_eq!(scene.revision, 4);
        assert_eq!(scene.state, PresentationSceneState::Preview);
        assert!(presentation_scene(&json!({ "showId": "show-1", "media": {} })).is_none());
    }
}
