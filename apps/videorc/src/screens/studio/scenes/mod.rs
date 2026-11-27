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
//! a card puts it on stream.
//!
//! Part 2 adds each card's glyph and still picture ([`pictures`]), the
//! reorder (a drag, or ⌥← ⌥→ on a focused card), the whole name or meta on
//! hover when a line cut it, and under the cards the scene on stream's own
//! fields ([`on_stream`]): Screen with Hide screen, Layout, Framing and the
//! Vertical stream.
//!
//! Part 3 opens the Scene page's dialogs (`useSceneDialogs`, one
//! [`SceneDialogs`] of the section's own): Add scene…, each card's ⋯ menu
//! (Rename…, Change screen…, Set key…, Follow the app, Save audio to scene,
//! Guests in the room…, Duplicate, Delete), the fields' Change screen…, a
//! layout that asks for a screen first (D19), and Resolve scene sources for
//! a card whose sources are gone.
//!
//! The status line shows a moment after a switch starts. The section asks
//! the core when, and draws once more then: no frame loop.

mod on_stream;
mod pictures;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{
    AnyElement, ColorSpace, Context, DragMoveEvent, Entity, EventEmitter, FocusHandle, FontWeight,
    Hsla, KeyDownEvent, ObjectFit, Role, SharedString, TextRun, Window, canvas, div, img,
    linear_color_stop, linear_gradient, prelude::*, px,
};
use tokio::sync::watch;
use videorc_app_core::StudioSnapshot;
use videorc_app_core::cloud_scene::USE_SCENES;
use videorc_app_core::nav::PageId;
use videorc_app_core::scenes::list::{
    MoveKey, SceneGlyph, duplicated_scene, scene_with_audio, scene_with_follow,
};
use videorc_app_core::scenes::model::scene_audio;
use videorc_app_core::scenes::pictures::picture_key;
use videorc_app_core::scenes::switch_progress::{
    SCENE_SWITCH_PENDING_LABEL, SceneSwitchStatusLine,
};
use videorc_app_core::scenes::thumb::{ThumbCorner, ThumbPart, ThumbSize, card_frame, thumb_areas};
use videorc_app_core::studio::families::{FollowSettings, save_follow_settings};
use videorc_app_core::studio::scene_on_stream::{
    SceneOnStreamView, ScreenRecordingAlert, screen_recording_alert,
};
use videorc_app_core::studio::scenes_section::{
    CardKey, DropEdge, SceneCardView, ScenesExtras, ScenesGalleryView, ScenesLine,
    ScenesSectionView, card_move_target, copy, cut_tooltip, drop_edge, session_active,
};
use videorc_app_core::studio::screen_views::TalkShowRoomView;
use videorc_kit::chrome::{box_shadow, focus_ring};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::kebab_menu::{KEBAB_HOST, KebabMenu, KebabMenuItem, KebabReveal};
use videorc_kit::theme::{self, FONT, TypeScale, faded_over, hsla, with_alpha};
use videorc_kit::tokens::{Color, Shadow, Theme, radius, text};
use videorc_kit::tooltip::tooltip;
use videorc_kit::{
    Button, ButtonSize, ButtonVariant, Kbd, PanelSection, Segment, SegmentedControl, Skeleton,
    Spinner, Switch,
};
use videorc_protocol::ScreenPrivacy;

use super::transport::{AppStudio, OpenPage};
use crate::app::bridge::Mirror;
use crate::app::hotkeys::{Hotkeys, node_platform};
use crate::app::permissions::Permissions;
use crate::screens::scene::dialogs::{GUESTS_LABEL, SET_KEY_LABEL, SceneDialogs};
use crate::screens::scene::model::copy as menu_copy;
use pictures::Stills;

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

/// A card's name: `text-sm font-medium` (`scene-card.tsx`
/// `scene-card-label`).
const NAME_TEXT_PX: f32 = 14.;

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

/// `new Date().toISOString()`.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// `SceneGlyphIcon` without the apps' own icons: the GPUI app has no
/// `getAppIcons` yet, so an app (and a window) shows the generic scene glyph,
/// as `AppIconImage` does while main has no icon.
fn glyph_icon(glyph: &SceneGlyph) -> IconName {
    match glyph {
        SceneGlyph::Display => IconName::Monitor,
        SceneGlyph::Camera => IconName::VideoCamera,
        SceneGlyph::App { .. } | SceneGlyph::Window => IconName::SquaresFour,
    }
}

