//! `first-run.test.ts`'s cases.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use videorc_protocol::{RecordingState, RecordingStatus};

use super::*;

const UPDATED_AT: &str = "2026-10-27T12:00:00.000Z";
const STATUSES: [Status; 4] = [
    Status::InProgress,
    Status::Done,
    Status::Skipped,
    Status::ExistingInstall,
];

fn record(status: Status) -> FirstRunRecord {
    FirstRunRecord {
        status,
        step: Step::Permissions,
        goal: None,
        updated_at: UPDATED_AT.into(),
    }
}

fn record_json(status: Status, edit: impl FnOnce(&mut Value)) -> String {
    let mut value: Value = serde_json::from_str(&record(status).to_json()).unwrap();
    edit(&mut value);
    value.to_string()
}

fn runtime() -> Runtime {
    Runtime {
        platform: "darwin".into(),
        first_run_suppressed: false,
    }
}

fn suppressed() -> Runtime {
    Runtime {
        first_run_suppressed: true,
        ..runtime()
    }
}

/// A store that counts what it was asked.
#[derive(Default)]
struct Store {
    values: BTreeMap<String, String>,
    sets: Vec<String>,
}

impl Store {
    fn seeded(seed: &[(&str, &str)]) -> Self {
        Self {
            values: seed
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            sets: Vec::new(),
        }
    }

    fn record(&self) -> Option<FirstRunRecord> {
        parse_record(self.values.get(FIRST_RUN_KEY).map(String::as_str))
    }
}

impl FirstRunStore for Store {
    fn get(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned()
    }

    fn set(&mut self, key: &str, value: &str) {
        self.sets.push(key.to_string());
        self.values.insert(key.to_string(), value.to_string());
    }
}

const REPLAY: SetupMode = SetupMode::Replay {
    return_to: PageId::Settings,
};

#[test]
fn a_record_round_trips_through_the_store() {
    for status in STATUSES {
        let mut store = Store::default();
        let written = write_record(&mut store, status, INITIAL_PROGRESS, Some(UPDATED_AT));
        assert_eq!(written, record(status));
        assert_eq!(store.record(), Some(record(status)));
    }
    let ids: Vec<_> = Step::ALL.iter().map(|step| step.id()).collect();
    assert_eq!(
        ids,
        ["permissions", "goal", "look", "sound", "destinations"]
    );
}

#[test]
fn an_invalid_or_unknown_record_is_absent() {
    let invalid = [
        String::new(),
        "{".into(),
        "null".into(),
        "[]".into(),
        "1".into(),
        "{}".into(),
        record_json(Status::Done, |v| v["version"] = json!(3)),
        record_json(Status::Done, |v| v["status"] = json!("unknown")),
        record_json(Status::Done, |v| v["status"] = json!(["done"])),
        record_json(Status::Done, |v| v["updatedAt"] = json!(123)),
        record_json(Status::Done, |v| v["updatedAt"] = json!("invalid")),
    ];
    assert_eq!(parse_record(None), None);
    for value in invalid {
        assert_eq!(parse_record(Some(&value)), None, "{value}");
    }
}

#[test]
fn a_v1_record_reads_as_v2_without_reopening_finished_setup() {
    for status in STATUSES {
        let legacy = json!({"version": 1, "status": status.id(), "step": "sound",
            "goal": "both", "updatedAt": UPDATED_AT})
        .to_string();
        assert_eq!(parse_record(Some(&legacy)), Some(record(status)));
        let mut store = Store::seeded(&[(FIRST_RUN_KEY, &legacy)]);
        let mut startup = FirstRunStartup::new(&store);
        let resume = status == Status::InProgress;
        let expected = if resume {
            Snapshot::Resume
        } else {
            Snapshot::Finished
        };
        assert_eq!(startup.snapshot, expected);
        assert_eq!((startup.step(), startup.goal()), (Step::Permissions, None));
        assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(resume));
    }
}

