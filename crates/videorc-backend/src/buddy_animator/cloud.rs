//! Plan 249 S5's motion stream from the backend (plan 260 S1.8, L1 R6b): the
//! Rust twin of `apps/desktop/src/shared/cloud-avatar-motion.ts`.
//!
//! Animating program pages (`EG_` identities advertising `animation: 1`)
//! draw the worn pack's atlas themselves and run the animator's TS twin
//! (`buddy-animator.ts`). Every page simulates the same 60 Hz ticks from the
//! same keyframe and the same numbered events, so they all draw the same
//! cell and motion at the same show time. This module is the producer side:
//!
//! - [`PublicEvent`]: the public projection of an animator input
//!   ([`super::public_event`]: moods, lengths, resolved reaction chains; no
//!   text, prompt or persona table), and [`MotionEvent`], which adds the
//!   inputs the compositor passes per frame (plan 164's state, the layout
//!   rects, the highlight cards, the worn pack).
//! - [`MotionSim`]: [`BuddyAnimator`] stepped tick by tick on both managed
//!   outputs (`h` 1920×1080 as leg 0, then `v` 1080×1920 as leg 1), the pack
//!   ([`AnimatorPack`]: ids, kinds and gaze points, no pixels) read through a
//!   synthetic one-pixel atlas so every rule reads it as it reads a real one.
//! - [`MotionProducer`]: the show clock (seconds since it started), events
//!   numbered from 1 and stamped never at or before the simulated time, and
//!   messages as `parseMotionMessage` accepts them: at most 16 events each,
//!   a keyframe of the whole state every 2 s or when asked (a new page, a
//!   new pack, a failed send).
//!
//! `protocol-fixtures/buddy-animator-events.json` (written by the TS test)
//! pins the simulation and the producer to the TS driver sample by sample
//! (`buddy_animator/tests.rs`). The consumer's rules (10 s lease, 200 ms
//! playout, 20 messages a second) are the pages'; the room sends at most a
//! few messages per 100 ms flush.

use std::sync::Arc;

use serde_json::{Value, json};

use super::{BuddyAnimator, BuddyAnimatorSettings};
use crate::buddy_pet::{BuddyMotionSettings, PetFrameKind, reaction_id_ok};
use crate::buddy_sprite::{
    BuddySpriteAtlas, BuddySpriteDraw, BuddySpriteLeg, BuddySpriteLegContext, BuddySpritePackMeta,
    buddy_box,
};
use crate::cohost::{CohostAvatarState, CohostUtteranceState};
use crate::overlay_layout::OverlayRect;

/// `AVATAR_MOTION_TICK_HZ`: the simulation clock every consumer steps.
pub const AVATAR_MOTION_TICK_HZ: f64 = 60.0;
/// `AVATAR_MOTION_MAX_EVENTS`: events per message, and pending events per keyframe.
pub const AVATAR_MOTION_MAX_EVENTS: usize = 16;
/// `AVATAR_MOTION_KEYFRAME_MS`: the producer's keyframe period.
pub const AVATAR_MOTION_KEYFRAME_MS: f64 = 2000.0;
/// `AVATAR_ATLAS_MAX_CELLS` and `AVATAR_ATLAS_MAX_TALK` (`cloud-avatar-atlas-meta.ts`).
pub const AVATAR_ATLAS_MAX_CELLS: usize = 64;
pub const AVATAR_ATLAS_MAX_TALK: usize = 4;
/// `AVATAR_REACTION_CHAIN_MAX`.
pub const AVATAR_REACTION_CHAIN_MAX: usize = super::PUBLIC_REACTION_CHAIN_MAX;

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// A stamped event's `at` (show seconds) is at most a week.
#[cfg(test)]
const MAX_SHOW_SECONDS: f64 = 7.0 * 24.0 * 3600.0;

// --- The outputs ----------------------------------------------------------------------------

/// A managed output's orientation (`MotionOrientation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    H,
    V,
}

impl Orientation {
    /// Stepped in this order every tick: `h` leads.
    pub const ALL: [Self; 2] = [Self::H, Self::V];

