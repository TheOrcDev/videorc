//! S9: public static raster projection. No HTML execution, paths or private AI
//! state leave this renderer-only RPC. Native placement/fades remain the oracle.
use crate::{captions::CaptionOverlay, overlay_layout::OverlayRect, state::AppState};
use anyhow::{Result, bail};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const ASSET_BASE64_MAX: usize = 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotParams {
    pub show_id: String,
    pub known: Option<String>,
}

/// Room output facts are separate from the native capture session. Open-only
/// allows a preview; only a running stream/take starts repeating banners/chat.
pub fn managed_room(state: &AppState) -> bool {
    let runtime = crate::cloud_show::lock(&state.cloud_show);
    runtime.talk_show_room_show_id().is_some()
        && runtime.show.as_ref().is_some_and(|show| {
            show.control.transport_kind() == crate::cloud_show::ControlKind::Web
        })
}

/// Plan 249 S11: the fixed room output canvases (S9's), horizontal then
/// vertical. HTML layer sheets are drawn against these.
pub const ROOM_CANVASES: [(u32, u32); 2] = [(1920, 1080), (1080, 1920)];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HtmlLayersWantParams {
    pub show_id: String,
    pub want: bool,
}

/// Plan 249 S11 (`cloud.htmlLayers.want`): the room renderer asks for HTML
/// overlay targets on the room's canvases while a program page can draw its
/// sheet. Only for the room this process is in; never starts a capture run,
/// session or recording. A lease, renewed by the renderer, bounds it.
pub fn html_layers_want(state: &AppState, params: HtmlLayersWantParams) -> Result<Value> {
    let current = crate::cloud_show::lock(&state.cloud_show).talk_show_room_show_id();
    if current.as_deref() != Some(params.show_id.as_str()) {
        state.html_overlays.set_room_want(None);
        bail!("That show's room is not open here")
    }
    state
        .html_overlays
        .set_room_want(params.want.then_some(params.show_id));
    Ok(json!({ "want": params.want }))
}

/// The room canvases HTML targets add now: none unless the renderer's want
/// holds for the room this process is in, and that room is active.
pub fn html_room_canvases(state: &AppState) -> Vec<(u32, u32)> {
    let Some(wanted) = state.html_overlays.room_want() else {
        return Vec::new();
    };
    let current = crate::cloud_show::lock(&state.cloud_show).talk_show_room_show_id();
    if current.as_deref() != Some(wanted.as_str()) || !room_active(state) {
        return Vec::new();
    }
    ROOM_CANVASES.to_vec()
}

pub fn room_active(state: &AppState) -> bool {
    let runtime = crate::cloud_show::lock(&state.cloud_show);
    runtime.talk_show_room_show_id().is_some()
        && runtime.connected
        && (runtime.talk.as_ref().is_some_and(|r| r.live)
            || runtime
                .runner
                .as_ref()
                .and_then(|r| r.recording.as_ref())
                .is_some_and(|r| r.active))
}

fn png(image: image::RgbaImage) -> Result<Value> {
    use image::ImageEncoder as _;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 || width > 1920 || height > 1920 || width * height > 1920 * 1080 {
        bail!("Static graphic dimensions exceed the output budget")
    }
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes).write_image(
        image.as_raw(),
        width,
        height,
        image::ExtendedColorType::Rgba8,
    )?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    if encoded.len() > ASSET_BASE64_MAX {
        bail!("Static graphic exceeds the lossless asset budget")
    }
    Ok(json!({"png":encoded,"hash":hash,"width":width,"height":height}))
}
fn rect(x: usize, y: usize, w: usize, h: usize, canvas: (u32, u32)) -> Value {
    json!({"x":x as f64/canvas.0 as f64,"y":y as f64/canvas.1 as f64,"w":w as f64/canvas.0 as f64,"h":h as f64/canvas.1 as f64})
}
fn overlay(
    layer: &CaptionOverlay,
    kind: &str,
    canvas: (u32, u32),
    placement: OverlayRect,
    stream: bool,
    recording: bool,
    expires: Option<i64>,
) -> Result<Value> {
    let (source, x, y, width) = crate::overlay_layout::overlay_blit_layout(
        layer.width as usize,
        layer.height as usize,
        canvas.0 as usize,
        canvas.1 as usize,
        placement,
        0,
    );
    let height = (layer.height as usize).min(canvas.1 as usize - y);
    let image = image::RgbaImage::from_raw(layer.width, layer.height, layer.rgba.as_ref().clone())
        .ok_or_else(|| anyhow::anyhow!("Invalid static raster"))?;
    let cropped =
        image::imageops::crop_imm(&image, source as u32, 0, width as u32, height as u32).to_image();
    Ok(
        json!({"id":kind,"kind":kind,"rect":rect(x,y,width,height,canvas),"asset":png(cropped)?,"opacity":1,"fade":null,"expiresAt":expires,"stream":stream,"recording":recording}),
    )
}

