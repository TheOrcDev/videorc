//! Show stage (`show-stage.tsx`; P357–P394): replaces the Preview while the
//! talk-show room is open. Words and stage geometry come from
//! `videorc_app_core::guests`; close room and Let in / Decline call Studio.
//! Live pictures and room actions come from [`TalkShowRoomHost`] (L1):
//! `room_media`, `remote_frame`, `share_screen` / `stop_screen_share`,
//! `set_stage`, and the Program monitor + Listen.

mod camera_off;
mod cards;
mod moderation;
mod privacy;
mod room_person;

use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, Image, ObjectFit, Role, SharedString, Window,
    div, img, prelude::*, px, relative,
};
use videorc_app_core::guests::layout::{
    StageCanvas, StageTile, StageTileKind, plan_stage, show_stage_input, stage_rect_fraction,
};
use videorc_app_core::guests::program::{ProgramMonitorView, StageMonitorState, is_managed_show};
use videorc_app_core::guests::session::PROGRAM_MONITOR_EMPTY;
use videorc_app_core::guests::stage_screens::{
    STAGE_MAX_SCREENS, add_screen, one_screen_stage, prune_stage_screens, remove_screen,
    screens_of, stage_sharers, two_screens_chosen, two_screens_stage,
};
use videorc_app_core::guests::tile::{host_circle, shows_away};
use videorc_app_core::guests::view::{
    self as guests, CloudRoomFacts, Heard, LayoutOption, RoomPerson, RoomScreen,
    bring_on_blocked_reason, close_room_asks_first, layout_options, layout_reasons_line,
    mic_toggle_label, person_mic_view, room_limits, room_people, room_screens, selected_layout,
    stage_with_screen_card,
};
use videorc_app_core::guests::wire::{
    DrawnStageLayout, RecordingStatus, RoomClientState, RoomParticipant, RoomPhase, RoomStatus,
    Stage, StageLayout,
};
use videorc_app_core::livestream::cloud_status::CloudStatus;
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::room_frames::RemoteSource;
use videorc_app_core::studio::room_media::RoomMedia;
use videorc_app_core::studio::screen_views::{PREVIEW_REPLACED_BY_SHOW_STAGE, TalkShowRoomView};
use videorc_app_core::studio::source_selection::{
    SourceKind, camera_picker_devices, capture_picker_devices,
};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::kebab_menu::KebabMenuItem;
use videorc_kit::list_row::GroupedList;
use videorc_kit::panel_section::PanelSection;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::spinner::Spinner;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::theme::{self, TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, text};
use videorc_kit::tooltip::tooltip;

use super::talk_show_host::TalkShowRoomHost;
use super::transport::{AppStudio, OpenPage};
use crate::app::bridge::Mirror;
use camera_off::{CAMERA_OFF_LABEL, camera_off_avatar};
use cards::{StageCard, card_columns, reasons_line, screen_thumb, stage_layout_thumb};
use moderation::GuestModeration;
use room_person::{PersonRowParts, count_label, person_row, request_row};
use videorc_protocol::ScreenPrivacy;

const STAGE_CANVAS: StageCanvas = StageCanvas {
    width: 1920,
    height: 1080,
};
const SHOW_STAGE_TITLE: &str = "Show stage";
const CLOSE_ROOM_CONFIRM_TITLE: &str = "Close the room?";
const CLOSING: &str = "Closing…";
const CANCEL: &str = "Cancel";
const ROOM_VIEW: &str = "Room view";
const ROOM_LABEL: &str = "Room";
const ROOM_TOOLTIP: &str = "What you and your guests see in the room now. Viewers see the Program.";
const NOBODY_ON_STAGE: &str = "Nobody is on stage.";
const JOINING: &str = "Joining the room…";
const RECONNECTING: &str = "Reconnecting…";
const WAITING_SCREEN: &str = "Waiting for the screen";
const NO_PICTURE: &str = "No picture yet";
const BACK_IN_A_MOMENT: &str = "Back in a moment";
const WANTS_TO_JOIN: &str = "Wants to join";
const LAYOUT: &str = "Layout";
const SCREENS: &str = "Screens";
const ON_STAGE: &str = "On stage";
const PUT_ON_STAGE: &str = "Put on stage";
const BACKSTAGE: &str = "Backstage";
const BRING_ON: &str = "Bring on";
const SEND_BACKSTAGE: &str = "Send backstage";
const INVITE_LINK: &str = "Invite link";
const PROGRAM: &str = "Program";
const PROGRAM_PREVIEW: &str = "Program preview";
const WAITING_PROGRAM: &str = "Waiting for the program…";
const SHARE_SCREEN: &str = "Share screen…";
const STOP_SHARING: &str = "Stop sharing";
const SHARE_A_SCREEN_TITLE: &str = "Share a screen";
const SHARE_A_SCREEN_DESCRIPTION: &str =
    "Your guests and your viewers see it. Pick a screen or one window.";
const NOTHING_TO_SHARE: &str = "Nothing to share. Check Screen Recording in System Settings.";
const LISTEN_PROGRAM: &str = "Listen to the program";
const MUTE_PROGRAM: &str = "Mute the program";
const ROOM_HOST_PENDING: &str = "Opens once the talk-show room host joins.";
const REQUESTS_SHOWN: usize = 3;

fn cloud_facts(status: Option<&CloudStatus>) -> Option<CloudRoomFacts> {
    status.map(|status| CloudRoomFacts {
        entitled: status.entitled,
        plan: status.plan.clone(),
        allowance: status.allowance.clone(),
        room: status.room.as_ref().and_then(RoomStatus::from_value),
        recording: status
            .recording
            .as_ref()
            .and_then(RecordingStatus::from_value),
    })
}

fn more_want_to_join(n: usize) -> String {
    if n == 1 {
        "1 more wants to join".into()
    } else {
        format!("{n} more want to join")
    }
}

/// Bring on / Send backstage: the host leads the list (Electron `stageWith`).
fn stage_with(stage: &Stage, identity: &str, on_stage: bool, host_identity: Option<&str>) -> Stage {
    let without: Vec<String> = stage
        .on_stage
        .iter()
        .filter(|entry| entry.as_str() != identity)
        .cloned()
        .collect();
    let next = if on_stage {
        let mut next = without;
        next.push(identity.to_string());
        next
    } else {
        without
    };
    let ordered = match host_identity {
        Some(host) => {
            let mut ordered = vec![host.to_string()];
            ordered.extend(next.into_iter().filter(|entry| entry != host));
            ordered
        }
        None => next,
    };
    let spotlight = stage
        .spotlight
        .as_ref()
        .filter(|spot| ordered.contains(spot))
        .cloned();
    prune_stage_screens(&Stage {
        on_stage: ordered,
        spotlight,
        ..stage.clone()
    })
}