    pub fn key(self) -> &'static str {
        match self {
            Self::H => "h",
            Self::V => "v",
        }
    }

    pub fn index(self) -> usize {
        match self {
            Self::H => 0,
            Self::V => 1,
        }
    }

    /// `AVATAR_MOTION_CANVAS`: managed outputs are 1080p.
    pub fn canvas(self) -> (u32, u32) {
        match self {
            Self::H => (1920, 1080),
            Self::V => (1080, 1920),
        }
    }

    /// The animator leg (`LEG`: `h` 0, `v` 1).
    fn leg(self) -> BuddySpriteLeg {
        match self {
            Self::H => BuddySpriteLeg::Primary,
            Self::V => BuddySpriteLeg::Auxiliary,
        }
    }
}

// --- Validation of untrusted shapes (the TS parsers' rules) ---------------------------------

/// `finite(v, min, max)`.
fn finite(value: &Value, min: f64, max: f64) -> Option<f64> {
    value
        .as_f64()
        .filter(|number| number.is_finite() && (min..=max).contains(number))
}

/// `int(v, min, max)` for a non-negative `min`: a whole number (`3` or `3.0`).
fn integer(value: &Value, min: f64, max: f64) -> Option<u64> {
    finite(value, min.max(0.0), max.min(MAX_SAFE_INTEGER))
        .filter(|number| number.fract() == 0.0)
        .map(|number| number as u64)
}

/// `pair(v, min, max)`.
fn pair(value: &Value, min: f64, max: f64) -> Option<[f64; 2]> {
    let values = value.as_array().filter(|values| values.len() == 2)?;
    Some([finite(&values[0], min, max)?, finite(&values[1], min, max)?])
}

/// `HASH`: a SHA-256 in lowercase hex.
fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `parseRect`: a normalized rect inside the canvas.
fn parse_rect(value: &Value) -> Option<OverlayRect> {
    let object = value.as_object()?;
    let [x, y, w, h] =
        ["x", "y", "w", "h"].map(|key| object.get(key).and_then(|value| finite(value, 0.0, 1.0)));
    let (x, y, w, h) = (x?, y?, w?, h?);
    if w <= 0.0 || h <= 0.0 || x + w > 1.00001 || y + h > 1.00001 {
        return None;
    }
    Some(OverlayRect::new(x, y, w, h))
}

fn rect_json(rect: OverlayRect) -> Value {
    json!({ "x": rect.x, "y": rect.y, "w": rect.w, "h": rect.h })
}

/// `parseOrientations`: `{ h, v }`, both present and valid.
fn orientations<T>(value: &Value, item: impl Fn(&Value) -> Option<T>) -> Option<[T; 2]> {
    let object = value.as_object()?;
    Some([item(object.get("h")?)?, item(object.get("v")?)?])
}

fn orientations_json([h, v]: [Value; 2]) -> Value {
    json!({ "h": h, "v": v })
}

/// `STATES`.
pub fn parse_avatar_state(value: &str) -> Option<CohostAvatarState> {
    match value {
        "idle" => Some(CohostAvatarState::Idle),
        "talk" => Some(CohostAvatarState::Talk),
        "laugh" => Some(CohostAvatarState::Laugh),
        "think" => Some(CohostAvatarState::Think),
        _ => None,
    }
}

/// `MOODS`.
pub fn parse_mood(value: &str) -> Option<CohostUtteranceState> {
    match value {
        "talk" => Some(CohostUtteranceState::Talk),
        "laugh" => Some(CohostUtteranceState::Laugh),
        "think" => Some(CohostUtteranceState::Think),
        _ => None,
    }
}

fn mood_str(mood: CohostUtteranceState) -> &'static str {
    CohostAvatarState::from(mood).as_str()
}

/// `parseSettings`: Motion 0..1, sleep 0 or 30..1800 s, breathing.
pub fn parse_settings(value: &Value) -> Option<BuddyMotionSettings> {
    let object = value.as_object()?;
    let intensity = finite(object.get("intensity")?, 0.0, 1.0)?;
    let breathing = object.get("breathing")?.as_bool()?;
    let sleep = integer(object.get("sleepAfterSeconds")?, 0.0, 1800.0)?;
    if sleep != 0 && sleep < 30 {
        return None;
    }
    Some(BuddyMotionSettings {
        intensity,
        sleep_after_seconds: sleep as u32,
        breathing,
    })
}

