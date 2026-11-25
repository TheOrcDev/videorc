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
//! Not yet: the atlas variant and the motion topic for animating pages
//! (`animated`, `cloud.room.avatar.motion`); those pages draw this still.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::buddy_sprite::{BuddyLegRequest, BuddySpriteLeg, buddy_box, buddy_rect_for_canvas};
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

/// Builds the content while asked and while the backend holds the room;
/// one task for the backend's life.
pub(crate) async fn run(state: AppState) {
    let mut last_key: Option<String> = None;
    loop {
        tokio::time::sleep(POLL).await;
        if !building() || !crate::room_host::holds_seat() {
            last_key = None;
            continue;
        }
        let layout = state.buddy_sprite.layout();
        let bubble = crate::captions::current_caption_overlays(&state.buddy_overlay).primary;
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
        if last_key.as_ref() == Some(&key) {
            continue;
        }
        last_key = Some(key);
        crate::room_content::set_built_avatar(content(
            h,
            v,
            layout.show_on_stream,
            layout.show_in_recording,
        ));
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
}
