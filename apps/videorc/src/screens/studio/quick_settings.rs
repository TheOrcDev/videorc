//! Quick settings (`quick-settings.tsx`, P248–P263): the Studio inspector's
//! Camera / Captions / Chat mirrors. Words and state come from app-core
//! `sources_section` and `camera_background_view` (the same Background
//! rules Scene ⌘3 already draws). This module draws them and calls the
//! Studio; the Background popover body lives in [`super::background`].

use std::sync::Arc;

use gpui::{
    AnyElement, Context, EventEmitter, FontWeight, SharedString, Window, div, prelude::*, px,
};
use tokio::sync::watch;
use videorc_app_core::StudioSnapshot;
use videorc_app_core::chat::LiveChat;
use videorc_app_core::chat::store::DeliveryCursor;
use videorc_app_core::desktop::permissions::PermissionPlatform;
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::HealthTelemetry;
use videorc_app_core::studio::camera_background_view::{
    CHOOSE_IMAGE_DESCRIPTION, CHOOSE_IMAGE_EMPTY, CHOOSE_IMAGE_TITLE, ChoiceId, ChoicesInput,
    DONE_LABEL, LABEL as BACKGROUND_LABEL, OPEN_IMAGES_LABEL, POPOVER_IMAGES, background_for,
    background_for_choice, choices, images_picked_first,
};
use videorc_app_core::studio::session::session_is_live;
use videorc_app_core::studio::source_selection::{PICKER_NONE_VALUE, PickerView, SourceKind};
use videorc_app_core::studio::sources_section::{
    SourcesExtras, SourcesSectionView, copy as section_copy,
};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::GroupedList;
use videorc_kit::navigable_row::NavigableRow;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::popover::Popover;
use videorc_kit::select::Select;
use videorc_kit::shortcut_keys::{self, ShortcutKeys, ShortcutStyle, parse_accelerator};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, size, text};

use super::background::{image_tiles, picker_body, thumbnail};
use super::transport::{AppStudio, OpenPage};
use crate::lcd;

/// Indent under the Camera row (`pl-9.5` ≈ 38 px).
const FOOTER_INDENT_PX: f32 = 38.;

/// `InspectorRow`'s label column (`w-22`).
const ROW_LABEL_PX: f32 = 88.;

fn runtime_platform() -> &'static str {
    match PermissionPlatform::current() {
        PermissionPlatform::MacOs => "darwin",
        PermissionPlatform::Windows => "win32",
        PermissionPlatform::Other => "linux",
    }
}

fn fill_select(id: &'static str, picker: &PickerView, disabled: bool) -> Select {
    let selected = picker
        .items
        .iter()
        .find(|item| item.selected && item.heading.is_empty())
        .map(|item| item.value.clone());
    let mut select = Select::new(id)
        .placeholder(if picker.placeholder {
            picker.label.clone()
        } else {
            "Choose…".to_string()
        })
        .disabled(disabled)
        .accessibility_label(section_copy::CAMERA)
        .value(selected.map(SharedString::from));
    for item in &picker.items {
        if !item.heading.is_empty() {
            continue;
        }
        if item.disabled && !item.selected {
            continue;
        }
        select = select.option(item.value.clone(), item.label.clone());
    }
    select
}

fn section_view(
    snapshot: &StudioSnapshot,
    telemetry: &HealthTelemetry,
    chat: &LiveChat,
    door_cursor: DeliveryCursor,
) -> SourcesSectionView {
    let chat_on_air = session_is_live(&snapshot.session.status)
        && chat.session_id.is_some()
        && !chat.providers.is_empty();
    let chat_new_count = chat.delivery.progress(Some(door_cursor)).count;
    SourcesSectionView::from_snapshot(
        snapshot,
        telemetry,
        &SourcesExtras {
            chat_on_air,
            chat_new_count,
            images: &[],
            platform: Some(runtime_platform()),
        },
    )
}

/// The Studio inspector's Quick settings (no heading: the rows name themselves).
pub struct QuickSettingsSection {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    view: SourcesSectionView,
    telemetry: HealthTelemetry,
    chat: LiveChat,
    door_cursor: DeliveryCursor,
    popover_open: bool,
    choose_image: DialogHandle,
    /// Settings → General → Retro LCD: Sources / Captions / Chat on screens.
    retro: bool,
}

impl EventEmitter<OpenPage> for QuickSettingsSection {}

