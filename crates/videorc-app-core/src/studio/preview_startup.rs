//! Plan 238 (P135): what the docked Preview says while it starts, the
//! Studio slot's startup card. Until the first real frame the slot shows
//! these steps instead of a picture. Every step comes from real state,
//! never from a timer:
//!
//!   1. the capture engine (the backend) is not connected yet,
//!   2. a source the scene uses has not sent a picture yet,
//!   3. the sources are live and the first frame is on its way.
//!
//! Electron's `shared/preview-startup.ts` (the steps and their words),
//! `renderer/src/lib/preview-startup.ts` (the sources the card waits for)
//! and `components/preview-startup-card.tsx` (the segments, the stall
//! clock and Open Sources), byte for byte. Pure: the GPUI card draws it.

use std::time::{Duration, Instant};

use serde_json::Value;

use super::health::HealthTelemetry;
use super::js_value::{get, is_nullish, trim, truthy};
use super::{Connection, StudioSnapshot};

/// `PREVIEW_STARTUP_TITLE` (`shared/preview-startup.ts:17`).
pub const PREVIEW_STARTUP_TITLE: &str = "Starting the preview";

/// `PREVIEW_STARTUP_STALL_MS` (`shared/preview-startup.ts:20`): how long
/// one step may run before the card says what is stuck (D3 a).
pub const PREVIEW_STARTUP_STALL: Duration = Duration::from_millis(20_000);

/// `OPEN_SOURCES_LABEL` (`preview-startup-card.tsx:17`).
pub const OPEN_SOURCES_LABEL: &str = "Open Sources";

/// `PreviewStartupStep` (`shared/preview-startup.ts:13`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PreviewStartupStep {
    /// The capture engine is not connected yet.
    Engine = 1,
    /// A source the scene uses has not sent a picture yet.
    Sources = 2,
    /// The first frame is on its way.
    FirstFrame = 3,
}

/// `PREVIEW_STARTUP_STEPS` (`shared/preview-startup.ts:15`).
pub const PREVIEW_STARTUP_STEPS: [PreviewStartupStep; 3] = [
    PreviewStartupStep::Engine,
    PreviewStartupStep::Sources,
    PreviewStartupStep::FirstFrame,
];

impl PreviewStartupStep {
    /// The step's number, 1 to 3.
    pub fn number(self) -> u8 {
        self as u8
    }
}

/// The screen-reader line under the words (`preview-startup-card.tsx:100`):
/// "Step 2 of 3".
pub fn step_words(step: PreviewStartupStep) -> String {
    format!("Step {} of {}", step.number(), PREVIEW_STARTUP_STEPS.len())
}

/// `PreviewStartupSourceKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewStartupSourceKind {
    Screen,
    Camera,
}

/// A source the scene uses, and whether it has sent a picture yet
/// (`PreviewStartupSource`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewStartupSource {
    pub kind: PreviewStartupSourceKind,
    /// The name the Studio shows for it ("LG HDR 4K", "ZV-E10M2"), if known.
    pub name: Option<String>,
    pub live: bool,
    /// It cannot send a picture until something changes (device missing,
    /// access needed, failed): the card says so at once instead of after the
    /// stall.
    pub blocked: bool,
}

/// The one fix a stalled step offers (`PreviewStartupAction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewStartupAction {
    OpenSources,
}

/// `PreviewStartupView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewStartupView {
    pub step: PreviewStartupStep,
    pub title: &'static str,
    pub detail: String,
    pub stalled: bool,
    pub action: Option<PreviewStartupAction>,
}

/// `previewStartupStep` (`shared/preview-startup.ts:56`).
pub fn preview_startup_step(
    engine_connected: bool,
    sources: &[PreviewStartupSource],
) -> PreviewStartupStep {
    if !engine_connected {
        return PreviewStartupStep::Engine;
    }
    if sources.iter().any(|source| !source.live) {
        PreviewStartupStep::Sources
    } else {
        PreviewStartupStep::FirstFrame
    }
}

/// `shownName`: the Studio's name without any " · " detail after it.
fn shown_name(source: &PreviewStartupSource) -> Option<&str> {
    let name = source.name.as_deref()?;
    let first = trim(name.split(" · ").next().unwrap_or_default());
    (!first.is_empty()).then_some(first)
}

