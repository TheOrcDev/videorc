//! Plan 253 S7: the backend remembers a managed talk show's delays
//! (docs/cloud/253-latency-contract.md, section 10).
//!
//! The renderer computes (D4): every 10 s the room client hands over what it
//! measured as `cloud.room.latency.report`. This module folds those reports,
//! the time each web command took and the program page's stage apply time
//! into one row per minute in `cloud_latency_minutes`, and writes a
//! `cloud-command-slow` health event when a command took 2 s or more.
//!
//! Durations only, never a timestamp from another machine (D1). Managed talk
//! shows only (D10): for a solo show, a node show or no room, nothing is
//! kept and the status is unchanged. Nothing here is sent anywhere: the
//! record stays on this computer and is deleted with its show (D12).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::cloud_show::CloudStatus;
use crate::protocol::HealthLevel;
use crate::state::AppState;
use crate::storage::LatencyMinuteRow;

/// A command that took this long leaves a health event (D8).
pub(crate) const SLOW_COMMAND_MS: u32 = 2_000;
pub(crate) const SLOW_COMMAND_CODE: &str = "cloud-command-slow";

/// The contract's `NET_MAX_MS`: the bound of every reported duration.
const REPORT_MAX_MS: u32 = 60_000;
/// More than a room holds (`NET_MAX_SENDERS` is 8).
const REPORT_MAX_PEOPLE: usize = 16;
const IDENTITY_MAX_CHARS: usize = 128;
const NAME_MAX_CHARS: usize = 80;
/// A stage that took longer than this to draw was not drawn for that stage.
const APPLY_MAX_MS: u64 = 600_000;
/// One figure's samples in one minute: six reports, or a burst of commands.
const MINUTE_MAX_SAMPLES: usize = 240;
const OPEN_MINUTES_MAX: usize = 512;

pub(crate) const SUBJECT_PROGRAM: &str = "program";
pub(crate) const SUBJECT_CONTROL: &str = "control";

/// `cloud.room.latency.report`: what the host's room client measured over
/// its last sample. Strict: an unknown key or a value out of bounds refuses
/// the report, and nothing of it is kept.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LatencyReportParams {
    pub show_id: String,
    /// The host's own round trip to the room.
    #[serde(default)]
    pub host_rtt_ms: Option<u32>,
    #[serde(default)]
    pub people: Vec<LatencyPerson>,
    #[serde(default)]
    pub program: Option<LatencyProgram>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LatencyPerson {
    pub identity: String,
    #[serde(default)]
    pub name: Option<String>,
    /// The conversation delay: the worse of the two directions.
    pub ms: u32,
    /// A part or a direction is missing: `ms` is a floor.
    #[serde(default)]
    pub partial: bool,
    #[serde(default)]
    pub to_guest_ms: Option<u32>,
    #[serde(default)]
    pub from_guest_ms: Option<u32>,
    #[serde(default)]
    pub video_to_guest_ms: Option<u32>,
    #[serde(default)]
    pub video_from_guest_ms: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LatencyProgram {
    /// The picture: the host's camera to the page having drawn it.
    pub ms: u32,
    #[serde(default)]
    pub audio_ms: Option<u32>,
}

/// One measured duration, before it is folded into its minute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LatencySample {
    pub subject: String,
    pub kind: &'static str,
    pub name: Option<String>,
    pub ms: u32,
    pub partial: bool,
}

fn in_bounds(ms: Option<u32>) -> bool {
    ms.is_none_or(|ms| ms <= REPORT_MAX_MS)
}

