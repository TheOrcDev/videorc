//! Buddy on the Electron proof surface (plan 205 S9, owner decision D6).
//!
//! The Windows idle preview and the Linux preview are composed by Electron
//! main from raw source frames; no compositor leg draws there. So the
//! backend serves the Buddy's layer on its own: the pet's current cell and
//! its speech bubble, exactly what the compositor legs burn in, rendered
//! into one small straight-alpha BGRA frame that covers the layer's rect on
//! the proof surface's canvas, and served at `/preview/buddy/latest.bmp`
//! beside the camera and screen routes. Main places the `<img>` at the rect
//! the response names (canvas fractions) above the banners.
//!
//! On demand only: every fetch draws one frame from the sprite slot's
//! `Preview` leg (its own atlas, so it never fights an output leg over one)
//! at the Preview clock (`BuddySpriteSlot::preview_clock_seconds`: an
//! output leg's own instant while one draws, else the slot's clock), so the
//! pet animates as the legs do. Nothing runs between fetches. A frame that
//! would be identical to the last one served (the same cell, transform,
//! bubble and rect: a sleeping pet) answers `204 Unchanged` to the caller's
//! cursor without rendering. While the program does not carry the Buddy
//! (`program_shows`, D1/D2: either switch at idle or under Clips, the
//! running outputs' switches otherwise) the route answers `204` with
//! `x-videorc-layer-empty: 1`, and main draws nothing.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::buddy_sprite::{
    BuddyLegFrame, BuddyLegRequest, BuddySpriteDraw, BuddySpriteLeg, blit_sprite_affine_to_bgra,
    buddy_bubble_blit_layout, source_over_straight_bgra, sprite_canvas_rect,
};
use crate::captions::CaptionOverlay;
use crate::overlay_layout::{OverlayItemLayout, OverlayRect, OverlaySessionShape, program_shows};
use crate::preview_bmp::PreviewBmpCursor;
use crate::protocol::SceneEditorDraftStatus;
use crate::state::AppState;

/// The proof surface's preview budget box (`DEFAULT_PREVIEW_CANVAS` in
/// `main/preview-surface-banners.ts`), the canvas a fetch that names none is
/// drawn for.
pub const DEFAULT_PREVIEW_BUDDY_CANVAS: (u32, u32) = (1280, 720);
/// A fetched canvas side is kept within these, whatever main asks for.
const MIN_CANVAS_SIDE: u32 = 16;
const MAX_CANVAS_SIDE: u32 = 4096;

/// `BITMAPFILEHEADER` (14) plus `BITMAPV4HEADER` (108): the pixel offset.
const BMP_V4_PIXEL_OFFSET: u32 = 122;
const BMP_V4_HEADER_SIZE: u32 = 108;
const BI_BITFIELDS: u32 = 3;
/// `LCS_sRGB`: the V4 header's colour space.
const LCS_SRGB: u32 = 0x7352_4742;

/// The headers a file-origin fetch may read (the proof page is `file://`).
pub const PREVIEW_BUDDY_LAYER_EXPOSED_HEADERS: &str = "x-videorc-frame-transport, x-videorc-frame-generation, x-videorc-frame-sequence, x-videorc-frame-width, x-videorc-frame-height, x-videorc-frame-stride, x-videorc-pixel-format, x-videorc-layer-rect, x-videorc-layer-canvas, x-videorc-layer-empty";

// --- The query ------------------------------------------------------------------------

/// `/preview/buddy/latest.bmp?token=&canvasWidth=&canvasHeight=&afterGeneration=&afterSequence=`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBuddyLayerQuery {
    token: String,
    /// The canvas main places the proof surface's layers against (its
    /// `bannerCanvas`), default [`DEFAULT_PREVIEW_BUDDY_CANVAS`].
    #[serde(default)]
    canvas_width: Option<u32>,
    #[serde(default)]
    canvas_height: Option<u32>,
    #[serde(default)]
    after_sequence: Option<u64>,
    #[serde(default)]
    after_generation: Option<String>,
}

impl PreviewBuddyLayerQuery {
    pub fn canvas(&self) -> (u32, u32) {
        bounded_canvas(self.canvas_width, self.canvas_height)
    }

    pub fn cursor(&self) -> Option<PreviewBmpCursor> {
        Some(PreviewBmpCursor {
            generation: self.after_generation.clone()?,
            sequence: self.after_sequence?,
        })
    }
}

/// The canvas a fetch names, or the default when a side is missing; each
/// side kept within `MIN_CANVAS_SIDE..=MAX_CANVAS_SIDE`.
pub fn bounded_canvas(width: Option<u32>, height: Option<u32>) -> (u32, u32) {
    match (width, height) {
        (Some(width), Some(height)) => (
            width.clamp(MIN_CANVAS_SIDE, MAX_CANVAS_SIDE),
            height.clamp(MIN_CANVAS_SIDE, MAX_CANVAS_SIDE),
        ),
        _ => DEFAULT_PREVIEW_BUDDY_CANVAS,
    }
}

