//! The Studio Camera row's Background popover body (P257–P262, P587) and
//! its tile grid. Words and picks are app-core's `camera_background_view` —
//! the same rules Scene ⌘3's Background inspector (#2063) uses
//! (`background_section_view`, `choices`, `background_for_choice`). The
//! tiles mirror Scene's `background_tile` (MediaCard / Orc art wait on kit).

use gpui::{AnyElement, App, SharedString, Window, div, prelude::*, px};
use videorc_app_core::studio::camera_background_view::{
    BLUR_CAVEAT, CHOOSE_COMPACT_LABEL, CHOOSE_IMAGE_LABEL, Choice, ChoiceId, Group, LABEL,
    LOCK_LINE, SETTINGS_BUTTON, WHAT_VIEWERS_SEE_LABEL,
};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::section_label::SectionLabel;
use videorc_kit::theme::{TypeScale, faded_over, hsla};
use videorc_kit::tokens::{Theme, radius, text};

/// One background tile (Scene's `background_tile` shape).
struct Tile {
    id: SharedString,
    label: SharedString,
    selected: bool,
    disabled: bool,
    mark: Option<IconName>,
}

/// Draws one tile. `on_pick` runs when it is free and clicked.
fn background_tile(
    tile: Tile,
    t: &Theme,
    on_pick: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let Tile {
        id,
        label,
        selected,
        disabled,
        mark,
    } = tile;
    let ground = t.glass_solid;
    let fade = |color| {
        if disabled {
            faded_over(color, ground, 0.5)
        } else {
            color
        }
    };
    let rim = if selected { t.ring } else { t.border };
    let ink = if selected {
        t.foreground
    } else {
        t.muted_foreground
    };
    let mut face = div()
        .id(id)
        .flex()
        .flex_col()
        .gap(px(4.))
        .min_w_0()
        .child(
            div()
                .w_full()
                .aspect_ratio(16. / 10.)
                .rounded(px(radius::ROW))
                .border_1()
                .border_color(hsla(fade(rim)))
                .bg(hsla(fade(t.muted)))
                .flex()
                .items_center()
                .justify_center()
                .children(mark.map(|mark| icon(mark, 16., hsla(fade(t.muted_foreground))))),
        )
        .child(
            div()
                .type_scale(text::LABEL)
                .text_color(hsla(fade(ink)))
                .child(label),
        );
    if !disabled {
        face = face.on_click(move |_, window, cx| on_pick(window, cx));
    }
    face.into_any_element()
}

/// Grouped tiles for the popover or the Choose-image dialog.
pub fn tiles_grid(
    choices: &[Choice],
    selected: Option<&ChoiceId>,
    choose_image: bool,
    compact_choose: bool,
    columns: u16,
    t: &Theme,
    on_choose: impl Fn(ChoiceId, &mut Window, &mut App) + Clone + 'static,
    on_choose_image: impl Fn(&mut Window, &mut App) + Clone + 'static,
) -> AnyElement {
    let groups = [Group::Blur, Group::Images, Group::Screens];
    let mut column = div().flex().flex_col().gap(px(8.));
    for group in groups {
        let in_group: Vec<&Choice> = choices
            .iter()
            .filter(|choice| choice.group == group)
            .collect();
        let show_choose = choose_image && group == Group::Images;
        if in_group.is_empty() && !show_choose {
            continue;
        }
        let mut grid = div().grid().grid_cols(columns).gap(px(6.));
        for choice in in_group {
            let id = choice.id.clone();
            let pick = on_choose.clone();
            grid = grid.child(background_tile(
                Tile {
                    id: SharedString::from(format!("camera-background-{}", choice.id.as_string())),
                    label: SharedString::from(choice.label.clone()),
                    selected: selected == Some(&choice.id),
                    disabled: choice.disabled_reason.is_some(),
                    mark: None,
                },
                t,
                move |window, cx| pick(id.clone(), window, cx),
            ));
        }
        if show_choose {
            let open = on_choose_image.clone();
            grid = grid.child(background_tile(
                Tile {
                    id: SharedString::from("camera-background-choose-image"),
                    label: SharedString::from(if compact_choose {
                        CHOOSE_COMPACT_LABEL
                    } else {
                        CHOOSE_IMAGE_LABEL
                    }),
                    selected: false,
                    disabled: false,
                    mark: Some(IconName::ImageSquare),
                },
                t,
                move |window, cx| open(window, cx),
            ));
        }
        column = column.child(SectionLabel::new(group.label())).child(grid);
    }
    column.into_any_element()
}

