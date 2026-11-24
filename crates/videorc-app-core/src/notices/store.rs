//! The notification store (plan 250, Electron's `lib/notifications/store.ts`):
//! one entry per subject, updated in place, whichever system reported it.
//!
//! Pure, as Electron's is: no window and no toast in here. The app hands it
//! the clock on every call and tells it whether a session is live, whether
//! "Quiet while recording or live" is on, whether the streamer has pressed
//! anything, and whether a list is on screen. What Electron's store does
//! through its pop-up door and callbacks is queued as [`Effect`]s the app
//! drains ([`Store::take_effects`]): show a toast, swap a toast for its
//! recovery, dismiss one, tell a screen reader, the bell's new count, and a
//! Clear the reporter asked to hear about. A button is data: the app runs
//! [`Store::run_action`]'s answer.

use super::kinds::{self, Kind};
use super::policy::{
    self, Change, LastPop, MAX_ENTRIES, PopUpQuestion, Report, came_back_words, entries_to_drop,
    join_sentences, merge_reports, notification_count, repeat_words, session_ended_words,
    sort_entries, span_words,
};
use super::types::{Action, Count, Entry, Input, Life, ProgressState, Resolution, State, Tone};

/// What the store asks the app to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Pop the entry up as a toast for `duration_ms`, with its first button.
    /// The toast's type is the entry's tone, which colours the icon only.
    Show {
        entry: Entry,
        duration_ms: u64,
        action: Option<Action>,
    },
    /// The problem cleared: a toast still showing gives way to the recovery.
    Recovered { entry: Entry },
    /// Close the toast on this key, if one is showing.
    Dismiss { key: String },
    /// A new entry, or one that got worse: what a screen reader is told.
    Announce { entry: Entry },
    /// The bell's number or tone changed.
    Count(Count),
    /// The streamer cleared the entry (hid an open problem, or removed a
    /// finished one): the reporter may want to know ("I know").
    Cleared { key: String },
}

#[derive(Debug, Clone)]
struct Held {
    entry: Entry,
    /// A condition's reports, by who sent them, in the order they came.
    reports: Vec<Report>,
    actions: Vec<Action>,
    /// What the reporter said, before "3 times." or "Came back once.".
    detail: Option<String>,
    comebacks: u32,
    /// Cleared while open ("I know"): kept out of the list until the problem
    /// gets worse than this, or ends and starts again.
    hidden: Option<Tone>,
    last_pop: Option<LastPop>,
    /// Resolved because its session ended, not because it recovered: the
    /// same subject in the next session is a new problem, never a flap.
    ended_with_session: bool,
}

/// The notification store.
pub struct Store {
    started_at: u64,
    launch_quiet_ms: u64,
    live: bool,
    pressed: bool,
    lists_open: Vec<String>,
    held: Vec<Held>,
    cached: Vec<Entry>,
    counted: Count,
    effects: Vec<Effect>,
    guard: Option<fn(&str) -> String>,
}

impl Store {
    /// A store whose run starts `now`. `launch_quiet_ms` is
    /// [`policy::LAUNCH_QUIET_MS`] in the app, 0 for tests about the other
    /// rules. Nothing is pressed yet.
    pub fn new(now: u64, launch_quiet_ms: u64) -> Self {
        Self {
            started_at: now,
            launch_quiet_ms,
            live: false,
            pressed: false,
            lists_open: Vec::new(),
            held: Vec::new(),
            cached: Vec::new(),
            counted: Count::default(),
            effects: Vec::new(),
            guard: None,
        }
    }

    /// Every title and detail passes through it (the raw-text guard: a
    /// provider's raw error never reaches the list as HTML or a JSON blob).
    pub fn set_guard(&mut self, guard: fn(&str) -> String) {
        self.guard = Some(guard);
    }

    /// A recording or a livestream runs.
    pub fn set_live(&mut self, live: bool) {
        self.live = live;
    }

