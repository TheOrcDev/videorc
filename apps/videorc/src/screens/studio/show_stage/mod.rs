//! Show stage (`show-stage.tsx`; P357–P394): replaces the Preview while the
//! talk-show room is open. Words and stage geometry come from
//! `videorc_app_core::guests`; close room and Let in / Decline call Studio.
//! LiveKit-only actions (layout, bring on, screen share, camera, program
//! listen) draw with the right copy and wait for the room host (S1.8).

mod camera_off;

use std::sync::Arc;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, Role, Window, div, prelude::*, px, relative,
};
use videorc_app_core::guests::layout::{
    StageCanvas, StageTile, StageTileKind, plan_stage, show_stage_input, stage_rect_fraction,
};
use videorc_app_core::guests::program::{ProgramMonitorView, StageMonitorState, is_managed_show};
use videorc_app_core::guests::tile::{host_circle, shows_away};
use videorc_app_core::guests::view::{
    self as guests, CloudRoomFacts, LayoutOption, RoomPerson, bring_on_blocked_reason,
    close_room_asks_first, layout_options, layout_reasons_line, request_device, request_title,
    room_counts, room_limits, room_people, selected_layout,
};
use videorc_app_core::guests::wire::{
    DrawnStageLayout, RecordingStatus, RoomClientState, RoomParticipant, RoomPhase, RoomRequest,
    RoomStatus,
};
use videorc_app_core::livestream::cloud_status::CloudStatus;
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::screen_views::{PREVIEW_REPLACED_BY_SHOW_STAGE, TalkShowRoomView};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::spinner::Spinner;
use videorc_kit::theme::{self, TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, text};
use videorc_kit::tooltip::tooltip;

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
const SCREENS_EMPTY: &str =
    "Nobody is sharing a screen. A guest can share theirs once you allow it on their row.";
const ON_STAGE: &str = "On stage";
const BACKSTAGE: &str = "Backstage";
const BRING_ON: &str = "Bring on";
const SEND_BACKSTAGE: &str = "Send backstage";
const INVITE_LINK: &str = "Invite link";
const PROGRAM: &str = "Program";
const PROGRAM_PREVIEW: &str = "Program preview";
const WAITING_PROGRAM: &str = "Waiting for the program…";
const PROGRAM_EMPTY: &str = "Program appears when the show starts.";
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

/// The Show stage that replaces the Preview while the room is open.
pub struct ShowStage {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    talk_show: Entity<Mirror<TalkShowRoomView>>,
    facts: Option<CloudRoomFacts>,
    show_node_id: Option<String>,
    closing: bool,
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
        cx.observe(&talk_show, |_, _, cx| cx.notify()).detach();
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
            facts: None,
            show_node_id: None,
            closing: false,
            close_confirm: DialogHandle::new(false),
        }
    }

    fn room(&self) -> Option<&RoomStatus> {
        self.facts.as_ref().and_then(|f| f.room.as_ref())
    }

    fn host_identity(&self, cx: &App) -> Option<String> {
        self.talk_show.read(cx).value().host_identity.clone()
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
            well = well.child(self.tile_view(tile, room, host.as_deref(), t));
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

    fn tile_view(
        &self,
        tile: &StageTile,
        room: Option<&RoomStatus>,
        host_identity: Option<&str>,
        t: &Theme,
    ) -> AnyElement {
        let [left, top, width, height] = stage_rect_fraction(STAGE_CANVAS, tile.rect);
        let participant =
            room.and_then(|r| r.participants.iter().find(|p| p.identity == tile.identity));
        let name = person_name(tile, participant, host_identity);
        // Without LiveKit tracks: waiting copy. Camera-off (P400) draws when
        // the room host reports it; until then the look is exercised from
        // `camera_off_avatar` directly in tests / when host lands.
        let camera_off = false;
        let away = participant.is_some_and(|p| shows_away(p.away, camera_off));
        let circle = host_circle(tile, host_identity, room.and_then(|r| r.stage.host_shape));
        let muted_fg = hsla(t.video_ground_muted);
        let fg = hsla(t.video_ground_foreground);

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

    fn layouts(&self, t: &Theme) -> AnyElement {
        let room = self.room();
        let managed = is_managed_show(self.show_node_id.as_deref());
        let options = layout_options(room, managed, 0);
        let reasons = layout_reasons_line(&options);
        let room_open = room.is_some_and(|r| r.phase == RoomPhase::Open);
        let current = selected_layout(room, false);
        let muted = hsla(t.muted_foreground);
        let mut cards = div()
            .id("show-stage-layouts")
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .role(Role::Group)
            .aria_label(LAYOUT);
        for option in &options {
            cards = cards.child(layout_card(option, current, room_open, t));
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

    fn screens_section(&self, t: &Theme) -> AnyElement {
        let muted = hsla(t.muted_foreground);
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(SectionLabel::new(SCREENS))
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(SCREENS_EMPTY),
            )
            .child(
                Button::new("share-screen")
                    .label("Share screen…")
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .tooltip(ROOM_HOST_PENDING)
                    .on_click(|_, _, _| {
                        eprintln!("[videorc-app] Show stage: Share screen: {ROOM_HOST_PENDING}");
                    }),
            )
            .into_any_element()
    }

    fn people_section(&self, people: &[RoomPerson], cx: &mut Context<Self>) -> AnyElement {
        let on_stage: Vec<&RoomPerson> = people.iter().filter(|p| p.host || p.on_stage).collect();
        let backstage: Vec<&RoomPerson> =
            people.iter().filter(|p| !p.host && !p.on_stage).collect();
        let counts = room_counts(self.room(), people);
        let entity = cx.entity();
        let mut root = div()
            .id("show-stage-people")
            .flex()
            .flex_col()
            .gap(px(8.))
            .role(Role::Region)
            .aria_label("In the room");

        let mut on_list = GroupedList::new().label(format!("{ON_STAGE} · {}", counts.on_stage));
        for person in &on_stage {
            on_list = on_list.item(person_row(person, true));
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
                back = back.item(person_row(person, false));
            }
            root = root.child(back);
        }
        root.into_any_element()
    }

    fn program_monitor(&self, t: &Theme, cx: &App) -> AnyElement {
        let talk = self.talk_show.read(cx).value();
        let view =
            program_monitor_view_simple(talk.live, talk.recording, self.show_node_id.as_deref());
        let title = match view {
            ProgramMonitorView::Return => PROGRAM,
            ProgramMonitorView::Stage(_) => PROGRAM_PREVIEW,
        };
        let muted = hsla(t.muted_foreground);
        let body = match view {
            ProgramMonitorView::Stage(StageMonitorState::Empty) => PROGRAM_EMPTY,
            ProgramMonitorView::Stage(StageMonitorState::Waiting)
            | ProgramMonitorView::Return
            | ProgramMonitorView::Stage(StageMonitorState::Shown) => WAITING_PROGRAM,
        };
        div()
            .id("show-stage-program")
            .flex()
            .flex_col()
            .gap(px(8.))
            .min_w(px(200.))
            .flex_1()
            .child(SectionLabel::new(title))
            .child(
                div()
                    .relative()
                    .w_full()
                    .aspect_ratio(16. / 9.)
                    .rounded(px(radius::PANEL))
                    .bg(hsla(t.video_ground))
                    .overflow_hidden()
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .type_scale(text::META)
                            .text_color(muted)
                            .child(body),
                    ),
            )
            .into_any_element()
    }
}

