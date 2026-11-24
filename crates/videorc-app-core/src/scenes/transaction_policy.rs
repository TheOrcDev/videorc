//! The layout transaction's policy (`lib/layout-transaction-policy.ts`) and
//! the scene evidence a failed transaction is judged by (`use-studio.tsx`'s
//! `requestedLayoutTransactionScene` and `backendLayoutTransactionScene`).
//!
//! - A commit is applied after its proof, and only while it is the latest
//!   switch ([`layout_transaction_proof_disposition`]); a missed preview
//!   presentation is a warning, a missed output proof an error
//!   ([`ProofMiss`]).
//! - A latest switch whose request failed reconciles to the backend's truth
//!   (`scene.get`, `compositor.status`, `scene.get`, stable across the
//!   reads), or else to the last commit
//!   ([`layout_transaction_failure_reconciliation`]). Only an
//!   outcome-unknown failure whose scene the backend shows at a newer
//!   revision counts as committed ([`layout_transaction_failure_disposition`]).
//!
//! Pure. `isSceneReloadSuperseded` and its retry delay are in
//! `studio::scene_switch`; `liveBackgroundCommitDecision` and
//! `shouldReloadSceneFromCaptureConfig` belong to the backgrounds port and
//! the preview feed's idle reload.

use serde_json::{Map, Value, json};

use crate::client::codes::REQUEST_OUTCOME_UNKNOWN;
use crate::studio::js_value::{canonical_eq, get, string, truthy};

/// `LayoutTransactionProofDisposition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofDisposition {
    /// A newer switch was asked for: this commit never reaches the controls.
    IgnoreStale,
    ApplyProven,
    /// The backend's commit is the truth even when its proof missed.
    ApplyUnproven,
}

/// `layoutTransactionProofDisposition`.
pub fn layout_transaction_proof_disposition(
    latest_intent_id: u64,
    committed_intent_id: u64,
    proof_succeeded: bool,
) -> ProofDisposition {
    if latest_intent_id != committed_intent_id {
        ProofDisposition::IgnoreStale
    } else if proof_succeeded {
        ProofDisposition::ApplyProven
    } else {
        ProofDisposition::ApplyUnproven
    }
}

/// `idlePreviewLayoutProofRequired`: an idle commit waits for the preview
/// only when the preview can present a frame.
pub fn idle_preview_layout_proof_required(surface_can_present: bool) -> bool {
    surface_can_present
}

/// Why a commit's proof missed: the session's output never showed it (the
/// renderer's plain `Error`), or only the preview's presented revision
/// (`NativePreviewPresentationProofError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofMiss {
    Output,
    Presentation,
}

/// `LayoutTransactionUnprovenSeverity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnprovenSeverity {
    OutputError,
    PresentationWarning,
}

/// `layoutTransactionUnprovenSeverity`: a preview-only miss is a warning;
/// anything else (no miss named included) is an output error.
pub fn layout_transaction_unproven_severity(miss: Option<ProofMiss>) -> UnprovenSeverity {
    match miss {
        Some(ProofMiss::Presentation) => UnprovenSeverity::PresentationWarning,
        _ => UnprovenSeverity::OutputError,
    }
}

/// `LayoutTransactionFailureDisposition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureDisposition {
    RequestedSceneApplied,
    BackendSceneDifferent,
    BackendTruthUnavailable,
    TerminalEvidenceUnavailable,
    DefinitelyNotApplied,
}

