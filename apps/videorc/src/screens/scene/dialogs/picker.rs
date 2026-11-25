//! The scene picker (`scene-picker-dialog.tsx`; P486–P498): Add scene…
//! (several choices, each a new scene at the end of the list) and Change
//! screen… (one choice for one scene). The choices are the core's
//! (`scenes::picker`): apps from the device list (the app pictures'
//! request is not in the protocol yet), a specific window, the displays,
//! and Camera only / No screen.

use std::collections::HashMap;

use gpui::{AnyElement, Context, FontWeight, SharedString, Window, div, prelude::*, px};
use serde_json::Value;
use videorc_app_core::editor::inspector::layout_preset_label;
use videorc_app_core::scenes::picker::{
    AppChoice, ScreenPick, add_scenes_label, app_choices_from_devices, display_choices,
    matches_search, new_scenes, pick_key, scene_showing_pick, search_app_choices, shows_pick,
    window_choices, window_count_label, window_label,
};
use videorc_app_core::scenes::v2::{Scene, SceneShows};
use videorc_app_core::studio::source_selection::SourceKind;
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::{GroupedList, GroupedRow, ListRow};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, radius, text};

use super::super::{now_iso, platform};
use super::SceneDialogs;

/// Electron's app id: Videorc's own windows are never offered.
const OWN_BUNDLE_IDS: [&str; 1] = ["dev.theorcdev.videorc"];

pub(super) mod copy {
    pub const ADD_TITLE: &str = "Add scene";
    pub const CHANGE_TITLE: &str = "Change screen";
    pub const ADD_DESCRIPTION: &str = "Each choice becomes a scene in the look of the scene on stream, at the end of your scenes. What’s on stream stays as it is.";
    pub const SEARCH_ADD: &str = "Search apps and displays…";
    pub const SEARCH_CHANGE: &str = "Search apps, windows and displays…";
    pub const APPS: &str = "Apps";
    pub const DISPLAYS: &str = "Displays";
    pub const CAMERA: &str = "Camera";
    pub const CAMERA_ONLY: &str = "Camera only";
    pub const NO_SCREEN: &str = "No screen";
    pub const PUTS_ON_CAMERA_ONLY: &str = "Puts the scene on Camera only";
    pub const SHOWS_CAMERA_ONLY: &str = "Shows your camera only";
    pub const YOUR_CAMERA: &str = "Your camera";
    pub const CAMERA_OFF: &str = "Camera is off";
    pub const NO_APPS_TITLE: &str = "No app windows found";
    pub const NO_APPS_DESCRIPTION: &str =
        "Open the apps you want to show, bring their windows up, then refresh.";
    pub const REFRESH: &str = "Refresh";
    pub const NO_DISPLAYS_TITLE: &str = "No displays found";
    pub const NO_DISPLAYS_DESCRIPTION: &str = "Connect a display, or check Sources.";
    pub const SPECIFIC_WINDOW: &str = "A specific window";
    pub const SPECIFIC_WINDOW_LINE: &str =
        "The scene keeps this one window, whichever window of its app is in front.";
    /// With a period, unlike the Apps group's title.
    pub const NO_WINDOWS: &str = "No app windows found.";
    pub const CHOOSE_ONE: &str = "Choose at least one.";
    pub const CANCEL: &str = "Cancel";
    pub const CHANGE_BUTTON: &str = "Change screen";

    pub fn change_description(name: &str, on_stream: bool, for_layout: Option<&str>) -> String {
        match for_layout {
            Some(layout) => {
                format!(
                    "{layout} shows a screen, and “{name}” shows none yet. Choose the screen it shows."
                )
            }
            None if on_stream => {
                format!("Choose what “{name}” shows. It’s on stream, so the stream changes too.")
            }
            None => format!("Choose what “{name}” shows. It keeps its layout, keys and audio."),
        }
    }

    pub fn choose_what(name: &str) -> String {
        format!("Choose what “{name}” shows.")
    }

    pub fn already_shows(name: &str) -> String {
        format!("“{name}” already shows this.")
    }

    pub fn nothing_matches(query: &str) -> String {
        format!("Nothing matches “{query}”.")
    }

