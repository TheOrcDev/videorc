//! First run (plan 260 S1.6f, from Electron's `lib/first-run.ts`, plans 203
//! and 207): whether setup shows, its steps, and the record that remembers
//! where it got to.
//!
//! - **The record** ([`FirstRunRecord`]) is `videorc.firstRun` in the
//!   renderer's storage: version 2, a status, the step and the goal. A
//!   version 1 record reads as version 2 at Permissions with no goal;
//!   anything else that does not read is absent.
//! - **The decision** ([`FirstRunStartup`]) is taken once: the storage is
//!   read before anything renders (What's New may write its marker on the
//!   first launch), and the decision waits for the runtime facts (the
//!   platform and the smokes' suppression). Nothing is written before then,
//!   nothing at all when suppressed, and a replay from Settings writes
//!   nothing.
//! - **The steps** ([`steps_for`]): Permissions (not on Linux), Goal, Look,
//!   Sound, Destinations (not for a goal of recordings only).
//! - **The shell** ([`shell_surface`]) shows setup while it is open, a plain
//!   placeholder while the decision is pending for an install that may show
//!   it, and the workspace for everyone else.
//!
//! Sound check's rules are [`sound`]. The Look step's scene writes
//! (`first-run-look.ts`) need the Studio's scenes and layouts (L7) and come
//! with them.

pub mod backdrop;
pub mod sound;

use serde_json::{Value, json};
use videorc_protocol::{RecordingState, RecordingStatus};

use crate::nav::PageId;

/// `STORAGE_KEYS.firstRun`.
pub const FIRST_RUN_KEY: &str = "videorc.firstRun";
/// `STORAGE_KEYS.onboarding`: the retired onboarding's marker. Any value
/// marks an existing install.
pub const ONBOARDING_KEY: &str = "videorc.onboardingComplete";
/// `ONBOARDING_DISMISSED_VALUE`: written on completion, so a downgrade keeps
/// the retired onboarding dismissed too.
pub const ONBOARDING_DISMISSED_VALUE: &str = "permissions-v1";
/// `WHATS_NEW_STORAGE_KEY`: What's New's last-seen version, read here only
/// as a migration marker.
pub const WHATS_NEW_LAST_SEEN_KEY: &str = "videorc.whatsNewLastSeenVersion";

/// `FIRST_RUN_REPLAY_LOCKED_REASON`: why "Run setup again…" is off.
pub const REPLAY_LOCKED_REASON: &str = "Finish your recording or livestream first.";
const REPLAY_WITH_PERMISSIONS: &str =
    "Go through the welcome steps again, starting with permissions.";
const REPLAY: &str = "Go through the welcome steps again.";

/// The renderer's `localStorage`, as first run reads and writes it.
pub trait FirstRunStore {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&mut self, key: &str, value: &str);
}

impl FirstRunStore for std::collections::BTreeMap<String, String> {
    fn get(&self, key: &str) -> Option<String> {
        std::collections::BTreeMap::get(self, key).cloned()
    }

    fn set(&mut self, key: &str, value: &str) {
        self.insert(key.to_string(), value.to_string());
    }
}

/// `FIRST_RUN_STEPS`, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Step {
    Permissions,
    Goal,
    Look,
    Sound,
    Destinations,
}

impl Step {
    pub const ALL: [Step; 5] = [
        Step::Permissions,
        Step::Goal,
        Step::Look,
        Step::Sound,
        Step::Destinations,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Step::Permissions => "permissions",
            Step::Goal => "goal",
            Step::Look => "look",
            Step::Sound => "sound",
            Step::Destinations => "destinations",
        }
    }

    pub fn parse(id: &str) -> Option<Step> {
        Step::ALL.into_iter().find(|step| step.id() == id)
    }
}

/// `FirstRunGoal`: what the streamer came to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Goal {
    Record,
    Stream,
    Both,
}

impl Goal {
    pub fn id(self) -> &'static str {
        match self {
            Goal::Record => "record",
            Goal::Stream => "stream",
            Goal::Both => "both",
        }
    }

    pub fn parse(id: &str) -> Option<Goal> {
        [Goal::Record, Goal::Stream, Goal::Both]
            .into_iter()
            .find(|goal| goal.id() == id)
    }
}

