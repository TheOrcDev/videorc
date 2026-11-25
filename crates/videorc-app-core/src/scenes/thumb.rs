//! `LayoutThumb`'s geometry (`components/studio/scenes-gallery.tsx`): the
//! small diagram of a layout preset that the Studio's scene cards, the Scene
//! page's rows, the Layout field and first run draw. It shows where the
//! layout puts the screen and the camera. It is never a live picture.
//!
//! Everything is in the frame's pixels, measured from its top-left corner.
//! The app draws the frame (a 16:9 or 9:16 box with a hairline and a muted
//! gradient), then each [`ThumbArea`] inside it, in order.
//!
//! There are two sizes:
//! - [`ThumbSize::Card`] is the card-size diagram. The camera plate carries
//!   its glyph and the screen area can show the scene's still or glyph.
//! - [`ThumbSize::Compact`] is the icon-size diagram (`compact`), used by
//!   the Scene page's rows and the Layout field. Its insets thin to a
//!   hairline, its areas get the stronger fills, and nothing carries a
//!   glyph.

/// What an area stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbPart {
    /// The screen's area: the scene's still when it has one, else its glyph
    /// (Card only), else the empty fill (`ThumbScreen`).
    Screen,
    /// The camera's neutral plate (`ThumbCamera`).
    Camera,
}

/// A corner, as a tier for the app to map onto its radius tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbCorner {
    /// The frame's own corner at card size and for every 9:16 frame
    /// (`rounded-chip`).
    Chip,
    /// 3 px (`rounded-[3px]`): a Card 16:9 area, and the frame of a
    /// Compact 16:9 diagram.
    Area,
    /// 2 px (`rounded-[2px]`): a Card 9:16 area and the Card 16:9
    /// picture-in-picture camera.
    Tight,
    /// 1 px (`rounded-[1px]`): every Compact area.
    Hair,
}

/// Which diagram to draw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbSize {
    /// A scene card's diagram.
    Card,
    /// The icon-size diagram (`compact`).
    Compact,
}

impl ThumbSize {
    fn compact(self) -> bool {
        self == Self::Compact
    }
}

/// One area of a layout diagram, in the frame's pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThumbArea {
    pub part: ThumbPart,
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
    pub corner: ThumbCorner,
    /// The stronger fill used at icon size. A screen's fill is
    /// `foreground/25` here and `foreground/10` otherwise. A camera's
    /// overlay is `foreground/55` here and `foreground/25` otherwise.
    pub strong: bool,
    /// The camera's glyph on its plate, or the screen's glyph. Card only,
    /// because an icon-size area is too small to read one.
    pub glyph: bool,
    /// A picture-in-picture camera's thin rim (`border border-background/60`).
    pub rim: bool,
}

/// The frame the areas sit in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThumbFrame {
    pub width: f32,
    pub height: f32,
    pub corner: ThumbCorner,
    /// The stronger hairline at icon size (`border-foreground/25`). Otherwise
    /// it is the plain border.
    pub strong_border: bool,
}

/// `layoutPresetOrientation(preset) === 'vertical'`.
pub fn thumb_is_vertical(preset: &str) -> bool {
    preset.starts_with("vertical-")
}

/// The diagram's frame on a scene card whose content is `inner` wide. A
/// 16:9 layout fills the width. A 9:16 layout stands in a 4:3 well, at its
/// height less the well's `py-1`.
pub fn card_frame(vertical: bool, inner: f32) -> ThumbFrame {
    let (width, height) = if vertical {
        let height = (inner * 3. / 4. - 8.).max(0.);
        (height * 9. / 16., height)
    } else {
        (inner, inner * 9. / 16.)
    };
    ThumbFrame {
        width,
        height,
        corner: ThumbCorner::Chip,
        strong_border: false,
    }
}

/// The diagram's frame in a Scene page row: a 16:9 well `well_height` tall
/// (`aspect-video h-6`). A 16:9 layout fills the well. A 9:16 layout stands
/// at the well's height (`h-full w-auto`).
pub fn row_frame(vertical: bool, well_height: f32) -> ThumbFrame {
    let height = well_height.max(0.);
    let (width, corner) = if vertical {
        (height * 9. / 16., ThumbCorner::Chip)
    } else {
        (height * 16. / 9., ThumbCorner::Area)
    };
    ThumbFrame {
        width,
        height,
        corner,
        strong_border: true,
    }
}

