//! Scenes made for an app (plan 210 D1, D5): the window such a scene shows
//! is found when it goes on (`lib/scene-window-state.ts`,
//! `lib/scene-window-resolution.ts`, `lib/scene-apps.ts`'s
//! `resolveSceneWindow`). The device list the Studio holds answers when it
//! lists the scene's remembered window under its app; anything it can't
//! answer asks the backend's resolver (`sources.resolve_app_window`).

use serde_json::{Value, json};
use videorc_protocol::{Device, DeviceKind, DeviceStatus};

use super::model::{SavedScene, normalize_scene_app, visual_sources};
use crate::studio::js_value::{get, string, truthy};

/// `SCENE_WINDOW_APPS_KEY`: each scene's app, device memory kept apart from
/// the scene.
pub const SCENE_WINDOW_APPS_KEY: &str = "videorc.scene-window-apps.v1";

/// The backend resolver's floor for a normal window (D1).
pub const SCENE_APP_WINDOW_MIN_WIDTH: u32 = 400;
pub const SCENE_APP_WINDOW_MIN_HEIGHT: u32 = 300;

/// `AppWindowFailure`: why an app scene can't go on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppWindowFailure {
    NotRunning,
    NoWindow,
    Minimized,
}

impl AppWindowFailure {
    /// The resolver's word (`not-running`, …).
    pub fn parse(reason: &str) -> Option<Self> {
        match reason {
            "not-running" => Some(Self::NotRunning),
            "no-window" => Some(Self::NoWindow),
            "minimized" => Some(Self::Minimized),
            _ => None,
        }
    }
}

/// `appWindowFailureCopy`: "Figma isn't open".
pub fn app_window_failure_copy(name: &str, failure: AppWindowFailure) -> String {
    match failure {
        AppWindowFailure::NotRunning => format!("{name} isn't open"),
        AppWindowFailure::NoWindow => format!("{name} has no window open"),
        AppWindowFailure::Minimized => format!("{name}'s window is minimized"),
    }
}

/// `SceneAppState`: an app scene's state for the gallery and the keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneAppState {
    Ready,
    Failed(AppWindowFailure),
}

/// `RememberedSceneApps`: each scene's app (scene id, bundle id), oldest
/// first. Electron keeps it as a JSON object whose key order is the order
/// the scenes went on, and caps it at the newest 200, so the order is read
/// from the stored text itself ([`RememberedSceneApps::parse`]): this
/// crate's JSON maps sort their keys.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RememberedSceneApps(pub Vec<(String, String)>);

/// A JSON object's members in the order its text lists them; anything that
/// is not an object reads as none.
struct OrderedMembers(Vec<(String, Value)>);

impl<'de> serde::Deserialize<'de> for OrderedMembers {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Members;
        impl<'de> serde::de::Visitor<'de> for Members {
            type Value = OrderedMembers;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("any JSON value")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<OrderedMembers, A::Error> {
                let mut members: Vec<(String, Value)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    // A repeated key keeps its first place, as in `JSON.parse`.
                    match members.iter_mut().find(|(seen, _)| *seen == key) {
                        Some(member) => member.1 = value,
                        None => members.push((key, value)),
                    }
                }
                Ok(OrderedMembers(members))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<OrderedMembers, A::Error> {
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(OrderedMembers(Vec::new()))
            }
            fn visit_bool<E>(self, _: bool) -> Result<OrderedMembers, E> {
                Ok(OrderedMembers(Vec::new()))
            }
            fn visit_i64<E>(self, _: i64) -> Result<OrderedMembers, E> {
                Ok(OrderedMembers(Vec::new()))
            }
            fn visit_u64<E>(self, _: u64) -> Result<OrderedMembers, E> {
                Ok(OrderedMembers(Vec::new()))
            }
            fn visit_f64<E>(self, _: f64) -> Result<OrderedMembers, E> {
                Ok(OrderedMembers(Vec::new()))
            }
            fn visit_str<E>(self, _: &str) -> Result<OrderedMembers, E> {
                Ok(OrderedMembers(Vec::new()))
            }
            fn visit_unit<E>(self) -> Result<OrderedMembers, E> {
                Ok(OrderedMembers(Vec::new()))
            }
        }
        deserializer.deserialize_any(Members)
    }
}