impl LatencyReportParams {
    /// Why this report is refused, if it is.
    fn problem(&self) -> Option<&'static str> {
        if self.show_id.is_empty() || self.show_id.chars().count() > IDENTITY_MAX_CHARS {
            return Some("Name the show.");
        }
        if self.people.len() > REPORT_MAX_PEOPLE {
            return Some("Too many people in one report.");
        }
        if !in_bounds(self.host_rtt_ms)
            || self
                .program
                .as_ref()
                .is_some_and(|program| program.ms > REPORT_MAX_MS || !in_bounds(program.audio_ms))
        {
            return Some("A duration is out of bounds.");
        }
        for (index, person) in self.people.iter().enumerate() {
            let identity = person.identity.as_str();
            if identity.is_empty()
                || identity.chars().count() > IDENTITY_MAX_CHARS
                || identity == SUBJECT_PROGRAM
                || identity == SUBJECT_CONTROL
                || self.people[..index]
                    .iter()
                    .any(|other| other.identity == identity)
            {
                return Some("A person's identity is missing, reserved or repeated.");
            }
            if person.ms > REPORT_MAX_MS
                || !in_bounds(person.to_guest_ms)
                || !in_bounds(person.from_guest_ms)
                || !in_bounds(person.video_to_guest_ms)
                || !in_bounds(person.video_from_guest_ms)
            {
                return Some("A duration is out of bounds.");
            }
        }
        None
    }

    /// Every figure of the report as its own sample. A guest's subject is
    /// its room identity; the host's round trip sits under `host:<show>`.
    fn samples(&self) -> Vec<LatencySample> {
        let mut samples = Vec::new();
        let mut push = |subject: &str, kind, name: &Option<String>, ms, partial| {
            samples.push(LatencySample {
                subject: subject.to_string(),
                kind,
                name: name.clone(),
                ms,
                partial,
            });
        };
        if let Some(ms) = self.host_rtt_ms {
            push(&format!("host:{}", self.show_id), "rtt", &None, ms, false);
        }
        for person in &self.people {
            let name = person
                .name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(|name| name.chars().take(NAME_MAX_CHARS).collect::<String>());
            let identity = person.identity.as_str();
            push(identity, "conversation", &name, person.ms, person.partial);
            for (kind, ms) in [
                ("to-guest", person.to_guest_ms),
                ("from-guest", person.from_guest_ms),
                ("video-to-guest", person.video_to_guest_ms),
                ("video-from-guest", person.video_from_guest_ms),
            ] {
                if let Some(ms) = ms {
                    push(identity, kind, &name, ms, false);
                }
            }
        }
        if let Some(program) = &self.program {
            push(SUBJECT_PROGRAM, "picture", &None, program.ms, false);
            if let Some(ms) = program.audio_ms {
                push(SUBJECT_PROGRAM, "sound", &None, ms, false);
            }
        }
        samples
    }
}

/// The nearest-rank percentile of sorted values: the smallest value with at
/// least `percent` of the samples at or below it.
fn percentile(sorted: &[u32], percent: usize) -> u32 {
    let rank = (sorted.len() * percent).div_ceil(100).max(1);
    sorted[rank.min(sorted.len()) - 1]
}

struct OpenMinute {
    minute: i64,
    values: Vec<u32>,
    partial: u32,
    name: Option<String>,
}

/// Folds samples into one row per show, minute, subject and kind. It holds
/// the open minute's samples, so each row it hands back is that whole minute
/// so far and replaces the one written before it. A sample of a new minute
/// starts over; the row of the minute before is already written.
#[derive(Default)]
pub(crate) struct MinuteFolder {
    open: HashMap<(String, String, &'static str), OpenMinute>,
}

impl MinuteFolder {
    pub(crate) fn observe(
        &mut self,
        show_id: &str,
        minute: i64,
        sample: LatencySample,
    ) -> LatencyMinuteRow {
        if self.open.len() >= OPEN_MINUTES_MAX {
            self.open.retain(|_, open| open.minute >= minute);
        }
        let key = (show_id.to_string(), sample.subject.clone(), sample.kind);
        let open = self.open.entry(key).or_insert_with(|| OpenMinute {
            minute,
            values: Vec::new(),
            partial: 0,
            name: None,
        });
        if open.minute != minute {
            open.minute = minute;
            open.values.clear();
            open.partial = 0;
        }
        if open.values.len() < MINUTE_MAX_SAMPLES {
            let at = open.values.partition_point(|value| *value <= sample.ms);
            open.values.insert(at, sample.ms);
            open.partial += u32::from(sample.partial);
        }
        if sample.name.is_some() {
            open.name = sample.name;
        }
        LatencyMinuteRow {
            show_id: show_id.to_string(),
            minute,
            subject: sample.subject,
            kind: sample.kind.to_string(),
            name: open.name.clone(),
            p50_ms: percentile(&open.values, 50),
            p95_ms: percentile(&open.values, 95),
            max_ms: open.values[open.values.len() - 1],
            samples: open.values.len() as u32,
            partial: open.partial,
        }
    }
}

/// How long the web took to answer this show's commands (D8), for the
/// Health page's Commands row. On `CloudStatus` only once a command of a
/// managed talk show was timed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudCommandTimes {
    pub last_ms: u32,
    pub slowest_ms: u32,
}

