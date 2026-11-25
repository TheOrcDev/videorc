//! My avatars (`buddy-library-section.tsx`, plan 170 D16): the official five
//! and the account's own, newest first, the active one marked. Use makes one
//! the avatar; Rename, Edit personality and Delete act on your own; Make it
//! Alive on one that does not move uses it, then opens the Alive creator.
//! Nothing toasts: the card and the look are the confirmation.

use gpui::{
    AnyElement, ColorSpace, Context, ImageSource, ObjectFit, SharedString, Window, div, img,
    linear_color_stop, linear_gradient, prelude::*, px,
};
use videorc_app_core::buddy::copy as words;
use videorc_app_core::buddy::library::{
    CONTEXT_MAX_CHARS, Card, CardKind, EditKind, NAME_MAX_CHARS, PERSONALITY_MAX_CHARS,
    alive_tag_distinguishes, busy_line, invitation_visible, library_view, save_offer, text_length,
};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::chrome::box_shadow;
use videorc_kit::dialog::{Dialog, DialogSize};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::Input;
use videorc_kit::kebab_menu::{KebabMenu, KebabMenuItem, KebabReveal};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::skeleton::Skeleton;
use videorc_kit::spinner::Spinner;
use videorc_kit::textarea::Textarea;
use videorc_kit::theme::{self, TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Shadow, Theme, radius, size, text};

use super::{AvatarScreen, pictures};

/// `Gallery`'s tracks (`components/page.tsx`): `repeat(auto-fill,
/// minmax(180px, 1fr))` with `gap-3`, so five official cards fill the
/// default window's row.
const CARD_MIN: f32 = 180.;
const GALLERY_GAP: f32 = 12.;
/// `MediaCard`'s `p-1.5` and its hairline, around the square picture.
const CARD_PADDING: f32 = 6.;

/// Each card's width across `width` (the section's content box): the row
/// shared out (`1fr`) among the tracks that fit, never under the minimum.
fn card_width(width: f32) -> f32 {
    if width <= CARD_MIN {
        return CARD_MIN;
    }
    let columns = ((width + GALLERY_GAP) / (CARD_MIN + GALLERY_GAP))
        .floor()
        .max(1.);
    ((width - GALLERY_GAP * (columns - 1.)) / columns)
        .floor()
        .max(CARD_MIN)
}

