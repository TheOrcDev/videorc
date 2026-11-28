//! The Studio Camera row's Background popover body (P257–P262, P587) and
//! its tile grid. Words and picks are app-core's `camera_background_view` —
//! the same rules Scene ⌘3's Background inspector (#2063) uses
//! (`background_section_view`, `choices`, `background_for_choice`). Every
//! tile is the kit's MediaCard with the Orc art on it
//! (`camera-background-tiles.tsx`, `camera-background-orc-art.tsx`); Scene's
//! `background_tile` draws the same card and name ([`tile_card`],
//! [`tile_label`]).

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use gpui::{
    AnyElement, App, Div, FontWeight, Image, ImageFormat, ImageSource, ObjectFit, RenderImage,
    SharedString, Window, div, img, prelude::*, px,
};
use videorc_app_core::studio::camera_background_art::{Art, BlurStrength, choice_art};
use videorc_app_core::studio::camera_background_view::{
    BLUR_CAVEAT, CHOOSE_COMPACT_LABEL, CHOOSE_IMAGE_LABEL, Choice, ChoiceId, Group, LABEL,
    SETTINGS_BUTTON, WHAT_VIEWERS_SEE_LABEL, lock_line,
};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::media_card::MediaCard;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::theme::{TypeScale, faded_over, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, text};

/// The grouped grid's columns in the 320 px popover (`grid-cols-4`).
const POPOVER_COLUMNS: u16 = 4;

// The Orc (orc.pictures, Videorc category) and his studio, sharp and blurred
// ahead of time: `apps/videorc/assets/camera-background/README.md`.
const ORC: &[u8] = include_bytes!("../../../assets/camera-background/orc.webp");
const ROOM: &[u8] = include_bytes!("../../../assets/camera-background/orc-room.webp");
const ROOM_SLIGHT_BLUR: &[u8] =
    include_bytes!("../../../assets/camera-background/orc-room-slight-blur.webp");
const ROOM_STRONG_BLUR: &[u8] =
    include_bytes!("../../../assets/camera-background/orc-room-strong-blur.webp");

/// The art's built-in pictures, made once.
struct OrcPictures {
    orc: Arc<Image>,
    room: Arc<Image>,
    slight_blur: Arc<Image>,
    strong_blur: Arc<Image>,
}

fn orc_pictures() -> &'static OrcPictures {
    static PICTURES: OnceLock<OrcPictures> = OnceLock::new();
    let webp = |bytes: &[u8]| Arc::new(Image::from_bytes(ImageFormat::Webp, bytes.to_vec()));
    PICTURES.get_or_init(|| OrcPictures {
        orc: webp(ORC),
        room: webp(ROOM),
        slight_blur: webp(ROOM_SLIGHT_BLUR),
        strong_blur: webp(ROOM_STRONG_BLUR),
    })
}

/// `CameraBackgroundOrcArt`: what the camera looks like on stream with a
/// pick. One cutout of the Orc over one layer: his own studio, sharp for Off
/// and blurred for a blur (the room only; the Orc stays sharp, like the real
/// effect), the picture itself, or the screen colour. It fills its box
/// (`relative`, 16:10 tiles, the 16:9 viewer, the 16 px trigger), cropped
/// like `object-cover`, with `corner` as its radius. These are on-stream
/// pixels, so they don't follow the app theme.
pub fn orc_art(art: &Art, corner: f32) -> AnyElement {
    let pictures = orc_pictures();
    let fill = |source: ImageSource| {
        img(source)
            .absolute()
            .inset_0()
            .size_full()
            .object_fit(ObjectFit::Cover)
            .rounded(px(corner))
    };
    let layer = match art {
        Art::Room => fill(pictures.room.clone().into()).into_any_element(),
        Art::Blur(BlurStrength::Slight) => {
            fill(pictures.slight_blur.clone().into()).into_any_element()
        }
        Art::Blur(BlurStrength::Strong) => {
            fill(pictures.strong_blur.clone().into()).into_any_element()
        }
        Art::Picture(path) => fill(ImageSource::from(PathBuf::from(path))).into_any_element(),
        Art::Screen(color) => div()
            .absolute()
            .inset_0()
            .size_full()
            .rounded(px(corner))
            .bg(hsla(color.fill()))
            .into_any_element(),
    };
    div()
        .absolute()
        .inset_0()
        .size_full()
        .child(layer)
        .child(fill(pictures.orc.clone().into()))
        .into_any_element()
}

