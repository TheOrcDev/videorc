//! The notification center's rules (plan 250, Electron's
//! `lib/notifications/policy.ts`), all pure: what pops up, what the number
//! counts, how two reports on one subject merge, and how long the list keeps
//! things. The store applies them.
//!
//! The owner's rules, 2026-11-22, live in [`pop_up_decision`]: anything
//! Videorc notices on its own is a bell entry, never a toast, while nothing
//! is recording or live (idle is the bell only, at any time); in the first
//! minute of a run nothing it found on its own pops up; a toast answers a
//! press, or says an urgent problem in a recording or livestream the
//! streamer started. Plan 250 D11's six (Sidekick's three nudges, and the
//! "Remove this message?" question with its two outcomes) are not
//! notifications: they stay their own toasts, outside this policy.

use super::kinds;
use super::types::{Action, Count, Entry, State, Tone};

/// Cleared and back inside this window is the same episode.
pub const FLAP_WINDOW_MS: u64 = 60_000;
/// A subject pops up again only after this long of being fine.
pub const REALERT_AFTER_MS: u64 = 5 * 60_000;
pub const MAX_ENTRIES: usize = 50;
pub const URGENT_POP_UP_MS: u64 = 15_000;
pub const POP_UP_MS: u64 = 8_000;
pub const PRESS_ANSWER_POP_UP_MS: u64 = 4_000;
/// A recovery that replaces a toast still showing.
pub const RECOVERY_POP_UP_MS: u64 = 4_000;
/// The first minute of a run: what Videorc finds on its own waits behind the
/// bell. The owner, 2026-11-22: "the first thing you see is a bunch of
/// toasts".
pub const LAUNCH_QUIET_MS: u64 = 60_000;

/// `NotificationReport`: one source's report on a subject.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub source: String,
    pub tone: Tone,
    pub title: String,
    pub detail: Option<String>,
    pub actions: Vec<Action>,
    /// The watchdog's report: it has the live clock and the one-press fix.
    pub lead: bool,
    pub at: u64,
}

/// `MergedReports`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    pub tone: Tone,
    pub title: String,
    pub detail: Option<String>,
    pub actions: Vec<Action>,
}

/// `mergeReports`: two systems reporting one subject make one entry. The
/// worse tone wins. The leading report gives the words and the first
/// buttons; the others only keep the entry open, and fill a free button
/// slot (two at most, never the same label twice).
pub fn merge_reports(reports: &[Report]) -> Option<Merged> {
    let mut ordered: Vec<&Report> = reports.iter().collect();
    ordered.sort_by(|a, b| {
        b.lead
            .cmp(&a.lead)
            .then(b.tone.rank().cmp(&a.tone.rank()))
            .then(b.at.cmp(&a.at))
    });
    let head = ordered.first()?;
    let mut actions: Vec<Action> = Vec::new();
    for report in &ordered {
        for action in &report.actions {
            if actions.len() >= 2 {
                break;
            }
            if actions.iter().any(|taken| taken.label == action.label) {
                continue;
            }
            actions.push(action.clone());
        }
    }
    Some(Merged {
        tone: ordered
            .iter()
            .fold(Tone::Done, |tone, report| tone.worse(report.tone)),
        title: head.title.clone(),
        detail: head.detail.clone(),
        actions,
    })
}

/// `NotificationChange`: what just happened to the entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// A new entry, or finished work arriving.
    Opened,
    /// An open entry got worse (warning to urgent).
    Escalated,
    /// New words on an open entry.
    Updated,
    /// Cleared and back within 60 s: the same episode.
    Flapped,
    /// Back after longer than that: a new episode.
    Returned,
    /// An event happened again.
    Repeated,
}

/// The last time a subject popped up, and how bad it was then.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LastPop {
    pub at: u64,
    pub tone: Tone,
}

/// `PopUpQuestion`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PopUpQuestion {
    pub change: Change,
    pub tone: Tone,
    pub answers_a_press: bool,
    /// The kind says a recording or livestream the streamer started has
    /// failed; said as the session ends, so no longer "live" when it arrives.
    pub failed_session: bool,
    /// Inside the first minute of this run ([`LAUNCH_QUIET_MS`]).
    pub launching: bool,
    /// The streamer has pressed something in this run: a click, a key, a
    /// shortcut.
    pub pressed: bool,
    pub pop_up_ms: Option<u64>,
    pub has_detail: bool,
    /// A recording or a livestream runs.
    pub live: bool,
    pub list_open: bool,
    pub now: u64,
    pub last_pop: Option<LastPop>,
    /// `Returned`: how long the subject had been fine.
    pub fine_for_ms: Option<u64>,
}

