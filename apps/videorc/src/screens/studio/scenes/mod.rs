//! Studio's Scenes section (`studio-dashboard-bottom-row.tsx`'s Scenes
//! slot, `scenes-gallery.tsx`, `scene-presets.tsx`, `scene-card.tsx`): the
//! scenes as cards under the preview. Words, states and reasons come from
//! app-core (`studio::scenes_section`); this module draws them on the kit
//! and calls the Studio.
//!
//! Part 1 (plan 260 Phase 3) is the gallery: the keys line, Edit scene, the
//! 16:9 / 9:16 toggle, Follow the app in front (macOS), the library's
//! error, one card per scene (its layout diagram, name, check, meta words
//! and keys), the switch's status line and the camera's reason. A click on
//! a card puts it on stream. Add scene…, reorder, the stills, ⋯ and the
//! scene on stream's own fields are later parts.
//!
//! The status line shows a moment after a switch starts. The section asks
//! the core when, and draws once more then: no frame loop.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, ColorSpace, Context, Entity, EventEmitter, FontWeight, Hsla, Role, Window, canvas,
    div, linear_color_stop, linear_gradient, prelude::*, px,
};
use tokio::sync::watch;
use videorc_app_core::StudioSnapshot;
use videorc_app_core::nav::PageId;
use videorc_app_core::scenes::switch_progress::{
    SCENE_SWITCH_PENDING_LABEL, SceneSwitchStatusLine,
};
use videorc_app_core::scenes::thumb::{ThumbCorner, ThumbPart, ThumbSize, card_frame, thumb_areas};
use videorc_app_core::studio::families::{FollowSettings, save_follow_settings};
use videorc_app_core::studio::scenes_section::{
    CardKey, SceneCardView, ScenesExtras, ScenesGalleryView, ScenesLine, ScenesSectionView, copy,
};
use videorc_app_core::studio::screen_views::TalkShowRoomView;
use videorc_kit::chrome::box_shadow;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, TypeScale, faded_over, hsla, with_alpha};
use videorc_kit::tokens::{Color, Shadow, Theme, radius, text};
use videorc_kit::tooltip::tooltip;
use videorc_kit::{
    Button, ButtonSize, ButtonVariant, Kbd, PanelSection, Segment, SegmentedControl, Skeleton,
    Spinner, Switch,
};

use super::transport::{AppStudio, OpenPage};
use crate::app::bridge::Mirror;
use crate::app::hotkeys::{Hotkeys, node_platform};

/// Cards are at least this wide: a picture big enough to read, and
/// "Screen + camera" on one line (`minmax(160px, 1fr)`).
pub const CARD_MIN_PX: f32 = 160.;
/// The grid's gap (`gap-2`).
pub const CARD_GAP_PX: f32 = 8.;
/// The card's padding (`p-2`) and its hairline.
const CARD_PADDING_PX: f32 = 8.;
const CARD_BORDER_PX: f32 = 1.;
/// How many cards fit across `width` (`repeat(auto-fill, minmax(160px, 1fr))`).
pub fn columns(width: f32) -> usize {
    if width <= CARD_MIN_PX {
        return 1;
    }
    (((width + CARD_GAP_PX) / (CARD_MIN_PX + CARD_GAP_PX)).floor() as usize).max(1)
}

/// Each card's width: the row shared out (`1fr`), never under the minimum.
pub fn card_width(width: f32) -> f32 {
    let count = columns(width);
    let shared = (width - CARD_GAP_PX * (count - 1) as f32) / count as f32;
    shared.floor().max(CARD_MIN_PX)
}

