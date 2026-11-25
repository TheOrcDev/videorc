//! Plan 260 S1.8 (L1): the room's avatar content built by the backend, for a
//! client that cannot build it (the GPUI app; Electron builds it in its
//! renderer, `renderCloudAvatar`, and hands it over through
//! `cloud.room.avatar.set`'s `content`).
//!
//! The client asks with `cloud.room.avatar.set { build: true }`. While the
//! backend holds the room, this draws the pet and its bubble the way the
//! stream draws them (the sprite slot's Preview leg and the caption slots'
//! bubble, [`compose_buddy_layer`]: the same pixels the outputs burn in) for
//! each lane's room canvas (1920×1080 landscape, 1080×1920 portrait), as one
//! static PNG layer per lane, and puts it where the room's avatar publisher
//! reads the content ([`crate::room_content`]). The pet is the still at a
//! fixed clock (Electron sends the pack's neutral frame), so a new layer
//! goes out only when the pet, the bubble or the place changes, never every
//! animation frame. The sprite slot keeps one atlas per leg and canvas, so
//! the Preview leg is asked for the landscape canvas only (asking for both
//! would rebuild its atlas on every look); the portrait lane gets the same
//! pet, without the bubble (the caption slots raster it for the primary
//! canvas), in its own box ([`buddy_box`] for the portrait rect).
//!
//! R6b: pages that animate (`animation: 1`) get the pose set and the motion
//! together, as Electron sends them (plan 249 S5): the content's `animated`
//! lanes carry the worn pack as one atlas PNG in each lane's square box
//! (`atlasLayerRect`) with its `atlas` meta (ids, kinds, gaze points,
//! pivot, head top, talk frames, cell rects), plus the bubble while one
//! shows; and [`run_motion`] runs the motion model (`MotionProducer`, the
//! animator's cloud twin in `buddy_animator::cloud`) on the animator's
//! public inputs (`cohost.pet.animator`), sending its messages through the
//! avatar publisher's connection (`room_avatar::send_motion`) to the pages
//! that animate. The atlas is the Preview leg's, repacked within the
//! pages' limits (at most 64 frames, 1024 × 1024 px, 256 KiB of base64,
//! cells of 64 to 256 px, as `buildCloudAvatarAtlas`); a pack that does not
//! fit, or the still avatar, sends no `animated` and no motion, and those
//! pages draw the still. The highlight card is not sent to the motion model
//! (Electron's backend-room path sends none either): on animating pages
//! the pet does not turn toward the card.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::buddy_animator::cloud::{
    AnimatorPack, MotionEvent, MotionInputs, MotionProducer, Orientation, PublicEvent,
    parse_avatar_state, public_settings,
};
use crate::buddy_pet::BuddyMotionSettings;
use crate::buddy_sprite::{
    BuddyLegFrame, BuddyLegRequest, BuddySpriteAtlas, BuddySpriteLeg, buddy_box,
    buddy_bubble_anchor, buddy_rect_for_canvas, scale_cell,
};
use crate::captions::CaptionOverlay;
use crate::cohost::CohostAvatarState;
use crate::overlay_layout::{OverlayItemLayout, OverlayRect};
use crate::preview_buddy_layer::compose_buddy_layer;
use crate::state::AppState;

/// The client asked the backend to build the avatar content.
static BUILD: AtomicBool = AtomicBool::new(false);

/// The room program's canvas per lane (web `STAGE_CANVAS`).
const LANDSCAPE: (u32, u32) = (1920, 1080);
const PORTRAIT: (u32, u32) = (1080, 1920);
/// How often the content is looked at (a change goes out within this).
const POLL: Duration = Duration::from_millis(250);
/// The still's clock: a fixed instant, so an idle pet's still never changes.
const STILL_CLOCK_SECONDS: f64 = 0.0;
/// `avatarPng` (`cloud-avatar.ts`): a page refuses a layer whose PNG is over
/// 256 KiB of base64, or over 1024 px on a side, or over 1024² pixels (and
/// with it the whole snapshot). `AVATAR_MAX_BYTES` (512 KiB) bounds the
/// snapshot, not one PNG.
const AVATAR_PNG_MAX_BASE64: usize = 256 * 1024;
const AVATAR_PNG_MAX_SIDE: u32 = 1024;
/// `buildCloudAvatarAtlas`: the sharpest cell sent (a 1080p output draws
/// the Buddy at about this size) and the smallest before the pack is refused.
const ATLAS_MAX_CELL_PX: u32 = 256;
const ATLAS_MIN_CELL_PX: u32 = 64;
/// An animating lane's pictures together stay under this much base64, so
/// its snapshot stays within the 512 KiB avatar budget
/// (`room_avatar::AVATAR_MAX_BYTES`); a bubble that would not fit is left out.
const ANIMATED_LANE_MAX_BASE64: usize = 480 * 1024;
/// `ROOM_AVATAR_MOTION_FLUSH_MS`: the motion model is stepped and flushed this often.
const MOTION_FLUSH: Duration = Duration::from_millis(100);
/// `publisherSid` until the room's sender stamps its own (`send_motion`).
const MOTION_PUBLISHER_STAND_IN: &str = "PA_backend";

