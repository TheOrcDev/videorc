//! Banners (plan 186): a streamer's own images placed anywhere on the
//! picture. A sponsor strip, "Follow me @handle", a logo, a full frame with a
//! transparent hole.
//!
//! This module owns the domain rules: the import pipeline (sniff, refuse,
//! decode, orient, downscale, publish), the default places, the contained
//! draw rect every render path shares, the update validation, the delete path
//! guard and the one hook every mutation ends in. SQLite rows live in
//! `storage.rs`; the RPCs in `main.rs`; drawing is S3's.
//!
//! Refusals are ordinary `anyhow` errors whose message is the verbatim
//! sentence from the plan's "Refusals" list, so `banners.*` callers can show
//! them as warnings unchanged. Never wrap one in `.context`.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use image::ImageDecoder;
use uuid::Uuid;

use crate::atomic_file;
use crate::banner_prepare::{
    BANNER_BITMAP_BUDGET_BYTES, BannerFileRevision, banner_file_revision, show_exceeds_budget,
};
use crate::overlay_layout::{
    LANDSCAPE_EDGE_MARGIN, LANDSCAPE_SIDE_MARGIN, OVERLAY_RECT_MIN_SIZE, OverlayHorizontalGravity,
    OverlayOrientation, OverlayRect, OverlaySessionShape, OverlaySwitches, PORTRAIT_SIDE_MARGIN,
    PORTRAIT_TOP_MARGIN, RECT_EPSILON, overlay_leg_plan, round6,
};
use crate::protocol::{Banner, UpdateBannerParams};
use crate::state::AppState;
use crate::storage::{Database, metadata_is_symlink_or_reparse};

/// Event carrying the full banner list to every window after each mutation.
pub(crate) const BANNERS_CHANGED_EVENT: &str = "banners.changed";

// --- Limits (D7) -------------------------------------------------------------

/// Largest source file accepted, in bytes.
pub(crate) const BANNER_MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// Largest source image accepted, from its header, in pixels.
pub(crate) const BANNER_MAX_PIXELS: u64 = 40_000_000;
/// Smallest side a source image may have.
pub(crate) const BANNER_MIN_SIDE: u32 = 16;
/// Longest side of the stored copy; a larger source is downscaled.
pub(crate) const BANNER_MAX_STORED_SIDE: u32 = 3840;
/// Longest side of the Assets thumbnail.
pub(crate) const BANNER_THUMBNAIL_SIDE: u32 = 480;
/// Most banners in Assets.
pub(crate) const BANNER_MAX_COUNT: usize = 24;
/// Most banners showing at once.
pub(crate) const BANNER_MAX_SHOWN: usize = 4;
/// Decoder allocation ceiling: a 40 MP RGBA source is 160 MB.
const BANNER_DECODE_MAX_ALLOC: u64 = 192 * 1024 * 1024;
/// Name length, in characters.
pub(crate) const BANNER_NAME_MAX_CHARS: usize = 40;
pub(crate) const BANNER_OPACITY_MIN: f64 = 0.2;
pub(crate) const BANNER_OPACITY_MAX: f64 = 1.0;

// --- Refusal sentences (plan 186 "Refusals", verbatim) -----------------------

pub(crate) const REFUSAL_NOT_AN_IMAGE: &str = "This file isn't a PNG, JPEG or WebP image.";
pub(crate) const REFUSAL_ANIMATED: &str =
    "Animated images aren't supported yet. Export a still PNG.";
pub(crate) const REFUSAL_TOO_LARGE: &str =
    "This image is too large. Use one under 25 MB and 40 megapixels.";
pub(crate) const REFUSAL_TOO_MANY: &str = "You have 24 banners. Delete one to import another.";
pub(crate) const REFUSAL_FOUR_SHOWING: &str = "Four banners are showing. Hide one first.";
pub(crate) const REFUSAL_DELETE_SHOWN_IN_SESSION: &str = "Hide this banner before you delete it.";
/// A Show during a session that cannot draw a banner added after its start
/// (plan 186 S4): the legacy FFmpeg graph without its overlay FIFO, or the
/// Windows direct D3D11 recording.
pub(crate) const REFUSAL_SESSION_CANNOT_ADD: &str =
    "This recording can't add banners after it starts. Show the banner before you press Record.";
/// The plan pins no sentence for the 16 px floor; this one follows the shape
/// of its neighbours.
pub(crate) const REFUSAL_TOO_SMALL: &str = "This image is too small. Use one at least 16 × 16 px.";

// --- Sniffing ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BannerImageFormat {
    Png,
    Jpeg,
    WebP,
}

impl BannerImageFormat {
    fn image_format(self) -> image::ImageFormat {
        match self {
            BannerImageFormat::Png => image::ImageFormat::Png,
            BannerImageFormat::Jpeg => image::ImageFormat::Jpeg,
            BannerImageFormat::WebP => image::ImageFormat::WebP,
        }
    }
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// The format from the magic bytes alone; the extension is never trusted.
pub(crate) fn sniff_banner_image(bytes: &[u8]) -> Result<BannerImageFormat> {
    if bytes.starts_with(&PNG_SIGNATURE) {
        return Ok(BannerImageFormat::Png);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Ok(BannerImageFormat::Jpeg);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok(BannerImageFormat::WebP);
    }
    bail!(REFUSAL_NOT_AN_IMAGE)
}

/// Animated PNG carries an `acTL` chunk before its first `IDAT`; animated
/// WebP carries an `ANIM` chunk (and sets the VP8X animation flag).
pub(crate) fn is_animated_banner_image(format: BannerImageFormat, bytes: &[u8]) -> bool {
    match format {
        BannerImageFormat::Png => png_has_actl(bytes),
        BannerImageFormat::WebP => webp_is_animated(bytes),
        BannerImageFormat::Jpeg => false,
    }
}

fn png_has_actl(bytes: &[u8]) -> bool {
    let mut offset = PNG_SIGNATURE.len();
    while offset + 8 <= bytes.len() {
        let length = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as usize;
        let kind = &bytes[offset + 4..offset + 8];
        if kind == b"acTL" {
            return true;
        }
        if kind == b"IDAT" || kind == b"IEND" {
            return false;
        }
        // length + type + data + CRC
        offset = match offset
            .checked_add(12)
            .and_then(|next| next.checked_add(length))
        {
            Some(next) => next,
            None => return false,
        };
    }
    false
}

fn webp_is_animated(bytes: &[u8]) -> bool {
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let fourcc = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        if fourcc == b"ANIM" || fourcc == b"ANMF" {
            return true;
        }
        if fourcc == b"VP8X" && offset + 9 <= bytes.len() && bytes[offset + 8] & 0x02 != 0 {
            return true;
        }
        // Chunks are padded to an even size.
        let padded = size + (size & 1);
        offset = match offset
            .checked_add(8)
            .and_then(|next| next.checked_add(padded))
        {
            Some(next) => next,
            None => return false,
        };
    }
    false
}

// --- Import ------------------------------------------------------------------

/// What the header says about a source before any pixel is decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InspectedBannerImage {
    pub format: BannerImageFormat,
    pub width: u32,
    pub height: u32,
}

/// Steps 1-3 of the import: sniff, refuse animation, refuse by size (bytes,
/// megapixels from the header, the 16 px floor). Pure over the bytes.
pub(crate) fn inspect_banner_image(bytes: &[u8]) -> Result<InspectedBannerImage> {
    let format = sniff_banner_image(bytes)?;
    if is_animated_banner_image(format, bytes) {
        bail!(REFUSAL_ANIMATED);
    }
    if bytes.len() as u64 > BANNER_MAX_FILE_BYTES {
        bail!(REFUSAL_TOO_LARGE);
    }
    let (width, height) = banner_reader(format, bytes)
        .into_dimensions()
        .map_err(|error| anyhow::anyhow!("Couldn't read this image's size: {error}"))?;
    check_banner_dimensions(width, height)?;
    Ok(InspectedBannerImage {
        format,
        width,
        height,
    })
}

/// The 40 MP ceiling and the 16 px floor, from header dimensions.
pub(crate) fn check_banner_dimensions(width: u32, height: u32) -> Result<()> {
    if u64::from(width) * u64::from(height) > BANNER_MAX_PIXELS {
        bail!(REFUSAL_TOO_LARGE);
    }
    if width < BANNER_MIN_SIDE || height < BANNER_MIN_SIDE {
        bail!(REFUSAL_TOO_SMALL);
    }
    Ok(())
}

fn banner_reader(format: BannerImageFormat, bytes: &[u8]) -> image::ImageReader<Cursor<&[u8]>> {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(BANNER_DECODE_MAX_ALLOC);
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format.image_format());
    reader.limits(limits);
    reader
}

/// Step 5: decode under the allocation limit and apply the EXIF orientation,
/// so a phone photo lands the way its viewer showed it.
pub(crate) fn decode_banner_image(
    inspected: InspectedBannerImage,
    bytes: &[u8],
) -> Result<image::RgbaImage> {
    let mut decoder = banner_reader(inspected.format, bytes)
        .into_decoder()
        .map_err(|error| anyhow::anyhow!("Couldn't decode this image: {error}"))?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded = image::DynamicImage::from_decoder(decoder)
        .map_err(|error| anyhow::anyhow!("Couldn't decode this image: {error}"))?;
    decoded.apply_orientation(orientation);
    Ok(decoded.into_rgba8())
}

/// Whether any pixel is not fully opaque.
pub(crate) fn image_has_alpha(image: &image::RgbaImage) -> bool {
    image.pixels().any(|pixel| pixel[3] != 255)
}

/// Step 6: the longest side brought down to `max_side`, never up.
pub(crate) fn fit_within(image: &image::RgbaImage, max_side: u32) -> image::RgbaImage {
    let (width, height) = image.dimensions();
    let longest = width.max(height);
    if longest <= max_side {
        return image.clone();
    }
    let scale = f64::from(max_side) / f64::from(longest);
    let target_width = ((f64::from(width) * scale).round() as u32).clamp(1, max_side);
    let target_height = ((f64::from(height) * scale).round() as u32).clamp(1, max_side);
    resize_straight_alpha(image, target_width, target_height)
}

