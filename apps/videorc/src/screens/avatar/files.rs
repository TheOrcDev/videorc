//! The files the onboarding and the Alive creator read: a picture the
//! streamer chooses (sent once as base64, never kept), the draft's poses and
//! a creation's stored sources and built moves, read straight from the buddy
//! write root (plan 260: the UI reads files directly, as Electron's main
//! process did for `readBuddyCreationFile`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui::{Image, ImageFormat};
use serde::Deserialize;

use super::pictures::BUDDY_ASSETS_FOLDER;

/// `BUDDY_LOOK_PICTURE_MAX_BYTES`: the onboarding refuses a bigger file
/// before reading it.
pub const LOOK_PICTURE_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// `BUDDY_LOOK_SEND_MAX_BYTES`: what the backend takes (Vercel's body cap).
/// Electron shrinks a bigger picture first; this app has no encoder yet, so
/// a bigger one is refused with the backend's own words.
pub const LOOK_SEND_MAX_BYTES: u64 = 3 * 1024 * 1024;
/// `BUDDY_PET_REFERENCE_UPLOAD_MAX_BYTES`.
pub const REFERENCE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// `BUDDY_PET_FILE_MAX_BYTES`: a creation file is read only below this.
const CREATION_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// A picture's kind, from its first bytes (what the backend checks too).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PictureKind {
    Png,
    Jpeg,
    Webp,
}

impl PictureKind {
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']) {
            Some(Self::Png)
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Self::Jpeg)
        } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else {
            None
        }
    }

    fn format(self) -> ImageFormat {
        match self {
            Self::Png => ImageFormat::Png,
            Self::Jpeg => ImageFormat::Jpeg,
            Self::Webp => ImageFormat::Webp,
        }
    }
}

/// A chosen picture: its name for the row, its file for the thumbnail and
/// the bytes as the backend takes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChosenPicture {
    pub name: String,
    pub path: PathBuf,
    pub base64: String,
}

/// Why a chosen file can't be used, in the streamer's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChooseError {
    /// Not one of the kinds asked for.
    Kind,
    /// Over the size the caller allows.
    TooLarge,
    /// Missing, empty or unreadable.
    Unreadable,
}

/// Reads `path` as one of `kinds`, at most `max_bytes`. Blocking: run it off
/// the UI thread.
pub fn read_picture(
    path: &Path,
    kinds: &[PictureKind],
    max_bytes: u64,
) -> Result<ChosenPicture, ChooseError> {
    let size = std::fs::metadata(path)
        .map_err(|_| ChooseError::Unreadable)?
        .len();
    if size > max_bytes {
        return Err(ChooseError::TooLarge);
    }
    let bytes = std::fs::read(path).map_err(|_| ChooseError::Unreadable)?;
    if bytes.is_empty() {
        return Err(ChooseError::Unreadable);
    }
    let kind = PictureKind::sniff(&bytes).ok_or(ChooseError::Kind)?;
    if !kinds.contains(&kind) {
        return Err(ChooseError::Kind);
    }
    Ok(ChosenPicture {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_path_buf(),
        base64: base64(&bytes),
    })
}

/// A picture file as an image GPUI draws, read fresh (a redone pose keeps
/// its path, so the path alone would show the old one). Blocking.
pub fn load_image(path: &Path) -> Option<Arc<Image>> {
    let bytes = std::fs::read(path).ok()?;
    let kind = PictureKind::sniff(&bytes)?;
    Some(Arc::new(Image::from_bytes(kind.format(), bytes)))
}

/// Standard base64 with padding (RFC 4648), as `FileReader.readAsDataURL`
/// gives after its prefix.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(char::from(ALPHABET[(triple >> 18) as usize & 63]));
        out.push(char::from(ALPHABET[(triple >> 12) as usize & 63]));
        out.push(if chunk.len() > 1 {
            char::from(ALPHABET[(triple >> 6) as usize & 63])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(ALPHABET[triple as usize & 63])
        } else {
            '='
        });
    }
    out
}

/// `isBuddyCreationFileName`: a stored source (`sources/<sheet>-v<n>.png`)
/// or the built moves (`pack/manifest.json`, `pack/mascot.webp`).
fn creation_file_name(file: &str) -> bool {
    if file == "pack/manifest.json" || file == "pack/mascot.webp" {
        return true;
    }
    let Some(stem) = file
        .strip_prefix("sources/")
        .and_then(|rest| rest.strip_suffix(".png"))
    else {
        return false;
    };
    let Some((sheet, version)) = stem.rsplit_once("-v") else {
        return false;
    };
    (1..=40).contains(&sheet.len())
        && sheet
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && (1..=4).contains(&version.len())
        && version.bytes().all(|byte| byte.is_ascii_digit())
}

