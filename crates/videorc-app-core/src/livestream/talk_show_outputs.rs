//! Plan 249 S17: the outputs a cloud talk-show room opens with, decided
//! before it is created (`lib/talk-show-outputs.ts`), and what the managed
//! egress makes of them (`shared/cloud-output-profile.ts`). A room's outputs
//! are fixed at creation, so they come from everything the show may use: one
//! per orientation of the enabled destinations (at the highest profile any of
//! them asks for), and the canvas's orientation when the show records or has
//! no destination yet. The managed half is pinned, like Electron's and the
//! web's copies, by `protocol-fixtures/cloud-parity-outputs.json`.
//!
//! - Managed egress encodes every program output the same way: 1080p
//!   (1920x1080, or 1080x1920 upright), H.264, 6 Mbps, 60 fps, AAC 160 kbps.
//! - A 60 fps request is sent as the qualified 30 fps picture inside the 60
//!   fps stream (Plan 234 Phase 0), and the room says so before it opens.
//! - Above 1080p nothing is measured: such a request is refused with its
//!   reason, never sent as 1080p under a higher claim.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::plan::{self, Streaming, Video};
use super::targets::{self, Target};

/// `MANAGED_ENCODING`: what managed egress sends.
const ENCODED_FPS: u32 = 60;
const ENCODED_VIDEO_KBPS: u32 = 6000;
const ENCODED_AUDIO_KBPS: u32 = 160;
/// `MANAGED_QUALIFIED`: the measured profile, 1080p with a 30 fps picture.
const QUALIFIED_LONG_SIDE: u32 = 1920;
const QUALIFIED_SHORT_SIDE: u32 = 1080;
const QUALIFIED_PICTURE_FPS: u32 = 30;
/// `MANAGED_HIGHER_PROFILES`: measured records only, none yet.
const HIGHER_PROFILES: [(&str, u32); 2] = [("1440p", 2560), ("4K", 3840)];
const QUALIFICATION: &str = "phase0-1080p30-picture";

/// `ManagedOutput`: one output a room is asked to open with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedOutput {
    /// `horizontal` or `vertical`.
    pub orientation: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_kbps: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_kbps: Option<u32>,
}

/// `ManagedEffectiveOutput`: what an output becomes, and how it differs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedEffectiveOutput {
    pub orientation: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// The picture's qualified cadence inside the encoded stream.
    pub picture_fps: u32,
    pub video_kbps: u32,
    pub audio_kbps: u32,
    /// `resolution`, `fps`, `bitrate`.
    pub differences: Vec<String>,
}

/// `ManagedOutputProfile`, version 1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedOutputProfile {
    pub version: u32,
    pub requested: Vec<ManagedOutput>,
    pub effective: Vec<ManagedEffectiveOutput>,
    pub qualification: String,
    pub higher_profiles_qualified: bool,
    /// No price is published for a show: always null.
    pub price_per_hour: Option<u32>,
    /// One stream egress and one recording egress per orientation, at most.
    pub max_program_egresses: u32,
}

fn vertical(orientation: &str) -> bool {
    orientation == "vertical"
}

/// The qualified output's width and height in `orientation`.
fn sides(orientation: &str) -> (u32, u32) {
    if vertical(orientation) {
        (QUALIFIED_SHORT_SIDE, QUALIFIED_LONG_SIDE)
    } else {
        (QUALIFIED_LONG_SIDE, QUALIFIED_SHORT_SIDE)
    }
}

/// `managedOutputProblem`: why these outputs can't open a room, or none.
/// Bitrate and 60 fps are disclosed, not refused.
pub fn managed_output_problem(outputs: &[ManagedOutput]) -> Option<String> {
    let mut orientations: Vec<&str> = outputs.iter().map(|o| o.orientation.as_str()).collect();
    orientations.sort_unstable();
    orientations.dedup();
    if outputs.is_empty() || outputs.len() > 2 || orientations.len() != outputs.len() {
        return Some("Choose one output per orientation before opening the room.".into());
    }
    for output in outputs {
        if !matches!(output.orientation.as_str(), "horizontal" | "vertical")
            || [output.width, output.height, output.fps, output.video_kbps].contains(&0)
        {
            return Some("Cloud room outputs need a size, a frame rate and a bitrate.".into());
        }
        let (width, height) = sides(&output.orientation);
        if u64::from(output.width) * u64::from(height)
            != u64::from(output.height) * u64::from(width)
        {
            return Some(if vertical(&output.orientation) {
                "A vertical cloud output must be 9:16.".into()
            } else {
                "A horizontal cloud output must be 16:9.".into()
            });
        }
        if output.width > width || output.height > height {
            let long = output.width.max(output.height);
            let higher = HIGHER_PROFILES
                .iter()
                .find(|(_, long_side)| long <= *long_side)
                .map_or("This size", |(label, _)| label);
            return Some(format!(
                "Cloud talk shows send 1080p. {higher} hasn't been measured on cloud outputs yet, so it can't be used. Choose 1080p or lower for the room, or stream directly."
            ));
        }
        if output.fps > ENCODED_FPS {
            return Some(format!("Cloud talk shows send at most {ENCODED_FPS} fps."));
        }
    }
    None
}

