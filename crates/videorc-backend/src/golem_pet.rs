//! Golem pet packs (plan 168 Phase A, decisions D1 to D4).
//!
//! A pet pack is a page-pet manifest v1 folder, unchanged (D1): a
//! `manifest.json`, the sheets it names, and a Videorc sidecar `golem.json`
//! (D1, D16). This module owns the pack contract every later phase builds on:
//!
//! - [`validate_manifest`] mirrors page-pet's `validateManifest` rule for
//!   rule, refuses what Videorc does not render (legacy two-layer packs, AVIF
//!   sheets, D1) and applies the D4 guards (frame count, cell size).
//! - [`validate_sheet_sizes`] and [`validate_images`] mirror page-pet's
//!   `validateImages` (every rect inside its decoded sheet) plus the D4 sheet
//!   and decode budgets and the playground's transparency check per cell.
//! - [`measure_head_top`] finds where the bubble anchors (D16).
//!
//! The same rules run in TypeScript (`apps/desktop/src/shared/golem-pet.ts`)
//! for the renderer preview; `protocol-fixtures/golem-pet-manifests.json` is
//! run by both, and every failing case names its [`PetRule`].
//!
//! Ported from page-pet (`gvastethecreator/page-pet-skill` `0b6a0ef`, MIT,
//! copyright 2026 Cristian): `runtime/manifest.js` (`validateManifest`,
//! `validateSprite`, `validateImages`, `sheetNames`) and the import guards of
//! `playground/app.js` (file sizes, the per-cell transparency probe).

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The manifest file of every pack.
pub const GOLEM_PET_MANIFEST_FILE: &str = "manifest.json";
/// The Videorc sidecar next to it (D1, D16).
pub const GOLEM_PET_SIDECAR_FILE: &str = "golem.json";
/// page-pet's import guard, per file (D4).
pub const GOLEM_PET_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// page-pet's import guard, for the whole pack (D4).
pub const GOLEM_PET_PACK_MAX_BYTES: u64 = 128 * 1024 * 1024;
/// A sheet is at most 8192 px on each side (D4).
pub const GOLEM_PET_SHEET_MAX_SIDE: u32 = 8192;
/// Cells are square, 128 to 1024 px (D4). Created packs use 640.
pub const GOLEM_PET_CELL_MIN: u32 = 128;
pub const GOLEM_PET_CELL_MAX: u32 = 1024;
/// At most 64 frames per pack (D4).
pub const GOLEM_PET_FRAMES_MAX: usize = 64;
/// Every decoded sheet together stays under the compositor's decode budget
/// (D4; `COMPOSITOR_IMAGE_DECODE_BUDGET_BYTES`).
pub const GOLEM_PET_DECODED_MAX_BYTES: u64 = 128 * 1024 * 1024;
/// The alpha a pixel needs to count as the character (page-pet's builder
/// uses `alpha > 16` everywhere it measures a silhouette).
pub const GOLEM_PET_ALPHA_SOLID: u8 = 16;
/// The sidecar version this build writes and reads.
pub const GOLEM_PET_SIDECAR_VERSION: u32 = 1;
/// A sidecar names at most this many talk frames (D12 uses two).
pub const GOLEM_PET_TALK_MAX: usize = 4;
/// Frame ids and the listed pack name are at most 64 UTF-16 units (a
/// Videorc bound: ids ride the wire and the reaction pickers).
pub const GOLEM_PET_TEXT_MAX: usize = 64;

/// Each reason a pack is refused. The kebab-case name is shared with the
/// TypeScript validator and the fixture (`rule` on every failing case).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PetRule {
    /// `manifest.json` is not JSON.
    ManifestJson,
    /// page-pet: `version: 1`, a non-blank `name`, a non-empty `frames` array.
    ManifestV1,
    /// D4: at most 64 frames.
    FrameCount,
    /// page-pet: static two-image puppets are retired.
    PuppetRetired,
    /// D1: legacy two-layer packs (`layers`) are refused.
    LegacyLayers,
    /// page-pet: `pivot` is a normalized `[x, y]`.
    PivotRange,
    /// page-pet: every frame has a unique, non-empty string id.
    FrameId,
    /// page-pet: `expression` needs a layered pack, which D1 refuses.
    FrameExpression,
    /// page-pet: a sheet is a local `.png`, `.webp` or `.avif` file name.
    SheetName,
    /// D1: AVIF sheets are refused (no decoder in this build).
    SheetAvif,
    /// page-pet: `rect` is four non-negative integers, square and non-empty.
    RectSquare,
    /// page-pet: `kind` is `gaze` or `reaction`.
    FrameKind,
    /// page-pet: a gaze point is inside [-1, 1]².
    GazeRange,
    /// page-pet: gaze points are unique across sheets.
    GazeUnique,
    /// page-pet: `neutral` names a gaze frame.
    NeutralMissing,
    /// D4: cells are 128 to 1024 px.
    CellSize,
    /// D4: a rect that reaches past 8192 px can never fit a sheet.
    RectLimit,
    /// page-pet `validateImages`: a frame lies inside its decoded sheet.
    FrameOutsideSheet,
    /// D4: a sheet is at most 8192 × 8192.
    SheetSize,
    /// D4: the decoded sheets fit the 128 MiB decode budget.
    DecodedBudget,
    /// page-pet playground: every cell shows a character on real transparency.
    CellTransparency,
    /// A sheet the manifest names is not in the folder.
    SheetMissing,
    /// A sheet is not a PNG or WebP image (by its bytes).
    SheetFormat,
    /// A sheet could not be decoded.
    SheetDecode,
    /// D4: a file is over 32 MB.
    FileSize,
    /// D4: the pack is over 128 MB.
    PackSize,
    /// `golem.json` is unreadable or out of bounds.
    Sidecar,
    /// The pack id is neither a uuid nor `bundled:<name>`.
    PackId,
    /// No pack folder with that id.
    PackNotFound,
    /// The pack folder resolves outside the managed golem roots.
    PackOutsideRoot,
    /// The pack folder could not be read or written.
    PackIo,
}

impl PetRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ManifestJson => "manifest-json",
            Self::ManifestV1 => "manifest-v1",
            Self::FrameCount => "frame-count",
            Self::PuppetRetired => "puppet-retired",
            Self::LegacyLayers => "legacy-layers",
            Self::PivotRange => "pivot-range",
            Self::FrameId => "frame-id",
            Self::FrameExpression => "frame-expression",
            Self::SheetName => "sheet-name",
            Self::SheetAvif => "sheet-avif",
            Self::RectSquare => "rect-square",
            Self::FrameKind => "frame-kind",
            Self::GazeRange => "gaze-range",
            Self::GazeUnique => "gaze-unique",
            Self::NeutralMissing => "neutral-missing",
            Self::CellSize => "cell-size",
            Self::RectLimit => "rect-limit",
            Self::FrameOutsideSheet => "frame-outside-sheet",
            Self::SheetSize => "sheet-size",
            Self::DecodedBudget => "decoded-budget",
            Self::CellTransparency => "cell-transparency",
            Self::SheetMissing => "sheet-missing",
            Self::SheetFormat => "sheet-format",
            Self::SheetDecode => "sheet-decode",
            Self::FileSize => "file-size",
            Self::PackSize => "pack-size",
            Self::Sidecar => "sidecar",
            Self::PackId => "pack-id",
            Self::PackNotFound => "pack-not-found",
            Self::PackOutsideRoot => "pack-outside-root",
            Self::PackIo => "pack-io",
        }
    }
}

/// Why a pack was refused: the rule it broke and one plain sentence for the
/// Golem tab to show inline.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PetError {
    pub rule: PetRule,
    pub message: String,
}

impl PetError {
    pub fn new(rule: PetRule, message: impl Into<String>) -> Self {
        Self {
            rule,
            message: message.into(),
        }
    }
}

/// A frame shows a gaze direction or a reaction (page-pet's two kinds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PetFrameKind {
    Gaze,
    Reaction,
}

/// One cell of an atlas: the whole character in one pose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetFrame {
    pub id: String,
    pub kind: PetFrameKind,
    /// A plain file name in the pack folder.
    pub sheet: String,
    /// `[x, y, w, h]` in sheet pixels; square (`w == h`).
    pub rect: [u32; 4],
    /// Gaze frames only: `[x, y]` in [-1, 1]², negative x = viewer's left,
    /// negative y = up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gaze: Option<[f64; 2]>,
}