/// `layoutTransactionFailureDisposition`: only a post-send outcome-unknown
/// failure is eligible for reconciliation. A stable scene read must both
/// advance beyond the pre-command revision and exactly match every
/// observable part of the requested scene (`semanticJsonEqual`: key order
/// is not content).
pub fn layout_transaction_failure_disposition(
    failure_code: Option<&str>,
    scene_revision_before_request: Option<u64>,
    requested_scene: &Value,
    backend_truth: Option<(u64, &Value)>,
) -> FailureDisposition {
    if failure_code != Some(REQUEST_OUTCOME_UNKNOWN) {
        return FailureDisposition::DefinitelyNotApplied;
    }
    let Some((revision, scene)) = backend_truth else {
        return FailureDisposition::BackendTruthUnavailable;
    };
    match scene_revision_before_request {
        Some(before) if revision > before => {}
        _ => return FailureDisposition::TerminalEvidenceUnavailable,
    }
    if canonical_eq(requested_scene, scene) {
        FailureDisposition::RequestedSceneApplied
    } else {
        FailureDisposition::BackendSceneDifferent
    }
}

/// `latestLayoutTransactionCommit`: a late older commit never replaces a
/// newer backend checkpoint (by scene revision; a tie takes the candidate).
pub fn latest_layout_transaction_commit<T>(
    current: Option<T>,
    candidate: T,
    revision: impl Fn(&T) -> u64,
) -> T {
    match current {
        Some(current) if revision(&current) > revision(&candidate) => current,
        _ => candidate,
    }
}

/// Where a failed switch's reconciliation came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconciliationSource {
    BackendTruth,
    LatestCommit,
}

/// `layoutTransactionFailureReconciliation`: a failed latest switch takes
/// the backend's truth, else the last commit; a failed switch a newer one
/// took over takes nothing.
pub fn layout_transaction_failure_reconciliation<T>(
    latest_intent_id: u64,
    failed_intent_id: u64,
    backend_truth: Option<T>,
    latest_commit: Option<T>,
) -> Option<(ReconciliationSource, T)> {
    if latest_intent_id != failed_intent_id {
        return None;
    }
    if let Some(truth) = backend_truth {
        return Some((ReconciliationSource::BackendTruth, truth));
    }
    latest_commit.map(|commit| (ReconciliationSource::LatestCommit, commit))
}

/// `layoutTransactionBackendSnapshotIsStable`: the same scene, with the same
/// content, surrounded the compositor's status read (a commit reuses the
/// scene id, so the id alone proves nothing).
pub fn layout_transaction_backend_snapshot_is_stable(
    scene_before: &Value,
    compositor_scene_id: Option<&str>,
    scene_after: &Value,
) -> bool {
    let id = |scene: &Value| string(scene.get("id")).map(str::to_string);
    let after_id = id(scene_after);
    if id(scene_before) != after_id
        || compositor_scene_id.is_some_and(|compositor| Some(compositor) != after_id.as_deref())
    {
        return false;
    }
    scene_before == scene_after
}

/// `layoutTransactionSourcesFromScene` (plan 212 S2): the capture selection
/// a transaction adopts from the backend's scene sources. A test pattern is
/// adopted in a dev build only.
pub fn layout_transaction_sources_from_scene(
    current: &Value,
    scene_sources: &[Value],
    packaged: bool,
) -> Value {
    let mut sources = current.as_object().cloned().unwrap_or_default();
    let name_for = |sources: &Map<String, Value>, id_key: &str, name_key: &str, source: &Value| {
        let same = sources.get(id_key) == source.get("deviceId");
        match (same, sources.get(name_key)) {
            (true, Some(name)) if !name.is_null() => name.clone(),
            _ => source.get("name").cloned().unwrap_or(Value::Null),
        }
    };
    let set = |sources: &mut Map<String, Value>, key: &str, value: Option<Value>| match value {
        Some(value) if !value.is_null() => {
            sources.insert(key.into(), value);
        }
        _ => {
            sources.remove(key);
        }
    };
    for source in scene_sources {
        let device = source.get("deviceId").cloned();
        match string(source.get("kind")) {
            Some("camera") => {
                let name = name_for(&sources, "cameraId", "cameraName", source);
                set(&mut sources, "cameraName", Some(name));
                set(&mut sources, "cameraId", device);
            }
            Some("screen") => {
                let name = name_for(&sources, "screenId", "screenName", source);
                set(&mut sources, "screenName", Some(name));
                // Plan 213 F1: another display's UUID would find that one.
                if sources.get("screenId") != source.get("deviceId") {
                    sources.remove("screenUuid");
                }
                set(&mut sources, "screenId", device);
                sources.remove("windowId");
                sources.remove("windowName");
                sources.insert("testPattern".into(), json!(false));
            }
            Some("window") => {
                let name = name_for(&sources, "windowId", "windowName", source);
                set(&mut sources, "windowName", Some(name));
                set(&mut sources, "windowId", device);
                sources.remove("screenId");
                sources.remove("screenName");
                sources.remove("screenUuid");
                sources.insert("testPattern".into(), json!(false));
            }
            Some("test-pattern") if !packaged => {
                sources.remove("screenId");
                sources.remove("screenUuid");
                sources.remove("windowId");
                sources.insert("testPattern".into(), json!(true));
            }
            _ => {}
        }
    }
    Value::Object(sources)
}

