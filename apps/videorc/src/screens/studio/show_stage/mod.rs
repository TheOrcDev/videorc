//! Show stage (`show-stage.tsx`; P357–P394): replaces the Preview while the
//! talk-show room is open. Words and stage geometry come from
//! `videorc_app_core::guests`; close room and Let in / Decline call Studio.
//! Live pictures and room actions come from [`TalkShowRoomHost`] (L1):
//! `room_media`, `remote_frame`, `share_screen` / `stop_screen_share`,
//! `set_stage`, and the Program monitor + Listen.

mod camera_off;

use std::sync::Arc;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, Image, ObjectFit, Role, Window, div, img,
    prelude::*, px, relative,
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
    self as guests, CloudRoomFacts, LayoutOption, RoomPerson, RoomScreen, bring_on_blocked_reason,
    close_room_asks_first, layout_options, layout_reasons_line, request_device, request_title,
    room_counts, room_limits, room_people, room_screens, selected_layout, stage_with_screen_card,
};
use videorc_app_core::guests::wire::{
    DrawnStageLayout, RecordingStatus, RoomClientState, RoomParticipant, RoomPhase, RoomRequest,
    RoomStatus, Stage, StageLayout,
};
use videorc_app_core::livestream::cloud_status::CloudStatus;
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::room_frames::RemoteSource;
use videorc_app_core::studio::room_media::RoomMedia;
use videorc_app_core::studio::screen_views::{PREVIEW_REPLACED_BY_SHOW_STAGE, TalkShowRoomView};
use videorc_app_core::studio::source_selection::capture_picker_devices;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::spinner::Spinner;
use videorc_kit::theme::{self, TypeScale, faded_over, hsla, with_alpha};
use videorc_kit::tokens::{Color, Theme, radius, text};
use videorc_kit::tooltip::tooltip;