    /// The streamer pressed something in this run (a click, a key, a
    /// global shortcut, a remote's intent).
    pub fn set_pressed(&mut self) {
        self.pressed = true;
    }

    /// The list is on screen in a window (`who`): nothing pops up while it
    /// is open anywhere. The main window and the Stream Manager each say
    /// their own.
    pub fn set_list_open(&mut self, open: bool, who: &str) {
        self.lists_open.retain(|each| each != who);
        if open {
            self.lists_open.push(who.to_owned());
        }
    }

    /// The effects queued since the last call, in order.
    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    /// The list, sorted: "Now" first, then newest first.
    pub fn snapshot(&self) -> &[Entry] {
        &self.cached
    }

    /// The bell.
    pub fn count(&self) -> Count {
        self.counted
    }

    /// Whether the subject is in the list (not hidden).
    pub fn has(&self, key: &str) -> bool {
        self.find(key).is_some_and(|item| item.hidden.is_none())
    }

    fn find(&self, key: &str) -> Option<&Held> {
        self.held.iter().find(|item| item.entry.key == key)
    }

    fn index(&self, key: &str) -> Option<usize> {
        self.held.iter().position(|item| item.entry.key == key)
    }

    fn guard_words(&self, words: Option<String>) -> Option<String> {
        match (self.guard, words) {
            (Some(guard), Some(words)) => Some(guard(&words)),
            (_, words) => words,
        }
    }

    /// `publish`: a report on a subject.
    pub fn publish(&mut self, mut input: Input, now: u64) {
        if !input.own_words {
            if let Some(guard) = self.guard {
                input.title = guard(&input.title);
            }
            input.detail = self.guard_words(input.detail.take());
        }
        let Some(kind) = kinds::find(&input.kind) else {
            return;
        };
        if kind.life == Life::Condition {
            self.publish_condition(input, kind, now);
        } else {
            self.publish_once(input, kind, now);
        }
    }

    fn visible(&self) -> Vec<Entry> {
        self.held
            .iter()
            .filter(|item| item.hidden.is_none())
            .map(|item| item.entry.clone())
            .collect()
    }

    fn commit(&mut self, now: u64) {
        // A cleared problem that ended is remembered for the flap window only.
        self.held.retain(|item| {
            !(item.hidden.is_some()
                && item.entry.state == State::Resolved
                && now.saturating_sub(item.entry.resolved_at.unwrap_or(now))
                    >= policy::FLAP_WINDOW_MS)
        });
        let drop = entries_to_drop(&self.visible(), MAX_ENTRIES);
        self.held.retain(|item| !drop.contains(&item.entry.key));
        let mut cached = self.visible();
        sort_entries(&mut cached);
        self.cached = cached;
        let next = notification_count(&self.cached);
        if next != self.counted {
            self.counted = next;
            self.effects.push(Effect::Count(next));
        }
    }

    fn view(actions: &[Action]) -> Vec<Action> {
        actions.iter().take(2).cloned().collect()
    }

    fn pop_up(&mut self, index: usize, kind: &Kind, change: Change, fine_for_ms: u64, now: u64) {
        if self.held[index].hidden.is_some() {
            return;
        }
        // Only a first appearance and a change for the worse speak: the
        // clock in an open entry's detail moves every second.
        if !matches!(change, Change::Updated | Change::Flapped) {
            self.effects.push(Effect::Announce {
                entry: self.held[index].entry.clone(),
            });
        }
        let item = &self.held[index];
        let question = PopUpQuestion {
            change,
            tone: item.entry.tone,
            answers_a_press: kind.answers_a_press,
            failed_session: kind.tone == Tone::Urgent || kind.fails_a_session,
            launching: now.saturating_sub(self.started_at) < self.launch_quiet_ms,
            pressed: self.pressed,
            pop_up_ms: kind.pop_up_ms,
            has_detail: item
                .entry
                .detail
                .as_deref()
                .is_some_and(|detail| !detail.is_empty()),
            live: self.live,
            list_open: !self.lists_open.is_empty(),
            now,
            last_pop: item.last_pop,
            fine_for_ms: Some(fine_for_ms),
        };
        let Some(duration_ms) = policy::pop_up_decision(&question) else {
            return;
        };
        let item = &mut self.held[index];
        item.last_pop = Some(LastPop {
            at: now,
            tone: item.entry.tone,
        });
        let effect = Effect::Show {
            entry: item.entry.clone(),
            duration_ms,
            action: item.actions.first().cloned(),
        };
        self.effects.push(effect);
    }