/// `selectedBaseSourceEvidence`.
fn base_source_evidence(sources: &Value) -> Value {
    if let Some(window) = string(sources.get("windowId")).filter(|id| !id.is_empty()) {
        json!({"kind": "window", "deviceId": window})
    } else if let Some(screen) = string(sources.get("screenId")).filter(|id| !id.is_empty()) {
        json!({"kind": "screen", "deviceId": screen})
    } else if truthy(sources.get("testPattern")) {
        json!({"kind": "test-pattern", "deviceId": null})
    } else {
        json!({"kind": "screen", "deviceId": null})
    }
}

/// `requestedLayoutTransactionSources`: the sources the backend will draw
/// for this layout and selection.
fn requested_sources(layout: &Value, sources: &Value) -> Vec<Value> {
    let base = base_source_evidence(sources);
    let camera = string(sources.get("cameraId"))
        .filter(|id| !id.is_empty())
        .map(|id| json!({"kind": "camera", "deviceId": id}));
    let preset = string(layout.get("layoutPreset")).unwrap_or_default();
    match preset {
        "camera-only" | "vertical-camera-only" => vec![camera.unwrap_or(base)],
        "screen-only" | "vertical-screen-only" => vec![base],
        "vertical-screen-camera"
            if !truthy(sources.get("windowId"))
                && !truthy(sources.get("screenId"))
                && !truthy(sources.get("testPattern"))
                && camera.is_some() =>
        {
            vec![camera.expect("checked")]
        }
        _ => match camera {
            Some(camera) => vec![base, camera],
            None => vec![base],
        },
    }
}

/// `requestedLayoutTransactionScene`: the scene a transaction asks for, as
/// it can be compared with the backend's (`LayoutTransactionSceneEvidence`).
pub fn requested_transaction_scene(
    layout: &Value,
    sources: &Value,
    video: &Value,
    background: Option<&Value>,
) -> Value {
    let visibility = layout.get("sourceVisibility");
    let evidence: Vec<Value> = requested_sources(layout, sources)
        .into_iter()
        .map(|mut source| {
            let key = if source["kind"] == "camera" {
                "camera"
            } else {
                "capture"
            };
            source["visible"] = json!(get(visibility, key) != Some(&Value::Bool(false)));
            source
        })
        .collect();
    let video = if video.is_object() {
        json!({
            "width": video.get("width").cloned().unwrap_or(Value::Null),
            "height": video.get("height").cloned().unwrap_or(Value::Null),
            "fps": video.get("fps").cloned().unwrap_or(Value::Null),
        })
    } else {
        Value::Null
    };
    json!({
        "layout": layout,
        "sources": evidence,
        "video": video,
        "background": background.cloned().unwrap_or(Value::Null),
    })
}

