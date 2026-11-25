//! The Co-host pane's state and calls (P1256–P1280): Electron's
//! `components/cohost-pane.tsx`, `cohost-question-row.tsx`,
//! `cohost-nudge.tsx` and `cohost-status.tsx`, as the Sidekick pane runs
//! them. The engine's `cohost.state` stays the one truth: nothing here
//! decides what a question is, and nothing here sends to chat. Reply and a
//! recap only fill the chat composer, through the window
//! ([`SidekickEvent`]).
//!
//! `cohost_list` draws the notices, the triage list and its cards;
//! `cohost_avatar` draws the avatar's identity, the Say footer and the
//! listening card.

use std::time::Duration;

use gpui::{
    App, Entity, EventEmitter, FocusHandle, KeyBinding, Subscription, Window, actions, prelude::*,
};
use serde_json::{Value, json};
use videorc_app_core::account::entitlements::{EntitlementGate, live_cohost_gate, read_snapshot};
use videorc_app_core::buddy::reactions::{PackSummary, active_reactions};
use videorc_app_core::chat::highlight_driver::{
    self as highlight, STATUS_EVENT as HIGHLIGHT_EVENT,
};
use videorc_app_core::chat::model::{CommentHighlightPhase, CommentHighlightState};
/// Re-export for cohost_list's accelerator chip.
pub(super) use videorc_app_core::stream_manager::buddy::REMOVE_FLAGGED_KEY;
use videorc_app_core::stream_manager::buddy::{
    BuddyOverlaySnapshot, CohostSettingsView, CohostState, PaneGate, RowCommand, RowKey,
    apply_cohost_state, buddy_outputs, draft_for_question, enable_patch, grouped_delta_flash,
    move_selection, pane_rows, resolve_selection, row_command, say_text, with_buddy_on_stream,
    words as pane_words,
};
use videorc_app_core::stream_manager::removal::{
    latest_by_message, remove_from_chat_available, remove_from_chat_blocked_reason,
};
use videorc_app_core::stream_manager::send::writable_providers;
use videorc_app_core::studio::families;
use videorc_app_core::user_error::{Failure, UserErrorContext, toast_user_error};
use videorc_kit::command::InputEvent;
use videorc_kit::input::InputState;
use videorc_protocol::buddy_pet::BuddyAvatar;
use videorc_protocol::cohost::CohostUtteranceState;

use super::sidekick::SidekickPane;

actions!(
    sidekick_list,
    [
        SelectPrevious,
        SelectNext,
        ReplyToRow,
        ShowRowOnStream,
        MarkRowAnswered,
        DismissRow,
        RemoveFlagged,
        OpenRow
    ]
);

/// The triage list's key context: its keys run only while it has focus,
/// so they never reach the chat composer or the Say box.
pub const LIST_CONTEXT: &str = "SidekickList";

// The list's keys, one spelling for the binding and its chip.
pub(super) const REPLY_KEY: &str = "r";
pub(super) const SHOW_KEY: &str = "h";
pub(super) const ANSWERED_KEY: &str = "a";
pub(super) const DISMISS_KEY: &str = "backspace";
pub(super) const OPEN_KEY: &str = "enter";
/// The Say box's own keys (the input's Enter and its secondary Enter).
pub(super) const SAY_KEY: &str = "enter";
pub(super) const LAUGH_KEY: &str = "secondary-enter";

/// "grouped 2 questions" stays in the status pill this long.
const FLASH_FOR: Duration = Duration::from_secs(2);
/// Ages and expiries (answered on air, the recap, alerts) tick this often.
const TICK: Duration = Duration::from_secs(30);

const UPDATE_SIDEKICK: UserErrorContext = UserErrorContext {
    action: "update",
    object: "Sidekick",
};
const TURN_ON_LISTENING: UserErrorContext = UserErrorContext {
    action: "turn on",
    object: "listening",
};
const WAVE: UserErrorContext = UserErrorContext {
    action: "wave at",
    object: "this viewer",
};
const SAY: UserErrorContext = UserErrorContext {
    action: "say",
    object: "that on stream",
};
const REACT: UserErrorContext = UserErrorContext {
    action: "play",
    object: "the reaction",
};
const SHOW_AVATAR: UserErrorContext = UserErrorContext {
    action: "show",
    object: "the avatar on stream",
};

