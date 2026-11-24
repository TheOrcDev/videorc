//! Guests ⌘7 (plan 260 Phase 3, L4): Room, Invite link and Who's here from
//! `videorc_app_core::guests::view` and `wire`, drawn with `videorc-kit`.
//! Words match Electron's guests-tab / guests-view.

use std::sync::Arc;

use gpui::{Context, Window, div, prelude::*, px};
use videorc_app_core::guests::view::{
    self as guests, CloudRoomFacts, GuestsAccess, RoomPerson, declined_line, guest_consent_line,
    guests_access, new_link_asks_first, request_device, request_title, room_counts, room_is_full,
    room_limits, room_limits_line, room_people, room_phase_label,
};
use videorc_app_core::guests::wire::{RecordingStatus, RoomPhase, RoomRequest, RoomStatus};
use videorc_app_core::livestream::cloud_status::CloudStatus;
use videorc_app_core::livestream::copy as livestream_copy;
use videorc_app_core::livestream::targets;
use videorc_app_core::{BackendClient, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::switch::Switch;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

pub type AppStudio = Studio<BackendClient>;

const ROOM_SECTION: &str = "Room";
const ROOM_DESCRIPTION: &str = "Guests join from a link in their browser. Nothing to install.";
const INVITE_SECTION: &str = "Invite link";
const WHOS_HERE: &str = "Who's here";
const OPENING: &str = "Opening…";
const CLOSING: &str = "Closing…";
const COPY: &str = "Copy";
const COPIED: &str = "Copied";
const NEW_LINK: &str = "New link";
const MAKING: &str = "Making…";
const MAKE_A_NEW_LINK: &str = "Make a new link?";
const INVITE_PLACEHOLDER: &str = "The link appears when the room opens.";
const INVITE_ARIA: &str = "Invite link";
const WANTS_TO_JOIN: &str = "Wants to join";
const ON_STAGE: &str = "On stage";
const BACKSTAGE: &str = "Backstage";
const LET_IN: &str = "Let in";
const DECLINE: &str = "Decline";
const CANCEL: &str = "Cancel";
const OFFLINE_LOCK: &str = "Videorc is reconnecting. These controls come back in a moment.";
const CONSENT_PREFIX: &str = "Guests read this before they ask to join: “";
const CONSENT_SUFFIX: &str = "”";

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

fn asking_badge(count: u32) -> String {
    if count == 1 {
        "1 wants to join".into()
    } else {
        format!("{count} want to join")
    }
}

pub struct GuestsPanel {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    facts: Option<CloudRoomFacts>,
    connected: bool,
    session_active: bool,
    opening: bool,
    closing: bool,
    rotating: bool,
    copied: bool,
    new_link: DialogHandle,
}

impl GuestsPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut cloud_rx = studio_watch.cloud();
            let mut studio_rx = studio_watch.watch();
            loop {
                tokio::select! {
                    changed = cloud_rx.changed() => if changed.is_err() { break },
                    changed = studio_rx.changed() => if changed.is_err() { break },
                }
                let _ = this.update(cx, |panel, cx| panel.rebuild(cx));
            }
        })
        .detach();
        let mut panel = Self {
            studio,
            runtime,
            facts: None,
            connected: false,
            session_active: false,
            opening: false,
            closing: false,
            rotating: false,
            copied: false,
            new_link: DialogHandle::new(false),
        };
        panel.rebuild(cx);
        panel
    }

    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let cloud = self.studio.cloud_now();
        let snapshot = self.studio.snapshot();
        let facts = cloud_facts(cloud.status.as_ref());
        let connected = self.studio.is_connected();
        let session_active = snapshot.session.phase.is_active();
        if self.facts != facts
            || self.connected != connected
            || self.session_active != session_active
        {
            self.facts = facts;
            self.connected = connected;
            self.session_active = session_active;
            let phase = self
                .facts
                .as_ref()
                .and_then(|f| f.room.as_ref())
                .map(|r| r.phase);
            if phase == Some(RoomPhase::Open) || phase == Some(RoomPhase::Closed) {
                self.opening = false;
            }
            if phase == Some(RoomPhase::Closed) {
                self.closing = false;
            }
            cx.notify();
        }
    }

    fn room(&self) -> Option<&RoomStatus> {
        self.facts.as_ref().and_then(|f| f.room.as_ref())
    }

    fn host_identity(&self) -> Option<String> {
        let status = self.studio.cloud_now().status?;
        let show_id = status.show.as_ref()?.id.as_str();
        let open = self.room().is_some_and(|r| r.phase == RoomPhase::Open);
        open.then(|| format!("host:{show_id}"))
    }

    fn open_room(&mut self, cx: &mut Context<Self>) {
        if self.opening {
            return;
        }
        self.opening = true;
        cx.notify();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let snapshot = studio.snapshot();
        let platforms: Vec<String> = {
            let mut seen = std::collections::BTreeSet::new();
            targets::targets(&snapshot.settings.capture_doc)
                .into_iter()
                .filter(|t| t.enabled)
                .filter_map(|t| seen.insert(t.platform.clone()).then_some(t.platform))
                .collect()
        };
        let title = studio
            .details_now()
            .draft
            .as_ref()
            .map(|d| d.title.trim().to_string())
            .filter(|t| !t.is_empty());
        cx.spawn(async move |this, cx| {
            runtime
                .spawn(async move { studio.open_talk_room(title, platforms).await })
                .await
                .ok();
            let _ = this.update(cx, |this, cx| {
                this.opening = false;
                this.rebuild(cx);
            });
        })
        .detach();
    }

    fn close_room(&mut self, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        self.closing = true;
        cx.notify();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            runtime
                .spawn(async move { studio.close_talk_room().await })
                .await
                .ok();
            let _ = this.update(cx, |this, cx| {
                this.closing = false;
                this.rebuild(cx);
            });
        })
        .detach();
    }

    fn set_door(&self, open: bool) {
        let studio = self.studio.clone();
        self.runtime
            .spawn(async move { studio.set_talk_door(open).await });
    }

    fn rotate_invite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.rotating {
            return;
        }
        self.rotating = true;
        self.new_link.close(window, cx);
        cx.notify();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            runtime
                .spawn(async move { studio.rotate_talk_invite().await })
                .await
                .ok();
            let _ = this.update(cx, |this, cx| {
                this.rotating = false;
                this.rebuild(cx);
            });
        })
        .detach();
    }

    fn copy_invite(&mut self, cx: &mut Context<Self>) {
        let Some(url) = self.room().and_then(|r| r.invite_url.clone()) else {
            return;
        };
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(url));
        self.copied = true;
        cx.notify();
        let entity = cx.entity();
        cx.spawn(async move |_, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(2))
                .await;
            let _ = entity.update(cx, |this, cx| {
                this.copied = false;
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
}

impl Render for GuestsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let access = guests_access(self.facts.as_ref());
        let room = self.room().cloned();
        let phase = room.as_ref().map(|r| r.phase).unwrap_or(RoomPhase::Closed);
        let room_open = phase == RoomPhase::Open;
        let locked = matches!(access, GuestsAccess::Locked { .. });
        let offline = !self.connected;
        let session_locked = self.session_active && phase == RoomPhase::Closed;
        let disabled = offline || locked || session_locked;
        let room_pending = self.opening || phase == RoomPhase::Opening;
        let limits = room_limits(self.facts.as_ref());
        let limits_line = room_limits_line(limits);
        let host = self.host_identity();
        let people = room_people(room.as_ref(), host.as_deref(), None);
        let counts = room_counts(room.as_ref(), &people);
        let full = room_open && room_is_full(&people, limits);
        let requests = room
            .as_ref()
            .map(|r| r.requests.clone())
            .unwrap_or_default();
        let declined = declined_line(room.as_ref().map(|r| r.declined_count).unwrap_or(0));
        let entity = cx.entity();

        let mut notices = div().flex().flex_col().gap(px(8.));
        if offline {
            notices = notices.child(
                Alert::new("guests-offline")
                    .variant(AlertVariant::Locked)
                    .title(OFFLINE_LOCK),
            );
        } else if let GuestsAccess::Locked { reason, upsell } = access {
            let mut alert = Alert::new("guests-lock")
                .variant(AlertVariant::Locked)
                .title(*reason);
            if upsell {
                alert = alert.action(
                    Button::new("guests-premium")
                        .label(livestream_copy::VIEW_PREMIUM)
                        .variant(ButtonVariant::Outline)
                        .on_click(|_, _, cx| cx.open_url("https://videorc.com/account")),
                );
            }
            notices = notices.child(alert);
        } else if session_locked {
            notices = notices.child(
                Alert::new("guests-session-lock")
                    .variant(AlertVariant::Locked)
                    .title(guests::ROOM_WAITS_FOR_SESSION),
            );
        }

        let phase_label = room_phase_label(room.as_ref());
        let mut room_trailing = div().flex().items_center().gap(px(8.)).flex_wrap();
        if room_open {
            if counts.asking > 0 {
                room_trailing = room_trailing
                    .child(Badge::new(asking_badge(counts.asking)).variant(BadgeVariant::Warning));
            }
            room_trailing = room_trailing
                .child(
                    Badge::new(format!("{} on stage", counts.on_stage))
                        .variant(BadgeVariant::Outline),
                )
                .child(
                    Badge::new(format!("{} backstage", counts.backstage))
                        .variant(BadgeVariant::Outline),
                );
        }
        if room_open || phase == RoomPhase::Closing {
            room_trailing = room_trailing.child(
                Button::new("guests-close-room")
                    .label(if self.closing || phase == RoomPhase::Closing {
                        CLOSING
                    } else {
                        guests::CLOSE_THE_ROOM_LABEL
                    })
                    .variant(ButtonVariant::Outline)
                    .disabled(disabled || self.closing || phase == RoomPhase::Closing)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.close_room(cx))
                    }),
            );
        } else {
            room_trailing = room_trailing.child(
                Button::new("guests-open-room")
                    .label(if room_pending {
                        OPENING
                    } else {
                        guests::OPEN_THE_ROOM_LABEL
                    })
                    .disabled(disabled || room_pending)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.open_room(cx))
                    }),
            );
        }

        let room_row = SettingsRow::new("guests-room-row", phase_label)
            .description(guests::ROOM_BACKSTAGE_TIME_LINE)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(StatusDot::new("guests-phase").tone(if room_open {
                        StatusTone::Good
                    } else {
                        StatusTone::Neutral
                    }))
                    .child(room_trailing),
            );

        let mut room_section = PanelSection::new("guests-room")
            .title(ROOM_SECTION)
            .description(ROOM_DESCRIPTION)
            .child(notices)
            .child(SettingsGroup::new().row(room_row));
        if let Some(message) = room.as_ref().and_then(|r| r.message.clone()) {
            room_section = room_section.child(
                Alert::new("guests-room-message")
                    .variant(AlertVariant::Warning)
                    .title(message),
            );
        }

        let invite_url = room
            .as_ref()
            .and_then(|r| r.invite_url.clone())
            .unwrap_or_default();
        let no_link = invite_url.is_empty();
        let mut invite = PanelSection::new("guests-invite").title(INVITE_SECTION);
        if let Some(line) = &limits_line {
            invite = invite.description(line.clone());
        }
        invite = invite
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .px(px(10.))
                            .py(px(6.))
                            .rounded(px(6.))
                            .bg(hsla(t.muted))
                            .type_scale(text::META)
                            .text_color(hsla(if no_link {
                                t.muted_foreground
                            } else {
                                t.foreground
                            }))
                            .child(if no_link {
                                INVITE_PLACEHOLDER.to_string()
                            } else {
                                invite_url.clone()
                            })
                            .id("guests-invite-url")
                            .accessibility_label(INVITE_ARIA),
                    )
                    .child(
                        Button::new("guests-invite-copy")
                            .label(if self.copied { COPIED } else { COPY })
                            .variant(ButtonVariant::Secondary)
                            .disabled(disabled || no_link)
                            .when(!disabled && no_link, |b| {
                                b.tooltip(guests::OPEN_THE_ROOM_FIRST)
                            })
                            .on_click({
                                let entity = entity.clone();
                                move |_, _, cx| entity.update(cx, |this, cx| this.copy_invite(cx))
                            }),
                    )
                    .child(
                        Button::new("guests-invite-rotate")
                            .label(if self.rotating { MAKING } else { NEW_LINK })
                            .variant(ButtonVariant::Outline)
                            .disabled(disabled || !room_open || self.rotating)
                            .when(!disabled && !room_open, |b| {
                                b.tooltip(guests::OPEN_THE_ROOM_FIRST)
                            })
                            .on_click({
                                let entity = entity.clone();
                                move |_, window, cx| {
                                    entity.update(cx, |this, cx| {
                                        if new_link_asks_first(this.room()) {
                                            this.new_link.open(window, cx);
                                        } else {
                                            this.rotate_invite(window, cx);
                                        }
                                    })
                                }
                            }),
                    ),
            )
            .child(
                SettingsGroup::new().row(
                    SettingsRow::new("guests-door", guests::DOOR_SWITCH_LABEL)
                        .description(guests::DOOR_SWITCH_DESCRIPTION)
                        .child(
                            Switch::new("guests-door-switch")
                                .checked(room.as_ref().is_some_and(|r| r.door_open))
                                .disabled(disabled || !room_open)
                                .on_change({
                                    let entity = entity.clone();
                                    move |open, _, cx| {
                                        entity.update(cx, |this, _| this.set_door(open))
                                    }
                                }),
                        ),
                ),
            )
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(format!(
                        "{CONSENT_PREFIX}{}{CONSENT_SUFFIX}",
                        guest_consent_line(
                            room.as_ref().map(|r| r.platforms.as_slice()).unwrap_or(&[])
                        )
                    )),
            );

        let mut people_section = PanelSection::new("guests-people")
            .title(WHOS_HERE)
            .last(true);
        if full {
            people_section = people_section.child(
                Alert::new("guests-room-full")
                    .variant(AlertVariant::Quiet)
                    .title(guests::ROOM_FULL_LINE),
            );
        }
        let guests_only: Vec<&RoomPerson> = people.iter().filter(|p| !p.host).collect();
        if requests.is_empty() && guests_only.is_empty() {
            people_section = people_section.child(Empty::new().description(guests::NOBODY_YET));
            if let Some(line) = declined {
                people_section = people_section.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(line),
                );
            }
        } else {
            let on_stage: Vec<&RoomPerson> =
                people.iter().filter(|p| p.host || p.on_stage).collect();
            let backstage: Vec<&RoomPerson> =
                people.iter().filter(|p| !p.host && !p.on_stage).collect();
            if !requests.is_empty() {
                let mut list =
                    GroupedList::new().label(format!("{WANTS_TO_JOIN} · {}", requests.len()));
                for request in &requests {
                    list = list.item(request_row(request, disabled, &entity));
                }
                people_section = people_section.child(list);
            }
            if !on_stage.is_empty() {
                let mut list = GroupedList::new().label(format!("{ON_STAGE} · {}", on_stage.len()));
                for person in on_stage {
                    list = list.item(person_row(person));
                }
                people_section = people_section.child(list);
            }
            if !backstage.is_empty() {
                let mut list =
                    GroupedList::new().label(format!("{BACKSTAGE} · {}", backstage.len()));
                for person in backstage {
                    list = list.item(person_row(person));
                }
                people_section = people_section.child(list);
            }
            if let Some(line) = declined {
                people_section = people_section.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(line),
                );
            }
        }

        let new_link_dialog = Dialog::new("guests-new-link", &self.new_link, MAKE_A_NEW_LINK)
            .size(DialogSize::Sm)
            .description(guests::NEW_LINK_CONFIRM_DESCRIPTION)
            .footer(
                Button::new("guests-new-link-cancel")
                    .label(CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.new_link.close(window, cx))
                        }
                    }),
            )
            .footer(
                Button::new("guests-new-link-confirm")
                    .label(if self.rotating { MAKING } else { NEW_LINK })
                    .disabled(self.rotating)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.rotate_invite(window, cx))
                        }
                    }),
            );

        div()
            .id("guests-page")
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .type_scale(text::META)
            .child(
                ScrollArea::new("guests-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .px(px(size::GUTTER))
                        .py(px(8.))
                        .gap(px(16.))
                        .child(room_section)
                        .child(invite)
                        .child(people_section),
                ),
            )
            .child(new_link_dialog)
    }
}