/// What the motion model needs from the built content: the atlas the pages
/// draw (its hash and frames) and the Buddy's layout rects `[h, v]`. Set
/// with content that has `animated` lanes, cleared with content that has none.
#[derive(Debug, Clone, PartialEq)]
struct MotionSeed {
    atlas_hash: String,
    pack: AnimatorPack,
    rects: [OverlayRect; 2],
}

static MOTION_SEED: StdMutex<Option<MotionSeed>> = StdMutex::new(None);

fn motion_seed_slot() -> std::sync::MutexGuard<'static, Option<MotionSeed>> {
    MOTION_SEED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn motion_seed() -> Option<MotionSeed> {
    motion_seed_slot().clone()
}

fn set_motion_seed(seed: Option<MotionSeed>) {
    *motion_seed_slot() = seed;
}

pub(crate) fn set_build(build: bool) {
    BUILD.store(build, Ordering::Release);
}

pub(crate) fn building() -> bool {
    BUILD.load(Ordering::Acquire)
}

/// One lane's static layer from a composed straight-alpha BGRA picture of
/// `size`: a PNG named by its SHA-256 (`avatarHash`), placed at `place`
/// (canvas pixels, `[x, y, w, h]`) in canvas fractions. `None` when a page
/// would refuse it (`avatarPng`'s limits).
pub(crate) fn png_layer(
    canvas: (u32, u32),
    place: [f32; 4],
    size: (u32, u32),
    bgra: &[u8],
) -> Option<Value> {
    let (width, height) = size;
    let [_, _, place_width, place_height] = place;
    if width == 0
        || height == 0
        || width > AVATAR_PNG_MAX_SIDE
        || height > AVATAR_PNG_MAX_SIDE
        || place_width <= 0.0
        || place_height <= 0.0
        || bgra.len() < width as usize * height as usize * 4
    {
        return None;
    }
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    let (hash, png) = encode_png(&rgba, width, height)?;
    Some(json!({
        "kind": "avatar",
        "rect": canvas_fractions(canvas, place),
        "asset": { "hash": hash, "png": png, "width": width, "height": height },
        "expiresAt": null,
    }))
}

/// Straight-alpha RGBA as a PNG: its SHA-256 (lowercase hex, the asset's
/// name) and its base64. `None` when encoding fails or the base64 is over
/// what a page takes.
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Option<(String, String)> {
    use image::ImageEncoder as _;
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .ok()?;
    let png = base64::engine::general_purpose::STANDARD.encode(&bytes);
    if png.len() > AVATAR_PNG_MAX_BASE64 {
        return None;
    }
    Some((format!("{:x}", Sha256::digest(&bytes)), png))
}

/// A place on a canvas (pixels, `[x, y, w, h]`) in canvas fractions.
fn canvas_fractions(canvas: (u32, u32), [x, y, width, height]: [f32; 4]) -> Value {
    let (canvas_width, canvas_height) = (f64::from(canvas.0), f64::from(canvas.1));
    json!({
        "x": f64::from(x) / canvas_width,
        "y": f64::from(y) / canvas_height,
        "w": f64::from(width) / canvas_width,
        "h": f64::from(height) / canvas_height,
    })
}

/// The content as `cloud.room.avatar.set` carries it.
pub(crate) fn content(h: Vec<Value>, v: Vec<Value>, stream: bool, recording: bool) -> Value {
    json!({ "h": h, "v": v, "stream": stream, "recording": recording })
}

// --- The pose set (R6b) ---------------------------------------------------------------------

/// The worn pack as the pages draw it (`CloudAvatarAtlas`): one PNG of every
/// distinct cell, its SHA-256 (the motion stream's `atlasHash`), the
/// `atlas` meta (the pack plus each frame's cell rect) and the pack.
#[derive(Debug, Clone)]
struct CloudAtlas {
    hash: String,
    png: String,
    width: u32,
    height: u32,
    meta: Value,
    pack: AnimatorPack,
}

/// `atlasGrid`: columns, rows and the cell side for `count` cells of at
/// most `cell_px`, the sheet within 1024 × 1024.
fn cloud_grid(count: usize, cell_px: u32) -> (u32, u32, u32) {
    let count = count.max(1) as u32;
    let columns = (f64::from(count).sqrt().ceil() as u32).max(1);
    let rows = count.div_ceil(columns);
    let side = cell_px
        .min(AVATAR_PNG_MAX_SIDE / columns)
        .min(AVATAR_PNG_MAX_SIDE / rows);
    (columns, rows, side)
}