fn stage_for_layout(
    stage: &Stage,
    layout: DrawnStageLayout,
    room: Option<&RoomStatus>,
    host_identity: Option<&str>,
    host_sharing: bool,
) -> Option<Stage> {
    match layout {
        DrawnStageLayout::TwoScreens => {
            let sharers = stage_sharers(room, host_identity, host_sharing);
            two_screens_stage(stage, &sharers)
        }
        DrawnStageLayout::ScreenPeople => Some(one_screen_stage(stage)),
        DrawnStageLayout::Solo => Some(Stage {
            layout: StageLayout::Solo,
            ..stage.clone()
        }),
        DrawnStageLayout::SideBySide => Some(Stage {
            layout: StageLayout::SideBySide,
            ..stage.clone()
        }),
        DrawnStageLayout::Spotlight => Some(Stage {
            layout: StageLayout::Spotlight,
            ..stage.clone()
        }),
    }
}

type WindowAction = Rc<dyn Fn(&mut Window, &mut App)>;

/// The Show stage that replaces the Preview while the room is open.
pub struct ShowStage {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    talk_show: Entity<Mirror<TalkShowRoomView>>,
    room_host: Option<Entity<TalkShowRoomHost>>,
    facts: Option<CloudRoomFacts>,
    show_node_id: Option<String>,
    closing: bool,
    /// Plan 251: the Two screens card stays chosen while one screen is up.
    two_screens_picked: bool,
    /// Share picker / share_screen in flight.
    share_pending: bool,
    share_picker: DialogHandle,
    close_confirm: DialogHandle,
    /// Mute hold, screen share and Rename/Remove/Ban for a guest's row.
    moderation: Entity<GuestModeration>,
    /// Hide screen's backend state (`useScreenPrivacy`), mirrored here.
    privacy: ScreenPrivacy,
    privacy_revision: u64,
}

impl EventEmitter<OpenPage> for ShowStage {}