// --- The program ------------------------------------------------------------------------

/// The program shape the proof surface's Buddy follows (plan 205 D1, D2),
/// from the running session if any: `(replay_only, overlay_session_shape)`.
/// No session, or a buffer-only one (Clips: the ring keeps the recording
/// plan while the Preview shows the idle program), is the idle program,
/// `Some(None)`. A session with a plan is its own shape. A session without
/// one runs a path that draws no overlays at all, so nothing carries the
/// Buddy: `None`.
pub fn buddy_program_shape(
    session: Option<(bool, Option<OverlaySessionShape>)>,
) -> Option<Option<OverlaySessionShape>> {
    match session {
        None => Some(None),
        Some((true, _)) => Some(None),
        Some((false, Some(shape))) => Some(Some(shape)),
        Some((false, None)) => None,
    }
}

/// Whether the program carries the Buddy with this layout, for a session
/// read as in [`buddy_program_shape`].
pub fn buddy_in_program(
    session: Option<(bool, Option<OverlaySessionShape>)>,
    layout: &OverlayItemLayout,
) -> bool {
    buddy_program_shape(session)
        .is_some_and(|shape| program_shows(shape, layout.show_on_stream, layout.show_in_recording))
}

/// Where the Scene editor holds the Buddy, if it drags it: the compositor's
/// `primary_buddy_place` for a leg whose plan carries the Buddy. A draft of
/// another item, or a chrome-only hold of the Buddy, leaves the saved rect.
pub fn buddy_editor_place(draft: Option<&SceneEditorDraftStatus>) -> Option<OverlayRect> {
    let draft = draft.filter(|draft| draft.source_id == crate::compositor::BUDDY_DRAFT_ID)?;
    let transform = draft.transform?;
    Some(OverlayRect::new(
        transform.x,
        transform.y,
        transform.width,
        transform.height,
    ))
}

// --- Composition ------------------------------------------------------------------------

/// The layer composed for one fetch: its rect on the canvas (pixels) and its
/// straight-alpha BGRA pixels, `rect[2] × rect[3]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposedBuddyLayer {
    pub rect: [u32; 4],
    pub bgra: Vec<u8>,
}

/// The bubble's rect on the canvas for this leg frame, `[x, y, w, h]` with
/// the source column it starts at, as `compositor::buddy_bubble_layout`
/// places it: above the pet's head.
fn bubble_canvas_rect(
    bubble: &CaptionOverlay,
    frame: &BuddyLegFrame,
    canvas: (u32, u32),
) -> Option<([u32; 4], usize)> {
    let (canvas_width, canvas_height) = (canvas.0.max(1) as usize, canvas.1.max(1) as usize);
    let (source_left, dest_left, dest_top, draw_width) = buddy_bubble_blit_layout(
        bubble.width as usize,
        bubble.height as usize,
        canvas_width,
        canvas_height,
        frame.bubble_anchor,
    );
    let draw_width = draw_width.min(canvas_width.saturating_sub(dest_left));
    let draw_height = (bubble.height as usize).min(canvas_height.saturating_sub(dest_top));
    if draw_width == 0 || draw_height == 0 || source_left >= bubble.width as usize {
        return None;
    }
    Some((
        [
            dest_left as u32,
            dest_top as u32,
            draw_width as u32,
            draw_height as u32,
        ],
        source_left,
    ))
}

fn union_rect(a: [u32; 4], b: [u32; 4]) -> [u32; 4] {
    let left = a[0].min(b[0]);
    let top = a[1].min(b[1]);
    let right = (a[0] + a[2]).max(b[0] + b[2]);
    let bottom = (a[1] + a[3]).max(b[1] + b[3]);
    [left, top, right - left, bottom - top]
}