fn program_monitor_view_simple(
    live: bool,
    recording: bool,
    node_id: Option<&str>,
) -> ProgramMonitorView {
    if !is_managed_show(node_id) {
        return ProgramMonitorView::Return;
    }
    let running = live || recording;
    if !running {
        return ProgramMonitorView::Stage(StageMonitorState::Empty);
    }
    ProgramMonitorView::Stage(StageMonitorState::Waiting)
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
    room_open: bool,
    t: &Theme,
) -> AnyElement {
    let selected = current == option.value;
    let disabled = !room_open || option.disabled_reason.is_some();
    let reason = room_open.then_some(option.disabled_reason).flatten();
    let border = if selected {
        hsla(t.foreground)
    } else {
        hsla(t.border)
    };
    let mut card = div()
        .id(format!("stage-layout-{}", option.label))
        .flex()
        .flex_col()
        .gap(px(4.))
        .w(px(120.))
        .p(px(8.))
        .rounded(px(radius::CHIP))
        .border_1()
        .border_color(border)
        .bg(hsla(if selected {
            with_alpha(t.foreground, 0.08)
        } else {
            with_alpha(t.foreground, 0.)
        }))
        .opacity(if disabled { 0.5 } else { 1. })
        .child(
            div()
                .h(px(40.))
                .rounded(px(radius::CHIP / 2.))
                .bg(hsla(with_alpha(t.muted, 0.5))),
        )
        .child(
            div()
                .type_scale(text::META)
                .font_weight(gpui::FontWeight::MEDIUM)
                .truncate()
                .child(option.label),
        );
    if !disabled {
        let label = option.label;
        card = card.on_click(move |_, _, _| {
            eprintln!("[videorc-app] Show stage: Layout {label}: {ROOM_HOST_PENDING}");
        });
    }
    if let Some(reason) = reason {
        card = card.tooltip(tooltip(reason));
    }
    card.into_any_element()
}

fn person_row(person: &RoomPerson, on_stage_list: bool) -> ListRow {
    let action = if person.host {
        None
    } else if on_stage_list && person.on_stage {
        Some(SEND_BACKSTAGE)
    } else if !person.host {
        Some(BRING_ON)
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
    if let Some(label) = action {
        row = row.child(
            Button::new(format!("move-{}", person.identity))
                .label(label)
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .tooltip(ROOM_HOST_PENDING)
                .on_click(move |_, _, _| {
                    eprintln!("[videorc-app] Show stage: {label}: {ROOM_HOST_PENDING}");
                }),
        );
    }
    row
}

impl Render for ShowStage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let talk = self.talk_show.read(cx).value().clone();
        let host = talk.host_identity.clone();
        let people = room_people(self.room(), host.as_deref(), None);
        let _limits_blocked = bring_on_blocked_reason(&people, room_limits(self.facts.as_ref()));
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

        // P366: host local media problem once the room host reports it.
        if let Some(problem) = talk.message.filter(|m| !m.is_empty()) {
            // Room-level message (also drawn on Guests); keep as a quiet alert.
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
            .child(self.layouts(&t))
            .child(self.screens_section(&t))
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
    }
}

// Keep the camera-off helper reachable for the room host wiring.
#[allow(dead_code)]
fn _camera_off_reachable(name: &str, t: &Theme) -> AnyElement {
    camera_off_avatar(name, 320, 180, t, CAMERA_OFF_LABEL)
}
