//! Plan 260 S1.8c c5: the HTML layers' sheet in the backend's room, the
//! renderer room's `RoomHtmlLayerPublisher` (plan 249 S11,
//! docs/cloud/249-s11-contract.md).
//!
//! The locked-down offscreen windows keep rendering the HTML banners; their
//! latest frames are already here (`html_overlays`). For each egress page
//! whose current capability receipt asks for HTML layers (a lane: output and
//! orientation), the banners on that lane are drawn into one sheet per
//! orientation and layer set (at most two publications, four layers each),
//! packed colour-left, gutter, alpha-right (S10) and published as a camera
//! track named for its role. Each lane gets a manifest naming the sheet's
//! track, generation, size and layer rectangles, renewed before its lease
//! ends. Nothing is published unless this computer controls the show with
//! its devices on (`cloud.room.html.set`) and the room's graphics are on.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use livekit::data_stream::api::{StreamByteOptions, StreamWriter};
use livekit::options::{VideoCodec, VideoEncoding};
use livekit::prelude::{
    LocalParticipant, LocalTrack, LocalVideoTrack, Room, TrackPublishOptions, TrackSid, TrackSource,
};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, oneshot};

use crate::room_capability::{CapabilityReceipts, capability_current};
use crate::state::AppState;

pub(crate) const HTML_LAYER_ROLE: &str = "videorc:html-layer:v1";
pub(crate) const HTML_LAYER_TOPIC: &str = "videorc.presentation.html.v1";
const MAX_LAYERS: usize = 4;
const MAX_PUBLICATIONS: usize = 2;
const FPS: u32 = 15;
const LEASE_MS: i64 = 30_000;
const RENEW: Duration = Duration::from_secs(10);
const MANIFEST_MAX_BYTES: usize = 16 * 1024;
const BITRATE: u64 = 2_500_000;
const GUTTER: u32 = 8;
const FADE_MS: f64 = 200.0;

/// `HTML_LAYER_SHEET`: the logical sheet per orientation.
pub(crate) fn sheet_size(orientation: &str) -> (u32, u32) {
    if orientation == "v" {
        (360, 640)
    } else {
        (640, 360)
    }
}

static PLACEMENTS: StdMutex<Option<Value>> = StdMutex::new(None);
static ENABLED: AtomicBool = AtomicBool::new(false);
static CHANGED: Notify = Notify::const_new();

/// The room canvases' HTML banners from the graphics snapshot (`content.html`),
/// or None while the room's graphics are off.
pub(crate) fn set_placements(placements: Option<Value>) {
    *PLACEMENTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = placements;
    CHANGED.notify_waiters();
}

/// `cloud.room.html.set`: this computer controls the show with its devices on.
pub(crate) fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Release);
    CHANGED.notify_waiters();
}

/// A hold ended.
pub(crate) fn clear() {
    set_placements(None);
    ENABLED.store(false, Ordering::Release);
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Rect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Fade {
    pub(crate) at: i64,
    pub(crate) from: f64,
    pub(crate) to: f64,
}

/// `HtmlBannerPlacement`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Placement {
    pub(crate) id: String,
    pub(crate) banner_id: String,
    pub(crate) rect: Rect,
    pub(crate) opacity: f64,
    pub(crate) fade: Option<Fade>,
    pub(crate) stream: bool,
    pub(crate) recording: bool,
}

#[derive(Debug, Default, Deserialize)]
struct Placements {
    #[serde(default)]
    h: Vec<Placement>,
    #[serde(default)]
    v: Vec<Placement>,
}

/// Native banner fade: 200 ms ease-out cubic (`htmlLayerFade`).
pub(crate) fn fade_at(fade: Option<&Fade>, now: i64) -> f64 {
    let Some(fade) = fade else {
        return 1.0;
    };
    let t = ((now - fade.at) as f64 / FADE_MS).clamp(0.0, 1.0);
    let eased = 1.0 - (1.0 - t).powi(3);
    fade.from + (fade.to - fade.from) * eased
}

/// One egress page's lane.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Lane {
    pub(crate) identity: String,
    pub(crate) output: String,
    pub(crate) orientation: String,
}