#[test]
fn an_unknown_step_falls_back_and_an_unknown_goal_is_none() {
    for status in STATUSES {
        let value = record_json(status, |v| {
            v["step"] = json!("unknown");
            v["goal"] = json!("both");
        });
        let mut expected = record(status);
        expected.goal = Some(Goal::Both);
        assert_eq!(parse_record(Some(&value)), Some(expected));
    }
    for goal in ["record", "stream", "both"] {
        let value = record_json(Status::InProgress, |v| v["goal"] = json!(goal));
        assert_eq!(parse_record(Some(&value)).unwrap().goal, Goal::parse(goal));
    }
    for goal in [
        json!(null),
        json!("unknown"),
        json!(1),
        json!(["record"]),
        json!({}),
    ] {
        let value = record_json(Status::InProgress, |v| v["goal"] = goal.clone());
        assert_eq!(parse_record(Some(&value)), Some(record(Status::InProgress)));
    }
    let missing = record_json(Status::InProgress, |v| {
        v.as_object_mut().unwrap().remove("goal");
    });
    assert_eq!(
        parse_record(Some(&missing)),
        Some(record(Status::InProgress))
    );
}

#[test]
fn completing_keeps_progress_and_dismisses_older_apps() {
    for completion in [Completion::Done, Completion::Skipped] {
        let progress = Progress {
            step: Step::Sound,
            goal: Some(Goal::Record),
        };
        let mut store = Store::default();
        write_record(&mut store, Status::InProgress, progress, Some(UPDATED_AT));
        complete(&mut store, completion, None);
        let saved = store.record().unwrap();
        assert_eq!(
            (saved.status, saved.step, saved.goal),
            (completion.into(), Step::Sound, Some(Goal::Record))
        );
        assert_eq!(
            store.get(ONBOARDING_KEY).as_deref(),
            Some(ONBOARDING_DISMISSED_VALUE)
        );

        let mut empty = Store::default();
        complete(&mut empty, completion, None);
        assert_eq!(empty.record().unwrap().status, completion.into());
    }
}

#[test]
fn the_steps_follow_the_platform_and_the_goal() {
    let goals = [
        None,
        Some(Goal::Record),
        Some(Goal::Stream),
        Some(Goal::Both),
    ];
    for platform in [Some("darwin"), Some("win32"), Some("linux"), None] {
        for goal in goals {
            let mut expected = Vec::new();
            if platform != Some("linux") {
                expected.push(Step::Permissions);
            }
            expected.extend([Step::Goal, Step::Look, Step::Sound]);
            if goal != Some(Goal::Record) {
                expected.push(Step::Destinations);
            }
            assert_eq!(steps_for(goal, platform), expected);
            for (index, step) in expected.iter().enumerate() {
                assert_eq!(
                    step_position(*step, goal, platform),
                    (index + 1, expected.len())
                );
                assert_eq!(
                    next_step(*step, goal, platform),
                    expected.get(index + 1).copied()
                );
                let previous = index.checked_sub(1).map(|at| expected[at]);
                assert_eq!(previous_step(*step, goal, platform), previous);
            }
        }
    }
    let mac = Some("darwin");
    assert_eq!(step_position(Step::Look, None, mac), (3, 5));
    assert_eq!(step_position(Step::Sound, Some(Goal::Record), mac), (4, 4));
    assert_eq!(next_step(Step::Sound, Some(Goal::Record), mac), None);

    // A saved step the current platform or goal leaves out.
    let (goal, linux) = (Some(Goal::Record), Some("linux"));
    assert_eq!(next_step(Step::Permissions, goal, linux), Some(Step::Goal));
    assert_eq!(previous_step(Step::Permissions, goal, linux), None);
    assert_eq!(step_position(Step::Permissions, goal, linux), (1, 3));
    assert_eq!(next_step(Step::Destinations, goal, linux), None);
    assert_eq!(
        previous_step(Step::Destinations, goal, linux),
        Some(Step::Sound)
    );
    assert_eq!(step_position(Step::Destinations, goal, linux), (3, 3));
}

#[test]
fn the_setup_again_line_names_permissions_only_where_setup_has_it() {
    assert_eq!(
        replay_description(Some("linux")),
        "Go through the welcome steps again."
    );
    assert_eq!(
        replay_description(Some("darwin")),
        "Go through the welcome steps again, starting with permissions."
    );
    assert_eq!(
        replay_description(None),
        "Go through the welcome steps again, starting with permissions."
    );
}

