//! The living preview's pack (plan 220 S3.10d): where a worn pack's files
//! are (`readBuddyPetFile`, `main/buddy-assets.ts`), its page-pet manifest
//! (`manifest.json`, as the backend's `PetManifest` reads it) and the cells
//! the preview draws (`lib/buddy-pet-preview-pack.ts`). Reading files and
//! decoding pictures is the app's; this names them and checks the paths.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::pet_player::{Frame, Pack};

/// The manifest's file name in a pack folder.
pub const MANIFEST_FILE: &str = "manifest.json";
/// `bundled:<name>`: a pack shipped with the app.
pub const BUNDLED_PREFIX: &str = "bundled:";
/// `official:<slug>`: a downloaded official pack.
pub const OFFICIAL_PREFIX: &str = "official:";
/// Where downloaded official packs live under the write root.
pub const OFFICIAL_DIR: &str = "official";
/// The most bytes one pack file may hold (`BUDDY_PET_FILE_MAX_BYTES`).
pub const FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// `officialAlivePackVersion`: the downloadable official packs' versions
/// (the catalog's; the default avatar's pack ships inside the app).
pub fn official_version(slug: &str) -> Option<u32> {
    match slug {
        "orc" | "goblin" | "pirate" | "robot" => Some(1),
        _ => None,
    }
}