impl RememberedSceneApps {
    /// The stored members (`videorc.scene-window-apps.v1`'s text), in the
    /// text's order; not checked yet ([`remembered_scene_apps`] does).
    pub fn parse(text: &str) -> Vec<(String, Value)> {
        serde_json::from_str::<OrderedMembers>(text)
            .map(|members| members.0)
            .unwrap_or_default()
    }

    /// The text to store: an object in this order.
    pub fn to_json_text(&self) -> String {
        let members: Vec<String> = self
            .0
            .iter()
            .map(|(id, bundle)| format!("{}:{}", json!(id), json!(bundle)))
            .collect();
        format!("{{{}}}", members.join(","))
    }

    /// The app a scene went on with.
    pub fn get(&self, scene_id: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(id, _)| id == scene_id)
            .map(|(_, bundle)| bundle.as_str())
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// `rememberedSceneApps`: bounded memory of each scene's app (scenes that
/// exist, valid bundle ids, the newest 200).
pub fn remembered_scene_apps(
    members: &[(String, Value)],
    scenes: &[SavedScene],
) -> RememberedSceneApps {
    let kept: Vec<(String, String)> = members
        .iter()
        .filter(|(id, bundle)| {
            scenes.iter().any(|scene| &scene.id == id)
                && normalize_scene_app(Some(&json!({"bundleId": bundle}))).is_some()
        })
        .map(|(id, bundle)| {
            (
                id.clone(),
                string(Some(bundle)).unwrap_or_default().to_string(),
            )
        })
        .collect();
    let skip = kept.len().saturating_sub(200);
    RememberedSceneApps(kept.into_iter().skip(skip).collect())
}

/// `rememberSceneWindowApp`: the app a scene went on with, newest last.
pub fn remember_scene_window_app(
    memory: &RememberedSceneApps,
    scene_id: &str,
    sources: &Value,
    devices: &[Device],
    scenes: &[SavedScene],
) -> RememberedSceneApps {
    let bundle = string(get(get(Some(sources), "app"), "bundleId"))
        .map(str::to_string)
        .or_else(|| {
            let window = string(get(Some(sources), "windowId"))?;
            devices
                .iter()
                .find(|device| device.kind == DeviceKind::Window && device.id == window)?
                .app
                .as_ref()
                .map(|app| app.bundle_id.clone())
        });
    let mut next: Vec<(String, Value)> = memory
        .0
        .iter()
        .map(|(id, bundle)| (id.clone(), json!(bundle)))
        .collect();
    if let Some(bundle) = bundle {
        next.retain(|(id, _)| id != scene_id);
        next.push((scene_id.to_string(), json!(bundle)));
    }
    remembered_scene_apps(&next, scenes)
}

/// `sceneAppState`: discovery can prove a window exists; only the resolver
/// tells a missing app from a minimized window.
pub fn scene_app_state(
    visual: &Value,
    devices: &[Device],
    last: Option<SceneAppState>,
) -> Option<SceneAppState> {
    let app = get(get(Some(visual), "sources"), "app").filter(|app| app.is_object())?;
    if let Some(failed @ SceneAppState::Failed(_)) = last {
        return Some(failed);
    }
    let bundle = string(get(Some(app), "bundleId"));
    if devices.iter().any(|device| {
        device.kind == DeviceKind::Window
            && device.status == DeviceStatus::Available
            && device.app.as_ref().map(|app| app.bundle_id.as_str()) == bundle
    }) {
        return Some(SceneAppState::Ready);
    }
    Some(SceneAppState::Failed(AppWindowFailure::NotRunning))
}

/// `heldAppWindow`: the remembered window, when the held list names it
/// on screen, available, under the scene's app and big enough.
pub fn held_app_window<'a>(
    devices: &'a [Device],
    bundle_id: &str,
    window_id: Option<&str>,
) -> Option<&'a Device> {
    let window_id = window_id?;
    devices.iter().find(|device| {
        device.kind == DeviceKind::Window
            && device.id == window_id
            && device.status == DeviceStatus::Available
            && device.app.as_ref().map(|app| app.bundle_id.as_str()) == Some(bundle_id)
            && device.width.is_none_or(|w| w >= SCENE_APP_WINDOW_MIN_WIDTH)
            && device
                .height
                .is_none_or(|h| h >= SCENE_APP_WINDOW_MIN_HEIGHT)
    })
}

/// `AppWindowResolution`: the resolver's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppWindowResolution {
    Found { window_id: String, title: String },
    Unavailable(AppWindowFailure),
}

