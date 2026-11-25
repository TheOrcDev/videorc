use super::*;
use gpui::{FontWeight, SharedString, div, prelude::*, px};
use videorc_app_core::library::{
    copy,
    noise::{NoiseCleanupAction, latest_job_for_session},
};
use videorc_kit::{
    Checkbox, CheckboxChecked,
    alert::{Alert, AlertVariant},
    badge::{Badge, BadgeVariant},
    button::{Button, ButtonSize, ButtonVariant},
    dialog::{Dialog, DialogSize},
    empty::Empty,
    icon::{IconName, icon},
    input::Input,
    input_group::{InputGroup, InputGroupAddon},
    kebab_context_menu::KebabContextMenu,
    kebab_menu::{KebabMenu, KebabMenuItem},
    scroll_area::ScrollArea,
    select::Select,
    spinner::Spinner,
    status_dot::{StatusDot, StatusTone},
    theme::{self, TypeScale, hsla, with_alpha},
    tokens::{Theme, size, text},
    tooltip::tooltip,
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
        // The first 150 rows' posters, keyed by both id and backend
        // duration/version, from the app-wide cache (`app::posters`). Never
        // put the authenticated poster URL in the scene or diagnostics.
        let keys = rows
            .iter()
            .take(150)
            .filter_map(|row| match row.poster {
                p::PosterView::Picture { version } => Some((row.id.clone(), version)),
                _ => None,
            })
            .collect::<Vec<_>>();
        self.posters
            .update(cx, |posters, cx| posters.want(POSTER_USER, keys, cx));
    }
}

// The table's columns (`LIBRARY_COLUMNS` in `library-tab.tsx`): select 2rem,
// name, scene 8rem, duration 5.5rem, size 5.5rem, file 4.5rem and actions
// 8rem (13rem from a 1280 px window, where Reduce noise shows its words).
const COLUMN_SELECT: f32 = 32.;
const COLUMN_SCENE: f32 = 128.;
const COLUMN_DURATION: f32 = 88.;
const COLUMN_SIZE: f32 = 88.;
const COLUMN_FILE: f32 = 72.;
const COLUMN_ACTIONS: f32 = 128.;
const COLUMN_ACTIONS_WIDE: f32 = 208.;
/// `min-[1280px]`: the window width where the actions column widens.
const WIDE_WINDOW: f32 = 1280.;
/// `LIBRARY_POSTER_CLASS`: the 72 × 40 poster frame.
const POSTER_WIDTH: f32 = 72.;
const POSTER_HEIGHT: f32 = 40.;

/// One header or body row's cells on the table's columns, `gap-2 px-gutter`.
fn columns(actions_width: f32, cells: [gpui::AnyElement; 7]) -> gpui::Div {
    let [select, name, scene, duration, bytes, file, actions] = cells;
    div()
        .w_full()
        .flex()
        .items_center()
        .gap(px(8.))
        .px(px(size::GUTTER))
        .child(
            div()
                .flex_none()
                .w(px(COLUMN_SELECT))
                .flex()
                .items_center()
                .child(select),
        )
        .child(div().flex_1().min_w(px(0.)).child(name))
        .child(
            div()
                .flex_none()
                .w(px(COLUMN_SCENE))
                .min_w(px(0.))
                .overflow_hidden()
                // A flex cell, so a badge keeps its own width (`w-fit`).
                .flex()
                .items_center()
                .child(scene),
        )
        .child(div().flex_none().w(px(COLUMN_DURATION)).child(duration))
        .child(div().flex_none().w(px(COLUMN_SIZE)).child(bytes))
        .child(
            div()
                .flex_none()
                .w(px(COLUMN_FILE))
                .flex()
                .items_center()
                .child(file),
        )
        .child(
            div()
                .flex_none()
                .w(px(actions_width))
                .flex()
                .items_center()
                .justify_end()
                .child(actions),
        )
}

