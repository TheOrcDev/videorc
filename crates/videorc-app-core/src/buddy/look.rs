//! Buddy's look (plan 220 S3.10e, `hooks/use-buddy-look.ts`): the four
//! poses the web draws (`cohost.avatar.create`), their progress and the
//! draft they make, Redo, keep and discard, and Cancel while a create runs.
//! The backend keeps the draft on disk, so a fresh window picks it up. This
//! is the state and the rules; the app sends the calls and feeds the events.
//! Every create and redo spends the streamer's images: no test or smoke
//! sends them to the real web.

use std::collections::BTreeMap;

use serde::Deserialize;

/// The four poses, in order.
pub const STATES: [&str; 4] = ["idle", "talk", "laugh", "think"];

/// The backend's events for a look being made.
pub const PROGRESS_EVENT: &str = "cohost.avatar.progress";
pub const DRAFT_EVENT: &str = "cohost.avatar.draft";

/// One picture that failed: the web's code and the tile's line.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

/// `cohost.avatar.draft`: the pictures it holds and why any other is
/// missing.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub request_id: String,
    #[serde(default)]
    pub images: BTreeMap<String, String>,
    #[serde(default)]
    pub failed: BTreeMap<String, ErrorDetail>,
    #[serde(default)]
    pub library_avatar_id: Option<String>,
}

/// The job running now.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub request_id: String,
    /// `create` or `redo`.
    pub kind: String,
    #[serde(default)]
    pub state: Option<String>,
}

/// `cohost.avatar.draft.get` and `cohost.avatar.discard`'s answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct DraftStatus {
    #[serde(default)]
    pub draft: Option<Draft>,
    #[serde(default)]
    pub running: Option<Running>,
}

/// `cohost.avatar.progress`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub request_id: String,
    pub state: String,
    /// `working`, `done` or `failed`.
    pub phase: String,
    #[serde(default)]
    pub error: Option<ErrorDetail>,
}

/// A call this window waits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pending {
    Create,
    Redo,
    Keep,
    Discard,
    Cancel,
}

/// The look as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Look {
    pub loading: bool,
    pub draft: Option<Draft>,
    pub running: Option<Running>,
    /// When this window first saw the job (ms on the app's clock).
    pub started_at: Option<u64>,
    /// Each state's step in the running job.
    pub phases: BTreeMap<String, String>,
    /// Why the last attempt at a state failed.
    pub state_errors: BTreeMap<String, String>,
    pub pending: Option<Pending>,
    /// The last refusal (its code and inline line), or a create that made
    /// nothing.
    pub problem: Option<(String, String)>,
    /// Bumped when a draft picture was made again under the same path.
    pub revision: u32,
}

impl Default for Look {
    fn default() -> Self {
        Self {
            loading: true,
            draft: None,
            running: None,
            started_at: None,
            phases: BTreeMap::new(),
            state_errors: BTreeMap::new(),
            pending: None,
            problem: None,
            revision: 0,
        }
    }
}

/// What the app does after a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    None,
    /// A job ended: today's images changed (`ai.capabilities.get`).
    RefreshCapabilities,
}

impl Look {
    /// A create is being made (or waits for its accept).
    pub fn creating(&self) -> bool {
        self.pending == Some(Pending::Create)
            || self
                .running
                .as_ref()
                .is_some_and(|run| run.kind == "create")
    }

    /// Anything in flight.
    pub fn busy(&self) -> bool {
        self.pending.is_some() || self.running.is_some()
    }

    /// `cohost.avatar.draft.get`'s answer.
    pub fn status(&mut self, status: DraftStatus, now: u64) {
        let same_run = matches!(
            (&self.running, &status.running),
            (Some(had), Some(has)) if had.request_id == has.request_id
        );
        self.loading = false;
        self.draft = status.draft;
        match status.running {
            Some(running) => {
                if !same_run {
                    self.started_at = Some(self.started_at.unwrap_or(now));
                    self.phases = BTreeMap::new();
                    if running.kind == "create" {
                        self.phases.insert("idle".into(), "working".into());
                    } else if let Some(state) = &running.state {
                        self.phases.insert(state.clone(), "working".into());
                    }
                }
                self.running = Some(running);
            }
            None => {
                self.running = None;
                self.phases = BTreeMap::new();
                self.started_at = None;
            }
        }
    }

    pub fn status_failed(&mut self, code: String, line: String) {
        self.loading = false;
        self.problem = Some((code, line));
    }

