//! Drawing the stage (`scene-stage.tsx`'s SVG): the schematic canvas and
//! its sources (without the live canvas), the overlay items and banners as
//! dashed outlines with their label chips, the selection's frame and
//! handles, the snap guides, and the cursors. Rects are placed in canvas
//! fractions (`relative`), so a resize redraws nothing by hand; the pixel
//! size (the camera's mask, which handles show, the cursors' hit squares)
//! is the one the layer measured last.

use gpui::{
    AnyElement, App, Bounds, Context, CursorStyle, DispatchPhase, Div, Hitbox, HitboxBehavior,
    Hsla, ImageSource, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ObjectFit, Pixels, Window, canvas, div, img, point, prelude::*, px, relative, size,
};
use videorc_app_core::editor::stage::{
    Axis, GestureKind, HandleId, ITEM_CHIP_HIT_WIDTH, PixelSize, SourceShape, StageItemBadge,
    StageRect, stage_handle_offset, stage_handle_points, stage_source_shape,
};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::{Theme, radius, text};
use videorc_protocol::{SceneSource, SceneSourceKind};

use super::super::ScenePage;
use super::{Entry, GUTTER, PictureFile, StageView, Target};
use crate::screens::avatar::pictures;

/// The handle's drawn square and its hit square (points).
const HANDLE_SIZE: f32 = 6.0;
const HANDLE_HIT: f32 = 24.0;
/// The label chip's height and padding (points): 11 px type, 4 px in.
const CHIP_HEIGHT: f32 = 16.0;
const CHIP_PADDING: f32 = 4.0;
/// Dimmed: a hidden source, an item no output shows (`opacity-40`).
const OFF_SHARE: f32 = 0.4;

/// A token colour at a share of its alpha (`fill-foreground/10`).
fn faded(mut color: Hsla, share: f32) -> Hsla {
    color.a *= share;
    color
}

/// A div on `rect`, in fractions of its parent (the canvas).
fn placed(rect: StageRect) -> Div {
    div()
        .absolute()
        .left(relative(rect.x as f32))
        .top(relative(rect.y as f32))
        .w(relative(rect.width as f32))
        .h(relative(rect.height as f32))
}

/// `handleCursor` as GPUI's cursor.
fn cursor_of(handle: HandleId) -> CursorStyle {
    match handle.cursor() {
        "nwse-resize" => CursorStyle::ResizeUpLeftDownRight,
        "nesw-resize" => CursorStyle::ResizeUpRightDownLeft,
        "ns-resize" => CursorStyle::ResizeUpDown,
        _ => CursorStyle::ResizeLeftRight,
    }
}

/// A label chip at a box's top-left: the name, then a badge's raw word.
fn chip(label: &str, badge: Option<String>, color: Hsla, badge_color: Hsla) -> Div {
    div()
        .absolute()
        .top(px(CHIP_PADDING))
        .left(px(CHIP_PADDING * 2.0))
        .h(px(CHIP_HEIGHT))
        .flex()
        .items_center()
        .gap(px(CHIP_PADDING))
        .whitespace_nowrap()
        .type_scale(text::LABEL)
        .text_color(color)
        .child(label.to_string())
        .when_some(badge, |chip, word| {
            chip.child(div().text_color(badge_color).child(word))
        })
}

/// One cursor square, in points from the layer's top-left.
struct CursorArea {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    style: CursorStyle,
}

impl CursorArea {
    /// `rect` (canvas fractions) on a canvas of `pixels`, in the layer.
    fn over(rect: StageRect, pixels: PixelSize, style: CursorStyle) -> Self {
        Self {
            x: GUTTER + (rect.x * pixels.width) as f32,
            y: GUTTER + (rect.y * pixels.height) as f32,
            width: (rect.width * pixels.width) as f32,
            height: (rect.height * pixels.height) as f32,
            style,
        }
    }
}

