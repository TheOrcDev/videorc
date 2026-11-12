//! HTML overlays (plan 231): a banner whose picture is a web page with a
//! transparent background. Electron main renders the page offscreen in a
//! sandbox and writes each frame down one loopback upload; this module owns
//! everything on the backend's side of that:
//!
//! - the import (an `.html` file or a folder with `index.html`, copied into
//!   the managed `Banners/<id>.overlay/` folder under its limits);
//! - the frame wire format, the premultiplied to straight alpha conversion
//!   and the latest-wins frame store the compositor's banner draw reads;
//! - the render targets main follows (which overlays, at what pixel size and
//!   rate) and the status the UI shows.
//!
//! Nothing here runs on the render thread: a tick reads one `Arc` per
//! overlay under a short mutex. Refusals are ordinary `anyhow` errors whose
//! message is the verbatim sentence from the plan; never wrap one in
//! `.context`.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::backend_authority::BackendRole;
use crate::banner_prepare::{BannerBitmap, next_bitmap_revision};
use crate::banners::{
    BANNER_MAX_COUNT, BANNER_THUMBNAIL_SIDE, NewBanner, REFUSAL_TOO_MANY, banner_default_places,
    banner_draw_rect, banner_image_file_name, banner_name_from_path, banner_thumbnail_file_name,
    encode_png, fit_within, image_has_alpha, validate_managed_banner_root, write_file_atomically,
};
use crate::overlay_layout::OverlayOrientation;
use crate::protocol::{
    Banner, BannerKind, HtmlOverlayHostState, HtmlOverlayState, HtmlOverlayStatus,
    HtmlOverlayStatuses, HtmlOverlayTarget, HtmlOverlayTargets,
};
use crate::state::AppState;
use crate::storage::{Database, metadata_is_symlink_or_reparse};

pub(crate) const HTML_OVERLAY_TARGETS_EVENT: &str = "htmlOverlays.targets";
pub(crate) const HTML_OVERLAY_STATUS_EVENT: &str = "htmlOverlays.status";

// --- Limits (D2, D3, D7) -----------------------------------------------------

/// The page a folder must have at its top, and the name a single imported
/// file is stored under.
pub(crate) const HTML_OVERLAY_ENTRY_FILE: &str = "index.html";
/// Every file of one overlay together.
pub(crate) const HTML_OVERLAY_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const HTML_OVERLAY_MAX_FILES: usize = 512;
/// Folders below the overlay's own folder.
pub(crate) const HTML_OVERLAY_MAX_DEPTH: usize = 8;
pub(crate) const HTML_OVERLAY_MAX_ENTRY_BYTES: u64 = 5 * 1024 * 1024;
/// The page size without a `videorc-overlay-size` meta tag (D3).
pub(crate) const HTML_OVERLAY_DEFAULT_PAGE: (u32, u32) = (1920, 1080);
pub(crate) const HTML_OVERLAY_PAGE_MIN_SIDE: u32 = 16;
pub(crate) const HTML_OVERLAY_PAGE_MAX_SIDE: u32 = 3840;
/// The largest frame main may send (D7): a 1080p frame.
pub(crate) const HTML_OVERLAY_MAX_FRAME_PIXELS: u64 = 1920 * 1080;
/// The highest rate an overlay renders at (D7).
pub(crate) const HTML_OVERLAY_MAX_FPS: u32 = 30;
/// How much of the entry page is searched for the size meta tag.
const SIZE_META_SEARCH_BYTES: usize = 64 * 1024;
/// How long after its first frame an overlay's own picture is saved as the
/// banner's stored image and thumbnail (D10).
const PICTURE_AFTER: Duration = Duration::from_secs(1);

// --- Refusals (verbatim, plan 231 "Refusals") --------------------------------

pub(crate) const REFUSAL_UNSUPPORTED: &str = "HTML banners work on macOS only for now.";
pub(crate) const REFUSAL_NOT_HTML: &str =
    "This isn't an HTML file. Choose an .html file or a folder with index.html.";
pub(crate) const REFUSAL_NO_INDEX: &str = "This folder has no index.html.";
pub(crate) const REFUSAL_TOO_LARGE: &str =
    "This HTML banner is too large. Use one under 64 MB and 512 files.";
pub(crate) const REFUSAL_LINK: &str =
    "This HTML banner has a link to a file outside its folder. Copy the file in.";
pub(crate) const REFUSAL_SESSION_CANNOT_DRAW: &str =
    "HTML banners can't join this recording. Hide it, or record at 30 fps.";

/// D9: the platforms whose compositor draws an HTML overlay in this slice.
pub(crate) fn html_overlays_supported() -> bool {
    cfg!(target_os = "macos")
}

// --- Import ------------------------------------------------------------------

/// The folder one overlay lives in, inside the managed `Banners` folder.
pub(crate) fn html_overlay_dir_name(id: &str) -> String {
    format!("{id}.overlay")
}

/// One file of an overlay: where it is and where it lands in the copy.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OverlayFile {
    source: PathBuf,
    relative: PathBuf,
    bytes: u64,
}

/// What an import found: the files to copy, the page size and the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HtmlOverlaySource {
    files: Vec<OverlayFile>,
    pub page: (u32, u32),
    pub name: String,
}