/// The layers one lane may show: on its output, not faded out
/// (`htmlLaneLayers`).
pub(crate) fn lane_layers(placements: &[Placement], output: &str, now: i64) -> Vec<Placement> {
    placements
        .iter()
        .filter(|layer| {
            let on_output = if output == "recording" {
                layer.recording
            } else {
                layer.stream
            };
            on_output && fade_at(layer.fade.as_ref(), now) * layer.opacity > 0.0
        })
        .take(MAX_LAYERS)
        .cloned()
        .collect()
}

/// A sheet's identity: its orientation and the exact layers it shows.
pub(crate) fn sheet_key(orientation: &str, layers: &[Placement]) -> String {
    let mut ids: Vec<&str> = layers.iter().map(|layer| layer.id.as_str()).collect();
    ids.sort_unstable();
    format!("{orientation}|{}", ids.join(","))
}

/// `htmlLayerPixels`: a unit rect on the sheet, in whole pixels.
pub(crate) fn layer_pixels(rect: &Rect, (width, height): (u32, u32)) -> (u32, u32, u32, u32) {
    let (w, h) = (f64::from(width), f64::from(height));
    let x = (rect.x * w).floor().max(0.0);
    let y = (rect.y * h).floor().max(0.0);
    let right = ((rect.x + rect.w) * w).ceil().min(w);
    let bottom = ((rect.y + rect.h) * h).ceil().min(h);
    (
        x as u32,
        y as u32,
        (right - x).max(0.0) as u32,
        (bottom - y).max(0.0) as u32,
    )
}