/// Where `preset` draws the screen and the camera in a frame `w` × `h`,
/// in drawing order. 9:16 with Fit (`fit`) keeps the screen's shape (a 16:9
/// screen is about 30% of the 9:16 canvas) and the camera takes the rest.
/// Fill draws the bands the backend composes. `fit` means nothing for a
/// 16:9 layout. An unknown preset draws nothing but the frame.
pub fn thumb_areas(preset: &str, fit: bool, size: ThumbSize, w: f32, h: f32) -> Vec<ThumbArea> {
    let compact = size.compact();
    let area = |part: ThumbPart, left: f32, top: f32, width: f32, height: f32, corner| ThumbArea {
        part,
        left,
        top,
        width: width.max(0.),
        height: height.max(0.),
        corner,
        strong: compact,
        glyph: !compact,
        rim: false,
    };
    // A camera in the bottom-right corner, `right` and `bottom` in from the
    // edges, taking the given shares of the frame.
    let pip = |right: f32, bottom: f32, w_share: f32, h_share: f32, corner, rim: bool| ThumbArea {
        rim,
        ..area(
            ThumbPart::Camera,
            w - right - w * w_share,
            h - bottom - h * h_share,
            w * w_share,
            h * h_share,
            corner,
        )
    };

    if thumb_is_vertical(preset) {
        // Card: inset-1 (4 px), pip right-1.5 bottom-1.5, rounded-[2px].
        // Compact: inset-[1.5px], pip right-[2px] bottom-[2px], rounded-[1px].
        let (i, pip_in, corner) = if compact {
            (1.5, 2., ThumbCorner::Hair)
        } else {
            (4., 6., ThumbCorner::Tight)
        };
        let band = |part: ThumbPart, at_top: bool, share: f32| {
            let height = h * share;
            let top = if at_top { i } else { h - i - height };
            area(part, i, top, w - 2. * i, height, corner)
        };
        let (camera_share, screen_share) = if fit { (0.62, 0.30) } else { (0.37, 0.55) };
        return match preset {
            "vertical-camera-top" => vec![
                band(ThumbPart::Camera, true, camera_share),
                band(ThumbPart::Screen, false, screen_share),
            ],
            "vertical-split" if !fit => vec![
                band(ThumbPart::Screen, true, 0.46),
                band(ThumbPart::Camera, false, 0.46),
            ],
            "vertical-camera-bottom" | "vertical-split" => vec![
                band(ThumbPart::Screen, true, screen_share),
                band(ThumbPart::Camera, false, camera_share),
            ],
            "vertical-screen-camera" | "vertical-screen-only" => {
                let screen = if fit {
                    // inset-x, top-[35%] h-[30%].
                    area(ThumbPart::Screen, i, h * 0.35, w - 2. * i, h * 0.30, corner)
                } else {
                    area(ThumbPart::Screen, i, i, w - 2. * i, h - 2. * i, corner)
                };
                let mut areas = vec![screen];
                if preset == "vertical-screen-camera" {
                    // h-[13%] w-[38%], always with its rim.
                    areas.push(pip(pip_in, pip_in, 0.38, 0.13, corner, true));
                }
                areas
            }
            "vertical-camera-only" => vec![area(
                ThumbPart::Camera,
                i,
                i,
                w - 2. * i,
                h - 2. * i,
                corner,
            )],
            _ => Vec::new(),
        };
    }

    // Card: inset-1.5 (6 px), rounded-[3px]; side-by-side halves w-[44%].
    // Compact: inset-[2px], rounded-[1px]; halves w-[45%].
    let (i, corner, half) = if compact {
        (2., ThumbCorner::Hair, 0.45)
    } else {
        (6., ThumbCorner::Area, 0.44)
    };
    let full_screen = || area(ThumbPart::Screen, i, i, w - 2. * i, h - 2. * i, corner);
    match preset {
        "screen-only" => vec![full_screen()],
        "screen-camera" => vec![
            full_screen(),
            if compact {
                // right-[3px] bottom-[3px] h-1/2 w-[34%], no rim.
                pip(3., 3., 0.34, 0.5, ThumbCorner::Hair, false)
            } else {
                // right-1.5 bottom-1.5 h-2/5 w-[30%] rounded-[2px], with its rim.
                pip(6., 6., 0.30, 0.40, ThumbCorner::Tight, true)
            },
        ],
        // inset-x-1/4.
        "camera-only" => vec![area(
            ThumbPart::Camera,
            w * 0.25,
            i,
            w * 0.5,
            h - 2. * i,
            corner,
        )],
        "side-by-side" => vec![
            area(ThumbPart::Screen, i, i, w * half, h - 2. * i, corner),
            area(
                ThumbPart::Camera,
                w - i - w * half,
                i,
                w * half,
                h - 2. * i,
                corner,
            ),
        ],
        _ => Vec::new(),
    }
}

#[cfg(test)]
#[path = "thumb_tests.rs"]
mod tests;