impl HtmlOverlaySource {
    #[cfg(test)]
    fn relative_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self
            .files
            .iter()
            .map(|file| file.relative.to_string_lossy().replace('\\', "/"))
            .collect();
        paths.sort();
        paths
    }
}

fn is_html_file_name(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

/// Dot files and dot folders (`.DS_Store`, `.git`) are never part of an
/// overlay: they are left out, not refused.
fn is_hidden_name(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|name| name.starts_with('.'))
}

/// Look at what the streamer picked without copying anything: a `.html` or
/// `.htm` file (imported alone), or a folder with `index.html` at its top
/// (imported whole). Every limit in D2 is checked here.
pub(crate) fn inspect_html_overlay_source(source: &Path) -> Result<HtmlOverlaySource> {
    let metadata = std::fs::symlink_metadata(source)
        .with_context(|| format!("Could not read {}", source.display()))?;
    if metadata_is_symlink_or_reparse(&metadata) {
        bail!(REFUSAL_LINK);
    }
    let name = banner_name_from_path(source);
    if metadata.is_file() {
        if !is_html_file_name(source) {
            bail!(REFUSAL_NOT_HTML);
        }
        if metadata.len() > HTML_OVERLAY_MAX_ENTRY_BYTES {
            bail!(REFUSAL_TOO_LARGE);
        }
        let page = read_page_size(source)?;
        return Ok(HtmlOverlaySource {
            files: vec![OverlayFile {
                source: source.to_path_buf(),
                relative: PathBuf::from(HTML_OVERLAY_ENTRY_FILE),
                bytes: metadata.len(),
            }],
            page,
            name,
        });
    }
    if !metadata.is_dir() {
        bail!(REFUSAL_NOT_HTML);
    }
    let entry = source.join(HTML_OVERLAY_ENTRY_FILE);
    match std::fs::symlink_metadata(&entry) {
        Ok(entry_metadata) if metadata_is_symlink_or_reparse(&entry_metadata) => {
            bail!(REFUSAL_LINK)
        }
        Ok(entry_metadata) if entry_metadata.is_file() => {
            if entry_metadata.len() > HTML_OVERLAY_MAX_ENTRY_BYTES {
                bail!(REFUSAL_TOO_LARGE);
            }
        }
        _ => bail!(REFUSAL_NO_INDEX),
    }

    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    // (folder, its path relative to the overlay, depth below the overlay).
    let mut pending = vec![(source.to_path_buf(), PathBuf::new(), 0_usize)];
    while let Some((folder, relative, depth)) = pending.pop() {
        let entries = std::fs::read_dir(&folder)
            .with_context(|| format!("Could not read {}", folder.display()))?;
        for entry in entries {
            let entry = entry.with_context(|| format!("Could not read {}", folder.display()))?;
            let file_name = entry.file_name();
            if is_hidden_name(&file_name) {
                continue;
            }
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path)
                .with_context(|| format!("Could not read {}", path.display()))?;
            if metadata_is_symlink_or_reparse(&metadata) {
                bail!(REFUSAL_LINK);
            }
            let relative_path = relative.join(&file_name);
            if metadata.is_dir() {
                if depth + 1 > HTML_OVERLAY_MAX_DEPTH {
                    bail!(REFUSAL_TOO_LARGE);
                }
                pending.push((path, relative_path, depth + 1));
            } else if metadata.is_file() {
                total_bytes = total_bytes.saturating_add(metadata.len());
                if files.len() >= HTML_OVERLAY_MAX_FILES || total_bytes > HTML_OVERLAY_MAX_BYTES {
                    bail!(REFUSAL_TOO_LARGE);
                }
                files.push(OverlayFile {
                    source: path,
                    relative: relative_path,
                    bytes: metadata.len(),
                });
            }
            // Sockets, devices and pipes are not part of a web page.
        }
    }
    let page = read_page_size(&entry)?;
    Ok(HtmlOverlaySource { files, page, name })
}

fn read_page_size(entry: &Path) -> Result<(u32, u32)> {
    let file = std::fs::File::open(entry)
        .with_context(|| format!("Could not open {}", entry.display()))?;
    let mut head = Vec::new();
    file.take(SIZE_META_SEARCH_BYTES as u64)
        .read_to_end(&mut head)
        .with_context(|| format!("Could not read {}", entry.display()))?;
    Ok(parse_overlay_size_meta(&String::from_utf8_lossy(&head))
        .unwrap_or(HTML_OVERLAY_DEFAULT_PAGE))
}

/// D3: `<meta name="videorc-overlay-size" content="640x360">`. Attribute
/// order, quotes and letter case do not matter; the separator is `x`, `×` or
/// a comma. A size outside 16 to 3840 px a side is ignored, so the page gets
/// the default. Pure.
pub(crate) fn parse_overlay_size_meta(html: &str) -> Option<(u32, u32)> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<meta") {
        let start = from + found;
        let end = lower[start..]
            .find('>')
            .map_or(lower.len(), |offset| start + offset);
        let tag = &lower[start..end];
        from = end;
        if !tag.contains("videorc-overlay-size") {
            continue;
        }
        let Some(value) = attribute_value(tag, "content") else {
            continue;
        };
        let mut sides = value
            .split(['x', '×', ','])
            .map(|side| side.trim().parse::<u32>().ok());
        let (Some(Some(width)), Some(Some(height)), None) =
            (sides.next(), sides.next(), sides.next())
        else {
            continue;
        };
        let allowed = HTML_OVERLAY_PAGE_MIN_SIDE..=HTML_OVERLAY_PAGE_MAX_SIDE;
        if allowed.contains(&width) && allowed.contains(&height) {
            return Some((width, height));
        }
    }
    None
}