/// The record's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    InProgress,
    Done,
    Skipped,
    ExistingInstall,
}

impl Status {
    pub fn id(self) -> &'static str {
        match self {
            Status::InProgress => "in-progress",
            Status::Done => "done",
            Status::Skipped => "skipped",
            Status::ExistingInstall => "existing-install",
        }
    }

    pub fn parse(id: &str) -> Option<Status> {
        [
            Status::InProgress,
            Status::Done,
            Status::Skipped,
            Status::ExistingInstall,
        ]
        .into_iter()
        .find(|status| status.id() == id)
    }
}

/// `FirstRunCompletion`: how setup ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    Done,
    Skipped,
}

impl From<Completion> for Status {
    fn from(completion: Completion) -> Status {
        match completion {
            Completion::Done => Status::Done,
            Completion::Skipped => Status::Skipped,
        }
    }
}

/// `FirstRunRecord` (always version 2 once read).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstRunRecord {
    pub status: Status,
    pub step: Step,
    pub goal: Option<Goal>,
    pub updated_at: String,
}

impl FirstRunRecord {
    /// The stored JSON, field for field as the renderer writes it.
    pub fn to_json(&self) -> String {
        json!({
            "version": 2,
            "status": self.status.id(),
            "step": self.step.id(),
            "goal": self.goal.map(Goal::id),
            "updatedAt": self.updated_at,
        })
        .to_string()
    }
}

/// `parseFirstRunRecord`: a record that does not read is absent. A version
/// 1 record has no step or goal: it reads at Permissions with none.
pub fn parse_record(value: Option<&str>) -> Option<FirstRunRecord> {
    let record: Value = serde_json::from_str(value?).ok()?;
    let record = record.as_object()?;
    let version = record.get("version").and_then(Value::as_f64)?;
    if version != 1.0 && version != 2.0 {
        return None;
    }
    let status = Status::parse(record.get("status")?.as_str()?)?;
    let updated_at = record.get("updatedAt")?.as_str()?;
    // `Number.isFinite(Date.parse(updatedAt))`: the renderer writes
    // `toISOString()`, which RFC 3339 reads.
    chrono::DateTime::parse_from_rfc3339(updated_at).ok()?;
    let v2 = version == 2.0;
    let text = |key| record.get(key).and_then(Value::as_str).filter(|_| v2);
    Some(FirstRunRecord {
        status,
        step: text("step")
            .and_then(Step::parse)
            .unwrap_or(Step::Permissions),
        goal: text("goal").and_then(Goal::parse),
        updated_at: updated_at.to_string(),
    })
}

/// The step and goal a record keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub step: Step,
    pub goal: Option<Goal>,
}

const INITIAL_PROGRESS: Progress = Progress {
    step: Step::Permissions,
    goal: None,
};

/// `toISOString()`: milliseconds, UTC, `Z`.
fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// `writeFirstRunRecord`.
pub fn write_record(
    store: &mut impl FirstRunStore,
    status: Status,
    progress: Progress,
    updated_at: Option<&str>,
) -> FirstRunRecord {
    let record = FirstRunRecord {
        status,
        step: progress.step,
        goal: progress.goal,
        updated_at: updated_at.map_or_else(now_iso, str::to_string),
    };
    store.set(FIRST_RUN_KEY, &record.to_json());
    record
}

/// `completeFirstRun`: the record keeps its progress, and the retired
/// onboarding is dismissed too.
pub fn complete(
    store: &mut impl FirstRunStore,
    completion: Completion,
    progress: Option<Progress>,
) {
    let progress = progress.unwrap_or_else(|| {
        parse_record(store.get(FIRST_RUN_KEY).as_deref()).map_or(INITIAL_PROGRESS, |record| {
            Progress {
                step: record.step,
                goal: record.goal,
            }
        })
    });
    write_record(store, completion.into(), progress, None);
    store.set(ONBOARDING_KEY, ONBOARDING_DISMISSED_VALUE);
}

/// `FirstRunSnapshot`: what the storage said before anything rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Snapshot {
    Fresh,
    Resume,
    Finished,
    ExistingInstall,
}

