//! S-F3, second half: the atlas, the page-pet manifest v1, the Videorc
//! sidecar and the files on disk, a port of the packing tail of page-pet's
//! `scripts/build_pack.py` (`--single-atlas`, ids, gaze coordinates,
//! `neutral`, `pivot`) plus plan 168's `golem.json` (D1, D16). The manifest
//! and sidecar are the pack contract's own types ([`crate::golem_pet`]), so
//! what the builder writes is exactly what an import or a load reads.

use std::io::Write;
use std::path::{Path, PathBuf};

use image::RgbaImage;
use serde::Serialize;

use super::BuildError;
use super::register::visible_bounds;
use crate::golem_pet::{PetFrame, PetFrameKind};

/// Cells per atlas row (page-pet's `--single-atlas` packs five across).
pub const ATLAS_COLUMNS: u32 = 5;
/// The one sheet of a created pack.
pub const ATLAS_FILE: &str = "mascot.webp";
pub const MANIFEST_FILE: &str = crate::golem_pet::GOLEM_PET_MANIFEST_FILE;
pub const SIDECAR_FILE: &str = crate::golem_pet::GOLEM_PET_SIDECAR_FILE;
pub const REPORT_FILE: &str = "build-report.json";
pub const PROVENANCE_FILE: &str = "provenance.json";

/// A registered cell ready for the atlas.
pub(super) struct AtlasCell<'a> {
    pub id: String,
    pub kind: PetFrameKind,
    pub gaze: Option<[f64; 2]>,
    pub image: &'a RgbaImage,
}

/// Atlas geometry for `count` cells of `size` in [`ATLAS_COLUMNS`] columns.
pub(super) fn atlas_dimensions(count: usize, size: u32) -> (u32, u32) {
    let rows = (count as u32).div_ceil(ATLAS_COLUMNS);
    (ATLAS_COLUMNS * size, rows * size)
}

/// Rect of cell `index` in the atlas.
pub(super) fn atlas_rect(index: usize, size: u32) -> [u32; 4] {
    let column = index as u32 % ATLAS_COLUMNS;
    let row = index as u32 / ATLAS_COLUMNS;
    [column * size, row * size, size, size]
}

/// Composite the cells row-major into one atlas and describe each as a
/// manifest frame on [`ATLAS_FILE`].
pub(super) fn pack_atlas(cells: &[AtlasCell<'_>], size: u32) -> (RgbaImage, Vec<PetFrame>) {
    let (width, height) = atlas_dimensions(cells.len(), size);
    let mut atlas = RgbaImage::new(width, height);
    let mut frames = Vec::with_capacity(cells.len());
    for (index, cell) in cells.iter().enumerate() {
        let rect = atlas_rect(index, size);
        image::imageops::replace(
            &mut atlas,
            cell.image,
            i64::from(rect[0]),
            i64::from(rect[1]),
        );
        frames.push(PetFrame {
            id: cell.id.clone(),
            kind: cell.kind,
            sheet: ATLAS_FILE.to_string(),
            rect,
            gaze: cell.gaze,
        });
    }
    (atlas, frames)
}

/// page-pet: the neutral is the gaze frame nearest `[0, 0]`.
pub(super) fn neutral_id(frames: &[PetFrame]) -> Option<String> {
    frames
        .iter()
        .filter(|frame| frame.kind == PetFrameKind::Gaze)
        .filter_map(|frame| frame.gaze.map(|g| (frame, g[0] * g[0] + g[1] * g[1])))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(frame, _)| frame.id.clone())
}

/// D16: the normalised top of the neutral silhouette inside its cell.
pub(super) fn head_top(neutral: &RgbaImage) -> f64 {
    let size = f64::from(neutral.height().max(1));
    visible_bounds(neutral).map_or(0.0, |bounds| f64::from(bounds.top) / size)
}

pub(super) fn encode_lossless_webp(atlas: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut bytes);
    encoder
        .encode(
            atlas.as_raw(),
            atlas.width(),
            atlas.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn write_error(path: &Path, error: impl ToString) -> BuildError {
    BuildError::Write {
        path: path.to_path_buf(),
        reason: error.to_string(),
    }
}

/// Stage the bytes next to the destination, flush, then replace atomically.
pub(super) fn write_file(out_dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, BuildError> {
    let destination = out_dir.join(name);
    let staged = out_dir.join(format!("{name}.partial"));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&staged)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        crate::atomic_file::replace_file(&staged, &destination)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&staged);
        return Err(write_error(&destination, error));
    }
    Ok(destination)
}

pub(super) fn write_json<T: Serialize>(
    out_dir: &Path,
    name: &str,
    value: &T,
) -> Result<PathBuf, BuildError> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| write_error(&out_dir.join(name), error))?;
    bytes.push(b'\n');
    write_file(out_dir, name, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn atlas_geometry_packs_five_across() {
        assert_eq!(atlas_dimensions(40, 640), (3200, 5120));
        assert_eq!(atlas_dimensions(37, 640), (3200, 5120));
        assert_eq!(atlas_dimensions(1, 128), (640, 128));
        assert_eq!(atlas_rect(0, 640), [0, 0, 640, 640]);
        assert_eq!(atlas_rect(7, 640), [1280, 640, 640, 640]);
    }

    #[test]
    fn neutral_is_the_gaze_frame_nearest_the_centre() {
        let frames = vec![
            PetFrame {
                id: "a".into(),
                kind: PetFrameKind::Gaze,
                sheet: ATLAS_FILE.into(),
                rect: [0, 0, 1, 1],
                gaze: Some([-1.0, 0.0]),
            },
            PetFrame {
                id: "b".into(),
                kind: PetFrameKind::Gaze,
                sheet: ATLAS_FILE.into(),
                rect: [1, 0, 1, 1],
                gaze: Some([0.0, 0.5]),
            },
            PetFrame {
                id: "c".into(),
                kind: PetFrameKind::Reaction,
                sheet: ATLAS_FILE.into(),
                rect: [2, 0, 1, 1],
                gaze: None,
            },
        ];
        assert_eq!(neutral_id(&frames).as_deref(), Some("b"));
    }

    #[test]
    fn lossless_webp_round_trips_every_pixel() {
        let mut atlas = RgbaImage::new(40, 24);
        for (x, y, pixel) in atlas.enumerate_pixels_mut() {
            *pixel = Rgba([
                (x * 6) as u8,
                (y * 10) as u8,
                77,
                if x.is_multiple_of(3) { 0 } else { 200 },
            ]);
        }
        let bytes = encode_lossless_webp(&atlas).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap().into_rgba8();
        assert_eq!(decoded.dimensions(), (40, 24));
        for (a, b) in decoded.pixels().zip(atlas.pixels()) {
            if b.0[3] == 0 {
                assert_eq!(a.0[3], 0);
            } else {
                assert_eq!(a, b);
            }
        }
    }

    #[test]
    fn head_top_is_the_normalised_silhouette_top() {
        let mut cell = RgbaImage::new(100, 100);
        for y in 18..90 {
            cell.put_pixel(50, y, Rgba([0, 0, 0, 255]));
        }
        assert!((head_top(&cell) - 0.18).abs() < 1e-12);
        assert_eq!(head_top(&RgbaImage::new(4, 4)), 0.0);
    }
}
