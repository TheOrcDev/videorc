//! Which column of the token table a window draws, and the small bridges
//! from the generated tokens to GPUI's types.

use gpui::{App, FontWeight, Global, Hsla, Styled, Window, WindowAppearance, px, rgba};

use crate::tokens::{Color, Theme, text::TextStyle};

/// Whether the system asks for more contrast. The app keeps it current
/// from the platform layer (plan 260 S2.6); without it, contrast is normal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IncreaseContrast(pub bool);

impl Global for IncreaseContrast {}

/// Whether the system asks for less motion. The app keeps it current from
/// the platform layer; anything that turns or breathes holds still under it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReduceMotion(pub bool);

impl Global for ReduceMotion {}

/// Whether motion is allowed now.
pub fn motion(cx: &App) -> bool {
    !cx.try_global::<ReduceMotion>().is_some_and(|it| it.0)
}

/// The appearance `window` shows now.
pub fn current(window: &Window, cx: &App) -> Appearance {
    let increase_contrast = cx.try_global::<IncreaseContrast>().is_some_and(|it| it.0);
    Appearance::of(window.appearance(), increase_contrast)
}

/// The theme a component draws with: the one it was given (the gallery
/// draws every appearance in one window), or its window's.
pub fn resolve(given: Option<Appearance>, window: &Window, cx: &App) -> &'static Theme {
    given.unwrap_or_else(|| current(window, cx)).theme()
}

/// Whether `theme` is one of the dark columns (dark, or dark with
/// Increase Contrast): the stylesheet's `dark:` variants.
pub fn is_dark(theme: &Theme) -> bool {
    theme.glass_solid == crate::tokens::DARK.glass_solid
}

/// `color` with its alpha scaled by `factor`: CSS's
/// `color-mix(in oklch, color X%, transparent)`.
pub fn with_alpha(color: Color, factor: f32) -> Color {
    let alpha = ((color & 0xff) as f32 * factor.clamp(0.0, 1.0)).round() as u32;
    (color & 0xffff_ff00) | alpha.min(0xff)
}

/// The system UI font on every platform: SF on macOS, Segoe UI on Windows,
/// the desktop's sans on Linux. It is the stylesheet's `--font-sans` stack
/// (`-apple-system`, `Segoe UI`, `system-ui`) in GPUI's own words.
pub const FONT: &str = ".SystemUIFont";

/// One appearance: light or dark, with or without Increase Contrast.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Appearance {
    pub dark: bool,
    pub increase_contrast: bool,
}

impl Appearance {
    pub const DARK: Appearance = Appearance {
        dark: true,
        increase_contrast: false,
    };
    pub const LIGHT: Appearance = Appearance {
        dark: false,
        increase_contrast: false,
    };
    pub const DARK_INCREASE_CONTRAST: Appearance = Appearance {
        dark: true,
        increase_contrast: true,
    };
    pub const LIGHT_INCREASE_CONTRAST: Appearance = Appearance {
        dark: false,
        increase_contrast: true,
    };

    /// Every appearance, dark first: the gallery's columns in order.
    pub const ALL: [Appearance; 4] = [
        Appearance::DARK,
        Appearance::LIGHT,
        Appearance::DARK_INCREASE_CONTRAST,
        Appearance::LIGHT_INCREASE_CONTRAST,
    ];

    /// The appearance a window shows. GPUI reports light or dark; Increase
    /// Contrast comes from the platform layer.
    pub fn of(window: WindowAppearance, increase_contrast: bool) -> Appearance {
        Appearance {
            dark: matches!(
                window,
                WindowAppearance::Dark | WindowAppearance::VibrantDark
            ),
            increase_contrast,
        }
    }

    /// The tokens for this appearance.
    pub fn theme(self) -> &'static Theme {
        Theme::get(self.dark, self.increase_contrast)
    }

    /// How the gallery names it.
    pub fn name(self) -> &'static str {
        match (self.dark, self.increase_contrast) {
            (true, false) => "Dark",
            (false, false) => "Light",
            (true, true) => "Dark, Increase Contrast",
            (false, true) => "Light, Increase Contrast",
        }
    }
}

/// A token colour as GPUI paints it.
pub fn hsla(color: Color) -> Hsla {
    rgba(color).into()
}

/// `color` faded to `opacity` over an opaque `ground`, blended in sRGB as
/// Chromium composites a faded group. A disabled control paints these
/// colours at full opacity: GPUI would fade each layer on its own and drop
/// the label into its fill.
pub fn faded_over(color: Color, ground: Color, opacity: f32) -> Color {
    let alpha = (color & 0xff) as f32 / 255.0 * opacity.clamp(0.0, 1.0);
    let channel = |shift: u32| {
        let top = ((color >> shift) & 0xff) as f32;
        let bottom = ((ground >> shift) & 0xff) as f32;
        ((top * alpha + bottom * (1.0 - alpha)).round() as u32).min(0xff)
    };
    (channel(24) << 24) | (channel(16) << 16) | (channel(8) << 8) | 0xff
}

/// Text from the type scale: one call sets the size, line height and weight.
pub trait TypeScale: Styled + Sized {
    fn type_scale(self, style: TextStyle) -> Self {
        self.text_size(px(style.size))
            .line_height(px(style.line_height))
            .font_weight(FontWeight(style.weight))
    }
}

impl<E: Styled> TypeScale for E {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::{DARK, LIGHT, text};

    #[test]
    fn maps_the_window_appearance() {
        assert_eq!(
            Appearance::of(WindowAppearance::VibrantDark, false),
            Appearance::DARK
        );
        assert_eq!(
            Appearance::of(WindowAppearance::Light, true),
            Appearance::LIGHT_INCREASE_CONTRAST
        );
        assert_eq!(Appearance::DARK.theme(), &DARK);
        assert_eq!(Appearance::LIGHT.theme(), &LIGHT);
    }

    #[test]
    fn the_windows_stand_on_the_solids() {
        // #070707 and #FAFAFA, the S0.4 sheets' grounds.
        assert_eq!(Appearance::DARK.theme().glass_solid, 0x070707ff);
        assert_eq!(Appearance::LIGHT.theme().glass_solid, 0xfafafaff);
        for appearance in Appearance::ALL {
            assert_eq!(appearance.theme().glass_solid & 0xff, 0xff);
        }
    }

    #[test]
    fn fades_over_the_ground() {
        assert_eq!(faded_over(0xffffffff, 0x000000ff, 0.5), 0x808080ff);
        assert_eq!(faded_over(0xffffff80, 0x000000ff, 1.0), 0x808080ff);
        assert_eq!(faded_over(0x123456ff, 0xfafafaff, 0.0), 0xfafafaff);
        assert_eq!(faded_over(0x123456ff, 0xfafafaff, 1.0), 0x123456ff);
    }

    #[test]
    fn no_text_below_eleven_px() {
        for style in [text::LABEL, text::SECTION, text::META] {
            assert!(style.size >= 11.0, "{style:?}");
        }
    }
}