    fn publish_condition(&mut self, input: Input, kind: &Kind, now: u64) {
        let source = if input.source.is_empty() {
            "self".to_owned()
        } else {
            input.source.clone()
        };
        let report = Report {
            source: source.clone(),
            tone: kinds::kind_tone(kind, input.tone),
            title: input.title.clone(),
            detail: input.detail.clone(),
            actions: input.actions.clone(),
            lead: input.lead,
            at: now,
        };
        let existing = self.index(&input.key);
        let fresh = match existing {
            None => true,
            Some(index) => {
                let item = &self.held[index];
                item.entry.life != Life::Condition || item.ended_with_session
            }
        };
        let mut change;
        let mut fine_for_ms = 0;
        let index = if fresh {
            // A subject whose last session ended starts clean: it may pop up
            // again.
            let last_pop = existing.and_then(|index| {
                let item = &self.held[index];
                if item.ended_with_session {
                    None
                } else {
                    item.last_pop
                }
            });
            let item = Held {
                entry: Entry {
                    key: input.key.clone(),
                    kind: input.kind.clone(),
                    tone: report.tone,
                    peak_tone: report.tone,
                    life: Life::Condition,
                    state: State::Open,
                    title: report.title.clone(),
                    detail: None,
                    opened_at: now,
                    updated_at: now,
                    resolved_at: None,
                    occurrences: 1,
                    read: false,
                    session_id: None,
                    actions: Vec::new(),
                },
                reports: Vec::new(),
                actions: Vec::new(),
                detail: None,
                comebacks: 0,
                hidden: None,
                last_pop,
                ended_with_session: false,
            };
            change = Change::Opened;
            match existing {
                Some(index) => {
                    self.held[index] = item;
                    index
                }
                None => {
                    self.held.push(item);
                    self.held.len() - 1
                }
            }
        } else {
            let index = existing.unwrap_or_default();
            let item = &mut self.held[index];
            if item.entry.state == State::Open {
                change = Change::Updated;
            } else {
                fine_for_ms = now.saturating_sub(item.entry.resolved_at.unwrap_or(now));
                if fine_for_ms < policy::FLAP_WINDOW_MS {
                    change = Change::Flapped;
                    item.comebacks += 1;
                    item.entry.state = State::Open;
                    item.entry.resolved_at = None;
                } else {
                    change = Change::Returned;
                    item.comebacks = 0;
                    item.hidden = None;
                    item.entry.state = State::Open;
                    item.entry.resolved_at = None;
                    item.entry.opened_at = now;
                    item.entry.read = false;
                    item.entry.peak_tone = report.tone;
                }
            }
            index
        };
        let item = &mut self.held[index];
        let before = (item.entry.state == State::Open && change != Change::Opened)
            .then_some(item.entry.tone);
        match item.reports.iter_mut().find(|each| each.source == source) {
            Some(slot) => *slot = report,
            None => item.reports.push(report),
        }
        let Some(merged) = merge_reports(&item.reports) else {
            return;
        };
        if matches!(change, Change::Flapped | Change::Updated) {
            // Worse than it was (or than what was cleared): it is news again.
            let was = item.hidden.or(if change == Change::Updated {
                before
            } else {
                Some(item.entry.peak_tone)
            });
            if was.is_some_and(|was| merged.tone.rank() > was.rank()) {
                change = Change::Escalated;
                item.hidden = None;
                item.entry.read = false;
            }
        }
        item.actions = merged.actions.clone();
        item.detail = merged.detail.clone();
        let comebacks = came_back_words(item.comebacks);
        item.entry.kind = input.kind;
        item.entry.tone = merged.tone;
        item.entry.peak_tone = item.entry.peak_tone.worse(merged.tone);
        item.entry.title = merged.title;
        item.entry.detail = join_sentences(&[comebacks.as_deref(), merged.detail.as_deref()]);
        item.entry.updated_at = now;
        if input.session_id.is_some() {
            item.entry.session_id = input.session_id;
        }
        item.entry.actions = Self::view(&merged.actions);
        self.pop_up(index, kind, change, fine_for_ms, now);
        self.commit(now);
    }

