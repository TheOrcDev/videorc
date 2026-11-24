//! What each `health` event code does to the list (plan 250 S5, Electron's
//! `lib/notifications/health-kinds.ts`). One row per code: the subject it is
//! about, and whether it opens that subject, resolves it, or is a thing that
//! happened once. The table replaces the `if` chains that raised a toast per
//! code.
//!
//! A code with no row raises nothing. A code that is known and deliberately
//! silent has an `Ignore` row, by name, so the test that walks Electron's
//! codes tells "decided" from "forgotten".

/// The page or section an entry sends the streamer to (`HealthDoor`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthDoor {
    Health,
    Audio,
    Sources,
    SystemAudio,
    Output,
}

/// `HealthKindRow`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthRow {
    Open {
        /// The subject.
        key: &'static str,
        kind: &'static str,
        /// Who reports, when two codes keep one subject open on their own.
        source: Option<&'static str>,
        title: &'static str,
        /// The words when the event's level is `error`, which also makes it
        /// urgent.
        error_title: Option<&'static str>,
        /// An `error` level makes the entry urgent (the kind allows it).
        urgent_on_error: bool,
        door: Option<HealthDoor>,
    },
    Resolve {
        key: &'static str,
        /// The reports this recovery clears; empty: the code's own (`health`).
        sources: &'static [&'static str],
        title: &'static str,
        /// "It was choppy": the store adds how long.
        was: Option<&'static str>,
    },
    Event {
        key: &'static str,
        kind: &'static str,
        title: &'static str,
        /// Words of Videorc's own, where the backend's line carries internals.
        detail: Option<&'static str>,
        door: Option<HealthDoor>,
    },
    /// Known, and handled by its own function (it needs more than the code).
    Custom,
    /// Known, and deliberately silent.
    Ignore { why: &'static str },
}

pub const HEALTH_SOURCE: &str = "health";
pub const MICROPHONE_SILENT_SOURCE: &str = "health:silent";
pub const MICROPHONE_LOST_SOURCE: &str = "health:lost";
pub const SCREEN_WINDOW_SOURCE: &str = "health:window";

const fn open(key: &'static str, kind: &'static str, title: &'static str) -> HealthRow {
    HealthRow::Open {
        key,
        kind,
        source: None,
        title,
        error_title: None,
        urgent_on_error: false,
        door: None,
    }
}

const fn open_door(
    key: &'static str,
    kind: &'static str,
    title: &'static str,
    door: HealthDoor,
) -> HealthRow {
    HealthRow::Open {
        key,
        kind,
        source: None,
        title,
        error_title: None,
        urgent_on_error: false,
        door: Some(door),
    }
}

const fn resolve(key: &'static str, title: &'static str, was: &'static str) -> HealthRow {
    HealthRow::Resolve {
        key,
        sources: &[],
        title,
        was: Some(was),
    }
}

const fn event(
    key: &'static str,
    kind: &'static str,
    title: &'static str,
    door: Option<HealthDoor>,
) -> HealthRow {
    HealthRow::Event {
        key,
        kind,
        title,
        detail: None,
        door,
    }
}

use HealthDoor::{Audio, Health, Output, Sources, SystemAudio};