fn status_tone(tone: p::StatusTone) -> StatusTone {
    match tone {
        p::StatusTone::Neutral => StatusTone::Neutral,
        p::StatusTone::Good => StatusTone::Good,
        p::StatusTone::Warn => StatusTone::Warn,
        p::StatusTone::Error => StatusTone::Error,
        p::StatusTone::Live => StatusTone::Live,
    }
}

impl LibraryScreen {
    /// `runNoiseCleanupAction` for the row's direct button: Upgrade opens
    /// Premium, Start queues the cleanup, and the cleaned copy or its source
    /// opens in the Library.
    fn noise_action(
        &mut self,
        id: &str,
        action: NoiseCleanupAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            NoiseCleanupAction::Upgrade => {
                crate::app::accounts::open_web(cx, |web| web.premium());
            }
            NoiseCleanupAction::OpenOutput => {
                let data = self.core.data();
                let output = latest_job_for_session(&data.noise_jobs, id)
                    .and_then(|job| job.output_session_id.clone());
                if let Some(output) = output {
                    self.focus_session(Some(output.as_str()), window, cx);
                }
            }
            NoiseCleanupAction::ShowSource => {
                let source = self
                    .core
                    .data()
                    .sessions
                    .iter()
                    .find(|session| session.id == id)
                    .and_then(|session| session.derived_from_session_id.clone());
                if let Some(source) = source {
                    self.focus_session(Some(source.as_str()), window, cx);
                }
            }
            NoiseCleanupAction::Start => {
                let core = self.core.clone();
                let id = id.to_string();
                self.task(
                    async move {
                        core.start_noise_cleanup(&id)
                            .await
                            .map(|_| ())
                            .map_err(|_| "Couldn't start noise cleanup.".to_string())
                    },
                    |this, result, _| this.message = result.err(),
                    cx,
                );
            }
            // Cancel lives in the row's menu, never on the direct button.
            NoiseCleanupAction::Cancel => {}
        }
    }

    /// `SessionPoster`: the live dot, the poster, or the video file glyph in
    /// the 72 × 40 frame (`rounded-row border bg-muted/30`).
    fn poster_cell(&self, row: &p::RowView, t: &Theme, cx: &gpui::App) -> gpui::Div {
        let frame = crate::app::posters::frame(POSTER_WIDTH, POSTER_HEIGHT, t);
        match row.poster {
            p::PosterView::Live { tone, pulse } => frame.child(
                StatusDot::new(SharedString::from(format!("poster-dot-{}", row.id)))
                    .tone(status_tone(tone))
                    .pulse(pulse),
            ),
            p::PosterView::Picture { version } => frame.child(crate::app::posters::picture(
                self.posters.read(cx).get(&row.id, version),
                t,
            )),
            p::PosterView::Glyph => {
                frame.child(icon(IconName::FileVideo, 16., hsla(t.muted_foreground)))
            }
        }
    }
}