    fn ended(&mut self) -> Effect {
        self.running = None;
        self.pending = None;
        self.phases = BTreeMap::new();
        self.started_at = None;
        Effect::RefreshCapabilities
    }

    /// `cohost.avatar.progress`.
    pub fn progress(&mut self, event: Progress, now: u64) -> Effect {
        if self.running.is_none() && self.pending == Some(Pending::Create) && event.state == "idle"
        {
            self.running = Some(Running {
                request_id: event.request_id.clone(),
                kind: "create".into(),
                state: None,
            });
            self.started_at = Some(self.started_at.unwrap_or(now));
        }
        let Some(running) = self.running.clone() else {
            return Effect::None;
        };
        if running.request_id != event.request_id {
            return Effect::None;
        }
        if event.phase == "failed" {
            if let Some(error) = &event.error {
                self.state_errors
                    .insert(event.state.clone(), error.message.clone());
            }
        } else {
            self.state_errors.remove(&event.state);
        }
        self.phases.insert(event.state.clone(), event.phase.clone());
        if running.kind == "create" && event.state == "idle" && event.phase == "failed" {
            self.problem = Some(match event.error {
                Some(error) => (error.code, error.message),
                None => ("failed".into(), "The look couldn't be made.".into()),
            });
            return self.ended();
        }
        if running.kind == "redo"
            && event
                .error
                .as_ref()
                .is_some_and(|error| error.code == "cohost-avatar-cancelled")
        {
            return self.ended();
        }
        Effect::None
    }

    /// `cohost.avatar.draft`.
    pub fn draft_event(&mut self, draft: Draft) -> Effect {
        let ours = self
            .running
            .as_ref()
            .is_some_and(|run| run.request_id == draft.request_id)
            || self
                .draft
                .as_ref()
                .is_some_and(|had| had.request_id == draft.request_id);
        if !ours {
            return Effect::None;
        }
        let redone = self.running.as_ref().is_some_and(|run| run.kind == "redo");
        if !redone {
            self.state_errors = draft
                .failed
                .iter()
                .map(|(state, failure)| (state.clone(), failure.message.clone()))
                .collect();
        }
        if redone {
            self.revision += 1;
        }
        self.draft = Some(draft);
        self.problem = None;
        self.ended()
    }

    /// Create pressed: false when something runs already.
    pub fn begin_create(&mut self, now: u64) -> bool {
        if self.busy() {
            return false;
        }
        self.pending = Some(Pending::Create);
        self.problem = None;
        self.state_errors = BTreeMap::new();
        self.phases = BTreeMap::from([("idle".into(), "working".into())]);
        self.started_at = Some(now);
        true
    }

    /// The create's accept: its id, unless the run already ended.
    pub fn create_accepted(&mut self, request_id: String) {
        if self.pending == Some(Pending::Create) {
            self.pending = None;
            self.running = Some(Running {
                request_id,
                kind: "create".into(),
                state: None,
            });
        }
    }

    pub fn create_refused(&mut self, code: String, line: String) {
        self.pending = None;
        self.phases = BTreeMap::new();
        self.started_at = None;
        self.problem = Some((code, line));
    }

    /// Redo pressed on `state`: the draft's id, or None when it can't run.
    pub fn begin_redo(&mut self, state: &str, now: u64) -> Option<String> {
        let draft = self.draft.as_ref()?;
        if self.busy() || state == "idle" {
            return None;
        }
        let request_id = draft.request_id.clone();
        self.state_errors.remove(state);
        self.pending = Some(Pending::Redo);
        self.problem = None;
        self.running = Some(Running {
            request_id: request_id.clone(),
            kind: "redo".into(),
            state: Some(state.into()),
        });
        self.started_at = Some(now);
        self.phases = BTreeMap::from([(state.to_string(), "working".into())]);
        Some(request_id)
    }

    pub fn redo_accepted(&mut self) {
        if self.pending == Some(Pending::Redo) {
            self.pending = None;
        }
    }

    pub fn redo_refused(&mut self, code: String, line: String) {
        self.pending = None;
        self.running = None;
        self.phases = BTreeMap::new();
        self.started_at = None;
        self.problem = Some((code, line));
    }

    /// Cancel pressed (only a create): the running id.
    pub fn begin_cancel(&mut self) -> Option<String> {
        let running = self.running.as_ref()?;
        if running.kind != "create" || self.pending.is_some() {
            return None;
        }
        let id = running.request_id.clone();
        self.pending = Some(Pending::Cancel);
        self.problem = None;
        Some(id)
    }