/// The window's half of the list's keys. Call once, beside the window's own.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("up", SelectPrevious, Some(LIST_CONTEXT)),
        KeyBinding::new("down", SelectNext, Some(LIST_CONTEXT)),
        KeyBinding::new(REPLY_KEY, ReplyToRow, Some(LIST_CONTEXT)),
        KeyBinding::new(SHOW_KEY, ShowRowOnStream, Some(LIST_CONTEXT)),
        KeyBinding::new(ANSWERED_KEY, MarkRowAnswered, Some(LIST_CONTEXT)),
        KeyBinding::new(DISMISS_KEY, DismissRow, Some(LIST_CONTEXT)),
        KeyBinding::new("delete", DismissRow, Some(LIST_CONTEXT)),
        KeyBinding::new("shift-backspace", RemoveFlagged, Some(LIST_CONTEXT)),
        KeyBinding::new("shift-delete", RemoveFlagged, Some(LIST_CONTEXT)),
        KeyBinding::new(OPEN_KEY, OpenRow, Some(LIST_CONTEXT)),
    ]);
}

/// What the Sidekick pane asks of the window's other panes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidekickEvent {
    /// Words for the chat composer: Reply's draft, a recap (`setPrefill`).
    Prefill(String),
    /// A question's message goes on stream (`requestHighlight`).
    ShowOnStream(String),
    /// Chat comes forward with this message in view.
    JumpTo(String),
    /// Remove a flagged message from chat (P1268 / Shift+Backspace).
    RemoveFromChat(String),
}

impl EventEmitter<SidekickEvent> for SidekickPane {}

/// The pane's own state beside the engine's.
pub struct Cohost {
    /// `liveCohostGate` from `entitlements.get`; `None` until it is read,
    /// and the pane shows nothing of Sidekick until then.
    pub(super) gate: Option<EntitlementGate>,
    /// The selected row's key (`q:…`, `f:…`).
    pub(super) selected: Option<String>,
    pub(super) list_focus: FocusHandle,
    pub(super) say: Entity<InputState>,
    clear_say: bool,
    pub(super) say_pending: bool,
    /// One engine call at a time (`cohostActionPending`).
    pub(super) pending: bool,
    /// `cohost.buddy.state`: the avatar's state and bubble.
    pub(super) buddy: BuddyOverlaySnapshot,
    /// `overlays.layout`, once read.
    layout: Option<Value>,
    /// `overlayLayout.buddy`: (on stream, in the recording).
    pub(super) outputs: Option<(bool, bool)>,
    /// `cohost.pet.list`, once read.
    packs: Option<Vec<PackSummary>>,
    /// The message on stream now (`liveHighlightId`).
    pub(super) highlighted: Option<String>,
    /// "grouped 2 questions" for two seconds after a pass added some.
    pub(super) flash: Option<String>,
    flash_mark: u64,
    /// "+2" under Answered on air is open.
    pub(super) answered_open: bool,
    /// The live session the nudge was dismissed for (once per session).
    nudge_dismissed_session: Option<String>,
    /// Turn on or Not now on the listening card, in this window's life.
    listen_answered: bool,
    _say: Subscription,
}

impl Cohost {
    pub(super) fn new(window: &mut Window, cx: &mut Context<SidekickPane>) -> Self {
        let say = cx.new(|cx| InputState::new(window, cx).placeholder(pane_words::SAY_PLACEHOLDER));
        let say_sub = cx.subscribe(&say, |pane, _, event: &InputEvent, cx| {
            if let InputEvent::PressEnter { secondary, .. } = event {
                let state = if *secondary {
                    CohostUtteranceState::Laugh
                } else {
                    CohostUtteranceState::Talk
                };
                pane.say(state, cx);
            }
        });
        Self {
            gate: None,
            selected: None,
            list_focus: cx.focus_handle(),
            say,
            clear_say: false,
            say_pending: false,
            pending: false,
            buddy: BuddyOverlaySnapshot::default(),
            layout: None,
            outputs: None,
            packs: None,
            highlighted: None,
            flash: None,
            flash_mark: 0,
            answered_open: false,
            nudge_dismissed_session: None,
            listen_answered: false,
            _say: say_sub,
        }
    }

