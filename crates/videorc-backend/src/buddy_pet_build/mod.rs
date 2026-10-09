//! Golem pet builder (plan 168, Phase F slices S-F1 to S-F3): turns the
//! generated sheets of one creation into a page-pet pack on disk.
//!
//! Inputs are the sheet set of decision D18: five 5 x 1 gaze strips
//! (`up2`, `up1`, `level`, `down1`, `down2`), two 3 x 2 reaction sheets,
//! one 3 x 1 extras strip (`talk-a`, `talk-b`, `wave`), each a transparent
//! PNG with its SHA-256, plus the reference image and, optionally, the
//! pilot (recorded in the provenance, never packed). The pipeline:
//!
//! 1. [`cut`]: adaptive alpha gutters (S-F1). When a sheet has no gutter,
//!    [`isolate`] separates the characters by connected components (S-F2)
//!    and the cut runs on the separated sheet.
//! 2. [`register`]: foot anchor, one scale per sheet (`neutral-height` for
//!    gaze strips from the strip's middle cell, `full-height` for reactions
//!    and extras within 0.75 to 1.55 of the neutral), margins, resample,
//!    drift checks (S-F3).
//! 3. [`pack`]: duplicate rejection by pixel hash, the row-major atlas
//!    (gaze rows `up2` to `down2`, then `reactions-a`, `reactions-b`,
//!    `extras`), lossless WebP, `manifest.json` (page-pet v1),
//!    `buddy.json`, and the [`report`] files.
//!
//! Every rejection is a [`BuildError`] that names the sheet, the cell and
//! the reason in words the wizard can show. Mechanical checks never
//! approve art: the review gate of D21 stays with the user.
//!
//! Ported from page-pet (MIT, copyright 2026 Cristian): the `cuts` and
//! `inspect` box loop of `scripts/prepare_layout.py`, `isolate` of
//! `scripts/isolate_strip.py` (ownership by nearest bounding box with a
//! 24 px limit instead of a distance transform, per plan S-F2), and
//! `body_metrics`, the box checks of `extract`, the per-frame loop of
//! `compile_pack` and the `--single-atlas` tail of `main` in
//! `scripts/build_pack.py`. Credit lives in `docs/third-party/page-pet.md`
//! (D6).

mod cut;
mod isolate;
mod pack;
mod register;
mod report;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use image::RgbaImage;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use cut::SourceBox;
#[cfg(test)]
use isolate::LOOSE_PIECE_JOIN_PX;
pub use pack::{ATLAS_FILE, MANIFEST_FILE, PROVENANCE_FILE, REPORT_FILE, SIDECAR_FILE};
#[cfg(test)]
use register::{MAX_ROOT_DRIFT_BOTTOM_PX, MAX_ROOT_DRIFT_X_PX, MIN_MARGIN_PX};
pub use report::{BuildReport, CellReport, NeutralReport, Provenance};

use crate::buddy_pet::{
    BUDDY_PET_SIDECAR_VERSION, PetFrameKind, PetManifest, PetSidecar, PetSource,
};
use isolate::IsolateFailure;
use register::{ExtractFailure, ExtractedCell, RegisterFailure, Registration};

/// Cell size of a created pack (D4: 640 px, as page-pet).
pub const DEFAULT_CELL_SIZE: u32 = 640;
/// D4 cell bounds.
pub const MIN_CELL_SIZE: u32 = 128;
pub const MAX_CELL_SIZE: u32 = 1024;
/// D4 sheet bound on each side.
pub const MAX_SHEET_DIMENSION: u32 = 8192;
/// The neutral's height as a fraction of the cell (page-pet `--occupancy`).
pub const OCCUPANCY: f64 = 0.65;
/// A pixel is visible when its alpha is above this (page-pet's `> 16`).
pub(crate) const VISIBLE_ALPHA: u8 = 16;
/// `full-height` bounds for reaction and extras cells relative to the
/// neutral (page-pet rejects outside `.75..=1.55`).
pub const FULL_HEIGHT_RATIO_MIN: f64 = 0.75;
pub const FULL_HEIGHT_RATIO_MAX: f64 = 1.55;

pub const REACTIONS_A: [&str; 6] = ["laugh", "surprised", "wink", "kiss", "blink", "sleep"];
pub const REACTIONS_B: [&str; 6] = ["worried", "annoyed", "proud", "confused", "excited", "calm"];
pub const EXTRAS: [&str; 3] = ["talk-a", "talk-b", "wave"];
pub const PILOT_CELLS: [&str; 4] = ["neutral", "left", "right", "laugh"];
/// The talk ids the animator cycles (D12), in order.
pub const TALK_IDS: [&str; 2] = ["talk-a", "talk-b"];
/// The neutral of every created pack: the front cell of the level strip.
pub const NEUTRAL_ID: &str = "gaze-2-2";

/// One pitch row of the 5 x 5 gaze grid, top to bottom.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GazeRow {
    Up2,
    Up1,
    Level,
    Down1,
    Down2,
}

impl GazeRow {
    /// Row index in the atlas and in the gaze ids (`gaze-<col>-<row>`).
    pub fn index(self) -> usize {
        match self {
            GazeRow::Up2 => 0,
            GazeRow::Up1 => 1,
            GazeRow::Level => 2,
            GazeRow::Down1 => 3,
            GazeRow::Down2 => 4,
        }
    }

    /// page-pet gaze y: negative is up.
    pub fn gaze_y(self) -> f64 {
        gaze_coordinate(self.index(), 5)
    }
}

/// `round(index / (count - 1) * 2 - 1, 4)`, page-pet's row-major gaze
/// coordinates (exact for five cells: -1, -0.5, 0, 0.5, 1).
fn gaze_coordinate(index: usize, count: usize) -> f64 {
    if count <= 1 {
        0.0
    } else {
        let value = index as f64 / (count - 1) as f64 * 2.0 - 1.0;
        (value * 10_000.0).round_ties_even() / 10_000.0
    }
}

/// Which generated sheet a file is (D18).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SheetKind {
    /// 2 x 2: neutral, left, right, laugh. Provenance only; never packed.
    Pilot,
    /// 5 x 1: left profile to right profile at one pitch.
    Gaze { row: GazeRow },
    /// 3 x 2: laugh, surprised, wink, kiss, blink, sleep.
    ReactionsA,
    /// 3 x 2: worried, annoyed, proud, confused, excited, calm.
    ReactionsB,
    /// 3 x 1: talk-a, talk-b, wave.
    Extras,
}

impl SheetKind {
    /// The sheets of a pack in atlas order.
    pub const ATLAS_ORDER: [SheetKind; 8] = [
        SheetKind::Gaze { row: GazeRow::Up2 },
        SheetKind::Gaze { row: GazeRow::Up1 },
        SheetKind::Gaze {
            row: GazeRow::Level,
        },
        SheetKind::Gaze {
            row: GazeRow::Down1,
        },
        SheetKind::Gaze {
            row: GazeRow::Down2,
        },
        SheetKind::ReactionsA,
        SheetKind::ReactionsB,
        SheetKind::Extras,
    ];

    /// `(columns, rows)` of the generated layout.
    pub fn grid(self) -> (usize, usize) {
        match self {
            SheetKind::Pilot => (2, 2),
            SheetKind::Gaze { .. } => (5, 1),
            SheetKind::ReactionsA | SheetKind::ReactionsB => (3, 2),
            SheetKind::Extras => (3, 1),
        }
    }