/// Render the Buddy's layer for one frame on a canvas: the pet (when its
/// atlas exists and the source drew it) and the bubble (when one shows),
/// into a transparent BGRA frame covering their union rect. `None` when
/// neither draws anything.
pub fn compose_buddy_layer(
    canvas: (u32, u32),
    frame: &BuddyLegFrame,
    bubble: Option<&CaptionOverlay>,
) -> Option<ComposedBuddyLayer> {
    let sprite = frame.sprite.as_ref().and_then(|sprite| {
        sprite_canvas_rect(&sprite.draw, canvas.0, canvas.1).map(|rect| (sprite, rect))
    });
    let bubble = bubble.and_then(|bubble| {
        bubble_canvas_rect(bubble, frame, canvas)
            .map(|(rect, source_left)| (bubble, rect, source_left))
    });
    let rect = match (sprite.as_ref(), bubble.as_ref()) {
        (Some((_, sprite_rect)), Some((_, bubble_rect, _))) => {
            union_rect(*sprite_rect, *bubble_rect)
        }
        (Some((_, sprite_rect)), None) => *sprite_rect,
        (None, Some((_, bubble_rect, _))) => *bubble_rect,
        (None, None) => return None,
    };
    let [x, y, width, height] = rect;
    let mut bgra = vec![0_u8; width as usize * height as usize * 4];
    if let Some((sprite, _)) = sprite {
        blit_sprite_affine_to_bgra(
            &mut bgra,
            width,
            height,
            (x, y),
            &sprite.atlas,
            &sprite.draw,
        );
    }
    if let Some((bubble, bubble_rect, source_left)) = bubble {
        composite_bubble(&mut bgra, rect, bubble, bubble_rect, source_left);
    }
    Some(ComposedBuddyLayer { rect, bgra })
}

/// Straight-alpha source-over of the bubble's RGBA rows into the layer,
/// the same blend `compositor::composite_overlay_at` does in yuv.
fn composite_bubble(
    bgra: &mut [u8],
    layer_rect: [u32; 4],
    bubble: &CaptionOverlay,
    bubble_rect: [u32; 4],
    source_left: usize,
) {
    let bubble_width = bubble.width as usize;
    if bubble.rgba.len() < bubble_width * bubble.height as usize * 4 {
        return;
    }
    let layer_width = layer_rect[2] as usize;
    let [bx, by, bw, bh] = bubble_rect.map(|value| value as usize);
    for row in 0..bh {
        for column in 0..bw {
            let source = ((row * bubble_width) + source_left + column) * 4;
            let pixel = &bubble.rgba[source..source + 4];
            if pixel[3] == 0 {
                continue;
            }
            let dest_x = bx + column - layer_rect[0] as usize;
            let dest_y = by + row - layer_rect[1] as usize;
            let index = (dest_y * layer_width + dest_x) * 4;
            source_over_straight_bgra(
                &mut bgra[index..index + 4],
                [
                    f32::from(pixel[2]),
                    f32::from(pixel[1]),
                    f32::from(pixel[0]),
                ],
                f32::from(pixel[3]) / 255.0,
            );
        }
    }
}

/// A top-down 32-bit BMP with a real alpha channel: a `BITMAPV4HEADER` with
/// `BI_BITFIELDS` masks (B `0x000000FF`, G `0x0000FF00`, R `0x00FF0000`, A
/// `0xFF000000`), so Chromium's decoder reads the fourth byte as alpha
/// instead of guessing. The BGRA bytes are appended as they are.
pub fn encode_bgra_bmp_with_alpha(width: u32, height: u32, bgra: &[u8]) -> Option<Vec<u8>> {
    let width = width.max(1);
    let height = height.max(1);
    let stride = width.checked_mul(4)?;
    let pixel_bytes = stride.checked_mul(height)?;
    if bgra.len() < pixel_bytes as usize {
        return None;
    }
    let file_size = BMP_V4_PIXEL_OFFSET.checked_add(pixel_bytes)?;
    let mut bmp = Vec::with_capacity(file_size as usize);
    // BITMAPFILEHEADER.
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&file_size.to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&BMP_V4_PIXEL_OFFSET.to_le_bytes());
    // BITMAPV4HEADER.
    bmp.extend_from_slice(&BMP_V4_HEADER_SIZE.to_le_bytes());
    bmp.extend_from_slice(&i32::try_from(width).ok()?.to_le_bytes());
    bmp.extend_from_slice(&i32::try_from(height).ok()?.checked_neg()?.to_le_bytes());
    bmp.extend_from_slice(&1_u16.to_le_bytes());
    bmp.extend_from_slice(&32_u16.to_le_bytes());
    bmp.extend_from_slice(&BI_BITFIELDS.to_le_bytes());
    bmp.extend_from_slice(&pixel_bytes.to_le_bytes());
    bmp.extend_from_slice(&0_i32.to_le_bytes());
    bmp.extend_from_slice(&0_i32.to_le_bytes());
    bmp.extend_from_slice(&0_u32.to_le_bytes());
    bmp.extend_from_slice(&0_u32.to_le_bytes());
    bmp.extend_from_slice(&0x00FF_0000_u32.to_le_bytes());
    bmp.extend_from_slice(&0x0000_FF00_u32.to_le_bytes());
    bmp.extend_from_slice(&0x0000_00FF_u32.to_le_bytes());
    bmp.extend_from_slice(&0xFF00_0000_u32.to_le_bytes());
    bmp.extend_from_slice(&LCS_SRGB.to_le_bytes());
    // CIEXYZTRIPLE endpoints (36 bytes) and the three gammas: unused for sRGB.
    bmp.extend_from_slice(&[0; 36]);
    bmp.extend_from_slice(&[0; 12]);
    debug_assert_eq!(bmp.len(), BMP_V4_PIXEL_OFFSET as usize);
    bmp.extend_from_slice(&bgra[..pixel_bytes as usize]);
    Some(bmp)
}

