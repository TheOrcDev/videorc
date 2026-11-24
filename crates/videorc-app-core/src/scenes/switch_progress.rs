//! Issue #1275 (`lib/scene-switch-progress.ts`): a slow scene switch keeps
//! the name the streamer clicked with a spinner, and after a moment one
//! status line names what the switch is waiting for, and a slow camera when
//! that is the reason. A click that takes over a switch says so at once.
//!
//! Pure: the Studio keeps the progress, and the UI asks for the line at the
//! instant it draws ([`scene_switch_status_visible`] and
//! [`scene_switch_status_line`]), so no timer lives here.

use crate::studio::camera_frame_rate::{CameraLowFrameRate, camera_low_frame_rate_line};

/// What a scene switch is waiting for, in the order it waits
/// (`SceneSwitchPhase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneSwitchPhase {
    /// The source check and the scene's current state, before Videorc is
    /// asked.
    Preparing,
    /// Videorc applies it, starting any source it adds and waiting for its
    /// first frame.
    Starting,
    /// The new scene is drawn into the recording, livestream or preview.
    Drawing,
    /// The Preview window shows it.
    Presenting,
}

/// `SceneSwitchProgress`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneSwitchProgress {
    /// The layout intent this progress belongs to; a newer one replaces it.
    pub intent_id: u64,
    /// The name the streamer clicked: a layout's label, "Freeform" or a
    /// saved scene's name.
    pub target: String,
    pub phase: SceneSwitchPhase,
    pub started_at_ms: u64,
    /// The switch this one took over, by name.
    pub replaced: Option<String>,
    /// Whether the scene being applied shows the camera (or the screen).
    pub shows_camera: bool,
    pub shows_screen: bool,
}

/// What a phase moves (`Partial<Pick<SceneSwitchProgress, 'phase' |
/// 'showsCamera' | 'showsScreen'>>`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SceneSwitchPatch {
    pub phase: Option<SceneSwitchPhase>,
    pub shows_camera: Option<bool>,
    pub shows_screen: Option<bool>,
}

impl SceneSwitchPatch {
    pub fn phase(phase: SceneSwitchPhase) -> Self {
        Self {
            phase: Some(phase),
            ..Self::default()
        }
    }
}

/// `SCENE_SWITCH_STATUS_DELAY_MS`: how long a switch runs before its status
/// line appears.
pub const SCENE_SWITCH_STATUS_DELAY_MS: u64 = 1500;

/// `SCENE_SWITCH_PENDING_LABEL`: the label a control shows beside its name
/// while its switch runs.
pub const SCENE_SWITCH_PENDING_LABEL: &str = "Applying…";

/// `startSceneSwitchProgress`: a new switch, taking over `previous` when one
/// is still running toward another target.
pub fn start_scene_switch_progress(
    previous: Option<&SceneSwitchProgress>,
    intent_id: u64,
    target: &str,
    now_ms: u64,
) -> SceneSwitchProgress {
    SceneSwitchProgress {
        intent_id,
        target: target.to_string(),
        phase: SceneSwitchPhase::Preparing,
        started_at_ms: now_ms,
        replaced: previous
            .filter(|previous| previous.target != target)
            .map(|previous| previous.target.clone()),
        shows_camera: false,
        shows_screen: false,
    }
}

/// `advanceSceneSwitchProgress`: `progress` moved on to a later phase, only
/// while it is still the switch `intent_id` started. `None` when nothing
/// changes (the renderer keeps the same object).
pub fn advance_scene_switch_progress(
    progress: Option<&SceneSwitchProgress>,
    intent_id: u64,
    patch: SceneSwitchPatch,
) -> Option<SceneSwitchProgress> {
    let progress = progress.filter(|progress| progress.intent_id == intent_id)?;
    let next = SceneSwitchProgress {
        phase: patch.phase.unwrap_or(progress.phase),
        shows_camera: patch.shows_camera.unwrap_or(progress.shows_camera),
        shows_screen: patch.shows_screen.unwrap_or(progress.shows_screen),
        ..progress.clone()
    };
    (next != *progress).then_some(next)
}