/// A persona or build id as a single safe folder name.
fn plain_id(id: &str) -> bool {
    (1..=80).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// `readBuddyCreationFile`'s path: `<userData>/buddy-assets/<personaId>/
/// creations/<buildId>/<file>`; None for anything else.
pub fn creation_file(
    user_data_dir: &Path,
    persona_id: &str,
    build_id: &str,
    file: &str,
) -> Option<PathBuf> {
    if !plain_id(persona_id) || !plain_id(build_id) || !creation_file_name(file) {
        return None;
    }
    let mut path = user_data_dir
        .join(BUDDY_ASSETS_FOLDER)
        .join(persona_id)
        .join("creations")
        .join(build_id);
    for part in file.split('/') {
        path.push(part);
    }
    Some(path)
}

/// One frame of the built moves: where it sits in the atlas.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// The built moves as Check draws them (`useCreationAtlas`): the atlas and
/// every frame's place in it.
#[derive(Clone)]
pub struct Atlas {
    pub image: Arc<Image>,
    pub width: f32,
    pub height: f32,
    pub frames: Vec<(String, Rect)>,
    pub neutral: String,
}

impl Atlas {
    pub fn frame(&self, id: &str) -> Option<Rect> {
        self.frames
            .iter()
            .find(|(frame, _)| frame == id)
            .map(|(_, rect)| *rect)
    }
}

#[derive(Deserialize)]
struct Manifest {
    neutral: String,
    frames: Vec<ManifestFrame>,
}

#[derive(Deserialize)]
struct ManifestFrame {
    id: String,
    rect: [f32; 4],
}

/// The manifest's frames, and the atlas size they span.
fn parse_manifest(text: &str) -> Option<(String, Vec<(String, Rect)>, f32, f32)> {
    let manifest: Manifest = serde_json::from_str(text).ok()?;
    let frames: Vec<(String, Rect)> = manifest
        .frames
        .into_iter()
        .map(|frame| {
            let [x, y, w, h] = frame.rect;
            (frame.id, Rect { x, y, w, h })
        })
        .collect();
    let width = frames
        .iter()
        .map(|(_, rect)| rect.x + rect.w)
        .fold(0., f32::max);
    let height = frames
        .iter()
        .map(|(_, rect)| rect.y + rect.h)
        .fold(0., f32::max);
    (width > 0. && height > 0.).then_some((manifest.neutral, frames, width, height))
}

/// Reads a creation's built moves. Blocking.
pub fn load_atlas(user_data_dir: &Path, persona_id: &str, build_id: &str) -> Option<Atlas> {
    let read = |file: &str| {
        let path = creation_file(user_data_dir, persona_id, build_id, file)?;
        let size = std::fs::metadata(&path).ok()?.len();
        (size > 0 && size <= CREATION_FILE_MAX_BYTES)
            .then(|| std::fs::read(&path).ok())
            .flatten()
    };
    let manifest = String::from_utf8(read("pack/manifest.json")?).ok()?;
    let (neutral, frames, width, height) = parse_manifest(&manifest)?;
    let bytes = read("pack/mascot.webp")?;
    Some(Atlas {
        image: Arc::new(Image::from_bytes(ImageFormat::Webp, bytes)),
        width,
        height,
        frames,
        neutral,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn pictures_are_known_by_their_first_bytes() {
        assert_eq!(
            PictureKind::sniff(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0]),
            Some(PictureKind::Png)
        );
        assert_eq!(
            PictureKind::sniff(&[0xff, 0xd8, 0xff, 0xe0]),
            Some(PictureKind::Jpeg)
        );
        assert_eq!(
            PictureKind::sniff(b"RIFF\0\0\0\0WEBPVP8 "),
            Some(PictureKind::Webp)
        );
        assert_eq!(PictureKind::sniff(b"GIF89a"), None);
    }

    #[test]
    fn a_chosen_picture_is_read_once_and_checked() {
        let dir = std::env::temp_dir().join(format!("videorc-avatar-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("pet.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 1]).unwrap();
        let chosen = read_picture(&png, &[PictureKind::Png], 1024).unwrap();
        assert_eq!(chosen.name, "pet.png");
        assert_eq!(
            chosen.base64,
            base64(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 1])
        );
        assert_eq!(
            read_picture(&png, &[PictureKind::Webp], 1024),
            Err(ChooseError::Kind)
        );
        assert_eq!(
            read_picture(&png, &[PictureKind::Png], 4),
            Err(ChooseError::TooLarge)
        );
        assert_eq!(
            read_picture(&dir.join("missing.png"), &[PictureKind::Png], 1024),
            Err(ChooseError::Unreadable)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn creation_files_stay_in_their_folder() {
        let root = Path::new("/data");
        assert_eq!(
            creation_file(root, "p1", "b-2", "sources/gaze-level-v2.png"),
            Some(PathBuf::from(
                "/data/buddy-assets/p1/creations/b-2/sources/gaze-level-v2.png"
            ))
        );
        assert_eq!(
            creation_file(root, "p1", "b", "pack/mascot.webp"),
            Some(PathBuf::from(
                "/data/buddy-assets/p1/creations/b/pack/mascot.webp"
            ))
        );
        for (persona, build, file) in [
            ("..", "b", "pack/mascot.webp"),
            ("p1", "a/b", "pack/mascot.webp"),
            ("p1", "b", "sources/../x-v1.png"),
            ("p1", "b", "sources/Pilot-v1.png"),
            ("p1", "b", "sources/pilot-v12345.png"),
            ("p1", "b", "pack/other.json"),
        ] {
            assert_eq!(creation_file(root, persona, build, file), None, "{file}");
        }
    }

    #[test]
    fn the_manifest_spans_its_frames() {
        let (neutral, frames, width, height) = parse_manifest(
            r#"{"neutral":"gaze-2-2","frames":[{"id":"gaze-2-2","rect":[0,0,64,64]},{"id":"wave","rect":[64,128,64,64]}]}"#,
        )
        .unwrap();
        assert_eq!(neutral, "gaze-2-2");
        assert_eq!(frames.len(), 2);
        assert_eq!((width, height), (128., 192.));
        assert!(parse_manifest(r#"{"neutral":"x","frames":[]}"#).is_none());
    }
}
