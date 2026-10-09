//! The Buddy on stream (plan 164, Phase C): the avatar's state machine and its
//! comic bubble, and the per-target bubble slot the compositor blits.
//!
//! Since plan 168 Phase B the backend draws the pet itself (`buddy_sprite`);
//! the renderer rasterizes the bubble only, per output canvas, and pushes it
//! through `buddy.overlay.set` (`buddy.overlay.clear` when it ends). The
//! compositor anchors the bubble above the pet's head (D16). The backend owns
//! WHICH state shows and for how long. Every bubble, manual (the Say box through
//! `cohost.utterance.say`) or automatic (Phase D's greetings, answers and
//! banter), enters through [`show_bubble`], which is the one way a bubble
//! appears; [`show_for_utterance`] is the gate in front of it (which statuses
//! bubble, and nothing while the Buddy is on no output). The state travels to
//! every window as the `cohost.buddy.state` event.
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
use crate::buddy_animator::BuddyAnimatorEvent;
use crate::overlay_layout::{OverlayItem, OverlayRect, OverlaySnap, load_overlay_layout};
use crate::state::AppState;

/// Event every renderer receives when the Buddy's state or bubble changes.
pub const BUDDY_STATE_EVENT: &str = "cohost.buddy.state";
/// A bubble stays at least this long (D17).
pub const BUDDY_BUBBLE_MIN: Duration = Duration::from_millis(2500);
/// ... plus this much per character ...
pub const BUDDY_BUBBLE_PER_CHAR: Duration = Duration::from_millis(60);
/// ... and never longer than this.
pub const BUDDY_BUBBLE_MAX: Duration = Duration::from_secs(10);

/// `max(2.5 s, 0.06 s × characters)`, capped at 10 s (D17).
pub fn buddy_bubble_duration(text: &str) -> Duration {
    let per_text = BUDDY_BUBBLE_PER_CHAR.saturating_mul(text.chars().count() as u32);
    per_text.max(BUDDY_BUBBLE_MIN).min(BUDDY_BUBBLE_MAX)
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
pub struct BuddyBubble {
    pub text: String,
    pub until: String,
}

/// `cohost.buddy.state`: `{ personaId, state, bubble: { text, until } | null }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuddyOverlaySnapshot {
    pub persona_id: String,
    pub state: CohostAvatarState,
    pub bubble: Option<BuddyBubble>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BuddyBubbleRecord {
    text: String,
    until: DateTime<Utc>,
    generation: u64,
}

/// The state machine. Pure and clock-injected; the runtime below owns the
/// lock, the event and the expiry timer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuddyOverlayState {
    persona_id: String,
    state: CohostAvatarState,
    bubble: Option<BuddyBubbleRecord>,
    generation: u64,
}

impl BuddyOverlayState {
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
        self.bubble = Some(BuddyBubbleRecord {
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

    pub fn snapshot(&self) -> BuddyOverlaySnapshot {
        BuddyOverlaySnapshot {
            persona_id: self.persona_id.clone(),
            state: self.state,
            bubble: self.bubble.as_ref().map(|bubble| BuddyBubble {
                text: bubble.text.clone(),
                until: bubble.until.to_rfc3339(),
            }),
        }
    }
}

pub type BuddyOverlayStateSlot = Arc<tokio::sync::Mutex<BuddyOverlayState>>;

pub fn new_buddy_overlay_state_slot(persona_id: impl Into<String>) -> BuddyOverlayStateSlot {
    Arc::new(tokio::sync::Mutex::new(BuddyOverlayState::new(persona_id)))
}

// --- Runtime ---------------------------------------------------------------------

/// A manual line is clipped like a chat message (1 to 200 characters).
pub const BUDDY_SAY_MAX_CHARS: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum BuddySayError {
    #[error("Say something first.")]
    Empty,
    #[error("Keep it under {BUDDY_SAY_MAX_CHARS} characters.")]
    TooLong,
}

/// The text a bubble shows: trimmed, inner whitespace collapsed, 1 to
/// [`BUDDY_SAY_MAX_CHARS`] characters.
pub fn validate_say_text(text: &str) -> Result<String, BuddySayError> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(BuddySayError::Empty);
    }
    if text.chars().count() > BUDDY_SAY_MAX_CHARS {
        return Err(BuddySayError::TooLong);
    }
    Ok(text)
}

