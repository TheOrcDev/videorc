//! Quitting or closing the main window while on air asks first (plan 260
//! S2.6a, from Electron's `main/exit-guard.ts`, plan 174 S3.1 D2, and plan
//! 243 C5 / R2 B-M1).
//!
//! The app reads "on air" from the backend's own `recording.status` events
//! and this computer's cloud room (`cloud.state`), holds the quit or the
//! close, and asks the Studio to put up the End livestream question; the
//! Studio ends the livestream on a yes (or hands a managed show off, "Quit
//! and keep it live") and lets that one exit through ([`LiveExitGuard::allow`]).
//! A recording quits as it always did: the backend's shutdown drains its
//! finalization. A quit that is not the person's (a smoke harness, a
//! shutdown signal, a recovery dialog's own Quit) is allowed up front and
//! never waits, and with nothing that can show the question the exit
//! proceeds.
//!
//! Pure: the decisions are tested as data; the app holds the exits.

use serde_json::Value;
use videorc_protocol::RecordingStatus;

use super::capture_state::CloudRoomActivity;
use crate::studio::session::session_is_live;

/// `AppExitKind`: the app's quit, or the main window's close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppExitKind {
    Quit,
    Close,
}

impl AppExitKind {
    /// The wire's word (`app:exit-request`).
    pub fn as_str(self) -> &'static str {
        match self {
            AppExitKind::Quit => "quit",
            AppExitKind::Close => "close",
        }
    }
}

/// `LiveExitGuard`.
#[derive(Debug, Clone, Default)]
pub struct LiveExitGuard {
    on_air: bool,
    talk_on_air: bool,
    allowed: Option<AppExitKind>,
}

impl LiveExitGuard {
    /// A `recording.status` from the backend's event socket.
    pub fn observe_recording_status(&mut self, status: &RecordingStatus) {
        self.on_air = session_is_live(status);
    }

    /// A `cloud.state` payload (or the `cloud.status` answer): a talk show
    /// has no local session; its livestream is the room's.
    pub fn observe_cloud_status(&mut self, payload: &Value) {
        self.talk_on_air =
            CloudRoomActivity::from_cloud_status(payload) == Some(CloudRoomActivity::Live);
    }

    /// The event socket is gone: there is no livestream left to protect.
    pub fn transport_lost(&mut self) {
        self.on_air = false;
        self.talk_on_air = false;
    }

    pub fn livestream_on_air(&self) -> bool {
        self.on_air || self.talk_on_air
    }

    /// Let the next exit of this kind through without asking.
    pub fn allow(&mut self, kind: AppExitKind) {
        self.allowed = Some(kind);
    }