impl PetFrame {
    /// The cell's side in sheet pixels.
    pub fn cell_size(&self) -> u32 {
        self.rect[2]
    }
}

/// A page-pet manifest v1 that passed [`validate_manifest`]. Fields page-pet
/// ignores at runtime (or that this build does not use) are not kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetManifest {
    pub version: u32,
    pub name: String,
    /// The id of the gaze frame the pet rests on.
    pub neutral: String,
    /// Normalized transform origin; page-pet's motion defaults to `[0.5, 0.9]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pivot: Option<[f64; 2]>,
    pub frames: Vec<PetFrame>,
}

impl PetManifest {
    #[allow(dead_code)] // Phase B and C look frames up by id.
    pub fn frame(&self, id: &str) -> Option<&PetFrame> {
        self.frames.iter().find(|frame| frame.id == id)
    }

    /// The neutral gaze frame (always present after validation).
    pub fn neutral_frame(&self) -> Option<&PetFrame> {
        self.frames
            .iter()
            .find(|frame| frame.id == self.neutral && frame.kind == PetFrameKind::Gaze)
    }

    /// Reaction ids in manifest order.
    pub fn reaction_ids(&self) -> Vec<String> {
        self.frames
            .iter()
            .filter(|frame| frame.kind == PetFrameKind::Reaction)
            .map(|frame| frame.id.clone())
            .collect()
    }

    pub fn has_reaction(&self, id: &str) -> bool {
        self.frames
            .iter()
            .any(|frame| frame.kind == PetFrameKind::Reaction && frame.id == id)
    }

    pub fn gaze_count(&self) -> usize {
        self.frames
            .iter()
            .filter(|frame| frame.kind == PetFrameKind::Gaze)
            .count()
    }

    /// Every sheet the frames name, each once (page-pet `sheetNames`).
    pub fn sheet_names(&self) -> BTreeSet<String> {
        self.frames
            .iter()
            .map(|frame| frame.sheet.clone())
            .collect()
    }
}

/// Where a pack came from (sidecar `source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PetSource {
    /// Made with the in-app creator (Phase F).
    VideorcCreator,
    /// A page-pet pack imported from a folder (S-A3).
    PagePetImport,
    /// Built in memory from the persona's state images (S-A4).
    Still,
}

/// The Videorc sidecar `golem.json` (D1, D16): what page-pet's manifest does
/// not carry. A pack imported without one gets one written (S-A3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSidecar {
    pub version: u32,
    pub source: PetSource,
    /// Normalized top of the neutral silhouette inside its cell (alpha > 16),
    /// where the bubble anchors (D16).
    pub head_top: f64,
    /// The talk frames, cycled while a bubble is up (D12); may be empty.
    #[serde(default)]
    pub talk: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_sha256: Option<String>,
}

/// The ids a pack's talk cycle uses when present (D12, Phase F's extras).
pub const GOLEM_PET_TALK_IDS: [&str; 2] = ["talk-a", "talk-b"];

// --- Manifest validation (page-pet `runtime/manifest.js`) --------------------

/// JavaScript truthiness of a JSON value, for page-pet's `if (value.puppet)`
/// and `if (value.layers)`.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A JSON number that `Number.isFinite` accepts.
fn finite_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

/// `[a, b]` of finite numbers within `[min, max]`.
fn bounded_pair(value: &Value, min: f64, max: f64) -> Option<[f64; 2]> {
    let items = value.as_array()?;
    if items.len() != 2 {
        return None;
    }
    let a = finite_number(&items[0]).filter(|n| (min..=max).contains(n))?;
    let b = finite_number(&items[1]).filter(|n| (min..=max).contains(n))?;
    Some([a, b])
}

/// page-pet's `/^[a-zA-Z0-9_-]+\.(png|webp|avif)$/`: one plain file name,
/// no path, no URL. Returns the extension.
fn sheet_extension(name: &str) -> Option<&str> {
    let (stem, extension) = name.rsplit_once('.')?;
    let stem_ok = !stem.is_empty()
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    (stem_ok && matches!(extension, "png" | "webp" | "avif")).then_some(extension)
}

/// page-pet `validateSprite`, the sheet half, then D1's AVIF refusal.
fn validate_sheet(frame_id: &str, value: Option<&Value>) -> Result<String, PetError> {
    let name = value.and_then(Value::as_str).unwrap_or_default();
    let Some(extension) = sheet_extension(name) else {
        return Err(PetError::new(
            PetRule::SheetName,
            format!(
                "Frame {frame_id}: sheets must be local PNG or WebP file names, without paths."
            ),
        ));
    };
    if extension == "avif" {
        return Err(PetError::new(
            PetRule::SheetAvif,
            format!("Frame {frame_id}: AVIF sheets are not supported. Use PNG or WebP."),
        ));
    }
    Ok(name.to_string())
}

/// page-pet `validateSprite`, the rect half: four non-negative integers
/// (`Number.isInteger`, so `640.0` counts), a non-zero width, square.
fn validate_rect(frame_id: &str, value: Option<&Value>) -> Result<[u64; 4], PetError> {
    let refuse = || {
        PetError::new(
            PetRule::RectSquare,
            format!("Frame {frame_id} needs a square rectangle of whole pixels."),
        )
    };
    let items = value.and_then(Value::as_array).ok_or_else(refuse)?;
    if items.len() != 4 {
        return Err(refuse());
    }
    let mut rect = [0u64; 4];
    for (slot, item) in rect.iter_mut().zip(items) {
        let number = finite_number(item)
            .filter(|n| n.fract() == 0.0 && *n >= 0.0)
            .ok_or_else(refuse)?;
        // Saturating: anything past u64 is far past the D4 sheet limit and
        // fails `RectLimit` below.
        *slot = number as u64;
    }
    if rect[2] == 0 || rect[2] != rect[3] {
        return Err(refuse());
    }
    Ok(rect)
}