#[test]
fn the_decision() {
    let fresh = snapshot(None, None, None);
    assert_eq!(fresh, Snapshot::Fresh);
    for platform in ["darwin", "win32"] {
        assert!(decision(fresh, false, Some(platform)));
    }
    let resume = snapshot(Some(&record(Status::InProgress)), None, None);
    for platform in [Some("linux"), None] {
        assert!(!decision(fresh, false, platform));
        assert!(!decision(resume, false, platform));
    }
    for legacy in ["creator-ux-v1", ONBOARDING_DISMISSED_VALUE, ""] {
        let existing = snapshot(None, Some(legacy), None);
        assert!(!decision(existing, false, Some("darwin")));
    }
    let whats_new_only = snapshot(None, None, Some("0.9.2"));
    assert!(!decision(whats_new_only, false, Some("darwin")));
    for status in STATUSES {
        let found = snapshot(Some(&record(status)), Some("creator-ux-v1"), Some("0.9.2"));
        let show = status == Status::InProgress;
        assert_eq!(decision(found, false, Some("darwin")), show);
        assert!(!decision(found, true, Some("darwin")));
    }
}

#[test]
fn startup_waits_for_the_runtime_then_writes_once() {
    let mut store = Store::default();
    let mut startup = FirstRunStartup::new(&store);
    assert_eq!(startup.snapshot, Snapshot::Fresh);
    assert_eq!(startup.finalize(&mut store, None), None);
    assert!(store.sets.is_empty());
    assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(true));
    assert_eq!(store.sets, [FIRST_RUN_KEY]);
    assert_eq!(store.record().unwrap().status, Status::InProgress);
    let mut again = FirstRunStartup::new(&store);
    assert_eq!(again.finalize(&mut store, Some(&runtime())), Some(true));
    // Later runtime refreshes do not write again.
    store.sets.clear();
    assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(true));
    assert!(store.sets.is_empty());

    // The snapshot is taken when built: a marker written while the runtime
    // loads does not change it.
    let mut store = Store::default();
    let mut startup = FirstRunStartup::new(&store);
    store.set(WHATS_NEW_LAST_SEEN_KEY, "1.0.0");
    assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(true));
}

#[test]
fn a_finished_setup_stays_hidden_across_remounts() {
    for completion in [Completion::Done, Completion::Skipped] {
        let mut store = Store::default();
        let mut startup = FirstRunStartup::new(&store);
        assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(true));
        startup.complete(&mut store, completion, SetupMode::FirstRun);
        assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(false));
        let mut next = FirstRunStartup::new(&store);
        assert_eq!(next.finalize(&mut store, Some(&runtime())), Some(false));
        assert_eq!(store.record().unwrap().status, completion.into());
        assert_eq!(
            store.get(ONBOARDING_KEY).as_deref(),
            Some(ONBOARDING_DISMISSED_VALUE)
        );
    }
}

#[test]
fn an_existing_install_migrates_exactly_once() {
    for key in [ONBOARDING_KEY, WHATS_NEW_LAST_SEEN_KEY] {
        let mut store = Store::seeded(&[(key, "")]);
        let mut startup = FirstRunStartup::new(&store);
        assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(false));
        assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(false));
        assert_eq!(store.sets.len(), 1);
        assert_eq!(store.record().unwrap().status, Status::ExistingInstall);
        FirstRunStartup::new(&store).finalize(&mut store, Some(&runtime()));
        assert_eq!(store.sets.len(), 1);

        // A malformed record still migrates.
        for malformed in [
            "garbage".to_string(),
            "{}".into(),
            record_json(Status::Done, |v| v["version"] = json!(3)),
            record_json(Status::Done, |v| v["updatedAt"] = json!("invalid")),
            record_json(Status::Done, |v| v["status"] = json!("unknown")),
        ] {
            let mut store = Store::seeded(&[(key, ""), (FIRST_RUN_KEY, &malformed)]);
            let mut startup = FirstRunStartup::new(&store);
            assert_eq!(startup.snapshot, Snapshot::ExistingInstall);
            assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(false));
            assert_eq!(store.record().unwrap().status, Status::ExistingInstall);
            assert_eq!(store.sets.len(), 1);
            FirstRunStartup::new(&store).finalize(&mut store, Some(&runtime()));
            assert_eq!(store.sets.len(), 1);
        }
    }
}

#[test]
fn suppression_writes_nothing() {
    let in_progress = record(Status::InProgress).to_json();
    let seeds: [&[(&str, &str)]; 3] = [
        &[],
        &[(WHATS_NEW_LAST_SEEN_KEY, "1.0.0")],
        &[(FIRST_RUN_KEY, &in_progress)],
    ];
    for seed in seeds {
        let mut store = Store::seeded(seed);
        let mut startup = FirstRunStartup::new(&store);
        assert_eq!(
            startup.finalize(&mut store, Some(&suppressed())),
            Some(false)
        );
        assert_eq!(startup.finalize(&mut store, Some(&runtime())), Some(false));
        startup.enter_step(&mut store, Step::Look, SetupMode::FirstRun);
        startup.set_goal(&mut store, Goal::Record, SetupMode::FirstRun);
        startup.complete(&mut store, Completion::Done, SetupMode::FirstRun);
        assert!(store.sets.is_empty());
    }
}

