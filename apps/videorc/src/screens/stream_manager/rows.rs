//! Chat rows and their menus (P966–P969): ManagerRow chrome, the ⋯ menu from
//! `pane::row_menu`, and the person right-click menu (About / Same person /
//! Mark as bot). Actions are stubs until the chat / community drivers land.

use std::sync::Arc;

use gpui::{AnyElement, IntoElement, SharedString, div, prelude::*, px};
use videorc_app_core::chat::highlight::RowHighlight;
use videorc_app_core::chat::model::LiveChatMessage;
use videorc_app_core::stream_manager::pane::{
    RowAction, RowMenuInputs, copy_text, row_menu, row_menu_label,
};
use videorc_app_core::stream_manager::rows::ManagerRow;
use videorc_kit::{
    context_menu::ContextMenu,
    dropdown_menu::{Menu, MenuItem},
    kebab_menu::{KebabMenu, KebabMenuItem, KebabReveal},
    tokens::radius,
};

/// Person-menu words (Electron `ChatPersonMenu`).
const SAME_PERSON: &str = "Same person as…";
const MARK_AS_BOT: &str = "Mark as bot";
const X_SELF_LINK_REASON: &str = "X accounts can't be linked as the same person yet.";

/// One chat row: body + ⋯ menu, wrapped in the person right-click menu.
pub fn chat_row(message: &Arc<LiveChatMessage>, live: bool) -> AnyElement {
    let view = ManagerRow::new(message, RowHighlight::default(), live, &[]);
    let inputs = RowMenuInputs {
        highlightable: view.row.highlightable,
        on_stream: false,
        can_reply: true,
        removable: false,
        remove_reason: Some("Reconnect to remove messages."),
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
            let mut kebab = KebabMenuItem::new(id, item.label, move |_, _| {
                let _ = (&action, &text);
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

    let body = row_body(&view);
    let row = div()
        .id(SharedString::from(format!("chat-row-{}", view.row.id)))
        .w_full()
        .flex()
        .items_start()
        .gap(px(2.))
        .px(px(4.))
        .py(px(4.))
        .rounded(px(radius::CHIP))
        .child(div().flex_1().min_w(px(0.)).child(body))
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

fn row_body(view: &ManagerRow) -> AnyElement {
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
        .child(div().text_size(px(13.)).child(view.row.words.clone()))
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