    /// The sheet key used in errors, reports and provenance.
    pub fn key(self) -> &'static str {
        match self {
            SheetKind::Pilot => "pilot",
            SheetKind::Gaze { row: GazeRow::Up2 } => "gaze-up2",
            SheetKind::Gaze { row: GazeRow::Up1 } => "gaze-up1",
            SheetKind::Gaze {
                row: GazeRow::Level,
            } => "gaze-level",
            SheetKind::Gaze {
                row: GazeRow::Down1,
            } => "gaze-down1",
            SheetKind::Gaze {
                row: GazeRow::Down2,
            } => "gaze-down2",
            SheetKind::ReactionsA => "reactions-a",
            SheetKind::ReactionsB => "reactions-b",
            SheetKind::Extras => "extras",
        }
    }

    /// Row-major cell labels: frame ids for atlas sheets, pose names for
    /// the pilot.
    pub fn cell_labels(self) -> Vec<String> {
        match self {
            SheetKind::Pilot => PILOT_CELLS.iter().map(|s| s.to_string()).collect(),
            SheetKind::Gaze { row } => (0..5).map(|col| gaze_id(col, row)).collect(),
            SheetKind::ReactionsA => REACTIONS_A.iter().map(|s| s.to_string()).collect(),
            SheetKind::ReactionsB => REACTIONS_B.iter().map(|s| s.to_string()).collect(),
            SheetKind::Extras => EXTRAS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// `gaze-<col>-<row>` with page-pet's row-major ids.
pub fn gaze_id(col: usize, row: GazeRow) -> String {
    format!("gaze-{col}-{}", row.index())
}

/// page-pet gaze coordinates of a strip cell: x from -1 (viewer's left)
/// to 1, y from -1 (up) to 1.
pub fn gaze_point(col: usize, row: GazeRow) -> [f64; 2] {
    [gaze_coordinate(col, 5), row.gaze_y()]
}

/// A file the builder reads, bound to the bytes the user accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceFile {
    pub path: PathBuf,
    /// Lowercase hex SHA-256 of the file as generated.
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SheetInput {
    pub kind: SheetKind,
    pub path: PathBuf,
    /// Lowercase hex SHA-256 of the file as generated.
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct BuildInput {
    /// The pack name (manifest `name`); trimmed, must not be empty.
    pub name: String,
    pub reference: SourceFile,
    /// Recorded in the provenance when present; its cells never pack.
    pub pilot: Option<SheetInput>,
    /// Exactly one sheet of every kind in [`SheetKind::ATLAS_ORDER`], in
    /// any order.
    pub sheets: Vec<SheetInput>,
    /// [`DEFAULT_CELL_SIZE`] for real packs; tests use smaller cells.
    pub cell_size: u32,
    /// Written to `buddy.json` and `provenance.json`.
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuildStage {
    Reading,
    Cutting,
    Registering,
    Packing,
    Writing,
}

/// One progress tick: `done` of `total` steps are complete and `stage`
/// (for `sheet`, when it names one) is starting; the last tick reports
/// `done == total`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildStep {
    pub stage: BuildStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet: Option<&'static str>,
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BuildOutcome {
    pub out_dir: PathBuf,
    pub manifest: PetManifest,
    pub sidecar: PetSidecar,
    pub report: BuildReport,
    pub provenance: Provenance,
    pub atlas_width: u32,
    pub atlas_height: u32,
}

// The cut boxes of one sheet (`cut_preview`) are not on the wire: the
// wizard reviews the built atlas. Only the builder's tests read them today.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CutMethod {
    /// A clear alpha gutter on each side.
    AlphaGutters,
    /// The sheet had no gutter; the box is the character's owned pixels
    /// after connected-component separation, in the original sheet.
    Isolated,
}

/// One cell for the review UI, in the coordinates of the sheet file.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellBox {
    pub index: usize,
    pub label: String,
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
    pub method: CutMethod,
}

/// Why a build stopped. `Display` is the copy the wizard shows.
#[derive(Debug, Clone, PartialEq, thiserror::Error, Serialize)]
#[serde(
    tag = "code",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum BuildError {
    #[error("the pet needs a name")]
    NameEmpty,
    #[error(
        "the cell size must be between {} and {} px, not {cell_size}",
        MIN_CELL_SIZE,
        MAX_CELL_SIZE
    )]
    InvalidCellSize { cell_size: u32 },
    #[error("the {sheet} sheet is missing")]
    SheetMissing { sheet: String },
    #[error("the {sheet} sheet was supplied twice")]
    SheetDuplicated { sheet: String },
    #[error("the reference image could not be read: {reason}")]
    ReferenceUnreadable { reason: String },
    #[error("the reference image changed since this creation started; start over")]
    ReferenceChanged,
    #[error("{sheet}: the sheet could not be read: {reason}")]
    SheetUnreadable { sheet: String, reason: String },
    #[error(
        "{sheet}: the sheet is {width} x {height} px; the limit is {} px on each side",
        MAX_SHEET_DIMENSION
    )]
    SheetTooLarge {
        sheet: String,
        width: u32,
        height: u32,
    },
    #[error("{sheet}: the sheet changed since it was generated; generate it again")]
    SheetChanged { sheet: String },
    #[error("{sheet}: the sheet has no transparent background; generate it again")]
    SheetOpaque { sheet: String },
    #[error(
        "{sheet}: expected {expected} separate characters but found {found}; characters that touch count as one. Generate the sheet again"
    )]
    CharactersNotSeparable {
        sheet: String,
        expected: usize,
        found: usize,
    },
    #[error(
        "{sheet}: a loose piece of art sits {distance} px from the nearest character; the builder never drops pixels. Generate the sheet again"
    )]
    LoosePieces {
        sheet: String,
        distance: f64,
        bounds: [u32; 4],
    },
    #[error("{sheet}, {cell}: the cell is empty")]
    CellEmpty {
        sheet: String,
        cell: String,
        cell_index: usize,
    },
    #[error("{sheet}, {cell}: the cell has no transparent background")]
    CellOpaque {
        sheet: String,
        cell: String,
        cell_index: usize,
    },
    #[error(
        "{sheet}, {cell}: the character touches the edge of its cell, so the cut clipped it. Generate the sheet again"
    )]
    CellClipped {
        sheet: String,
        cell: String,
        cell_index: usize,
    },
    #[error("{sheet}, {cell}: no feet to stand on; the lower part of the character is empty")]
    CellNoFootBand {
        sheet: String,
        cell: String,
        cell_index: usize,
    },
    #[error(
        "{sheet}, {cell}: the character is {height_ratio} times the neutral's height; it must stay between 0.65 and 1.33. Generate the sheet again"
    )]
    ScaleOutOfRange {
        sheet: String,
        cell: String,
        cell_index: usize,
        height_ratio: f64,
    },
    #[error(
        "{sheet}, {cell}: the pose needs more room than the cell gives ({margin} px of margin, 8 needed); the builder never shrinks a pose. Generate the sheet again with the pose closer to the body"
    )]
    MarginTooSmall {
        sheet: String,
        cell: String,
        cell_index: usize,
        margin: f64,
    },
    #[error("{sheet}, {cell}: only {padding} px of clear padding after registration")]
    OutputPadding {
        sheet: String,
        cell: String,
        cell_index: usize,
        padding: i64,
    },
    #[error("{sheet}, {cell}: the feet moved {} px across and {} px down during registration; stray marks around the character cause this. Generate the sheet again", .drift[0], .drift[1])]
    RootDrift {
        sheet: String,
        cell: String,
        cell_index: usize,
        drift: [f64; 2],
    },
    #[error(
        "{sheet}, {cell}: identical to {other_sheet}, {other_cell}; every pose must be its own drawing"
    )]
    DuplicateCell {
        sheet: String,
        cell: String,
        cell_index: usize,
        other_sheet: String,
        other_cell: String,
    },
    #[error("could not write {}: {reason}", .path.display())]
    Write { path: PathBuf, reason: String },
    #[error("the builder hit an internal error: {reason}")]
    Internal { reason: String },
}

impl BuildError {
    /// The kebab-case code the wire carries (`cohost.pet.build.progress`
    /// `error`), matching the serde tag.
    pub fn code(&self) -> &'static str {
        match self {
            BuildError::NameEmpty => "name-empty",
            BuildError::InvalidCellSize { .. } => "invalid-cell-size",
            BuildError::SheetMissing { .. } => "sheet-missing",
            BuildError::SheetDuplicated { .. } => "sheet-duplicated",
            BuildError::ReferenceUnreadable { .. } => "reference-unreadable",
            BuildError::ReferenceChanged => "reference-changed",
            BuildError::SheetUnreadable { .. } => "sheet-unreadable",
            BuildError::SheetTooLarge { .. } => "sheet-too-large",
            BuildError::SheetChanged { .. } => "sheet-changed",
            BuildError::SheetOpaque { .. } => "sheet-opaque",
            BuildError::CharactersNotSeparable { .. } => "characters-not-separable",
            BuildError::LoosePieces { .. } => "loose-pieces",
            BuildError::CellEmpty { .. } => "cell-empty",
            BuildError::CellOpaque { .. } => "cell-opaque",
            BuildError::CellClipped { .. } => "cell-clipped",
            BuildError::CellNoFootBand { .. } => "cell-no-foot-band",
            BuildError::ScaleOutOfRange { .. } => "scale-out-of-range",
            BuildError::MarginTooSmall { .. } => "margin-too-small",
            BuildError::OutputPadding { .. } => "output-padding",
            BuildError::RootDrift { .. } => "root-drift",
            BuildError::DuplicateCell { .. } => "duplicate-cell",
            BuildError::Write { .. } => "write",
            BuildError::Internal { .. } => "internal",
        }
    }
}

/// Lowercase hex SHA-256, the digest every input and provenance uses.
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn round_to(value: f64, decimals: i32) -> f64 {
    let factor = 10f64.powi(decimals);
    (value * factor).round() / factor
}

fn read_verified(path: &Path, sha256: &str) -> Result<Vec<u8>, std::io::Error> {
    let bytes = std::fs::read(path)?;
    if sha256_hex(&bytes) != sha256.trim().to_ascii_lowercase() {
        return Err(std::io::Error::other("sha256 mismatch"));
    }
    Ok(bytes)
}

