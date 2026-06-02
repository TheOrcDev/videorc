//! LS1: the active-session scene revision model.
//!
//! Wraps the backend scene graph with a monotonic revision counter, classifies live
//! mutations as hot/warm/cold, rejects stale (`expectedRevision`) and
//! cold-during-session mutations, and records every attempt as a [`LiveEditEvent`].
//!
//! This is the model + contract layer only. It does NOT yet push changes into the
//! running FFmpeg output — the live render consumer (LS2+) is what makes a committed
//! revision actually reach recording/streaming. Per the plan's compatibility rule we
//! must never pretend a change applied to the live output until that wiring exists,
//! so nothing here touches the encoder; it only tracks the revision/event contract.
//! Introduced ahead of its protocol + state wiring, hence `allow(dead_code)`.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::protocol::{LayoutSettings, SceneOutputKind, SceneSource};

/// How a mutation reaches (or does not reach) the active session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApplyMode {
    /// Applies immediately without restarting capture or output.
    Hot,
    /// Keeps the session running but must prepare a replacement adapter before an
    /// atomic swap (e.g. a device switch, or a preset that needs a new source).
    Warm,
    /// Cannot apply during an active session; takes effect next session.
    Cold,
}

/// The set of live mutations a session can receive. Mirrors the renderer's
/// `SceneMutation['kind']`. Cold-only concerns (codec, destination set, canvas
/// orientation, recording-output toggle) are deliberately NOT scene mutations — they
/// are configuration changes handled outside this model.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MutationKind {
    #[serde(rename = "layout.set_preset")]
    LayoutSetPreset,
    #[serde(rename = "layout.patch")]
    LayoutPatch,
    #[serde(rename = "source.transform.patch")]
    SourceTransformPatch,
    #[serde(rename = "source.visibility.set")]
    SourceVisibilitySet,
    #[serde(rename = "source.order.set")]
    SourceOrderSet,
    #[serde(rename = "source.device.switch")]
    SourceDeviceSwitch,
    #[serde(rename = "audio.mic.patch")]
    AudioMicPatch,
    #[serde(rename = "output.resolution.patch")]
    OutputResolutionPatch,
    #[serde(rename = "output.fps.patch")]
    OutputFpsPatch,
    #[serde(rename = "output.bitrate.patch")]
    OutputBitratePatch,
}

/// Context the classifier needs to decide warm-vs-hot for layout/preset changes.
#[derive(Debug, Clone, Copy, Default)]
pub struct MutationContext {
    /// Whether the sources a layout/preset change needs are already live. A preset
    /// change that needs a not-yet-started source is warm (start it, then swap);
    /// otherwise it is hot.
    pub required_sources_active: bool,
}

/// Classifies a mutation. The backend is authoritative even if the renderer guessed,
/// so callers must use this result rather than any `applyMode` hint on the mutation.
pub fn classify_mutation(kind: MutationKind, ctx: &MutationContext) -> ApplyMode {
    match kind {
        MutationKind::LayoutPatch
        | MutationKind::SourceTransformPatch
        | MutationKind::SourceVisibilitySet
        | MutationKind::SourceOrderSet
        | MutationKind::AudioMicPatch
        | MutationKind::OutputBitratePatch => ApplyMode::Hot,
        // A preset is hot when the sources it needs are already live; otherwise it
        // must start a source first, which is warm (prepare-then-swap).
        MutationKind::LayoutSetPreset => {
            if ctx.required_sources_active {
                ApplyMode::Hot
            } else {
                ApplyMode::Warm
            }
        }
        // Switching a device always prepares a new capture adapter before the swap.
        MutationKind::SourceDeviceSwitch => ApplyMode::Warm,
        // Resolution/FPS require a full encoder/render reconfiguration that does not
        // exist yet (planned for LS7); until then they are next-session only so the UI
        // never pretends they applied live. Bitrate alone is hot. When LS7 lands these
        // can be promoted.
        MutationKind::OutputResolutionPatch | MutationKind::OutputFpsPatch => ApplyMode::Cold,
    }
}