/// The value of `name=` in a (lower-cased) tag: quoted, or up to the next
/// space.
fn attribute_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(found) = tag[from..].find(name) {
        let at = from + found;
        from = at + name.len();
        // A real attribute name starts after a space, not inside a word.
        if at > 0 && !tag.as_bytes()[at - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = tag[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let rest = rest.trim_start();
        return Some(match rest.chars().next()? {
            quote @ ('"' | '\'') => {
                let inner = &rest[1..];
                &inner[..inner.find(quote)?]
            }
            _ => rest
                .split(|character: char| character.is_ascii_whitespace() || character == '/')
                .next()?,
        });
    }
    None
}

/// Copy `files` under `destination` (which must not exist). Each file is
/// checked again right before it is read: a link swapped in after the
/// inspection is refused, and a file that grew is cut off at the budget.
fn copy_overlay_files(files: &[OverlayFile], destination: &Path) -> Result<()> {
    std::fs::create_dir(destination)
        .with_context(|| format!("Could not create {}", destination.display()))?;
    let mut budget = HTML_OVERLAY_MAX_BYTES;
    for file in files {
        if file
            .relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            bail!(REFUSAL_LINK);
        }
        let metadata = std::fs::symlink_metadata(&file.source)
            .with_context(|| format!("Could not read {}", file.source.display()))?;
        if metadata_is_symlink_or_reparse(&metadata) || !metadata.is_file() {
            bail!(REFUSAL_LINK);
        }
        let target = destination.join(&file.relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Could not create {}", parent.display()))?;
        }
        let source = std::fs::File::open(&file.source)
            .with_context(|| format!("Could not open {}", file.source.display()))?;
        let mut output = std::fs::File::create(&target)
            .with_context(|| format!("Could not create {}", target.display()))?;
        let copied = std::io::copy(&mut source.take(budget + 1), &mut output)
            .with_context(|| format!("Could not copy {}", file.source.display()))?;
        if copied > budget {
            bail!(REFUSAL_TOO_LARGE);
        }
        budget -= copied;
    }
    Ok(())
}

/// The whole import, blocking: run it on the AssetImport lane through
/// `spawn_blocking`. Nothing is published half done: the files land in a
/// staging folder, the folder is renamed, the row is inserted last, and
/// everything is removed if any step fails.
pub(crate) fn import_html_overlay(database: &Database, source: &Path) -> Result<Banner> {
    if !html_overlays_supported() {
        bail!(REFUSAL_UNSUPPORTED);
    }
    import_html_overlay_unchecked(database, source)
}

/// `import_html_overlay` without the platform refusal (the store tests run
/// everywhere).
pub(crate) fn import_html_overlay_unchecked(database: &Database, source: &Path) -> Result<Banner> {
    let inspected = inspect_html_overlay_source(source)?;
    if database.count_banners()? >= BANNER_MAX_COUNT {
        bail!(REFUSAL_TOO_MANY);
    }
    let id = Uuid::new_v4().to_string();
    let root = database.banner_assets_dir();
    std::fs::create_dir_all(&root)
        .with_context(|| format!("Could not create {}", root.display()))?;
    let root = validate_managed_banner_root(&root)?;
    let staging = root.join(format!(".{id}.staging"));
    let destination = root.join(html_overlay_dir_name(&id));
    let (width, height) = inspected.page;
    let (horizontal, vertical) = banner_default_places(width, height);
    let published = (|| -> Result<Banner> {
        copy_overlay_files(&inspected.files, &staging)?;
        std::fs::rename(&staging, &destination)
            .with_context(|| format!("Could not publish {}", destination.display()))?;
        database.insert_banner(
            NewBanner {
                id: id.clone(),
                name: inspected.name.clone(),
                kind: BannerKind::Html,
                width,
                height,
                // A page is see-through wherever it draws nothing.
                has_alpha: true,
                horizontal,
                vertical,
            },
            BANNER_MAX_COUNT,
        )
    })();
    if published.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::remove_dir_all(&destination);
    }
    published
}

/// The delete path guard for an overlay's folder: exactly `<id>.overlay`
/// inside the canonical managed root, a real folder and never a link.
/// `Ok(None)` means it is already gone.
pub(crate) fn managed_html_overlay_dir(root: &Path, banner_id: &str) -> Result<Option<PathBuf>> {
    Uuid::parse_str(banner_id).context("Banner id is invalid.")?;
    let root = match std::fs::symlink_metadata(root) {
        Ok(_) => validate_managed_banner_root(root)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).context("Managed Banners directory could not be inspected.");
        }
    };
    let name = html_overlay_dir_name(banner_id);
    let path = root.join(&name);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("Overlay folder could not be inspected."),
    };
    if !metadata.is_dir() || metadata_is_symlink_or_reparse(&metadata) {
        bail!("Overlay folder is not a direct regular directory.");
    }
    let canonical =
        std::fs::canonicalize(&path).context("Overlay folder could not be resolved.")?;
    if canonical.parent() != Some(root.as_path())
        || canonical.file_name() != Some(std::ffi::OsStr::new(&name))
    {
        bail!("Overlay folder escaped the managed Banners directory.");
    }
    Ok(Some(canonical))
}

