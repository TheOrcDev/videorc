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

/// A kit window. On macOS the title bar is hidden and the traffic lights sit
/// on the 40 px toolbar band at (14, 13) (P044). On Windows and Linux the OS
/// draws the native title bar (P046); Mica (P045) waits on the Windows glass
/// path. The window's root view paints the theme's `glass_solid` behind
/// everything.
pub fn options(title: impl Into<SharedString>, bounds: Bounds<Pixels>) -> WindowOptions {
    let title = title.into();
    #[cfg(target_os = "macos")]
    let titlebar = Some(TitlebarOptions {
        title: Some(title),
        appears_transparent: true,
        traffic_light_position: Some(point(
            px(TRAFFIC_LIGHTS_X),
            px((size::TOOLBAR - TRAFFIC_LIGHTS_HEIGHT) / 2.0),
        )),
    });
    #[cfg(not(target_os = "macos"))]
    let titlebar = Some(TitlebarOptions {
        title: Some(title),
        appears_transparent: false,
        traffic_light_position: None,
    });
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar,
        ..Default::default()
    }
}
