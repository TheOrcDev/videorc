use super::*;
use gpui::{Anchor, AnyElement, SharedString, div, prelude::*, px};
use n::types::State;
use videorc_kit::{
    button::{Button, ButtonSize, ButtonVariant},
    icon::{IconName, icon},
    list_row::{GroupedRow, ListRow},
    popover::Popover,
    scroll_area::ScrollArea,
    section_label::SectionLabel,
    status_bar_action::StatusBarAction,
    theme::{TypeScale, current, hsla},
    tokens::{Theme, text},
};

impl Centre {
    fn content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let t = current(window, cx).theme();
        let entries = self.hub.read(cx).store.snapshot().to_vec();
        self.focuses
            .retain(|key, _| entries.iter().any(|entry| &entry.key == key));
        for entry in &entries {
            self.focuses
                .entry(entry.key.clone())
                .or_insert_with(|| cx.focus_handle());
        }
        let clearable = entries.iter().any(|e| !n::policy::is_now(e.state));
        let labelled = entries.iter().any(|e| n::policy::is_now(e.state));
        let mut header = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(16.))
            .py(px(8.))
            .border_b_1()
            .border_color(hsla(t.border))
            .child(
                div()
                    .flex_1()
                    .type_scale(text::SECTION)
                    .child("Notifications"),
            );
        if clearable {
            header = header.child(
                Button::new("clear-all")
                    .label("Clear all")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.hub.update(cx, |hub, cx| hub.clear(None, cx))
                    })),
            );
        }
        let mut body = div().flex().flex_col().gap(px(8.)).child(header);
        if entries.is_empty() {
            body = body.child(
                div()
                    .py(px(40.))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(4.))
                    .child(div().type_scale(text::SECTION).child("No notifications"))
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child("Problems and finished work show up here."),
                    ),
            );
        } else {
            let mut list = div()
                .id("notification-list")
                .role(gpui::Role::List)
                .aria_label("Notifications")
                .flex()
                .flex_col();
            let mut earlier = false;
            if labelled {
                list = list.child(div().px(px(16.)).py(px(8.)).child(SectionLabel::new("Now")));
            }
            for (index, entry) in entries.iter().enumerate() {
                if labelled && !earlier && !n::policy::is_now(entry.state) {
                    earlier = true;
                    list = list.child(
                        div()
                            .px(px(16.))
                            .py(px(8.))
                            .child(SectionLabel::new("Earlier")),
                    );
                }
                list = list.child(self.row(entry, index, &entries, t, cx));
            }
            let height = (entries.len() as f32 * 124. + 48.)
                .min(448.)
                .min((f32::from(window.viewport_size().height) - 176.).max(100.));
            body = body.child(
                div()
                    .h(px(height))
                    .child(ScrollArea::new("notification-scroll").child(list)),
            );
        }
        body.into_any_element()
    }
    fn row(
        &self,
        entry: &Entry,
        index: usize,
        entries: &[Entry],
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let focus = self.focuses[&entry.key].clone();
        let key = entry.key.clone();
        let next = entries
            .get(index + 1)
            .or_else(|| index.checked_sub(1).and_then(|i| entries.get(i)))
            .map(|e| self.focuses[&e.key].clone());
        let previous = index
            .checked_sub(1)
            .and_then(|i| entries.get(i))
            .map(|e| self.focuses[&e.key].clone());
        let down = entries.get(index + 1).map(|e| self.focuses[&e.key].clone());
        let first = entry.actions.first().map(|a| a.id.clone());
        let title = ListRow::new(
            SharedString::from(format!("entry-title:{}", entry.key)),
            entry.title.clone(),
        )
        .grouped()
        .leading(icon(
            if entry.state == State::Running {
                IconName::CircleNotch
            } else {
                tone_icon(entry.tone)
            },
            16.,
            hsla(tone_color(entry.tone, t)),
        ))
        .meta(time_words(entry, now()))
        .map(|row| {
            if entry.read {
                row
            } else {
                row.status_icon(div().size(px(5.)).rounded_full().bg(hsla(t.foreground)))
            }
        });
        let mut row = div()
            .id(SharedString::from(format!("entry:{}", entry.key)))
            .track_focus(&focus)
            .role(gpui::Role::ListItem)
            .aria_label(entry.title.clone())
            .aria_description(entry.detail.clone().unwrap_or_default())
            .tab_index(if index == 0 { 0 } else { -1 })
            .flex()
            .flex_col()
            .gap(px(4.))
            .px(px(16.))
            .py(px(8.))
            .border_b_1()
            .border_color(hsla(t.border))
            .child(title);
        if let Some(detail) = &entry.detail {
            row = row.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .line_clamp(2)
                    .child(detail.clone()),
            );
        }
        let mut buttons = div().flex().items_center().gap(px(4.));
        for (index, action) in entry.actions.iter().take(2).enumerate() {
            let key = entry.key.clone();
            let id = action.id.clone();
            let hub = self.hub.read(cx);
            let available = hub.can_run(&key, &id);
            let busy = hub.busy.contains(&key);
            buttons = buttons.child(
                Button::new(SharedString::from(format!("{key}/{id}")))
                    .label(action.label.clone())
                    .size(ButtonSize::Xs)
                    .variant(if index == 0 {
                        ButtonVariant::Default
                    } else {
                        ButtonVariant::Outline
                    })
                    .disabled(!available || busy)
                    .map(|button| {
                        if !available {
                            button.tooltip("Unavailable in this build.")
                        } else if busy {
                            button.tooltip("Working…")
                        } else {
                            button
                        }
                    })
                    .on_click(cx.listener(move |this, _, _, cx| this.act(&key, &id, cx))),
            );
        }
        let clear_key = entry.key.clone();
        buttons = buttons.child(div().flex_1()).child(
            Button::new(SharedString::from(format!("clear:{}", entry.key)))
                .child(icon(IconName::X, 14., hsla(t.muted_foreground)))
                .accessibility_label(format!("Clear {}", entry.title))
                .tooltip(format!("Clear {}", entry.title))
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::IconXs)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.hub
                        .update(cx, |hub, cx| hub.clear(Some(&clear_key), cx));
                    if let Some(next) = &next {
                        window.focus(next, cx);
                    }
                })),
        );
        row.child(buttons)
            .on_key_down(
                cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                    let mods = &event.keystroke.modifiers;
                    if mods.platform || mods.control || mods.alt {
                        return;
                    }
                    match event.keystroke.key.as_str() {
                        "up" => {
                            if let Some(previous) = &previous {
                                window.focus(previous, cx);
                            }
                            cx.stop_propagation();
                        }
                        "down" => {
                            if let Some(down) = &down {
                                window.focus(down, cx);
                            }
                            cx.stop_propagation();
                        }
                        "enter" if focus.is_focused(window) => {
                            if let Some(id) = &first {
                                this.act(&key, id, cx);
                            }
                            cx.stop_propagation();
                        }
                        "backspace" | "delete" if focus.is_focused(window) => {
                            this.hub.update(cx, |hub, cx| hub.clear(Some(&key), cx));
                            if let Some(next) = down.as_ref().or(previous.as_ref()) {
                                window.focus(next, cx);
                            }
                            cx.stop_propagation();
                        }
                        _ => {}
                    }
                }),
            )
            .into_any_element()
    }
}
impl Render for Centre {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let count = self.hub.read(cx).store.count();
        let t = current(window, cx).theme();
        let color = hsla(
            count
                .tone
                .map_or(t.muted_foreground, |tone| tone_color(tone, t)),
        );
        let mut label = "Notifications".to_string();
        if count.unread > 0 {
            label.push_str(&format!(", {} unread", count.unread));
        }
        if count.urgent > 0 {
            label.push_str(&format!(", {} urgent", count.urgent));
        } else if count.tone == Some(Tone::Warning) {
            label.push_str(", a warning is open");
        }
        let count_text = match count.unread {
            0 => String::new(),
            1..=9 => count.unread.to_string(),
            _ => "9+".into(),
        };
        let changed = cx.entity().downgrade();
        let content = cx.entity().downgrade();
        Popover::new("notifications")
            .flush()
            .open(self.open)
            .anchor(Anchor::BottomRight)
            .width(380.)
            .trigger_with(move |open, _, _| {
                StatusBarAction::new("notification-bell", label)
                    .icon(icon(IconName::Bell, 14., color))
                    .text(count_text)
                    .pressed(open)
                    .tooltip("Notifications", Some("secondary-shift-b"))
            })
            .on_open_change(move |open, _, cx| {
                let _ = changed.update(cx, |this, cx| this.set_open(open, cx));
            })
            .content(move |window, cx| {
                content
                    .update(cx, |this, cx| this.content(window, cx))
                    .unwrap_or_else(|_| div().into_any_element())
            })
    }
}
fn tone_color(tone: Tone, t: &Theme) -> videorc_kit::tokens::Color {
    match tone {
        Tone::Urgent => t.destructive,
        Tone::Warning => t.warning,
        Tone::News => t.info,
        Tone::Done => t.success,
    }
}
fn tone_icon(tone: Tone) -> IconName {
    match tone {
        Tone::Urgent => IconName::XCircle,
        Tone::Warning => IconName::Warning,
        Tone::News => IconName::Info,
        Tone::Done => IconName::CheckCircle,
    }
}
fn time_words(entry: &Entry, now: u64) -> String {
    let seconds = now.saturating_sub(if entry.state == State::Open {
        entry.opened_at
    } else {
        entry.resolved_at.unwrap_or(entry.updated_at)
    }) / 1000;
    if entry.state == State::Open && seconds < 60 {
        return format!("0:{seconds:02}");
    }
    if entry.state != State::Open && seconds < 45 {
        return "now".into();
    }
    let minutes = seconds.max(60) / 60;
    if minutes < 60 {
        format!("{minutes} min")
    } else if minutes < 1440 {
        format!("{} h", minutes / 60)
    } else {
        format!("{} d", minutes / 1440)
    }
}
