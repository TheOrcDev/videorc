//! The shell's side of the smoke driver ([`ShellSmoke`]): which window a
//! command names, the look a screenshot forces, and a toast through the
//! app's own toast path (plan 260 S2.5, wired by L6 in Phase 3).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use gpui::{AnyWindowHandle, App, Entity, WindowAppearance, WindowHandle};
use serde_json::{Value, json};
use videorc_app_core::smoke::security::{UiAppearanceRequest, UiToastRequest, UiWindow};
use videorc_kit::theme::{IncreaseContrast, ReduceMotion};
use videorc_kit::{ToastData, ToastKind};

use super::ShellSmoke;
use crate::app::shell::Shell;
use crate::preview::Preview;
use crate::screens::notifications::Hub;
use videorc_app_core::nav::PageId;
use videorc_preview::lifecycle::WindowMode;

/// What is forced now: `None` gives that part back to the system.
#[derive(Clone, Copy, Default)]
struct Forced {
    dark: Option<bool>,
    increase_contrast: Option<bool>,
    reduce_motion: Option<bool>,
}

pub struct ShellWindows {
    pub main: WindowHandle<Shell>,
    pub notices: Entity<Hub>,
    /// The preview, once the main window started it.
    pub preview: Rc<RefCell<Option<Entity<Preview>>>>,
    forced: Cell<Forced>,
}

impl ShellWindows {
    pub fn new(
        main: WindowHandle<Shell>,
        notices: Entity<Hub>,
        preview: Rc<RefCell<Option<Entity<Preview>>>>,
    ) -> Self {
        Self {
            main,
            notices,
            preview,
            forced: Cell::new(Forced::default()),
        }
    }
}

/// `Some(Some(v))` forces `v`, `Some(None)` gives it back, `None` keeps it.
fn apply(current: Option<bool>, request: Option<Option<bool>>) -> Option<bool> {
    match request {
        Some(next) => next,
        None => current,
    }
}

/// `ui-toast`'s types in the kit's words. A loading toast has no GPUI form
/// yet, so it is refused by name rather than shown as something else.
pub(crate) fn toast_kind(kind: &str) -> Result<ToastKind, String> {
    match kind {
        "message" => Ok(ToastKind::Plain),
        "success" => Ok(ToastKind::Success),
        "info" => Ok(ToastKind::Info),
        "warning" => Ok(ToastKind::Warning),
        "error" => Ok(ToastKind::Error),
        "loading" => Err("ui-toast: the GPUI app has no loading toast yet.".to_string()),
        other => Err(format!("ui-toast: unknown toast type {other:?}.")),
    }
}

impl ShellSmoke for ShellWindows {
    fn window(&self, which: UiWindow, cx: &App) -> Option<AnyWindowHandle> {
        match which {
            UiWindow::Main => Some(self.main.into()),
            UiWindow::StreamManager => crate::screens::stream_manager::window::handle(cx),
            UiWindow::Notes => crate::screens::notes::window::handle(cx),
            // The preview's own window while it floats; docked, it draws in
            // the main window. The Captions reader has no window yet.
            UiWindow::Preview => self
                .preview
                .borrow()
                .as_ref()
                .and_then(|preview| preview.read(cx).floating_window()),
            UiWindow::Captions => None,
        }
    }

    fn appearance(&self, request: UiAppearanceRequest, cx: &mut App) -> Result<Value, String> {
        let before = self.forced.get();
        let forced = Forced {
            dark: apply(before.dark, request.dark),
            increase_contrast: apply(before.increase_contrast, request.increase_contrast),
            reduce_motion: apply(before.reduce_motion, request.reduce_motion),
        };
        self.forced.set(forced);
        // Dark/light goes through the same window appearance the Settings
        // theme picker uses; theme::current then follows window.appearance().
        // The app does not read Increase Contrast or Reduce Motion from the
        // system yet (S2.6), so giving one back means off.
        let appearance = match forced.dark {
            Some(true) => Some(WindowAppearance::Dark),
            Some(false) => Some(WindowAppearance::Light),
            None => None,
        };
        // The window's appearance on macOS; the kit's own override everywhere,
        // which is the only switch on Linux (`AppearanceOverride`).
        cx.set_window_appearance(appearance);
        cx.set_global(videorc_kit::theme::AppearanceOverride(appearance));
        cx.set_global(IncreaseContrast(forced.increase_contrast.unwrap_or(false)));
        cx.set_global(ReduceMotion(forced.reduce_motion.unwrap_or(false)));
        cx.refresh_windows();
        Ok(json!({
            "theme": forced.dark.map(|dark| if dark { "dark" } else { "light" }),
            "increaseContrast": forced.increase_contrast,
            "reduceMotion": forced.reduce_motion,
        }))
    }

    fn toast(&self, request: &UiToastRequest, cx: &mut App) -> Result<Value, String> {
        let mut toast = ToastData::new(toast_kind(&request.kind)?, request.title.clone());
        if let Some(description) = &request.description {
            toast.description = Some(description.clone().into());
        }
        if let Some(ms) = request.duration_ms {
            toast.timeout = Some(Some(Duration::from_millis(ms)));
        }
        let id = request.id.clone();
        self.notices
            .update(cx, |hub, cx| hub.press_toast(id.clone(), toast, cx));
        Ok(json!({ "shown": true, "id": id }))
    }

    fn notifications(&self, cx: &mut App) -> Result<Value, String> {
        self.main
            .update(cx, |shell, _, cx| shell.smoke_notifications(cx))
            .map_err(|_| super::MAIN_WINDOW_NOT_READY.to_string())
    }