/// `sceneSwitchStatusVisible`: the status line shows once the switch has
/// run a moment, or at once when it took over another.
pub fn scene_switch_status_visible(progress: &SceneSwitchProgress, now_ms: u64) -> bool {
    progress.replaced.is_some()
        || now_ms.saturating_sub(progress.started_at_ms) >= SCENE_SWITCH_STATUS_DELAY_MS
}

/// The instant the status line shows ([`scene_switch_status_visible`]), for
/// a UI that wants to draw again then.
pub fn scene_switch_status_visible_at(progress: &SceneSwitchProgress) -> u64 {
    if progress.replaced.is_some() {
        progress.started_at_ms
    } else {
        progress.started_at_ms + SCENE_SWITCH_STATUS_DELAY_MS
    }
}

fn phase_label(progress: &SceneSwitchProgress) -> &'static str {
    match progress.phase {
        SceneSwitchPhase::Preparing => "Getting ready…",
        SceneSwitchPhase::Starting if progress.shows_camera => {
            "Waiting for the camera's first frame…"
        }
        SceneSwitchPhase::Starting if progress.shows_screen => {
            "Waiting for the screen's first frame…"
        }
        SceneSwitchPhase::Starting => SCENE_SWITCH_PENDING_LABEL,
        SceneSwitchPhase::Drawing => "Drawing the new scene…",
        SceneSwitchPhase::Presenting => "Updating the preview…",
    }
}

/// The camera the status line may name (`{name, lowFrameRate}`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SwitchCamera {
    pub name: Option<String>,
    pub low_frame_rate: Option<CameraLowFrameRate>,
}

/// The status line's two parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneSwitchStatusLine {
    pub title: String,
    pub detail: Option<String>,
}

