//! Destinations → After the stream (plans 237 D7, 241 D7:
//! `streaming/stream-report-email-section.tsx`) as data: "Email me a report
//! after each stream", "Save my streams on videorc.com", "Your streams" and
//! "Send the last one". The choices live on the videorc.com account, so the
//! email's unsubscribe link and this switch are one setting.
//!
//! The backend answers `streamReport.email.get`, `.set`, `.sendLast` and
//! `streamReport.history.set`. `videorc-protocol` has no types for them yet,
//! so they are read leniently here. [`Section`] holds the section's own
//! rules: only the latest answer lands, a failed save puts the confirmed
//! choice back, and a failed first read retries itself a few times (QA F13).

use serde::Deserialize;
use serde_json::Value;

pub const TITLE: &str = "After the stream";
pub const DESCRIPTION: &str = "A minute after a live stream ends, Videorc emails you how many people watched at the peak and on average, and how many chatted, platform by platform. Numbers only: never chat messages or viewer names. Streams of 5 minutes or more.";
/// The Sign in lock while signed out.
pub const SIGNED_OUT_REASON: &str = "Stream reports go to your Videorc account's email.";
pub const LOAD_FAILED: &str = "Couldn't load these settings.";
/// QA F13: a failed first read retries itself after these waits, then stops;
/// Try again starts the cycle over.
pub const LOAD_RETRY_MS: [u64; 3] = [2_000, 5_000, 15_000];
pub const EMAIL_LABEL: &str = "Email me a report after each stream";
pub const HISTORY_LABEL: &str = "Save my streams on videorc.com";
pub const HISTORY_DESCRIPTION: &str = "Keeps each stream's report on videorc.com/live for 90 days (YouTube's numbers for 30). Never chat messages or viewer names.";
pub const YOUR_STREAMS: &str = "Your streams";
pub const YOUR_STREAMS_DESCRIPTION: &str = "Your last stream and your history, on the web.";
pub const OPEN: &str = "Open";
pub const SEND_LAST: &str = "Send the last one";
pub const SEND: &str = "Send";
pub const SENDING: &str = "Sending…";
pub const TRY_AGAIN: &str = "Try again";
/// `toastUserError`'s objects when a save fails.
pub const EMAIL_SAVE_OBJECT: &str = "the stream report setting";
pub const HISTORY_SAVE_OBJECT: &str = "the saved streams setting";

const TO_ACCOUNT_EMAIL: &str = "To your Videorc account's email.";
const ENV_DISABLED: &str = "Turned off when Videorc started. Reopen Videorc to change it.";
const UNREACHABLE: &str = "Couldn't reach videorc.com.";

/// `StreamReportEmailState`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub signed_in: bool,
    /// Where the report goes: the account's own address.
    pub email: Option<String>,
    /// The account's choice; `None` when it could not be read.
    pub enabled: Option<bool>,
    /// Absent when the web has no history preference yet or is unreachable.
    pub history: Option<bool>,
    /// `VIDEORC_STREAM_REPORT_EMAIL=0` turned it off for this run.
    pub env_disabled: bool,
}

/// `streamReportEmailDescription`.
pub fn email_description(state: Option<&State>, load_failed: bool) -> String {
    let Some(state) = state else {
        return if load_failed {
            LOAD_FAILED
        } else {
            TO_ACCOUNT_EMAIL
        }
        .to_string();
    };
    if state.env_disabled {
        return ENV_DISABLED.to_string();
    }
    if !state.signed_in {
        return TO_ACCOUNT_EMAIL.to_string();
    }
    if state.enabled.is_none() {
        return UNREACHABLE.to_string();
    }
    match state.email.as_deref().filter(|email| !email.is_empty()) {
        Some(email) => format!("To {email}."),
        None => TO_ACCOUNT_EMAIL.to_string(),
    }
}

/// `streamHistoryDescription`.
pub fn history_description(state: Option<&State>) -> &'static str {
    match state {
        Some(state) if state.signed_in && state.env_disabled => ENV_DISABLED,
        Some(state) if state.signed_in && state.history.is_none() => UNREACHABLE,
        _ => HISTORY_DESCRIPTION,
    }
}