/// A flat image-only grid for the Choose an image dialog (no group labels).
pub fn image_tiles(
    choices: &[Choice],
    selected: Option<&ChoiceId>,
    t: &Theme,
    on_choose: impl Fn(ChoiceId, &mut Window, &mut App) + Clone + 'static,
) -> AnyElement {
    let mut grid = div().grid().grid_cols(4).gap(px(8.));
    for choice in choices {
        let id = choice.id.clone();
        let pick = on_choose.clone();
        grid = grid.child(background_tile(
            Tile {
                id: SharedString::from(format!(
                    "camera-background-image-{}",
                    choice.id.as_string()
                )),
                label: SharedString::from(choice.label.clone()),
                selected: selected == Some(&choice.id),
                disabled: choice.disabled_reason.is_some(),
                mark: Some(IconName::ImageSquare),
            },
            t,
            move |window, cx| pick(id.clone(), window, cx),
        ));
    }
    grid.into_any_element()
}

/// P257–P262: the popover body (viewer, grouped tiles, blur caveat, lock).
pub fn picker_body(
    background: &serde_json::Value,
    choices: &[Choice],
    selected: Option<&ChoiceId>,
    value_label: &str,
    t: &Theme,
    on_choose: impl Fn(ChoiceId, &mut Window, &mut App) + Clone + 'static,
    on_choose_image: impl Fn(&mut Window, &mut App) + Clone + 'static,
    on_settings: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let blur = background.get("mode").and_then(|mode| mode.as_str()) == Some("blur");
    // P257: live "What viewers see". The effect-stage frame lease is not on
    // the Studio inspector yet (Scene's MediaCard / Orc art wait too), so
    // the box names the pick until the preview frame lands.
    let viewer = div()
        .flex()
        .flex_col()
        .gap(px(4.))
        .child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(WHAT_VIEWERS_SEE_LABEL),
        )
        .child(
            div()
                .w_full()
                .aspect_ratio(16. / 9.)
                .rounded(px(radius::ROW))
                .border_1()
                .border_color(hsla(t.border))
                .bg(hsla(t.muted))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .type_scale(text::LABEL)
                        .text_color(hsla(t.muted_foreground))
                        .child(value_label.to_string()),
                ),
        );

    let mut body = div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .type_scale(text::SECTION)
                .text_color(hsla(t.foreground))
                .child(LABEL),
        )
        .child(viewer)
        .child(tiles_grid(
            choices,
            selected,
            true,
            true,
            3,
            t,
            on_choose,
            on_choose_image,
        ));
    if blur {
        body = body.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(BLUR_CAVEAT),
        );
    }
    body.child(
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .border_t_1()
            .border_color(hsla(t.border))
            .pt(px(10.))
            .type_scale(text::META)
            .text_color(hsla(t.muted_foreground))
            .child(icon(IconName::LockKey, 14., hsla(t.muted_foreground)))
            .child(div().min_w_0().flex_1().child(LOCK_LINE))
            .child(
                Button::new("camera-background-settings")
                    .label(SETTINGS_BUTTON)
                    .size(ButtonSize::Xs)
                    .variant(ButtonVariant::Ghost)
                    .on_click(move |_, window, cx| on_settings(window, cx)),
            ),
    )
    .into_any_element()
}

/// The Background NavigableRow trigger's 16 px thumbnail square.
pub fn thumbnail(t: &Theme) -> AnyElement {
    div()
        .size(px(16.))
        .rounded(px(radius::CHIP))
        .bg(hsla(t.muted))
        .border_1()
        .border_color(hsla(t.border))
        .flex()
        .items_center()
        .justify_center()
        .child(icon(IconName::ImageSquare, 10., hsla(t.muted_foreground)))
        .into_any_element()
}
