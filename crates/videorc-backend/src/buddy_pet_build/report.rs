//! The build evidence written beside the pack: `build-report.json` (every
//! cell's scale, margin, root, bounds and source) and `provenance.json`
//! (the reference and every source sheet SHA-256). The shapes follow
//! page-pet's `build_pack.py` report where the fields overlap.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::buddy_pet::PetFrameKind;

pub const ANCHOR_POLICY: &str = "lower-body-bottom";
pub const SCALE_POLICY: &str = "neutral-height-and-reaction-full-height-v1";
pub const GAZE_SCALE_POLICY: &str = "neutral-height";
pub const REACTION_SCALE_POLICY: &str = "full-height";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildReport {
    pub version: u32,
    pub anchor: String,
    pub scale_policy: String,
    pub gaze_scale_policy: String,
    pub reaction_scale_policy: String,
    pub occupancy: f64,
    pub cell_size: u32,
    pub atlas_size: [u32; 2],
    pub target_anchor: [f64; 2],
    pub reference_sha256: String,
    /// Sheet key to SHA-256, the same map as `provenance.json`.
    pub source_hashes: BTreeMap<String, String>,
    pub neutral: NeutralReport,
    pub cells: Vec<CellReport>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeutralReport {
    pub id: String,
    pub sheet: String,
    pub cell: usize,
    /// Silhouette height of the neutral in its source sheet, in pixels.
    pub source_height: f64,
    /// `cellSize * occupancy / sourceHeight`: the base scale every cell
    /// multiplies by its sheet ratio.
    pub base_scale: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellReport {
    pub id: String,
    pub kind: PetFrameKind,
    /// Sheet key, e.g. `gaze-level` or `reactions-a`.
    pub sheet: String,
    pub sheet_sha256: String,
    /// Row-major cell index on the sheet.
    pub cell: usize,
    /// The sheet needed the component separation of S-F2 before the cut.
    pub isolated: bool,
    /// Bounds of this character's owned pixels in the original sheet when
    /// `isolated`; the cut box lives on the separated sheet then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_bounds: Option<[u32; 4]>,
    /// `[left, top, right, bottom]` of the cut box on the sheet that was cut.
    pub source_box: [u32; 4],
    pub source_bounds: [u32; 4],
    pub source_anchor: [f64; 2],
    pub scale: f64,
    pub minimum_margin: f64,
    pub output_bounds: [u32; 4],
    pub target_anchor: [f64; 2],
    pub anchor_drift: [f64; 2],
    pub body_width: u32,
    /// The cell's rect in the atlas.
    pub rect: [u32; 4],
    /// SHA-256 of the visible source crop; unique across the pack.
    pub pixel_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub version: u32,
    pub reference_sha256: String,
    /// Sheet key to SHA-256 for every source, the pilot included when it
    /// was supplied.
    pub sources: BTreeMap<String, String>,
    pub created_at: String,
}