impl CloudCommandTimes {
    pub(crate) fn with(previous: Option<Self>, ms: u32) -> Self {
        Self {
            last_ms: ms,
            slowest_ms: previous.map_or(ms, |times| times.slowest_ms.max(ms)),
        }
    }
}

/// One command to the web, timed on the backend's monotonic clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandTiming {
    pub show_id: String,
    pub kind: &'static str,
    pub ms: u32,
    pub failed: bool,
}

/// The intents that reach the web (`send_web_intent_until`'s routes). Any
/// other kind sends nothing, so there is nothing to time.
fn command_kind(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "stage.set" => "stage.set",
        "destinations.set" => "destinations.set",
        "legs.end" => "legs.end",
        "recording.start" => "recording.start",
        "recording.stop" => "recording.stop",
        "hold.image.set" => "hold.image.set",
        _ => return None,
    })
}

/// The health event a command leaves when it was slow: the command and the
/// milliseconds, so an overloaded show leaves evidence.
pub(crate) fn slow_command_message(timing: &CommandTiming) -> Option<String> {
    (timing.ms >= SLOW_COMMAND_MS).then(|| {
        format!(
            "Videorc Cloud took {:.1} s to {} {} ({} ms).",
            f64::from(timing.ms) / 1000.0,
            if timing.failed { "fail" } else { "answer" },
            timing.kind,
            timing.ms
        )
    })
}

#[derive(Default)]
struct Recorder {
    folder: MinuteFolder,
    /// The stage whose apply time was last recorded, so a later report of
    /// the same draw is not a second sample.
    stage: Option<(String, String)>,
}

static RECORDER: OnceLock<Mutex<Recorder>> = OnceLock::new();
static COMMANDS: OnceLock<mpsc::UnboundedSender<CommandTiming>> = OnceLock::new();

fn recorder() -> std::sync::MutexGuard<'static, Recorder> {
    RECORDER
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn this_minute() -> i64 {
    chrono::Utc::now().timestamp().div_euclid(60)
}

/// Is `show_id` the managed talk show this computer holds a room of (D10)?
/// The backend's room measures only then (`room_latency`, S1.8c c6).
pub(crate) fn managed_show(state: &AppState, show_id: &str) -> bool {
    let runtime = crate::cloud_show::lock(&state.cloud_show);
    runtime.talk_show_room_show_id().as_deref() == Some(show_id)
        && runtime.show.as_ref().is_some_and(|show| {
            show.control.transport_kind() == crate::cloud_show::ControlKind::Web
        })
}

fn fold(show_id: &str, samples: Vec<LatencySample>) -> Vec<LatencyMinuteRow> {
    let minute = this_minute();
    let mut recorder = recorder();
    samples
        .into_iter()
        .map(|sample| recorder.folder.observe(show_id, minute, sample))
        .collect()
}

/// Off the caller's task: the record never holds up a command or the room.
fn write(state: &AppState, rows: Vec<LatencyMinuteRow>) {
    if rows.is_empty() {
        return;
    }
    let database = state.database.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(error) = database.save_cloud_latency_minutes(&rows) {
            tracing::debug!("Could not keep the show's latency record: {error:#}");
        }
    });
}

/// The rows a report folds into: `Err` for a report that is refused, an
/// empty list for a show that is not this computer's managed talk show.
pub(crate) fn fold_report(
    state: &AppState,
    params: &LatencyReportParams,
) -> Result<Vec<LatencyMinuteRow>, &'static str> {
    if let Some(problem) = params.problem() {
        return Err(problem);
    }
    if !managed_show(state, &params.show_id) {
        return Ok(Vec::new());
    }
    Ok(fold(&params.show_id, params.samples()))
}

/// `cloud.room.latency.report`. Answers whether anything was kept.
pub(crate) fn report(state: &AppState, params: &LatencyReportParams) -> Result<bool, &'static str> {
    let rows = fold_report(state, params)?;
    let kept = !rows.is_empty();
    write(state, rows);
    Ok(kept)
}

