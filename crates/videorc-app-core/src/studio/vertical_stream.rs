//! Plan 260 S1.6b part 4c (L7): the vertical stream beside a 16:9 studio
//! (plan 231 D4). The leg shows the scene on stream's own 9:16 layout, with
//! what the sources look like taken from the program (`lib/capture.ts`:
//! `simulcastLegLayout`, `PROGRAM_SOURCE_KEYS`, `simulcastLegLiveRequest`),
//! and the Vertical stream panel edits that layout
//! (`components/studio/vertical-stream-layout-control.tsx`).
//!
//! The leg's canvas ([`simulcast_leg_video`], `simulcastLegVideo`: the
//! vertical destinations' common profile, in portrait) is S1.6c's
//! `livestream::plan::simulcast_video`. The session start's leg is
//! [`start_simulcast`] (S1.6b part 4c-2); the live leg sends after a commit
//! and for the scene on stream are `super::vertical_leg`'s. The builders
//! here take the canvas as an input.

use serde_json::{Map, Value, json};

use super::capture_config::{self, VERTICAL_LAYOUT_PRESETS};
use super::js_value::string;
use super::settings::{SettingWrite, keys};
use super::{Studio, StudioBackend};
use crate::livestream::plan;
use crate::scenes::framing::recalled_layout_framing;
use crate::scenes::model::{GapSource, GapState, SourceGap, scene_gallery_reason};
use crate::scenes::v2::{Scene, SceneShows, layout_preset_label};

/// `PROGRAM_SOURCE_KEYS`: what the vertical stream takes from the program,
/// not from its scene: the camera's look, background, mirror and key, and
/// which sources are shown.
pub const PROGRAM_SOURCE_KEYS: [&str; 10] = [
    "cameraLook",
    "cameraBackground",
    "cameraMirror",
    "cameraChromaKeyEnabled",
    "cameraChromaKeyColor",
    "cameraChromaKeySimilarityPct",
    "cameraChromaKeySmoothnessPct",
    "cameraChromaKeySpillPct",
    "cameraChromaKeyEdges",
    "sourceVisibility",
];

/// `READ_ONLY_REASON`: a library from a newer Videorc can't be edited.
pub const READ_ONLY_REASON: &str = "Update Videorc to change your scenes.";

/// `simulcastLegLayout`: the one builder for the session start's leg and a
/// live edit of it, so what goes live and what a mid-stream change commits
/// never disagree. The scene's 9:16 layout (its layout, its Fill or Fit,
/// where and in what shape the camera and the screen sit), with the
/// program's [`PROGRAM_SOURCE_KEYS`], so one camera reads the same on both
/// streams and a source hidden on stream is hidden on both.
pub fn simulcast_leg_layout(scene_vertical: &Value, program: &Value) -> Value {
    let mut leg = scene_vertical.as_object().cloned().unwrap_or_default();
    for key in PROGRAM_SOURCE_KEYS {
        // `leg[key] = program[key]`, dropped only when the program has none.
        match program.get(key) {
            Some(value) => leg.insert(key.into(), value.clone()),
            None => leg.remove(key),
        };
    }
    Value::Object(leg)
}

/// `buildSimulcastParams`: the vertical leg's session params on the
/// portrait canvas `video`; none without a scene or a canvas (no vertical
/// stream armed).
pub fn simulcast_params(
    scene: Option<&Scene>,
    program: &Value,
    video: Option<&Value>,
) -> Option<Value> {
    let (scene, video) = (scene?, video?);
    Some(json!({
        "layout": simulcast_leg_layout(&scene.vertical, program),
        "video": video,
    }))
}

/// `simulcastLegVideo`: the vertical stream's canvas, or none when no
/// vertical stream is armed: the vertical destinations' common profile
/// (`simulcastStreamVideo`), in portrait.
pub fn simulcast_leg_video(config: &Value) -> Option<Value> {
    if !capture_config::simulcast_armed(config) {
        return None;
    }
    let video = plan::simulcast_video_of(config, &plan::recording_video(config));
    Some(capture_config::coerce_video_to_orientation(
        &json!({
            "preset": video.preset,
            "width": video.width,
            "height": video.height,
            "fps": video.fps,
            "bitrateKbps": video.bitrate_kbps,
        }),
        true,
    ))
}

