//! S3.5b: the trail column under Output quality (`GoLivePanel`): Ready to go
//! live (`ReadyToGoLive`, `StreamCheckRow`), as data. S3.5e: the same while
//! the stream is on air (`LiveStreamRow`), read from the diagnostics the
//! Studio's Session section reads. The encoder paths and frame counters are
//! Health's only (#1592: Technical details left the page).
//!
//! The output check is the backend's (`stream.output.topology.probe`, the
//! secret-free profiles and roles `buildStreamOutputTopologyProbeParams`
//! sends); the page asks once per request and reads the answer here.

use chrono::{DateTime, Utc};
use serde_json::{Value, json};

use super::PlatformsState;
use super::accounts::destination_label;
use super::captions_preflight::OutputRule;
use super::copy;
use super::go_live_copy;
use super::on_air::{
    CloudOnAir, StreamHealthAttribution, classify_stream_health, cloud_stream_reading,
    live_problem_label,
};
use super::plan::{Plan, Video};
use super::targets::{Target, destination_setup, setup_hint};
use crate::studio::health::RecentDrops;

/// `StreamOutputTopologyPreflight`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Topology {
    #[default]
    NotRequested,
    Pending {
        key: String,
    },
    Ready {
        key: String,
        result: Value,
    },
    Failed {
        key: String,
        message: String,
    },
}

impl Topology {
    pub fn key(&self) -> Option<&str> {
        match self {
            Topology::NotRequested => None,
            Topology::Pending { key }
            | Topology::Ready { key, .. }
            | Topology::Failed { key, .. } => Some(key),
        }
    }
}

fn video_json(video: &Video) -> Value {
    json!({
        "preset": video.preset,
        "width": video.width,
        "height": video.height,
        "fps": video.fps,
        "bitrateKbps": video.bitrate_kbps,
    })
}

/// `buildStreamOutputTopologyProbeParams`' request: the stream's profile,
/// the recording's when it records, and the roles: split when it records and
/// captions force the stream its own leg or the two profiles differ
/// (`sameTopologyVideoProfile`).
pub fn probe_params(
    plan: &Plan,
    recording: &Video,
    record_enabled: bool,
    force_split: bool,
) -> Value {
    let same_profile = recording.width == plan.stream_video.width
        && recording.height == plan.stream_video.height
        && recording.fps == plan.stream_video.fps
        && recording.bitrate_kbps == plan.stream_video.bitrate_kbps;
    let split = record_enabled && (force_split || !same_profile);
    let mut params = json!({
        "streamProfile": video_json(&plan.stream_video),
        "outputRoles": if split { json!(["recording", "stream"]) } else { json!(["shared"]) },
    });
    if record_enabled {
        params["recordingProfile"] = video_json(recording);
    }
    params
}

/// `streamOutputTopologyProbeRequestKey`.
pub fn probe_key(params: &Value) -> String {
    serde_json::to_string(params).unwrap_or_default()
}

/// A row's glyph: done, still open, a plain fact (`InfoRow`), or a row
/// that goes where the fix is (`NavigableRow`: FFmpeg → Health).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowState {
    Ok,
    Pending,
    Info,
    Nav,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyRow {
    pub label: String,
    pub detail: String,
    pub hint: String,
    /// The lines under the row (`QualityLines`).
    pub lines: Vec<String>,
    pub state: RowState,
}

fn row(label: &str, detail: String, state: RowState) -> ReadyRow {
    ReadyRow {
        label: label.to_string(),
        detail,
        hint: String::new(),
        lines: Vec::new(),
        state,
    }
}

/// S3.5e: the stream on air (`liveOutputActive`): the diagnostics
/// (`diagnostics.stats`), the stream's health for this session
/// (`currentStreamHealth`), the running destinations (`stream.targets`) and
/// the stages that dropped lately.
#[derive(Clone, Copy)]
pub struct LiveInput<'a> {
    pub stats: &'a Value,
    pub stream_health: Option<&'a Value>,
    pub stream_targets: &'a [Value],
    pub drops: RecentDrops,
    pub now: DateTime<Utc>,
}