    /// Whether this exit must wait for the answer. An allowance is spent by
    /// the exit it was given for, so a later livestream asks again. Only
    /// something that can show the question is worth asking; without it the
    /// exit proceeds as it always did.
    pub fn should_ask(&mut self, kind: AppExitKind, can_answer: bool) -> bool {
        if self.allowed == Some(kind) {
            self.allowed = None;
            return false;
        }
        self.livestream_on_air() && can_answer
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use AppExitKind::{Close, Quit};

    fn status(value: Value) -> RecordingStatus {
        serde_json::from_value(value).expect("a recording.status")
    }

    fn on_air() -> RecordingStatus {
        status(
            json!({"state": "recording", "sessionId": "s1", "streamUrl": "rtmp://127.0.0.1/live/***"}),
        )
    }

    fn recording() -> RecordingStatus {
        status(json!({"state": "recording", "sessionId": "s1"}))
    }

    fn talk_live() -> Value {
        json!({
            "phase": "live",
            "room": {"phase": "open", "live": true},
            "onAir": {"kind": "computer", "source": "host", "waiting": false, "thisDevice": true}
        })
    }

    #[test]
    fn never_asks_unless_a_livestream_is_on_air() {
        let mut guard = LiveExitGuard::default();
        assert!(!guard.should_ask(Quit, true));
        guard.observe_recording_status(&recording());
        assert!(!guard.livestream_on_air());
        assert!(!guard.should_ask(Quit, true));
        assert!(!guard.should_ask(Close, true));
    }

    #[test]
    fn asks_for_a_quit_and_for_a_window_close_while_on_air() {
        let mut guard = LiveExitGuard::default();
        guard.observe_recording_status(&on_air());
        assert!(guard.livestream_on_air());
        assert!(guard.should_ask(Quit, true));
        assert!(guard.should_ask(Close, true));
        // Asking again is still asking: nothing was answered.
        assert!(guard.should_ask(Quit, true));
    }

    #[test]
    fn lets_exactly_the_allowed_exit_through_once() {
        let mut guard = LiveExitGuard::default();
        guard.observe_recording_status(&on_air());
        guard.allow(Quit);
        assert!(guard.should_ask(Close, true));
        assert!(!guard.should_ask(Quit, true));
        // Spent: a later livestream asks again.
        assert!(guard.should_ask(Quit, true));
        guard.allow(Close);
        assert!(guard.should_ask(Quit, true));
        assert!(!guard.should_ask(Close, true));
        assert!(guard.should_ask(Close, true));
    }

    #[test]
    fn stops_asking_once_the_session_leaves_the_air_or_the_socket_is_lost() {
        let mut guard = LiveExitGuard::default();
        guard.observe_recording_status(&on_air());
        guard.observe_recording_status(&status(json!({"state": "stopping", "sessionId": "s1"})));
        assert!(!guard.should_ask(Quit, true));
        guard.observe_recording_status(&on_air());
        guard.transport_lost();
        assert!(!guard.livestream_on_air());
        assert!(!guard.should_ask(Quit, true));
    }

    #[test]
    fn does_not_hold_an_exit_when_nothing_can_show_the_question() {
        let mut guard = LiveExitGuard::default();
        guard.observe_recording_status(&on_air());
        assert!(!guard.should_ask(Quit, false));
        assert!(!guard.should_ask(Close, false));
    }

    #[test]
    fn a_talk_show_this_computer_hosts_asks_while_the_room_is_live() {
        let mut guard = LiveExitGuard::default();
        guard.observe_cloud_status(&talk_live());
        assert!(guard.livestream_on_air());
        assert!(guard.should_ask(Quit, true));
        assert!(guard.should_ask(Close, true));
        // A recording status never clears the room's answer, nor the reverse.
        guard.observe_recording_status(&recording());
        assert!(guard.should_ask(Quit, true));
        // An old web sends no onAir: the live room alone is this computer's.
        guard.observe_cloud_status(&json!({"room": {"phase": "open", "live": true}}));
        assert!(guard.should_ask(Quit, true));
    }

    #[test]
    fn a_talk_show_stops_asking_once_the_room_is_not_live_here() {
        let with = |patch: Value| {
            let mut status = talk_live();
            for (key, value) in patch.as_object().unwrap() {
                if value.is_null() {
                    status.as_object_mut().unwrap().remove(key);
                } else {
                    status[key] = value.clone();
                }
            }
            status
        };
        let on_air = talk_live()["onAir"].clone();
        let mut not_here = on_air.clone();
        not_here["thisDevice"] = json!(false);
        let mut waiting = on_air.clone();
        waiting["waiting"] = json!(true);
        for status in [
            with(json!({"room": {"phase": "open", "live": false}})),
            with(json!({"room": {"phase": "closing", "live": true}})),
            with(json!({"room": null})),
            with(json!({"onAir": not_here})),
            with(json!({"onAir": waiting})),
            with(json!({"stoppedBy": "taken-over"})),
            with(json!({"stoppedBy": "hand-off"})),
            json!(null),
            json!("live"),
        ] {
            let mut guard = LiveExitGuard::default();
            guard.observe_cloud_status(&talk_live());
            guard.observe_cloud_status(&status);
            assert!(!guard.should_ask(Quit, true), "{status}");
        }
        let mut guard = LiveExitGuard::default();
        guard.observe_cloud_status(&talk_live());
        guard.transport_lost();
        assert!(!guard.livestream_on_air());
        assert!(!guard.should_ask(Close, true));
    }

    #[test]
    fn a_talk_show_lets_the_answered_exit_through_once() {
        let mut guard = LiveExitGuard::default();
        guard.observe_cloud_status(&talk_live());
        guard.allow(Quit);
        assert!(!guard.should_ask(Quit, true));
        assert!(guard.should_ask(Quit, true));
    }
}
