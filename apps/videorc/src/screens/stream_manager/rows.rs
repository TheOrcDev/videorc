//! Chat rows and their menus (P966–P969, P1268): ManagerRow chrome, the ⋯
//! menu from `pane::row_menu`, and the person right-click menu (About /
//! Same person / Mark as bot). A click on the row and ⋯ Highlight put the
//! message on stream; Remove from chat runs the Studio's moderation request
//! after the 3 s Undo toast.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{AnyElement, App, IntoElement, SharedString, Window, div, prelude::*, px};
use videorc_app_core::chat::highlight::{RowHighlight, RowPhase, StatusChip};
use videorc_app_core::chat::model::{LiveChatMessage, LiveChatProviderState};
use videorc_app_core::stream_manager::pane::{
    RowAction, RowMenuInputs, copy_text, row_menu, row_menu_label,
};
use videorc_app_core::stream_manager::removal::{
    ModerationOperation, remove_from_chat_available, remove_from_chat_blocked_reason,
};
use videorc_app_core::stream_manager::rows::ManagerRow;
use videorc_kit::{
    badge::{Badge, BadgeVariant},
    context_menu::ContextMenu,
    dropdown_menu::{Menu, MenuItem},
    kebab_menu::{KebabMenu, KebabMenuItem, KebabReveal},
    tokens::radius,
};

use crate::screens::chat_media::{self, Picture};

/// Person-menu words (Electron `ChatPersonMenu`).
const SAME_PERSON: &str = "Same person as…";
const MARK_AS_BOT: &str = "Mark as bot";
const X_SELF_LINK_REASON: &str = "X accounts can't be linked as the same person yet.";

/// What a row's click and its ⋯ Highlight ask the pane for, by message id.
pub type OnHighlight = Rc<dyn Fn(&str, &mut Window, &mut App)>;
/// ⋯ Remove from chat, by message id.
pub type OnRemove = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// One chat row: body + ⋯ menu, wrapped in the person right-click menu.
pub fn chat_row(
    message: &Arc<LiveChatMessage>,
    highlight: RowHighlight,
    live: bool,
    mention_names: &[String],
    providers: &[LiveChatProviderState],
    operation: Option<&ModerationOperation>,
    requesting: bool,
    pictures: &HashMap<String, Picture>,
    on_highlight: OnHighlight,
    on_remove: OnRemove,
) -> AnyElement {
    let view = ManagerRow::new(message, highlight, live, mention_names);
    let highlightable = view.row.highlightable;
    let blocked = remove_from_chat_blocked_reason(message, providers);
    let available =
        live && blocked.is_none() && remove_from_chat_available(message, operation, requesting);
    let inputs = RowMenuInputs {
        highlightable,
        on_stream: view.row.phase == RowPhase::Live,
        can_reply: true,
        removable: available,
        remove_reason: blocked.as_deref(),
    };
    let kebab_items: Vec<KebabMenuItem> = row_menu(message, inputs)
        .into_iter()
        .map(|item| {
            let id = match &item.action {
                RowAction::Highlight => "highlight",
                RowAction::Reply => "reply",
                RowAction::OpenLink(_) => "open-link",
                RowAction::CopyLink(_) => "copy-link",
                RowAction::Copy => "copy",
                RowAction::Remove => "remove",
            };
            let action = item.action.clone();
            let text = copy_text(message);
            let message_id = message.id.clone();
            let on_highlight = on_highlight.clone();
            let on_remove = on_remove.clone();
            let mut kebab = KebabMenuItem::new(id, item.label, move |window, app| {
                match &action {
                    RowAction::Highlight => on_highlight(&message_id, window, app),
                    RowAction::Remove => on_remove(&message_id, window, app),
                    RowAction::Copy => {
                        // Clipboard wiring lands with the rest of Copy.
                        let _ = &text;
                    }
                    _ => {
                        let _ = &text;
                    }
                }
            })
            .destructive(item.destructive)
            .disabled(item.disabled);
            if let Some(reason) = item.reason {
                kebab = kebab.disabled_reason(reason);
            }
            if item.separated {
                kebab = kebab.group("destructive");
            }
            kebab
        })
        .collect();

    let author = view.row.author.clone();
    let platform = message.platform.clone();
    let person_name = author.clone();
    let has_person =
        !author.is_empty() && message.event_type != "system" && message.event_type != "moderation";

    let body = row_body(&view, pictures);
    let chips = view.row.chips.iter().map(|(label, chip)| {
        Badge::new(*label).variant(match chip {
            StatusChip::Neutral => BadgeVariant::Default,
            StatusChip::Chrome => BadgeVariant::Chrome,
            StatusChip::Destructive => BadgeVariant::Destructive,
        })
    });
    let message_id = message.id.clone();
    let row = div()
        .id(SharedString::from(format!("chat-row-{}", view.row.id)))
        .w_full()
        .flex()
        .items_start()
        .gap(px(2.))
        .px(px(4.))
        .py(px(4.))
        .rounded(px(radius::CHIP))
        // The body is the click (`comment-row.tsx`'s plate); the ⋯ menu
        // beside it keeps its own.
        .child(
            div()
                .id(SharedString::from(format!("chat-row-body-{}", view.row.id)))
                .flex_1()
                .min_w(px(0.))
                .when(highlightable, |plate| {
                    plate
                        .cursor_pointer()
                        .on_click(move |_, window, app| on_highlight(&message_id, window, app))
                })
                .child(body),
        )
        .children(chips)
        .child(
            KebabMenu::new(
                SharedString::from(format!("chat-row-menu-{}", view.row.id)),
                kebab_items,
            )
            .label(row_menu_label(&author))
            .reveal(KebabReveal::Hover),
        );

    if !has_person {
        return row.into_any_element();
    }

    ContextMenu::new(
        SharedString::from(format!("chat-person-{}", view.row.id)),
        row,
    )
    .menu(move |_, _| person_menu(&person_name, &platform))
    .into_any_element()
}

