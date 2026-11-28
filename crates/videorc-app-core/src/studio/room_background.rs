//! Plan 249 S14: prepare a Studio working background for a room scene
//! commit (`room-background.ts` / `cloud-background.ts`).
//!
//! Live backgrounds become [`SceneBackground::Live`] with a phase clock.
//! Picture backgrounds need encoded bytes (hash/mime/width/height). The
//! GPUI host resolves [`managed_background_file_name`] under
//! [`managed_background_roots`], encodes (WebP/JPEG), and passes the
//! bytes here; without bytes, prepare fails with a clear note and the
//! scene still commits without a background asset.
//!
//! Gap: look-specific live clock rates/poster phases from
//! `live_background/looks.rs` are not mirrored in app-core; calm uses half
//! of [`DEFAULT_LIVE_CLOCK_RATE`].

use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::cloud_scene::types::{
    BACKGROUND_ASSET_MAX_SIDE, BACKGROUND_DIM_MAX, BackgroundCrop, BackgroundMime,
    LIVE_BACKGROUND_IDS, LiveBackgroundClock, SceneBackground, SceneFit,
};
use crate::studio::js_value::{finite_number, get, string};
use crate::studio::room_scene::PreparedBackgroundAsset;

/// Bytes of one encoded picture (WebP/JPEG/PNG), header excluded.
pub const BACKGROUND_ASSET_MAX_BYTES: usize = 2 * 1024 * 1024;

/// The managed folder under the app's user data (`background-assets`).
pub const MANAGED_BACKGROUND_DIR: &str = "background-assets";

/// When the host could not load or encode the managed picture.
pub const PICTURE_ENCODE_GAP: &str =
    "The background picture couldn't be sent to the room: the file couldn't be read or encoded.";

/// File name inside a `videorc-asset://background/…` URL, or the basename of
/// an absolute managed path. `None` when the path is empty or escapes.
pub fn managed_background_file_name(managed_asset_path: &str) -> Option<String> {
    let path = managed_asset_path.trim();
    if path.is_empty() {
        return None;
    }
    let file =
        if let Some(rest) = path.strip_prefix(crate::scenes::background::MANAGED_BACKGROUND_ROOT) {
            rest
        } else if path.starts_with('/')
            || (path.len() > 2 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'\\')
        {
            Path::new(path).file_name()?.to_str()?
        } else {
            return None;
        };
    let decoded = percent_decode(file);
    if decoded.is_empty()
        || decoded.contains('/')
        || decoded.contains('\\')
        || decoded.contains("..")
    {
        return None;
    }
    Some(decoded)
}

/// Roots Electron serves for `videorc-asset://background/…`: imported assets
/// under user data, then the bundled pictures directory when present.
pub fn managed_background_roots(user_data_dir: &Path, bundled_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = vec![user_data_dir.join(MANAGED_BACKGROUND_DIR)];
    if let Some(bundled) = bundled_dir.filter(|path| path.is_dir()) {
        roots.push(bundled.to_path_buf());
    }
    roots
}

/// The first regular file named `file_name` under `roots` (no symlinks).
pub fn resolve_managed_background_file(file_name: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
    {
        return None;
    }
    for root in roots {
        let candidate = root.join(file_name);
        let Ok(meta) = std::fs::symlink_metadata(&candidate) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_file() {
            continue;
        }
        let Ok(canonical_root) = std::fs::canonicalize(root) else {
            continue;
        };
        let Ok(canonical_file) = std::fs::canonicalize(&candidate) else {
            continue;
        };
        if canonical_file.starts_with(&canonical_root) {
            return Some(canonical_file);
        }
    }
    None
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A prepared room background (and optional picture asset).
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedBackground {
    pub background: SceneBackground,
    pub asset: Option<PreparedBackgroundAsset>,
}

/// Prior live clock kept across look/motion changes without a jump.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveClockMemory {
    pub id: String,
    pub clock: LiveBackgroundClock,
}

/// Look clock constants when the backend render export is unavailable.
pub const DEFAULT_LIVE_CLOCK_RATE: f64 = 1.0;
pub const DEFAULT_LIVE_POSTER_PHASE: f64 = 0.0;

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.clamp(min, max)
}