/// `backendLayoutTransactionScene`: the backend's scene (`scene.get`) under
/// its compositor's layout, as [`requested_transaction_scene`] reads.
pub fn backend_transaction_scene(layout: &Value, scene: &Value) -> Value {
    let sources: Vec<Value> = scene
        .get("sources")
        .and_then(Value::as_array)
        .map(|sources| {
            sources
                .iter()
                .map(|source| {
                    json!({
                        "kind": source.get("kind").cloned().unwrap_or(Value::Null),
                        "deviceId": source.get("deviceId").cloned().unwrap_or(Value::Null),
                        "visible": source.get("visible").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let output = scene
        .get("outputs")
        .and_then(Value::as_array)
        .and_then(|outputs| {
            outputs
                .iter()
                .find(|output| output.get("kind") == Some(&json!("recording")))
        });
    let video = match output {
        Some(output) => json!({
            "width": output.get("width").cloned().unwrap_or(Value::Null),
            "height": output.get("height").cloned().unwrap_or(Value::Null),
            "fps": output.get("fps").cloned().unwrap_or(Value::Null),
        }),
        None => Value::Null,
    };
    json!({
        "layout": layout,
        "sources": sources,
        "video": video,
        "background": scene.get("background").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // `layout-transaction-policy.test.ts`.

    #[test]
    fn requires_idle_preview_proof_only_when_a_detached_preview_can_present() {
        assert!(!idle_preview_layout_proof_required(false));
        assert!(idle_preview_layout_proof_required(true));
    }

    #[test]
    fn a_current_commit_applies_proven_or_unproven_and_an_older_one_never() {
        assert_eq!(
            layout_transaction_proof_disposition(42, 42, false),
            ProofDisposition::ApplyUnproven
        );
        assert_eq!(
            layout_transaction_proof_disposition(42, 42, true),
            ProofDisposition::ApplyProven
        );
        assert_eq!(
            layout_transaction_proof_disposition(43, 42, false),
            ProofDisposition::IgnoreStale
        );
    }

    #[test]
    fn a_preview_only_miss_is_a_warning_and_an_output_miss_an_error() {
        assert_eq!(
            layout_transaction_unproven_severity(Some(ProofMiss::Presentation)),
            UnprovenSeverity::PresentationWarning
        );
        assert_eq!(
            layout_transaction_unproven_severity(Some(ProofMiss::Output)),
            UnprovenSeverity::OutputError
        );
        assert_eq!(
            layout_transaction_unproven_severity(None),
            UnprovenSeverity::OutputError
        );
    }

    #[test]
    fn reconciles_commit_a_when_superseding_intent_b_fails() {
        let committed_a = json!({"intentId": 42, "sceneRevision": 7, "scene": "scene-a"});
        assert_eq!(
            layout_transaction_proof_disposition(43, 42, true),
            ProofDisposition::IgnoreStale
        );
        assert_eq!(
            layout_transaction_failure_reconciliation(43, 43, None, Some(committed_a.clone())),
            Some((ReconciliationSource::LatestCommit, committed_a))
        );
    }

    #[test]
    fn a_late_older_commit_never_replaces_a_newer_checkpoint() {
        let revision = |value: &Value| value["sceneRevision"].as_u64().unwrap();
        let a = json!({"sceneRevision": 7, "scene": "scene-a"});
        let b = json!({"sceneRevision": 8, "scene": "scene-b"});
        assert_eq!(
            latest_layout_transaction_commit(Some(b.clone()), a.clone(), revision),
            b
        );
        assert_eq!(
            latest_layout_transaction_commit(Some(a), b.clone(), revision),
            b
        );
    }

    #[test]
    fn prefers_freshly_read_backend_truth_over_the_checkpoint() {
        let a = json!({"sceneRevision": 7, "scene": "scene-a"});
        let truth = json!({"sceneRevision": 8, "scene": "scene-b"});
        assert_eq!(
            layout_transaction_failure_reconciliation(43, 43, Some(truth.clone()), Some(a)),
            Some((ReconciliationSource::BackendTruth, truth))
        );
    }

    #[test]
    fn ignores_a_failed_intent_once_a_newer_one_exists() {
        assert_eq!(
            layout_transaction_failure_reconciliation(
                44,
                43,
                Some(json!({"sceneRevision": 8})),
                Some(json!({"sceneRevision": 7}))
            ),
            None
        );
    }

    fn requested() -> Value {
        json!({
            "layout": {"layoutPreset": "screen-camera", "camera": {"corner": "bottom-right", "size": 30}},
            "sources": [
                {"kind": "screen", "deviceId": "screen-1"},
                {"kind": "camera", "deviceId": "camera-1"}
            ],
            "video": {"width": 1920, "height": 1080, "fps": 30},
            "background": {"assetId": "background-1"}
        })
    }

    #[test]
    fn requires_outcome_unknown_a_newer_revision_and_full_scene_equivalence() {
        let requested = requested();
        // Key order reversed: semantic equality ignores it.
        let reversed = json!({
            "background": {"assetId": "background-1"},
            "video": {"fps": 30, "height": 1080, "width": 1920},
            "sources": [
                {"deviceId": "screen-1", "kind": "screen"},
                {"deviceId": "camera-1", "kind": "camera"}
            ],
            "layout": {"camera": {"size": 30, "corner": "bottom-right"}, "layoutPreset": "screen-camera"}
        });
        let unknown = Some("request-outcome-unknown");
        assert_eq!(
            layout_transaction_failure_disposition(
                unknown,
                Some(7),
                &requested,
                Some((8, &reversed))
            ),
            FailureDisposition::RequestedSceneApplied
        );
        let mut other = requested.clone();
        other["background"] = json!({"assetId": "background-2"});
        assert_eq!(
            layout_transaction_failure_disposition(unknown, Some(7), &requested, Some((8, &other))),
            FailureDisposition::BackendSceneDifferent
        );
        assert_eq!(
            layout_transaction_failure_disposition(unknown, Some(7), &requested, None),
            FailureDisposition::BackendTruthUnavailable
        );
    }

    #[test]
    fn never_treats_definitely_not_applied_commands_as_success() {
        let requested = json!({
            "layout": {"layoutPreset": "screen-only"},
            "sources": [{"kind": "screen", "deviceId": "screen-new"}],
            "video": {"width": 1920, "height": 1080, "fps": 30},
            "background": {"assetId": "background-new"}
        });
        let mut old_screen = requested.clone();
        old_screen["sources"] = json!([{"kind": "screen", "deviceId": "screen-old"}]);
        let mut old_background = requested.clone();
        old_background["background"] = json!({"assetId": "background-old"});
        for scene in [old_screen, old_background] {
            assert_eq!(
                layout_transaction_failure_disposition(
                    Some("command-expired-before-dispatch"),
                    Some(7),
                    &requested,
                    Some((7, &scene))
                ),
                FailureDisposition::DefinitelyNotApplied
            );
        }
    }

    #[test]
    fn never_infers_success_without_a_newer_revision() {
        let scene = json!({
            "layout": {"layoutPreset": "screen-only"},
            "sources": [{"kind": "screen", "deviceId": "screen-1"}],
            "video": {"width": 1920, "height": 1080, "fps": 30},
            "background": null
        });
        let unknown = Some("request-outcome-unknown");
        assert_eq!(
            layout_transaction_failure_disposition(unknown, Some(7), &scene, Some((7, &scene))),
            FailureDisposition::TerminalEvidenceUnavailable
        );
        assert_eq!(
            layout_transaction_failure_disposition(unknown, None, &scene, Some((8, &scene))),
            FailureDisposition::TerminalEvidenceUnavailable,
            "no baseline revision proves nothing"
        );
    }

    #[test]
    fn backend_truth_must_be_stable_across_the_compositor_read() {
        assert!(!layout_transaction_backend_snapshot_is_stable(
            &json!({"id": "program", "sources": ["camera"]}),
            Some("program"),
            &json!({"id": "program", "sources": ["screen"]}),
        ));
        assert!(layout_transaction_backend_snapshot_is_stable(
            &json!({"id": "program", "sources": ["camera"]}),
            Some("program"),
            &json!({"id": "program", "sources": ["camera"]}),
        ));
        assert!(!layout_transaction_backend_snapshot_is_stable(
            &json!({"id": "program"}),
            Some("other"),
            &json!({"id": "program"}),
        ));
    }

    fn current() -> Value {
        json!({
            "cameraId": "cam-1", "cameraName": "FaceTime",
            "screenId": "screen-1", "screenName": "Display 1",
            "testPattern": false
        })
    }

    #[test]
    fn adopts_a_test_pattern_source_in_a_dev_build() {
        let scene = [
            json!({"kind": "camera", "deviceId": "cam-1", "name": "FaceTime"}),
            json!({"kind": "test-pattern", "name": "Test pattern"}),
        ];
        assert_eq!(
            layout_transaction_sources_from_scene(&current(), &scene, false),
            json!({
                "cameraId": "cam-1", "cameraName": "FaceTime",
                "screenName": "Display 1", "testPattern": true
            })
        );
    }

    #[test]
    fn ignores_a_test_pattern_in_the_packaged_app_and_keeps_the_screen() {
        let scene = [
            json!({"kind": "camera", "deviceId": "cam-1", "name": "FaceTime"}),
            json!({"kind": "test-pattern", "name": "Test pattern"}),
        ];
        assert_eq!(
            layout_transaction_sources_from_scene(&current(), &scene, true),
            current()
        );
        let display = [json!({"kind": "screen", "deviceId": "screen-2", "name": "Display 2"})];
        assert_eq!(
            layout_transaction_sources_from_scene(&current(), &display, true),
            json!({
                "cameraId": "cam-1", "cameraName": "FaceTime",
                "screenId": "screen-2", "screenName": "Display 2",
                "testPattern": false
            })
        );
    }

    #[test]
    fn the_requested_scene_names_what_the_layout_draws() {
        let sources = json!({"cameraId": "cam", "screenId": "screen:1"});
        let video = json!({"width": 1920, "height": 1080, "fps": 30, "bitrateKbps": 6000});
        let camera_only = requested_transaction_scene(
            &json!({"layoutPreset": "camera-only"}),
            &sources,
            &video,
            None,
        );
        assert_eq!(
            camera_only["sources"],
            json!([{"kind": "camera", "deviceId": "cam", "visible": true}])
        );
        assert_eq!(
            camera_only["video"],
            json!({"width": 1920, "height": 1080, "fps": 30})
        );
        assert_eq!(camera_only["background"], Value::Null);
        let hidden = requested_transaction_scene(
            &json!({"layoutPreset": "screen-camera", "sourceVisibility": {"camera": false}}),
            &sources,
            &video,
            None,
        );
        assert_eq!(
            hidden["sources"],
            json!([
                {"kind": "screen", "deviceId": "screen:1", "visible": true},
                {"kind": "camera", "deviceId": "cam", "visible": false}
            ])
        );
        let no_capture = requested_transaction_scene(
            &json!({"layoutPreset": "vertical-screen-camera"}),
            &json!({"cameraId": "cam"}),
            &video,
            None,
        );
        assert_eq!(
            no_capture["sources"],
            json!([{"kind": "camera", "deviceId": "cam", "visible": true}])
        );
        // The backend's own scene reads the same way.
        let backend = backend_transaction_scene(
            &json!({"layoutPreset": "camera-only"}),
            &json!({
                "id": "program",
                "sources": [{"id": "c", "kind": "camera", "deviceId": "cam", "visible": true, "name": "Cam"}],
                "outputs": [{"kind": "recording", "width": 1920, "height": 1080, "fps": 30}]
            }),
        );
        assert!(canonical_eq(&backend, &camera_only));
    }
}