pub fn render_library(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let t = theme::resolve(None, window, cx);
    let library = screen.library.as_ref();
    let persona = screen.persona.as_ref();
    let view = library_view(library, persona);
    let busy = busy_line(library, persona.map(|persona| persona.name.as_str()));
    let offer = save_offer(library, persona, screen.library_alive());
    let invitation = invitation_visible(library, persona, screen.invitation_dismissed);
    let working = screen.working();
    let entity = cx.entity();
    // The section's content box: the page less its gutters.
    let card_w = card_width(screen.page_width - 2. * size::GUTTER);

    let mut actions = div().flex().items_center().gap(px(6.));
    if view.syncing {
        actions = actions.child(
            Spinner::new("avatar-library-syncing")
                .size(14.)
                .accessibility_label(words::LIBRARY_SYNCING),
        );
    }
    actions = actions.child(
        Button::new("avatar-library-new")
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .icon(IconName::Sparkle)
            .label(words::LIBRARY_NEW_BUDDY)
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| entity.update(cx, |screen, cx| screen.open_onboarding(cx))
            }),
    );

    let mut column = div().flex().flex_col().gap(px(16.));

    if invitation {
        let start = entity.clone();
        let dismiss = entity.clone();
        column = column.child(
            Alert::new("avatar-library-invitation")
                .glyph(IconName::Sparkle)
                .title(words::LIBRARY_INVITATION)
                .action(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(
                            Button::new("avatar-library-invitation-start")
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .label(words::LIBRARY_INVITATION_ACTION)
                                .on_click(move |_, _, cx| {
                                    start.update(cx, |screen, cx| screen.open_onboarding(cx))
                                }),
                        )
                        .child(
                            Button::new("avatar-library-invitation-dismiss")
                                .variant(ButtonVariant::Ghost)
                                .size(ButtonSize::IconXs)
                                .accessibility_label(words::LIBRARY_DISMISS)
                                .tooltip(words::LIBRARY_DISMISS)
                                .child(icon(IconName::X, 12., hsla(t.muted_foreground)))
                                .on_click(move |_, _, cx| {
                                    dismiss.update(cx, |screen, cx| screen.dismiss_invitation(cx))
                                }),
                        ),
                ),
        );
    }

    if let Some(name) = offer {
        let save = entity.clone();
        column = column.child(
            Alert::new("avatar-library-local-only")
                .glyph(IconName::UploadSimple)
                .title(words::library_local_only(&name))
                .action(
                    Button::new("avatar-library-save-to-library")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(words::LIBRARY_SAVE_TO_LIBRARY)
                        .disabled(working)
                        .on_click(move |_, _, cx| {
                            save.update(cx, |screen, cx| screen.save_to_library(cx))
                        }),
                ),
        );
    }

    if let Some(line) = busy {
        column = column.child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(Spinner::new("avatar-library-busy").size(14.))
                .child(div().min_w(px(0.)).truncate().child(line)),
        );
    }

    if let Some((id, name)) = view.picked_elsewhere.clone() {
        let use_it = entity.clone();
        column = column.child(
            Alert::new("avatar-library-picked-elsewhere")
                .glyph(IconName::ArrowsClockwise)
                .title(words::library_picked_elsewhere(&name))
                .action(
                    Button::new("avatar-library-picked-elsewhere-use")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(words::LIBRARY_USE)
                        .disabled(working)
                        .on_click(move |_, _, cx| {
                            let id = id.clone();
                            use_it.update(cx, |screen, cx| screen.use_avatar(id, cx))
                        }),
                ),
        );
    }

    let official_tag = alive_tag_distinguishes(&view.official);
    let mut official = gallery();
    for card in &view.official {
        official = official.child(card_element(
            screen,
            card,
            official_tag,
            working,
            card_w,
            t,
            cx,
        ));
    }
    column = column.child(group(
        words::LIBRARY_OFFICIAL,
        official.into_any_element(),
        t,
    ));

    let mine: Option<AnyElement> = if screen.loading {
        None
    } else if !view.signed_in {
        let sign_in = entity.clone();
        Some(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(12.))
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(words::LIBRARY_SIGNED_OUT),
                )
                .child(
                    Button::new("avatar-library-sign-in")
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .icon(IconName::SignIn)
                        .label(words::SIGN_IN)
                        .on_click(move |_, _, cx| {
                            sign_in.update(cx, |screen, cx| screen.sign_in(cx))
                        }),
                )
                .into_any_element(),
        )
    } else {
        match view.mine.as_ref() {
            None if view.syncing => Some(
                gallery()
                    .child(placeholder("avatar-library-loading-1", card_w))
                    .child(placeholder("avatar-library-loading-2", card_w))
                    .into_any_element(),
            ),
            // Listing failed: the error below says why, never "empty".
            None if view.error.is_some() => None,
            None => Some(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(words::LIBRARY_UNAVAILABLE)
                    .into_any_element(),
            ),
            Some(cards) if cards.is_empty() => Some(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.subtle))
                    .child(words::LIBRARY_EMPTY_MINE)
                    .into_any_element(),
            ),
            Some(cards) => {
                let tag = alive_tag_distinguishes(cards);
                let mut mine = gallery();
                for card in cards {
                    mine = mine.child(card_element(screen, card, tag, working, card_w, t, cx));
                }
                Some(mine.into_any_element())
            }
        }
    };
    column = column.child(group(
        words::LIBRARY_MINE,
        mine.unwrap_or_else(|| div().into_any_element()),
        t,
    ));

    // A failed sync or action is the section's (plan 174 G-7).
    let dialog_open = screen.edit_want_open || screen.delete_want_open;
    if !dialog_open && let Some(problem) = screen.shown_problem().or(view.error.clone()) {
        column = column.child(
            Alert::new("avatar-library-error")
                .variant(AlertVariant::Destructive)
                .title(problem),
        );
    }

    PanelSection::new("avatar-library")
        .title(words::LIBRARY_TITLE)
        .action(actions)
        .child(column)
        .into_any_element()
}

fn gallery() -> gpui::Div {
    div().flex().flex_wrap().gap(px(GALLERY_GAP))
}

/// A card still loading (`aspect-[3/4] rounded-row`).
fn placeholder(id: &'static str, width: f32) -> impl IntoElement {
    Skeleton::new(id)
        .w(px(width))
        .h(px(width * 4. / 3.))
        .rounded(px(radius::ROW))
}