fn settings_json(settings: &BuddyMotionSettings) -> Value {
    json!({
        "intensity": settings.intensity,
        "sleepAfterSeconds": settings.sleep_after_seconds,
        "breathing": settings.breathing,
    })
}

/// The persona's motion as the pages' parser accepts it (the seed a
/// producer starts from): Motion clamped to 0..1, sleep 0 or 30..1800 s.
pub fn public_settings(settings: BuddyMotionSettings) -> BuddyMotionSettings {
    let defaults = BuddyMotionSettings::default();
    BuddyMotionSettings {
        intensity: if settings.intensity.is_finite() {
            settings.intensity.clamp(0.0, 1.0)
        } else {
            defaults.intensity
        },
        sleep_after_seconds: match settings.sleep_after_seconds {
            0 => 0,
            seconds => seconds.clamp(30, 1800),
        },
        breathing: settings.breathing,
    }
}

// --- The pack ---------------------------------------------------------------------------------

/// One frame of the pack as the animator knows it (`AnimatorCell`).
#[derive(Debug, Clone, PartialEq)]
pub struct PackCell {
    pub id: String,
    pub kind: PetFrameKind,
    /// Gaze frames: page-pet's `[x, y]` in [-1, 1]²; reactions: none.
    pub gaze: Option<[f64; 2]>,
}

impl PackCell {
    pub fn to_json(&self) -> Value {
        let kind = match self.kind {
            PetFrameKind::Gaze => "gaze",
            PetFrameKind::Reaction => "reaction",
        };
        json!({ "id": self.id, "kind": kind, "gaze": self.gaze })
    }
}

/// What the animator knows about the worn pack (`AnimatorPack`: the
/// compositor's `BuddySpriteAtlas` minus its pixels).
#[derive(Debug, Clone, PartialEq)]
pub struct AnimatorPack {
    pub neutral: String,
    pub pivot: [f64; 2],
    /// Normalized top of the neutral silhouette in its cell (D16).
    pub head_top: f64,
    /// The talk frames the pack names (D12), in order.
    pub talk: Vec<String>,
    pub cells: Vec<PackCell>,
}

impl AnimatorPack {
    /// `parseAnimatorPack`: 1 to 64 cells with unique ids of `[a-z0-9-]`,
    /// gaze cells with a point in [-1, 1]², reactions with none, a gaze
    /// neutral, at most 4 talk frames the pack has, pivot and head top in
    /// 0..1.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let raw_cells = object.get("cells")?.as_array()?;
        if raw_cells.is_empty() || raw_cells.len() > AVATAR_ATLAS_MAX_CELLS {
            return None;
        }
        let pivot = pair(object.get("pivot")?, 0.0, 1.0)?;
        let head_top = finite(object.get("headTop")?, 0.0, 1.0)?;
        let neutral = object.get("neutral")?.as_str()?;
        let raw_talk = object.get("talk")?.as_array()?;
        if raw_talk.len() > AVATAR_ATLAS_MAX_TALK {
            return None;
        }
        let mut cells: Vec<PackCell> = Vec::with_capacity(raw_cells.len());
        for raw in raw_cells {
            let cell = raw.as_object()?;
            let id = cell.get("id")?.as_str()?;
            if !reaction_id_ok(id) || cells.iter().any(|known| known.id == id) {
                return None;
            }
            let (kind, gaze) = match cell.get("kind")?.as_str()? {
                "gaze" => (
                    PetFrameKind::Gaze,
                    Some(pair(cell.get("gaze")?, -1.0, 1.0)?),
                ),
                "reaction" if cell.get("gaze")?.is_null() => (PetFrameKind::Reaction, None),
                _ => return None,
            };
            cells.push(PackCell {
                id: id.to_string(),
                kind,
                gaze,
            });
        }
        if !cells
            .iter()
            .any(|cell| cell.id == neutral && cell.kind == PetFrameKind::Gaze)
        {
            return None;
        }
        let mut talk: Vec<String> = Vec::with_capacity(raw_talk.len());
        for id in raw_talk {
            let id = id.as_str()?;
            if !cells.iter().any(|cell| cell.id == id) || talk.iter().any(|known| known == id) {
                return None;
            }
            talk.push(id.to_string());
        }
        Some(Self {
            neutral: neutral.to_string(),
            pivot,
            head_top,
            talk,
            cells,
        })
    }

    pub fn to_json(&self) -> Value {
        json!({
            "neutral": self.neutral,
            "pivot": self.pivot,
            "headTop": self.head_top,
            "talk": self.talk,
            "cells": self.cells.iter().map(PackCell::to_json).collect::<Vec<_>>(),
        })
    }

    /// The animator's view of a leg atlas, when the pages could take it
    /// (`parseAnimatorPack`'s limits). Frames keep the atlas's order.
    pub fn from_atlas(atlas: &BuddySpriteAtlas) -> Option<Self> {
        let pack = Self {
            neutral: atlas.meta.neutral.clone(),
            pivot: atlas.meta.pivot,
            head_top: atlas.meta.head_top.clamp(0.0, 1.0),
            talk: atlas.meta.talk.clone(),
            cells: atlas
                .cells
                .iter()
                .map(|cell| PackCell {
                    id: cell.id.clone(),
                    kind: cell.kind,
                    gaze: if cell.kind == PetFrameKind::Gaze {
                        cell.gaze
                    } else {
                        None
                    },
                })
                .collect(),
        };
        Self::parse(&pack.to_json())
    }

    /// A one-pixel-per-frame atlas with this pack's ids, kinds, gaze points,
    /// neutral, pivot, head top and talk frames: what the animator reads.
    /// Every frame has its own cell, so a draw's cell names its frame.
    pub fn sim_atlas(&self) -> BuddySpriteAtlas {
        let pixels = self
            .cells
            .iter()
            .map(|_| image::RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 0, 255])))
            .collect::<Vec<_>>();
        let meta = Arc::new(BuddySpritePackMeta {
            pack_id: "cloud".to_string(),
            neutral: self.neutral.clone(),
            pivot: self.pivot,
            head_top: self.head_top,
            talk: self.talk.clone(),
            source_cell_px: 1,
            unique_cells: self.cells.len(),
        });
        let frames = self
            .cells
            .iter()
            .enumerate()
            .map(|(index, cell)| (cell.id.clone(), cell.kind, cell.gaze, index))
            .collect();
        BuddySpriteAtlas::from_cells(&pixels, 1, frames, meta)
    }
}