/// A diagram corner on the radius tiers: the chip, and its half, third
/// and sixth for the 3, 2 and 1 px corners `LayoutThumb` draws.
fn corner_px(corner: ThumbCorner) -> f32 {
    match corner {
        ThumbCorner::Chip => radius::CHIP,
        ThumbCorner::Area => radius::CHIP / 2.0,
        ThumbCorner::Tight => radius::CHIP / 3.0,
        ThumbCorner::Hair => radius::CHIP / 6.0,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

pub struct ScenesSection {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    talk_show: Entity<Mirror<TalkShowRoomView>>,
    hotkeys: Hotkeys,
    view: ScenesSectionView,
    /// The status line's instant this section will draw again at.
    wake: Option<u64>,
    /// The cards' row width at the last paint.
    width: f32,
}

impl EventEmitter<OpenPage> for ScenesSection {}

impl ScenesSection {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        mut snapshot: watch::Receiver<StudioSnapshot>,
        talk_show: Entity<Mirror<TalkShowRoomView>>,
        hotkeys: Hotkeys,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&talk_show, |section, _, cx| section.refresh(cx))
            .detach();
        cx.spawn(async move |this, cx| {
            loop {
                if snapshot.changed().await.is_err() {
                    break;
                }
                let alive = this.update(cx, |section, cx| {
                    let snap = snapshot.borrow_and_update().clone();
                    section.recompute(&snap, cx);
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
        let mut section = Self {
            studio,
            runtime,
            talk_show,
            hotkeys,
            view: ScenesSectionView::Loading,
            wake: None,
            width: 0.,
        };
        section.refresh(cx);
        section
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let snapshot = self.studio.snapshot();
        self.recompute(&snapshot, cx);
    }

    /// The view again; a redraw only when it changed, and one more at the
    /// instant the status line is due.
    fn recompute(&mut self, snapshot: &StudioSnapshot, cx: &mut Context<Self>) {
        let registration = self.hotkeys.registration();
        // The slow camera only matters to a switch's status line.
        let camera_low = snapshot
            .scenes
            .switch_progress
            .as_ref()
            .and_then(|_| self.studio.telemetry_now().camera_low_frame_rate());
        let now = now_ms();
        let view = ScenesSectionView::from_snapshot(
            snapshot,
            ScenesExtras {
                room_open: self.talk_show.read(cx).value().open,
                platform: Some(node_platform()),
                registered: &registration.registered,
                camera_low,
                now_ms: now,
            },
        );
        if let ScenesSectionView::Gallery(gallery) = &view
            && let Some(at) = gallery.status_at
        {
            self.wake_at(at, now, cx);
        }
        if view != self.view {
            self.view = view;
            cx.notify();
        }
    }

    fn wake_at(&mut self, at: u64, now: u64, cx: &mut Context<Self>) {
        if self.wake == Some(at) {
            return;
        }
        self.wake = Some(at);
        let wait = Duration::from_millis(at.saturating_sub(now));
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            this.update(cx, |section, cx| {
                if section.wake == Some(at) {
                    section.wake = None;
                }
                section.refresh(cx);
            })
            .ok();
        })
        .detach();
    }

    fn measured(&mut self, width: f32, cx: &mut Context<Self>) {
        if (width - self.width).abs() >= 0.5 {
            self.width = width;
            cx.notify();
        }
    }

    /// A card's click (`dialogs.select`): the scene goes on stream. A scene
    /// whose sources need choosing again would open the repair dialog in
    /// Electron; until that dialog lands the core's apply answers it (a
    /// refusal in words is the core's toast).
    fn apply(&mut self, id: String) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            if !studio.apply_saved_scene_by_id(&id).await {
                eprintln!("[videorc-app] Scenes: the scene didn't go on stream");
            }
        });
    }

    /// The 16:9 / 9:16 toggle (`switchMode`).
    fn switch_orientation(&mut self, vertical: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            if !studio.switch_orientation(vertical).await {
                eprintln!("[videorc-app] Scenes: the orientation didn't change");
            }
        });
    }

    /// Follow the app in front (plan 210 D10), stored per device.
    fn set_follow(&mut self, on: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let write = save_follow_settings(FollowSettings {
                follow_front_app: on,
            });
            if let Err(error) = studio.write_settings(vec![write]).await {
                eprintln!("[videorc-app] Scenes: Follow the app in front: {error}");
            }
        });
    }
}

/// The diagram's colours on a card.
struct Paint {
    frame_top: Hsla,
    frame_bottom: Hsla,
    frame_border: Hsla,
    screen: Hsla,
    camera: Hsla,
    pip_rim: Hsla,
    well: Hsla,
}

impl Paint {
    /// `disabled` fades the picture to half over the card's ground, each
    /// colour pre-blended (never a layer's opacity).
    fn of(t: &Theme, disabled: bool) -> Self {
        let ground = card_ground(t);
        let fade = |color: Color| {
            if disabled {
                with_alpha(color, 0.5)
            } else {
                color
            }
        };
        // A neutral plate, opaque over a picture: foreground/25 on the solid.
        let camera = faded_over(t.foreground, t.glass_solid, 0.25);
        Self {
            frame_top: hsla(fade(with_alpha(t.muted, 0.4))),
            frame_bottom: hsla(fade(with_alpha(t.muted, 0.7))),
            frame_border: hsla(fade(t.border)),
            screen: hsla(fade(with_alpha(t.foreground, 0.1))),
            camera: hsla(if disabled {
                faded_over(camera, ground, 0.5)
            } else {
                camera
            }),
            pip_rim: hsla(fade(with_alpha(t.background, 0.6))),
            well: hsla(with_alpha(t.foreground, 0.03)),
        }
    }
}

