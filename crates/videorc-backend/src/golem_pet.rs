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
}