/// One cell of a leg atlas (straight-alpha BGRA) as RGBA; fully clear
/// texels lose the bled colour (it only matters to the GPU's filtering).
fn atlas_cell_rgba(
    atlas: &BuddySpriteAtlas,
    [x, y, width, height]: [u32; 4],
) -> Option<image::RgbaImage> {
    if width == 0
        || height == 0
        || x.checked_add(width)? > atlas.width
        || y.checked_add(height)? > atlas.height
    {
        return None;
    }
    let stride = atlas.width as usize * 4;
    if atlas.bgra.len() < stride * atlas.height as usize {
        return None;
    }
    Some(image::RgbaImage::from_fn(width, height, |column, row| {
        let index = (y + row) as usize * stride + (x + column) as usize * 4;
        let pixel = &atlas.bgra[index..index + 4];
        if pixel[3] == 0 {
            image::Rgba([0, 0, 0, 0])
        } else {
            image::Rgba([pixel[2], pixel[1], pixel[0], pixel[3]])
        }
    }))
}

/// `buildCloudAvatarAtlas` from a leg atlas: every distinct cell once (frames
/// drawing the same cell share it), in a near-square grid at the sharpest
/// side that fits (at most 256 px and the leg's own cells, never upscaled),
/// 20 % smaller per try until the PNG is within 256 KiB of base64. `None`
/// for the still avatar (Electron animates Alive packs only), a pack the
/// pages would refuse (`parseAnimatorPack`), or one that does not fit at
/// 64 px (or the leg's own side when that is smaller, never under 32 px).
fn cloud_atlas(atlas: &BuddySpriteAtlas) -> Option<CloudAtlas> {
    if atlas.meta.pack_id == crate::buddy_pet::STILL_PACK_ID {
        return None;
    }
    let pack = AnimatorPack::from_atlas(atlas)?;
    let mut unique: Vec<[u32; 4]> = Vec::new();
    let cell_of = atlas
        .cells
        .iter()
        .map(
            |cell| match unique.iter().position(|rect| *rect == cell.rect) {
                Some(index) => index,
                None => {
                    unique.push(cell.rect);
                    unique.len() - 1
                }
            },
        )
        .collect::<Vec<_>>();
    let cells = unique
        .iter()
        .map(|rect| atlas_cell_rgba(atlas, *rect))
        .collect::<Option<Vec<_>>>()?;
    let smallest = atlas.cell_px.clamp(32, ATLAS_MIN_CELL_PX);
    let mut cell_px = cloud_grid(cells.len(), ATLAS_MAX_CELL_PX.min(atlas.cell_px)).2;
    while cell_px >= smallest {
        let (columns, rows, side) = cloud_grid(cells.len(), cell_px);
        let (width, height) = (columns * side, rows * side);
        let origin = |index: usize| {
            let index = index as u32;
            ((index % columns) * side, (index / columns) * side)
        };
        let mut sheet = image::RgbaImage::new(width, height);
        for (index, cell) in cells.iter().enumerate() {
            let (x, y) = origin(index);
            image::imageops::replace(
                &mut sheet,
                &scale_cell(cell, side),
                i64::from(x),
                i64::from(y),
            );
        }
        if let Some((hash, png)) = encode_png(sheet.as_raw(), width, height) {
            let mut meta = pack.to_json();
            if let Some(entries) = meta.get_mut("cells").and_then(Value::as_array_mut) {
                for (entry, index) in entries.iter_mut().zip(&cell_of) {
                    let (x, y) = origin(*index);
                    entry["rect"] = json!([x, y, side, side]);
                }
            }
            return Some(CloudAtlas {
                hash,
                png,
                width,
                height,
                meta,
                pack,
            });
        }
        cell_px = (f64::from(side) * 0.8).floor() as u32;
    }
    None
}

/// The Buddy's layout rect on one lane.
fn lane_rect(layout: &OverlayItemLayout, orientation: Orientation) -> OverlayRect {
    match orientation {
        Orientation::H => layout.horizontal,
        Orientation::V => layout.vertical,
    }
}

/// The bubble alone, above the head of the pet in `buddy_box` on a lane's
/// canvas, as S4's `bubble` layer: it leaves the page at `until` (ms).
fn bubble_layer(
    canvas: (u32, u32),
    buddy_box: [f32; 4],
    head_top: f64,
    bubble: &CaptionOverlay,
    until: i64,
) -> Option<Value> {
    let frame = BuddyLegFrame {
        buddy_box,
        sprite: None,
        bubble_anchor: buddy_bubble_anchor(buddy_box, head_top),
    };
    let composed = compose_buddy_layer(canvas, &frame, Some(bubble))?;
    let mut layer = png_layer(
        canvas,
        composed.rect.map(|value| value as f32),
        (composed.rect[2], composed.rect[3]),
        &composed.bgra,
    )?;
    layer["kind"] = json!("bubble");
    layer["expiresAt"] = json!(until);
    Some(layer)
}

