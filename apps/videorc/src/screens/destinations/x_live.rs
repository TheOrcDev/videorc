//! Live on X (`XLiveEditSection`, plan 260 L2): the broadcast on air takes a
//! new title or category at once (`PUT /2/broadcasts/:id`). Shown only while
//! X is live; keyed by the broadcast, so a new stream starts from what its Go
//! Live sent. The saved Stream details stay as they are.

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use gpui_base::input::InputEvent;
use videorc_app_core::livestream::setup::Runtime;
use videorc_app_core::livestream::x_categories::X_NO_CATEGORY;
use videorc_app_core::livestream::x_live_edit::{
    self as live, UPDATE_X, UPDATING, X_LIVE_EDIT_DESCRIPTION, X_LIVE_EDIT_TITLE,
    X_LIVE_TITLE_LABEL, X_LIVE_TITLE_REQUIRED, XLiveValues,
};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::field::{Field, FieldError};
use videorc_kit::input::{Input, InputState};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

/// One live X broadcast's edit (`XLiveEditSection`'s state).
pub(super) struct XLiveEdit {
    broadcast_id: String,
    account_id: Option<String>,
    /// What X shows now, as Videorc last knew it.
    shown: XLiveValues,
    answer_name: Option<String>,
    title: Entity<InputState>,
    category_value: String,
    pending: bool,
    failure: Option<String>,
    /// X's answered title, for the input on the next frame (it needs the
    /// window).
    answered_title: Option<String>,
}

impl DestinationsPanel {
    /// Keeps the edit on the X broadcast that is live: none when X isn't,
    /// a fresh one (from what Go Live sent) for a new broadcast.
    pub(super) fn sync_x_live_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let capture = self.studio.snapshot().settings.capture_doc.clone();
        let targets = videorc_app_core::livestream::targets::targets(&capture);
        let runtimes = Runtime::read(&self.studio.telemetry_now().stream_targets);
        let Some(target) = live::live_x_target(&targets, &runtimes) else {
            self.x_live_edit = None;
            return;
        };
        let broadcast_id = target.platform_broadcast_id.clone().unwrap_or_default();
        if let Some(edit) = self
            .x_live_edit
            .as_mut()
            .filter(|edit| edit.broadcast_id == broadcast_id)
        {
            if let Some(value) = edit.answered_title.take() {
                edit.title
                    .update(cx, |input, cx| input.set_value(value, window, cx));
            }
            return;
        }
        let categories = self.studio.platforms_now().x_live_categories;
        let shown = live::x_live_start(self.details.draft.as_ref(), &categories);
        let value = shown.title.clone();
        let title = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_value(value, window, cx);
            state
        });
        cx.subscribe(&title, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
        self.x_live_edit = Some(XLiveEdit {
            broadcast_id,
            account_id: target.account_id.clone(),
            category_value: shown
                .category_id
                .clone()
                .unwrap_or_else(|| X_NO_CATEGORY.to_string()),
            shown,
            answer_name: None,
            title,
            pending: false,
            failure: None,
            answered_title: None,
        });
    }

    pub(super) fn x_live_section(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let edit = self.x_live_edit.as_ref()?;
        let t = *theme::current(window, cx).theme();
        let entity = cx.entity();
        let title_text = edit.title.read(cx).value().to_string();
        let title_empty = title_text.trim().is_empty();
        let changes = live::x_live_changes(&edit.shown, &title_text, &edit.category_value);
        let pending = edit.pending;
        let categories = self.studio.platforms_now().x_live_categories;
        let shown_line =
            live::x_live_shown_line(&edit.shown, &categories, edit.answer_name.as_deref());
        let failure = edit.failure.clone();
        let category_value = edit.category_value.clone();
        let category_name = categories
            .iter()
            .find(|category| category.id == category_value)
            .map(|category| category.name.clone());
        let title_input = edit.title.clone();

        let update = Button::new("x-live-update")
            .label(if pending { UPDATING } else { UPDATE_X })
            .variant(ButtonVariant::Secondary)
            .disabled(changes.is_none() || pending)
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |this, cx| this.update_x_live(cx));
                }
            });

        let title = Field::new("x-live-title-field")
            .label(X_LIVE_TITLE_LABEL)
            .child(
                Input::new("x-live-title", &title_input)
                    .accessibility_label(X_LIVE_TITLE_LABEL)
                    .disabled(pending)
                    .invalid(title_empty),
            )
            .when(title_empty, |field| field.error(X_LIVE_TITLE_REQUIRED));

        let saved_id = (category_value != X_NO_CATEGORY).then_some(category_value.as_str());
        let category = self.x_category_field(
            &t,
            "x-live-category",
            saved_id,
            category_name.as_deref(),
            pending,
            move |value, _, cx| {
                entity.update(cx, |this, cx| {
                    if let Some(edit) = this.x_live_edit.as_mut() {
                        edit.category_value = value;
                    }
                    cx.notify();
                });
            },
        );

        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(title)
            .child(category)
            .child(
                // `FieldDescription role="status"`: what X shows now.
                div()
                    .id("x-live-shown")
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(shown_line),
            );
        if let Some(failure) = failure {
            body = body.child(FieldError::new(failure));
        }

        Some(
            PanelSection::new("x-live-edit")
                .title(X_LIVE_EDIT_TITLE)
                .description(SharedString::from(X_LIVE_EDIT_DESCRIPTION))
                .action(update)
                .child(body)
                .into_any_element(),
        )
    }

    /// `update`: only what changed goes to X; X's answer is what the section
    /// shows next, or the words for why X didn't take it.
    fn update_x_live(&mut self, cx: &mut Context<Self>) {
        let Some(edit) = self.x_live_edit.as_mut() else {
            return;
        };
        let title = edit.title.read(cx).value().to_string();
        let Some(changes) = live::x_live_changes(&edit.shown, &title, &edit.category_value) else {
            return;
        };
        if edit.pending {
            return;
        }
        edit.pending = true;
        edit.failure = None;
        cx.notify();
        let studio = self.studio.clone();
        let broadcast_id = edit.broadcast_id.clone();
        let account_id = edit.account_id.clone();
        let task = self.runtime.spawn(async move {
            studio
                .update_x_broadcast(account_id, broadcast_id.clone(), changes)
                .await
        });
        let broadcast = edit.broadcast_id.clone();
        cx.spawn(async move |this, cx| {
            let answer = task.await.unwrap_or_else(|error| Err(error.to_string()));
            let _ = this.update(cx, |this, cx| {
                // A new broadcast since: its own edit, not this answer's.
                let Some(edit) = this
                    .x_live_edit
                    .as_mut()
                    .filter(|edit| edit.broadcast_id == broadcast)
                else {
                    return;
                };
                edit.pending = false;
                match answer {
                    Ok(answer) => {
                        let next = live::x_live_from_answer(&answer, &edit.shown);
                        edit.answer_name = answer.live_category_name.clone();
                        edit.category_value = next
                            .category_id
                            .clone()
                            .unwrap_or_else(|| X_NO_CATEGORY.to_string());
                        edit.answered_title = Some(next.title.clone());
                        edit.shown = next;
                    }
                    Err(message) => edit.failure = Some(live::x_live_update_failed(&message)),
                }
                cx.notify();
            });
        })
        .detach();
    }
}
