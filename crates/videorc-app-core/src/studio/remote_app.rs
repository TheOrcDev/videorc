//! The remote keys past the Studio's own (Stream Deck, the phone remote):
//! Electron's `lib/studio-actions/windows.ts` and `buddy.ts`, on the Studio.
//! [`super::remote`] matches the kind and acks the answer.
//!
//! A window key is the app's to run: app-core holds no window. The Studio
//! hands it to the app over the channel the app listens on
//! ([`Studio::set_remote_app_listener`]) with a one-shot answer, and waits at
//! most [`APP_ANSWER_TIMEOUT`] for it, so a stuck app never holds a key.
//! While no app listens these keys answer "Update Videorc", as before.
//!
//! The Stream Manager Screen key's tap moves the window to its other screen
//! in Electron; this app cannot move windows yet, so the tap is refused with
//! Electron's sentence for the case (`SCREEN_REFUSAL_COPY`), never "Update
//! Videorc". Its hold (front or close) runs.
//!
//! Sidekick Live needs no window: the Studio saves it as `set_buddy` does
//! (`saveBuddy`), with Premium and the Cloud AI consent checked when it
//! turns on.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::families;
use super::remote::{IntentOutcome, RemoteNamed, ScreenMoves, copy, refused, text_field};
use super::{Studio, StudioBackend};
use crate::account::entitlements::{EntitlementGate, live_cohost_gate, read_snapshot};
use crate::stream_manager::buddy::{CohostSettingsView, enable_patch};

/// How long a window key waits for the app before it says it failed.
pub const APP_ANSWER_TIMEOUT: Duration = Duration::from_secs(5);
/// Sidekick's settings, as the Stream Manager's commands read and save them.
pub const COHOST_SETTINGS_GET_METHOD: &str = "cohost.settings.get";
pub const COHOST_SETTINGS_SET_METHOD: &str = "cohost.settings.set";
/// The plan Sidekick Live needs (`liveCohostGate`).
pub const ENTITLEMENTS_GET_METHOD: &str = "entitlements.get";

/// What Sidekick's key reads (`BUDDY_TOOL_COPY`, and `saveBuddy`'s words).
pub mod buddy_copy {
    pub const LOADING: &str = "Loading your Sidekick settings… Try again in a moment.";
    pub const PREMIUM: &str = crate::account::entitlements::copy::LIVE_COHOST_REASON;
    pub const CONSENT: &str = crate::buddy::copy::CONSENT_OFF_REASON;
    pub const ON: &str = "Sidekick Live is on.";
    pub const OFF: &str = "Sidekick Live is off.";
}

/// `buddyLiveOn`, `buddyLiveOff`, `buddyLiveToggle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuddyLiveVerb {
    On,
    Off,
    Toggle,
}

/// The windows a `windowFront` key names (`describe.windows`). `Comments`
/// is the Stream Manager (Electron's comments window).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteWindow {
    Notes,
    Comments,
    Preview,
}

impl RemoteWindow {
    /// The wire's name, or `None` for a window Videorc doesn't have.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "notes" => Some(Self::Notes),
            "comments" => Some(Self::Comments),
            "preview" => Some(Self::Preview),
            _ => None,
        }
    }
}

/// What the app is asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppRemoteAction {
    /// `windowFront`: the window to the front, opened when it is closed
    /// (`openWindow`).
    WindowFront(RemoteWindow),
    /// `streamManagerFrontOrClose`: the Screen key held
    /// ([`stream_manager_hold_action`]).
    StreamManagerFrontOrClose,
}

/// One key for the app, and where its answer goes. Answer it with
/// [`Self::answer`]; one dropped unanswered reads as a failure.
#[derive(Debug)]
pub struct AppRemoteIntent {
    pub action: AppRemoteAction,
    pub reply: oneshot::Sender<IntentOutcome>,
}

impl AppRemoteIntent {
    /// The key's answer; one that comes after the wait ended is dropped.
    pub fn answer(self, outcome: IntentOutcome) {
        let _ = self.reply.send(outcome);
    }
}

/// What a hold of the Stream Manager Screen key does
/// (`streamManagerHoldAction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldAction {
    /// The streamer is using it: it closes.
    Close,
    /// It comes to the front, opened when it is closed.
    Front,
}

/// Close the window the streamer is using (open, showing and focused), else
/// bring it up. A deck press never moves the focus, so focused means in use.
pub fn stream_manager_hold_action(open: bool, visible: bool, focused: bool) -> HoldAction {
    if open && visible && focused {
        HoldAction::Close
    } else {
        HoldAction::Front
    }
}