/// PERF-02: at most this many finished banner assets stay cached: four banners
/// on the two room canvases.
const BANNER_RASTER_CACHE_MAX: usize = 8;

/// One finished banner asset's identity: the stored file (path and revision,
/// the identity the native prepared bitmaps use) at one output size. Placement,
/// opacity, fades, expiry and the snapshot signature are not part of it: they
/// are rebuilt fresh on every response.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BannerRasterKey {
    path: Arc<Path>,
    revision: crate::banner_prepare::BannerFileRevision,
    width: u32,
    height: u32,
}

#[derive(Default)]
struct BannerRasterEntries {
    /// The room (show id, room generation) the entries were built for.
    room: Option<(String, u64)>,
    /// Least recently used first.
    entries: VecDeque<(BannerRasterKey, Arc<Value>)>,
}

#[derive(Default)]
struct BannerRasterCacheInner {
    entries: Mutex<BannerRasterEntries>,
    decodes: AtomicU64,
    encodes: AtomicU64,
}

/// PERF-02: the lossless PNG assets of image banners, reused across full
/// `cloud.graphics.snapshot` responses. A chat, caption, highlight or layout
/// change forces a full response; without this every visible banner was
/// decoded from disk, resized twice and PNG/SHA-256/base64 encoded again even
/// though its pixels had not changed. Bounded, separated per room generation,
/// and errors are never cached.
#[derive(Clone, Default)]
pub struct BannerRasterCache(Arc<BannerRasterCacheInner>);

impl BannerRasterCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, BannerRasterEntries> {
        self.0
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The room a build is for. A different room or generation starts empty.
    fn enter_room(&self, show_id: &str, generation: u64) {
        let mut cache = self.lock();
        let room = (show_id.to_string(), generation);
        if cache.room.as_ref() != Some(&room) {
            cache.entries.clear();
            cache.room = Some(room);
        }
    }

    fn get(&self, key: &BannerRasterKey) -> Option<Arc<Value>> {
        let mut cache = self.lock();
        let index = cache.entries.iter().position(|(k, _)| k == key)?;
        let entry = cache.entries.remove(index)?;
        let asset = Arc::clone(&entry.1);
        cache.entries.push_back(entry);
        Some(asset)
    }

    fn insert(&self, room: &(String, u64), key: BannerRasterKey, asset: Arc<Value>) {
        let mut cache = self.lock();
        if cache.room.as_ref() != Some(room) {
            return;
        }
        cache.entries.retain(|(k, _)| *k != key);
        cache.entries.push_back((key, asset));
        while cache.entries.len() > BANNER_RASTER_CACHE_MAX {
            cache.entries.pop_front();
        }
    }

    /// After a successful full build: drop assets of files (or revisions) no
    /// longer in the banner set, so a removed or replaced banner frees them.
    fn retain_files(&self, files: &[(Arc<Path>, crate::banner_prepare::BannerFileRevision)]) {
        self.lock().entries.retain(|(key, _)| {
            files
                .iter()
                .any(|(path, revision)| *path == key.path && *revision == key.revision)
        });
    }