    pub fn layout_note(name: &str, layout: &str) -> String {
        format!("“{name}” uses {layout}, which shows no screen. Change its layout to show it.")
    }
}

/// What the picker is for.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum PickerMode {
    Add,
    Change {
        scene_id: String,
        name: String,
        on_stream: bool,
        /// D19: the layout that asked for a screen, applied once it lands.
        for_layout: Option<String>,
    },
}

/// The picker while it is open.
pub(super) struct Picking {
    pub mode: PickerMode,
    pub chosen: Vec<ScreenPick>,
    pub windows_open: bool,
    pub busy: bool,
}

/// A display's name without its " · 1920 × 1080" tail.
fn display_title(name: &str) -> String {
    match name.rsplit_once(" · ") {
        Some((head, tail)) if tail.contains(" × ") => head.to_string(),
        _ => name.to_string(),
    }
}

fn layout_draws_no_screen(layout: &Value) -> bool {
    matches!(
        layout.get("layoutPreset").and_then(Value::as_str),
        Some("camera-only" | "vertical-camera-only")
    )
}

impl SceneDialogs {
    /// The stored scene with this id.
    fn stored_scene(&self, id: &str) -> Option<Scene> {
        self.studio
            .watch()
            .borrow()
            .scenes
            .library
            .as_ref()
            .and_then(|library| library.scenes.iter().find(|scene| scene.id == id).cloned())
    }

