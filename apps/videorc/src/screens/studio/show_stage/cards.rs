//! The Show stage's cards (plan 252, `show-stage.tsx` StageLayouts /
//! StageScreens): `SceneCard size="sm"` over `MediaCard`, with the layout
//! diagram (`stage-layout-thumb.tsx`) or the shared screen
//! (`room-person.tsx` ScreenThumb) as its picture.
//!
//! A compact card (`scene-card.tsx`, `compact`): the card's `p-2` button
//! holds the picture well, the name (12 px medium, up to two lines) and an
//! optional quiet meta line, `gap-1.5`. The one in use wears MediaCard's
//! chrome plate, a 2 px ring in the text's tone 2 px off its picture, and a
//! check badge on the picture's corner. A disabled card fades only its
//! picture (`disabled && 'opacity-50'` on the well); its words stay.

use std::sync::Arc;

use gpui::{
    AnyElement, App, ElementId, Image, ObjectFit, SharedString, Window, div, img, prelude::*, px,
    relative,
};
use videorc_app_core::guests::wire::DrawnStageLayout;
use videorc_kit::badge::Badge;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::media_card::MediaCard;
use videorc_kit::theme::{TypeScale, faded_over, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, text};
use videorc_kit::tooltip::tooltip;

/// `grid grid-cols-2 gap-2 @min-[30rem]/show-stage:grid-cols-4`: four across
/// once the Show stage is 480 px wide, two below.
pub const CARD_GRID_WIDE_PX: f32 = 480.;

pub fn card_columns(stage_width: f32) -> u16 {
    if stage_width >= CARD_GRID_WIDE_PX {
        4
    } else {
        2
    }
}

/// One compact scene card.
pub struct StageCard {
    pub id: ElementId,
    pub thumb: AnyElement,
    pub label: SharedString,
    pub meta: Option<SharedString>,
    pub selected: bool,
    pub disabled: bool,
    /// The card's own reason while disabled, on hover.
    pub disabled_reason: Option<SharedString>,
}

impl StageCard {
    pub fn render(
        self,
        t: &Theme,
        on_select: impl Fn(&mut Window, &mut App) + 'static,
    ) -> AnyElement {
        let StageCard {
            id,
            thumb,
            label,
            meta,
            selected,
            disabled,
            disabled_reason,
        } = self;
        let foreground = hsla(t.foreground);
        // The well: the ring a 2 px gap off the picture on the one in use
        // (`outline-2 outline-offset-2 outline-foreground`), the picture at
        // half strength on a disabled card.
        let well = div()
            .relative()
            .min_w_0()
            .rounded(px(radius::CHIP))
            .child(div().when(disabled, |well| well.opacity(0.5)).child(thumb))
            .when(selected, |well| {
                well.child(
                    div()
                        .absolute()
                        .top(px(-4.))
                        .left(px(-4.))
                        .right(px(-4.))
                        .bottom(px(-4.))
                        .rounded(px(radius::CHIP + 4.))
                        .border_2()
                        .border_color(foreground),
                )
            });
        let body = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(px(6.))
            .p(px(8.))
            .child(well)
            .child(
                div()
                    .min_w_0()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(foreground)
                    .line_clamp(2)
                    .child(label.clone()),
            )
            .children(meta.map(|meta| {
                div()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(hsla(t.muted_foreground))
                    .child(meta)
            }));
        // The check on the picture's corner (`absolute top-1 left-1 px-1`).
        let check = selected.then(|| {
            div()
                .absolute()
                .top(px(4.))
                .left(px(4.))
                .child(Badge::new("").icon(icon(IconName::CheckBold, 12., foreground)))
        });
        let card = MediaCard::new(id.clone())
            .selected(selected)
            .interactive(!selected && !disabled)
            .accessibility_label(label)
            .relative()
            .h_full()
            .child(body)
            .children(check);
        // A disabled card is not a button and takes no hover; its reason
        // shows on hover (`DisabledReason`). Its picture is the only fade.
        let card = if disabled {
            card.into_any_element()
        } else {
            card.on_click(move |_, window, cx| on_select(window, cx))
                .into_any_element()
        };
        let mut host = div()
            .id(SharedString::from(format!("{id}/host")))
            .min_w_0()
            .child(card);
        if let (true, Some(reason)) = (disabled, disabled_reason) {
            host = host.tooltip(tooltip(reason));
        }
        host.into_any_element()
    }
}