/// `HEALTH_KINDS`, in Electron's order.
pub const HEALTH_KINDS: &[(&str, HealthRow)] = &[
    // The live output.
    (
        "stream-output-failed",
        event(
            "stream-output",
            "stream-output-failed",
            "Your stream stopped",
            Some(Health),
        ),
    ),
    (
        "stream-output-stalled",
        open_door(
            "stream-output",
            "stream-output",
            "Your stream is frozen",
            Health,
        ),
    ),
    (
        "stream-output-resumed",
        resolve(
            "stream-output",
            "Your stream is moving again",
            "It was frozen",
        ),
    ),
    (
        "recording-output-failed",
        event(
            "recording-output",
            "recording-output-failed",
            "Your recording stopped",
            Some(Health),
        ),
    ),
    (
        "stream-delivery-degraded",
        open_door(
            "stream-delivery",
            "stream-delivery",
            "Your stream is choppy",
            Health,
        ),
    ),
    (
        "stream-delivery-recovered",
        resolve(
            "stream-delivery",
            "Your stream is smooth again",
            "It was choppy",
        ),
    ),
    // The connection: an overflow, the step down it causes, the floor and
    // the way back are one subject.
    (
        "stream-leg-overflow",
        open_door(
            "stream-uplink",
            "stream-uplink",
            "Your connection can’t keep up",
            Health,
        ),
    ),
    (
        "stream-bitrate-lowered",
        open_door(
            "stream-uplink",
            "stream-uplink",
            "Stream quality lowered to fit your connection",
            Health,
        ),
    ),
    (
        "stream-bitrate-floor",
        open_door(
            "stream-uplink",
            "stream-uplink",
            "Your connection can’t carry this stream",
            Health,
        ),
    ),
    (
        "stream-bitrate-restored",
        resolve(
            "stream-uplink",
            "Stream quality is back",
            "Your connection held it back",
        ),
    ),
    // The screen.
    (
        "screen-capture-stopped",
        HealthRow::Open {
            key: "screen-capture",
            kind: "screen-capture",
            source: None,
            title: "Screen capture stopped",
            error_title: None,
            urgent_on_error: true,
            door: Some(Sources),
        },
    ),
    (
        "screen-capture-restored",
        resolve("screen-capture", "Screen capture is back", "It was stopped"),
    ),
    (
        "screen-window-out-of-sight",
        HealthRow::Open {
            key: "screen-capture",
            kind: "screen-capture",
            source: Some(SCREEN_WINDOW_SOURCE),
            title: "Window out of sight",
            error_title: None,
            urgent_on_error: false,
            door: Some(Sources),
        },
    ),
    (
        "screen-window-back",
        HealthRow::Resolve {
            key: "screen-capture",
            sources: &[SCREEN_WINDOW_SOURCE],
            title: "The window is back",
            was: Some("It was out of sight"),
        },
    ),
    // The computer. Each says when it cleared (plan 250 S9); an episode
    // still open ends with the session.
    (
        "host-overloaded",
        open(
            "host-overloaded",
            "host-overloaded",
            "This computer is overloaded",
        ),
    ),
    (
        "host-overload-cleared",
        resolve(
            "host-overloaded",
            "This computer is keeping up again",
            "It was overloaded",
        ),
    ),
    // Sent at Record and again each time it gets worse: the words follow.
    (
        "disk-space-low",
        open_door("disk-space", "disk-space", "Recording space is low", Output),
    ),
    (
        "disk-space-recovered",
        resolve("disk-space", "Recording space is back", "It was low"),
    ),
    // It stops the take; the take's failure lands on the same entry.
    ("recording-disk-full", HealthRow::Custom),
    // The microphone. Two reports can hold the subject open: no sound
    // (`mic-silent`), and a lost or silent input (`sources::devices`).
    (
        "mic-silent",
        HealthRow::Open {
            key: "microphone",
            kind: "microphone",
            source: Some(MICROPHONE_SILENT_SOURCE),
            title: "Microphone is silent",
            error_title: Some("Recording has no sound"),
            urgent_on_error: true,
            door: Some(Audio),
        },
    ),
    ("microphone-input-lost", HealthRow::Custom),
    ("microphone-timeline-lost", HealthRow::Custom),
    ("microphone-silent", HealthRow::Custom),
    ("system-audio-lost", HealthRow::Custom),
    (
        "microphone-timeline-recovered",
        HealthRow::Resolve {
            key: "microphone",
            sources: &[MICROPHONE_LOST_SOURCE],
            title: "Microphone is back",
            was: None,
        },
    ),
    (
        "microphone-input-recovered",
        HealthRow::Resolve {
            key: "microphone",
            sources: &[MICROPHONE_LOST_SOURCE],
            title: "Microphone is back",
            was: None,
        },
    ),
    (
        "microphone-signal-recovered",
        HealthRow::Resolve {
            key: "microphone",
            sources: &[MICROPHONE_LOST_SOURCE, MICROPHONE_SILENT_SOURCE],
            title: "Your microphone has sound again",
            was: Some("It was silent"),
        },
    ),
    // Short blips with no open state: one counted entry each, never a pop-up.
    (
        "microphone-noise-reduction-silenced",
        event(
            "microphone-blip",
            "audio-blip",
            "Microphone silenced for a moment",
            None,
        ),
    ),
    (
        "audio-output-stalled",
        event(
            "audio-blip",
            "audio-blip",
            "Audio dropped for a moment",
            None,
        ),
    ),
    (
        "system-audio-echo-paused",
        open_door(
            "system-audio-echo",
            "system-audio-echo",
            "System audio paused: your stream was echoing",
            SystemAudio,
        ),
    ),
    (
        "audio-output-failed",
        event(
            "audio-output",
            "audio-output-failed",
            "Your recording has no sound from here",
            Some(Health),
        ),
    ),
    // The take's files and its start.
    ("separate-source-recordings-role-failed", HealthRow::Custom),
    ("separate-source-recordings-shed", HealthRow::Custom),
    ("recording-quality-not-100", HealthRow::Custom),
    ("recording-startup-cadence-unsteady", HealthRow::Custom),
    ("recording-output-stepped-down", HealthRow::Custom),
    ("recording-degraded", HealthRow::Custom),
    ("microphone-capture-worker-fallback", HealthRow::Custom),
    ("microphone-capture-worker-unavailable", HealthRow::Custom),
    ("recording-startup-barrier-timeout", HealthRow::Custom),
    (
        "stream-dropped-frames",
        HealthRow::Ignore {
            why: "It fires on every rise of the count; the stream-delivery condition covers it.",
        },
    ),
    (
        "live-background-gpu-budget",
        HealthRow::Ignore {
            why: "The still line on the Assets page covers it.",
        },
    ),
];