/// Rust `scene_geometry::background_zoom_crop`.
pub fn background_zoom_crop(scale: f64, offset_x: f64, offset_y: f64) -> BackgroundCrop {
    let s = clamp(if scale.is_finite() { scale } else { 100.0 }, 100.0, 200.0);
    if s <= 100.0 {
        return BackgroundCrop {
            l: 0.0,
            t: 0.0,
            r: 0.0,
            b: 0.0,
        };
    }
    let total = 1.0 - 100.0 / s;
    let x = (clamp(
        if offset_x.is_finite() { offset_x } else { 0.0 },
        -100.0,
        100.0,
    ) / 200.0)
        * total;
    let y = (clamp(
        if offset_y.is_finite() { offset_y } else { 0.0 },
        -100.0,
        100.0,
    ) / 200.0)
        * total;
    BackgroundCrop {
        l: clamp(total / 2.0 + x, 0.0, 0.95),
        t: clamp(total / 2.0 + y, 0.0, 0.95),
        r: clamp(total / 2.0 - x, 0.0, 0.95),
        b: clamp(total / 2.0 - y, 0.0, 0.95),
    }
}

/// Native fit: only `fit` keeps the whole picture; `fill` and `stretch` cover.
pub fn background_fit(fit: &str) -> SceneFit {
    if fit == "fit" {
        SceneFit::Contain
    } else {
        SceneFit::Cover
    }
}

/// `live_background/runtime.rs`: `(dim_percent / 100).clamp(0, 0.8)`.
pub fn live_background_dim(dim_percent: f64) -> f64 {
    clamp(
        (if dim_percent.is_finite() {
            dim_percent
        } else {
            0.0
        }) / 100.0,
        0.0,
        BACKGROUND_DIM_MAX,
    )
}

/// The shader phase at wall time `now` (ms).
pub fn live_background_phase(clock: &LiveBackgroundClock, now: i64) -> f64 {
    clock.anchor_phase + clock.rate * ((now - clock.anchor_at).max(0) as f64) / 1000.0
}

/// Next clock for `next`, continuing `previous` without a jump.
pub fn next_live_clock(
    previous: Option<&LiveClockMemory>,
    next_id: &str,
    rate: f64,
    poster_phase: f64,
    now: i64,
) -> LiveBackgroundClock {
    if let Some(previous) = previous.filter(|previous| previous.id == next_id) {
        if (previous.clock.rate - rate).abs() < f64::EPSILON {
            return previous.clock;
        }
        return LiveBackgroundClock {
            anchor_at: now,
            anchor_phase: live_background_phase(&previous.clock, now),
            rate,
        };
    }
    LiveBackgroundClock {
        anchor_at: now,
        anchor_phase: poster_phase,
        rate,
    }
}