/// The content's `animated` lanes (`animatedAvatarContent`): per lane the
/// atlas as the avatar layer in the compositor's square box for the lane's
/// rect (`atlasLayerRect`), then the bubble while one shows (`bubble`: the
/// raster and when it ends).
fn animated_lanes(
    atlas: &CloudAtlas,
    layout: &OverlayItemLayout,
    bubble: Option<(&CaptionOverlay, i64)>,
) -> Value {
    let mut lanes = serde_json::Map::new();
    for orientation in Orientation::ALL {
        let canvas = orientation.canvas();
        let place = buddy_box(lane_rect(layout, orientation), canvas.0, canvas.1);
        let mut layers = vec![json!({
            "kind": "avatar",
            "rect": canvas_fractions(canvas, place),
            "asset": {
                "hash": atlas.hash,
                "png": atlas.png,
                "width": atlas.width,
                "height": atlas.height,
            },
            "expiresAt": null,
            "atlas": atlas.meta,
        })];
        if let Some((bubble, until)) = bubble
            && let Some(layer) = bubble_layer(canvas, place, atlas.pack.head_top, bubble, until)
            && layer["asset"]["png"].as_str().map_or(0, str::len) + atlas.png.len()
                <= ANIMATED_LANE_MAX_BASE64
        {
            layers.push(layer);
        }
        lanes.insert(orientation.key().to_string(), Value::Array(layers));
    }
    Value::Object(lanes)
}

/// Builds the content while asked and while the backend holds the room;
/// one task for the backend's life.
pub(crate) async fn run(state: AppState) {
    // R6b: the motion stream runs beside the builder, on the seed it leaves.
    tokio::spawn(run_motion(state.clone()));
    let mut last_key: Option<String> = None;
    // The pose set of the last leg atlas looked at, by its revision (a
    // repack happens once per atlas, never per look).
    let mut atlas_cache: Option<(u64, Option<Arc<CloudAtlas>>)> = None;
    loop {
        tokio::time::sleep(POLL).await;
        if !building() || !crate::room_host::holds_seat() {
            last_key = None;
            set_motion_seed(None);
            continue;
        }
        let layout = state.buddy_sprite.layout();
        let bubble = crate::captions::current_caption_overlays(&state.buddy_overlay).primary;
        // When the bubble ends: an animating page drops its bubble layer then.
        let bubble_until = crate::buddy_overlay::status(&state)
            .await
            .bubble
            .and_then(|bubble| chrono::DateTime::parse_from_rfc3339(&bubble.until).ok())
            .map(|until| until.timestamp_millis());
        let mut key = format!(
            "{}:{}:{:?}",
            layout.show_on_stream,
            layout.show_in_recording,
            bubble
                .as_ref()
                .map(|bubble| (bubble.revision, bubble.width, bubble.height))
        );
        // One look at the Preview leg, for the landscape canvas only.
        let frame = state.buddy_sprite.leg_frame_at(
            BuddyLegRequest {
                leg: BuddySpriteLeg::Preview,
                canvas: LANDSCAPE,
                now_seconds: STILL_CLOCK_SECONDS,
                highlight_rect: None,
                caption_rect: None,
            },
            None,
        );
        key.push_str(&format!(
            "|{:?}:{:?}:{:?}",
            frame
                .sprite
                .as_ref()
                .map(|sprite| (sprite.atlas.revision, sprite.draw)),
            (
                frame.bubble_anchor.x.to_bits(),
                frame.bubble_anchor.y.to_bits()
            ),
            (layout.horizontal, layout.vertical),
        ));
        // The pose set: the leg atlas repacked for the pages, once per atlas.
        let leg_atlas = frame
            .sprite
            .as_ref()
            .map(|sprite| Arc::clone(&sprite.atlas));
        if let Some(leg_atlas) = leg_atlas.as_ref()
            && atlas_cache
                .as_ref()
                .is_none_or(|(revision, _)| *revision != leg_atlas.revision)
        {
            let source = Arc::clone(leg_atlas);
            let built = tokio::task::spawn_blocking(move || cloud_atlas(&source))
                .await
                .ok()
                .flatten();
            if built.is_none() && leg_atlas.meta.pack_id != crate::buddy_pet::STILL_PACK_ID {
                tracing::info!(
                    "The room's avatar stays still on animating outputs: its pack does not fit the cloud atlas limits (64 frames, 1024 px, 256 KiB)."
                );
            }
            atlas_cache = Some((leg_atlas.revision, built.map(Arc::new)));
        }
        let animated_atlas = leg_atlas.as_ref().and_then(|leg_atlas| {
            atlas_cache
                .as_ref()
                .filter(|(revision, _)| *revision == leg_atlas.revision)
                .and_then(|(_, built)| built.clone())
        });
        key.push_str(&format!(
            "|{:?}:{:?}",
            animated_atlas.as_ref().map(|atlas| atlas.hash.as_str()),
            bubble_until,
        ));
        if last_key.as_ref() == Some(&key) {
            continue;
        }
        let at = |rect: [u32; 4]| rect.map(|value| value as f32);
        let h: Vec<Value> = compose_buddy_layer(LANDSCAPE, &frame, bubble.as_ref())
            .and_then(|composed| {
                png_layer(
                    LANDSCAPE,
                    at(composed.rect),
                    (composed.rect[2], composed.rect[3]),
                    &composed.bgra,
                )
            })
            .into_iter()
            .collect();
        // The portrait lane: the same pet, in the portrait rect's box.
        let portrait_box = buddy_box(
            buddy_rect_for_canvas(&layout, PORTRAIT.0, PORTRAIT.1),
            PORTRAIT.0,
            PORTRAIT.1,
        );
        let v: Vec<Value> = compose_buddy_layer(LANDSCAPE, &frame, None)
            .and_then(|composed| {
                png_layer(
                    PORTRAIT,
                    portrait_box,
                    (composed.rect[2], composed.rect[3]),
                    &composed.bgra,
                )
            })
            .into_iter()
            .collect();
        let mut built = content(h, v, layout.show_on_stream, layout.show_in_recording);
        // The pose set and the motion go together: a page with the atlas
        // and no motion would draw a resting cell.
        match animated_atlas.as_deref() {
            Some(atlas) => {
                let now = chrono::Utc::now().timestamp_millis();
                let live_bubble = bubble
                    .as_ref()
                    .zip(bubble_until.filter(|until| *until > now));
                built["animated"] = animated_lanes(atlas, &layout, live_bubble);
                set_motion_seed(Some(MotionSeed {
                    atlas_hash: atlas.hash.clone(),
                    pack: atlas.pack.clone(),
                    rects: [layout.horizontal, layout.vertical],
                }));
            }
            None => set_motion_seed(None),
        }
        last_key = Some(key);
        crate::room_content::set_built_avatar(built);
    }
}