    /// The banner's asset at each size (one per room canvas). The file is
    /// decoded at most once, and only when a size misses.
    fn banner_assets<const N: usize>(
        &self,
        room: &(String, u64),
        path: &Arc<Path>,
        revision: Option<crate::banner_prepare::BannerFileRevision>,
        sizes: [(u32, u32); N],
    ) -> Result<[Arc<Value>; N]> {
        let mut decoded: Option<image::RgbaImage> = None;
        let mut assets: Vec<Arc<Value>> = Vec::with_capacity(N);
        for (index, (width, height)) in sizes.into_iter().enumerate() {
            if let Some(same) = sizes[..index].iter().position(|s| *s == (width, height)) {
                assets.push(Arc::clone(&assets[same]));
                continue;
            }
            let key = revision.map(|revision| BannerRasterKey {
                path: Arc::clone(path),
                revision,
                width,
                height,
            });
            if let Some(hit) = key.as_ref().and_then(|key| self.get(key)) {
                assets.push(hit);
                continue;
            }
            let source = match decoded.as_ref() {
                Some(source) => source,
                None => {
                    self.0.decodes.fetch_add(1, Ordering::Relaxed);
                    decoded.insert(
                        crate::banner_prepare::decode_banner_file(path)
                            .map_err(anyhow::Error::msg)?,
                    )
                }
            };
            self.0.encodes.fetch_add(1, Ordering::Relaxed);
            let asset = Arc::new(png(crate::banners::resize_straight_alpha(
                source, width, height,
            ))?);
            if let Some(key) = key {
                self.insert(room, key, Arc::clone(&asset));
            }
            assets.push(asset);
        }
        Ok(assets
            .try_into()
            .unwrap_or_else(|_| unreachable!("one asset per size")))
    }

    #[cfg(test)]
    fn counts(&self) -> (u64, u64) {
        (
            self.0.decodes.load(Ordering::Relaxed),
            self.0.encodes.load(Ordering::Relaxed),
        )
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().entries.len()
    }
}

/// Whether the caption source a snapshot was built from still holds once its
/// rasters are done. A newer caption frame of the same source, on the same
/// outputs, only moves the expiry: the snapshot is as current as one that
/// finished a moment before that frame arrived, and the next poll carries the
/// newer bar. A source that ended, another source, or a changed output is
/// refused: that bar must never reach an output it no longer belongs on.
///
/// The snapshot is an observation, so it runs beside `cloud.speech.overlay`
/// (several frames a second while someone speaks). Comparing the expiry too
/// would refuse most snapshots built during speech.
fn caption_source_held(
    built_from: &Option<crate::captions::cloud_host::Presentation>,
    now: &Option<crate::captions::cloud_host::Presentation>,
) -> bool {
    match (built_from, now) {
        (None, None) => true,
        (Some(built), Some(now)) => {
            built.session == now.session
                && built.stream == now.stream
                && built.recording == now.recording
        }
        _ => false,
    }
}