impl AppWindowResolution {
    /// `sources.resolve_app_window`'s JSON.
    pub fn from_json(value: &Value) -> Option<Self> {
        if get(Some(value), "ok") == Some(&Value::Bool(true)) {
            return Some(Self::Found {
                window_id: string(get(Some(value), "windowId"))?.to_string(),
                title: string(get(Some(value), "title"))
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        string(get(Some(value), "reason"))
            .and_then(AppWindowFailure::parse)
            .map(Self::Unavailable)
    }
}

/// `SceneWindowResolution`.
#[derive(Debug, Clone, PartialEq)]
pub enum SceneWindowResolution {
    /// The sources the commit sends (the snapshot is never rewritten).
    Ready(Value),
    /// The app's window must be resolved.
    ResolveApp(String),
    Blocked(AppWindowFailure),
    /// A fixed window that is gone and no app to find another under.
    ResolveSources,
}

/// `resolveSceneWindow`.
pub fn resolve_scene_window(
    visual: &Value,
    devices: &[Device],
    fallback_bundle_id: Option<&str>,
    resolution: Option<&AppWindowResolution>,
) -> SceneWindowResolution {
    let sources = visual_sources(visual.get("sources").unwrap_or(&Value::Null));
    let app = get(Some(&sources), "app").filter(|app| app.is_object());
    let bundle = string(get(app, "bundleId"))
        .or(fallback_bundle_id)
        .map(str::to_string);
    let window_id = string(get(Some(&sources), "windowId")).filter(|id| !id.is_empty());
    let exact = window_id.is_some_and(|id| {
        devices.iter().any(|device| {
            device.kind == DeviceKind::Window
                && device.id == id
                && device.status == DeviceStatus::Available
        })
    });
    if app.is_none() && (window_id.is_none() || exact) {
        return SceneWindowResolution::Ready(sources);
    }
    let Some(bundle) = bundle else {
        return SceneWindowResolution::ResolveSources;
    };
    match resolution {
        None => SceneWindowResolution::ResolveApp(bundle),
        Some(AppWindowResolution::Unavailable(failure)) => SceneWindowResolution::Blocked(*failure),
        Some(AppWindowResolution::Found { window_id, title }) => {
            let mut next = sources.as_object().cloned().unwrap_or_default();
            for key in ["screenId", "screenName", "screenUuid"] {
                next.remove(key);
            }
            next.insert("captureOff".into(), json!(false));
            next.insert("testPattern".into(), json!(false));
            next.insert("windowId".into(), json!(window_id));
            next.insert("windowName".into(), json!(title));
            SceneWindowResolution::Ready(Value::Object(next))
        }
    }
}

/// `resolveSceneWindowForApply`'s second step: with the resolver's (or the
/// held list's) answer, the resolution; a fixed window's failure asks for
/// new sources.
pub fn resolved_for_apply(
    visual: &Value,
    devices: &[Device],
    fallback_bundle_id: Option<&str>,
    resolution: &AppWindowResolution,
) -> SceneWindowResolution {
    let resolved = resolve_scene_window(visual, devices, fallback_bundle_id, Some(resolution));
    let has_app = truthy(get(get(Some(visual), "sources"), "app"));
    match resolved {
        SceneWindowResolution::Blocked(_) if !has_app => SceneWindowResolution::ResolveSources,
        other => other,
    }
}

/// `savedSceneApplyRetryAllowed`: one more try over the backend while the
/// streamer's pick is still the latest.
pub fn saved_scene_apply_retry_allowed(
    attempt: u32,
    generation: u64,
    latest_generation: u64,
    intent: u64,
    latest_intent: u64,
) -> bool {
    attempt == 0 && generation == latest_generation && intent == latest_intent
}

/// `sceneWindowRefusal`'s words: the app's name, else the window's, else
/// "The app".
pub fn scene_window_refusal(visual: &Value, failure: AppWindowFailure) -> String {
    let sources = visual.get("sources");
    let name = string(get(get(sources, "app"), "name"))
        .or_else(|| string(get(sources, "windowName")))
        .unwrap_or("The app");
    app_window_failure_copy(name, failure)
}

/// `sceneForFrontApp` (`lib/scene-apps.ts`): the following scene made for
/// the app in front, of the Studio's orientation, the one used last.
pub fn scene_for_front_app<'a>(
    scenes: &'a [SavedScene],
    bundle_id: &str,
    last_used: &std::collections::HashMap<String, u64>,
    vertical: bool,
) -> Option<&'a SavedScene> {
    let wanted = bundle_id.to_lowercase();
    let mut best: Option<&SavedScene> = None;
    for scene in scenes {
        let Some(app) = scene.app() else { continue };
        if string(app.get("bundleId"))
            .map(str::to_lowercase)
            .as_deref()
            != Some(wanted.as_str())
            || app.get("follows") != Some(&Value::Bool(true))
            || scene.layout_preset().starts_with("vertical-") != vertical
        {
            continue;
        }
        let used = |scene: &SavedScene| last_used.get(&scene.id).copied().unwrap_or(0);
        if best.is_none_or(|current| used(scene) > used(current)) {
            best = Some(scene);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_protocol::DeviceApp;

    fn window(id: &str, bundle: &str) -> Device {
        Device {
            app: Some(DeviceApp {
                bundle_id: bundle.into(),
                name: "Figma".into(),
                pid: 1,
            }),
            window_title: Some("Design".into()),
            display_uuid: None,
            id: id.into(),
            name: "Figma — Design".into(),
            kind: DeviceKind::Window,
            status: DeviceStatus::Available,
            detail: None,
            width: Some(1200),
            height: Some(800),
        }
    }

    fn app_visual(window_id: Option<&str>) -> Value {
        let mut sources =
            json!({"app": {"bundleId": "com.figma.Desktop", "name": "Figma", "follows": true}});
        if let Some(id) = window_id {
            sources["windowId"] = json!(id);
        }
        json!({"layout": {"layoutPreset": "screen-only"}, "sources": sources, "background": null})
    }

    #[test]
    fn an_app_scene_resolves_from_the_held_list_or_the_backend() {
        let devices = vec![window("window:9", "com.figma.Desktop")];
        let visual = app_visual(Some("window:9"));
        assert_eq!(
            resolve_scene_window(&visual, &devices, None, None),
            SceneWindowResolution::ResolveApp("com.figma.Desktop".into())
        );
        assert!(held_app_window(&devices, "com.figma.Desktop", Some("window:9")).is_some());
        assert!(held_app_window(&devices, "com.other.App", Some("window:9")).is_none());
        let found = AppWindowResolution::Found {
            window_id: "window:9".into(),
            title: "Design".into(),
        };
        let SceneWindowResolution::Ready(sources) =
            resolved_for_apply(&visual, &devices, None, &found)
        else {
            panic!("ready");
        };
        assert_eq!(sources["windowId"], "window:9");
        assert_eq!(sources["windowName"], "Design");
        assert_eq!(sources["captureOff"], false);
        let gone = AppWindowResolution::Unavailable(AppWindowFailure::NotRunning);
        assert_eq!(
            resolved_for_apply(&visual, &devices, None, &gone),
            SceneWindowResolution::Blocked(AppWindowFailure::NotRunning)
        );
        assert_eq!(
            scene_window_refusal(&visual, AppWindowFailure::Minimized),
            "Figma's window is minimized"
        );
        assert_eq!(
            AppWindowResolution::from_json(&json!({"ok": false, "reason": "no-window"})),
            Some(AppWindowResolution::Unavailable(AppWindowFailure::NoWindow))
        );
    }

    #[test]
    fn a_fixed_window_scene_is_ready_while_its_window_is_listed() {
        let devices = vec![window("window:9", "com.figma.Desktop")];
        let visual = json!({"layout": {"layoutPreset": "screen-only"}, "sources": {"windowId": "window:9"}, "background": null});
        assert!(matches!(
            resolve_scene_window(&visual, &devices, None, None),
            SceneWindowResolution::Ready(_)
        ));
        let gone = json!({"layout": {"layoutPreset": "screen-only"}, "sources": {"windowId": "window:1"}, "background": null});
        assert_eq!(
            resolve_scene_window(&gone, &devices, None, None),
            SceneWindowResolution::ResolveSources
        );
        assert_eq!(
            resolve_scene_window(&gone, &devices, Some("com.figma.Desktop"), None),
            SceneWindowResolution::ResolveApp("com.figma.Desktop".into())
        );
        assert!(saved_scene_apply_retry_allowed(0, 3, 3, 9, 9));
        assert!(!saved_scene_apply_retry_allowed(1, 3, 3, 9, 9));
        assert!(!saved_scene_apply_retry_allowed(0, 3, 4, 9, 9));
    }

    // ── Electron since 81e756ca: `scenesForApps` is gone, so the tests
    // build plan 210's app scene by hand (`scene-apps.test.ts`'s `make`,
    // `scene-window-resolution.test.ts`'s device-memory case).

    use crate::scenes::model::{
        GapSource, GapState, SourceGap, normalize_scene_visual, scene_source_gaps,
    };
    use crate::studio::capture_config::default_layout;
    use std::collections::HashMap;

    const FIGMA: &str = "com.figma.Desktop";

    fn figma_app(follows: bool) -> Value {
        json!({"bundleId": FIGMA, "name": "Figma", "follows": follows})
    }

    fn saved(id: &str, name: &str, visual: Value) -> SavedScene {
        SavedScene {
            id: id.into(),
            name: name.into(),
            created_at: "2026-10-28".into(),
            updated_at: "2026-10-28".into(),
            visual,
            audio: None,
            cloud: None,
        }
    }

    /// `scene-apps.test.ts`'s `make`: a plan 210 (v1) scene for Figma, as
    /// New scene… made them: following, no audio.
    fn make() -> SavedScene {
        let mut layout = default_layout();
        layout["layoutPreset"] = json!("screen-only");
        saved(
            "id",
            "Figma",
            normalize_scene_visual(&json!({
                "layout": layout,
                "sources": {
                    "cameraId": "camera",
                    "windowId": "window",
                    "windowName": "Design",
                    "captureOff": false,
                    "testPattern": false,
                    "app": figma_app(true)
                },
                "background": null
            }))
            .unwrap(),
        )
    }

    #[test]
    fn requests_app_resolution_even_with_a_stale_window_with_no_missing_window_gap() {
        let scene = make();
        assert_eq!(scene_source_gaps(&scene.visual, &[]), vec![]);
        assert_eq!(
            resolve_scene_window(&scene.visual, &[], None, None),
            SceneWindowResolution::ResolveApp(FIGMA.into())
        );
        let found = AppWindowResolution::Found {
            window_id: "new".into(),
            title: "New".into(),
        };
        let SceneWindowResolution::Ready(sources) =
            resolve_scene_window(&scene.visual, &[], None, Some(&found))
        else {
            panic!("ready");
        };
        assert_eq!(sources["windowId"], "new");
        assert_eq!(scene.visual["sources"]["windowId"], "window");
    }

    #[test]
    fn returns_a_typed_failure_and_its_copy() {
        for (failure, copy) in [
            (AppWindowFailure::NotRunning, "Figma isn't open"),
            (AppWindowFailure::NoWindow, "Figma has no window open"),
            (AppWindowFailure::Minimized, "Figma's window is minimized"),
        ] {
            assert_eq!(
                resolve_scene_window(
                    &make().visual,
                    &[],
                    None,
                    Some(&AppWindowResolution::Unavailable(failure))
                ),
                SceneWindowResolution::Blocked(failure)
            );
            assert_eq!(app_window_failure_copy("Figma", failure), copy);
        }
    }

    #[test]
    fn preserves_fixed_window_semantics_with_an_explicit_ownership_fallback_before_resolve_sources()
    {
        let mut visual = make().visual;
        visual["sources"].as_object_mut().unwrap().remove("app");
        assert_eq!(
            scene_source_gaps(&visual, &[]),
            vec![SourceGap {
                source: GapSource::Screen,
                state: GapState::Unavailable
            }]
        );
        assert_eq!(
            resolve_scene_window(&visual, &[], None, None),
            SceneWindowResolution::ResolveSources
        );
        assert_eq!(
            resolve_scene_window(&visual, &[], Some(FIGMA), None),
            SceneWindowResolution::ResolveApp(FIGMA.into())
        );
        let listed: Device = serde_json::from_value(
            json!({"id": "window", "kind": "window", "status": "available", "name": "Design"}),
        )
        .unwrap();
        assert!(matches!(
            resolve_scene_window(&visual, &[listed], Some(FIGMA), None),
            SceneWindowResolution::Ready(_)
        ));
    }

    #[test]
    fn selects_the_latest_used_following_scene_in_the_current_orientation_only() {
        let a = make();
        let b = SavedScene {
            id: "b".into(),
            ..make()
        };
        let mut stopped = SavedScene {
            id: "stopped".into(),
            ..make()
        };
        stopped.visual["sources"] = json!({"app": figma_app(false)});
        let mut vertical = SavedScene {
            id: "vertical".into(),
            ..make()
        };
        vertical.visual["layout"]["layoutPreset"] = json!("vertical-screen-only");
        let scenes = vec![a, b, stopped.clone(), vertical];
        let used: HashMap<String, u64> = [("b".to_string(), 20), ("stopped".to_string(), 100)]
            .into_iter()
            .collect();
        let none = HashMap::new();
        let id = |scene: Option<&SavedScene>| scene.map(|scene| scene.id.clone());
        assert_eq!(
            id(scene_for_front_app(&scenes, FIGMA, &used, false)).as_deref(),
            Some("b")
        );
        assert_eq!(
            id(scene_for_front_app(&scenes, FIGMA, &none, true)).as_deref(),
            Some("vertical")
        );
        assert_eq!(
            id(scene_for_front_app(&scenes, "other", &none, false)),
            None
        );
        assert_eq!(
            id(scene_for_front_app(
                std::slice::from_ref(&stopped),
                FIGMA,
                &none,
                false
            )),
            None
        );
    }

    #[test]
    fn fills_separate_device_memory_prunes_deleted_scenes_and_caps_it_at_200() {
        let mut layout = default_layout();
        layout["layoutPreset"] = json!("screen-only");
        let scene = saved(
            "s",
            "Figma",
            json!({
                "layout": layout,
                "sources": {"windowId": "window:screencapturekit:old", "app": figma_app(true)},
                "background": null
            }),
        );
        let device: Device = serde_json::from_value(json!({
            "id": "window:screencapturekit:new",
            "name": "New design",
            "kind": "window",
            "status": "available",
            "app": {"bundleId": FIGMA, "name": "Figma", "pid": 12}
        }))
        .unwrap();
        let legacy = json!({"windowId": device.id});
        let scenes = std::slice::from_ref(&scene);
        let remembered = remember_scene_window_app(
            &RememberedSceneApps::default(),
            "s",
            &legacy,
            std::slice::from_ref(&device),
            scenes,
        );
        assert_eq!(remembered.to_json_text(), format!("{{\"s\":\"{FIGMA}\"}}"));
        let stored = format!("{{\"s\":\"{FIGMA}\",\"gone\":\"{FIGMA}\",\"bad\":4}}");
        assert_eq!(
            remembered_scene_apps(&RememberedSceneApps::parse(&stored), scenes),
            RememberedSceneApps(vec![("s".into(), FIGMA.into())])
        );
        let many: Vec<SavedScene> = (0..205)
            .map(|i| saved(&format!("s{i}"), "", Value::Null))
            .collect();
        let raw: Vec<(String, Value)> = many
            .iter()
            .map(|scene| (scene.id.clone(), json!(FIGMA)))
            .collect();
        let memory = remembered_scene_apps(&raw, &many);
        assert_eq!(memory.len(), 200);
        // The newest 200 in the stored order: s0..s4 go, never s10 or s100.
        for gone in ["s0", "s1", "s2", "s3", "s4"] {
            assert_eq!(memory.get(gone), None);
        }
        for kept in ["s5", "s10", "s100", "s204"] {
            assert_eq!(memory.get(kept), Some(FIGMA));
        }
    }

    #[test]
    fn the_app_memory_keeps_the_stored_order_and_moves_a_scene_that_went_on_again_last() {
        let scenes: Vec<SavedScene> = ["b", "a", "c"]
            .iter()
            .map(|id| saved(id, "", Value::Null))
            .collect();
        let text = format!("{{\"b\":\"{FIGMA}\",\"a\":\"{FIGMA}\",\"c\":\"{FIGMA}\"}}");
        let memory = remembered_scene_apps(&RememberedSceneApps::parse(&text), &scenes);
        let order: Vec<&str> = memory.0.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(order, ["b", "a", "c"]);
        let again = remember_scene_window_app(
            &memory,
            "b",
            &json!({"app": {"bundleId": "com.apple.Notes", "name": "Notes"}}),
            &[],
            &scenes,
        );
        let order: Vec<&str> = again.0.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(order, ["a", "c", "b"]);
        assert_eq!(again.get("b"), Some("com.apple.Notes"));
        assert_eq!(RememberedSceneApps::parse("[1,2]"), vec![]);
        assert_eq!(RememberedSceneApps::parse("not json"), vec![]);
    }
}