    fn publish_once(&mut self, input: Input, kind: &Kind, now: u64) {
        let progress = kind.life == Life::Progress;
        let state = if progress {
            match input.progress.unwrap_or(ProgressState::Running) {
                ProgressState::Running => State::Running,
                ProgressState::Done => State::Done,
                ProgressState::Failed => State::Failed,
            }
        } else {
            State::Happened
        };
        let tone = if progress {
            match state {
                State::Failed => Tone::Warning,
                State::Done => Tone::Done,
                _ => Tone::News,
            }
        } else {
            kinds::kind_tone(kind, input.tone)
        };
        let existing = self.index(&input.key);
        let previous = existing.map(|index| self.held[index].clone());
        let again = previous
            .as_ref()
            .filter(|item| item.entry.life == kind.life);
        // One happening two systems report (a full disk, then the failed
        // take) is not a repeat.
        let same = again.is_some() && input.once;
        let repeated = again.is_some() && !progress && !same;
        let occurrences = match again {
            Some(again) if repeated => again.entry.occurrences + 1,
            Some(again) => again.entry.occurrences,
            None => 1,
        };
        let repeat = repeat_words(occurrences);
        let read = match again {
            // The same news with new words (an export's progress line) is
            // not new.
            Some(again) if same || (again.entry.state == state && progress) => again.entry.read,
            _ => false,
        };
        let item = Held {
            entry: Entry {
                key: input.key.clone(),
                kind: input.kind.clone(),
                tone,
                peak_tone: tone,
                life: kind.life,
                state,
                title: input.title.clone(),
                detail: join_sentences(&[repeat.as_deref(), input.detail.as_deref()]),
                opened_at: again.map_or(now, |again| again.entry.opened_at),
                updated_at: now,
                resolved_at: None,
                occurrences,
                read,
                session_id: input.session_id.clone(),
                actions: Self::view(&input.actions),
            },
            reports: Vec::new(),
            actions: input.actions.clone(),
            detail: input.detail.clone(),
            comebacks: 0,
            hidden: None,
            last_pop: previous.as_ref().and_then(|item| item.last_pop),
            ended_with_session: false,
        };
        let settled = same || (progress && again.is_some_and(|again| again.entry.state == state));
        let index = match existing {
            Some(index) => {
                self.held[index] = item;
                index
            }
            None => {
                self.held.push(item);
                self.held.len() - 1
            }
        };
        if state != State::Running {
            let change = if settled {
                Change::Updated
            } else if repeated {
                Change::Repeated
            } else {
                Change::Opened
            };
            self.pop_up(index, kind, change, 0, now);
        }
        self.commit(now);
    }

    fn remerge(&mut self, index: usize, now: u64) {
        let item = &mut self.held[index];
        let Some(merged) = merge_reports(&item.reports) else {
            return;
        };
        item.actions = merged.actions.clone();
        item.detail = merged.detail.clone();
        let comebacks = came_back_words(item.comebacks);
        item.entry.tone = merged.tone;
        item.entry.title = merged.title;
        item.entry.detail = join_sentences(&[comebacks.as_deref(), merged.detail.as_deref()]);
        item.entry.updated_at = now;
        item.entry.actions = Self::view(&merged.actions);
    }

