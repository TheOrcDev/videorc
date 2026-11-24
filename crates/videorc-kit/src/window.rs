//! The kit's window frame. GPUI's default title bar is AppKit's grey strip
//! (#212324, dark even in the light theme): S0.4's first round showed it as
//! "the header is a different colour". Every kit window hides it and draws
//! its own toolbar band over the window's solid, as `window-glass.ts` does
//! for Electron.

use gpui::{Bounds, Pixels, SharedString, TitlebarOptions, WindowBounds, WindowOptions, point, px};

use crate::tokens::size;

/// The traffic lights' left inset.
const TRAFFIC_LIGHTS_X: f32 = 14.0;
/// The traffic lights' height, to centre them on the toolbar band.
const TRAFFIC_LIGHTS_HEIGHT: f32 = 14.0;

/// A kit window: the title bar hidden and the traffic lights centred on the
/// 40 px toolbar band at (14, 13). The window's root view paints the theme's
/// `glass_solid` behind everything.
pub fn options(title: impl Into<SharedString>, bounds: Bounds<Pixels>) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some(title.into()),
            appears_transparent: true,
            traffic_light_position: Some(point(
                px(TRAFFIC_LIGHTS_X),
                px((size::TOOLBAR - TRAFFIC_LIGHTS_HEIGHT) / 2.0),
            )),
        }),
        ..Default::default()
    }
}
