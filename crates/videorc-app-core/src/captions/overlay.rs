//! The caption bar on the outputs (Electron's burn-in driver in
//! `use-studio.tsx` and `lib/captions-ui.ts`): which compositor targets get a
//! bar and at what canvas (`captionOverlayTargetPlan`), the key that says a
//! bar must be drawn again (`captionOverlayKey`), how long a line stays
//! (`captionDwellMs`), and the push-or-clear decision (`decideOverlayPush`).
//! The backend draws the bar from the line's text (`captions.overlay.set`;
//! `cloud.speech.overlay` while a talk-show room is open).

use std::time::Duration;

use serde_json::{Value, json};

use super::{CaptionLine, Status};
use crate::livestream::plan::{self, Video};
use crate::studio::capture_config;
use crate::studio::session::SessionStartIntent;

/// A compositor role the backend keeps for the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Primary,
    Auxiliary,
}

impl Target {
    pub fn as_str(self) -> &'static str {
        match self {
            Target::Primary => "primary",
            Target::Auxiliary => "auxiliary",
        }
    }
}

/// One bar to draw: its target, the canvas it is drawn for, and the
/// captions rect for that canvas's orientation (plan 164).
#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    pub target: Target,
    /// `recording` or `stream`, for the key.
    pub leg: &'static str,
    pub width: u32,
    pub height: u32,
    pub rect: Option<Value>,
}

/// `overlayOrientationForCanvas`.
fn orientation(width: u32, height: u32) -> &'static str {
    if height > width {
        "vertical"
    } else {
        "horizontal"
    }
}

fn output(target: Target, leg: &'static str, video: (u32, u32), layout: Option<&Value>) -> Output {
    let (width, height) = video;
    Output {
        target,
        leg,
        width,
        height,
        rect: layout
            .map(|layout| layout["captions"][orientation(width, height)].clone())
            .filter(Value::is_object),
    }
}

/// `captureConfigForIntent`: the saved config with the running session's
/// outputs.
pub fn session_config(capture: &Value, intent: SessionStartIntent) -> Value {
    let mut config = capture.clone();
    if let Some(object) = config.as_object_mut() {
        object.insert("recordEnabled".into(), Value::Bool(intent.record));
        object.insert("streamEnabled".into(), Value::Bool(intent.stream));
    }
    config
}

/// `auxiliaryStreamOutputVideoSettings`: the first destination profile that
/// differs from the recording's, else the recording's.
fn auxiliary_stream_video(capture: &Value, recording: &Video) -> (u32, u32) {
    plan::go_live_plan(capture, recording, false)
        .targets
        .iter()
        .map(|(.., video)| video)
        .find(|video| {
            (video.width, video.height, video.fps, video.bitrate_kbps)
                != (
                    recording.width,
                    recording.height,
                    recording.fps,
                    recording.bitrate_kbps,
                )
        })
        .map_or((recording.width, recording.height), |video| {
            (video.width, video.height)
        })
}

/// `simulcastLegVideo`: the armed vertical leg's portrait canvas.
fn vertical_leg(capture: &Value, recording: &Video) -> Option<(u32, u32)> {
    if !capture_config::simulcast_armed(capture) {
        return None;
    }
    let video = plan::simulcast_video_of(capture, recording);
    Some((video.width.min(video.height), video.width.max(video.height)))
}

/// `captionOverlayTargetPlan` for a session (`session_config`'s output), or
/// the talk-show room's two fixed canvases.
pub fn targets(session: &Value, layout: Option<&Value>, room_open: bool) -> Vec<Output> {
    if room_open {
        return vec![
            output(Target::Primary, "primary", (1920, 1080), layout),
            output(Target::Auxiliary, "auxiliary", (1080, 1920), layout),
        ];
    }
    let record = session["recordEnabled"].as_bool().unwrap_or(false);
    let stream = session["streamEnabled"].as_bool().unwrap_or(false);
    let burn = session["captions"]["burnTarget"]
        .as_str()
        .unwrap_or("stream");
    let stream_requested = stream && matches!(burn, "stream" | "both");
    let recording = plan::recording_video(session);
    let canvas = (recording.width, recording.height);
    // Plan 077: the vertical leg owns the auxiliary output and horizontal
    // viewers share the primary, so each gets a bar.
    if stream_requested && let Some(vertical) = vertical_leg(session, &recording) {
        return vec![
            output(Target::Primary, "stream", canvas, layout),
            output(Target::Auxiliary, "stream", vertical, layout),
        ];
    }
    if record && stream {
        // The recording stays clean (its captioned copy is drawn after
        // capture); only the split viewer-facing leg gets a live bar.
        return if stream_requested {
            vec![output(
                Target::Auxiliary,
                "stream",
                auxiliary_stream_video(session, &recording),
                layout,
            )]
        } else {
            Vec::new()
        };
    }
    if stream_requested {
        // A stream-only session draws at the primary compositor's size.
        return vec![output(Target::Primary, "stream", canvas, layout)];
    }
    Vec::new()
}

