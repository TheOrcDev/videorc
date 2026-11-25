//! The Scene page ⌘3 (plan 260 Phase 3, L1; `layout-tab.tsx`): the Scenes
//! list with its ⋯ menu, Rename and Delete, the picker (Add scene…, Change
//! screen…), Set key…, Guests in the room… and Resolve scene sources; the
//! Layout section, the Canvas section's toolbar and Hide screen; the
//! inspector and the Banners section; the stage (its drawing, gestures and
//! live drafts) over the docked preview, with its footer, Freeform, Edit
//! scene and ⌘Z.
//!
//! Every rule is the core's; [`model::SceneModel`] and
//! [`editor::EditorModel`] map one snapshot (and what the page keeps) to
//! what the page draws, and the clicks call the Studio on the core's
//! runtime. The page scrolls as one: the scene list at full width, then the
//! lead column (Layout, Canvas, Hide screen) with the inspector beside it
//! from 940 px of page width (`@min-[940px]/page`), under it below that.

mod banners;
mod camera;
mod canvas;
mod controls;
pub mod dialogs;
pub mod editor;
mod hide_screen;
mod inspector;
mod layout;
mod list;
pub mod model;
mod stage;

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{
    Context, Entity, EventEmitter, FocusHandle, KeyBinding, ScrollHandle, Task, Window, actions,
    div, prelude::*,
};
use videorc_app_core::nav::PageId;
use videorc_app_core::settings_page::SettingsTab;
use videorc_app_core::studio::Connection;
use videorc_app_core::studio::screen_views::talk_show_room;
use videorc_app_core::{BackendClient, Studio, StudioSnapshot};
use videorc_kit::input::InputState;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::theme::{self, hsla};

use crate::preview::Preview;
use crate::screens::avatar::pictures;
use videorc_app_core::stream_manager::buddy::CohostSettingsView;

use controls::Controls;
use dialogs::SceneDialogs;
use editor::{EditorModel, EditorState, parse_banners};
use model::SceneModel;

/// `@min-[940px]/page`: the inspector beside the lead column from here.
const SCENE_GRID_MIN_WIDTH: f32 = 940.;

/// The page's key context: ⌘Z / Ctrl+Z undoes the last layout change
/// (P536). A focused text field's own Undo binding is deeper, so it wins.
const KEY_CONTEXT: &str = "ScenePage";

actions!(scene_page, [UndoLayout]);

/// Binds the page's keys; call once at start. ⇧⌘Z and ⌥⌘Z stay unbound
/// (P537: no redo).
pub fn bind_keys(cx: &mut gpui::App) {
    cx.bind_keys([KeyBinding::new(
        "secondary-z",
        UndoLayout,
        Some(KEY_CONTEXT),
    )]);
}

pub type AppStudio = Studio<BackendClient>;

/// Where the page sends the shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneNavigate {
    Page(PageId),
    Settings(SettingsTab),
}

