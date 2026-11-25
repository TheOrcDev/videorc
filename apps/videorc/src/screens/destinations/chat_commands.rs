//! Chat commands on Destinations Setup (plan 226, P797–P813).

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use videorc_app_core::livestream::chat_commands::{
    self, ChatCommand, ChatCommandSaveParams, DESCRIPTION_HINT, DESCRIPTION_LABEL,
    DESCRIPTION_PLACEHOLDER, NAME_LABEL, NAME_PLACEHOLDER, REPLY_LABEL, REPLY_PLACEHOLDER,
};
use videorc_app_core::studio::chat_commands_store::ChatCommandsStore;
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::input::{Input, InputState};
use videorc_kit::kebab_menu::{KebabMenu, KebabMenuItem};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

const SECTION_TITLE: &str = "Chat commands";
const HELP: &str = "Viewers type !name in chat. Videorc answers as you, starting with @their name, in the chat they asked in.";
const LIST_LABEL: &str = "Answer !commands";
const LIST_DESCRIPTION: &str = "Lists your commands in chat.";
const ADD_LABEL: &str = "Add command…";
const NO_COMMANDS: &str = "No commands yet.";
const EDIT: &str = "Edit…";
const DELETE: &str = "Delete";

pub(super) struct CommandEditor {
    pub dialog: DialogHandle,
    pub editing: Option<Option<ChatCommand>>,
    pub name: Entity<InputState>,
    pub description: Entity<InputState>,
    pub reply: Entity<InputState>,
    pub enabled: bool,
    pub error: Option<String>,
    pub pending: bool,
}