    pub(super) fn show_picker(
        &mut self,
        mode: PickerMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Change screen… starts with what the scene shows chosen (not for
        // a layout that asked for a screen).
        let chosen = match &mode {
            PickerMode::Change {
                scene_id,
                for_layout: None,
                ..
            } => self
                .stored_scene(scene_id)
                .and_then(|scene| self.current_pick(&scene.shows))
                .into_iter()
                .collect(),
            _ => Vec::new(),
        };
        let windows_open = matches!(&mode, PickerMode::Change { scene_id, .. }
            if self.stored_scene(scene_id).is_some_and(|scene| matches!(scene.shows, SceneShows::Window { .. })));
        // A fresh search field each time: its placeholder is the mode's.
        let placeholder = if matches!(mode, PickerMode::Add) {
            copy::SEARCH_ADD
        } else {
            copy::SEARCH_CHANGE
        };
        self.picker_search = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        cx.observe(&self.picker_search, |_, _, cx| cx.notify())
            .detach();
        self.picking = Some(Picking {
            mode,
            chosen,
            windows_open,
            busy: false,
        });
        self.picker.open(window, cx);
        cx.notify();
    }

    /// The pick that stands for what a scene shows now, when the device
    /// list still offers it.
    fn current_pick(&self, shows: &SceneShows) -> Option<ScreenPick> {
        let snapshot = self.studio.watch().borrow().clone();
        let devices = &snapshot.sources.devices.devices;
        let own: Vec<String> = OWN_BUNDLE_IDS.iter().map(|id| id.to_string()).collect();
        let picks = app_choices_from_devices(devices, &own)
            .into_iter()
            .map(ScreenPick::App)
            .chain(
                window_choices(devices, &own)
                    .into_iter()
                    .cloned()
                    .map(ScreenPick::Window),
            )
            .chain(
                display_choices(devices, platform())
                    .into_iter()
                    .cloned()
                    .map(ScreenPick::Display),
            )
            .chain(std::iter::once(ScreenPick::None));
        picks.into_iter().find(|pick| shows_pick(shows, pick))
    }

    fn toggle_pick(&mut self, pick: ScreenPick, cx: &mut Context<Self>) {
        let Some(picking) = &mut self.picking else {
            return;
        };
        let key = pick_key(&pick);
        match picking.mode {
            PickerMode::Add => {
                if let Some(at) = picking
                    .chosen
                    .iter()
                    .position(|chosen| pick_key(chosen) == key)
                {
                    picking.chosen.remove(at);
                } else {
                    picking.chosen.push(pick);
                }
            }
            PickerMode::Change { .. } => picking.chosen = vec![pick],
        }
        cx.notify();
    }

    /// Why the primary button waits, if it does.
    fn picker_blocked(&self, picking: &Picking) -> Option<String> {
        match &picking.mode {
            PickerMode::Add => picking
                .chosen
                .is_empty()
                .then(|| copy::CHOOSE_ONE.to_string()),
            PickerMode::Change { scene_id, name, .. } => {
                let Some(pick) = picking.chosen.first() else {
                    return Some(copy::choose_what(name));
                };
                self.stored_scene(scene_id)
                    .filter(|scene| shows_pick(&scene.shows, pick))
                    .map(|_| copy::already_shows(name))
            }
        }
    }

    fn submit_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(picking) = &self.picking else {
            return;
        };
        if picking.busy || self.picker_blocked(picking).is_some() {
            return;
        }
        let mode = picking.mode.clone();
        let chosen = picking.chosen.clone();
        let snapshot = self.studio.watch().borrow().clone();
        let studio = self.studio.clone();
        match mode {
            PickerMode::Add => {
                let Some(library) = snapshot.scenes.library.clone() else {
                    return;
                };
                let Some(template) = snapshot
                    .scenes
                    .on_stream()
                    .cloned()
                    .or_else(|| library.scenes.first().cloned())
                else {
                    return;
                };
                let camera_on = snapshot.settings.capture_doc["sources"]["cameraId"]
                    .as_str()
                    .is_some_and(|id| !id.trim().is_empty());
                let made = new_scenes(
                    &chosen,
                    &template,
                    &library.scenes,
                    camera_on,
                    || uuid::Uuid::new_v4().to_string(),
                    now_iso,
                );
                let hints: HashMap<String, String> = made.window_hints.into_iter().collect();
                if let Some(picking) = &mut self.picking {
                    picking.busy = true;
                }
                self.finish_picker(window, cx, async move {
                    studio.insert_scenes(&made.scenes, None, &hints).await
                });
            }
            PickerMode::Change {
                scene_id,
                on_stream,
                for_layout,
                ..
            } => {
                let (Some(pick), Some(stored), Some(library)) = (
                    chosen.first().cloned(),
                    self.stored_scene(&scene_id),
                    snapshot.scenes.library.clone(),
                ) else {
                    return;
                };
                let next = scene_showing_pick(&stored, &pick, &library.scenes, &now_iso());
                let hint = match &pick {
                    ScreenPick::App(app) => app.front_window_id.clone(),
                    _ => None,
                };
                let vertical = snapshot.settings.capture_doc["layout"]["layoutPreset"]
                    .as_str()
                    .is_some_and(|preset| preset.starts_with("vertical-"));
                if let Some(picking) = &mut self.picking {
                    picking.busy = true;
                }
                self.finish_picker(window, cx, async move {
                    let edited = studio.edit_scene(&next, hint.as_deref()).await;
                    if !edited || !on_stream {
                        return edited;
                    }
                    // The scene on stream: the stream changes too.
                    match &pick {
                        ScreenPick::Display(device) | ScreenPick::Window(device) => {
                            let switched = studio
                                .select_source_device(SourceKind::Capture, Some(&device.id))
                                .await;
                            eprintln!("[videorc-app] Change screen: {switched:?}");
                        }
                        ScreenPick::None => {
                            let switched =
                                studio.select_source_device(SourceKind::Capture, None).await;
                            eprintln!("[videorc-app] Change screen: {switched:?}");
                            let layout = if vertical {
                                &next.vertical
                            } else {
                                &next.horizontal
                            };
                            if let Some(preset) = layout.get("layoutPreset").and_then(Value::as_str)
                            {
                                studio.apply_layout_preset(preset).await;
                            }
                        }
                        ScreenPick::App(_) => {
                            studio.apply_saved_scene_by_id(&scene_id).await;
                        }
                    }
                    // D19: the layout that asked for the screen goes on now.
                    if let Some(layout) = for_layout {
                        studio.apply_layout_preset(&layout).await;
                    }
                    true
                });
            }
        }
    }