// --- Events -------------------------------------------------------------------------------------

/// The public projection of an animator input (`AnimatorEvent`), as
/// [`super::public_event`] writes it. No text, no persona table.
#[derive(Debug, Clone, PartialEq)]
pub enum PublicEvent {
    Utterance {
        mood: CohostUtteranceState,
        chars: usize,
        bubble_seconds: f64,
    },
    UtteranceEnd,
    Think,
    ThinkSettle,
    /// A trigger with its resolved chain (`activity` false for a failed
    /// destination), or a manual react.
    Reaction {
        chain: Vec<String>,
        activity: bool,
    },
    Highlight {
        ttl_seconds: f64,
    },
    HighlightIdle,
    Chat,
    Settings(BuddyMotionSettings),
}

impl PublicEvent {
    /// One untrusted public event (`parseMotionEvent` for the animator's kinds).
    pub fn parse(value: &Value) -> Option<Self> {
        match MotionEvent::parse(value)? {
            MotionEvent::Animator(event) => Some(event),
            _ => None,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Utterance {
                mood,
                chars,
                bubble_seconds,
            } => json!({
                "kind": "utterance",
                "mood": mood_str(*mood),
                "chars": chars,
                "bubbleSeconds": bubble_seconds,
            }),
            Self::UtteranceEnd => json!({ "kind": "utterance-end" }),
            Self::Think => json!({ "kind": "think" }),
            Self::ThinkSettle => json!({ "kind": "think-settle" }),
            Self::Reaction { chain, activity } => json!({
                "kind": "reaction",
                "chain": chain,
                "activity": activity,
            }),
            Self::Highlight { ttl_seconds } => json!({
                "kind": "highlight",
                "ttlSeconds": ttl_seconds,
            }),
            Self::HighlightIdle => json!({ "kind": "highlight-idle" }),
            Self::Chat => json!({ "kind": "chat" }),
            Self::Settings(settings) => json!({
                "kind": "settings",
                "settings": settings_json(settings),
            }),
        }
    }
}