impl ShowStage {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        talk_show: Entity<Mirror<TalkShowRoomView>>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&talk_show, |stage, _, cx| {
            stage.sync_monitor(cx);
            cx.notify();
        })
        .detach();
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut cloud_rx = studio_watch.cloud();
            loop {
                let state = cloud_rx.borrow().clone();
                let facts = cloud_facts(state.status.as_ref());
                let show_node_id = state
                    .status
                    .as_ref()
                    .and_then(|s| s.show.as_ref())
                    .map(|show| show.node_id.clone())
                    .filter(|id| !id.is_empty());
                this.update(cx, |stage, cx| {
                    if stage.facts != facts || stage.show_node_id != show_node_id {
                        stage.facts = facts;
                        stage.show_node_id = show_node_id;
                        stage.sync_monitor(cx);
                        cx.notify();
                    }
                })
                .ok();
                if cloud_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .detach();
        let moderation = cx.new(|_| GuestModeration::new(studio.clone(), runtime.clone()));
        cx.observe(&moderation, |_, _, cx| cx.notify()).detach();
        let mut stage = Self {
            privacy: ScreenPrivacy::default(),
            privacy_revision: 0,
            moderation,
            studio,
            runtime,
            talk_show,
            room_host: None,
            facts: None,
            show_node_id: None,
            closing: false,
            two_screens_picked: false,
            share_pending: false,
            share_picker: DialogHandle::new(false),
            close_confirm: DialogHandle::new(false),
        };
        stage.watch_privacy(cx);
        stage
    }

    /// Wire the talk-show host so tiles, Screens, layouts and the Program
    /// monitor use live room media (L1 / R4).
    pub fn bind_room_host(&mut self, host: Entity<TalkShowRoomHost>, cx: &mut Context<Self>) {
        cx.observe(&host, |_, _, cx| cx.notify()).detach();
        self.room_host = Some(host);
        self.sync_monitor(cx);
        cx.notify();
    }

    fn room(&self) -> Option<&RoomStatus> {
        self.facts.as_ref().and_then(|f| f.room.as_ref())
    }

    fn host_identity(&self, cx: &App) -> Option<String> {
        self.talk_show.read(cx).value().host_identity.clone()
    }

    fn room_media<'a>(&'a self, cx: &'a App) -> Option<&'a RoomMedia> {
        self.room_host
            .as_ref()
            .and_then(|host| host.read(cx).room_media())
    }

    fn host_sharing(&self, cx: &App) -> bool {
        self.room_media(cx)
            .and_then(|media| media.screen.as_ref())
            .is_some()
    }

    fn remote_frame(&self, identity: &str, source: RemoteSource, cx: &App) -> Option<Arc<Image>> {
        self.room_host
            .as_ref()
            .and_then(|host| host.read(cx).remote_frame(identity, source))
    }

    /// Node shows: turn the Program monitor on while the room is open (as
    /// Electron mounts Listen on the Show stage).
    fn sync_monitor(&mut self, cx: &mut Context<Self>) {
        let Some(host) = self.room_host.clone() else {
            return;
        };
        let open = self.room().is_some_and(|r| r.phase == RoomPhase::Open);
        let managed = is_managed_show(self.show_node_id.as_deref());
        host.update(cx, |host, cx| {
            if open && !managed {
                if !host.monitor() {
                    host.set_monitor(true, cx);
                }
            } else if host.monitor() {
                host.set_monitor(false, cx);
            }
        });
    }

    fn ask_or_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        if close_room_asks_first(self.facts.as_ref()) {
            self.close_confirm.open(window, cx);
            cx.notify();
        } else {
            self.close_room(window, cx);
        }
    }

    fn close_room(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        self.closing = true;
        self.close_confirm.close(window, cx);
        cx.notify();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            runtime
                .spawn(async move { studio.close_talk_room().await })
                .await
                .ok();
            let _ = this.update(cx, |stage, cx| {
                stage.closing = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn decide(&self, request_id: String, decision: &'static str) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.decide_talk_guest(&request_id, decision).await;
        });
    }

    fn open_guests(&mut self, cx: &mut Context<Self>) {
        cx.emit(OpenPage::of(PageId::Guests));
    }

    fn apply_stage(&mut self, next: Stage, cx: &mut Context<Self>) {
        let Some(host) = self.room_host.clone() else {
            eprintln!("[videorc-app] Show stage: set stage: {ROOM_HOST_PENDING}");
            return;
        };
        let task = host.update(cx, |host, cx| host.set_stage(next, cx));
        cx.spawn(async move |_this, _cx| {
            if let Err(error) = task.await {
                eprintln!("[videorc-app] Show stage: set stage: {error}");
            }
        })
        .detach();
    }

    fn set_layout(&mut self, layout: DrawnStageLayout, cx: &mut Context<Self>) {
        let Some(room) = self.room().cloned() else {
            return;
        };
        let host_identity = self.host_identity(cx);
        let host_sharing = self.host_sharing(cx);
        let Some(next) = stage_for_layout(
            &room.stage,
            layout,
            Some(&room),
            host_identity.as_deref(),
            host_sharing,
        ) else {
            return;
        };
        self.two_screens_picked = layout == DrawnStageLayout::TwoScreens;
        self.apply_stage(next, cx);
        cx.notify();
    }

    fn move_person(&mut self, identity: String, on_stage: bool, cx: &mut Context<Self>) {
        let Some(room) = self.room().cloned() else {
            return;
        };
        let host = self.host_identity(cx);
        if on_stage {
            let people = room_people(Some(&room), host.as_deref(), None);
            if bring_on_blocked_reason(&people, room_limits(self.facts.as_ref())).is_some() {
                return;
            }
        }
        let next = stage_with(&room.stage, &identity, on_stage, host.as_deref());
        self.apply_stage(next, cx);
    }

    fn toggle_screen_card(&mut self, screen: RoomScreen, cx: &mut Context<Self>) {
        let Some(room) = self.room().cloned() else {
            return;
        };
        if screen.blocked_reason.is_some() {
            return;
        }
        let next = stage_with_screen_card(&room.stage, &screen, self.two_screens_picked);
        self.apply_stage(next, cx);
    }

    fn open_share_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.share_pending || self.room_host.is_none() {
            return;
        }
        self.share_picker.open(window, cx);
        cx.notify();
    }

    fn share_source(&mut self, source_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(host) = self.room_host.clone() else {
            return;
        };
        self.share_picker.close(window, cx);
        self.share_pending = true;
        cx.notify();
        let task = host.update(cx, |host, cx| host.share_screen(&source_id, cx));
        let room = self.room().cloned();
        let host_identity = self.host_identity(cx);
        let two = self.two_screens_picked;
        let host_entity = host.clone();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |stage, cx| {
                stage.share_pending = false;
                cx.notify();
            });
            match result {
                Ok(()) => {
                    if let (Some(room), Some(identity)) = (room, host_identity) {
                        let max = if two { STAGE_MAX_SCREENS } else { 1 };
                        let next = add_screen(&room.stage, &identity, max);
                        let set = host_entity.update(cx, |host, cx| host.set_stage(next, cx));
                        if let Err(error) = set.await {
                            eprintln!("[videorc-app] Show stage: put screen on stage: {error}");
                        }
                    }
                }
                Err(error) => {
                    eprintln!("[videorc-app] Show stage: Share screen: {error}");
                }
            }
        })
        .detach();
    }

    fn stop_sharing(&mut self, cx: &mut Context<Self>) {
        let Some(host) = self.room_host.clone() else {
            return;
        };
        let room = self.room().cloned();
        let host_identity = self.host_identity(cx);
        host.update(cx, |host, _| host.stop_screen_share());
        if let (Some(room), Some(identity)) = (room, host_identity)
            && screens_of(&room.stage).iter().any(|id| id == &identity)
        {
            let next = remove_screen(&room.stage, &identity);
            self.apply_stage(next, cx);
        }
        cx.notify();
    }

    /// `setSpotlight`: the spotlight layout on this person.
    fn spotlight(&mut self, identity: String, cx: &mut Context<Self>) {
        let Some(room) = self.room().cloned() else {
            return;
        };
        self.apply_stage(
            Stage {
                layout: StageLayout::Spotlight,
                spotlight: Some(identity),
                ..room.stage.clone()
            },
            cx,
        );
    }

    /// The host's own mic, from their row: the Studio's mute.
    fn toggle_host_mic(&mut self, muted: bool) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.request_microphone_mute(!muted).await;
        });
    }

    /// The host's camera, from their row's ⋯: off is the Camera picker's
    /// Off; on picks the first camera the picker lists.
    fn set_host_camera(&mut self, on: bool) {
        let studio = self.studio.clone();
        let picked = on
            .then(|| {
                let devices = studio.snapshot().sources.devices.devices;
                camera_picker_devices(&devices)
                    .first()
                    .map(|device| device.id.clone())
            })
            .flatten();
        if on && picked.is_none() {
            eprintln!("[videorc-app] Show stage: Turn camera on: no camera listed");
            return;
        }
        self.runtime.spawn(async move {
            let result = studio
                .select_source_device(SourceKind::Camera, picked.as_deref())
                .await;
            if let Err(error) = result {
                eprintln!("[videorc-app] Show stage: camera: {error}");
            }
        });
    }

    fn toggle_listen(&mut self, cx: &mut Context<Self>) {
        let Some(host) = self.room_host.clone() else {
            return;
        };
        host.update(cx, |host, cx| {
            host.set_monitor_listening(!host.monitor_listening(), cx);
        });
    }
}