/// SHA-256 hex of picture bytes (`hexOf`).
pub fn hex_of(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Scale a picture down to at most [`BACKGROUND_ASSET_MAX_SIDE`].
pub fn picture_size(width: u32, height: u32) -> (u32, u32) {
    let max_side = BACKGROUND_ASSET_MAX_SIDE as f64;
    let scale = (1.0_f64).min(max_side / f64::from(width.max(height).max(1)));
    (
        ((f64::from(width) * scale).round() as u32).max(1),
        ((f64::from(height) * scale).round() as u32).max(1),
    )
}

fn mime_from_str(mime: &str) -> Option<BackgroundMime> {
    match mime {
        "image/webp" => Some(BackgroundMime::Webp),
        "image/jpeg" => Some(BackgroundMime::Jpeg),
        "image/png" => Some(BackgroundMime::Png),
        _ => None,
    }
}

fn side_u32(value: Option<&Value>) -> Option<u32> {
    let n = finite_number(value)? as i64;
    (1..=BACKGROUND_ASSET_MAX_SIDE)
        .contains(&n)
        .then_some(n as u32)
}

/// Prepare a working-scene background Value for a room commit.
///
/// `picture_bytes`: optional already-encoded picture (tests / future encode).
/// When absent and the background is a picture, returns [`PICTURE_ENCODE_GAP`].
pub fn prepare_room_background(
    background: &Value,
    now_ms: i64,
    previous_live: Option<&LiveClockMemory>,
    picture_bytes: Option<&[u8]>,
) -> Result<(PreparedBackground, Option<LiveClockMemory>), String> {
    let bg = Some(background);
    if let Some(live) = get(bg, "live") {
        let id = string(get(Some(live), "id")).unwrap_or_default();
        if !LIVE_BACKGROUND_IDS.contains(&id) {
            return Err("This live background is not known here.".into());
        }
        let look = string(get(Some(live), "look")).unwrap_or("default");
        let motion = string(get(Some(live), "motion")).unwrap_or("normal");
        let dim_percent = finite_number(get(bg, "dimPercent")).unwrap_or(0.0);
        let rate = DEFAULT_LIVE_CLOCK_RATE * if motion == "calm" { 0.5 } else { 1.0 };
        let clock = next_live_clock(previous_live, id, rate, DEFAULT_LIVE_POSTER_PHASE, now_ms);
        let memory = LiveClockMemory {
            id: id.to_string(),
            clock,
        };
        return Ok((
            PreparedBackground {
                background: SceneBackground::Live {
                    id: id.to_string(),
                    look: look.to_string(),
                    dim: live_background_dim(dim_percent),
                    clock,
                },
                asset: None,
            },
            Some(memory),
        ));
    }

    let scale = finite_number(get(bg, "scale")).unwrap_or(100.0);
    let offset_x = finite_number(get(bg, "offsetX")).unwrap_or(0.0);
    let offset_y = finite_number(get(bg, "offsetY")).unwrap_or(0.0);
    let fit = background_fit(string(get(bg, "fit")).unwrap_or("fill"));
    let crop = background_zoom_crop(scale, offset_x, offset_y);

    // Pre-baked picture fields on the working background (rare).
    if let (Some(hash), Some(mime), Some(width), Some(height)) = (
        string(get(bg, "hash")),
        string(get(bg, "mime")).and_then(mime_from_str),
        side_u32(get(bg, "width")),
        side_u32(get(bg, "height")),
    ) {
        let bytes = picture_bytes.unwrap_or(&[]).to_vec();
        let asset = if bytes.is_empty() {
            None
        } else {
            if bytes.len() > BACKGROUND_ASSET_MAX_BYTES {
                return Err("The background picture is too large to send.".into());
            }
            Some(PreparedBackgroundAsset {
                hash: hash.to_string(),
                mime,
                width,
                height,
                bytes,
            })
        };
        return Ok((
            PreparedBackground {
                background: SceneBackground::Picture {
                    hash: hash.to_string(),
                    mime,
                    width: i64::from(width),
                    height: i64::from(height),
                    fit,
                    crop,
                },
                asset,
            },
            None,
        ));
    }

    let Some(bytes) = picture_bytes else {
        return Err(PICTURE_ENCODE_GAP.into());
    };
    if bytes.len() > BACKGROUND_ASSET_MAX_BYTES {
        return Err("The background picture is too large to send.".into());
    }
    let width = finite_number(get(bg, "width"))
        .map(|n| n as u32)
        .filter(|&w| w > 0)
        .unwrap_or(1);
    let height = finite_number(get(bg, "height"))
        .map(|n| n as u32)
        .filter(|&h| h > 0)
        .unwrap_or(1);
    let (width, height) = picture_size(width, height);
    let mime = string(get(bg, "mime"))
        .and_then(mime_from_str)
        .unwrap_or(BackgroundMime::Webp);
    let hash = hex_of(bytes);
    let asset = PreparedBackgroundAsset {
        hash: hash.clone(),
        mime,
        width,
        height,
        bytes: bytes.to_vec(),
    };
    Ok((
        PreparedBackground {
            background: SceneBackground::Picture {
                hash,
                mime,
                width: i64::from(width),
                height: i64::from(height),
                fit,
                crop,
            },
            asset: Some(asset),
        },
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn zoom_crop_fit_and_dim_match_cloud_background() {
        let crop = background_zoom_crop(200.0, 0.0, 0.0);
        assert!((crop.l - 0.25).abs() < 1e-9);
        assert!((crop.r - 0.25).abs() < 1e-9);
        assert_eq!(background_fit("fit"), SceneFit::Contain);
        assert_eq!(background_fit("fill"), SceneFit::Cover);
        assert!((live_background_dim(80.0) - 0.8).abs() < 1e-9);
        assert!((live_background_dim(100.0) - 0.8).abs() < 1e-9);
    }

    #[test]
    fn live_prepare_builds_scene_background() {
        let (prepared, memory) = prepare_room_background(
            &json!({
                "assetId": "live-silk-satin",
                "dimPercent": 20,
                "live": { "id": "silk", "look": "satin", "motion": "calm" }
            }),
            1_000,
            None,
            None,
        )
        .expect("live");
        assert!(prepared.asset.is_none());
        match prepared.background {
            SceneBackground::Live {
                id,
                look,
                dim,
                clock,
            } => {
                assert_eq!(id, "silk");
                assert_eq!(look, "satin");
                assert!((dim - 0.2).abs() < 1e-9);
                assert!((clock.rate - 0.5).abs() < 1e-9);
                assert_eq!(clock.anchor_at, 1_000);
            }
            other => panic!("expected live, got {other:?}"),
        }
        assert_eq!(memory.unwrap().id, "silk");
    }

    #[test]
    fn picture_without_bytes_names_the_gap() {
        let err = prepare_room_background(
            &json!({
                "assetId": "builtin-bg-01",
                "fit": "fill",
                "scale": 100,
                "managedAssetPath": "videorc-asset://background/code-demo.webp"
            }),
            0,
            None,
            None,
        )
        .expect_err("gap");
        assert_eq!(err, PICTURE_ENCODE_GAP);
    }

    #[test]
    fn managed_asset_paths_resolve_under_roots() {
        assert_eq!(
            managed_background_file_name("videorc-asset://background/code-demo.webp").as_deref(),
            Some("code-demo.webp")
        );
        assert_eq!(
            managed_background_file_name("videorc-asset://background/bg%207.webp").as_deref(),
            Some("bg 7.webp")
        );
        assert!(managed_background_file_name("videorc-asset://background/../x").is_none());

        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("beach.webp");
        std::fs::write(&file, b"webp").unwrap();
        let roots = managed_background_roots(root.path(), None);
        assert_eq!(roots, vec![root.path().join(MANAGED_BACKGROUND_DIR)]);
        let roots = vec![root.path().to_path_buf()];
        // The resolver answers the canonical path (macOS: /var is
        // /private/var), so compare against the file's canonical path.
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert_eq!(
            resolve_managed_background_file("beach.webp", &roots).as_deref(),
            Some(canonical.as_path())
        );
        assert!(resolve_managed_background_file("../beach.webp", &roots).is_none());
    }

    #[test]
    fn picture_with_bytes_hashes_and_attaches() {
        let bytes = b"fake-webp-bytes";
        let (prepared, _) = prepare_room_background(
            &json!({
                "assetId": "builtin-bg-01",
                "fit": "fit",
                "scale": 100,
                "width": 100,
                "height": 50,
                "mime": "image/webp"
            }),
            0,
            None,
            Some(bytes.as_slice()),
        )
        .expect("picture");
        let asset = prepared.asset.expect("asset");
        assert_eq!(asset.bytes, bytes);
        assert_eq!(asset.hash, hex_of(bytes));
        assert_eq!(asset.mime, BackgroundMime::Webp);
        match prepared.background {
            SceneBackground::Picture { fit, .. } => assert_eq!(fit, SceneFit::Contain),
            other => panic!("expected picture, got {other:?}"),
        }
    }

    #[test]
    fn next_live_clock_continues_same_id() {
        let first = next_live_clock(None, "silk", 1.0, 0.0, 0);
        let memory = LiveClockMemory {
            id: "silk".into(),
            clock: first,
        };
        let same = next_live_clock(Some(&memory), "silk", 1.0, 0.0, 500);
        assert_eq!(same, first);
        let faster = next_live_clock(Some(&memory), "silk", 2.0, 0.0, 1_000);
        assert_eq!(faster.rate, 2.0);
        assert_eq!(faster.anchor_at, 1_000);
    }
}