/// `firstRunSnapshot`: a record decides; without one, either migration
/// marker means an existing install.
pub fn snapshot(
    record: Option<&FirstRunRecord>,
    legacy_onboarding: Option<&str>,
    whats_new_last_seen: Option<&str>,
) -> Snapshot {
    match record {
        Some(record) if record.status == Status::InProgress => Snapshot::Resume,
        Some(_) => Snapshot::Finished,
        None if legacy_onboarding.is_some() || whats_new_last_seen.is_some() => {
            Snapshot::ExistingInstall
        }
        None => Snapshot::Fresh,
    }
}

/// `firstRunSnapshotDecision`: show setup (true) for a fresh or resuming
/// install on macOS or Windows, unless the smokes suppress it.
pub fn decision(snapshot: Snapshot, suppressed: bool, platform: Option<&str>) -> bool {
    if suppressed || platform.is_none_or(|platform| platform == "linux") {
        return false;
    }
    matches!(snapshot, Snapshot::Fresh | Snapshot::Resume)
}

/// `FirstRunSetupMode`: the first launch writes the record and opens the
/// Studio; a replay from Settings or ⌘K writes nothing and returns to its
/// page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupMode {
    FirstRun,
    Replay { return_to: PageId },
}

/// `FirstRunLeave`: how setup ends, and a page other than the usual one to
/// land on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Leave {
    pub completion: Completion,
    pub open_page: Option<PageId>,
}

/// `firstRunStepsFor`: Permissions is not on Linux; Destinations is not for
/// recordings only.
pub fn steps_for(goal: Option<Goal>, platform: Option<&str>) -> Vec<Step> {
    Step::ALL
        .into_iter()
        .filter(|step| *step != Step::Permissions || platform != Some("linux"))
        .filter(|step| *step != Step::Destinations || goal != Some(Goal::Record))
        .collect()
}

/// `nextFirstRunStep`: the next applicable step after `step` (which may be
/// one the platform or goal leaves out, as a saved step can be).
pub fn next_step(step: Step, goal: Option<Goal>, platform: Option<&str>) -> Option<Step> {
    steps_for(goal, platform)
        .into_iter()
        .find(|candidate| *candidate > step)
}

/// `previousFirstRunStep`.
pub fn previous_step(step: Step, goal: Option<Goal>, platform: Option<&str>) -> Option<Step> {
    steps_for(goal, platform)
        .into_iter()
        .rev()
        .find(|candidate| *candidate < step)
}

/// `firstRunStepPosition`: "Step 3 of 5" (1-based). A saved step the
/// platform leaves out counts as the first applicable one after it.
pub fn step_position(step: Step, goal: Option<Goal>, platform: Option<&str>) -> (usize, usize) {
    let steps = steps_for(goal, platform);
    let before = steps.iter().filter(|candidate| **candidate < step).count();
    ((before + 1).min(steps.len()), steps.len())
}

/// `firstRunReplayDescription`: the line under "Run setup again…" names
/// permissions only where setup has that step.
pub fn replay_description(platform: Option<&str>) -> &'static str {
    if steps_for(None, platform).first() == Some(&Step::Permissions) {
        REPLAY_WITH_PERMISSIONS
    } else {
        REPLAY
    }
}

/// A session starts, runs or stops.
fn session_busy(state: &RecordingState) -> bool {
    matches!(
        state,
        RecordingState::Starting
            | RecordingState::Recording
            | RecordingState::Streaming
            | RecordingState::Stopping
    )
}

/// `firstRunReplayLocked`: "Run setup again…" waits while a recording or
/// livestream starts, runs or stops. The Clips ring alone is no session.
pub fn replay_locked(recording: &RecordingStatus) -> bool {
    !recording.replay_only && session_busy(&recording.state)
}

/// `firstRunLookWritesHeld`: a replay while Clips runs holds the look's
/// writes until the workspace shows (the idle reload is refused while any
/// session, the ring included, runs).
pub fn look_writes_held(state: &RecordingState) -> bool {
    session_busy(state)
}

/// `BackgroundLibrarySyncDecision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundSync {
    Skip,
    Hold,
    Apply,
}

/// `backgroundLibrarySyncDecision`: never for a background already applied,
/// and held while setup is open (a layout transaction starts the scene's
/// devices).
pub fn background_library_sync(
    setup_open: bool,
    fingerprint: &str,
    applied: &str,
) -> BackgroundSync {
    if fingerprint == applied {
        BackgroundSync::Skip
    } else if setup_open {
        BackgroundSync::Hold
    } else {
        BackgroundSync::Apply
    }
}