/// The capture config a start is built from (`sessionCaptureConfig` in
/// `runStartSession`): `captureConfigForIntent`'s flags in place of the
/// saved mode, the destinations this start goes to, and the layout at the
/// output boundary (`cameraOutputLayout`).
pub fn session_capture_config(
    capture: &Value,
    record: bool,
    stream: bool,
    streaming: Option<Value>,
    layout: Value,
) -> Value {
    let mut session = capture.as_object().cloned().unwrap_or_default();
    session.insert("recordEnabled".into(), Value::Bool(record));
    session.insert("streamEnabled".into(), Value::Bool(stream));
    if let Some(streaming) = streaming {
        session.insert("streaming".into(), streaming);
    }
    session.insert("layout".into(), layout);
    Value::Object(session)
}

/// The session start's leg (`buildStartSessionParams`' `simulcast`):
/// [`simulcast_params`] for the scene on stream over the start's config, on
/// [`simulcast_leg_video`]'s canvas. None when no vertical stream is armed
/// or no scene is on stream.
pub fn start_simulcast(session: &Value, scene: Option<&Scene>) -> Option<Value> {
    let video = simulcast_leg_video(session);
    simulcast_params(scene, &session["layout"], video.as_ref())
}

/// [`simulcast_leg_live_request`] for a capture config: its sources, its
/// layout as the program, and [`simulcast_leg_video`]'s canvas
/// (`simulcastLegLiveRequest(config, scene)`).
pub fn simulcast_leg_live_request_of(config: &Value, scene: Option<&Scene>) -> Option<Value> {
    let video = simulcast_leg_video(config);
    simulcast_leg_live_request(&config["sources"], scene, &config["layout"], video.as_ref())
}

/// `simulcastLegLiveRequest`: the scene transaction that moves the vertical
/// leg of a running dual-orientation session, built exactly like the
/// session start's leg (the same sources, the derived layout, the portrait
/// canvas, no background). `simulcastLeg` makes the backend commit it to
/// the leg only, and refuse it when no leg runs.
pub fn simulcast_leg_live_request(
    sources: &Value,
    scene: Option<&Scene>,
    program: &Value,
    video: Option<&Value>,
) -> Option<Value> {
    let leg = simulcast_params(scene, program, video)?;
    Some(json!({
        "simulcastLeg": true,
        "sources": sources,
        "layout": leg["layout"],
        "video": leg["video"],
    }))
}

/// `verticalStreamLayout`: the panel's edit of a scene's 9:16 layout. Fill
/// or Fit keeps the arrangement; another layout is a layout pick (its
/// remembered framing, the preset arrangement, no custom camera box).
pub fn vertical_stream_layout(
    vertical: &Value,
    patch: &Map<String, Value>,
    framing_memory: &Value,
) -> Value {
    let current = string(vertical.get("layoutPreset")).unwrap_or_default();
    let preset = string(patch.get("layoutPreset")).unwrap_or(current);
    let mut next = vertical.as_object().cloned().unwrap_or_default();
    if preset == current {
        next.extend(patch.clone());
        return Value::Object(next);
    }
    next.extend(recalled_layout_framing(framing_memory, current, preset));
    next.insert("arrangementMode".into(), json!("preset"));
    next.insert("sourceTransformOverrides".into(), json!({}));
    next.extend(patch.clone());
    next.insert("cameraTransformMode".into(), json!("preset"));
    next.insert("cameraTransform".into(), Value::Null);
    Value::Object(next)
}

/// One of the panel's layouts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerticalLayoutChoice {
    pub preset: &'static str,
    pub label: String,
    /// A source it needs is missing (never the layout on now).
    pub disabled: bool,
}

