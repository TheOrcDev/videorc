//! The Studio page's grid (`studio-layout.ts`, P113). The breakpoint reads
//! the page's own width, not the window's: the sidebar and a narrow window
//! both push the inspector under the preview.

/// From this content width the inspector sits beside the preview
/// (`STUDIO_WIDE_MIN_PX`).
pub const STUDIO_WIDE_MIN_PX: f32 = 720.;

/// The inspector column's widest (`minmax(0, 20rem)`).
pub const INSPECTOR_MAX_PX: f32 = 320.;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudioLayout {
    /// Two columns: the preview column spans both rows on the left; the
    /// transport heads the right column and the inspector fills under it.
    Wide,
    /// One column: the transport leads, then the preview, then the
    /// inspector.
    Narrow,
}

impl StudioLayout {
    pub fn for_width(width: f32) -> Self {
        if width >= STUDIO_WIDE_MIN_PX {
            StudioLayout::Wide
        } else {
            StudioLayout::Narrow
        }
    }

    /// The transport sticks to the top of a narrow page, unless the preview
    /// is docked there: the docked surface must not slide under it.
    pub fn transport_sticky(self, preview_docked: bool) -> bool {
        self == StudioLayout::Narrow && !preview_docked
    }
}

/// `previewFootprintRatio` (`preview-stage.tsx:268`): the stage's width over
/// its height. The canvas's own aspect, but a portrait canvas (the vertical
/// 9:16 profile) or none keeps the landscape 16:9 footprint, so the column
/// never towers.
pub fn stage_footprint(width: u32, height: u32) -> f32 {
    if width == 0 || height == 0 || height > width {
        16. / 9.
    } else {
        width as f32 / height as f32
    }
}

/// `previewSlotRatio` (`preview-stage.tsx:282`): the docked slot's width over
/// its height, always the canvas's real aspect (16:9 with none), so the
/// native surface glued to it is never squeezed. A portrait canvas gets a
/// true 9:16 slot centred in the landscape footprint.
pub fn stage_slot_aspect(width: u32, height: u32) -> f32 {
    if width == 0 || height == 0 {
        16. / 9.
    } else {
        width as f32 / height as f32
    }
}

/// The slot's share of the footprint's width: the slot is as tall as the
/// footprint, so its width is `slot / footprint` of the footprint's (1 for
/// a landscape canvas, the slot and the footprint being one box).
pub fn stage_slot_share(width: u32, height: u32) -> f32 {
    (stage_slot_aspect(width, height) / stage_footprint(width, height)).min(1.)
}

/// A section a door brings into view on the page's scroll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudioSection {
    /// Sources' Open Scenes (P283): `scrollIntoView({ block: 'start' })`
    /// (`scene-presets.tsx:102-105`).
    Scenes,
    /// Open Audio (P172 / P180): the Microphone row centred
    /// (`use-section-focus.ts:61`, `block: 'center'`).
    Audio,
    /// Gallery Vertical stream shot: the bottom-row panel at the foot of
    /// the preview column (`vertical-leg-monitor.tsx`).
    VerticalStream,
}

/// The scroll offset (GPUI's: zero at the top, more negative further down)
/// that brings `target` into `view`, both as window tops and bottoms: its top
/// at the view's top for Scenes, its middle at the view's middle for Audio
/// (its top when it is taller than the view), within the scroll's range. None
/// when it is there already.
pub fn reveal_offset(
    section: StudioSection,
    view: (f32, f32),
    target: (f32, f32),
    offset_y: f32,
    max_y: f32,
) -> Option<f32> {
    let (view_top, view_bottom) = view;
    let (top, bottom) = target;
    let shift = match section {
        StudioSection::Scenes | StudioSection::VerticalStream => view_top - top,
        StudioSection::Audio if bottom - top > view_bottom - view_top => view_top - top,
        StudioSection::Audio => (view_top + view_bottom) / 2. - (top + bottom) / 2.,
    };
    let y = (offset_y + shift).clamp(-max_y.max(0.), 0.);
    ((y - offset_y).abs() >= 0.5).then_some(y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stage_keeps_a_landscape_footprint() {
        assert_eq!(stage_footprint(1920, 1080), 1920. / 1080.);
        assert_eq!(stage_footprint(1440, 1080), 1440. / 1080.);
        assert_eq!(stage_footprint(1080, 1920), 16. / 9.);
        assert_eq!(stage_footprint(0, 0), 16. / 9.);
    }

    #[test]
    fn a_portrait_canvas_gets_a_true_slot_centred_in_the_footprint() {
        // Landscape: the slot is the footprint.
        assert_eq!(stage_slot_aspect(1920, 1080), 1920. / 1080.);
        assert_eq!(stage_slot_share(1920, 1080), 1.);
        assert_eq!(stage_slot_share(1440, 1080), 1.);
        // Portrait 9:16: a 9:16 slot, (9/16) / (16/9) of the footprint wide.
        assert_eq!(stage_slot_aspect(1080, 1920), 1080. / 1920.);
        assert!((stage_slot_share(1080, 1920) - 81. / 256.).abs() < 1e-6);
        // No canvas yet: the 16:9 footprint, whole.
        assert_eq!(stage_slot_aspect(0, 0), 16. / 9.);
        assert_eq!(stage_slot_share(0, 0), 1.);
    }

    #[test]
    fn scenes_scroll_to_the_top_of_the_view_within_the_range() {
        // View 100..600; Scenes at 900..1200 with nothing scrolled yet.
        assert_eq!(
            reveal_offset(
                StudioSection::Scenes,
                (100., 600.),
                (900., 1200.),
                0.,
                2000.
            ),
            Some(-800.)
        );
        // The page can scroll only 500 down: it stops there.
        assert_eq!(
            reveal_offset(StudioSection::Scenes, (100., 600.), (900., 1200.), 0., 500.),
            Some(-500.)
        );
        // Already at the top of the view: nothing to do.
        assert_eq!(
            reveal_offset(
                StudioSection::Scenes,
                (100., 600.),
                (100., 400.),
                -300.,
                2000.
            ),
            None
        );
    }

    #[test]
    fn audio_centres_in_the_view_or_shows_its_top_when_taller() {
        // View 0..600 (middle 300); Audio at 700..900 (middle 800).
        assert_eq!(
            reveal_offset(StudioSection::Audio, (0., 600.), (700., 900.), 0., 2000.),
            Some(-500.)
        );
        // Scrolled past it: back down to the top, never past zero.
        assert_eq!(
            reveal_offset(StudioSection::Audio, (0., 600.), (-200., 0.), -50., 2000.),
            Some(0.)
        );
        // Taller than the view: its top at the view's top.
        assert_eq!(
            reveal_offset(StudioSection::Audio, (0., 600.), (700., 1500.), 0., 2000.),
            Some(-700.)
        );
    }

    #[test]
    fn the_inspector_moves_beside_the_preview_from_720_px() {
        assert_eq!(StudioLayout::for_width(719.9), StudioLayout::Narrow);
        assert_eq!(StudioLayout::for_width(720.), StudioLayout::Wide);
        assert_eq!(StudioLayout::for_width(0.), StudioLayout::Narrow);
    }

    #[test]
    fn only_a_narrow_page_without_a_docked_preview_sticks_the_transport() {
        assert!(StudioLayout::Narrow.transport_sticky(false));
        assert!(!StudioLayout::Narrow.transport_sticky(true));
        assert!(!StudioLayout::Wide.transport_sticky(false));
    }
}