impl QuickSettingsSection {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        mut snapshot: watch::Receiver<StudioSnapshot>,
        mut telemetry: watch::Receiver<HealthTelemetry>,
        mut live_chat: watch::Receiver<LiveChat>,
        cx: &mut Context<Self>,
    ) -> Self {
        let chat = live_chat.borrow().clone();
        let health = telemetry.borrow().clone();
        let door_cursor = DeliveryCursor {
            generation: chat.delivery.generation,
            sequence: 0,
            loss: chat.delivery.loss,
        };
        let snap = snapshot.borrow().clone();
        let view = section_view(&snap, &health, &chat, door_cursor);
        let retro = snap.settings.studio.retro_lcd_studio();
        cx.spawn(async move |this, cx| {
            loop {
                let open = tokio::select! {
                    changed = snapshot.changed() => changed.is_ok(),
                    changed = telemetry.changed() => changed.is_ok(),
                    changed = live_chat.changed() => changed.is_ok(),
                };
                if !open {
                    break;
                }
                let snap = snapshot.borrow_and_update().clone();
                let health = telemetry.borrow_and_update().clone();
                let chat = live_chat.borrow_and_update().clone();
                let retro = snap.settings.studio.retro_lcd_studio();
                let alive = this.update(cx, |section, cx| {
                    section.chat = chat;
                    section.telemetry = health;
                    let next = section_view(
                        &snap,
                        &section.telemetry,
                        &section.chat,
                        section.door_cursor,
                    );
                    if section.view != next || section.retro != retro {
                        section.view = next;
                        section.retro = retro;
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            studio,
            runtime,
            view,
            telemetry: health,
            chat,
            door_cursor,
            popover_open: false,
            choose_image: DialogHandle::new(false),
            retro,
        }
    }

    fn select_camera(&self, value: String) {
        let studio = self.studio.clone();
        let picked = (value != PICKER_NONE_VALUE).then_some(value);
        self.runtime.spawn(async move {
            let result = studio
                .select_source_device(SourceKind::Camera, picked.as_deref())
                .await;
            eprintln!("[videorc-app] Quick settings camera: {result:?}");
        });
    }

    fn choose_background(&self, choice: ChoiceId) {
        let snapshot = self.studio.watch().borrow().clone();
        let camera_id = snapshot.settings.capture.sources.camera_id.clone();
        let current = background_for(
            snapshot.settings.studio.get("cameraBackgrounds"),
            camera_id.as_deref(),
        );
        let next = background_for_choice(&current, &choice);
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let ok = studio.apply_camera_background(&next).await;
            eprintln!("[videorc-app] Quick settings background: {ok}");
        });
    }

    fn open_stream_manager(&mut self, cx: &mut Context<Self>) {
        self.door_cursor = self.chat.delivery.cursor();
        let snap = self.studio.watch().borrow().clone();
        self.view = section_view(&snap, &self.telemetry, &self.chat, self.door_cursor);
        crate::screens::stream_manager::window::show(cx);
        cx.notify();
    }

    fn footer_line(&self, mark: Option<(IconName, bool)>, words: String, t: &Theme) -> AnyElement {
        let muted = hsla(t.muted_foreground);
        let mut row = div()
            .px(px(12.))
            .pb(px(8.))
            .pl(px(FOOTER_INDENT_PX))
            .flex()
            .items_start()
            .gap(px(6.))
            .type_scale(text::META)
            .text_color(muted);
        if let Some((name, warning)) = mark {
            let color = if warning { hsla(t.warning) } else { muted };
            row = row.child(icon(name, 14., color));
        }
        row.child(div().min_w_0().child(words)).into_any_element()
    }

    fn camera_block(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let camera = &self.view.camera;
        let muted = hsla(t.muted_foreground);
        let ghost = hsla(t.foreground);
        let disabled = camera.row.disabled_reason.is_some();
        let entity = cx.entity().downgrade();

        // `trigger="inline"` (`quick-settings.tsx:92-111`): the row's value,
        // borderless and right-aligned, its list 288 px at the end.
        let picker = fill_select("quick-settings-camera", &camera.row.picker, disabled)
            .inline(true)
            .on_change(move |value, _, cx| {
                let _ = entity.update(cx, |section, _| {
                    section.select_camera(value.to_string());
                });
            });

        let open = cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Sources)));
        // `InspectorRow`: `min-h-row py-0.5 pr-1 pl-3 gap-2.5`, the label
        // `text-sm text-muted-foreground` in its `w-22` column.
        let mut column = div().flex().flex_col().child(
            div()
                .flex()
                .min_h(px(size::ROW))
                .items_center()
                .gap(px(10.))
                .py(px(2.))
                .pl(px(12.))
                .pr(px(4.))
                .child(icon(IconName::VideoCamera, 16., muted))
                .child(
                    div()
                        .w(px(ROW_LABEL_PX))
                        .flex_none()
                        .truncate()
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .text_color(muted)
                        .child(section_copy::CAMERA),
                )
                .child(div().min_w_0().flex_1().flex().justify_end().child(picker))
                .child(
                    Button::new("quick-settings-open-sources")
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::IconXs)
                        .accessibility_label(camera.open_label)
                        .tooltip(camera.open_label)
                        .child(icon(IconName::GearSix, 16., ghost))
                        .on_click(open),
                ),
        );
        if let Some(status) = &camera.row.status {
            column = column.child(self.footer_line(None, status.message.clone(), t));
        }
        if let Some(stand_in) = &camera.row.stand_in {
            column = column.child(self.footer_line(None, stand_in.clone(), t));
        }
        if camera.background.is_some() {
            column = column.child(self.background_line(t, cx));
        }
        if let Some(stage) = &camera.background_stage {
            column =
                column.child(self.footer_line(Some((IconName::Warning, true)), stage.clone(), t));
        }
        if let Some(effect) = camera.system_effect {
            column = column.child(self.footer_line(
                Some((IconName::Info, false)),
                effect.to_string(),
                t,
            ));
        }
        column.into_any_element()
    }

    fn background_line(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(line) = self.view.camera.background.clone() else {
            return div().into_any_element();
        };
        let open = self.popover_open;
        let trigger_value = SharedString::from(line.value_label.clone());
        let entity = cx.entity().downgrade();
        let content_entity = entity.clone();
        let background = line.background.clone();
        let choice = line.choice.clone();
        let value_for_picker = line.value_label.clone();

        Popover::new("quick-settings-background")
            .open(open)
            .width(320.)
            .on_open_change(move |now, _, cx| {
                let _ = entity.update(cx, |section, cx| {
                    section.popover_open = now;
                    cx.notify();
                });
            })
            .trigger_with(move |_expanded, window, app| {
                let theme = theme::resolve(None, window, app);
                NavigableRow::new(
                    "quick-settings-background-trigger",
                    BACKGROUND_LABEL,
                    trigger_value.clone(),
                )
                .leading(thumbnail(&theme))
                .on_navigate(|_, _, _| {})
            })
            .content(move |window, cx| {
                content_entity
                    .update(cx, |section, cx| {
                        section.popover_content(
                            &background,
                            choice.as_ref(),
                            &value_for_picker,
                            window,
                            cx,
                        )
                    })
                    .unwrap_or_else(|_| div().into_any_element())
            })
            .into_any_element()
    }

    fn popover_content(
        &self,
        background: &serde_json::Value,
        selected: Option<&ChoiceId>,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        let camera_selected = self
            .studio
            .watch()
            .borrow()
            .settings
            .capture
            .sources
            .camera_id
            .is_some();
        let shown = images_picked_first(&[], None);
        let tiles = choices(&ChoicesInput {
            images: &shown,
            camera_selected,
            room_open: false,
            platform: Some(runtime_platform()),
            image_limit: Some(POPOVER_IMAGES),
        });
        let choose_entity = cx.entity().downgrade();
        let image_entity = choose_entity.clone();
        let settings_entity = choose_entity.clone();
        picker_body(
            background,
            &tiles,
            selected,
            value,
            &t,
            move |choice, _, cx| {
                let _ = choose_entity.update(cx, |section, cx| {
                    section.choose_background(choice);
                    section.popover_open = false;
                    cx.notify();
                });
            },
            move |window, cx| {
                let _ = image_entity.update(cx, |section, cx| {
                    section.popover_open = false;
                    section.choose_image.open(window, cx);
                    cx.notify();
                });
            },
            move |_, cx| {
                let _ = settings_entity.update(cx, |section, cx| {
                    section.popover_open = false;
                    // Scene page is Background's home (Electron
                    // `openSceneBackground`, P575).
                    cx.emit(OpenPage::scene_background());
                    cx.notify();
                });
            },
        )
    }

    fn choose_image_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if !self.choose_image.is_open() {
            return div().into_any_element();
        }
        let t = theme::resolve(None, window, cx);
        let camera_selected = self
            .studio
            .watch()
            .borrow()
            .settings
            .capture
            .sources
            .camera_id
            .is_some();
        let image_choices = choices(&ChoicesInput {
            images: &[],
            camera_selected,
            room_open: false,
            platform: Some(runtime_platform()),
            image_limit: None,
        })
        .into_iter()
        .filter(|choice| matches!(choice.id, ChoiceId::Image(_)))
        .collect::<Vec<_>>();
        let selected = self
            .view
            .camera
            .background
            .as_ref()
            .and_then(|line| line.choice.clone());
        let body: AnyElement = if image_choices.is_empty() {
            Empty::new()
                .description(CHOOSE_IMAGE_EMPTY)
                .into_any_element()
        } else {
            let entity = cx.entity().downgrade();
            image_tiles(
                &image_choices,
                selected.as_ref(),
                &t,
                move |choice, window, cx| {
                    let _ = entity.update(cx, |section, cx| {
                        section.choose_background(choice);
                        section.choose_image.close(window, cx);
                        cx.notify();
                    });
                },
            )
        };
        Dialog::new(
            "quick-settings-choose-image",
            &self.choose_image,
            CHOOSE_IMAGE_TITLE,
        )
        .size(DialogSize::Lg)
        .description(CHOOSE_IMAGE_DESCRIPTION)
        .child(body)
        .footer(
            Button::new("quick-settings-open-images")
                .label(OPEN_IMAGES_LABEL)
                .variant(ButtonVariant::Ghost)
                .on_click(cx.listener(|section, _, window, cx| {
                    section.choose_image.close(window, cx);
                    cx.emit(OpenPage::of(PageId::Assets));
                    cx.notify();
                })),
        )
        .footer(
            Button::new("quick-settings-choose-image-done")
                .label(DONE_LABEL)
                .variant(ButtonVariant::Secondary)
                .on_click(cx.listener(|section, _, window, cx| {
                    section.choose_image.close(window, cx);
                    cx.notify();
                })),
        )
        .into_any_element()
    }

    fn captions_row(&self, t: &Theme, cx: &mut Context<Self>) -> NavigableRow {
        NavigableRow::new(
            "quick-settings-captions",
            section_copy::CAPTIONS,
            self.view.captions.clone(),
        )
        .icon(icon(
            IconName::ClosedCaptioning,
            16.,
            hsla(t.muted_foreground),
        ))
        .on_navigate(cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Captions))))
    }

    fn chat_row(&self, t: &Theme, cx: &mut Context<Self>) -> NavigableRow {
        let door = &self.view.chat;
        let value: AnyElement = if let Some(new_label) = &door.new_label {
            div().child(new_label.clone()).into_any_element()
        } else {
            div()
                .flex()
                .min_w_0()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .child(section_copy::STREAM_MANAGER),
                )
                .child(div().text_color(hsla(t.muted_foreground)).child("·"))
                // `door.accelerator`, as Electron prints it: the menu's
                // binding sits behind the shell's modal gate, which the
                // keymap only reports to a focused view.
                .child(
                    div()
                        .font_weight(FontWeight::NORMAL)
                        .text_color(hsla(t.muted_foreground))
                        .child(
                            ShortcutKeys::accelerator(door.accelerator).style(ShortcutStyle::Text),
                        ),
                )
                .into_any_element()
        };
        NavigableRow::with_control("quick-settings-chat", section_copy::CHAT, value)
            .icon(icon(IconName::ChatCircle, 16., hsla(t.muted_foreground)))
            .on_navigate(cx.listener(|section, _, _, cx| {
                section.open_stream_manager(cx);
            }))
    }

    /// Retro LCD Sources + Captions/Chat screens (P239–P243).
    fn render_retro(&self, t: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let camera = &self.view.camera;
        let disabled = camera.row.disabled_reason.is_some();
        let entity = cx.entity().downgrade();
        let open_page = camera.open_page.unwrap_or(PageId::Sources);
        let cog = lcd::cog(
            "quick-settings-lcd-open-sources",
            t,
            camera.open_label,
            cx.listener(move |_, _, _, cx| cx.emit(OpenPage::of(open_page))),
        );
        // `LcdDevicePicker`'s `LcdPanelRow` (`py-2 gap-4`): the dim label,
        // then the pick and the cog on the right.
        let mut sources_body = div().flex().flex_col().child(
            div()
                .flex()
                .min_w_0()
                .items_center()
                .justify_between()
                .gap(px(16.))
                .py(px(8.))
                .child(
                    div()
                        .flex_none()
                        .text_color(lcd::dim(t))
                        .child(lcd::tracked(section_copy::CAMERA)),
                )
                .child(
                    div()
                        .flex()
                        .min_w_0()
                        .items_center()
                        .justify_end()
                        .gap(px(8.))
                        .child(
                            fill_select("quick-settings-lcd-camera", &camera.row.picker, disabled)
                                .trigger_with(lcd::picker_trigger(t))
                                .on_change(move |value, _, cx| {
                                    let _ = entity.update(cx, |section, _| {
                                        section.select_camera(value.to_string());
                                    });
                                }),
                        )
                        .child(cog),
                ),
        );
        if let Some(status) = &camera.row.status {
            sources_body = sources_body.child(lcd::message(t, status.message.clone()));
        }
        if let Some(stand_in) = &camera.row.stand_in {
            sources_body = sources_body.child(lcd::message(t, stand_in.clone()));
        }
        if camera.background.is_some() {
            // Keep the same Background popover (C2); only the trigger is LCD.
            sources_body = sources_body.child(self.background_line(t, cx));
        }
        if let Some(stage) = &camera.background_stage {
            sources_body = sources_body.child(lcd::message(t, stage.clone()));
        }
        if let Some(effect) = camera.system_effect {
            sources_body = sources_body.child(lcd::message(t, effect));
        }

        let captions = lcd::nav_row(
            "quick-settings-lcd-captions",
            t,
            section_copy::CAPTIONS,
            div()
                .truncate()
                .child(lcd::caps(self.view.captions.clone())),
            cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Captions))),
        );
        // One line that truncates at its end, as Electron's LCD value does
        // ("STREAM MANAGER · ⇧…"): the name stays whole and the key is what
        // a narrow screen cuts. Tracked text can't end in "…", so the line
        // is plain capitals; the key is printed by the kit from the keymap's
        // accelerator, never a hand-typed glyph (gpui-design-guards).
        let chat_value: AnyElement = if let Some(new_label) = &self.view.chat.new_label {
            div()
                .truncate()
                .child(lcd::caps(new_label.clone()))
                .into_any_element()
        } else {
            let mac = cfg!(target_os = "macos");
            let strokes = parse_accelerator(self.view.chat.accelerator, mac);
            let keys = shortcut_keys::label(
                strokes
                    .iter()
                    .map(|stroke| (stroke.modifiers, stroke.key.as_str())),
                mac,
            );
            let words = if keys.is_empty() {
                section_copy::STREAM_MANAGER.to_string()
            } else {
                format!("{} · {keys}", section_copy::STREAM_MANAGER)
            };
            div()
                .min_w_0()
                .truncate()
                .child(lcd::caps(words))
                .into_any_element()
        };
        let chat = lcd::nav_row(
            "quick-settings-lcd-chat",
            t,
            section_copy::CHAT,
            chat_value,
            cx.listener(|section, _, _, cx| section.open_stream_manager(cx)),
        );

        // Each screen in its own section (`RetroQuickSettings`), as the
        // default look's groups are.
        div()
            .id("quick-settings")
            .flex()
            .flex_col()
            .child(
                PanelSection::new("quick-settings-sources").child(lcd::panel(
                    "quick-settings-lcd-sources",
                    t,
                    section_copy::SOURCES,
                    sources_body,
                )),
            )
            .child(PanelSection::new("quick-settings-doors").child(lcd::panel(
                "quick-settings-lcd-doors",
                t,
                "Captions and Chat",
                div().flex().flex_col().child(captions).child(chat),
            )))
            .child(self.choose_image_dialog(window, cx))
            .into_any_element()
    }
}

impl Render for QuickSettingsSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        // No "Sources" heading (plan 235 D3): group_label is for screen
        // readers only; GroupedList's visible label stays off.
        let _ = self.view.group_label;
        if self.retro {
            return self.render_retro(&t, window, cx);
        }
        let sources = PanelSection::new("quick-settings-sources")
            .child(GroupedList::new().item(self.camera_block(&t, cx)));
        let doors = PanelSection::new("quick-settings-doors").child(
            GroupedList::new()
                .row(self.captions_row(&t, cx))
                .row(self.chat_row(&t, cx)),
        );
        div()
            .id("quick-settings")
            .flex()
            .flex_col()
            .child(sources)
            .child(doors)
            .child(self.choose_image_dialog(window, cx))
            .into_any_element()
    }
}