    /// The Premium gate as the pane reads it (`cohostGate`).
    pub(super) fn pane_gate(&self) -> Option<PaneGate<'_>> {
        Some(match self.gate.as_ref()? {
            EntitlementGate::Allowed => PaneGate {
                allowed: true,
                reason: "",
                upgrade_url: None,
            },
            EntitlementGate::Locked {
                reason,
                upgrade_url,
                ..
            } => PaneGate {
                allowed: false,
                reason: reason.as_str(),
                upgrade_url: *upgrade_url,
            },
        })
    }
}

impl SidekickPane {
    // --- Reads and events ----------------------------------------------------

    /// The first reads: the gate, the avatar, its placement and its packs,
    /// the message on stream; then the slow clock for ages and expiries.
    pub(super) fn cohost_start(&mut self, cx: &mut Context<Self>) {
        self.read_gate(cx);
        self.read_packs(cx);
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            let backend = studio.backend().clone();
            let buddy = backend
                .request("cohost.buddy.status", json!({}))
                .await
                .ok()
                .and_then(|value| serde_json::from_value::<BuddyOverlaySnapshot>(value).ok());
            let layout = studio.overlay_layout().await.ok();
            let highlight = highlight::read_status(&*backend).await;
            (buddy, layout, highlight)
        });
        cx.spawn(async move |this, cx| {
            let Ok((buddy, layout, highlight)) = job.await else {
                return;
            };
            let _ = this.update(cx, |pane, cx| {
                if let Some(buddy) = buddy {
                    pane.cohost.buddy = buddy;
                }
                if let Some(layout) = layout {
                    pane.take_layout(layout);
                }
                if let Some(state) = highlight {
                    pane.take_highlight(&state);
                }
                cx.notify();
            });
        })
        .detach();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// The backend's events the Co-host pane reads, beside the pane's own.
    pub(super) fn cohost_event(&mut self, event: &str, payload: &Value, cx: &mut Context<Self>) {
        match event {
            "cohost.buddy.state" => {
                if let Ok(buddy) = serde_json::from_value::<BuddyOverlaySnapshot>(payload.clone()) {
                    self.cohost.buddy = buddy;
                    cx.notify();
                }
            }
            "overlays.layout" => {
                self.take_layout(payload.clone());
                cx.notify();
            }
            HIGHLIGHT_EVENT => {
                if let Ok(state) = serde_json::from_value::<CommentHighlightState>(payload.clone())
                {
                    self.take_highlight(&state);
                    cx.notify();
                }
            }
            "cohost.settings.changed" => {
                self.avatar_name = self.settings.persona.as_ref().map(|p| p.name.clone());
                self.read_packs(cx);
            }
            "account.changed" => self.read_gate(cx),
            _ => {}
        }
    }

    /// A `cohost.state` (pushed, or a call's answer): an older tick never
    /// wins, and a pass that grouped new questions says so for two seconds.
    pub(super) fn receive_state(&mut self, next: CohostState, cx: &mut Context<Self>) {
        if let Some(flash) = grouped_delta_flash(Some(&self.state), &next) {
            self.cohost.flash = Some(flash);
            self.cohost.flash_mark += 1;
            let mark = self.cohost.flash_mark;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(FLASH_FOR).await;
                let _ = this.update(cx, |pane, cx| {
                    if pane.cohost.flash_mark == mark {
                        pane.cohost.flash = None;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        self.state = apply_cohost_state(Some(&self.state), next);
        cx.notify();
    }

    fn take_layout(&mut self, layout: Value) {
        self.cohost.outputs = buddy_outputs(&layout);
        self.cohost.layout = Some(layout);
    }

    fn take_highlight(&mut self, state: &CommentHighlightState) {
        self.cohost.highlighted = (state.phase == CommentHighlightPhase::Live)
            .then(|| state.message_id.clone())
            .flatten();
    }

    fn read_gate(&mut self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            let snapshot = backend
                .request("entitlements.get", Value::Null)
                .await
                .ok()
                .and_then(|value| read_snapshot(&value));
            live_cohost_gate(snapshot.as_ref())
        });
        cx.spawn(async move |this, cx| {
            let Ok(gate) = job.await else {
                return;
            };
            let _ = this.update(cx, |pane, cx| {
                pane.cohost.gate = Some(gate);
                cx.notify();
            });
        })
        .detach();
    }

    fn read_packs(&mut self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request("cohost.pet.list", json!({})).await });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(value)) = job.await else {
                return;
            };
            let packs = serde_json::from_value::<Vec<PackSummary>>(value).unwrap_or_default();
            let _ = this.update(cx, |pane, cx| {
                pane.cohost.packs = Some(packs);
                cx.notify();
            });
        })
        .detach();
    }

    // --- What the pane reads -------------------------------------------------

    /// The live chat's session: the pane's actions name it, and Sidekick's
    /// list shows only while there is one (`mode === 'Live'`).
    pub(super) fn chat_session(&self) -> Option<String> {
        self.studio.live_chat().borrow().session_id.clone()
    }

    /// Recording or streaming (`onAir`).
    pub(super) fn on_air(&self) -> bool {
        self.studio.watch().borrow().session.phase.is_active()
    }

    /// Asked to start, not reading yet (`cohostStarting`).
    pub(super) fn cohost_starting(&self, live: bool) -> bool {
        live && self.settings.enabled
            && self
                .cohost
                .gate
                .as_ref()
                .is_some_and(EntitlementGate::allowed)
            && self.consented
            && self.state.status == "off"
    }

    /// The worn pack's reactions; `None` while an Alive pack is unread.
    pub(super) fn pack_reactions(&self) -> Option<Vec<String>> {
        let persona = self.settings.persona.as_ref()?;
        match (&persona.avatar, &self.cohost.packs) {
            (BuddyAvatar::Still, _) => Some(active_reactions(persona, &[])),
            (BuddyAvatar::Alive { .. }, Some(packs)) => Some(active_reactions(persona, packs)),
            (BuddyAvatar::Alive { .. }, None) => None,
        }
    }

    /// `cohostNudgeVisible`: live, allowed, consented, and simply off.
    pub(super) fn nudge_visible(&self, session: Option<&str>) -> bool {
        let Some(gate) = self.cohost.gate.as_ref() else {
            return false;
        };
        videorc_app_core::stream_manager::buddy::nudge_visible(
            session,
            gate.allowed(),
            self.consented,
            self.settings.enabled,
            self.studio
                .read_ui_settings(families::cohost_nudge_dismissed),
            self.cohost.nudge_dismissed_session.as_deref(),
        )
    }

    /// `cohostListenPromptVisible`, with Premium and consent as the pane's
    /// own gate.
    pub(super) fn listen_prompt_visible(&self) -> bool {
        let allowed = self
            .cohost
            .gate
            .as_ref()
            .is_some_and(EntitlementGate::allowed);
        let dismissed = self.cohost.listen_answered
            || self
                .studio
                .read_ui_settings(families::cohost_listen_prompt_dismissed);
        videorc_app_core::stream_manager::buddy::listen_prompt_visible(
            self.settings.enabled && self.consented && allowed,
            Some(self.settings.listen),
            dismissed,
        )
    }

    /// The Say box empties on the render after a line went out.
    pub(super) fn settle_say(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.cohost.clear_say {
            self.cohost.clear_say = false;
            self.cohost
                .say
                .update(cx, |input, cx| input.set_value("", window, cx));
        }
    }

    // --- The list's keys -----------------------------------------------------

    /// ⌘J: the list takes focus, so its keys run.
    pub fn focus_list(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cohost.list_focus.focus(window, cx);
        cx.notify();
    }

    pub(super) fn select_row(&mut self, key: String, window: &mut Window, cx: &mut Context<Self>) {
        self.cohost.selected = Some(key);
        self.cohost.list_focus.focus(window, cx);
        cx.notify();
    }

    pub(super) fn move_row(&mut self, delta: i64, cx: &mut Context<Self>) {
        let rows = pane_rows(&self.state);
        self.cohost.selected = move_selection(&rows, self.cohost.selected.as_deref(), delta);
        cx.notify();
    }

    pub(super) fn row_key(&mut self, key: RowKey, cx: &mut Context<Self>) {
        let rows = pane_rows(&self.state);
        if let Some(command) = row_command(&rows, self.cohost.selected.as_deref(), key) {
            self.run_row(command, cx);
        }
    }

    /// P1268: Remove from chat on the selected flag (Shift+Backspace).
    pub(super) fn remove_flagged(&mut self, cx: &mut Context<Self>) {
        let rows = pane_rows(&self.state);
        let Some(active) = resolve_selection(&rows, self.cohost.selected.as_deref()) else {
            return;
        };
        let Some(row) = rows.iter().find(|row| row.key == active) else {
            return;
        };
        if row.question {
            return;
        }
        if !self.flag_removable(&row.id) {
            return;
        }
        cx.emit(SidekickEvent::RemoveFromChat(row.id.clone()));
    }

    /// Whether the flagged message can still be removed (same rules as the
    /// chat row's ⋯ menu).
    pub(super) fn flag_removable(&self, message_id: &str) -> bool {
        let chat = self.studio.live_chat_now();
        if chat.session_id.is_none() {
            return false;
        }
        let Some(message) = chat.messages.iter().find(|m| m.id == message_id) else {
            return false;
        };
        let operations = self.studio.moderation_operations_now();
        let latest = latest_by_message(&operations);
        let operation = latest.get(message_id).copied();
        remove_from_chat_available(message, operation, false)
            && remove_from_chat_blocked_reason(message, &chat.providers).is_none()
    }

    pub(super) fn run_row(&mut self, command: RowCommand, cx: &mut Context<Self>) {
        let Some(session) = self.chat_session() else {
            return;
        };
        match command {
            RowCommand::Reply(id) => self.reply(&id, cx),
            RowCommand::ShowOnStream(id) => {
                let message = self
                    .state
                    .questions
                    .iter()
                    .find(|question| question.id == id)
                    .and_then(|question| question.message_ids.first().cloned());
                if let Some(message) = message {
                    cx.emit(SidekickEvent::ShowOnStream(message));
                }
            }
            RowCommand::Answered(id) => self.cohost_call(
                "cohost.question.answered",
                json!({ "sessionId": session, "questionId": id }),
                false,
                cx,
            ),
            RowCommand::DismissQuestion(id) => self.cohost_call(
                "cohost.question.dismiss",
                json!({ "sessionId": session, "questionId": id }),
                false,
                cx,
            ),
            RowCommand::DismissFlag(id) => self.cohost_call(
                "cohost.flag.dismiss",
                json!({ "sessionId": session, "messageId": id }),
                false,
                cx,
            ),
            RowCommand::Jump(id) => cx.emit(SidekickEvent::JumpTo(id)),
        }
    }

    /// Reply: the suggested reply, at the strictest destination's cap, in
    /// the composer. Nothing is sent.
    fn reply(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(question) = self.state.questions.iter().find(|q| q.id == id) else {
            return;
        };
        let chat = self.studio.live_chat();
        let targets: Vec<String> = writable_providers(&chat.borrow().providers)
            .into_iter()
            .map(|provider| provider.platform.clone())
            .collect();
        cx.emit(SidekickEvent::Prefill(draft_for_question(
            question, &targets,
        )));
    }

    // --- The cards' actions --------------------------------------------------

    pub(super) fn restore_question(&mut self, id: String, cx: &mut Context<Self>) {
        if let Some(session) = self.chat_session() {
            self.cohost_call(
                "cohost.question.restore",
                json!({ "sessionId": session, "questionId": id }),
                false,
                cx,
            );
        }
    }

    pub(super) fn close_promise(&mut self, id: String, done: bool, cx: &mut Context<Self>) {
        let method = if done {
            "cohost.promise.done"
        } else {
            "cohost.promise.dismiss"
        };
        if let Some(session) = self.chat_session() {
            self.cohost_call(
                method,
                json!({ "sessionId": session, "promiseId": id }),
                false,
                cx,
            );
        }
    }

    pub(super) fn draft_recap(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = self.chat_session() {
            self.cohost_call(
                "cohost.recap.draft",
                json!({ "sessionId": session }),
                true,
                cx,
            );
        }
    }

    pub(super) fn dismiss_recap(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = self.chat_session() {
            self.cohost_call(
                "cohost.recap.dismiss",
                json!({ "sessionId": session }),
                false,
                cx,
            );
        }
    }

    pub(super) fn post_recap(&mut self, cx: &mut Context<Self>) {
        if let Some(recap) = self.state.recap.as_ref() {
            cx.emit(SidekickEvent::Prefill(recap.text.clone()));
        }
    }

    pub(super) fn greeted(&mut self, author_key: String, cx: &mut Context<Self>) {
        if let Some(session) = self.chat_session() {
            self.cohost_call(
                "cohost.author.greeted",
                json!({ "sessionId": session, "authorKey": author_key }),
                false,
                cx,
            );
        }
    }

    /// One engine call that answers with the state. A drafted recap goes to
    /// the composer once it arrives.
    fn cohost_call(
        &mut self,
        method: &'static str,
        params: Value,
        prefill_recap: bool,
        cx: &mut Context<Self>,
    ) {
        if self.cohost.pending {
            return;
        }
        self.cohost.pending = true;
        cx.notify();
        let backend = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { backend.request(method, params).await });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |pane, cx| {
                pane.cohost.pending = false;
                match answer {
                    Ok(Ok(value)) => {
                        if let Ok(state) = serde_json::from_value::<CohostState>(value) {
                            let recap = state.recap.as_ref().map(|recap| recap.text.clone());
                            pane.receive_state(state, cx);
                            if prefill_recap && let Some(text) = recap.filter(|t| !t.is_empty()) {
                                cx.emit(SidekickEvent::Prefill(text));
                            }
                        }
                    }
                    Ok(Err(error)) => {
                        if let Some(command) =
                            toast_user_error(Failure::Rpc(&error), UPDATE_SIDEKICK, "cohost-action")
                        {
                            pane.studio.post_notices(vec![command]);
                        }
                    }
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Wave (plan 225 D11): the avatar waves on stream; nothing goes to chat.
    pub(super) fn wave(&mut self, person_id: String, cx: &mut Context<Self>) {
        self.quiet_call(
            "cohost.community.wave",
            json!({ "personId": person_id }),
            WAVE,
            "community-wave",
            cx,
        );
    }

    /// A reaction chip: the avatar plays it on air.
    pub(super) fn react(&mut self, reaction: &str, cx: &mut Context<Self>) {
        self.quiet_call(
            "cohost.pet.react",
            json!({ "reaction": reaction }),
            REACT,
            "buddy-react",
            cx,
        );
    }

    /// A call whose answer the pane doesn't read; a failure is one toast.
    fn quiet_call(
        &mut self,
        method: &'static str,
        params: Value,
        context: UserErrorContext,
        toast_id: &'static str,
        cx: &mut Context<Self>,
    ) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            if let Err(error) = studio.backend().request(method, params).await
                && let Some(command) = toast_user_error(Failure::Rpc(&error), context, toast_id)
            {
                studio.post_notices(vec![command]);
            }
        });
        cx.notify();
    }

    // --- The avatar ------------------------------------------------------------

    /// The Say box (plan 211 D2): the avatar says it in its bubble, talking
    /// (Enter) or laughing (secondary Enter). Nothing goes to chat.
    pub(super) fn say(&mut self, state: CohostUtteranceState, cx: &mut Context<Self>) {
        if self.cohost.say_pending {
            return;
        }
        let draft = self.cohost.say.read(cx).value().to_string();
        let Some(text) = say_text(&draft) else {
            return;
        };
        self.cohost.say_pending = true;
        self.cohost.clear_say = true;
        cx.notify();
        let mut params = json!({ "text": text, "state": state });
        if let Some(session) = self.chat_session() {
            params["sessionId"] = Value::String(session);
        }
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            studio
                .backend()
                .request("cohost.utterance.say", params)
                .await
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |pane, cx| {
                pane.cohost.say_pending = false;
                if let Ok(Err(error)) = answer
                    && let Some(command) = toast_user_error(Failure::Rpc(&error), SAY, "buddy-say")
                {
                    pane.studio.post_notices(vec![command]);
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// "{name} on stream": `overlayLayout.buddy.showOnStream`, the one
    /// overlay write (as the Studio's `buddy-show-on-stream`).
    pub(super) fn set_avatar_on_stream(&mut self, show: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let cached = self.cohost.layout.clone();
        let job = self.runtime.spawn(async move {
            let layout = match cached {
                Some(layout) => layout,
                None => studio.overlay_layout().await?,
            };
            Ok::<_, videorc_app_core::client::RpcError>(match with_buddy_on_stream(&layout, show) {
                Some(next) => studio.set_overlay_layout(next).await,
                None => Some(layout),
            })
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |pane, cx| {
                match answer {
                    Ok(Ok(Some(saved))) => pane.take_layout(saved),
                    Ok(Err(error)) => {
                        if let Some(command) =
                            toast_user_error(Failure::Rpc(&error), SHOW_AVATAR, "buddy-on-stream")
                        {
                            pane.studio.post_notices(vec![command]);
                        }
                    }
                    // A refused save already said so (`overlays.layout.set`).
                    Ok(Ok(None)) | Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    // --- The notices -----------------------------------------------------------

    /// The listening card's Turn on: listening on, Sidekick Live as it is.
    pub(super) fn listen_turn_on(&mut self, cx: &mut Context<Self>) {
        self.answer_listen_prompt(cx);
        let patch = enable_patch(Some(self.settings.enabled), true, Some(true), true);
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.settings.set", Value::Object(patch))
                .await
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |pane, cx| {
                match answer {
                    Ok(Ok(value)) => {
                        if let Some(settings) = CohostSettingsView::from_json(&value) {
                            pane.settings = settings;
                        }
                    }
                    Ok(Err(error)) => {
                        if let Some(command) = toast_user_error(
                            Failure::Rpc(&error),
                            TURN_ON_LISTENING,
                            "cohost-enable",
                        ) {
                            pane.studio.post_notices(vec![command]);
                        }
                    }
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Either answer on the listening card is final.
    pub(super) fn answer_listen_prompt(&mut self, cx: &mut Context<Self>) {
        self.cohost.listen_answered = true;
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio
                .write_settings(vec![families::write_cohost_listen_prompt_dismissed()])
                .await;
        });
        cx.notify();
    }

    /// The nudge's Turn on: Sidekick Live, through its own consent; the
    /// nudge leaves for this session.
    pub(super) fn nudge_turn_on(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cohost.nudge_dismissed_session = self.chat_session();
        self.set_live(true, window, cx);
    }

    /// The nudge's Dismiss: gone for this session and never offered again.
    pub(super) fn nudge_dismiss(&mut self, cx: &mut Context<Self>) {
        self.cohost.nudge_dismissed_session = self.chat_session();
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio
                .write_settings(vec![families::write_cohost_nudge_dismissed()])
                .await;
        });
        cx.notify();
    }
}