/// A web command was answered (or failed, or timed out) after `elapsed`.
/// Called on the intent's own task; nothing here waits. Before
/// `spawn_command_recorder`, and for an intent with no route, it does nothing.
pub(crate) fn note_command(show_id: &str, kind: &str, elapsed: Duration, failed: bool) {
    let (Some(commands), Some(kind)) = (COMMANDS.get(), command_kind(kind)) else {
        return;
    };
    let _ = commands.send(CommandTiming {
        show_id: show_id.to_string(),
        kind,
        ms: u32::try_from(elapsed.as_millis()).unwrap_or(u32::MAX),
        failed,
    });
}

/// What one timed command leaves: its minute row, the show's command times
/// on the status, and a health event when it was slow. `None` (and nothing
/// kept) unless the show is this computer's managed talk show.
pub(crate) fn record_command(state: &AppState, timing: &CommandTiming) -> Option<CloudStatus> {
    if !managed_show(state, &timing.show_id) {
        return None;
    }
    let status = {
        let mut runtime = crate::cloud_show::lock(&state.cloud_show);
        let previous = runtime
            .command_times
            .take()
            .filter(|(show_id, _)| *show_id == timing.show_id)
            .map(|(_, times)| times);
        runtime.command_times = Some((
            timing.show_id.clone(),
            CloudCommandTimes::with(previous, timing.ms),
        ));
        runtime.status()
    };
    if let Some(message) = slow_command_message(timing) {
        // The show's Library entry exists only once it is live or recording;
        // before that the event is stored without a session.
        let session = state
            .database
            .session_exists(&timing.show_id)
            .unwrap_or(false)
            .then_some(timing.show_id.as_str());
        if let Err(error) = crate::recording::emit_health_event(
            state,
            session,
            HealthLevel::Warn,
            SLOW_COMMAND_CODE,
            &message,
        ) {
            tracing::debug!("Could not keep the slow command's health event: {error:#}");
        }
    }
    Some(status)
}

/// Starts the one task that records command timings. Once per process.
pub(crate) fn spawn_command_recorder(state: &AppState) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    if COMMANDS.set(tx).is_err() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        while let Some(timing) = rx.recv().await {
            let Some(status) = record_command(&state, &timing) else {
                continue;
            };
            write(
                &state,
                fold(
                    &timing.show_id,
                    vec![LatencySample {
                        subject: SUBJECT_CONTROL.to_string(),
                        kind: timing.kind,
                        name: None,
                        ms: timing.ms,
                        partial: false,
                    }],
                ),
            );
            state.emit_event(crate::cloud_show::CLOUD_STATE_EVENT, &status);
        }
    });
}

/// The stage apply time a status carries, once per stage the page drew:
/// the show, the stage's key and `room.shown.applyMs`. Managed shows only
/// (the web alone sends `applyMs`, and only for a stage it accepted).
fn stage_apply(status: &CloudStatus) -> Option<(&str, &str, u32)> {
    let show = status.show.as_ref()?;
    let shown = status.room.as_ref()?.shown.as_ref()?;
    let ms = shown.apply_ms.filter(|ms| *ms <= APPLY_MAX_MS)?;
    Some((
        show.id.as_str(),
        shown.stage_key.as_deref()?,
        u32::try_from(ms).ok()?,
    ))
}

/// The row a status adds, if it shows a stage whose apply time is new.
pub(crate) fn fold_status(status: &CloudStatus, minute: i64) -> Option<LatencyMinuteRow> {
    let (show_id, stage_key, ms) = stage_apply(status)?;
    let mut recorder = recorder();
    if recorder
        .stage
        .as_ref()
        .is_some_and(|(show, key)| show == show_id && key == stage_key)
    {
        return None;
    }
    recorder.stage = Some((show_id.to_string(), stage_key.to_string()));
    Some(recorder.folder.observe(
        show_id,
        minute,
        LatencySample {
            subject: SUBJECT_PROGRAM.to_string(),
            kind: "stage-apply",
            name: None,
            ms,
            partial: false,
        },
    ))
}