/// `managedOutputProfile`: what each requested output becomes, and how it
/// differs from the request.
pub fn managed_output_profile(requested: &[ManagedOutput]) -> ManagedOutputProfile {
    let effective = requested
        .iter()
        .map(|output| {
            let (width, height) = sides(&output.orientation);
            let mut differences = Vec::new();
            if output.width != width || output.height != height {
                differences.push("resolution".to_string());
            }
            if output.fps > QUALIFIED_PICTURE_FPS {
                differences.push("fps".to_string());
            }
            if output.video_kbps != ENCODED_VIDEO_KBPS {
                differences.push("bitrate".to_string());
            }
            ManagedEffectiveOutput {
                orientation: output.orientation.clone(),
                width,
                height,
                fps: ENCODED_FPS,
                picture_fps: QUALIFIED_PICTURE_FPS,
                video_kbps: ENCODED_VIDEO_KBPS,
                audio_kbps: ENCODED_AUDIO_KBPS,
                differences,
            }
        })
        .collect();
    ManagedOutputProfile {
        version: 1,
        requested: requested.to_vec(),
        effective,
        qualification: QUALIFICATION.to_string(),
        higher_profiles_qualified: false,
        price_per_hour: None,
        max_program_egresses: u32::try_from(requested.len() * 2).unwrap_or(u32::MAX),
    }
}

/// `managedDestinationProblem`: whether a destination can go to this room,
/// before anything is prepared on its platform. Its orientation must be one
/// the room opened with, and its address an RTMP or RTMPS one. An empty `url`
/// is a platform's own (no custom address to check).
pub fn managed_destination_problem(
    label: &str,
    orientation: &str,
    url: Option<&str>,
    room_orientations: &[&str],
) -> Option<String> {
    if !matches!(orientation, "horizontal" | "vertical") {
        return Some(format!("{label} needs a horizontal or vertical output."));
    }
    if !room_orientations.contains(&orientation) {
        return Some(format!(
            "{label} is {orientation}, and this room opened without a {orientation} output. Close the room and open it again with {label} on."
        ));
    }
    let rtmp = |url: &str| {
        let lower = url.to_ascii_lowercase();
        lower.starts_with("rtmp://") || lower.starts_with("rtmps://")
    };
    if let Some(url) = url.filter(|url| !url.is_empty())
        && !rtmp(url)
    {
        return Some(format!(
            "{label} needs an rtmp:// or rtmps:// address for cloud output."
        ));
    }
    None
}

fn orientation_word(orientation: &str) -> &'static str {
    if vertical(orientation) {
        "Vertical"
    } else {
        "Horizontal"
    }
}

/// `managedProfileDescription`: one sentence per output, what viewers get and
/// what differs from the request.
pub fn managed_profile_description(profile: Option<&ManagedOutputProfile>) -> String {
    let Some(profile) = profile.filter(|profile| profile.version == 1) else {
        return "This room didn't report its output profile. Reopen the room to see it.".into();
    };
    let mbps = |kbps: u32| f64::from(kbps) / 1000.0;
    let lines: Vec<String> = profile
        .effective
        .iter()
        .map(|output| {
            let has = |difference: &str| output.differences.iter().any(|d| d == difference);
            let mut notes = Vec::new();
            if has("resolution") {
                notes.push("scaled to 1080p".to_string());
            }
            if has("fps") {
                notes.push(format!("{} fps picture", output.picture_fps));
            }
            if has("bitrate") {
                notes.push(format!("{} Mbps", mbps(output.video_kbps)));
            }
            let differs = if notes.is_empty() {
                String::new()
            } else {
                format!(" (differs from your settings: {})", notes.join(", "))
            };
            format!(
                "{} {}×{}, {} fps picture in a {} fps stream, {} Mbps H.264, AAC {} kbps{}",
                orientation_word(&output.orientation),
                output.width,
                output.height,
                output.picture_fps,
                output.fps,
                mbps(output.video_kbps),
                output.audio_kbps,
                differs
            )
        })
        .collect();
    let egress = if profile.effective.len() == 2 {
        "Each orientation is its own cloud output"
    } else {
        "One cloud output"
    };
    format!(
        "{}. {egress}; recording adds one per orientation. 1440p and 4K aren't available yet.",
        lines.join(". ")
    )
}

/// `TalkShowOutputPlan`: the outputs a room would open with now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TalkShowOutputPlan {
    pub outputs: Vec<ManagedOutput>,
    /// Why the room can't open with these settings, or none.
    pub problem: Option<String>,
    /// What viewers will get, or the problem, in words (the Guests page's
    /// closed-room line).
    pub description: String,
}