/// `StreamReportSendView`: idle, sending, or the backend's
/// `StreamReportSendResult` (`status`, and `email` once sent).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Send {
    #[default]
    Idle,
    Sending,
    Done {
        status: String,
        email: Option<String>,
    },
}

impl Send {
    pub fn from_result(result: &Value) -> Self {
        Send::Done {
            status: result["status"].as_str().unwrap_or("failed").to_string(),
            email: result["email"]
                .as_str()
                .filter(|email| !email.is_empty())
                .map(str::to_string),
        }
    }

    pub fn failed() -> Self {
        Send::Done {
            status: "failed".into(),
            email: None,
        }
    }
}

/// `streamReportSendLine`.
pub fn send_line(send: &Send) -> String {
    let (status, email) = match send {
        Send::Idle => return "Emails your latest live stream's report now.".to_string(),
        Send::Sending => return SENDING.to_string(),
        Send::Done { status, email } => (status.as_str(), email.as_deref()),
    };
    match status {
        "sent" => email.map_or_else(|| "Sent.".to_string(), |email| format!("Sent to {email}.")),
        "already-sent" => "Already sent.".into(),
        "disabled" => "Stream reports are off for your account.".into(),
        "no-stream" => "No finished live stream yet.".into(),
        "signed-out" => "Sign in to Videorc first.".into(),
        "rate-limited" => "That's 10 reports today. Try again tomorrow.".into(),
        "unavailable" => "videorc.com can't send stream reports right now.".into(),
        _ => "Couldn't send it. Try again.".into(),
    }
}

/// The email row's control: a switch, or Try again when the choice couldn't
/// be read (a switch would show "off" for an account that may be on).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailControl {
    Switch { checked: bool, enabled: bool },
    TryAgain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionView {
    /// The Sign in lock with [`SIGNED_OUT_REASON`].
    pub signed_out: bool,
    pub email_description: String,
    pub email_control: EmailControl,
    pub history_checked: bool,
    pub history_enabled: bool,
    pub history_description: &'static str,
    pub send_line: String,
    pub send_label: &'static str,
    pub send_enabled: bool,
}

/// `StreamReportEmailSectionView`.
pub fn section_view(state: Option<&State>, load_failed: bool, send: &Send) -> SectionView {
    let signed_out = state.is_some_and(|state| !state.signed_in);
    let usable = state.is_some_and(|state| state.signed_in && !state.env_disabled);
    let unread = (usable && state.is_some_and(|state| state.enabled.is_none()))
        || (state.is_none() && load_failed);
    SectionView {
        signed_out,
        email_description: email_description(state, load_failed),
        email_control: if unread {
            EmailControl::TryAgain
        } else {
            EmailControl::Switch {
                checked: state.and_then(|state| state.enabled) == Some(true),
                enabled: usable && state.is_some_and(|state| state.enabled.is_some()),
            }
        },
        history_checked: state.and_then(|state| state.history) == Some(true),
        history_enabled: usable && state.is_some_and(|state| state.history.is_some()),
        history_description: history_description(state),
        send_line: send_line(send),
        send_label: if *send == Send::Sending {
            SENDING
        } else {
            SEND
        },
        send_enabled: usable && *send != Send::Sending,
    }
}

/// The section's state between the backend's answers
/// (`StreamReportEmailSection`). Every read and save takes a request number;
/// only the latest one's answer lands.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Section {
    pub state: Option<State>,
    pub load_failed: bool,
    pub send: Send,
    /// What the backend last said, so a failed save puts the switch back.
    confirmed: Option<State>,
    latest: u64,
    retries: usize,
    send_generation: u64,
}

/// What the driver does after a failed read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterReadFailure {
    Nothing,
    /// Read again after this many milliseconds.
    RetryAfter(u64),
}

impl Section {
    pub fn view(&self) -> SectionView {
        section_view(self.state.as_ref(), self.load_failed, &self.send)
    }