/// What the trail column reads.
pub struct ReadyInput<'a> {
    pub targets: &'a [Target],
    pub platforms: &'a PlatformsState,
    pub plan: &'a Plan,
    pub record_enabled: bool,
    /// The saved output mode streams (`captureConfig.streamEnabled`).
    pub stream_enabled: bool,
    pub recording: &'a Video,
    pub ffmpeg_ready: bool,
    pub topology: &'a Topology,
    /// `videoProfileCompatibility`'s `blockingReason` (only Windows' bridge
    /// envelope refuses a profile): the warning above Output quality, and
    /// Quality's row is not ok.
    pub profile_blocking: Option<&'a str>,
    /// Live captions when on: the output rule a livestream would break
    /// (`livestreamCaptionsBlockerFor`), if any.
    pub captions: Option<Option<OutputRule>>,
    /// The session records at the stream's profile
    /// (`streamSharedEncodeFallbackVideo`); `recording` is that profile.
    pub recording_matches_stream: bool,
    /// S3.5e: the stream is on air.
    pub live: Option<LiveInput<'a>>,
    /// The Videorc Cloud show carrying the session (plan 184 C7).
    pub cloud: Option<&'a CloudOnAir>,
}

/// The trail column's data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyView {
    pub rows: Vec<ReadyRow>,
    /// (target id, "Twitch · add a stream key").
    pub not_ready: Vec<(String, String)>,
    /// The output check failed: its Retry and line.
    pub retry: bool,
    /// `videoProfileCompatibility`'s refusal, else its warning, above Output
    /// quality.
    pub warning: Option<String>,
}