/// `coerceVideoToOrientation`: the profile transposed to `orientation`.
fn coerce(video: &Video, orientation: &str) -> Video {
    let transpose = if vertical(orientation) {
        video.width > video.height
    } else {
        video.height > video.width
    };
    if !transpose {
        return video.clone();
    }
    Video {
        preset: "custom".into(),
        width: video.height,
        height: video.width,
        ..video.clone()
    }
}

/// The destinations that are on: enabled and in `enabledTargetIds`.
fn enabled_targets<'a>(capture: &Value, all: &'a [Target]) -> Vec<&'a Target> {
    let ids: Vec<&str> = capture["streaming"]["enabledTargetIds"]
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    all.iter()
        .filter(|target| target.enabled && ids.contains(&target.id.as_str()))
        .collect()
}

fn target_orientation(target: &Target) -> &'static str {
    if target.vertical() {
        "vertical"
    } else {
        "horizontal"
    }
}

/// `talkShowOutputPlan`: one output per orientation of the enabled
/// destinations, at the highest profile any of them asks for, plus the
/// canvas's orientation when the show records or has no destination; refused
/// with its reason when a destination or a profile can't go to a room.
pub fn talk_show_output_plan(capture: &Value) -> TalkShowOutputPlan {
    let mut outputs: Vec<ManagedOutput> = Vec::new();
    let all = targets::targets(capture);
    let recording = plan::recording_video(capture);
    // Each destination at what it would stream, as if streaming were on.
    let streaming = Streaming {
        enabled: true,
        ..plan::streaming_of(capture, &all)
    };
    for target in enabled_targets(capture, &all) {
        let orientation = target_orientation(target);
        if let Some(problem) = managed_destination_problem(
            &target.label,
            orientation,
            Some(target.server_url.as_str()),
            &[orientation],
        ) {
            return refused(outputs, problem);
        }
        let video = plan::video_for_target(&recording, &streaming, target);
        add(&mut outputs, orientation, &video);
    }
    let record = capture["recordEnabled"].as_bool().unwrap_or(false);
    if record || outputs.is_empty() {
        let canvas = if recording.height > recording.width {
            "vertical"
        } else {
            "horizontal"
        };
        add(&mut outputs, canvas, &recording);
    }
    // Horizontal first.
    outputs.sort_by_key(|output| vertical(&output.orientation));
    if let Some(problem) = managed_output_problem(&outputs) {
        return refused(outputs, problem);
    }
    let description = managed_profile_description(Some(&managed_output_profile(&outputs)));
    TalkShowOutputPlan {
        outputs,
        problem: None,
        description,
    }
}

/// A refused plan says its problem as its description.
fn refused(outputs: Vec<ManagedOutput>, problem: String) -> TalkShowOutputPlan {
    TalkShowOutputPlan {
        outputs,
        description: problem.clone(),
        problem: Some(problem),
    }
}

/// The plan's `add`: `source` in `orientation` as a new output, or the
/// larger of it and the one already there, side by side.
fn add(outputs: &mut Vec<ManagedOutput>, orientation: &str, source: &Video) {
    let video = coerce(source, orientation);
    match outputs.iter_mut().find(|o| o.orientation == orientation) {
        None => outputs.push(ManagedOutput {
            orientation: orientation.to_string(),
            width: video.width,
            height: video.height,
            fps: video.fps,
            video_kbps: video.bitrate_kbps,
            audio_kbps: None,
        }),
        Some(previous) => {
            previous.width = previous.width.max(video.width);
            previous.height = previous.height.max(video.height);
            previous.fps = previous.fps.max(video.fps);
            previous.video_kbps = previous.video_kbps.max(video.bitrate_kbps);
        }
    }
}

/// `talkShowOutputStartProblem`: before anything is prepared on a platform
/// in an open room, every destination this start streams to must fit the
/// outputs the room opened with. A room that reported no profile (a node
/// show, or a web from before S17), and a start that doesn't stream, are
/// never blocked here.
pub fn talk_show_output_start_problem(
    capture: &Value,
    profile: Option<&ManagedOutputProfile>,
    stream: bool,
) -> Option<String> {
    let profile = profile.filter(|profile| profile.version == 1)?;
    if !stream {
        return None;
    }
    let room: Vec<&str> = profile
        .effective
        .iter()
        .map(|output| output.orientation.as_str())
        .collect();
    let all = targets::targets(capture);
    enabled_targets(capture, &all)
        .into_iter()
        .find_map(|target| {
            managed_destination_problem(
                &target.label,
                target_orientation(target),
                Some(target.server_url.as_str()),
                &room,
            )
        })
}

#[cfg(test)]
#[path = "talk_show_outputs_tests.rs"]
mod tests;
