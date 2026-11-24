//! What the notification center keeps (plan 250, Electron's
//! `lib/notifications/types.ts`). An entry is plain data, so the Stream
//! Manager can receive the list as it is. A button is data too (an id, its
//! words and whether it fixes in place or opens a page): the app runs it by
//! the entry's key and the button's id.

use serde::{Deserialize, Serialize};

/// `NotificationTone`. Urgent: viewers or the recording are affected right
/// now. The tone colours a toast's icon only, never its card (the owner's
/// rule): the pop-up door turns it into the toast's type, nothing more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    Urgent,
    Warning,
    News,
    Done,
}

impl Tone {
    /// `TONE_RANK`: done, news, warning, urgent.
    pub fn rank(self) -> u8 {
        match self {
            Tone::Done => 0,
            Tone::News => 1,
            Tone::Warning => 2,
            Tone::Urgent => 3,
        }
    }

    /// `worseTone`.
    pub fn worse(self, other: Tone) -> Tone {
        if other.rank() > self.rank() {
            other
        } else {
            self
        }
    }
}

/// `NotificationLife`: a condition is true for a while and resolves on its
/// own; an event happened once; progress runs, then is done or failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Life {
    Condition,
    Event,
    Progress,
}

/// `NotificationState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Open,
    Resolved,
    Happened,
    Running,
    Done,
    Failed,
}

/// A fix runs in place and keeps the list open; a door opens a page and
/// closes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Fix,
    Door,
}

/// `NotificationActionView`: a button, as data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Action {
    pub id: String,
    pub label: String,
    pub kind: ActionKind,
}

/// `NotificationEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The subject, not the message: `microphone`, `stream-target:tw-1`.
    pub key: String,
    /// A kind id from [`super::kinds`].
    pub kind: String,
    pub tone: Tone,
    /// The worst tone this episode reached: a cleared urgent problem still
    /// counts.
    pub peak_tone: Tone,
    pub life: Life,
    pub state: State,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub opened_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
    /// How many times an event repeated ("3 times.").
    pub occurrences: u32,
    pub read: bool,
    /// Set on a condition that ends with its session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// At most two.
    pub actions: Vec<Action>,
}

/// `NotificationInput`: one report on a subject.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Input {
    pub key: String,
    pub kind: String,
    /// Who reports it. Two systems can report one subject (the watchdog and
    /// a `health` event on `microphone`); the entry resolves when both
    /// cleared. Empty is the default source.
    pub source: String,
    /// Only where the kind allows more than one tone.
    pub tone: Option<Tone>,
    /// Progress only.
    pub progress: Option<ProgressState>,
    pub title: String,
    pub detail: Option<String>,
    pub actions: Vec<Action>,
    pub session_id: Option<String>,
    /// The watchdog's report: its words and fixes lead the entry.
    pub lead: bool,
    /// An event two systems report (the full disk, then the take that failed
    /// on it): a second publish on the key updates the words and is not a
    /// repeat.
    pub once: bool,
    /// The words carry the streamer's own text (a device's name). They skip
    /// the raw-provider-text guard. Only for news, which never pops up.
    pub own_words: bool,
}

/// A progress report's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressState {
    Running,
    Done,
    Failed,
}

/// `NotificationResolution`: how a condition cleared.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Resolution {
    /// Which report cleared. None: every report on the subject.
    pub source: Option<String>,
    /// The recovery's words: "Your stream is smooth again".
    pub title: Option<String>,
    /// A whole sentence, in place of the one built from `was`.
    pub detail: Option<String>,
    /// "It was choppy": the store adds how long, "It was choppy for 38 s."
    pub was: Option<String>,
}

/// `NotificationCount`: what the bell shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Count {
    pub unread: u32,
    /// The worst problem still open, read or not: `Urgent` or `Warning`.
    pub tone: Option<Tone>,
    /// Open urgent problems, for the bell's name.
    pub urgent: u32,
}