/// Scale a straight-alpha image to exactly `target_width` × `target_height`.
/// Lanczos3 on premultiplied pixels and straight alpha again afterwards (the
/// `buddy_sprite::scale_cell` recipe), so a soft edge gets no dark halo. An
/// opaque image skips the premultiply, which is the identity for it. The
/// premultiplied copy stays 8-bit: a 40 MP source in `f32` would be 640 MB.
/// Shared by the import (`fit_within`) and the compositor's prepared bitmaps
/// (`banner_prepare`, S3).
pub(crate) fn resize_straight_alpha(
    image: &image::RgbaImage,
    target_width: u32,
    target_height: u32,
) -> image::RgbaImage {
    let (width, height) = image.dimensions();
    let target_width = target_width.max(1);
    let target_height = target_height.max(1);
    if (width, height) == (target_width, target_height) {
        return image.clone();
    }
    if !image_has_alpha(image) {
        return image::imageops::resize(
            image,
            target_width,
            target_height,
            image::imageops::FilterType::Lanczos3,
        );
    }
    let premultiplied = image::RgbaImage::from_fn(width, height, |x, y| {
        let pixel = image.get_pixel(x, y);
        let alpha = u32::from(pixel[3]);
        let channel = |value: u8| ((u32::from(value) * alpha + 127) / 255) as u8;
        image::Rgba([
            channel(pixel[0]),
            channel(pixel[1]),
            channel(pixel[2]),
            pixel[3],
        ])
    });
    let scaled = image::imageops::resize(
        &premultiplied,
        target_width,
        target_height,
        image::imageops::FilterType::Lanczos3,
    );
    image::RgbaImage::from_fn(target_width, target_height, |x, y| {
        let pixel = scaled.get_pixel(x, y);
        let alpha = u32::from(pixel[3]);
        if alpha == 0 {
            return image::Rgba([0, 0, 0, 0]);
        }
        let channel = |value: u8| ((u32::from(value) * 255 + alpha / 2) / alpha).min(255) as u8;
        image::Rgba([
            channel(pixel[0]),
            channel(pixel[1]),
            channel(pixel[2]),
            pixel[3],
        ])
    })
}

fn encode_png(image: &image::RgbaImage) -> Result<Vec<u8>> {
    use image::ImageEncoder;
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new_with_quality(
        &mut bytes,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Adaptive,
    )
    .write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .context("Couldn't encode the banner image")?;
    Ok(bytes)
}

/// Publish `bytes` at `destination` through a staged sibling and an atomic
/// replace, so a crash never leaves a half-written banner behind.
fn write_file_atomically(destination: &Path, bytes: &[u8]) -> Result<()> {
    let parent = destination
        .parent()
        .context("Banner file has no parent directory")?;
    let staged_name = format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("banner"),
        Uuid::new_v4()
    );
    let staged = parent.join(staged_name);
    let outcome = (|| -> Result<()> {
        let mut file = std::fs::File::create(&staged)
            .with_context(|| format!("Could not create {}", staged.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_file::replace_file(&staged, destination)
            .with_context(|| format!("Could not publish {}", destination.display()))?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    outcome
}

/// The file stem at import, trimmed to 40 characters (D1 table).
pub(crate) fn banner_name_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim();
    let name = stem
        .chars()
        .take(BANNER_NAME_MAX_CHARS)
        .collect::<String>()
        .trim_end()
        .to_string();
    if name.is_empty() {
        "Banner".to_string()
    } else {
        name
    }
}

fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>> {
    let file =
        std::fs::File::open(path).with_context(|| format!("Could not open {}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(cap)
        .read_to_end(&mut bytes)
        .with_context(|| format!("Could not read {}", path.display()))?;
    Ok(bytes)
}

/// Everything the row needs besides what SQLite assigns (sort order,
/// timestamps). Built by the import, consumed by `Database::insert_banner`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NewBanner {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub horizontal: OverlayRect,
    pub vertical: OverlayRect,
}

pub(crate) fn banner_image_file_name(id: &str) -> String {
    format!("{id}.png")
}

pub(crate) fn banner_thumbnail_file_name(id: &str) -> String {
    format!("{id}.thumb.png")
}

/// The managed `Banners` directory must be a real directory, never a symlink
/// or a reparse point, before anything is written into or deleted from it.
pub(crate) fn validate_managed_banner_root(root: &Path) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(root)
        .with_context(|| "Managed Banners directory is unavailable.")?;
    if !metadata.is_dir() || metadata_is_symlink_or_reparse(&metadata) {
        bail!("Managed Banners directory is not a direct regular directory.");
    }
    std::fs::canonicalize(root).context("Managed Banners directory could not be resolved.")
}

/// The whole import ("Import" in plan 186), blocking: run it on the
/// AssetImport lane through `spawn_blocking`. Nothing is published half done:
/// the row is inserted last, and both files are removed if it is not.
pub(crate) fn import_banner(database: &Database, source_path: &Path) -> Result<Banner> {
    // One byte over the cap is enough to refuse; never read a huge file whole.
    let bytes = read_capped(source_path, BANNER_MAX_FILE_BYTES + 1)?;
    let inspected = inspect_banner_image(&bytes)?;
    if database.count_banners()? >= BANNER_MAX_COUNT {
        bail!(REFUSAL_TOO_MANY);
    }
    let decoded = decode_banner_image(inspected, &bytes)?;
    drop(bytes);
    let stored = fit_within(&decoded, BANNER_MAX_STORED_SIDE);
    drop(decoded);
    let has_alpha = image_has_alpha(&stored);
    let thumbnail = fit_within(&stored, BANNER_THUMBNAIL_SIDE);
    let image_png = encode_png(&stored)?;
    let thumbnail_png = encode_png(&thumbnail)?;
    let (width, height) = stored.dimensions();
    drop(stored);
    drop(thumbnail);

    let id = Uuid::new_v4().to_string();
    let root = database.banner_assets_dir();
    std::fs::create_dir_all(&root)
        .with_context(|| format!("Could not create {}", root.display()))?;
    let root = validate_managed_banner_root(&root)?;
    let image_path = root.join(banner_image_file_name(&id));
    let thumbnail_path = root.join(banner_thumbnail_file_name(&id));
    let (horizontal, vertical) = banner_default_places(width, height);
    let published = (|| -> Result<Banner> {
        write_file_atomically(&image_path, &image_png)?;
        write_file_atomically(&thumbnail_path, &thumbnail_png)?;
        database.insert_banner(
            NewBanner {
                id: id.clone(),
                name: banner_name_from_path(source_path),
                width,
                height,
                has_alpha,
                horizontal,
                vertical,
            },
            BANNER_MAX_COUNT,
        )
    })();
    if published.is_err() {
        let _ = std::fs::remove_file(&image_path);
        let _ = std::fs::remove_file(&thumbnail_path);
    }
    published
}

// --- Delete ------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BannerFileKind {
    Image,
    Thumbnail,
}

/// The delete path guard: a stored basename resolves to a file only when it is
/// exactly the managed name for this banner, inside the canonical managed
/// root, and a direct regular file. `Ok(None)` means the file is already
/// gone, which a delete tolerates. Anything else is refused, so a forged row
/// can never turn `banners.delete` into an arbitrary file deletion.
pub(crate) fn managed_banner_file(
    root: &Path,
    banner_id: &str,
    stored_name: &str,
    kind: BannerFileKind,
) -> Result<Option<PathBuf>> {
    Uuid::parse_str(banner_id).context("Banner id is invalid.")?;
    let expected = match kind {
        BannerFileKind::Image => banner_image_file_name(banner_id),
        BannerFileKind::Thumbnail => banner_thumbnail_file_name(banner_id),
    };
    if stored_name != expected {
        bail!("Banner file is outside the managed Banners directory.");
    }
    let root = match std::fs::symlink_metadata(root) {
        Ok(_) => validate_managed_banner_root(root)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).context("Managed Banners directory could not be inspected.");
        }
    };
    let path = root.join(&expected);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("Banner file could not be inspected."),
    };
    if !metadata.is_file() || metadata_is_symlink_or_reparse(&metadata) {
        bail!("Banner file is not a direct regular file.");
    }
    let canonical = std::fs::canonicalize(&path).context("Banner file could not be resolved.")?;
    if canonical.parent() != Some(root.as_path())
        || canonical.file_name() != Some(std::ffi::OsStr::new(&expected))
    {
        bail!("Banner file escaped the managed Banners directory.");
    }
    Ok(Some(canonical))
}

/// `banners.delete`: refuses a showing banner while a session runs (D9),
/// refuses paths outside the managed dir, then removes the row and, best
/// effort once SQLite is authoritative, both files.
pub(crate) fn delete_banner(database: &Database, id: &str, session_active: bool) -> Result<()> {
    let banner = database.banner_by_id(id)?;
    if banner.shown && session_active {
        bail!(REFUSAL_DELETE_SHOWN_IN_SESSION);
    }
    let root = database.banner_assets_dir();
    let image = managed_banner_file(&root, &banner.id, &banner.image_file, BannerFileKind::Image)?;
    let thumbnail = managed_banner_file(
        &root,
        &banner.id,
        &banner.thumbnail_file,
        BannerFileKind::Thumbnail,
    )?;
    database.delete_banner_row(id)?;
    for path in [image, thumbnail].into_iter().flatten() {
        if let Err(error) = std::fs::remove_file(&path) {
            tracing::warn!(
                path = %path.display(),
                "Could not remove deleted banner file after database commit: {error}"
            );
        }
    }
    Ok(())
}

// --- Update validation -------------------------------------------------------

/// A validated `banners.update`. `None` leaves a field alone; the timers are
/// `Some(None)` when `0` turned them off.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct BannerUpdate {
    pub name: Option<String>,
    pub horizontal: Option<OverlayRect>,
    pub vertical: Option<OverlayRect>,
    pub show_on_stream: Option<bool>,
    pub show_in_recording: Option<bool>,
    pub opacity: Option<f64>,
    pub hide_after_sec: Option<Option<u32>>,
    pub repeat_every_min: Option<Option<u32>>,
}

impl BannerUpdate {
    pub(crate) fn from_params(params: &UpdateBannerParams) -> Result<Self> {
        let name = params
            .name
            .as_deref()
            .map(normalize_banner_name)
            .transpose()?;
        if let Some(rect) = params.horizontal {
            validate_banner_rect(rect, OverlayOrientation::Horizontal)?;
        }
        if let Some(rect) = params.vertical {
            validate_banner_rect(rect, OverlayOrientation::Vertical)?;
        }
        if let Some(opacity) = params.opacity {
            validate_banner_opacity(opacity)?;
        }
        Ok(Self {
            name,
            horizontal: params.horizontal,
            vertical: params.vertical,
            show_on_stream: params.show_on_stream,
            show_in_recording: params.show_in_recording,
            opacity: params.opacity,
            hide_after_sec: params.hide_after_sec.map(timer_or_off),
            repeat_every_min: params.repeat_every_min.map(timer_or_off),
        })
    }
}

fn timer_or_off(value: u32) -> Option<u32> {
    (value > 0).then_some(value)
}

/// Trimmed, 1 to 40 characters.
pub(crate) fn normalize_banner_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    let length = trimmed.chars().count();
    if length == 0 || length > BANNER_NAME_MAX_CHARS {
        bail!("Banner name must be 1 to {BANNER_NAME_MAX_CHARS} characters.");
    }
    Ok(trimmed.to_string())
}