/// "Official" / "Made by you" (`LibraryGroup`): an 11 px label over its cards.
fn group(label: &'static str, body: AnyElement, t: &Theme) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .px(px(2.))
                .type_scale(text::LABEL)
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(hsla(t.subtle))
                .child(label),
        )
        .child(body)
}

/// One avatar (`BuddyCard` on `BuddyPictureCard`): its idle pose, name and
/// what it is like, then Use and a menu with the rest. The active one is
/// marked by the card itself; "Alive" shows only where it tells cards apart.
fn card_element(
    screen: &AvatarScreen,
    card: &Card,
    alive_tag: bool,
    working: bool,
    width: f32,
    t: &Theme,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let entity = cx.entity();
    let picture: Option<ImageSource> = match (card.slug.as_deref(), card.idle_url.as_deref()) {
        (Some(slug), _) => pictures::official_idle(slug).map(Into::into),
        (None, Some(url)) => pictures::managed_path(&screen.user_data_dir, url).map(Into::into),
        (None, None) => None,
    };
    let key = card.id.replace([':', '/'], "-");

    // `aspect-square` inside the card's padding and hairline, on
    // `bg-foreground/[0.04]`.
    let frame = div()
        .relative()
        .w_full()
        .h(px(width - 2. * (CARD_PADDING + 1.)))
        .overflow_hidden()
        .rounded(px(radius::CHIP))
        .bg(hsla(with_alpha(t.foreground, 0.04)))
        .map(|frame| match picture {
            // `object-contain p-1.5`: GPUI's img ignores its own padding,
            // so a padded box holds it.
            Some(picture) => frame.child(
                div()
                    .size_full()
                    .p(px(6.))
                    .child(img(picture).size_full().object_fit(ObjectFit::Contain)),
            ),
            None => frame.child(
                Skeleton::new(SharedString::from(format!("avatar-card-picture-{key}"))).size_full(),
            ),
        })
        .when(card.busy, |frame| {
            frame.child(div().absolute().top(px(6.)).right(px(6.)).child(
                Spinner::new(SharedString::from(format!("avatar-card-busy-{key}"))).size(14.),
            ))
        });

    let mut title = div().flex().min_w(px(0.)).items_center().gap(px(6.)).child(
        div()
            .flex_1()
            .min_w(px(0.))
            .truncate()
            .text_size(px(14.))
            .line_height(px(20.))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(hsla(t.foreground))
            .child(card.name.clone()),
    );
    if alive_tag && card.alive {
        title = title.child(Badge::new(words::LIBRARY_ALIVE).variant(BadgeVariant::Outline));
    }
    if card.active {
        title = title.child(Badge::new(words::LIBRARY_ACTIVE).variant(BadgeVariant::Outline));
    }

    let mut words_block = div()
        .flex()
        .flex_col()
        .min_w(px(0.))
        .gap(px(2.))
        .px(px(2.))
        .child(title);
    if !card.subtitle.is_empty() {
        // `line-clamp-2 min-h-8`: a one-line tagline keeps two lines' room,
        // so the cards' words start level.
        words_block = words_block.child(
            div()
                .line_clamp(2)
                .text_ellipsis()
                .min_h(px(32.))
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(card.subtitle.clone()),
        );
    }
    if let Some(detail) = card.detail() {
        words_block = words_block.child(
            div()
                .line_clamp(3)
                .text_ellipsis()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(detail.to_string()),
        );
    }

    let menu = card.has_menu();
    let mut footer = div().flex().items_center().gap(px(4.));
    if !card.active {
        let id = card.id.clone();
        let use_it = entity.clone();
        footer = footer.child(
            div().flex_1().child(
                Button::new(SharedString::from(format!("avatar-card-use-{key}")))
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .label(words::LIBRARY_USE)
                    .disabled(working)
                    .on_click(move |_, _, cx| {
                        let id = id.clone();
                        use_it.update(cx, |screen, cx| screen.use_avatar(id, cx))
                    }),
            ),
        );
    } else if menu {
        footer = footer.child(div().flex_1());
    }
    if menu {
        footer = footer.child(
            KebabMenu::new(
                SharedString::from(format!("avatar-card-more-{key}")),
                card_menu(card, entity.clone()),
            )
            .label(words::library_more_label(&card.name))
            .disabled(working)
            .reveal(KebabReveal::Always),
        );
    }

    // `MediaCard`: the row radius, a 4% fill and a hairline; the one in use
    // is `selected`, the chrome plate with a brighter rim, never a colour.
    div()
        .id(SharedString::from(format!("avatar-card-{key}")))
        .w(px(width))
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(6.))
        .p(px(CARD_PADDING))
        .rounded(px(radius::ROW))
        .border_1()
        .map(|element| {
            if card.active {
                element
                    .border_color(hsla(with_alpha(t.foreground, 0.25)))
                    .bg(linear_gradient(
                        180.,
                        linear_color_stop(hsla(t.chrome_plate_top), 0.),
                        linear_color_stop(hsla(t.chrome_plate_bottom), 1.),
                    )
                    .color_space(ColorSpace::Oklab))
                    .shadow(plate_shadows(t))
            } else {
                element
                    .border_color(hsla(t.border))
                    .bg(hsla(with_alpha(t.foreground, 0.04)))
            }
        })
        .child(frame)
        .child(words_block)
        .when(!card.active || menu, |element| element.child(footer))
        .into_any_element()
}