/// `previewStartupSourceName` (`shared/preview-startup.ts:70`): the name to
/// say for a source, or the kind in plain words.
pub fn preview_startup_source_name(source: &PreviewStartupSource) -> String {
    match shown_name(source) {
        Some(name) => name.to_string(),
        None => match source.kind {
            PreviewStartupSourceKind::Screen => "your screen".to_string(),
            PreviewStartupSourceKind::Camera => "your camera".to_string(),
        },
    }
}

/// `joinNames`: "A", "A and B", "A, B and C".
fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [head @ .., last] => format!("{} and {last}", head.join(", ")),
    }
}

/// `sourceNames`: "LG HDR 4K and ZV-E10M2"; two unnamed sources read "your
/// screen and camera".
fn source_names(sources: &[&PreviewStartupSource]) -> String {
    let unnamed = sources.iter().all(|source| shown_name(source).is_none());
    if unnamed && sources.len() == 2 && sources[0].kind != sources[1].kind {
        return "your screen and camera".to_string();
    }
    let names: Vec<String> = sources
        .iter()
        .map(|source| preview_startup_source_name(source))
        .collect();
    join_names(&names)
}

/// `capitalize`: the first letter upper case.
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `previewStartupView` (`shared/preview-startup.ts:98`).
pub fn preview_startup_view(
    engine_connected: bool,
    sources: &[PreviewStartupSource],
    stalled: bool,
) -> PreviewStartupView {
    let step = preview_startup_step(engine_connected, sources);
    match step {
        PreviewStartupStep::Engine => PreviewStartupView {
            step,
            title: PREVIEW_STARTUP_TITLE,
            detail: if stalled {
                "The capture engine is taking longer than usual.".to_string()
            } else {
                "Waiting for the capture engine".to_string()
            },
            stalled,
            action: None,
        },
        PreviewStartupStep::Sources => {
            let waiting: Vec<&PreviewStartupSource> =
                sources.iter().filter(|source| !source.live).collect();
            let names = source_names(&waiting);
            let stuck = stalled || waiting.iter().any(|source| source.blocked);
            let detail = if stuck {
                let verb = if waiting.len() > 1 {
                    "haven\u{2019}t"
                } else {
                    "hasn\u{2019}t"
                };
                format!("{} {verb} sent a picture yet.", capitalize(&names))
            } else {
                format!("Connecting {names}")
            };
            PreviewStartupView {
                step,
                title: PREVIEW_STARTUP_TITLE,
                detail,
                stalled: stuck,
                action: stuck.then_some(PreviewStartupAction::OpenSources),
            }
        }
        PreviewStartupStep::FirstFrame => PreviewStartupView {
            step,
            title: PREVIEW_STARTUP_TITLE,
            detail: if stalled {
                "The first frame is taking longer than usual.".to_string()
            } else {
                "Drawing the first frame".to_string()
            },
            stalled,
            action: None,
        },
    }
}

/// One of the three segments under the words (`SegmentState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentState {
    Done,
    Current,
    Stalled,
    Next,
}

impl SegmentState {
    /// The segment's bar, full or empty (`value={state === 'next' ? 0 : 100}`).
    pub fn value(self) -> f32 {
        match self {
            SegmentState::Next => 0.0,
            _ => 100.0,
        }
    }
}

/// `previewStartupSegmentState` (`preview-startup-card.tsx:21`).
pub fn preview_startup_segment_state(
    segment: PreviewStartupStep,
    view: &PreviewStartupView,
) -> SegmentState {
    if segment < view.step {
        SegmentState::Done
    } else if segment > view.step {
        SegmentState::Next
    } else if view.stalled {
        SegmentState::Stalled
    } else {
        SegmentState::Current
    }
}

/// `previewStartupSources`' blocked screen states
/// (`renderer/src/lib/preview-startup.ts:8`).
const BLOCKED_SCREEN_STATES: [&str; 3] = ["permission-needed", "source-missing", "failed"];

/// `previewStartupSources`' blocked camera states
/// (`renderer/src/lib/preview-startup.ts:14`).
const BLOCKED_CAMERA_STATES: [&str; 3] = ["permission-needed", "device-missing", "failed"];

