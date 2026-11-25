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
    fn the_official_five_ship_their_idle_pose() {
        for slug in ["golem", "orc", "goblin", "pirate", "robot"] {
            assert!(official_idle(slug).is_some(), "{slug}");
        }
        assert!(official_idle("dragon").is_none());
    }
}
