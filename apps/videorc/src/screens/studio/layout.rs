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

#[cfg(test)]
mod tests {
    use super::*;

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