/// One tile's card (`MediaCard`, 16:10): its art filling it, or the image
/// icon on an empty card for Choose image… (`art` none). The pick wears the
/// kit's chrome plate; a free tile's border brightens while the pointer is
/// over its `group` (the tile, card and name); a disabled one is at half
/// strength.
pub fn tile_card(
    id: SharedString,
    art: Option<&Art>,
    selected: bool,
    disabled: bool,
    group: SharedString,
    t: &Theme,
) -> AnyElement {
    let card = MediaCard::new(id)
        .selected(selected)
        .relative()
        .w_full()
        .aspect_ratio(16. / 10.)
        .overflow_hidden();
    let card = match art {
        Some(art) => card.child(orc_art(art, radius::ROW)),
        None => card.items_center().justify_center().child(icon(
            IconName::ImageSquare,
            16.,
            hsla(t.muted_foreground),
        )),
    };
    // Over the card and its border (an absolute child sits inside the border).
    let over = || {
        div()
            .absolute()
            .top(px(-1.))
            .right(px(-1.))
            .bottom(px(-1.))
            .left(px(-1.))
            .rounded(px(radius::ROW))
    };
    let card = if disabled {
        // `disabled:opacity-50`: the ground at half over the whole picture
        // (GPUI would fade the Orc and his room each on their own).
        card.child(over().bg(hsla(with_alpha(t.glass_solid, 0.5))))
    } else {
        // `group-hover/tile:border-foreground/30`.
        card.child(
            over()
                .border_1()
                .border_color(hsla(with_alpha(t.foreground, 0.)))
                .group_hover(group, |style| {
                    style.border_color(hsla(with_alpha(t.foreground, 0.3)))
                }),
        )
    };
    card.into_any_element()
}

/// A tile's name under its card: centred, in the label type, the pick in the
/// foreground and the rest muted and regular. It wraps to a second line
/// rather than cutting; Choose image… (`nowrap`) stays on one.
pub fn tile_label(
    label: SharedString,
    selected: bool,
    disabled: bool,
    nowrap: bool,
    t: &Theme,
) -> Div {
    let ink = if selected {
        t.foreground
    } else {
        t.muted_foreground
    };
    let ink = if disabled {
        faded_over(ink, t.glass_solid, 0.5)
    } else {
        ink
    };
    div()
        .w_full()
        .text_center()
        .type_scale(text::LABEL)
        .when(!selected, |label| label.font_weight(FontWeight::NORMAL))
        .when(nowrap, |label| label.whitespace_nowrap())
        .text_color(hsla(ink))
        .child(label)
}

/// One background tile (Scene's `background_tile` shape).
struct Tile {
    id: SharedString,
    label: SharedString,
    selected: bool,
    disabled: bool,
    /// Its picture; none for Choose image…, which shows the image icon.
    art: Option<Art>,
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
        art,
    } = tile;
    let choose = art.is_none();
    let mut face = div()
        .id(id.clone())
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .aria_toggled(if selected {
            gpui::Toggled::True
        } else {
            gpui::Toggled::False
        })
        .group(id.clone())
        .flex()
        .flex_col()
        .gap(px(4.))
        .min_w_0()
        .child(tile_card(
            SharedString::from(format!("{id}-card")),
            art.as_ref(),
            selected,
            disabled,
            id,
            t,
        ))
        .child(tile_label(label, selected, disabled, choose, t));
    if !disabled {
        face = face.on_click(move |_, window, cx| on_pick(window, cx));
    }
    face.into_any_element()
}