/// `a ?? b ?? …` over the selection's name fields, as a name.
fn first_name(sources: &Value, fields: &[&str]) -> Option<String> {
    fields
        .iter()
        .map(|field| get(Some(sources), field))
        .find(|value| !is_nullish(*value))
        .flatten()
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn status_state(status: Option<&Value>) -> Option<&str> {
    get(status, "state").and_then(Value::as_str)
}

/// `previewStartupSources` (`renderer/src/lib/preview-startup.ts:25`): the
/// screen (or window) and camera the scene uses, from the capture choice
/// (`captureConfig.sources`) and the live `preview.screen.status` and
/// `preview.camera.status`, each with the name the Studio's Sources rows
/// show and whether it has sent a picture. The test pattern needs no
/// device, so it is never waited for.
pub fn preview_startup_sources(
    sources: &Value,
    screen_status: Option<&Value>,
    camera_status: Option<&Value>,
) -> Vec<PreviewStartupSource> {
    let field = |name: &str| truthy(get(Some(sources), name));
    let mut result = Vec::new();
    let screen_chosen = field("screenId")
        || field("windowId")
        || field("wantedScreenId")
        || field("wantedWindowId");
    if screen_chosen && !field("testPattern") && !field("captureOff") {
        let state = status_state(screen_status);
        result.push(PreviewStartupSource {
            kind: PreviewStartupSourceKind::Screen,
            name: first_name(
                sources,
                &[
                    "screenName",
                    "windowName",
                    "wantedWindowName",
                    "wantedScreenName",
                ],
            ),
            live: state == Some("live"),
            blocked: screen_status.is_some()
                && state.is_some_and(|state| BLOCKED_SCREEN_STATES.contains(&state)),
        });
    }
    if (field("cameraId") || field("wantedCameraId")) && !field("cameraOff") {
        let state = status_state(camera_status);
        let no_video = get(camera_status, "noVideo") == Some(&Value::Bool(true));
        result.push(PreviewStartupSource {
            kind: PreviewStartupSourceKind::Camera,
            name: first_name(sources, &["cameraName", "wantedCameraName"]),
            live: state == Some("live") && !no_video,
            blocked: camera_status.is_some()
                && state.is_some_and(|state| BLOCKED_CAMERA_STATES.contains(&state)),
        });
    }
    result
}

/// What the card reads from the Studio: the engine's connection
/// (`wsStatus === 'connected'`, `preview-stage.tsx:146`) and the sources it
/// waits for.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PreviewStartupInputs {
    pub engine_connected: bool,
    pub sources: Vec<PreviewStartupSource>,
}

impl PreviewStartupInputs {
    pub fn of(snapshot: &StudioSnapshot, telemetry: &HealthTelemetry) -> Self {
        Self {
            engine_connected: matches!(snapshot.connection, Connection::Connected { .. }),
            sources: preview_startup_sources(
                &snapshot.settings.capture_doc["sources"],
                telemetry.preview_screen.as_ref(),
                telemetry.preview_camera.as_ref(),
            ),
        }
    }

    pub fn step(&self) -> PreviewStartupStep {
        preview_startup_step(self.engine_connected, &self.sources)
    }

    pub fn view(&self, stalled: bool) -> PreviewStartupView {
        preview_startup_view(self.engine_connected, &self.sources, stalled)
    }
}

/// `usePreviewStartupStalled` (`preview-startup-card.tsx:38`): true once
/// the step has run past the stall budget. The clock restarts whenever the
/// step changes and runs while the card is shown ([`Self::reset`] when it
/// goes); a reconnect that revisits a step that stalled earlier gets its own
/// full budget.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StallClock {
    started: Option<(PreviewStartupStep, Instant)>,
}

impl StallClock {
    /// Notes the step now running; true when it has run past the budget.
    pub fn observe(&mut self, step: PreviewStartupStep, now: Instant) -> bool {
        let since = match self.started {
            Some((running, since)) if running == step => since,
            _ => {
                self.started = Some((step, now));
                now
            }
        };
        now.saturating_duration_since(since) >= PREVIEW_STARTUP_STALL
    }

    /// When the running step stalls, if one runs.
    pub fn deadline(&self) -> Option<Instant> {
        self.started.map(|(_, since)| since + PREVIEW_STARTUP_STALL)
    }

    /// The card left: the next showing starts its step's clock again.
    pub fn reset(&mut self) {
        self.started = None;
    }
}

#[cfg(test)]
#[path = "preview_startup_tests.rs"]
mod tests;