fn request_row(
    request: &RoomRequest,
    disabled: bool,
    entity: &gpui::Entity<GuestsPanel>,
) -> impl IntoElement {
    let id = request.request_id.clone();
    let entity = entity.clone();
    div().child(
        ListRow::new(
            format!("guests-request-{}", request.request_id),
            request_title(request),
        )
        .context(request_device(request))
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(
                    Button::new(format!("guests-let-in-{id}"))
                        .label(LET_IN)
                        .disabled(disabled)
                        .on_click({
                            let entity = entity.clone();
                            let id = id.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, _| this.decide(id.clone(), "let-in"))
                            }
                        }),
                )
                .child(
                    Button::new(format!("guests-decline-{id}"))
                        .label(DECLINE)
                        .variant(ButtonVariant::Outline)
                        .disabled(disabled)
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |this, _| this.decide(id.clone(), "decline"))
                        }),
                ),
        ),
    )
}

fn person_row(person: &RoomPerson) -> impl IntoElement {
    let mut trailing = div().flex().items_center().gap(px(8.));
    if person.away {
        trailing = trailing.child(Badge::new("Away").variant(BadgeVariant::Warning));
    }
    if let Some((label, _)) = guests::guest_mic_status(person.mic, &person.name) {
        trailing = trailing.child(Badge::new(label).variant(BadgeVariant::Outline));
    }
    ListRow::new(
        format!("guests-person-{}", person.identity),
        person.name.clone(),
    )
    .context(if person.host {
        "Host"
    } else if person.on_stage {
        ON_STAGE
    } else {
        BACKSTAGE
    })
    .child(trailing)
}
