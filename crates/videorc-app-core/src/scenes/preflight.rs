//! Plan 210 S3: the strict check before a saved scene goes on stream
//! (`lib/scene-apply-preflight.ts`), without a fresh `devices.list` round
//! trip per switch: a source turned off on purpose refuses at once, a
//! source in the held list is proven, and only a chosen source missing from
//! the held list asks for one fresh list. An app scene's window is the
//! resolver's word and is not judged again here.

use std::future::Future;

use serde_json::{Value, json};
use videorc_protocol::Device;

use super::model::{GapState, scene_source_gaps, scene_source_problems};

/// `Saved background unavailable…`: the refusal for a background that is no
/// longer on disk.
pub const BACKGROUND_UNAVAILABLE: &str =
    "Saved background unavailable. Resolve it or apply without background.";

/// `ScenePreflightJudgement`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Judgement {
    Proven,
    Refetch,
    Refused(Vec<&'static str>),
}

/// The visual with the scene's app, as the judgement reads it.
fn judged(visual: &Value, scene_app: Option<&Value>) -> Value {
    let mut judged = visual.clone();
    if let Some(app) = scene_app
        && let Some(Value::Object(sources)) = judged.get_mut("sources")
    {
        sources.insert("app".into(), app.clone());
    }
    judged
}

/// `judgeSceneSources`.
pub fn judge_scene_sources(
    visual: &Value,
    devices: &[Device],
    scene_app: Option<&Value>,
) -> Judgement {
    let judged = judged(visual, scene_app);
    let gaps = scene_source_gaps(&judged, devices);
    if gaps.is_empty() {
        return Judgement::Proven;
    }
    if gaps.iter().any(|gap| gap.state == GapState::Off) {
        return Judgement::Refused(scene_source_problems(&judged, devices));
    }
    Judgement::Refetch
}

/// `SavedScenePreflightResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightResult {
    /// What refuses the switch, in the order it is said.
    pub issues: Vec<&'static str>,
    /// Whether a fresh `devices.list` was needed.
    pub refetched: bool,
}

/// `runSavedScenePreflight`: the device judgement and the background check
/// side by side; neither waits behind the other. A failed list or check
/// counts as missing.
pub async fn run_saved_scene_preflight<L, B>(
    visual: &Value,
    scene_app: Option<&Value>,
    devices: &[Device],
    list_devices: L,
    background_exists: Option<B>,
) -> PreflightResult
where
    L: Future<Output = Option<Vec<Device>>>,
    B: Future<Output = bool>,
{
    let background = async {
        match background_exists {
            Some(check) => {
                if check.await {
                    Vec::new()
                } else {
                    vec![BACKGROUND_UNAVAILABLE]
                }
            }
            None => Vec::new(),
        }
    };
    let sources = async {
        match judge_scene_sources(visual, devices, scene_app) {
            Judgement::Proven => (Vec::new(), false),
            Judgement::Refused(issues) => (issues, false),
            Judgement::Refetch => {
                let fresh = list_devices.await.unwrap_or_default();
                match judge_scene_sources(visual, &fresh, scene_app) {
                    Judgement::Proven => (Vec::new(), true),
                    _ => (
                        scene_source_problems(&judged(visual, scene_app), &fresh),
                        true,
                    ),
                }
            }
        }
    };
    let ((mut issues, refetched), background) = tokio::join!(sources, background);
    issues.extend(background);
    PreflightResult { issues, refetched }
}

/// The visual a commit's preflight judges: the commit's layout, its sources
/// as in use without the app, and its background.
pub fn preflight_visual(layout: &Value, sources: &Value, background: Option<&Value>) -> Value {
    let mut sources = super::model::using_visual_sources(sources);
    if let Value::Object(map) = &mut sources {
        map.remove("app");
    }
    json!({
        "layout": layout,
        "sources": sources,
        "background": super::background::snapshot_background(background),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use videorc_protocol::{DeviceKind, DeviceStatus};

    fn device(id: &str, kind: DeviceKind) -> Device {
        Device {
            app: None,
            window_title: None,
            display_uuid: None,
            id: id.into(),
            name: id.into(),
            kind,
            status: DeviceStatus::Available,
            detail: None,
            width: None,
            height: None,
        }
    }

    fn visual(sources: Value) -> Value {
        json!({"layout": {"layoutPreset": "screen-camera", "arrangementMode": "preset"}, "sources": sources, "background": null})
    }

    #[test]
    fn the_held_list_proves_refuses_or_asks_again() {
        let devices = vec![
            device("screen:1", DeviceKind::Screen),
            device("camera:1", DeviceKind::Camera),
        ];
        assert_eq!(
            judge_scene_sources(
                &visual(json!({"screenId": "screen:1", "cameraId": "camera:1"})),
                &devices,
                None
            ),
            Judgement::Proven
        );
        assert_eq!(
            judge_scene_sources(
                &visual(json!({"screenId": "screen:1", "cameraOff": true})),
                &devices,
                None
            ),
            Judgement::Refused(vec![super::super::model::CAMERA_OFF_PROBLEM])
        );
        assert_eq!(
            judge_scene_sources(
                &visual(json!({"screenId": "screen:1", "cameraId": "camera:2"})),
                &devices,
                None
            ),
            Judgement::Refetch
        );
        // An app scene's window is the resolver's: only the camera counts.
        assert_eq!(
            judge_scene_sources(
                &visual(json!({"cameraId": "camera:1"})),
                &devices,
                Some(&json!({"bundleId": "com.figma.Desktop", "name": "Figma", "follows": true}))
            ),
            Judgement::Proven
        );
    }

    #[tokio::test]
    async fn one_fresh_list_and_the_background_run_side_by_side() {
        let devices = vec![device("screen:1", DeviceKind::Screen)];
        let lists = AtomicUsize::new(0);
        let fresh = vec![
            device("screen:1", DeviceKind::Screen),
            device("camera:2", DeviceKind::Camera),
        ];
        let result = run_saved_scene_preflight(
            &visual(json!({"screenId": "screen:1", "cameraId": "camera:2"})),
            None,
            &devices,
            async {
                lists.fetch_add(1, Ordering::SeqCst);
                Some(fresh.clone())
            },
            Some(async { false }),
        )
        .await;
        assert_eq!(lists.load(Ordering::SeqCst), 1);
        assert_eq!(result.issues, vec![BACKGROUND_UNAVAILABLE]);
        assert!(result.refetched);
        let proven = run_saved_scene_preflight(
            &visual(json!({"screenId": "screen:1", "cameraId": "camera:2"})),
            None,
            &fresh,
            async { panic!("never listed when proven") },
            None::<std::future::Ready<bool>>,
        )
        .await;
        assert_eq!(
            proven,
            PreflightResult {
                issues: vec![],
                refetched: false
            }
        );
        let still_missing = run_saved_scene_preflight(
            &visual(json!({"screenId": "screen:1", "cameraId": "camera:3"})),
            None,
            &devices,
            async { Some(devices.clone()) },
            None::<std::future::Ready<bool>>,
        )
        .await;
        assert_eq!(
            still_missing.issues,
            vec![super::super::model::CAMERA_GONE_PROBLEM]
        );
    }
}
