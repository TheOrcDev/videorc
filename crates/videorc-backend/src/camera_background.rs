//! Plan 258 S1: the one-choice rule for a camera's background.
//!
//! A camera's background (`protocol::CameraBackground`, one per camera, D3)
//! is one pick: Off, a blur, a picture, a video, Cut out, or a green or blue
//! screen (D4). [`camera_background_treatment`] turns the pick, what the
//! system's own camera effect is doing and how the camera effect stage is
//! doing into exactly one treatment for the next frame, so a key and an
//! effect can never both apply, and an effect that has no fresh mask shows
//! the cover, never the room (D6).
//!
//! Nothing calls it yet: the stage that does (plan 258 S3) sits at the
//! camera publish point, and the compositor keeps keying from the scene
//! until then, so nothing renders differently.

use std::time::Duration;

use crate::protocol::{CameraBackground, CameraBackgroundMode};

/// D6: the newest mask must be younger than this (3 frames at 30 fps), or
/// the stage outputs the cover.
#[cfg_attr(not(test), allow(dead_code))]
pub const MAX_MASK_AGE: Duration = Duration::from_millis(100);

/// What the operating system's own camera effect does to the picture before
/// Videorc sees a frame: the camera status's `systemEffect` (plan 258 S4,
/// macOS Video Effects and Windows Studio Effects), as this rule reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum SystemEffect {
    /// No system effect is on, or the system can't say.
    None,
    /// The system blurs the background (macOS Portrait, Windows blur).
    BackgroundBlur,
    /// The system replaces the background (macOS 15 background replacement).
    BackgroundReplacement,
}

/// How the camera effect stage is doing for the camera in use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum StageState {
    /// No stage can run here (no engine on this platform or OS version, or
    /// the pick needs a later slice).
    Unavailable,
    /// The stage runs but has no mask since the effect, the camera or the
    /// session started (Vision's first request is cold for 0.7–1.4 s, S0).
    Starting,
    /// The newest finished mask is this old.
    Running { mask_age: Duration },
    /// The segmenter failed or stopped.
    Failed,
}

/// What the next camera frame gets. Exactly one, always.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum CameraBackgroundTreatment {
    /// The camera as captured: only while the camera's background is Off.
    Raw,
    /// The effect drawn with a fresh mask.
    Processed,
    /// D6's cover instead of the camera: the whole frame past Strong blur,
    /// the picture alone, or nothing for Cut out.
    Cover,
    /// The green or blue screen key, drawn by the compositor as today.
    Key,
}