fn decode_sheet(key: &'static str, bytes: &[u8]) -> Result<RgbaImage, BuildError> {
    let unreadable = |reason: String| BuildError::SheetUnreadable {
        sheet: key.to_string(),
        reason,
    };
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| unreadable(error.to_string()))?
        .into_dimensions()
        .map_err(|error| unreadable(error.to_string()))?;
    if width > MAX_SHEET_DIMENSION || height > MAX_SHEET_DIMENSION {
        return Err(BuildError::SheetTooLarge {
            sheet: key.to_string(),
            width,
            height,
        });
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| unreadable(error.to_string()))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SHEET_DIMENSION);
    limits.max_image_height = Some(MAX_SHEET_DIMENSION);
    reader.limits(limits);
    Ok(reader
        .decode()
        .map_err(|error| unreadable(error.to_string()))?
        .into_rgba8())
}

fn load_sheet(input: &SheetInput) -> Result<RgbaImage, BuildError> {
    let key = input.kind.key();
    let bytes = match read_verified(&input.path, &input.sha256) {
        Ok(bytes) => bytes,
        Err(error) if error.to_string() == "sha256 mismatch" => {
            return Err(BuildError::SheetChanged {
                sheet: key.to_string(),
            });
        }
        Err(error) => {
            return Err(BuildError::SheetUnreadable {
                sheet: key.to_string(),
                reason: error.to_string(),
            });
        }
    };
    decode_sheet(key, &bytes)
}

/// A sheet after the cut: the image the boxes refer to (the original, or
/// the separated sheet) and, when separated, every character's owned
/// bounds in the original.
struct CutSheet {
    image: RgbaImage,
    boxes: Vec<SourceBox>,
    owned_bounds: Option<Vec<SourceBox>>,
}

fn cut_or_isolate(kind: SheetKind, image: RgbaImage) -> Result<CutSheet, BuildError> {
    let key = kind.key();
    if !cut::has_transparent_pixel(&image) {
        return Err(BuildError::SheetOpaque {
            sheet: key.to_string(),
        });
    }
    let (cols, rows) = kind.grid();
    let failure = match cut::cut_grid(&image, cols, rows) {
        Ok(boxes) => {
            return Ok(CutSheet {
                image,
                boxes,
                owned_bounds: None,
            });
        }
        Err(failure) => failure,
    };
    tracing::info!(
        sheet = key,
        axis = failure.axis.noun(),
        slot = failure.slot,
        "no alpha gutter near the boundary; separating the characters by connected components"
    );
    let isolated =
        isolate::isolate(&image, cols * rows, cols).map_err(|failure| match failure {
            IsolateFailure::TooFewCharacters { expected, found } => {
                BuildError::CharactersNotSeparable {
                    sheet: key.to_string(),
                    expected,
                    found,
                }
            }
            IsolateFailure::LoosePiece { distance, bounds } => BuildError::LoosePieces {
                sheet: key.to_string(),
                distance: round_to(distance, 1),
                bounds: bounds.as_array(),
            },
            IsolateFailure::PixelsLost => BuildError::Internal {
                reason: format!("{key}: the separated sheet lost pixels"),
            },
        })?;
    let boxes =
        cut::cut_grid(&isolated.image, cols, rows).map_err(|failure| BuildError::Internal {
            reason: format!(
                "{key}: the separated sheet has no gap between {} {} and {}",
                failure.axis.noun(),
                failure.slot,
                failure.slot + 1
            ),
        })?;
    Ok(CutSheet {
        image: isolated.image,
        boxes,
        owned_bounds: Some(isolated.owned_bounds),
    })
}

/// Cut one sheet for the review UI: row-major boxes in the coordinates of
/// the sheet file, labelled with their frame ids (pose names for the
/// pilot). Falls back to component separation exactly as the build does,
/// so a sheet that previews is a sheet that cuts.
#[cfg(test)]
pub fn cut_preview(sheet: &SheetInput) -> Result<Vec<CellBox>, BuildError> {
    let image = load_sheet(sheet)?;
    let cut = cut_or_isolate(sheet.kind, image)?;
    let labels = sheet.kind.cell_labels();
    let (boxes, method) = match cut.owned_bounds {
        Some(owned) => (owned, CutMethod::Isolated),
        None => (cut.boxes, CutMethod::AlphaGutters),
    };
    Ok(boxes
        .into_iter()
        .zip(labels)
        .enumerate()
        .map(|(index, (b, label))| CellBox {
            index,
            label,
            left: b.left,
            top: b.top,
            right: b.right,
            bottom: b.bottom,
            method,
        })
        .collect())
}

struct SheetCells {
    kind: SheetKind,
    sha256: String,
    cells: Vec<ExtractedCell>,
    owned_bounds: Option<Vec<SourceBox>>,
}

fn cell_error(
    kind: SheetKind,
    index: usize,
    make: impl FnOnce(String, String, usize) -> BuildError,
) -> BuildError {
    let label = kind
        .cell_labels()
        .get(index)
        .cloned()
        .unwrap_or_else(|| format!("cell {index}"));
    make(kind.key().to_string(), label, index)
}

fn extract_sheet(input: &SheetInput) -> Result<SheetCells, BuildError> {
    let image = load_sheet(input)?;
    let cut = cut_or_isolate(input.kind, image)?;
    let mut cells = Vec::with_capacity(cut.boxes.len());
    for (index, source_box) in cut.boxes.iter().enumerate() {
        let cell = register::extract_cell(&cut.image, *source_box).map_err(|failure| {
            cell_error(input.kind, index, |sheet, cell, cell_index| match failure {
                ExtractFailure::Opaque => BuildError::CellOpaque {
                    sheet,
                    cell,
                    cell_index,
                },
                ExtractFailure::Empty => BuildError::CellEmpty {
                    sheet,
                    cell,
                    cell_index,
                },
                ExtractFailure::NoLowerBand => BuildError::CellNoFootBand {
                    sheet,
                    cell,
                    cell_index,
                },
                ExtractFailure::TouchesEdge => BuildError::CellClipped {
                    sheet,
                    cell,
                    cell_index,
                },
            })
        })?;
        cells.push(cell);
    }
    Ok(SheetCells {
        kind: input.kind,
        sha256: input.sha256.trim().to_ascii_lowercase(),
        cells,
        owned_bounds: cut.owned_bounds,
    })
}

fn ordered_sheets(input: &BuildInput) -> Result<Vec<&SheetInput>, BuildError> {
    if input
        .sheets
        .iter()
        .any(|sheet| sheet.kind == SheetKind::Pilot)
    {
        return Err(BuildError::Internal {
            reason: "the pilot belongs in BuildInput.pilot, not in sheets".to_string(),
        });
    }
    let mut ordered = Vec::with_capacity(SheetKind::ATLAS_ORDER.len());
    for kind in SheetKind::ATLAS_ORDER {
        let mut matches = input.sheets.iter().filter(|sheet| sheet.kind == kind);
        let Some(first) = matches.next() else {
            return Err(BuildError::SheetMissing {
                sheet: kind.key().to_string(),
            });
        };
        if matches.next().is_some() {
            return Err(BuildError::SheetDuplicated {
                sheet: kind.key().to_string(),
            });
        }
        ordered.push(first);
    }
    Ok(ordered)
}

/// page-pet rejects exact duplicate art: every pose must be its own
/// drawing. The hash covers the visible crop, so the same art on two
/// sheets is caught too.
fn reject_duplicates(sheets: &[SheetCells]) -> Result<(), BuildError> {
    let mut seen: HashMap<&str, (SheetKind, usize)> = HashMap::new();
    for sheet in sheets {
        for (index, cell) in sheet.cells.iter().enumerate() {
            if let Some((other_kind, other_index)) = seen.get(cell.pixel_sha256.as_str()) {
                let other_sheet = other_kind.key().to_string();
                let other_cell = other_kind
                    .cell_labels()
                    .get(*other_index)
                    .cloned()
                    .unwrap_or_else(|| format!("cell {other_index}"));
                return Err(cell_error(sheet.kind, index, |sheet, cell, cell_index| {
                    BuildError::DuplicateCell {
                        sheet,
                        cell,
                        cell_index,
                        other_sheet,
                        other_cell,
                    }
                }));
            }
            seen.insert(cell.pixel_sha256.as_str(), (sheet.kind, index));
        }
    }
    Ok(())
}

/// One ratio per cell against the neutral height: gaze strips share the
/// ratio of their middle cell (`neutral-height`); reactions and extras
/// use their own full height within the page-pet window (`full-height`).
fn sheet_ratios(sheet: &SheetCells, neutral_height: f64) -> Result<Vec<f64>, BuildError> {
    match sheet.kind {
        SheetKind::Gaze { .. } => {
            let center = &sheet.cells[sheet.cells.len() / 2];
            Ok(vec![
                neutral_height / center.metrics.height();
                sheet.cells.len()
            ])
        }
        _ => sheet
            .cells
            .iter()
            .enumerate()
            .map(|(index, cell)| {
                let ratio = neutral_height / cell.metrics.height();
                if !(FULL_HEIGHT_RATIO_MIN..=FULL_HEIGHT_RATIO_MAX).contains(&ratio) {
                    return Err(cell_error(sheet.kind, index, |sheet, cell, cell_index| {
                        BuildError::ScaleOutOfRange {
                            sheet,
                            cell,
                            cell_index,
                            height_ratio: round_to(1.0 / ratio, 2),
                        }
                    }));
                }
                Ok(ratio)
            })
            .collect(),
    }
}