// --- The served frame -----------------------------------------------------------------

/// One served Buddy layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewBuddyLayerFrame {
    pub generation: String,
    pub sequence: u64,
    /// The canvas the layer was drawn for.
    pub canvas: (u32, u32),
    /// The layer's rect on that canvas, pixels `[x, y, w, h]`.
    pub rect: [u32; 4],
    /// The BMP file.
    pub bytes: Vec<u8>,
}

impl PreviewBuddyLayerFrame {
    pub fn width(&self) -> u32 {
        self.rect[2]
    }

    pub fn height(&self) -> u32 {
        self.rect[3]
    }

    pub fn stride(&self) -> u32 {
        self.rect[2] * 4
    }

    /// The rect as canvas fractions, `x,y,w,h`, the way main places layers.
    pub fn rect_fractions(&self) -> String {
        let (width, height) = (
            f64::from(self.canvas.0.max(1)),
            f64::from(self.canvas.1.max(1)),
        );
        format!(
            "{:.6},{:.6},{:.6},{:.6}",
            f64::from(self.rect[0]) / width,
            f64::from(self.rect[1]) / height,
            f64::from(self.rect[2]) / width,
            f64::from(self.rect[3]) / height
        )
    }
}

/// What one fetch gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewBuddyLayerPoll {
    Frame(PreviewBuddyLayerFrame),
    /// The caller's cursor already names this frame.
    Unchanged {
        generation: String,
        sequence: u64,
    },
    /// The program does not carry the Buddy, or nothing of it draws yet.
    Empty,
}

/// What made the last served frame: a fetch that would make the same frame
/// again serves it again (or `Unchanged` to its cursor) without drawing.
#[derive(Debug, Clone, PartialEq)]
struct LayerKey {
    canvas: (u32, u32),
    atlas_revision: Option<u64>,
    draw: Option<BuddySpriteDraw>,
    bubble: Option<(u64, u32, u32)>,
    anchor: (u32, u32),
}

impl LayerKey {
    fn new(canvas: (u32, u32), frame: &BuddyLegFrame, bubble: Option<&CaptionOverlay>) -> Self {
        Self {
            canvas,
            atlas_revision: frame.sprite.as_ref().map(|sprite| sprite.atlas.revision),
            draw: frame.sprite.as_ref().map(|sprite| sprite.draw),
            bubble: bubble.map(|bubble| (bubble.revision, bubble.width, bubble.height)),
            anchor: (
                frame.bubble_anchor.x.to_bits(),
                frame.bubble_anchor.y.to_bits(),
            ),
        }
    }
}

struct LayerMemo {
    key: LayerKey,
    frame: PreviewBuddyLayerFrame,
}

static MEMO: Mutex<Option<LayerMemo>> = Mutex::new(None);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static GENERATION: OnceLock<String> = OnceLock::new();

/// Process-unique, so a relaunched backend never matches a stale cursor.
fn generation() -> &'static str {
    GENERATION.get_or_init(|| {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or_default();
        format!("buddy-layer-{}-{millis}", std::process::id())
    })
}

fn memo() -> std::sync::MutexGuard<'static, Option<LayerMemo>> {
    MEMO.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The Buddy's layer for the proof surface's canvas, drawn now.
pub async fn latest_preview_buddy_layer(
    state: &AppState,
    canvas: (u32, u32),
    cursor: Option<PreviewBmpCursor>,
) -> PreviewBuddyLayerPoll {
    let layout = state.buddy_sprite.layout();
    let session = state
        .recording
        .lock()
        .await
        .as_ref()
        .map(|active| (active.replay_only, active.overlay_session_shape));
    if !buddy_in_program(session, &layout) {
        return PreviewBuddyLayerPoll::Empty;
    }
    let place = buddy_editor_place(
        crate::compositor::compositor_status(state)
            .await
            .editor_draft
            .as_ref(),
    );
    let now_seconds = state.buddy_sprite.preview_clock_seconds();
    let frame = state.buddy_sprite.leg_frame_at(
        BuddyLegRequest {
            leg: BuddySpriteLeg::Preview,
            canvas,
            now_seconds,
            highlight_rect: None,
            caption_rect: None,
        },
        place,
    );
    let bubble = crate::captions::current_caption_overlays(&state.buddy_overlay).primary;
    let key = LayerKey::new(canvas, &frame, bubble.as_ref());
    if let Some(memo) = memo().as_ref().filter(|memo| memo.key == key) {
        let frame = &memo.frame;
        if cursor.as_ref().is_some_and(|cursor| {
            cursor.generation == frame.generation && cursor.sequence >= frame.sequence
        }) {
            return PreviewBuddyLayerPoll::Unchanged {
                generation: frame.generation.clone(),
                sequence: frame.sequence,
            };
        }
        return PreviewBuddyLayerPoll::Frame(frame.clone());
    }
    let composed = tokio::task::spawn_blocking(move || {
        let layer = compose_buddy_layer(canvas, &frame, bubble.as_ref())?;
        let bytes = encode_bgra_bmp_with_alpha(layer.rect[2], layer.rect[3], &layer.bgra)?;
        Some((layer.rect, bytes))
    })
    .await
    .ok()
    .flatten();
    let Some((rect, bytes)) = composed else {
        return PreviewBuddyLayerPoll::Empty;
    };
    let frame = PreviewBuddyLayerFrame {
        generation: generation().to_string(),
        sequence: SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1,
        canvas,
        rect,
        bytes,
    };
    *memo() = Some(LayerMemo {
        key,
        frame: frame.clone(),
    });
    PreviewBuddyLayerPoll::Frame(frame)
}