/// `StageLayoutThumb`: the arrangement as boxes, never a live picture.
/// People are the stronger boxes (`bg-foreground/30`), a shared screen the
/// lighter one (`/10`), the people a spotlight sets aside between (`/15`).
pub fn stage_layout_thumb(layout: DrawnStageLayout, t: &Theme) -> AnyElement {
    let person = hsla(with_alpha(t.foreground, 0.30));
    let screen = hsla(with_alpha(t.foreground, 0.10));
    let other = hsla(with_alpha(t.foreground, 0.15));
    // `inset-1` / `top-1` etc.: 4 px from the frame's inside edge.
    const IN: f32 = 4.;
    let boxed = |color| div().absolute().rounded(px(2.)).bg(color);
    let boxes: Vec<gpui::Div> = match layout {
        DrawnStageLayout::Solo => vec![
            boxed(person)
                .top(px(IN))
                .bottom(px(IN))
                .left(px(IN))
                .right(px(IN)),
        ],
        DrawnStageLayout::SideBySide => vec![
            boxed(person)
                .top(relative(0.26))
                .bottom(relative(0.26))
                .left(px(IN))
                .w(relative(0.46)),
            boxed(person)
                .top(relative(0.26))
                .bottom(relative(0.26))
                .right(px(IN))
                .w(relative(0.46)),
        ],
        DrawnStageLayout::ScreenPeople => vec![
            boxed(screen)
                .top(px(IN))
                .bottom(px(IN))
                .left(px(IN))
                .w(relative(0.68)),
            boxed(person)
                .top(px(IN))
                .right(px(IN))
                .h(relative(0.28))
                .w(relative(0.24)),
            boxed(person)
                .top(relative(0.36))
                .right(px(IN))
                .h(relative(0.28))
                .w(relative(0.24)),
        ],
        DrawnStageLayout::TwoScreens => vec![
            boxed(screen)
                .top(px(IN))
                .left(px(IN))
                .h(relative(0.50))
                .w(relative(0.47)),
            boxed(screen)
                .top(px(IN))
                .right(px(IN))
                .h(relative(0.50))
                .w(relative(0.47)),
            boxed(person)
                .bottom(px(IN))
                .left(relative(0.23))
                .h(relative(0.30))
                .w(relative(0.25)),
            boxed(person)
                .bottom(px(IN))
                .right(relative(0.23))
                .h(relative(0.30))
                .w(relative(0.25)),
        ],
        DrawnStageLayout::Spotlight => vec![
            boxed(person)
                .top(px(IN))
                .left(relative(0.16))
                .h(relative(0.62))
                .w(relative(0.68)),
            boxed(other)
                .bottom(px(IN))
                .left(relative(0.26))
                .h(relative(0.20))
                .w(relative(0.22)),
            boxed(other)
                .bottom(px(IN))
                .right(relative(0.26))
                .h(relative(0.20))
                .w(relative(0.22)),
        ],
    };
    // `relative aspect-video w-full overflow-hidden rounded-chip border
    // bg-gradient-to-br from-muted/40 to-muted/70`, each stop over the card's
    // 4% ground so GPUI's one fill reads as the layered CSS.
    let ground = faded_over(t.foreground, t.glass_solid, 0.04);
    let top = faded_over(t.muted, ground, 0.40);
    let bottom = faded_over(t.muted, ground, 0.70);
    div()
        .relative()
        .w_full()
        .aspect_ratio(16. / 9.)
        .overflow_hidden()
        .rounded(px(radius::CHIP))
        .border_1()
        .border_color(hsla(t.border))
        .bg(gpui::linear_gradient(
            135.,
            gpui::linear_color_stop(hsla(top), 0.),
            gpui::linear_color_stop(hsla(bottom), 1.),
        ))
        .children(boxes)
        .into_any_element()
}

/// `ScreenThumb`: a shared screen, live, in a 16:9 frame on the video
/// ground; the Display glyph until a picture arrives.
pub fn screen_thumb(frame: Option<Arc<Image>>, t: &Theme) -> AnyElement {
    div()
        .relative()
        .w_full()
        .aspect_ratio(16. / 9.)
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(radius::CHIP))
        .bg(hsla(t.video_ground))
        .map(|thumb| match frame {
            Some(frame) => thumb.child(img(frame).size_full().object_fit(ObjectFit::Cover)),
            None => thumb.child(icon(IconName::Monitor, 20., hsla(t.video_ground_muted))),
        })
        .into_any_element()
}

/// `text-meta text-muted-foreground` line under a card grid, `px-1`.
pub fn reasons_line(id: &'static str, words: String, t: &Theme) -> AnyElement {
    div()
        .id(id)
        .px(px(4.))
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(words)
        .into_any_element()
}
