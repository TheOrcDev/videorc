//! Plan 249 S26: a cloud room's health, layer by layer (`cloud-program-health.ts`).
//!
//! Pure: Health and the parity fixture (`protocol-fixtures/cloud-parity-health.json`)
//! read the same rows. Every row's status is a sentence-case word. The program
//! preview is never proof of the encoded stream.

use serde::Deserialize;
use serde_json::Value;

use crate::guests::view::{ManagedEffectiveOutput, ManagedOutputProfile};
use crate::guests::wire::{RoomRole, RoomStatus};
use crate::livestream::cloud_status::{CloudCommandTimes, CloudStatus};

/// `ProgramHealthLayer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramHealthLayer {
    Contribution,
    Page,
    Egress,
    Control,
}

impl ProgramHealthLayer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Contribution => "contribution",
            Self::Page => "page",
            Self::Egress => "egress",
            Self::Control => "control",
        }
    }

    /// Section label under Health's Cloud room panel.
    pub fn label(self) -> &'static str {
        match self {
            Self::Contribution => "In the room",
            Self::Page => "Program pages",
            Self::Egress => "Outputs",
            Self::Control => "Videorc Cloud",
        }
    }
}

/// `ProgramHealthTone` (never how it looks).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramHealthTone {
    Good,
    Warn,
    Error,
    Neutral,
}

impl ProgramHealthTone {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Good => "good",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Neutral => "neutral",
        }
    }
}

/// One Health row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramHealthRow {
    pub id: String,
    pub layer: ProgramHealthLayer,
    pub label: String,
    pub status: String,
    pub tone: ProgramHealthTone,
    pub detail: String,
}

/// The app's own room microphone (plan 249 S7b), when it knows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramHealthMicrophone {
    /// `off`, `opening`, `published` or `lost`.
    pub state: ProgramMicState,
    /// A level was measured here in the last half second.
    pub level_fresh: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProgramMicState {
    Off,
    Opening,
    Published,
    Lost,
    #[serde(other)]
    Unknown,
}

/// What [`program_health_rows`] reads.
#[derive(Debug, Clone, Default)]
pub struct ProgramHealthInput {
    pub room: Option<RoomStatus>,
    pub output_health: Vec<CloudOutputHealth>,
    pub show_profile: Option<ManagedOutputProfile>,
    pub microphone: Option<ProgramHealthMicrophone>,
    pub command_times: Option<CloudCommandTimes>,
}