/// The width `words` take on one line at `size` px in the system font.
fn text_width(window: &Window, words: &str, size: f32, weight: FontWeight, color: Hsla) -> f32 {
    if words.is_empty() {
        return 0.;
    }
    let mut font = gpui::font(FONT);
    font.weight = weight;
    let run = TextRun {
        len: words.len(),
        font,
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    f32::from(
        window
            .text_system()
            .shape_line(
                SharedString::from(words.to_string()),
                px(size),
                &[run],
                None,
            )
            .width(),
    )
}

/// The dragged card's fade (`opacity-40`).
const DRAGGING_OPACITY: f32 = 0.4;

/// A card being dragged (P281): its scene, its place, and what the pointer
/// carries: the card itself, as wide as it sits in the row, with its still.
#[derive(Clone)]
struct SceneDrag {
    id: String,
    index: usize,
    card: SceneCardView,
    width: f32,
    still: Option<Arc<gpui::Image>>,
}

impl Render for SceneDrag {
    /// The card's picture under the pointer, as the browser's drag image
    /// draws the card: GPUI lays it out where the card was, offset by the
    /// grab point. A copy of the card's face (its well, name row and meta
    /// row) on its own ground, without the ⋯, the hover and the text
    /// measures; the opaque ground keeps what it passes over out of it.
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let card = &self.card;
        let paint = Paint::of(t, card.disabled);
        let ground = card_ground(t);
        let foreground = hsla(t.foreground);
        let name_ink = if card.disabled {
            hsla(faded_over(t.foreground, ground, 0.5))
        } else {
            foreground
        };
        let inner = self.width - 2. * (CARD_PADDING_PX + CARD_BORDER_PX);
        let well = div().relative().flex_none().child(layout_thumb(
            card,
            inner,
            &paint,
            self.still.as_ref(),
        ));
        let name_row = div()
            .mt(px(8.))
            .h(px(20.))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .child(icon(glyph_icon(&card.glyph), 16., paint.screen_glyph))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(NAME_TEXT_PX))
                    .line_height(px(20.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(name_ink)
                    .child(card.name.clone()),
            )
            .when(card.on_stream, |row| {
                row.child(icon(IconName::Check, 16., foreground))
            });
        let meta_words = if card.pending {
            SCENE_SWITCH_PENDING_LABEL.to_string()
        } else {
            card.meta.clone().unwrap_or_default()
        };
        let meta_row = div()
            .mt(px(4.))
            .h(px(20.))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(8.))
            .type_scale(text::META)
            .text_color(hsla(t.muted_foreground))
            .child(div().flex_1().min_w_0().truncate().child(meta_words))
            .children(card_keys(&card.keys));
        div()
            .w(px(self.width))
            .flex()
            .flex_col()
            .p(px(CARD_PADDING_PX))
            .rounded(px(radius::ROW))
            .border_1()
            .font_family(FONT)
            .map(|card_box| {
                if card.on_stream {
                    card_box
                        .border_color(hsla(with_alpha(t.foreground, 0.25)))
                        .bg(linear_gradient(
                            180.,
                            linear_color_stop(hsla(t.chrome_plate_top), 0.),
                            linear_color_stop(hsla(t.chrome_plate_bottom), 1.),
                        )
                        .color_space(ColorSpace::Oklab))
                } else {
                    card_box.border_color(hsla(t.border)).bg(hsla(ground))
                }
            })
            .child(well)
            .child(name_row)
            .child(meta_row)
    }
}

pub struct ScenesSection {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    talk_show: Entity<Mirror<TalkShowRoomView>>,
    /// Room scene opt-in (`TalkShowRoomHost::scenes_enabled`); set after both
    /// entities exist (`StudioPage::new` / `bind_room_host`).
    room_host: Option<Entity<super::talk_show_host::TalkShowRoomHost>>,
    hotkeys: Hotkeys,
    permissions: Arc<Permissions>,
    view: ScenesSectionView,
    /// The scene on stream's fields under the cards (none with no scene).
    on_stream: Option<SceneOnStreamView>,
    screen_alert: Option<ScreenRecordingAlert>,
    /// The alert's action runs.
    alert_pending: bool,
    /// The last Hide screen state the backend gave (`screen.privacy.*`).
    privacy: ScreenPrivacy,
    /// Bumped by every change, so an older read can't land over it.
    privacy_revision: u64,
    /// The cards' still pictures.
    stills: Stills,
    /// Each card's focus, by scene: it follows the card when it moves.
    focus: HashMap<String, FocusHandle>,
    /// Each card's room for its name and its meta words, by scene, at the
    /// last paint (P292).
    text_room: HashMap<String, (f32, f32)>,
    /// A drag over a card: where it came from and the card under it.
    drag: Option<(usize, usize)>,
    /// The status line's instant this section will draw again at.
    wake: Option<u64>,
    /// The cards' row width at the last paint.
    width: f32,
    /// The scene dialogs the section opens (Add scene…, the ⋯ menu's,
    /// Change screen…, Resolve scene sources).
    dialogs: Entity<SceneDialogs>,
}

impl EventEmitter<OpenPage> for ScenesSection {}