fn register_sheet(
    sheet: &SheetCells,
    ratios: &[f64],
    base: f64,
    size: u32,
    target: [f64; 2],
) -> Result<Vec<Registration>, BuildError> {
    let results: Vec<Result<Registration, BuildError>> = sheet
        .cells
        .par_iter()
        .enumerate()
        .map(|(index, cell)| {
            register::register_cell(cell, base * ratios[index], size, target).map_err(|failure| {
                cell_error(sheet.kind, index, |sheet, cell, cell_index| match failure {
                    RegisterFailure::Margin { margin } => BuildError::MarginTooSmall {
                        sheet,
                        cell,
                        cell_index,
                        margin,
                    },
                    RegisterFailure::Unmeasurable => BuildError::CellNoFootBand {
                        sheet,
                        cell,
                        cell_index,
                    },
                    RegisterFailure::OutputPadding { padding } => BuildError::OutputPadding {
                        sheet,
                        cell,
                        cell_index,
                        padding,
                    },
                    RegisterFailure::Drift { drift } => BuildError::RootDrift {
                        sheet,
                        cell,
                        cell_index,
                        drift,
                    },
                })
            })
        })
        .collect();
    results.into_iter().collect()
}

/// Build the pack at `out_dir` (created when missing; existing pack files
/// are replaced, other files such as `sources/` are left alone). Heavy
/// and synchronous: call it from `spawn_blocking`. `progress` receives a
/// [`BuildStep`] before each step and once more when everything is
/// written.
pub fn build_pack(
    input: &BuildInput,
    out_dir: &Path,
    mut progress: impl FnMut(BuildStep),
) -> Result<BuildOutcome, BuildError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(BuildError::NameEmpty);
    }
    if !(MIN_CELL_SIZE..=MAX_CELL_SIZE).contains(&input.cell_size) {
        return Err(BuildError::InvalidCellSize {
            cell_size: input.cell_size,
        });
    }
    let sheets = ordered_sheets(input)?;
    let size = input.cell_size;
    let total = 2 * sheets.len() as u32 + 3;
    let mut done = 0u32;
    let mut tick = |stage: BuildStage, sheet: Option<&'static str>, done: u32| {
        progress(BuildStep {
            stage,
            sheet,
            done,
            total,
        });
    };

    // 0. The reference and the pilot: bytes must be the accepted ones.
    tick(BuildStage::Reading, None, done);
    let reference_sha256 = input.reference.sha256.trim().to_ascii_lowercase();
    read_verified(&input.reference.path, &reference_sha256).map_err(|error| {
        if error.to_string() == "sha256 mismatch" {
            BuildError::ReferenceChanged
        } else {
            BuildError::ReferenceUnreadable {
                reason: error.to_string(),
            }
        }
    })?;
    let mut sources: BTreeMap<String, String> = BTreeMap::new();
    if let Some(pilot) = &input.pilot {
        let sha256 = pilot.sha256.trim().to_ascii_lowercase();
        read_verified(&pilot.path, &sha256).map_err(|error| {
            if error.to_string() == "sha256 mismatch" {
                BuildError::SheetChanged {
                    sheet: SheetKind::Pilot.key().to_string(),
                }
            } else {
                BuildError::SheetUnreadable {
                    sheet: SheetKind::Pilot.key().to_string(),
                    reason: error.to_string(),
                }
            }
        })?;
        sources.insert(SheetKind::Pilot.key().to_string(), sha256);
    }
    done += 1;

    // 1. Cut (or isolate) and measure every sheet.
    let mut extracted: Vec<SheetCells> = Vec::with_capacity(sheets.len());
    for sheet in &sheets {
        tick(BuildStage::Cutting, Some(sheet.kind.key()), done);
        let cells = extract_sheet(sheet)?;
        sources.insert(sheet.kind.key().to_string(), cells.sha256.clone());
        extracted.push(cells);
        done += 1;
    }
    reject_duplicates(&extracted)?;

    // 2. Scales from the accepted neutral: the level strip's front cell.
    let level = extracted
        .iter()
        .find(|sheet| {
            sheet.kind
                == SheetKind::Gaze {
                    row: GazeRow::Level,
                }
        })
        .ok_or_else(|| BuildError::Internal {
            reason: "the level strip vanished".to_string(),
        })?;
    let neutral_index = level.cells.len() / 2;
    let neutral_height = level.cells[neutral_index].metrics.height();
    let base = f64::from(size) * OCCUPANCY / neutral_height;
    let target = [
        f64::from(size) / 2.0,
        (f64::from(size) * 0.9).round_ties_even(),
    ];
    let ratios: Vec<Vec<f64>> = extracted
        .iter()
        .map(|sheet| sheet_ratios(sheet, neutral_height))
        .collect::<Result<_, _>>()?;

    // 3. Register every cell onto the common canvas.
    let mut registered: Vec<Vec<Registration>> = Vec::with_capacity(extracted.len());
    for (sheet, ratios) in extracted.iter().zip(&ratios) {
        tick(BuildStage::Registering, Some(sheet.kind.key()), done);
        registered.push(register_sheet(sheet, ratios, base, size, target)?);
        done += 1;
    }

    // 4. The atlas, the manifest and the evidence.
    tick(BuildStage::Packing, None, done);
    let mut atlas_cells: Vec<pack::AtlasCell<'_>> = Vec::new();
    for (sheet, cells) in extracted.iter().zip(&registered) {
        let labels = sheet.kind.cell_labels();
        for (index, cell) in cells.iter().enumerate() {
            let (kind, gaze) = match sheet.kind {
                SheetKind::Gaze { row } => (PetFrameKind::Gaze, Some(gaze_point(index, row))),
                _ => (PetFrameKind::Reaction, None),
            };
            atlas_cells.push(pack::AtlasCell {
                id: labels[index].clone(),
                kind,
                gaze,
                image: &cell.image,
            });
        }
    }
    let (atlas, frames) = pack::pack_atlas(&atlas_cells, size);
    let neutral = pack::neutral_id(&frames).ok_or_else(|| BuildError::Internal {
        reason: "no gaze frame to be the neutral".to_string(),
    })?;
    if neutral != NEUTRAL_ID {
        return Err(BuildError::Internal {
            reason: format!("the neutral resolved to {neutral}, expected {NEUTRAL_ID}"),
        });
    }
    let manifest = PetManifest {
        version: 1,
        name: name.to_string(),
        neutral: neutral.clone(),
        pivot: Some([target[0] / f64::from(size), target[1] / f64::from(size)]),
        frames,
    };
    let neutral_image = registered
        .iter()
        .zip(&extracted)
        .find(|(_, sheet)| {
            sheet.kind
                == SheetKind::Gaze {
                    row: GazeRow::Level,
                }
        })
        .map(|(cells, _)| &cells[neutral_index].image)
        .ok_or_else(|| BuildError::Internal {
            reason: "the registered level strip vanished".to_string(),
        })?;
    let created_at = input.created_at.to_rfc3339_opts(SecondsFormat::Secs, true);
    let sidecar = PetSidecar {
        version: BUDDY_PET_SIDECAR_VERSION,
        source: PetSource::VideorcCreator,
        head_top: round_to(pack::head_top(neutral_image), 4),
        talk: TALK_IDS
            .iter()
            .filter(|id| manifest.frames.iter().any(|frame| frame.id == **id))
            .map(|id| id.to_string())
            .collect(),
        created_at: Some(created_at.clone()),
        reference_sha256: Some(reference_sha256.clone()),
    };
    let mut cell_reports = Vec::with_capacity(manifest.frames.len());
    let mut frame_index = 0usize;
    for (sheet, cells) in extracted.iter().zip(&registered) {
        for (index, (cell, registration)) in sheet.cells.iter().zip(cells).enumerate() {
            let frame = &manifest.frames[frame_index];
            frame_index += 1;
            cell_reports.push(CellReport {
                id: frame.id.clone(),
                kind: frame.kind,
                sheet: sheet.kind.key().to_string(),
                sheet_sha256: sheet.sha256.clone(),
                cell: index,
                isolated: sheet.owned_bounds.is_some(),
                owned_bounds: sheet
                    .owned_bounds
                    .as_ref()
                    .and_then(|bounds| bounds.get(index))
                    .map(SourceBox::as_array),
                source_box: cell.source_box.as_array(),
                source_bounds: cell.metrics.bounds.as_array(),
                source_anchor: [round_to(cell.metrics.anchor[0], 3), cell.metrics.anchor[1]],
                scale: round_to(registration.scale, 6),
                minimum_margin: round_to(registration.minimum_margin, 2),
                output_bounds: registration.output_bounds.as_array(),
                target_anchor: target,
                anchor_drift: registration.anchor_drift,
                body_width: registration.body_width,
                rect: frame.rect,
                pixel_sha256: cell.pixel_sha256.clone(),
            });
        }
    }
    let report = BuildReport {
        version: 1,
        anchor: report::ANCHOR_POLICY.to_string(),
        scale_policy: report::SCALE_POLICY.to_string(),
        gaze_scale_policy: report::GAZE_SCALE_POLICY.to_string(),
        reaction_scale_policy: report::REACTION_SCALE_POLICY.to_string(),
        occupancy: OCCUPANCY,
        cell_size: size,
        atlas_size: [atlas.width(), atlas.height()],
        target_anchor: target,
        reference_sha256: reference_sha256.clone(),
        source_hashes: sources.clone(),
        neutral: NeutralReport {
            id: neutral,
            sheet: SheetKind::Gaze {
                row: GazeRow::Level,
            }
            .key()
            .to_string(),
            cell: neutral_index,
            source_height: neutral_height,
            base_scale: round_to(base, 6),
        },
        cells: cell_reports,
    };
    let provenance = Provenance {
        version: 1,
        reference_sha256,
        sources,
        created_at,
    };
    done += 1;

    // 5. Files.
    tick(BuildStage::Writing, None, done);
    let atlas_bytes = pack::encode_lossless_webp(&atlas).map_err(|reason| BuildError::Write {
        path: out_dir.join(ATLAS_FILE),
        reason,
    })?;
    std::fs::create_dir_all(out_dir).map_err(|error| BuildError::Write {
        path: out_dir.to_path_buf(),
        reason: error.to_string(),
    })?;
    pack::write_file(out_dir, ATLAS_FILE, &atlas_bytes)?;
    pack::write_json(out_dir, MANIFEST_FILE, &manifest)?;
    pack::write_json(out_dir, SIDECAR_FILE, &sidecar)?;
    pack::write_json(out_dir, REPORT_FILE, &report)?;
    pack::write_json(out_dir, PROVENANCE_FILE, &provenance)?;
    done += 1;
    tick(BuildStage::Writing, None, done);
    tracing::info!(
        name,
        frames = manifest.frames.len(),
        atlas = %format!("{}x{}", atlas.width(), atlas.height()),
        bytes = atlas_bytes.len(),
        "buddy pet pack built"
    );
    Ok(BuildOutcome {
        out_dir: out_dir.to_path_buf(),
        manifest,
        sidecar,
        report,
        provenance,
        atlas_width: atlas.width(),
        atlas_height: atlas.height(),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use image::Rgba;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const CELL_W: u32 = 160;
    pub(crate) const CELL_H: u32 = 300;
    const FIGURE_HEIGHT: i32 = 220;
    pub(crate) const TEST_CELL_SIZE: u32 = 128;

    /// A simple silhouette: two leg blocks, an ellipse body, a round head
    /// (offset per gaze), an optional arm to the right at leg height, and
    /// an optional stray dot below the feet.
    #[derive(Clone)]
    pub(crate) struct Figure {
        cx: i32,
        baseline: i32,
        height: i32,
        head_dx: i32,
        head_dy: i32,
        color: [u8; 3],
        arm_right: i32,
        dust: Option<(i32, u8)>,
    }

    impl Figure {
        pub(crate) fn at(cx: i32, baseline: i32, color: [u8; 3]) -> Self {
            Figure {
                cx,
                baseline,
                height: FIGURE_HEIGHT,
                head_dx: 0,
                head_dy: 0,
                color,
                arm_right: 0,
                dust: None,
            }
        }
    }

    fn put(image: &mut RgbaImage, x: i32, y: i32, pixel: Rgba<u8>) {
        if x >= 0 && y >= 0 && (x as u32) < image.width() && (y as u32) < image.height() {
            image.put_pixel(x as u32, y as u32, pixel);
        }
    }

    fn rect(image: &mut RgbaImage, left: i32, top: i32, right: i32, bottom: i32, pixel: Rgba<u8>) {
        for y in top..bottom {
            for x in left..right {
                put(image, x, y, pixel);
            }
        }
    }

    pub(crate) fn draw_figure(image: &mut RgbaImage, f: &Figure) {
        let ink = Rgba([f.color[0], f.color[1], f.color[2], 255]);
        let h = f64::from(f.height);
        let rx = (0.12 * h).round() as i32;
        let ry = (0.30 * h).round() as i32;
        let body_cy = f.baseline - (0.55 * h).round() as i32;
        let leg_top = f.baseline - (0.30 * h).round() as i32;
        let head_r = (0.15 * h).round() as i32;
        let (head_cx, head_cy) = (f.cx + f.head_dx, f.baseline - f.height + head_r + f.head_dy);
        rect(image, f.cx - 18, leg_top, f.cx - 8, f.baseline, ink);
        rect(image, f.cx + 8, leg_top, f.cx + 18, f.baseline, ink);
        for y in (body_cy - ry)..=(body_cy + ry) {
            for x in (f.cx - rx)..=(f.cx + rx) {
                let nx = f64::from(x - f.cx) / f64::from(rx);
                let ny = f64::from(y - body_cy) / f64::from(ry);
                if nx * nx + ny * ny <= 1.0 {
                    put(image, x, y, ink);
                }
            }
        }
        for y in (head_cy - head_r)..=(head_cy + head_r) {
            for x in (head_cx - head_r)..=(head_cx + head_r) {
                let dx = f64::from(x - head_cx);
                let dy = f64::from(y - head_cy);
                if dx * dx + dy * dy <= f64::from(head_r * head_r) {
                    put(image, x, y, ink);
                }
            }
        }
        if f.arm_right > 0 {
            rect(
                image,
                f.cx + 18,
                f.baseline - 50,
                f.cx + 18 + f.arm_right,
                f.baseline - 40,
                ink,
            );
        }
        if let Some((below, alpha)) = f.dust {
            put(
                image,
                f.cx,
                f.baseline + below,
                Rgba([f.color[0], f.color[1], f.color[2], alpha]),
            );
        }
    }

    fn color_for(kind: SheetKind, index: usize) -> [u8; 3] {
        let seed = match kind {
            SheetKind::Pilot => 0,
            SheetKind::Gaze { row } => 10 + row.index() * 8,
            SheetKind::ReactionsA => 60,
            SheetKind::ReactionsB => 80,
            SheetKind::Extras => 100,
        } + index;
        [
            40 + (seed * 7 % 160) as u8,
            60 + (seed * 13 % 150) as u8,
            200 - (seed * 5 % 120) as u8,
        ]
    }

    fn default_figure(kind: SheetKind, index: usize, cell_h: u32) -> Figure {
        let (cols, _) = kind.grid();
        let col = (index % cols) as i32;
        let row = (index / cols) as i32;
        let cx = col * CELL_W as i32 + CELL_W as i32 / 2;
        let baseline = row * cell_h as i32 + cell_h as i32 - 60;
        let mut figure = Figure::at(cx, baseline, color_for(kind, index));
        match kind {
            SheetKind::Gaze { row } => {
                figure.head_dx = (col - 2) * 6;
                figure.head_dy = (row.index() as i32 - 2) * 3;
            }
            SheetKind::Pilot => {
                figure.head_dx = [0, -10, 10, 0][index];
            }
            _ => {
                figure.head_dx = (index as i32 % 3 - 1) * 4;
            }
        }
        figure
    }

    /// Draw a whole sheet of `kind`, letting `tweak` edit each figure.
    pub(crate) fn sheet_image(
        kind: SheetKind,
        cell_h: u32,
        mut tweak: impl FnMut(usize, &mut Figure),
    ) -> RgbaImage {
        let (cols, rows) = kind.grid();
        let mut image = RgbaImage::new(CELL_W * cols as u32, cell_h * rows as u32);
        for index in 0..cols * rows {
            let mut figure = default_figure(kind, index, cell_h);
            tweak(index, &mut figure);
            draw_figure(&mut image, &figure);
        }
        image
    }

    static SCRATCH: AtomicUsize = AtomicUsize::new(0);

    fn scratch_dir(tag: &str) -> PathBuf {
        let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "videorc-buddy-pet-build-{}-{tag}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_png(dir: &Path, name: &str, image: &RgbaImage) -> (PathBuf, String) {
        let path = dir.join(name);
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        std::fs::write(&path, &bytes).unwrap();
        (path, sha256_hex(&bytes))
    }

    struct Fixture {
        dir: PathBuf,
        input: BuildInput,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Every sheet drawn by `tweak(kind, index, figure)`; `heights` may
    /// give one sheet kind a taller cell.
    fn fixture(
        tag: &str,
        mut tweak: impl FnMut(SheetKind, usize, &mut Figure),
        cell_height: impl Fn(SheetKind) -> u32,
    ) -> Fixture {
        let dir = scratch_dir(tag);
        let sources = dir.join("sources");
        std::fs::create_dir_all(&sources).unwrap();
        let mut reference = RgbaImage::new(120, 260);
        draw_figure(&mut reference, &Figure::at(60, 240, [90, 90, 90]));
        let (reference_path, reference_sha) = write_png(&sources, "reference.png", &reference);
        let pilot_image = sheet_image(SheetKind::Pilot, CELL_H, |index, figure| {
            tweak(SheetKind::Pilot, index, figure)
        });
        let (pilot_path, pilot_sha) = write_png(&sources, "pilot.png", &pilot_image);
        let sheets = SheetKind::ATLAS_ORDER
            .iter()
            .map(|kind| {
                let image = sheet_image(*kind, cell_height(*kind), |index, figure| {
                    tweak(*kind, index, figure)
                });
                let (path, sha256) = write_png(&sources, &format!("{}.png", kind.key()), &image);
                SheetInput {
                    kind: *kind,
                    path,
                    sha256,
                }
            })
            .collect();
        Fixture {
            input: BuildInput {
                name: "Test Golem".to_string(),
                reference: SourceFile {
                    path: reference_path,
                    sha256: reference_sha,
                },
                pilot: Some(SheetInput {
                    kind: SheetKind::Pilot,
                    path: pilot_path,
                    sha256: pilot_sha,
                }),
                sheets,
                cell_size: TEST_CELL_SIZE,
                created_at: DateTime::parse_from_rfc3339("2026-10-08T12:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            },
            dir,
        }
    }

    fn plain_fixture(tag: &str) -> Fixture {
        fixture(tag, |_, _, _| {}, |_| CELL_H)
    }

    fn build(fixture: &Fixture) -> Result<BuildOutcome, BuildError> {
        build_pack(&fixture.input, &fixture.dir.join("pack"), |_| {})
    }

    /// The pack contract's own rules (plan 168 S-A1): the manifest as JSON
    /// through [`crate::buddy_pet::validate_manifest`] (page-pet manifest v1
    /// plus D1 and D4), then every rect inside the atlas.
    fn validate_pack_rules(
        manifest: &PetManifest,
        atlas: (u32, u32),
    ) -> Result<PetManifest, crate::buddy_pet::PetError> {
        let parsed = crate::buddy_pet::validate_manifest(&serde_json::to_value(manifest).unwrap())?;
        let sizes = BTreeMap::from([(ATLAS_FILE.to_string(), atlas)]);
        crate::buddy_pet::validate_sheet_sizes(&parsed, &sizes)?;
        Ok(parsed)
    }

    #[test]
    fn builds_a_full_pack_from_synthetic_sheets() {
        let fixture = plain_fixture("happy");
        let mut steps: Vec<BuildStep> = Vec::new();
        let out_dir = fixture.dir.join("pack");
        let outcome = build_pack(&fixture.input, &out_dir, |step| steps.push(step)).unwrap();

        // Atlas: 40 cells, five across, eight rows.
        assert_eq!((outcome.atlas_width, outcome.atlas_height), (640, 1024));
        assert_eq!(outcome.manifest.frames.len(), 40);
        assert_eq!(outcome.manifest.neutral, "gaze-2-2");
        assert_eq!(outcome.manifest.pivot, Some([0.5, 115.0 / 128.0]));
        let ids: Vec<&str> = outcome
            .manifest
            .frames
            .iter()
            .map(|f| f.id.as_str())
            .collect();
        assert_eq!(
            &ids[..5],
            &["gaze-0-0", "gaze-1-0", "gaze-2-0", "gaze-3-0", "gaze-4-0"]
        );
        assert_eq!(
            &ids[10..15],
            &["gaze-0-2", "gaze-1-2", "gaze-2-2", "gaze-3-2", "gaze-4-2"]
        );
        assert_eq!(&ids[25..31], &REACTIONS_A);
        assert_eq!(&ids[31..37], &REACTIONS_B);
        assert_eq!(&ids[37..], &EXTRAS);
        let frame = |id: &str| outcome.manifest.frames.iter().find(|f| f.id == id).unwrap();
        assert_eq!(frame("gaze-0-0").gaze, Some([-1.0, -1.0]));
        assert_eq!(frame("gaze-3-1").gaze, Some([0.5, -0.5]));
        assert_eq!(frame("gaze-2-2").gaze, Some([0.0, 0.0]));
        assert_eq!(frame("gaze-4-4").gaze, Some([1.0, 1.0]));
        assert_eq!(frame("gaze-2-2").rect, [256, 256, 128, 128]);
        assert_eq!(frame("wave").rect, [512, 896, 128, 128]);
        assert_eq!(frame("wave").kind, PetFrameKind::Reaction);
        assert_eq!(frame("wave").gaze, None);
        assert!(
            outcome
                .manifest
                .frames
                .iter()
                .all(|f| f.sheet == ATLAS_FILE)
        );

        // Sidecar.
        assert_eq!(outcome.sidecar.version, 1);
        assert_eq!(outcome.sidecar.source, PetSource::VideorcCreator);
        assert_eq!(outcome.sidecar.talk, vec!["talk-a", "talk-b"]);
        assert_eq!(
            outcome.sidecar.created_at.as_deref(),
            Some("2026-10-08T12:00:00Z")
        );
        assert_eq!(
            outcome.sidecar.reference_sha256.as_deref(),
            Some(fixture.input.reference.sha256.as_str())
        );
        // The neutral stands 0.65 of the cell tall on the 0.9 pivot.
        let expected_head_top = (115.0 - 128.0 * 0.65) / 128.0;
        assert!(
            (outcome.sidecar.head_top - expected_head_top).abs() < 0.02,
            "{}",
            outcome.sidecar.head_top
        );

        // Report and provenance.
        assert_eq!(outcome.report.cells.len(), 40);
        assert!(
            outcome
                .report
                .cells
                .iter()
                .all(|c| !c.isolated && c.owned_bounds.is_none())
        );
        assert!(
            outcome
                .report
                .cells
                .iter()
                .all(|c| c.minimum_margin >= MIN_MARGIN_PX)
        );
        assert!(
            outcome
                .report
                .cells
                .iter()
                .all(|c| c.anchor_drift[0].abs() <= MAX_ROOT_DRIFT_X_PX
                    && c.anchor_drift[1].abs() <= MAX_ROOT_DRIFT_BOTTOM_PX)
        );
        assert_eq!(outcome.report.neutral.id, "gaze-2-2");
        assert_eq!(outcome.report.neutral.sheet, "gaze-level");
        assert_eq!(outcome.report.atlas_size, [640, 1024]);
        let gaze_level: Vec<&CellReport> = outcome
            .report
            .cells
            .iter()
            .filter(|c| c.sheet == "gaze-level")
            .collect();
        assert!(
            gaze_level
                .iter()
                .all(|c| (c.scale - gaze_level[0].scale).abs() < 1e-9),
            "one scale per strip"
        );
        assert_eq!(outcome.provenance.sources.len(), 9);
        assert_eq!(
            outcome.provenance.sources["pilot"],
            fixture.input.pilot.as_ref().unwrap().sha256
        );
        assert_eq!(
            outcome.provenance.sources["gaze-level"],
            fixture.input.sheets[2].sha256
        );
        assert_eq!(
            outcome.provenance.reference_sha256,
            fixture.input.reference.sha256
        );
        assert_eq!(outcome.report.source_hashes, outcome.provenance.sources);

        // Files on disk decode and parse back to the same shapes.
        for name in [
            ATLAS_FILE,
            MANIFEST_FILE,
            SIDECAR_FILE,
            REPORT_FILE,
            PROVENANCE_FILE,
        ] {
            assert!(out_dir.join(name).is_file(), "{name} missing");
        }
        assert!(!out_dir.join(format!("{ATLAS_FILE}.partial")).exists());
        let atlas = image::open(out_dir.join(ATLAS_FILE)).unwrap().into_rgba8();
        assert_eq!(atlas.dimensions(), (640, 1024));
        let manifest: PetManifest =
            serde_json::from_str(&std::fs::read_to_string(out_dir.join(MANIFEST_FILE)).unwrap())
                .unwrap();
        assert_eq!(manifest, outcome.manifest);
        let sidecar: PetSidecar =
            serde_json::from_str(&std::fs::read_to_string(out_dir.join(SIDECAR_FILE)).unwrap())
                .unwrap();
        assert_eq!(sidecar, outcome.sidecar);
        let report: BuildReport =
            serde_json::from_str(&std::fs::read_to_string(out_dir.join(REPORT_FILE)).unwrap())
                .unwrap();
        assert_eq!(report, outcome.report);
        let provenance: Provenance =
            serde_json::from_str(&std::fs::read_to_string(out_dir.join(PROVENANCE_FILE)).unwrap())
                .unwrap();
        assert_eq!(provenance, outcome.provenance);
        let sidecar_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(out_dir.join(SIDECAR_FILE)).unwrap())
                .unwrap();
        assert!(
            sidecar_json.get("headTop").is_some() && sidecar_json.get("referenceSha256").is_some()
        );

        // Each cell carries its own colour in its left leg (centre 13 px left
        // of the root, scaled to about 5 px), feet ending on the pivot row.
        for (index, cell) in outcome.report.cells.iter().enumerate() {
            let [x, y, _, _] = cell.rect;
            let leg = atlas.get_pixel(x + 59, y + 110);
            let expected = color_for(SheetKind::ATLAS_ORDER[sheet_index_of(index)], cell.cell);
            assert_eq!(leg.0[3], 255, "{}: leg pixel {:?}", cell.id, leg);
            assert_eq!(&leg.0[..3], &expected, "{}: colour", cell.id);
            assert_eq!(
                atlas.get_pixel(x + 59, y + 120).0[3],
                0,
                "{}: below the pivot is clear",
                cell.id
            );
            assert!(
                (115..=116).contains(&cell.output_bounds[3]),
                "{}: {:?}",
                cell.id,
                cell.output_bounds
            );
        }

        // Progress: monotonic, every stage, ends at total.
        assert_eq!(steps.first().unwrap().stage, BuildStage::Reading);
        assert!(steps.windows(2).all(|w| w[0].done <= w[1].done));
        assert_eq!(
            steps
                .iter()
                .filter(|s| s.stage == BuildStage::Cutting)
                .count(),
            8
        );
        assert_eq!(
            steps
                .iter()
                .filter(|s| s.stage == BuildStage::Registering)
                .count(),
            8
        );
        assert_eq!(
            steps
                .iter()
                .filter(|s| s.stage == BuildStage::Cutting && s.sheet == Some("gaze-up2"))
                .count(),
            1
        );
        let last = steps.last().unwrap();
        assert_eq!(
            (last.stage, last.done, last.total),
            (BuildStage::Writing, 19, 19)
        );
    }

    /// Sheet index in `ATLAS_ORDER` for a frame index of the full pack.
    fn sheet_index_of(frame: usize) -> usize {
        match frame {
            0..=24 => frame / 5,
            25..=30 => 5,
            31..=36 => 6,
            _ => 7,
        }
    }

    #[test]
    fn builder_output_passes_manifest_rules() {
        use crate::buddy_pet::{PetRule, load_pack_dir, parse_sidecar};
        let fixture = plain_fixture("rules");
        let outcome = build(&fixture).unwrap();
        let atlas = (outcome.atlas_width, outcome.atlas_height);
        assert_eq!(
            validate_pack_rules(&outcome.manifest, atlas).unwrap(),
            outcome.manifest
        );

        // The files on disk are the contract's own JSON, byte for byte: the
        // canonical types parse them and serialize them back identically.
        let out_dir = fixture.dir.join("pack");
        let manifest_bytes = std::fs::read(out_dir.join(MANIFEST_FILE)).unwrap();
        let parsed = crate::buddy_pet::parse_manifest(&manifest_bytes).unwrap();
        let mut reserialized = serde_json::to_vec_pretty(&parsed).unwrap();
        reserialized.push(b'\n');
        assert_eq!(reserialized, manifest_bytes);
        let sidecar_bytes = std::fs::read(out_dir.join(SIDECAR_FILE)).unwrap();
        let sidecar = parse_sidecar(&sidecar_bytes, &parsed).unwrap();
        let mut reserialized = serde_json::to_vec_pretty(&sidecar).unwrap();
        reserialized.push(b'\n');
        assert_eq!(reserialized, sidecar_bytes);

        // The whole folder loads as a pack: decoded, every cell transparent
        // around a character, the sidecar read from disk.
        let loaded = load_pack_dir(&out_dir, "built").unwrap();
        assert_eq!(loaded.manifest, outcome.manifest);
        assert_eq!(loaded.sidecar, outcome.sidecar);
        assert!(loaded.sidecar_on_disk);

        // The contract's validator catches each rule by name.
        let rule = |manifest: &PetManifest, atlas: (u32, u32)| {
            validate_pack_rules(manifest, atlas).unwrap_err().rule
        };
        let mut broken = outcome.manifest.clone();
        broken.frames[1].id = broken.frames[0].id.clone();
        assert_eq!(rule(&broken, atlas), PetRule::FrameId);
        let mut broken = outcome.manifest.clone();
        broken.frames[3].gaze = broken.frames[2].gaze;
        assert_eq!(rule(&broken, atlas), PetRule::GazeUnique);
        let mut broken = outcome.manifest.clone();
        broken.neutral = "wave".into();
        assert_eq!(rule(&broken, atlas), PetRule::NeutralMissing);
        let mut broken = outcome.manifest.clone();
        broken.frames[0].rect = [0, 0, 128, 64];
        assert_eq!(rule(&broken, atlas), PetRule::RectSquare);
        assert_eq!(
            rule(&outcome.manifest, (640, 1000)),
            PetRule::FrameOutsideSheet
        );
    }

    #[test]
    fn isolates_a_strip_whose_poses_overlap() {
        // The up1 strip's first pose reaches over the second one's column
        // range at leg height without touching it: no alpha gutter.
        let fixture = fixture(
            "isolate",
            |kind, index, figure| {
                if kind == (SheetKind::Gaze { row: GazeRow::Up1 }) && index == 0 {
                    figure.arm_right = 120;
                }
            },
            |_| CELL_H,
        );
        let preview = cut_preview(&fixture.input.sheets[1]).unwrap();
        assert_eq!(preview.len(), 5);
        assert!(preview.iter().all(|b| b.method == CutMethod::Isolated));
        assert_eq!(preview[0].label, "gaze-0-1");
        // Head (offset 12 px left, radius 33) to the arm's tip.
        assert_eq!((preview[0].left, preview[0].right), (35, 218));
        assert!(
            preview[1].left < preview[0].right,
            "the owned boxes overlap in the original"
        );
        let plain = cut_preview(&fixture.input.sheets[0]).unwrap();
        assert!(plain.iter().all(|b| b.method == CutMethod::AlphaGutters));
        assert_eq!(plain[0].left, 0);
        assert!((140..=170).contains(&plain[0].right), "{:?}", plain[0]);

        let outcome = build(&fixture).unwrap();
        let up1: Vec<&CellReport> = outcome
            .report
            .cells
            .iter()
            .filter(|c| c.sheet == "gaze-up1")
            .collect();
        assert!(up1.iter().all(|c| c.isolated));
        assert_eq!(up1[0].owned_bounds, Some([35, 17, 218, 240]));
        assert!(up1[0].minimum_margin >= MIN_MARGIN_PX);
        assert!(
            outcome
                .report
                .cells
                .iter()
                .filter(|c| c.sheet != "gaze-up1")
                .all(|c| !c.isolated)
        );
        validate_pack_rules(
            &outcome.manifest,
            (outcome.atlas_width, outcome.atlas_height),
        )
        .unwrap();
    }

    #[test]
    fn rejects_an_opaque_sheet() {
        let fixture = plain_fixture("opaque");
        let sheet = &fixture.input.sheets[4];
        let mut image = image::open(&sheet.path).unwrap().into_rgba8();
        for pixel in image.pixels_mut() {
            if pixel.0[3] == 0 {
                *pixel = Rgba([250, 250, 250, 255]);
            }
        }
        let (_, sha256) = write_png(&fixture.dir.join("sources"), "gaze-down2.png", &image);
        let mut input = fixture.input.clone();
        input.sheets[4].sha256 = sha256;
        let error = build_pack(&input, &fixture.dir.join("pack"), |_| {}).unwrap_err();
        assert_eq!(
            error,
            BuildError::SheetOpaque {
                sheet: "gaze-down2".into()
            }
        );
        assert_eq!(error.code(), "sheet-opaque");
        assert_eq!(
            error.to_string(),
            "gaze-down2: the sheet has no transparent background; generate it again"
        );
    }

    #[test]
    fn rejects_touching_characters() {
        let fixture = fixture(
            "touching",
            |kind, index, figure| {
                if kind
                    == (SheetKind::Gaze {
                        row: GazeRow::Down1,
                    })
                    && index == 1
                {
                    figure.arm_right = 130;
                }
            },
            |_| CELL_H,
        );
        assert_eq!(
            build(&fixture).unwrap_err(),
            BuildError::CharactersNotSeparable {
                sheet: "gaze-down1".into(),
                expected: 5,
                found: 4
            }
        );
    }

    #[test]
    fn rejects_a_loose_piece() {
        let fixture = fixture(
            "loose",
            |kind, index, figure| {
                if kind
                    == (SheetKind::Gaze {
                        row: GazeRow::Down2,
                    })
                    && index == 0
                {
                    figure.arm_right = 120;
                }
            },
            |_| CELL_H,
        );
        let sheet = &fixture.input.sheets[4];
        let mut image = image::open(&sheet.path).unwrap().into_rgba8();
        rect(&mut image, 2, 2, 8, 8, Rgba([255, 255, 255, 255]));
        let (_, sha256) = write_png(&fixture.dir.join("sources"), "gaze-down2.png", &image);
        let mut input = fixture.input.clone();
        input.sheets[4].sha256 = sha256;
        let error = build_pack(&input, &fixture.dir.join("pack"), |_| {}).unwrap_err();
        match error {
            BuildError::LoosePieces {
                sheet,
                distance,
                bounds,
            } => {
                assert_eq!(sheet, "gaze-down2");
                assert_eq!(bounds, [2, 2, 8, 8]);
                assert!(distance > LOOSE_PIECE_JOIN_PX, "{distance}");
            }
            other => panic!("expected loose pieces, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_pose_that_needs_more_room() {
        // A gaze cell far taller than its strip's front pose: the strip's
        // scale comes from the front pose, so the tall one is never shrunk.
        let fixture = fixture(
            "margin",
            |kind, index, figure| {
                if kind == (SheetKind::Gaze { row: GazeRow::Up1 }) && index == 0 {
                    figure.height = 320;
                }
            },
            |kind| {
                if kind == (SheetKind::Gaze { row: GazeRow::Up1 }) {
                    400
                } else {
                    CELL_H
                }
            },
        );
        match build(&fixture).unwrap_err() {
            BuildError::MarginTooSmall {
                sheet,
                cell,
                cell_index,
                margin,
            } => {
                assert_eq!(
                    (sheet.as_str(), cell.as_str(), cell_index),
                    ("gaze-up1", "gaze-0-1", 0)
                );
                assert!(margin < MIN_MARGIN_PX, "{margin}");
            }
            other => panic!("expected a margin rejection, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_reaction_drawn_at_another_scale() {
        let fixture = fixture(
            "scale",
            |kind, index, figure| {
                if kind == SheetKind::ReactionsA && index == 3 {
                    figure.height = 100;
                }
            },
            |_| CELL_H,
        );
        match build(&fixture).unwrap_err() {
            BuildError::ScaleOutOfRange {
                sheet,
                cell,
                cell_index,
                height_ratio,
            } => {
                assert_eq!(
                    (sheet.as_str(), cell.as_str(), cell_index),
                    ("reactions-a", "kiss", 3)
                );
                assert!(
                    (height_ratio - 100.0 / 220.0).abs() < 0.02,
                    "{height_ratio}"
                );
            }
            other => panic!("expected a scale rejection, got {other:?}"),
        }
    }

    #[test]
    fn rejects_duplicate_cells() {
        let fixture = fixture(
            "duplicate",
            |kind, index, figure| {
                if kind == SheetKind::ReactionsB && (index == 1 || index == 4) {
                    figure.color = [1, 2, 3];
                    figure.head_dx = 0;
                }
            },
            |_| CELL_H,
        );
        assert_eq!(
            build(&fixture).unwrap_err(),
            BuildError::DuplicateCell {
                sheet: "reactions-b".into(),
                cell: "excited".into(),
                cell_index: 4,
                other_sheet: "reactions-b".into(),
                other_cell: "annoyed".into(),
            }
        );
    }

    #[test]
    fn rejects_a_pose_whose_feet_move_during_registration() {
        // A faint stray dot below the feet drags the measured root down in
        // the source and vanishes when the cell is scaled: the pose would
        // float. page-pet's drift gate catches it.
        let fixture = fixture(
            "drift",
            |kind, index, figure| {
                if kind == (SheetKind::Gaze { row: GazeRow::Up2 }) && index == 1 {
                    figure.dust = Some((30, 20));
                }
            },
            |_| CELL_H,
        );
        match build(&fixture).unwrap_err() {
            BuildError::RootDrift {
                sheet,
                cell,
                cell_index,
                drift,
            } => {
                assert_eq!(
                    (sheet.as_str(), cell.as_str(), cell_index),
                    ("gaze-up2", "gaze-1-0", 1)
                );
                assert!(drift[1] < -MAX_ROOT_DRIFT_BOTTOM_PX, "{drift:?}");
            }
            other => panic!("expected a drift rejection, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_cell_without_feet() {
        let fixture = fixture(
            "feet",
            |kind, index, figure| {
                if kind == SheetKind::Extras && index == 2 {
                    figure.dust = Some((50, 255));
                }
            },
            |_| CELL_H,
        );
        assert_eq!(
            build(&fixture).unwrap_err(),
            BuildError::CellNoFootBand {
                sheet: "extras".into(),
                cell: "wave".into(),
                cell_index: 2
            }
        );
    }

    #[test]
    fn rejects_a_changed_sheet_and_reference() {
        let fixture = plain_fixture("changed");
        let mut input = fixture.input.clone();
        input.sheets[6].sha256 = "0".repeat(64);
        assert_eq!(
            build_pack(&input, &fixture.dir.join("pack"), |_| {}).unwrap_err(),
            BuildError::SheetChanged {
                sheet: "reactions-b".into()
            }
        );
        let mut input = fixture.input.clone();
        input.reference.sha256 = "0".repeat(64);
        assert_eq!(
            build_pack(&input, &fixture.dir.join("pack"), |_| {}).unwrap_err(),
            BuildError::ReferenceChanged
        );
        let mut input = fixture.input.clone();
        input.pilot.as_mut().unwrap().path = fixture.dir.join("missing.png");
        assert!(matches!(
            build_pack(&input, &fixture.dir.join("pack"), |_| {}).unwrap_err(),
            BuildError::SheetUnreadable { sheet, .. } if sheet == "pilot"
        ));
    }

    #[test]
    fn rejects_incomplete_input_and_an_empty_name() {
        let fixture = plain_fixture("input");
        let mut input = fixture.input.clone();
        input.sheets.remove(3);
        assert_eq!(
            build_pack(&input, &fixture.dir.join("pack"), |_| {}).unwrap_err(),
            BuildError::SheetMissing {
                sheet: "gaze-down1".into()
            }
        );
        let mut input = fixture.input.clone();
        input.sheets.push(input.sheets[7].clone());
        assert_eq!(
            build_pack(&input, &fixture.dir.join("pack"), |_| {}).unwrap_err(),
            BuildError::SheetDuplicated {
                sheet: "extras".into()
            }
        );
        let mut input = fixture.input.clone();
        input.name = "   ".into();
        assert_eq!(
            build_pack(&input, &fixture.dir.join("pack"), |_| {}).unwrap_err(),
            BuildError::NameEmpty
        );
        let mut input = fixture.input.clone();
        input.cell_size = 64;
        assert_eq!(
            build_pack(&input, &fixture.dir.join("pack"), |_| {}).unwrap_err(),
            BuildError::InvalidCellSize { cell_size: 64 }
        );
        assert!(
            !fixture.dir.join("pack").exists(),
            "nothing is written before the inputs pass"
        );
    }

    #[test]
    fn cut_preview_labels_the_pilot_cells() {
        let fixture = plain_fixture("preview");
        let boxes = cut_preview(fixture.input.pilot.as_ref().unwrap()).unwrap();
        let labels: Vec<&str> = boxes.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, PILOT_CELLS);
        assert!(boxes.iter().all(|b| b.method == CutMethod::AlphaGutters));
        assert_eq!((boxes[0].left, boxes[0].top), (0, 0));
        assert_eq!((boxes[3].right, boxes[3].bottom), (320, 600));
        assert!(boxes[1].left > 100 && boxes[1].left < 220);
        assert!(boxes[2].top > 250 && boxes[2].top < 350);
    }

    #[test]
    fn errors_serialize_with_a_code_and_camel_case_fields() {
        let error = BuildError::MarginTooSmall {
            sheet: "gaze-up1".into(),
            cell: "gaze-0-1".into(),
            cell_index: 0,
            margin: -5.5,
        };
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["code"], "margin-too-small");
        assert_eq!(json["cellIndex"], 0);
        assert_eq!(error.code(), "margin-too-small");
        assert!(
            error
                .to_string()
                .starts_with("gaze-up1, gaze-0-1: the pose needs more room")
        );
        assert!(!error.to_string().contains('\u{2014}'));
    }

    #[test]
    fn gaze_ids_and_points_follow_page_pet() {
        assert_eq!(gaze_id(0, GazeRow::Up2), "gaze-0-0");
        assert_eq!(gaze_id(4, GazeRow::Down2), "gaze-4-4");
        assert_eq!(gaze_point(0, GazeRow::Level), [-1.0, 0.0]);
        assert_eq!(gaze_point(1, GazeRow::Up1), [-0.5, -0.5]);
        assert_eq!(gaze_point(3, GazeRow::Down1), [0.5, 0.5]);
        assert_eq!(
            SheetKind::Gaze {
                row: GazeRow::Level
            }
            .cell_labels()[2],
            NEUTRAL_ID
        );
        assert_eq!(
            serde_json::to_value(SheetKind::Gaze {
                row: GazeRow::Down1
            })
            .unwrap(),
            serde_json::json!({ "kind": "gaze", "row": "down1" })
        );
        assert_eq!(
            serde_json::to_value(SheetKind::ReactionsA).unwrap(),
            serde_json::json!({ "kind": "reactions-a" })
        );
    }
}