    /// A read (`streamReport.email.get`) is about to go out: its request
    /// number. The driver cancels a pending automatic retry first.
    pub fn read_started(&mut self) -> u64 {
        self.latest += 1;
        self.latest
    }

    /// Try again: a fresh cycle of automatic retries after this read.
    pub fn retry_started(&mut self) -> u64 {
        self.retries = 0;
        self.read_started()
    }

    /// A read, a save or a send returned the backend's state.
    pub fn answered(&mut self, request: u64, state: State) {
        if request != self.latest {
            return;
        }
        self.confirmed = Some(state.clone());
        self.retries = 0;
        self.load_failed = false;
        self.state = Some(state);
    }

    /// A read failed. A failed re-read keeps the choices already shown; a
    /// failed first read says so and tries again a few times on its own.
    pub fn read_failed(&mut self, request: u64) -> AfterReadFailure {
        if request != self.latest || self.confirmed.is_some() {
            return AfterReadFailure::Nothing;
        }
        self.load_failed = true;
        let Some(wait) = LOAD_RETRY_MS.get(self.retries) else {
            return AfterReadFailure::Nothing;
        };
        self.retries += 1;
        AfterReadFailure::RetryAfter(*wait)
    }

    /// The email switch flipped: shown at once, saved with this request.
    pub fn email_flipped(&mut self, enabled: bool) -> u64 {
        if let Some(state) = &mut self.state {
            state.enabled = Some(enabled);
        }
        self.read_started()
    }

    /// The history switch flipped.
    pub fn history_flipped(&mut self, enabled: bool) -> u64 {
        if let Some(state) = &mut self.state {
            state.history = Some(enabled);
        }
        self.read_started()
    }

    /// A save failed: `true` when it was the latest, so the driver toasts and
    /// reads again; the confirmed choice is back on screen.
    pub fn save_failed(&mut self, request: u64) -> bool {
        if request != self.latest {
            return false;
        }
        self.state = self.confirmed.clone();
        true
    }

    /// "Send" pressed: the send's generation.
    pub fn send_started(&mut self) -> u64 {
        self.send_generation += 1;
        self.send = Send::Sending;
        self.send_generation
    }

    /// The send answered: `true` when the account's choice changed
    /// elsewhere ("disabled", "signed-out") and the driver reads it again.
    pub fn send_answered(&mut self, generation: u64, result: &Value) -> bool {
        if generation != self.send_generation {
            return false;
        }
        self.send = Send::from_result(result);
        matches!(&self.send, Send::Done { status, .. } if status == "disabled" || status == "signed-out")
    }

    pub fn send_failed(&mut self, generation: u64) {
        if generation == self.send_generation {
            self.send = Send::failed();
        }
    }

    /// `account.changed`: another account's choices are not this one's.
    /// Returns the fresh read's request number.
    pub fn account_changed(&mut self) -> u64 {
        self.send_generation += 1;
        self.send = Send::Idle;
        self.confirmed = None;
        self.state = None;
        self.load_failed = false;
        self.retries = 0;
        self.read_started()
    }