// --- Frames: the wire --------------------------------------------------------

pub(crate) const FRAME_MAGIC: [u8; 4] = *b"VHOF";
pub(crate) const FRAME_VERSION: u8 = 1;
/// magic 4, version 1, flags 1, reserved 2, id 16, width 4, height 4,
/// sequence 8.
pub(crate) const FRAME_HEADER_BYTES: usize = 40;
/// A header naming a side past this is not ours: the upload ends.
const FRAME_MAX_SIDE: u32 = 3840;

/// One frame's header on the upload (little endian). Pinned against main's
/// encoder by `protocol-fixtures/html-overlay-frame.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrameHeader {
    pub id: Uuid,
    pub width: u32,
    pub height: u32,
    pub sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum FrameError {
    #[error("frame record does not start with VHOF")]
    Magic,
    #[error("frame record version is not supported")]
    Version,
    #[error("frame record size is out of range")]
    Size,
}

impl FrameHeader {
    pub(crate) fn parse(bytes: &[u8; FRAME_HEADER_BYTES]) -> Result<Self, FrameError> {
        if bytes[0..4] != FRAME_MAGIC {
            return Err(FrameError::Magic);
        }
        if bytes[4] != FRAME_VERSION {
            return Err(FrameError::Version);
        }
        let word = |at: usize| {
            u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
        };
        let (width, height) = (word(24), word(28));
        if width == 0 || height == 0 || width > FRAME_MAX_SIDE || height > FRAME_MAX_SIDE {
            return Err(FrameError::Size);
        }
        let mut id = [0_u8; 16];
        id.copy_from_slice(&bytes[8..24]);
        let mut sequence = [0_u8; 8];
        sequence.copy_from_slice(&bytes[32..40]);
        Ok(Self {
            id: Uuid::from_bytes(id),
            width,
            height,
            sequence: u64::from_le_bytes(sequence),
        })
    }

    #[cfg(test)]
    pub(crate) fn encode(&self) -> [u8; FRAME_HEADER_BYTES] {
        let mut bytes = [0_u8; FRAME_HEADER_BYTES];
        bytes[0..4].copy_from_slice(&FRAME_MAGIC);
        bytes[4] = FRAME_VERSION;
        bytes[8..24].copy_from_slice(self.id.as_bytes());
        bytes[24..28].copy_from_slice(&self.width.to_le_bytes());
        bytes[28..32].copy_from_slice(&self.height.to_le_bytes());
        bytes[32..40].copy_from_slice(&self.sequence.to_le_bytes());
        bytes
    }

    pub(crate) fn payload_bytes(&self) -> usize {
        self.width as usize * self.height as usize * 4
    }
}

#[inline]
fn straight_channel(premultiplied: u8, alpha: u8) -> u8 {
    ((u32::from(premultiplied) * 255 + u32::from(alpha) / 2) / u32::from(alpha)).min(255) as u8
}

/// Append `premultiplied` (whole BGRA pixels, alpha last) to `straight` as
/// straight alpha: what the banner layer blends. Opaque and empty runs, most
/// of any overlay, are copied or zeroed sixteen pixels at a time. Pure.
pub(crate) fn append_straight_alpha(straight: &mut Vec<u8>, premultiplied: &[u8]) {
    const BLOCK: usize = 64;
    debug_assert!(premultiplied.len().is_multiple_of(4));
    let start = straight.len();
    straight.resize(start + premultiplied.len(), 0);
    let output = &mut straight[start..];
    let mut blocks_out = output.chunks_exact_mut(BLOCK);
    let mut blocks_in = premultiplied.chunks_exact(BLOCK);
    for (block_out, block_in) in (&mut blocks_out).zip(&mut blocks_in) {
        let mut all_opaque = true;
        let mut all_empty = true;
        for pixel in block_in.chunks_exact(4) {
            all_opaque &= pixel[3] == 255;
            all_empty &= pixel[3] == 0;
        }
        if all_opaque {
            block_out.copy_from_slice(block_in);
        } else if !all_empty {
            straight_pixels(block_out, block_in);
        }
        // An empty block stays the zeros `resize` wrote.
    }
    straight_pixels(blocks_out.into_remainder(), blocks_in.remainder());
}

fn straight_pixels(output: &mut [u8], premultiplied: &[u8]) {
    for (out, pixel) in output
        .chunks_exact_mut(4)
        .zip(premultiplied.chunks_exact(4))
    {
        match pixel[3] {
            255 => out.copy_from_slice(pixel),
            0 => out.fill(0),
            alpha => {
                out[0] = straight_channel(pixel[0], alpha);
                out[1] = straight_channel(pixel[1], alpha);
                out[2] = straight_channel(pixel[2], alpha);
                out[3] = alpha;
            }
        }
    }
}

struct InFlightFrame {
    header: FrameHeader,
    remaining: usize,
    /// `None`: the frame is read and thrown away (not showing, over the cap).
    pixels: Option<Vec<u8>>,
    /// The bytes of a pixel a chunk boundary split.
    carry: [u8; 4],
    carry_len: usize,
}