/// Every emitted status passes here: a newly drawn stage's apply time goes
/// into the record.
pub(crate) fn observe_status(state: &AppState, status: &CloudStatus) {
    if let Some(row) = fold_status(status, this_minute()) {
        write(state, vec![row]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(ms: u32, partial: bool) -> LatencySample {
        LatencySample {
            subject: "g_ada".to_string(),
            kind: "conversation",
            name: Some("Ada".to_string()),
            ms,
            partial,
        }
    }

    fn report_json(show_id: &str) -> serde_json::Value {
        json!({
            "showId": show_id,
            "hostRttMs": 42,
            "people": [{
                "identity": "g_ada", "name": "  Ada  ", "ms": 210, "partial": true,
                "toGuestMs": 210, "fromGuestMs": 180, "videoFromGuestMs": 96
            }],
            "program": { "ms": 300, "audioMs": 120 }
        })
    }

    fn state_with_room(show_id: &str, managed: bool) -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        let state = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        let _control =
            crate::cloud_talk::open_talk_show_for_tests(&state.cloud_show, show_id, true);
        if managed {
            crate::cloud_show::lock(&state.cloud_show)
                .show
                .as_mut()
                .unwrap()
                .control =
                serde_json::from_value(json!({ "kind": "web", "url": "", "token": "" })).unwrap();
        }
        state
    }

    #[test]
    fn a_minute_folds_to_its_median_its_95th_and_its_worst() {
        let mut folder = MinuteFolder::default();
        let mut row = None;
        for ms in [180, 900, 150, 210, 170, 160] {
            row = Some(folder.observe("sh_fold", 100, sample(ms, ms == 900)));
        }
        let row = row.unwrap();
        // Nearest rank over 150 160 170 180 210 900.
        assert_eq!((row.p50_ms, row.p95_ms, row.max_ms), (170, 900, 900));
        assert_eq!((row.samples, row.partial), (6, 1));
        assert_eq!(row.name.as_deref(), Some("Ada"));
        assert_eq!((row.minute, row.kind.as_str()), (100, "conversation"));
    }

    #[test]
    fn one_sample_is_its_own_minute() {
        let row = MinuteFolder::default().observe("sh_fold", 7, sample(180, false));
        assert_eq!((row.p50_ms, row.p95_ms, row.max_ms), (180, 180, 180));
        assert_eq!((row.samples, row.partial), (1, 0));
    }

    #[test]
    fn a_new_minute_starts_over_and_figures_never_mix() {
        let mut folder = MinuteFolder::default();
        folder.observe("sh_fold", 100, sample(900, true));
        let other = folder.observe(
            "sh_fold",
            100,
            LatencySample {
                kind: "to-guest",
                ..sample(40, false)
            },
        );
        assert_eq!((other.max_ms, other.samples), (40, 1));
        let other_show = folder.observe("sh_other", 100, sample(60, false));
        assert_eq!((other_show.max_ms, other_show.samples), (60, 1));
        let next = folder.observe("sh_fold", 101, sample(200, false));
        assert_eq!((next.minute, next.max_ms), (101, 200));
        assert_eq!((next.samples, next.partial), (1, 0));
    }

    #[test]
    fn a_minute_keeps_a_bounded_number_of_samples() {
        let mut folder = MinuteFolder::default();
        let mut row = folder.observe("sh_fold", 1, sample(10, false));
        for _ in 0..MINUTE_MAX_SAMPLES + 20 {
            row = folder.observe("sh_fold", 1, sample(10, false));
        }
        assert_eq!(row.samples as usize, MINUTE_MAX_SAMPLES);
    }

    #[test]
    fn a_report_is_one_sample_per_figure() {
        let params: LatencyReportParams = serde_json::from_value(report_json("sh_r")).unwrap();
        assert_eq!(params.problem(), None);
        let samples = params.samples();
        let figures: Vec<_> = samples
            .iter()
            .map(|sample| (sample.subject.as_str(), sample.kind, sample.ms))
            .collect();
        assert_eq!(
            figures,
            vec![
                ("host:sh_r", "rtt", 42),
                ("g_ada", "conversation", 210),
                ("g_ada", "to-guest", 210),
                ("g_ada", "from-guest", 180),
                ("g_ada", "video-from-guest", 96),
                ("program", "picture", 300),
                ("program", "sound", 120),
            ]
        );
        // The floor mark rides the headline figure, with the trimmed name.
        assert!(samples[1].partial);
        assert_eq!(samples[1].name.as_deref(), Some("Ada"));
        assert!(samples[0].name.is_none());
    }

    #[test]
    fn a_report_with_an_unknown_key_or_a_bad_value_is_refused() {
        let mut unknown = report_json("sh_r");
        unknown["at"] = json!(1_794_000_000_123_u64);
        assert!(serde_json::from_value::<LatencyReportParams>(unknown).is_err());
        let mut nested = report_json("sh_r");
        nested["people"][0]["address"] = json!("10.0.0.2");
        assert!(serde_json::from_value::<LatencyReportParams>(nested).is_err());
        let mut fraction = report_json("sh_r");
        fraction["program"]["ms"] = json!(12.5);
        assert!(serde_json::from_value::<LatencyReportParams>(fraction).is_err());

        let refused = |edit: fn(&mut serde_json::Value)| {
            let mut value = report_json("sh_r");
            edit(&mut value);
            serde_json::from_value::<LatencyReportParams>(value)
                .unwrap()
                .problem()
                .is_some()
        };
        assert!(refused(|value| value["hostRttMs"] = json!(60_001)));
        assert!(refused(|value| value["people"][0]["ms"] = json!(60_001)));
        assert!(refused(|value| value["people"][0]["identity"] = json!("")));
        assert!(refused(
            |value| value["people"][0]["identity"] = json!("control")
        ));
        assert!(refused(|value| value["showId"] = json!("")));
        assert!(refused(|value| {
            let person = value["people"][0].clone();
            value["people"].as_array_mut().unwrap().push(person);
        }));
        assert!(refused(|value| {
            value["people"] = (0..=REPORT_MAX_PEOPLE)
                .map(|index| json!({ "identity": format!("g_{index}"), "ms": 1 }))
                .collect();
        }));
    }

    #[tokio::test]
    async fn a_managed_shows_report_is_kept_and_any_other_shows_is_not() {
        let state = state_with_room("sh_report_kept", true);
        let params: LatencyReportParams =
            serde_json::from_value(report_json("sh_report_kept")).unwrap();
        let rows = fold_report(&state, &params).unwrap();
        assert_eq!(rows.len(), 7);
        state.database.save_cloud_latency_minutes(&rows).unwrap();
        let kept = state
            .database
            .cloud_latency_minutes("sh_report_kept")
            .unwrap();
        assert_eq!(kept.len(), 7);
        let headline = kept
            .iter()
            .find(|row| row.subject == "g_ada" && row.kind == "conversation")
            .unwrap();
        assert_eq!((headline.max_ms, headline.partial), (210, 1));
        assert_eq!(headline.name.as_deref(), Some("Ada"));

        // Another show's report, a node show's and one with no room: nothing.
        let other: LatencyReportParams = serde_json::from_value(report_json("sh_else")).unwrap();
        assert_eq!(fold_report(&state, &other), Ok(Vec::new()));
        let node = state_with_room("sh_report_node", false);
        let params: LatencyReportParams =
            serde_json::from_value(report_json("sh_report_node")).unwrap();
        assert_eq!(fold_report(&node, &params), Ok(Vec::new()));
        assert_eq!(report(&node, &params), Ok(false));
        let (events, _) = tokio::sync::broadcast::channel(16);
        let no_room = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        assert_eq!(fold_report(&no_room, &params), Ok(Vec::new()));

        // A refused report is an error, never a partly kept one.
        let mut bad = params.clone();
        bad.show_id = "sh_report_kept".to_string();
        bad.people[0].ms = REPORT_MAX_MS + 1;
        assert!(fold_report(&state, &bad).is_err());
    }

    #[test]
    fn only_a_command_of_two_seconds_or_more_is_slow() {
        let timing = |ms, failed| CommandTiming {
            show_id: "sh_c".to_string(),
            kind: "stage.set",
            ms,
            failed,
        };
        assert_eq!(slow_command_message(&timing(1_999, false)), None);
        assert_eq!(
            slow_command_message(&timing(2_000, false)).as_deref(),
            Some("Videorc Cloud took 2.0 s to answer stage.set (2000 ms).")
        );
        assert_eq!(
            slow_command_message(&timing(22_004, true)).as_deref(),
            Some("Videorc Cloud took 22.0 s to fail stage.set (22004 ms).")
        );
    }

    #[test]
    fn only_intents_with_a_route_are_timed() {
        for kind in [
            "stage.set",
            "destinations.set",
            "legs.end",
            "recording.start",
            "recording.stop",
            "hold.image.set",
        ] {
            assert_eq!(command_kind(kind), Some(kind));
        }
        assert_eq!(command_kind("show.end"), None);
        assert_eq!(command_kind("return.set"), None);
    }

    #[tokio::test]
    async fn a_slow_command_leaves_a_health_event_and_the_shows_command_times() {
        let state = state_with_room("sh_slow_command", true);
        let mut events = state.events.subscribe();
        let timing = |ms, failed| CommandTiming {
            show_id: "sh_slow_command".to_string(),
            kind: "stage.set",
            ms,
            failed,
        };

        // A quick command: its times on the status, and no event.
        let status = record_command(&state, &timing(420, false)).unwrap();
        assert_eq!(
            status.command_times,
            Some(CloudCommandTimes {
                last_ms: 420,
                slowest_ms: 420
            })
        );
        assert!(events.try_recv().is_err());

        // A slow one: the event names the command and the milliseconds.
        let status = record_command(&state, &timing(3_412, false)).unwrap();
        assert_eq!(
            status.command_times,
            Some(CloudCommandTimes {
                last_ms: 3_412,
                slowest_ms: 3_412
            })
        );
        let event = events.try_recv().unwrap();
        assert_eq!(event.event, "health.event");
        assert_eq!(event.payload["code"], SLOW_COMMAND_CODE);
        assert_eq!(event.payload["level"], "warn");
        assert_eq!(
            event.payload["message"],
            "Videorc Cloud took 3.4 s to answer stage.set (3412 ms)."
        );
        // No Library entry yet: stored without a session, never refused.
        assert!(event.payload.get("sessionId").is_none_or(|id| id.is_null()));

        // The slowest stays; the last moves.
        let status = record_command(&state, &timing(300, false)).unwrap();
        assert_eq!(
            status.command_times,
            Some(CloudCommandTimes {
                last_ms: 300,
                slowest_ms: 3_412
            })
        );
        assert_eq!(
            serde_json::to_value(&status).unwrap()["commandTimes"],
            json!({ "lastMs": 300, "slowestMs": 3412 })
        );
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_command_of_a_show_that_is_not_managed_leaves_nothing() {
        for (state, show_id) in [
            (state_with_room("sh_node_command", false), "sh_node_command"),
            (state_with_room("sh_held", true), "sh_someone_elses"),
        ] {
            let mut events = state.events.subscribe();
            let before =
                serde_json::to_string(&crate::cloud_show::lock(&state.cloud_show).status())
                    .unwrap();
            let timing = CommandTiming {
                show_id: show_id.to_string(),
                kind: "stage.set",
                ms: 9_000,
                failed: false,
            };
            assert!(record_command(&state, &timing).is_none());
            assert!(events.try_recv().is_err());
            let after = serde_json::to_string(&crate::cloud_show::lock(&state.cloud_show).status())
                .unwrap();
            assert_eq!(before, after);
            assert!(!after.contains("commandTimes"));
        }
    }

    /// The times belong to the show they were measured on.
    #[tokio::test]
    async fn another_shows_command_times_never_ride_the_status() {
        let state = state_with_room("sh_times_a", true);
        let timing = CommandTiming {
            show_id: "sh_times_a".to_string(),
            kind: "legs.end",
            ms: 700,
            failed: false,
        };
        assert!(record_command(&state, &timing).is_some());
        crate::cloud_show::lock(&state.cloud_show)
            .show
            .as_mut()
            .unwrap()
            .record
            .id = "sh_times_b".to_string();
        let status = crate::cloud_show::lock(&state.cloud_show).status();
        assert_eq!(status.command_times, None);
    }

    /// D11: with no latency data the status is byte for byte what it was
    /// before this slice. A `null` or an unknown key in the renderer's strict
    /// contract drops the whole status, so neither may ever appear.
    #[tokio::test]
    async fn a_status_without_latency_is_byte_for_byte_what_it_was() {
        // The room's `shown`, as the web and a runner sent it before S7.
        let before = r#"{"onStage":["host:sh_abc"],"screen":"g_ada","layout":"screen-people","stageKey":"k1","at":"2026-11-20T10:00:00.000Z"}"#;
        let shown: crate::cloud_talk::CloudRoomShown = serde_json::from_str(before).unwrap();
        assert_eq!(shown.apply_ms, None);
        assert_eq!(serde_json::to_string(&shown).unwrap(), before);

        // A value this reader cannot use is dropped. It never refuses the
        // state, and it never comes out the other side as `null`.
        for unusable in [
            json!(null),
            json!("412"),
            json!(-1),
            json!(12.5),
            json!({}),
            json!(crate::cloud_talk::APPLY_MS_MAX + 1),
        ] {
            let mut value: serde_json::Value = serde_json::from_str(before).unwrap();
            value["applyMs"] = unusable;
            let shown: crate::cloud_talk::CloudRoomShown = serde_json::from_value(value).unwrap();
            assert_eq!(shown.apply_ms, None);
            assert_eq!(serde_json::to_string(&shown).unwrap(), before);
        }

        // With an apply time: one more key at the end, and nothing else moves.
        let mut value: serde_json::Value = serde_json::from_str(before).unwrap();
        value["applyMs"] = json!(412);
        let shown: crate::cloud_talk::CloudRoomShown = serde_json::from_value(value).unwrap();
        assert_eq!(shown.apply_ms, Some(412));
        assert_eq!(
            serde_json::to_string(&shown).unwrap(),
            format!(r#"{},"applyMs":412}}"#, before.trim_end_matches('}'))
        );

        // No room, a node show's room and a managed room with no command
        // timed: no key of this slice is on the status.
        let (events, _) = tokio::sync::broadcast::channel(16);
        let no_room = AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        let node = state_with_room("sh_pin_node", false);
        let managed = state_with_room("sh_pin_managed", true);
        for state in [&no_room, &node, &managed] {
            let text = serde_json::to_string(&crate::cloud_show::lock(&state.cloud_show).status())
                .unwrap();
            assert!(!text.contains("commandTimes"), "{text}");
            assert!(!text.contains("applyMs"), "{text}");
        }

        // Command times are one key at the very end: without them the bytes
        // are exactly the bytes of the status before this slice.
        let without =
            serde_json::to_string(&crate::cloud_show::lock(&managed.cloud_show).status()).unwrap();
        let timing = CommandTiming {
            show_id: "sh_pin_managed".to_string(),
            kind: "stage.set",
            ms: 420,
            failed: false,
        };
        let with = serde_json::to_string(&record_command(&managed, &timing).unwrap()).unwrap();
        assert_eq!(
            with,
            format!(
                r#"{},"commandTimes":{{"lastMs":420,"slowestMs":420}}}}"#,
                without.strip_suffix('}').unwrap()
            )
        );
    }

    fn status_with_shown(show_id: &str, shown: serde_json::Value) -> CloudStatus {
        let mut status = crate::storage::Database::cloud_show_status_for_tests();
        status.show.as_mut().unwrap().id = show_id.to_string();
        status.room.as_mut().unwrap().shown = Some(serde_json::from_value(shown).unwrap());
        status
    }

    #[test]
    fn a_drawn_stage_is_one_sample_however_often_its_status_repeats() {
        let show = "sh_stage_apply";
        let first = status_with_shown(
            show,
            json!({ "onStage": [], "stageKey": "k1", "applyMs": 412 }),
        );
        let row = fold_status(&first, 50).unwrap();
        assert_eq!(
            (row.subject.as_str(), row.kind.as_str()),
            ("program", "stage-apply")
        );
        assert_eq!((row.max_ms, row.samples), (412, 1));
        // The page's next heartbeat of the same draw, a few ms off.
        let again = status_with_shown(
            show,
            json!({ "onStage": [], "stageKey": "k1", "applyMs": 415 }),
        );
        assert!(fold_status(&again, 50).is_none());
        // A stage the page has not drawn yet carries no apply time.
        let pending = status_with_shown(show, json!({ "onStage": [], "stageKey": "k1" }));
        assert!(fold_status(&pending, 50).is_none());
        let next = status_with_shown(
            show,
            json!({ "onStage": [], "stageKey": "k2", "applyMs": 388 }),
        );
        assert_eq!(fold_status(&next, 51).unwrap().max_ms, 388);
        // Back to the first stage: it was drawn again.
        assert_eq!(fold_status(&first, 51).unwrap().samples, 2);
        // An apply time no draw could have is not a sample.
        let absurd = status_with_shown(
            show,
            json!({ "onStage": [], "stageKey": "k3", "applyMs": APPLY_MAX_MS + 1 }),
        );
        assert!(fold_status(&absurd, 52).is_none());
        // No room, no sample.
        let mut no_room = next.clone();
        no_room.room = None;
        assert!(fold_status(&no_room, 52).is_none());
    }
}