    pub fn cancelled(&mut self, status: DraftStatus) -> Effect {
        self.pending = None;
        self.running = None;
        self.phases = BTreeMap::new();
        self.state_errors = BTreeMap::new();
        self.started_at = None;
        self.draft = status.draft;
        Effect::RefreshCapabilities
    }

    /// Keep or discard pressed: the draft's id.
    pub fn begin_keep_or_discard(&mut self, keep: bool) -> Option<String> {
        let draft = self.draft.as_ref()?;
        if self.busy() {
            return None;
        }
        let id = draft.request_id.clone();
        self.pending = Some(if keep {
            Pending::Keep
        } else {
            Pending::Discard
        });
        self.problem = None;
        Some(id)
    }

    pub fn kept(&mut self) {
        self.pending = None;
        self.draft = None;
        self.state_errors = BTreeMap::new();
        self.revision = 0;
    }

    pub fn discarded(&mut self, status: DraftStatus) {
        self.pending = None;
        self.draft = status.draft;
        self.state_errors = BTreeMap::new();
        self.revision = 0;
    }

    /// A keep, discard or cancel refused.
    pub fn refused(&mut self, code: String, line: String) {
        self.pending = None;
        self.problem = Some((code, line));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(id: &str, state: &str, phase: &str) -> Progress {
        Progress {
            request_id: id.into(),
            state: state.into(),
            phase: phase.into(),
            error: None,
        }
    }

    fn draft(id: &str) -> Draft {
        Draft {
            request_id: id.into(),
            images: BTreeMap::from([("idle".into(), "p/drafts/r/idle.png".into())]),
            failed: BTreeMap::new(),
            library_avatar_id: Some("lib".into()),
        }
    }

    #[test]
    fn a_create_runs_then_lands_as_a_draft() {
        let mut look = Look::default();
        assert!(look.begin_create(10));
        assert!(look.creating());
        assert!(!look.begin_create(11));
        // A progress before the accept adopts the run.
        look.progress(progress("r", "idle", "working"), 12);
        assert_eq!(look.running.as_ref().unwrap().request_id, "r");
        look.create_accepted("r".into());
        look.progress(progress("r", "idle", "done"), 13);
        assert_eq!(look.phases["idle"], "done");
        assert_eq!(look.draft_event(draft("r")), Effect::RefreshCapabilities);
        assert!(!look.busy());
        assert_eq!(look.draft.as_ref().unwrap().request_id, "r");
        // Someone else's draft is not ours.
        assert_eq!(look.draft_event(draft("other")), Effect::None);
    }

    #[test]
    fn a_failed_idle_ends_the_create_with_its_line() {
        let mut look = Look::default();
        look.begin_create(0);
        look.create_accepted("r".into());
        let mut failed = progress("r", "idle", "failed");
        failed.error = Some(ErrorDetail {
            code: "quota-exhausted".into(),
            message: "No images left".into(),
        });
        assert_eq!(look.progress(failed, 1), Effect::RefreshCapabilities);
        assert_eq!(look.problem.as_ref().unwrap().0, "quota-exhausted");
        assert!(!look.busy());
    }

    #[test]
    fn redo_keep_and_discard_follow_the_draft() {
        let mut look = Look::default();
        look.status(
            DraftStatus {
                draft: Some(draft("r")),
                running: None,
            },
            0,
        );
        assert!(!look.loading);
        assert_eq!(look.begin_redo("idle", 1), None);
        assert_eq!(look.begin_redo("talk", 1).as_deref(), Some("r"));
        look.redo_accepted();
        look.draft_event(draft("r"));
        assert_eq!(look.revision, 1);
        assert_eq!(look.begin_keep_or_discard(true).as_deref(), Some("r"));
        look.kept();
        assert!(look.draft.is_none());
        assert_eq!(look.begin_keep_or_discard(false), None);
    }

    #[test]
    fn cancel_stops_only_a_create() {
        let mut look = Look::default();
        look.begin_create(0);
        assert_eq!(look.begin_cancel(), None, "nothing runs before the accept");
        look.create_accepted("r".into());
        assert_eq!(look.begin_cancel().as_deref(), Some("r"));
        look.cancelled(DraftStatus::default());
        assert!(!look.busy());
    }
}