impl ScenePage {
    /// The stage layer: see [`ScenePage::stage_layer`].
    pub(super) fn draw_stage(
        &mut self,
        live: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.stage.live = live;
        let focus = self.ensure_stage_focus(window, cx);
        let view = self.stage_view(cx);
        self.stage.facts = view.facts(self.stage.snap);
        let t = theme::resolve(None, window, cx);
        let pixels = self.stage.canvas_pixels();
        let gesture = self
            .stage
            .gesture
            .as_ref()
            .map(|active| (active.motion.kind, active.ghost.guides.clone()));

        // The canvas: the schematic's ground, and every source and item,
        // clipped to it (a box may hang three canvases off).
        let mut canvas_box = div()
            .absolute()
            .top(px(GUTTER))
            .left(px(GUTTER))
            .right(px(GUTTER))
            .bottom(px(GUTTER))
            .overflow_hidden();
        if !live {
            canvas_box = canvas_box
                .rounded(px(radius::PANEL))
                .border_1()
                .border_color(hsla(t.border))
                .bg(faded(hsla(t.background), 0.4));
        }
        let mut cursors = Vec::new();
        for entry in &view.entries {
            let selected = view.selected.as_deref() == Some(entry.id.as_str());
            match &entry.target {
                Target::Source(source) => {
                    // On the live canvas the picture is the video itself.
                    if !live {
                        canvas_box =
                            canvas_box.child(source_paint(entry, source, &view, pixels, t));
                    }
                    if let Some(pixels) = pixels
                        && view.drag_enabled
                        && entry.editable
                    {
                        cursors.push(CursorArea::over(entry.rect, pixels, CursorStyle::OpenHand));
                    }
                }
                _ => {
                    // Under the live canvas the compositor draws the real
                    // thing.
                    if !live {
                        canvas_box =
                            canvas_box.children(item_picture(entry, self.editor.canvas_aspect));
                    }
                    canvas_box = canvas_box.child(item_paint(entry, selected, t));
                    if let Some(pixels) = pixels
                        && entry.editable
                    {
                        let area = if selected || entry.grabs_body {
                            entry.rect
                        } else {
                            // Unselected, only the label chip takes the pointer.
                            StageRect {
                                width: entry
                                    .rect
                                    .width
                                    .min(ITEM_CHIP_HIT_WIDTH / pixels.width.max(1.0)),
                                height: entry.rect.height.min(
                                    f64::from(CHIP_HEIGHT + 2.0 * CHIP_PADDING)
                                        / pixels.height.max(1.0),
                                ),
                                ..entry.rect
                            }
                        };
                        cursors.push(CursorArea::over(area, pixels, CursorStyle::OpenHand));
                    }
                }
            }
        }
        // P522: one dashed line per snapped axis.
        if let Some((_, guides)) = &gesture {
            for guide in guides {
                let line = match guide.axis {
                    Axis::X => div()
                        .absolute()
                        .left(relative(guide.position as f32))
                        .top_0()
                        .h_full()
                        .w(px(0.))
                        .border_l_1(),
                    Axis::Y => div()
                        .absolute()
                        .top(relative(guide.position as f32))
                        .left_0()
                        .w_full()
                        .h(px(0.))
                        .border_t_1(),
                };
                canvas_box = canvas_box.child(line.border_dashed().border_color(hsla(t.ring)));
            }
        }

        // The selection's frame and handles, over the canvas and into the
        // gutter (P518).
        let mut chrome = div()
            .absolute()
            .top(px(GUTTER))
            .left(px(GUTTER))
            .right(px(GUTTER))
            .bottom(px(GUTTER));
        if let (Some(entry), Some(pixels)) = (view.selected_entry(), pixels) {
            chrome = chrome.child(
                placed(entry.rect)
                    .border_1()
                    .border_color(faded(hsla(t.foreground), 0.7)),
            );
            let mut handles = view.handles(entry, pixels);
            // During a resize only the handle that pulls shows.
            if let Some((GestureKind::Handle(active), _)) = &gesture {
                handles.retain(|handle| handle == active);
            }
            let offset = stage_handle_offset(
                entry.rect.width * pixels.width,
                entry.rect.height * pixels.height,
            ) as f32;
            for (handle, ax, ay) in stage_handle_points(entry.rect) {
                if !handles.contains(&handle) {
                    continue;
                }
                chrome = chrome.child(
                    div()
                        .absolute()
                        .left(relative(ax as f32))
                        .top(relative(ay as f32))
                        .ml(px(offset - HANDLE_SIZE / 2.0))
                        .mt(px(offset - HANDLE_SIZE / 2.0))
                        .size(px(HANDLE_SIZE))
                        .bg(hsla(t.background))
                        .border_1()
                        .border_color(faded(hsla(t.foreground), 0.8)),
                );
                cursors.push(CursorArea {
                    x: GUTTER + (ax * pixels.width) as f32 + offset - HANDLE_HIT / 2.0,
                    y: GUTTER + (ay * pixels.height) as f32 + offset - HANDLE_HIT / 2.0,
                    width: HANDLE_HIT,
                    height: HANDLE_HIT,
                    style: cursor_of(handle),
                });
            }
        }

        // The layer's place in the window (for the hit test and a gesture's
        // mapping), the cursors, and the pointer while a gesture runs.
        let gesture_cursor = gesture.as_ref().map(|(kind, _)| match kind {
            GestureKind::Move => CursorStyle::ClosedHand,
            GestureKind::Handle(handle) => cursor_of(*handle),
        });
        let cell = self.stage.bounds.clone();
        let measured = cx.entity().downgrade();
        let pointer = measured.clone();
        let measure = canvas(
            move |bounds, window, _: &mut App| {
                let before = cell.replace(Some(bounds));
                if before.map(|before| before.size) != Some(bounds.size) {
                    // The pixel-sized parts (the camera's mask, the handles)
                    // follow the new size on the next frame.
                    window.on_next_frame(move |_, cx| {
                        let _ = measured.update(cx, |_, cx| cx.notify());
                    });
                }
                if gesture_cursor.is_some() {
                    return Vec::new();
                }
                cursors
                    .into_iter()
                    .map(|area| {
                        let hitbox = window.insert_hitbox(
                            Bounds {
                                origin: point(
                                    bounds.origin.x + px(area.x),
                                    bounds.origin.y + px(area.y),
                                ),
                                size: size(px(area.width), px(area.height)),
                            },
                            HitboxBehavior::Normal,
                        );
                        (hitbox, area.style)
                    })
                    .collect::<Vec<(Hitbox, CursorStyle)>>()
            },
            move |_: Bounds<Pixels>, hitboxes, window, _: &mut App| {
                for (hitbox, style) in &hitboxes {
                    window.set_cursor_style(*style, hitbox);
                }
                let Some(style) = gesture_cursor else {
                    return;
                };
                // The pointer is the gesture's until it lets go, wherever it
                // goes in the window (`setPointerCapture`).
                window.set_window_cursor_style(style);
                let moves = pointer.clone();
                window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                    if phase != DispatchPhase::Capture {
                        return;
                    }
                    let pressed = event.pressed_button == Some(MouseButton::Left);
                    let _ = moves.update(cx, |page, cx| {
                        page.stage_drag(event.position, event.modifiers, pressed, cx)
                    });
                });
                let releases = pointer;
                window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                    if phase != DispatchPhase::Capture || event.button != MouseButton::Left {
                        return;
                    }
                    let _ = releases.update(cx, |page, cx| {
                        page.stage_release(event.position, event.modifiers, cx)
                    });
                });
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        // The layer takes the pointer over the whole canvas and its gutter
        // (over the live canvas's native view too), and the keys while
        // focused.
        div()
            .id("scene-stage")
            .relative()
            .size_full()
            .overflow_hidden()
            .track_focus(&focus)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|page, event: &MouseDownEvent, window, cx| {
                    page.stage_press(event, window, cx)
                }),
            )
            .on_key_down(cx.listener(|page, event: &KeyDownEvent, window, cx| {
                page.stage_key(event, window, cx)
            }))
            .child(canvas_box)
            .child(chrome)
            .child(measure)
            .into_any_element()
    }
}

