//! The Golem on stream (plan 164, Phase C): the avatar's state machine and its
//! comic bubble, and the per-target PNG slot the compositor blits.
//!
//! The renderer rasterizes the avatar (state image plus bubble) per output
//! canvas and pushes it through `golem.overlay.set`; the backend owns WHICH
//! state shows and for how long. Every bubble, manual (the Say box through
//! `cohost.utterance.say`) or automatic (Phase D's greetings, answers and
//! banter), enters through [`show_bubble`], which is the one way a bubble
//! appears; [`show_for_utterance`] is the gate in front of it (which statuses
//! bubble, and nothing while the Golem is on no output). The state travels to
//! every window as the `cohost.golem.state` event.
//!
//! Transitions (D18): `idle` → (`think` while an answer is pending, optional)
//! → `talk` / `laugh` / `think` while a bubble is up → `idle` when it ends. A
//! new bubble replaces the current one (a laugh overrides a talk); the expiry
//! of a replaced bubble is a no-op.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::captions::{
    CaptionOverlaySlots, CaptionOverlayTarget, CaptionOverlayTargetsInfo, OverlayFallbackPlacement,
    OverlayPlacement,
};
use crate::cohost::{
    CohostAvatarState, CohostUtterance, CohostUtteranceState, CohostUtteranceStatus,
    CohostUtteranceTriggerKind,
};
use crate::overlay_layout::{OverlayItem, OverlayRect, OverlaySnap, load_overlay_layout};
use crate::state::AppState;

/// Event every renderer receives when the Golem's state or bubble changes.
pub const GOLEM_STATE_EVENT: &str = "cohost.golem.state";
/// A bubble stays at least this long (D17).
pub const GOLEM_BUBBLE_MIN: Duration = Duration::from_millis(2500);
/// ... plus this much per character ...
pub const GOLEM_BUBBLE_PER_CHAR: Duration = Duration::from_millis(60);
/// ... and never longer than this.
pub const GOLEM_BUBBLE_MAX: Duration = Duration::from_secs(10);

/// `max(2.5 s, 0.06 s × characters)`, capped at 10 s (D17).
pub fn golem_bubble_duration(text: &str) -> Duration {
    let per_text = GOLEM_BUBBLE_PER_CHAR.saturating_mul(text.chars().count() as u32);
    per_text.max(GOLEM_BUBBLE_MIN).min(GOLEM_BUBBLE_MAX)
}

impl From<CohostUtteranceState> for CohostAvatarState {
    fn from(state: CohostUtteranceState) -> Self {
        match state {
            CohostUtteranceState::Talk => CohostAvatarState::Talk,
            CohostUtteranceState::Laugh => CohostAvatarState::Laugh,
            CohostUtteranceState::Think => CohostAvatarState::Think,
        }
    }
}

/// The bubble on the wire: its text and when it ends (RFC 3339).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GolemBubble {
    pub text: String,
    pub until: String,
}

/// `cohost.golem.state`: `{ personaId, state, bubble: { text, until } | null }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GolemOverlaySnapshot {
    pub persona_id: String,
    pub state: CohostAvatarState,
    pub bubble: Option<GolemBubble>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GolemBubbleRecord {
    text: String,
    until: DateTime<Utc>,
    generation: u64,
}

/// The state machine. Pure and clock-injected; the runtime below owns the
/// lock, the event and the expiry timer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GolemOverlayState {
    persona_id: String,
    state: CohostAvatarState,
    bubble: Option<GolemBubbleRecord>,
    generation: u64,
}

impl GolemOverlayState {
    pub fn new(persona_id: impl Into<String>) -> Self {
        Self {
            persona_id: persona_id.into(),
            state: CohostAvatarState::Idle,
            bubble: None,
            generation: 0,
        }
    }

    #[cfg(test)]
    pub fn state(&self) -> CohostAvatarState {
        self.state
    }

    #[cfg(test)]
    pub fn persona_id(&self) -> &str {
        &self.persona_id
    }

    /// The persona whose images the renderer should draw.
    pub fn set_persona(&mut self, persona_id: impl Into<String>) {
        self.persona_id = persona_id.into();
    }

    /// `idle` → `think` while an answer is pending (D18). Nothing changes while
    /// a bubble is up: a bubble's state wins until it ends. Returns whether
    /// the state changed.
    pub fn think(&mut self) -> bool {
        if self.bubble.is_some() || self.state != CohostAvatarState::Idle {
            return false;
        }
        self.state = CohostAvatarState::Think;
        true
    }