/// `sceneSwitchStatusLine`: "Side by side · Waiting for the camera's first
/// frame…", then the switch it replaced, and a slow camera when the scene
/// shows it.
pub fn scene_switch_status_line(
    progress: &SceneSwitchProgress,
    camera: Option<&SwitchCamera>,
) -> SceneSwitchStatusLine {
    let mut details = Vec::new();
    if let Some(replaced) = &progress.replaced {
        details.push(format!("Replaces the switch to {replaced}."));
    }
    if progress.shows_camera
        && progress.phase != SceneSwitchPhase::Preparing
        && let Some(camera) = camera
        && let Some(low) = camera.low_frame_rate
    {
        // The renderer's status line passes no Low-light compensation.
        details.push(camera_low_frame_rate_line(
            camera.name.as_deref(),
            low,
            false,
        ));
    }
    SceneSwitchStatusLine {
        title: format!("{} · {}", progress.target, phase_label(progress)),
        detail: (!details.is_empty()).then(|| details.join(" ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `scene-switch-progress.test.ts`.
    fn start(target: &str, intent_id: u64, now_ms: u64) -> SceneSwitchProgress {
        start_scene_switch_progress(None, intent_id, target, now_ms)
    }

    fn advance(
        progress: &SceneSwitchProgress,
        intent_id: u64,
        patch: SceneSwitchPatch,
    ) -> SceneSwitchProgress {
        advance_scene_switch_progress(Some(progress), intent_id, patch)
            .unwrap_or_else(|| progress.clone())
    }

    fn starting(camera: bool, screen: bool) -> SceneSwitchPatch {
        SceneSwitchPatch {
            phase: Some(SceneSwitchPhase::Starting),
            shows_camera: Some(camera),
            shows_screen: Some(screen),
        }
    }

    #[test]
    fn names_the_clicked_scene_and_each_phase_it_waits_on() {
        let mut progress = start("Side by side", 1, 1_000);
        assert_eq!(
            scene_switch_status_line(&progress, None).title,
            "Side by side · Getting ready…"
        );
        progress = advance(&progress, 1, starting(true, true));
        assert_eq!(
            scene_switch_status_line(&progress, None).title,
            "Side by side · Waiting for the camera's first frame…"
        );
        progress = advance(
            &progress,
            1,
            SceneSwitchPatch::phase(SceneSwitchPhase::Drawing),
        );
        assert_eq!(
            scene_switch_status_line(&progress, None).title,
            "Side by side · Drawing the new scene…"
        );
        progress = advance(
            &progress,
            1,
            SceneSwitchPatch::phase(SceneSwitchPhase::Presenting),
        );
        assert_eq!(
            scene_switch_status_line(&progress, None).title,
            "Side by side · Updating the preview…"
        );
    }

    #[test]
    fn waits_on_the_screen_or_just_applies_when_the_scene_has_no_camera() {
        let screen = advance(&start("Screen only", 1, 1_000), 1, starting(false, true));
        assert_eq!(
            scene_switch_status_line(&screen, None).title,
            "Screen only · Waiting for the screen's first frame…"
        );
        let neither = advance(
            &start("Freeform", 1, 1_000),
            1,
            SceneSwitchPatch::phase(SceneSwitchPhase::Starting),
        );
        assert_eq!(
            scene_switch_status_line(&neither, None).title,
            "Freeform · Applying…"
        );
    }

    #[test]
    fn ignores_a_phase_from_a_switch_a_newer_click_replaced() {
        let progress = start("Camera only", 2, 1_000);
        assert_eq!(
            advance_scene_switch_progress(
                Some(&progress),
                1,
                SceneSwitchPatch::phase(SceneSwitchPhase::Drawing)
            ),
            None
        );
        assert_eq!(
            advance_scene_switch_progress(
                None,
                1,
                SceneSwitchPatch::phase(SceneSwitchPhase::Drawing)
            ),
            None
        );
    }

    #[test]
    fn keeps_the_same_progress_when_nothing_changes() {
        let progress = start("Camera only", 1, 1_000);
        assert_eq!(
            advance_scene_switch_progress(
                Some(&progress),
                1,
                SceneSwitchPatch::phase(SceneSwitchPhase::Preparing)
            ),
            None
        );
    }

    #[test]
    fn shows_the_line_after_a_moment_and_at_once_when_a_click_took_over() {
        let progress = start("Side by side", 1, 1_000);
        assert!(!scene_switch_status_visible(
            &progress,
            1_000 + SCENE_SWITCH_STATUS_DELAY_MS - 1
        ));
        assert!(scene_switch_status_visible(
            &progress,
            1_000 + SCENE_SWITCH_STATUS_DELAY_MS
        ));
        assert_eq!(scene_switch_status_visible_at(&progress), 2_500);

        let takeover = start_scene_switch_progress(Some(&progress), 2, "Camera only", 1_200);
        assert_eq!(takeover.replaced.as_deref(), Some("Side by side"));
        assert!(scene_switch_status_visible(&takeover, 1_200));
        assert_eq!(scene_switch_status_visible_at(&takeover), 1_200);
        assert_eq!(
            scene_switch_status_line(&takeover, None),
            SceneSwitchStatusLine {
                title: "Camera only · Getting ready…".to_string(),
                detail: Some("Replaces the switch to Side by side.".to_string()),
            }
        );
    }

    #[test]
    fn a_second_click_on_the_same_scene_replaces_nothing() {
        let progress = start("Side by side", 1, 1_000);
        assert_eq!(
            start_scene_switch_progress(Some(&progress), 2, "Side by side", 1_100).replaced,
            None
        );
    }

    #[test]
    fn says_a_slow_camera_is_the_reason_only_when_the_scene_shows_it() {
        let low = CameraLowFrameRate {
            fps: 14.7,
            expected_fps: 30.0,
        };
        let c920 = SwitchCamera {
            name: Some("C920".to_string()),
            low_frame_rate: Some(low),
        };
        let camera = advance(&start("Camera only", 1, 1_000), 1, starting(true, false));
        assert_eq!(
            scene_switch_status_line(&camera, Some(&c920))
                .detail
                .as_deref(),
            Some("C920 is sending 15 of 30 fps. More light usually helps.")
        );
        let screen = advance(&start("Screen only", 1, 1_000), 1, starting(false, true));
        assert_eq!(scene_switch_status_line(&screen, Some(&c920)).detail, None);
        let steady = SwitchCamera {
            name: Some("C920".to_string()),
            low_frame_rate: None,
        };
        assert_eq!(
            scene_switch_status_line(&camera, Some(&steady)).detail,
            None
        );
    }
}