    /// A condition's settling: recovered (a green tick, and the recovery in
    /// the place of a toast still showing) or ended with its session (no
    /// tick, the toast closes).
    fn settle(
        &mut self,
        index: usize,
        title: Option<String>,
        detail: Option<String>,
        recovered: bool,
        now: u64,
    ) {
        let item = &mut self.held[index];
        item.reports.clear();
        item.actions.clear();
        item.entry.state = State::Resolved;
        item.entry.tone = if recovered { Tone::Done } else { Tone::News };
        item.entry.resolved_at = Some(now);
        item.entry.updated_at = now;
        item.entry.actions.clear();
        if let Some(title) = title {
            item.entry.title = title;
        }
        item.entry.detail = detail;
        if item.hidden.is_some() {
            return;
        }
        let effect = if recovered {
            Effect::Recovered {
                entry: item.entry.clone(),
            }
        } else {
            Effect::Dismiss {
                key: item.entry.key.clone(),
            }
        };
        self.effects.push(effect);
    }

    fn open_condition(&self, key: &str, source: Option<&str>) -> Option<usize> {
        let index = self.index(key)?;
        let item = &self.held[index];
        if item.entry.life != Life::Condition || item.entry.state != State::Open {
            return None;
        }
        if let Some(source) = source
            && !item.reports.iter().any(|report| report.source == source)
        {
            return None;
        }
        Some(index)
    }

    fn drop_reports(&mut self, index: usize, source: Option<&str>) {
        let reports = &mut self.held[index].reports;
        match source {
            None => reports.clear(),
            Some(source) => reports.retain(|report| report.source != source),
        }
    }

    /// `resolve`: a condition cleared. The entry stays, resolved, when no
    /// report is left: "It was choppy for 38 s." or "It lasted 38 s.".
    pub fn resolve(&mut self, key: &str, resolution: Resolution, now: u64) {
        let title = self.guard_words(resolution.title);
        let detail = self.guard_words(resolution.detail);
        let was = self.guard_words(resolution.was);
        let Some(index) = self.open_condition(key, resolution.source.as_deref()) else {
            return;
        };
        self.drop_reports(index, resolution.source.as_deref());
        if self.held[index].reports.is_empty() {
            let lasted = span_words(now.saturating_sub(self.held[index].entry.opened_at));
            let detail = detail.unwrap_or_else(|| match was {
                Some(was) => format!("{was} for {lasted}."),
                None => format!("It lasted {lasted}."),
            });
            self.settle(index, title, Some(detail), true, now);
        } else {
            self.remerge(index, now);
        }
        self.commit(now);
    }

    /// `withdraw`: a report was taken back (the alert was snoozed): no
    /// resolved entry is left.
    pub fn withdraw(&mut self, key: &str, source: Option<&str>, now: u64) {
        let Some(index) = self.open_condition(key, source) else {
            return;
        };
        self.drop_reports(index, source);
        if self.held[index].reports.is_empty() {
            self.held.remove(index);
            self.effects.push(Effect::Dismiss {
                key: key.to_owned(),
            });
        } else {
            self.remerge(index, now);
        }
        self.commit(now);
    }

    /// `clear`: the streamer's Clear. An open problem is hidden; anything
    /// else is removed.
    pub fn clear(&mut self, key: &str, now: u64) {
        let Some(index) = self.index(key) else {
            return;
        };
        if self.held[index].hidden.is_some() {
            return;
        }
        self.effects.push(Effect::Dismiss {
            key: key.to_owned(),
        });
        if self.held[index].entry.state == State::Open {
            self.held[index].hidden = Some(self.held[index].entry.tone);
        } else {
            self.held.remove(index);
        }
        self.effects.push(Effect::Cleared {
            key: key.to_owned(),
        });
        self.commit(now);
    }