/// Validate a parsed `manifest.json` (page-pet manifest v1).
///
/// The page-pet checks run in page-pet's order with page-pet's semantics
/// (JavaScript truthiness for `puppet` and `layers`, `Number.isInteger` for
/// rects, numeric equality for gaze uniqueness), then D1 (no `layers`, no
/// AVIF) and D4 (64 frames, 128 to 1024 px cells, nothing past 8192 px).
pub fn validate_manifest(value: &Value) -> Result<PetManifest, PetError> {
    let invalid = || {
        PetError::new(
            PetRule::ManifestV1,
            "This is not a page-pet manifest: it needs version 1, a name and frames.",
        )
    };
    let object = value.as_object().ok_or_else(invalid)?;
    let version_ok = object.get("version").and_then(finite_number) == Some(1.0);
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty());
    let frames = object
        .get("frames")
        .and_then(Value::as_array)
        .filter(|frames| !frames.is_empty());
    let (true, Some(name), Some(frames)) = (version_ok, name, frames) else {
        return Err(invalid());
    };
    if frames.len() > GOLEM_PET_FRAMES_MAX {
        return Err(PetError::new(
            PetRule::FrameCount,
            format!("A pack has at most {GOLEM_PET_FRAMES_MAX} frames."),
        ));
    }
    if object.get("puppet").is_some_and(js_truthy) {
        return Err(PetError::new(
            PetRule::PuppetRetired,
            "Static two-image puppets are not supported. Use a complete-character pack.",
        ));
    }
    if object.get("layers").is_some_and(js_truthy) {
        return Err(PetError::new(
            PetRule::LegacyLayers,
            "Two-layer packs (separate head and body) are not supported. Use a complete-character pack.",
        ));
    }
    let pivot = match object.get("pivot") {
        None => None,
        Some(pivot) => Some(bounded_pair(pivot, 0.0, 1.0).ok_or_else(|| {
            PetError::new(
                PetRule::PivotRange,
                "The pivot must be two numbers between 0 and 1.",
            )
        })?),
    };

    let mut ids: HashSet<&str> = HashSet::new();
    let mut points: Vec<[f64; 2]> = Vec::new();
    let mut typed: Vec<(PetFrame, [u64; 4])> = Vec::with_capacity(frames.len());
    for frame in frames {
        let fields = frame.as_object();
        let field = |key: &str| fields.and_then(|fields| fields.get(key));
        let id = field("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && !ids.contains(id))
            .ok_or_else(|| PetError::new(PetRule::FrameId, "Every frame needs its own id."))?;
        if field("expression").is_some() {
            return Err(PetError::new(
                PetRule::FrameExpression,
                format!(
                    "Frame {id}: expressions belong to two-layer packs, which are not supported."
                ),
            ));
        }
        ids.insert(id);
        let sheet = validate_sheet(id, field("sheet"))?;
        let rect = validate_rect(id, field("rect"))?;
        let kind = match field("kind").and_then(Value::as_str) {
            Some("gaze") => PetFrameKind::Gaze,
            Some("reaction") => PetFrameKind::Reaction,
            _ => {
                return Err(PetError::new(
                    PetRule::FrameKind,
                    format!("Frame {id}: the kind must be gaze or reaction."),
                ));
            }
        };
        let gaze = if kind == PetFrameKind::Gaze {
            let point = field("gaze")
                .and_then(|gaze| bounded_pair(gaze, -1.0, 1.0))
                .ok_or_else(|| {
                    PetError::new(
                        PetRule::GazeRange,
                        format!("Frame {id}: gaze coordinates must be between -1 and 1."),
                    )
                })?;
            // Numeric equality, as page-pet's joined strings compare (-0 == 0).
            if points.contains(&point) {
                return Err(PetError::new(
                    PetRule::GazeUnique,
                    format!("Frame {id}: another frame already looks in that direction."),
                ));
            }
            points.push(point);
            Some(point)
        } else {
            None
        };
        typed.push((
            PetFrame {
                id: id.to_string(),
                kind,
                sheet,
                rect: [0; 4],
                gaze,
            },
            rect,
        ));
    }
    let neutral = object
        .get("neutral")
        .and_then(Value::as_str)
        .filter(|neutral| {
            typed
                .iter()
                .any(|(frame, _)| frame.id == *neutral && frame.kind == PetFrameKind::Gaze)
        })
        .ok_or_else(|| {
            PetError::new(
                PetRule::NeutralMissing,
                "The manifest needs a neutral gaze frame.",
            )
        })?;

    // D4, after every page-pet rule.
    let mut out = Vec::with_capacity(typed.len());
    for (mut frame, [x, y, w, h]) in typed {
        if frame.id.encode_utf16().count() > GOLEM_PET_TEXT_MAX {
            return Err(PetError::new(
                PetRule::FrameId,
                format!("Frame ids are at most {GOLEM_PET_TEXT_MAX} characters."),
            ));
        }
        if !(u64::from(GOLEM_PET_CELL_MIN)..=u64::from(GOLEM_PET_CELL_MAX)).contains(&w) {
            return Err(PetError::new(
                PetRule::CellSize,
                format!(
                    "Frame {}: cells must be {GOLEM_PET_CELL_MIN} to {GOLEM_PET_CELL_MAX} pixels.",
                    frame.id
                ),
            ));
        }
        let limit = u64::from(GOLEM_PET_SHEET_MAX_SIDE);
        if x.saturating_add(w) > limit || y.saturating_add(h) > limit {
            return Err(PetError::new(
                PetRule::RectLimit,
                format!(
                    "Frame {} reaches past {GOLEM_PET_SHEET_MAX_SIDE} pixels, larger than any sheet.",
                    frame.id
                ),
            ));
        }
        // Every value is at most 8192 here.
        frame.rect = [x as u32, y as u32, w as u32, h as u32];
        out.push(frame);
    }

    Ok(PetManifest {
        version: 1,
        name: name.to_string(),
        neutral: neutral.to_string(),
        pivot,
        frames: out,
    })
}

/// `manifest.json` bytes to a validated manifest.
pub fn parse_manifest(bytes: &[u8]) -> Result<PetManifest, PetError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        PetError::new(
            PetRule::ManifestJson,
            format!("manifest.json is not valid JSON: {error}"),
        )
    })?;
    validate_manifest(&value)
}

// --- Images (page-pet `validateImages` and the playground import) ------------

/// page-pet `validateImages` on sheet dimensions (every rect inside its
/// sheet), then the D4 sheet side and decode budget. Runs before any decode,
/// from the image headers.
pub fn validate_sheet_sizes(
    manifest: &PetManifest,
    sizes: &BTreeMap<String, (u32, u32)>,
) -> Result<(), PetError> {
    for frame in &manifest.frames {
        let [x, y, w, h] = frame.rect.map(u64::from);
        let inside = sizes.get(&frame.sheet).is_some_and(|&(width, height)| {
            x + w <= u64::from(width) && y + h <= u64::from(height)
        });
        if !inside {
            return Err(PetError::new(
                PetRule::FrameOutsideSheet,
                format!("Frame {} is outside its sheet.", frame.id),
            ));
        }
    }
    let mut decoded: u64 = 0;
    for name in manifest.sheet_names() {
        let (width, height) = sizes[&name];
        if width > GOLEM_PET_SHEET_MAX_SIDE || height > GOLEM_PET_SHEET_MAX_SIDE {
            return Err(PetError::new(
                PetRule::SheetSize,
                format!(
                    "{name} is {width} × {height}; sheets are at most {GOLEM_PET_SHEET_MAX_SIDE} pixels on each side."
                ),
            ));
        }
        decoded = decoded.saturating_add(u64::from(width) * u64::from(height) * 4);
    }
    if decoded > GOLEM_PET_DECODED_MAX_BYTES {
        return Err(PetError::new(
            PetRule::DecodedBudget,
            "The sheets are too large together: they must decode to under 128 MB.",
        ));
    }
    Ok(())
}

/// The playground's probe, at full resolution: a cell needs real
/// transparency (at least 328 of 4096 pixels fully clear, 8 %) and a visible
/// character (at least 32 of 4096 pixels with alpha above 128). An opaque
/// background or an empty cell fails.
fn cell_has_character_on_transparency(sheet: &image::RgbaImage, rect: [u32; 4]) -> bool {
    let [x, y, w, h] = rect;
    let mut clear: u64 = 0;
    let mut solid: u64 = 0;
    for row in y..y + h {
        for col in x..x + w {
            let alpha = sheet.get_pixel(col, row)[3];
            if alpha == 0 {
                clear += 1;
            }
            if alpha > 128 {
                solid += 1;
            }
        }
    }
    let area = u64::from(w) * u64::from(h);
    clear * 4096 >= 328 * area && solid * 4096 >= 32 * area
}

/// page-pet `validateImages` on decoded sheets plus the per-cell
/// transparency check every imported pack passes.
pub fn validate_images(
    manifest: &PetManifest,
    sheets: &BTreeMap<String, image::RgbaImage>,
) -> Result<(), PetError> {
    let sizes = sheets
        .iter()
        .map(|(name, sheet)| (name.clone(), sheet.dimensions()))
        .collect();
    validate_sheet_sizes(manifest, &sizes)?;
    for frame in &manifest.frames {
        if !cell_has_character_on_transparency(&sheets[&frame.sheet], frame.rect) {
            return Err(PetError::new(
                PetRule::CellTransparency,
                format!(
                    "Frame {} needs a visible character on a transparent background.",
                    frame.id
                ),
            ));
        }
    }
    Ok(())
}

/// The normalized top of the neutral silhouette inside its cell: the first
/// row (from the top) with a pixel of alpha above 16, divided by the cell
/// height, rounded to 4 places. `None` when the neutral cell is empty or
/// outside its sheet.
pub fn measure_head_top(
    manifest: &PetManifest,
    sheets: &BTreeMap<String, image::RgbaImage>,
) -> Option<f64> {
    let frame = manifest.neutral_frame()?;
    let sheet = sheets.get(&frame.sheet)?;
    let [x, y, w, h] = frame.rect;
    if x.checked_add(w)? > sheet.width() || y.checked_add(h)? > sheet.height() {
        return None;
    }
    (0..h)
        .find(|row| (x..x + w).any(|col| sheet.get_pixel(col, y + row)[3] > GOLEM_PET_ALPHA_SOLID))
        .map(|row| (f64::from(row) / f64::from(h) * 10_000.0).round() / 10_000.0)
}

// --- Sidecar ------------------------------------------------------------------