#[test]
fn setup_resumes_at_its_step_with_its_goal() {
    for step in Step::ALL {
        let mut store = Store::default();
        let mut startup = FirstRunStartup::new(&store);
        startup.finalize(&mut store, Some(&runtime()));
        startup.set_goal(&mut store, Goal::Both, SetupMode::FirstRun);
        startup.enter_step(&mut store, step, SetupMode::FirstRun);
        assert_eq!((startup.step(), startup.goal()), (step, Some(Goal::Both)));
        let mut resumed = FirstRunStartup::new(&store);
        assert_eq!(resumed.snapshot, Snapshot::Resume);
        assert_eq!((resumed.step(), resumed.goal()), (step, Some(Goal::Both)));
        assert_eq!(resumed.finalize(&mut store, Some(&runtime())), Some(true));
        let saved = store.record().unwrap();
        assert_eq!(
            (saved.status, saved.step, saved.goal),
            (Status::InProgress, step, Some(Goal::Both))
        );
    }
}

#[test]
fn a_new_goal_keeps_the_step_even_after_going_back() {
    let mut store = Store::default();
    let mut startup = FirstRunStartup::new(&store);
    startup.finalize(&mut store, Some(&runtime()));
    startup.enter_step(&mut store, Step::Look, SetupMode::FirstRun);
    startup.set_goal(&mut store, Goal::Stream, SetupMode::FirstRun);
    let saved = store.record().unwrap();
    assert_eq!((saved.step, saved.goal), (Step::Look, Some(Goal::Stream)));
    startup.enter_step(&mut store, Step::Goal, SetupMode::FirstRun);
    startup.set_goal(&mut store, Goal::Record, SetupMode::FirstRun);
    startup.complete(&mut store, Completion::Done, SetupMode::FirstRun);
    let saved = store.record().unwrap();
    assert_eq!(
        (saved.status, saved.step, saved.goal),
        (Status::Done, Step::Goal, Some(Goal::Record))
    );
}

#[test]
fn a_replay_leaves_the_record_and_the_markers_byte_identical() {
    for status in STATUSES {
        let raw = record_json(status, |v| {
            v["step"] = json!("sound");
            v["goal"] = json!("stream");
        });
        let mut store = Store::seeded(&[
            (FIRST_RUN_KEY, &raw),
            (ONBOARDING_KEY, "legacy-marker"),
            (WHATS_NEW_LAST_SEEN_KEY, "1.0.0"),
        ]);
        let mut startup = FirstRunStartup::new(&store);
        startup.finalize(&mut store, Some(&runtime()));
        startup.enter_step(&mut store, Step::Look, REPLAY);
        startup.set_goal(&mut store, Goal::Record, REPLAY);
        startup.complete(&mut store, Completion::Skipped, REPLAY);
        assert!(store.sets.is_empty());
        assert_eq!(store.get(FIRST_RUN_KEY), Some(raw));
        assert_eq!(
            (startup.step(), startup.goal()),
            (Step::Sound, Some(Goal::Stream))
        );
    }
}

#[test]
fn nothing_is_written_before_the_decision_or_after_completion() {
    let mut store = Store::default();
    let mut startup = FirstRunStartup::new(&store);
    startup.enter_step(&mut store, Step::Look, SetupMode::FirstRun);
    startup.set_goal(&mut store, Goal::Record, SetupMode::FirstRun);
    startup.complete(&mut store, Completion::Done, SetupMode::FirstRun);
    assert!(store.sets.is_empty());
    startup.finalize(&mut store, Some(&suppressed()));
    startup.enter_step(&mut store, Step::Sound, SetupMode::FirstRun);
    assert!(store.sets.is_empty());
    let mut active = FirstRunStartup::new(&store);
    active.finalize(&mut store, Some(&runtime()));
    active.complete(&mut store, Completion::Done, SetupMode::FirstRun);
    store.sets.clear();
    active.enter_step(&mut store, Step::Goal, SetupMode::FirstRun);
    active.set_goal(&mut store, Goal::Stream, SetupMode::FirstRun);
    active.complete(&mut store, Completion::Skipped, SetupMode::FirstRun);
    assert!(store.sets.is_empty());
}