/// `streamManagerScreenSwap`'s refusal (`planStreamManagerScreenSwap`, then
/// `SCREEN_REFUSAL_COPY`): both screens named, two different ones, both
/// connected, then the move this app cannot make yet (Wayland's own words
/// where the app says so; else Electron's `unavailable`).
pub fn screen_swap_refusal(
    intent: &Value,
    screens: &[RemoteNamed],
    moves: ScreenMoves,
) -> &'static str {
    let (Some(presenting), Some(monitor)) = (
        text_field(intent, "presentingScreen"),
        text_field(intent, "monitorScreen"),
    ) else {
        return copy::WINDOW_MISSING;
    };
    if presenting == monitor {
        return copy::SCREENS_SAME;
    }
    let connected = |id: &str| screens.iter().any(|screen| screen.id == id);
    if !connected(presenting) || !connected(monitor) {
        return copy::SCREEN_MISSING;
    }
    match moves {
        ScreenMoves::Wayland => copy::STREAM_MANAGER_WAYLAND,
        ScreenMoves::Supported => copy::WINDOW_MISSING,
    }
}

/// `saveBuddy`'s gate for turning Sidekick Live on: Premium first, then the
/// Cloud AI consent only the streamer can give. `None`: allowed.
pub fn buddy_live_refusal(gate: &EntitlementGate, consented: bool) -> Option<String> {
    if !gate.allowed() {
        return Some(
            gate.reason()
                .filter(|reason| !reason.is_empty())
                .unwrap_or(buddy_copy::PREMIUM)
                .to_string(),
        );
    }
    (!consented).then(|| buddy_copy::CONSENT.to_string())
}

impl<B: StudioBackend> Studio<B> {
    /// The app's receiver for the keys only it can run; `None` when it
    /// stops listening (those keys answer "Update Videorc" again).
    pub fn set_remote_app_listener(
        &self,
        listener: Option<mpsc::UnboundedSender<AppRemoteIntent>>,
    ) {
        self.remote_lock().app_intents = listener;
    }