/// `golem.json` as read from a pack: version 1, `headTop` in [0, 1], at
/// most four talk ids that each name a reaction frame once, bounded strings.
pub fn validate_sidecar(sidecar: &PetSidecar, manifest: &PetManifest) -> Result<(), PetError> {
    let refuse = |reason: &str| PetError::new(PetRule::Sidecar, format!("golem.json {reason}"));
    if sidecar.version != GOLEM_PET_SIDECAR_VERSION {
        return Err(refuse("must be version 1."));
    }
    if !sidecar.head_top.is_finite() || !(0.0..=1.0).contains(&sidecar.head_top) {
        return Err(refuse("needs a headTop between 0 and 1."));
    }
    if sidecar.talk.len() > GOLEM_PET_TALK_MAX {
        return Err(refuse("names at most four talk frames."));
    }
    let mut seen = HashSet::new();
    for id in &sidecar.talk {
        if !manifest.has_reaction(id) || !seen.insert(id.as_str()) {
            return Err(refuse("names a talk frame the pack does not have."));
        }
    }
    if sidecar
        .created_at
        .as_ref()
        .is_some_and(|created| created.is_empty() || created.len() > 64)
    {
        return Err(refuse("has an unreadable createdAt."));
    }
    if sidecar
        .reference_sha256
        .as_ref()
        .is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(refuse("has a referenceSha256 that is not a SHA-256."));
    }
    Ok(())
}

/// `golem.json` bytes to a validated sidecar.
pub fn parse_sidecar(bytes: &[u8], manifest: &PetManifest) -> Result<PetSidecar, PetError> {
    let sidecar: PetSidecar = serde_json::from_slice(bytes).map_err(|error| {
        PetError::new(
            PetRule::Sidecar,
            format!("golem.json is not readable: {error}"),
        )
    })?;
    validate_sidecar(&sidecar, manifest)?;
    Ok(sidecar)
}

// --- Packs on disk (plan 168 S-A3, D3) ----------------------------------------

/// A bundled pack id is `bundled:<name>`; its folder is `<bundled root>/<name>`.
pub const GOLEM_BUNDLED_PACK_PREFIX: &str = "bundled:";
/// `manifest.json` and `golem.json` are small; a larger one is refused.
pub const GOLEM_PET_JSON_MAX_BYTES: u64 = 1024 * 1024;

/// Where a pack id points (D3): the persona's own pack (a lowercase uuid
/// under `<write root>/<personaId>/pets/`) or a shipped one (`bundled:<name>`
/// under the read-only second root).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackRef {
    User(String),
    Bundled(String),
}

/// A pack id as the wire carries it, or `PackId` when it is neither form.
pub fn parse_pack_id(pack_id: &str) -> Result<PackRef, PetError> {
    if let Some(name) = pack_id.strip_prefix(GOLEM_BUNDLED_PACK_PREFIX) {
        if (1..=40).contains(&name.len())
            && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Ok(PackRef::Bundled(name.to_string()));
        }
    } else if uuid::Uuid::parse_str(pack_id)
        .is_ok_and(|uuid| uuid.hyphenated().to_string() == pack_id)
    {
        return Ok(PackRef::User(pack_id.to_string()));
    }
    Err(PetError::new(
        PetRule::PackId,
        "The pack id is neither a pack of this Golem nor a built-in pack.",
    ))
}

/// A persona id names a folder: a plain token only (as `cohost.rs` checks).
fn persona_id_ok(persona_id: &str) -> bool {
    !persona_id.is_empty()
        && persona_id.len() <= 128
        && persona_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The folder a pack id names under the golem roots (`roots[0]` is the
/// write root, `roots[1]` the bundled root), canonicalized and checked to be
/// a directory inside its root: a link that leaves the root is refused.
pub fn pack_dir(roots: &[PathBuf], persona_id: &str, pack_id: &str) -> Result<PathBuf, PetError> {
    if !persona_id_ok(persona_id) {
        return Err(PetError::new(
            PetRule::PackId,
            "The persona id is not a plain token.",
        ));
    }
    let not_found = || PetError::new(PetRule::PackNotFound, "That pack is not on this computer.");
    let (root, dir) = match parse_pack_id(pack_id)? {
        PackRef::User(id) => {
            let root = roots.first().ok_or_else(not_found)?;
            (root, root.join(persona_id).join("pets").join(id))
        }
        PackRef::Bundled(name) => {
            let root = roots.get(1).ok_or_else(not_found)?;
            (root, root.join(name))
        }
    };
    let canonical = match std::fs::canonicalize(&dir) {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(not_found()),
        Err(error) => {
            return Err(PetError::new(
                PetRule::PackIo,
                format!("The pack folder could not be read: {error}"),
            ));
        }
    };
    let inside = std::fs::canonicalize(root).is_ok_and(|root| canonical.starts_with(root));
    if !inside {
        return Err(PetError::new(
            PetRule::PackOutsideRoot,
            "The pack folder is outside Videorc's Golem storage.",
        ));
    }
    if !canonical.is_dir() {
        return Err(not_found());
    }
    Ok(canonical)
}

/// One file of a pack folder: a regular file (never a link), at most `cap`
/// bytes, refused (not truncated) when it grew after it was sized. `None`
/// when it does not exist.
fn read_pack_file(dir: &Path, name: &str, cap: u64) -> Result<Option<Vec<u8>>, PetError> {
    use std::io::Read as _;
    let path = dir.join(name);
    let io_error = |error: std::io::Error| {
        PetError::new(
            PetRule::PackIo,
            format!("{name} could not be read: {error}"),
        )
    };
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    if !metadata.file_type().is_file() {
        return Err(PetError::new(
            PetRule::PackIo,
            format!("{name} is not a regular file."),
        ));
    }
    let too_large = || {
        PetError::new(
            PetRule::FileSize,
            format!("{name} is too large. Keep each pack file under 32 MB."),
        )
    };
    if metadata.len() > cap {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(&path)
        .map_err(io_error)?
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > cap {
        return Err(too_large());
    }
    Ok(Some(bytes))
}

/// The format of a sheet by its bytes: PNG or WebP only (D1).
fn sheet_format(name: &str, bytes: &[u8]) -> Result<image::ImageFormat, PetError> {
    match image::guess_format(bytes) {
        Ok(format @ (image::ImageFormat::Png | image::ImageFormat::WebP)) => Ok(format),
        _ => Err(PetError::new(
            PetRule::SheetFormat,
            format!("{name} is not a PNG or WebP image."),
        )),
    }
}

/// The decoder limits every sheet decode uses (D4).
fn sheet_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(GOLEM_PET_SHEET_MAX_SIDE);
    limits.max_image_height = Some(GOLEM_PET_SHEET_MAX_SIDE);
    limits.max_alloc = Some(GOLEM_PET_DECODED_MAX_BYTES);
    limits
}

fn sheet_reader<'a>(
    name: &str,
    bytes: &'a [u8],
) -> Result<image::ImageReader<std::io::Cursor<&'a [u8]>>, PetError> {
    let format = sheet_format(name, bytes)?;
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    reader.limits(sheet_limits());
    Ok(reader)
}

/// A sheet's size from its header, before any pixel is decoded.
fn sheet_dimensions(name: &str, bytes: &[u8]) -> Result<(u32, u32), PetError> {
    sheet_reader(name, bytes)?
        .into_dimensions()
        .map_err(|error| {
            PetError::new(
                PetRule::SheetDecode,
                format!("{name} could not be read: {error}"),
            )
        })
}

/// A sheet decoded to RGBA, bounded by [`sheet_limits`].
fn decode_sheet(name: &str, bytes: &[u8]) -> Result<image::RgbaImage, PetError> {
    Ok(sheet_reader(name, bytes)?
        .decode()
        .map_err(|error| {
            PetError::new(
                PetRule::SheetDecode,
                format!("{name} could not be decoded: {error}"),
            )
        })?
        .into_rgba8())
}

/// The talk ids a pack has among `talk-a`, `talk-b` (D1: the sidecar an
/// import writes).
fn talk_ids_present(manifest: &PetManifest) -> Vec<String> {
    GOLEM_PET_TALK_IDS
        .iter()
        .filter(|id| manifest.has_reaction(id))
        .map(|id| id.to_string())
        .collect()
}

/// The sidecar a pack without `golem.json` gets (D1): `page-pet-import`,
/// `headTop` measured, the talk ids present.
pub fn import_sidecar(
    manifest: &PetManifest,
    sheets: &BTreeMap<String, image::RgbaImage>,
    created_at: Option<String>,
) -> PetSidecar {
    PetSidecar {
        version: GOLEM_PET_SIDECAR_VERSION,
        source: PetSource::PagePetImport,
        head_top: measure_head_top(manifest, sheets).unwrap_or(0.0),
        talk: talk_ids_present(manifest),
        created_at,
        reference_sha256: None,
    }
}