/// Everything the simulation applies (`MotionEvent`): the animator's public
/// inputs and the per-frame inputs the compositor reads.
#[derive(Debug, Clone, PartialEq)]
pub enum MotionEvent {
    Animator(PublicEvent),
    /// Plan 164's state.
    State(CohostAvatarState),
    /// The Buddy's layout rect per orientation (`h`, `v`).
    Layout([OverlayRect; 2]),
    /// The accepted highlight card per orientation, while one shows.
    Cards([Option<OverlayRect>; 2]),
    /// A new worn pack: its atlas PNG's SHA-256 and its frames.
    Pack {
        atlas_hash: String,
        pack: AnimatorPack,
    },
}

impl MotionEvent {
    /// `parseMotionEvent`: one untrusted event; unknown fields refuse it
    /// (nothing extra, such as text, rides along).
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let kind = object.get("kind")?.as_str()?;
        let allowed: &[&str] = match kind {
            "utterance" => &["mood", "chars", "bubbleSeconds"],
            "reaction" => &["chain", "activity"],
            "highlight" => &["ttlSeconds"],
            "settings" => &["settings"],
            "state" => &["state"],
            "layout" => &["rects"],
            "cards" => &["cards"],
            "pack" => &["atlasHash", "pack"],
            _ => &[],
        };
        if !object
            .keys()
            .all(|key| key == "kind" || allowed.contains(&key.as_str()))
        {
            return None;
        }
        let event = match kind {
            "utterance" => Self::Animator(PublicEvent::Utterance {
                mood: parse_mood(object.get("mood")?.as_str()?)?,
                chars: integer(object.get("chars")?, 0.0, 4000.0)? as usize,
                bubble_seconds: finite(object.get("bubbleSeconds")?, 0.0, 120.0)?,
            }),
            "utterance-end" => Self::Animator(PublicEvent::UtteranceEnd),
            "think" => Self::Animator(PublicEvent::Think),
            "think-settle" => Self::Animator(PublicEvent::ThinkSettle),
            "highlight-idle" => Self::Animator(PublicEvent::HighlightIdle),
            "chat" => Self::Animator(PublicEvent::Chat),
            "reaction" => {
                let chain = object.get("chain")?.as_array()?;
                let activity = object.get("activity")?.as_bool()?;
                if chain.len() > AVATAR_REACTION_CHAIN_MAX {
                    return None;
                }
                let chain = chain
                    .iter()
                    .map(|id| {
                        id.as_str()
                            .filter(|id| reaction_id_ok(id))
                            .map(str::to_string)
                    })
                    .collect::<Option<Vec<_>>>()?;
                Self::Animator(PublicEvent::Reaction { chain, activity })
            }
            "highlight" => Self::Animator(PublicEvent::Highlight {
                ttl_seconds: finite(object.get("ttlSeconds")?, 0.0, 600.0)?,
            }),
            "settings" => Self::Animator(PublicEvent::Settings(parse_settings(
                object.get("settings")?,
            )?)),
            "state" => Self::State(parse_avatar_state(object.get("state")?.as_str()?)?),
            "layout" => Self::Layout(orientations(object.get("rects")?, parse_rect)?),
            "cards" => Self::Cards(orientations(object.get("cards")?, |value| {
                if value.is_null() {
                    Some(None)
                } else {
                    parse_rect(value).map(Some)
                }
            })?),
            "pack" => {
                let atlas_hash = object.get("atlasHash")?.as_str()?;
                if !is_hash(atlas_hash) {
                    return None;
                }
                Self::Pack {
                    atlas_hash: atlas_hash.to_string(),
                    pack: AnimatorPack::parse(object.get("pack")?)?,
                }
            }
            _ => return None,
        };
        Some(event)
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Animator(event) => event.to_json(),
            Self::State(state) => json!({ "kind": "state", "state": state.as_str() }),
            Self::Layout(rects) => json!({
                "kind": "layout",
                "rects": orientations_json(rects.map(rect_json)),
            }),
            Self::Cards(cards) => json!({
                "kind": "cards",
                "cards": orientations_json(cards.map(|card| card.map_or(Value::Null, rect_json))),
            }),
            Self::Pack { atlas_hash, pack } => json!({
                "kind": "pack",
                "atlasHash": atlas_hash,
                "pack": pack.to_json(),
            }),
        }
    }
}