/// The current state for a renderer that just connected (`cohost.buddy.status`).
pub async fn status(app: &AppState) -> BuddyOverlaySnapshot {
    app.buddy_overlay_state.lock().await.snapshot()
}

/// Whether the Buddy is on any output: `overlayLayout.buddy.showOnStream` or
/// `showInRecording`. With both off nothing is shown (the compositor flags
/// are untouched; the bubble and the think are simply skipped, D7).
pub fn overlay_enabled(app: &AppState) -> bool {
    let buddy = load_overlay_layout(&app.database).buddy;
    buddy.show_on_stream || buddy.show_in_recording
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
/// bubble shows when [`utterance_bubbles`] says so and the Buddy is on some
/// output. Returns the state as shown, or `None` when nothing was shown.
pub async fn show_for_utterance(
    app: &AppState,
    utterance: &CohostUtterance,
) -> Option<BuddyOverlaySnapshot> {
    if !utterance_bubbles(utterance) || !overlay_enabled(app) {
        return None;
    }
    match show_bubble(app, &utterance.text, utterance.state).await {
        Ok(snapshot) => Some(snapshot),
        Err(error) => {
            app.emit_log(
                "warn",
                format!(
                    "Buddy bubble skipped for utterance {}: {error}",
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
) -> Result<BuddyOverlaySnapshot, BuddySayError> {
    let text = validate_say_text(text)?;
    let persona_id = crate::cohost::get_cohost_settings(app).await.persona.id;
    let duration = buddy_bubble_duration(&text);
    let chars = text.chars().count();
    let (snapshot, generation) = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        buddy.set_persona(persona_id);
        let generation = buddy.show_bubble(text, state, duration, Utc::now());
        (buddy.snapshot(), generation)
    };
    publish_state(
        app,
        snapshot.clone(),
        Some(BuddyAnimatorEvent::UtteranceStart {
            state,
            chars,
            bubble_seconds: duration.as_secs_f64(),
        }),
    );
    let app = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(duration).await;
        expire_bubble(&app, generation).await;
    });
    Ok(snapshot)
}

/// Tell every window, and the pet on stream: the state and the event that
/// changed it reach the animator together (plan 168 S-C3).
fn publish_state(
    app: &AppState,
    snapshot: BuddyOverlaySnapshot,
    animator_event: Option<BuddyAnimatorEvent>,
) {
    app.buddy_sprite
        .set_avatar_state_and_notify(snapshot.state, animator_event);
    app.emit_event(BUDDY_STATE_EVENT, snapshot);
}

async fn expire_bubble(app: &AppState, generation: u64) {
    let snapshot = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        if !buddy.expire(generation, Utc::now()) {
            return;
        }
        buddy.snapshot()
    };
    publish_state(app, snapshot, Some(BuddyAnimatorEvent::UtteranceEnd));
}

/// `idle` → `think` while an answer is pending (D18): the send path calls
/// this while an answer is on its way to chat, when the Buddy is on some
/// output. Emits only on change.
pub async fn think(app: &AppState) -> BuddyOverlaySnapshot {
    let (snapshot, changed) = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        let changed = buddy.think();
        (buddy.snapshot(), changed)
    };
    if changed {
        publish_state(app, snapshot.clone(), Some(BuddyAnimatorEvent::ThinkStart));
    }
    snapshot
}

/// A pending answer went nowhere: `think` → `idle` unless a bubble is up.
/// Emits only on change.
pub async fn settle(app: &AppState) -> BuddyOverlaySnapshot {
    let (snapshot, changed) = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        let changed = buddy.settle();
        (buddy.snapshot(), changed)
    };
    if changed {
        publish_state(app, snapshot.clone(), Some(BuddyAnimatorEvent::ThinkSettle));
    }
    snapshot
}

/// Back to `idle` at once (a session boundary: a bubble from before the
/// session never rides into the new video). Emits only on change.
pub async fn clear(app: &AppState) -> BuddyOverlaySnapshot {
    let (snapshot, changed) = {
        let mut buddy = app.buddy_overlay_state.lock().await;
        let changed = buddy.clear();
        (buddy.snapshot(), changed)
    };
    if changed {
        // Idle at once: the animator drops the bubble and the pending answer.
        publish_state(
            app,
            snapshot.clone(),
            Some(BuddyAnimatorEvent::UtteranceEnd),
        );
    }
    snapshot
}

// --- The bubble slot ----------------------------------------------------------------