/// `MediaCard`'s 4% fill on the solid, opaque (the ground faded colours
/// blend over).
fn card_ground(t: &Theme) -> Color {
    faded_over(t.foreground, t.glass_solid, 0.04)
}

/// The layout diagram (`LayoutThumb`, P288): its frame and areas; a 9:16
/// one upright in a 4:3 well. Never the live program, and no still yet.
fn layout_thumb(card: &SceneCardView, inner: f32, paint: &Paint) -> AnyElement {
    let frame_box = card_frame(card.vertical, inner);
    let (frame_w, frame_h) = (frame_box.width, frame_box.height);
    let areas = thumb_areas(
        &card.preset,
        card.fit,
        ThumbSize::Card,
        frame_w - 2. * CARD_BORDER_PX,
        frame_h - 2. * CARD_BORDER_PX,
    );
    let frame = div()
        .relative()
        .flex_none()
        .w(px(frame_w))
        .h(px(frame_h))
        .overflow_hidden()
        .rounded(px(corner_px(frame_box.corner)))
        .border_1()
        .border_color(paint.frame_border)
        .bg(linear_gradient(
            135.,
            linear_color_stop(paint.frame_top, 0.),
            linear_color_stop(paint.frame_bottom, 1.),
        ))
        .children(areas.into_iter().map(|area| {
            div()
                .absolute()
                .left(px(area.left))
                .top(px(area.top))
                .w(px(area.width))
                .h(px(area.height))
                .rounded(px(corner_px(area.corner)))
                .bg(match area.part {
                    ThumbPart::Camera => paint.camera,
                    ThumbPart::Screen => paint.screen,
                })
                .when(area.rim, |plate| {
                    plate.border_1().border_color(paint.pip_rim)
                })
        }));
    if !card.vertical {
        return frame.into_any_element();
    }
    div()
        .w(px(inner))
        .h(px(inner * 3. / 4.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(radius::CHIP))
        .bg(paint.well)
        .child(frame)
        .into_any_element()
}

/// The meta row's keys (`SceneShortcutKeys`, P290, P291).
fn card_keys(keys: &[CardKey]) -> Option<AnyElement> {
    if keys.is_empty() {
        return None;
    }
    Some(
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .children(keys.iter().map(|key| match key {
                CardKey::Chip { label, .. } => Kbd::new(label.clone()).into_any_element(),
                CardKey::Conflict { reason, .. } => div().child(reason.clone()).into_any_element(),
            }))
            .into_any_element(),
    )
}

/// `ScenesLine` (P274): the platform's first and ninth keys in its own
/// words, medium weight, or the general line.
fn scenes_line(line: &ScenesLine) -> AnyElement {
    match line {
        ScenesLine::General => div().child(copy::LINE_GENERAL).into_any_element(),
        ScenesLine::Keys { first, last } => div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(4.))
            .child(copy::LINE_LEAD)
            .child(div().font_weight(FontWeight::MEDIUM).child(first.clone()))
            .child(copy::LINE_TO)
            .child(div().font_weight(FontWeight::MEDIUM).child(last.clone()))
            .child(copy::LINE_TAIL)
            .into_any_element(),
    }
}

/// The switch's status line (`SceneSwitchStatus`, P284).
fn status_line(status: &SceneSwitchStatusLine, t: &Theme) -> AnyElement {
    div()
        .id("scene-switch-status")
        .role(Role::Status)
        .flex()
        .items_start()
        .gap(px(6.))
        .type_scale(text::META)
        .text_color(hsla(t.muted_foreground))
        .child(
            div().mt(px(1.)).child(
                Spinner::new("scene-switch-status-spinner")
                    .size(14.)
                    .color(t.muted_foreground)
                    .hidden(true),
            ),
        )
        .child(
            div()
                .min_w_0()
                .flex()
                .flex_wrap()
                .gap(px(4.))
                .child(
                    div()
                        .text_color(hsla(t.foreground))
                        .child(status.title.clone()),
                )
                .children(status.detail.clone()),
        )
        .into_any_element()
}