/// `captionOverlayKey` across every output: anything that changes pixels.
pub fn key(line: &CaptionLine, captions: &Value, outputs: &[Output]) -> String {
    outputs
        .iter()
        .map(|output| {
            let mut key = [
                line.identity(),
                line.text.clone(),
                captions["styleId"].as_str().unwrap_or("classic").into(),
                captions["styleRevision"].as_u64().unwrap_or(0).to_string(),
                captions["position"].as_str().unwrap_or("bottom").into(),
                captions["textSize"].as_str().unwrap_or("m").into(),
                format!("{}x{}", output.width, output.height),
                output.leg.into(),
            ]
            .join(":");
            if let Some(rect) = &output.rect {
                key.push('@');
                key.push_str(&rect.to_string());
            }
            key
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// `captionDwellMs`: a settled line stays two to six seconds by length.
pub fn dwell(text: &str) -> Duration {
    let ms = (1800 + text.trim().chars().count() as u64 * 45).clamp(2000, 6000);
    Duration::from_millis(ms)
}

/// How long the bar shows a line after it last changed: a partial six
/// seconds, a settled line its dwell (at most ten).
pub fn expiry(line: &CaptionLine) -> Duration {
    if line.is_partial() {
        Duration::from_millis(6000)
    } else {
        dwell(&line.text).min(Duration::from_millis(10_000))
    }
}

/// `captionsBarRunning`: the host's caption session decides, except that in
/// a talk-show room a muted host rests in `ready` while the guests' lines
/// keep the bar.
pub fn bar_running(status: &Status, latest: Option<&CaptionLine>, room_open: bool) -> bool {
    status.is_active()
        || (room_open
            && status.state == "ready"
            && latest.is_some_and(|line| line.session_client_id.starts_with("guests-")))
}

/// `decideOverlayPush`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Push(String),
    Clear,
    None,
}

/// `decideOverlayPush` (the session floor is [`super::Lines`]'s own).
pub fn decide(
    burn_in: bool,
    running: bool,
    session_active: bool,
    latest: Option<&CaptionLine>,
    pushed_key: Option<&str>,
    candidate_key: Option<String>,
    expired: Option<&str>,
) -> Decision {
    if !burn_in || !running || !session_active {
        return if pushed_key.is_some() {
            Decision::Clear
        } else {
            Decision::None
        };
    }
    let Some(latest) = latest else {
        return Decision::None;
    };
    if expired == Some(latest.identity().as_str()) {
        return Decision::None;
    }
    match candidate_key {
        Some(key) if pushed_key != Some(key.as_str()) => Decision::Push(key),
        _ => Decision::None,
    }
}

/// `captions.overlay.set`'s params for one output: the backend draws the bar.
pub fn set_params(text: &str, captions: &Value, output: &Output) -> Value {
    let mut params = json!({
        "text": text,
        "textSize": captions["textSize"].as_str().unwrap_or("m"),
        "styleId": captions["styleId"].as_str().unwrap_or("classic"),
        "canvasWidth": output.width,
        "canvasHeight": output.height,
        "position": captions["position"].as_str().unwrap_or("bottom"),
        "target": output.target.as_str(),
        "styleRevision": captions["styleRevision"].as_u64().unwrap_or(0),
    });
    if let Some(rect) = &output.rect {
        params["rect"] = rect.clone();
    }
    params
}

/// `cloud.speech.overlay`'s params while a talk-show room is open: the same
/// bar, with its source and expiry; on stream always, in the recording for
/// "Live stream and recording".
pub fn room_params(
    line: &CaptionLine,
    expires_at_ms: i64,
    captions: &Value,
    output: &Output,
) -> Value {
    json!({
        "sessionClientId": line.session_client_id,
        "expiresAt": expires_at_ms,
        "stream": true,
        "recording": captions["burnTarget"].as_str() == Some("both"),
        "frame": set_params(&line.text, captions, output),
    })
}

/// `captions.overlay.clear`'s params.
pub fn clear_params(captions: &Value) -> Value {
    json!({ "styleRevision": captions["styleRevision"].as_u64().unwrap_or(0) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(record: bool, stream: bool, burn: &str) -> Value {
        json!({
            "recordEnabled": record,
            "streamEnabled": stream,
            "video": { "width": 1920, "height": 1080, "fps": 30, "bitrateKbps": 6000 },
            "captions": { "burnTarget": burn, "styleId": "glass", "styleRevision": 2,
                          "position": "bottom", "textSize": "m" },
            "streaming": { "enabled": false, "targets": [] },
            "layout": { "layoutPreset": "screen-camera" },
        })
    }

    fn line(kind: &str, text: &str) -> CaptionLine {
        CaptionLine {
            session_client_id: "s".into(),
            seq: 1,
            kind: Some(kind.into()),
            text: text.into(),
        }
    }

    #[test]
    fn stream_only_draws_on_the_primary_at_the_capture_size() {
        let outputs = targets(&capture(false, true, "stream"), None, false);
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].target, Target::Primary);
        assert_eq!((outputs[0].width, outputs[0].height), (1920, 1080));
    }

    #[test]
    fn record_and_stream_draws_only_the_stream_leg() {
        let outputs = targets(&capture(true, true, "both"), None, false);
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].target, Target::Auxiliary);
    }

    #[test]
    fn a_recording_alone_gets_no_live_bar() {
        assert!(targets(&capture(true, false, "both"), None, false).is_empty());
    }

    #[test]
    fn a_room_draws_both_fixed_canvases_with_their_rects() {
        let layout = json!({ "captions": {
            "horizontal": { "x": 0.1, "y": 0.8, "w": 0.8, "h": 0.1 },
            "vertical": { "x": 0.05, "y": 0.7, "w": 0.9, "h": 0.1 },
        }});
        let outputs = targets(&capture(false, false, "stream"), Some(&layout), true);
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[1].rect.as_ref().unwrap()["x"], 0.05);
    }

    #[test]
    fn the_session_intent_overrides_the_saved_switches() {
        let session = session_config(
            &capture(true, false, "stream"),
            SessionStartIntent {
                record: false,
                stream: true,
            },
        );
        assert_eq!(targets(&session, None, false).len(), 1);
    }

    #[test]
    fn push_once_per_key_and_clear_when_captions_stop() {
        let latest = line("final", "hello");
        let key = Some("k".to_string());
        assert_eq!(
            decide(true, true, true, Some(&latest), None, key.clone(), None),
            Decision::Push("k".into())
        );
        assert_eq!(
            decide(
                true,
                true,
                true,
                Some(&latest),
                Some("k"),
                key.clone(),
                None
            ),
            Decision::None
        );
        assert_eq!(
            decide(
                true,
                false,
                true,
                Some(&latest),
                Some("k"),
                key.clone(),
                None
            ),
            Decision::Clear
        );
        assert_eq!(
            decide(true, false, true, Some(&latest), None, key.clone(), None),
            Decision::None
        );
        assert_eq!(
            decide(true, true, true, Some(&latest), None, key, Some("s:1")),
            Decision::None
        );
    }

    #[test]
    fn dwell_is_two_to_six_seconds() {
        assert_eq!(dwell("hi"), Duration::from_millis(2000));
        assert_eq!(dwell(&"x".repeat(500)), Duration::from_millis(6000));
        assert_eq!(expiry(&line("partial", "x")), Duration::from_millis(6000));
    }

    #[test]
    fn params_carry_the_look_and_the_target() {
        let outputs = targets(&capture(false, true, "stream"), None, false);
        let captions = &capture(false, true, "stream")["captions"];
        let params = set_params("hello", captions, &outputs[0]);
        assert_eq!(params["target"], "primary");
        assert_eq!(params["styleRevision"], 2);
        assert!(params.get("rect").is_none());
        let room = room_params(&line("final", "hi"), 5, captions, &outputs[0]);
        assert_eq!(room["recording"], false);
        assert_eq!(room["frame"]["text"], "hi");
        assert!(key(&line("final", "hi"), captions, &outputs).contains("1920x1080:stream"));
    }

    #[test]
    fn only_guest_lines_keep_a_ready_host_bar_in_a_room() {
        let ready = Status {
            state: "ready".into(),
            ..Default::default()
        };
        let mut guest = line("final", "hi");
        guest.session_client_id = "guests-1".into();
        assert!(bar_running(&ready, Some(&guest), true));
        assert!(!bar_running(&ready, Some(&guest), false));
        assert!(!bar_running(&ready, Some(&line("final", "hi")), true));
    }
}