/// An event as sent (`StampedMotionEvent`): its id (from 1, monotonic in
/// the epoch) and its show time (seconds, millisecond precision).
#[derive(Debug, Clone, PartialEq)]
pub struct StampedEvent {
    pub id: u64,
    pub at: f64,
    pub event: MotionEvent,
}

impl StampedEvent {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "at": self.at, "event": self.event.to_json() })
    }

    /// `parseStamped`.
    #[cfg(test)]
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        Some(Self {
            id: integer(object.get("id")?, 1.0, MAX_SAFE_INTEGER)?,
            at: finite(object.get("at")?, 0.0, MAX_SHOW_SECONDS)?,
            event: MotionEvent::parse(object.get("event")?)?,
        })
    }
}

/// What the simulation reads besides events (`MotionInputs`).
#[derive(Debug, Clone, PartialEq)]
pub struct MotionInputs {
    pub avatar_state: CohostAvatarState,
    /// The Buddy's layout rect per orientation (`overlayLayout.buddy`), `[h, v]`.
    pub rects: [OverlayRect; 2],
    /// The accepted highlight card per orientation, while one shows.
    pub cards: [Option<OverlayRect>; 2],
    /// The atlas PNG's SHA-256 (the avatar layer's asset hash).
    pub atlas_hash: String,
    pub pack: AnimatorPack,
}

impl MotionInputs {
    pub fn to_json(&self) -> Value {
        json!({
            "avatarState": self.avatar_state.as_str(),
            "rects": orientations_json(self.rects.map(rect_json)),
            "cards": orientations_json(self.cards.map(|card| card.map_or(Value::Null, rect_json))),
            "atlasHash": self.atlas_hash,
            "pack": self.pack.to_json(),
        })
    }

    /// `parseInputs`.
    #[cfg(test)]
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let atlas_hash = object.get("atlasHash")?.as_str()?;
        if !is_hash(atlas_hash) {
            return None;
        }
        Some(Self {
            avatar_state: parse_avatar_state(object.get("avatarState")?.as_str()?)?,
            rects: orientations(object.get("rects")?, parse_rect)?,
            cards: orientations(object.get("cards")?, |value| {
                if value.is_null() {
                    Some(None)
                } else {
                    parse_rect(value).map(Some)
                }
            })?,
            atlas_hash: atlas_hash.to_string(),
            pack: AnimatorPack::parse(object.get("pack")?)?,
        })
    }
}

// --- The deterministic simulation ----------------------------------------------------------------

fn tick_time(tick: u64) -> f64 {
    tick as f64 / AVATAR_MOTION_TICK_HZ
}

/// The animator plus its inputs, stepped tick by tick, both outputs per
/// tick, `h` first (`MotionSim`).
pub struct MotionSim {
    animator: BuddyAnimator,
    inputs: MotionInputs,
    /// [`AnimatorPack::sim_atlas`] of `inputs.pack`.
    atlas: BuddySpriteAtlas,
    tick: u64,
    last_event_id: u64,
    /// Added, not applied yet, in id order.
    pending: Vec<StampedEvent>,
    /// The draws of the last stepped tick, `[h, v]`.
    #[cfg_attr(not(test), allow(dead_code))] // the tests compare them with the TS samples
    draws: [Option<BuddySpriteDraw>; 2],
}

impl MotionSim {
    /// A fresh simulation at tick 0 (the producer's start).
    pub fn start(seed: u64, settings: BuddyMotionSettings, inputs: MotionInputs) -> Self {
        let animator = BuddyAnimator::new(
            BuddyAnimatorSettings {
                motion: settings,
                reactions: Default::default(),
            },
            seed,
        );
        Self {
            animator,
            atlas: inputs.pack.sim_atlas(),
            inputs,
            tick: 0,
            last_event_id: 0,
            pending: Vec::new(),
            draws: [None, None],
        }
    }