/// `healthKindFor`: the row for a code. The watchdog's own history codes
/// (`watchdog-<check>`, `-cleared` …) are ignored by name: the alert list is
/// their source.
pub fn health_kind_for(code: &str) -> Option<HealthRow> {
    if code.starts_with("watchdog-") {
        return Some(HealthRow::Ignore {
            why: "The watchdog alert list is the source.",
        });
    }
    HEALTH_KINDS
        .iter()
        .find(|(each, _)| *each == code)
        .map(|(_, row)| *row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::kinds;

    #[test]
    fn every_row_names_a_known_kind_and_the_watchdog_is_ignored() {
        for (code, row) in HEALTH_KINDS {
            match row {
                HealthRow::Open { kind, .. } | HealthRow::Event { kind, .. } => {
                    assert!(kinds::find(kind).is_some(), "{code}: {kind}");
                }
                _ => {}
            }
        }
        assert!(matches!(
            health_kind_for("watchdog-stream-health-cleared"),
            Some(HealthRow::Ignore { .. })
        ));
        assert_eq!(health_kind_for("nope"), None);
        // An urgent-on-error row's kind allows urgent.
        for (code, row) in HEALTH_KINDS {
            if let HealthRow::Open {
                kind,
                urgent_on_error: true,
                ..
            } = row
            {
                let kind = kinds::find(kind).unwrap();
                assert!(
                    kind.may_be.contains(&crate::notices::Tone::Urgent),
                    "{code}"
                );
            }
        }
    }

    /// Every code in Electron's table is here, and nothing else.
    #[test]
    fn the_table_is_electrons() {
        const ELECTRON: &str = include_str!(
            "../../../../apps/desktop/src/renderer/src/lib/notifications/health-kinds.ts"
        );
        let block = ELECTRON
            .split("export const HEALTH_KINDS: Record<string, HealthKindRow> = {")
            .nth(1)
            .unwrap()
            .split("\n}\n")
            .next()
            .unwrap();
        let mut electron: Vec<&str> = block
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with('\'') && line.contains("': {"))
            .map(|line| line.split('\'').nth(1).unwrap())
            .collect();
        let mut rust: Vec<&str> = HEALTH_KINDS.iter().map(|(code, _)| *code).collect();
        electron.sort_unstable();
        rust.sort_unstable();
        assert_eq!(rust, electron);
        for (_, row) in HEALTH_KINDS {
            let title = match row {
                HealthRow::Open { title, .. }
                | HealthRow::Resolve { title, .. }
                | HealthRow::Event { title, .. } => *title,
                _ => continue,
            };
            assert!(ELECTRON.contains(&format!("title: '{title}'")), "{title}");
        }
    }
}
