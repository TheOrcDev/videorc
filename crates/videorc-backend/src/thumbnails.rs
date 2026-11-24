//! Plan 260 S1.5b: the image jobs Electron main ran with `nativeImage`, in the
//! backend: a scheduled livestream's thumbnail (fitted under YouTube's 2 MB
//! and stored by content hash) and an imported background with its small
//! Assets tile copy. Main keeps only the native picker; it hands the picked
//! path over its admin socket (or the renderer an `input-file` capability).

use std::fs::{self, OpenOptions};
use std::io::{Cursor, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Where main keeps scheduled thumbnails (`<userData>/scheduled-thumbnails`);
/// the same root `resource_authority` registers them under.
pub(crate) const SCHEDULED_THUMBNAIL_ROOT_ENV: &str = "VIDEORC_MANAGED_THUMBNAIL_ROOT";
/// The managed folder an imported background is copied into
/// (`<userData>/background-assets`); it must be one of the managed roots.
pub(crate) const BACKGROUND_IMPORT_DIR_ENV: &str = "VIDEORC_MANAGED_BACKGROUND_IMPORT_DIR";

/// A stored thumbnail never exceeds this; `scheduled_youtube` agrees.
const STORED_MAX_BYTES: usize = 2 * 1024 * 1024;
/// A picked source may be larger (YouTube accepts 50 MB); it is fitted down.
const SOURCE_MAX_BYTES: usize = 50 * 1024 * 1024;
const MAX_PIXELS: u64 = 20_000_000;
/// JPEG qualities tried, best first, until the fitted image is under 2 MB.
const FIT_QUALITIES: [u8; 3] = [90, 80, 70];
/// Plan 083: the fitted copy's long edge. Capping the long edge, not fitting
/// 1280 x 720, keeps a portrait image above YouTube's 640 px minimum width.
const FIT_LONG_EDGE: u32 = 1280;

/// Plan 174 C-40: wide enough for an Assets tile on a Retina display.
pub(crate) const BACKGROUND_THUMBNAIL_WIDTH: u32 = 480;
const BACKGROUND_THUMBNAIL_JPEG_QUALITY: u8 = 82;
const SUPPORTED_BACKGROUND_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportImageParams {
    /// Filled from `sourceCapability`, or sent raw by the admin role only.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledThumbnail {
    pub id: String,
    pub preview_url: String,
    pub width: u32,
    pub height: u32,
}

/// What main turns into the renderer's `BackgroundImportResult`: it owns the
/// `videorc-asset://` URLs and the asset's display name.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImport {
    pub id: String,
    pub asset_file_name: String,
    /// None when this image can't be decoded here: the tile reads the full
    /// file, as before.
    pub thumbnail_file_name: Option<String>,
}

pub(crate) fn configured_dir(env: &str) -> Result<PathBuf> {
    std::env::var_os(env)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .with_context(|| format!("{env} is not configured."))
}

fn read_capped(path: &Path, max_bytes: usize) -> Result<Vec<u8>> {
    let file = fs::File::open(path).context("Could not open the image.")?;
    let info = file.metadata()?;
    let too_large = || {
        anyhow::anyhow!(
            "Choose an image smaller than {} MB.",
            max_bytes / 1024 / 1024
        )
    };
    if !info.is_file() || info.len() > max_bytes as u64 {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    // One byte past the cap catches a file that grew after the stat.
    file.take(max_bytes as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(too_large());
    }
    Ok(bytes)
}

/// Format and pixel-count check from the header only, before any decode.
fn thumbnail_header_format(bytes: &[u8]) -> Result<ImageFormat> {
    let format = match image::guess_format(bytes) {
        Ok(format @ (ImageFormat::Png | ImageFormat::Jpeg)) => format,
        _ => bail!("Choose a JPEG or PNG image. The file contents must match the format."),
    };
    if format == ImageFormat::Png && bytes.windows(4).any(|part| part == b"acTL") {
        bail!("Animated thumbnails are not supported.");
    }
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .context("Corrupt or unsupported thumbnail image.")?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        bail!("Thumbnail exceeds 20 megapixels.");
    }
    Ok(format)
}

/// The fitted size: the long edge capped at `long_edge`, never enlarged.
pub(crate) fn fitted_size(width: u32, height: u32, long_edge: u32) -> (u32, u32) {
    let scale = (f64::from(long_edge) / f64::from(width.max(height))).min(1.0);
    scaled(width, height, scale)
}

fn scaled(width: u32, height: u32, scale: f64) -> (u32, u32) {
    (
        ((f64::from(width) * scale).round() as u32).max(1),
        ((f64::from(height) * scale).round() as u32).max(1),
    )
}

fn encode_jpeg(image: &DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode_image(&image.to_rgb8())?;
    Ok(bytes)
}

/// Fit an oversize source under 2 MB: a JPEG with a 1280 px long edge,
/// stepping quality down.
fn fit_thumbnail(source: &[u8], format: ImageFormat) -> Result<Vec<u8>> {
    let image = image::load_from_memory_with_format(source, format)
        .context("Corrupt or unsupported thumbnail image.")?;
    let (width, height) = fitted_size(image.width(), image.height(), FIT_LONG_EDGE);
    let fitted = if (width, height) == (image.width(), image.height()) {
        image
    } else {
        image.resize_exact(width, height, FilterType::Lanczos3)
    };
    for quality in FIT_QUALITIES {
        let bytes = encode_jpeg(&fitted, quality)?;
        if !bytes.is_empty() && bytes.len() <= STORED_MAX_BYTES {
            return Ok(bytes);
        }
    }
    bail!("This image could not be reduced to 2 MB. Choose a smaller one.")
}