    /// A late consumer's simulation from a keyframe (`MotionSim.fromKeyframe`).
    #[cfg(test)]
    pub fn from_keyframe(keyframe: &Value) -> Option<Self> {
        let object = keyframe.as_object()?;
        let tick = integer(
            object.get("tick")?,
            0.0,
            MAX_SHOW_SECONDS * AVATAR_MOTION_TICK_HZ,
        )?;
        let last_event_id = integer(object.get("lastEventId")?, 0.0, MAX_SAFE_INTEGER)?;
        let animator = BuddyAnimator::load_state(object.get("animator")?).ok()?;
        let inputs = MotionInputs::parse(object.get("inputs")?)?;
        let atlas = inputs.pack.sim_atlas();
        let mut sim = Self {
            animator,
            inputs,
            atlas,
            tick,
            last_event_id,
            pending: Vec::new(),
            draws: [None, None],
        };
        let pending = object.get("pending")?.as_array()?;
        if pending.len() > AVATAR_MOTION_MAX_EVENTS {
            return None;
        }
        for raw in pending {
            let event = StampedEvent::parse(raw)?;
            if event.id <= last_event_id {
                return None;
            }
            sim.add(event);
        }
        Some(sim)
    }

    #[cfg(test)]
    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// The simulated show time, seconds.
    pub fn time(&self) -> f64 {
        tick_time(self.tick)
    }

    /// Queue an event; an id at or below what was applied, or one already
    /// queued, is ignored (no duplicates).
    pub fn add(&mut self, event: StampedEvent) -> bool {
        if event.id <= self.last_event_id || self.pending.iter().any(|known| known.id == event.id) {
            return false;
        }
        self.pending.push(event);
        self.pending.sort_by_key(|event| event.id);
        true
    }

    /// Step every tick up to `tick`: the due events (in id order), then the
    /// `h` and the `v` leg.
    pub fn advance_to(&mut self, tick: u64) {
        while self.tick < tick {
            let next = self.tick + 1;
            let now = tick_time(next);
            while self.pending.first().is_some_and(|due| due.at <= now) {
                let due = self.pending.remove(0);
                self.apply(&due.event, due.at);
                self.last_event_id = self.last_event_id.max(due.id);
            }
            for orientation in Orientation::ALL {
                let (width, height) = orientation.canvas();
                let rect = self.inputs.rects[orientation.index()];
                let highlight_rect = self.inputs.cards[orientation.index()].map(|card| {
                    let (width, height) = (f64::from(width), f64::from(height));
                    [
                        (card.x * width) as f32,
                        (card.y * height) as f32,
                        (card.w * width) as f32,
                        (card.h * height) as f32,
                    ]
                });
                let context = BuddySpriteLegContext {
                    leg: orientation.leg(),
                    now_seconds: now,
                    canvas: (width, height),
                    buddy_rect: rect,
                    buddy_box: buddy_box(rect, width, height),
                    highlight_rect,
                    caption_rect: None,
                    avatar_state: self.inputs.avatar_state,
                    atlas: &self.atlas,
                };
                let draw = self.animator.draw(&context);
                self.draws[orientation.index()] = draw;
            }
            self.tick = next;
        }
    }

    fn apply(&mut self, event: &MotionEvent, at: f64) {
        match event {
            MotionEvent::State(state) => self.inputs.avatar_state = *state,
            MotionEvent::Layout(rects) => self.inputs.rects = *rects,
            MotionEvent::Cards(cards) => self.inputs.cards = *cards,
            MotionEvent::Pack { atlas_hash, pack } => {
                self.inputs.pack = pack.clone();
                self.inputs.atlas_hash = atlas_hash.clone();
                self.atlas = pack.sim_atlas();
            }
            MotionEvent::Animator(event) => self.animator.handle_public(event, at),
        }
    }

    /// The draws of the last stepped tick, `[h, v]`.
    #[cfg(test)]
    pub fn draws(&self) -> [Option<BuddySpriteDraw>; 2] {
        self.draws
    }

    /// The last stepped tick on one output as the TS samples name it: the
    /// cell's id, the CSS affine and the translation.
    #[cfg(test)]
    pub fn sample(&self, orientation: Orientation) -> Option<(String, [f32; 4], [f32; 2])> {
        let draw = self.draws[orientation.index()]?;
        let cell = self
            .atlas
            .cells
            .iter()
            .find(|cell| cell.rect == draw.cell)?;
        Some((cell.id.clone(), draw.affine, draw.translate))
    }

    /// The whole state at this tick (`MotionKeyframe`): every event up to
    /// `lastEventId` is folded in; `pending` are the ones sent but not
    /// applied yet.
    pub fn keyframe(&self) -> Value {
        json!({
            "tick": self.tick,
            "lastEventId": self.last_event_id,
            "animator": self.animator.save_state(),
            "inputs": self.inputs.to_json(),
            "pending": self.pending.iter().map(StampedEvent::to_json).collect::<Vec<_>>(),
        })
    }
}