/// A pack decoded into memory: the validated manifest, its sidecar and every
/// sheet as RGBA. Built once per pack (or persona) change, never per frame;
/// callers run the load in `spawn_blocking`.
#[derive(Debug, Clone)]
pub struct LoadedPack {
    /// A uuid, `bundled:<name>`, or `still` for [`still_pack`].
    pub pack_id: String,
    pub manifest: PetManifest,
    pub sidecar: PetSidecar,
    /// Sheet name to decoded pixels; every frame's sheet is here.
    #[allow(dead_code)] // Phase B pre-scales these into the sprite slot.
    pub sheets: BTreeMap<String, image::RgbaImage>,
    /// Plain sentences about fallbacks taken while loading (a missing
    /// sidecar, a state image that did not decode), for the log.
    #[allow(dead_code)] // Phase B logs them when it loads the active pack.
    pub notes: Vec<String>,
    /// `golem.json` was read from the folder (false when it was measured).
    pub sidecar_on_disk: bool,
}

impl LoadedPack {
    pub fn summary(&self) -> GolemPetSummary {
        summarize(&self.pack_id, &self.manifest, &self.sidecar)
    }

    /// RGBA bytes resident for this pack.
    #[allow(dead_code)] // Phase B's atlas budget (D5).
    pub fn decoded_bytes(&self) -> u64 {
        self.sheets
            .values()
            .map(|sheet| u64::from(sheet.width()) * u64::from(sheet.height()) * 4)
            .sum()
    }
}

/// Read, validate and decode the pack in `dir`: `manifest.json` (S-A1 rules),
/// every sheet it names (PNG or WebP by their bytes, 32 MB each, 128 MB for
/// the pack, dimensions checked from the headers before any decode, decoded
/// under [`sheet_limits`]), the per-cell transparency check, and `golem.json`
/// when present (measured otherwise). Blocking: run it in `spawn_blocking`.
pub fn load_pack_dir(dir: &Path, pack_id: &str) -> Result<LoadedPack, PetError> {
    let manifest_bytes = read_pack_file(dir, GOLEM_PET_MANIFEST_FILE, GOLEM_PET_JSON_MAX_BYTES)?
        .ok_or_else(|| {
            PetError::new(
                PetRule::PackNotFound,
                "The pack folder has no manifest.json.",
            )
        })?;
    let manifest = parse_manifest(&manifest_bytes)?;
    let mut total = manifest_bytes.len() as u64;

    let mut encoded: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut sizes = BTreeMap::new();
    for name in manifest.sheet_names() {
        let bytes = read_pack_file(dir, &name, GOLEM_PET_FILE_MAX_BYTES)?.ok_or_else(|| {
            PetError::new(
                PetRule::SheetMissing,
                format!("{name} is missing. Choose the whole pack folder."),
            )
        })?;
        total += bytes.len() as u64;
        if total > GOLEM_PET_PACK_MAX_BYTES {
            return Err(PetError::new(
                PetRule::PackSize,
                "The pack is too large. Keep the pack under 128 MB.",
            ));
        }
        sizes.insert(name.clone(), sheet_dimensions(&name, &bytes)?);
        encoded.insert(name, bytes);
    }
    validate_sheet_sizes(&manifest, &sizes)?;

    let mut sheets = BTreeMap::new();
    for (name, bytes) in encoded {
        let sheet = decode_sheet(&name, &bytes)?;
        drop(bytes);
        sheets.insert(name, sheet);
    }
    validate_images(&manifest, &sheets)?;

    let mut notes = Vec::new();
    let sidecar_bytes = read_pack_file(dir, GOLEM_PET_SIDECAR_FILE, GOLEM_PET_JSON_MAX_BYTES)?;
    let sidecar_on_disk = sidecar_bytes.is_some();
    let sidecar = match sidecar_bytes {
        Some(bytes) => parse_sidecar(&bytes, &manifest)?,
        None => {
            notes.push(format!(
                "Pack {pack_id} has no golem.json; its head top was measured."
            ));
            import_sidecar(&manifest, &sheets, None)
        }
    };
    Ok(LoadedPack {
        pack_id: pack_id.to_string(),
        manifest,
        sidecar,
        sheets,
        notes,
        sidecar_on_disk,
    })
}

/// Load a pack by id from the golem roots (`roots[0]` write, `roots[1]`
/// bundled): the active Alive pack for Phase B's sprite slot. Blocking: run
/// it in `spawn_blocking`.
#[allow(dead_code)] // Phase B loads the active Alive pack with this.
pub fn load_pack(
    roots: &[PathBuf],
    persona_id: &str,
    pack_id: &str,
) -> Result<LoadedPack, PetError> {
    load_pack_dir(&pack_dir(roots, persona_id, pack_id)?, pack_id)
}

/// One pack as the Golem tab lists it (`cohost.pet.list`, `cohost.pet.import`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GolemPetSummary {
    pub pack_id: String,
    pub name: String,
    /// The neutral cell's side in sheet pixels.
    pub cell_size: u32,
    pub gaze_count: u32,
    /// Reaction ids in manifest order.
    pub reactions: Vec<String>,
    pub source: PetSource,
    pub has_talk: bool,
}

pub fn summarize(pack_id: &str, manifest: &PetManifest, sidecar: &PetSidecar) -> GolemPetSummary {
    GolemPetSummary {
        pack_id: pack_id.to_string(),
        name: crate::cohost::truncate_utf16(manifest.name.trim(), GOLEM_PET_TEXT_MAX)
            .trim_end()
            .to_string(),
        cell_size: manifest
            .neutral_frame()
            .map(PetFrame::cell_size)
            .unwrap_or_default(),
        gaze_count: manifest.gaze_count() as u32,
        reactions: manifest.reaction_ids(),
        source: sidecar.source,
        has_talk: !sidecar.talk.is_empty(),
    }
}

/// Write `golem.json` into a pack folder: staged, then moved into place.
fn write_sidecar(dir: &Path, sidecar: &PetSidecar) -> Result<(), PetError> {
    let io_error = |error: std::io::Error| {
        PetError::new(
            PetRule::PackIo,
            format!("golem.json could not be written: {error}"),
        )
    };
    let bytes = serde_json::to_vec_pretty(sidecar).map_err(|error| {
        PetError::new(
            PetRule::PackIo,
            format!("golem.json could not be written: {error}"),
        )
    })?;
    let staged = dir.join(format!("{GOLEM_PET_SIDECAR_FILE}.tmp"));
    std::fs::write(&staged, bytes).map_err(io_error)?;
    crate::atomic_file::replace_file(&staged, &dir.join(GOLEM_PET_SIDECAR_FILE)).map_err(|error| {
        let _ = std::fs::remove_file(&staged);
        io_error(error)
    })
}

/// Import a pack main copied to `<write root>/<personaId>/pets/<packId>/`
/// (S-A3): validate and decode it (see [`load_pack_dir`]), write `golem.json`
/// when it has none (D1), and return its summary. Blocking: run it in
/// `spawn_blocking`. Main removes the folder on any refusal.
pub fn import_pack(
    roots: &[PathBuf],
    persona_id: &str,
    pack_id: &str,
    created_at: String,
) -> Result<GolemPetSummary, PetError> {
    if !matches!(parse_pack_id(pack_id)?, PackRef::User(_)) {
        return Err(PetError::new(
            PetRule::PackId,
            "Only a copied pack folder can be imported.",
        ));
    }
    let dir = pack_dir(roots, persona_id, pack_id)?;
    let mut pack = load_pack_dir(&dir, pack_id)?;
    if !pack.sidecar_on_disk {
        pack.sidecar.created_at = Some(created_at);
        write_sidecar(&dir, &pack.sidecar)?;
    }
    Ok(pack.summary())
}

/// The manifest and sidecar of a pack folder, no pixels: what the list and
/// the reaction check need.
pub fn read_pack_manifest(dir: &Path) -> Result<(PetManifest, Option<PetSidecar>), PetError> {
    let bytes = read_pack_file(dir, GOLEM_PET_MANIFEST_FILE, GOLEM_PET_JSON_MAX_BYTES)?
        .ok_or_else(|| {
            PetError::new(
                PetRule::PackNotFound,
                "The pack folder has no manifest.json.",
            )
        })?;
    let manifest = parse_manifest(&bytes)?;
    let sidecar = read_pack_file(dir, GOLEM_PET_SIDECAR_FILE, GOLEM_PET_JSON_MAX_BYTES)?
        .map(|bytes| parse_sidecar(&bytes, &manifest))
        .transpose()?;
    Ok((manifest, sidecar))
}