/// A requested live change, carrying the revision it expects the scene to be at.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneMutation {
    pub id: String,
    pub expected_revision: u64,
    pub kind: MutationKind,
    /// The renderer's optimistic classification. Advisory only — the backend
    /// recomputes via [`classify_mutation`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apply_mode: Option<ApplyMode>,
    #[serde(default)]
    pub payload: serde_json::Value,
    pub created_at: String,
}

/// The lifecycle of a single applied attempt.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LiveEditStatus {
    /// Accepted and in progress (a warm swap that has not committed yet).
    Started,
    /// Committed: the revision advanced.
    Applied,
    /// Rejected or failed; the revision did not advance.
    Failed,
    /// Undone by a later revert.
    Reverted,
}

/// A recorded live-edit attempt, stored on the session timeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveEditEvent {
    pub id: String,
    pub session_id: String,
    pub mutation_id: String,
    pub revision_before: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_after: Option<u64>,
    pub apply_mode: ApplyMode,
    pub status: LiveEditStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub timestamp: String,
}

/// Runtime capture state for a source, separate from its configured settings.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceRuntimePhase {
    Idle,
    Starting,
    Live,
    Reconnecting,
    Failed,
    PermissionNeeded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRuntimeState {
    pub source_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub state: SourceRuntimePhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_frame_at: Option<String>,
}

/// Which outputs the active session is driving.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionMode {
    Idle,
    Recording,
    Streaming,
    RecordingStreaming,
}

impl SessionMode {
    /// Whether outputs are live (anything other than idle).
    pub fn is_active(self) -> bool {
        !matches!(self, SessionMode::Idle)
    }
}

/// A serializable snapshot of the active scene, shared with the renderer and stored
/// in session metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSceneState {
    pub session_id: String,
    pub scene_id: String,
    pub revision: u64,
    pub layout: LayoutSettings,
    pub sources: Vec<SceneSource>,
    pub outputs: Vec<SceneOutputKind>,
    pub mode: SessionMode,
    pub updated_at: String,
}

/// The decision returned by [`ActiveScene::apply`].
#[derive(Debug, Clone)]
pub struct LiveEditDecision {
    pub apply_mode: ApplyMode,
    /// Whether the mutation was accepted (false for a stale revision or a cold change
    /// during an active session).
    pub accepted: bool,
    /// Whether the committed revision advanced as a result.
    pub committed: bool,
    pub event: LiveEditEvent,
}

/// The backend-owned, mutable active scene. Tracks the committed revision and the
/// live-edit timeline. It does NOT execute scene/output changes itself — the LS2+
/// executor applies the payload and the revision contract here keeps preview and
/// outputs agreeing on a single committed revision.
#[derive(Debug, Clone)]
pub struct ActiveScene {
    state: ActiveSceneState,
    events: Vec<LiveEditEvent>,
    event_seq: u64,
}

impl ActiveScene {
    pub fn new(state: ActiveSceneState) -> Self {
        Self {
            state,
            events: Vec::new(),
            event_seq: 0,
        }
    }

    pub fn revision(&self) -> u64 {
        self.state.revision
    }

    pub fn mode(&self) -> SessionMode {
        self.state.mode
    }

    pub fn snapshot(&self) -> ActiveSceneState {
        self.state.clone()
    }

    pub fn events(&self) -> &[LiveEditEvent] {
        &self.events
    }