fn person_menu(name: &str, platform: &str) -> Menu {
    let x = platform == "x";
    let mut same = MenuItem::new(SAME_PERSON).disabled(x).on_select(|_, _| {});
    if x {
        same = same.disabled_reason(X_SELF_LINK_REASON);
    }
    Menu::new()
        .label(name.to_string())
        .item(MenuItem::new(format!("About {name}")).on_select(|_, _| {}))
        .item(same)
        .item(MenuItem::new(MARK_AS_BOT).on_select(|_, _| {}))
}

fn row_body(view: &ManagerRow, pictures: &HashMap<String, Picture>) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .flex_none()
                        .size(px(22.))
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(11.))
                        .child(view.row.initials.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.))
                        .flex()
                        .flex_wrap()
                        .items_baseline()
                        .gap(px(6.))
                        .child(
                            div()
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_size(px(12.))
                                .child(view.row.author.clone()),
                        )
                        .child(div().text_size(px(11.)).child(view.row.platform_label))
                        .children(view.roles.iter().map(|role| {
                            div()
                                .text_size(px(11.))
                                .child((*role).to_string())
                                .into_any_element()
                        }))
                        .when(view.first_chat, |row| {
                            row.child(div().text_size(px(11.)).child("First chat"))
                        })
                        .when(view.mentioned, |row| {
                            row.child(div().text_size(px(11.)).child("@you"))
                        }),
                )
                .child(
                    div()
                        .flex_none()
                        .text_size(px(11.))
                        .child(view.time.clone()),
                ),
        )
        .when_some(view.reply.clone(), |col, reply| {
            col.child(div().text_size(px(11.)).child(reply))
        })
        .when_some(view.notice.clone(), |col, notice| {
            col.child(div().text_size(px(12.)).italic().child(notice))
        })
        // P198: emotes and GIFs as pictures (Electron CommentMessageBody).
        .child(chat_media::message_body(
            &view.pieces,
            &view.gifs,
            pictures,
            13.,
            96.,
        ))
        .into_any_element()
}

/// Offline shell samples so row + menu chrome is reviewable; the chat
/// driver replaces this list once live messages arrive.
pub fn shell_messages() -> Vec<Arc<LiveChatMessage>> {
    vec![
        Arc::new(LiveChatMessage {
            id: "shell-1".into(),
            session_id: "shell".into(),
            platform: "youtube".into(),
            author_name: "Ada".into(),
            message_text: "Ship it!".into(),
            event_type: "message".into(),
            received_at: "2026-11-25T00:00:00Z".into(),
            ..LiveChatMessage::default()
        }),
        Arc::new(LiveChatMessage {
            id: "shell-2".into(),
            session_id: "shell".into(),
            platform: "twitch".into(),
            author_name: "Bo".into(),
            message_text: "hello @orc".into(),
            event_type: "message".into(),
            received_at: "2026-11-25T00:01:00Z".into(),
            ..LiveChatMessage::default()
        }),
    ]
}