    /// The section closed: retire every read and send in flight.
    pub fn closed(&mut self) {
        self.send_generation += 1;
        self.latest += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn signed_in(enabled: Option<bool>) -> State {
        State {
            signed_in: true,
            email: Some("me@example.com".into()),
            enabled,
            history: Some(false),
            env_disabled: false,
        }
    }

    #[test]
    fn the_rows_say_where_the_report_goes_or_why_not() {
        assert_eq!(
            email_description(None, false),
            "To your Videorc account's email."
        );
        assert_eq!(
            email_description(None, true),
            "Couldn't load these settings."
        );
        let on = signed_in(Some(true));
        assert_eq!(email_description(Some(&on), false), "To me@example.com.");
        let unread = signed_in(None);
        assert_eq!(
            email_description(Some(&unread), false),
            "Couldn't reach videorc.com."
        );
        let env = State {
            env_disabled: true,
            ..on.clone()
        };
        assert_eq!(
            email_description(Some(&env), false),
            "Turned off when Videorc started. Reopen Videorc to change it."
        );
        assert_eq!(
            history_description(Some(&env)),
            "Turned off when Videorc started. Reopen Videorc to change it."
        );
        let no_history = State {
            history: None,
            ..on.clone()
        };
        assert_eq!(
            history_description(Some(&no_history)),
            "Couldn't reach videorc.com."
        );
        assert_eq!(history_description(None), HISTORY_DESCRIPTION);

        let view = section_view(Some(&unread), false, &Send::Idle);
        assert_eq!(view.email_control, EmailControl::TryAgain);
        let out = section_view(Some(&State::default()), false, &Send::Idle);
        assert!(out.signed_out && !out.send_enabled && !out.history_enabled);
        assert_eq!(
            out.email_control,
            EmailControl::Switch {
                checked: false,
                enabled: false
            }
        );
    }

    #[test]
    fn the_send_line_says_what_happened() {
        assert_eq!(
            send_line(&Send::Idle),
            "Emails your latest live stream's report now."
        );
        assert_eq!(send_line(&Send::Sending), "Sending…");
        assert_eq!(
            send_line(&Send::from_result(
                &json!({ "status": "sent", "email": "a@b.c" })
            )),
            "Sent to a@b.c."
        );
        assert_eq!(
            send_line(&Send::from_result(&json!({ "status": "sent" }))),
            "Sent."
        );
        assert_eq!(
            send_line(&Send::from_result(&json!({ "status": "rate-limited" }))),
            "That's 10 reports today. Try again tomorrow."
        );
        assert_eq!(send_line(&Send::failed()), "Couldn't send it. Try again.");
        let sending = section_view(Some(&signed_in(Some(true))), false, &Send::Sending);
        assert_eq!(
            (sending.send_label, sending.send_enabled),
            ("Sending…", false)
        );
    }

    #[test]
    fn only_the_latest_answer_lands_and_a_failed_save_puts_the_choice_back() {
        let mut section = Section::default();
        let first = section.read_started();
        assert_eq!(
            section.read_failed(first),
            AfterReadFailure::RetryAfter(2_000)
        );
        assert!(section.load_failed);
        let second = section.read_started();
        assert_eq!(
            section.read_failed(second),
            AfterReadFailure::RetryAfter(5_000)
        );
        let third = section.read_started();
        assert_eq!(
            section.read_failed(third),
            AfterReadFailure::RetryAfter(15_000)
        );
        let fourth = section.read_started();
        assert_eq!(section.read_failed(fourth), AfterReadFailure::Nothing);
        let again = section.retry_started();
        section.answered(again, signed_in(Some(false)));
        assert!(!section.load_failed);

        let save = section.email_flipped(true);
        assert_eq!(section.state.as_ref().unwrap().enabled, Some(true));
        let stale = section.read_started();
        assert!(!section.save_failed(save));
        assert!(section.save_failed(stale));
        assert_eq!(section.state.as_ref().unwrap().enabled, Some(false));
        // A failed re-read keeps what is shown.
        let reread = section.read_started();
        assert_eq!(section.read_failed(reread), AfterReadFailure::Nothing);
        assert!(!section.load_failed);
    }

    #[test]
    fn an_account_change_forgets_the_old_choices_and_retires_the_send() {
        let mut section = Section::default();
        let read = section.read_started();
        section.answered(read, signed_in(Some(true)));
        let send = section.send_started();
        let fresh = section.account_changed();
        assert!(section.state.is_none());
        assert!(!section.send_answered(send, &json!({ "status": "sent" })));
        assert_eq!(section.send, Send::Idle);
        assert_eq!(
            section.read_failed(fresh),
            AfterReadFailure::RetryAfter(2_000)
        );

        let send = section.send_started();
        assert!(section.send_answered(send, &json!({ "status": "disabled" })));
        section.closed();
        let late = section.latest;
        section.answered(late - 1, signed_in(Some(true)));
        assert!(section.state.is_none());
    }
}