/// `chrome-plate`'s light and shade: a 1 px top line and its rim, inset.
fn plate_shadows(t: &Theme) -> Vec<gpui::BoxShadow> {
    [
        Shadow {
            inset: true,
            x: 0.,
            y: 1.,
            blur: 0.,
            spread: 0.,
            color: t.chrome_plate_hi,
        },
        Shadow {
            inset: true,
            x: 0.,
            y: 0.,
            blur: 0.,
            spread: 1.,
            color: t.chrome_plate_rim,
        },
    ]
    .iter()
    .map(box_shadow)
    .collect()
}

/// Rename and Edit personality for your own; Make it Alive where it does
/// not move; Delete last, in its own group.
fn card_menu(card: &Card, entity: gpui::Entity<AvatarScreen>) -> Vec<KebabMenuItem> {
    let mut items = Vec::new();
    if card.kind == CardKind::Mine {
        let (rename, id) = (entity.clone(), card.id.clone());
        items.push(
            KebabMenuItem::new("rename", words::LIBRARY_RENAME, move |window, cx| {
                let id = id.clone();
                rename.update(cx, |screen, cx| {
                    screen.open_edit(EditKind::Rename, id, window, cx)
                })
            })
            .icon(|ink| icon(IconName::PencilSimple, 16., ink)),
        );
        let (edit, id) = (entity.clone(), card.id.clone());
        items.push(
            KebabMenuItem::new(
                "edit-personality",
                words::LIBRARY_EDIT_PERSONALITY,
                move |window, cx| {
                    let id = id.clone();
                    edit.update(cx, |screen, cx| {
                        screen.open_edit(EditKind::Personality, id, window, cx)
                    })
                },
            )
            .icon(|ink| icon(IconName::NotePencil, 16., ink)),
        );
    }
    if card.can_make_alive {
        let (alive, id, active) = (entity.clone(), card.id.clone(), card.active);
        items.push(
            KebabMenuItem::new("make-alive", words::LIBRARY_MAKE_ALIVE, move |_, cx| {
                let id = id.clone();
                alive.update(cx, |screen, cx| screen.make_alive(id, active, cx))
            })
            .icon(|ink| icon(IconName::Sparkle, 16., ink)),
        );
    }
    if card.kind == CardKind::Mine {
        let (delete, id, name) = (entity, card.id.clone(), card.name.clone());
        items.push(
            KebabMenuItem::new("delete", words::LIBRARY_DELETE, move |_, cx| {
                let (id, name) = (id.clone(), name.clone());
                delete.update(cx, |screen, cx| screen.ask_delete(id, name, cx))
            })
            .icon(|ink| icon(IconName::Trash, 16., ink))
            .destructive(true),
        );
    }
    items
}