/// A source on the schematic: its painted shape (the camera's mask) and
/// its name, dimmed and dashed while hidden.
fn source_paint(
    entry: &Entry,
    source: &SceneSource,
    view: &StageView,
    pixels: Option<PixelSize>,
    t: &Theme,
) -> Div {
    let camera = source.kind == SceneSourceKind::Camera;
    let share = if entry.off { OFF_SHARE } else { 1.0 };
    let fill = if camera {
        faded(hsla(t.foreground), 0.1 * share)
    } else {
        faded(hsla(t.muted_foreground), 0.05 * share)
    };
    let stroke = faded(hsla(t.muted_foreground), 0.4 * share);
    let shape = if camera {
        view.camera_shape.as_str()
    } else {
        "rectangle"
    };
    let painted = match pixels.map(|pixels| {
        stage_source_shape(
            entry.rect,
            pixels.width,
            pixels.height,
            shape,
            view.corner_radius_pct,
        )
    }) {
        Some(SourceShape::Circle { r, .. }) => {
            let diameter = (r * 2.0) as f32;
            div()
                .absolute()
                .left(relative(0.5))
                .top(relative(0.5))
                .ml(px(-diameter / 2.0))
                .mt(px(-diameter / 2.0))
                .size(px(diameter))
                .rounded_full()
        }
        Some(SourceShape::Rect { rx, .. }) => div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .rounded(px(rx as f32)),
        None => div().absolute().top_0().left_0().size_full(),
    };
    let mut painted = painted.bg(fill).border_1().border_color(stroke);
    if entry.off {
        painted = painted.border_dashed();
    }
    let mut body = placed(entry.rect).child(painted);
    // A box too short for the chip has no name.
    let labelled = pixels.is_some_and(|pixels| {
        entry.rect.height * pixels.height >= f64::from(CHIP_HEIGHT + 2.0 * CHIP_PADDING)
    });
    if labelled {
        body = body.overflow_hidden().child(chip(
            &entry.label,
            None,
            faded(hsla(t.foreground), 0.8 * share),
            hsla(t.muted_foreground),
        ));
    }
    body
}

