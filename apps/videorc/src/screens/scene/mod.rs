//! The Scene page ⌘3 (plan 260 Phase 3, L1; `layout-tab.tsx`), part one:
//! the Scenes list with its ⋯ menu, Rename and Delete, the Layout section
//! and Hide screen. The canvas, the inspector and the banners are part two;
//! the picker (Add scene…, Change screen…), Set key…, Guests in the room…
//! and Resolve scene sources follow in their own PR.
//!
//! Every rule is the core's; [`model::SceneModel`] maps one snapshot to
//! what the page draws, and the clicks call the Studio on the core's
//! runtime. The page scrolls as one: the scene list at full width, then
//! Layout and Hide screen. Part two adds the canvas between them and the
//! inspector beside them from 940 px of page width (`@min-[940px]/page`).

mod dialogs;
mod hide_screen;
mod layout;
mod list;
pub mod model;
mod picker;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{Context, Entity, EventEmitter, Task, Window, div, prelude::*};
use videorc_app_core::nav::PageId;
use videorc_app_core::settings_page::SettingsTab;
use videorc_app_core::{BackendClient, Studio, StudioSnapshot};
use videorc_kit::command::InputEvent;
use videorc_kit::dialog::DialogHandle;
use videorc_kit::input::InputState;
use videorc_kit::scroll_area::ScrollArea;

use model::SceneModel;

pub type AppStudio = Studio<BackendClient>;

/// Where the page sends the shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneNavigate {
    Page(PageId),
    Settings(SettingsTab),
}

/// The Rename dialog while it is open.
struct Renaming {
    id: String,
    error: Option<String>,
    busy: bool,
}

/// The Delete confirmation while it is open.
struct Deleting {
    id: String,
    name: String,
    next: Option<String>,
    busy: bool,
}

pub struct ScenePage {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    model: SceneModel,
    rename: DialogHandle,
    rename_input: Entity<InputState>,
    renaming: Option<Renaming>,
    delete: DialogHandle,
    deleting: Option<Deleting>,
    /// Add scene… and Change screen….
    picker: DialogHandle,
    picker_search: Entity<InputState>,
    picking: Option<picker::Picking>,
    /// Draws again when the switch status line is due (no timer lives in
    /// the Studio).
    status_timer: Option<Task<()>>,
}

impl EventEmitter<SceneNavigate> for ScenePage {}

/// `process.platform`'s name for this build.
fn platform() -> Option<&'static str> {
    videorc_app_core::studio::scenes::host_platform()
}

/// A Wayland session hears no global key (`globalShortcutsUnavailable`).
fn wayland() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// `new Date().toISOString()`.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl ScenePage {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let model = SceneModel::of(&studio.watch().borrow(), platform(), wayland());
        let rename_input = cx.new(|cx| {
            InputState::new(window, cx)
                .validate(|value, _| value.chars().count() <= dialogs::NAME_MAX_CHARS)
        });
        cx.subscribe_in(
            &rename_input,
            window,
            |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    // Typing clears the error (`sceneNameError` waits for Enter).
                    if let Some(renaming) = &mut this.renaming {
                        renaming.error = None;
                    }
                    cx.notify();
                }
                if matches!(event, InputEvent::PressEnter { .. }) && this.rename.is_open() {
                    this.submit_rename(window, cx);
                }
            },
        )
        .detach();

        let picker_search = cx.new(|cx| InputState::new(window, cx));
        let watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut snapshots = watch.watch();
            while snapshots.changed().await.is_ok() {
                let snapshot = snapshots.borrow_and_update().clone();
                if this
                    .update(cx, |page, cx| page.rebuild(&snapshot, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();

        let mut page = Self {
            studio,
            runtime,
            model,
            rename: DialogHandle::new(false),
            rename_input,
            renaming: None,
            delete: DialogHandle::new(false),
            deleting: None,
            picker: DialogHandle::new(false),
            picker_search,
            picking: None,
            status_timer: None,
        };
        let snapshot = page.studio.watch().borrow().clone();
        page.schedule_status_line(&snapshot, cx);
        page
    }

    fn rebuild(&mut self, snapshot: &StudioSnapshot, cx: &mut Context<Self>) {
        let model = SceneModel::of(snapshot, platform(), wayland());
        self.schedule_status_line(snapshot, cx);
        if model != self.model {
            self.model = model;
            cx.notify();
        }
    }

    /// The switch status line shows 1.5 s after a switch starts (at once
    /// when it replaced another): draw again then.
    fn schedule_status_line(&mut self, snapshot: &StudioSnapshot, cx: &mut Context<Self>) {
        self.status_timer = None;
        let Some(at) = snapshot.scenes.progress_line_at() else {
            return;
        };
        let now = epoch_ms();
        if at <= now {
            return;
        }
        let wait = Duration::from_millis(at - now);
        self.status_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            let _ = this.update(cx, |_, cx| cx.notify());
        }));
    }

    /// Runs a Studio call on the core's runtime.
    fn run(&self, job: impl std::future::Future<Output = ()> + Send + 'static) {
        self.runtime.spawn(job);
    }

    fn navigate(&mut self, to: SceneNavigate, cx: &mut Context<Self>) {
        cx.emit(to);
    }
}

impl Render for ScenePage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let list = self.scenes_section(window, cx);
        let layout = self.layout_section(window, cx);
        let hide = self.hide_screen_section(window, cx);
        div()
            .id("scene-page")
            .relative()
            .size_full()
            .child(
                ScrollArea::new("scene-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .w_full()
                        .child(list)
                        // The lead column: Layout, the canvas (part two),
                        // Hide screen.
                        .child(
                            div()
                                .id("scene-lead-column")
                                .flex()
                                .flex_col()
                                .min_w_0()
                                .child(layout)
                                .child(hide),
                        ),
                ),
            )
            .child(self.rename_dialog(window, cx))
            .child(self.delete_dialog(cx))
            .child(self.picker_dialog(window, cx))
    }
}