/// `buddy.overlay.set { target, pngBase64, rect }`: the renderer's raster of
/// the bubble for one output canvas (plan 168 D16: the bubble only, its tail
/// tip on the bitmap's bottom-centre). `rect` is the Buddy's rect the bubble
/// was wrapped for; the compositor anchors the bitmap above the pet's head,
/// or, where no pet frame exists (tests, older callers), inside `rect` (a push
/// without one lands on the Buddy's default corner).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBuddyOverlayParams {
    pub png_base64: String,
    #[serde(default)]
    pub target: Option<CaptionOverlayTarget>,
    #[serde(default)]
    pub rect: Option<OverlayRect>,
}

/// `buddy.overlay.clear { target? }`: the bubble ended; both targets without
/// one.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearBuddyOverlayParams {
    #[serde(default)]
    pub target: Option<CaptionOverlayTarget>,
}

pub fn buddy_overlay_placement(rect: Option<OverlayRect>) -> OverlayPlacement {
    OverlayPlacement::new(
        rect,
        OverlayFallbackPlacement {
            item: OverlayItem::Buddy,
            snap: OverlaySnap::BottomRight,
        },
    )
}

#[cfg(test)]
pub fn install_buddy_overlay(
    slots: &CaptionOverlaySlots,
    params: SetBuddyOverlayParams,
) -> anyhow::Result<CaptionOverlayTargetsInfo> {
    crate::captions::install_overlay_targets(
        slots,
        &params.png_base64,
        params.target,
        buddy_overlay_placement(params.rect),
    )
}

/// `buddy.overlay.set`: decode the bubble off the async runtime (like the
/// highlight card), then one bounded swap into the slot.
pub async fn set_buddy_overlay(
    slots: &CaptionOverlaySlots,
    params: SetBuddyOverlayParams,
) -> anyhow::Result<CaptionOverlayTargetsInfo> {
    let SetBuddyOverlayParams {
        png_base64,
        target,
        rect,
    } = params;
    let prepared =
        tokio::task::spawn_blocking(move || crate::captions::prepare_caption_overlay(&png_base64))
            .await
            .map_err(|error| anyhow::anyhow!("Buddy bubble preparation stopped: {error}"))??;
    Ok(crate::captions::install_prepared_overlay_targets(
        slots,
        prepared,
        target,
        buddy_overlay_placement(rect),
    ))
}