/// The Vertical stream panel (`VerticalStreamLayoutControl`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerticalStreamLayoutView {
    /// "The 9:16 layout of {scene}, the scene on stream. Each scene keeps
    /// its own."
    pub description: String,
    pub preset: String,
    pub choices: Vec<VerticalLayoutChoice>,
    /// `sceneGalleryReason` for the layouts a missing source blocks.
    pub reason: Option<String>,
    pub fit: bool,
    /// Why nothing can change (a library from a newer Videorc).
    pub read_only_reason: Option<&'static str>,
}

/// Copy for the Studio bottom-row Vertical stream panel
/// (`vertical-leg-monitor.tsx`).
pub mod leg_copy {
    pub const TITLE: &str = "Vertical stream";
    pub const ON_AIR: &str = "On air";
    pub const READY: &str = "Ready";
    pub const DESC_LIVE: &str =
        "Changes here go live on the vertical stream only. Your horizontal stream isn't touched.";
    pub const DESC_IDLE: &str = "Goes live beside your horizontal stream when you start.";
    pub const LAYOUT: &str = "Layout";
    pub const LAYOUT_ARIA: &str = "Vertical stream layout";
    /// `ScreenFramingControl`'s default label on the Vertical stream panel.
    pub const SCREEN: &str = "Screen";
}

/// The Vertical stream panel in the Studio dashboard bottom row
/// (`VerticalLegMonitor`): none while simulcast is not armed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerticalLegMonitorView {
    pub session_active: bool,
    /// The scene on stream's 9:16 layout control; none without a scene or
    /// while the studio itself is already 9:16.
    pub layout: Option<VerticalStreamLayoutView>,
}

/// `VerticalLegMonitor`: the panel when a vertical destination is armed
/// beside a 16:9 studio.
pub fn vertical_leg_monitor_view(
    capture: &Value,
    session_active: bool,
    scene: Option<&Scene>,
    read_only: bool,
) -> Option<VerticalLegMonitorView> {
    if !capture_config::simulcast_armed(capture) {
        return None;
    }
    Some(VerticalLegMonitorView {
        session_active,
        layout: vertical_stream_layout_view(scene, capture, read_only),
    })
}

fn needs_camera(preset: &str) -> bool {
    matches!(
        preset,
        "vertical-camera-top"
            | "vertical-camera-bottom"
            | "vertical-split"
            | "vertical-screen-camera"
            | "vertical-camera-only"
    )
}

fn needs_screen(preset: &str) -> bool {
    matches!(
        preset,
        "vertical-camera-top"
            | "vertical-camera-bottom"
            | "vertical-split"
            | "vertical-screen-camera"
            | "vertical-screen-only"
    )
}

/// The panel for the scene on stream, or none: no scene, or a 9:16 studio
/// (its one canvas is the portrait one).
pub fn vertical_stream_layout_view(
    scene: Option<&Scene>,
    capture: &Value,
    read_only: bool,
) -> Option<VerticalStreamLayoutView> {
    let scene = scene?;
    let studio_preset = string(capture["layout"].get("layoutPreset")).unwrap_or_default();
    if capture_config::layout_preset_is_vertical(studio_preset) {
        return None;
    }
    let vertical = &scene.vertical;
    let preset = string(vertical.get("layoutPreset"))
        .unwrap_or_default()
        .to_string();
    let sources = &capture["sources"];
    let chosen = |key: &str| string(sources.get(key)).is_some_and(|id| !id.is_empty());
    let has_camera = chosen("cameraId");
    let has_screen = scene.shows != SceneShows::None && (chosen("screenId") || chosen("windowId"));
    let mut blocked: Vec<(String, Vec<SourceGap>)> = Vec::new();
    let choices = VERTICAL_LAYOUT_PRESETS
        .iter()
        .map(|&id| {
            let mut gaps = Vec::new();
            if needs_camera(id) && !has_camera {
                gaps.push(SourceGap {
                    source: GapSource::Camera,
                    state: GapState::Off,
                });
            }
            if needs_screen(id) && !has_screen {
                gaps.push(SourceGap {
                    source: GapSource::Screen,
                    state: GapState::Off,
                });
            }
            let label = layout_preset_label(id, false);
            let disabled = !gaps.is_empty() && id != preset;
            if !gaps.is_empty() {
                blocked.push((label.clone(), gaps));
            }
            VerticalLayoutChoice {
                preset: id,
                label,
                disabled,
            }
        })
        .collect();
    let blocked: Vec<(&str, Vec<SourceGap>)> = blocked
        .iter()
        .map(|(label, gaps)| (label.as_str(), gaps.clone()))
        .collect();
    Some(VerticalStreamLayoutView {
        description: format!(
            "The 9:16 layout of {}, the scene on stream. Each scene keeps its own.",
            scene.name
        ),
        preset,
        choices,
        reason: scene_gallery_reason(&blocked),
        fit: string(vertical.get("verticalScreenFraming")) == Some("fit"),
        read_only_reason: read_only.then_some(READ_ONLY_REASON),
    })
}