impl PopUpQuestion {
    /// A question with the defaults the tests and the store start from.
    pub fn new(change: Change, tone: Tone, now: u64) -> Self {
        Self {
            change,
            tone,
            answers_a_press: false,
            failed_session: false,
            launching: false,
            pressed: false,
            pop_up_ms: None,
            has_detail: false,
            live: false,
            list_open: false,
            now,
            last_pop: None,
            fine_for_ms: None,
        }
    }
}

/// `popUpDecision`: how long the entry pops up as a toast, or none for the
/// bell only.
pub fn pop_up_decision(question: &PopUpQuestion) -> Option<u64> {
    if question.list_open {
        return None;
    }
    if matches!(question.change, Change::Updated | Change::Flapped) {
        return None;
    }
    // A toast is the answer to a press. In the first minute, only once the
    // streamer has pressed something.
    if question.answers_a_press {
        if question.launching && !question.pressed {
            return None;
        }
        return Some(question.pop_up_ms.unwrap_or(if question.has_detail {
            POP_UP_MS
        } else {
            PRESS_ANSWER_POP_UP_MS
        }));
    }
    // With nothing recording or live, what Videorc notices on its own waits
    // behind the bell, at launch or at any time after.
    if !question.live && !(question.failed_session && question.tone == Tone::Urgent) {
        return None;
    }
    // In the first minute, only an urgent problem in a recording or
    // livestream the streamer started speaks.
    if question.launching && (!question.pressed || question.tone != Tone::Urgent) {
        return None;
    }
    if question.tone == Tone::News {
        return None;
    }
    if let Some(last) = question.last_pop {
        if matches!(question.change, Change::Returned | Change::Repeated)
            && question.tone.rank() <= last.tone.rank()
        {
            let fine_for = if question.change == Change::Returned {
                question.fine_for_ms.unwrap_or(0)
            } else {
                question.now.saturating_sub(last.at)
            };
            if fine_for < REALERT_AFTER_MS {
                return None;
            }
        }
        // A problem that swings between warning and urgent already popped up
        // as urgent: getting that bad again inside the window is not news.
        if question.change == Change::Escalated
            && question.tone.rank() <= last.tone.rank()
            && question.now.saturating_sub(last.at) < REALERT_AFTER_MS
        {
            return None;
        }
    }
    // The owner's rule: a toast answers a press or says an urgent problem.
    // Anything else Videorc found on its own (a finished MP4, a device that
    // came back, a warning) goes to the bell, live or not. ("Quiet while
    // recording or live" is retired: it changed nothing any more.)
    if question.tone == Tone::Urgent {
        return Some(URGENT_POP_UP_MS);
    }
    None
}

/// `isNow`: still true, an open problem or work in progress (the list's
/// "Now" group).
pub fn is_now(state: State) -> bool {
    matches!(state, State::Open | State::Running)
}

/// `countsAsUnread`: the number is what waits for you. News never counts,
/// except an announcement (it never pops up, so the number is how it is
/// seen). A warning that cleared on its own stops counting; an urgent
/// problem that cleared counts until it is seen.
pub fn counts_as_unread(entry: &Entry) -> bool {
    if entry.read {
        return false;
    }
    match entry.state {
        State::Open => matches!(entry.tone, Tone::Urgent | Tone::Warning),
        State::Resolved => entry.peak_tone == Tone::Urgent,
        State::Happened => {
            entry.tone != Tone::News
                || kinds::find(&entry.kind).is_some_and(|kind| kind.announcement)
        }
        State::Running => false,
        State::Done | State::Failed => true,
    }
}

/// `notificationCount`: the bell's number, and the tone of the worst
/// problem still open.
pub fn notification_count(entries: &[Entry]) -> Count {
    let mut count = Count::default();
    let mut warning = false;
    for entry in entries {
        if counts_as_unread(entry) {
            count.unread += 1;
        }
        // A problem that happened once tints the bell until it has been
        // seen; a condition tints it for as long as it is open.
        let still_wrong = entry.state == State::Open
            || (matches!(entry.state, State::Happened | State::Failed) && !entry.read);
        if !still_wrong {
            continue;
        }
        match entry.tone {
            Tone::Urgent => count.urgent += 1,
            Tone::Warning => warning = true,
            _ => {}
        }
    }
    count.tone = if count.urgent > 0 {
        Some(Tone::Urgent)
    } else if warning {
        Some(Tone::Warning)
    } else {
        None
    };
    count
}