pub struct ScenePage {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    /// The page's focus: ⌘Z lands here (the shell focuses it on entry).
    focus: FocusHandle,
    /// The preview: its docked layer is the canvas's picture (X5).
    preview: Entity<Preview>,
    /// The stage's gesture, drafts and Snap toggle.
    stage: stage::Stage,
    /// The layout undo slot holds an entry (Undo shows, ⌘Z works).
    undo_available: bool,
    /// Where the banner images and the avatar's pictures are (the stage
    /// draws them on the schematic).
    user_data_dir: PathBuf,
    /// The avatar's own idle picture, as Settings last said; None draws the
    /// golem (`buddyStateImageUrl`).
    avatar_picture: Option<PathBuf>,
    /// The page's scroll, so Background settings can bring the camera's
    /// Background into view (P575).
    scroll: ScrollHandle,
    /// The Background tile that takes focus (the chosen one, else the
    /// first), and a reveal waiting for the section's next paint.
    background_focus: FocusHandle,
    background_reveal: Rc<Cell<bool>>,
    model: SceneModel,
    /// The scene dialogs, shared with the Studio's Scenes section.
    dialogs: Entity<SceneDialogs>,
    /// The global keys: a key the OS refused shows why on its chip (P461).
    hotkeys: crate::app::hotkeys::Hotkeys,
    /// The scene rows' stills, by `picture_key` (P458).
    row_stills: std::collections::HashMap<String, Arc<gpui::Image>>,
    /// Hide screen's Add app… popover, and its search.
    add_app_open: bool,
    add_app_search: Entity<InputState>,
    /// Draws again when the switch status line is due (no timer lives in
    /// the Studio).
    status_timer: Option<Task<()>>,
    /// Part two: what the inspector keeps (the selection, the banners and
    /// the overlay layout it read, the aspect locks), what it draws, and
    /// its sliders and fields.
    editor_state: EditorState,
    editor: EditorModel,
    controls: Controls,
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
        hotkeys: crate::app::hotkeys::Hotkeys,
        preview: Entity<Preview>,
        user_data_dir: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        // The canvas follows the preview between docked and its own window.
        cx.observe(&preview, |_, _, cx| cx.notify()).detach();
        let model = SceneModel::of(&studio.watch().borrow(), platform(), wayland());
        let dialogs = cx.new(|cx| {
            SceneDialogs::new(studio.clone(), runtime.clone(), hotkeys.clone(), window, cx)
        });
        let controls = Controls::new(window, cx);
        let add_app_search =
            cx.new(|cx| InputState::new(window, cx).placeholder(model::copy::SEARCH_OPEN_APPS));
        cx.observe(&add_app_search, |_, _, cx| cx.notify()).detach();
        let editor_state = EditorState::default();
        let editor = EditorModel::of(
            &studio.watch().borrow(),
            &editor_state,
            talk_show_room(studio.cloud_now().status.as_ref()).open,
            platform(),
        );
        // The room's phase turns the Background's effects off (P580).
        let cloud = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut states = cloud.cloud();
            while states.changed().await.is_ok() {
                if this.update(cx, |page, cx| page.refresh_editor(cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
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
            focus: cx.focus_handle(),
            preview,
            stage: stage::Stage::new(),
            undo_available: false,
            user_data_dir,
            avatar_picture: None,
            scroll: ScrollHandle::new(),
            background_focus: cx.focus_handle(),
            background_reveal: Rc::new(Cell::new(false)),
            model,
            dialogs,
            hotkeys,
            row_stills: Default::default(),
            add_app_open: false,
            add_app_search,
            status_timer: None,
            editor_state,
            editor,
            controls,
        };
        let snapshot = page.studio.watch().borrow().clone();
        page.schedule_status_line(&snapshot, cx);
        page.update_editor(&snapshot, cx);
        page
    }

    fn rebuild(&mut self, snapshot: &StudioSnapshot, cx: &mut Context<Self>) {
        let model = SceneModel::of(snapshot, platform(), wayland());
        self.schedule_status_line(snapshot, cx);
        if model != self.model {
            self.model = model;
            cx.notify();
        }
        let undo_available = self.studio.layout_undo_available();
        if undo_available != self.undo_available {
            self.undo_available = undo_available;
            cx.notify();
        }
        self.update_editor(snapshot, cx);
    }

    /// The inspector's model again; the banners and the overlay layout are
    /// read once per connection (and after every write).
    fn update_editor(&mut self, snapshot: &StudioSnapshot, cx: &mut Context<Self>) {
        let connected = matches!(snapshot.connection, Connection::Connected { .. });
        if connected && self.controls.lists_generation != Some(snapshot.connection_generation) {
            self.controls.lists_generation = Some(snapshot.connection_generation);
            self.load_lists(cx);
        }
        let room_open = talk_show_room(self.studio.cloud_now().status.as_ref()).open;
        let editor = EditorModel::of(snapshot, &self.editor_state, room_open, platform());
        // The default selection sticks (`layout-tab.tsx` 530-547); "Overlays
        // on" goes back to Horizontal once the vertical leg is gone.
        self.editor_state.selection = Some(editor.selection.clone());
        if editor.overlays_on.is_none() {
            self.editor_state.overlays_vertical = false;
        }
        if editor != self.editor {
            self.editor = editor;
            cx.notify();
        }
    }

    /// The inspector's model from the latest snapshot (after a page-side
    /// change: a selection, a list read, a precise edit in flight).
    fn refresh_editor(&mut self, cx: &mut Context<Self>) {
        let snapshot = self.studio.snapshot();
        self.update_editor(&snapshot, cx);
    }

    /// `banners.list` and `overlays.layout.get`.
    fn load_lists(&mut self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let read = self.runtime.spawn(async move {
            let banners = studio.banners().await.ok().and_then(parse_banners);
            let overlay = studio.overlay_layout().await.ok();
            // The avatar's idle picture, for its square on the schematic.
            let persona = studio
                .backend()
                .request("cohost.settings.get", serde_json::json!({}))
                .await
                .ok()
                .and_then(|value| CohostSettingsView::from_json(&value))
                .map(|settings| settings.persona);
            (banners, overlay, persona)
        });
        cx.spawn(async move |this, cx| {
            let Ok((banners, overlay, persona)) = read.await else {
                return;
            };
            let _ = this.update(cx, |page, cx| {
                if let Some(persona) = persona {
                    page.avatar_picture = persona
                        .and_then(|persona| persona.images.idle)
                        .and_then(|idle| pictures::managed_path(&page.user_data_dir, &idle));
                }
                if let Some(banners) = banners {
                    page.editor_state.banners = banners;
                    page.editor_state.banners_loaded = true;
                }
                if let Some(layout) = overlay {
                    page.editor_state.overlay_layout = Some(layout);
                }
                page.refresh_editor(cx);
            });
        })
        .detach();
    }

    /// The page's width, for the two columns (X1).
    fn measured(&mut self, width: f32, cx: &mut Context<Self>) {
        let flips =
            (width >= SCENE_GRID_MIN_WIDTH) != (self.controls.width >= SCENE_GRID_MIN_WIDTH);
        self.controls.width = width;
        if flips {
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

    /// The page's focus, for the shell to focus on entry.
    pub fn focus_handle(&self) -> FocusHandle {
        self.focus.clone()
    }

    /// The page opens: the banners, the overlay layout and the avatar's
    /// picture are read again (another page may have changed them).
    pub fn entered(&mut self, cx: &mut Context<Self>) {
        let snapshot = self.studio.snapshot();
        if matches!(snapshot.connection, Connection::Connected { .. }) {
            self.load_lists(cx);
            self.ask_row_stills(cx);
        }
    }
}

impl Render for ScenePage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The inspector waits while a stage gesture runs.
        let dragging = self.stage.phase() == stage::StagePhase::Dragging;
        if dragging != self.editor_state.stage_dragging {
            self.editor_state.stage_dragging = dragging;
            self.refresh_editor(cx);
        }
        self.sync_controls(window, cx);
        let t = theme::resolve(None, window, cx);
        let list = self.scenes_section(window, cx);
        let layout = self.layout_section(window, cx);
        let canvas = self.canvas_section(window, cx);
        let hide = self.hide_screen_section(window, cx);
        let inspector = self.inspector_column(window, cx);
        let page = cx.entity().downgrade();
        let measure = gpui::canvas(
            move |bounds, _, cx| {
                let width = f32::from(bounds.size.width);
                page.update(cx, |page, cx| page.measured(width, cx)).ok();
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();

        // X1: the lead column (Layout, Canvas, Hide screen), and the
        // inspector beside it from 940 px (`minmax(0,1.3fr) minmax(0,1fr)`,
        // a border between), under it below.
        let lead = div()
            .id("scene-lead-column")
            .flex()
            .flex_col()
            .min_w_0()
            .child(layout)
            .child(canvas)
            .child(hide);
        let grid = if self.controls.width >= SCENE_GRID_MIN_WIDTH {
            div()
                .id("scene-grid")
                .flex()
                .items_start()
                .w_full()
                .child(
                    lead.flex_1()
                        .flex_grow(1.3)
                        .border_r_1()
                        .border_color(hsla(t.border)),
                )
                .child(div().flex_1().min_w_0().child(inspector))
        } else {
            div()
                .id("scene-grid")
                .flex()
                .flex_col()
                .w_full()
                .child(lead)
                .child(inspector)
        };
        div()
            .id("scene-page")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(|page, _: &UndoLayout, _, cx| page.undo_key(cx)))
            .relative()
            .size_full()
            .child(measure)
            .child(
                ScrollArea::new("scene-scroll")
                    .handle(self.scroll.clone())
                    .child(div().flex().flex_col().w_full().child(list).child(grid)),
            )
            .child(self.camera_reset_dialog(cx))
            .child(self.choose_image_dialog(window, cx))
            .child(self.dialogs.clone())
    }
}

/// The page's doors into the shared dialogs.
impl ScenePage {
    fn open_rename(&mut self, id: &str, _name: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_rename(id, None, window, cx));
    }

    fn open_delete(
        &mut self,
        id: &str,
        _name: &str,
        _next: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_delete(id, None, window, cx));
    }

    fn open_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_add(None, window, cx));
    }

    fn open_change_screen(
        &mut self,
        id: &str,
        for_layout: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dialogs.update(cx, |dialogs, cx| {
            dialogs.open_change_screen(id, for_layout, None, window, cx)
        });
    }

    fn open_set_key(&mut self, id: &str, _name: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_set_key(id, None, window, cx));
    }

    fn open_guests(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_guests(id, None, window, cx));
    }

    fn open_resolve_for(
        &mut self,
        id: &str,
        apply_failed: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dialogs.update(cx, |dialogs, cx| {
            dialogs.open_resolve(id, apply_failed, None, window, cx)
        });
    }
}