impl<B: StudioBackend> Studio<B> {
    /// `editVerticalStreamLayout`: the panel's pick (a layout, or Fill /
    /// Fit) saved into the scene on stream's 9:16 layout, and the capture
    /// config's `lastVerticalPreset` and `simulcastScreenFraming` (written,
    /// though they steer nothing since plan 231). False with no scene on
    /// stream or a refused write.
    pub async fn edit_vertical_stream_layout(&self, patch: Map<String, Value>) -> bool {
        let now = (self.config.clock)();
        let wrote = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
            let Some(id) = inner.scenes.on_stream.clone() else {
                return false;
            };
            let Some(mut scene) = inner.stored_scene(&id) else {
                return false;
            };
            let layout = vertical_stream_layout(
                &scene.vertical,
                &patch,
                &inner.capture.config["layoutFramingMemory"],
            );
            scene.vertical = layout.clone();
            scene.updated_at = now;
            let Some(library) = inner
                .scenes
                .state
                .as_ref()
                .and_then(|state| state.replace(&scene).ok())
            else {
                return false;
            };
            if !inner.write_library(library, false) {
                return false;
            }
            let mut next = inner.capture.config.clone();
            next["lastVerticalPreset"] = layout["layoutPreset"].clone();
            next["simulcastScreenFraming"] = layout["verticalScreenFraming"].clone();
            let stored = capture_config::stored_capture_config(&next);
            let write = SettingWrite::Put {
                key: keys::CAPTURE_CONFIG.to_string(),
                value: stored.clone(),
            };
            match inner.stage_writes(&[write], &self.config.logger) {
                Ok(()) => inner.capture.set(next, Some(stored)),
                Err(error) => {
                    self.config.logger.warn(format!(
                        "[scenes] the vertical stream's layout memory was not saved: {}",
                        error.message
                    ));
                    inner.capture.replace_config(next);
                }
            }
            true
        };
        self.publish();
        if wrote {
            let _ = self.flush_settings().await;
        }
        wrote
    }

    /// The Vertical stream panel for the scene on stream now.
    pub fn vertical_stream_layout(&self) -> Option<VerticalStreamLayoutView> {
        let mut guard = self.lock();
        let inner = &mut *guard;
        inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
        let scene = inner
            .scenes
            .on_stream
            .clone()
            .and_then(|id| inner.stored_scene(&id));
        let read_only = inner
            .scenes
            .state
            .as_ref()
            .is_some_and(|state| state.read_only);
        vertical_stream_layout_view(scene.as_ref(), &inner.capture.config, read_only)
    }

    /// The Studio bottom-row Vertical stream panel (`VerticalLegMonitor`).
    pub fn vertical_leg_monitor(&self, session_active: bool) -> Option<VerticalLegMonitorView> {
        let mut guard = self.lock();
        let inner = &mut *guard;
        inner.capture.sync(inner.settings.get(keys::CAPTURE_CONFIG));
        let scene = inner
            .scenes
            .on_stream
            .clone()
            .and_then(|id| inner.stored_scene(&id));
        let read_only = inner
            .scenes
            .state
            .as_ref()
            .is_some_and(|state| state.read_only);
        vertical_leg_monitor_view(
            &inner.capture.config,
            session_active,
            scene.as_ref(),
            read_only,
        )
    }
}

#[cfg(test)]
#[path = "vertical_stream_tests.rs"]
mod tests;