/// `sortEntries`: "Now" first (urgent, then warnings, then the rest, then
/// work), then newest first.
pub fn sort_entries(entries: &mut [Entry]) {
    let group = |entry: &Entry| -> u8 {
        match entry.state {
            State::Open => 3 - entry.tone.rank(),
            State::Running => 4,
            _ => 5,
        }
    };
    entries.sort_by(|a, b| {
        group(a)
            .cmp(&group(b))
            .then(b.updated_at.cmp(&a.updated_at))
            .then(a.key.cmp(&b.key))
    });
}

/// `entriesToDrop`: the keys to drop so the list keeps its newest `max`.
/// Open problems and work in progress are never dropped; the oldest of the
/// rest go first.
pub fn entries_to_drop(entries: &[Entry], max: usize) -> Vec<String> {
    let over = entries.len().saturating_sub(max);
    if over == 0 {
        return Vec::new();
    }
    let mut droppable: Vec<&Entry> = entries
        .iter()
        .filter(|entry| !is_now(entry.state))
        .collect();
    droppable.sort_by_key(|entry| entry.updated_at);
    droppable
        .into_iter()
        .take(over)
        .map(|entry| entry.key.clone())
        .collect()
}

/// `spanWords`: "38 s", "2 min", "1 h 5 min": how long a problem lasted.
pub fn span_words(ms: u64) -> String {
    let seconds = ((ms as f64 / 1000.0).round() as u64).max(1);
    if seconds < 60 {
        return format!("{seconds} s");
    }
    let minutes = (seconds as f64 / 60.0).round() as u64;
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest == 0 {
        format!("{hours} h")
    } else {
        format!("{hours} h {rest} min")
    }
}

/// `repeatWords`: a repeat says so in the detail and never adds a row.
pub fn repeat_words(occurrences: u32) -> Option<String> {
    match occurrences {
        0 | 1 => None,
        2 => Some("Twice.".to_owned()),
        n => Some(format!("{n} times.")),
    }
}

/// `cameBackWords`.
pub fn came_back_words(comebacks: u32) -> Option<String> {
    match comebacks {
        0 => None,
        1 => Some("Came back once.".to_owned()),
        n => Some(format!("Came back {n} times.")),
    }
}

/// `joinSentences`: sentences joined with one space, skipping the missing.
pub fn join_sentences(parts: &[Option<&str>]) -> Option<String> {
    let present: Vec<&str> = parts
        .iter()
        .flatten()
        .copied()
        .filter(|part| !part.is_empty())
        .collect();
    (!present.is_empty()).then(|| present.join(" "))
}