/// The overlay rect rules (finite, inside 0..1, sides at least 0.02), worded
/// for a banner place.
pub(crate) fn validate_banner_rect(
    rect: OverlayRect,
    orientation: OverlayOrientation,
) -> Result<()> {
    let label = orientation.label();
    let fields = [rect.x, rect.y, rect.w, rect.h];
    if fields.iter().any(|value| !value.is_finite()) {
        bail!("Banner {label} place must be finite.");
    }
    if rect.w < OVERLAY_RECT_MIN_SIZE - RECT_EPSILON
        || rect.h < OVERLAY_RECT_MIN_SIZE - RECT_EPSILON
    {
        bail!("Banner {label} place must be at least {OVERLAY_RECT_MIN_SIZE} wide and tall.");
    }
    if rect.x < -RECT_EPSILON
        || rect.y < -RECT_EPSILON
        || rect.x + rect.w > 1.0 + RECT_EPSILON
        || rect.y + rect.h > 1.0 + RECT_EPSILON
    {
        bail!("Banner {label} place must stay inside the canvas (0..1).");
    }
    Ok(())
}

pub(crate) fn validate_banner_opacity(opacity: f64) -> Result<()> {
    if !opacity.is_finite()
        || opacity < BANNER_OPACITY_MIN - RECT_EPSILON
        || opacity > BANNER_OPACITY_MAX + RECT_EPSILON
    {
        bail!("Banner opacity must be between 0.2 and 1.0.");
    }
    Ok(())
}

// --- Default places (plan 186 "Pinned numbers") ------------------------------

const LANDSCAPE_ASPECT: f64 = 16.0 / 9.0;
const PORTRAIT_ASPECT: f64 = 9.0 / 16.0;
/// Below the 22% portrait safe area.
const PORTRAIT_WIDE_BOTTOM: f64 = 0.78;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BannerShape {
    FullFrame,
    Wide,
    Tall,
    Badge,
}

fn banner_shape(width: u32, height: u32) -> BannerShape {
    let aspect = f64::from(width) / f64::from(height.max(1));
    if (aspect - LANDSCAPE_ASPECT).abs() <= 0.02 && width >= 1280 {
        BannerShape::FullFrame
    } else if aspect >= 2.5 {
        BannerShape::Wide
    } else if aspect <= 0.6 {
        BannerShape::Tall
    } else {
        BannerShape::Badge
    }
}

/// Where a freshly imported banner lands on each orientation, from its pixel
/// aspect `a = width / height`. Canvases are assumed 16:9 and 9:16; on a
/// canvas of aspect `C` a rect's sides are linked by `h = w × C / a`. Each
/// value is rounded to 6 decimals, then clamped to the overlay rules.
pub(crate) fn banner_default_places(width: u32, height: u32) -> (OverlayRect, OverlayRect) {
    let aspect = f64::from(width.max(1)) / f64::from(height.max(1));
    let portrait_span = 1.0 - 2.0 * PORTRAIT_SIDE_MARGIN;
    let (horizontal, vertical) = match banner_shape(width, height) {
        BannerShape::FullFrame => {
            let h = PORTRAIT_ASPECT / aspect;
            (
                OverlayRect::new(0.0, 0.0, 1.0, 1.0),
                OverlayRect::new(0.0, (1.0 - h) / 2.0, 1.0, h),
            )
        }
        BannerShape::Wide => {
            let w = 0.60;
            let h = w * LANDSCAPE_ASPECT / aspect;
            let vw = portrait_span;
            let vh = vw * PORTRAIT_ASPECT / aspect;
            (
                OverlayRect::new(0.20, 1.0 - LANDSCAPE_EDGE_MARGIN - h, w, h),
                OverlayRect::new(PORTRAIT_SIDE_MARGIN, PORTRAIT_WIDE_BOTTOM - vh, vw, vh),
            )
        }
        BannerShape::Tall => {
            let h = 0.70;
            let w = h * aspect / LANDSCAPE_ASPECT;
            let mut vh = 0.40;
            let mut vw = vh * aspect / PORTRAIT_ASPECT;
            if vw > portrait_span {
                vw = portrait_span;
                vh = vw * PORTRAIT_ASPECT / aspect;
            }
            (
                OverlayRect::new(1.0 - LANDSCAPE_SIDE_MARGIN - w, 0.15, w, h),
                OverlayRect::new(1.0 - PORTRAIT_SIDE_MARGIN - vw, 0.30, vw, vh),
            )
        }
        BannerShape::Badge => {
            let h = 0.20;
            let w = h * aspect / LANDSCAPE_ASPECT;
            let vw = 0.30 * aspect.min(1.0);
            let vh = vw * PORTRAIT_ASPECT / aspect;
            (
                OverlayRect::new(1.0 - LANDSCAPE_SIDE_MARGIN - w, LANDSCAPE_EDGE_MARGIN, w, h),
                OverlayRect::new(1.0 - PORTRAIT_SIDE_MARGIN - vw, PORTRAIT_TOP_MARGIN, vw, vh),
            )
        }
    };
    (rounded_clamped(horizontal), rounded_clamped(vertical))
}

fn rounded_clamped(rect: OverlayRect) -> OverlayRect {
    let w = round6(rect.w).clamp(OVERLAY_RECT_MIN_SIZE, 1.0);
    let h = round6(rect.h).clamp(OVERLAY_RECT_MIN_SIZE, 1.0);
    let x = round6(rect.x).clamp(0.0, round6(1.0 - w));
    let y = round6(rect.y).clamp(0.0, round6(1.0 - h));
    OverlayRect::new(x, y, w, h)
}

// --- Draw rect (plan 186 "Where the image lands inside its rect") -----------

/// Round half away from zero of `numerator / denominator`, both positive.
fn rounded_ratio(numerator: u64, denominator: u64) -> u64 {
    (2 * numerator + denominator) / (2 * denominator)
}

/// Where the image lands on a canvas: `(x, y, w, h)` in canvas pixels. The
/// image is contained in its rect (aspect kept, longer side fitted) and hugs
/// the rect edge its gravity picks. Shared by every render path and pinned
/// against the TS twin by `protocol-fixtures/banner-geometry.json`.
pub(crate) fn banner_draw_rect(
    image_width: u32,
    image_height: u32,
    canvas_width: usize,
    canvas_height: usize,
    rect: OverlayRect,
) -> (usize, usize, usize, usize) {
    let canvas_width = canvas_width.max(1);
    let canvas_height = canvas_height.max(1);
    let (left, top, right, bottom) = rect.pixels(canvas_width, canvas_height);
    let rect_width = (right - left).max(1);
    let rect_height = (bottom - top).max(1);
    let image_width = u64::from(image_width.max(1));
    let image_height = u64::from(image_height.max(1));
    let (draw_width, draw_height) = if image_width * rect_height as u64
        <= image_height * rect_width as u64
    {
        let width = rounded_ratio(image_width * rect_height as u64, image_height).max(1) as usize;
        (width.min(rect_width), rect_height)
    } else {
        let height = rounded_ratio(image_height * rect_width as u64, image_width).max(1) as usize;
        (rect_width, height.min(rect_height))
    };
    let x = match rect.horizontal_gravity() {
        OverlayHorizontalGravity::Left => left,
        OverlayHorizontalGravity::Center => left + (rect_width - draw_width) / 2,
        OverlayHorizontalGravity::Right => left + rect_width - draw_width,
    };
    let y = if rect.bottom_gravity() {
        top + rect_height - draw_height
    } else {
        top
    };
    (
        x.min(canvas_width.saturating_sub(draw_width)),
        y.min(canvas_height.saturating_sub(draw_height)),
        draw_width,
        draw_height,
    )
}

// --- The compositor's set (S3) ----------------------------------------------

/// How long a banner fades on Show and Hide (D10).
pub(crate) const BANNER_FADE: Duration = Duration::from_millis(200);

/// Ease-out cubic, `1 − (1 − t)³`: quick to appear, soft to settle.
fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

/// One banner's fade: `from` → `to` over `BANNER_FADE` from `started_at`. The
/// factor multiplies the layer's (pre-baked) opacity once per tick at the
/// snapshot, so the bitmap is never re-prepared for a fade.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct BannerFade {
    pub from: f32,
    pub to: f32,
    pub started_at: Instant,
}

impl BannerFade {
    /// A banner that just appeared: 0 → 1 from `now`.
    pub(crate) fn appearing_at(now: Instant) -> Self {
        Self {
            from: 0.0,
            to: 1.0,
            started_at: now,
        }
    }

    pub(crate) fn value_at(&self, now: Instant) -> f32 {
        let elapsed = now.saturating_duration_since(self.started_at).as_secs_f32();
        let t = (elapsed / BANNER_FADE.as_secs_f32()).clamp(0.0, 1.0);
        self.from + (self.to - self.from) * ease_out_cubic(t)
    }

    pub(crate) fn is_settled_at(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.started_at) >= BANNER_FADE
    }

    /// Whether this fade ends with the banner gone.
    pub(crate) fn hides(&self) -> bool {
        self.to <= 0.0
    }

    /// The fade toward `to`, reversed from the current value when the
    /// direction changes (Show mid-fade-out starts where the fade-out is, not
    /// from zero) and left alone when it already heads there.
    pub(crate) fn toward(&self, to: f32, now: Instant) -> Self {
        if self.to == to {
            return *self;
        }
        Self {
            from: self.value_at(now),
            to,
            started_at: now,
        }
    }
}

/// One banner as the compositor holds it: the row, where its stored image
/// is, which file revision the prepared bitmaps are keyed by, and its fade.
#[derive(Debug, Clone)]
pub(crate) struct BannerLayer {
    pub banner: Banner,
    pub image_path: Arc<Path>,
    pub file_revision: Option<BannerFileRevision>,
    pub fade: BannerFade,
}

/// A shown banner with its stored file inspected: the input of
/// `BannerSet::next_with_files`.
pub(crate) type BannerWithFile = (Banner, Arc<Path>, Option<BannerFileRevision>);

/// Join each shown banner onto the managed `Banners` root and stat its file
/// (cheap; done before any lock is taken).
pub(crate) fn banners_with_files(shown: Vec<Banner>, assets_root: &Path) -> Vec<BannerWithFile> {
    shown
        .into_iter()
        .map(|banner| {
            let image_path: Arc<Path> = Arc::from(assets_root.join(&banner.image_file));
            let file_revision = banner_file_revision(&image_path);
            (banner, image_path, file_revision)
        })
        .collect()
}

impl BannerLayer {
    /// The key-addressed Metal slot this banner draws from (namespace 9): a
    /// stable hash of its id, so a reorder or a fade never re-uploads.
    pub(crate) fn metal_slot(&self) -> u64 {
        banner_metal_slot(&self.banner.id)
    }
}

/// FNV-1a over the id: 64 bits is plenty for four banners.
pub(crate) fn banner_metal_slot(banner_id: &str) -> u64 {
    banner_id
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
}

