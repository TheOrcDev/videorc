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
    ChatPlatform,
    avatar::Avatar,
    badge::{Badge, BadgeVariant},
    context_menu::ContextMenu,
    dropdown_menu::{Menu, MenuItem},
    kebab_menu::{KebabMenu, KebabMenuItem, KebabReveal},
    platform_glyph::{PlatformMark, VerifiedCheck, VerifiedKind},
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

    let body = row_body(&view, &message.platform, live, pictures);
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
        .group(SharedString::from(format!("chat-row-{}", view.row.id)))
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

/// `CommentContent` at the Stream Manager's comfortable density: the 40 px
/// avatar (picture, else the monogram), then the name line closed by the
/// 20 px platform mark on the far right, then the words at 15 px.
fn row_body(
    view: &ManagerRow,
    platform: &str,
    live: bool,
    pictures: &HashMap<String, Picture>,
) -> AnyElement {
    // While live the time waits for the pointer, like the row's ⋯ (plan 057,
    // D3): a clock on every row is noise mid-stream.
    let group = SharedString::from(format!("chat-row-{}", view.row.id));
    let picture = view
        .row
        .avatar_url
        .as_ref()
        .and_then(|url| pictures.get(url).and_then(Picture::ready));
    let avatar = match picture {
        Some(image) => Avatar::new(view.row.initials.clone()).lg().image(image),
        None => Avatar::new(view.row.initials.clone()).lg(),
    };
    let name_line = div()
        .w_full()
        .min_w(px(0.))
        .flex()
        .items_center()
        .gap(px(6.))
        .child(
            div()
                .min_w(px(0.))
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_size(px(14.))
                .line_height(px(20.))
                .child(view.row.author.clone()),
        )
        // X's verified check after the name (`VerifiedCheck`: X's own badge).
        .children(view.verified.map(|(kind, _)| {
            VerifiedCheck::new(
                SharedString::from(format!("verified-{}", view.row.id)),
                match kind {
                    "business" => VerifiedKind::Business,
                    "government" => VerifiedKind::Government,
                    _ => VerifiedKind::Blue,
                },
            )
        }))
        .children(
            view.roles
                .iter()
                .map(|role| Badge::new(*role).variant(BadgeVariant::Outline)),
        )
        .when(view.first_chat, |line| {
            line.child(Badge::new("First chat").variant(BadgeVariant::Outline))
        })
        .when(view.mentioned, |line| line.child(Badge::new("@you")))
        .child(div().flex_1())
        .when(!view.time.is_empty(), |line| {
            line.child(
                div()
                    .flex_none()
                    .text_size(px(11.))
                    .opacity(0.7)
                    .when(live, |time| {
                        time.opacity(0.)
                            .group_hover(group.clone(), |style| style.opacity(0.7))
                    })
                    .child(view.time.clone()),
            )
        })
        // The platform mark closes the line on the far right (plan 165).
        .child(
            div()
                .flex_none()
                .ml(px(4.))
                .child(PlatformMark::new(chat_platform(platform)).size(20.)),
        );
    div()
        .w_full()
        .flex()
        .items_start()
        .gap(px(12.))
        .child(div().flex_none().mt(px(2.)).child(avatar))
        .child(
            div()
                .flex_1()
                .min_w(px(0.))
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(name_line)
                .when_some(view.reply.clone(), |col, reply| {
                    col.child(div().text_size(px(12.)).opacity(0.7).child(reply))
                })
                .when_some(view.notice.clone(), |col, notice| {
                    col.child(div().text_size(px(15.)).italic().child(notice))
                })
                // P198: emotes and GIFs as pictures (Electron CommentMessageBody).
                .child(chat_media::message_body(
                    &view.pieces,
                    &view.gifs,
                    pictures,
                    15.,
                    96.,
                )),
        )
        .into_any_element()
}

/// `ChatPlatformIcon`'s platform: the backend's id, anything else custom.
pub(super) fn chat_platform(platform: &str) -> ChatPlatform {
    match platform {
        "youtube" => ChatPlatform::Youtube,
        "twitch" => ChatPlatform::Twitch,
        "kick" => ChatPlatform::Kick,
        "x" => ChatPlatform::X,
        "facebook" => ChatPlatform::Facebook,
        "tiktok" => ChatPlatform::Tiktok,
        "instagram" => ChatPlatform::Instagram,
        _ => ChatPlatform::Custom,
    }
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