/// Reads, checks and (over 2 MB) fits the picked image, then stores it as
/// `<sha256>.<png|jpg>` under `root`. At or under 2 MB the file is stored
/// byte-identical. Returns the thumbnail and its stored path for
/// registration.
pub fn import_scheduled_thumbnail(
    source_path: &Path,
    root: &Path,
) -> Result<(ScheduledThumbnail, PathBuf)> {
    let source = read_capped(source_path, SOURCE_MAX_BYTES)?;
    if source.is_empty() {
        bail!("Choose a thumbnail smaller than 2 MB.");
    }
    let format = thumbnail_header_format(&source)?;
    let bytes = if source.len() > STORED_MAX_BYTES {
        fit_thumbnail(&source, format)?
    } else {
        source
    };
    let mime = crate::scheduled_youtube::validate_thumbnail(&bytes)?;
    let extension = if mime == "image/png" { "png" } else { "jpg" };
    let stored_format = if extension == "png" {
        ImageFormat::Png
    } else {
        ImageFormat::Jpeg
    };
    let (width, height) =
        ImageReader::with_format(Cursor::new(&bytes), stored_format).into_dimensions()?;
    let id = format!("{:x}", Sha256::digest(&bytes));
    fs::create_dir_all(root)?;
    let path = root.join(format!("{id}.{extension}"));
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => file.write_all(&bytes)?,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            if read_capped(&path, STORED_MAX_BYTES)? != bytes {
                bail!("Managed thumbnail contents changed. Choose another image.");
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok((
        ScheduledThumbnail {
            preview_url: format!("videorc-asset://scheduled-thumbnail/{id}"),
            id,
            width,
            height,
        },
        path,
    ))
}

/// Every stored thumbnail under `root`, as `(asset id, path)`, for the
/// backend to register at startup (main's old `rehydrateScheduledThumbnails`).
pub fn stored_scheduled_thumbnails(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut stored: Vec<(String, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let path = entry.path();
            let extension = path.extension()?.to_str()?;
            if !matches!(extension, "png" | "jpg") {
                return None;
            }
            Some((path.file_stem()?.to_str()?.to_string(), path))
        })
        .collect();
    stored.sort();
    stored
}

fn background_extension(source_path: &Path) -> Option<String> {
    let extension = source_path.extension()?.to_str()?.to_ascii_lowercase();
    SUPPORTED_BACKGROUND_EXTENSIONS
        .contains(&extension.as_str())
        .then_some(extension)
}

/// The thumbnail's size: the image scaled to the width, never enlarged.
pub(crate) fn background_thumbnail_size(width: u32, height: u32) -> Option<(u32, u32)> {
    if width == 0 || height == 0 {
        return None;
    }
    let scale = (f64::from(BACKGROUND_THUMBNAIL_WIDTH) / f64::from(width)).min(1.0);
    Some(scaled(width, height, scale))
}

/// `<id>.thumb.png` for a PNG (it may carry transparency), `<id>.thumb.jpg`
/// otherwise. The second dot keeps it out of the managed-asset scans, which
/// read `<id>.<ext>` only.
pub(crate) fn background_thumbnail_file_name(id: &str, extension: &str) -> String {
    format!(
        "{id}.thumb.{}",
        if extension == "png" { "png" } else { "jpg" }
    )
}

fn write_background_thumbnail(
    asset_path: &Path,
    id: &str,
    extension: &str,
    directory: &Path,
) -> Result<String> {
    let image = ImageReader::open(asset_path)?
        .with_guessed_format()?
        .decode()?;
    let (width, height) = background_thumbnail_size(image.width(), image.height())
        .context("The background image is empty.")?;
    let resized = image.resize_exact(width, height, FilterType::Lanczos3);
    let file_name = background_thumbnail_file_name(id, extension);
    let bytes = if file_name.ends_with(".png") {
        let mut bytes = Vec::new();
        resized.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)?;
        bytes
    } else {
        encode_jpeg(&resized, BACKGROUND_THUMBNAIL_JPEG_QUALITY)?
    };
    fs::write(directory.join(&file_name), bytes)?;
    Ok(file_name)
}

/// Copies the picked image into the managed folder as `<uuid>.<ext>` (the
/// asset never references the streamer's original path) and writes its
/// ~480 px tile copy beside it.
pub fn import_background(source_path: &Path, directory: &Path) -> Result<BackgroundImport> {
    let Some(extension) = background_extension(source_path) else {
        bail!("Choose a PNG, JPEG or WebP image.");
    };
    if !source_path.is_file() {
        bail!("The background image is missing.");
    }
    let id = uuid::Uuid::new_v4().to_string();
    fs::create_dir_all(directory)?;
    let asset_file_name = format!("{id}.{extension}");
    let asset_path = directory.join(&asset_file_name);
    fs::copy(source_path, &asset_path).context("Could not copy the background image.")?;
    let thumbnail_file_name =
        match write_background_thumbnail(&asset_path, &id, &extension, directory) {
            Ok(file_name) => Some(file_name),
            Err(error) => {
                tracing::warn!(%error, "background thumbnail failed; the tile reads the full file");
                None
            }
        };
    Ok(BackgroundImport {
        id,
        asset_file_name,
        thumbnail_file_name,
    })
}

#[cfg(test)]
mod tests;
