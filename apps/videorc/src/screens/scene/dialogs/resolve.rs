//! Resolve scene sources (`scene-dialogs.tsx`; P481–P485): a scene whose
//! camera or screen is gone gets sources that are connected now, and keeps
//! them once it goes on. A row click opens it when the scene needs
//! sources, and so does a failed apply that has no words of its own.

use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*, px};
use serde_json::Value;
use tokio::sync::oneshot;
use videorc_app_core::protocol::DeviceKind;
use videorc_app_core::scenes::model::{SavedScene, normalize_scene_visual, scene_source_problems};
use videorc_app_core::studio::scene_switch::ApplyOptions;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogSize};
use videorc_kit::select::Select;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::super::now_iso;
use super::SceneDialogs;

pub(super) mod copy {
    pub const TITLE: &str = "Resolve scene sources";
    pub const CAMERA: &str = "Camera";
    pub const CAMERA_OFF: &str = "Off";
    pub const CHOOSE_CAMERA: &str = "Choose a camera";
    pub const SCREEN: &str = "Screen / window";
    pub const SCREEN_NONE: &str = "None";
    pub const CHOOSE_SCREEN: &str = "Choose a screen or window";
    pub const WITHOUT_BACKGROUND: &str = "Apply without background";
    pub const BACKGROUND_OMITTED: &str = "Background omitted";
    pub const CANCEL: &str = "Cancel";
    pub const APPLY: &str = "Apply scene";
    /// P485: a failed apply with no words of its own (ASCII apostrophe).
    pub const FAILED: &str =
        "The scene couldn't be put on stream. Check its sources and background.";

    pub fn description(name: &str) -> String {
        format!("Choose sources that are connected now. “{name}” keeps them.")
    }
}

/// The dialog while it is open: the scene and the sources picked so far.
pub(super) struct Resolving {
    scene: SavedScene,
    /// `visual.sources` as picked.
    sources: Value,
    without_background: bool,
    error: Option<&'static str>,
    busy: bool,
}

impl SceneDialogs {
    pub(super) fn show_resolve(
        &mut self,
        scene: SavedScene,
        error: Option<&'static str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let sources = scene.visual["sources"].clone();
        self.resolving = Some(Resolving {
            scene,
            sources,
            without_background: false,
            error,
            busy: false,
        });
        self.resolve.open(window, cx);
        cx.notify();
    }

    /// The scene's visual with the picked sources (and without its
    /// background when asked).
    fn repaired_visual(resolving: &Resolving) -> Value {
        let mut visual = resolving.scene.visual.clone();
        visual["sources"] = resolving.sources.clone();
        if resolving.without_background {
            visual["background"] = Value::Null;
        }
        visual
    }

    fn pick_camera(&mut self, value: &str, cx: &mut Context<Self>) {
        let name = self.device_name(value);
        if let Some(resolving) = &mut self.resolving
            && let Some(sources) = resolving.sources.as_object_mut()
        {
            if value.is_empty() {
                sources.remove("cameraId");
                sources.remove("cameraName");
            } else {
                sources.insert("cameraId".into(), Value::from(value));
                sources.insert("cameraName".into(), Value::from(name.unwrap_or_default()));
            }
            resolving.error = None;
            cx.notify();
        }
    }

    /// A screen clears the window and the test pattern, and the other way
    /// round.
    fn pick_screen(&mut self, value: &str, cx: &mut Context<Self>) {
        let device = self
            .studio
            .watch()
            .borrow()
            .sources
            .devices
            .devices
            .iter()
            .find(|device| device.id == value)
            .cloned();
        if let Some(resolving) = &mut self.resolving
            && let Some(sources) = resolving.sources.as_object_mut()
        {
            for key in [
                "screenId",
                "screenName",
                "screenUuid",
                "windowId",
                "windowName",
            ] {
                sources.remove(key);
            }
            sources.insert("testPattern".into(), Value::Bool(false));
            if let Some(device) = device {
                if device.kind == DeviceKind::Window {
                    sources.insert("windowId".into(), Value::from(device.id.clone()));
                    sources.insert("windowName".into(), Value::from(device.name.clone()));
                } else {
                    sources.insert("screenId".into(), Value::from(device.id.clone()));
                    sources.insert("screenName".into(), Value::from(device.name.clone()));
                    if let Some(uuid) = &device.display_uuid {
                        sources.insert("screenUuid".into(), Value::from(uuid.clone()));
                    }
                }
            }
            resolving.error = None;
            cx.notify();
        }
    }

    fn device_name(&self, id: &str) -> Option<String> {
        self.studio
            .watch()
            .borrow()
            .sources
            .devices
            .devices
            .iter()
            .find(|device| device.id == id)
            .map(|device| device.name.clone())
    }