    /// Evaluates a mutation against the revision/classification contract and records
    /// the attempt:
    /// - a stale `expectedRevision` is rejected with a conflict (no revision change),
    /// - a cold change during an active session is rejected (`Applies next session`),
    /// - a hot change commits atomically (the committed revision advances now),
    /// - a warm change is accepted but pending (it commits later via
    ///   [`ActiveScene::commit_pending`] once the source swap succeeds),
    /// - a cold change while idle simply edits next-session config.
    ///
    /// The actual scene/output payload is applied by the executor (LS2+); this method
    /// owns only the revision contract and the timeline.
    pub fn apply(
        &mut self,
        mutation: &SceneMutation,
        ctx: &MutationContext,
        now: &str,
    ) -> LiveEditDecision {
        let revision_before = self.state.revision;
        let apply_mode = classify_mutation(mutation.kind, ctx);

        if mutation.expected_revision != revision_before {
            let event = self.record(
                mutation,
                apply_mode,
                LiveEditStatus::Failed,
                revision_before,
                None,
                Some(format!(
                    "revision conflict: scene is at {revision_before}, mutation expected {}",
                    mutation.expected_revision
                )),
                now,
            );
            return LiveEditDecision {
                apply_mode,
                accepted: false,
                committed: false,
                event,
            };
        }

        if apply_mode == ApplyMode::Cold && self.state.mode.is_active() {
            let event = self.record(
                mutation,
                apply_mode,
                LiveEditStatus::Failed,
                revision_before,
                None,
                Some("Applies next session".to_string()),
                now,
            );
            return LiveEditDecision {
                apply_mode,
                accepted: false,
                committed: false,
                event,
            };
        }

        match apply_mode {
            ApplyMode::Hot => {
                let revision_after = self.bump(now);
                let event = self.record(
                    mutation,
                    apply_mode,
                    LiveEditStatus::Applied,
                    revision_before,
                    Some(revision_after),
                    None,
                    now,
                );
                LiveEditDecision {
                    apply_mode,
                    accepted: true,
                    committed: true,
                    event,
                }
            }
            ApplyMode::Warm => {
                // Accepted, but the swap commits later once the replacement adapter is
                // ready. The committed revision does not advance yet.
                let event = self.record(
                    mutation,
                    apply_mode,
                    LiveEditStatus::Started,
                    revision_before,
                    None,
                    None,
                    now,
                );
                LiveEditDecision {
                    apply_mode,
                    accepted: true,
                    committed: false,
                    event,
                }
            }
            ApplyMode::Cold => {
                // Reached only while idle: edits next-session config, no live commit.
                let event = self.record(
                    mutation,
                    apply_mode,
                    LiveEditStatus::Applied,
                    revision_before,
                    None,
                    None,
                    now,
                );
                LiveEditDecision {
                    apply_mode,
                    accepted: true,
                    committed: false,
                    event,
                }
            }
        }
    }

    /// Commits a previously-accepted warm mutation once its source swap succeeded:
    /// advances the committed revision and records an `Applied` event. Returns the new
    /// revision.
    pub fn commit_pending(&mut self, mutation_id: &str, now: &str) -> u64 {
        let revision_before = self.state.revision;
        let revision_after = self.bump(now);
        let id = self.next_event_id();
        self.push_event(LiveEditEvent {
            id,
            session_id: self.state.session_id.clone(),
            mutation_id: mutation_id.to_string(),
            revision_before,
            revision_after: Some(revision_after),
            apply_mode: ApplyMode::Warm,
            status: LiveEditStatus::Applied,
            message: None,
            timestamp: now.to_string(),
        });
        revision_after
    }

    /// Rolls back a started warm mutation that failed during execution: records a
    /// `Failed` event and leaves the committed revision unchanged.
    pub fn fail_pending(&mut self, mutation_id: &str, message: &str, now: &str) {
        let revision_before = self.state.revision;
        let id = self.next_event_id();
        self.push_event(LiveEditEvent {
            id,
            session_id: self.state.session_id.clone(),
            mutation_id: mutation_id.to_string(),
            revision_before,
            revision_after: None,
            apply_mode: ApplyMode::Warm,
            status: LiveEditStatus::Failed,
            message: Some(message.to_string()),
            timestamp: now.to_string(),
        });
    }

    fn bump(&mut self, now: &str) -> u64 {
        self.state.revision += 1;
        self.state.updated_at = now.to_string();
        self.state.revision
    }

    #[allow(clippy::too_many_arguments)]
    fn record(
        &mut self,
        mutation: &SceneMutation,
        apply_mode: ApplyMode,
        status: LiveEditStatus,
        revision_before: u64,
        revision_after: Option<u64>,
        message: Option<String>,
        now: &str,
    ) -> LiveEditEvent {
        let id = self.next_event_id();
        let event = LiveEditEvent {
            id,
            session_id: self.state.session_id.clone(),
            mutation_id: mutation.id.clone(),
            revision_before,
            revision_after,
            apply_mode,
            status,
            message,
            timestamp: now.to_string(),
        };
        self.push_event(event.clone());
        event
    }