/// Turns the upload's chunks back into frames. A chunk may end anywhere: in
/// a header, between two pixels or inside one.
pub(crate) struct FrameAssembler {
    header: [u8; FRAME_HEADER_BYTES],
    header_len: usize,
    current: Option<InFlightFrame>,
}

impl Default for FrameAssembler {
    fn default() -> Self {
        Self {
            header: [0; FRAME_HEADER_BYTES],
            header_len: 0,
            current: None,
        }
    }
}

impl FrameAssembler {
    /// Feed one chunk. `accept` is asked once per header whether the frame is
    /// wanted; `done` gets each wanted frame, already straight alpha.
    pub(crate) fn push(
        &mut self,
        mut chunk: &[u8],
        accept: &mut dyn FnMut(&FrameHeader) -> bool,
        done: &mut dyn FnMut(FrameHeader, Vec<u8>),
    ) -> Result<(), FrameError> {
        while !chunk.is_empty() {
            let Some(frame) = self.current.as_mut() else {
                let take = (FRAME_HEADER_BYTES - self.header_len).min(chunk.len());
                self.header[self.header_len..self.header_len + take]
                    .copy_from_slice(&chunk[..take]);
                self.header_len += take;
                chunk = &chunk[take..];
                if self.header_len == FRAME_HEADER_BYTES {
                    self.header_len = 0;
                    let header = FrameHeader::parse(&self.header)?;
                    let payload = header.payload_bytes();
                    self.current = Some(InFlightFrame {
                        header,
                        remaining: payload,
                        pixels: accept(&header).then(|| Vec::with_capacity(payload)),
                        carry: [0; 4],
                        carry_len: 0,
                    });
                }
                continue;
            };
            let take = frame.remaining.min(chunk.len());
            let (mut part, rest) = chunk.split_at(take);
            chunk = rest;
            frame.remaining -= take;
            if let Some(pixels) = frame.pixels.as_mut() {
                if frame.carry_len > 0 {
                    let fill = (4 - frame.carry_len).min(part.len());
                    frame.carry[frame.carry_len..frame.carry_len + fill]
                        .copy_from_slice(&part[..fill]);
                    frame.carry_len += fill;
                    part = &part[fill..];
                    if frame.carry_len == 4 {
                        append_straight_alpha(pixels, &frame.carry);
                        frame.carry_len = 0;
                    }
                }
                let whole = part.len() - part.len() % 4;
                append_straight_alpha(pixels, &part[..whole]);
                let tail = &part[whole..];
                frame.carry[..tail.len()].copy_from_slice(tail);
                frame.carry_len += tail.len();
            }
            if frame.remaining == 0 {
                let frame = self.current.take().expect("the frame in flight");
                if let Some(pixels) = frame.pixels {
                    done(frame.header, pixels);
                }
            }
        }
        Ok(())
    }
}

// --- Frames: the store -------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PictureState {
    /// Not saved by this process yet; the file may exist from an earlier run.
    Unknown,
    /// Saved, being saved, or found on disk: nothing more to do.
    Settled,
}

struct OverlayFrame {
    bitmap: Arc<BannerBitmap>,
    picture: PictureState,
    next_picture_check_at: Instant,
}

/// What main last said about a page (`htmlOverlays.host.report`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostReport {
    pub state: HtmlOverlayHostState,
    pub detail: Option<String>,
    pub blocked_requests: u32,
}

/// Counters for the measured cost (`htmlOverlays.stats`).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HtmlOverlayStats {
    /// Frames stored for the compositor.
    pub frames_received: u64,
    /// Frames read and thrown away: the overlay was not showing, or the
    /// frame was over the cap.
    pub frames_dropped: u64,
    /// Pixel bytes of the stored frames.
    pub bytes_received: u64,
    /// Time spent turning stored frames into straight alpha, in microseconds
    /// (the socket read is not in it).
    pub convert_micros: u64,
    /// Uploads main has opened.
    pub uploads_opened: u64,
}

#[derive(Default)]
struct ServiceInner {
    frames: Mutex<HashMap<String, OverlayFrame>>,
    targets: Mutex<Vec<HtmlOverlayTarget>>,
    statuses: Mutex<Vec<HtmlOverlayStatus>>,
    host: Mutex<HashMap<String, HostReport>>,
    wake: tokio::sync::Notify,
    frames_received: AtomicU64,
    frames_dropped: AtomicU64,
    bytes_received: AtomicU64,
    convert_micros: AtomicU64,
    uploads_opened: AtomicU64,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What storing a frame asks of the caller.
pub(crate) struct StoredFrame {
    /// The overlay's picture is due (D10): save this bitmap.
    pub picture_due: Option<Arc<BannerBitmap>>,
}

/// The latest frame of every showing overlay, the targets main follows and
/// what main reports (one per process, on `AppState`).
#[derive(Clone, Default)]
pub(crate) struct HtmlOverlayService {
    inner: Arc<ServiceInner>,
}

impl std::fmt::Debug for HtmlOverlayService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HtmlOverlayService")
            .field("frames", &locked(&self.inner.frames).len())
            .finish_non_exhaustive()
    }
}