/// Grouped tiles for the popover or the Choose-image dialog.
#[allow(
    clippy::too_many_arguments,
    reason = "Explicit screen assembly inputs keep independent view state and callbacks visible"
)]
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
                    art: Some(choice_art(&choice.id, choice.picture.as_deref())),
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
                    art: None,
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
                art: Some(choice_art(&choice.id, choice.picture.as_deref())),
            },
            t,
            move |window, cx| pick(id.clone(), window, cx),
        ));
    }
    grid.into_any_element()
}

/// `CameraBackgroundViewer`: the popover's "What viewers see" (16:9). The
/// camera's newest processed frame when there is one (`frame`, already
/// mirrored like the outputs), else the pick's own picture (`fallback`); its
/// name is a small pill over the top left.
fn viewer(frame: Option<Arc<RenderImage>>, fallback: &Art, t: &Theme) -> AnyElement {
    let picture = match frame {
        Some(frame) => img(ImageSource::Render(frame))
            .absolute()
            .inset_0()
            .size_full()
            .object_fit(ObjectFit::Cover)
            .rounded(px(radius::ROW))
            .into_any_element(),
        None => orc_art(fallback, radius::ROW),
    };
    div()
        .id("camera-background-viewer")
        .relative()
        .w_full()
        .aspect_ratio(16. / 9.)
        .overflow_hidden()
        .rounded(px(radius::ROW))
        .border_1()
        .border_color(hsla(t.border))
        .bg(hsla(t.video_ground))
        .child(picture)
        // `absolute top-1.5 left-1.5 rounded-full bg-video-ground/75 px-1.5
        // py-0.5 text-label text-video-ground-foreground`.
        .child(
            div()
                .absolute()
                .top(px(6.))
                .left(px(6.))
                .rounded_full()
                .bg(hsla(with_alpha(t.video_ground, 0.75)))
                .px(px(6.))
                .py(px(2.))
                .type_scale(text::LABEL)
                .text_color(hsla(t.video_ground_foreground))
                .child(WHAT_VIEWERS_SEE_LABEL),
        )
        .into_any_element()
}

/// P257–P262: the popover body (viewer, grouped tiles, blur caveat, lock).
/// `frame` is the camera's newest processed frame while the popover polls
/// for it, none until one arrives.
#[allow(
    clippy::too_many_arguments,
    reason = "Explicit screen assembly inputs keep independent view state and callbacks visible"
)]
pub fn picker_body(
    background: &serde_json::Value,
    choices: &[Choice],
    selected: Option<&ChoiceId>,
    frame: Option<Arc<RenderImage>>,
    t: &Theme,
    on_choose: impl Fn(ChoiceId, &mut Window, &mut App) + Clone + 'static,
    on_choose_image: impl Fn(&mut Window, &mut App) + Clone + 'static,
    on_settings: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let blur = background.get("mode").and_then(|mode| mode.as_str()) == Some("blur");
    // P257: until a frame arrives (and with no camera frame), the pick's own
    // tile picture (`choiceArt({ id: choiceId ?? 'off', picture })`).
    let fallback = selected
        .and_then(|selected| choices.iter().find(|choice| &choice.id == selected))
        .map_or(Art::Room, |choice| {
            choice_art(&choice.id, choice.picture.as_deref())
        });

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
        .child(viewer(frame, &fallback, t))
        .child(tiles_grid(
            choices,
            selected,
            true,
            true,
            POPOVER_COLUMNS,
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
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(lock_line(Some(crate::app::hotkeys::node_platform()))),
            )
            .child(
                Button::new("camera-background-settings")
                    .label(SETTINGS_BUTTON)
                    .size(ButtonSize::Xs)
                    .variant(ButtonVariant::Outline)
                    .on_click(move |_, window, cx| on_settings(window, cx)),
            ),
    )
    .into_any_element()
}

/// `CameraBackgroundThumbnail`: the Background NavigableRow trigger's 16 px
/// picture, the Orc over the current pick (the same art as the tiles).
pub fn thumbnail(art: &Art, t: &Theme) -> AnyElement {
    div()
        .relative()
        .size(px(16.))
        .flex_none()
        .overflow_hidden()
        .rounded(px(radius::CHIP))
        .bg(hsla(t.video_ground))
        .child(orc_art(art, radius::CHIP))
        .into_any_element()
}
