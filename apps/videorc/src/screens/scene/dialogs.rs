//! The list's dialogs (`scene-dialogs.tsx`; P476, P477): Rename scene and
//! Delete scene?. Nothing here toasts a success; a refused write keeps the
//! dialog open with its line. The picker, Set key, Guests in the room and
//! Resolve scene sources join in their own PR.

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use tokio::sync::oneshot;
use videorc_app_core::scenes::model::scene_name_error;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogSize};
use videorc_kit::input::Input;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::model::copy;
use super::{Deleting, Renaming, ScenePage};

/// `maxLength={80}` on the name field.
pub(super) const NAME_MAX_CHARS: usize = 80;

impl ScenePage {
    pub(super) fn open_rename(
        &mut self,
        id: &str,
        name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.rename_input.update(cx, |input, cx| {
            input.set_value(name.to_string(), window, cx)
        });
        self.renaming = Some(Renaming {
            id: id.to_string(),
            error: None,
            busy: false,
        });
        self.rename.open(window, cx);
        cx.notify();
    }

    /// Enter or Rename: `sceneNameError` first, inline; then the write.
    pub(super) fn submit_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(renaming) = &mut self.renaming else {
            return;
        };
        if renaming.busy {
            return;
        }
        let name = self.rename_input.read(cx).value().to_string();
        let error = {
            let watch = self.studio.watch();
            let snapshot = watch.borrow();
            scene_name_error(&name, &snapshot.scenes.scenes, Some(renaming.id.as_str()))
        };
        if let Some(error) = error {
            renaming.error = Some(error.to_string());
            cx.notify();
            return;
        }
        renaming.busy = true;
        let id = renaming.id.clone();
        let studio = self.studio.clone();
        let (done, answer) = oneshot::channel();
        self.run(async move {
            let _ = done.send(studio.rename_scene(&id, &name).await);
        });
        cx.spawn_in(window, async move |this, cx| {
            let renamed = answer.await.unwrap_or(false);
            let _ = this.update_in(cx, |page, window, cx| {
                if renamed {
                    page.renaming = None;
                    page.rename.close(window, cx);
                } else if let Some(renaming) = &mut page.renaming {
                    renaming.busy = false;
                    renaming.error = Some(copy::RENAME_FAILED.to_string());
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn rename_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(renaming) = &self.renaming else {
            return div().into_any_element();
        };
        let t = theme::resolve(None, window, cx);
        let line_ink = |invalid: bool| {
            hsla(if invalid {
                t.destructive
            } else {
                t.muted_foreground
            })
        };
        let page = cx.entity().downgrade();
        let (line, invalid) = match &renaming.error {
            Some(error) => (error.clone(), true),
            None => (copy::NAME_HELPER.to_string(), false),
        };
        Dialog::new("rename-scene-dialog", &self.rename, copy::RENAME_TITLE)
            .size(DialogSize::Sm)
            .on_open_change(move |open, _, _, cx| {
                if !open {
                    let _ = page.update(cx, |page, cx| {
                        page.renaming = None;
                        cx.notify();
                    });
                }
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(div().type_scale(text::LABEL).child(copy::NAME_LABEL))
                    .child(
                        Input::new("scene-preset-name", &self.rename_input)
                            .accessibility_label(copy::NAME_LABEL)
                            .invalid(invalid)
                            .disabled(renaming.busy),
                    )
                    .child(
                        div()
                            .id("scene-preset-error")
                            .type_scale(text::META)
                            .text_color(line_ink(invalid))
                            .child(line),
                    ),
            )
            .footer(
                Button::new("rename-scene-cancel")
                    .label(copy::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.renaming = None;
                        this.rename.close(window, cx);
                    })),
            )
            .footer(
                Button::new("rename-scene-submit")
                    .label(copy::RENAME_BUTTON)
                    .disabled(renaming.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.submit_rename(window, cx))),
            )
            .into_any_element()
    }

    pub(super) fn open_delete(
        &mut self,
        id: &str,
        name: &str,
        next: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.deleting = Some(Deleting {
            id: id.to_string(),
            name: name.to_string(),
            next,
            busy: false,
        });
        self.delete.open(window, cx);
        cx.notify();
    }

    fn confirm_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(deleting) = &mut self.deleting else {
            return;
        };
        if deleting.busy {
            return;
        }
        deleting.busy = true;
        let id = deleting.id.clone();
        let studio = self.studio.clone();
        let (done, answer) = oneshot::channel();
        self.run(async move {
            let _ = done.send(studio.delete_scene(&id).await);
        });
        cx.spawn_in(window, async move |this, cx| {
            let deleted = answer.await.unwrap_or(false);
            let _ = this.update_in(cx, |page, window, cx| {
                if deleted {
                    page.deleting = None;
                    page.delete.close(window, cx);
                } else if let Some(deleting) = &mut page.deleting {
                    deleting.busy = false;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn delete_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(deleting) = &self.deleting else {
            return div().into_any_element();
        };
        let page = cx.entity().downgrade();
        Dialog::new("scene-delete-dialog", &self.delete, copy::DELETE_TITLE)
            .size(DialogSize::Sm)
            .close_button(false)
            .description(copy::delete_description(
                &deleting.name,
                deleting.next.as_deref(),
            ))
            .on_open_change(move |open, _, _, cx| {
                if !open {
                    let _ = page.update(cx, |page, cx| {
                        page.deleting = None;
                        cx.notify();
                    });
                }
            })
            .footer(
                Button::new("scene-delete-cancel")
                    .label(copy::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.deleting = None;
                        this.delete.close(window, cx);
                    })),
            )
            .footer(
                Button::new("scene-delete-confirm")
                    .label(copy::DELETE_BUTTON)
                    .variant(ButtonVariant::Destructive)
                    .disabled(deleting.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.confirm_delete(window, cx))),
            )
            .into_any_element()
    }
}
