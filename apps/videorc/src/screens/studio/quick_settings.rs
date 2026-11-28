//! Quick settings (`quick-settings.tsx`, P248–P263): the Studio inspector's
//! Camera / Captions / Chat mirrors. Words and state come from app-core
//! `sources_section` and `camera_background_view` (the same Background
//! rules Scene ⌘3 already draws). This module draws them and calls the
//! Studio; the Background popover body lives in [`super::background`].

use std::sync::Arc;

use gpui::{
    AnyElement, Context, EventEmitter, FontWeight, RenderImage, SharedString, Task, Window, div,
    prelude::*, px,
};
use tokio::sync::watch;
use videorc_app_core::chat::LiveChat;
use videorc_app_core::chat::store::DeliveryCursor;
use videorc_app_core::desktop::permissions::PermissionPlatform;
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::HealthTelemetry;
use videorc_app_core::studio::camera_background_art::current_art;
use videorc_app_core::studio::camera_background_frames::{
    POLL_INTERVAL, bgra_from_bmp, poll_camera_frame,
};
use videorc_app_core::studio::camera_background_view::{
    CHOOSE_IMAGE_DESCRIPTION, CHOOSE_IMAGE_EMPTY, CHOOSE_IMAGE_TITLE, ChoiceId, ChoicesInput,
    DONE_LABEL, LABEL as BACKGROUND_LABEL, OPEN_IMAGES_LABEL, POPOVER_IMAGES, background_for,
    background_for_choice, bundled_images, choices, images_picked_first,
};
use videorc_app_core::studio::room_frames::{FrameCursor, FramePoll};
use videorc_app_core::studio::session::session_is_live;
use videorc_app_core::studio::source_selection::{PICKER_NONE_VALUE, PickerView, SourceKind};
use videorc_app_core::studio::sources_section::{
    SourcesExtras, SourcesSectionView, copy as section_copy,
};
use videorc_app_core::{ConnectionState, StudioSnapshot};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::GroupedList;
use videorc_kit::navigable_row::NavigableRow;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::popover::Popover;
use videorc_kit::select::Select;
use videorc_kit::shortcut_keys::{ShortcutKeys, ShortcutStyle};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, size, text};

use super::background::{image_tiles, picker_body, thumbnail};
use super::transport::{AppStudio, OpenPage};

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
            images: &bundled_images(&videorc_app_core::bundled::current().backgrounds),
            platform: Some(runtime_platform()),
        },
    )
}

/// The polls between two checks that the popover is still drawn (about 2 s).
const VIEWER_SEEN_TICKS: u32 = 13;

/// The Background popover's "What viewers see" while it is open: the
/// camera's newest processed frame and the task that polls for it.
struct ViewerFeed {
    /// The frame shown, with its place in the stream; none until one arrives
    /// and after the camera has none.
    frame: Option<(FrameCursor, Arc<RenderImage>)>,
    /// Dropped with the feed, which stops the polling.
    task: Task<()>,
}

/// One poll, read off the main thread: a new frame is decoded there.
enum ViewerPoll {
    Frame(FrameCursor, Arc<RenderImage>),
    /// No camera frame: back to the pick's picture.
    Empty,
    Unchanged,
}