impl ScenesSection {
    /// One scene card (`SceneCard`, P288–P290, P293).
    fn card(
        &self,
        index: usize,
        card: &SceneCardView,
        width: f32,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let paint = Paint::of(t, card.disabled);
        let ground = card_ground(t);
        let muted = hsla(t.muted_foreground);
        let foreground = hsla(t.foreground);
        let name_ink = if card.disabled {
            hsla(faded_over(t.foreground, ground, 0.5))
        } else {
            foreground
        };
        let inner = width - 2. * (CARD_PADDING_PX + CARD_BORDER_PX);

        // The well, and the ring a 2 px gap off it on the scene on stream:
        // the text's own tone, never a colour.
        let well = div()
            .relative()
            .flex_none()
            .child(layout_thumb(card, inner, &paint))
            .when(card.on_stream, |well| {
                well.child(
                    div()
                        .absolute()
                        .top(px(-4.))
                        .left(px(-4.))
                        .right(px(-4.))
                        .bottom(px(-4.))
                        .rounded(px(radius::CHIP + 4.0))
                        .border_2()
                        .border_color(foreground),
                )
            });

        let name_row = div()
            .mt(px(8.))
            .h(px(20.))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .type_scale(text::LABEL)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(name_ink)
                    .child(card.name.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .size(px(16.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(card.on_stream, |check| {
                        check.child(icon(IconName::Check, 16., foreground))
                    }),
            );

        // Essential words: never dimmed with a disabled card.
        let meta: AnyElement = if card.pending {
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(4.))
                .child(
                    Spinner::new(("scene-card-pending", index))
                        .size(14.)
                        .color(t.muted_foreground)
                        .hidden(true),
                )
                .child(SCENE_SWITCH_PENDING_LABEL)
                .into_any_element()
        } else {
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .child(card.meta.clone().unwrap_or_default())
                .into_any_element()
        };
        let meta_row = div()
            .mt(px(4.))
            .h(px(20.))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(8.))
            .type_scale(text::META)
            .text_color(muted)
            .child(meta)
            .children(card_keys(&card.keys));

        let interactive = !card.on_stream && !card.disabled;
        let accent = hsla(t.accent);
        let id = card.id.clone();
        div()
            .id(("scene-card", index))
            .role(Role::Button)
            .aria_label(card.name.clone())
            .flex_none()
            .w(px(width))
            .flex()
            .flex_col()
            .p(px(CARD_PADDING_PX))
            .rounded(px(radius::ROW))
            .border_1()
            .map(|card_box| {
                if card.on_stream {
                    // The selected plate: chrome-plate, a brighter rim.
                    card_box
                        .border_color(hsla(with_alpha(t.foreground, 0.25)))
                        .bg(linear_gradient(
                            180.,
                            linear_color_stop(hsla(t.chrome_plate_top), 0.),
                            linear_color_stop(hsla(t.chrome_plate_bottom), 1.),
                        )
                        .color_space(ColorSpace::Oklab))
                        .shadow(vec![
                            box_shadow(&Shadow {
                                inset: true,
                                x: 0.,
                                y: 1.,
                                blur: 0.,
                                spread: 0.,
                                color: t.chrome_plate_hi,
                            }),
                            box_shadow(&Shadow {
                                inset: true,
                                x: 0.,
                                y: 0.,
                                blur: 0.,
                                spread: 1.,
                                color: t.chrome_plate_rim,
                            }),
                        ])
                } else {
                    card_box
                        .border_color(hsla(t.border))
                        .bg(hsla(with_alpha(t.foreground, 0.04)))
                }
            })
            .when(interactive, |card_box| {
                card_box
                    .cursor_pointer()
                    .hover(move |style| style.bg(accent))
            })
            .when(!card.disabled, |card_box| {
                card_box.on_click(cx.listener(move |section, _, _, _| {
                    section.apply(id.clone());
                }))
            })
            .when_some(
                card.disabled_reason.clone().filter(|_| card.disabled),
                |card_box, reason| card_box.tooltip(tooltip(reason)),
            )
            .child(well)
            .child(name_row)
            .child(meta_row)
            .into_any_element()
    }