/// `ReadyToGoLive`, off air and on.
pub fn ready_view(input: &ReadyInput<'_>) -> ReadyView {
    let ReadyInput {
        targets,
        platforms,
        plan,
        record_enabled,
        stream_enabled,
        recording,
        ffmpeg_ready,
        topology,
        profile_blocking,
        captions,
        recording_matches_stream,
        live,
        cloud,
    } = *input;
    let attribution_live = live.map(|live| {
        classify_stream_health(
            live.stats,
            live.stream_health,
            live.stream_targets,
            live.drops,
            live.now,
        )
    });
    let enabled: Vec<&Target> = targets.iter().filter(|t| t.enabled).collect();
    let not_ready: Vec<(String, String)> = enabled
        .iter()
        .filter_map(|t| {
            setup_hint(destination_setup(t, platforms.account(&t.platform))).map(|hint| {
                (
                    t.id.clone(),
                    format!("{} · {hint}", destination_label(&t.label)),
                )
            })
        })
        .collect();
    let ready_count = enabled.len() - not_ready.len();
    let mut rows = vec![row(
        copy::READY_DESTINATIONS,
        if enabled.is_empty() {
            copy::TURN_ON_A_DESTINATION.to_string()
        } else {
            copy::ready_of(ready_count, enabled.len())
        },
        if !enabled.is_empty() && not_ready.is_empty() {
            RowState::Ok
        } else {
            RowState::Pending
        },
    )];
    let mut retry = false;
    if let Some(attribution) = attribution_live {
        // `LiveStreamRow`: quiet when healthy, the problem in a few words
        // when not, its sentence on hover and focus. While the cloud holds or
        // resumes the show, that is the word.
        let cloud_reading = cloud_stream_reading(cloud);
        let healthy = attribution == StreamHealthAttribution::Healthy && cloud_reading.is_none();
        rows.push(ReadyRow {
            hint: live_description(attribution).to_string(),
            ..row(
                copy::STREAM,
                if let Some(reading) = cloud_reading {
                    reading.to_string()
                } else if healthy {
                    copy::BADGE_HEALTHY.to_string()
                } else {
                    live_problem_label(attribution).to_string()
                },
                if healthy {
                    RowState::Ok
                } else {
                    RowState::Pending
                },
            )
        });
    } else if !enabled.is_empty() {
        rows.push(match topology {
            Topology::Ready { .. } => {
                row(copy::STREAM_SETTINGS, copy::CHECKED.into(), RowState::Ok)
            }
            Topology::Pending { .. } => row(
                copy::STREAM_SETTINGS,
                copy::CHECKING.into(),
                RowState::Pending,
            ),
            Topology::Failed { message, .. } => {
                retry = true;
                ReadyRow {
                    hint: message.clone(),
                    ..row(
                        copy::STREAM_SETTINGS,
                        copy::COULDNT_CHECK.into(),
                        RowState::Pending,
                    )
                }
            }
            Topology::NotRequested => row(
                copy::STREAM_SETTINGS,
                copy::NOT_CHECKED_YET.into(),
                RowState::Pending,
            ),
        });
    }
    // `qualitySummary`: one line when every output matches, else one line
    // per destination under the row.
    let qualities: Vec<(String, String)> = plan
        .targets
        .iter()
        .map(|(_, label, vertical, video)| {
            let quality = if *vertical {
                video.vertical().quality()
            } else {
                video.quality()
            };
            (label.clone(), quality)
        })
        .collect();
    let (quality, lines) = match qualities.first() {
        None => (plan.stream_video.quality(), Vec::new()),
        Some((_, first)) if qualities.iter().all(|(_, q)| q == first) => {
            (first.clone(), Vec::new())
        }
        Some(_) => (
            copy::VARIES_BY_DESTINATION.to_string(),
            qualities
                .iter()
                .map(|(label, quality)| format!("{label}: {quality}"))
                .collect(),
        ),
    };
    // `presetOk`: the profile is allowed here and every output passes the
    // stream-safe rules.
    let stream_safe = profile_blocking.is_none()
        && if plan.targets.is_empty() {
            super::plan::stream_safe(&plan.stream_video, None)
        } else {
            plan.targets.iter().all(|(id, .., video)| {
                let platform = targets
                    .iter()
                    .find(|t| t.id == *id)
                    .map(|t| t.platform.as_str());
                super::plan::stream_safe(video, platform)
            })
        };
    rows.push(ReadyRow {
        lines,
        ..row(
            copy::QUALITY,
            if stream_safe {
                quality
            } else {
                copy::choose_stream_safe(&quality)
            },
            if stream_safe {
                RowState::Ok
            } else {
                RowState::Pending
            },
        )
    });
    let four_k = plan
        .targets
        .iter()
        .any(|(.., video)| video.preset == "stream-youtube-4k30");
    if let Some(blocker) = captions {
        rows.push(ReadyRow {
            hint: String::new(),
            lines: blocker
                .map(|rule| vec![rule.description().to_string()])
                .unwrap_or_default(),
            ..row(
                go_live_copy::CAPTIONS,
                blocker.map_or(copy::ON, OutputRule::label).to_string(),
                if blocker.is_none() {
                    RowState::Ok
                } else {
                    RowState::Pending
                },
            )
        });
    }
    if record_enabled && recording_matches_stream {
        rows.push(row(
            copy::RECORDING,
            copy::matches_the_stream(&recording.quality()),
            RowState::Info,
        ));
    } else if record_enabled && (plan.separate_encoded_output_role || four_k) {
        rows.push(row(copy::RECORDING, recording.quality(), RowState::Info));
    }
    if !enabled.is_empty() {
        // `streamOutputs`: the planned destinations, or the one stream profile.
        let total: u64 = if plan.targets.is_empty() {
            u64::from(plan.stream_video.bitrate_kbps) + 128
        } else {
            plan.targets
                .iter()
                .map(|(.., video)| u64::from(video.bitrate_kbps) + 128)
                .sum()
        };
        let mbps = ((total as f64) * 1.1 / 100.0).round() / 10.0;
        rows.push(row(
            copy::UPLOAD_NEEDED,
            copy::about_mbps(mbps),
            RowState::Info,
        ));
    }
    if record_enabled {
        let gb = ((f64::from(recording.bitrate_kbps) / 8.0 / 1000.0) * 3600.0).round() / 1000.0;
        rows.push(row(copy::DISK, copy::about_gb_per_hour(gb), RowState::Info));
    }
    if !ffmpeg_ready {
        rows.push(row(copy::FFMPEG, copy::MISSING.to_string(), RowState::Nav));
    }
    ReadyView {
        rows,
        not_ready,
        retry,
        warning: profile_blocking.map(str::to_string).or_else(|| {
            (record_enabled && stream_enabled && recording.width.min(recording.height) >= 2160)
                .then(|| copy::FOUR_K_RECORDING_WARNING.to_string())
        }),
    }
}