/// The poll's BMP as a picture GPUI draws (BGRA, mirrored like the outputs).
fn viewer_poll(poll: FramePoll, mirror: bool) -> ViewerPoll {
    match poll {
        FramePoll::Frame { cursor, bmp } => bgra_from_bmp(&bmp, mirror)
            .and_then(|frame| image::RgbaImage::from_raw(frame.width, frame.height, frame.pixels))
            .map_or(ViewerPoll::Unchanged, |pixels| {
                ViewerPoll::Frame(
                    cursor,
                    Arc::new(RenderImage::new(vec![image::Frame::new(pixels)])),
                )
            }),
        FramePoll::Empty => ViewerPoll::Empty,
        FramePoll::Unchanged => ViewerPoll::Unchanged,
    }
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
    /// The popover's live picture: there only while the popover is drawn.
    viewer: Option<ViewerFeed>,
    /// The popover's body was drawn since the feed last checked.
    viewer_seen: bool,
    choose_image: DialogHandle,
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
                let alive = this.update(cx, |section, cx| {
                    section.chat = chat;
                    section.telemetry = health;
                    let next = section_view(
                        &snap,
                        &section.telemetry,
                        &section.chat,
                        section.door_cursor,
                    );
                    if section.view != next {
                        section.view = next;
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
            viewer: None,
            viewer_seen: false,
            choose_image: DialogHandle::new(false),
        }
    }

    /// Opens or closes the Background popover. Closing it stops the live
    /// picture's polling and drops its frame.
    fn set_popover_open(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.popover_open = open;
        // The taken feed drops with its `task` either way: the polling stops.
        if !open
            && let Some(feed) = self.viewer.take()
            && let Some((_, frame)) = feed.frame
        {
            cx.drop_image(frame, Some(window));
        }
        cx.notify();
    }

    /// Starts the live picture's polling when the popover's body is drawn
    /// (`CameraBackgroundViewer` polls only while mounted): one poll every
    /// 150 ms, the newest frame kept. A failed poll is asked again on the
    /// next tick and the last frame stays; no toast, no error. It stops when
    /// the popover closes ([`Self::set_popover_open`]) and, about 2 s after
    /// the body was last drawn, by itself (the page left with it open).
    fn ensure_viewer(&mut self, cx: &mut Context<Self>) {
        self.viewer_seen = true;
        if self.viewer.is_some() {
            return;
        }
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let task = cx.spawn(async move |this, cx| {
            let mut ticks = 0;
            loop {
                // What to ask after, and which way round the camera is.
                let Ok(Some((after, mirror))) = this.update(cx, |section, _| {
                    let feed = section.viewer.as_ref().filter(|_| section.popover_open)?;
                    let after = feed.frame.as_ref().map(|(cursor, _)| cursor.clone());
                    let mirror = section
                        .studio
                        .watch()
                        .borrow()
                        .settings
                        .capture
                        .layout
                        .camera_mirror;
                    Some((after, mirror))
                }) else {
                    break;
                };
                if let ConnectionState::Connected { ready, .. } = studio.backend().current_state() {
                    let (port, token) = (ready.port, ready.token.clone());
                    let job = runtime.spawn(async move {
                        poll_camera_frame(port, &token, after.as_ref())
                            .await
                            .map(|poll| viewer_poll(poll, mirror))
                    });
                    if let Ok(Ok(poll)) = job.await
                        && this
                            .update(cx, |section, cx| section.take_viewer_poll(poll, cx))
                            .is_err()
                    {
                        return;
                    }
                }
                cx.background_executor().timer(POLL_INTERVAL).await;
                ticks += 1;
                if ticks % VIEWER_SEEN_TICKS == 0 {
                    // Ask for a draw; a popover still on screen answers
                    // (`viewer_seen`) before the next check.
                    let Ok(seen) = this.update(cx, |section, cx| {
                        let seen = std::mem::take(&mut section.viewer_seen);
                        cx.notify();
                        seen
                    }) else {
                        return;
                    };
                    if !seen {
                        break;
                    }
                }
            }
            // The popover is closed or no longer drawn: the feed and its
            // frame go. This task is the feed's own, so it is let go of
            // rather than cancelled from inside itself.
            let _ = this.update(cx, |section, cx| {
                if let Some(feed) = section.viewer.take() {
                    if let Some((_, frame)) = feed.frame {
                        cx.drop_image(frame, None);
                    }
                    feed.task.detach();
                    cx.notify();
                }
            });
        });
        self.viewer = Some(ViewerFeed { frame: None, task });
    }

    /// Keeps a poll's answer: the newer frame (the one before it leaves the
    /// GPU), or none when the camera has no frame.
    fn take_viewer_poll(&mut self, poll: ViewerPoll, cx: &mut Context<Self>) {
        let Some(feed) = self.viewer.as_mut() else {
            return;
        };
        let before = match poll {
            ViewerPoll::Frame(cursor, frame) => feed.frame.replace((cursor, frame)),
            ViewerPoll::Empty => match feed.frame.take() {
                Some(before) => Some(before),
                None => return,
            },
            ViewerPoll::Unchanged => return,
        };
        if let Some((_, before)) = before {
            cx.drop_image(before, None);
        }
        cx.notify();
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

    fn background_line(&self, _t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let Some(line) = self.view.camera.background.clone() else {
            return div().into_any_element();
        };
        let open = self.popover_open;
        let trigger_value = SharedString::from(line.value_label.clone());
        let entity = cx.entity().downgrade();
        let content_entity = entity.clone();
        let background = line.background.clone();
        let choice = line.choice.clone();
        // The trigger's picture: the Orc over the current pick.
        let art = current_art(line.choice.as_ref(), || {
            bundled_images(&videorc_app_core::bundled::current().backgrounds)
        });

        Popover::new("quick-settings-background")
            .open(open)
            .width(320.)
            .on_open_change(move |now, window, cx| {
                let _ = entity.update(cx, |section, cx| {
                    section.set_popover_open(now, window, cx);
                });
            })
            .trigger_with(move |_expanded, window, app| {
                let theme = theme::resolve(None, window, app);
                NavigableRow::new(
                    "quick-settings-background-trigger",
                    BACKGROUND_LABEL,
                    trigger_value.clone(),
                )
                .leading(thumbnail(&art, theme))
                .on_navigate(|_, _, _| {})
            })
            .content(move |window, cx| {
                content_entity
                    .update(cx, |section, cx| {
                        section.popover_content(&background, choice.as_ref(), window, cx)
                    })
                    .unwrap_or_else(|_| div().into_any_element())
            })
            .into_any_element()
    }

    fn popover_content(
        &mut self,
        background: &serde_json::Value,
        selected: Option<&ChoiceId>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::resolve(None, window, cx);
        // P257: the live "What viewers see", only while this body is drawn.
        if self.popover_open {
            self.ensure_viewer(cx);
        }
        let frame = self
            .viewer
            .as_ref()
            .and_then(|feed| feed.frame.as_ref())
            .map(|(_, frame)| frame.clone());
        let camera_selected = self
            .studio
            .watch()
            .borrow()
            .settings
            .capture
            .sources
            .camera_id
            .is_some();
        let images = bundled_images(&videorc_app_core::bundled::current().backgrounds);
        let picked = match selected {
            Some(ChoiceId::Image(id)) => Some(id.as_str()),
            _ => None,
        };
        let shown = images_picked_first(&images, picked);
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
            frame,
            t,
            move |choice, _window, cx| {
                // The popover stays open on a pick, as Electron's does, so
                // "What viewers see" shows the new pick at once (owner,
                // 2026-11-27). Escape, a click outside, Choose… and Settings
                // close it.
                let _ = choose_entity.update(cx, |section, cx| {
                    section.choose_background(choice);
                    cx.notify();
                });
            },
            move |window, cx| {
                let _ = image_entity.update(cx, |section, cx| {
                    section.set_popover_open(false, window, cx);
                    section.choose_image.open(window, cx);
                    cx.notify();
                });
            },
            move |window, cx| {
                let _ = settings_entity.update(cx, |section, cx| {
                    section.set_popover_open(false, window, cx);
                    // Scene page is Background's home (Electron
                    // `openSceneBackground`, P575).
                    cx.emit(OpenPage::scene_background());
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
            images: &bundled_images(&videorc_app_core::bundled::current().backgrounds),
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
                t,
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
                .variant(ButtonVariant::Outline)
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
}

impl Render for QuickSettingsSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        // No "Sources" heading (plan 235 D3): group_label is for screen
        // readers only; GroupedList's visible label stays off.
        let _ = self.view.group_label;

        let sources = PanelSection::new("quick-settings-sources")
            .child(GroupedList::new().item(self.camera_block(t, cx)));
        let doors = PanelSection::new("quick-settings-doors").child(
            GroupedList::new()
                .row(self.captions_row(t, cx))
                .row(self.chat_row(t, cx)),
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