// --- The motion stream (R6b) ------------------------------------------------------------------

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// The motion model while the backend builds the avatar (Electron's
/// `RoomAvatarMotion` in its backend-room mode): one producer per hold and
/// seed, fed the animator's public inputs as they come (`cohost.pet.animator`,
/// `BuddySpriteSlot::publish_animator`'s projection), flushed every 100 ms
/// through the avatar publisher's connection (`room_avatar::send_motion`,
/// which stamps the host's session and the room and sends only to the pages
/// that animate). A page not served yet, a new pack and a failed send get a
/// keyframe at the next flush; a hold that ends, or content without the pose
/// set, stops it (the next one is a new epoch).
async fn run_motion(state: AppState) {
    let mut events = state.events.subscribe();
    let mut flush = tokio::time::interval(MOTION_FLUSH);
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut motion: Option<BackendMotion> = None;
    loop {
        let received = tokio::select! {
            received = events.recv() => Some(received),
            _ = flush.tick() => None,
        };
        match received {
            Some(Ok(event)) => {
                if event.event == crate::buddy_sprite::BUDDY_ANIMATOR_EVENT
                    && let Some(running) = motion.as_mut()
                {
                    running.backend(&event.payload, now_ms());
                }
            }
            // Inputs missed under load: the stream carries on from what it has.
            Some(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
            Some(Err(tokio::sync::broadcast::error::RecvError::Closed)) => return,
            None => {
                let Some(seed) =
                    motion_seed().filter(|_| building() && crate::room_host::holds_seat())
                else {
                    motion = None;
                    continue;
                };
                let now = now_ms();
                if let Some(running) = motion.as_mut() {
                    running.follow(seed, now);
                } else {
                    let settings =
                        public_settings(state.cohost.lock().await.settings().persona.motion);
                    let avatar_state = crate::buddy_overlay::status(&state).await.state;
                    motion = Some(BackendMotion::new(seed, settings, avatar_state, now));
                }
                let Some(running) = motion.as_mut() else {
                    continue;
                };
                for message in running.flush(now) {
                    match crate::room_avatar::send_motion(&message).await {
                        Ok(targets) => running.sent(targets),
                        Err(error) => {
                            running.failed(&error);
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// One run of the motion model (one epoch).
struct BackendMotion {
    producer: MotionProducer,
    seed: MotionSeed,
    /// The pages the last send reached; a new one gets a keyframe.
    consumers: HashSet<String>,
    force_keyframe: bool,
    failing: bool,
}

impl BackendMotion {
    fn new(
        seed: MotionSeed,
        settings: BuddyMotionSettings,
        avatar_state: CohostAvatarState,
        now: f64,
    ) -> Self {
        let random = *uuid::Uuid::new_v4().as_bytes();
        let animator_seed = u64::from_le_bytes([
            random[0], random[1], random[2], random[3], random[4], random[5], random[6], random[7],
        ]);
        let inputs = MotionInputs {
            avatar_state,
            rects: seed.rects,
            cards: [None, None],
            atlas_hash: seed.atlas_hash.clone(),
            pack: seed.pack.clone(),
        };
        Self {
            producer: MotionProducer::new(
                String::new(),
                MOTION_PUBLISHER_STAND_IN.to_string(),
                uuid::Uuid::new_v4().simple().to_string(),
                animator_seed,
                settings,
                inputs,
                now,
            ),
            seed,
            consumers: HashSet::new(),
            force_keyframe: true,
            failing: false,
        }
    }

    /// `cohost.pet.animator`: plan 164's state first, then the event, as the
    /// backend applied them together. Anything the pages would refuse is
    /// dropped here.
    fn backend(&mut self, payload: &Value, now: f64) {
        if let Some(state) = payload
            .get("avatarState")
            .and_then(Value::as_str)
            .and_then(parse_avatar_state)
        {
            self.producer.push(MotionEvent::State(state), now);
        }
        if let Some(event) = payload.get("event").and_then(PublicEvent::parse) {
            self.producer.push(MotionEvent::Animator(event), now);
        }
    }

    /// The built content changed: a new pack (with a keyframe), a new layout.
    fn follow(&mut self, seed: MotionSeed, now: f64) {
        if seed.atlas_hash != self.seed.atlas_hash || seed.pack != self.seed.pack {
            self.producer.push(
                MotionEvent::Pack {
                    atlas_hash: seed.atlas_hash.clone(),
                    pack: seed.pack.clone(),
                },
                now,
            );
            self.force_keyframe = true;
        }
        if seed.rects != self.seed.rects {
            self.producer.push(MotionEvent::Layout(seed.rects), now);
        }
        self.seed = seed;
    }

    fn flush(&mut self, now: f64) -> Vec<Value> {
        let messages = self.producer.flush(self.force_keyframe, now);
        self.force_keyframe = false;
        messages
    }

    fn sent(&mut self, targets: Vec<String>) {
        if targets
            .iter()
            .any(|target| !self.consumers.contains(target))
        {
            self.force_keyframe = true;
        }
        self.consumers = targets.into_iter().collect();
        self.failing = false;
    }

    fn failed(&mut self, error: &anyhow::Error) {
        if !self.failing {
            tracing::warn!(
                "Couldn't send the avatar's motion; animating outputs hold its pose and catch up. ({error:#})"
            );
        }
        self.failing = true;
        self.force_keyframe = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layer_is_a_png_named_by_its_hash_in_canvas_fractions() {
        // 2×1 pixels: one opaque red (BGRA), one clear.
        let bgra = [0, 0, 255, 255, 0, 0, 0, 0];
        let layer = png_layer((100, 50), [10.0, 5.0, 2.0, 1.0], (2, 1), &bgra).expect("a layer");
        assert_eq!(layer["kind"], "avatar");
        assert_eq!(
            layer["rect"],
            json!({ "x": 0.1, "y": 0.1, "w": 0.02, "h": 0.02 })
        );
        assert_eq!(layer["asset"]["width"], 2);
        let png = base64::engine::general_purpose::STANDARD
            .decode(layer["asset"]["png"].as_str().unwrap())
            .unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            layer["asset"]["hash"],
            format!("{:x}", Sha256::digest(&png))
        );
        assert_eq!(layer["expiresAt"], Value::Null);
        // Placed elsewhere than its size: the rect is the place.
        let placed = png_layer((100, 50), [0.0, 0.0, 50.0, 25.0], (2, 1), &bgra).unwrap();
        assert_eq!(placed["rect"]["w"], json!(0.5));
        assert_eq!(placed["asset"]["width"], 2);
        // Short pixels or an empty size: none.
        assert!(png_layer((100, 50), [0.0, 0.0, 2.0, 2.0], (2, 2), &bgra).is_none());
        assert!(png_layer((100, 50), [0.0, 0.0, 0.0, 1.0], (2, 1), &bgra).is_none());
    }

    #[test]
    fn a_layer_a_page_would_refuse_is_not_made() {
        // Wider than 1024 px (`avatarPng`).
        let wide = vec![255_u8; 1025 * 4];
        assert!(png_layer((1920, 1080), [0.0, 0.0, 1025.0, 1.0], (1025, 1), &wide).is_none());
        let edge = vec![255_u8; 1024 * 4];
        assert!(png_layer((1920, 1080), [0.0, 0.0, 1024.0, 1.0], (1024, 1), &edge).is_some());
        // Noise does not compress: 300² pixels are far over 256 KiB of base64.
        let mut seed = 0x2545_F491_u32;
        let noise = (0..300 * 300 * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 24) as u8
            })
            .collect::<Vec<_>>();
        assert!(png_layer((1920, 1080), [0.0, 0.0, 300.0, 300.0], (300, 300), &noise).is_none());
    }

    #[test]
    fn the_content_names_its_lanes_and_outputs() {
        let content = content(vec![json!(1)], Vec::new(), true, false);
        assert_eq!(
            content,
            json!({ "h": [1], "v": [], "stream": true, "recording": false })
        );
    }

    // --- R6b: the pose set and the motion stream ---------------------------------------------

    use base64::Engine as _;

    use crate::buddy_pet::PetFrameKind;
    use crate::buddy_sprite::BuddySpritePackMeta;

    /// A leg atlas of `cell_px` cells: three gaze frames, `wave`, and `blink`
    /// drawing the neutral frame's cell (frames may share one), each cell
    /// one flat colour.
    fn leg_atlas(pack_id: &str, cell_px: u32) -> BuddySpriteAtlas {
        let colours = [[200, 40, 40], [40, 200, 40], [40, 40, 200], [200, 200, 40]];
        let cells = colours
            .iter()
            .map(|[r, g, b]| {
                image::RgbaImage::from_pixel(cell_px, cell_px, image::Rgba([*r, *g, *b, 255]))
            })
            .collect::<Vec<_>>();
        let frames = vec![
            (
                "look-22".to_string(),
                PetFrameKind::Gaze,
                Some([0.0, 0.0]),
                0,
            ),
            (
                "look-02".to_string(),
                PetFrameKind::Gaze,
                Some([-1.0, 0.0]),
                1,
            ),
            (
                "look-42".to_string(),
                PetFrameKind::Gaze,
                Some([1.0, 0.0]),
                2,
            ),
            ("wave".to_string(), PetFrameKind::Reaction, None, 3),
            ("blink".to_string(), PetFrameKind::Reaction, None, 0),
        ];
        let meta = Arc::new(BuddySpritePackMeta {
            pack_id: pack_id.to_string(),
            neutral: "look-22".to_string(),
            pivot: [0.5, 0.9],
            head_top: 0.2,
            talk: Vec::new(),
            source_cell_px: cell_px,
            unique_cells: 4,
        });
        BuddySpriteAtlas::from_cells(&cells, cell_px, frames, meta)
    }

    fn layout() -> OverlayItemLayout {
        OverlayItemLayout {
            horizontal: OverlayRect::new(0.82, 0.72, 0.125, 0.25),
            vertical: OverlayRect::new(0.05, 0.82, 0.22, 0.125),
            show_on_stream: true,
            show_in_recording: false,
        }
    }

    #[test]
    fn the_pose_set_is_the_pack_repacked_within_the_pages_limits() {
        let atlas = cloud_atlas(&leg_atlas("bundled:fixture", 120)).expect("a pose set");
        // Four distinct cells at the leg's own 120 px, two by two.
        assert_eq!((atlas.width, atlas.height), (240, 240));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&atlas.png)
            .expect("base64");
        assert_eq!(atlas.hash, format!("{:x}", Sha256::digest(&bytes)));
        assert!(atlas.png.len() <= 256 * 1024);
        let sheet = image::load_from_memory(&bytes).expect("a PNG").to_rgba8();
        assert_eq!(sheet.dimensions(), (240, 240));
        // The meta is the pack (the pages' `parseAnimatorPack`) plus a
        // square cell rect per frame inside the PNG; frames sharing a cell
        // share its rect.
        assert_eq!(AnimatorPack::parse(&atlas.meta).as_ref(), Some(&atlas.pack));
        let cells = atlas.meta["cells"].as_array().expect("cells");
        let rect = |id: &str| {
            cells
                .iter()
                .find(|cell| cell["id"] == id)
                .map(|cell| cell["rect"].clone())
                .expect(id)
        };
        for cell in cells {
            let [x, y, w, h] =
                [0_usize, 1, 2, 3].map(|i| cell["rect"][i].as_u64().expect("an integer"));
            assert!(w == h && w >= 32 && x + w <= 240 && y + h <= 240, "{cell}");
        }
        assert_eq!(rect("blink"), rect("look-22"));
        assert_ne!(rect("wave"), rect("look-22"));
        // Each frame's rect holds its own picture.
        let wave = rect("wave");
        let centre = sheet.get_pixel(
            (wave[0].as_u64().unwrap() + 60) as u32,
            (wave[1].as_u64().unwrap() + 60) as u32,
        );
        assert_eq!(centre.0, [200, 200, 40, 255]);
        assert_eq!(atlas.meta["neutral"], "look-22");
        assert_eq!(atlas.meta["cells"][4]["gaze"], Value::Null);
    }

    #[test]
    fn the_still_avatar_and_a_pack_the_pages_refuse_get_no_pose_set() {
        assert!(cloud_atlas(&leg_atlas(crate::buddy_pet::STILL_PACK_ID, 120)).is_none());
        // Cells under 32 px are too small to send.
        assert!(cloud_atlas(&leg_atlas("bundled:fixture", 24)).is_none());
        // An id the pages refuse.
        let mut bad = leg_atlas("bundled:fixture", 120);
        bad.cells[3].id = "Wave!".to_string();
        assert!(cloud_atlas(&bad).is_none());
        // The grid never passes 1024 px, the cells never 256 px.
        assert_eq!(cloud_grid(40, 256), (7, 6, 146));
        assert_eq!(cloud_grid(4, 256), (2, 2, 256));
        assert_eq!(cloud_grid(64, 256), (8, 8, 128));
    }

    #[test]
    fn each_animated_lane_carries_the_atlas_in_the_compositors_box() {
        let atlas = cloud_atlas(&leg_atlas("bundled:fixture", 120)).expect("a pose set");
        let lanes = animated_lanes(&atlas, &layout(), None);
        for (lane, canvas) in [("h", (1920.0, 1080.0)), ("v", (1080.0, 1920.0))] {
            let layers = lanes[lane].as_array().expect(lane);
            assert_eq!(layers.len(), 1, "no bubble, no bubble layer");
            let layer = &layers[0];
            assert_eq!(layer["kind"], "avatar");
            assert_eq!(layer["expiresAt"], Value::Null);
            assert_eq!(layer["atlas"], atlas.meta);
            assert_eq!(layer["asset"]["hash"], atlas.hash);
            assert_eq!(layer["asset"]["width"], 240);
            // `atlasLayerRect`: a square of the rect's width in canvas pixels.
            let w = layer["rect"]["w"].as_f64().unwrap() * canvas.0;
            let h = layer["rect"]["h"].as_f64().unwrap() * canvas.1;
            assert!((w - h).abs() < 1e-6, "{lane}: {w} x {h}");
        }
        // Landscape: 240 px (0.125 × 1920) centred on the rect, resting on its bottom edge.
        assert_eq!(
            lanes["h"][0]["rect"],
            json!({ "x": 1574.0 / 1920.0, "y": 808.0 / 1080.0, "w": 240.0 / 1920.0, "h": 240.0 / 1080.0 })
        );
    }

    fn seed() -> MotionSeed {
        let atlas = cloud_atlas(&leg_atlas("bundled:fixture", 120)).expect("a pose set");
        MotionSeed {
            atlas_hash: atlas.hash,
            pack: atlas.pack,
            rects: [layout().horizontal, layout().vertical],
        }
    }

    fn event_kinds(message: &Value) -> Vec<String> {
        message["events"]
            .as_array()
            .expect("events")
            .iter()
            .map(|event| {
                event["event"]["kind"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn the_motion_stream_follows_the_animators_public_inputs_and_the_content() {
        let start = 1_700_000_000_000.0;
        let mut motion = BackendMotion::new(
            seed(),
            public_settings(BuddyMotionSettings::default()),
            CohostAvatarState::Idle,
            start,
        );
        // The first flush is a keyframe, of the seed's pack and rects.
        let first = motion.flush(start + 100.0);
        assert_eq!(first.len(), 1);
        let keyframe = &first[0]["keyframe"];
        assert_eq!(keyframe["inputs"]["atlasHash"], seed().atlas_hash);
        assert_eq!(keyframe["inputs"]["pack"], seed().pack.to_json());
        assert_eq!(first[0]["publisherSid"], MOTION_PUBLISHER_STAND_IN);
        assert!(
            first[0]["epoch"]
                .as_str()
                .is_some_and(|epoch| epoch.len() == 32)
        );
        // `cohost.pet.animator`: the state, then the event; anything private
        // or malformed never goes out.
        motion.backend(
            &json!({
                "avatarState": "talk",
                "event": { "kind": "utterance", "mood": "talk", "chars": 12, "bubbleSeconds": 2.0 }
            }),
            start + 200.0,
        );
        motion.backend(
            &json!({ "event": { "kind": "utterance", "mood": "talk", "chars": 12, "bubbleSeconds": 2.0, "text": "hi" } }),
            start + 210.0,
        );
        let sent = motion.flush(start + 300.0);
        assert_eq!(sent.len(), 1);
        assert_eq!(event_kinds(&sent[0]), vec!["state", "utterance"]);
        assert_eq!(sent[0]["keyframe"], Value::Null);
        // A page it has not served gets a keyframe at the next flush.
        motion.sent(vec!["EG_stream_h".to_string()]);
        let keyframed = motion.flush(start + 400.0);
        assert!(!keyframed[0]["keyframe"].is_null());
        motion.sent(vec!["EG_stream_h".to_string()]);
        assert!(motion.flush(start + 500.0).is_empty());
        // A new layout and a new pack follow the content; the pack with a keyframe.
        let mut moved = seed();
        moved.rects[0] = OverlayRect::new(0.02, 0.05, 0.15, 0.27);
        motion.follow(moved.clone(), start + 600.0);
        let laid = motion.flush(start + 700.0);
        assert_eq!(event_kinds(&laid[0]), vec!["layout"]);
        assert!(laid[0]["keyframe"].is_null());
        let mut repacked = moved;
        repacked.atlas_hash = "b".repeat(64);
        motion.follow(repacked, start + 800.0);
        let packed = motion.flush(start + 900.0);
        assert_eq!(event_kinds(&packed[0]), vec!["pack"]);
        assert!(!packed[0]["keyframe"].is_null());
        assert_eq!(packed[0]["keyframe"]["inputs"]["atlasHash"], "b".repeat(64));
        // A failed send asks for a keyframe.
        motion.failed(&anyhow::anyhow!("offline"));
        assert!(!motion.flush(start + 1000.0)[0]["keyframe"].is_null());
    }
}