/// The banners the picture carries, bottom to top (Assets order, D5). Swapped
/// as one `Arc` on `CompositorRuntime`; a hidden banner stays in the set until
/// its fade-out ends.
#[derive(Debug, Clone, Default)]
pub(crate) struct BannerSet {
    pub layers: Vec<BannerLayer>,
}

impl BannerSet {
    /// The set after a change: `shown` (bottom to top, files inspected by
    /// `banners_with_files`) is what the store says shows now. A banner
    /// already in the set keeps its fade (reversed when it was leaving); a
    /// new one fades in; one that left fades out from where it is; one whose
    /// fade-out already ended is dropped. Pure.
    pub(crate) fn next_with_files(&self, shown: Vec<BannerWithFile>, now: Instant) -> Self {
        let mut layers = shown
            .into_iter()
            .map(|(banner, image_path, file_revision)| {
                let fade = self
                    .layers
                    .iter()
                    .find(|layer| layer.banner.id == banner.id)
                    .map(|layer| layer.fade.toward(1.0, now))
                    .unwrap_or_else(|| BannerFade::appearing_at(now));
                BannerLayer {
                    banner,
                    image_path,
                    file_revision,
                    fade,
                }
            })
            .collect::<Vec<_>>();
        for layer in &self.layers {
            if layers.iter().any(|next| next.banner.id == layer.banner.id) {
                continue;
            }
            let fade = layer.fade.toward(0.0, now);
            if fade.hides() && fade.is_settled_at(now) {
                continue;
            }
            layers.push(BannerLayer {
                fade,
                ..layer.clone()
            });
        }
        layers.sort_by(|a, b| {
            a.banner
                .sort_order
                .cmp(&b.banner.sort_order)
                .then_with(|| a.banner.id.cmp(&b.banner.id))
        });
        Self { layers }
    }

    /// The set without the layers whose fade-out ended by `now`; `None` when
    /// nothing is due, so the caller keeps its `Arc`.
    pub(crate) fn without_faded_out(&self, now: Instant) -> Option<Self> {
        let keep = |layer: &BannerLayer| !(layer.fade.hides() && layer.fade.is_settled_at(now));
        if self.layers.iter().all(keep) {
            return None;
        }
        Some(Self {
            layers: self
                .layers
                .iter()
                .filter(|layer| keep(layer))
                .cloned()
                .collect(),
        })
    }
}

/// Which compositor leg a draw is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BannerLeg {
    Primary,
    Auxiliary,
}

/// Whether `leg` carries `banner` (plan 186 "Which leg carries a banner").
/// Idle (`shape` is `None`): the preview draws every banner with at least one
/// switch on. In a session: the overlay leg plan, with the shared-leg
/// fallback when the switches disagree on one shared leg, exactly as the
/// highlight card and the Buddy.
pub(crate) fn banner_leg_carries(
    shape: Option<OverlaySessionShape>,
    leg: BannerLeg,
    banner: &Banner,
) -> bool {
    let Some(shape) = shape else {
        return leg == BannerLeg::Primary && (banner.show_on_stream || banner.show_in_recording);
    };
    let plan = overlay_leg_plan(
        shape.record_enabled,
        shape.stream_enabled,
        shape.aux_leg,
        banner.show_on_stream,
        banner.show_in_recording,
    );
    let plan = if plan.needs_split {
        plan.shared_leg_fallback()
    } else {
        plan
    };
    match leg {
        BannerLeg::Primary => plan.primary,
        BannerLeg::Auxiliary => plan.aux,
    }
}

/// The stage id prefix the Scene editor's drafts use for a banner (pinned):
/// `banner:<bannerId>`.
pub(crate) const BANNER_DRAFT_ID_PREFIX: &str = "banner:";

/// The banner id a `scene.editor.draft.set` stage id names, if it is one.
pub(crate) fn banner_draft_id(source_id: &str) -> Option<&str> {
    source_id.strip_prefix(BANNER_DRAFT_ID_PREFIX)
}

/// The rect a leg draws `banner` in: its rect for the canvas orientation,
/// unless a live draft (`banner:<id>` plus a transform, idle preview only)
/// overrides it for this tick. The draft's transform is already the exact
/// image rect, so the contained draw lands on it.
pub(crate) fn banner_rect_for(
    banner: &Banner,
    orientation: OverlayOrientation,
    draft: Option<(&str, OverlayRect)>,
) -> OverlayRect {
    if let Some((source_id, rect)) = draft
        && banner_draft_id(source_id) == Some(banner.id.as_str())
    {
        return rect;
    }
    match orientation {
        OverlayOrientation::Horizontal => banner.horizontal,
        OverlayOrientation::Vertical => banner.vertical,
    }
}

/// The switches of every shown banner, for the D13 start notices
/// (`overlay_layout::overlay_start_notices_with_banners`).
pub(crate) fn shown_banner_switches(database: &Database) -> Result<Vec<OverlaySwitches>> {
    Ok(shown_banners_for_compositor(database)?
        .iter()
        .map(|banner| OverlaySwitches {
            show_on_stream: banner.show_on_stream,
            show_in_recording: banner.show_in_recording,
        })
        .collect())
}

/// `banners.show`: a session that cannot draw a banner added after its start
/// (`session_accepts_banners` is `Some(false)`; `None` when nothing runs), the
/// cap of four and the 160 MB prepared-bitmap budget for `canvases` (the
/// compositor's current primary and auxiliary canvases) are each refused with
/// their one sentence before the row changes. The store keeps the cap under
/// its own transaction too. Showing a banner that already shows is a no-op
/// and refuses nothing.
pub(crate) fn show_banner(
    database: &Database,
    id: &str,
    canvases: &[(u32, u32)],
    session_accepts_banners: Option<bool>,
) -> Result<Banner> {
    show_banner_within_budget(
        database,
        id,
        canvases,
        session_accepts_banners,
        BANNER_BITMAP_BUDGET_BYTES,
    )
}

pub(crate) fn show_banner_within_budget(
    database: &Database,
    id: &str,
    canvases: &[(u32, u32)],
    session_accepts_banners: Option<bool>,
    budget_bytes: u64,
) -> Result<Banner> {
    let candidate = database.banner_by_id(id)?;
    if !candidate.shown {
        if session_accepts_banners == Some(false) {
            bail!(REFUSAL_SESSION_CANNOT_ADD);
        }
        let shown = shown_banners_for_compositor(database)?;
        if shown.len() >= BANNER_MAX_SHOWN
            || show_exceeds_budget(&shown, &candidate, canvases, budget_bytes)
        {
            bail!(REFUSAL_FOUR_SHOWING);
        }
    }
    database.show_banner(id, BANNER_MAX_SHOWN)
}

// --- The seam to the compositor (S3) ----------------------------------------

/// The banners the compositor draws, bottom to top: showing, in Assets order.
/// `compositor::install_banner_set` reads this at backend start (shown
/// survives a relaunch, D3) and from `on_banners_changed`.
pub(crate) fn shown_banners_for_compositor(database: &Database) -> Result<Vec<Banner>> {
    let mut banners = database.list_banners()?;
    banners.retain(|banner| banner.shown);
    banners.sort_by_key(|banner| banner.sort_order);
    Ok(banners)
}