/// A pack folder's summary and its sidecar's `createdAt`, no pixels. A pack
/// without `golem.json` lists with the talk ids it has.
fn summarize_dir(dir: &Path, pack_id: &str) -> Result<(Option<String>, GolemPetSummary), PetError> {
    let (manifest, sidecar) = read_pack_manifest(dir)?;
    let sidecar = sidecar.unwrap_or_else(|| PetSidecar {
        version: GOLEM_PET_SIDECAR_VERSION,
        source: PetSource::PagePetImport,
        head_top: 0.0,
        talk: talk_ids_present(&manifest),
        created_at: None,
        reference_sha256: None,
    });
    Ok((
        sidecar.created_at.clone(),
        summarize(pack_id, &manifest, &sidecar),
    ))
}

/// The packs a persona can wear (`cohost.pet.list`): every bundled pack
/// (sorted by name), then the persona's own (oldest first). Manifests and
/// sidecars only, no pixels. A folder that fails its manifest or sidecar is
/// left out and named in the second list (for the log). Blocking.
pub fn list_packs(roots: &[PathBuf], persona_id: &str) -> (Vec<GolemPetSummary>, Vec<String>) {
    let mut packs = Vec::new();
    let mut skipped = Vec::new();
    let mut folders: Vec<String> = Vec::new();
    if let Some(bundled) = roots.get(1)
        && let Ok(entries) = std::fs::read_dir(bundled)
    {
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .collect();
        names.sort();
        folders.extend(
            names
                .into_iter()
                .map(|name| format!("{GOLEM_BUNDLED_PACK_PREFIX}{name}")),
        );
    }
    let mut own: Vec<(Option<String>, GolemPetSummary)> = Vec::new();
    if persona_id_ok(persona_id)
        && let Some(write) = roots.first()
        && let Ok(entries) = std::fs::read_dir(write.join(persona_id).join("pets"))
    {
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            match pack_dir(roots, persona_id, &name).and_then(|dir| summarize_dir(&dir, &name)) {
                Ok(pack) => own.push(pack),
                Err(error) => skipped.push(format!("Golem pack {name} skipped: {error}")),
            }
        }
    }
    for pack_id in folders {
        match pack_dir(roots, persona_id, &pack_id).and_then(|dir| summarize_dir(&dir, &pack_id)) {
            Ok((_, summary)) => packs.push(summary),
            Err(error) => skipped.push(format!("Golem pack {pack_id} skipped: {error}")),
        }
    }
    own.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.pack_id.cmp(&b.1.pack_id)));
    packs.extend(own.into_iter().map(|(_, summary)| summary));
    (packs, skipped)
}

/// Delete one of the persona's own packs (`cohost.pet.remove`). Built-in
/// packs are never removed. Blocking.
pub fn remove_pack(roots: &[PathBuf], persona_id: &str, pack_id: &str) -> Result<(), PetError> {
    if matches!(parse_pack_id(pack_id)?, PackRef::Bundled(_)) {
        return Err(PetError::new(
            PetRule::PackId,
            "Built-in packs cannot be removed.",
        ));
    }
    let dir = pack_dir(roots, persona_id, pack_id)?;
    std::fs::remove_dir_all(&dir).map_err(|error| {
        PetError::new(
            PetRule::PackIo,
            format!("The pack could not be removed: {error}"),
        )
    })
}

// --- Persona wire (plan 168 Wire shape) -----------------------------------------

/// The Golem's avatar kind (D2): `still` renders the persona's state images
/// (as a flat pack, S-A4), `alive` a pet pack by id. A settings row from
/// before plan 168 loads as Still.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GolemAvatar {
    #[default]
    Still,
    Alive {
        #[serde(rename = "packId")]
        pack_id: String,
    },
}

/// The still pack's reaction ids: the persona's `talk`, `laugh` and `think`
/// state images (D2, S-A4).
pub const STILL_REACTION_IDS: [&str; 3] = ["talk", "laugh", "think"];