    /// Apply scene: the scene goes on with the repaired sources; once it is
    /// on, the list keeps them.
    fn apply_resolved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(resolving) = &mut self.resolving else {
            return;
        };
        if resolving.busy {
            return;
        }
        resolving.busy = true;
        let visual = Self::repaired_visual(resolving);
        let scene = resolving.scene.clone();
        let studio = self.studio.clone();
        let (done, answer) = oneshot::channel();
        self.run(async move {
            let result = studio
                .apply_saved_scene(&scene.id, Some(visual.clone()), ApplyOptions::default())
                .await;
            if result.ok {
                let kept = SavedScene {
                    updated_at: now_iso(),
                    visual: normalize_scene_visual(&visual).unwrap_or(visual),
                    ..scene
                };
                studio.replace_listed_scene(&kept).await;
            }
            let failed = !result.ok && result.message.is_none() && !result.superseded;
            let _ = done.send((result.ok, failed));
        });
        cx.spawn_in(window, async move |this, cx| {
            let (ok, failed) = answer.await.unwrap_or((false, true));
            let _ = this.update_in(cx, |page, window, cx| {
                if ok {
                    page.succeeded = true;
                    page.resolving = None;
                    page.resolve.close(window, cx);
                } else if let Some(resolving) = &mut page.resolving {
                    resolving.busy = false;
                    if failed {
                        resolving.error = Some(copy::FAILED);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn resolve_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(resolving) = &self.resolving else {
            return div().into_any_element();
        };
        let t = theme::resolve(None, window, cx);
        let muted = hsla(t.muted_foreground);
        let snapshot = self.studio.watch().borrow().clone();
        let devices = &snapshot.sources.devices.devices;
        let visual = Self::repaired_visual(resolving);
        let problems = !scene_source_problems(&visual, devices).is_empty();
        let sources = &resolving.sources;
        let text_of = |key: &str| {
            sources
                .get(key)
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(|id| SharedString::from(id.to_string()))
        };

        let camera_page = cx.entity().downgrade();
        let mut camera = Select::new("resolve-camera")
            .accessibility_label(copy::CAMERA)
            .placeholder(copy::CHOOSE_CAMERA)
            .width(280.)
            .value(Some(text_of("cameraId").unwrap_or_default()))
            .option("", copy::CAMERA_OFF)
            .on_change(move |value, _, cx| {
                let _ = camera_page.update(cx, |page, cx| page.pick_camera(value.as_ref(), cx));
            });
        for device in devices
            .iter()
            .filter(|device| device.kind == DeviceKind::Camera)
        {
            camera = camera.option(device.id.clone(), device.name.clone());
        }

        let screen_page = cx.entity().downgrade();
        let mut screen = Select::new("resolve-screen")
            .accessibility_label(copy::SCREEN)
            .placeholder(copy::CHOOSE_SCREEN)
            .width(280.)
            .value(Some(
                text_of("windowId")
                    .or_else(|| text_of("screenId"))
                    .unwrap_or_default(),
            ))
            .option("", copy::SCREEN_NONE)
            .on_change(move |value, _, cx| {
                let _ = screen_page.update(cx, |page, cx| page.pick_screen(value.as_ref(), cx));
            });
        for device in devices
            .iter()
            .filter(|device| matches!(device.kind, DeviceKind::Screen | DeviceKind::Window))
        {
            screen = screen.option(device.id.clone(), device.name.clone());
        }

        let field = |label: &'static str, control: AnyElement| {
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(div().type_scale(text::LABEL).child(label))
                .child(control)
        };
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(field(copy::CAMERA, camera.into_any_element()))
            .child(field(copy::SCREEN, screen.into_any_element()));
        if !resolving.scene.visual["background"].is_null() {
            let omitted = resolving.without_background;
            body = body.child(
                Button::new("resolve-without-background")
                    .label(if omitted {
                        copy::BACKGROUND_OMITTED
                    } else {
                        copy::WITHOUT_BACKGROUND
                    })
                    .variant(ButtonVariant::Outline)
                    .lit(omitted)
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(resolving) = &mut this.resolving {
                            resolving.without_background = !resolving.without_background;
                        }
                        cx.notify();
                    })),
            );
        }
        if let Some(error) = resolving.error {
            body = body.child(
                div()
                    .id("resolve-error")
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(error),
            );
        }

        let page = cx.entity().downgrade();
        Dialog::new("resolve-scene-dialog", &self.resolve, copy::TITLE)
            .size(DialogSize::Md)
            .description(copy::description(&resolving.scene.name))
            .on_open_change(move |open, _, _, cx| {
                if !open {
                    let _ = page.update(cx, |page, cx| {
                        page.resolving = None;
                        cx.notify();
                    });
                }
            })
            .child(body)
            .footer(
                Button::new("resolve-cancel")
                    .label(copy::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.resolving = None;
                        this.resolve.close(window, cx);
                    })),
            )
            .footer(
                Button::new("resolve-apply")
                    .label(copy::APPLY)
                    .disabled(resolving.busy || problems)
                    .on_click(cx.listener(|this, _, window, cx| this.apply_resolved(window, cx))),
            )
            .into_any_element()
    }
}
