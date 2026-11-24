//! The platforms' own marks the overlays draw: YouTube's icon (plan 165), X's
//! mark and X's verified checks (plan 167). They are the renderer's files,
//! unmodified (`apps/desktop/src/renderer/src/assets/brand/`), drawn as
//! vectors at the size they land at, as the canvas draws an SVG image.

use std::sync::OnceLock;

use resvg::usvg;
use tiny_skia::{Pixmap, Transform};

use crate::live_chat::LiveChatAuthorVerified;

/// The official file's artboard, which includes YouTube's clear space
/// (`YOUTUBE_ARTBOARD`).
#[cfg(test)]
const YOUTUBE_ARTBOARD: (f32, f32) = (602.187, 515.868);
/// The red mark's bounds inside the artboard, in the file's own units
/// (`YOUTUBE_MARK`): x, y, width, height.
const YOUTUBE_MARK: (f64, f64, f64, f64) = (102.6875, 119.167969, 396.0, 277.402343);
/// The mark is never drawn shorter than this (`YOUTUBE_MARK_MIN_PX`).
pub(crate) const YOUTUBE_MARK_MIN_PX: f64 = 20.0;

/// Width over height of the visible mark (`YOUTUBE_MARK_ASPECT`, about 1.43).
pub(crate) fn youtube_mark_aspect() -> f64 {
    YOUTUBE_MARK.2 / YOUTUBE_MARK.3
}

const YOUTUBE_ICON: &[u8] = include_bytes!(
    "../../../../apps/desktop/src/renderer/src/assets/brand/youtube/youtube-icon-red.svg"
);
const X_LOGO_WHITE: &[u8] =
    include_bytes!("../../../../apps/desktop/src/renderer/src/assets/brand/x/x-logo-white.svg");
const X_VERIFIED_BLUE: &[u8] = include_bytes!(
    "../../../../apps/desktop/src/renderer/src/assets/brand/x/verified-premium-blue.svg"
);
const X_VERIFIED_BUSINESS: &[u8] = include_bytes!(
    "../../../../apps/desktop/src/renderer/src/assets/brand/x/verified-business-gold.svg"
);
const X_VERIFIED_GOVERNMENT: &[u8] = include_bytes!(
    "../../../../apps/desktop/src/renderer/src/assets/brand/x/verified-government-gray.svg"
);

/// One mark file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mark {
    /// YouTube's full-colour icon, drawn cropped to the red mark.
    Youtube,
    /// X's mark in white, for the dark glass.
    X,
    /// X's verified check of one type. Never tinted.
    Verified(LiveChatAuthorVerified),
}

impl Mark {
    fn bytes(self) -> &'static [u8] {
        match self {
            Self::Youtube => YOUTUBE_ICON,
            Self::X => X_LOGO_WHITE,
            Self::Verified(LiveChatAuthorVerified::Blue) => X_VERIFIED_BLUE,
            Self::Verified(LiveChatAuthorVerified::Business) => X_VERIFIED_BUSINESS,
            Self::Verified(LiveChatAuthorVerified::Government) => X_VERIFIED_GOVERNMENT,
        }
    }

    fn slot(self) -> &'static OnceLock<Option<usvg::Tree>> {
        static TREES: [OnceLock<Option<usvg::Tree>>; 5] = [const { OnceLock::new() }; 5];
        &TREES[match self {
            Self::Youtube => 0,
            Self::X => 1,
            Self::Verified(LiveChatAuthorVerified::Blue) => 2,
            Self::Verified(LiveChatAuthorVerified::Business) => 3,
            Self::Verified(LiveChatAuthorVerified::Government) => 4,
        }]
    }

    /// The parsed file, once per process; None (logged once) if it does not
    /// parse, and the card then names the platform in words or shows no
    /// check, as the renderer did when its image failed to load.
    fn tree(self) -> Option<&'static usvg::Tree> {
        self.slot()
            .get_or_init(
                || match usvg::Tree::from_data(self.bytes(), &usvg::Options::default()) {
                    Ok(tree) => Some(tree),
                    Err(error) => {
                        tracing::warn!("Overlay: the {self:?} mark did not load ({error}).");
                        None
                    }
                },
            )
            .as_ref()
    }

    /// Whether the mark can be drawn (`platformMark`/`verifiedMark` loaded).
    pub(crate) fn available(self) -> bool {
        self.tree().is_some()
    }
}

/// `ctx.drawImage(mark, x, y, w, h)`; YouTube's icon as
/// `drawImage(icon, …YOUTUBE_MARK, x, y, w, h)`, the mark's bounds out of the
/// artboard.
pub(crate) fn draw_mark(target: &mut Pixmap, mark: Mark, x: f32, y: f32, w: f32, h: f32) {
    let Some(tree) = mark.tree() else {
        return;
    };
    let size = tree.size();
    let (src_x, src_y, src_w, src_h) = match mark {
        Mark::Youtube => (
            YOUTUBE_MARK.0 as f32,
            YOUTUBE_MARK.1 as f32,
            YOUTUBE_MARK.2 as f32,
            YOUTUBE_MARK.3 as f32,
        ),
        _ => (0.0, 0.0, size.width(), size.height()),
    };
    if src_w <= 0.0 || src_h <= 0.0 || w <= 0.0 || h <= 0.0 {
        return;
    }
    let (scale_x, scale_y) = (w / src_w, h / src_h);
    let transform = Transform::from_row(
        scale_x,
        0.0,
        0.0,
        scale_y,
        x - src_x * scale_x,
        y - src_y * scale_y,
    );
    resvg::render(tree, transform, &mut target.as_mut());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mark_parses_and_youtube_keeps_its_artboard() {
        for mark in [
            Mark::Youtube,
            Mark::X,
            Mark::Verified(LiveChatAuthorVerified::Blue),
            Mark::Verified(LiveChatAuthorVerified::Business),
            Mark::Verified(LiveChatAuthorVerified::Government),
        ] {
            assert!(mark.available(), "{mark:?}");
        }
        let size = Mark::Youtube.tree().expect("tree").size();
        assert!((size.width() - YOUTUBE_ARTBOARD.0).abs() < 0.01);
        assert!((size.height() - YOUTUBE_ARTBOARD.1).abs() < 0.01);
    }

    #[test]
    fn the_youtube_mark_fills_its_box_in_red_and_white() {
        let mut target = Pixmap::new(40, 30).expect("pixmap");
        let h = 20.0;
        let w = (h * youtube_mark_aspect()).ceil() as f32;
        draw_mark(&mut target, Mark::Youtube, 5.0, 5.0, w, h as f32);
        // The red body near the left edge, the white play triangle mid-left.
        let body = target.pixel(8, 15).expect("pixel");
        assert!(body.red() > 200 && body.green() < 40, "{body:?}");
        assert_eq!(target.pixel(2, 15).expect("pixel").alpha(), 0);
    }
}