    fn open_page(&self, page: PageId, open: super::OpenTab, cx: &mut App) -> Result<(), String> {
        self.main
            .update(cx, |shell, window, cx| {
                shell.smoke_open(page, open, window, cx)
            })
            .map_err(|_| super::MAIN_WINDOW_NOT_READY.to_string())?
    }

    fn reveal_studio_vertical_stream(&self, cx: &mut App) -> Result<(), String> {
        self.main
            .update(cx, |shell, window, cx| {
                shell.reveal_studio_vertical_stream(window, cx);
                Ok(())
            })
            .map_err(|_| super::MAIN_WINDOW_NOT_READY.to_string())?
    }

    fn preview_entity(&self) -> Option<Entity<Preview>> {
        self.preview.borrow().clone()
    }

    fn preview(&self, command: &str, cx: &mut App) -> Result<Value, String> {
        let preview = self
            .preview
            .borrow()
            .clone()
            .ok_or_else(|| super::MAIN_WINDOW_NOT_READY.to_string())?;
        let mode = preview.read(cx).mode();
        let can_float = preview.read(cx).can_float();
        if command == "native-preview-surface-status" {
            return Ok(preview.read(cx).smoke_surface_status());
        }
        if command == "inspect-native-preview-live-background" {
            // Electron's proof surface drew the idle live background on
            // Linux; the GPUI preview draws the backend compositor's frames
            // everywhere, so `compositor.status` reports it.
            return Ok(json!({
                "liveBackground": null,
                "reporter": "compositor",
                "detail": "The GPUI preview draws the compositor's frames; compositor.status reports the live background.",
            }));
        }
        if command == "preview-window-os-close" {
            let handle = preview.read(cx).floating_window().ok_or_else(|| {
                "preview-window-os-close: the Preview window is not open.".to_string()
            })?;
            handle
                .update(cx, |_, window, _| {
                    crate::platform::current().perform_close(window)
                })
                .map_err(|_| "preview-window-os-close: the Preview window closed.".to_string())??;
            // The close lands a moment later; the smoke polls
            // `preview-window-state` for `closed`.
            return Ok(preview.read(cx).smoke_state());
        }
        if command == "preview-toggle-open" {
            // The menu's and ⌘P's own handler (`main.rs`): the main window
            // forward, then `Preview::toggle_open`.
            cx.dispatch_action(&crate::app::menus::TogglePreview);
            return Ok(preview.read(cx).smoke_state());
        }
        if command == "preview-retry" {
            let retried = preview.update(cx, |preview, cx| preview.retry(cx));
            let mut state = preview.read(cx).smoke_state();
            state["retried"] = json!(retried);
            return Ok(state);
        }
        let wanted = match command {
            "inspect-native-preview-runtime" | "preview-window-state" => None,
            "preview-window-open" => Some(WindowMode::Floating),
            "preview-window-close" => Some(WindowMode::Docked),
            "preview-window-toggle" => Some(match mode {
                WindowMode::Docked => WindowMode::Floating,
                WindowMode::Floating => WindowMode::Docked,
            }),
            other => return Err(format!("{other} is not a preview command.")),
        };
        if let Some(wanted) = wanted {
            if wanted == WindowMode::Floating && !can_float {
                return Err(format!(
                    "{command}: the Preview window opens only on macOS with the native preview \
                     ready here."
                ));
            }
            // It opens a moment later (`Preview::float`); the smoke polls
            // `preview-window-state` for `floatingOpen`.
            if wanted != mode {
                preview.update(cx, |preview, cx| preview.toggle_floating(cx));
            }
        }
        let mut state = preview.read(cx).smoke_state();
        // Electron's `preview-window-state` shape too: whether the preview is
        // on screen, and its own window's content size while it floats.
        let floating = state["mode"] == "floating";
        let shown = if state["closed"] == true {
            false
        } else if floating {
            state["floatingOpen"] == true
        } else {
            state["dockedShown"] == true
        };
        state["open"] = json!(shown);
        state["visible"] = json!(shown);
        let bounds = preview
            .read(cx)
            .floating_window()
            .and_then(|handle| handle.update(cx, |_, window, _| window.bounds().size).ok());
        state["contentBounds"] = match bounds {
            Some(size) => json!({
                "width": f32::from(size.width),
                "height": f32::from(size.height),
            }),
            None => Value::Null,
        };
        Ok(state)
    }
}

impl ShellWindows {}

/// Debug binaries stay dev builds when the sentinel copies them for the
/// gallery. Release binaries outside cargo's `target/<profile>/` are
/// packaged, so the server needs the harness's capability there.
pub fn packaged() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    std::env::current_exe().ok().is_none_or(|exe| {
        let profile = exe.parent();
        let target = profile.and_then(|dir| dir.parent());
        let named = |dir: Option<&std::path::Path>, names: &[&str]| {
            dir.and_then(|dir| dir.file_name())
                .and_then(|name| name.to_str())
                .is_some_and(|name| names.contains(&name))
        };
        !(named(profile, &["debug", "release"]) && named(target, &["target"]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_part_is_forced_given_back_or_kept() {
        assert_eq!(apply(None, Some(Some(true))), Some(true));
        assert_eq!(apply(Some(true), Some(None)), None);
        assert_eq!(apply(Some(false), None), Some(false));
    }

    #[test]
    fn every_toast_type_maps_or_is_refused_by_name() {
        for kind in videorc_app_core::smoke::security::UI_TOAST_KINDS {
            match toast_kind(kind) {
                Ok(_) => {}
                Err(error) => assert!(error.contains("loading"), "{kind}: {error}"),
            }
        }
        assert!(toast_kind("party").is_err());
    }
}