impl ShowStage {
    fn well(&self, t: &Theme, cx: &App) -> AnyElement {
        let room = self.room();
        let host = self.host_identity(cx);
        let tiles = plan_stage(STAGE_CANVAS, &show_stage_input(room));
        let client = room.map(|r| r.client).unwrap_or_default();
        let joining = matches!(
            client,
            RoomClientState::Connecting | RoomClientState::Reconnecting
        );
        let fg = hsla(t.video_ground_foreground);

        let mut well = div()
            .id("show-stage-well")
            .relative()
            .w_full()
            .overflow_hidden()
            .rounded(px(radius::PANEL))
            .bg(hsla(t.video_ground))
            .aspect_ratio(STAGE_CANVAS.width as f32 / STAGE_CANVAS.height as f32)
            .aria_label(ROOM_VIEW);

        for tile in &tiles {
            well = well.child(self.tile_view(tile, room, host.as_deref(), t, cx));
        }
        if tiles.is_empty() {
            well = well.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(Empty::new().description(NOBODY_ON_STAGE)),
            );
        }
        well = well.child(
            div().absolute().top(px(12.)).right(px(12.)).child(
                div()
                    .id("show-stage-room-label")
                    .px(px(10.))
                    .py(px(4.))
                    .rounded_full()
                    .bg(hsla(with_alpha(t.video_ground, 0.8)))
                    .type_scale(text::META)
                    .text_color(fg)
                    .child(ROOM_LABEL)
                    .tooltip(tooltip(ROOM_TOOLTIP)),
            ),
        );
        if joining {
            let words = if client == RoomClientState::Reconnecting {
                RECONNECTING
            } else {
                JOINING
            };
            well = well.child(
                div()
                    .id("show-stage-joining-status")
                    .absolute()
                    .top(px(12.))
                    .left(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .py(px(4.))
                    .rounded_full()
                    .bg(hsla(with_alpha(t.video_ground, 0.8)))
                    .type_scale(text::META)
                    .text_color(fg)
                    .role(Role::Status)
                    .child(Spinner::new("show-stage-joining"))
                    .child(words),
            );
        }
        well.into_any_element()
    }

    fn tile_camera_off(&self, tile: &StageTile, host_identity: Option<&str>, cx: &App) -> bool {
        if tile.kind == StageTileKind::Screen {
            return false;
        }
        let Some(media) = self.room_media(cx) else {
            return false;
        };
        if Some(tile.identity.as_str()) == host_identity {
            return !media.camera;
        }
        media
            .people
            .iter()
            .find(|person| person.identity == tile.identity)
            .is_some_and(|person| person.camera_off)
    }