use super::talk_show_host::TalkShowRoomHost;
use super::transport::{AppStudio, OpenPage};
use crate::app::bridge::Mirror;
use camera_off::{CAMERA_OFF_LABEL, camera_off_avatar};

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
const LET_IN: &str = "Let in";
const DECLINE: &str = "Decline";
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
        Self {
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
        }
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
                            .px(px(8.))
                            .py(px(2.))
                            .rounded_full()
                            .bg(hsla(with_alpha(t.video_ground, 0.7)))
                            .type_scale(text::META)
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(fg)
                            .truncate()
                            .child(name),
                    ),
            );
        }
        stack.into_any_element()
    }

    fn join_requests(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let room = self.room()?;
        if room.requests.is_empty() {
            return None;
        }
        let open = room.phase == RoomPhase::Open;
        let shown: Vec<&RoomRequest> = room.requests.iter().take(REQUESTS_SHOWN).collect();
        let overflow = room.requests.len().saturating_sub(REQUESTS_SHOWN);
        let entity = cx.entity();
        let mut list =
            GroupedList::new().label(format!("{WANTS_TO_JOIN} · {}", room.requests.len()));
        for request in shown {
            let id = request.request_id.clone();
            let id_decline = request.request_id.clone();
            list = list.item(
                ListRow::new(
                    format!("join-{}", request.request_id),
                    request_title(request),
                )
                .context(request_device(request))
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            Button::new(format!("let-in-{}", request.request_id))
                                .label(LET_IN)
                                .size(ButtonSize::Xs)
                                .disabled(!open)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, _, cx| {
                                        entity.update(cx, |stage, _| {
                                            stage.decide(id.clone(), "let-in")
                                        })
                                    }
                                }),
                        )
                        .child(
                            Button::new(format!("decline-{}", request.request_id))
                                .label(DECLINE)
                                .variant(ButtonVariant::Outline)
                                .size(ButtonSize::Xs)
                                .disabled(!open)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, _, cx| {
                                        entity.update(cx, |stage, _| {
                                            stage.decide(id_decline.clone(), "decline")
                                        })
                                    }
                                }),
                        ),
                ),
            );
        }
        let mut block = div().flex().flex_col().gap(px(8.)).child(list);
        if overflow > 0 {
            block = block.child(
                Button::new("more-want-to-join")
                    .label(more_want_to_join(overflow))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Xs)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |stage, cx| stage.open_guests(cx))
                    }),
            );
        }
        Some(block.into_any_element())
    }

    fn layouts(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let room = self.room();
        let managed = is_managed_show(self.show_node_id.as_deref());
        let host = self.host_identity(cx);
        let sharers = stage_sharers(room, host.as_deref(), self.host_sharing(cx)).len();
        let options = layout_options(room, managed, sharers);
        let reasons = layout_reasons_line(&options);
        let room_open = room.is_some_and(|r| r.phase == RoomPhase::Open);
        let current = selected_layout(
            room,
            two_screens_chosen(room.map(|r| &r.stage), self.two_screens_picked),
        );
        let muted = hsla(t.muted_foreground);
        let entity = cx.entity();
        let host_ready = self.room_host.is_some();
        let mut cards = div()
            .id("show-stage-layouts")
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .role(Role::Group)
            .aria_label(LAYOUT);
        for option in &options {
            cards = cards.child(layout_card(
                option,
                current,
                room_open && host_ready,
                entity.clone(),
                t,
            ));
        }
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(SectionLabel::new(LAYOUT))
            .child(cards)
            .children(room_open.then(|| reasons).flatten().map(|line| {
                div()
                    .id("show-stage-layout-reasons")
                    .px(px(4.))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(line)
            }))
            .into_any_element()
    }

    fn screens_section(
        &self,
        people: &[RoomPerson],
        t: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let muted = hsla(t.muted_foreground);
        let room = self.room();
        let room_open = room.is_some_and(|r| r.phase == RoomPhase::Open);
        let host_ready = self.room_host.is_some();
        let sharing = self.host_sharing(cx);
        let screens = room_screens(room, people, sharing, self.two_screens_picked);
        let entity = cx.entity();
        let pending = self.share_pending;

        let share_btn = if sharing {
            Button::new("stop-share")
                .label(STOP_SHARING)
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .disabled(!room_open || !host_ready || pending)
                .on_click({
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |stage, cx| stage.stop_sharing(cx))
                })
        } else {
            Button::new("share-screen")
                .label(SHARE_SCREEN)
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .disabled(!room_open || !host_ready || pending)
                .tooltip(if host_ready {
                    SHARE_A_SCREEN_DESCRIPTION
                } else {
                    ROOM_HOST_PENDING
                })
                .on_click({
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |stage, cx| stage.open_share_picker(window, cx))
                    }
                })
        };

        let mut body = div().flex().flex_col().gap(px(6.)).child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(SectionLabel::new(SCREENS))
                .child(div().flex_1())
                .child(share_btn),
        );

        if screens.is_empty() {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(format!(
                        "{} {}",
                        guests::NO_SCREENS_YET,
                        guests::SCREENS_GUEST_HINT
                    )),
            );
        } else {
            let mut cards = div()
                .id("show-stage-screens")
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .role(Role::Group)
                .aria_label(SCREENS);
            for screen in &screens {
                cards = cards.child(self.screen_card(
                    screen,
                    room_open && host_ready,
                    entity.clone(),
                    t,
                    cx,
                ));
            }
            body = body.child(cards);
        }
        body.into_any_element()
    }

    fn screen_card(
        &self,
        screen: &RoomScreen,
        interactive: bool,
        entity: Entity<Self>,
        t: &Theme,
        cx: &App,
    ) -> AnyElement {
        let disabled = !interactive || screen.blocked_reason.is_some();
        let paint = StageCardPaint::of(t, screen.on_program, disabled);
        let frame = self.remote_frame(&screen.identity, RemoteSource::Screen, cx);
        let entity_screen = screen.clone();
        let mut thumb = div()
            .relative()
            .h(px(72.))
            .w_full()
            .rounded(px(radius::CHIP / 2.))
            .bg(paint.thumb)
            .overflow_hidden();
        if let Some(frame) = frame {
            thumb = thumb.child(img(frame).size_full().object_fit(ObjectFit::Cover));
        }
        if let Some(veil) = paint.thumb_veil {
            thumb = thumb.child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(radius::CHIP / 2.))
                    .bg(veil),
            );
        }
        let mut card = div()
            .id(format!("stage-screen-{}", screen.identity))
            .flex()
            .flex_col()
            .gap(px(4.))
            .w(px(140.))
            .p(px(8.))
            .rounded(px(radius::CHIP))
            .border_1()
            .border_color(paint.border)
            .bg(paint.fill)
            .child(thumb)
            .child(
                div()
                    .type_scale(text::META)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .text_color(paint.name)
                    .truncate()
                    .child(screen.name.clone()),
            )
            .child(div().type_scale(text::META).text_color(paint.meta).child(
                if screen.on_program {
                    ON_STAGE
                } else {
                    PUT_ON_STAGE
                },
            ));
        if !disabled {
            card = card.on_click(move |_, _, cx| {
                let screen = entity_screen.clone();
                entity.update(cx, |stage, cx| stage.toggle_screen_card(screen, cx));
            });
        }
        if let Some(reason) = screen.blocked_reason.as_deref() {
            card = card.tooltip(tooltip(reason.to_string()));
        }
        card.into_any_element()
    }

    fn people_section(&self, people: &[RoomPerson], cx: &mut Context<Self>) -> AnyElement {
        let on_stage: Vec<&RoomPerson> = people.iter().filter(|p| p.host || p.on_stage).collect();
        let backstage: Vec<&RoomPerson> =
            people.iter().filter(|p| !p.host && !p.on_stage).collect();
        let counts = room_counts(self.room(), people);
        let entity = cx.entity();
        let host_ready = self.room_host.is_some();
        let blocked = bring_on_blocked_reason(people, room_limits(self.facts.as_ref()));
        let mut root = div()
            .id("show-stage-people")
            .flex()
            .flex_col()
            .gap(px(8.))
            .role(Role::Region)
            .aria_label("In the room");

        let mut on_list = GroupedList::new().label(format!("{ON_STAGE} · {}", counts.on_stage));
        for person in &on_stage {
            on_list = on_list.item(person_row(person, true, host_ready, None, entity.clone()));
        }
        root = root.child(on_list);

        if backstage.is_empty() {
            root = root.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(SectionLabel::new(format!("{BACKSTAGE} · 0")))
                    .child(Empty::new().description(guests::NOBODY_BACKSTAGE))
                    .child(
                        Button::new("invite-link")
                            .label(INVITE_LINK)
                            .variant(ButtonVariant::Outline)
                            .size(ButtonSize::Xs)
                            .on_click({
                                let entity = entity.clone();
                                move |_, _, cx| entity.update(cx, |stage, cx| stage.open_guests(cx))
                            }),
                    ),
            );
        } else {
            let mut back = GroupedList::new().label(format!("{BACKSTAGE} · {}", backstage.len()));
            for person in &backstage {
                back = back.item(person_row(
                    person,
                    false,
                    host_ready,
                    blocked.clone(),
                    entity.clone(),
                ));
            }
            root = root.child(back);
        }
        root.into_any_element()
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

        let mut header = div()
            .flex()
            .items_center()
            .gap(px(8.))
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

        div()
            .id("show-stage-program")
            .flex()
            .flex_col()
            .gap(px(8.))
            .min_w(px(200.))
            .flex_1()
            .child(header)
            .child(
                div()
                    .relative()
                    .w_full()
                    .aspect_ratio(16. / 9.)
                    .rounded(px(radius::PANEL))
                    .bg(hsla(t.video_ground))
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

/// Colours for a layout / Screens card. Disabled paints each layer
/// pre-blended over the card ground — never `.opacity` (GPUI fades each
/// layer alone and the label shows its fill through).
struct StageCardPaint {
    border: gpui::Hsla,
    fill: gpui::Hsla,
    thumb: gpui::Hsla,
    name: gpui::Hsla,
    meta: gpui::Hsla,
    /// Half the card ground over a live thumb when the card is disabled.
    thumb_veil: Option<gpui::Hsla>,
}

impl StageCardPaint {
    fn of(t: &Theme, selected: bool, disabled: bool) -> Self {
        let ground = faded_over(t.foreground, t.glass_solid, 0.04);
        let dim = |color: Color| {
            if disabled {
                faded_over(color, ground, 0.5)
            } else {
                color
            }
        };
        let border = if selected { t.foreground } else { t.border };
        let fill = if selected {
            with_alpha(t.foreground, 0.08)
        } else {
            with_alpha(t.foreground, 0.)
        };
        Self {
            border: hsla(dim(border)),
            fill: hsla(if disabled {
                faded_over(fill, ground, 0.5)
            } else {
                fill
            }),
            thumb: hsla(dim(t.inset)),
            name: hsla(dim(t.foreground)),
            meta: hsla(dim(t.muted_foreground)),
            thumb_veil: disabled.then(|| hsla(with_alpha(ground, 0.5))),
        }
    }

    /// Layout cards use a muted plate instead of the Screens inset well.
    fn layout_thumb(t: &Theme, disabled: bool) -> gpui::Hsla {
        let ground = faded_over(t.foreground, t.glass_solid, 0.04);
        let plate = with_alpha(t.muted, 0.5);
        hsla(if disabled {
            faded_over(plate, ground, 0.5)
        } else {
            plate
        })
    }
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
    let selected = current == option.value;
    let disabled = !interactive || option.disabled_reason.is_some();
    let reason = interactive.then_some(option.disabled_reason).flatten();
    let paint = StageCardPaint::of(t, selected, disabled);
    let value = option.value;
    let mut card = div()
        .id(format!("stage-layout-{}", option.label))
        .flex()
        .flex_col()
        .gap(px(4.))
        .w(px(120.))
        .p(px(8.))
        .rounded(px(radius::CHIP))
        .border_1()
        .border_color(paint.border)
        .bg(paint.fill)
        .child(
            div()
                .h(px(40.))
                .rounded(px(radius::CHIP / 2.))
                .bg(StageCardPaint::layout_thumb(t, disabled)),
        )
        .child(
            div()
                .type_scale(text::META)
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(paint.name)
                .truncate()
                .child(option.label),
        );
    if !disabled {
        card = card.on_click(move |_, _, cx| {
            entity.update(cx, |stage, cx| stage.set_layout(value, cx));
        });
    }
    if let Some(reason) = reason {
        card = card.tooltip(tooltip(reason));
    } else if !interactive {
        card = card.tooltip(tooltip(ROOM_HOST_PENDING));
    }
    card.into_any_element()
}

fn person_row(
    person: &RoomPerson,
    on_stage_list: bool,
    host_ready: bool,
    bring_blocked: Option<String>,
    entity: Entity<ShowStage>,
) -> ListRow {
    let action = if person.host {
        None
    } else if on_stage_list && person.on_stage {
        Some((SEND_BACKSTAGE, false))
    } else if !person.host {
        Some((BRING_ON, true))
    } else {
        None
    };
    let mut row = ListRow::new(format!("person-{}", person.identity), person.name.clone()).context(
        if person.host {
            "Host"
        } else if person.on_stage {
            ON_STAGE
        } else {
            BACKSTAGE
        },
    );
    if let Some((label, on_stage)) = action {
        let identity = person.identity.clone();
        let disabled = !host_ready || (on_stage && bring_blocked.is_some());
        let tip = if !host_ready {
            Some(ROOM_HOST_PENDING.to_string())
        } else if on_stage {
            bring_blocked
        } else {
            None
        };
        let mut button = Button::new(format!("move-{}", person.identity))
            .label(label)
            .variant(ButtonVariant::Outline)
            .size(ButtonSize::Xs)
            .disabled(disabled)
            .on_click(move |_, _, cx| {
                let identity = identity.clone();
                entity.update(cx, |stage, cx| stage.move_person(identity, on_stage, cx));
            });
        if let Some(tip) = tip {
            button = button.tooltip(tip);
        }
        row = row.child(button);
    }
    row
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
            .child(self.well(&t, cx));

        if let Some(problem) = talk.message.filter(|m| !m.is_empty()) {
            section = section.child(
                Alert::new("show-stage-room-message")
                    .variant(AlertVariant::Warning)
                    .title(problem),
            );
        }
        if let Some(requests) = self.join_requests(cx) {
            section = section.child(requests);
        }

        let controls = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .min_w_0()
            .flex_1()
            .child(self.layouts(&t, cx))
            .child(self.screens_section(&people, &t, cx))
            .child(self.people_section(&people, cx));

        let row = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .min_w_0()
            .child(self.program_monitor(&t, cx))
            .child(controls);

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
    }
}