/// `sessionEndedWords`.
pub fn session_ended_words(livestream: bool) -> &'static str {
    if livestream {
        "Ended with the livestream."
    } else {
        "Ended with the recording."
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notices::types::{ActionKind, Life};

    fn question(tone: Tone) -> PopUpQuestion {
        PopUpQuestion::new(Change::Opened, tone, 1_000_000)
    }

    fn entry(tone: Tone, state: State) -> Entry {
        Entry {
            key: "k".into(),
            kind: "watchdog".into(),
            tone,
            peak_tone: tone,
            life: Life::Condition,
            state,
            title: "Title".into(),
            detail: None,
            opened_at: 0,
            updated_at: 0,
            resolved_at: None,
            occurrences: 1,
            read: false,
            session_id: None,
            actions: Vec::new(),
        }
    }

    /// Plan 250's table, by tone, idle and live. Idle is the bell only;
    /// live, only an urgent problem pops up (the owner's rule).
    #[test]
    fn what_pops_up_by_tone_idle_and_live() {
        let table = [
            (Tone::Urgent, None, Some(URGENT_POP_UP_MS)),
            (Tone::Warning, None, None),
            (Tone::Done, None, None),
            (Tone::News, None, None),
        ];
        for (tone, idle, live) in table {
            assert_eq!(pop_up_decision(&question(tone)), idle, "{tone:?} idle");
            let q = PopUpQuestion {
                live: true,
                ..question(tone)
            };
            assert_eq!(pop_up_decision(&q), live, "{tone:?} live");
        }
    }

    #[test]
    fn a_failed_session_pops_up_although_it_ended() {
        let failed = PopUpQuestion {
            failed_session: true,
            ..question(Tone::Urgent)
        };
        assert_eq!(pop_up_decision(&failed), Some(URGENT_POP_UP_MS));
        assert_eq!(pop_up_decision(&question(Tone::Urgent)), None);
        let warning = PopUpQuestion {
            failed_session: true,
            ..question(Tone::Warning)
        };
        assert_eq!(pop_up_decision(&warning), None);
        let launching = PopUpQuestion {
            launching: true,
            ..failed
        };
        assert_eq!(pop_up_decision(&launching), None);
        let pressed = PopUpQuestion {
            pressed: true,
            ..launching
        };
        assert_eq!(pop_up_decision(&pressed), Some(URGENT_POP_UP_MS));
    }

    #[test]
    fn the_answer_to_a_press_pops_up_briefly_quiet_or_not() {
        for live in [false, true] {
            let done = PopUpQuestion {
                answers_a_press: true,
                live,
                ..question(Tone::Done)
            };
            assert_eq!(pop_up_decision(&done), Some(PRESS_ANSWER_POP_UP_MS));
            let news = PopUpQuestion {
                has_detail: true,
                ..PopUpQuestion {
                    tone: Tone::News,
                    ..done
                }
            };
            assert_eq!(pop_up_decision(&news), Some(POP_UP_MS));
            let timed = PopUpQuestion {
                pop_up_ms: Some(6_000),
                tone: Tone::Warning,
                ..done
            };
            assert_eq!(pop_up_decision(&timed), Some(6_000));
        }
    }

    #[test]
    fn nothing_pops_up_while_the_list_is_open_or_twice_per_episode() {
        let open = PopUpQuestion {
            list_open: true,
            ..question(Tone::Urgent)
        };
        assert_eq!(pop_up_decision(&open), None);
        for change in [Change::Updated, Change::Flapped] {
            let q = PopUpQuestion {
                change,
                live: true,
                ..question(Tone::Urgent)
            };
            assert_eq!(pop_up_decision(&q), None);
        }
        let worse = PopUpQuestion {
            change: Change::Escalated,
            live: true,
            last_pop: Some(LastPop {
                at: 999_000,
                tone: Tone::Warning,
            }),
            ..question(Tone::Urgent)
        };
        assert_eq!(pop_up_decision(&worse), Some(URGENT_POP_UP_MS));
        let again = |now: u64| {
            pop_up_decision(&PopUpQuestion {
                change: Change::Escalated,
                live: true,
                now,
                last_pop: Some(LastPop {
                    at: 1_000_000,
                    tone: Tone::Urgent,
                }),
                ..question(Tone::Urgent)
            })
        };
        assert_eq!(again(1_000_000 + REALERT_AFTER_MS - 1), None);
        assert_eq!(again(1_000_000 + REALERT_AFTER_MS), Some(URGENT_POP_UP_MS));
    }

    /// The owner, 2026-11-22: no toasts when you open the app.
    #[test]
    fn nothing_videorc_found_on_its_own_pops_up_at_launch() {
        for tone in [Tone::Urgent, Tone::Warning, Tone::Done, Tone::News] {
            let q = PopUpQuestion {
                launching: true,
                ..question(tone)
            };
            assert_eq!(pop_up_decision(&q), None);
            let live = PopUpQuestion { live: true, ..q };
            assert_eq!(pop_up_decision(&live), None);
        }
        let press = PopUpQuestion {
            launching: true,
            answers_a_press: true,
            ..question(Tone::Done)
        };
        assert_eq!(pop_up_decision(&press), None);
        assert_eq!(
            pop_up_decision(&PopUpQuestion {
                pressed: true,
                ..press
            }),
            Some(PRESS_ANSWER_POP_UP_MS)
        );
        let urgent = PopUpQuestion {
            launching: true,
            ..question(Tone::Urgent)
        };
        assert_eq!(
            pop_up_decision(&PopUpQuestion {
                pressed: true,
                ..urgent
            }),
            None
        );
        assert_eq!(
            pop_up_decision(&PopUpQuestion {
                live: true,
                ..urgent
            }),
            None
        );
        assert_eq!(
            pop_up_decision(&PopUpQuestion {
                live: true,
                pressed: true,
                ..urgent
            }),
            Some(URGENT_POP_UP_MS)
        );
        let check = PopUpQuestion {
            launching: true,
            pressed: true,
            ..question(Tone::Warning)
        };
        assert_eq!(pop_up_decision(&check), None);
    }

    #[test]
    fn the_number_counts_what_waits_and_the_bell_keeps_the_open_problems_tone() {
        assert!(counts_as_unread(&entry(Tone::Warning, State::Open)));
        assert!(!counts_as_unread(&entry(Tone::News, State::Open)));
        assert!(!counts_as_unread(&entry(Tone::Warning, State::Resolved)));
        assert!(counts_as_unread(&Entry {
            peak_tone: Tone::Urgent,
            ..entry(Tone::Warning, State::Resolved)
        }));
        assert!(!counts_as_unread(&entry(Tone::News, State::Happened)));
        assert!(counts_as_unread(&Entry {
            kind: "cloud-announce".into(),
            ..entry(Tone::News, State::Happened)
        }));
        assert!(counts_as_unread(&entry(Tone::Done, State::Done)));
        assert!(!counts_as_unread(&entry(Tone::News, State::Running)));
        let read_open = Entry {
            read: true,
            ..entry(Tone::Urgent, State::Open)
        };
        assert_eq!(
            notification_count(&[read_open]),
            Count {
                unread: 0,
                tone: Some(Tone::Urgent),
                urgent: 1
            }
        );
        let cleared = Entry {
            peak_tone: Tone::Warning,
            ..entry(Tone::Warning, State::Resolved)
        };
        assert_eq!(notification_count(&[cleared]).tone, None);
    }

    #[test]
    fn the_worse_tone_wins_and_the_leader_speaks_with_two_buttons_at_most() {
        let button = |label: &str| Action {
            id: label.into(),
            label: label.into(),
            kind: ActionKind::Fix,
        };
        let health = Report {
            source: "health".into(),
            tone: Tone::Urgent,
            title: "Microphone silent".into(),
            detail: None,
            actions: vec![button("Open Sources"), button("Retry")],
            lead: false,
            at: 2,
        };
        let watchdog = Report {
            source: "watchdog".into(),
            tone: Tone::Warning,
            title: "Your microphone went quiet".into(),
            detail: Some("For 12 s.".into()),
            actions: vec![button("Fix"), button("Retry")],
            lead: true,
            at: 1,
        };
        let merged = merge_reports(&[health, watchdog]).unwrap();
        assert_eq!(merged.tone, Tone::Urgent);
        assert_eq!(merged.title, "Your microphone went quiet");
        assert_eq!(
            merged
                .actions
                .iter()
                .map(|action| action.label.as_str())
                .collect::<Vec<_>>(),
            ["Fix", "Retry"]
        );
        assert_eq!(merge_reports(&[]), None);
    }

    #[test]
    fn the_list_orders_now_first_and_keeps_open_problems() {
        let mut list = vec![
            Entry {
                key: "old".into(),
                updated_at: 1,
                ..entry(Tone::Done, State::Done)
            },
            Entry {
                key: "warn".into(),
                updated_at: 2,
                ..entry(Tone::Warning, State::Open)
            },
            Entry {
                key: "urgent".into(),
                updated_at: 1,
                ..entry(Tone::Urgent, State::Open)
            },
            Entry {
                key: "work".into(),
                updated_at: 3,
                ..entry(Tone::News, State::Running)
            },
        ];
        sort_entries(&mut list);
        assert_eq!(
            list.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(),
            ["urgent", "warn", "work", "old"]
        );
        assert_eq!(entries_to_drop(&list, 3), ["old"]);
        assert!(
            entries_to_drop(&list, 2)
                .iter()
                .all(|key| key != "urgent" && key != "warn")
        );
    }

    #[test]
    fn the_words_say_how_long_and_how_often() {
        assert_eq!(span_words(38_000), "38 s");
        assert_eq!(span_words(120_000), "2 min");
        assert_eq!(span_words(3_900_000), "1 h 5 min");
        assert_eq!(span_words(3_600_000), "1 h");
        assert_eq!(repeat_words(1), None);
        assert_eq!(repeat_words(2).as_deref(), Some("Twice."));
        assert_eq!(repeat_words(3).as_deref(), Some("3 times."));
        assert_eq!(came_back_words(1).as_deref(), Some("Came back once."));
        assert_eq!(came_back_words(3).as_deref(), Some("Came back 3 times."));
        assert_eq!(
            join_sentences(&[Some("A."), None, Some("B.")]).as_deref(),
            Some("A. B.")
        );
        assert_eq!(session_ended_words(true), "Ended with the livestream.");
    }

    /// The constants are Electron's.
    #[test]
    fn the_numbers_are_electrons() {
        const POLICY: &str =
            include_str!("../../../../apps/desktop/src/renderer/src/lib/notifications/policy.ts");
        for line in [
            "FLAP_WINDOW_MS = 60_000",
            "REALERT_AFTER_MS = 5 * 60_000",
            "MAX_ENTRIES = 50",
            "URGENT_POP_UP_MS = 15_000",
            "POP_UP_MS = 8_000",
            "PRESS_ANSWER_POP_UP_MS = 4_000",
            "RECOVERY_POP_UP_MS = 4_000",
            "LAUNCH_QUIET_MS = 60_000",
        ] {
            assert!(POLICY.contains(line), "policy.ts no longer says {line}");
        }
    }
}
