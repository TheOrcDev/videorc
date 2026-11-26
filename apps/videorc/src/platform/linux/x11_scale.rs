//! The X11 scale factor (plan 260, L5).
//!
//! X11 has one scale for the whole app. gpui-pre-linux picks it from
//! `GPUI_X11_SCALE_FACTOR`, then `Xft.dpi`, then RandR: the primary monitor's
//! pixels per physical millimetre. That last step isn't what Linux apps do:
//! GTK reads `Xft.dpi` and `GDK_SCALE`, and Chromium (so Electron) reads
//! `Xft.dpi`, else 1. Under XWayland the monitors' millimetres are the
//! laptop panel's, so the app drew at about 2.2× on a 1× screen (ogre,
//! 2026-11-26: a headless 1920×1080 output next to a 2880×1800 panel).
//!
//! Before GPUI starts, an X11 run that has neither `GPUI_X11_SCALE_FACTOR`
//! nor `Xft.dpi` gets `GDK_SCALE` when that's a valid number, else 1. An
//! explicit `GPUI_X11_SCALE_FACTOR` (a number or `randr`) and `Xft.dpi`
//! still win, as GPUI reads them.

/// The variable gpui-pre-linux reads (`x11/client.rs`).
const GPUI_X11_SCALE_FACTOR: &str = "GPUI_X11_SCALE_FACTOR";

/// The scale to hand GPUI, or `None` to leave its own choice: the user set
/// `GPUI_X11_SCALE_FACTOR`, or the X server has `Xft.dpi`.
fn x11_scale_override(
    gpui_scale: Option<&str>,
    xft_dpi: bool,
    gdk_scale: Option<&str>,
) -> Option<String> {
    if gpui_scale.is_some_and(|value| !value.is_empty()) || xft_dpi {
        return None;
    }
    let gdk = gdk_scale
        .and_then(|value| value.trim().parse::<f32>().ok())
        .filter(|scale| scale.is_normal() && *scale > 0.0);
    Some(match gdk {
        Some(scale) => scale.to_string(),
        None => "1".to_string(),
    })
}

/// The X resources carry `Xft.dpi` (what `xrdb -merge` sets).
fn resources_have_xft_dpi(resources: &[u8]) -> bool {
    String::from_utf8_lossy(resources)
        .lines()
        .any(|line| line.trim_start().starts_with("Xft.dpi:"))
}

/// `Xft.dpi` on the root window's `RESOURCE_MANAGER`, where GPUI reads it.
fn xft_dpi_present() -> bool {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};

    let Ok((connection, screen)) = x11rb::rust_connection::RustConnection::connect(None) else {
        return false;
    };
    let Some(root) = connection
        .setup()
        .roots
        .get(screen)
        .map(|screen| screen.root)
    else {
        return false;
    };
    connection
        .get_property(
            false,
            root,
            AtomEnum::RESOURCE_MANAGER,
            AtomEnum::STRING,
            0,
            u32::MAX / 4,
        )
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some_and(|reply| resources_have_xft_dpi(&reply.value))
}

/// Run first in `main`, before any thread starts (it sets an environment
/// variable). A Wayland run (any `WAYLAND_DISPLAY`, the rule
/// `front_app.rs` and `idle.rs` use) is left alone.
pub fn apply() {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_none() {
        return;
    }
    let gpui_scale = std::env::var(GPUI_X11_SCALE_FACTOR).ok();
    if gpui_scale.as_deref().is_some_and(|value| !value.is_empty()) {
        return;
    }
    let gdk_scale = std::env::var("GDK_SCALE").ok();
    if let Some(scale) = x11_scale_override(
        gpui_scale.as_deref(),
        xft_dpi_present(),
        gdk_scale.as_deref(),
    ) {
        eprintln!(
            "[videorc-app] X11 without Xft.dpi: scale {scale} (GDK_SCALE, else 1), not RandR's physical DPI"
        );
        // SAFETY: `apply` runs at the top of `main`, before any other
        // thread exists, so nothing reads the environment concurrently.
        unsafe { std::env::set_var(GPUI_X11_SCALE_FACTOR, &scale) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_x11_run_without_xft_dpi_is_1x_unless_gdk_scale_says_otherwise() {
        // ogre, 2026-11-26: no Xft.dpi, so RandR's panel DPI made it ~2.2×.
        assert_eq!(x11_scale_override(None, false, None).as_deref(), Some("1"));
        assert_eq!(
            x11_scale_override(None, false, Some("2")).as_deref(),
            Some("2")
        );
        assert_eq!(
            x11_scale_override(None, false, Some("garbage")).as_deref(),
            Some("1")
        );
        assert_eq!(
            x11_scale_override(None, false, Some("0")).as_deref(),
            Some("1")
        );
        // Xft.dpi and an explicit GPUI_X11_SCALE_FACTOR stay GPUI's.
        assert_eq!(x11_scale_override(None, true, Some("2")), None);
        assert_eq!(x11_scale_override(Some("randr"), false, None), None);
        assert_eq!(x11_scale_override(Some("1.5"), false, None), None);
        assert_eq!(
            x11_scale_override(Some(""), false, None).as_deref(),
            Some("1")
        );
    }

    #[test]
    fn xft_dpi_is_found_in_the_resource_string() {
        assert!(resources_have_xft_dpi(
            b"Xcursor.size:\t24\nXft.dpi:\t192\n"
        ));
        assert!(!resources_have_xft_dpi(b"Xcursor.size:\t24\n"));
        assert!(!resources_have_xft_dpi(b""));
    }
}
