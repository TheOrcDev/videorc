//! `sources.scene_pictures` (plan 231 D7, D17): a still of the screen each
//! scene shows, for the Scene page's cards and the scene picker. Still
//! pictures are independent of every running capture and compositor. Only
//! macOS takes them; elsewhere every target is `unsupported`, and while the
//! screen is hidden every target is `hidden`.
//!
//! The TS mirror is `ScenePicturesParams` / `ScenePicturesResult` in
//! `apps/desktop/src/shared/backend.ts`; both sides read
//! `protocol-fixtures/scene-pictures.json`.

use serde::{Deserialize, Serialize};

pub const METHOD: &str = "sources.scene_pictures";
/// The most targets one request may name.
pub const MAX_TARGETS: usize = 512;
/// The picture width bounds, when one is asked for.
pub const MIN_WIDTH: u32 = 32;
pub const MAX_WIDTH: u32 = 1920;

/// Why a target has no picture.
pub mod unavailable {
    pub const HIDDEN: &str = "hidden";
    pub const UNSUPPORTED: &str = "unsupported";
    pub const SOURCE_UNAVAILABLE: &str = "source-unavailable";
    pub const SCREENSHOT_UNAVAILABLE: &str = "screenshot-unavailable";
    pub const ALL: [&str; 4] = [
        HIDDEN,
        UNSUPPORTED,
        SOURCE_UNAVAILABLE,
        SCREENSHOT_UNAVAILABLE,
    ];
}

/// `ScenePictureTarget`: the app (its front window), the fixed window or
/// the display a scene shows.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ScenePictureTarget {
    App {
        #[serde(rename = "bundleId")]
        bundle_id: String,
    },
    Window {
        #[serde(rename = "windowId")]
        window_id: String,
    },
    Display {
        #[serde(rename = "screenId")]
        screen_id: String,
    },
}

impl ScenePictureTarget {
    /// The id the target names.
    pub fn id(&self) -> &str {
        match self {
            ScenePictureTarget::App { bundle_id } => bundle_id,
            ScenePictureTarget::Window { window_id } => window_id,
            ScenePictureTarget::Display { screen_id } => screen_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenePicturesParams {
    pub targets: Vec<ScenePictureTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u32>,
}

impl ScenePicturesParams {
    /// The contract's bounds: at most 512 targets, a width of 32 to 1920,
    /// and every id non-blank and at most 16 KiB.
    pub fn valid(&self) -> bool {
        self.targets.len() <= MAX_TARGETS
            && self
                .max_width
                .is_none_or(|width| (MIN_WIDTH..=MAX_WIDTH).contains(&width))
            && self.targets.iter().all(|target| {
                let id = target.id();
                !id.trim().is_empty() && id.len() <= 16_384
            })
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenePicturesResult {
    pub pictures: Vec<ScenePicture>,
    pub elapsed_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<bool>,
}

impl ScenePicturesResult {
    /// Every target unavailable for one reason (an [`unavailable`] word);
    /// `hidden` and `unsupported` also mark the whole answer.
    pub fn unavailable(targets: Vec<ScenePictureTarget>, reason: &str) -> Self {
        Self {
            pictures: targets
                .into_iter()
                .map(|target| ScenePicture {
                    target,
                    outcome: ScenePictureOutcome::Unavailable(reason.into()),
                })
                .collect(),
            elapsed_ms: 0.0,
            hidden: (reason == unavailable::HIDDEN).then_some(true),
            unsupported: (reason == unavailable::UNSUPPORTED).then_some(true),
        }
    }

    /// The picture for `target`, as JPEG base64, when there is one.
    pub fn jpeg_for(&self, target: &ScenePictureTarget) -> Option<&str> {
        self.pictures
            .iter()
            .find(|picture| &picture.target == target)
            .and_then(|picture| match &picture.outcome {
                ScenePictureOutcome::JpegBase64(jpeg) => Some(jpeg.as_str()),
                ScenePictureOutcome::Unavailable(_) => None,
            })
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ScenePicture {
    pub target: ScenePictureTarget,
    #[serde(flatten)]
    pub outcome: ScenePictureOutcome,
}

/// A picture, or the [`unavailable`] word for why there is none.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScenePictureOutcome {
    JpegBase64(String),
    Unavailable(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const FIXTURE: &str = include_str!("../../../protocol-fixtures/scene-pictures.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("fixture parses")
    }

    #[test]
    fn the_fixture_params_round_trip_and_are_valid() {
        let fixture = fixture();
        let params: ScenePicturesParams =
            serde_json::from_value(fixture["params"].clone()).expect("params fit");
        assert!(params.valid());
        assert_eq!(params.targets.len(), 3);
        assert_eq!(serde_json::to_value(&params).unwrap(), fixture["params"]);
    }

    #[test]
    fn every_fixture_result_round_trips() {
        let fixture = fixture();
        for name in ["result", "hidden", "unsupported"] {
            let result: ScenePicturesResult = serde_json::from_value(fixture[name].clone())
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(
                serde_json::to_value(&result).unwrap(),
                fixture[name],
                "{name}"
            );
            for picture in &result.pictures {
                if let ScenePictureOutcome::Unavailable(reason) = &picture.outcome {
                    assert!(unavailable::ALL.contains(&reason.as_str()), "{reason}");
                }
            }
        }
    }

    #[test]
    fn unavailable_answers_match_the_fixture() {
        let fixture = fixture();
        let params: ScenePicturesParams =
            serde_json::from_value(fixture["params"].clone()).unwrap();
        for (name, reason) in [
            ("hidden", unavailable::HIDDEN),
            ("unsupported", unavailable::UNSUPPORTED),
        ] {
            let answer = ScenePicturesResult::unavailable(params.targets.clone(), reason);
            assert_eq!(
                serde_json::to_value(answer).unwrap(),
                fixture[name],
                "{name}"
            );
        }
    }

    #[test]
    fn a_picture_is_found_by_its_target() {
        let result: ScenePicturesResult =
            serde_json::from_value(fixture()["result"].clone()).unwrap();
        let app = ScenePictureTarget::App {
            bundle_id: "com.figma.Desktop".into(),
        };
        let window = ScenePictureTarget::Window {
            window_id: "window:screencapturekit:7".into(),
        };
        assert_eq!(result.jpeg_for(&app), Some("/9j/4AAQ"));
        assert_eq!(result.jpeg_for(&window), None);
    }

    #[test]
    fn out_of_bounds_params_are_refused() {
        let target = json!({ "kind": "display", "screenId": "screen:1" });
        let params = |value: Value| serde_json::from_value::<ScenePicturesParams>(value);
        assert!(
            !params(json!({ "targets": [target], "maxWidth": 16 }))
                .unwrap()
                .valid()
        );
        assert!(
            !params(json!({ "targets": [{ "kind": "app", "bundleId": " " }] }))
                .unwrap()
                .valid()
        );
        assert!(params(json!({ "targets": [target], "extra": 1 })).is_err());
        assert!(params(json!({ "targets": [{ "kind": "tab", "id": "x" }] })).is_err());
        let many: Vec<Value> = (0..=MAX_TARGETS).map(|_| target.clone()).collect();
        assert!(!params(json!({ "targets": many })).unwrap().valid());
    }
}