    fn push_event(&mut self, event: LiveEditEvent) {
        self.events.push(event);
    }

    fn next_event_id(&mut self) -> String {
        self.event_seq += 1;
        format!("live-edit-{}", self.event_seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::default_layout_settings;

    fn ctx(required_sources_active: bool) -> MutationContext {
        MutationContext {
            required_sources_active,
        }
    }

    fn mutation(kind: MutationKind, expected_revision: u64) -> SceneMutation {
        SceneMutation {
            id: format!("mut-{expected_revision}"),
            expected_revision,
            kind,
            apply_mode: None,
            payload: serde_json::Value::Null,
            created_at: "2026-06-02T00:00:00Z".to_string(),
        }
    }

    fn active_scene(mode: SessionMode) -> ActiveScene {
        ActiveScene::new(ActiveSceneState {
            session_id: "session-1".to_string(),
            scene_id: "scene:default".to_string(),
            revision: 0,
            layout: default_layout_settings(),
            sources: Vec::new(),
            outputs: vec![SceneOutputKind::Recording],
            mode,
            updated_at: "2026-06-02T00:00:00Z".to_string(),
        })
    }

    #[test]
    fn classifies_hot_warm_and_cold() {
        assert_eq!(
            classify_mutation(MutationKind::SourceTransformPatch, &ctx(true)),
            ApplyMode::Hot
        );
        assert_eq!(
            classify_mutation(MutationKind::SourceVisibilitySet, &ctx(true)),
            ApplyMode::Hot
        );
        assert_eq!(
            classify_mutation(MutationKind::OutputBitratePatch, &ctx(true)),
            ApplyMode::Hot
        );
        // A device switch always prepares a new adapter first.
        assert_eq!(
            classify_mutation(MutationKind::SourceDeviceSwitch, &ctx(true)),
            ApplyMode::Warm
        );
        // Resolution/FPS are next-session until LS7.
        assert_eq!(
            classify_mutation(MutationKind::OutputResolutionPatch, &ctx(true)),
            ApplyMode::Cold
        );
        assert_eq!(
            classify_mutation(MutationKind::OutputFpsPatch, &ctx(true)),
            ApplyMode::Cold
        );
    }

    #[test]
    fn preset_is_hot_when_sources_ready_warm_otherwise() {
        assert_eq!(
            classify_mutation(MutationKind::LayoutSetPreset, &ctx(true)),
            ApplyMode::Hot
        );
        assert_eq!(
            classify_mutation(MutationKind::LayoutSetPreset, &ctx(false)),
            ApplyMode::Warm
        );
    }

    #[test]
    fn rejects_stale_revision_without_advancing() {
        let mut scene = active_scene(SessionMode::Recording);
        // Advance to revision 1 with a valid hot edit.
        scene.apply(
            &mutation(MutationKind::SourceTransformPatch, 0),
            &ctx(true),
            "t1",
        );
        assert_eq!(scene.revision(), 1);

        // A mutation that still expects revision 0 is stale.
        let decision = scene.apply(
            &mutation(MutationKind::SourceTransformPatch, 0),
            &ctx(true),
            "t2",
        );
        assert!(!decision.accepted);
        assert_eq!(decision.event.status, LiveEditStatus::Failed);
        assert!(
            decision
                .event
                .message
                .as_deref()
                .unwrap()
                .contains("conflict")
        );
        assert_eq!(
            scene.revision(),
            1,
            "stale mutation must not advance revision"
        );
    }

    #[test]
    fn hot_edit_commits_and_advances_revision() {
        let mut scene = active_scene(SessionMode::Streaming);
        let decision = scene.apply(
            &mutation(MutationKind::SourceVisibilitySet, 0),
            &ctx(true),
            "t1",
        );
        assert!(decision.accepted && decision.committed);
        assert_eq!(decision.apply_mode, ApplyMode::Hot);
        assert_eq!(decision.event.status, LiveEditStatus::Applied);
        assert_eq!(decision.event.revision_after, Some(1));
        assert_eq!(scene.revision(), 1);
    }

    #[test]
    fn cold_edit_is_rejected_during_active_session() {
        let mut scene = active_scene(SessionMode::Recording);
        let decision = scene.apply(
            &mutation(MutationKind::OutputResolutionPatch, 0),
            &ctx(true),
            "t1",
        );
        assert!(!decision.accepted);
        assert_eq!(decision.apply_mode, ApplyMode::Cold);
        assert_eq!(decision.event.status, LiveEditStatus::Failed);
        assert_eq!(
            decision.event.message.as_deref(),
            Some("Applies next session")
        );
        assert_eq!(scene.revision(), 0);
    }

    #[test]
    fn cold_edit_is_allowed_while_idle() {
        let mut scene = active_scene(SessionMode::Idle);
        let decision = scene.apply(&mutation(MutationKind::OutputFpsPatch, 0), &ctx(true), "t1");
        assert!(decision.accepted);
        assert!(
            !decision.committed,
            "cold config edit does not bump the live revision"
        );
        assert_eq!(decision.event.status, LiveEditStatus::Applied);
        assert_eq!(scene.revision(), 0);
    }

    #[test]
    fn warm_edit_starts_pending_then_commits_or_rolls_back() {
        let mut scene = active_scene(SessionMode::Streaming);
        let decision = scene.apply(
            &mutation(MutationKind::SourceDeviceSwitch, 0),
            &ctx(true),
            "t1",
        );
        assert!(decision.accepted);
        assert!(
            !decision.committed,
            "warm swap is not committed until the source is ready"
        );
        assert_eq!(decision.event.status, LiveEditStatus::Started);
        assert_eq!(scene.revision(), 0);

        // The replacement source becomes ready (LS5) → commit.
        let revision = scene.commit_pending("mut-0", "t2");
        assert_eq!(revision, 1);
        assert_eq!(scene.revision(), 1);
        assert_eq!(
            scene.events().last().unwrap().status,
            LiveEditStatus::Applied
        );

        // A second warm switch that fails leaves the revision untouched.
        scene.apply(
            &mutation(MutationKind::SourceDeviceSwitch, 1),
            &ctx(true),
            "t3",
        );
        scene.fail_pending("mut-1", "camera unavailable", "t4");
        assert_eq!(scene.revision(), 1);
        let last = scene.events().last().unwrap();
        assert_eq!(last.status, LiveEditStatus::Failed);
        assert_eq!(last.message.as_deref(), Some("camera unavailable"));
    }

    #[test]
    fn records_every_attempt_on_the_timeline() {
        let mut scene = active_scene(SessionMode::Recording);
        scene.apply(
            &mutation(MutationKind::SourceTransformPatch, 0),
            &ctx(true),
            "t1",
        );
        scene.apply(
            &mutation(MutationKind::OutputResolutionPatch, 1),
            &ctx(true),
            "t2",
        );
        scene.apply(
            &mutation(MutationKind::SourceTransformPatch, 99),
            &ctx(true),
            "t3",
        );
        // applied + rejected-cold + rejected-conflict are all on the timeline.
        assert_eq!(scene.events().len(), 3);
        assert!(scene.events().iter().all(|e| e.session_id == "session-1"));
    }

    #[test]
    fn round_trips_through_camel_case_json() {
        let event = LiveEditEvent {
            id: "live-edit-1".to_string(),
            session_id: "session-1".to_string(),
            mutation_id: "mut-0".to_string(),
            revision_before: 0,
            revision_after: Some(1),
            apply_mode: ApplyMode::Hot,
            status: LiveEditStatus::Applied,
            message: None,
            timestamp: "t1".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"revisionAfter\":1"));
        assert!(json.contains("\"applyMode\":\"hot\""));
        assert!(json.contains("\"status\":\"applied\""));
        let restored: LiveEditEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, event);

        let mutation = mutation(MutationKind::OutputBitratePatch, 3);
        let json = serde_json::to_string(&mutation).unwrap();
        assert!(json.contains("\"kind\":\"output.bitrate.patch\""));
        assert!(json.contains("\"expectedRevision\":3"));
    }
}