impl HtmlOverlayService {
    /// The render tick's lookup: the overlay's latest frame, if it has one.
    /// One short mutex, never a copy.
    pub(crate) fn latest_frame(&self, banner_id: &str) -> Option<Arc<BannerBitmap>> {
        locked(&self.inner.frames)
            .get(banner_id)
            .map(|frame| Arc::clone(&frame.bitmap))
    }

    /// Whether the upload keeps this frame: its overlay is a current target
    /// and the frame is within the cap (D7).
    pub(crate) fn accepts(&self, header: &FrameHeader) -> bool {
        if u64::from(header.width) * u64::from(header.height) > HTML_OVERLAY_MAX_FRAME_PIXELS {
            return false;
        }
        let id = header.id.to_string();
        locked(&self.inner.targets)
            .iter()
            .any(|target| target.id == id)
    }

    /// Store a converted frame as its overlay's latest (latest wins).
    pub(crate) fn store(&self, header: FrameHeader, bgra: Vec<u8>, now: Instant) -> StoredFrame {
        let id = header.id.to_string();
        self.inner.frames_received.fetch_add(1, Ordering::Relaxed);
        self.inner
            .bytes_received
            .fetch_add(bgra.len() as u64, Ordering::Relaxed);
        let bitmap = Arc::new(BannerBitmap {
            width: header.width,
            height: header.height,
            bgra: Arc::new(bgra),
            revision: next_bitmap_revision(),
        });
        let mut frames = locked(&self.inner.frames);
        let first = !frames.contains_key(&id);
        let frame = frames.entry(id).or_insert_with(|| OverlayFrame {
            bitmap: Arc::clone(&bitmap),
            picture: PictureState::Unknown,
            next_picture_check_at: now + PICTURE_AFTER,
        });
        frame.bitmap = Arc::clone(&bitmap);
        let mut picture_due = None;
        if frame.picture == PictureState::Unknown && now >= frame.next_picture_check_at {
            if bitmap.bgra.chunks_exact(4).any(|pixel| pixel[3] != 0) {
                frame.picture = PictureState::Settled;
                picture_due = Some(bitmap);
            } else {
                // Nothing drawn yet: look again in a second, not every frame.
                frame.next_picture_check_at = now + PICTURE_AFTER;
            }
        }
        drop(frames);
        if first {
            // The overlay had no frame before this one: its status changes.
            self.inner.wake.notify_one();
        }
        StoredFrame { picture_due }
    }

    /// Drop the frames (and host reports) of overlays that are not in `keep`.
    pub(crate) fn retain(&self, keep: &HashSet<&str>) {
        locked(&self.inner.frames).retain(|id, _| keep.contains(id.as_str()));
        locked(&self.inner.host).retain(|id, _| keep.contains(id.as_str()));
    }

    pub(crate) fn targets(&self) -> HtmlOverlayTargets {
        HtmlOverlayTargets {
            targets: locked(&self.inner.targets).clone(),
        }
    }

    /// Replace the targets; `true` when they changed.
    pub(crate) fn set_targets(&self, targets: Vec<HtmlOverlayTarget>) -> bool {
        let mut current = locked(&self.inner.targets);
        if *current == targets {
            return false;
        }
        *current = targets;
        true
    }

    pub(crate) fn statuses(&self) -> HtmlOverlayStatuses {
        HtmlOverlayStatuses {
            overlays: locked(&self.inner.statuses).clone(),
        }
    }

    /// Replace the statuses; `true` when they changed.
    pub(crate) fn set_statuses(&self, statuses: Vec<HtmlOverlayStatus>) -> bool {
        let mut current = locked(&self.inner.statuses);
        if *current == statuses {
            return false;
        }
        *current = statuses;
        true
    }

    /// `htmlOverlays.host.report`: what main says about a page it hosts.
    pub(crate) fn report_host(&self, banner_id: &str, report: HostReport) {
        locked(&self.inner.host).insert(banner_id.to_string(), report);
        self.inner.wake.notify_one();
    }

    fn host_report(&self, banner_id: &str) -> Option<HostReport> {
        locked(&self.inner.host).get(banner_id).cloned()
    }

    /// Recompute targets and statuses now (a banner, a canvas or a session
    /// changed).
    pub(crate) fn wake(&self) {
        self.inner.wake.notify_one();
    }

    pub(crate) fn stats(&self) -> HtmlOverlayStats {
        HtmlOverlayStats {
            frames_received: self.inner.frames_received.load(Ordering::Relaxed),
            frames_dropped: self.inner.frames_dropped.load(Ordering::Relaxed),
            bytes_received: self.inner.bytes_received.load(Ordering::Relaxed),
            convert_micros: self.inner.convert_micros.load(Ordering::Relaxed),
            uploads_opened: self.inner.uploads_opened.load(Ordering::Relaxed),
        }
    }
}

// --- Targets and status ------------------------------------------------------

/// What the compositor says about HTML overlays right now
/// (`CompositorRuntime::html_overlay_view`).
#[derive(Debug, Clone, Default)]
pub(crate) struct HtmlOverlayView {
    /// Every HTML banner in the set and whether it is fading out.
    pub layers: Vec<(Banner, bool)>,
    /// The canvases a run draws (primary, then auxiliary); empty without one.
    pub canvases: Vec<(u32, u32)>,
    /// The compositor's rate.
    pub fps: u32,
}