pub async fn snapshot(state: &AppState, params: SnapshotParams) -> Result<Value> {
    let generation = {
        let runtime = crate::cloud_show::lock(&state.cloud_show);
        if runtime.talk_show_room_show_id().as_deref() != Some(&params.show_id) {
            bail!("Room is no longer open")
        }
        runtime.generation
    };
    let caption_presentation = crate::captions::cloud_host::presentation(state).await;
    let caption_slots = crate::captions::current_caption_overlays(&state.caption_overlay);
    let captions = [caption_slots.primary, caption_slots.auxiliary];
    let banners = crate::compositor::static_graphics_banners(state).await;
    let layout = crate::overlay_layout::load_overlay_layout(&state.database);
    let chat = [
        crate::captions::current_caption_overlay(&state.chat_overlay),
        crate::captions::current_caption_overlay(&state.simulcast_chat_overlay),
    ];
    let (highlight, cards) = {
        let _commit = state.comment_highlight_commit.lock().await;
        let status = state.comment_highlight.lock().await.clone();
        let cards = [
            crate::captions::current_caption_overlay(&state.highlight_overlay),
            crate::captions::current_caption_overlay(&state.simulcast_highlight_overlay),
        ];
        (status, cards)
    };
    let now = Instant::now();
    let at = chrono::Utc::now().timestamp_millis();
    let expires = highlight
        .expires_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .filter(|v| *v > at && highlight.session_id.as_deref() == Some(params.show_id.as_str()));
    let key = format!(
        "{}:{generation}:{:?}:{:?}:{:?}:{:?}:{:?}",
        params.show_id,
        layout,
        banners
            .layers
            .iter()
            .map(|l| (
                &l.banner,
                l.file_revision,
                l.fade,
                l.fade.hides() && l.fade.is_settled_at(now)
            ))
            .collect::<Vec<_>>(),
        chat.iter()
            .map(|c| c.as_ref().map(|c| c.revision))
            .collect::<Vec<_>>(),
        highlight,
        cards
            .iter()
            .map(|c| c.as_ref().map(|c| c.revision))
            .collect::<Vec<_>>()
    );
    let key = format!(
        "{key}:{caption_presentation:?}:{:?}",
        captions
            .iter()
            .map(|c| c.as_ref().map(|c| c.revision))
            .collect::<Vec<_>>()
    );
    let signature = format!("{:x}", Sha256::digest(key.as_bytes()));
    let expected_caption = caption_presentation.clone();
    if params.known.as_deref() == Some(&signature) {
        return Ok(json!({"signature":signature,"content":null}));
    }
    let rasters = state.cloud_graphics_rasters.clone();
    let room = (params.show_id.clone(), generation);
    rasters.enter_room(&room.0, room.1);
    let content = tokio::task::spawn_blocking(move || -> Result<Value> {
        let mut lanes = [Vec::<Value>::new(), Vec::new()];
        // Plan 249 S11: HTML banners' placement on the room canvases. Pixels
        // never travel here: the sheet carries them, and only when a page
        // may draw it (default-off; see docs/cloud/249-s11-contract.md).
        let mut html_lanes = [Vec::<Value>::new(), Vec::new()];
        let mut unsupported = Vec::<String>::new();
        for layer in &banners.layers {
            if layer.fade.hides() && layer.fade.is_settled_at(now) {
                continue;
            }
            let banner = &layer.banner;
            if !banner.show_on_stream && !banner.show_in_recording {
                continue;
            }
            if banner.kind != crate::protocol::BannerKind::Image {
                unsupported.push(
                    "HTML graphics require the separately qualified dynamic transport.".into(),
                );
                if banner.kind == crate::protocol::BannerKind::Html {
                    let fade_at = at
                        - now
                            .saturating_duration_since(layer.fade.started_at)
                            .as_millis()
                            .min(i64::MAX as u128) as i64;
                    for (index, canvas) in ROOM_CANVASES.into_iter().enumerate() {
                        let placement = if index == 0 {
                            banner.horizontal
                        } else {
                            banner.vertical
                        };
                        let (x, y, w, h) = crate::banners::banner_draw_rect(
                            banner.width,
                            banner.height,
                            canvas.0 as usize,
                            canvas.1 as usize,
                            placement,
                        );
                        if html_lanes[index].len() < 4 && w > 0 && h > 0 {
                            html_lanes[index].push(json!({
                                "id": format!("banner:{}", banner.id),
                                "bannerId": banner.id,
                                "rect": rect(x, y, w, h, canvas),
                                "opacity": banner.opacity.clamp(0.0, 1.0),
                                "fade": {"at": fade_at.max(1), "from": layer.fade.from, "to": layer.fade.to},
                                "stream": banner.show_on_stream,
                                "recording": banner.show_in_recording,
                            }));
                        }
                    }
                }
                continue;
            }
            let draws = ROOM_CANVASES.map(|canvas| {
                let placement = if canvas == ROOM_CANVASES[0] {
                    banner.horizontal
                } else {
                    banner.vertical
                };
                crate::banners::banner_draw_rect(
                    banner.width,
                    banner.height,
                    canvas.0 as usize,
                    canvas.1 as usize,
                    placement,
                )
            });
            let assets = rasters.banner_assets(
                &room,
                &layer.image_path,
                layer.file_revision,
                draws.map(|(_, _, w, h)| (w as u32, h as u32)),
            )?;
            for (index, canvas) in ROOM_CANVASES.into_iter().enumerate() {
                let (x, y, w, h) = draws[index];
                let fade_at = at
                    - now
                        .saturating_duration_since(layer.fade.started_at)
                        .as_millis()
                        .min(i64::MAX as u128) as i64;
                lanes[index].push(json!({
                    "id": format!("banner:{}", banner.id), "kind": "banner",
                    "rect": rect(x, y, w, h, canvas), "asset": (*assets[index]).clone(),
                    "opacity": banner.opacity.clamp(0.0, 1.0),
                    "fade": {"at": fade_at.max(1), "from": layer.fade.from, "to": layer.fade.to},
                    "expiresAt": if layer.fade.hides() { Some(fade_at + 200) } else { None },
                    "stream": banner.show_on_stream, "recording": banner.show_in_recording,
                }));
            }
        }
        for (index, canvas) in [(1920, 1080), (1080, 1920)].into_iter().enumerate() {
            if let (Some(caption), Some(presentation)) = (&captions[index], &caption_presentation) {
                let placement = if index == 0 {
                    layout.captions.horizontal
                } else {
                    layout.captions.vertical
                };
                let mut layer = overlay(
                    caption,
                    "caption",
                    canvas,
                    placement,
                    // Live captions alone decides (owner, 2026-11-20): the
                    // renderer's presentation carries its outputs, and the
                    // scene's captions item only places the bar.
                    presentation.stream,
                    presentation.recording,
                    Some(presentation.expires_at),
                )?;
                let mut output_rects = serde_json::Map::new();
                for (output, visible) in [
                    ("stream", layout.highlight.show_on_stream),
                    ("recording", layout.highlight.show_in_recording),
                ] {
                    let card = if visible && expires.is_some() {
                        cards[index].as_ref()
                    } else {
                        None
                    };
                    let inset = crate::compositor::caption_overlay_safe_inset(
                        Some(caption),
                        card,
                        canvas.0,
                        canvas.1,
                    );
                    let (_, x, y, w) = crate::overlay_layout::overlay_blit_layout(
                        caption.width as usize,
                        caption.height as usize,
                        canvas.0 as usize,
                        canvas.1 as usize,
                        placement,
                        inset,
                    );
                    output_rects.insert(
                        output.into(),
                        rect(
                            x,
                            y,
                            w,
                            (caption.height as usize).min(canvas.1 as usize - y),
                            canvas,
                        ),
                    );
                }
                layer["outputRects"] = Value::Object(output_rects);
                lanes[index].push(layer);
            }
            if let Some(chat) = &chat[index]
                && (layout.chat.show_on_stream || layout.chat.show_in_recording)
            {
                lanes[index].push(overlay(
                    chat,
                    "chat",
                    canvas,
                    if index == 0 {
                        layout.chat.horizontal
                    } else {
                        layout.chat.vertical
                    },
                    layout.chat.show_on_stream,
                    layout.chat.show_in_recording,
                    None,
                )?);
            }
            if highlight.phase == crate::comment_highlight::CommentHighlightPhase::Live
                && expires.is_some()
                && (layout.highlight.show_on_stream || layout.highlight.show_in_recording)
                && let Some(card) = &cards[index]
            {
                lanes[index].push(overlay(
                    card,
                    "highlight",
                    canvas,
                    if index == 0 {
                        layout.highlight.horizontal
                    } else {
                        layout.highlight.vertical
                    },
                    layout.highlight.show_on_stream,
                    layout.highlight.show_in_recording,
                    expires,
                )?);
            }
            if lanes[index].len() > 7 {
                bail!("Static layer budget exceeded");
            }
        }
        rasters.retain_files(
            &banners
                .layers
                .iter()
                .filter_map(|layer| Some((Arc::clone(&layer.image_path), layer.file_revision?)))
                .collect::<Vec<_>>(),
        );
        unsupported.sort();
        unsupported.dedup();
        Ok(json!({
            "h": lanes[0], "v": lanes[1], "unsupported": unsupported,
            "html": {"h": html_lanes[0], "v": html_lanes[1]},
        }))
    })
    .await??;
    if !caption_source_held(
        &expected_caption,
        &crate::captions::cloud_host::presentation(state).await,
    ) {
        bail!("Caption source changed during graphic preparation")
    }
    let runtime = crate::cloud_show::lock(&state.cloud_show);
    if runtime.generation != generation
        || runtime.talk_show_room_show_id().as_deref() != Some(&params.show_id)
    {
        bail!("Room changed during graphic preparation")
    }
    Ok(json!({"signature":signature,"content":content}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_caption_frame_of_the_same_source_keeps_the_snapshot() {
        use crate::captions::cloud_host::Presentation;
        let built = Some(Presentation {
            session: "host-1".into(),
            expires_at: 1_000,
            stream: true,
            recording: false,
        });
        let newer = |change: fn(&mut Presentation)| {
            let mut next = built.clone().unwrap();
            change(&mut next);
            Some(next)
        };
        assert!(caption_source_held(&built, &built));
        assert!(caption_source_held(&None, &None));
        // The next frame while the rasters were prepared: only the expiry moved.
        assert!(caption_source_held(
            &built,
            &newer(|next| next.expires_at = 4_000)
        ));
        // Captions ended, started, moved to another source or another output.
        assert!(!caption_source_held(&built, &None));
        assert!(!caption_source_held(&None, &built));
        assert!(!caption_source_held(
            &built,
            &newer(|next| next.session = "guests-1".into())
        ));
        assert!(!caption_source_held(
            &built,
            &newer(|next| next.stream = false)
        ));
        assert!(!caption_source_held(
            &built,
            &newer(|next| next.recording = true)
        ));
    }

    #[test]
    fn public_png_keeps_straight_alpha_and_bounds() {
        let source =
            image::RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 255, 0, 128]).unwrap();
        let asset = png(source).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(asset["png"].as_str().unwrap())
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(decoded.get_pixel(1, 0).0, [0, 255, 0, 128]);
        assert_eq!(asset["hash"], format!("{:x}", Sha256::digest(bytes)));
        assert!(png(image::RgbaImage::new(1921, 1)).is_err());
    }

    /// A photo-like banner with straight alpha (so the premultiplied resize
    /// path runs), stored as PNG in a fresh temp file.
    fn banner_file(width: u32, height: u32, seed: u32) -> Arc<Path> {
        let dir =
            std::env::temp_dir().join(format!("videorc-cloud-raster-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("banner.png");
        write_banner(&path, width, height, seed);
        Arc::from(path.as_path())
    }

    fn write_banner(path: &Path, width: u32, height: u32, seed: u32) {
        let image = image::RgbaImage::from_fn(width, height, |x, y| {
            let n = x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503) ^ seed;
            image::Rgba([
                (x * 255 / width.max(1)) as u8,
                (y * 255 / height.max(1)) as u8,
                (n >> 13) as u8,
                if x < 8 { 0 } else { 128 + (n % 128) as u8 },
            ])
        });
        image
            .save_with_format(path, image::ImageFormat::Png)
            .unwrap();
    }

    fn revision(path: &Path) -> Option<crate::banner_prepare::BannerFileRevision> {
        crate::banner_prepare::banner_file_revision(path)
    }

    /// The asset exactly as the snapshot built it before PERF-02.
    fn uncached(path: &Path, size: (u32, u32)) -> Value {
        let source = crate::banner_prepare::decode_banner_file(path).unwrap();
        png(crate::banners::resize_straight_alpha(
            &source, size.0, size.1,
        ))
        .unwrap()
    }

    fn room(generation: u64) -> (String, u64) {
        ("show-1".to_string(), generation)
    }

    const SIZES: [(u32, u32); 2] = [(480, 120), (432, 108)];

    #[test]
    fn unchanged_banner_decodes_once_across_sixty_full_builds() {
        let path = banner_file(640, 160, 1);
        let cache = BannerRasterCache::default();
        let room = room(1);
        cache.enter_room(&room.0, room.1);
        let first = cache
            .banner_assets(&room, &path, revision(&path), SIZES)
            .unwrap();
        for _ in 0..60 {
            cache.enter_room(&room.0, room.1);
            let again = cache
                .banner_assets(&room, &path, revision(&path), SIZES)
                .unwrap();
            assert_eq!(again, first);
        }
        assert_eq!(cache.counts(), (1, 2), "one decode, one encode per size");
        for (index, size) in SIZES.into_iter().enumerate() {
            assert_eq!(*first[index], uncached(&path, size), "byte-identical asset");
        }
    }

    #[test]
    fn a_new_file_revision_size_or_room_rebuilds_and_never_serves_stale_pixels() {
        let path = banner_file(640, 160, 1);
        let cache = BannerRasterCache::default();
        let one = room(1);
        cache.enter_room(&one.0, one.1);
        let before = cache
            .banner_assets(&one, &path, revision(&path), SIZES)
            .unwrap();

        // The file is overwritten: new revision, new pixels.
        write_banner(&path, 700, 175, 2);
        let after = cache
            .banner_assets(&one, &path, revision(&path), SIZES)
            .unwrap();
        assert_eq!(cache.counts(), (2, 4));
        assert_ne!(after[0]["hash"], before[0]["hash"]);
        assert_eq!(*after[0], uncached(&path, SIZES[0]));

        // Only the vertical size changes: one decode, one encode.
        let resized = [SIZES[0], (300, 75)];
        let moved = cache
            .banner_assets(&one, &path, revision(&path), resized)
            .unwrap();
        assert_eq!(cache.counts(), (3, 5));
        assert_eq!(moved[0], after[0]);
        assert_eq!(*moved[1], uncached(&path, (300, 75)));

        // A new room generation starts empty.
        let two = room(2);
        cache.enter_room(&two.0, two.1);
        assert_eq!(cache.len(), 0);
        cache
            .banner_assets(&two, &path, revision(&path), SIZES)
            .unwrap();
        assert_eq!(cache.counts(), (4, 7));
        // A build still running for the old room never fills the new one.
        cache.insert(
            &one,
            BannerRasterKey {
                path: Arc::clone(&path),
                revision: revision(&path).unwrap(),
                width: 1,
                height: 1,
            },
            Arc::new(json!({})),
        );
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn unknown_revisions_and_failures_are_never_cached() {
        let path = banner_file(64, 16, 1);
        let cache = BannerRasterCache::default();
        let room = room(1);
        cache.enter_room(&room.0, room.1);
        for _ in 0..3 {
            cache.banner_assets(&room, &path, None, SIZES).unwrap();
        }
        assert_eq!(cache.counts(), (3, 6));
        assert_eq!(cache.len(), 0);

        let broken: Arc<Path> = Arc::from(path.with_file_name("broken.png").as_path());
        std::fs::write(&broken, b"not an image").unwrap();
        for _ in 0..2 {
            assert!(
                cache
                    .banner_assets(&room, &broken, revision(&broken), SIZES)
                    .is_err()
            );
        }
        assert_eq!(cache.counts(), (5, 6));
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn the_cache_is_bounded_and_drops_departed_banners() {
        let path = banner_file(64, 16, 1);
        let other = banner_file(64, 16, 2);
        let cache = BannerRasterCache::default();
        let room = room(1);
        cache.enter_room(&room.0, room.1);
        for width in 1..=12 {
            cache
                .banner_assets(&room, &path, revision(&path), [(width * 4, width)])
                .unwrap();
        }
        assert_eq!(cache.len(), BANNER_RASTER_CACHE_MAX);
        cache
            .banner_assets(&room, &other, revision(&other), SIZES)
            .unwrap();
        cache.retain_files(&[(Arc::clone(&other), revision(&other).unwrap())]);
        assert_eq!(cache.len(), 2);
        // Identical sizes on both canvases encode once.
        let (_, encodes) = cache.counts();
        let same = cache
            .banner_assets(&room, &path, revision(&path), [(50, 50), (50, 50)])
            .unwrap();
        assert_eq!(same[0], same[1]);
        assert_eq!(cache.counts().1, encodes + 1);
    }

    /// PERF-02 measurement (run with `-- --ignored --nocapture`): 61 full
    /// snapshot builds of one 1600x400 banner, as before (decode + resize + PNG
    /// every time) and with the cache. Same process, same file, same sizes.
    #[test]
    #[ignore = "timing measurement"]
    fn measure_banner_raster_work_per_minute_of_full_builds() {
        let path = banner_file(1600, 400, 7);
        let sizes = ROOM_CANVASES.map(|canvas| {
            let (_, _, w, h) = crate::banners::banner_draw_rect(
                1600,
                400,
                canvas.0 as usize,
                canvas.1 as usize,
                crate::overlay_layout::OverlayRect {
                    x: 0.05,
                    y: 0.75,
                    w: 0.9,
                    h: 0.2,
                },
            );
            (w as u32, h as u32)
        });
        let room = room(1);
        let mut rows = Vec::new();
        for round in 0..3 {
            let started = Instant::now();
            for _ in 0..61 {
                let fresh = BannerRasterCache::default();
                fresh.enter_room(&room.0, room.1);
                fresh
                    .banner_assets(&room, &path, revision(&path), sizes)
                    .unwrap();
            }
            let before = started.elapsed();
            let cache = BannerRasterCache::default();
            cache.enter_room(&room.0, room.1);
            let started = Instant::now();
            for _ in 0..61 {
                let assets = cache
                    .banner_assets(&room, &path, revision(&path), sizes)
                    .unwrap();
                // What the snapshot does with each hit: clone it into the lane.
                std::hint::black_box(assets.map(|a| (*a).clone()));
            }
            let after = started.elapsed();
            rows.push(format!(
                "round {round}: sizes {sizes:?}; before {:.1} ms (61 decodes, 122 encodes); after {:.1} ms {:?} (decodes, encodes)",
                before.as_secs_f64() * 1000.0,
                after.as_secs_f64() * 1000.0,
                cache.counts()
            ));
        }
        println!("PERF-02 {}", rows.join("\nPERF-02 "));
    }

    #[test]
    fn public_rect_is_the_native_pixel_geometry_normalized_once() {
        assert_eq!(
            rect(192, 108, 960, 540, (1920, 1080)),
            json!({"x":0.1,"y":0.1,"w":0.5,"h":0.5})
        );
    }
}
