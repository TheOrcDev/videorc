//! Images page words, byte for byte with Electron
//! (`tabs/assets-tab.tsx`, `banners-section.tsx`, `takeover-screens-section.tsx`,
//! `live-backgrounds-group.tsx`, `background-replace-dialog.tsx`).

pub const TITLE: &str = "Images";
pub const DESCRIPTION: &str = "Backgrounds for your scenes, banners for your picture and takeovers for the output. Click a background to apply it, then tune it with Adjust style on its tile.";

pub const BACKGROUNDS: &str = "Backgrounds";
pub const BACKGROUNDS_DESCRIPTION: &str =
    "Live backgrounds move behind your screen and camera. Images can be PNG, JPEG or WebP.";
pub const IMPORT_IMAGE: &str = "Import image…";
pub const IMPORTING: &str = "Importing…";
pub const USE_NO_BACKGROUND: &str = "Use no background";
pub const IN_THIS_SCENE: &str = "In this scene:";
pub const LIVE_GROUP: &str = "Live";
pub const IMAGES_GROUP: &str = "Images";
pub const ADD_IMAGE: &str = "Add image…";
pub const RESTORE_DEFAULT: &str = "Restore default";
pub const ADJUST_STYLE: &str = "Adjust style";
pub const FIT: &str = "Fit";
pub const FIT_FILL: &str = "Fill";
pub const FIT_FIT: &str = "Fit";
pub const FIT_STRETCH: &str = "Stretch";

pub const STATUS_EMPTY: &str = "Empty";
pub const STATUS_READY: &str = "Ready";
pub const STATUS_ACTIVE: &str = "In use";
pub const STATUS_MISSING: &str = "File missing";
pub const STATUS_UNSUPPORTED: &str = "Unsupported";

pub const REMOVE_APPLIED_TITLE: &str = "Remove applied background?";
pub const REMOVE_TITLE_PREFIX: &str = "Remove ";
pub const REMOVE_BACKGROUND: &str = "Remove background";
pub const REMOVE_APPLIED_DESCRIPTION: &str = "This empties the library slot and removes the background from the current scene, including a running recording or stream. Other scenes keep their copy.";
pub const REMOVE_SLOT_DESCRIPTION: &str = "The imported image is deleted from this computer. The slot stays empty until you restore its built-in background or import another.";

pub const REPLACE_WHICH: &str = "Replace which background?";
pub const REPLACE_PREFIX: &str = "Replace ";

pub const BANNERS: &str = "Banners";
pub const BANNERS_DESCRIPTION: &str = "Images you place on your picture: a sponsor, your socials, a logo. PNG with transparency works best. Sharp sizes: wide banner 2400 × 400, logo 512 × 512, full frame 3840 × 2160. An HTML banner is a web page with a transparent background, so it can move: import an .html file, or a folder with index.html.";
pub const IMPORT_HTML: &str = "Import HTML…";
pub const CHOOSING_IMAGE: &str = "Choosing image…";
pub const CHOOSING_HTML: &str = "Choosing HTML…";
pub const LOADING_BANNERS: &str = "Loading banners…";
pub const NO_BANNERS: &str = "No banners yet";
pub const DELETE_BANNER_TITLE: &str = "Delete banner?";
pub const DELETE_BANNER: &str = "Delete banner";
pub const DELETING: &str = "Deleting…";
pub const SHOW: &str = "Show";
pub const HIDE: &str = "Hide";
pub const PLACE_ON_SCENE: &str = "Place on Scene";
pub const RENAME_ELLIPSIS: &str = "Rename…";
pub const MOVE_EARLIER: &str = "Move earlier";
pub const MOVE_LATER: &str = "Move later";
pub const DELETE_ELLIPSIS: &str = "Delete…";
pub const SHOWING: &str = "Showing";

pub const TAKEOVERS: &str = "Takeovers";
pub const TAKEOVERS_DESCRIPTION: &str = "Full-frame images that cover the output, turned on from the Studio. Turning one on mutes your microphone until you turn it off. Drop images here to import them.";
pub const IMPORT_IMAGES: &str = "Import images…";
pub const CHOOSING_SOUNDS_IMAGES: &str = "Choosing images…";
pub const LOADING_TAKEOVERS: &str = "Loading takeovers…";
pub const NO_TAKEOVERS: &str = "No takeovers yet";
pub const NO_TAKEOVERS_HINT: &str =
    "Import or drop PNG, JPEG or WebP images to make the first ones.";
pub const DELETE_TAKEOVER_PREFIX: &str = "Delete ";
pub const DELETE_TAKEOVER_SUFFIX: &str = "?";
pub const DELETE_TAKEOVER: &str = "Delete takeover";
pub const DELETE_TAKEOVER_DESCRIPTION: &str = "Its image file is deleted from this computer.";
pub const QUIET_ALERT: &str = "You can import images now. Stop recording or end the livestream to rename, reorder or delete takeovers.";
pub const SAVE_TAKEOVER_NAME: &str = "Save takeover name";
pub const TAKEOVER_NAME: &str = "Takeover name";

pub const CANCEL: &str = "Cancel";
pub const OFFLINE_LOCK: &str = "Videorc is reconnecting. These controls come back in a moment.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_words_match_electron() {
        assert_eq!(TITLE, "Images");
        assert!(DESCRIPTION.contains("Backgrounds for your scenes"));
        assert_eq!(BANNERS, "Banners");
        assert_eq!(NO_BANNERS, "No banners yet");
        assert_eq!(TAKEOVERS, "Takeovers");
        assert_eq!(NO_TAKEOVERS, "No takeovers yet");
        assert_eq!(IMPORT_IMAGE, "Import image…");
        assert_eq!(IMPORT_HTML, "Import HTML…");
    }
}