// --- The producer ------------------------------------------------------------------------------

/// The desktop renderer's `MotionProducer`, on an injected wall clock
/// (milliseconds): seconds since it started are the show clock.
pub struct MotionProducer {
    show: String,
    publisher_sid: String,
    epoch: String,
    origin: f64,
    sim: MotionSim,
    next_id: u64,
    seq: u64,
    last_at: f64,
    outbox: Vec<StampedEvent>,
    last_keyframe_at: f64,
}

impl MotionProducer {
    /// `show` and `publisherSid` go into every message as given (the room's
    /// sender stamps its own); `epoch` names this run (8 to 64 of
    /// `[A-Za-z0-9_-]`); `now_ms` is show time 0.
    pub fn new(
        show: String,
        publisher_sid: String,
        epoch: String,
        seed: u64,
        settings: BuddyMotionSettings,
        inputs: MotionInputs,
        now_ms: f64,
    ) -> Self {
        Self {
            show,
            publisher_sid,
            epoch,
            origin: now_ms,
            sim: MotionSim::start(seed, settings, inputs),
            next_id: 1,
            seq: 0,
            last_at: 0.0,
            outbox: Vec::new(),
            last_keyframe_at: f64::NEG_INFINITY,
        }
    }

    #[cfg(test)]
    pub fn sim(&self) -> &MotionSim {
        &self.sim
    }

    fn show_now(&self, now_ms: f64) -> f64 {
        (now_ms - self.origin) / 1000.0
    }

    /// Step the producer's own simulation to now (its keyframes come from it).
    pub fn advance(&mut self, now_ms: f64) {
        let tick = (self.show_now(now_ms) * AVATAR_MOTION_TICK_HZ).floor();
        if tick > 0.0 {
            self.sim.advance_to(tick as u64);
        }
    }

    /// Stamp an event: never at or before the simulated time, never before
    /// the last one.
    pub fn push(&mut self, event: MotionEvent, now_ms: f64) -> StampedEvent {
        self.advance(now_ms);
        let at = ((self.show_now(now_ms) * 1000.0).ceil() / 1000.0)
            .max(self.sim.time() + 0.001)
            .max(self.last_at);
        self.last_at = at;
        let stamped = StampedEvent {
            id: self.next_id,
            at,
            event,
        };
        self.next_id += 1;
        self.sim.add(stamped.clone());
        self.outbox.push(stamped.clone());
        let keep = 4 * AVATAR_MOTION_MAX_EVENTS;
        if self.outbox.len() > keep {
            let drop = self.outbox.len() - keep;
            self.outbox.drain(..drop);
        }
        stamped
    }

    /// The messages to send now (`MotionMessage` JSON): queued events in
    /// chunks of at most 16, and a keyframe on the last one when one is due
    /// (2 s since the last) or `force_keyframe` (a new page, a reconnect).
    pub fn flush(&mut self, force_keyframe: bool, now_ms: f64) -> Vec<Value> {
        self.advance(now_ms);
        let keyframe_due =
            force_keyframe || now_ms - self.last_keyframe_at >= AVATAR_MOTION_KEYFRAME_MS;
        let mut messages = Vec::new();
        let mut keyframed = false;
        while !self.outbox.is_empty() || (keyframe_due && !keyframed) {
            let take = self.outbox.len().min(AVATAR_MOTION_MAX_EVENTS);
            let events = self.outbox.drain(..take).collect::<Vec<_>>();
            let keyframe = (keyframe_due && self.outbox.is_empty()).then(|| self.sim.keyframe());
            keyframed |= keyframe.is_some();
            self.seq += 1;
            messages.push(json!({
                "version": 1,
                "show": self.show,
                "publisherSid": self.publisher_sid,
                "epoch": self.epoch,
                "seq": self.seq,
                "sentAt": self.origin.max(now_ms.round()) as i64,
                "origin": self.origin.round() as i64,
                "keyframe": keyframe,
                "events": events.iter().map(StampedEvent::to_json).collect::<Vec<_>>(),
            }));
        }
        if keyframed {
            self.last_keyframe_at = now_ms;
        }
        messages
    }
}