/// The avatar as the wire may carry it: an Alive pack id must be a uuid or
/// `bundled:<name>`. Whether the pack exists is checked where it is loaded.
pub fn validate_avatar(avatar: &GolemAvatar) -> Result<(), String> {
    match avatar {
        GolemAvatar::Still => Ok(()),
        GolemAvatar::Alive { pack_id } => parse_pack_id(pack_id)
            .map(|_| ())
            .map_err(|_| "The avatar's pack id is not a pack id.".to_string()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// One synthetic RGBA sheet: transparent, with an opaque square-ish
    /// silhouette drawn inside each listed cell (a body and a head bump), in
    /// a colour per cell.
    pub(crate) fn synthetic_sheet(width: u32, height: u32, cells: &[[u32; 4]]) -> image::RgbaImage {
        let mut sheet = image::RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 0]));
        for (index, [x, y, w, h]) in cells.iter().copied().enumerate() {
            let colour = image::Rgba([
                (40 + index * 37 % 200) as u8,
                (90 + index * 53 % 150) as u8,
                (160 + index * 29 % 90) as u8,
                255,
            ]);
            // Body: the middle half, from 40 % down to the bottom margin.
            for row in y + h * 2 / 5..y + h * 9 / 10 {
                for col in x + w / 4..x + w * 3 / 4 {
                    sheet.put_pixel(col, row, colour);
                }
            }
            // Head: a smaller block above it, its top at 20 %.
            for row in y + h / 5..y + h * 2 / 5 {
                for col in x + w * 3 / 8..x + w * 5 / 8 {
                    sheet.put_pixel(col, row, colour);
                }
            }
        }
        sheet
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../protocol-fixtures/golem-pet-manifests.json"
        ))
        .expect("the golem pet manifest fixture is valid JSON")
    }

    fn fixture_sizes(case: &Value) -> Option<BTreeMap<String, (u32, u32)>> {
        let sheets = case.get("sheets")?.as_object()?;
        Some(
            sheets
                .iter()
                .map(|(name, size)| {
                    let size = size.as_array().expect("sheet size is [w, h]");
                    (
                        name.clone(),
                        (
                            size[0].as_u64().expect("width") as u32,
                            size[1].as_u64().expect("height") as u32,
                        ),
                    )
                })
                .collect(),
        )
    }

    /// The shared fixture: every valid pack passes both validators, every
    /// failing case fails with exactly the rule it names, and every
    /// manifest-level rule has a case.
    #[test]
    fn golem_pet_shared_fixture_passes_and_names_every_rule() {
        let fixture = fixture();
        for case in fixture["valid"].as_array().expect("valid cases") {
            let name = case["name"].as_str().unwrap_or_default();
            let manifest = validate_manifest(&case["manifest"])
                .unwrap_or_else(|error| panic!("{name}: {error} ({:?})", error.rule));
            if let Some(sizes) = fixture_sizes(case) {
                validate_sheet_sizes(&manifest, &sizes)
                    .unwrap_or_else(|error| panic!("{name}: {error} ({:?})", error.rule));
            }
            if let Some(expected) = case.get("expect") {
                assert_eq!(
                    manifest.frames.len() as u64,
                    expected["frames"].as_u64().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    manifest.gaze_count() as u64,
                    expected["gaze"].as_u64().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    manifest.neutral,
                    expected["neutral"].as_str().unwrap(),
                    "{name}"
                );
            }
        }
        let mut covered = HashSet::new();
        for case in fixture["invalid"].as_array().expect("invalid cases") {
            let name = case["name"].as_str().unwrap_or_default();
            let rule = case["rule"]
                .as_str()
                .expect("every failing case names its rule");
            let outcome = validate_manifest(&case["manifest"]).and_then(|manifest| {
                let sizes = fixture_sizes(case)
                    .unwrap_or_else(|| panic!("{name}: passed the manifest rules without sheets"));
                validate_sheet_sizes(&manifest, &sizes)
            });
            let error = outcome.expect_err(name);
            assert_eq!(error.rule.as_str(), rule, "{name}: {error}");
            assert!(!error.message.is_empty(), "{name}");
            covered.insert(rule.to_string());
        }
        for rule in fixture["rules"].as_array().expect("rules") {
            let rule = rule.as_str().unwrap();
            assert!(covered.contains(rule), "no failing case for {rule}");
        }
    }

    #[test]
    fn golem_pet_rule_names_match_their_serde_names() {
        for rule in [
            PetRule::ManifestJson,
            PetRule::LegacyLayers,
            PetRule::SheetAvif,
            PetRule::CellTransparency,
            PetRule::PackOutsideRoot,
        ] {
            assert_eq!(
                serde_json::to_value(rule).unwrap(),
                Value::String(rule.as_str().to_string())
            );
        }
    }

    #[test]
    fn golem_pet_manifest_json_errors_name_their_rule() {
        let error = parse_manifest(b"{ not json").unwrap_err();
        assert_eq!(error.rule, PetRule::ManifestJson);
    }

    fn manifest_with(frames: Value) -> PetManifest {
        validate_manifest(&serde_json::json!({
            "version": 1,
            "name": "Synthetic",
            "neutral": "center",
            "frames": frames
        }))
        .unwrap()
    }

    #[test]
    fn golem_pet_images_need_transparency_and_a_character_per_cell() {
        let manifest = manifest_with(serde_json::json!([
            { "id": "center", "kind": "gaze", "gaze": [0, 0], "sheet": "a.png", "rect": [0, 0, 128, 128] },
            { "id": "laugh", "kind": "reaction", "sheet": "a.png", "rect": [128, 0, 128, 128] }
        ]));
        let cells = [[0, 0, 128, 128], [128, 0, 128, 128]];
        let mut sheets = BTreeMap::from([("a.png".to_string(), synthetic_sheet(256, 128, &cells))]);
        validate_images(&manifest, &sheets).unwrap();
        assert_eq!(measure_head_top(&manifest, &sheets), Some(0.1953));

        // An opaque background behind the reaction cell.
        let sheet = sheets.get_mut("a.png").unwrap();
        for row in 0..128 {
            for col in 128..256 {
                let pixel = sheet.get_pixel_mut(col, row);
                pixel[3] = 255;
            }
        }
        let error = validate_images(&manifest, &sheets).unwrap_err();
        assert_eq!(error.rule, PetRule::CellTransparency);
        assert!(error.message.contains("laugh"), "{error}");

        // An empty neutral cell.
        let sheets = BTreeMap::from([(
            "a.png".to_string(),
            synthetic_sheet(256, 128, &[[128, 0, 128, 128]]),
        )]);
        let error = validate_images(&manifest, &sheets).unwrap_err();
        assert_eq!(error.rule, PetRule::CellTransparency);
        assert_eq!(measure_head_top(&manifest, &sheets), None);

        // A sheet smaller than the rects.
        let sheets = BTreeMap::from([(
            "a.png".to_string(),
            synthetic_sheet(200, 128, &[[0, 0, 128, 128]]),
        )]);
        assert_eq!(
            validate_images(&manifest, &sheets).unwrap_err().rule,
            PetRule::FrameOutsideSheet
        );
    }

    #[test]
    fn golem_pet_sidecar_bounds() {
        let manifest = manifest_with(serde_json::json!([
            { "id": "center", "kind": "gaze", "gaze": [0, 0], "sheet": "a.png", "rect": [0, 0, 128, 128] },
            { "id": "talk-a", "kind": "reaction", "sheet": "a.png", "rect": [128, 0, 128, 128] }
        ]));
        let sidecar = parse_sidecar(
            br#"{"version":1,"source":"videorc-creator","headTop":0.18,"talk":["talk-a"],"createdAt":"2026-10-20T12:00:00Z","referenceSha256":"0000000000000000000000000000000000000000000000000000000000000000"}"#,
            &manifest,
        )
        .unwrap();
        assert_eq!(sidecar.source, PetSource::VideorcCreator);
        assert_eq!(sidecar.talk, vec!["talk-a".to_string()]);
        let wire = serde_json::to_value(&sidecar).unwrap();
        assert_eq!(wire["headTop"], 0.18);
        assert_eq!(wire["source"], "videorc-creator");

        for bad in [
            r#"{"version":2,"source":"still","headTop":0.1}"#,
            r#"{"version":1,"source":"still","headTop":1.5}"#,
            r#"{"version":1,"source":"elsewhere","headTop":0.1}"#,
            r#"{"version":1,"source":"still","headTop":0.1,"talk":["talk-b"]}"#,
            r#"{"version":1,"source":"still","headTop":0.1,"talk":["center"]}"#,
            r#"{"version":1,"source":"still","headTop":0.1,"talk":["talk-a","talk-a"]}"#,
            r#"{"version":1,"source":"still","headTop":0.1,"referenceSha256":"abc"}"#,
        ] {
            let error = parse_sidecar(bad.as_bytes(), &manifest).unwrap_err();
            assert_eq!(error.rule, PetRule::Sidecar, "{bad}");
        }
    }

    // --- Packs on disk (S-A3) -------------------------------------------------

    pub(crate) const PACK_ID: &str = "0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a";

    pub(crate) fn temp_roots() -> Vec<PathBuf> {
        let base = std::env::temp_dir().join(format!("videorc-golem-pet-{}", uuid::Uuid::new_v4()));
        let roots = vec![base.join("write"), base.join("bundled")];
        for root in &roots {
            std::fs::create_dir_all(root).unwrap();
        }
        roots
    }

    /// A small complete-character pack: two gaze cells and two reactions
    /// (`talk-a`, `laugh`) on one 512 × 128 sheet, drawn in code.
    pub(crate) fn synthetic_manifest(sheet: &str) -> Value {
        serde_json::json!({
            "version": 1,
            "name": "Synthetic Pip",
            "neutral": "center",
            "pivot": [0.5, 0.9],
            "frames": [
                { "id": "center", "kind": "gaze", "gaze": [0, 0], "sheet": sheet, "rect": [0, 0, 128, 128] },
                { "id": "left", "kind": "gaze", "gaze": [-1, 0], "sheet": sheet, "rect": [128, 0, 128, 128] },
                { "id": "talk-a", "kind": "reaction", "sheet": sheet, "rect": [256, 0, 128, 128] },
                { "id": "laugh", "kind": "reaction", "sheet": sheet, "rect": [384, 0, 128, 128] }
            ]
        })
    }

    /// Write `manifest` and a synthetic sheet (PNG or lossless WebP by its
    /// extension) into `dir`.
    pub(crate) fn write_pack(dir: &Path, manifest: &Value, sheet: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(GOLEM_PET_MANIFEST_FILE),
            serde_json::to_vec(manifest).unwrap(),
        )
        .unwrap();
        let cells = [
            [0, 0, 128, 128],
            [128, 0, 128, 128],
            [256, 0, 128, 128],
            [384, 0, 128, 128],
        ];
        let image = image::DynamicImage::ImageRgba8(synthetic_sheet(512, 128, &cells));
        let format = if sheet.ends_with(".webp") {
            image::ImageFormat::WebP
        } else {
            image::ImageFormat::Png
        };
        image.save_with_format(dir.join(sheet), format).unwrap();
    }

    fn user_dir(roots: &[PathBuf], id: &str) -> PathBuf {
        roots[0].join("persona-1").join("pets").join(id)
    }

    #[test]
    fn golem_pet_import_writes_the_sidecar_lists_loads_and_removes() {
        let roots = temp_roots();
        write_pack(
            &user_dir(&roots, PACK_ID),
            &synthetic_manifest("mascot.webp"),
            "mascot.webp",
        );
        write_pack(
            &roots[1].join("golem"),
            &synthetic_manifest("mascot.png"),
            "mascot.png",
        );

        let summary = import_pack(
            &roots,
            "persona-1",
            PACK_ID,
            "2026-10-08T12:00:00Z".to_string(),
        )
        .unwrap();
        assert_eq!(
            summary,
            GolemPetSummary {
                pack_id: PACK_ID.to_string(),
                name: "Synthetic Pip".to_string(),
                cell_size: 128,
                gaze_count: 2,
                reactions: vec!["talk-a".to_string(), "laugh".to_string()],
                source: PetSource::PagePetImport,
                has_talk: true,
            }
        );
        // D1: the sidecar is written with the measured head top.
        let sidecar: Value = serde_json::from_slice(
            &std::fs::read(user_dir(&roots, PACK_ID).join(GOLEM_PET_SIDECAR_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            sidecar,
            serde_json::json!({
                "version": 1,
                "source": "page-pet-import",
                "headTop": 0.1953,
                "talk": ["talk-a"],
                "createdAt": "2026-10-08T12:00:00Z"
            })
        );
        // A second import of the same folder keeps the sidecar it has.
        import_pack(
            &roots,
            "persona-1",
            PACK_ID,
            "2027-01-01T00:00:00Z".to_string(),
        )
        .unwrap();
        let again = read_pack_manifest(&user_dir(&roots, PACK_ID))
            .unwrap()
            .1
            .unwrap();
        assert_eq!(again.created_at.as_deref(), Some("2026-10-08T12:00:00Z"));

        let (packs, skipped) = list_packs(&roots, "persona-1");
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(
            packs
                .iter()
                .map(|pack| pack.pack_id.as_str())
                .collect::<Vec<_>>(),
            vec!["bundled:golem", PACK_ID]
        );
        // Another persona sees the bundled pack only.
        assert_eq!(list_packs(&roots, "persona-2").0.len(), 1);

        let loaded = load_pack(&roots, "persona-1", PACK_ID).unwrap();
        assert!(loaded.sidecar_on_disk);
        assert_eq!(loaded.sheets["mascot.webp"].dimensions(), (512, 128));
        assert_eq!(loaded.decoded_bytes(), 512 * 128 * 4);
        let bundled = load_pack(&roots, "anyone", "bundled:golem").unwrap();
        assert!(!bundled.sidecar_on_disk);
        assert_eq!(bundled.sidecar.head_top, 0.1953);
        assert_eq!(bundled.notes.len(), 1);

        assert_eq!(
            remove_pack(&roots, "persona-1", "bundled:golem")
                .unwrap_err()
                .rule,
            PetRule::PackId
        );
        remove_pack(&roots, "persona-1", PACK_ID).unwrap();
        assert!(!user_dir(&roots, PACK_ID).exists());
        assert_eq!(
            load_pack(&roots, "persona-1", PACK_ID).unwrap_err().rule,
            PetRule::PackNotFound
        );
        let _ = std::fs::remove_dir_all(roots[0].parent().unwrap());
    }

    /// Every refusal path an import can hit, each with its rule.
    #[test]
    fn golem_pet_import_refuses_layered_avif_and_broken_packs() {
        let roots = temp_roots();
        let import =
            |id: &str| import_pack(&roots, "persona-1", id, "2026-10-08T12:00:00Z".to_string());
        let ids: Vec<String> = (0..12).map(|_| uuid::Uuid::new_v4().to_string()).collect();

        // A legacy two-layer pack.
        let mut layered = synthetic_manifest("mascot.png");
        layered["layers"] =
            serde_json::json!({ "size": 128, "neck": [0.5, 0.4], "bodyFrames": [] });
        write_pack(&user_dir(&roots, &ids[0]), &layered, "mascot.png");
        let error = import(&ids[0]).unwrap_err();
        assert_eq!(error.rule, PetRule::LegacyLayers, "{error}");
        assert!(error.message.contains("Two-layer packs"), "{error}");

        // An AVIF sheet.
        write_pack(
            &user_dir(&roots, &ids[1]),
            &synthetic_manifest("mascot.avif"),
            "mascot.png",
        );
        let error = import(&ids[1]).unwrap_err();
        assert_eq!(error.rule, PetRule::SheetAvif, "{error}");
        assert!(error.message.contains("AVIF"), "{error}");

        // A missing sheet.
        write_pack(
            &user_dir(&roots, &ids[2]),
            &synthetic_manifest("other.png"),
            "mascot.png",
        );
        assert_eq!(import(&ids[2]).unwrap_err().rule, PetRule::SheetMissing);

        // A sheet whose bytes are not PNG or WebP.
        write_pack(
            &user_dir(&roots, &ids[3]),
            &synthetic_manifest("mascot.png"),
            "mascot.png",
        );
        std::fs::write(
            user_dir(&roots, &ids[3]).join("mascot.png"),
            b"GIF89a not a png",
        )
        .unwrap();
        assert_eq!(import(&ids[3]).unwrap_err().rule, PetRule::SheetFormat);

        // An opaque background.
        let dir = user_dir(&roots, &ids[4]);
        write_pack(&dir, &synthetic_manifest("mascot.png"), "mascot.png");
        image::RgbaImage::from_pixel(512, 128, image::Rgba([10, 20, 30, 255]))
            .save_with_format(dir.join("mascot.png"), image::ImageFormat::Png)
            .unwrap();
        assert_eq!(import(&ids[4]).unwrap_err().rule, PetRule::CellTransparency);

        // A file over 32 MB (sparse; nothing is decoded).
        let dir = user_dir(&roots, &ids[5]);
        write_pack(&dir, &synthetic_manifest("mascot.png"), "mascot.png");
        std::fs::File::create(dir.join("mascot.png"))
            .unwrap()
            .set_len(GOLEM_PET_FILE_MAX_BYTES + 1)
            .unwrap();
        assert_eq!(import(&ids[5]).unwrap_err().rule, PetRule::FileSize);

        // A sheet smaller than its rects.
        let dir = user_dir(&roots, &ids[6]);
        write_pack(&dir, &synthetic_manifest("mascot.png"), "mascot.png");
        image::DynamicImage::ImageRgba8(synthetic_sheet(384, 128, &[[0, 0, 128, 128]]))
            .save_with_format(dir.join("mascot.png"), image::ImageFormat::Png)
            .unwrap();
        assert_eq!(
            import(&ids[6]).unwrap_err().rule,
            PetRule::FrameOutsideSheet
        );

        // A broken sidecar.
        let dir = user_dir(&roots, &ids[7]);
        write_pack(&dir, &synthetic_manifest("mascot.png"), "mascot.png");
        std::fs::write(
            dir.join(GOLEM_PET_SIDECAR_FILE),
            br#"{"version":1,"source":"x"}"#,
        )
        .unwrap();
        assert_eq!(import(&ids[7]).unwrap_err().rule, PetRule::Sidecar);

        // No manifest at all, an unknown id, a bundled id.
        std::fs::create_dir_all(user_dir(&roots, &ids[8])).unwrap();
        assert_eq!(import(&ids[8]).unwrap_err().rule, PetRule::PackNotFound);
        assert_eq!(import(&ids[9]).unwrap_err().rule, PetRule::PackNotFound);
        assert_eq!(import("bundled:golem").unwrap_err().rule, PetRule::PackId);
        assert_eq!(import("../escape").unwrap_err().rule, PetRule::PackId);
        assert_eq!(
            import(&PACK_ID.to_uppercase()).unwrap_err().rule,
            PetRule::PackId
        );

        // A pack folder that is a link to a folder outside the roots.
        #[cfg(unix)]
        {
            let outside = roots[0].parent().unwrap().join("outside");
            write_pack(&outside, &synthetic_manifest("mascot.png"), "mascot.png");
            std::os::unix::fs::symlink(&outside, user_dir(&roots, &ids[10])).unwrap();
            assert_eq!(import(&ids[10]).unwrap_err().rule, PetRule::PackOutsideRoot);
            // A sheet that is a link is never read either.
            let dir = user_dir(&roots, &ids[11]);
            write_pack(&dir, &synthetic_manifest("mascot.png"), "mascot.png");
            std::fs::remove_file(dir.join("mascot.png")).unwrap();
            std::os::unix::fs::symlink(outside.join("mascot.png"), dir.join("mascot.png")).unwrap();
            assert_eq!(import(&ids[11]).unwrap_err().rule, PetRule::PackIo);
        }

        // Nothing refused was given a sidecar.
        for id in &ids[..8] {
            assert!(!user_dir(&roots, id).join(GOLEM_PET_SIDECAR_FILE).exists() || id == &ids[7]);
        }
        // The list reads manifests and sidecars only (main removes a refused
        // copy): it skips the folders those refuse, and names them.
        let (packs, skipped) = list_packs(&roots, "persona-1");
        for id in [&ids[0], &ids[1], &ids[7], &ids[8]] {
            assert!(packs.iter().all(|pack| &pack.pack_id != id), "{id}");
            assert!(
                skipped.iter().any(|note| note.contains(id.as_str())),
                "{skipped:?}"
            );
        }
        let _ = std::fs::remove_dir_all(roots[0].parent().unwrap());
    }

    #[test]
    fn golem_pet_pack_ids_are_uuids_or_bundled_names() {
        assert_eq!(
            parse_pack_id(PACK_ID).unwrap(),
            PackRef::User(PACK_ID.to_string())
        );
        assert_eq!(
            parse_pack_id("bundled:golem").unwrap(),
            PackRef::Bundled("golem".to_string())
        );
        for bad in [
            "",
            "bundled:",
            "bundled:Golem",
            "bundled:../x",
            "{0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a}",
            "0b1e9f0e6c8a4c559a3f3f6d2b1c4e5a",
            "urn:uuid:0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a",
        ] {
            assert_eq!(
                parse_pack_id(bad).unwrap_err().rule,
                PetRule::PackId,
                "{bad}"
            );
        }
        assert_eq!(
            pack_dir(&temp_roots(), "../x", PACK_ID).unwrap_err().rule,
            PetRule::PackId
        );
    }
}