/// The one place every banner mutation ends (import, update, reorder, delete,
/// show, hide). The shown set is installed into the compositor first (the
/// next tick draws it; no scene commit, no capture change) and the legacy
/// FFmpeg overlay frame is recomposed when such a session runs (S4), then
/// the full list is republished as `banners.changed` under one lock so an
/// older snapshot is never emitted after a newer one.
pub(crate) async fn on_banners_changed(state: &AppState) -> Result<Vec<Banner>> {
    if let Err(error) = crate::compositor::install_banner_set(state).await {
        tracing::warn!("Could not install the banner set into the compositor: {error:#}");
    }
    if let Err(error) = crate::recording::apply_banners_to_legacy_overlay(state).await {
        tracing::warn!("Could not recompose the legacy overlay frame with the banners: {error:#}");
    }
    let banners = {
        let _publication = state
            .banner_list_publication
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let banners = state.database.list_banners()?;
        state.emit_event(BANNERS_CHANGED_EVENT, banners.clone());
        banners
    };
    // Plan 186 S10: "Hide after" and "Show every" follow every change,
    // however it was made.
    state.banner_timer_wake.notify_one();
    Ok(banners)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay_layout::PORTRAIT_BOTTOM_MARGIN;
    use serde::Deserialize;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("videorc-banners-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_database(dir: &Path) -> Database {
        Database::open_file_for_tests(&dir.join("videorc.sqlite3"))
    }

    fn png_bytes(image: &image::RgbaImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image.clone())
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    fn opaque_png(width: u32, height: u32) -> Vec<u8> {
        png_bytes(&image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([20, 120, 220, 255]),
        ))
    }

    fn write_png(dir: &Path, name: &str, width: u32, height: u32) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, opaque_png(width, height)).unwrap();
        path
    }

    fn jpeg_bytes(image: &image::RgbImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 100)
            .encode_image(image)
            .unwrap();
        bytes
    }

    /// A baseline JPEG with one EXIF APP1 segment carrying `orientation`.
    fn jpeg_with_exif_orientation(image: &image::RgbImage, orientation: u16) -> Vec<u8> {
        let jpeg = jpeg_bytes(image);
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II\x2a\x00");
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&0u16.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        let mut out = Vec::new();
        out.extend_from_slice(&jpeg[..2]);
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
        out.extend_from_slice(b"Exif\x00\x00");
        out.extend_from_slice(&tiff);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    fn webp_bytes(image: &image::RgbaImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
            .encode(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        bytes
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        let mut crc_input = kind.to_vec();
        crc_input.extend_from_slice(data);
        chunk.extend_from_slice(&crc32(&crc_input).to_be_bytes());
        chunk
    }

    /// A PNG header claiming `width × height` with an empty IDAT and no real
    /// pixel data: enough for `into_dimensions`, which is what the 40 MP gate
    /// reads before any decode.
    fn png_header_only(width: u32, height: u32) -> Vec<u8> {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&width.to_be_bytes());
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&png_chunk(b"IHDR", &ihdr));
        bytes.extend_from_slice(&png_chunk(b"IDAT", &[]));
        bytes.extend_from_slice(&png_chunk(b"IEND", &[]));
        bytes
    }

    fn animated_png() -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&32u32.to_be_bytes());
        ihdr.extend_from_slice(&32u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&png_chunk(b"IHDR", &ihdr));
        let mut actl = Vec::new();
        actl.extend_from_slice(&2u32.to_be_bytes());
        actl.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&png_chunk(b"acTL", &actl));
        bytes.extend_from_slice(&png_chunk(b"IEND", &[]));
        bytes
    }

    fn animated_webp() -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(b"WEBP");
        // VP8X: flags byte with the animation bit, three reserved bytes,
        // then 24-bit canvas width-1 and height-1.
        body.extend_from_slice(b"VP8X");
        body.extend_from_slice(&10u32.to_le_bytes());
        body.extend_from_slice(&[0x02, 0, 0, 0, 31, 0, 0, 31, 0, 0]);
        body.extend_from_slice(b"ANIM");
        body.extend_from_slice(&6u32.to_le_bytes());
        body.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&body);
        bytes
    }

    #[test]
    fn sniff_table_trusts_magic_bytes_not_extensions() {
        let square = image::RgbaImage::from_pixel(16, 16, image::Rgba([1, 2, 3, 255]));
        assert_eq!(
            sniff_banner_image(&png_bytes(&square)).unwrap(),
            BannerImageFormat::Png
        );
        let rgb = image::RgbImage::from_pixel(16, 16, image::Rgb([1, 2, 3]));
        assert_eq!(
            sniff_banner_image(&jpeg_bytes(&rgb)).unwrap(),
            BannerImageFormat::Jpeg
        );
        assert_eq!(
            sniff_banner_image(&webp_bytes(&square)).unwrap(),
            BannerImageFormat::WebP
        );
        // A text file renamed .png is sniffed, not trusted.
        let text = b"hello, this is not an image.png".to_vec();
        assert_eq!(
            sniff_banner_image(&text).unwrap_err().to_string(),
            REFUSAL_NOT_AN_IMAGE
        );
        assert_eq!(
            inspect_banner_image(&text).unwrap_err().to_string(),
            REFUSAL_NOT_AN_IMAGE
        );
        assert_eq!(
            inspect_banner_image(&animated_png())
                .unwrap_err()
                .to_string(),
            REFUSAL_ANIMATED
        );
        assert_eq!(
            inspect_banner_image(&animated_webp())
                .unwrap_err()
                .to_string(),
            REFUSAL_ANIMATED
        );
        assert!(!is_animated_banner_image(
            BannerImageFormat::Png,
            &png_bytes(&square)
        ));
        assert!(!is_animated_banner_image(
            BannerImageFormat::WebP,
            &webp_bytes(&square)
        ));
    }

    #[test]
    fn size_limits_refuse_25_mb_40_mp_and_a_side_under_16_px() {
        let mut oversized = PNG_SIGNATURE.to_vec();
        oversized.resize(BANNER_MAX_FILE_BYTES as usize + 1, 0);
        assert_eq!(
            inspect_banner_image(&oversized).unwrap_err().to_string(),
            REFUSAL_TOO_LARGE
        );
        // 8000 × 5001 = 40.008 MP, read from the header alone.
        assert_eq!(
            inspect_banner_image(&png_header_only(8000, 5001))
                .unwrap_err()
                .to_string(),
            REFUSAL_TOO_LARGE
        );
        let at_the_cap = inspect_banner_image(&png_header_only(8000, 5000)).unwrap();
        assert_eq!((at_the_cap.width, at_the_cap.height), (8000, 5000));
        assert_eq!(
            inspect_banner_image(&opaque_png(15, 64))
                .unwrap_err()
                .to_string(),
            REFUSAL_TOO_SMALL
        );
        assert_eq!(
            inspect_banner_image(&opaque_png(64, 15))
                .unwrap_err()
                .to_string(),
            REFUSAL_TOO_SMALL
        );
        assert!(inspect_banner_image(&opaque_png(16, 16)).is_ok());
        assert!(check_banner_dimensions(1, 40_000_000).is_err());
    }

    #[test]
    fn import_refuses_the_25th_banner() {
        let dir = temp_dir("cap");
        let database = test_database(&dir);
        let path = write_png(&dir, "logo.png", 16, 16);
        for _ in 0..BANNER_MAX_COUNT {
            import_banner(&database, &path).unwrap();
        }
        assert_eq!(database.count_banners().unwrap(), BANNER_MAX_COUNT);
        assert_eq!(
            import_banner(&database, &path).unwrap_err().to_string(),
            REFUSAL_TOO_MANY
        );
        assert_eq!(database.count_banners().unwrap(), BANNER_MAX_COUNT);
        // Nothing half published: exactly two files per banner remain.
        let files = std::fs::read_dir(database.banner_assets_dir())
            .unwrap()
            .count();
        assert_eq!(files, BANNER_MAX_COUNT * 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn import_applies_exif_rotation() {
        let dir = temp_dir("exif");
        let database = test_database(&dir);
        let mut source = image::RgbImage::from_pixel(16, 16, image::Rgb([0, 0, 255]));
        for y in 0..16 {
            for x in 0..8 {
                source.put_pixel(x, y, image::Rgb([255, 0, 0]));
            }
        }
        let mut wide = image::RgbImage::new(32, 16);
        for y in 0..16 {
            for x in 0..32 {
                let pixel = if x < 16 {
                    image::Rgb([255, 0, 0])
                } else {
                    image::Rgb([0, 0, 255])
                };
                wide.put_pixel(x, y, pixel);
            }
        }
        let path = dir.join("photo.jpg");
        std::fs::write(&path, jpeg_with_exif_orientation(&wide, 6)).unwrap();

        let banner = import_banner(&database, &path).unwrap();
        // Orientation 6 rotates 90° clockwise: 32×16 becomes 16×32 with the
        // red left half now the top half.
        assert_eq!((banner.width, banner.height), (16, 32));
        let stored = image::open(database.banner_assets_dir().join(&banner.image_file))
            .unwrap()
            .into_rgba8();
        assert_eq!(stored.dimensions(), (16, 32));
        let top = stored.get_pixel(8, 2);
        let bottom = stored.get_pixel(8, 29);
        assert!(top[0] > 200 && top[2] < 60, "top should be red: {top:?}");
        assert!(
            bottom[2] > 200 && bottom[0] < 60,
            "bottom should be blue: {bottom:?}"
        );
        assert!(!banner.has_alpha);
        assert_eq!(banner.name, "photo");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn import_keeps_alpha_and_a_half_transparent_red_pixel_survives() {
        let dir = temp_dir("alpha");
        let database = test_database(&dir);
        let mut source = image::RgbaImage::from_pixel(32, 32, image::Rgba([255, 255, 255, 255]));
        source.put_pixel(3, 4, image::Rgba([255, 0, 0, 128]));
        source.put_pixel(5, 6, image::Rgba([0, 0, 0, 0]));
        let path = dir.join("Follow me @handle.png");
        std::fs::write(&path, png_bytes(&source)).unwrap();

        let banner = import_banner(&database, &path).unwrap();
        assert!(banner.has_alpha);
        assert_eq!(banner.name, "Follow me @handle");
        assert_eq!(banner.image_file, format!("{}.png", banner.id));
        assert_eq!(banner.thumbnail_file, format!("{}.thumb.png", banner.id));
        assert!(!banner.shown);
        assert!(banner.show_on_stream);
        assert!(banner.show_in_recording);
        assert_eq!(banner.opacity, 1.0);
        assert_eq!(banner.hide_after_sec, None);
        assert_eq!(banner.repeat_every_min, None);
        let stored = image::open(database.banner_assets_dir().join(&banner.image_file))
            .unwrap()
            .into_rgba8();
        assert_eq!(*stored.get_pixel(3, 4), image::Rgba([255, 0, 0, 128]));
        assert_eq!(*stored.get_pixel(5, 6), image::Rgba([0, 0, 0, 0]));
        let thumbnail = image::open(database.banner_assets_dir().join(&banner.thumbnail_file))
            .unwrap()
            .into_rgba8();
        assert_eq!(thumbnail.dimensions(), (32, 32), "never upscaled");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stored_copy_is_capped_at_3840_and_thumbnails_at_480() {
        let wide = image::RgbaImage::from_pixel(7680, 400, image::Rgba([10, 20, 30, 255]));
        let fitted = fit_within(&wide, BANNER_MAX_STORED_SIDE);
        assert_eq!(fitted.dimensions(), (3840, 200));
        assert_eq!(*fitted.get_pixel(100, 100), image::Rgba([10, 20, 30, 255]));
        let full = image::RgbaImage::new(3840, 2160);
        assert_eq!(
            fit_within(&full, BANNER_MAX_STORED_SIDE).dimensions(),
            (3840, 2160)
        );
        let tall = image::RgbaImage::new(100, 9000);
        assert_eq!(
            fit_within(&tall, BANNER_MAX_STORED_SIDE).dimensions(),
            (43, 3840)
        );
        assert_eq!(
            fit_within(&wide, BANNER_THUMBNAIL_SIDE).dimensions(),
            (480, 25)
        );

        // Soft edges: a transparent neighbour must not darken a scaled pixel.
        let mut edge = image::RgbaImage::from_pixel(64, 64, image::Rgba([0, 0, 0, 0]));
        for y in 0..64 {
            for x in 0..32 {
                edge.put_pixel(x, y, image::Rgba([255, 200, 100, 255]));
            }
        }
        let scaled = fit_within(&edge, 16);
        for x in 0..16 {
            let pixel = scaled.get_pixel(x, 8);
            if pixel[3] > 0 {
                assert!(pixel[0] >= 250, "no halo at x={x}: {pixel:?}");
                assert!(pixel[1] >= 195, "no halo at x={x}: {pixel:?}");
            }
        }

        let dir = temp_dir("downscale");
        let database = test_database(&dir);
        let path = write_png(&dir, "strip.png", 4000, 100);
        let banner = import_banner(&database, &path).unwrap();
        assert_eq!((banner.width, banner.height), (3840, 96));
        let thumbnail =
            image::open(database.banner_assets_dir().join(&banner.thumbnail_file)).unwrap();
        assert_eq!(thumbnail.width(), 480);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn import_never_auto_shows_and_the_list_is_in_order() {
        let dir = temp_dir("order");
        let database = test_database(&dir);
        let first = import_banner(&database, &write_png(&dir, "a-sponsor.png", 240, 40)).unwrap();
        let second = import_banner(&database, &write_png(&dir, "b.png", 64, 64)).unwrap();
        assert_eq!(first.sort_order, 0);
        assert_eq!(second.sort_order, 1);
        let listed = database.list_banners().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, first.id);
        assert_eq!(listed[1].id, second.id);
        assert!(shown_banners_for_compositor(&database).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_names_are_trimmed_to_forty_characters() {
        assert_eq!(
            banner_name_from_path(Path::new("/x/  Sponsor strip  .png")),
            "Sponsor strip"
        );
        assert_eq!(banner_name_from_path(Path::new("/x/   .png")), "Banner");
        assert_eq!(banner_name_from_path(Path::new("")), "Banner");
        let long = "a".repeat(60);
        assert_eq!(
            banner_name_from_path(Path::new(&format!("/x/{long}.webp"))),
            "a".repeat(40)
        );
        assert_eq!(
            banner_name_from_path(Path::new("/x/ünïcödé.jpg")),
            "ünïcödé"
        );
    }

    #[test]
    fn default_places_follow_the_pinned_table() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .unwrap();
        let (horizontal, vertical) = banner_default_places(2400, 400);
        assert_eq!(
            serde_json::to_value(horizontal).unwrap(),
            fixture["banner"]["minimal"]["horizontal"],
            "wide horizontal drifted from the pinned fixture"
        );
        assert_eq!(
            serde_json::to_value(vertical).unwrap(),
            fixture["banner"]["minimal"]["vertical"],
            "wide vertical drifted from the pinned fixture"
        );
        // Wide: 60% wide, bottom centre, 4% margin; portrait bottom at 0.78.
        assert_eq!(horizontal, OverlayRect::new(0.2, 0.782222, 0.6, 0.177778));
        assert_eq!(
            vertical,
            OverlayRect::new(0.071111, 0.699583, 0.857778, 0.080417)
        );
        assert!((vertical.y + vertical.h - (1.0 - PORTRAIT_BOTTOM_MARGIN)).abs() < 1e-5);

        // Full frame: exactly 16:9 and at least 1280 wide.
        let (horizontal, vertical) = banner_default_places(3840, 2160);
        assert_eq!(horizontal, OverlayRect::new(0.0, 0.0, 1.0, 1.0));
        assert_eq!(vertical, OverlayRect::new(0.0, 0.341797, 1.0, 0.316406));
        // A small 16:9 image is a badge, not a full frame.
        let (small, _) = banner_default_places(1279, 720);
        assert_ne!(small, OverlayRect::new(0.0, 0.0, 1.0, 1.0));
        assert_eq!(small.h, 0.2);

        // Tall: 70% high on the right; 40% high on the portrait leg.
        let (horizontal, vertical) = banner_default_places(400, 1200);
        assert_eq!(horizontal.h, 0.7);
        assert_eq!(horizontal.y, 0.15);
        assert_eq!(horizontal.w, round6(0.7 * (400.0 / 1200.0) * 9.0 / 16.0));
        assert_eq!(
            horizontal.x,
            round6(1.0 - LANDSCAPE_SIDE_MARGIN - horizontal.w)
        );
        assert_eq!(vertical.h, 0.4);
        assert_eq!(vertical.y, 0.3);
        assert_eq!(vertical.w, round6(0.4 * (400.0 / 1200.0) * 16.0 / 9.0));
        assert_eq!(vertical.x, round6(1.0 - PORTRAIT_SIDE_MARGIN - vertical.w));
        // The widest tall image (0.6) still fits between the portrait side
        // margins at 40% high, so the shrink clause never bites in practice.
        let (_, vertical) = banner_default_places(600, 1000);
        assert_eq!(vertical.w, round6(0.4 * 0.6 * 16.0 / 9.0));
        assert_eq!(vertical.h, 0.4);
        assert!(vertical.x + vertical.w <= 1.0 - PORTRAIT_SIDE_MARGIN + 1e-6);

        // Badge: 20% high top right; 30% wide below the portrait safe top.
        let (horizontal, vertical) = banner_default_places(512, 512);
        assert_eq!(horizontal.h, 0.2);
        assert_eq!(horizontal.w, 0.1125);
        assert_eq!(horizontal.y, LANDSCAPE_EDGE_MARGIN);
        assert_eq!(horizontal.x, round6(1.0 - LANDSCAPE_SIDE_MARGIN - 0.1125));
        assert_eq!(vertical.w, 0.3);
        assert_eq!(vertical.h, round6(0.3 * 9.0 / 16.0));
        assert_eq!(vertical.y, PORTRAIT_TOP_MARGIN);
        assert_eq!(vertical.x, round6(1.0 - PORTRAIT_SIDE_MARGIN - 0.3));
        // A tall-ish badge (0.8) takes 30% of the height instead.
        let (_, vertical) = banner_default_places(800, 1000);
        assert_eq!(vertical.w, round6(0.3 * 0.8));

        // Every default place obeys the overlay rules on both orientations.
        for (width, height) in [
            (2400, 400),
            (3840, 2160),
            (1920, 1080),
            (400, 1200),
            (600, 1000),
            (512, 512),
            (800, 1000),
            (16, 16),
            (16, 3840),
            (3840, 16),
            (1279, 720),
        ] {
            let (horizontal, vertical) = banner_default_places(width, height);
            validate_banner_rect(horizontal, OverlayOrientation::Horizontal)
                .unwrap_or_else(|error| panic!("{width}x{height} horizontal: {error}"));
            validate_banner_rect(vertical, OverlayOrientation::Vertical)
                .unwrap_or_else(|error| panic!("{width}x{height} vertical: {error}"));
        }
    }

    #[derive(Deserialize)]
    struct GeometryFixture {
        cases: Vec<GeometryCase>,
    }

    #[derive(Deserialize)]
    struct GeometrySize {
        width: u32,
        height: u32,
    }

    #[derive(Deserialize)]
    struct GeometryExpected {
        x: usize,
        y: usize,
        w: usize,
        h: usize,
    }

    #[derive(Deserialize)]
    struct GeometryCase {
        name: String,
        image: GeometrySize,
        canvas: GeometrySize,
        rect: OverlayRect,
        expected: GeometryExpected,
    }

    #[test]
    fn draw_rect_reproduces_every_shared_geometry_fixture_case() {
        let fixture: GeometryFixture = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/banner-geometry.json"
        ))
        .expect("protocol-fixtures/banner-geometry.json is valid JSON");
        assert!(fixture.cases.len() >= 9);
        for case in fixture.cases {
            let actual = banner_draw_rect(
                case.image.width,
                case.image.height,
                case.canvas.width as usize,
                case.canvas.height as usize,
                case.rect,
            );
            assert_eq!(
                actual,
                (
                    case.expected.x,
                    case.expected.y,
                    case.expected.w,
                    case.expected.h
                ),
                "banner_draw_rect drifted from the fixture case {:?}",
                case.name
            );
        }
    }

    #[test]
    fn draw_rect_never_leaves_the_canvas() {
        // A rect pinned to the far corner with an image wider than the rect.
        let rect = OverlayRect::new(0.9, 0.9, 0.1, 0.1);
        let (x, y, w, h) = banner_draw_rect(1000, 10, 1920, 1080, rect);
        assert!(x + w <= 1920 && y + h <= 1080);
        assert_eq!((w, h), (192, 2));
        // Degenerate inputs stay finite.
        let (x, y, w, h) = banner_draw_rect(0, 0, 0, 0, OverlayRect::new(0.0, 0.0, 1.0, 1.0));
        assert_eq!((x, y, w, h), (0, 0, 1, 1));
    }

    #[test]
    fn wire_fixtures_round_trip_without_null_or_timer_keys_when_off() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .expect("shared high-risk protocol fixture must be valid JSON");
        const KEY_ORDER: [&str; 18] = [
            "id",
            "name",
            "imageFile",
            "thumbnailFile",
            "width",
            "height",
            "hasAlpha",
            "sortOrder",
            "shown",
            "horizontal",
            "vertical",
            "showOnStream",
            "showInRecording",
            "opacity",
            "hideAfterSec",
            "repeatEveryMin",
            "createdAt",
            "updatedAt",
        ];
        for (pointer, timers) in [("/banner/minimal", false), ("/banner/withTimer", true)] {
            let expected = fixture
                .pointer(pointer)
                .unwrap_or_else(|| panic!("shared protocol fixture is missing {pointer}"))
                .clone();
            let banner: Banner = serde_json::from_value(expected.clone()).unwrap();
            assert_eq!(banner.hide_after_sec, timers.then_some(30));
            assert_eq!(banner.repeat_every_min, timers.then_some(15));
            assert_eq!(
                serde_json::to_value(&banner).unwrap(),
                expected,
                "{pointer} drifted"
            );
            let text = serde_json::to_string(&banner).unwrap();
            assert!(!text.contains("null"), "{pointer}: {text}");
            let round_trip: Banner = serde_json::from_str(&text).unwrap();
            assert_eq!(round_trip, banner);
            // Byte-level shape: keys appear in the pinned order, and the
            // timer keys only when a timer is set.
            let mut cursor = 0;
            for key in KEY_ORDER {
                let token = format!("\"{key}\":");
                match text[cursor..].find(&token) {
                    Some(position) => cursor += position + token.len(),
                    None => assert!(
                        !timers && (key == "hideAfterSec" || key == "repeatEveryMin"),
                        "{pointer} is missing {key} or has it out of order: {text}"
                    ),
                }
            }
            if !timers {
                assert!(!text.contains("hideAfterSec"));
                assert!(!text.contains("repeatEveryMin"));
            }
        }
    }

    #[test]
    fn a_banner_with_no_timer_emits_no_null_and_no_timer_keys() {
        let (horizontal, vertical) = banner_default_places(512, 512);
        let banner = Banner {
            id: Uuid::new_v4().to_string(),
            name: "Logo".to_string(),
            image_file: "x.png".to_string(),
            thumbnail_file: "x.thumb.png".to_string(),
            width: 512,
            height: 512,
            has_alpha: false,
            sort_order: 3,
            shown: false,
            horizontal,
            vertical,
            show_on_stream: true,
            show_in_recording: true,
            opacity: 1.0,
            hide_after_sec: None,
            repeat_every_min: None,
            created_at: "2026-10-20T18:00:00Z".to_string(),
            updated_at: "2026-10-20T18:00:00Z".to_string(),
        };
        let value = serde_json::to_value(&banner).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 16);
        assert!(!object.contains_key("hideAfterSec"));
        assert!(!object.contains_key("repeatEveryMin"));
        assert!(object.values().all(|value| !value.is_null()));
    }

    #[test]
    fn update_validation_enforces_name_opacity_rects_and_timer_off() {
        let base = UpdateBannerParams {
            id: "b".to_string(),
            ..Default::default()
        };
        assert_eq!(
            BannerUpdate::from_params(&base).unwrap(),
            BannerUpdate::default()
        );

        let named = UpdateBannerParams {
            name: Some("  Sponsor  ".to_string()),
            ..base.clone()
        };
        assert_eq!(
            BannerUpdate::from_params(&named).unwrap().name.as_deref(),
            Some("Sponsor")
        );
        for bad in ["", "   ", &"x".repeat(41)] {
            let params = UpdateBannerParams {
                name: Some(bad.to_string()),
                ..base.clone()
            };
            assert!(BannerUpdate::from_params(&params).is_err(), "{bad:?}");
        }
        let forty = UpdateBannerParams {
            name: Some("é".repeat(40)),
            ..base.clone()
        };
        assert!(BannerUpdate::from_params(&forty).is_ok());

        for opacity in [0.2, 0.5, 1.0] {
            let params = UpdateBannerParams {
                opacity: Some(opacity),
                ..base.clone()
            };
            assert!(BannerUpdate::from_params(&params).is_ok(), "{opacity}");
        }
        for opacity in [0.19, 1.01, -1.0, f64::NAN, f64::INFINITY] {
            let params = UpdateBannerParams {
                opacity: Some(opacity),
                ..base.clone()
            };
            let error = BannerUpdate::from_params(&params).unwrap_err().to_string();
            assert_eq!(
                error, "Banner opacity must be between 0.2 and 1.0.",
                "{opacity}"
            );
        }

        for rect in [
            OverlayRect::new(0.0, 0.0, 0.01, 0.5),
            OverlayRect::new(0.5, 0.0, 0.6, 0.5),
            OverlayRect::new(-0.1, 0.0, 0.5, 0.5),
            OverlayRect::new(0.0, f64::NAN, 0.5, 0.5),
        ] {
            let params = UpdateBannerParams {
                horizontal: Some(rect),
                ..base.clone()
            };
            assert!(BannerUpdate::from_params(&params).is_err(), "{rect:?}");
            let params = UpdateBannerParams {
                vertical: Some(rect),
                ..base.clone()
            };
            assert!(BannerUpdate::from_params(&params).is_err(), "{rect:?}");
        }
        let full = UpdateBannerParams {
            horizontal: Some(OverlayRect::new(0.0, 0.0, 1.0, 1.0)),
            vertical: Some(OverlayRect::new(0.98, 0.98, 0.02, 0.02)),
            ..base.clone()
        };
        assert!(BannerUpdate::from_params(&full).is_ok());

        let timers = UpdateBannerParams {
            hide_after_sec: Some(0),
            repeat_every_min: Some(15),
            ..base.clone()
        };
        let update = BannerUpdate::from_params(&timers).unwrap();
        assert_eq!(update.hide_after_sec, Some(None));
        assert_eq!(update.repeat_every_min, Some(Some(15)));
    }

    #[test]
    fn storage_update_reorder_show_cap_and_hide_all() {
        let dir = temp_dir("rules");
        let database = test_database(&dir);
        let mut ids = Vec::new();
        for index in 0..5 {
            let banner = import_banner(
                &database,
                &write_png(&dir, &format!("b{index}.png"), 64, 64),
            )
            .unwrap();
            ids.push(banner.id);
        }

        let updated = database
            .update_banner(
                &ids[0],
                BannerUpdate {
                    name: Some("Sponsor".to_string()),
                    horizontal: Some(OverlayRect::new(0.1, 0.1, 0.3, 0.2)),
                    opacity: Some(0.5),
                    show_in_recording: Some(false),
                    hide_after_sec: Some(Some(30)),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.name, "Sponsor");
        assert_eq!(updated.horizontal, OverlayRect::new(0.1, 0.1, 0.3, 0.2));
        assert_eq!(updated.opacity, 0.5);
        assert!(!updated.show_in_recording);
        assert!(updated.show_on_stream);
        assert_eq!(updated.hide_after_sec, Some(30));
        let cleared = database
            .update_banner(
                &ids[0],
                BannerUpdate {
                    hide_after_sec: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.hide_after_sec, None);
        assert_eq!(cleared.name, "Sponsor", "other fields untouched");
        assert!(
            database
                .update_banner("missing", BannerUpdate::default())
                .is_err()
        );

        for id in &ids[..4] {
            assert!(database.show_banner(id, BANNER_MAX_SHOWN).unwrap().shown);
        }
        // Showing a banner that already shows is idempotent, not a fifth.
        assert!(
            database
                .show_banner(&ids[0], BANNER_MAX_SHOWN)
                .unwrap()
                .shown
        );
        assert_eq!(
            database
                .show_banner(&ids[4], BANNER_MAX_SHOWN)
                .unwrap_err()
                .to_string(),
            REFUSAL_FOUR_SHOWING
        );
        assert!(!database.hide_banner(&ids[1]).unwrap().shown);
        assert!(
            database
                .show_banner(&ids[4], BANNER_MAX_SHOWN)
                .unwrap()
                .shown
        );
        let shown = shown_banners_for_compositor(&database).unwrap();
        assert_eq!(
            shown
                .iter()
                .map(|banner| banner.id.as_str())
                .collect::<Vec<_>>(),
            [&ids[0], &ids[2], &ids[3], &ids[4]]
        );

        // Reorder is the drawing order: later is on top.
        let mut reversed = ids.clone();
        reversed.reverse();
        let reordered = database.reorder_banners(&reversed).unwrap();
        assert_eq!(reordered[0].id, ids[4]);
        assert_eq!(reordered[0].sort_order, 0);
        assert_eq!(reordered[4].id, ids[0]);
        let shown = shown_banners_for_compositor(&database).unwrap();
        assert_eq!(shown[0].id, ids[4]);
        assert!(database.reorder_banners(&ids[..3]).is_err());
        assert!(
            database
                .reorder_banners(&[
                    ids[0].clone(),
                    ids[0].clone(),
                    ids[1].clone(),
                    ids[2].clone(),
                    ids[3].clone()
                ])
                .is_err()
        );

        database.hide_all_banners().unwrap();
        assert!(shown_banners_for_compositor(&database).unwrap().is_empty());
        assert!(
            database
                .list_banners()
                .unwrap()
                .iter()
                .all(|banner| !banner.shown)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn shown_state_persists_across_a_reopen() {
        let dir = temp_dir("persist");
        let id = {
            let database = test_database(&dir);
            let banner = import_banner(&database, &write_png(&dir, "keep.png", 64, 64)).unwrap();
            database.show_banner(&banner.id, BANNER_MAX_SHOWN).unwrap();
            banner.id
        };
        let reopened = test_database(&dir);
        let shown = shown_banners_for_compositor(&reopened).unwrap();
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].id, id);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn delete_removes_row_and_both_files_and_refuses_a_shown_banner_in_session() {
        let dir = temp_dir("delete");
        let database = test_database(&dir);
        let banner = import_banner(&database, &write_png(&dir, "gone.png", 64, 64)).unwrap();
        let root = database.banner_assets_dir();
        let image = root.join(&banner.image_file);
        let thumbnail = root.join(&banner.thumbnail_file);
        assert!(image.exists() && thumbnail.exists());

        database.show_banner(&banner.id, BANNER_MAX_SHOWN).unwrap();
        assert_eq!(
            delete_banner(&database, &banner.id, true)
                .unwrap_err()
                .to_string(),
            REFUSAL_DELETE_SHOWN_IN_SESSION
        );
        assert_eq!(database.list_banners().unwrap().len(), 1);
        assert!(image.exists() && thumbnail.exists());

        // Hidden: deletable even during a session.
        database.hide_banner(&banner.id).unwrap();
        delete_banner(&database, &banner.id, true).unwrap();
        assert!(database.list_banners().unwrap().is_empty());
        assert!(!image.exists() && !thumbnail.exists());
        assert!(delete_banner(&database, &banner.id, false).is_err());

        // Shown but idle: deletable.
        let banner = import_banner(&database, &write_png(&dir, "idle.png", 64, 64)).unwrap();
        database.show_banner(&banner.id, BANNER_MAX_SHOWN).unwrap();
        delete_banner(&database, &banner.id, false).unwrap();
        assert!(database.list_banners().unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn delete_refuses_paths_outside_the_managed_directory() {
        let dir = temp_dir("guard");
        let database = test_database(&dir);
        let banner = import_banner(&database, &write_png(&dir, "safe.png", 64, 64)).unwrap();
        let root = database.banner_assets_dir();
        let id = banner.id.clone();

        // The pure guard: only the exact managed basename resolves.
        for forged in [
            "../escape.png",
            "/etc/passwd",
            "other.png",
            &format!("{id}.PNG"),
            &format!("{id}.thumb.png"),
            &format!("sub/{id}.png"),
        ] {
            assert!(
                managed_banner_file(&root, &id, forged, BannerFileKind::Image).is_err(),
                "{forged} must be refused"
            );
        }
        assert!(
            managed_banner_file(&root, "not-a-uuid", "not-a-uuid.png", BannerFileKind::Image)
                .is_err()
        );
        assert!(
            managed_banner_file(&root, &id, &banner.image_file, BannerFileKind::Image)
                .unwrap()
                .is_some()
        );
        assert!(
            managed_banner_file(
                &root,
                &id,
                &banner.thumbnail_file,
                BannerFileKind::Thumbnail
            )
            .unwrap()
            .is_some()
        );
        // A gone file is tolerated, not refused.
        let orphan = Uuid::new_v4().to_string();
        assert!(
            managed_banner_file(
                &root,
                &orphan,
                &format!("{orphan}.png"),
                BannerFileKind::Image
            )
            .unwrap()
            .is_none()
        );

        // A forged row never deletes anything: the escape target survives
        // and the row stays.
        let escape = dir.join("escape.png");
        std::fs::write(&escape, b"not yours").unwrap();
        {
            let conn = database.lock().unwrap();
            conn.execute(
                "UPDATE banners SET image_file = ?2 WHERE id = ?1",
                rusqlite::params![id, "../escape.png"],
            )
            .unwrap();
        }
        let error = delete_banner(&database, &id, false)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("outside the managed Banners directory"),
            "{error}"
        );
        assert!(escape.exists());
        assert_eq!(database.list_banners().unwrap().len(), 1);

        #[cfg(unix)]
        {
            // A symlink planted under the managed name is refused too.
            let link_id = Uuid::new_v4().to_string();
            let link = root.join(format!("{link_id}.png"));
            std::os::unix::fs::symlink(&escape, &link).unwrap();
            assert!(
                managed_banner_file(
                    &root,
                    &link_id,
                    &format!("{link_id}.png"),
                    BannerFileKind::Image
                )
                .is_err()
            );
            assert!(escape.exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    // --- The compositor's set (S3) ------------------------------------------

    fn sample_banner(id: &str, sort_order: i64) -> Banner {
        let (horizontal, vertical) = banner_default_places(2400, 400);
        Banner {
            id: id.to_string(),
            name: id.to_string(),
            image_file: format!("{id}.png"),
            thumbnail_file: format!("{id}.thumb.png"),
            width: 2400,
            height: 400,
            has_alpha: true,
            sort_order,
            shown: true,
            horizontal,
            vertical,
            show_on_stream: true,
            show_in_recording: true,
            opacity: 1.0,
            hide_after_sec: None,
            repeat_every_min: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn with_file(banner: Banner) -> BannerWithFile {
        let path: Arc<Path> = Arc::from(Path::new("/nonexistent").join(&banner.image_file));
        let revision = BannerFileRevision {
            size: 1,
            modified_nanos: 1,
        };
        (banner, path, Some(revision))
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn the_fade_is_200_ms_ease_out_and_reverses_from_where_it_is() {
        let t0 = Instant::now();
        let ms = |millis: u64| t0 + Duration::from_millis(millis);
        let fade = BannerFade::appearing_at(t0);
        // 0, 100 and 200 ms: 0, 1 - 0.5^3, 1.
        assert!(close(fade.value_at(ms(0)), 0.0));
        assert!(close(fade.value_at(ms(100)), 0.875));
        assert!(close(fade.value_at(ms(200)), 1.0));
        assert!(close(fade.value_at(ms(900)), 1.0));
        assert!(!fade.is_settled_at(ms(199)));
        assert!(fade.is_settled_at(ms(200)));
        assert!(!fade.hides());
        // Heading the same way leaves the fade alone.
        assert_eq!(fade.toward(1.0, ms(50)), fade);
        // Hide at 100 ms: a fade-out from 0.875, not from 1.
        let out = fade.toward(0.0, ms(100));
        assert!(out.hides());
        assert_eq!(out.started_at, ms(100));
        assert!(close(out.value_at(ms(100)), 0.875));
        assert!(close(out.value_at(ms(200)), 0.875 * (1.0 - 0.875)));
        assert!(close(out.value_at(ms(300)), 0.0));
        // Show again mid-fade-out: back up from the current value (D10).
        let back = out.toward(1.0, ms(200));
        assert!(close(back.from, 0.875 * 0.125));
        assert!(close(back.value_at(ms(400)), 1.0));
    }

    #[test]
    fn the_set_fades_banners_in_and_out_and_drops_them_once_gone() {
        let t0 = Instant::now();
        let ms = |millis: u64| t0 + Duration::from_millis(millis);
        let empty = BannerSet::default();
        // Show a and b (b first in Assets order): both appear from 0.
        let shown = empty.next_with_files(
            vec![
                with_file(sample_banner("b", 0)),
                with_file(sample_banner("a", 1)),
            ],
            ms(0),
        );
        let ids = |set: &BannerSet| {
            set.layers
                .iter()
                .map(|layer| layer.banner.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&shown), ["b", "a"]);
        assert!(
            shown
                .layers
                .iter()
                .all(|layer| layer.fade == BannerFade::appearing_at(ms(0)))
        );
        assert_eq!(shown.layers[0].metal_slot(), banner_metal_slot("b"));
        assert_ne!(shown.layers[0].metal_slot(), shown.layers[1].metal_slot());
        // Hide a at 100 ms: it stays, fading out from 0.875, in its place.
        let hiding = shown.next_with_files(vec![with_file(sample_banner("b", 0))], ms(100));
        assert_eq!(ids(&hiding), ["b", "a"]);
        assert_eq!(
            hiding.layers[0].fade,
            BannerFade::appearing_at(ms(0)),
            "b untouched"
        );
        let a = &hiding.layers[1];
        assert!(a.fade.hides());
        assert!(close(a.fade.from, 0.875));
        // The next tick keeps it until the fade-out ends, then drops it.
        assert!(hiding.without_faded_out(ms(250)).is_none());
        let dropped = hiding.without_faded_out(ms(300)).expect("a leaves the set");
        assert_eq!(ids(&dropped), ["b"]);
        // A mutation after the fade-out ended drops it too.
        assert_eq!(
            ids(&hiding.next_with_files(vec![with_file(sample_banner("b", 0))], ms(300))),
            ["b"]
        );
        // Show a again at 200 ms, mid-fade-out: it comes back from where it is.
        let back = hiding.next_with_files(
            vec![
                with_file(sample_banner("b", 0)),
                with_file(sample_banner("a", 1)),
            ],
            ms(200),
        );
        let a = &back.layers[1];
        assert!(!a.fade.hides());
        assert!(close(a.fade.from, 0.875 * 0.125));
        assert_eq!(a.fade.started_at, ms(200));
        // A reorder re-sorts (later draws on top) without touching fades.
        let reordered = back.next_with_files(
            vec![
                with_file(sample_banner("a", 0)),
                with_file(sample_banner("b", 1)),
            ],
            ms(250),
        );
        assert_eq!(ids(&reordered), ["a", "b"]);
        assert_eq!(reordered.layers[1].fade, BannerFade::appearing_at(ms(0)));
    }

    /// The leg plan per banner across the exhaustive session table: in a
    /// session exactly `overlay_leg_plan` with the shared-leg fallback (as
    /// the highlight card and the Buddy); idle, the primary draws every
    /// banner with a switch on and the auxiliary nothing.
    #[test]
    fn banner_leg_plan_follows_the_overlay_table_and_the_idle_rule() {
        use crate::overlay_layout::OverlayAuxLeg;
        let switches = [(false, false), (true, false), (false, true), (true, true)];
        for (on_stream, in_recording) in switches {
            let mut banner = sample_banner("a", 0);
            banner.show_on_stream = on_stream;
            banner.show_in_recording = in_recording;
            assert_eq!(
                banner_leg_carries(None, BannerLeg::Primary, &banner),
                on_stream || in_recording,
                "idle primary on_stream={on_stream} in_recording={in_recording}"
            );
            assert!(!banner_leg_carries(None, BannerLeg::Auxiliary, &banner));
            for record in [false, true] {
                for stream in [false, true] {
                    for aux_leg in [
                        OverlayAuxLeg::None,
                        OverlayAuxLeg::Stream,
                        OverlayAuxLeg::VerticalSimulcast,
                    ] {
                        let shape = OverlaySessionShape {
                            record_enabled: record,
                            stream_enabled: stream,
                            aux_leg,
                        };
                        let plan =
                            overlay_leg_plan(record, stream, aux_leg, on_stream, in_recording);
                        let expected = if plan.needs_split {
                            plan.shared_leg_fallback()
                        } else {
                            plan
                        };
                        assert_eq!(
                            (
                                banner_leg_carries(Some(shape), BannerLeg::Primary, &banner),
                                banner_leg_carries(Some(shape), BannerLeg::Auxiliary, &banner),
                            ),
                            (expected.primary, expected.aux),
                            "{shape:?} on_stream={on_stream} in_recording={in_recording}"
                        );
                    }
                }
            }
        }
        // The one row that falls back: record + stream on one shared leg with
        // the switches apart burns the shared leg and never asks for a split.
        let mut stream_only = sample_banner("a", 0);
        stream_only.show_in_recording = false;
        let shared = OverlaySessionShape {
            record_enabled: true,
            stream_enabled: true,
            aux_leg: OverlayAuxLeg::None,
        };
        assert!(banner_leg_carries(
            Some(shared),
            BannerLeg::Primary,
            &stream_only
        ));
        assert!(!banner_leg_carries(
            Some(shared),
            BannerLeg::Auxiliary,
            &stream_only
        ));
    }

    #[test]
    fn the_draw_rect_follows_the_orientation_unless_a_banner_draft_moves_it() {
        let banner = sample_banner("abc", 0);
        assert_eq!(
            banner_rect_for(&banner, OverlayOrientation::Horizontal, None),
            banner.horizontal
        );
        assert_eq!(
            banner_rect_for(&banner, OverlayOrientation::Vertical, None),
            banner.vertical
        );
        let dragged = OverlayRect::new(0.3, 0.4, 0.2, 0.1);
        assert_eq!(
            banner_rect_for(
                &banner,
                OverlayOrientation::Horizontal,
                Some(("banner:abc", dragged))
            ),
            dragged
        );
        // Another banner's draft, or a source draft, leaves it alone.
        assert_eq!(
            banner_rect_for(
                &banner,
                OverlayOrientation::Horizontal,
                Some(("banner:zzz", dragged))
            ),
            banner.horizontal
        );
        assert_eq!(
            banner_rect_for(
                &banner,
                OverlayOrientation::Horizontal,
                Some(("camera-1", dragged))
            ),
            banner.horizontal
        );
        assert_eq!(banner_draft_id("banner:abc"), Some("abc"));
        assert_eq!(banner_draft_id("camera-1"), None);
    }

    #[test]
    fn show_refuses_past_the_prepared_bitmap_budget_with_the_four_showing_sentence() {
        let dir = temp_dir("show-budget");
        let database = test_database(&dir);
        let first = import_banner(&database, &write_png(&dir, "one.png", 64, 64)).unwrap();
        let second = import_banner(&database, &write_png(&dir, "two.png", 64, 64)).unwrap();
        let canvases = [(3840_u32, 2160_u32), (1080, 1920)];
        // Under budget: shown.
        assert!(
            show_banner(&database, &first.id, &canvases, None)
                .unwrap()
                .shown
        );
        // A budget the first banner already fills refuses the second with the
        // verbatim sentence, and leaves the row hidden.
        let one_banner_bytes = crate::banner_prepare::estimated_prepared_bytes([&first], &canvases);
        let refused = show_banner_within_budget(
            &database,
            &second.id,
            &canvases,
            Some(true),
            one_banner_bytes,
        )
        .unwrap_err()
        .to_string();
        assert_eq!(refused, REFUSAL_FOUR_SHOWING);
        assert!(!database.banner_by_id(&second.id).unwrap().shown);
        // Showing a banner that already shows never re-checks the budget.
        assert!(
            show_banner_within_budget(&database, &first.id, &canvases, None, 0)
                .unwrap()
                .shown
        );
        // Without a compositor run there are no canvases and nothing to refuse.
        assert!(
            show_banner_within_budget(&database, &second.id, &[], None, 0)
                .unwrap()
                .shown
        );
        assert_eq!(shown_banners_for_compositor(&database).unwrap().len(), 2);
        // The switches the start notices read, in Assets order.
        assert_eq!(
            shown_banner_switches(&database).unwrap(),
            vec![
                OverlaySwitches {
                    show_on_stream: true,
                    show_in_recording: true
                };
                2
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Plan 186 S4: a session that cannot draw a banner added after its start
    /// (the legacy FFmpeg graph without its overlay FIFO, the Windows direct
    /// D3D11 recording) refuses a new Show with the verbatim sentence, before
    /// the cap and the budget; showing a banner that already shows stays a
    /// no-op there, and a session that draws the set refuses nothing.
    #[test]
    fn show_refuses_a_new_banner_on_a_session_that_cannot_add_one() {
        let dir = temp_dir("show-session");
        let database = test_database(&dir);
        let first = import_banner(&database, &write_png(&dir, "one.png", 64, 64)).unwrap();
        let second = import_banner(&database, &write_png(&dir, "two.png", 64, 64)).unwrap();
        assert!(
            show_banner(&database, &first.id, &[], Some(true))
                .unwrap()
                .shown
        );
        let refused = show_banner(&database, &second.id, &[], Some(false))
            .unwrap_err()
            .to_string();
        assert_eq!(
            refused,
            "This recording can't add banners after it starts. Show the banner before you press Record."
        );
        assert_eq!(refused, REFUSAL_SESSION_CANNOT_ADD);
        assert!(!database.banner_by_id(&second.id).unwrap().shown);
        // The session's refusal comes before the cap: nothing else is read.
        assert_eq!(shown_banners_for_compositor(&database).unwrap().len(), 1);
        // Already showing: a no-op, not a refusal.
        assert!(
            show_banner(&database, &first.id, &[], Some(false))
                .unwrap()
                .shown
        );
        // No session, or one that draws the set: shown.
        assert!(show_banner(&database, &second.id, &[], None).unwrap().shown);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