/// A pack id the preview can open: a user pack (a uuid-like token), a
/// bundled one or an official one.
fn plain_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The folder of `pack_id` for `persona_id` (`readBuddyPetFile`'s rule), and
/// the root it must stay inside.
pub fn pack_folder(
    write_root: &Path,
    bundled_root: &Path,
    persona_id: &str,
    pack_id: &str,
) -> Option<(PathBuf, PathBuf)> {
    if !plain_token(persona_id) {
        return None;
    }
    if let Some(name) = pack_id.strip_prefix(BUNDLED_PREFIX) {
        return plain_token(name).then(|| (bundled_root.join(name), bundled_root.to_path_buf()));
    }
    if let Some(slug) = pack_id.strip_prefix(OFFICIAL_PREFIX) {
        let version = official_version(slug)?;
        return Some((
            write_root
                .join(OFFICIAL_DIR)
                .join(slug)
                .join(version.to_string()),
            write_root.to_path_buf(),
        ));
    }
    plain_token(pack_id).then(|| {
        (
            write_root.join(persona_id).join("pets").join(pack_id),
            write_root.to_path_buf(),
        )
    })
}

/// One file of a pack, inside its root (symlinks resolved), at most 32 MB;
/// None for anything else.
pub fn read_pack_file(folder: &Path, root: &Path, file: &str) -> Option<Vec<u8>> {
    if !plain_file_name(file) {
        return None;
    }
    let path = folder.join(file);
    let resolved = std::fs::canonicalize(&path).ok()?;
    let resolved_root = std::fs::canonicalize(root).ok()?;
    if !resolved.starts_with(&resolved_root) {
        return None;
    }
    let meta = std::fs::metadata(&resolved).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > FILE_MAX_BYTES {
        return None;
    }
    std::fs::read(&resolved).ok()
}

fn plain_file_name(file: &str) -> bool {
    !file.is_empty()
        && file.len() <= 128
        && !file.starts_with('.')
        && file
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFrame {
    id: String,
    kind: String,
    sheet: String,
    rect: [u32; 4],
    #[serde(default)]
    gaze: Option<[f64; 2]>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    name: String,
    neutral: String,
    #[serde(default)]
    pivot: Option<[f64; 2]>,
    frames: Vec<ManifestFrame>,
}

/// One frame's drawable: `rect` (sheet pixels) of `sheet`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    pub frame: String,
    pub sheet: String,
    pub rect: [u32; 4],
}

/// A pack as the preview plays it.
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewPack {
    pub name: String,
    pub pack: Pack,
    pub cells: Vec<Cell>,
    /// Every sheet the frames name, each once.
    pub sheets: Vec<String>,
}

/// A manifest read for the preview: the frames the player plays and the
/// cells they draw. None when it doesn't read, names no frames, or its
/// neutral is not one of its gaze frames.
pub fn read_manifest(bytes: &[u8]) -> Option<PreviewPack> {
    let manifest: Manifest = serde_json::from_slice(bytes).ok()?;
    if manifest.frames.is_empty() {
        return None;
    }
    let mut frames = Vec::new();
    let mut cells = Vec::new();
    let mut sheets: Vec<String> = Vec::new();
    for frame in &manifest.frames {
        let reaction = match frame.kind.as_str() {
            "gaze" => false,
            "reaction" => true,
            _ => return None,
        };
        if !plain_file_name(&frame.sheet) || frame.rect[2] == 0 || frame.rect[3] == 0 {
            return None;
        }
        frames.push(Frame {
            id: frame.id.clone(),
            reaction,
            gaze: if reaction { None } else { frame.gaze },
        });
        cells.push(Cell {
            frame: frame.id.clone(),
            sheet: frame.sheet.clone(),
            rect: frame.rect,
        });
        if !sheets.contains(&frame.sheet) {
            sheets.push(frame.sheet.clone());
        }
    }
    let neutral_ok = frames
        .iter()
        .any(|frame| frame.id == manifest.neutral && !frame.reaction);
    neutral_ok.then_some(PreviewPack {
        name: manifest.name,
        pack: Pack {
            neutral: manifest.neutral,
            pivot: manifest.pivot,
            frames,
        },
        cells,
        sheets,
    })
}

/// A Still persona as a pack: its idle picture the neutral cell and its
/// talk, laugh and think pictures reactions (`BUDDY_STILL_PACK_ID`, the
/// backend's Still pack), each a whole picture.
pub fn still_pack(states: &[(&str, bool)]) -> Pack {
    Pack {
        neutral: "idle".into(),
        pivot: None,
        frames: states
            .iter()
            .map(|(id, reaction)| Frame {
                id: (*id).to_string(),
                reaction: *reaction,
                gaze: (!*reaction).then_some([0.0, 0.0]),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pack_folder_follows_main_s_rule() {
        let write = Path::new("/w");
        let bundled = Path::new("/b");
        assert_eq!(
            pack_folder(write, bundled, "p1", "bundled:buddy"),
            Some((PathBuf::from("/b/buddy"), PathBuf::from("/b")))
        );
        assert_eq!(
            pack_folder(write, bundled, "p1", "official:orc"),
            Some((PathBuf::from("/w/official/orc/1"), PathBuf::from("/w")))
        );
        assert_eq!(
            pack_folder(write, bundled, "p1", "a1b2"),
            Some((PathBuf::from("/w/p1/pets/a1b2"), PathBuf::from("/w")))
        );
        assert_eq!(pack_folder(write, bundled, "p1", "../x"), None);
        assert_eq!(pack_folder(write, bundled, "p1", "official:dragon"), None);
        assert_eq!(pack_folder(write, bundled, "../p", "a1"), None);
    }

    #[test]
    fn a_manifest_reads_into_frames_and_cells() {
        let manifest = br#"{"version":1,"name":"Grum","neutral":"c","pivot":[0.5,0.9],
            "frames":[{"id":"c","kind":"gaze","sheet":"gaze.webp","rect":[0,0,640,640],"gaze":[0,0]},
                      {"id":"wave","kind":"reaction","sheet":"react.webp","rect":[640,0,640,640]}]}"#;
        let pack = read_manifest(manifest).unwrap();
        assert_eq!(pack.name, "Grum");
        assert_eq!(pack.pack.frames.len(), 2);
        assert!(pack.pack.frames[1].reaction);
        assert_eq!(pack.sheets, ["gaze.webp", "react.webp"]);
        assert!(read_manifest(br#"{"neutral":"x","frames":[]}"#).is_none());
        assert!(
            read_manifest(br#"{"neutral":"wave","frames":[{"id":"wave","kind":"reaction","sheet":"a.webp","rect":[0,0,1,1]}]}"#)
                .is_none()
        );
    }
}