// --- The route --------------------------------------------------------------------------

/// `GET /preview/buddy/latest.bmp` (plan 205 S9), registered in `main.rs`
/// beside the camera and screen BMP routes. Token-gated like them.
pub async fn latest_bmp_handler(
    State(state): State<AppState>,
    Query(query): Query<PreviewBuddyLayerQuery>,
) -> Response {
    if crate::backend_authority::authenticate_backend_token(
        &query.token,
        &state.token,
        &state.admin_token,
    )
    .is_none()
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let poll = latest_preview_buddy_layer(&state, query.canvas(), query.cursor()).await;
    preview_buddy_layer_response(poll)
}

fn response_builder(status: StatusCode) -> axum::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header("access-control-allow-origin", "*")
        .header(
            "access-control-expose-headers",
            PREVIEW_BUDDY_LAYER_EXPOSED_HEADERS,
        )
        .header("x-videorc-frame-transport", "latest-bgra-bmp")
}

/// The HTTP answer: `200 image/bmp` with the cursor, the frame size and the
/// layer's rect; `204` with the cursor when the caller already has this
/// frame; `204` with `x-videorc-layer-empty: 1` when there is no layer.
pub fn preview_buddy_layer_response(poll: PreviewBuddyLayerPoll) -> Response {
    match poll {
        PreviewBuddyLayerPoll::Frame(frame) => response_builder(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/bmp")
            .header("x-videorc-frame-generation", frame.generation.as_str())
            .header("x-videorc-frame-sequence", frame.sequence.to_string())
            .header("x-videorc-frame-width", frame.width().to_string())
            .header("x-videorc-frame-height", frame.height().to_string())
            .header("x-videorc-frame-stride", frame.stride().to_string())
            .header("x-videorc-pixel-format", "bgra8")
            .header("x-videorc-layer-rect", frame.rect_fractions())
            .header(
                "x-videorc-layer-canvas",
                format!("{}x{}", frame.canvas.0, frame.canvas.1),
            )
            .body(Body::from(frame.bytes))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        PreviewBuddyLayerPoll::Unchanged {
            generation,
            sequence,
        } => response_builder(StatusCode::NO_CONTENT)
            .header("x-videorc-frame-generation", generation)
            .header("x-videorc-frame-sequence", sequence.to_string())
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        PreviewBuddyLayerPoll::Empty => response_builder(StatusCode::NO_CONTENT)
            .header("x-videorc-layer-empty", "1")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::buddy_sprite::{
        BUDDY_SPRITE_DEFAULT_PIVOT, BuddySpriteLayer, StaticBuddySpriteSource, buddy_box,
        buddy_bubble_anchor, tests::parity_atlas,
    };
    use crate::overlay_layout::{OverlayAuxLeg, OverlayLayout};
    use crate::protocol::CameraTransform;

    fn shape(record: bool, stream: bool) -> OverlaySessionShape {
        OverlaySessionShape {
            record_enabled: record,
            stream_enabled: stream,
            aux_leg: OverlayAuxLeg::None,
        }
    }

    fn buddy_layout(on_stream: bool, in_recording: bool) -> OverlayItemLayout {
        OverlayItemLayout {
            show_on_stream: on_stream,
            show_in_recording: in_recording,
            ..OverlayLayout::default().buddy
        }
    }

    fn solid_bubble(width: u32, height: u32, rgba: [u8; 4], revision: u64) -> CaptionOverlay {
        let pixels = std::iter::repeat_n(rgba, (width * height) as usize)
            .flatten()
            .collect::<Vec<_>>();
        let bgra = pixels
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], pixel[3]])
            .collect::<Vec<_>>();
        CaptionOverlay {
            rgba: Arc::new(pixels),
            bgra: Arc::new(bgra),
            width,
            height,
            placement: crate::captions::OverlayPlacement::new(
                None,
                crate::captions::CaptionOverlayPosition::default(),
            ),
            revision,
        }
    }

    fn layer_pixel(layer: &ComposedBuddyLayer, x: u32, y: u32) -> [u8; 4] {
        let [lx, ly, lw, _] = layer.rect;
        let index = (((y - ly) * lw + (x - lx)) * 4) as usize;
        let bgra = &layer.bgra[index..index + 4];
        [bgra[2], bgra[1], bgra[0], bgra[3]]
    }

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    #[test]
    fn the_program_follows_d1_and_d2() {
        // Nothing running, or Clips: either switch.
        assert!(buddy_in_program(None, &buddy_layout(true, false)));
        assert!(buddy_in_program(
            Some((true, Some(shape(true, false)))),
            &buddy_layout(true, false)
        ));
        assert!(!buddy_in_program(None, &buddy_layout(false, false)));
        // A recording carries the recording switch, a stream the stream's.
        assert!(!buddy_in_program(
            Some((false, Some(shape(true, false)))),
            &buddy_layout(true, false)
        ));
        assert!(buddy_in_program(
            Some((false, Some(shape(false, true)))),
            &buddy_layout(true, false)
        ));
        assert!(buddy_in_program(
            Some((false, Some(shape(true, true)))),
            &buddy_layout(false, true)
        ));
        // A session whose path draws no overlays carries nothing.
        assert!(!buddy_in_program(
            Some((false, None)),
            &buddy_layout(true, true)
        ));
        assert_eq!(buddy_program_shape(Some((false, None))), None);
    }

    #[test]
    fn the_editor_place_is_the_dragged_buddy_only() {
        let dragged = SceneEditorDraftStatus {
            source_id: crate::compositor::BUDDY_DRAFT_ID.to_string(),
            transform: Some(CameraTransform {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.4,
            }),
            release_at_revision: None,
        };
        assert_eq!(
            buddy_editor_place(Some(&dragged)),
            Some(OverlayRect::new(0.1, 0.2, 0.3, 0.4))
        );
        let held = SceneEditorDraftStatus {
            transform: None,
            ..dragged.clone()
        };
        assert_eq!(buddy_editor_place(Some(&held)), None);
        let banner = SceneEditorDraftStatus {
            source_id: "banner:sponsor".to_string(),
            ..dragged
        };
        assert_eq!(buddy_editor_place(Some(&banner)), None);
        assert_eq!(buddy_editor_place(None), None);
    }

    #[test]
    fn the_canvas_is_bounded_and_defaults() {
        assert_eq!(bounded_canvas(None, None), DEFAULT_PREVIEW_BUDDY_CANVAS);
        assert_eq!(
            bounded_canvas(Some(1920), None),
            DEFAULT_PREVIEW_BUDDY_CANVAS
        );
        assert_eq!(bounded_canvas(Some(1920), Some(1080)), (1920, 1080));
        assert_eq!(bounded_canvas(Some(1), Some(99_999)), (16, 4096));
    }

    #[test]
    fn the_layer_covers_the_pet_and_the_bubble() {
        let atlas = Arc::new(parity_atlas(16));
        let canvas = (64_u32, 48_u32);
        let buddy_box = [20.0, 24.0, 16.0, 16.0];
        let draw = BuddySpriteDraw::at_rest(
            atlas.cell("cell-2").unwrap().rect,
            buddy_box,
            BUDDY_SPRITE_DEFAULT_PIVOT,
        );
        let anchor = buddy_bubble_anchor(buddy_box, 0.25);
        let frame = BuddyLegFrame {
            buddy_box,
            sprite: Some(BuddySpriteLayer {
                atlas: Arc::clone(&atlas),
                draw,
            }),
            bubble_anchor: anchor,
        };
        // The pet alone: exactly its box.
        let pet = compose_buddy_layer(canvas, &frame, None).expect("the pet draws");
        assert_eq!(pet.rect, [20, 24, 16, 16]);
        assert_eq!(layer_pixel(&pet, 28, 32), [50, 70, 230, 255]);
        assert_eq!(
            layer_pixel(&pet, 20, 32),
            [50, 70, 230, 128],
            "the half-alpha ring"
        );
        // With a 20 x 8 bubble: bottom-centre on the anchor (28, 28), so it
        // sits at x 18..38, y 20..28, and the rect is the union.
        let bubble = solid_bubble(20, 8, [255, 255, 255, 255], 3);
        let both = compose_buddy_layer(canvas, &frame, Some(&bubble)).expect("both draw");
        assert_eq!(both.rect, [18, 20, 20, 20]);
        assert_eq!(layer_pixel(&both, 19, 21), [255, 255, 255, 255]);
        assert_eq!(layer_pixel(&both, 28, 32), [50, 70, 230, 255]);
        // Above the bubble, between it and the pet's sides: transparent.
        assert_eq!(layer_pixel(&both, 18, 30)[3], 0);
        // The bubble over the pet's ring: the bubble wins (opaque over).
        assert_eq!(layer_pixel(&both, 28, 24), [255, 255, 255, 255]);
        // The bubble alone (no atlas yet): its own rect.
        let bare = BuddyLegFrame {
            buddy_box,
            sprite: None,
            bubble_anchor: anchor,
        };
        let only = compose_buddy_layer(canvas, &bare, Some(&bubble)).expect("the bubble draws");
        assert_eq!(only.rect, [18, 20, 20, 8]);
        assert_eq!(compose_buddy_layer(canvas, &bare, None), None);
    }

    #[test]
    fn the_bmp_has_a_v4_header_with_an_alpha_mask_and_the_pixels_verbatim() {
        let bgra = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let bmp = encode_bgra_bmp_with_alpha(3, 1, &bgra).unwrap();
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(bmp.len(), 122 + 12);
        assert_eq!(u32::from_le_bytes(bmp[2..6].try_into().unwrap()), 134);
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 122);
        assert_eq!(u32::from_le_bytes(bmp[14..18].try_into().unwrap()), 108);
        assert_eq!(i32::from_le_bytes(bmp[18..22].try_into().unwrap()), 3);
        assert_eq!(
            i32::from_le_bytes(bmp[22..26].try_into().unwrap()),
            -1,
            "top-down"
        );
        assert_eq!(u16::from_le_bytes(bmp[28..30].try_into().unwrap()), 32);
        assert_eq!(
            u32::from_le_bytes(bmp[30..34].try_into().unwrap()),
            BI_BITFIELDS
        );
        assert_eq!(
            u32::from_le_bytes(bmp[54..58].try_into().unwrap()),
            0x00FF_0000
        );
        assert_eq!(
            u32::from_le_bytes(bmp[58..62].try_into().unwrap()),
            0x0000_FF00
        );
        assert_eq!(
            u32::from_le_bytes(bmp[62..66].try_into().unwrap()),
            0x0000_00FF
        );
        assert_eq!(
            u32::from_le_bytes(bmp[66..70].try_into().unwrap()),
            0xFF00_0000
        );
        assert_eq!(&bmp[122..], &bgra);
        assert!(encode_bgra_bmp_with_alpha(3, 1, &bgra[..8]).is_none());
    }

    #[test]
    fn the_response_names_the_rect_the_cursor_and_the_empty_layer() {
        let frame = PreviewBuddyLayerFrame {
            generation: "buddy-layer-test".to_string(),
            sequence: 7,
            canvas: (1280, 720),
            rect: [640, 360, 320, 180],
            bytes: vec![0; 122],
        };
        let response = preview_buddy_layer_response(PreviewBuddyLayerPoll::Frame(frame));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "image/bmp");
        assert_eq!(response.headers()["x-videorc-frame-sequence"], "7");
        assert_eq!(response.headers()["x-videorc-frame-width"], "320");
        assert_eq!(response.headers()["x-videorc-frame-stride"], "1280");
        assert_eq!(
            response.headers()["x-videorc-layer-rect"],
            "0.500000,0.500000,0.250000,0.250000"
        );
        assert_eq!(response.headers()["x-videorc-layer-canvas"], "1280x720");
        assert!(
            response.headers()["access-control-expose-headers"]
                .to_str()
                .unwrap()
                .contains("x-videorc-layer-rect")
        );
        let unchanged = preview_buddy_layer_response(PreviewBuddyLayerPoll::Unchanged {
            generation: "buddy-layer-test".to_string(),
            sequence: 7,
        });
        assert_eq!(unchanged.status(), StatusCode::NO_CONTENT);
        assert_eq!(unchanged.headers()["x-videorc-frame-sequence"], "7");
        assert!(unchanged.headers().get("x-videorc-layer-empty").is_none());
        let empty = preview_buddy_layer_response(PreviewBuddyLayerPoll::Empty);
        assert_eq!(empty.status(), StatusCode::NO_CONTENT);
        assert_eq!(empty.headers()["x-videorc-layer-empty"], "1");
        assert!(empty.headers().get("x-videorc-frame-sequence").is_none());
    }

    #[tokio::test]
    async fn the_query_parses_the_canvas_and_the_cursor() {
        use axum::extract::FromRequestParts;

        let request = axum::http::Request::builder()
            .uri(
                "/preview/buddy/latest.bmp?token=t&canvasWidth=1280&canvasHeight=720&afterGeneration=buddy-layer-a&afterSequence=3&maxWidth=640",
            )
            .body(())
            .unwrap();
        let (mut parts, _) = request.into_parts();
        let Query(query) = Query::<PreviewBuddyLayerQuery>::from_request_parts(&mut parts, &())
            .await
            .unwrap();
        assert_eq!(query.canvas(), (1280, 720));
        assert_eq!(
            query.cursor(),
            Some(PreviewBmpCursor {
                generation: "buddy-layer-a".to_string(),
                sequence: 3,
            })
        );
    }

    /// The route against an `AppState`: empty while the Buddy is off, then
    /// the pet at its box once its atlas exists, `Unchanged` to the cursor
    /// while nothing moves, and a bubble widens the rect.
    #[tokio::test]
    async fn the_route_is_empty_while_the_buddy_is_off_and_serves_the_pet_once_on() {
        let state = test_state();
        let canvas = (320_u32, 180_u32);
        state
            .buddy_sprite
            .set_source(Box::new(StaticBuddySpriteSource));
        // Off for both outputs (the default layout): nothing, and no draw.
        state.buddy_sprite.set_layout(buddy_layout(false, false));
        assert_eq!(
            latest_preview_buddy_layer(&state, canvas, None).await,
            PreviewBuddyLayerPoll::Empty
        );
        assert!(
            state
                .buddy_sprite
                .resident_atlas(BuddySpriteLeg::Preview)
                .is_none(),
            "an off Buddy asks for no atlas"
        );
        // Stream only, nothing running: the program carries it (D1).
        let layout = buddy_layout(true, false);
        state.buddy_sprite.set_layout(layout);
        let expected_box = buddy_box(layout.horizontal, canvas.0, canvas.1);
        let deadline = Instant::now() + Duration::from_secs(20);
        let frame = loop {
            match latest_preview_buddy_layer(&state, canvas, None).await {
                PreviewBuddyLayerPoll::Frame(frame) => break frame,
                PreviewBuddyLayerPoll::Unchanged { .. } => panic!("no cursor was sent"),
                PreviewBuddyLayerPoll::Empty => {
                    assert!(
                        Instant::now() < deadline,
                        "the still pet's atlas never came"
                    );
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        };
        assert_eq!(frame.canvas, canvas);
        assert_eq!(
            frame.rect,
            [
                expected_box[0] as u32,
                expected_box[1] as u32,
                expected_box[2] as u32,
                expected_box[3] as u32
            ]
        );
        assert_eq!(&frame.bytes[..2], b"BM");
        assert_eq!(
            frame.bytes.len(),
            122 + (frame.rect[2] * frame.rect[3] * 4) as usize
        );
        // The still pet has an opaque texel somewhere and a transparent one.
        let pixels = &frame.bytes[122..];
        assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] == 255));
        assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] == 0));
        // The same frame again: `Unchanged` to the cursor, the frame to a
        // caller without one, nothing re-rendered either way.
        let cursor = PreviewBmpCursor {
            generation: frame.generation.clone(),
            sequence: frame.sequence,
        };
        assert_eq!(
            latest_preview_buddy_layer(&state, canvas, Some(cursor.clone())).await,
            PreviewBuddyLayerPoll::Unchanged {
                generation: frame.generation.clone(),
                sequence: frame.sequence,
            }
        );
        assert_eq!(
            latest_preview_buddy_layer(&state, canvas, None).await,
            PreviewBuddyLayerPoll::Frame(frame.clone())
        );
        // A bubble: a new sequence, and the rect grows above the head.
        let bubble = image::RgbaImage::from_pixel(40, 12, image::Rgba([255, 255, 255, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        bubble.write_to(&mut png, image::ImageFormat::Png).unwrap();
        use base64::Engine as _;
        crate::captions::install_caption_overlays(
            &state.buddy_overlay,
            crate::captions::SetCaptionOverlayParams {
                png_base64: base64::engine::general_purpose::STANDARD.encode(png.into_inner()),
                position: crate::captions::CaptionOverlayPosition::default(),
                rect: None,
                target: Some(crate::captions::CaptionOverlayTarget::Primary),
                style_revision: None,
            },
        )
        .unwrap();
        let PreviewBuddyLayerPoll::Frame(with_bubble) =
            latest_preview_buddy_layer(&state, canvas, Some(cursor)).await
        else {
            panic!("the bubble makes a new frame");
        };
        assert!(with_bubble.sequence > frame.sequence);
        assert!(
            with_bubble.rect[1] < frame.rect[1],
            "the bubble sits above the head"
        );
        assert!(with_bubble.rect[2] >= 40);
        // Turn the Buddy off again: empty at once.
        state.buddy_sprite.set_layout(buddy_layout(false, false));
        assert_eq!(
            latest_preview_buddy_layer(&state, canvas, None).await,
            PreviewBuddyLayerPoll::Empty
        );
    }
}