    /// `clearAll`: removes everything that is no longer true. Open problems
    /// and work in progress stay.
    pub fn clear_all(&mut self, now: u64) {
        let removed: Vec<String> = self
            .held
            .iter()
            .filter(|item| item.hidden.is_none() && !policy::is_now(item.entry.state))
            .map(|item| item.entry.key.clone())
            .collect();
        self.held.retain(|item| !removed.contains(&item.entry.key));
        for key in removed {
            // Its toast may still be on screen, with a button that now does
            // nothing.
            self.effects.push(Effect::Dismiss { key: key.clone() });
            self.effects.push(Effect::Cleared { key });
        }
        self.commit(now);
    }

    /// `markRead`.
    pub fn mark_read(&mut self, key: &str, now: u64) {
        let Some(index) = self.index(key) else {
            return;
        };
        if self.held[index].entry.read {
            return;
        }
        self.held[index].entry.read = true;
        self.commit(now);
    }

    /// `markAllRead`.
    pub fn mark_all_read(&mut self, now: u64) {
        let mut changed = false;
        for item in &mut self.held {
            if item.hidden.is_some() || item.entry.read {
                continue;
            }
            item.entry.read = true;
            changed = true;
        }
        if changed {
            self.commit(now);
        }
    }

    /// `sessionEnded`: the conditions that belong to the session resolve
    /// ("Ended with the livestream."). `session` is its id; none, every
    /// session.
    pub fn session_ended(&mut self, livestream: bool, session: Option<&str>, now: u64) {
        let mut changed = false;
        let mut index = 0;
        while index < self.held.len() {
            let item = &self.held[index];
            let belongs = item.entry.life == Life::Condition
                && item
                    .entry
                    .session_id
                    .as_deref()
                    .is_some_and(|id| session.is_none_or(|session| session == id));
            if !belongs {
                index += 1;
                continue;
            }
            if item.entry.state != State::Open {
                // It cleared before the session ended. Its row stays, but the
                // same subject in the next session is a new problem.
                self.held[index].ended_with_session = true;
                index += 1;
                continue;
            }
            changed = true;
            if item.hidden.is_some() {
                self.held.remove(index);
                continue;
            }
            let detail = join_sentences(&[
                item.detail.as_deref(),
                Some(session_ended_words(livestream)),
            ]);
            self.settle(index, None, detail, false, now);
            self.held[index].ended_with_session = true;
            index += 1;
        }
        if changed {
            self.commit(now);
        }
    }

    /// `runAction`: the button the streamer pressed, for the app to run; the
    /// entry is read. None for a key or a button the entry no longer has.
    pub fn run_action(&mut self, key: &str, action_id: &str, now: u64) -> Option<Action> {
        let action = self
            .find(key)?
            .actions
            .iter()
            .find(|action| action.id == action_id)
            .cloned()?;
        self.mark_read(key, now);
        Some(action)
    }