impl Render for LibraryScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        // The title is the shell's toolbar band (#2206), not the page's.
        if self.cloud_shown {
            let cloud = self.cloud_body(cx);
            let tabs = self.tabs(cx).child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .flex()
                    .flex_col()
                    .p(px(size::GUTTER))
                    .child(cloud),
            );
            return div()
                .size_full()
                .flex()
                .flex_col()
                .type_scale(text::LABEL)
                .text_color(hsla(t.foreground))
                .child(tabs)
                .child(self.markers_dialog_view(cx));
        }
        let view = self.view();
        self.posters(&view.rows, cx);
        let wide = window.viewport_size().width >= px(WIDE_WINDOW);
        let actions_width = if wide {
            COLUMN_ACTIONS_WIDE
        } else {
            COLUMN_ACTIONS
        };
        let muted = hsla(t.muted_foreground);
        let ink = hsla(t.foreground);

        // `PaneStrip` filter bar: filter · sort · search, then Import… and
        // Open Studio.
        let mut filter = Select::new("library-filter")
            .accessibility_label(copy::FILTER_LABEL)
            .width(160.)
            .value(Some(view.filter_index.to_string().into()));
        for value in v::LibraryFilter::ALL {
            filter = filter.option(value.index().to_string(), value.label());
        }
        let mut sort = Select::new("library-sort")
            .accessibility_label(copy::SORT_LABEL)
            .width(144.)
            .value(Some(view.sort_index.to_string().into()));
        for value in v::LibrarySort::ALL {
            sort = sort.option(value.index().to_string(), value.label());
        }
        let toolbar = div()
            .flex_none()
            .px(px(size::GUTTER))
            .py(px(8.))
            .border_b_1()
            .border_color(hsla(t.border))
            .flex()
            .flex_wrap()
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
            .child(
                div().flex_1().min_w(px(192.)).child(
                    InputGroup::new("library-search", &self.search)
                        .start(InputGroupAddon::start().child(icon(
                            IconName::MagnifyingGlass,
                            16.,
                            muted,
                        )))
                        .accessibility_label(copy::SEARCH_LABEL),
                ),
            )
            .child(
                Button::new("library-import")
                    .variant(ButtonVariant::Outline)
                    .disabled(view.importing || !self.core.data().online)
                    .child(icon(IconName::UploadSimple, 16., ink))
                    .child(if view.importing {
                        copy::IMPORTING
                    } else {
                        copy::IMPORT
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.import(cx))),
            )
            .child(
                Button::new("library-open-studio")
                    .variant(ButtonVariant::Outline)
                    .child(icon(IconName::VideoCamera, 16., ink))
                    .child(copy::OPEN_STUDIO)
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.emit(Navigate(videorc_app_core::nav::PageId::Studio))
                    })),
            );

        let mut panel = div()
            .flex_1()
            .min_h(px(0.))
            .flex()
            .flex_col()
            // `PageHeader`: the description, `px-gutter pt-3 pb-1 text-xs`.
            .child(
                div()
                    .flex_none()
                    .px(px(size::GUTTER))
                    .pt(px(12.))
                    .pb(px(4.))
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(muted)
                    .child(copy::DESCRIPTION),
            )
            .child(toolbar);

        // The selection bar: the checkbox column's one bulk action, shown
        // while something is selected.
        if view.selected_count > 0 {
            panel = panel.child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .px(px(size::GUTTER))
                    .py(px(6.))
                    .border_b_1()
                    .border_color(hsla(t.border))
                    .text_size(px(14.))
                    .line_height(px(20.))
                    .font_weight(FontWeight::NORMAL)
                    .child(
                        div()
                            .text_color(muted)
                            .child(format!("{} selected", view.selected_count)),
                    )
                    .child(
                        Button::new("library-delete-selected")
                            .variant(ButtonVariant::Destructive)
                            .disabled(view.bulk_hold.is_some())
                            .child(icon(IconName::Trash, 16., hsla(t.destructive)))
                            .child(copy::DELETE)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.ask_delete(this.ui.selection.selected.clone(), window, cx)
                            })),
                    )
                    .child(
                        Button::new("library-clear-selected")
                            .variant(ButtonVariant::Ghost)
                            .label(copy::CLEAR_SELECTION)
                            .on_click(cx.listener(|this, _, _, cx| this.select_all(false, cx))),
                    )
                    .children(view.bulk_hold.map(|reason| {
                        div().type_scale(text::META).text_color(muted).child(reason)
                    })),
            );
        }
        if view.offline_alert && view.list_state != v::ListState::Offline {
            panel = panel.child(
                div()
                    .flex_none()
                    .px(px(size::GUTTER))
                    .pt(px(8.))
                    .child(Alert::new("library-offline").title("Videorc is reconnecting…")),
            );
        }
        if let Some(message) = &self.message {
            panel = panel.child(
                div()
                    .flex_none()
                    .px(px(size::GUTTER))
                    .pt(px(8.))
                    .child(Alert::new("library-message").title(message.clone())),
            );
        }
        if let Some(partial) = &view.partial_notice {
            panel = panel.child(
                div().flex_none().px(px(size::GUTTER)).pt(px(8.)).child(
                    Alert::new("library-partial")
                        .variant(AlertVariant::Quiet)
                        .title(partial.clone())
                        .action(
                            Button::new("library-load-all")
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .label(view.load_all_label)
                                .disabled(!view.load_all_enabled)
                                .on_click(cx.listener(|this, _, _, cx| this.load(true, cx))),
                        ),
                ),
            );
        }

        match view.list_state {
            v::ListState::Loading => {
                panel = panel.child(
                    Empty::new().child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_color(muted)
                            .child(
                                Spinner::new("library-loading")
                                    .accessibility_label(copy::LOADING_RECORDINGS),
                            )
                            .child(copy::LOADING_RECORDINGS),
                    ),
                );
            }
            v::ListState::Offline => {
                panel = panel.child(
                    div()
                        .px(px(size::GUTTER))
                        .py(px(16.))
                        .child(Alert::new("library-offline").title("Videorc is reconnecting…")),
                );
            }
            v::ListState::Empty => {
                panel = panel.child(
                    Empty::new()
                        .title(copy::EMPTY_TITLE)
                        .description(copy::EMPTY_DESCRIPTION),
                );
            }
            _ => {}
        }
        if let Some(clear) = view.no_match {
            panel = panel.child(
                Empty::new().title(copy::NO_MATCH_TITLE).child(
                    Button::new("library-clear-query")
                        .variant(ButtonVariant::Outline)
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

        if !view.rows.is_empty() {
            let all = match view.select_all {
                v::SelectAllState::All => CheckboxChecked::Checked,
                v::SelectAllState::Some => CheckboxChecked::Mixed,
                v::SelectAllState::None => CheckboxChecked::Unchecked,
            };
            let select_all = Checkbox::new("library-select-all")
                .state(all)
                .disabled(!view.select_all_enabled)
                .disabled_reason(view.bulk_hold.unwrap_or("No recordings can be selected."))
                .accessibility_label(copy::SELECT_ALL_LABEL)
                .on_change(Self::change(cx, |this, next: &CheckboxChecked, _, cx| {
                    this.select_all(*next == CheckboxChecked::Checked, cx)
                }));
            // `LIBRARY_HEADER_CLASS`: tertiary labels on a hairline.
            let header = div()
                .flex_none()
                .py(px(8.))
                .border_b_1()
                .border_color(hsla(t.border))
                .type_scale(text::META)
                .font_weight(FontWeight::MEDIUM)
                .text_color(muted)
                .child(columns(
                    actions_width,
                    [
                        select_all.into_any_element(),
                        div().child(copy::COLUMN_NAME).into_any_element(),
                        div().child(copy::COLUMN_SCENE).into_any_element(),
                        div().child(copy::COLUMN_DURATION).into_any_element(),
                        div().child(copy::COLUMN_SIZE).into_any_element(),
                        div().child(copy::COLUMN_FILE).into_any_element(),
                        div().child(copy::COLUMN_ACTIONS).into_any_element(),
                    ],
                ));
            let focused = self.focus.is_focused(window);
            let last = view.rows.len() - 1;
            let mut rows = div().flex().flex_col();
            for (index, row) in view.rows.iter().enumerate() {
                rows = rows.child(self.row(
                    row,
                    index == last,
                    focused,
                    view.bulk_hold,
                    actions_width,
                    t,
                    cx,
                ));
            }
            panel = panel.child(header).child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .child(ScrollArea::new("library-scroll").child(rows)),
            );
        }
        // The honest storage footer: real totals, and Load more.
        if view.footer.is_some() || view.load_more.is_some() {
            panel = panel.child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .px(px(size::GUTTER))
                    .py(px(8.))
                    .border_t_1()
                    .border_color(hsla(t.border))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(div().children(view.footer.clone()))
                    .children(view.load_more.map(|label| {
                        Button::new("library-load-more")
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::Xs)
                            .label(label)
                            .disabled(!view.load_more_enabled)
                            .on_click(cx.listener(|this, _, _, cx| this.load(false, cx)))
                    })),
            );
        }

        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::keys))
            .type_scale(text::LABEL)
            .text_color(ink)
            .child(self.tabs(cx).child(panel));
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