/// `streamHealthDescription` on air.
pub fn live_description(attribution: StreamHealthAttribution) -> &'static str {
    use StreamHealthAttribution as A;
    match attribution {
        A::Device => copy::LIVE_DEVICE,
        A::Audio => copy::LIVE_AUDIO,
        A::Choppy => copy::LIVE_CHOPPY,
        A::Uplink => copy::LIVE_UPLINK,
        A::Capture => copy::LIVE_CAPTURE,
        A::Render => copy::LIVE_RENDER,
        A::Encoder => copy::LIVE_ENCODER,
        A::Fallback => copy::LIVE_FALLBACK,
        A::Network => copy::LIVE_NETWORK,
        A::Preview => copy::LIVE_PREVIEW,
        A::Healthy => copy::LIVE_HEALTHY,
        A::Unknown => copy::LIVE_UNKNOWN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(preset: &str) -> Video {
        Video::preset(preset).unwrap()
    }

    #[test]
    fn the_rows_say_what_go_live_needs() {
        let targets = vec![
            Target {
                id: "twitch".into(),
                platform: "twitch".into(),
                label: "Twitch".into(),
                enabled: true,
                auth_mode: "manual-rtmp".into(),
                server_url: "rtmp://live.twitch.tv/app".into(),
                stream_key_present: true,
                ..Target::default()
            },
            Target {
                id: "kick".into(),
                platform: "kick".into(),
                label: "Kick".into(),
                enabled: true,
                auth_mode: "manual-rtmp".into(),
                server_url: "rtmps://k/app".into(),
                ..Target::default()
            },
        ];
        let recording = video("tutorial-1080p30");
        let streaming = super::super::plan::Streaming {
            enabled: true,
            targets: &targets,
            default_preset: "tutorial-1080p30",
            default_bitrate_kbps: 6000,
        };
        let plan = super::super::plan::resolve(&recording, &streaming, true, false, false);
        let view = ready_view(&ReadyInput {
            targets: &targets,
            platforms: &PlatformsState::default(),
            plan: &plan,
            record_enabled: true,
            stream_enabled: true,
            recording: &recording,
            ffmpeg_ready: true,
            topology: &Topology::NotRequested,
            profile_blocking: None,
            captions: None,
            recording_matches_stream: false,
            live: None,
            cloud: None,
        });
        let details: Vec<(&str, &str)> = view
            .rows
            .iter()
            .map(|r| (r.label.as_str(), r.detail.as_str()))
            .collect();
        assert_eq!(
            details,
            [
                ("Destinations", "1 of 2 ready"),
                (
                    "Stream settings",
                    "Not checked yet. Go Live checks it first."
                ),
                ("Quality", "1080p · 30 fps · 6 Mbps"),
                ("Upload needed", "About 13.5 Mbps"),
                ("Disk", "About 2.7 GB per hour"),
            ]
        );
        assert_eq!(
            view.not_ready,
            [("kick".to_string(), "Kick · add a stream key".to_string())]
        );
        assert_eq!(
            probe_params(&plan, &recording, true, false)["outputRoles"],
            json!(["shared"])
        );

        // No planned destination: the upload is the one stream profile's.
        let unplanned = Plan {
            targets: Vec::new(),
            ..plan.clone()
        };
        let view = ready_view(&ReadyInput {
            targets: &targets,
            platforms: &PlatformsState::default(),
            plan: &unplanned,
            record_enabled: true,
            stream_enabled: true,
            recording: &recording,
            ffmpeg_ready: true,
            topology: &Topology::NotRequested,
            profile_blocking: None,
            captions: None,
            recording_matches_stream: false,
            live: None,
            cloud: None,
        });
        assert!(
            view.rows
                .iter()
                .any(|r| r.label == "Upload needed" && r.detail == "About 6.7 Mbps")
        );
    }

    #[test]
    fn the_upload_and_disk_figures_read_as_javascript_numbers() {
        assert_eq!(copy::about_mbps(20.2), "About 20.2 Mbps");
        assert_eq!(copy::about_gb_per_hour(2.7), "About 2.7 GB per hour");
    }

    fn live_plan() -> Plan {
        Plan {
            targets: Vec::new(),
            stream_video: video("stream-safe-1080p30"),
            separate_encoded_output_role: false,
        }
    }

    fn live<'a>(stats: &'a Value, health: Option<&'a Value>) -> LiveInput<'a> {
        LiveInput {
            stats,
            stream_health: health,
            stream_targets: &[],
            drops: RecentDrops::default(),
            now: Utc::now(),
        }
    }

    /// S3.5e: on air, Ready to go live's check row becomes the stream's.
    #[test]
    fn on_air_the_stream_row_takes_the_checks_place() {
        let targets = vec![Target {
            id: "custom".into(),
            platform: "custom".into(),
            label: "Custom RTMP".into(),
            enabled: true,
            auth_mode: "manual-rtmp".into(),
            server_url: "rtmp://127.0.0.1/live".into(),
            stream_key_present: true,
            ..Target::default()
        }];
        let recording = video("tutorial-1080p30");
        let plan = live_plan();
        let stats = json!({ "sessionId": "s1", "deviceDisconnected": true });
        let view = ready_view(&ReadyInput {
            targets: &targets,
            platforms: &PlatformsState::default(),
            plan: &plan,
            record_enabled: false,
            stream_enabled: true,
            recording: &recording,
            ffmpeg_ready: true,
            topology: &Topology::NotRequested,
            profile_blocking: None,
            captions: None,
            recording_matches_stream: false,
            live: Some(live(&stats, None)),
            cloud: None,
        });
        let stream = view
            .rows
            .iter()
            .find(|r| r.label == "Stream")
            .expect("the stream row");
        assert_eq!(stream.detail, "Capture device lost");
        assert_eq!(
            stream.hint,
            "A disconnected capture device is interrupting the stream."
        );
        assert_eq!(stream.state, RowState::Pending);
        assert!(!view.rows.iter().any(|r| r.label == "Stream settings"));
    }

    fn custom_target() -> Vec<Target> {
        vec![Target {
            id: "custom".into(),
            platform: "custom".into(),
            label: "Custom RTMP".into(),
            enabled: true,
            auth_mode: "manual-rtmp".into(),
            server_url: "rtmp://127.0.0.1/live".into(),
            stream_key_present: true,
            ..Target::default()
        }]
    }

    #[test]
    fn captions_the_shared_recording_and_a_refused_profile_have_their_rows() {
        let targets = custom_target();
        let recording = video("stream-safe-1080p30");
        let plan = live_plan();
        let input = ReadyInput {
            targets: &targets,
            platforms: &PlatformsState::default(),
            plan: &plan,
            record_enabled: true,
            stream_enabled: true,
            recording: &recording,
            ffmpeg_ready: true,
            topology: &Topology::NotRequested,
            profile_blocking: None,
            captions: Some(Some(OutputRule::FrameRate)),
            recording_matches_stream: true,
            live: None,
            cloud: None,
        };
        let view = ready_view(&input);
        let captions = view.rows.iter().find(|r| r.label == "Captions").unwrap();
        assert_eq!(captions.detail, "Need 30 fps or less");
        assert_eq!(captions.state, RowState::Pending);
        assert_eq!(captions.lines, [OutputRule::FrameRate.description()]);
        let recording_row = view.rows.iter().find(|r| r.label == "Recording").unwrap();
        assert_eq!(
            recording_row.detail,
            "1080p · 30 fps · 6 Mbps · matches the stream"
        );

        let on = ready_view(&ReadyInput {
            captions: Some(None),
            profile_blocking: Some("Refused here."),
            ..input
        });
        let captions = on.rows.iter().find(|r| r.label == "Captions").unwrap();
        assert_eq!(
            (captions.detail.as_str(), captions.state),
            ("On", RowState::Ok)
        );
        let quality = on.rows.iter().find(|r| r.label == "Quality").unwrap();
        assert_eq!(quality.state, RowState::Pending);
        assert_eq!(on.warning.as_deref(), Some("Refused here."));

        let off = ready_view(&ReadyInput {
            captions: None,
            ..input
        });
        assert!(!off.rows.iter().any(|r| r.label == "Captions"));
    }

    #[test]
    fn on_air_the_cloud_hold_is_the_stream_rows_word() {
        let targets = custom_target();
        let recording = video("tutorial-1080p30");
        let plan = live_plan();
        let stats = json!({ "sessionId": "s1" });
        let cloud = CloudOnAir {
            phase: "hold".into(),
            hold_remaining_seconds: Some(125.0),
        };
        let view = ready_view(&ReadyInput {
            targets: &targets,
            platforms: &PlatformsState::default(),
            plan: &plan,
            record_enabled: false,
            stream_enabled: true,
            recording: &recording,
            ffmpeg_ready: true,
            topology: &Topology::NotRequested,
            profile_blocking: None,
            captions: None,
            recording_matches_stream: false,
            live: Some(live(&stats, None)),
            cloud: Some(&cloud),
        });
        let stream = view.rows.iter().find(|r| r.label == "Stream").unwrap();
        assert_eq!(stream.detail, "Be right back · 3 min left");
        assert_eq!(stream.state, RowState::Pending);
    }
}