/// Straight-alpha `src` over `dst` at `alpha` (canvas source-over with a
/// global alpha), both RGBA.
pub(crate) fn blend_over(dst: &mut [u8; 4], src: [u8; 4], alpha: f64) {
    let sa = f64::from(src[3]) / 255.0 * alpha.clamp(0.0, 1.0);
    if sa <= 0.0 {
        return;
    }
    let da = f64::from(dst[3]) / 255.0;
    let out_a = sa + da * (1.0 - sa);
    for (channel, value) in dst[..3].iter_mut().zip(&src[..3]) {
        let blended = (f64::from(*value) * sa + f64::from(*channel) * da * (1.0 - sa)) / out_a;
        *channel = blended.round().clamp(0.0, 255.0) as u8;
    }
    dst[3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
}

/// Straight-alpha BGRA resampled to `out_width` x `out_height` straight
/// RGBA, as a canvas `drawImage` keeps it: each output pixel the area
/// average of the source texels it covers, colour weighted by alpha, so a
/// half-transparent background or a soft shadow keeps its coverage.
pub(crate) fn resample_bgra(
    bgra: &[u8],
    width: u32,
    height: u32,
    out_width: u32,
    out_height: u32,
) -> Option<Vec<u8>> {
    if width == 0
        || height == 0
        || out_width == 0
        || out_height == 0
        || bgra.len() < width as usize * height as usize * 4
    {
        return None;
    }
    let mut out = vec![0u8; out_width as usize * out_height as usize * 4];
    for oy in 0..out_height {
        let y0 = (u64::from(oy) * u64::from(height) / u64::from(out_height)) as u32;
        let y1 = ((u64::from(oy + 1) * u64::from(height)).div_ceil(u64::from(out_height)) as u32)
            .clamp(y0 + 1, height);
        for ox in 0..out_width {
            let x0 = (u64::from(ox) * u64::from(width) / u64::from(out_width)) as u32;
            let x1 = ((u64::from(ox + 1) * u64::from(width)).div_ceil(u64::from(out_width)) as u32)
                .clamp(x0 + 1, width);
            // Premultiplied sums: [r, g, b] times alpha, and alpha.
            let mut sum = [0.0f64; 4];
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let index = (sy as usize * width as usize + sx as usize) * 4;
                    let alpha = f64::from(bgra[index + 3]) / 255.0;
                    sum[0] += f64::from(bgra[index + 2]) * alpha;
                    sum[1] += f64::from(bgra[index + 1]) * alpha;
                    sum[2] += f64::from(bgra[index]) * alpha;
                    sum[3] += alpha;
                }
            }
            let count = f64::from((y1 - y0) * (x1 - x0));
            let index = (oy as usize * out_width as usize + ox as usize) * 4;
            if sum[3] <= 0.0 {
                continue;
            }
            let coverage = sum[3];
            for (slot, total) in out[index..index + 3].iter_mut().zip(&sum[..3]) {
                *slot = (total / coverage).round().clamp(0.0, 255.0) as u8;
            }
            out[index + 3] = (coverage / count * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    Some(out)
}

/// S10 packing: colour left (opaque), an 8 px black gutter, alpha as grey.
pub(crate) fn pack(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let packed_width = width * 2 + GUTTER;
    let mut out = Vec::with_capacity((packed_width * height * 4) as usize);
    for row in rgba.chunks_exact(width as usize * 4).take(height as usize) {
        for pixel in row.chunks_exact(4) {
            out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
        }
        for _ in 0..GUTTER {
            out.extend_from_slice(&[0, 0, 0, 255]);
        }
        for pixel in row.chunks_exact(4) {
            out.extend_from_slice(&[pixel[3], pixel[3], pixel[3], 255]);
        }
    }
    out
}

/// One sheet's straight-alpha RGBA: its layers' latest frames at their rects.
fn draw_sheet(state: &AppState, orientation: &str, layers: &[Placement], now: i64) -> Vec<u8> {
    let (width, height) = sheet_size(orientation);
    let mut sheet = vec![0u8; (width * height * 4) as usize];
    for layer in layers {
        let alpha = layer.opacity * fade_at(layer.fade.as_ref(), now);
        if alpha <= 0.0 {
            continue;
        }
        let Some(bitmap) = state.html_overlays.latest_frame(&layer.banner_id) else {
            continue;
        };
        let (x, y, w, h) = layer_pixels(&layer.rect, (width, height));
        if w == 0 || h == 0 {
            continue;
        }
        let Some(scaled) = resample_bgra(&bitmap.bgra, bitmap.width, bitmap.height, w, h) else {
            continue;
        };
        for row in 0..h as usize {
            for column in 0..w as usize {
                let from = (row * w as usize + column) * 4;
                let to = ((y as usize + row) * width as usize + x as usize + column) * 4;
                let mut pixel = [sheet[to], sheet[to + 1], sheet[to + 2], sheet[to + 3]];
                blend_over(
                    &mut pixel,
                    [
                        scaled[from],
                        scaled[from + 1],
                        scaled[from + 2],
                        scaled[from + 3],
                    ],
                    alpha,
                );
                sheet[to..to + 4].copy_from_slice(&pixel);
            }
        }
    }
    sheet
}

/// The packed sheet as I420 for the track.
fn sheet_frame(rgba: &[u8], width: u32, height: u32) -> I420Buffer {
    let packed = pack(rgba, width, height);
    let packed_width = width * 2 + GUTTER;
    let mut buffer = I420Buffer::new(packed_width, height);
    let (stride_y, stride_u, stride_v) = buffer.strides();
    let (y, u, v) = buffer.data_mut();
    yuv_helper::abgr_to_i420(
        &packed,
        packed_width * 4,
        y,
        stride_y,
        u,
        stride_u,
        v,
        stride_v,
        packed_width as i32,
        height as i32,
    );
    buffer
}

struct Sheet {
    orientation: String,
    layers: Vec<Placement>,
    lanes: Vec<Lane>,
    generation: u64,
    revision: u64,
    sid: TrackSid,
    source: NativeVideoSource,
    manifests_at: Option<Instant>,
}

async fn publish(
    room: &Room,
    orientation: &str,
    generation: u64,
) -> anyhow::Result<(TrackSid, NativeVideoSource)> {
    let (width, height) = sheet_size(orientation);
    let source = NativeVideoSource::new(
        VideoResolution {
            width: width * 2 + GUTTER,
            height,
        },
        false,
    );
    let name = format!("{HTML_LAYER_ROLE}:{orientation}:{generation}");
    let track = LocalVideoTrack::create_video_track(&name, RtcVideoSource::Native(source.clone()));
    let options = TrackPublishOptions {
        source: TrackSource::Camera,
        video_codec: VideoCodec::VP8,
        simulcast: false,
        video_encoding: Some(VideoEncoding {
            max_bitrate: BITRATE,
            max_framerate: f64::from(FPS),
        }),
        ..Default::default()
    };
    let publication = room
        .local_participant()
        .publish_track(LocalTrack::Video(track), options)
        .await?;
    Ok((publication.sid(), source))
}

async fn unpublish(room: &Room, sheet: Sheet) {
    if let Err(error) = room.local_participant().unpublish_track(&sheet.sid).await {
        tracing::warn!("The backend could not take an HTML layer sheet off: {error}");
    }
}

/// A lane's manifest (`HtmlLayerManifest`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn manifest(
    show: &str,
    publisher_sid: &str,
    track_sid: &str,
    generation: u64,
    controller_epoch: u64,
    revision: u64,
    lane: &Lane,
    orientation: &str,
    layers: &[Placement],
    now: i64,
) -> Value {
    let (width, height) = sheet_size(orientation);
    json!({
        "version": 1,
        "role": HTML_LAYER_ROLE,
        "show": show,
        "publisherSid": publisher_sid,
        "trackSid": track_sid,
        "generation": generation,
        "controllerEpoch": controller_epoch,
        "revision": revision,
        "output": lane.output,
        "orientation": orientation,
        "width": width,
        "height": height,
        "fps": FPS,
        "packing": "rgb-left-alpha-right",
        "expiresAt": now + LEASE_MS - 1000,
        "layers": layers
            .iter()
            .map(|layer| json!({
                "id": layer.id,
                "rect": { "x": layer.rect.x, "y": layer.rect.y, "w": layer.rect.w, "h": layer.rect.h }
            }))
            .collect::<Vec<_>>(),
    })
}

async fn send_manifest(
    local: &LocalParticipant,
    identity: &str,
    bytes: &[u8],
) -> anyhow::Result<()> {
    let mut options = StreamByteOptions::new_with_topic(HTML_LAYER_TOPIC);
    options.mime_type = Some("application/json".to_string());
    options.total_length = Some(bytes.len() as u64);
    options.destination_identities = vec![identity.to_string().into()];
    let writer = local
        .stream_bytes(options)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    writer
        .write(bytes)
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    writer
        .close()
        .await
        .map_err(|error| anyhow::anyhow!("{error}"))
}

/// The controller epoch the manifests carry, or None when this computer
/// does not control the show (lost, or devices held).
fn controller_epoch(state: &AppState) -> Option<u64> {
    if !ENABLED.load(Ordering::Acquire) {
        return None;
    }
    let status = crate::cloud_show::lock(&state.cloud_show).status();
    match status.controller {
        Some(facts) if facts.lost => None,
        Some(facts) => Some(facts.controller_epoch),
        None => Some(0),
    }
}

fn lanes(room: &Room, receipts: &StdMutex<CapabilityReceipts>, now: i64) -> Vec<Lane> {
    let visible: HashMap<String, String> = room
        .remote_participants()
        .values()
        .map(|p| {
            (
                p.identity().as_str().to_string(),
                p.sid().as_str().to_string(),
            )
        })
        .collect();
    let receipts = receipts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut lanes: Vec<Lane> = receipts
        .consumers(&visible, now)
        .into_iter()
        .filter(|(identity, _)| identity.starts_with("EG_"))
        .filter_map(|(identity, sid)| {
            let receipt = receipts.get(&identity)?;
            if !capability_current(Some(receipt), &sid, now) {
                return None;
            }
            let html = receipt.capability.html.as_ref()?;
            Some(Lane {
                identity,
                output: html.output.clone(),
                orientation: html.orientation.clone(),
            })
        })
        .collect();
    lanes.sort_by(|a, b| a.identity.cmp(&b.identity));
    lanes
}

/// One connection's HTML layer sheets. Ends when `done` fires or its sender
/// drops.
pub(crate) async fn run(
    state: AppState,
    room: Arc<Room>,
    show_id: String,
    receipts: Arc<StdMutex<CapabilityReceipts>>,
    mut done: oneshot::Receiver<()>,
) {
    let mut sheets: BTreeMap<String, Sheet> = BTreeMap::new();
    let mut generation = 0u64;
    let mut wanted_at: Option<(bool, Instant)> = None;
    let mut pulse = tokio::time::interval(Duration::from_millis(1000 / u64::from(FPS)));
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut done => break,
            _ = pulse.tick() => {}
            _ = CHANGED.notified() => {}
        }
        let now = chrono::Utc::now().timestamp_millis();
        let epoch = controller_epoch(&state);
        let placements: Placements = PLACEMENTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default();
        // Candidate sheets by key, from the lanes asking.
        let mut candidates: BTreeMap<String, (String, Vec<Placement>, Vec<Lane>)> = BTreeMap::new();
        let mut order: Vec<String> = Vec::new();
        if epoch.is_some() {
            for lane in lanes(&room, &receipts, now) {
                let layers = lane_layers(
                    if lane.orientation == "v" {
                        &placements.v
                    } else {
                        &placements.h
                    },
                    &lane.output,
                    now,
                );
                if layers.is_empty() {
                    continue;
                }
                let key = sheet_key(&lane.orientation, &layers);
                match candidates.get_mut(&key) {
                    Some(entry) => entry.2.push(lane),
                    None => {
                        order.push(key.clone());
                        candidates.insert(key, (lane.orientation.clone(), layers, vec![lane]));
                    }
                }
            }
        }
        // Sheets already out keep their places; new ones take free ones.
        order.sort_by_key(|key| !sheets.contains_key(key));
        order.truncate(MAX_PUBLICATIONS);
        for key in sheets.keys().cloned().collect::<Vec<_>>() {
            if !order.contains(&key)
                && let Some(sheet) = sheets.remove(&key)
            {
                unpublish(&room, sheet).await;
            }
        }
        // The banners' own render targets follow the room's want (a lease).
        let want = !order.is_empty();
        if wanted_at.is_none_or(|(wanted, at)| wanted != want || (want && at.elapsed() >= RENEW)) {
            let params = crate::cloud_graphics::HtmlLayersWantParams {
                show_id: show_id.clone(),
                want,
            };
            if let Err(error) = crate::cloud_graphics::html_layers_want(&state, params) {
                tracing::debug!("The room's HTML layers were not wanted: {error:#}");
            }
            wanted_at = Some((want, Instant::now()));
        }
        let local = room.local_participant();
        for key in &order {
            let Some((orientation, layers, lanes)) = candidates.remove(key) else {
                continue;
            };
            if !sheets.contains_key(key) {
                generation += 1;
                match publish(&room, &orientation, generation).await {
                    Ok((sid, source)) => {
                        sheets.insert(
                            key.clone(),
                            Sheet {
                                orientation: orientation.clone(),
                                layers: Vec::new(),
                                lanes: Vec::new(),
                                generation,
                                revision: 0,
                                sid,
                                source,
                                manifests_at: None,
                            },
                        );
                    }
                    Err(error) => {
                        tracing::warn!("An HTML layer sheet was not published: {error:#}");
                        continue;
                    }
                }
            }
            let Some(sheet) = sheets.get_mut(key) else {
                continue;
            };
            let changed = sheet.lanes != lanes || sheet.layers != layers;
            if changed {
                sheet.revision += 1;
                sheet.layers = layers;
                sheet.lanes = lanes;
            }
            // Draw this sheet's frame.
            let (width, height) = sheet_size(&sheet.orientation);
            let rgba = {
                let state = state.clone();
                let orientation = sheet.orientation.clone();
                let layers = sheet.layers.clone();
                tokio::task::spawn_blocking(move || draw_sheet(&state, &orientation, &layers, now))
                    .await
                    .unwrap_or_default()
            };
            if rgba.len() == (width * height * 4) as usize {
                let buffer = sheet_frame(&rgba, width, height);
                sheet.source.capture_frame(&VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us: now.saturating_mul(1000),
                    frame_metadata: None,
                    buffer,
                });
            }
            // Manifests on a change and before the lease ends.
            if changed || sheet.manifests_at.is_none_or(|at| at.elapsed() >= RENEW) {
                for lane in &sheet.lanes {
                    let value = manifest(
                        &room.name(),
                        local.sid().as_str(),
                        sheet.sid.as_str(),
                        sheet.generation,
                        epoch.unwrap_or(0),
                        sheet.revision,
                        lane,
                        &sheet.orientation,
                        &sheet.layers,
                        now,
                    );
                    let bytes = value.to_string().into_bytes();
                    if bytes.len() > MANIFEST_MAX_BYTES {
                        continue;
                    }
                    if let Err(error) = send_manifest(&local, &lane.identity, &bytes).await {
                        tracing::debug!("An HTML layer manifest did not go out: {error:#}");
                    }
                }
                sheet.manifests_at = Some(Instant::now());
            }
        }
    }
    for (_, sheet) in std::mem::take(&mut sheets) {
        unpublish(&room, sheet).await;
    }
    let params = crate::cloud_graphics::HtmlLayersWantParams {
        show_id,
        want: false,
    };
    let _ = crate::cloud_graphics::html_layers_want(&state, params);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placement(id: &str, stream: bool, opacity: f64) -> Placement {
        Placement {
            id: format!("banner:{id}"),
            banner_id: id.to_string(),
            rect: Rect {
                x: 0.0,
                y: 0.5,
                w: 0.5,
                h: 0.5,
            },
            opacity,
            fade: None,
            stream,
            recording: !stream,
        }
    }

    #[test]
    fn a_lane_shows_its_output_and_skips_faded_out_layers() {
        let layers = vec![
            placement("a", true, 1.0),
            placement("b", false, 1.0),
            placement("c", true, 0.0),
        ];
        let shown = lane_layers(&layers, "stream", 0);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].banner_id, "a");
        assert_eq!(lane_layers(&layers, "recording", 0)[0].banner_id, "b");
    }

    #[test]
    fn a_sheet_is_named_by_its_orientation_and_sorted_layers() {
        let layers = vec![placement("b", true, 1.0), placement("a", true, 1.0)];
        assert_eq!(sheet_key("h", &layers), "h|banner:a,banner:b");
    }

    #[test]
    fn the_fade_eases_out_over_200_ms() {
        let fade = Fade {
            at: 1_000,
            from: 0.0,
            to: 1.0,
        };
        assert_eq!(fade_at(Some(&fade), 1_000), 0.0);
        assert!((fade_at(Some(&fade), 1_100) - 0.875).abs() < 1e-9);
        assert_eq!(fade_at(Some(&fade), 1_300), 1.0);
        assert_eq!(fade_at(None, 0), 1.0);
    }

    #[test]
    fn a_rect_covers_whole_pixels_on_the_sheet() {
        let rect = Rect {
            x: 0.1,
            y: 0.5,
            w: 0.5,
            h: 0.5,
        };
        assert_eq!(layer_pixels(&rect, (640, 360)), (64, 180, 320, 180));
    }

    #[test]
    fn layers_blend_as_the_canvas_does() {
        let mut pixel = [0, 0, 0, 0];
        blend_over(&mut pixel, [200, 100, 0, 255], 0.5);
        assert_eq!(pixel, [200, 100, 0, 128]);
        blend_over(&mut pixel, [0, 0, 200, 255], 1.0);
        assert_eq!(pixel, [0, 0, 200, 255]);
    }

    #[test]
    fn resampling_keeps_partial_alpha() {
        // BGRA: one opaque red texel and one 50% blue texel, side by side.
        let bgra = [0, 0, 255, 255, 255, 0, 0, 128];
        let one = resample_bgra(&bgra, 2, 1, 1, 1).unwrap();
        // Coverage is the mean alpha; colour is weighted by it.
        assert!((191..=192).contains(&one[3]), "{one:?}");
        assert!(one[0] > one[2], "{one:?}");
        let same = resample_bgra(&bgra, 2, 1, 2, 1).unwrap();
        assert_eq!(same, vec![255, 0, 0, 255, 0, 0, 255, 128]);
        // Fully clear stays clear.
        assert_eq!(
            resample_bgra(&[9, 9, 9, 0], 1, 1, 1, 1).unwrap(),
            vec![0, 0, 0, 0]
        );
    }

    #[test]
    fn the_sheet_packs_colour_gutter_alpha() {
        let rgba = [10, 20, 30, 40, 50, 60, 70, 255];
        let packed = pack(&rgba, 2, 1);
        assert_eq!(packed.len(), (2 * 2 + 8) * 4);
        assert_eq!(&packed[..8], &[10, 20, 30, 255, 50, 60, 70, 255]);
        assert_eq!(&packed[8..12], &[0, 0, 0, 255]);
        assert_eq!(
            &packed[packed.len() - 8..],
            &[40, 40, 40, 255, 255, 255, 255, 255]
        );
    }

    #[test]
    fn a_manifest_names_the_sheet_for_one_lane() {
        let lane = Lane {
            identity: "EG_p".to_string(),
            output: "stream".to_string(),
            orientation: "h".to_string(),
        };
        let value = manifest(
            "show_1",
            "PA_host",
            "TR_sheet",
            3,
            7,
            2,
            &lane,
            "h",
            &[placement("a", true, 1.0)],
            1_000,
        );
        assert_eq!(value["role"], HTML_LAYER_ROLE);
        assert_eq!(value["width"], 640);
        assert_eq!(value["packing"], "rgb-left-alpha-right");
        assert_eq!(value["expiresAt"], 30_000);
        assert_eq!(value["layers"][0]["id"], "banner:a");
        assert_eq!(value.as_object().unwrap().len(), 16);
    }
}
