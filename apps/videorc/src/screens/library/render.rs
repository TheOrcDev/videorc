use super::*;
use gpui::{SharedString, div, px};
use videorc_app_core::library::copy;
use videorc_kit::{
    Checkbox, CheckboxChecked,
    alert::Alert,
    badge::Badge,
    button::{Button, ButtonVariant},
    dialog::{Dialog, DialogSize},
    empty::Empty,
    input::Input,
    kebab_context_menu::KebabContextMenu,
    kebab_menu::{KebabMenu, KebabMenuItem},
    list_row::{GroupedList, ListRow},
    scroll_area::ScrollArea,
    select::Select,
    theme::{self, TypeScale, hsla},
    tokens::{size, text},
};
impl LibraryScreen {
    fn change<E: 'static>(
        cx: &Context<Self>,
        f: impl Fn(&mut Self, &E, &mut Window, &mut Context<Self>) + 'static,
    ) -> impl Fn(E, &mut Window, &mut gpui::App) + 'static {
        let weak = cx.entity().downgrade();
        move |value, window, cx| {
            let _ = weak.update(cx, |this, cx| f(this, &value, window, cx));
        }
    }

    fn select_all(&mut self, checked: bool, cx: &mut Context<Self>) {
        self.ui.selection.selected = if checked {
            self.view()
                .rows
                .into_iter()
                .filter(|r| r.selectable)
                .map(|r| r.id)
                .collect()
        } else {
            Vec::new()
        };
        cx.notify();
    }
    fn keys(&mut self, event: &gpui::KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // Inputs, menus, the checkbox and the dialog own their own keys.
        if !self.focus.is_focused(window) {
            return;
        }
        let key = match event.keystroke.key.as_str() {
            "up" => "ArrowUp",
            "down" => "ArrowDown",
            "home" => "Home",
            "end" => "End",
            "space" => " ",
            "enter" => "Enter",
            "escape" => "Escape",
            "backspace" => "Backspace",
            "delete" => "Delete",
            other => other,
        };
        let m = event.keystroke.modifiers;
        let Some(command) = v::key_command(
            key,
            m.shift,
            if cfg!(target_os = "macos") {
                m.platform
            } else {
                m.control
            },
            m.alt,
        ) else {
            return;
        };
        let rows = self.view().rows;
        let ordered = rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
        let active = self.ui.active.clone().or_else(|| ordered.first().cloned());
        match command {
            v::KeyCommand::Move { step, extend } => {
                if let Some(id) = v::row_after_move(&ordered, active.as_deref(), step) {
                    self.ui.active = Some(id.clone());
                    if extend {
                        self.pick(&id, v::PickModifier::Range, cx);
                    }
                }
            }
            v::KeyCommand::Toggle => {
                if let Some(id) = active {
                    self.pick(&id, v::PickModifier::Toggle, cx);
                }
            }
            v::KeyCommand::SelectAll => self.select_all(true, cx),
            v::KeyCommand::Clear => self.ui.selection.selected.clear(),
            v::KeyCommand::Rename => {
                if let Some(id) = active {
                    self.action(id, MenuId::Rename, window, cx);
                }
            }
            v::KeyCommand::Delete => {
                self.ask_delete(self.ui.selection.selected.clone(), window, cx)
            }
        }
        cx.stop_propagation();
        cx.notify();
    }
    fn menu(&self, row: &p::RowView, cx: &mut Context<Self>) -> Vec<KebabMenuItem> {
        let mut group = 0;
        row.menu
            .iter()
            .map(|item| {
                if item.separated {
                    group += 1;
                }
                let implemented = matches!(
                    item.id,
                    MenuId::Play
                        | MenuId::Markers
                        | MenuId::Reveal
                        | MenuId::ExportMp4
                        | MenuId::Rename
                        | MenuId::Duplicate
                        | MenuId::Check
                        | MenuId::Repair
                        | MenuId::Restore
                        | MenuId::Delete
                );
                let weak = cx.entity().downgrade();
                let id = row.id.clone();
                let action = item.id;
                KebabMenuItem::new(item.id.as_str(), item.label.clone(), move |window, cx| {
                    let _ = weak.update(cx, |this, cx| this.action(id.clone(), action, window, cx));
                })
                .disabled(
                    item.disabled
                        || !implemented
                        || row.menu_disabled
                        || self.busy.contains(&row.id),
                )
                .disabled_reason(item.reason.clone().unwrap_or_else(|| {
                    if !implemented {
                        "This action isn't available in this window yet.".into()
                    } else if row.menu_disabled {
                        "Videorc is reconnecting…".into()
                    } else {
                        "This recording isn't ready for that action.".into()
                    }
                }))
                .destructive(item.destructive)
                .group(group.to_string())
            })
            .collect()
    }
    fn posters(&mut self, rows: &[p::RowView], cx: &mut Context<Self>) {
        // A bounded set, keyed by both id and backend duration/version. Never
        // put the authenticated poster URL in the scene or diagnostics.
        let needed = rows
            .iter()
            .take(150)
            .filter_map(|row| match row.poster {
                p::PosterView::Picture { version } => Some((row.id.clone(), version)),
                _ => None,
            })
            .filter(|key| !self.posters.contains_key(key))
            .collect::<Vec<_>>();
        if needed.is_empty() {
            return;
        }
        if self.posters.len() > 200 {
            self.posters.clear();
        }
        for key in &needed {
            self.posters.insert(key.clone(), None);
        }
        let core = self.core.clone();
        self.task(
            async move {
                let mut images = Vec::new();
                for (id, version) in needed {
                    let bytes = match core.poster(&id, version).await {
                        Some(bytes) => Some(bytes),
                        None => {
                            if core.ensure_poster(&id).await {
                                core.poster(&id, version).await
                            } else {
                                None
                            }
                        }
                    };
                    images.push(((id, version), bytes));
                }
                Ok(images)
            },
            |this, result, _| {
                if let Ok(images) = result {
                    for (key, bytes) in images {
                        this.posters.insert(
                            key,
                            bytes.map(|bytes| {
                                Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes))
                            }),
                        );
                    }
                }
            },
            cx,
        );
    }
}
impl Render for LibraryScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        if self.cloud_shown {
            let tabs = self.tabs(cx);
            let cloud = self.cloud_body(cx);
            return div()
                .size_full()
                .flex()
                .flex_col()
                .p(px(size::GUTTER))
                .gap(px(12.))
                .child(copy::TITLE)
                .child(tabs)
                .child(cloud)
                .child(self.markers_dialog_view(cx));
        }
        let view = self.view();
        self.posters(&view.rows, cx);
        let mut filter = Select::new("library-filter")
            .accessibility_label(copy::FILTER_LABEL)
            .value(Some(view.filter_index.to_string().into()));
        for value in v::LibraryFilter::ALL {
            filter = filter.option(value.index().to_string(), value.label());
        }
        let mut sort = Select::new("library-sort")
            .accessibility_label(copy::SORT_LABEL)
            .value(Some(view.sort_index.to_string().into()));
        for value in v::LibrarySort::ALL {
            sort = sort.option(value.index().to_string(), value.label());
        }
        let toolbar = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                filter.on_change(Self::change(cx, |this, value: &SharedString, _, cx| {
                    this.ui.change_view(
                        &this.core.data().sessions,
                        value.parse().ok().and_then(v::LibraryFilter::from_index),
                        None,
                    );
                    cx.notify();
                })),
            )
            .child(
                sort.on_change(Self::change(cx, |this, value: &SharedString, _, cx| {
                    if let Some(sort) = value.parse().ok().and_then(v::LibrarySort::from_index) {
                        this.ui.sort = sort;
                        cx.notify();
                    }
                })),
            )
            .child(div().flex_1().child(
                Input::new("library-search", &self.search).accessibility_label(copy::SEARCH_LABEL),
            ))
            .child(
                Button::new("library-import")
                    .label(if view.importing {
                        copy::IMPORTING
                    } else {
                        copy::IMPORT
                    })
                    .disabled(view.importing || !self.core.data().online)
                    .tooltip(if view.importing {
                        copy::IMPORTING
                    } else {
                        "Import a recording"
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.import(cx))),
            );
        let mut list = GroupedList::new();
        for row in &view.rows {
            let id = row.id.clone();
            let menu = self.menu(row, cx);
            let reason = if !row.selectable {
                view.bulk_hold.unwrap_or("This recording is in use.")
            } else {
                ""
            };
            let selection = Checkbox::new(SharedString::from(format!("pick-{id}")))
                .checked(row.selected)
                .disabled(!row.selectable)
                .disabled_reason(reason)
                .accessibility_label(format!("Select {}", row.title))
                .on_change(Self::change(cx, {
                    let id = id.clone();
                    move |this, _, _, cx| this.pick(&id, v::PickModifier::Toggle, cx)
                }));
            let file = match &row.file {
                p::FileCell::None => String::new(),
                p::FileCell::Live { label, .. }
                | p::FileCell::Finalizing(label)
                | p::FileCell::Format(label)
                | p::FileCell::Problem { label, .. }
                | p::FileCell::Note { label, .. } => label.clone(),
            };
            let mut line = ListRow::new(
                SharedString::from(format!("session-{id}")),
                row.title.clone(),
            )
            .leading(selection)
            .context(row.meta.clone())
            .selected(row.selected || row.active)
            .meta(format!("{} · {} · {}", row.duration, row.size, file));
            if let Some(scene) = &row.scene {
                line = line.child(Badge::new(scene.text.clone()));
            }
            if let Some(quality) = &row.quality {
                line = line.child(Badge::new(quality.label.clone()));
            }
            if let p::PosterView::Picture { version } = row.poster {
                if let Some(Some(image)) = self.posters.get(&(id.clone(), version)) {
                    line = line.icon(
                        gpui::img(image.clone())
                            .w(px(32.))
                            .h(px(18.))
                            .object_fit(gpui::ObjectFit::Contain),
                    );
                }
            }
            let play_id = id.clone();
            line = line
                .child(
                    Button::new(SharedString::from(format!("play-{id}")))
                        .label(copy::MENU_PLAY)
                        .variant(ButtonVariant::Ghost)
                        .disabled(row.play_reason.is_some() || row.menu_disabled)
                        .tooltip(row.play_reason.unwrap_or(copy::PLAY_IN_DEFAULT_PLAYER))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.external_recording(play_id.clone(), cx)
                        })),
                )
                .child(
                    KebabMenu::new(SharedString::from(format!("actions-{id}")), menu.clone())
                        .label(copy::SESSION_ACTIONS)
                        .busy(row.menu_busy || self.busy.contains(&id)),
                )
                .on_click(
                    cx.listener(move |this, event: &gpui::ClickEvent, window, cx| {
                        let m = event.modifiers();
                        this.pick(
                            &id,
                            v::pick_modifier(
                                m.shift,
                                if cfg!(target_os = "macos") {
                                    m.platform
                                } else {
                                    m.control
                                },
                            ),
                            cx,
                        );
                        this.focus.focus(window, cx);
                        if matches!(event,gpui::ClickEvent::Mouse(event) if event.up.click_count==2)
                        {
                            this.external_recording(id.clone(), cx);
                        }
                    }),
                );
            // ContextMenu composes the shared ListRow without a second action list.
            list = list.item(KebabContextMenu::new(
                SharedString::from(format!("context-{}", row.id)),
                menu,
                line,
            ));
        }
        let mut body = div().flex().flex_col().gap(px(8.)).child(toolbar);
        if view.offline_alert || view.list_state == v::ListState::Offline {
            body = body.child(Alert::new("library-offline").title("Videorc is reconnecting…"));
        }
        if let Some(message) = &self.message {
            body = body.child(Alert::new("library-message").title(message.clone()));
        }
        if let Some(partial) = &view.partial_notice {
            body = body.child(
                Alert::new("library-partial").title(partial.clone()).action(
                    Button::new("library-load-all")
                        .label(view.load_all_label)
                        .disabled(!view.load_all_enabled)
                        .on_click(cx.listener(|this, _, _, cx| this.load(true, cx))),
                ),
            );
        }
        if view.list_state == v::ListState::Loading {
            body = body.child(
                videorc_kit::spinner::Spinner::new("library-loading")
                    .accessibility_label(copy::LOADING_RECORDINGS),
            );
        }
        if view.list_state == v::ListState::Empty {
            body = body.child(
                Empty::new()
                    .title(copy::EMPTY_TITLE)
                    .description(copy::EMPTY_DESCRIPTION)
                    .child(
                        Button::new("library-studio")
                            .label(copy::OPEN_STUDIO)
                            .on_click(cx.listener(|_, _, _, cx| {
                                cx.emit(Navigate(videorc_app_core::nav::PageId::Studio))
                            })),
                    ),
            );
        }
        if let Some(clear) = view.no_match {
            body = body.child(
                Empty::new().title(copy::NO_MATCH_TITLE).child(
                    Button::new("library-clear-query")
                        .label(clear)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.ui.change_view(
                                &this.core.data().sessions,
                                Some(v::LibraryFilter::All),
                                Some(String::new()),
                            );
                            this.search
                                .update(cx, |input, cx| input.set_value("", window, cx));
                            cx.notify();
                        })),
                ),
            );
        }
        let all = match view.select_all {
            v::SelectAllState::All => CheckboxChecked::Checked,
            v::SelectAllState::Some => CheckboxChecked::Mixed,
            v::SelectAllState::None => CheckboxChecked::Unchecked,
        };
        if !view.rows.is_empty() {
            body = body
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            Checkbox::new("library-select-all")
                                .state(all)
                                .disabled(!view.select_all_enabled)
                                .disabled_reason(
                                    view.bulk_hold.unwrap_or("No recordings can be selected."),
                                )
                                .accessibility_label(copy::SELECT_ALL_LABEL)
                                .on_change(Self::change(
                                    cx,
                                    |this, next: &CheckboxChecked, _, cx| {
                                        this.select_all(*next == CheckboxChecked::Checked, cx)
                                    },
                                )),
                        )
                        .child(copy::COLUMN_NAME)
                        .child(
                            Button::new("library-delete-selected")
                                .label(copy::DELETE)
                                .disabled(view.selected_count == 0 || view.bulk_hold.is_some())
                                .tooltip(view.bulk_hold.unwrap_or("Select recordings to delete"))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.ask_delete(this.ui.selection.selected.clone(), window, cx)
                                })),
                        )
                        .child(
                            Button::new("library-clear-selected")
                                .label(copy::CLEAR_SELECTION)
                                .disabled(view.selected_count == 0)
                                .on_click(cx.listener(|this, _, _, cx| this.select_all(false, cx))),
                        ),
                )
                .child(list);
        }
        if let Some(footer) = view.footer {
            body = body.child(footer);
        }
        if let Some(label) = view.load_more {
            body = body.child(
                Button::new("library-load-more")
                    .label(label)
                    .disabled(!view.load_more_enabled)
                    .on_click(cx.listener(|this, _, _, cx| this.load(false, cx))),
            );
        }
        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::keys))
            .p(px(size::GUTTER))
            .gap(px(12.))
            .type_scale(text::LABEL)
            .text_color(hsla(t.foreground))
            .child(div().type_scale(text::SECTION).child(copy::TITLE))
            .child(
                div()
                    .text_color(hsla(t.muted_foreground))
                    .child(copy::DESCRIPTION),
            )
            .child(self.tabs(cx))
            .child(ScrollArea::new("library-scroll").child(body));
        if let Some(rename) = view.rename {
            root = root.child(
                Dialog::new("library-rename", &self.rename_dialog, copy::RENAME_TITLE)
                    .description(copy::RENAME_DESCRIPTION)
                    .size(DialogSize::Sm)
                    .child(
                        Input::new("library-name", &self.rename_input)
                            .accessibility_label(copy::RECORDING_NAME_LABEL),
                    )
                    .footer(
                        Button::new("library-rename-cancel")
                            .label(copy::CANCEL)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.rename_dialog.close(window, cx)
                            })),
                    )
                    .footer(
                        Button::new("library-rename-save")
                            .label(copy::RENAME)
                            .disabled(!rename.can_submit)
                            .on_click(cx.listener(|this, _, window, cx| this.rename(window, cx))),
                    ),
            );
        }
        if let Some(delete) = view.delete {
            root = root.child(
                Dialog::new("library-delete", &self.delete_dialog, delete.title)
                    .description(delete.description)
                    .size(DialogSize::Sm)
                    .close_button(false)
                    .child(div().children(delete.names.into_iter().map(|name| div().child(name))))
                    .footer(
                        Button::new("library-delete-cancel")
                            .label(copy::CANCEL)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.delete_dialog.close(window, cx)
                            })),
                    )
                    .footer(
                        Button::new("library-delete-confirm")
                            .label(delete.confirm_label)
                            .disabled(delete.confirm_disabled)
                            .variant(ButtonVariant::Destructive)
                            .on_click(cx.listener(|this, _, window, cx| this.delete(window, cx))),
                    ),
            );
        }
        root.child(self.player.clone())
    }
}