impl ScenesSection {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        mut snapshot: watch::Receiver<StudioSnapshot>,
        talk_show: Entity<Mirror<TalkShowRoomView>>,
        hotkeys: Hotkeys,
        permissions: Arc<Permissions>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&talk_show, |section, _, cx| section.refresh(cx))
            .detach();
        // The stills ask again when the window comes back to the front.
        // The Screen Recording alert reads the grant again then too: it may
        // have been made in System Settings meanwhile.
        cx.observe_window_activation(window, |section, window, cx| {
            if window.is_window_active() {
                section.window_activated(cx);
                section.refresh(cx);
            }
        })
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
        let dialogs = cx.new(|cx| {
            SceneDialogs::new(studio.clone(), runtime.clone(), hotkeys.clone(), window, cx)
        });
        let mut section = Self {
            studio,
            runtime,
            talk_show,
            room_host: None,
            hotkeys,
            permissions,
            view: ScenesSectionView::Loading,
            on_stream: None,
            screen_alert: None,
            alert_pending: false,
            privacy: ScreenPrivacy::default(),
            privacy_revision: 0,
            stills: Stills::default(),
            focus: HashMap::new(),
            text_room: HashMap::new(),
            drag: None,
            wake: None,
            width: 0.,
            dialogs,
        };
        section.watch_privacy(cx);
        section.refresh(cx);
        section
    }

    /// Wire the talk-show host so the room-open Scenes line can toggle
    /// `scenes_enabled` (C3 room-scene readiness).
    pub fn bind_room_host(
        &mut self,
        host: Entity<super::talk_show_host::TalkShowRoomHost>,
        cx: &mut Context<Self>,
    ) {
        cx.observe(&host, |section, _, cx| section.refresh(cx))
            .detach();
        self.room_host = Some(host);
        self.refresh(cx);
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
        let on_stream = SceneOnStreamView::from_snapshot(snapshot, &self.privacy, None);
        // Only under the fields: no scene on stream, no OS read.
        let screen_alert = on_stream.as_ref().and_then(|_| {
            screen_recording_alert(
                &snapshot.sources.devices.devices,
                videorc_app_core::desktop::permissions::PermissionPlatform::current(),
                Some(&self.permissions.snapshot()),
            )
        });
        if let ScenesSectionView::Gallery(gallery) = &view {
            // A scene that left the list takes its focus and room along.
            self.focus
                .retain(|id, _| gallery.cards.iter().any(|card| &card.id == id));
            self.text_room
                .retain(|id, _| gallery.cards.iter().any(|card| &card.id == id));
            self.update_stills(
                gallery,
                session_active(snapshot),
                snapshot.connection_generation,
                matches!(
                    snapshot.connection,
                    videorc_app_core::studio::Connection::Connected { .. }
                ),
                cx,
            );
        }
        if view != self.view || on_stream != self.on_stream || screen_alert != self.screen_alert {
            self.view = view;
            self.on_stream = on_stream;
            self.screen_alert = screen_alert;
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

    /// A card's room for its name or meta words (`name` picks which).
    fn measured_text(&mut self, id: &str, name: bool, width: f32, cx: &mut Context<Self>) {
        let room = self.text_room.entry(id.to_string()).or_insert((0., 0.));
        let slot = if name { &mut room.0 } else { &mut room.1 };
        if (width - *slot).abs() >= 0.5 {
            *slot = width;
            cx.notify();
        }
    }

    /// `move` (D5): the position keys move with the positions.
    fn move_scene(&mut self, id: String, to_index: usize) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            if !studio.move_scene(&id, to_index).await {
                eprintln!("[videorc-app] Scenes: the scene didn't move");
            }
        });
    }

    /// A drag over the card at `index` (P281), from the card at `from`.
    fn drag_over(&mut self, from: usize, index: usize, cx: &mut Context<Self>) {
        if self.drag != Some((from, index)) {
            self.drag = Some((from, index));
            cx.notify();
        }
    }

    /// A card's click (`dialogs.select`, P280): a scene whose sources need
    /// choosing again opens Resolve scene sources; any other goes on
    /// stream, and a failure with no words of its own opens Resolve with its
    /// line (never for an app scene, whose window is found when it goes on),
    /// as the Scene page's rows do. A refusal in words is the core's toast.
    fn select(
        &mut self,
        id: String,
        needs_sources: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if needs_sources {
            self.open_resolve(&id, false, window, cx);
            return;
        }
        let app_scene = self
            .studio
            .watch()
            .borrow()
            .scenes
            .scenes
            .iter()
            .find(|scene| scene.id == id)
            .is_some_and(|scene| scene.app().is_some());
        let studio = self.studio.clone();
        let applied = id.clone();
        let (done, answer) = tokio::sync::oneshot::channel();
        self.runtime.spawn(async move {
            let result = studio
                .apply_saved_scene(&applied, None, Default::default())
                .await;
            if !result.ok {
                eprintln!("[videorc-app] Scenes: the scene didn't go on stream");
            }
            let _ = done.send(!result.ok && result.message.is_none() && !result.superseded);
        });
        cx.spawn_in(window, async move |this, cx| {
            let failed = answer.await.unwrap_or(false);
            if failed && !app_scene {
                let _ = this.update_in(cx, |section, window, cx| {
                    section.open_resolve(&id, true, window, cx)
                });
            }
        })
        .detach();
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

/// The section's doors into the shared scene dialogs, and the ⋯ menu's
/// writes (`useSceneDialogs`).
impl ScenesSection {
    /// Add scene… (P276), also ⌘K's (P283): never in a library from a newer
    /// Videorc, nor while the room holds the section.
    pub fn open_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ScenesSectionView::Gallery(gallery) = &self.view else {
            return;
        };
        if gallery.read_only {
            return;
        }
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_add(None, window, cx));
    }

    fn open_rename(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_rename(id, None, window, cx));
    }

    /// Change screen… for one scene; `for_layout` is D19's layout that asked
    /// for a screen, put on once the screen lands.
    fn open_change_screen(
        &mut self,
        id: &str,
        for_layout: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dialogs.update(cx, |dialogs, cx| {
            dialogs.open_change_screen(id, for_layout, None, window, cx)
        });
    }

    fn open_set_key(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_set_key(id, None, window, cx));
    }

    fn open_guests(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_guests(id, None, window, cx));
    }

    fn open_delete(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.dialogs
            .update(cx, |dialogs, cx| dialogs.open_delete(id, None, window, cx));
    }

    /// Resolve scene sources (P315, P316); `apply_failed` adds the failed
    /// apply's line.
    fn open_resolve(
        &mut self,
        id: &str,
        apply_failed: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dialogs.update(cx, |dialogs, cx| {
            dialogs.open_resolve(id, apply_failed, None, window, cx)
        });
    }

    /// Follow the app / Stop following (`sceneWithFollow`).
    fn set_follows(&self, id: &str, follows: bool) {
        let studio = self.studio.clone();
        let Some(scene) = studio
            .watch()
            .borrow()
            .scenes
            .scenes
            .iter()
            .find(|scene| scene.id == id)
            .cloned()
        else {
            return;
        };
        self.runtime.spawn(async move {
            let next = scene_with_follow(&scene, follows, &now_iso());
            if !studio.replace_listed_scene(&next).await {
                eprintln!("[videorc-app] Scenes: the scene's follow wasn't saved");
            }
        });
    }

    /// Save audio to scene (`sceneWithAudio` with the working audio).
    fn save_audio(&self, id: &str) {
        let studio = self.studio.clone();
        let (scene, working) = {
            let watch = studio.watch();
            let snapshot = watch.borrow();
            let capture = &snapshot.settings.capture_doc;
            let working = scene_audio(
                &capture["sources"],
                capture["audio"]["systemAudioEnabled"] == serde_json::Value::Bool(true),
            );
            let scene = snapshot
                .scenes
                .scenes
                .iter()
                .find(|scene| scene.id == id)
                .cloned();
            (scene, working)
        };
        let Some(scene) = scene else {
            return;
        };
        self.runtime.spawn(async move {
            let next = scene_with_audio(&scene, working, &now_iso());
            if !studio.replace_listed_scene(&next).await {
                eprintln!("[videorc-app] Scenes: the scene's audio wasn't saved");
            }
        });
    }

    /// Duplicate (D5, D6): a deep copy named "{name} 2", at the end of the
    /// list, without its custom key.
    fn duplicate(&self, id: &str) {
        let studio = self.studio.clone();
        let copy = {
            let watch = studio.watch();
            let snapshot = watch.borrow();
            snapshot.scenes.library.as_ref().and_then(|library| {
                library
                    .scenes
                    .iter()
                    .find(|scene| scene.id == id)
                    .map(|stored| {
                        duplicated_scene(
                            stored,
                            &library.scenes,
                            &uuid::Uuid::new_v4().to_string(),
                            &now_iso(),
                        )
                    })
            })
        };
        let Some(copy) = copy else {
            return;
        };
        self.runtime.spawn(async move {
            if !studio.insert_scenes(&[copy], None, &HashMap::new()).await {
                eprintln!("[videorc-app] Scenes: the scene wasn't duplicated");
            }
        });
    }

    /// A card's ⋯ menu (`dialogs.menuItems`, D11, P294–P301): edit, keeps,
    /// copy, then Delete; the states and reasons are the core's.
    fn menu_items(&self, card: &SceneCardView, cx: &mut Context<Self>) -> Vec<KebabMenuItem> {
        let section = cx.entity().downgrade();
        let menu = &card.menu;
        let mut items = Vec::new();

        let (id, weak) = (card.id.clone(), section.clone());
        let mut rename = KebabMenuItem::new("rename", menu_copy::RENAME, move |window, cx| {
            let _ = weak.update(cx, |section, cx| section.open_rename(&id, window, cx));
        })
        .group("edit");
        if let Some(reason) = menu.read_only_reason {
            rename = rename.disabled(true).disabled_reason(reason);
        }
        items.push(rename);

        let (id, weak) = (card.id.clone(), section.clone());
        let mut change = KebabMenuItem::new(
            "change-screen",
            menu_copy::CHANGE_SCREEN,
            move |window, cx| {
                let _ = weak.update(cx, |section, cx| {
                    section.open_change_screen(&id, None, window, cx)
                });
            },
        )
        .group("edit");
        if let Some(reason) = menu.change_screen_reason.clone() {
            change = change.disabled(true).disabled_reason(reason);
        }
        items.push(change);

        // Set key… is never off, even read-only.
        let (id, weak) = (card.id.clone(), section.clone());
        items.push(
            KebabMenuItem::new("set-key", SET_KEY_LABEL, move |window, cx| {
                let _ = weak.update(cx, |section, cx| section.open_set_key(&id, window, cx));
            })
            .group("edit"),
        );

        if let Some(follows) = menu.follows {
            let (id, weak) = (card.id.clone(), section.clone());
            let mut follow = KebabMenuItem::new(
                "follow",
                if follows {
                    menu_copy::STOP_FOLLOWING
                } else {
                    menu_copy::FOLLOW_THE_APP
                },
                move |_, cx| {
                    let _ = weak.update(cx, |section, _| section.set_follows(&id, !follows));
                },
            )
            .group("keeps");
            if let Some(reason) = menu.read_only_reason {
                follow = follow.disabled(true).disabled_reason(reason);
            }
            items.push(follow);
        }

        let (id, weak) = (card.id.clone(), section.clone());
        let mut save_audio =
            KebabMenuItem::new("save-audio", menu_copy::SAVE_AUDIO, move |_, cx| {
                let _ = weak.update(cx, |section, _| section.save_audio(&id));
            })
            .group("keeps");
        if let Some(reason) = menu.save_audio_reason {
            save_audio = save_audio.disabled(true).disabled_reason(reason);
        }
        items.push(save_audio);

        let (id, weak) = (card.id.clone(), section.clone());
        let mut guests = KebabMenuItem::new("guests", GUESTS_LABEL, move |window, cx| {
            let _ = weak.update(cx, |section, cx| section.open_guests(&id, window, cx));
        })
        .group("keeps");
        if let Some(reason) = menu.read_only_reason {
            guests = guests.disabled(true).disabled_reason(reason);
        }
        items.push(guests);

        let (id, weak) = (card.id.clone(), section.clone());
        let mut duplicate = KebabMenuItem::new("duplicate", menu_copy::DUPLICATE, move |_, cx| {
            let _ = weak.update(cx, |section, _| section.duplicate(&id));
        })
        .group("copy");
        if let Some(reason) = menu.read_only_reason {
            duplicate = duplicate.disabled(true).disabled_reason(reason);
        }
        items.push(duplicate);

        // Plan 231 D16: the last scene stays, and so does the scene on
        // stream while recording or live (P317's words are the dialog's).
        let (id, weak) = (card.id.clone(), section);
        let mut delete = KebabMenuItem::new("delete", menu_copy::DELETE, move |window, cx| {
            let _ = weak.update(cx, |section, cx| section.open_delete(&id, window, cx));
        })
        .destructive(true);
        if menu.delete_disabled {
            delete = delete.disabled(true);
            if let Some(reason) = menu.delete_reason {
                delete = delete.disabled_reason(reason);
            }
        }
        items.push(delete);
        items
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
    /// What the screen area shows, in the secondary tier.
    screen_glyph: Hsla,
    /// The camera's glyph on its plate (`text-foreground/45`), opaque.
    camera_glyph: Hsla,
    /// A disabled card's picture is half over the card's ground.
    still_veil: Option<Hsla>,
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
        let camera_glyph = faded_over(t.foreground, camera, 0.45);
        let dim = |color: Color| {
            if disabled {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };
        Self {
            screen_glyph: hsla(dim(t.muted_foreground)),
            camera_glyph: hsla(dim(camera_glyph)),
            still_veil: disabled.then(|| hsla(with_alpha(ground, 0.5))),
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

/// The screen area's content (`ThumbScreen`, P286, P288): the scene's still
/// when one came back, else its glyph at card size, else the empty fill.
fn thumb_screen(
    card: &SceneCardView,
    still: Option<&Arc<gpui::Image>>,
    glyph: bool,
    corner: f32,
    paint: &Paint,
) -> Option<AnyElement> {
    if let Some(still) = still {
        return Some(
            div()
                .relative()
                .size_full()
                .child(
                    img(still.clone())
                        .size_full()
                        .rounded(px(corner))
                        .object_fit(ObjectFit::Cover),
                )
                .when_some(paint.still_veil, |area, veil| {
                    area.child(
                        div()
                            .absolute()
                            .top_0()
                            .left_0()
                            .size_full()
                            .rounded(px(corner))
                            .bg(veil),
                    )
                })
                .into_any_element(),
        );
    }
    glyph.then(|| {
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(icon(glyph_icon(&card.glyph), 24., paint.screen_glyph))
            .into_any_element()
    })
}

/// The layout diagram (`LayoutThumb`, P288): its frame and areas; a 9:16
/// one upright in a 4:3 well. Never the live program: the screen area holds
/// the scene's still or glyph, the camera plate its glyph.
fn layout_thumb(
    card: &SceneCardView,
    inner: f32,
    paint: &Paint,
    still: Option<&Arc<gpui::Image>>,
) -> AnyElement {
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
            let corner = corner_px(area.corner);
            let content = match area.part {
                ThumbPart::Screen => thumb_screen(card, still, area.glyph, corner, paint),
                // `size-3.5 max-h-[60%]`: 14 px, never over 60% of the plate.
                ThumbPart::Camera => area.glyph.then(|| {
                    div()
                        .size_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon(
                            IconName::VideoCamera,
                            (area.height * 0.6).min(14.),
                            paint.camera_glyph,
                        ))
                        .into_any_element()
                }),
            };
            div()
                .absolute()
                .left(px(area.left))
                .top(px(area.top))
                .w(px(area.width))
                .h(px(area.height))
                .overflow_hidden()
                .rounded(px(corner))
                .bg(match area.part {
                    ThumbPart::Camera => paint.camera,
                    ThumbPart::Screen => paint.screen,
                })
                .when(area.rim, |plate| {
                    plate.border_1().border_color(paint.pip_rim)
                })
                .children(content)
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
    /// A card's room measure: a canvas over its line that reports the
    /// line's width at paint (P292).
    fn text_measure(&self, id: &str, name: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let weak = cx.entity().downgrade();
        let id = id.to_string();
        canvas(
            move |bounds, _, cx| {
                let width = f32::from(bounds.size.width);
                weak.update(cx, |section, cx| {
                    section.measured_text(&id, name, width, cx)
                })
                .ok();
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }

    /// One scene card (`SceneCard`, P281, P282, P286, P288–P290, P292,
    /// P293).
    #[allow(clippy::too_many_arguments)]
    fn card(
        &mut self,
        index: usize,
        card: &SceneCardView,
        count: usize,
        read_only: bool,
        width: f32,
        t: &Theme,
        window: &mut Window,
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
        let still = card
            .picture
            .as_ref()
            .and_then(|target| self.stills.image(&picture_key(target)));

        // The well, and the ring a 2 px gap off it on the scene on stream:
        // the text's own tone, never a colour.
        let well = div()
            .relative()
            .flex_none()
            .child(layout_thumb(card, inner, &paint, still.as_ref()))
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

        let focus = self
            .focus
            .entry(card.id.clone())
            .or_insert_with(|| cx.focus_handle())
            .clone();
        // Focus anywhere in the card (the card itself, or tabbed into its ⋯)
        // shows the ⋯ and hides the check, as hover does
        // (`scene-card.tsx:182`, `group-focus-within/kebab-host`; the kit's
        // own focus-within covers only the ⋯'s trigger and open menu).
        let focus_within = focus.contains_focused(window, cx);

        // The icon of what it shows before the name (`SceneGlyphIcon`),
        // faded with a disabled card.
        let name_row = div()
            .mt(px(8.))
            .h(px(20.))
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .child(icon(glyph_icon(&card.glyph), 16., paint.screen_glyph))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(NAME_TEXT_PX))
                    .line_height(px(20.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(name_ink)
                    .child(card.name.clone())
                    .child(self.text_measure(&card.id, true, cx)),
            )
            // The check's place is the ⋯'s: on hover and focus the menu
            // takes it.
            .child(
                div()
                    .flex_none()
                    .size(px(16.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(card.on_stream, |check| {
                        check
                            .group_hover(KEBAB_HOST, |style| style.opacity(0.))
                            .when(focus_within, |check| check.opacity(0.))
                            .child(icon(IconName::Check, 16., foreground))
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
                .relative()
                .flex_1()
                .min_w_0()
                .truncate()
                .child(card.meta.clone().unwrap_or_default())
                .child(self.text_measure(&card.id, false, cx))
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

        // P292: the whole name, and the meta words when they were cut, on
        // hover, only when a line cut them. GPUI can't say whether text was
        // cut, so the words' shaped width is held against the line's room.
        let (name_room, meta_room) = self.text_room.get(&card.id).copied().unwrap_or_default();
        let name_cut = name_room > 0.
            && text_width(
                window,
                &card.name,
                NAME_TEXT_PX,
                FontWeight::MEDIUM,
                name_ink,
            ) > name_room + 0.5;
        let meta_words = (!card.pending).then_some(card.meta.as_deref()).flatten();
        let meta_cut = meta_room > 0.
            && meta_words.is_some_and(|words| {
                text_width(
                    window,
                    words,
                    text::META.size,
                    FontWeight(text::META.weight),
                    muted,
                ) > meta_room + 0.5
            });
        let cut = cut_tooltip(&card.name, name_cut, meta_words, meta_cut);

        let interactive = !card.on_stream && !card.disabled;
        let accent = hsla(t.accent);
        // The selected plate's light and shade, and the keyboard's ring.
        let plate = if card.on_stream {
            vec![
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
            ]
        } else {
            Vec::new()
        };
        let mut focused = plate.clone();
        focused.push(focus_ring(t));

        // P281: where a dragged card would land beside this one.
        let edge = self
            .drag
            .filter(|(_, over)| *over == index)
            .and_then(|(from, _)| drop_edge(from, index));
        // P281: the card being dragged fades while it moves
        // (`scene-presets.tsx:188`, `reorder.dragging(scene.id) && 'opacity-40'`).
        let dragging = cx.has_active_drag() && self.drag.is_some_and(|(from, _)| from == index);
        let ring = hsla(t.ring);

        let id = card.id.clone();
        let key_id = card.id.clone();
        let drop_id = card.id.clone();
        let disabled = card.disabled;
        let needs_sources = card.needs_sources;
        let key_focus = focus.clone();
        // P294–P301: over the name row's last place (`right-1 bottom-7.5`),
        // centred on that row and the check's 16 px; shown on hover.
        let menu = div().absolute().right(px(4.)).bottom(px(30.)).child(
            KebabMenu::new(
                SharedString::from(format!("scene-card-actions-{}", card.id)),
                self.menu_items(card, cx),
            )
            .label(menu_copy::actions_for(&card.name))
            .reveal(if focus_within {
                KebabReveal::Always
            } else {
                KebabReveal::Hover
            }),
        );
        div()
            .id(("scene-card", index))
            .group(KEBAB_HOST)
            .role(Role::Button)
            .aria_label(card.name.clone())
            .track_focus(&focus)
            .tab_index(0)
            .relative()
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
                        .shadow(plate)
                } else {
                    card_box
                        .border_color(hsla(t.border))
                        .bg(hsla(with_alpha(t.foreground, 0.04)))
                }
            })
            .focus_visible(move |style| style.shadow(focused))
            .when(dragging, |card_box| card_box.opacity(DRAGGING_OPACITY))
            .when(interactive, |card_box| {
                card_box
                    .cursor_pointer()
                    .hover(move |style| style.bg(accent))
            })
            .when(!disabled, |card_box| {
                card_box.on_click(cx.listener(move |section, _, window, cx| {
                    section.select(id.clone(), needs_sources, window, cx);
                }))
            })
            // ⌥← ⌥→ move the card (P282), on the card itself, while it can't
            // go on too; Enter and Space put it on stream, as its button
            // (only the card's own: the ⋯ inside it takes its own keys).
            .on_key_down(
                cx.listener(move |section, event: &KeyDownEvent, window, cx| {
                    let keystroke = &event.keystroke;
                    let modifiers = &keystroke.modifiers;
                    let dom_key = match keystroke.key.as_str() {
                        "left" => "ArrowLeft",
                        "right" => "ArrowRight",
                        "up" => "ArrowUp",
                        "down" => "ArrowDown",
                        other => other,
                    };
                    let key = MoveKey {
                        key: dom_key,
                        alt: modifiers.alt,
                        ctrl: modifiers.control,
                        meta: modifiers.platform,
                        shift: modifiers.shift,
                    };
                    if let Some(target) = card_move_target(key, index, count, read_only) {
                        cx.stop_propagation();
                        section.move_scene(key_id.clone(), target);
                        return;
                    }
                    let plain = !modifiers.alt
                        && !modifiers.control
                        && !modifiers.platform
                        && !modifiers.shift;
                    if plain
                        && !disabled
                        && key_focus.is_focused(window)
                        && matches!(keystroke.key.as_str(), "enter" | "space")
                    {
                        cx.stop_propagation();
                        section.select(key_id.clone(), needs_sources, window, cx);
                    }
                }),
            )
            .when(!read_only, |card_box| {
                card_box
                    .on_drag(
                        SceneDrag {
                            id: card.id.clone(),
                            index,
                            card: card.clone(),
                            width,
                            still: still.clone(),
                        },
                        |drag: &SceneDrag, _, _, cx| cx.new(|_| drag.clone()),
                    )
                    .on_drag_move(cx.listener(
                        move |section, event: &DragMoveEvent<SceneDrag>, _, cx| {
                            if event.bounds.contains(&event.event.position) {
                                let from = event.drag(cx).index;
                                section.drag_over(from, index, cx);
                            }
                        },
                    ))
                    .on_drop(cx.listener(move |section, drag: &SceneDrag, _, cx| {
                        section.drag = None;
                        cx.notify();
                        if drag.id != drop_id {
                            section.move_scene(drag.id.clone(), index);
                        }
                    }))
            })
            .map(
                |card_box| match card.disabled_reason.clone().filter(|_| disabled) {
                    // A card's own reason wins over the cut words (P293).
                    Some(reason) => card_box.tooltip(tooltip(reason)),
                    None => match cut {
                        Some(words) => card_box.tooltip(tooltip(words)),
                        None => card_box,
                    },
                },
            )
            .child(well)
            .child(name_row)
            .child(meta_row)
            .child(menu)
            // The drop line, 2 px in the ring's tone, in the gap beside the
            // card (`before:w-0.5 before:bg-ring`, 5 px out).
            .children(edge.map(|edge| {
                let line = div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .w(px(2.))
                    .rounded_full()
                    .bg(ring);
                match edge {
                    DropEdge::Before => line.left(px(-5.)),
                    DropEdge::After => line.right(px(-5.)),
                }
            }))
            .into_any_element()
    }

    fn gallery(
        &mut self,
        gallery: &ScenesGalleryView,
        t: &Theme,
        window: &mut Window,
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
            )
            .action(
                // P276: the same Add scene… as the Scene page's, off with its
                // reason in a library from a newer Videorc.
                div()
                    .id("scene-add-reason")
                    .child(
                        Button::new("scene-add")
                            .variant(ButtonVariant::Outline)
                            .label(menu_copy::ADD_SCENE)
                            .disabled(gallery.read_only)
                            .on_click(
                                cx.listener(|section, _, window, cx| section.open_add(window, cx)),
                            ),
                    )
                    .when(gallery.read_only, |wrap| {
                        wrap.tooltip(tooltip(copy::READ_ONLY_REASON))
                    }),
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
                    .child(icon(IconName::Monitor, 16., muted))
                    .tooltip(copy::HORIZONTAL_TOOLTIP),
            )
            .option(
                Segment::new(copy::VERTICAL, copy::VERTICAL_SEGMENT)
                    .child(icon(IconName::DeviceMobile, 16., muted))
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
        let count = gallery.cards.len();
        let mut cards: Vec<AnyElement> = Vec::with_capacity(count);
        for (index, card) in gallery.cards.iter().enumerate() {
            cards.push(self.card(index, card, count, gallery.read_only, card_w, t, window, cx));
        }
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
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .label(copy::OPEN_SOURCES)
                        .on_click(
                            cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Sources))),
                        ),
                )
        });
        // Plan 231 D8: under the cards, the scene on stream's own fields.
        let fields = self.on_stream_fields(t, window, cx);
        section
            .child(controls)
            .children(error)
            .child(grid)
            .children(status)
            .children(reason)
            .children(fields)
            .child(self.dialogs_host())
    }

    /// The dialogs draw over the window (gpui-base's deferred overlay);
    /// their host takes no room and no gap in the section.
    fn dialogs_host(&self) -> impl IntoElement {
        div().absolute().size_0().child(self.dialogs.clone())
    }
}