    fn gallery(
        &self,
        gallery: &ScenesGalleryView,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> PanelSection {
        let entity = cx.entity();
        let muted = hsla(t.muted_foreground);
        let section = PanelSection::new("studio-scenes")
            .title(copy::TITLE)
            .description(scenes_line(&gallery.line))
            .action(
                // Plan 215 D4: the same Edit scene as the Scene page's and
                // ⌘K's. The Scene page turns its editor on as it lands.
                Button::new("scene-edit")
                    .variant(ButtonVariant::Ghost)
                    .label(copy::EDIT_SCENE)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Layouts)))),
            );

        // P277: the canvas's orientation; the encoder canvas is fixed at
        // session start, so it locks while one runs. A switch restarts the
        // canvas, so the arrows only move focus (manual).
        let toggle = SegmentedControl::new("studio-orientation")
            .small(true)
            .manual(true)
            .accessibility_label(copy::ORIENTATION_LABEL)
            .value(Some(if gallery.vertical {
                copy::VERTICAL
            } else {
                copy::HORIZONTAL
            }))
            .disabled(gallery.orientation_locked.is_some())
            .option(
                Segment::new(copy::HORIZONTAL, copy::HORIZONTAL_SEGMENT)
                    .tooltip(copy::HORIZONTAL_TOOLTIP),
            )
            .option(
                Segment::new(copy::VERTICAL, copy::VERTICAL_SEGMENT)
                    .tooltip(copy::VERTICAL_TOOLTIP),
            )
            .on_change({
                let entity = entity.clone();
                move |value, _, cx| {
                    let vertical = value.as_ref() == copy::VERTICAL;
                    entity.update(cx, |section, _| section.switch_orientation(vertical));
                }
            });
        let toggle = div()
            .id("studio-orientation-reason")
            .child(toggle)
            .when_some(gallery.orientation_locked, |wrap, reason| {
                wrap.tooltip(tooltip(reason))
            });
        let follow = gallery.follow_front_app.map(|on| {
            let entity = entity.clone();
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(copy::FOLLOW_FRONT_APP),
                )
                .child(
                    Switch::new("scene-follow-front-app")
                        .small(true)
                        .checked(on)
                        .accessibility_label(copy::FOLLOW_FRONT_APP)
                        .on_change(move |value, _, cx| {
                            entity.update(cx, |section, _| section.set_follow(value));
                        }),
                )
        });
        let controls = div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .child(toggle)
            .children(follow);

        let card_w = card_width(self.width);
        let cards: Vec<AnyElement> = gallery
            .cards
            .iter()
            .enumerate()
            .map(|(index, card)| self.card(index, card, card_w, t, cx))
            .collect();
        let weak = entity.downgrade();
        let measure = canvas(
            move |bounds, _, cx| {
                let width = f32::from(bounds.size.width);
                weak.update(cx, |section, cx| section.measured(width, cx))
                    .ok();
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();
        let grid = div()
            .relative()
            .w_full()
            .flex()
            .flex_wrap()
            .gap(px(CARD_GAP_PX))
            .child(measure)
            .children(cards);

        let error = gallery.error.map(|error| {
            div()
                .type_scale(text::LABEL)
                .font_weight(FontWeight::NORMAL)
                .text_color(muted)
                .child(error)
        });
        let status = gallery.status.as_ref().map(|status| status_line(status, t));
        // P285: why some scenes can't go on, once, under the cards.
        let reason = gallery.camera_reason.clone().map(|reason| {
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .type_scale(text::META)
                .text_color(muted)
                .child(div().min_w_0().child(reason))
                .child(
                    Button::new("scenes-open-sources")
                        .variant(ButtonVariant::Ghost)
                        .size(ButtonSize::Xs)
                        .label(copy::OPEN_SOURCES)
                        .on_click(
                            cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Sources))),
                        ),
                )
        });
        section
            .child(controls)
            .children(error)
            .child(grid)
            .children(status)
            .children(reason)
    }
}

impl Render for ScenesSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        match self.view.clone() {
            // P272: while the room is open the Show stage's layouts are
            // what goes on air.
            ScenesSectionView::RoomOpen => PanelSection::new("studio-scenes")
                .title(copy::TITLE)
                .description(div().child(ScenesSectionView::room_open_line())),
            // P287: the section's room while the library is read.
            ScenesSectionView::Loading => PanelSection::new("studio-scenes")
                .title(copy::TITLE)
                .child(Skeleton::new("scenes-loading").w_full().h(px(320.))),
            ScenesSectionView::Gallery(gallery) => self.gallery(&gallery, t, cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_share_the_row_and_never_go_under_160_px() {
        assert_eq!(columns(0.), 1);
        assert_eq!(columns(160.), 1);
        assert_eq!(columns(327.), 1);
        assert_eq!(columns(328.), 2);
        assert_eq!(card_width(328.), 160.);
        assert_eq!(card_width(400.), 196.);
        assert_eq!(card_width(100.), 160.);
    }
}