#[test]
fn linux_and_a_corrupt_record() {
    let mut store = Store::default();
    let linux = Runtime {
        platform: "linux".into(),
        first_run_suppressed: false,
    };
    assert_eq!(
        FirstRunStartup::new(&store).finalize(&mut store, Some(&linux)),
        Some(false)
    );
    assert!(store.sets.is_empty());
    let mut store = Store::seeded(&[(FIRST_RUN_KEY, "garbage")]);
    assert_eq!(
        FirstRunStartup::new(&store).finalize(&mut store, Some(&runtime())),
        Some(true)
    );
    assert_eq!(store.record().unwrap().status, Status::InProgress);
}

#[test]
fn the_shell_shows_setup_a_placeholder_or_the_workspace() {
    use Snapshot::*;
    assert_eq!(shell_surface(Fresh, None, false), ShellSurface::Placeholder);
    assert_eq!(
        shell_surface(Resume, None, false),
        ShellSurface::Placeholder
    );
    assert_eq!(
        shell_surface(Finished, None, false),
        ShellSurface::Workspace
    );
    assert_eq!(
        shell_surface(ExistingInstall, None, false),
        ShellSurface::Workspace
    );
    for snapshot in [Fresh, Resume, Finished, ExistingInstall] {
        for decided in [None, Some(true), Some(false)] {
            assert_eq!(shell_surface(snapshot, decided, true), ShellSurface::Setup);
        }
        assert_eq!(
            shell_surface(snapshot, Some(false), false),
            ShellSurface::Workspace
        );
        assert_eq!(
            shell_surface(snapshot, Some(true), false),
            ShellSurface::Workspace
        );
    }
}

fn status(state: RecordingState, replay_only: bool) -> RecordingStatus {
    let mut value = json!({ "state": state });
    if replay_only {
        value["replayOnly"] = json!(true);
    }
    serde_json::from_value(value).unwrap()
}

#[test]
fn setup_again_waits_for_a_session_but_not_for_the_clips_ring() {
    use RecordingState::*;
    for state in [Starting, Recording, Streaming, Stopping] {
        assert!(replay_locked(&status(state.clone(), false)), "{state:?}");
        assert!(!replay_locked(&status(state.clone(), true)), "{state:?}");
        assert!(look_writes_held(&state));
    }
    for state in [Idle, Failed] {
        assert!(!replay_locked(&status(state.clone(), false)));
        assert!(!look_writes_held(&state));
    }
    assert_eq!(
        REPLAY_LOCKED_REASON,
        "Finish your recording or livestream first."
    );
    assert_eq!(
        background_library_sync(true, "a", "a"),
        BackgroundSync::Skip
    );
    assert_eq!(
        background_library_sync(true, "a", "b"),
        BackgroundSync::Hold
    );
    assert_eq!(
        background_library_sync(false, "a", "b"),
        BackgroundSync::Apply
    );
}

/// The keys, the marker and the lines are still Electron's.
#[test]
fn the_keys_and_lines_are_the_renderers() {
    let first_run = include_str!("../../../../apps/desktop/src/renderer/src/lib/first-run.ts");
    let capture = include_str!("../../../../apps/desktop/src/renderer/src/lib/capture.ts");
    let whats_new = include_str!("../../../../apps/desktop/src/renderer/src/lib/whats-new.ts");
    assert!(capture.contains(&format!("firstRun: '{FIRST_RUN_KEY}'")));
    assert!(capture.contains(&format!("onboarding: '{ONBOARDING_KEY}'")));
    assert!(capture.contains(&format!(
        "ONBOARDING_DISMISSED_VALUE = '{ONBOARDING_DISMISSED_VALUE}'"
    )));
    assert!(whats_new.contains(&format!(
        "WHATS_NEW_STORAGE_KEY = '{WHATS_NEW_LAST_SEEN_KEY}'"
    )));
    for line in [REPLAY_LOCKED_REASON, super::REPLAY, REPLAY_WITH_PERMISSIONS] {
        assert!(first_run.contains(&format!("'{line}'")), "{line}");
    }
    assert!(first_run.contains(
        "export const FIRST_RUN_STEPS = ['permissions', 'goal', 'look', 'sound', 'destinations']"
    ));
}