    /// The one way a bubble appears: the text, the state it shows with and
    /// how long it stays. Replaces any bubble that is up (a laugh overrides a
    /// talk, a talk pre-empts a pending think). Returns the bubble's
    /// generation, which [`expire`](Self::expire) needs.
    pub fn show_bubble(
        &mut self,
        text: impl Into<String>,
        state: CohostUtteranceState,
        duration: Duration,
        now: DateTime<Utc>,
    ) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        let until = now
            + chrono::Duration::from_std(duration)
                .unwrap_or_else(|_| chrono::Duration::seconds(10));
        self.bubble = Some(GolemBubbleRecord {
            text: text.into(),
            until,
            generation: self.generation,
        });
        self.state = state.into();
        self.generation
    }

    /// Drop the bubble of `generation` once its time is up; `idle` follows.
    /// A replaced or already-gone bubble, or one still running, is a no-op.
    pub fn expire(&mut self, generation: u64, now: DateTime<Utc>) -> bool {
        let Some(bubble) = self.bubble.as_ref() else {
            return false;
        };
        if bubble.generation != generation || bubble.until > now {
            return false;
        }
        self.bubble = None;
        self.state = CohostAvatarState::Idle;
        true
    }

    /// A pending answer went nowhere: `think` → `idle`, unless a bubble is
    /// up (its state wins until it ends). Returns whether the state changed.
    pub fn settle(&mut self) -> bool {
        if self.bubble.is_some() || self.state != CohostAvatarState::Think {
            return false;
        }
        self.state = CohostAvatarState::Idle;
        true
    }

    /// Back to `idle` at once (a session boundary, a cleared pending answer).
    pub fn clear(&mut self) -> bool {
        let changed = self.bubble.is_some() || self.state != CohostAvatarState::Idle;
        self.bubble = None;
        self.state = CohostAvatarState::Idle;
        self.generation = self.generation.wrapping_add(1);
        changed
    }

    pub fn snapshot(&self) -> GolemOverlaySnapshot {
        GolemOverlaySnapshot {
            persona_id: self.persona_id.clone(),
            state: self.state,
            bubble: self.bubble.as_ref().map(|bubble| GolemBubble {
                text: bubble.text.clone(),
                until: bubble.until.to_rfc3339(),
            }),
        }
    }
}

pub type GolemOverlayStateSlot = Arc<tokio::sync::Mutex<GolemOverlayState>>;

pub fn new_golem_overlay_state_slot(persona_id: impl Into<String>) -> GolemOverlayStateSlot {
    Arc::new(tokio::sync::Mutex::new(GolemOverlayState::new(persona_id)))
}

// --- Runtime ---------------------------------------------------------------------

/// A manual line is clipped like a chat message (1 to 200 characters).
pub const GOLEM_SAY_MAX_CHARS: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum GolemSayError {
    #[error("Say something first.")]
    Empty,
    #[error("Keep it under {GOLEM_SAY_MAX_CHARS} characters.")]
    TooLong,
}

/// The text a bubble shows: trimmed, inner whitespace collapsed, 1 to
/// [`GOLEM_SAY_MAX_CHARS`] characters.
pub fn validate_say_text(text: &str) -> Result<String, GolemSayError> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(GolemSayError::Empty);
    }
    if text.chars().count() > GOLEM_SAY_MAX_CHARS {
        return Err(GolemSayError::TooLong);
    }
    Ok(text)
}

/// The current state for a renderer that just connected (`cohost.golem.status`).
pub async fn status(app: &AppState) -> GolemOverlaySnapshot {
    app.golem_overlay_state.lock().await.snapshot()
}

/// Whether the Golem is on any output: `overlayLayout.golem.showOnStream` or
/// `showInRecording`. With both off nothing is shown (the compositor flags
/// are untouched; the bubble and the think are simply skipped, D7).
pub fn overlay_enabled(app: &AppState) -> bool {
    let golem = load_overlay_layout(&app.database).golem;
    golem.show_on_stream || golem.show_in_recording
}

/// Whether an utterance's words belong in the bubble: a line that reached
/// chat (`sent`), one that was never meant for chat (`bubble-only`), or the
/// streamer's own line from the Say box, which bubbles the moment it is
/// typed, whatever its send does later.
pub fn utterance_bubbles(utterance: &CohostUtterance) -> bool {
    matches!(
        utterance.status,
        CohostUtteranceStatus::Sent | CohostUtteranceStatus::BubbleOnly
    ) || utterance.trigger.kind == CohostUtteranceTriggerKind::Manual
}