    fn tile_view(
        &self,
        tile: &StageTile,
        room: Option<&RoomStatus>,
        host_identity: Option<&str>,
        t: &Theme,
        cx: &App,
    ) -> AnyElement {
        let [left, top, width, height] = stage_rect_fraction(STAGE_CANVAS, tile.rect);
        let participant =
            room.and_then(|r| r.participants.iter().find(|p| p.identity == tile.identity));
        let name = person_name(tile, participant, host_identity);
        let camera_off = self.tile_camera_off(tile, host_identity, cx);
        let away = participant.is_some_and(|p| shows_away(p.away, camera_off));
        let circle = host_circle(tile, host_identity, room.and_then(|r| r.stage.host_shape));
        let muted_fg = hsla(t.video_ground_muted);
        let fg = hsla(t.video_ground_foreground);
        let source = if tile.kind == StageTileKind::Screen {
            RemoteSource::Screen
        } else {
            RemoteSource::Camera
        };
        let frame = self.remote_frame(&tile.identity, source, cx);

        let mut body = div()
            .absolute()
            .left(relative(left as f32))
            .top(relative(top as f32))
            .w(relative(width as f32))
            .h(relative(height as f32))
            .overflow_hidden()
            .bg(hsla(t.inset))
            .when(!circle, |el| {
                el.rounded(px(
                    tile.corner_radius as f32 * (STAGE_CANVAS.width as f32 / 1920.)
                ))
            })
            .when(circle, |el| el.rounded_full());

        if camera_off {
            body = body.child(camera_off_avatar(
                &name,
                tile.rect.w,
                tile.rect.h,
                t,
                CAMERA_OFF_LABEL,
            ));
        } else if let Some(frame) = frame {
            body = body.child(
                img(frame)
                    .size_full()
                    .object_fit(ObjectFit::Cover)
                    .when(circle, |el| el.rounded_full()),
            );
        } else {
            let waiting = if tile.kind == StageTileKind::Screen {
                WAITING_SCREEN
            } else {
                NO_PICTURE
            };
            body = body.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .type_scale(text::META)
                    .text_color(muted_fg)
                    .child(waiting),
            );
        }
        if away && tile.kind == StageTileKind::Person {
            body = body.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(hsla(with_alpha(t.video_ground, 0.6)))
                    .type_scale(text::META)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(BACK_IN_A_MOMENT),
            );
        }

        let mut stack = div().child(body);
        if let Some(plate) = tile.plate {
            // `tileVoice`: who talks and who can't be heard, on the picture.
            let voice = (tile.kind == StageTileKind::Person)
                .then(|| self.room_media(cx))
                .flatten()
                .and_then(|media| {
                    if Some(tile.identity.as_str()) == host_identity {
                        return (!media.microphone).then_some(true);
                    }
                    let person = media.people.iter().find(|p| p.identity == tile.identity);
                    if person.is_some_and(|p| p.mic_muted) || participant.is_some_and(|p| p.muted) {
                        Some(true)
                    } else {
                        person.is_some_and(|p| p.speaking).then_some(false)
                    }
                });
            let mark = voice.map(|muted| {
                if muted {
                    icon(IconName::WaveformSlash, 12., muted_fg).into_any_element()
                } else {
                    div()
                        .flex_none()
                        .size(px(6.))
                        .rounded_full()
                        .bg(hsla(t.success))
                        .into_any_element()
                }
            });
            let [pl, pt, pw, ph] = stage_rect_fraction(STAGE_CANVAS, plate);
            stack = stack.child(
                div()
                    .absolute()
                    .left(relative(pl as f32))
                    .top(relative(pt as f32))
                    .w(relative(pw as f32))
                    .h(relative(ph as f32))
                    .flex()
                    .items_end()
                    .child(
                        div()
                            .max_w_full()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .px(px(8.))
                            .py(px(2.))
                            .rounded_full()
                            .bg(hsla(with_alpha(t.video_ground, 0.7)))
                            .type_scale(text::META)
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(fg)
                            .children(mark)
                            .child(div().min_w_0().truncate().child(name)),
                    ),
            );
        }
        stack.into_any_element()
    }

    /// "Ada wants to join", above everything the host arranges.
    fn join_requests(&self, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let room = self.room()?;
        if room.requests.is_empty() {
            return None;
        }
        let open = room.phase == RoomPhase::Open;
        let overflow = room.requests.len().saturating_sub(REQUESTS_SHOWN);
        let entity = cx.entity();
        let mut list = GroupedList::new()
            .id("show-stage-requests-list")
            .accessibility_label(WANTS_TO_JOIN);
        for request in room.requests.iter().take(REQUESTS_SHOWN) {
            let let_in: WindowAction = {
                let entity = entity.clone();
                let id = request.request_id.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |stage, _| stage.decide(id.clone(), "let-in"))
                })
            };
            let decline: WindowAction = {
                let entity = entity.clone();
                let id = request.request_id.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |stage, _| stage.decide(id.clone(), "decline"))
                })
            };
            list = list.row(request_row(request, !open, t, let_in, decline));
        }
        // The label: a pulsing amber dot, then "Wants to join 2".
        let label = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .pl(px(4.))
            .child(
                StatusDot::new("show-stage-requests-dot")
                    .tone(StatusTone::Warn)
                    .pulse(true),
            )
            .child(
                div()
                    .ml(px(-4.))
                    .child(count_label(WANTS_TO_JOIN, room.requests.len(), t)),
            );
        let mut block = div()
            .id("show-stage-requests")
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(div().flex().flex_col().gap(px(6.)).child(label).child(list));
        if overflow > 0 {
            block = block.child(
                div().child(
                    Button::new("more-want-to-join")
                        .label(more_want_to_join(overflow))
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .on_click({
                            let entity = entity.clone();
                            move |_, _, cx| entity.update(cx, |stage, cx| stage.open_guests(cx))
                        }),
                ),
            );
        }
        Some(block.into_any_element())
    }

    /// The room's layouts as cards, each with its diagram (plan 252). A
    /// layout that can't apply says why on hover; one line under the cards
    /// says it for all of them.
    fn layouts(&self, columns: u16, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let room = self.room();
        let managed = is_managed_show(self.show_node_id.as_deref());
        let host = self.host_identity(cx);
        let sharers = stage_sharers(room, host.as_deref(), self.host_sharing(cx)).len();
        let options = layout_options(room, managed, sharers);
        let reasons = layout_reasons_line(&options);
        let room_open = room.is_some_and(|r| r.phase == RoomPhase::Open);
        let interactive = room_open && self.room_host.is_some();
        let current = selected_layout(
            room,
            two_screens_chosen(room.map(|r| &r.stage), self.two_screens_picked),
        );
        let entity = cx.entity();
        let mut grid = div()
            .id("show-stage-layouts")
            .grid()
            .grid_cols(columns)
            .gap(px(8.))
            .role(Role::Group)
            .aria_label(LAYOUT);
        for option in &options {
            grid = grid.child(layout_card(option, current, interactive, entity.clone(), t));
        }
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(px(6.))
            .child(div().px(px(4.)).child(SectionLabel::new(LAYOUT)))
            .child(grid)
            .children(
                room_open
                    .then_some(reasons)
                    .flatten()
                    .map(|line| reasons_line("show-stage-layout-reasons", line, t)),
            )
            .into_any_element()
    }

    /// The screens shared in the room (plan 252), each a card with its live
    /// picture; Share screen… starts the host's own.
    fn screens_section(
        &self,
        people: &[RoomPerson],
        columns: u16,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let room = self.room();
        let room_open = room.is_some_and(|r| r.phase == RoomPhase::Open);
        let host_ready = self.room_host.is_some();
        let sharing = self.host_sharing(cx);
        let screens = room_screens(room, people, sharing, self.two_screens_picked);
        let entity = cx.entity();
        let pending = self.share_pending;
        // Plan 254 D4: shown over the host's own screen, or while it holds.
        let privacy = self.privacy_view();
        let privacy_shown = sharing
            || screens.iter().any(|screen| screen.host)
            || privacy.hidden
            || privacy.chip.is_some();

        let share_btn = if sharing {
            Button::new("show-stage-stop-share")
                .label(STOP_SHARING)
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .disabled(!room_open || !host_ready || pending)
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |stage, cx| stage.stop_sharing(cx))
                })
                .into_any_element()
        } else {
            let mut button = Button::new("show-stage-share")
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .disabled(!room_open || !host_ready || pending);
            button = if pending {
                button.child(Spinner::new("show-stage-share-pending").size(14.))
            } else {
                button.icon(IconName::Monitor)
            };
            button
                .label(SHARE_SCREEN)
                .when(!host_ready, |button| button.tooltip(ROOM_HOST_PENDING))
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |stage, cx| stage.open_share_picker(window, cx))
                    }
                })
                .into_any_element()
        };

        // `flex min-h-6 items-center gap-x-2 px-1`: the name, then the
        // controls at the end.
        let header = div()
            .min_h(px(24.))
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .px(px(4.))
            .child(SectionLabel::new(SCREENS))
            .children(Self::privacy_chip(&privacy, t))
            .child(div().flex_1())
            .children(privacy_shown.then(|| self.privacy_control(&privacy, cx)))
            .child(share_btn);
        let mut body = div()
            .id("show-stage-screens")
            .flex()
            .flex_col()
            .min_w_0()
            .gap(px(6.))
            .child(header);
        if screens.is_empty() {
            body = body.child(reasons_line(
                "show-stage-screens-empty",
                format!("{} {}", guests::NO_SCREENS_YET, guests::SCREENS_GUEST_HINT),
                t,
            ));
        } else {
            let mut grid = div()
                .id("show-stage-screen-cards")
                .grid()
                .grid_cols(columns)
                .gap(px(8.))
                .role(Role::Group)
                .aria_label(SCREENS);
            for screen in &screens {
                let disabled = !room_open || !host_ready || screen.blocked_reason.is_some();
                let frame = self.remote_frame(&screen.identity, RemoteSource::Screen, cx);
                let chosen = screen.clone();
                let entity = entity.clone();
                grid = grid.child(
                    StageCard {
                        id: SharedString::from(format!("show-stage-screen-{}", screen.identity))
                            .into(),
                        thumb: screen_thumb(frame, t),
                        label: screen.name.clone().into(),
                        meta: Some(SharedString::from(if screen.on_program {
                            ON_STAGE
                        } else {
                            PUT_ON_STAGE
                        })),
                        selected: screen.on_program,
                        disabled,
                        disabled_reason: room_open
                            .then(|| screen.blocked_reason.clone())
                            .flatten()
                            .map(Into::into),
                    }
                    .render(t, move |_, cx| {
                        let screen = chosen.clone();
                        entity.update(cx, |stage, cx| stage.toggle_screen_card(screen, cx));
                    }),
                );
            }
            body = body.child(grid);
        }
        body.into_any_element()
    }

    /// Everyone in the room, in two lists: On stage and Backstage, the one
    /// home of Bring on and Send backstage (D16).
    fn people_section(
        &self,
        people: &[RoomPerson],
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if people.is_empty() {
            return div().into_any_element();
        }
        let room = self.room();
        let room_open = room.is_some_and(|r| r.phase == RoomPhase::Open);
        let disabled = !room_open || self.room_host.is_none();
        let blocked = bring_on_blocked_reason(people, room_limits(self.facts.as_ref()));
        let on_stage: Vec<&RoomPerson> = people.iter().filter(|p| p.host || p.on_stage).collect();
        let backstage: Vec<&RoomPerson> =
            people.iter().filter(|p| !p.host && !p.on_stage).collect();
        let spotlight = room
            .filter(|r| r.stage.layout == StageLayout::Spotlight)
            .and_then(|r| r.stage.spotlight.clone());

        let group = |label: &str, count: usize, rows: Vec<videorc_kit::list_row::ListRow>| {
            let mut list = GroupedList::new()
                .id(SharedString::from(format!("show-stage-list-{label}")))
                .accessibility_label(label.to_string());
            for row in rows {
                list = list.row(row);
            }
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(count_label(label, count, t))
                .child(list)
        };

        let on_rows = on_stage
            .iter()
            .map(|person| self.stage_row(person, disabled, None, spotlight.as_deref(), t, cx))
            .collect();
        let mut root = div()
            .id("show-stage-strip")
            .flex()
            .flex_col()
            .gap(px(16.))
            .role(Role::Region)
            .aria_label("In the room")
            .child(group(ON_STAGE, on_stage.len(), on_rows));

        if backstage.is_empty() {
            let entity = cx.entity();
            root = root.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(count_label(BACKSTAGE, 0, t))
                    .child(
                        div()
                            .id("show-stage-backstage-empty")
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .rounded(px(radius::ROW))
                            .border_1()
                            .border_color(hsla(t.border))
                            .bg(hsla(t.inset))
                            .py(px(6.))
                            .pr(px(6.))
                            .pl(px(12.))
                            .child(
                                div()
                                    .min_w_0()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(guests::NOBODY_BACKSTAGE),
                            )
                            .child(
                                Button::new("show-stage-invite-link")
                                    .icon(IconName::LinkSimple)
                                    .label(INVITE_LINK)
                                    .variant(ButtonVariant::Outline)
                                    .size(ButtonSize::Xs)
                                    .on_click(move |_, _, cx| {
                                        entity.update(cx, |stage, cx| stage.open_guests(cx))
                                    }),
                            ),
                    ),
            );
        } else {
            let back_rows = backstage
                .iter()
                .map(|person| {
                    self.stage_row(
                        person,
                        disabled,
                        blocked.clone(),
                        spotlight.as_deref(),
                        t,
                        cx,
                    )
                })
                .collect();
            root = root.child(group(BACKSTAGE, backstage.len(), back_rows));
        }
        root.into_any_element()
    }

    /// `StageRow`: a `PersonRow` with the stage move and the stage's ⋯.
    fn stage_row(
        &self,
        person: &RoomPerson,
        disabled: bool,
        bring_on_blocked: Option<String>,
        spotlight: Option<&str>,
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> videorc_kit::list_row::ListRow {
        let entity = cx.entity();
        let media = self.room_media(cx);
        let local_mic_muted = media.is_some_and(|media| !media.microphone);
        let remote = media.and_then(|media| {
            media
                .people
                .iter()
                .find(|entry| entry.identity == person.identity)
        });
        let (camera_off, picture) = if person.host {
            let off = media.is_some_and(|media| !media.camera);
            let identity = self.host_identity(cx).unwrap_or_default();
            (
                off,
                (!off)
                    .then(|| self.remote_frame(&identity, RemoteSource::Camera, cx))
                    .flatten(),
            )
        } else {
            let off = remote.is_some_and(|remote| remote.camera_off);
            (
                off,
                (!off)
                    .then(|| self.remote_frame(&person.identity, RemoteSource::Camera, cx))
                    .flatten(),
            )
        };
        let mic = person_mic_view(
            person,
            Heard {
                local_mic_muted,
                room_mic_muted: remote.is_some_and(|remote| remote.mic_muted),
                speaking: remote.is_some_and(|remote| remote.speaking),
            },
        );

        // ⋯: Spotlight (or End spotlight), then the host's camera or the
        // guest's moderation.
        let identity = person.identity.clone();
        let spotlit = spotlight == Some(identity.as_str());
        let mut menu = vec![if spotlit {
            let entity = entity.clone();
            KebabMenuItem::new("spotlight", "End spotlight", move |_, cx| {
                entity.update(cx, |stage, cx| {
                    stage.set_layout(DrawnStageLayout::SideBySide, cx)
                })
            })
            .group("stage")
        } else {
            let entity = entity.clone();
            let identity = identity.clone();
            let item = KebabMenuItem::new("spotlight", "Spotlight", move |_, cx| {
                let identity = identity.clone();
                entity.update(cx, |stage, cx| stage.spotlight(identity, cx))
            })
            .group("stage");
            if person.on_stage || person.host {
                item
            } else {
                item.disabled(true).disabled_reason("Bring them on first.")
            }
        }];
        if person.host {
            let entity = entity.clone();
            menu.push(
                KebabMenuItem::new(
                    "camera",
                    if camera_off {
                        "Turn camera on"
                    } else {
                        "Turn camera off"
                    },
                    move |_, cx| entity.update(cx, |stage, _| stage.set_host_camera(camera_off)),
                )
                .group("stage"),
            );
        } else {
            menu.extend(GuestModeration::items(&self.moderation, person));
        }

        // The host is always on stage (H2): their row has no stage move.
        let action = (!person.host).then(|| {
            let blocked = (!person.on_stage).then_some(bring_on_blocked).flatten();
            let on_stage = person.on_stage;
            let identity = identity.clone();
            let entity = entity.clone();
            let button = Button::new(SharedString::from(format!(
                "show-stage-{}-{}",
                if on_stage {
                    "send-backstage"
                } else {
                    "bring-on"
                },
                person.identity
            )))
            .icon(if on_stage {
                IconName::ArrowDown
            } else {
                IconName::ArrowUp
            })
            .label(if on_stage { SEND_BACKSTAGE } else { BRING_ON })
            .variant(if on_stage {
                ButtonVariant::Outline
            } else {
                ButtonVariant::Secondary
            })
            .size(ButtonSize::Xs)
            .disabled(disabled || blocked.is_some())
            .on_click(move |_, _, cx| {
                let identity = identity.clone();
                entity.update(cx, |stage, cx| stage.move_person(identity, !on_stage, cx))
            });
            match blocked {
                Some(reason) => button.tooltip(reason).into_any_element(),
                None => button.into_any_element(),
            }
        });

        let on_mic: WindowAction = {
            let entity = entity.clone();
            let moderation = self.moderation.clone();
            let person = person.clone();
            Rc::new(move |_, cx| {
                if person.host {
                    entity.update(cx, |stage, _| stage.toggle_host_mic(local_mic_muted));
                } else {
                    moderation.update(cx, |moderation, cx| moderation.toggle_mute(&person, cx));
                }
            })
        };
        let on_share: WindowAction = {
            let moderation = self.moderation.clone();
            let person = person.clone();
            Rc::new(move |_, cx| {
                moderation.update(cx, |moderation, cx| {
                    moderation.toggle_screen_share(&person, cx)
                })
            })
        };
        person_row(
            PersonRowParts {
                person: person.clone(),
                picture,
                camera_off,
                mic,
                mic_label: mic_toggle_label(person, local_mic_muted),
                mic_pressed: if person.host {
                    local_mic_muted
                } else {
                    person.muted
                },
                disabled,
                menu,
                action,
            },
            t,
            on_mic,
            on_share,
        )
    }

    fn program_monitor(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let talk = self.talk_show.read(cx).value();
        let view = program_monitor_view_simple(
            talk.live,
            talk.recording,
            self.show_node_id.as_deref(),
            self.room(),
        );
        let title = match view {
            ProgramMonitorView::Return => PROGRAM,
            ProgramMonitorView::Stage(_) => PROGRAM_PREVIEW,
        };
        let muted = hsla(t.muted_foreground);
        let frame = self.remote_frame("monitor", RemoteSource::Monitor, cx);
        let media = self.room_media(cx);
        let monitor_audio = media
            .and_then(|media| media.monitor)
            .is_some_and(|monitor| monitor.audio);
        let listening = self
            .room_host
            .as_ref()
            .is_some_and(|host| host.read(cx).monitor_listening());
        let entity = cx.entity();

        let pictured = match view {
            ProgramMonitorView::Return => frame.is_some(),
            ProgramMonitorView::Stage(state) => state == StageMonitorState::Shown,
        };
        let body: AnyElement = match view {
            ProgramMonitorView::Return => {
                if let Some(frame) = frame {
                    img(frame)
                        .size_full()
                        .object_fit(ObjectFit::Contain)
                        .into_any_element()
                } else {
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(if talk.live || talk.recording {
                            WAITING_PROGRAM
                        } else {
                            PROGRAM_MONITOR_EMPTY
                        })
                        .into_any_element()
                }
            }
            ProgramMonitorView::Stage(StageMonitorState::Empty) => div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .type_scale(text::META)
                .text_color(muted)
                .child(PROGRAM_MONITOR_EMPTY)
                .into_any_element(),
            ProgramMonitorView::Stage(StageMonitorState::Waiting) => div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .type_scale(text::META)
                .text_color(muted)
                .child(WAITING_PROGRAM)
                .into_any_element(),
            ProgramMonitorView::Stage(StageMonitorState::Shown) => {
                // Managed preview: the same stage tiles with remote frames.
                let tiles = plan_stage(STAGE_CANVAS, &show_stage_input(self.room()));
                let host = self.host_identity(cx);
                let mut well = div().relative().size_full().bg(hsla(t.video_ground));
                for tile in &tiles {
                    well = well.child(self.tile_view(tile, self.room(), host.as_deref(), t, cx));
                }
                well.into_any_element()
            }
        };

        // `flex min-h-6 items-center gap-1.5 px-1`.
        let mut header = div()
            .min_h(px(24.))
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(4.))
            .child(SectionLabel::new(title))
            .child(div().flex_1());

        if matches!(view, ProgramMonitorView::Return) && self.room_host.is_some() {
            let tip = if listening {
                MUTE_PROGRAM
            } else {
                LISTEN_PROGRAM
            };
            let speaker = if listening {
                IconName::SpeakerHigh
            } else {
                IconName::SpeakerSlash
            };
            header = header.child(
                Button::new("program-listen")
                    .size(ButtonSize::IconXs)
                    .variant(ButtonVariant::Ghost)
                    .accessibility_label(tip)
                    .disabled(!monitor_audio && !listening)
                    .tooltip(tip)
                    .child(icon(speaker, 14., hsla(t.muted_foreground)))
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |stage, cx| stage.toggle_listen(cx))
                    }),
            );
        }

        // Electron (`show-stage.tsx` ProgramMonitor): beside Layout/Screens/
        // People at ~36% width (`w-[36%] shrink-0`), aspect-video frame — not
        // a full-width stack above them (that made the Program well far taller).
        div()
            .id("show-stage-program")
            .flex()
            .flex_col()
            .gap(px(6.))
            .w(relative(0.36))
            .min_w(px(192.))
            .flex_shrink_0()
            .child(header)
            .child(
                // `aspect-video rounded-row`: empty, the frame is the
                // Preview's inset well (a video-ground box would vanish on
                // the dark ground and leave its words floating).
                div()
                    .relative()
                    .w_full()
                    .aspect_ratio(16. / 9.)
                    .rounded(px(radius::ROW))
                    .bg(hsla(if pictured { t.video_ground } else { t.inset }))
                    .overflow_hidden()
                    .child(body),
            )
            .into_any_element()
    }

    fn share_dialog(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let devices = self.studio.snapshot().sources.devices.devices;
        let picks: Vec<(String, String)> = capture_picker_devices(&devices)
            .into_iter()
            .map(|device| (device.id.clone(), device.name.clone()))
            .collect();
        let entity = cx.entity();
        let muted = {
            let t = theme::resolve(None, window, cx);
            hsla(t.muted_foreground)
        };

        let mut body = div().flex().flex_col().gap(px(8.)).p(px(4.));
        if picks.is_empty() {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(NOTHING_TO_SHARE),
            );
        } else {
            for (id, name) in picks {
                let source_id = id.clone();
                body = body.child(
                    Button::new(format!("share-pick-{id}"))
                        .label(name)
                        .variant(ButtonVariant::Outline)
                        .on_click({
                            let entity = entity.clone();
                            move |_, window, cx| {
                                let source_id = source_id.clone();
                                entity.update(cx, |stage, cx| {
                                    stage.share_source(source_id, window, cx)
                                });
                            }
                        }),
                );
            }
        }

        Dialog::new(
            "show-stage-share-picker",
            &self.share_picker,
            SHARE_A_SCREEN_TITLE,
        )
        .size(DialogSize::Md)
        .description(SHARE_A_SCREEN_DESCRIPTION)
        .child(body)
        .footer(
            Button::new("share-picker-cancel")
                .label(CANCEL)
                .variant(ButtonVariant::Ghost)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |stage, cx| stage.share_picker.close(window, cx))
                    }
                }),
        )
        .into_any_element()
    }
}

