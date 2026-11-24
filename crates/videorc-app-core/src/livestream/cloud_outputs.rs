//! S1.6c: what Videorc Cloud uploads (`lib/cloud-test-outputs.ts`): the
//! outputs a Test cloud pushes and the upload line's plan, both from the
//! saved capture config.

use serde::Serialize;
use serde_json::Value;

use super::cloud_view::UploadPlan;
use super::plan::{self, Video};
use super::targets::{self, Target};

/// `CloudTestOutput`: one feed a show would be created with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTestOutput {
    /// `horizontal` or `vertical`.
    pub orientation: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_kbps: u32,
}

impl CloudTestOutput {
    fn of(orientation: &'static str, video: &Video, video_kbps: u32) -> Self {
        Self {
            orientation,
            width: video.width,
            height: video.height,
            fps: video.fps,
            video_kbps,
        }
    }
}

/// The destinations that are on: enabled and in `enabledTargetIds`.
fn enabled_targets(capture: &Value, all: &[Target]) -> Vec<Target> {
    let ids: Vec<&str> = capture["streaming"]["enabledTargetIds"]
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    all.iter()
        .filter(|t| t.enabled && ids.contains(&t.id.as_str()))
        .cloned()
        .collect()
}

/// `cloudTestOutputs` (plan 184 C6b): horizontal at the lowest bitrate the
/// enabled horizontal destinations stream at, or the default stream profile
/// with none set up yet; vertical only when the dual-orientation leg is
/// armed, at that leg's profile.
pub fn cloud_test_outputs(capture: &Value) -> Vec<CloudTestOutput> {
    let all = targets::targets(capture);
    let streaming = plan::streaming_of(capture, &all);
    let recording = plan::recording_video(capture);
    let horizontal: Vec<Video> = enabled_targets(capture, &all)
        .iter()
        .filter(|t| !t.vertical())
        .map(|t| plan::video_for_target(&recording, &streaming, t))
        .collect();
    let first = horizontal
        .first()
        .cloned()
        .unwrap_or_else(|| plan::stream_output_video(&recording, &streaming));
    let lowest = horizontal
        .iter()
        .map(|video| video.bitrate_kbps)
        .fold(first.bitrate_kbps, u32::min);
    let mut outputs = vec![CloudTestOutput::of("horizontal", &first, lowest)];
    let stream_enabled = capture["streamEnabled"].as_bool().unwrap_or(false);
    if plan::simulcast_armed(capture, &all, stream_enabled) {
        let vertical = plan::simulcast_video(&recording, &streaming).vertical();
        outputs.push(CloudTestOutput::of(
            "vertical",
            &vertical,
            vertical.bitrate_kbps,
        ));
    }
    outputs
}

/// `cloudUploadPlan` (plan 222 U2, U3): through the cloud, one feed per
/// orientation in use; directly, every destination's own stream. Video
/// bitrates only, like Test. `None` with no destination on.
pub fn cloud_upload_plan(capture: &Value) -> Option<UploadPlan> {
    let all = targets::targets(capture);
    let enabled = enabled_targets(capture, &all);
    if enabled.is_empty() {
        return None;
    }
    let streaming = plan::streaming_of(capture, &all);
    let recording = plan::recording_video(capture);
    let (vertical, horizontal): (Vec<&Target>, Vec<&Target>) =
        enabled.iter().partition(|t| t.vertical());
    let outputs = cloud_test_outputs(capture);
    let feed = |orientation: &str| {
        outputs
            .iter()
            .find(|output| output.orientation == orientation)
            .map(|output| output.video_kbps)
    };
    let mut feeds_kbps = Vec::new();
    if !horizontal.is_empty() {
        feeds_kbps.extend(feed("horizontal"));
    }
    if !vertical.is_empty() {
        feeds_kbps.extend(feed("vertical"));
    }
    if feeds_kbps.is_empty() {
        return None;
    }
    let direct_horizontal: u32 = horizontal
        .iter()
        .map(|t| plan::video_for_target(&recording, &streaming, t).bitrate_kbps)
        .sum();
    let direct_vertical =
        u32::try_from(vertical.len()).unwrap_or(u32::MAX) * feed("vertical").unwrap_or(0);
    Some(UploadPlan {
        feeds_kbps,
        direct_kbps: direct_horizontal + direct_vertical,
        destinations: enabled.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(id: &str, platform: &str, kbps: u32, vertical: bool) -> Value {
        json!({
            "id": id,
            "platform": platform,
            "label": id,
            "enabled": true,
            "outputPreset": "stream-safe-1080p30",
            "outputBitrateKbps": kbps,
            "outputOrientation": if vertical { "vertical" } else { "horizontal" },
        })
    }

    fn capture(targets: Vec<Value>, enabled: &[&str]) -> Value {
        json!({
            "streamEnabled": true,
            "video": { "preset": "custom", "width": 1920, "height": 1080, "fps": 30, "bitrateKbps": 8000 },
            "layout": { "layoutPreset": "screen-camera" },
            "streaming": {
                "enabled": true,
                "defaultOutputPreset": "stream-safe-1080p30",
                "defaultBitrateKbps": 6000,
                "targets": targets,
                "enabledTargetIds": enabled,
            },
        })
    }

    #[test]
    fn a_test_with_no_destination_pushes_the_default_stream_profile() {
        let outputs = cloud_test_outputs(&capture(Vec::new(), &[]));
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].orientation, "horizontal");
        assert_eq!(outputs[0].video_kbps, 6000);
        assert_eq!(cloud_upload_plan(&capture(Vec::new(), &[])), None);
    }

    #[test]
    fn horizontal_takes_the_lowest_bitrate_and_a_vertical_leg_adds_a_feed() {
        let config = capture(
            vec![
                target("a", "twitch", 6000, false),
                target("b", "kick", 4500, false),
                target("c", "youtube", 3000, true),
            ],
            &["a", "b", "c"],
        );
        let outputs = cloud_test_outputs(&config);
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].video_kbps, 4500);
        assert_eq!(outputs[1].orientation, "vertical");
        assert!(outputs[1].height > outputs[1].width);

        let plan = cloud_upload_plan(&config).expect("a plan");
        assert_eq!(plan.destinations, 3);
        assert_eq!(plan.feeds_kbps, vec![4500, outputs[1].video_kbps]);
        assert_eq!(plan.direct_kbps, 6000 + 4500 + outputs[1].video_kbps);
    }

    #[test]
    fn a_destination_left_out_of_the_enabled_ids_uploads_nothing() {
        let config = capture(vec![target("a", "twitch", 6000, false)], &[]);
        assert_eq!(cloud_upload_plan(&config), None);
        assert_eq!(cloud_test_outputs(&config)[0].video_kbps, 6000);
    }
}
