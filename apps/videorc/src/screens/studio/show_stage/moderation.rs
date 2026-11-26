//! One moderation kit for a guest (`guest-moderation.tsx`, plan 224 D5,
//! D14), as the Show stage's lists use it: the host's mute hold and screen
//! share per guest (the row's own controls, plan 252) and the ⋯ menu's
//! Rename…, Remove and Ban. Remove and Ban ask first; a Ban rotates the link
//! and the toast says so once. A failure is already the controller's toast.

use std::sync::Arc;

use gpui::{AnyElement, Context, Entity, Window, prelude::*};
use videorc_app_core::guests::view::{
    GUEST_NAME_MAX_CHARS, NEW_LINK_AFTER_BAN, RoomPerson, ScreenShareAction, ban_guest_copy,
    guest_screen_share, remove_guest_copy, renamed_guest_name, unmute_hint,
};
use videorc_app_core::notices::{NoticeCommand, ToastRequest};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::input::{Input, InputState};
use videorc_kit::kebab_menu::KebabMenuItem;

use super::super::transport::AppStudio;

const RENAME_TITLE: &str = "Rename guest";
const RENAME_NAME: &str = "Name";
const RENAME_DESCRIPTION: &str = "Viewers see it under their tile, and so does the guest.";
const SAVE: &str = "Save";
const CANCEL: &str = "Cancel";
const REMOVING: &str = "Removing…";
const BANNING: &str = "Banning…";
const UNMUTE_TOAST_ID: &str = "videorc-guests-unmute";
const NEW_LINK_TOAST_ID: &str = "videorc-guests-new-link";

enum Pending {
    Rename {
        guest_id: String,
        name: String,
        input: Entity<InputState>,
    },
    Remove {
        guest_id: String,
        name: String,
    },
    Ban {
        guest_id: String,
        name: String,
    },
}

pub struct GuestModeration {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    pending: Option<Pending>,
    busy: bool,
    rename: DialogHandle,
    confirm: DialogHandle,
}

impl GuestModeration {
    pub fn new(studio: Arc<AppStudio>, runtime: tokio::runtime::Handle) -> Self {
        Self {
            studio,
            runtime,
            pending: None,
            busy: false,
            rename: DialogHandle::new(false),
            confirm: DialogHandle::new(false),
        }
    }