/// Plan 249 S26: one program output's health (lenient mirror of the wire).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudOutputHealth {
    pub output: String,
    pub orientation: String,
    pub egress: String,
    pub also_records: Option<bool>,
    pub page: String,
    pub page_age_seconds: Option<u64>,
    pub joined: bool,
    pub audio: String,
    pub program: Option<CloudProgramCounters>,
    pub stage_key: Option<String>,
    pub faults: Option<CloudOutputFaults>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudProgramCounters {
    pub audio_silent_seconds: Option<u64>,
    pub black_seconds: Option<u64>,
    pub frozen_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudOutputFaults {
    pub asset: Option<u64>,
    pub drop: Option<u64>,
}

/// A command that took this long was slow (the backend's `SLOW_COMMAND_MS`).
pub const COMMAND_SLOW_MS: u32 = 2000;

/// Says what the program preview is, and what it is not.
pub const PROGRAM_PREVIEW_NOTE: &str = "The program preview is drawn on this computer from the room. It isn't the encoded stream, and it never proves what viewers hear.";

/// Cloud room section title (P070).
pub const CLOUD_ROOM_TITLE: &str = "Cloud room";

impl ProgramHealthInput {
    /// From the Studio's cloud status while a room is open.
    pub fn from_cloud(
        status: &CloudStatus,
        microphone: Option<ProgramHealthMicrophone>,
    ) -> Option<Self> {
        let room = status.room.as_ref().and_then(RoomStatus::from_value)?;
        if room.phase != crate::guests::wire::RoomPhase::Open {
            return None;
        }
        let output_health = status
            .output_health
            .iter()
            .filter_map(|value| serde_json::from_value(value.clone()).ok())
            .collect();
        let show_profile = status
            .show
            .as_ref()
            .and_then(|show| show.output_profile.as_ref())
            .and_then(|value| serde_json::from_value::<ManagedOutputProfile>(value.clone()).ok());
        Some(Self {
            room: Some(room),
            output_health,
            show_profile,
            microphone,
            command_times: status.command_times,
        })
    }
}

fn seconds(value: Option<u64>) -> String {
    format!("{} s", value.unwrap_or(0))
}

fn output_label(entry: &CloudOutputHealth) -> Option<String> {
    let orientation = match entry.orientation.as_str() {
        "horizontal" => "Horizontal",
        "vertical" => "Vertical",
        _ => return None,
    };
    let output = match entry.output.as_str() {
        "stream" => "stream",
        "recording" => "recording",
        _ => return None,
    };
    Some(format!("{orientation} {output}"))
}

fn contribution_rows(input: &ProgramHealthInput) -> Vec<ProgramHealthRow> {
    let participants = input
        .room
        .as_ref()
        .map(|room| room.participants.as_slice())
        .unwrap_or(&[]);
    if participants.is_empty() {
        return vec![ProgramHealthRow {
            id: "host-microphone".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "Your microphone".into(),
            status: "Unknown".into(),
            tone: ProgramHealthTone::Neutral,
            detail: "The room hasn't listed anyone yet.".into(),
        }];
    }
    let Some(host) = participants
        .iter()
        .find(|person| person.role == RoomRole::Host)
    else {
        return vec![ProgramHealthRow {
            id: "host-room".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "This computer".into(),
            status: "Not in room".into(),
            tone: ProgramHealthTone::Error,
            detail: "This computer isn't in the room. Guests and viewers see the away card.".into(),
        }];
    };
    let mut rows = Vec::new();
    let microphone = input.microphone;
    rows.push(if !host.audio {
        ProgramHealthRow {
            id: "host-microphone".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "Your microphone".into(),
            status: "Missing".into(),
            tone: ProgramHealthTone::Error,
            detail: if microphone.is_some_and(|mic| mic.state == ProgramMicState::Lost) {
                "The room has no microphone from you: the device was lost.".into()
            } else {
                "The room has no microphone from you.".into()
            },
        }
    } else if host.muted {
        ProgramHealthRow {
            id: "host-microphone".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "Your microphone".into(),
            status: "Muted".into(),
            tone: ProgramHealthTone::Warn,
            detail: "You muted your microphone. Viewers hear no voice from you.".into(),
        }
    } else {
        ProgramHealthRow {
            id: "host-microphone".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "Your microphone".into(),
            status: "Published".into(),
            tone: ProgramHealthTone::Good,
            detail: if microphone.is_some_and(|mic| mic.level_fresh) {
                "In the room. Its level is measured on this computer.".into()
            } else {
                "In the room. Its level isn't measured here, so silence reads as Unknown.".into()
            },
        }
    });
    rows.push(if !host.video {
        ProgramHealthRow {
            id: "host-camera".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "Your camera".into(),
            status: "Off".into(),
            tone: ProgramHealthTone::Neutral,
            detail: "Your camera is switched off.".into(),
        }
    } else if !host.on_stage {
        ProgramHealthRow {
            id: "host-camera".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "Your camera".into(),
            status: "Off stage".into(),
            tone: ProgramHealthTone::Neutral,
            detail: "You're off stage.".into(),
        }
    } else if host.away {
        ProgramHealthRow {
            id: "host-camera".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "Your camera".into(),
            status: "No frames".into(),
            tone: ProgramHealthTone::Warn,
            detail: "The program draws no frame of your camera. Viewers see the away card.".into(),
        }
    } else {
        ProgramHealthRow {
            id: "host-camera".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "Your camera".into(),
            status: "On program".into(),
            tone: ProgramHealthTone::Good,
            detail: "The program draws your camera.".into(),
        }
    });
    for guest in participants {
        if guest.role == RoomRole::Host || !guest.on_stage {
            continue;
        }
        let name = {
            let trimmed = guest.name.trim();
            if trimmed.is_empty() {
                "Guest".into()
            } else {
                trimmed.to_string()
            }
        };
        rows.push(if guest.video && guest.away {
            ProgramHealthRow {
                id: format!("guest:{}", guest.identity),
                layer: ProgramHealthLayer::Contribution,
                label: name,
                status: "No frames".into(),
                tone: ProgramHealthTone::Warn,
                detail: "The program draws no frame of this guest's camera.".into(),
            }
        } else if !guest.audio {
            ProgramHealthRow {
                id: format!("guest:{}", guest.identity),
                layer: ProgramHealthLayer::Contribution,
                label: name,
                status: "No microphone".into(),
                tone: ProgramHealthTone::Warn,
                detail: "The room has no microphone from this guest.".into(),
            }
        } else {
            ProgramHealthRow {
                id: format!("guest:{}", guest.identity),
                layer: ProgramHealthLayer::Contribution,
                label: name,
                status: "On stage".into(),
                tone: ProgramHealthTone::Good,
                detail: if guest.video {
                    "On the program.".into()
                } else {
                    "On the program, camera off.".into()
                },
            }
        });
    }
    rows
}

fn fault_words(entry: &CloudOutputHealth) -> Option<String> {
    let asset = entry.faults.and_then(|faults| faults.asset).unwrap_or(0);
    let drop = entry.faults.and_then(|faults| faults.drop).unwrap_or(0);
    let mut parts = Vec::new();
    if asset > 0 {
        parts.push(format!(
            "{asset} {} failed to draw",
            if asset == 1 { "layer" } else { "layers" }
        ));
    }
    if drop > 0 {
        parts.push(format!("{drop} dropped at a limit"));
    }
    (!parts.is_empty()).then(|| format!("{} since the page started.", parts.join(", ")))
}

fn page_row(entry: &CloudOutputHealth, label: &str) -> ProgramHealthRow {
    let id = format!("page:{}-{}", entry.output, entry.orientation);
    let label = format!("{label} page");
    let faults = fault_words(entry);
    if entry.page == "stale" {
        return ProgramHealthRow {
            id,
            layer: ProgramHealthLayer::Page,
            label,
            status: "Not reporting".into(),
            tone: ProgramHealthTone::Error,
            detail: format!(
                "Its last report was {} ago. What its viewers see and hear is unknown.",
                seconds(entry.page_age_seconds)
            ),
        };
    }
    if entry.page == "missing" {
        return if entry.egress == "active" {
            ProgramHealthRow {
                id,
                layer: ProgramHealthLayer::Page,
                label,
                status: "Not reporting".into(),
                tone: ProgramHealthTone::Error,
                detail: "It hasn't reported yet. What its viewers see and hear is unknown.".into(),
            }
        } else {
            ProgramHealthRow {
                id,
                layer: ProgramHealthLayer::Page,
                label,
                status: "Waiting".into(),
                tone: ProgramHealthTone::Neutral,
                detail: "Its page is starting.".into(),
            }
        };
    }
    if entry.page != "reporting" {
        return ProgramHealthRow {
            id,
            layer: ProgramHealthLayer::Page,
            label,
            status: "Unknown".into(),
            tone: ProgramHealthTone::Neutral,
            detail: "This app can't read its state.".into(),
        };
    }
    let program = entry.program.clone().unwrap_or_default();
    let mut problems = Vec::new();
    if program.black_seconds.unwrap_or(0) > 0 {
        problems.push(format!("black for {}", seconds(program.black_seconds)));
    }
    if program.frozen_seconds.unwrap_or(0) > 0 {
        problems.push(format!("frozen for {}", seconds(program.frozen_seconds)));
    }
    if entry.audio == "measured" && program.audio_silent_seconds.unwrap_or(0) > 0 {
        problems.push(format!(
            "silent for {}",
            seconds(program.audio_silent_seconds)
        ));
    }
    let sound = if entry.audio == "measured" {
        "It measures the sound it plays, not the encoded stream."
    } else {
        "It has no sound meter: what its viewers hear is unknown."
    };
    let tail = [Some(sound.to_string()), faults]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if !problems.is_empty() {
        let sentence = problems.join(", ");
        let mut chars = sentence.chars();
        let detail_head = chars
            .next()
            .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
            .unwrap_or_default();
        let status = if program.black_seconds.unwrap_or(0) > 0 {
            "Black"
        } else if program.frozen_seconds.unwrap_or(0) > 0 {
            "Frozen"
        } else {
            "Silent"
        };
        return ProgramHealthRow {
            id,
            layer: ProgramHealthLayer::Page,
            label,
            status: status.into(),
            tone: ProgramHealthTone::Error,
            detail: format!("{detail_head}. {tail}"),
        };
    }
    let stage = if entry.stage_key.is_some() {
        ", stage applied"
    } else {
        ""
    };
    ProgramHealthRow {
        id,
        layer: ProgramHealthLayer::Page,
        label,
        status: "Reporting".into(),
        tone: if entry.audio == "measured" && fault_words(entry).is_none() {
            ProgramHealthTone::Good
        } else {
            ProgramHealthTone::Warn
        },
        detail: format!(
            "Reported {} ago{stage}. {tail}",
            seconds(entry.page_age_seconds)
        ),
    }
}

fn egress_row(
    entry: &CloudOutputHealth,
    label: &str,
    profile: Option<&ManagedOutputProfile>,
) -> ProgramHealthRow {
    let id = format!("egress:{}-{}", entry.output, entry.orientation);
    let label = format!("{label} output");
    let takes = if entry.also_records == Some(true) {
        " It also records the take."
    } else {
        ""
    };
    match entry.egress.as_str() {
        "active" => {
            let matched = profile.and_then(|profile| {
                profile
                    .effective
                    .iter()
                    .find(|output| output.orientation == entry.orientation)
            });
            ProgramHealthRow {
                id,
                layer: ProgramHealthLayer::Egress,
                label,
                status: "Running".into(),
                tone: ProgramHealthTone::Good,
                detail: if let Some(ManagedEffectiveOutput {
                    width,
                    height,
                    picture_fps,
                    video_kbps,
                    ..
                }) = matched
                {
                    format!(
                        "{width}×{height}, {picture_fps} fps picture, {} Mbps.{takes}",
                        f64::from(*video_kbps) / 1000.0
                    )
                } else {
                    format!("Running. Its profile wasn't reported.{takes}")
                },
            }
        }
        "starting" => ProgramHealthRow {
            id,
            layer: ProgramHealthLayer::Egress,
            label,
            status: "Starting".into(),
            tone: ProgramHealthTone::Neutral,
            detail: "The cloud is starting it.".into(),
        },
        "ending" | "complete" => ProgramHealthRow {
            id,
            layer: ProgramHealthLayer::Egress,
            label,
            status: "Ended".into(),
            tone: ProgramHealthTone::Neutral,
            detail: "This output has ended.".into(),
        },
        "failed" | "aborted" | "limit-reached" => ProgramHealthRow {
            id,
            layer: ProgramHealthLayer::Egress,
            label,
            status: "Failed".into(),
            tone: ProgramHealthTone::Error,
            detail: "The cloud stopped this output.".into(),
        },
        _ => ProgramHealthRow {
            id,
            layer: ProgramHealthLayer::Egress,
            label,
            status: "Unknown".into(),
            tone: ProgramHealthTone::Neutral,
            detail: "This app can't read its state.".into(),
        },
    }
}

fn command_time(ms: u32) -> String {
    if ms < 1000 {
        format!("{ms} ms")
    } else {
        format!("{:.1} s", f64::from(ms) / 1000.0)
    }
}

fn commands_row(times: CloudCommandTimes) -> ProgramHealthRow {
    let slow = times.last_ms >= COMMAND_SLOW_MS;
    ProgramHealthRow {
        id: "commands".into(),
        layer: ProgramHealthLayer::Control,
        label: "Commands".into(),
        status: if slow { "Slow" } else { "Normal" }.into(),
        tone: if slow {
            ProgramHealthTone::Warn
        } else {
            ProgramHealthTone::Good
        },
        detail: format!(
            "Last answered in {}. Slowest this show: {}.",
            command_time(times.last_ms),
            command_time(times.slowest_ms)
        ),
    }
}

/// Every row: contributions first, then each output's page and egress, then
/// the show's commands.
pub fn program_health_rows(input: &ProgramHealthInput) -> Vec<ProgramHealthRow> {
    let mut rows = contribution_rows(input);
    for entry in input.output_health.iter().take(4) {
        let Some(label) = output_label(entry) else {
            continue;
        };
        rows.push(page_row(entry, &label));
        rows.push(egress_row(entry, &label, input.show_profile.as_ref()));
    }
    if let Some(times) = input.command_times {
        rows.push(commands_row(times));
    }
    rows
}

/// The worst tone among the rows: the section's one verdict.
pub fn program_health_verdict(rows: &[ProgramHealthRow]) -> ProgramHealthTone {
    if rows.iter().any(|row| row.tone == ProgramHealthTone::Error) {
        return ProgramHealthTone::Error;
    }
    if rows.iter().any(|row| row.tone == ProgramHealthTone::Warn) {
        return ProgramHealthTone::Warn;
    }
    if rows.iter().any(|row| row.tone == ProgramHealthTone::Good) {
        return ProgramHealthTone::Good;
    }
    ProgramHealthTone::Neutral
}

/// Rows grouped for Health's Cloud room section (empty layers omitted).
pub fn program_health_layers(
    rows: &[ProgramHealthRow],
) -> Vec<(ProgramHealthLayer, Vec<&ProgramHealthRow>)> {
    [
        ProgramHealthLayer::Contribution,
        ProgramHealthLayer::Page,
        ProgramHealthLayer::Egress,
        ProgramHealthLayer::Control,
    ]
    .into_iter()
    .filter_map(|layer| {
        let group: Vec<_> = rows.iter().filter(|row| row.layer == layer).collect();
        (!group.is_empty()).then_some((layer, group))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input_from_json(value: Value) -> ProgramHealthInput {
        let object = value.as_object().unwrap();
        let room = object.get("room").and_then(|value| {
            // The fixture nests participants under room; RoomStatus needs phase.
            let mut room = value.clone();
            if let Some(map) = room.as_object_mut() {
                map.entry("phase".into()).or_insert(json!("open"));
            }
            RoomStatus::from_value(&room)
        });
        let output_health = object
            .get("outputHealth")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| serde_json::from_value(value.clone()).ok())
            .collect();
        let show_profile = object
            .get("show")
            .and_then(|show| show.get("outputProfile"))
            .and_then(|value| serde_json::from_value(value.clone()).ok());
        let microphone = object
            .get("microphone")
            .and_then(|value| serde_json::from_value(value.clone()).ok());
        let command_times = object
            .get("commandTimes")
            .and_then(|value| serde_json::from_value(value.clone()).ok());
        ProgramHealthInput {
            room,
            output_health,
            show_profile,
            microphone,
            command_times,
        }
    }

    #[test]
    fn fixture_layers_match_electron() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../protocol-fixtures/cloud-parity-health.json");
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("fixture")).unwrap();
        for vector in fixture["layers"].as_array().unwrap() {
            let name = vector["name"].as_str().unwrap();
            let input = input_from_json(vector["input"].clone());
            let rows = program_health_rows(&input);
            let got: Vec<_> = rows
                .iter()
                .map(|row| {
                    json!([
                        row.id.clone(),
                        row.status.clone(),
                        row.tone.as_str().to_string()
                    ])
                })
                .collect();
            assert_eq!(got, vector["expected"], "{name}");
            if let Some(includes) = vector.get("detailIncludes").and_then(Value::as_object) {
                for (id, words) in includes {
                    let detail = rows
                        .iter()
                        .find(|row| row.id == *id)
                        .map(|row| row.detail.as_str())
                        .unwrap_or("");
                    assert!(
                        detail.contains(words.as_str().unwrap()),
                        "{name} {id}: {detail:?} missing {words}"
                    );
                }
            }
            for row in &rows {
                assert!(
                    !row.status
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '-'),
                    "{name}: status {:?} looks machine-cased",
                    row.status
                );
            }
        }
    }

    #[test]
    fn unknown_output_is_skipped_never_healthy() {
        let rows = program_health_rows(&ProgramHealthInput {
            room: Some(RoomStatus {
                participants: Vec::new(),
                ..RoomStatus::default()
            }),
            output_health: vec![CloudOutputHealth {
                output: "archive".into(),
                orientation: "square".into(),
                egress: "active".into(),
                page: "reporting".into(),
                joined: true,
                audio: "measured".into(),
                ..CloudOutputHealth::default()
            }],
            ..ProgramHealthInput::default()
        });
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["host-microphone"]
        );
    }

    #[test]
    fn verdict_is_worst_first() {
        assert_eq!(program_health_verdict(&[]), ProgramHealthTone::Neutral);
        let good = ProgramHealthRow {
            id: "a".into(),
            layer: ProgramHealthLayer::Contribution,
            label: "a".into(),
            status: "Published".into(),
            tone: ProgramHealthTone::Good,
            detail: String::new(),
        };
        let err = ProgramHealthRow {
            tone: ProgramHealthTone::Error,
            ..good.clone()
        };
        assert_eq!(
            program_health_verdict(&[good.clone()]),
            ProgramHealthTone::Good
        );
        assert_eq!(
            program_health_verdict(&[good, err]),
            ProgramHealthTone::Error
        );
    }
}
