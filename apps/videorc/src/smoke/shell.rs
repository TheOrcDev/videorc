//! The shell's side of the smoke driver ([`ShellSmoke`]): which window a
//! command names, the look a screenshot forces, and a toast through the
//! app's own toast path (plan 260 S2.5, wired by L6 in Phase 3).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use gpui::{AnyWindowHandle, App, Entity, WindowHandle};
use serde_json::{Value, json};
use videorc_app_core::smoke::security::{UiAppearanceRequest, UiToastRequest, UiWindow};
use videorc_kit::theme::{ForcedDark, IncreaseContrast, ReduceMotion};
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
        // The app does not read Increase Contrast or Reduce Motion from the
        // system yet (S2.6), so giving one back means off.
        cx.set_global(ForcedDark(forced.dark));
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

    fn open_page(&self, page: PageId, cx: &mut App) -> Result<(), String> {
        self.open(page, cx)
    }

    fn preview(&self, command: &str, cx: &mut App) -> Result<Value, String> {
        let preview = self
            .preview
            .borrow()
            .clone()
            .ok_or_else(|| super::MAIN_WINDOW_NOT_READY.to_string())?;
        let mode = preview.read(cx).mode();
        let can_float = preview.read(cx).can_float();
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
        Ok(preview.read(cx).smoke_state())
    }
}

impl ShellWindows {
    fn open(&self, page: PageId, cx: &mut App) -> Result<(), String> {
        self.main
            .update(cx, |shell, window, cx| shell.open_page(page, window, cx))
            .map_err(|_| super::MAIN_WINDOW_NOT_READY.to_string())
    }
}

/// Whether this binary is a shipped app rather than a dev build. A dev build
/// runs from cargo's `target/<profile>/`; anything else is treated as
/// packaged, so the server needs the harness's capability there.
pub fn packaged() -> bool {
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