impl LibraryScreen {
    /// `LibraryRow`: one recording on the table's columns
    /// (`LIBRARY_ROW_CLASS`: `border-b py-2`, the accent on hover and
    /// selection).
    #[allow(clippy::too_many_arguments)]
    fn row(
        &self,
        row: &p::RowView,
        last: bool,
        focused: bool,
        hold: Option<&'static str>,
        actions_width: f32,
        t: &'static Theme,
        cx: &mut Context<Self>,
    ) -> KebabContextMenu {
        // Reduce noise shows its words where the actions column is wide.
        let wide = actions_width > COLUMN_ACTIONS;
        let muted = hsla(t.muted_foreground);
        let ink = hsla(t.foreground);
        let id = row.id.clone();
        let menu = self.menu(row, cx);
        let reason = if !row.selectable {
            hold.unwrap_or("This recording is in use.")
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

        // Name: the poster, the title with its chips, and the meta line.
        let mut title_line = div().min_w(px(0.)).flex().items_center().gap(px(8.)).child(
            div()
                .min_w(px(0.))
                .truncate()
                .text_size(px(14.))
                .line_height(px(20.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(ink)
                .child(row.title.clone()),
        );
        if let Some(chip) = &row.clean_cut {
            let mut badge = Badge::new(chip.label.clone()).variant(BadgeVariant::Outline);
            if chip.working {
                badge = badge.icon(Spinner::new(SharedString::from(format!("cut-{id}"))).size(12.));
            }
            title_line = title_line.child(
                div()
                    .id(SharedString::from(format!("cut-chip-{id}")))
                    .flex_none()
                    .tooltip(tooltip(chip.hint.clone()))
                    .child(badge),
            );
        }
        if let Some(quality) = &row.quality {
            title_line = title_line.child(
                div()
                    .id(SharedString::from(format!("quality-{id}")))
                    .flex_none()
                    .tooltip(tooltip(quality.detail.clone()))
                    .child(Badge::new(quality.label.clone()).variant(BadgeVariant::Warning)),
            );
        }
        let name = div()
            .min_w(px(0.))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(self.poster_cell(row, t, cx))
            .child(
                div()
                    .min_w(px(0.))
                    .flex()
                    .flex_col()
                    .child(title_line)
                    .child(
                        div()
                            .min_w(px(0.))
                            .truncate()
                            .type_scale(text::META)
                            .text_color(muted)
                            .child(row.meta.clone()),
                    ),
            );
        let scene = div().flex().children(
            row.scene
                .as_ref()
                .map(|scene| Badge::new(scene.text.clone()).variant(BadgeVariant::Outline)),
        );
        let meta = |words: String| div().type_scale(text::META).text_color(muted).child(words);
        let file = match &row.file {
            p::FileCell::None => div().into_any_element(),
            p::FileCell::Live { label, tone, pulse } => {
                StatusDot::new(SharedString::from(format!("file-dot-{id}")))
                    .tone(status_tone(*tone))
                    .label(label.clone())
                    .pulse(*pulse)
                    .into_any_element()
            }
            p::FileCell::Finalizing(label) => Badge::new(label.clone())
                .variant(BadgeVariant::Outline)
                .icon(Spinner::new(SharedString::from(format!("file-spin-{id}"))).size(12.))
                .into_any_element(),
            p::FileCell::Problem { label, detail } => div()
                .id(SharedString::from(format!("file-problem-{id}")))
                .tooltip(tooltip(detail.clone()))
                .child(Badge::new(label.clone()).variant(BadgeVariant::Destructive))
                .into_any_element(),
            p::FileCell::Note { label, detail } => div()
                .id(SharedString::from(format!("file-note-{id}")))
                .tooltip(tooltip(detail.clone()))
                .child(Badge::new(label.clone()).variant(BadgeVariant::Outline))
                .into_any_element(),
            p::FileCell::Format(label) => Badge::new(label.clone())
                .variant(BadgeVariant::Outline)
                .into_any_element(),
        };

        // `RowActions`: Play, the noise cleanup button and ⋯.
        let play_off = row.play_reason.is_some() || row.menu_disabled;
        let play_id = id.clone();
        let play = Button::new(SharedString::from(format!("play-{id}")))
            .variant(ButtonVariant::Ghost)
            .size(ButtonSize::Icon)
            .accessibility_label(copy::PLAY_RECORDING)
            .disabled(play_off)
            .tooltip(row.play_reason.unwrap_or(copy::PLAY_IN_DEFAULT_PLAYER))
            .child(icon(
                IconName::Play,
                16.,
                if play_off {
                    hsla(with_alpha(t.foreground, 0.5))
                } else {
                    ink
                },
            ))
            .on_click(
                cx.listener(move |this, _, _, cx| this.external_recording(play_id.clone(), cx)),
            );
        let noise = row.noise.as_ref().map(|noise| {
            let direct = noise.direct_action;
            let glyph_ink = if direct.is_some() {
                ink
            } else {
                hsla(with_alpha(t.foreground, 0.5))
            };
            let glyph = if noise.premium_locked {
                icon(IconName::LockKey, 16., glyph_ink).into_any_element()
            } else if noise.busy {
                Spinner::new(SharedString::from(format!("noise-spin-{id}")))
                    .size(16.)
                    .into_any_element()
            } else {
                icon(IconName::WaveformSlash, 16., glyph_ink).into_any_element()
            };
            let label = noise.direct_label.clone().unwrap_or_default();
            let mut button = Button::new(SharedString::from(format!("noise-{id}")))
                .variant(ButtonVariant::Ghost)
                .disabled(direct.is_none())
                .accessibility_label(if direct == Some(NoiseCleanupAction::OpenOutput) {
                    format!("Open cleaned copy for {}", row.title)
                } else {
                    format!("Clean up noise in {}", row.title)
                })
                .child(glyph);
            button = if wide {
                button.child(label)
            } else {
                button.size(ButtonSize::Icon)
            };
            if let Some(help) = noise
                .disabled_reason
                .map(str::to_string)
                .or_else(|| noise.detail.clone())
            {
                button = button.tooltip(help);
            }
            let noise_id = id.clone();
            button.on_click(cx.listener(move |this, _, window, cx| {
                if let Some(action) = direct {
                    this.noise_action(&noise_id, action, window, cx);
                }
            }))
        });
        let actions = div()
            .flex()
            .items_center()
            .justify_end()
            .gap(px(2.))
            .child(play)
            .children(noise)
            .child(
                KebabMenu::new(SharedString::from(format!("actions-{id}")), menu.clone())
                    .label(copy::SESSION_ACTIONS)
                    .busy(row.menu_busy || self.busy.contains(&id)),
            );

        let highlight = row.selected || row.revealed || (row.active && focused);
        let line = div()
            .id(SharedString::from(format!("session-{id}")))
            .w_full()
            .py(px(8.))
            .when(!last, |line| line.border_b_1().border_color(hsla(t.border)))
            .when(highlight, |line| line.bg(hsla(t.accent)))
            .hover(|style| style.bg(hsla(t.accent)))
            .child(columns(
                actions_width,
                [
                    selection.into_any_element(),
                    name.into_any_element(),
                    scene.into_any_element(),
                    meta(row.duration.clone()).into_any_element(),
                    meta(row.size.clone()).into_any_element(),
                    file,
                    actions.into_any_element(),
                ],
            ))
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
                    if matches!(event,gpui::ClickEvent::Mouse(event) if event.up.click_count==2) {
                        this.external_recording(id.clone(), cx);
                    }
                }),
            );
        // The right-click menu is the same list as ⋯.
        KebabContextMenu::new(
            SharedString::from(format!("context-{}", row.id)),
            menu,
            line,
        )
    }
}
