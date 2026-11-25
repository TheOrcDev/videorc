//! The avatar's pictures: the official five's idle poses, shipped in the
//! binary as Electron's renderer ships them (`lib/buddy-official-art.ts`),
//! and the managed `videorc-asset://buddy/...` pictures, read straight from
//! the buddy write root (plan 260: the UI reads files directly, no scheme).

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

use gpui::{Image, ImageFormat};

/// Electron's `BUDDY_ASSETS_FOLDER`: the buddy write root under user data.
pub const BUDDY_ASSETS_FOLDER: &str = "buddy-assets";
const ASSET_PREFIX: &str = "videorc-asset://buddy/";

const GOLEM: &[u8] =
    include_bytes!("../../../../desktop/src/renderer/src/assets/buddy/default/idle.webp");
const ORC: &[u8] =
    include_bytes!("../../../../desktop/src/renderer/src/assets/buddy/official/orc/idle.webp");
const GOBLIN: &[u8] =
    include_bytes!("../../../../desktop/src/renderer/src/assets/buddy/official/goblin/idle.webp");
const PIRATE: &[u8] =
    include_bytes!("../../../../desktop/src/renderer/src/assets/buddy/official/pirate/idle.webp");
const ROBOT: &[u8] =
    include_bytes!("../../../../desktop/src/renderer/src/assets/buddy/official/robot/idle.webp");

fn official_bytes(slug: &str) -> Option<&'static [u8]> {
    Some(match slug {
        "golem" => GOLEM,
        "orc" => ORC,
        "goblin" => GOBLIN,
        "pirate" => PIRATE,
        "robot" => ROBOT,
        _ => return None,
    })
}

/// An official character's idle pose, decoded once per slug.
pub fn official_idle(slug: &str) -> Option<Arc<Image>> {
    static IMAGES: OnceLock<Vec<(&'static str, Arc<Image>)>> = OnceLock::new();
    let images = IMAGES.get_or_init(|| {
        ["golem", "orc", "goblin", "pirate", "robot"]
            .into_iter()
            .filter_map(|slug| {
                let bytes = official_bytes(slug)?;
                Some((
                    slug,
                    Arc::new(Image::from_bytes(ImageFormat::Webp, bytes.to_vec())),
                ))
            })
            .collect()
    });
    images
        .iter()
        .find(|(known, _)| *known == slug)
        .map(|(_, image)| image.clone())
}

const GOLEM_TALK: &[u8] =
    include_bytes!("../../../../desktop/src/renderer/src/assets/buddy/default/talk.webp");
const GOLEM_LAUGH: &[u8] =
    include_bytes!("../../../../desktop/src/renderer/src/assets/buddy/default/laugh.webp");
const GOLEM_THINK: &[u8] =
    include_bytes!("../../../../desktop/src/renderer/src/assets/buddy/default/think.webp");

/// The default pack's picture for a state (`BUDDY_DEFAULT_PACK`): idle,
/// talk, laugh or think.
pub fn default_state(state: &str) -> Option<Arc<Image>> {
    static IMAGES: OnceLock<Vec<(&'static str, Arc<Image>)>> = OnceLock::new();
    if state == "idle" {
        return default_idle();
    }
    let images = IMAGES.get_or_init(|| {
        [
            ("talk", GOLEM_TALK),
            ("laugh", GOLEM_LAUGH),
            ("think", GOLEM_THINK),
        ]
        .into_iter()
        .map(|(state, bytes)| {
            (
                state,
                Arc::new(Image::from_bytes(ImageFormat::Webp, bytes.to_vec())),
            )
        })
        .collect()
    });
    images
        .iter()
        .find(|(known, _)| *known == state)
        .map(|(_, image)| image.clone())
}

/// A PNG's or WebP's pixel size, from its header: the sprite sheet's, so
/// one cell can be cut out of it. None for anything else.
pub fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let be = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    };
    let le24 = |at: usize| -> Option<u32> {
        let b = bytes.get(at..at + 3)?;
        Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
    };
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(&b"IHDR"[..]) {
        return Some((be(16)?, be(20)?));
    }
    if bytes.get(0..4) != Some(&b"RIFF"[..]) || bytes.get(8..12) != Some(&b"WEBP"[..]) {
        return None;
    }
    match bytes.get(12..16)? {
        b"VP8X" => Some((le24(24)? + 1, le24(27)? + 1)),
        b"VP8L" => {
            let b = bytes.get(21..25)?;
            let bits = u32::from_le_bytes(b.try_into().ok()?);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8 " => {
            let w = u16::from_le_bytes(bytes.get(26..28)?.try_into().ok()?) & 0x3fff;
            let h = u16::from_le_bytes(bytes.get(28..30)?.try_into().ok()?) & 0x3fff;
            Some((u32::from(w), u32::from(h)))
        }
        _ => None,
    }
}

/// The stone golem: the default avatar's picture (`BuddyEmblem` with no
/// picture of its own).
pub fn default_idle() -> Option<Arc<Image>> {
    official_idle("golem")
}

/// A managed picture's file: a `videorc-asset://buddy/<path>` URL (the
/// library's cached poses) or a persona's relative image path
/// (`<personaId>/<state>-<tag>.<ext>`), under `<userData>/buddy-assets/`.
/// None for anything that would leave the root.
pub fn managed_path(user_data_dir: &Path, picture: &str) -> Option<PathBuf> {
    let relative = picture.strip_prefix(ASSET_PREFIX).unwrap_or(picture);
    let relative = relative.split(['?', '#']).next().unwrap_or_default();
    if relative.is_empty() || relative.contains("://") {
        return None;
    }
    let path = Path::new(relative);
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(user_data_dir.join(BUDDY_ASSETS_FOLDER).join(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_pictures_resolve_under_the_buddy_root() {
        let root = Path::new("/data");
        assert_eq!(
            managed_path(root, "videorc-asset://buddy/library/a/idle-1.png"),
            Some(PathBuf::from("/data/buddy-assets/library/a/idle-1.png"))
        );
        assert_eq!(
            managed_path(root, "p1/idle-3.webp"),
            Some(PathBuf::from("/data/buddy-assets/p1/idle-3.webp"))
        );
        assert_eq!(
            managed_path(root, "p1/drafts/r/idle.png?v=12"),
            Some(PathBuf::from("/data/buddy-assets/p1/drafts/r/idle.png"))
        );
    }

    #[test]
    fn nothing_leaves_the_buddy_root() {
        let root = Path::new("/data");
        for picture in [
            "",
            "../secret.png",
            "videorc-asset://buddy/../x.png",
            "/etc/passwd",
            "videorc-asset://banner/a.png",
        ] {
            assert_eq!(managed_path(root, picture), None, "{picture}");
        }
    }

    #[test]
    fn sheet_sizes_read_from_their_headers() {
        // The shipped pictures are WebP; each reads as a sensible size.
        for bytes in [GOLEM, ORC, GOLEM_TALK] {
            let (w, h) = image_size(bytes).expect("a WebP size");
            assert!(w > 16 && h > 16 && w <= 8192 && h <= 8192, "{w}x{h}");
        }
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((640, 480)));
        assert_eq!(image_size(b"not a picture"), None);
        assert!(default_state("laugh").is_some());
        assert!(default_state("dance").is_none());
    }

    #[test]
    fn the_official_five_ship_their_idle_pose() {
        for slug in ["golem", "orc", "goblin", "pirate", "robot"] {
            assert!(official_idle(slug).is_some(), "{slug}");
        }
        assert!(official_idle("dragon").is_none());
    }
}