    /// Runs the picker's write; the picker closes when it is taken.
    fn finish_picker(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        job: impl std::future::Future<Output = bool> + Send + 'static,
    ) {
        let (done, answer) = tokio::sync::oneshot::channel();
        self.run(async move {
            let _ = done.send(job.await);
        });
        cx.spawn_in(window, async move |this, cx| {
            let taken = answer.await.unwrap_or(false);
            let _ = this.update_in(cx, |page, window, cx| {
                if taken {
                    page.succeeded = true;
                    page.picking = None;
                    page.picker.close(window, cx);
                } else if let Some(picking) = &mut page.picking {
                    picking.busy = false;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn card(
        &self,
        id: SharedString,
        title: String,
        meta: Option<String>,
        selected: bool,
        pick: ScreenPick,
        well: Option<IconName>,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .id(id)
            .w(px(148.))
            .flex()
            .flex_col()
            .gap(px(6.))
            .p(px(8.))
            .rounded(px(radius::PANEL))
            .border_1()
            .border_color(hsla(if selected { t.ring } else { t.border }))
            .cursor_pointer()
            .child(
                div()
                    .w_full()
                    .h(px(74.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(radius::ROW))
                    .bg(hsla(t.inset))
                    .children(well.map(|name| icon(name, 32., hsla(t.muted_foreground)))),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .type_scale(text::LABEL)
                            .font_weight(FontWeight::MEDIUM)
                            .child(title),
                    )
                    .when(selected, |row| {
                        row.child(icon(IconName::Check, 14., hsla(t.foreground)))
                    }),
            )
            .children(meta.map(|meta| {
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .truncate()
                    .child(meta)
            }))
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_pick(pick.clone(), cx)))
            .into_any_element()
    }

    pub(super) fn picker_dialog(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(picking) = &self.picking else {
            return div().into_any_element();
        };
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let mode = picking.mode.clone();
        let chosen_keys: Vec<String> = picking.chosen.iter().map(pick_key).collect();
        let busy = picking.busy;
        let windows_open = picking.windows_open;
        let blocked = self.picker_blocked(picking);
        let chosen_count = picking.chosen.len();
        let first_pick = picking.chosen.first().cloned();

        let snapshot = self.studio.watch().borrow().clone();
        let devices = &snapshot.sources.devices.devices;
        let mac = platform() == Some("darwin");
        let own: Vec<String> = OWN_BUNDLE_IDS.iter().map(|id| id.to_string()).collect();
        let query = self.picker_search.read(cx).value().trim().to_string();
        let change = matches!(mode, PickerMode::Change { .. });
        let for_layout = matches!(
            &mode,
            PickerMode::Change {
                for_layout: Some(_),
                ..
            }
        );

        let apps: Vec<AppChoice> = if mac {
            app_choices_from_devices(devices, &own)
        } else {
            Vec::new()
        };
        let shown_apps = search_app_choices(&apps, &query);
        let windows: Vec<_> = if change && mac {
            window_choices(devices, &own)
                .into_iter()
                .filter(|device| {
                    matches_search(
                        &[
                            Some(window_label(device).as_str()),
                            device.app.as_ref().map(|app| app.name.as_str()),
                        ],
                        &query,
                    )
                })
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        let displays: Vec<_> = display_choices(devices, platform())
            .into_iter()
            .filter(|device| matches_search(&[Some(device.name.as_str())], &query))
            .cloned()
            .collect();
        let camera_title = if change {
            copy::NO_SCREEN
        } else {
            copy::CAMERA_ONLY
        };
        let camera_shown =
            !for_layout && matches_search(&[Some(camera_title), Some("camera")], &query);

        let (title, description) = match &mode {
            PickerMode::Add => (copy::ADD_TITLE, copy::ADD_DESCRIPTION.to_string()),
            PickerMode::Change {
                name,
                on_stream,
                for_layout,
                ..
            } => (
                copy::CHANGE_TITLE,
                copy::change_description(
                    name,
                    *on_stream,
                    for_layout.as_deref().map(layout_preset_label),
                ),
            ),
        };

        let mut body = div().flex().flex_col().gap(px(16.));
        if mac && !apps.is_empty() {
            body = body.child(
                Input::new("scene-picker-search", &self.picker_search).accessibility_label(
                    if change {
                        copy::SEARCH_CHANGE.trim_end_matches('…')
                    } else {
                        copy::SEARCH_ADD.trim_end_matches('…')
                    },
                ),
            );
        }

        let nothing = !query.is_empty()
            && shown_apps.is_empty()
            && windows.is_empty()
            && displays.is_empty()
            && !camera_shown;
        if nothing {
            body = body.child(Empty::new().description(copy::nothing_matches(&query)));
        }

        // P490–P492: the apps (macOS).
        if mac && (!shown_apps.is_empty() || query.is_empty()) {
            let mut group = div().flex().flex_col().gap(px(8.)).child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .font_weight(FontWeight::MEDIUM)
                    .child(copy::APPS),
            );
            if apps.is_empty() {
                group = group.child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            Empty::new()
                                .title(copy::NO_APPS_TITLE)
                                .description(copy::NO_APPS_DESCRIPTION),
                        )
                        .child(
                            Button::new("scene-picker-refresh")
                                .label(copy::REFRESH)
                                .variant(ButtonVariant::Outline)
                                .on_click(cx.listener(|this, _, _, _| this.refresh_devices())),
                        ),
                );
            } else {
                let mut grid = div().flex().flex_wrap().gap(px(12.));
                for app in shown_apps {
                    let pick = ScreenPick::App(app.clone());
                    let selected = chosen_keys.contains(&pick_key(&pick));
                    let meta =
                        window_count_label(app.window_count).or(app.front_window_title.clone());
                    grid = grid.child(self.card(
                        SharedString::from(format!("pick-{}", pick_key(&pick))),
                        app.name.clone(),
                        meta,
                        selected,
                        pick,
                        None,
                        t,
                        cx,
                    ));
                }
                group = group.child(grid);
            }
            body = body.child(group);
        }

        // P493: A specific window (Change screen…, macOS).
        if change && mac && (!windows.is_empty() || query.is_empty()) {
            let open = windows_open || !query.is_empty();
            let mut group = div().flex().flex_col().gap(px(8.)).child(
                Button::new("scene-picker-specific-window")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .child(icon(
                        if open {
                            IconName::CaretDown
                        } else {
                            IconName::CaretRight
                        },
                        12.,
                        muted,
                    ))
                    .child(copy::SPECIFIC_WINDOW)
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(picking) = &mut this.picking {
                            picking.windows_open = !picking.windows_open;
                        }
                        cx.notify();
                    })),
            );
            if open {
                group = group.child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(copy::SPECIFIC_WINDOW_LINE),
                );
                if windows.is_empty() {
                    group = group.child(
                        div()
                            .type_scale(text::META)
                            .text_color(muted)
                            .child(copy::NO_WINDOWS),
                    );
                } else {
                    let mut list = GroupedList::new().label("Windows");
                    for device in windows {
                        let pick = ScreenPick::Window(device.clone());
                        let selected = chosen_keys.contains(&pick_key(&pick));
                        let mut row = ListRow::new(
                            SharedString::from(format!("pick-{}", pick_key(&pick))),
                            window_label(&device),
                        )
                        .grouped()
                        .selected(selected)
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.toggle_pick(pick.clone(), cx)),
                        );
                        if let Some(app) = &device.app {
                            row = row.context(app.name.clone());
                        }
                        if selected {
                            row = row.status_icon(icon(IconName::Check, 14., hsla(t.foreground)));
                        }
                        list = list.row(row);
                    }
                    group = group.child(list);
                }
            }
            body = body.child(group);
        }

        // P494/P495: the displays.
        if !displays.is_empty() || query.is_empty() {
            let mut group = div().flex().flex_col().gap(px(8.)).child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .font_weight(FontWeight::MEDIUM)
                    .child(copy::DISPLAYS),
            );
            if displays.is_empty() {
                group = group.child(
                    Empty::new()
                        .title(copy::NO_DISPLAYS_TITLE)
                        .description(copy::NO_DISPLAYS_DESCRIPTION),
                );
            } else {
                let mut grid = div().flex().flex_wrap().gap(px(12.));
                for device in displays {
                    let meta = device
                        .width
                        .zip(device.height)
                        .map(|(width, height)| format!("{width} × {height}"));
                    let pick = ScreenPick::Display(device.clone());
                    let selected = chosen_keys.contains(&pick_key(&pick));
                    grid = grid.child(self.card(
                        SharedString::from(format!("pick-{}", pick_key(&pick))),
                        display_title(&device.name),
                        meta,
                        selected,
                        pick,
                        Some(IconName::Monitor),
                        t,
                        cx,
                    ));
                }
                group = group.child(grid);
            }
            body = body.child(group);
        }

        // P496: Camera only / No screen.
        if camera_shown {
            let sources = &snapshot.settings.capture_doc["sources"];
            let meta = match &mode {
                PickerMode::Change { scene_id, .. } => {
                    let draws_screen = self.stored_scene(scene_id).is_some_and(|scene| {
                        !layout_draws_no_screen(&scene.horizontal)
                            || !layout_draws_no_screen(&scene.vertical)
                    });
                    if draws_screen {
                        copy::PUTS_ON_CAMERA_ONLY.to_string()
                    } else {
                        copy::SHOWS_CAMERA_ONLY.to_string()
                    }
                }
                PickerMode::Add => {
                    let camera_on = sources["cameraId"]
                        .as_str()
                        .is_some_and(|id| !id.trim().is_empty());
                    if camera_on {
                        sources["cameraName"]
                            .as_str()
                            .unwrap_or(copy::YOUR_CAMERA)
                            .to_string()
                    } else {
                        copy::CAMERA_OFF.to_string()
                    }
                }
            };
            let pick = ScreenPick::None;
            let selected = chosen_keys.contains(&pick_key(&pick));
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(muted)
                            .font_weight(FontWeight::MEDIUM)
                            .child(copy::CAMERA),
                    )
                    .child(self.card(
                        "pick-none".into(),
                        camera_title.to_string(),
                        Some(meta),
                        selected,
                        pick,
                        None,
                        t,
                        cx,
                    )),
            );
        }

        // P497: the scene's layout shows no screen.
        if let (
            PickerMode::Change {
                scene_id,
                name,
                for_layout: None,
                ..
            },
            Some(pick),
        ) = (&mode, &first_pick)
            && !matches!(pick, ScreenPick::None)
        {
            let vertical = snapshot.settings.capture_doc["layout"]["layoutPreset"]
                .as_str()
                .is_some_and(|preset| preset.starts_with("vertical-"));
            if let Some(scene) = self.stored_scene(scene_id) {
                let layout = if vertical {
                    &scene.vertical
                } else {
                    &scene.horizontal
                };
                if layout_draws_no_screen(layout) {
                    let label = layout_preset_label(
                        layout
                            .get("layoutPreset")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    );
                    body = body.child(
                        div()
                            .id("scene-picker-layout-note")
                            .type_scale(text::META)
                            .text_color(muted)
                            .child(copy::layout_note(name, label)),
                    );
                }
            }
        }

        let primary_label = if change {
            copy::CHANGE_BUTTON.to_string()
        } else {
            add_scenes_label(chosen_count)
        };
        let mut primary = Button::new("scene-picker-submit")
            .label(primary_label)
            .disabled(busy || blocked.is_some())
            .on_click(cx.listener(|this, _, window, cx| this.submit_picker(window, cx)));
        if let Some(reason) = blocked {
            primary = primary.tooltip(reason);
        }
        let page = cx.entity().downgrade();
        Dialog::new("scene-picker-dialog", &self.picker, title)
            .size(DialogSize::Lg)
            .description(description)
            .on_open_change(move |open, _, _, cx| {
                if !open {
                    let _ = page.update(cx, |page, cx| {
                        page.picking = None;
                        cx.notify();
                    });
                }
            })
            .child(body)
            .footer(
                Button::new("scene-picker-cancel")
                    .label(copy::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.picking = None;
                        this.picker.close(window, cx);
                    })),
            )
            .footer(primary)
            .into_any_element()
    }

    /// The picker's Refresh: the device list again.
    fn refresh_devices(&self) {
        let studio = self.studio.clone();
        self.run(async move {
            let result = studio.refresh_sources().await;
            eprintln!("[videorc-app] Scene picker refresh: {result:?}");
        });
    }
}