fn program_monitor_view_simple(
    live: bool,
    recording: bool,
    node_id: Option<&str>,
    room: Option<&RoomStatus>,
) -> ProgramMonitorView {
    if !is_managed_show(node_id) {
        return ProgramMonitorView::Return;
    }
    let running = live || recording;
    if !running {
        return ProgramMonitorView::Stage(StageMonitorState::Empty);
    }
    ProgramMonitorView::Stage(if room.is_some_and(|room| room.shown.is_some()) {
        StageMonitorState::Shown
    } else {
        StageMonitorState::Waiting
    })
}

fn person_name(
    tile: &StageTile,
    participant: Option<&RoomParticipant>,
    host_identity: Option<&str>,
) -> String {
    if tile.kind == StageTileKind::Screen {
        if Some(tile.identity.as_str()) == host_identity {
            return "Your screen".into();
        }
        let base = participant
            .map(|p| p.name.as_str())
            .filter(|n| !n.is_empty())
            .unwrap_or("Guest");
        return format!("{base}'s screen");
    }
    if Some(tile.identity.as_str()) == host_identity {
        return "You".into();
    }
    participant
        .map(|p| p.name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Guest".into())
}

fn layout_card(
    option: &LayoutOption,
    current: DrawnStageLayout,
    interactive: bool,
    entity: Entity<ShowStage>,
    t: &Theme,
) -> AnyElement {
    let value = option.value;
    let selected = current == value;
    StageCard {
        id: SharedString::from(format!("show-stage-layout-{}", option.label)).into(),
        thumb: stage_layout_thumb(value, t),
        label: option.label.into(),
        meta: None,
        selected,
        disabled: !interactive || option.disabled_reason.is_some(),
        disabled_reason: interactive
            .then_some(option.disabled_reason)
            .flatten()
            .map(Into::into),
    }
    .render(t, move |_, cx| {
        if !selected {
            entity.update(cx, |stage, cx| stage.set_layout(value, cx));
        }
    })
}

impl Render for ShowStage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let talk = self.talk_show.read(cx).value().clone();
        let host = talk.host_identity.clone();
        let people = room_people(self.room(), host.as_deref(), None);
        let entity = cx.entity();
        let room_open = self.room().is_some_and(|r| r.phase == RoomPhase::Open);
        let closing = self.closing || self.room().is_some_and(|r| r.phase == RoomPhase::Closing);

        let close_btn = Button::new("show-stage-close-room")
            .label(if closing {
                CLOSING
            } else {
                guests::CLOSE_THE_ROOM_LABEL
            })
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .disabled(!room_open || closing)
            .on_click({
                let entity = entity.clone();
                move |_, window, cx| entity.update(cx, |stage, cx| stage.ask_or_close(window, cx))
            });

        let mut section = PanelSection::new("show-stage")
            .title(SHOW_STAGE_TITLE)
            .description(
                div()
                    .id("preview-replaced-by-show-stage")
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(PREVIEW_REPLACED_BY_SHOW_STAGE),
            )
            .action(close_btn)
            .child(self.well(t, cx));

        if let Some(problem) = talk.message.filter(|m| !m.is_empty()) {
            section = section.child(
                Alert::new("show-stage-room-message")
                    .variant(AlertVariant::Warning)
                    .title(problem),
            );
        }
        if let Some(requests) = self.join_requests(t, cx) {
            section = section.child(requests);
        }

        // `@min-[30rem]/show-stage:grid-cols-4`: the stage's own width is
        // the window less the sidebar (208) and the Studio's right column
        // (~330) and gutters; under 480 px the cards go two across.
        let columns = card_columns(f32::from(window.viewport_size().width) - 208. - 330. - 48.);

        // Electron: Layout / Screens / People on the left (`flex-1`); Program
        // on the right at 36% (`@min-[44rem]/show-stage:flex-row`). Gallery
        // shots are that wide layout.
        let controls = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .min_w_0()
            .flex_1()
            .child(self.layouts(columns, t, cx))
            .child(self.screens_section(&people, columns, t, cx))
            .child(self.people_section(&people, t, cx));

        let row = div()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(16.))
            .min_w_0()
            .w_full()
            .child(controls)
            .child(self.program_monitor(t, cx));

        section = section.child(row);

        let close_dialog = Dialog::new(
            "show-stage-close-room-confirm",
            &self.close_confirm,
            CLOSE_ROOM_CONFIRM_TITLE,
        )
        .size(DialogSize::Sm)
        .description(guests::CLOSE_ROOM_CONFIRM_DESCRIPTION)
        .footer(
            Button::new("show-stage-close-cancel")
                .label(CANCEL)
                .variant(ButtonVariant::Ghost)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |stage, cx| stage.close_confirm.close(window, cx))
                    }
                }),
        )
        .footer(
            Button::new("show-stage-close-confirm")
                .label(if closing {
                    CLOSING
                } else {
                    guests::CLOSE_THE_ROOM_LABEL
                })
                .disabled(closing)
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| entity.update(cx, |stage, cx| stage.close_room(window, cx))
                }),
        );

        div()
            .id("show-stage-root")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_hidden()
            .child(
                div()
                    .id("show-stage-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(section),
            )
            .child(close_dialog)
            .child(self.share_dialog(window, cx))
            .child(self.moderation.clone())
    }
}