/// Rename (sm) or Edit personality with About you (lg). Save is on only
/// when something changed and every field is in bounds.
pub fn edit_dialog(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let t = theme::resolve(None, window, cx);
    let Some(edit) = screen.edit.as_ref() else {
        return div().into_any_element();
    };
    let rename = edit.form_kind == EditKind::Rename;
    let saving = screen.pending == Some(super::Pending::Update);
    let can_save = edit.form(cx).update_params().is_some();
    let problem = if edit.refused {
        screen.problem.clone()
    } else {
        None
    };
    let entity = cx.entity();
    let cancel = entity.clone();
    let field_label = |label: &'static str| {
        div()
            .text_size(px(14.))
            .line_height(px(20.))
            .font_weight(gpui::FontWeight::MEDIUM)
            .child(label)
    };
    let help = |line: SharedString| {
        div()
            .type_scale(text::META)
            .text_color(hsla(t.muted_foreground))
            .child(line)
    };

    let mut body = div().flex().flex_col().gap(px(20.));
    if rename {
        let name = edit.name.read(cx).value();
        body = body.child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(field_label(words::NAME_LABEL))
                .child(
                    Input::new("avatar-library-name", &edit.name)
                        .accessibility_label(words::NAME_LABEL)
                        .invalid(text_length(name.trim()) > NAME_MAX_CHARS),
                )
                .child(help(words::NAME_HELP.into())),
        );
    } else {
        let personality = text_length(&edit.personality.read(cx).value());
        let context = text_length(&edit.context.read(cx).value());
        body = body
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(field_label(words::PERSONALITY_LABEL))
                    .child(
                        Textarea::new("avatar-library-personality", &edit.personality)
                            .accessibility_label(words::PERSONALITY_LABEL)
                            .invalid(personality > PERSONALITY_MAX_CHARS),
                    )
                    .child(div().flex().justify_end().child(help(
                        words::counter(personality, PERSONALITY_MAX_CHARS).into(),
                    ))),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(field_label(words::ABOUT_LABEL))
                    .child(
                        Textarea::new("avatar-library-about", &edit.context)
                            .accessibility_label(words::ABOUT_LABEL)
                            .invalid(context > CONTEXT_MAX_CHARS),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(help(words::ABOUT_HELP.into()))
                            .child(div().flex_1())
                            .child(help(words::counter(context, CONTEXT_MAX_CHARS).into())),
                    ),
            );
    }
    if let Some(problem) = problem {
        body = body.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.destructive))
                .child(problem),
        );
    }

    let title = if rename {
        words::LIBRARY_RENAME
    } else {
        words::LIBRARY_EDIT_PERSONALITY
    };
    Dialog::new("avatar-library-edit", &screen.edit_handle, title)
        .size(if rename {
            DialogSize::Sm
        } else {
            DialogSize::Lg
        })
        .child(body)
        .footer(
            Button::new("avatar-library-edit-cancel")
                .variant(ButtonVariant::Ghost)
                .label(words::LIBRARY_CANCEL)
                .disabled(saving)
                .on_click(move |_, _, cx| cancel.update(cx, |screen, cx| screen.close_edit(cx))),
        )
        .footer(
            Button::new("avatar-library-save")
                .label(if saving { words::SAVING } else { words::SAVE })
                .disabled(!can_save || saving)
                .on_click(move |_, _, cx| entity.update(cx, |screen, cx| screen.save_edit(cx))),
        )
        .into_any_element()
}

/// "Delete {name}?" (the confirm recipe): it closes only once the backend
/// accepted; a refusal shows inside it.
pub fn delete_dialog(
    screen: &AvatarScreen,
    window: &mut Window,
    cx: &mut Context<AvatarScreen>,
) -> AnyElement {
    let t = theme::resolve(None, window, cx);
    let Some(target) = screen.delete.as_ref() else {
        return div().into_any_element();
    };
    let deleting = screen.pending == Some(super::Pending::Delete);
    let problem = if target.refused && !deleting {
        screen.problem.clone()
    } else {
        None
    };
    let entity = cx.entity();
    let cancel = entity.clone();
    let mut dialog = Dialog::new(
        "avatar-library-delete",
        &screen.delete_handle,
        words::library_delete_title(&target.name),
    )
    .description(words::LIBRARY_DELETE_BODY)
    .close_button(false);
    if let Some(problem) = problem {
        dialog = dialog.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.destructive))
                .child(problem),
        );
    }
    dialog
        .footer(
            Button::new("avatar-library-delete-cancel")
                .variant(ButtonVariant::Ghost)
                .label(words::LIBRARY_CANCEL)
                .disabled(deleting)
                .on_click(move |_, _, cx| cancel.update(cx, |screen, cx| screen.cancel_delete(cx))),
        )
        .footer(
            Button::new("avatar-library-delete-confirm")
                .variant(ButtonVariant::Destructive)
                .label(if deleting {
                    words::DELETING
                } else {
                    words::LIBRARY_DELETE
                })
                .disabled(deleting)
                .on_click(move |_, _, cx| {
                    entity.update(cx, |screen, cx| screen.confirm_delete(cx))
                }),
        )
        .into_any_element()
}