    /// Hands a key to the app and waits for its answer: "Update Videorc"
    /// while no app listens, the plain failure when it never answers.
    async fn ask_app(&self, action: AppRemoteAction) -> IntentOutcome {
        let listener = self.remote_lock().app_intents.clone();
        let Some(listener) = listener else {
            return refused(copy::UNSUPPORTED);
        };
        let (reply, answer) = oneshot::channel();
        if listener.send(AppRemoteIntent { action, reply }).is_err() {
            return refused(copy::UNSUPPORTED);
        }
        match tokio::time::timeout(APP_ANSWER_TIMEOUT, answer).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => {
                self.config.logger.warn(format!(
                    "[remote-control] the app dropped {action:?} unanswered"
                ));
                refused(copy::FAILED)
            }
            Err(_) => {
                self.config.logger.warn(format!(
                    "[remote-control] the app did not answer {action:?} in time"
                ));
                refused(copy::FAILED)
            }
        }
    }

    /// `windowFront`: notes, comments (the Stream Manager) or the Preview.
    pub(super) async fn remote_window_front(&self, intent: &Value) -> IntentOutcome {
        let Some(window) = text_field(intent, "window").and_then(RemoteWindow::from_name) else {
            return refused(copy::WINDOW_MISSING);
        };
        self.ask_app(AppRemoteAction::WindowFront(window)).await
    }

    /// `streamManagerFrontOrClose`: the Screen key held.
    pub(super) async fn remote_stream_manager_front_or_close(&self) -> IntentOutcome {
        self.ask_app(AppRemoteAction::StreamManagerFrontOrClose)
            .await
    }

    /// `streamManagerScreenSwap`: the Screen key tapped. Always refused
    /// here, with the sentence for why (see the module's note).
    pub(super) fn remote_screen_swap(&self, intent: &Value) -> IntentOutcome {
        let (screens, moves) = {
            let remote = self.remote_lock();
            (remote.extras.screens.clone(), remote.extras.screen_moves)
        };
        refused(screen_swap_refusal(intent, &screens, moves))
    }

    /// `buddyLiveOn`, `buddyLiveOff`, `buddyLiveToggle` (`saveBuddy` with
    /// `on`): the settings read fresh; turning on needs Premium and the
    /// Cloud AI consent; off is always allowed. Done, it says so.
    pub(super) async fn remote_buddy_live(&self, verb: BuddyLiveVerb) -> IntentOutcome {
        let current = match self
            .backend
            .buddy_request(COHOST_SETTINGS_GET_METHOD, json!({}))
            .await
        {
            Ok(value) => CohostSettingsView::from_json(&value),
            Err(error) => {
                self.config.logger.warn(format!(
                    "[remote-control] Sidekick's settings did not read: {} ({})",
                    error.message, error.code
                ));
                None
            }
        };
        let Some(current) = current else {
            return refused(buddy_copy::LOADING);
        };
        self.note_buddy_live(current.enabled);
        let on = match verb {
            BuddyLiveVerb::On => true,
            BuddyLiveVerb::Off => false,
            BuddyLiveVerb::Toggle => !current.enabled,
        };
        if on && !current.enabled {
            let gate = match self
                .backend
                .buddy_request(ENTITLEMENTS_GET_METHOD, Value::Null)
                .await
            {
                Ok(value) => live_cohost_gate(read_snapshot(&value).as_ref()),
                // Fail closed, as the Stream Manager's gate does.
                Err(_) => live_cohost_gate(None),
            };
            let consented = self.read_ui_settings(families::ai_consent);
            if let Some(refusal) = buddy_live_refusal(&gate, consented) {
                return refused(refusal);
            }
        }
        let patch = enable_patch(Some(current.enabled), on, None, false);
        if !patch.is_empty() {
            match self
                .backend
                .buddy_request(COHOST_SETTINGS_SET_METHOD, Value::Object(patch))
                .await
            {
                Ok(saved) => self.note_cohost_settings(&saved),
                Err(error) => {
                    self.config.logger.warn(format!(
                        "[remote-control] Sidekick Live did not save: {} ({})",
                        error.message, error.code
                    ));
                    return refused(copy::FAILED);
                }
            }
        }
        (
            true,
            Some(if on { buddy_copy::ON } else { buddy_copy::OFF }.to_string()),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(id: &str) -> RemoteNamed {
        RemoteNamed {
            id: id.to_string(),
            name: id.to_string(),
        }
    }

    #[test]
    fn a_hold_closes_only_the_stream_manager_in_use() {
        assert_eq!(
            stream_manager_hold_action(true, true, true),
            HoldAction::Close
        );
        assert_eq!(
            stream_manager_hold_action(true, true, false),
            HoldAction::Front
        );
        assert_eq!(
            stream_manager_hold_action(true, false, true),
            HoldAction::Front
        );
        assert_eq!(
            stream_manager_hold_action(false, false, false),
            HoldAction::Front
        );
    }

    #[test]
    fn the_window_names_are_the_wires() {
        assert_eq!(RemoteWindow::from_name("notes"), Some(RemoteWindow::Notes));
        assert_eq!(
            RemoteWindow::from_name("comments"),
            Some(RemoteWindow::Comments)
        );
        assert_eq!(
            RemoteWindow::from_name("preview"),
            Some(RemoteWindow::Preview)
        );
        assert_eq!(RemoteWindow::from_name("Notes"), None);
        assert_eq!(RemoteWindow::from_name(""), None);
    }

    #[test]
    fn a_screen_tap_is_refused_with_the_reason_in_electrons_order() {
        let screens = [named("1"), named("2")];
        let tap = |fields: Value, moves| screen_swap_refusal(&fields, &screens, moves);
        assert_eq!(
            tap(json!({"presentingScreen": "1"}), ScreenMoves::Supported),
            copy::WINDOW_MISSING
        );
        assert_eq!(
            tap(
                json!({"presentingScreen": "1", "monitorScreen": "1"}),
                ScreenMoves::Supported
            ),
            copy::SCREENS_SAME
        );
        assert_eq!(
            tap(
                json!({"presentingScreen": "1", "monitorScreen": "9"}),
                ScreenMoves::Supported
            ),
            copy::SCREEN_MISSING
        );
        assert_eq!(
            tap(
                json!({"presentingScreen": "1", "monitorScreen": "2"}),
                ScreenMoves::Wayland
            ),
            copy::STREAM_MANAGER_WAYLAND
        );
        assert_eq!(
            tap(
                json!({"presentingScreen": "1", "monitorScreen": "2"}),
                ScreenMoves::Supported
            ),
            copy::WINDOW_MISSING
        );
        // No screens reported: nothing is connected.
        assert_eq!(
            screen_swap_refusal(
                &json!({"presentingScreen": "1", "monitorScreen": "2"}),
                &[],
                ScreenMoves::Supported
            ),
            copy::SCREEN_MISSING
        );
    }

    #[test]
    fn sidekick_live_needs_premium_then_the_consent() {
        assert_eq!(
            buddy_live_refusal(&live_cohost_gate(None), true).as_deref(),
            Some(buddy_copy::PREMIUM)
        );
        assert_eq!(
            buddy_live_refusal(&EntitlementGate::Allowed, false).as_deref(),
            Some(buddy_copy::CONSENT)
        );
        assert_eq!(buddy_live_refusal(&EntitlementGate::Allowed, true), None);
    }
}