/// D7: the frame size for a draw of `width` × `height`: scaled down to the
/// cap with the aspect kept, each side even and at least 2. Pure.
pub(crate) fn frame_size_for_draw(width: u32, height: u32) -> (u32, u32) {
    let (mut width, mut height) = (width.max(1), height.max(1));
    let pixels = u64::from(width) * u64::from(height);
    if pixels > HTML_OVERLAY_MAX_FRAME_PIXELS {
        let scale = (HTML_OVERLAY_MAX_FRAME_PIXELS as f64 / pixels as f64).sqrt();
        width = ((f64::from(width) * scale).floor() as u32).max(1);
        height = ((f64::from(height) * scale).floor() as u32).max(1);
    }
    let even = |side: u32| (side + side % 2).max(2);
    let (mut width, mut height) = (even(width), even(height));
    // Rounding up to even may step over the cap by a row or a column.
    while u64::from(width) * u64::from(height) > HTML_OVERLAY_MAX_FRAME_PIXELS {
        if width >= height {
            width -= 2;
        } else {
            height -= 2;
        }
    }
    (width, height)
}

/// The overlays main renders now ("Targets"): every HTML banner that shows
/// (not fading out) with a switch on, at its largest contained draw size
/// over the run's canvases, at the compositor's rate capped at 30. No run,
/// or a session that cannot draw one, means no targets. Pure.
pub(crate) fn html_overlay_targets(
    view: &HtmlOverlayView,
    session_accepts: Option<bool>,
) -> Vec<HtmlOverlayTarget> {
    if view.canvases.is_empty() || session_accepts == Some(false) {
        return Vec::new();
    }
    let fps = view.fps.clamp(1, HTML_OVERLAY_MAX_FPS);
    view.layers
        .iter()
        .filter(|(banner, leaving)| {
            !leaving
                && banner.kind == BannerKind::Html
                && (banner.show_on_stream || banner.show_in_recording)
        })
        .map(|(banner, _)| {
            let (draw_width, draw_height) = view
                .canvases
                .iter()
                .map(|canvas| {
                    let rect = match OverlayOrientation::for_canvas(canvas.0, canvas.1) {
                        OverlayOrientation::Horizontal => banner.horizontal,
                        OverlayOrientation::Vertical => banner.vertical,
                    };
                    let (_, _, width, height) = banner_draw_rect(
                        banner.width,
                        banner.height,
                        canvas.0 as usize,
                        canvas.1 as usize,
                        rect,
                    );
                    (width as u32, height as u32)
                })
                .max_by_key(|(width, height)| u64::from(*width) * u64::from(*height))
                .unwrap_or((banner.width, banner.height));
            let (frame_width, frame_height) = frame_size_for_draw(draw_width, draw_height);
            HtmlOverlayTarget {
                id: banner.id.clone(),
                page_width: banner.width,
                page_height: banner.height,
                frame_width,
                frame_height,
                fps,
            }
        })
        .collect()
}

/// Where each showing HTML overlay stands, for the UI. Pure but for the two
/// lookups.
pub(crate) fn html_overlay_statuses(
    view: &HtmlOverlayView,
    session_accepts: Option<bool>,
    frame_of: &dyn Fn(&str) -> Option<(u32, u32)>,
    host_of: &dyn Fn(&str) -> Option<HostReport>,
) -> Vec<HtmlOverlayStatus> {
    view.layers
        .iter()
        .filter(|(banner, leaving)| !leaving && banner.kind == BannerKind::Html)
        .map(|(banner, _)| {
            let host = host_of(&banner.id);
            let blocked_requests = host
                .as_ref()
                .map(|report| report.blocked_requests)
                .filter(|count| *count > 0);
            let frame = frame_of(&banner.id);
            let (state, detail) = if session_accepts == Some(false) {
                (
                    HtmlOverlayState::Unavailable,
                    Some(REFUSAL_SESSION_CANNOT_DRAW.to_string()),
                )
            } else if let Some(HostReport {
                state: HtmlOverlayHostState::Failed,
                detail,
                ..
            }) = host.as_ref()
            {
                (
                    HtmlOverlayState::Failed,
                    Some(match detail.as_deref().map(str::trim) {
                        Some(detail) if !detail.is_empty() => {
                            format!("This banner stopped: {detail}")
                        }
                        _ => "This banner stopped.".to_string(),
                    }),
                )
            } else if frame.is_some() {
                (HtmlOverlayState::Live, None)
            } else {
                (HtmlOverlayState::Loading, None)
            };
            let live = state == HtmlOverlayState::Live;
            HtmlOverlayStatus {
                id: banner.id.clone(),
                state,
                detail,
                frame_width: frame.filter(|_| live).map(|(width, _)| width),
                frame_height: frame.filter(|_| live).map(|(_, height)| height),
                blocked_requests,
            }
        })
        .collect()
}

/// Publish targets and statuses when they changed. Runs for the whole
/// process: twice a second, and at once after `HtmlOverlayService::wake`
/// (a banner change, a session start or stop, a first frame, a host report).
pub(crate) async fn run_html_overlay_targets(state: AppState) {
    loop {
        refresh_html_overlays(&state).await;
        tokio::select! {
            () = state.html_overlays.inner.wake.notified() => {}
            () = tokio::time::sleep(Duration::from_millis(500)) => {}
        }
    }
}