impl Render for ScenesSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        // A drag that ended anywhere (dropped elsewhere, or let go outside
        // the window) takes its drop line along.
        if self.drag.is_some() && !cx.has_active_drag() {
            self.drag = None;
        }
        match self.view.clone() {
            // P272: while the room is open the Show stage's layouts are
            // what goes on air. C3: Use scenes opt-in beside that line.
            ScenesSectionView::RoomOpen => {
                let scenes_on = self
                    .room_host
                    .as_ref()
                    .is_some_and(|host| host.read(cx).scenes_enabled());
                let host = self.room_host.clone();
                let line = div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .w_full()
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(ScenesSectionView::room_open_line()),
                    )
                    .when_some(host, |row, host| {
                        row.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .type_scale(text::META)
                                        .text_color(hsla(t.muted_foreground))
                                        .child(USE_SCENES),
                                )
                                .child(
                                    Switch::new("room-use-scenes")
                                        .small(true)
                                        .checked(scenes_on)
                                        .accessibility_label(USE_SCENES)
                                        .on_change(move |value, _, cx| {
                                            host.update(cx, |host, cx| {
                                                host.set_scenes_enabled(value, cx);
                                            });
                                        }),
                                ),
                        )
                    });
                PanelSection::new("studio-scenes")
                    .title(copy::TITLE)
                    .description(line)
            }
            // P287: the section's room while the library is read.
            ScenesSectionView::Loading => PanelSection::new("studio-scenes")
                .title(copy::TITLE)
                .child(Skeleton::new("scenes-loading").w_full().h(px(320.)))
                .child(self.dialogs_host()),
            ScenesSectionView::Gallery(gallery) => self.gallery(&gallery, t, window, cx),
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