/// Phase D's utterances meet Phase C's bubble here (plan 164 D7/D18): the
/// bubble shows when [`utterance_bubbles`] says so and the Golem is on some
/// output. Returns the state as shown, or `None` when nothing was shown.
pub async fn show_for_utterance(
    app: &AppState,
    utterance: &CohostUtterance,
) -> Option<GolemOverlaySnapshot> {
    if !utterance_bubbles(utterance) || !overlay_enabled(app) {
        return None;
    }
    match show_bubble(app, &utterance.text, utterance.state).await {
        Ok(snapshot) => Some(snapshot),
        Err(error) => {
            app.emit_log(
                "warn",
                format!(
                    "Golem bubble skipped for utterance {}: {error}",
                    utterance.id
                ),
            );
            None
        }
    }
}

/// Show a bubble: THE entry point for every utterance. Validates the text,
/// stamps the current persona, runs the state machine, tells every window and
/// schedules the bubble's end. Returns the state as shown.
pub async fn show_bubble(
    app: &AppState,
    text: &str,
    state: CohostUtteranceState,
) -> Result<GolemOverlaySnapshot, GolemSayError> {
    let text = validate_say_text(text)?;
    let persona_id = crate::cohost::get_cohost_settings(app).await.persona.id;
    let duration = golem_bubble_duration(&text);
    let (snapshot, generation) = {
        let mut golem = app.golem_overlay_state.lock().await;
        golem.set_persona(persona_id);
        let generation = golem.show_bubble(text, state, duration, Utc::now());
        (golem.snapshot(), generation)
    };
    app.emit_event(GOLEM_STATE_EVENT, snapshot.clone());
    let app = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(duration).await;
        expire_bubble(&app, generation).await;
    });
    Ok(snapshot)
}

async fn expire_bubble(app: &AppState, generation: u64) {
    let snapshot = {
        let mut golem = app.golem_overlay_state.lock().await;
        if !golem.expire(generation, Utc::now()) {
            return;
        }
        golem.snapshot()
    };
    app.emit_event(GOLEM_STATE_EVENT, snapshot);
}

/// `idle` → `think` while an answer is pending (D18): the send path calls
/// this while an answer is on its way to chat, when the Golem is on some
/// output. Emits only on change.
pub async fn think(app: &AppState) -> GolemOverlaySnapshot {
    let (snapshot, changed) = {
        let mut golem = app.golem_overlay_state.lock().await;
        let changed = golem.think();
        (golem.snapshot(), changed)
    };
    if changed {
        app.emit_event(GOLEM_STATE_EVENT, snapshot.clone());
    }
    snapshot
}

/// A pending answer went nowhere: `think` → `idle` unless a bubble is up.
/// Emits only on change.
pub async fn settle(app: &AppState) -> GolemOverlaySnapshot {
    let (snapshot, changed) = {
        let mut golem = app.golem_overlay_state.lock().await;
        let changed = golem.settle();
        (golem.snapshot(), changed)
    };
    if changed {
        app.emit_event(GOLEM_STATE_EVENT, snapshot.clone());
    }
    snapshot
}

/// Back to `idle` at once (a session boundary: a bubble from before the
/// session never rides into the new video). Emits only on change.
pub async fn clear(app: &AppState) -> GolemOverlaySnapshot {
    let (snapshot, changed) = {
        let mut golem = app.golem_overlay_state.lock().await;
        let changed = golem.clear();
        (golem.snapshot(), changed)
    };
    if changed {
        app.emit_event(GOLEM_STATE_EVENT, snapshot.clone());
    }
    snapshot
}

// --- The PNG slot ------------------------------------------------------------------

/// `golem.overlay.set { target, pngBase64, rect }`: the renderer's raster of
/// the avatar (and bubble) for one output canvas, blitted inside `rect`. A
/// push without a rect lands on the Golem's default corner for the canvas
/// orientation.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGolemOverlayParams {
    pub png_base64: String,
    #[serde(default)]
    pub target: Option<CaptionOverlayTarget>,
    #[serde(default)]
    pub rect: Option<OverlayRect>,
}

pub fn golem_overlay_placement(rect: Option<OverlayRect>) -> OverlayPlacement {
    OverlayPlacement::new(
        rect,
        OverlayFallbackPlacement {
            item: OverlayItem::Golem,
            snap: OverlaySnap::BottomRight,
        },
    )
}