    fn act(
        &mut self,
        guest_id: String,
        action: &'static str,
        name: Option<String>,
        after: Option<(&'static str, String)>,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        self.busy = true;
        cx.notify();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let toast_studio = studio.clone();
            let ok = runtime
                .spawn(async move { studio.act_talk_guest(&guest_id, action, name).await })
                .await
                .unwrap_or(false);
            if ok && let Some((id, title)) = after {
                toast_studio.post_notices(vec![NoticeCommand::Show(
                    ToastRequest::info(title).id(id).finish(),
                )]);
            }
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// Mute holds the guest's mic at the server; Unmute lets them unmute,
    /// and says so (D14).
    pub fn toggle_mute(&mut self, person: &RoomPerson, cx: &mut Context<Self>) {
        let Some(guest_id) = person.guest_id.clone() else {
            return;
        };
        let action = if person.muted { "unmute" } else { "mute" };
        let after = (action == "unmute").then(|| (UNMUTE_TOAST_ID, unmute_hint(&person.name)));
        self.act(guest_id, action, None, after, cx);
    }

    /// Lets a guest share their screen, or takes that back (and stops a share).
    pub fn toggle_screen_share(&mut self, person: &RoomPerson, cx: &mut Context<Self>) {
        let Some(guest_id) = person.guest_id.clone() else {
            return;
        };
        let action = match guest_screen_share(person).action {
            ScreenShareAction::Allow => "allow-screen-share",
            ScreenShareAction::Disallow => "disallow-screen-share",
        };
        self.act(guest_id, action, None, None, cx);
    }

    /// The guest's ⋯ items; the host gets none here.
    pub fn items(entity: &Entity<Self>, person: &RoomPerson) -> Vec<KebabMenuItem> {
        if person.host || person.guest_id.is_none() {
            return Vec::new();
        }
        let rename = {
            let entity = entity.clone();
            let person = person.clone();
            KebabMenuItem::new("rename", "Rename…", move |window, cx| {
                entity.update(cx, |this, cx| this.open_rename(&person, window, cx))
            })
            .group("guest")
        };
        let remove = {
            let entity = entity.clone();
            let person = person.clone();
            KebabMenuItem::new("remove", "Remove…", move |window, cx| {
                entity.update(cx, |this, cx| this.open_confirm(&person, false, window, cx))
            })
            .destructive(true)
        };
        let ban = {
            let entity = entity.clone();
            let person = person.clone();
            KebabMenuItem::new("ban", "Ban…", move |window, cx| {
                entity.update(cx, |this, cx| this.open_confirm(&person, true, window, cx))
            })
            .destructive(true)
        };
        vec![rename, remove, ban]
    }

    fn open_rename(&mut self, person: &RoomPerson, window: &mut Window, cx: &mut Context<Self>) {
        let Some(guest_id) = person.guest_id.clone() else {
            return;
        };
        let name = person.name.clone();
        let input = cx.new(|cx| {
            let mut input = InputState::new(window, cx)
                .validate(|value, _| value.encode_utf16().count() <= GUEST_NAME_MAX_CHARS);
            input.set_value(name.clone(), window, cx);
            input
        });
        cx.observe(&input, |_, _, cx| cx.notify()).detach();
        self.pending = Some(Pending::Rename {
            guest_id,
            name,
            input,
        });
        self.rename.open(window, cx);
        cx.notify();
    }

    fn open_confirm(
        &mut self,
        person: &RoomPerson,
        ban: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(guest_id) = person.guest_id.clone() else {
            return;
        };
        let name = person.name.clone();
        self.pending = Some(if ban {
            Pending::Ban { guest_id, name }
        } else {
            Pending::Remove { guest_id, name }
        });
        self.confirm.open(window, cx);
        cx.notify();
    }

    fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.rename.close(window, cx);
        self.confirm.close(window, cx);
        self.pending = None;
        cx.notify();
    }

    fn run(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        match pending {
            Pending::Rename {
                guest_id,
                name,
                input,
            } => {
                let typed = input.read(cx).value().to_string();
                let Some(next) = renamed_guest_name(&name, &typed) else {
                    self.pending = Some(Pending::Rename {
                        guest_id,
                        name,
                        input,
                    });
                    return;
                };
                self.act(guest_id, "rename", Some(next), None, cx);
            }
            Pending::Remove { guest_id, .. } => self.act(guest_id, "remove", None, None, cx),
            Pending::Ban { guest_id, .. } => self.act(
                guest_id,
                "ban",
                None,
                Some((NEW_LINK_TOAST_ID, NEW_LINK_AFTER_BAN.into())),
                cx,
            ),
        }
        self.rename.close(window, cx);
        self.confirm.close(window, cx);
        cx.notify();
    }
}

impl Render for GuestModeration {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = cx.entity();
        let cancel = |id: &'static str| {
            let entity = entity.clone();
            Button::new(id)
                .label(CANCEL)
                .variant(ButtonVariant::Ghost)
                .on_click(move |_, window, cx| entity.update(cx, |this, cx| this.clear(window, cx)))
        };
        let confirm = |id: &'static str, label: String, disabled: bool| {
            let entity = entity.clone();
            Button::new(id)
                .label(label)
                .disabled(disabled)
                .on_click(move |_, window, cx| entity.update(cx, |this, cx| this.run(window, cx)))
        };
        let dialog: Option<AnyElement> = match &self.pending {
            Some(Pending::Rename { name, input, .. }) => {
                let typed = input.read(cx).value().to_string();
                let next = renamed_guest_name(name, &typed);
                Some(
                    Dialog::new("show-stage-guest-rename", &self.rename, RENAME_TITLE)
                        .size(DialogSize::Sm)
                        .description(RENAME_DESCRIPTION)
                        .child(
                            Input::new("show-stage-guest-rename-name", input)
                                .accessibility_label(RENAME_NAME)
                                .disabled(self.busy),
                        )
                        .footer(cancel("show-stage-guest-rename-cancel"))
                        .footer(confirm(
                            "show-stage-guest-rename-save",
                            SAVE.into(),
                            self.busy || next.is_none(),
                        ))
                        .into_any_element(),
                )
            }
            Some(Pending::Remove { name, .. }) => {
                let copy = remove_guest_copy(name);
                Some(
                    Dialog::new("show-stage-guest-remove", &self.confirm, copy.title.clone())
                        .size(DialogSize::Sm)
                        .description(copy.description.clone())
                        .footer(cancel("show-stage-guest-remove-cancel"))
                        .footer(confirm(
                            "show-stage-guest-remove-confirm",
                            if self.busy {
                                REMOVING.into()
                            } else {
                                copy.confirm.clone()
                            },
                            self.busy,
                        ))
                        .into_any_element(),
                )
            }
            Some(Pending::Ban { name, .. }) => {
                let copy = ban_guest_copy(name);
                Some(
                    Dialog::new("show-stage-guest-ban", &self.confirm, copy.title.clone())
                        .size(DialogSize::Sm)
                        .description(copy.description.clone())
                        .footer(cancel("show-stage-guest-ban-cancel"))
                        .footer(confirm(
                            "show-stage-guest-ban-confirm",
                            if self.busy {
                                BANNING.into()
                            } else {
                                copy.confirm.clone()
                            },
                            self.busy,
                        ))
                        .into_any_element(),
                )
            }
            None => None,
        };
        gpui::div().children(dialog)
    }
}