    /// Tests only, as Electron's `reset`: forgets every entry, and the
    /// launch is over.
    pub fn reset(&mut self, now: u64) {
        self.launch_quiet_ms = 0;
        let keys: Vec<String> = self
            .held
            .iter()
            .map(|item| item.entry.key.clone())
            .collect();
        for key in keys {
            self.effects.push(Effect::Dismiss { key });
        }
        self.held.clear();
        self.lists_open.clear();
        self.commit(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::policy::URGENT_POP_UP_MS;
    use crate::notices::types::ActionKind;

    fn input(key: &str, kind: &str, title: &str) -> Input {
        Input {
            key: key.into(),
            kind: kind.into(),
            title: title.into(),
            ..Input::default()
        }
    }

    fn shown(effects: &[Effect]) -> Vec<(String, u64)> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Show {
                    entry, duration_ms, ..
                } => Some((entry.key.clone(), *duration_ms)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn idle_news_waits_behind_the_bell_and_counts() {
        let mut store = Store::new(0, 0);
        store.publish(
            input("microphone", "microphone", "Microphone silent"),
            1_000,
        );
        let effects = store.take_effects();
        assert!(shown(&effects).is_empty(), "idle is the bell only");
        assert_eq!(
            store.count(),
            Count {
                unread: 1,
                tone: Some(Tone::Warning),
                urgent: 0
            }
        );
        assert!(store.has("microphone"));
    }

    #[test]
    fn a_live_urgent_problem_pops_up_once_and_its_recovery_takes_its_place() {
        let mut store = Store::new(0, 0);
        store.set_live(true);
        store.publish(
            input("stream-output", "stream-output", "Your stream stopped"),
            1_000,
        );
        assert_eq!(
            shown(&store.take_effects()),
            [("stream-output".to_string(), URGENT_POP_UP_MS)]
        );
        // New words on the open problem: no second toast.
        store.publish(
            input("stream-output", "stream-output", "Your stream stopped (2)"),
            2_000,
        );
        assert!(shown(&store.take_effects()).is_empty());
        store.resolve(
            "stream-output",
            Resolution {
                was: Some("It was down".into()),
                ..Resolution::default()
            },
            39_000,
        );
        let effects = store.take_effects();
        let recovered = effects.iter().find_map(|effect| match effect {
            Effect::Recovered { entry } => Some(entry.clone()),
            _ => None,
        });
        let recovered = recovered.expect("the recovery");
        assert_eq!(recovered.state, State::Resolved);
        assert_eq!(recovered.detail.as_deref(), Some("It was down for 38 s."));
        // A cleared urgent problem still counts until it is seen.
        assert_eq!(store.count().unread, 1);
    }

    #[test]
    fn nothing_found_on_its_own_pops_up_in_the_first_minute() {
        let mut store = Store::new(0, policy::LAUNCH_QUIET_MS);
        store.set_live(true);
        store.publish(
            input(
                "host-overloaded",
                "host-overloaded",
                "Your computer is overloaded",
            ),
            5_000,
        );
        assert!(shown(&store.take_effects()).is_empty());
        // The answer to a press pops up once the streamer has pressed something.
        store.set_pressed();
        store.publish(input("clip:1", "clip", "Clip saved"), 6_000);
        assert_eq!(
            shown(&store.take_effects()),
            [("clip:1".to_string(), 4_000)]
        );
        // After the minute, a live warning still waits behind the bell (the
        // owner's rule: a toast answers a press or says an urgent problem);
        // an urgent one pops up.
        store.publish(
            input("disk-space", "disk-space", "Your disk is nearly full"),
            61_000,
        );
        assert!(shown(&store.take_effects()).is_empty());
        store.publish(
            input("stream-output", "stream-output", "Your stream stopped"),
            62_000,
        );
        assert_eq!(
            shown(&store.take_effects()),
            [("stream-output".to_string(), URGENT_POP_UP_MS)]
        );
    }

    #[test]
    fn a_flap_is_the_same_episode_and_says_it_came_back() {
        let mut store = Store::new(0, 0);
        store.publish(
            input("microphone", "microphone", "Microphone silent"),
            1_000,
        );
        store.resolve("microphone", Resolution::default(), 2_000);
        store.publish(
            input("microphone", "microphone", "Microphone silent"),
            3_000,
        );
        let entry = store
            .snapshot()
            .iter()
            .find(|entry| entry.key == "microphone")
            .unwrap()
            .clone();
        assert_eq!(entry.state, State::Open);
        assert_eq!(entry.detail.as_deref(), Some("Came back once."));
    }

    #[test]
    fn events_repeat_in_place_and_progress_settles() {
        let mut store = Store::new(0, 0);
        store.publish(
            input("backend-error:x", "backend-error", "That didn't work"),
            1_000,
        );
        store.publish(
            input("backend-error:x", "backend-error", "That didn't work"),
            2_000,
        );
        let entry = store.snapshot()[0].clone();
        assert_eq!(entry.occurrences, 2);
        assert_eq!(entry.detail.as_deref(), Some("Twice."));
        store.publish(
            Input {
                progress: Some(ProgressState::Running),
                ..input("mp4:s1", "mp4", "Exporting MP4")
            },
            3_000,
        );
        assert_eq!(store.count().unread, 1, "work in progress does not count");
        store.publish(
            Input {
                progress: Some(ProgressState::Done),
                ..input("mp4:s1", "mp4", "MP4 ready")
            },
            4_000,
        );
        let mp4 = store
            .snapshot()
            .iter()
            .find(|entry| entry.key == "mp4:s1")
            .unwrap()
            .clone();
        assert_eq!((mp4.state, mp4.tone), (State::Done, Tone::Done));
    }

    #[test]
    fn two_reports_make_one_entry_and_it_resolves_when_both_cleared() {
        let mut store = Store::new(0, 0);
        let fix = Action {
            id: "fix".into(),
            label: "Fix".into(),
            kind: ActionKind::Fix,
        };
        store.publish(
            Input {
                source: "health".into(),
                ..input("microphone", "microphone", "Microphone silent")
            },
            1_000,
        );
        store.publish(
            Input {
                source: "watchdog".into(),
                lead: true,
                tone: Some(Tone::Urgent),
                actions: vec![fix],
                ..input("microphone", "microphone", "Your microphone went quiet")
            },
            2_000,
        );
        let entry = store.snapshot()[0].clone();
        assert_eq!(
            (entry.tone, entry.title.as_str()),
            (Tone::Urgent, "Your microphone went quiet")
        );
        assert_eq!(
            store
                .run_action("microphone", "fix", 3_000)
                .map(|action| action.label),
            Some("Fix".into())
        );
        assert!(store.snapshot()[0].read);
        store.resolve(
            "microphone",
            Resolution {
                source: Some("watchdog".into()),
                ..Resolution::default()
            },
            4_000,
        );
        assert_eq!(
            store.snapshot()[0].state,
            State::Open,
            "health still reports it"
        );
        store.resolve(
            "microphone",
            Resolution {
                source: Some("health".into()),
                ..Resolution::default()
            },
            5_000,
        );
        assert_eq!(store.snapshot()[0].state, State::Resolved);
    }

    #[test]
    fn clear_hides_an_open_problem_until_it_gets_worse_and_session_end_settles_it() {
        let mut store = Store::new(0, 0);
        store.publish(
            Input {
                session_id: Some("s1".into()),
                ..input(
                    "stream-target:tw",
                    "stream-target",
                    "Twitch is reconnecting",
                )
            },
            1_000,
        );
        store.clear("stream-target:tw", 2_000);
        assert!(!store.has("stream-target:tw"));
        store.publish(
            Input {
                session_id: Some("s1".into()),
                tone: Some(Tone::Urgent),
                ..input("stream-target:tw", "stream-target", "Twitch stopped")
            },
            3_000,
        );
        assert!(
            store.has("stream-target:tw"),
            "worse than what was cleared: news again"
        );
        store.session_ended(true, Some("s1"), 4_000);
        let entry = store.snapshot()[0].clone();
        assert_eq!((entry.state, entry.tone), (State::Resolved, Tone::News));
        assert!(
            entry
                .detail
                .as_deref()
                .unwrap_or_default()
                .ends_with("Ended with the livestream.")
        );
        store.clear_all(5_000);
        assert!(store.snapshot().is_empty());
    }

    #[test]
    fn nothing_pops_up_while_a_list_is_open() {
        let mut store = Store::new(0, 0);
        store.set_live(true);
        store.set_list_open(true, "stream-manager");
        store.publish(
            input("stream-output", "stream-output", "Your stream stopped"),
            1_000,
        );
        assert!(shown(&store.take_effects()).is_empty());
        store.set_list_open(false, "stream-manager");
        store.publish(
            input("recording-failed", "recording-failed", "Recording failed"),
            2_000,
        );
        assert_eq!(shown(&store.take_effects()).len(), 1);
    }
}