/// An overlay item or a banner: a dashed hairline (stronger when
/// selected) and its label chip with the badge's raw word; dimmed when no
/// output shows it.
/// The item itself on the schematic: a banner's image, the avatar's still
/// in its pet's square; dimmed when no output shows it.
fn item_picture(entry: &Entry, canvas_aspect: f64) -> Option<AnyElement> {
    let picture = entry.picture.as_ref()?;
    let rect = entry.picture_rect(canvas_aspect)?;
    let source: ImageSource = match &picture.file {
        PictureFile::File(path) => path.clone().into(),
        PictureFile::Golem => pictures::default_idle()?.into(),
    };
    let share = if entry.off { OFF_SHARE } else { 1.0 };
    Some(
        placed(rect)
            .child(
                img(source)
                    .size_full()
                    .object_fit(ObjectFit::Contain)
                    .opacity(picture.opacity * share),
            )
            .into_any_element(),
    )
}

fn item_paint(entry: &Entry, selected: bool, t: &Theme) -> Div {
    let share = if entry.off { OFF_SHARE } else { 1.0 };
    let stroke = faded(
        hsla(t.foreground),
        (if selected { 0.6 } else { 0.3 }) * share,
    );
    placed(entry.rect)
        .border_1()
        .border_dashed()
        .border_color(stroke)
        .child(chip(
            &entry.label,
            entry.badge.map(StageItemBadge::word),
            faded(hsla(t.foreground), 0.8 * share),
            faded(hsla(t.muted_foreground), share),
        ))
}