/// `buddy.overlay.clear`: drop the bubble raster of one target, or both.
pub fn clear_buddy_overlay(
    slots: &CaptionOverlaySlots,
    params: ClearBuddyOverlayParams,
) -> anyhow::Result<CaptionOverlayTargetsInfo> {
    crate::captions::clear_caption_overlays(
        slots,
        crate::captions::ClearCaptionOverlayParams {
            target: params.target,
            style_revision: None,
        },
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
        assert_eq!(buddy_bubble_duration(""), BUDDY_BUBBLE_MIN);
        assert_eq!(buddy_bubble_duration("hi"), BUDDY_BUBBLE_MIN);
        // 50 characters × 60 ms = 3 s.
        assert_eq!(
            buddy_bubble_duration(&"x".repeat(50)),
            Duration::from_secs(3)
        );
        assert_eq!(buddy_bubble_duration(&"x".repeat(200)), BUDDY_BUBBLE_MAX);
    }

    #[test]
    fn idle_talk_idle() {
        let mut buddy = BuddyOverlayState::new("default");
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        let generation = buddy.show_bubble(
            "Welcome to the horde",
            CohostUtteranceState::Talk,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(buddy.state(), CohostAvatarState::Talk);
        let snapshot = buddy.snapshot();
        assert_eq!(
            snapshot.bubble.as_ref().unwrap().text,
            "Welcome to the horde"
        );
        assert_eq!(snapshot.bubble.as_ref().unwrap().until, at(3).to_rfc3339());
        // Not yet.
        assert!(!buddy.expire(generation, at(2)));
        assert_eq!(buddy.state(), CohostAvatarState::Talk);
        assert!(buddy.expire(generation, at(3)));
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        assert_eq!(buddy.snapshot().bubble, None);
        // A second expiry is a no-op.
        assert!(!buddy.expire(generation, at(4)));
    }

    #[test]
    fn think_is_pre_empted_by_talk_and_never_interrupts_a_bubble() {
        let mut buddy = BuddyOverlayState::new("default");
        assert!(buddy.think());
        assert_eq!(buddy.state(), CohostAvatarState::Think);
        assert!(!buddy.think(), "already thinking");
        assert_eq!(buddy.snapshot().bubble, None);
        let generation = buddy.show_bubble(
            "Yes.",
            CohostUtteranceState::Talk,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(buddy.state(), CohostAvatarState::Talk);
        assert!(!buddy.think(), "a bubble's state wins until it ends");
        assert_eq!(buddy.state(), CohostAvatarState::Talk);
        assert!(buddy.expire(generation, at(3)));
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        assert!(buddy.think());
    }

    #[test]
    fn laugh_overrides_talk_and_the_old_expiry_is_a_no_op() {
        let mut buddy = BuddyOverlayState::new("default");
        let talk = buddy.show_bubble(
            "one",
            CohostUtteranceState::Talk,
            Duration::from_secs(5),
            at(0),
        );
        let laugh = buddy.show_bubble(
            "ha",
            CohostUtteranceState::Laugh,
            Duration::from_secs(3),
            at(1),
        );
        assert_ne!(talk, laugh);
        assert_eq!(buddy.state(), CohostAvatarState::Laugh);
        assert_eq!(buddy.snapshot().bubble.unwrap().text, "ha");
        // The replaced talk bubble's timer fires: nothing happens.
        assert!(!buddy.expire(talk, at(5)));
        assert_eq!(buddy.state(), CohostAvatarState::Laugh);
        assert!(buddy.expire(laugh, at(4)));
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
    }

    #[test]
    fn clear_drops_everything_and_invalidates_the_running_expiry() {
        let mut buddy = BuddyOverlayState::new("default");
        assert!(!buddy.clear(), "nothing to clear");
        let generation = buddy.show_bubble(
            "x",
            CohostUtteranceState::Think,
            Duration::from_secs(3),
            at(0),
        );
        assert_eq!(buddy.state(), CohostAvatarState::Think);
        assert!(buddy.clear());
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        assert!(!buddy.expire(generation, at(3)));
        buddy.set_persona("p2");
        assert_eq!(buddy.persona_id(), "p2");
    }

    #[test]
    fn wire_shape_is_camel_case_with_a_null_bubble() {
        let buddy = BuddyOverlayState::new("default");
        let value = serde_json::to_value(buddy.snapshot()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "personaId": "default", "state": "idle", "bubble": null })
        );
        let mut buddy = buddy;
        buddy.show_bubble(
            "Hello horde",
            CohostUtteranceState::Laugh,
            Duration::from_secs(3),
            at(0),
        );
        let value = serde_json::to_value(buddy.snapshot()).unwrap();
        assert_eq!(value["state"], "laugh");
        assert_eq!(value["bubble"]["text"], "Hello horde");
        assert!(value["bubble"]["until"].is_string());
        let round_trip: BuddyOverlaySnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, buddy.snapshot());
    }

    #[test]
    fn say_text_is_trimmed_collapsed_and_bounded() {
        assert_eq!(
            validate_say_text("  hello   horde  ").unwrap(),
            "hello horde"
        );
        assert!(matches!(
            validate_say_text("   "),
            Err(BuddySayError::Empty)
        ));
        assert!(matches!(
            validate_say_text(&"x".repeat(201)),
            Err(BuddySayError::TooLong)
        ));
        assert_eq!(validate_say_text(&"x".repeat(200)).unwrap().len(), 200);
    }

    #[test]
    fn settle_ends_a_think_but_never_a_bubble() {
        let mut buddy = BuddyOverlayState::new("default");
        assert!(!buddy.settle(), "idle stays idle");
        assert!(buddy.think());
        assert!(buddy.settle());
        assert_eq!(buddy.state(), CohostAvatarState::Idle);
        buddy.show_bubble(
            "x",
            CohostUtteranceState::Think,
            Duration::from_secs(3),
            at(0),
        );
        assert!(!buddy.settle(), "a bubble's think is the bubble's");
        assert_eq!(buddy.state(), CohostAvatarState::Think);
    }

    #[test]
    fn overlay_params_default_to_the_buddy_corner_and_keep_a_placed_rect() {
        let params: SetBuddyOverlayParams =
            serde_json::from_value(serde_json::json!({ "pngBase64": "AAAA" })).unwrap();
        assert_eq!(params.target, None);
        let placement = buddy_overlay_placement(params.rect);
        assert_eq!(
            placement.rect_for_canvas(1920, 1080),
            crate::overlay_layout::overlay_snap_rect(
                OverlayItem::Buddy,
                crate::overlay_layout::OverlayOrientation::Horizontal,
                OverlaySnap::BottomRight
            )
        );
        assert_eq!(
            placement.rect_for_canvas(1080, 1920),
            crate::overlay_layout::overlay_snap_rect(
                OverlayItem::Buddy,
                crate::overlay_layout::OverlayOrientation::Vertical,
                OverlaySnap::BottomRight
            )
        );
        let params: SetBuddyOverlayParams = serde_json::from_value(serde_json::json!({
            "pngBase64": "AAAA",
            "target": "auxiliary",
            "rect": { "x": 0.1, "y": 0.2, "w": 0.25, "h": 0.2 }
        }))
        .unwrap();
        assert_eq!(params.target, Some(CaptionOverlayTarget::Auxiliary));
        assert_eq!(
            buddy_overlay_placement(params.rect).rect_for_canvas(1280, 720),
            OverlayRect::new(0.1, 0.2, 0.25, 0.2)
        );
        // A bad payload is refused; nothing is installed.
        let slots = crate::captions::new_caption_overlay_slots();
        assert!(install_buddy_overlay(&slots, params).is_err());
        assert!(!crate::captions::caption_overlay_targets_metadata(&slots).active);
    }

    fn bubble_png(width: u32, height: u32) -> String {
        use base64::Engine as _;
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([250, 250, 251, 255]),
        ))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("test png encodes");
        base64::engine::general_purpose::STANDARD.encode(png)
    }

    /// Plan 168 S-B1: the bubble decodes off the async runtime, lands in its
    /// target, and `buddy.overlay.clear` drops it (one target or both).
    #[tokio::test]
    async fn the_bubble_is_set_off_the_runtime_and_cleared_per_target() {
        let slots = crate::captions::new_caption_overlay_slots();
        let info = set_buddy_overlay(
            &slots,
            SetBuddyOverlayParams {
                png_base64: bubble_png(40, 20),
                target: None,
                rect: Some(OverlayRect::new(0.7, 0.6, 0.2, 0.3)),
            },
        )
        .await
        .unwrap();
        assert!(info.primary.active && info.auxiliary.active);
        assert_eq!((info.primary.width, info.primary.height), (40, 20));
        assert!(
            set_buddy_overlay(
                &slots,
                SetBuddyOverlayParams {
                    png_base64: "AAAA".to_string(),
                    target: None,
                    rect: None,
                },
            )
            .await
            .is_err(),
            "a bad payload is refused and the bubble stays"
        );
        let cleared = clear_buddy_overlay(
            &slots,
            ClearBuddyOverlayParams {
                target: Some(CaptionOverlayTarget::Auxiliary),
            },
        )
        .unwrap();
        assert!(cleared.primary.active && !cleared.auxiliary.active);
        let cleared = clear_buddy_overlay(&slots, ClearBuddyOverlayParams::default()).unwrap();
        assert!(!cleared.active);
        let params: ClearBuddyOverlayParams =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(params.target, None);
        assert!(
            serde_json::from_value::<ClearBuddyOverlayParams>(serde_json::json!({ "x": 1 }))
                .is_err()
        );
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

    fn buddy_output_switches(app: &AppState, show_on_stream: bool, show_in_recording: bool) {
        let mut layout = load_overlay_layout(&app.database);
        layout.buddy.show_on_stream = show_on_stream;
        layout.buddy.show_in_recording = show_in_recording;
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
        assert_eq!(event.event, BUDDY_STATE_EVENT);
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
        buddy_output_switches(&app, true, false);
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
        assert!(!overlay_enabled(&app), "the Buddy ships off/off");
        let sent = utterance(
            CohostUtteranceTriggerKind::Answer,
            CohostUtteranceStatus::Sent,
            "It is a Keychron.",
        );
        assert!(utterance_bubbles(&sent));
        assert_eq!(show_for_utterance(&app, &sent).await, None);
        assert_eq!(status(&app).await.bubble, None);
        assert!(rx.try_recv().is_err(), "no event with the Buddy off");
        buddy_output_switches(&app, false, true);
        assert!(overlay_enabled(&app));
        assert!(show_for_utterance(&app, &sent).await.is_some());
        assert_eq!(
            rx.recv().await.unwrap().payload["bubble"]["text"],
            "It is a Keychron."
        );
    }
}