pub fn install_golem_overlay(
    slots: &CaptionOverlaySlots,
    params: SetGolemOverlayParams,
) -> anyhow::Result<CaptionOverlayTargetsInfo> {
    crate::captions::install_overlay_targets(
        slots,
        &params.png_base64,
        params.target,
        golem_overlay_placement(params.rect),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::<Utc>::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
    }

    #[test]
    fn bubble_duration_scales_with_text_between_the_floor_and_the_cap() {
        assert_eq!(golem_bubble_duration(""), GOLEM_BUBBLE_MIN);
        assert_eq!(golem_bubble_duration("hi"), GOLEM_BUBBLE_MIN);
        // 50 characters × 60 ms = 3 s.
        assert_eq!(
            golem_bubble_duration(&"x".repeat(50)),
            Duration::from_secs(3)
        );
        assert_eq!(golem_bubble_duration(&"x".repeat(200)), GOLEM_BUBBLE_MAX);
    }

    #[test]
    fn idle_talk_idle() {
        let mut golem = GolemOverlayState::new("default");
        assert_eq!(golem.state(), CohostAvatarState::Idle);
        let generation = golem.show_bubble(
            "Welcome to the horde",
            CohostUtteranceState::Talk,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(golem.state(), CohostAvatarState::Talk);
        let snapshot = golem.snapshot();
        assert_eq!(
            snapshot.bubble.as_ref().unwrap().text,
            "Welcome to the horde"
        );
        assert_eq!(snapshot.bubble.as_ref().unwrap().until, at(3).to_rfc3339());
        // Not yet.
        assert!(!golem.expire(generation, at(2)));
        assert_eq!(golem.state(), CohostAvatarState::Talk);
        assert!(golem.expire(generation, at(3)));
        assert_eq!(golem.state(), CohostAvatarState::Idle);
        assert_eq!(golem.snapshot().bubble, None);
        // A second expiry is a no-op.
        assert!(!golem.expire(generation, at(4)));
    }

    #[test]
    fn think_is_pre_empted_by_talk_and_never_interrupts_a_bubble() {
        let mut golem = GolemOverlayState::new("default");
        assert!(golem.think());
        assert_eq!(golem.state(), CohostAvatarState::Think);
        assert!(!golem.think(), "already thinking");
        assert_eq!(golem.snapshot().bubble, None);
        let generation = golem.show_bubble(
            "Yes.",
            CohostUtteranceState::Talk,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(golem.state(), CohostAvatarState::Talk);
        assert!(!golem.think(), "a bubble's state wins until it ends");
        assert_eq!(golem.state(), CohostAvatarState::Talk);
        assert!(golem.expire(generation, at(3)));
        assert_eq!(golem.state(), CohostAvatarState::Idle);
        assert!(golem.think());
    }

    #[test]
    fn laugh_overrides_talk_and_the_old_expiry_is_a_no_op() {
        let mut golem = GolemOverlayState::new("default");
        let talk = golem.show_bubble(
            "one",
            CohostUtteranceState::Talk,
            Duration::from_secs(5),
            at(0),
        );
        let laugh = golem.show_bubble(
            "ha",
            CohostUtteranceState::Laugh,
            Duration::from_secs(3),
            at(1),
        );
        assert_ne!(talk, laugh);
        assert_eq!(golem.state(), CohostAvatarState::Laugh);
        assert_eq!(golem.snapshot().bubble.unwrap().text, "ha");
        // The replaced talk bubble's timer fires: nothing happens.
        assert!(!golem.expire(talk, at(5)));
        assert_eq!(golem.state(), CohostAvatarState::Laugh);
        assert!(golem.expire(laugh, at(4)));
        assert_eq!(golem.state(), CohostAvatarState::Idle);
    }

    #[test]
    fn clear_drops_everything_and_invalidates_the_running_expiry() {
        let mut golem = GolemOverlayState::new("default");
        assert!(!golem.clear(), "nothing to clear");
        let generation = golem.show_bubble(
            "x",
            CohostUtteranceState::Think,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(golem.state(), CohostAvatarState::Think);
        assert!(golem.clear());
        assert_eq!(golem.state(), CohostAvatarState::Idle);
        assert!(!golem.expire(generation, at(3)));
        golem.set_persona("p2");
        assert_eq!(golem.persona_id(), "p2");
    }

    #[test]
    fn wire_shape_is_camel_case_with_a_null_bubble() {
        let golem = GolemOverlayState::new("default");
        let value = serde_json::to_value(golem.snapshot()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "personaId": "default", "state": "idle", "bubble": null })
        );
        let mut golem = golem;
        golem.show_bubble(
            "Hello horde",
            CohostUtteranceState::Laugh,
            Duration::from_secs(3),
            at(0),
        );
        let value = serde_json::to_value(golem.snapshot()).unwrap();
        assert_eq!(value["state"], "laugh");
        assert_eq!(value["bubble"]["text"], "Hello horde");
        assert!(value["bubble"]["until"].is_string());
        let round_trip: GolemOverlaySnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, golem.snapshot());
    }

    #[test]
    fn say_text_is_trimmed_collapsed_and_bounded() {
        assert_eq!(
            validate_say_text("  hello   horde  ").unwrap(),
            "hello horde"
        );
        assert!(matches!(
            validate_say_text("   "),
            Err(GolemSayError::Empty)
        ));
        assert!(matches!(
            validate_say_text(&"x".repeat(201)),
            Err(GolemSayError::TooLong)
        ));
        assert_eq!(validate_say_text(&"x".repeat(200)).unwrap().len(), 200);
    }

    #[test]
    fn settle_ends_a_think_but_never_a_bubble() {
        let mut golem = GolemOverlayState::new("default");
        assert!(!golem.settle(), "idle stays idle");
        assert!(golem.think());
        assert!(golem.settle());
        assert_eq!(golem.state(), CohostAvatarState::Idle);
        golem.show_bubble(
            "x",
            CohostUtteranceState::Think,
            Duration::from_secs(3),
            at(0),
        );
        assert!(!golem.settle(), "a bubble's think is the bubble's");
        assert_eq!(golem.state(), CohostAvatarState::Think);
    }

    #[test]
    fn overlay_params_default_to_the_golem_corner_and_keep_a_placed_rect() {
        let params: SetGolemOverlayParams =
            serde_json::from_value(serde_json::json!({ "pngBase64": "AAAA" })).unwrap();
        assert_eq!(params.target, None);
        let placement = golem_overlay_placement(params.rect);
        assert_eq!(
            placement.rect_for_canvas(1920, 1080),
            crate::overlay_layout::overlay_snap_rect(
                OverlayItem::Golem,
                crate::overlay_layout::OverlayOrientation::Horizontal,
                OverlaySnap::BottomRight
            )
        );
        assert_eq!(
            placement.rect_for_canvas(1080, 1920),
            crate::overlay_layout::overlay_snap_rect(
                OverlayItem::Golem,
                crate::overlay_layout::OverlayOrientation::Vertical,
                OverlaySnap::BottomRight
            )
        );
        let params: SetGolemOverlayParams = serde_json::from_value(serde_json::json!({
            "pngBase64": "AAAA",
            "target": "auxiliary",
            "rect": { "x": 0.1, "y": 0.2, "w": 0.25, "h": 0.2 }
        }))
        .unwrap();
        assert_eq!(params.target, Some(CaptionOverlayTarget::Auxiliary));
        assert_eq!(
            golem_overlay_placement(params.rect).rect_for_canvas(1280, 720),
            OverlayRect::new(0.1, 0.2, 0.25, 0.2)
        );
        // A bad payload is refused; nothing is installed.
        let slots = crate::captions::new_caption_overlay_slots();
        assert!(install_golem_overlay(&slots, params).is_err());
        assert!(!crate::captions::caption_overlay_targets_metadata(&slots).active);
    }

    fn test_app() -> (
        AppState,
        tokio::sync::broadcast::Receiver<crate::protocol::ServerEvent>,
    ) {
        let (events, rx) = tokio::sync::broadcast::channel(16);
        let app = AppState::new(
            "fixture".into(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        );
        (app, rx)
    }

    fn golem_output_switches(app: &AppState, show_on_stream: bool, show_in_recording: bool) {
        let mut layout = load_overlay_layout(&app.database);
        layout.golem.show_on_stream = show_on_stream;
        layout.golem.show_in_recording = show_in_recording;
        crate::overlay_layout::save_overlay_layout(&app.database, &layout).unwrap();
    }

    fn utterance(
        trigger: CohostUtteranceTriggerKind,
        status: CohostUtteranceStatus,
        text: &str,
    ) -> CohostUtterance {
        CohostUtterance {
            id: format!("utt-{text}"),
            text: text.to_string(),
            state: CohostUtteranceState::Laugh,
            trigger: crate::cohost::CohostUtteranceTrigger {
                kind: trigger,
                event_id: None,
                message_id: None,
            },
            destination_ids: Vec::new(),
            status,
            at: "2026-10-08T12:00:00Z".to_string(),
            expires_at: None,
        }
    }

    #[tokio::test]
    async fn show_bubble_tells_every_window_and_ends_it() {
        let (app, mut rx) = test_app();
        assert_eq!(status(&app).await.state, CohostAvatarState::Idle);
        assert!(
            show_bubble(&app, "   ", CohostUtteranceState::Talk)
                .await
                .is_err()
        );
        let shown = show_bubble(&app, "Hello horde", CohostUtteranceState::Laugh)
            .await
            .unwrap();
        assert_eq!(shown.state, CohostAvatarState::Laugh);
        assert_eq!(shown.persona_id, crate::cohost::COHOST_DEFAULT_PERSONA_ID);
        assert_eq!(shown.bubble.as_ref().unwrap().text, "Hello horde");
        let event = rx.recv().await.unwrap();
        assert_eq!(event.event, GOLEM_STATE_EVENT);
        assert_eq!(event.payload["state"], "laugh");
        assert_eq!(status(&app).await, shown);
        // think never interrupts a bubble; clear ends it at once and says so.
        assert_eq!(think(&app).await.state, CohostAvatarState::Laugh);
        assert_eq!(clear(&app).await.state, CohostAvatarState::Idle);
        let event = rx.recv().await.unwrap();
        assert_eq!(event.payload["bubble"], serde_json::Value::Null);
        assert_eq!(think(&app).await.state, CohostAvatarState::Think);
        assert_eq!(settle(&app).await.state, CohostAvatarState::Idle);
    }

    /// Plan 164 D7/D18: a sent utterance and a bubble-only one bubble; a
    /// proposed, dismissed or failed one does not.
    #[tokio::test]
    async fn sent_and_bubble_only_utterances_bubble_the_rest_do_not() {
        let (app, mut rx) = test_app();
        golem_output_switches(&app, true, false);
        let sent = utterance(
            CohostUtteranceTriggerKind::Greeting,
            CohostUtteranceStatus::Sent,
            "Welcome Fan0!",
        );
        let shown = show_for_utterance(&app, &sent).await.unwrap();
        assert_eq!(shown.state, CohostAvatarState::Laugh);
        assert_eq!(shown.bubble.as_ref().unwrap().text, "Welcome Fan0!");
        assert_eq!(
            rx.recv().await.unwrap().payload["bubble"]["text"],
            "Welcome Fan0!"
        );
        let bubble_only = utterance(
            CohostUtteranceTriggerKind::Manual,
            CohostUtteranceStatus::BubbleOnly,
            "Just the bubble",
        );
        let shown = show_for_utterance(&app, &bubble_only).await.unwrap();
        assert_eq!(shown.bubble.as_ref().unwrap().text, "Just the bubble");
        assert_eq!(
            rx.recv().await.unwrap().payload["bubble"]["text"],
            "Just the bubble"
        );
        for status in [
            CohostUtteranceStatus::Proposed,
            CohostUtteranceStatus::Dismissed,
            CohostUtteranceStatus::Failed,
        ] {
            let silent = utterance(CohostUtteranceTriggerKind::Answer, status, "never shown");
            assert!(!utterance_bubbles(&silent));
            assert_eq!(show_for_utterance(&app, &silent).await, None);
        }
        assert_eq!(status(&app).await.bubble.unwrap().text, "Just the bubble");
        assert!(rx.try_recv().is_err(), "nothing else was emitted");
    }

    /// Plan 164 D7: with `showOnStream` and `showInRecording` both off the
    /// bubble is skipped; either switch on brings it back.
    #[tokio::test]
    async fn both_output_switches_off_means_no_bubble() {
        let (app, mut rx) = test_app();
        assert!(!overlay_enabled(&app), "the Golem ships off/off");
        let sent = utterance(
            CohostUtteranceTriggerKind::Answer,
            CohostUtteranceStatus::Sent,
            "It is a Keychron.",
        );
        assert!(utterance_bubbles(&sent));
        assert_eq!(show_for_utterance(&app, &sent).await, None);
        assert_eq!(status(&app).await.bubble, None);
        assert!(rx.try_recv().is_err(), "no event with the Golem off");
        golem_output_switches(&app, false, true);
        assert!(overlay_enabled(&app));
        assert!(show_for_utterance(&app, &sent).await.is_some());
        assert_eq!(
            rx.recv().await.unwrap().payload["bubble"]["text"],
            "It is a Keychron."
        );
    }
}