/// One pass of `run_html_overlay_targets`.
pub(crate) async fn refresh_html_overlays(state: &AppState) {
    let session_accepts = crate::recording::active_session_accepts_html_overlays(state).await;
    let view = crate::compositor::html_overlay_view(state).await;
    let service = &state.html_overlays;
    // A frame outlives Hide for the fade-out and no longer: it goes when its
    // layer leaves the set, or when the running session cannot draw it.
    let keep: HashSet<&str> = if session_accepts == Some(false) {
        HashSet::new()
    } else {
        view.layers
            .iter()
            .map(|(banner, _)| banner.id.as_str())
            .collect()
    };
    service.retain(&keep);
    let targets = html_overlay_targets(&view, session_accepts);
    if service.set_targets(targets.clone()) {
        state.emit_event(HTML_OVERLAY_TARGETS_EVENT, HtmlOverlayTargets { targets });
    }
    let statuses = html_overlay_statuses(
        &view,
        session_accepts,
        &|id: &str| {
            service
                .latest_frame(id)
                .map(|bitmap| (bitmap.width, bitmap.height))
        },
        &|id: &str| service.host_report(id),
    );
    if service.set_statuses(statuses.clone()) {
        state.emit_event(
            HTML_OVERLAY_STATUS_EVENT,
            HtmlOverlayStatuses { overlays: statuses },
        );
    }
}

// --- The upload route --------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct FramesQuery {
    token: String,
}

/// `POST /html-overlays/frames?token=<admin>`: one long-lived chunked upload
/// of frame records from Electron main. Admin role only: the renderer and
/// remote clients can never put pixels on the picture.
pub(crate) async fn frames_upload_handler(
    State(state): State<AppState>,
    Query(query): Query<FramesQuery>,
    body: axum::body::Body,
) -> Response {
    if crate::http_backend_role(&state, &query.token) != Some(BackendRole::Admin) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let service = state.html_overlays.clone();
    service.inner.uploads_opened.fetch_add(1, Ordering::Relaxed);
    let mut assembler = FrameAssembler::default();
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            // Main went away mid-frame: the half frame is dropped with us.
            return StatusCode::BAD_REQUEST.into_response();
        };
        let mut completed: Vec<(FrameHeader, Vec<u8>)> = Vec::new();
        let started = Instant::now();
        let pushed = assembler.push(
            &chunk,
            &mut |header: &FrameHeader| {
                let accepted = service.accepts(header);
                if !accepted {
                    service.inner.frames_dropped.fetch_add(1, Ordering::Relaxed);
                }
                accepted
            },
            &mut |header: FrameHeader, pixels: Vec<u8>| completed.push((header, pixels)),
        );
        if assembler
            .current
            .as_ref()
            .is_some_and(|frame| frame.pixels.is_some())
            || !completed.is_empty()
        {
            // Only chunks of a kept frame count as conversion time.
            service
                .inner
                .convert_micros
                .fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        }
        if let Err(error) = pushed {
            tracing::warn!("HTML overlay frame upload ended: {error}");
            return StatusCode::BAD_REQUEST.into_response();
        }
        for (header, pixels) in completed {
            let stored = service.store(header, pixels, Instant::now());
            if let Some(bitmap) = stored.picture_due {
                save_overlay_picture(&state, header.id.to_string(), bitmap);
            }
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

/// D10: save the overlay's own picture as the banner's stored image and
/// thumbnail, off the upload task, once. A picture an earlier run saved is
/// kept.
fn save_overlay_picture(state: &AppState, banner_id: String, bitmap: Arc<BannerBitmap>) {
    let state = state.clone();
    tokio::spawn(async move {
        let database = state.database.clone();
        let id = banner_id.clone();
        let saved = tokio::task::spawn_blocking(move || -> Result<bool> {
            let root = validate_managed_banner_root(&database.banner_assets_dir())?;
            let image_path = root.join(banner_image_file_name(&id));
            if image_path.exists() {
                return Ok(false);
            }
            let mut rgba = Vec::with_capacity(bitmap.bgra.len());
            for pixel in bitmap.bgra.chunks_exact(4) {
                rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
            }
            let image = image::RgbaImage::from_raw(bitmap.width, bitmap.height, rgba)
                .context("Overlay frame has the wrong size for its picture")?;
            let thumbnail = fit_within(&image, BANNER_THUMBNAIL_SIDE);
            write_file_atomically(
                &root.join(banner_thumbnail_file_name(&id)),
                &encode_png(&thumbnail)?,
            )?;
            write_file_atomically(&image_path, &encode_png(&image)?)?;
            database.mark_banner_picture_saved(&id, image_has_alpha(&image))?;
            Ok(true)
        })
        .await;
        match saved {
            Ok(Ok(true)) => {
                if let Err(error) = crate::banners::on_banners_changed(&state).await {
                    tracing::warn!(
                        "Could not publish the banner list after an overlay picture: {error:#}"
                    );
                }
            }
            Ok(Ok(false)) => {}
            Ok(Err(error)) => {
                tracing::warn!(banner = %banner_id, "Could not save an HTML overlay's picture: {error:#}");
            }
            Err(error) => {
                tracing::warn!(banner = %banner_id, "The HTML overlay picture task stopped: {error}");
            }
        }
    });
}

#[cfg(test)]
#[path = "html_overlay_tests.rs"]
mod tests;