/// `FirstRunShellSurface`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellSurface {
    Placeholder,
    Setup,
    Workspace,
}

/// `firstRunShellSurface`: setup while it is open; before the decision, a
/// solid placeholder for an install that may show it, so neither the Studio
/// nor a preview mounts and vanishes; the workspace at once for everyone
/// else.
pub fn shell_surface(snapshot: Snapshot, decision: Option<bool>, setup_open: bool) -> ShellSurface {
    if setup_open {
        ShellSurface::Setup
    } else if decision.is_none() && matches!(snapshot, Snapshot::Fresh | Snapshot::Resume) {
        ShellSurface::Placeholder
    } else {
        ShellSurface::Workspace
    }
}

/// The runtime facts the decision waits for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runtime {
    pub platform: String,
    pub first_run_suppressed: bool,
}

/// `createFirstRunStartup`: built once, before the window renders. The
/// storage is read now; the decision is taken at [`Self::finalize`].
#[derive(Debug, Clone)]
pub struct FirstRunStartup {
    pub snapshot: Snapshot,
    progress: Progress,
    decision: Option<bool>,
}

impl FirstRunStartup {
    pub fn new(store: &impl FirstRunStore) -> Self {
        let record = parse_record(store.get(FIRST_RUN_KEY).as_deref());
        let snapshot = snapshot(
            record.as_ref(),
            store.get(ONBOARDING_KEY).as_deref(),
            store.get(WHATS_NEW_LAST_SEEN_KEY).as_deref(),
        );
        let progress = record.map_or(INITIAL_PROGRESS, |record| Progress {
            step: record.step,
            goal: record.goal,
        });
        Self {
            snapshot,
            progress,
            decision: None,
        }
    }

    pub fn step(&self) -> Step {
        self.progress.step
    }

    pub fn goal(&self) -> Option<Goal> {
        self.progress.goal
    }

    /// The decision once taken: `Some(true)` shows setup.
    pub fn decided(&self) -> Option<bool> {
        self.decision
    }

    /// Takes the decision once, when the runtime facts arrive (`None`
    /// before then), and writes what it calls for: an existing install's
    /// record, or a fresh one's in-progress record. Later calls return the
    /// first answer and write nothing.
    pub fn finalize(
        &mut self,
        store: &mut impl FirstRunStore,
        runtime: Option<&Runtime>,
    ) -> Option<bool> {
        if self.decision.is_some() {
            return self.decision;
        }
        let runtime = runtime?;
        let show = decision(
            self.snapshot,
            runtime.first_run_suppressed,
            Some(&runtime.platform),
        );
        self.decision = Some(show);
        if !runtime.first_run_suppressed {
            match self.snapshot {
                Snapshot::ExistingInstall => {
                    write_record(store, Status::ExistingInstall, INITIAL_PROGRESS, None);
                }
                Snapshot::Fresh if show => {
                    write_record(store, Status::InProgress, self.progress, None);
                }
                _ => {}
            }
        }
        self.decision
    }

    fn can_write(&self, mode: SetupMode) -> bool {
        self.decision == Some(true) && mode == SetupMode::FirstRun
    }

    /// `enterStep`: the first launch remembers where it got to.
    pub fn enter_step(&mut self, store: &mut impl FirstRunStore, step: Step, mode: SetupMode) {
        if !self.can_write(mode) {
            return;
        }
        self.progress.step = step;
        write_record(store, Status::InProgress, self.progress, None);
    }

    /// `setGoal`: a new goal keeps the current step.
    pub fn set_goal(&mut self, store: &mut impl FirstRunStore, goal: Goal, mode: SetupMode) {
        if !self.can_write(mode) {
            return;
        }
        self.progress.goal = Some(goal);
        write_record(store, Status::InProgress, self.progress, None);
    }

    /// `complete`: the record is finished and the decision stays hidden
    /// across shell remounts.
    pub fn complete(
        &mut self,
        store: &mut impl FirstRunStore,
        completion: Completion,
        mode: SetupMode,
    ) {
        if !self.can_write(mode) {
            return;
        }
        complete(store, completion, Some(self.progress));
        self.decision = Some(false);
    }
}

#[cfg(test)]
mod tests;
