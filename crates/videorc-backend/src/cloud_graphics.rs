//! S9: public static raster projection. No HTML execution, paths or private AI
//! state leave this renderer-only RPC. Native placement/fades remain the oracle.
use crate::{captions::CaptionOverlay, overlay_layout::OverlayRect, state::AppState};
use anyhow::{Result, bail};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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

pub async fn snapshot(state: &AppState, params: SnapshotParams) -> Result<Value> {
    let generation = {
        let runtime = crate::cloud_show::lock(&state.cloud_show);
        if runtime.talk_show_room_show_id().as_deref() != Some(&params.show_id) {
            bail!("Room is no longer open")
        }
        runtime.generation
    };
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
    let signature = format!("{:x}", Sha256::digest(key.as_bytes()));
    if params.known.as_deref() == Some(&signature) {
        return Ok(json!({"signature":signature,"content":null}));
    }
    let content = tokio::task::spawn_blocking(move || -> Result<Value> {
        let mut lanes = [Vec::<Value>::new(), Vec::new()];
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
                continue;
            }
            let image = crate::banner_prepare::decode_banner_file(&layer.image_path)
                .map_err(anyhow::Error::msg)?;
            for (index, canvas) in [(1920, 1080), (1080, 1920)].into_iter().enumerate() {
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
                let image = crate::banners::resize_straight_alpha(&image, w as u32, h as u32);
                let fade_at = at
                    - now
                        .saturating_duration_since(layer.fade.started_at)
                        .as_millis()
                        .min(i64::MAX as u128) as i64;
                lanes[index].push(json!({
                    "id": format!("banner:{}", banner.id), "kind": "banner",
                    "rect": rect(x, y, w, h, canvas), "asset": png(image)?,
                    "opacity": banner.opacity.clamp(0.0, 1.0),
                    "fade": {"at": fade_at.max(1), "from": layer.fade.from, "to": layer.fade.to},
                    "expiresAt": if layer.fade.hides() { Some(fade_at + 200) } else { None },
                    "stream": banner.show_on_stream, "recording": banner.show_in_recording,
                }));
            }
        }
        for (index, canvas) in [(1920, 1080), (1080, 1920)].into_iter().enumerate() {
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
            if lanes[index].len() > 6 {
                bail!("Static layer budget exceeded");
            }
        }
        unsupported.sort();
        unsupported.dedup();
        Ok(json!({"h": lanes[0], "v": lanes[1], "unsupported": unsupported}))
    })
    .await??;
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
    #[test]
    fn public_rect_is_the_native_pixel_geometry_normalized_once() {
        assert_eq!(
            rect(192, 108, 960, 540, (1920, 1080)),
            json!({"x":0.1,"y":0.1,"w":0.5,"h":0.5})
        );
    }
}