/// The one-choice rule. `setting` is the camera's background (`None` reads
/// as Off). Off is the only way to [`CameraBackgroundTreatment::Raw`]; a
/// screen always keys; an effect is processed only with a mask younger than
/// [`MAX_MASK_AGE`], and gets the cover otherwise, however the stage failed.
///
/// `system_effect` never changes the answer (D12): apps can't turn macOS's
/// effects off, so Videorc's effect runs on top of them, and a system blur
/// is never taken as cover for a stalled stage. It is an input so that rule
/// is pinned by the table test, beside the rest.
#[cfg_attr(not(test), allow(dead_code))]
pub fn camera_background_treatment(
    setting: Option<&CameraBackground>,
    system_effect: SystemEffect,
    stage: StageState,
) -> CameraBackgroundTreatment {
    let _ = system_effect;
    let mode = setting.map_or(CameraBackgroundMode::Off, |setting| setting.mode);
    match mode {
        CameraBackgroundMode::Off => CameraBackgroundTreatment::Raw,
        CameraBackgroundMode::Green | CameraBackgroundMode::Blue => CameraBackgroundTreatment::Key,
        CameraBackgroundMode::Blur
        | CameraBackgroundMode::Image
        | CameraBackgroundMode::Video
        | CameraBackgroundMode::Cutout => match stage {
            StageState::Running { mask_age } if mask_age < MAX_MASK_AGE => {
                CameraBackgroundTreatment::Processed
            }
            StageState::Running { .. }
            | StageState::Starting
            | StageState::Failed
            | StageState::Unavailable => CameraBackgroundTreatment::Cover,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CameraBackgroundEdges, CameraBackgroundKey, CameraKeyEdges};
    use CameraBackgroundTreatment::{Cover, Key, Processed, Raw};

    const MODES: [CameraBackgroundMode; 7] = [
        CameraBackgroundMode::Off,
        CameraBackgroundMode::Blur,
        CameraBackgroundMode::Image,
        CameraBackgroundMode::Video,
        CameraBackgroundMode::Cutout,
        CameraBackgroundMode::Green,
        CameraBackgroundMode::Blue,
    ];
    const SYSTEM: [SystemEffect; 3] = [
        SystemEffect::None,
        SystemEffect::BackgroundBlur,
        SystemEffect::BackgroundReplacement,
    ];

    fn stages() -> [(&'static str, StageState); 7] {
        [
            ("unavailable", StageState::Unavailable),
            ("starting", StageState::Starting),
            (
                "fresh",
                StageState::Running {
                    mask_age: Duration::ZERO,
                },
            ),
            (
                "fresh 99 ms",
                StageState::Running {
                    mask_age: Duration::from_millis(99),
                },
            ),
            (
                "stale 100 ms",
                StageState::Running {
                    mask_age: MAX_MASK_AGE,
                },
            ),
            (
                "stale 2 s",
                StageState::Running {
                    mask_age: Duration::from_secs(2),
                },
            ),
            ("failed", StageState::Failed),
        ]
    }

    fn setting(mode: CameraBackgroundMode) -> CameraBackground {
        CameraBackground {
            mode,
            blur_pct: 70,
            edges: CameraBackgroundEdges::Balanced,
            asset_id: Some("bundled-podcast".to_string()),
            key: Some(CameraBackgroundKey {
                similarity_pct: 40,
                smoothness_pct: 8,
                spill_pct: 10,
                hide_edges: CameraKeyEdges::default(),
            }),
        }
    }

    /// The expected treatment by mode and stage, for every system effect.
    fn expected(mode: CameraBackgroundMode, stage: &str) -> CameraBackgroundTreatment {
        use CameraBackgroundMode as M;
        match (mode, stage) {
            (M::Off, _) => Raw,
            (M::Green | M::Blue, _) => Key,
            (_, "fresh" | "fresh 99 ms") => Processed,
            _ => Cover,
        }
    }

    #[test]
    fn camera_background_treatment_table() {
        let mut rows = 0;
        for mode in MODES {
            for system in SYSTEM {
                for (name, stage) in stages() {
                    let got = camera_background_treatment(Some(&setting(mode)), system, stage);
                    assert_eq!(
                        got,
                        expected(mode, name),
                        "{mode:?} with system {system:?} and stage {name}"
                    );
                    rows += 1;
                }
            }
        }
        assert_eq!(rows, 7 * 3 * 7);
    }

    #[test]
    fn no_setting_is_off_and_raw_whatever_the_stage() {
        for system in SYSTEM {
            for (name, stage) in stages() {
                assert_eq!(
                    camera_background_treatment(None, system, stage),
                    Raw,
                    "{name}"
                );
            }
        }
    }

    /// Privacy invariant 6: green screen and an effect are never both
    /// applied, and invariant 3: only Off returns raw frames.
    #[test]
    fn exactly_one_treatment_and_raw_only_when_off() {
        for mode in MODES {
            for system in SYSTEM {
                for (name, stage) in stages() {
                    let got = camera_background_treatment(Some(&setting(mode)), system, stage);
                    let is_screen = matches!(
                        mode,
                        CameraBackgroundMode::Green | CameraBackgroundMode::Blue
                    );
                    assert_eq!(got == Key, is_screen, "{mode:?} {name}");
                    assert_eq!(
                        got == Raw,
                        mode == CameraBackgroundMode::Off,
                        "{mode:?} {name}"
                    );
                    if !is_screen && mode != CameraBackgroundMode::Off {
                        assert!(matches!(got, Processed | Cover), "{mode:?} {name}");
                    }
                }
            }
        }
    }

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../protocol-fixtures/camera-background.json"
        ))
        .expect("protocol-fixtures/camera-background.json is valid JSON")
    }

    /// Every field survives serde both ways, alone and on a layout, and a
    /// layout without one goes out as layouts did before plan 258.
    #[test]
    fn camera_background_fixture_round_trips_every_field() {
        let fixture = fixture();
        let mut wires = vec![fixture["full"].clone(), fixture["minimal"].clone()];
        wires.extend(fixture["everyMode"].as_array().unwrap().iter().cloned());
        assert_eq!(wires.len(), 9);
        for wire in wires {
            let background: CameraBackground = serde_json::from_value(wire.clone())
                .unwrap_or_else(|error| panic!("{wire} must parse: {error}"));
            assert_eq!(serde_json::to_value(&background).unwrap(), wire);
            let mut layout = crate::protocol::default_layout_settings();
            layout.camera_background = Some(background.clone());
            let layout_wire = serde_json::to_value(&layout).unwrap();
            assert_eq!(layout_wire["cameraBackground"], wire);
            let back: crate::protocol::LayoutSettings =
                serde_json::from_value(layout_wire).unwrap();
            assert_eq!(back.camera_background, Some(background));
        }
        let full: CameraBackground = serde_json::from_value(fixture["full"].clone()).unwrap();
        assert_eq!(full.mode, CameraBackgroundMode::Image);
        assert_eq!(full.blur_pct, 30);
        assert_eq!(full.edges, CameraBackgroundEdges::Soft);
        assert_eq!(full.asset_id.as_deref(), Some("bundled-podcast"));
        let key = full.key.unwrap();
        assert_eq!(
            (key.similarity_pct, key.smoothness_pct, key.spill_pct),
            (42, 9, 12)
        );
        assert_eq!(
            key.hide_edges,
            CameraKeyEdges {
                left_pct: 3,
                top_pct: 0,
                right_pct: 5,
                bottom_pct: 1,
            }
        );
        let plain = serde_json::to_value(crate::protocol::default_layout_settings()).unwrap();
        assert!(plain.get("cameraBackground").is_none());
        let legacy: crate::protocol::LayoutSettings = serde_json::from_value(plain).unwrap();
        assert_eq!(legacy.camera_background, None);
    }

    #[test]
    fn camera_background_fixture_rejected_shapes_never_parse() {
        let fixture = fixture();
        for wire in fixture["rejectedEverywhere"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<CameraBackground>(wire.clone()).is_err(),
                "{wire} must be refused"
            );
            if !wire.is_null() {
                let mut layout =
                    serde_json::to_value(crate::protocol::default_layout_settings()).unwrap();
                layout["cameraBackground"] = wire.clone();
                assert!(
                    serde_json::from_value::<crate::protocol::LayoutSettings>(layout).is_err(),
                    "a layout carrying {wire} must be refused"
                );
            }
        }
    }
}