impl DestinationsPanel {
    pub(super) fn ensure_command_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.command_editor.is_some() {
            return;
        }
        let name = cx.new(|cx| InputState::new(window, cx).placeholder(NAME_PLACEHOLDER));
        let description =
            cx.new(|cx| InputState::new(window, cx).placeholder(DESCRIPTION_PLACEHOLDER));
        let reply = cx.new(|cx| InputState::new(window, cx).placeholder(REPLY_PLACEHOLDER));
        for input in [&name, &description, &reply] {
            cx.subscribe(input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    if let Some(editor) = this.command_editor.as_mut() {
                        editor.error = None;
                    }
                    cx.notify();
                }
            })
            .detach();
        }
        self.command_editor = Some(CommandEditor {
            dialog: DialogHandle::new(false),
            editing: None,
            name,
            description,
            reply,
            enabled: true,
            error: None,
            pending: false,
        });
    }

    pub(super) fn chat_commands_section(
        &self,
        store: &ChatCommandsStore,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let mut section = PanelSection::new("destinations-chat-commands").title(SECTION_TITLE);

        if store.load_failed {
            section = section.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.destructive))
                    .child("Couldn't load chat commands."),
            );
        }

        let Some(state) = store.state.as_ref() else {
            return section
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child("Loading chat commands…"),
                )
                .into_any_element();
        };

        section = section.child(
            SettingsGroup::new().row(
                SettingsRow::new("chat-commands-list", LIST_LABEL)
                    .description(LIST_DESCRIPTION)
                    .child(
                        Switch::new("chat-commands-list-enabled")
                            .accessibility_label(LIST_LABEL)
                            .checked(state.list_enabled)
                            .on_change({
                                let entity = entity.clone();
                                move |value, _, cx| {
                                    entity.update(cx, |this, _| this.set_list_enabled(value));
                                }
                            }),
                    ),
            ),
        );

        if state.commands.is_empty() {
            section = section.child(Empty::new().description(NO_COMMANDS));
        } else {
            let mut list = GroupedList::new();
            for command in &state.commands {
                let id = command.id.clone();
                let name = command.name.clone();
                let enabled = command.enabled;
                let entity = entity.clone();
                let command_clone = command.clone();
                list = list.item(
                    div().child(
                        ListRow::new(
                            format!("chat-cmd-{}", command.id),
                            format!("!{}", command.name),
                        )
                        .context(command.description.clone())
                        .interactive(true)
                        .on_click({
                            let entity = entity.clone();
                            let command = command_clone.clone();
                            move |_, window, cx| {
                                entity.update(cx, |this, cx| {
                                    this.open_command_editor(Some(command.clone()), window, cx)
                                })
                            }
                        })
                        .child(
                            Switch::new(format!("chat-cmd-enabled-{}", command.id))
                                .accessibility_label(format!("Enable !{}", command.name))
                                .checked(enabled)
                                .on_change({
                                    let entity = entity.clone();
                                    let command = command_clone.clone();
                                    move |value, _, cx| {
                                        entity.update(cx, |this, _| {
                                            this.toggle_command_enabled(command.clone(), value)
                                        })
                                    }
                                }),
                        )
                        .child({
                            let edit_entity = entity.clone();
                            let edit_command = command_clone.clone();
                            let delete_entity = entity.clone();
                            let delete_id = id.clone();
                            let delete_name = name.clone();
                            KebabMenu::new(
                                SharedString::from(format!("chat-cmd-menu-{}", command.id)),
                                vec![
                                    KebabMenuItem::new("edit", EDIT, move |window, cx| {
                                        edit_entity.update(cx, |this, cx| {
                                            this.open_command_editor(
                                                Some(edit_command.clone()),
                                                window,
                                                cx,
                                            )
                                        })
                                    }),
                                    KebabMenuItem::new("delete", DELETE, move |_, cx| {
                                        delete_entity.update(cx, |this, _| {
                                            this.delete_command(
                                                delete_id.clone(),
                                                delete_name.clone(),
                                            )
                                        })
                                    })
                                    .destructive(true),
                                ],
                            )
                        }),
                    ),
                );
            }
            section = section.child(list);
        }

        let add_blocked = if state.commands.len() >= chat_commands::MAX_COUNT {
            Some(format!(
                "You can have up to {} commands. Delete one to add another.",
                chat_commands::MAX_COUNT
            ))
        } else {
            None
        };
        section = section
            .child(
                Button::new("chat-commands-add")
                    .label(ADD_LABEL)
                    .variant(ButtonVariant::Outline)
                    .disabled(add_blocked.is_some())
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.open_command_editor(None, window, cx))
                        }
                    }),
            )
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(add_blocked.unwrap_or_else(|| HELP.to_string())),
            );

        section.into_any_element()
    }

    pub(super) fn command_dialog_element(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(editor) = self.command_editor.as_mut() else {
            return div().into_any_element();
        };
        if editor.editing.is_none() {
            if editor.dialog.is_open() {
                editor.dialog.close(window, cx);
            }
            return div().into_any_element();
        }
        if !editor.dialog.is_open() {
            // Escape / backdrop / X closed the kit sheet — same as Cancel.
            // Do not reopen: that left the dialog ignoring Escape.
            editor.editing = None;
            return div().into_any_element();
        }
        let title = chat_commands::dialog_title(editor.editing.as_ref().and_then(|c| c.as_ref()));
        let entity = cx.entity();
        let t = theme::current(window, cx).theme();
        let pending = editor.pending;
        let error = editor.error.clone();

        let mut body = div().flex().flex_col().gap(px(8.)).child(
            SettingsGroup::new()
                .row(
                    SettingsRow::new("cmd-name", NAME_LABEL).child(
                        Input::new("cmd-name-input", &editor.name)
                            .accessibility_label(NAME_LABEL)
                            .disabled(pending),
                    ),
                )
                .row(
                    SettingsRow::new("cmd-description", DESCRIPTION_LABEL)
                        .description(DESCRIPTION_HINT)
                        .child(
                            Input::new("cmd-description-input", &editor.description)
                                .accessibility_label(DESCRIPTION_LABEL)
                                .disabled(pending),
                        ),
                )
                .row(
                    SettingsRow::new("cmd-reply", REPLY_LABEL)
                        .description({
                            let reply = editor.reply.read(cx).value().to_string();
                            chat_commands::room_label(&reply)
                        })
                        .child(
                            Input::new("cmd-reply-input", &editor.reply)
                                .accessibility_label(REPLY_LABEL)
                                .disabled(pending)
                                .invalid(chat_commands::reply_over(
                                    &editor.reply.read(cx).value().to_string(),
                                )),
                        ),
                ),
        );
        if let Some(error) = error {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.destructive))
                    .child(error),
            );
        }

        Dialog::new("chat-command-dialog", &editor.dialog, title)
            .size(DialogSize::Md)
            .on_open_change({
                let entity = entity.clone();
                move |open, _, window, cx| {
                    if !open {
                        // Escape / backdrop / X — same as Cancel.
                        entity.update(cx, |this, cx| this.close_command_editor(window, cx));
                    }
                }
            })
            .child(body)
            .footer(
                Button::new("cmd-cancel")
                    .label(chat_commands::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .disabled(pending)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.close_command_editor(window, cx))
                        }
                    }),
            )
            .footer(
                Button::new("cmd-save")
                    .label(if pending {
                        chat_commands::SAVING
                    } else {
                        chat_commands::SAVE
                    })
                    .variant(ButtonVariant::Default)
                    .disabled(pending)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.save_command(window, cx))
                        }
                    }),
            )
            .into_any_element()
    }

    fn open_command_editor(
        &mut self,
        command: Option<ChatCommand>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ensure_command_editor(window, cx);
        let Some(editor) = self.command_editor.as_mut() else {
            return;
        };
        let enabled = command.as_ref().map(|c| c.enabled).unwrap_or(true);
        let name = command.as_ref().map(|c| c.name.clone()).unwrap_or_default();
        let description = command
            .as_ref()
            .map(|c| c.description.clone())
            .unwrap_or_default();
        let reply = command
            .as_ref()
            .map(|c| c.reply.clone())
            .unwrap_or_default();
        editor.name.update(cx, |input, cx| {
            input.set_value(name, window, cx);
        });
        editor.description.update(cx, |input, cx| {
            input.set_value(description, window, cx);
        });
        editor.reply.update(cx, |input, cx| {
            input.set_value(reply, window, cx);
        });
        editor.enabled = enabled;
        editor.error = None;
        editor.pending = false;
        editor.editing = Some(command);
        editor.dialog.open(window, cx);
        cx.notify();
    }

    fn close_command_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.command_editor.as_mut() else {
            return;
        };
        editor.editing = None;
        if editor.dialog.is_open() {
            editor.dialog.close(window, cx);
        }
        cx.notify();
    }

    fn save_command(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.command_editor.as_mut() else {
            return;
        };
        if editor.pending {
            return;
        }
        let existing = editor.editing.clone().flatten();
        let name = editor.name.read(cx).value().to_string();
        let description = editor.description.read(cx).value().to_string();
        let reply = editor.reply.read(cx).value().to_string();
        let enabled = editor.enabled;
        let mut params = chat_commands::save_params(existing.as_ref(), &name, &description, &reply);
        params.enabled = enabled;
        let store = self.studio.chat_commands_now();
        let existing_list = store
            .state
            .as_ref()
            .map(|s| s.commands.as_slice())
            .unwrap_or(&[]);
        let draft = chat_commands::Draft {
            id: params.id.clone(),
            name: params.name.clone(),
            description: params.description.clone(),
            reply: params.reply.clone(),
        };
        if let Some(errors) = chat_commands::validate_draft(&draft, existing_list) {
            editor.error = errors.name.or(errors.description).or(errors.reply);
            cx.notify();
            return;
        }
        editor.pending = true;
        cx.notify();
        let studio = self.studio.clone();
        let job = self
            .runtime
            .spawn(async move { studio.save_chat_command(&params).await });
        cx.spawn(async move |this, cx| {
            let refused = job.await.unwrap_or(None);
            let _ = this.update(cx, |this, cx| {
                if let Some(editor) = this.command_editor.as_mut() {
                    editor.pending = false;
                    if let Some(refusal) = refused {
                        editor.error = Some(refusal.message);
                    } else {
                        editor.editing = None;
                    }
                }
                cx.notify();
            });
        })
        .detach();
        let _ = window;
    }

    fn set_list_enabled(&self, enabled: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio.set_chat_commands_list_enabled(enabled).await;
        });
    }

    fn toggle_command_enabled(&self, command: ChatCommand, enabled: bool) {
        let studio = self.studio.clone();
        let params = ChatCommandSaveParams {
            id: Some(command.id),
            name: command.name,
            description: command.description,
            reply: command.reply,
            enabled,
        };
        self.runtime.spawn(async move {
            let _ = studio.save_chat_command(&params).await;
        });
    }

    fn delete_command(&self, id: String, name: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let _ = studio.delete_chat_command(&id, &name).await;
        });
    }
}
