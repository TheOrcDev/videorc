//! Guests → Separate files (plan 249 S22 / P932–P936): Studio
//! `cloud.iso.*` wrappers drive the section; words and gates live in
//! `videorc_app_core::guests::iso`.

use std::time::Duration;

use gpui::{AnyElement, App, Context, Entity, Window, div, prelude::*, px};
use videorc_app_core::guests::iso::{
    ISO_DEFAULT_LIMITS, IsoRoomGate, iso_cost_line, iso_current_take, iso_enable_blocked_reason,
    iso_enable_params, iso_error_text, iso_guest_consent_rows, iso_limits_line,
    iso_micros_per_file_minute, iso_parsed_takes, iso_refusal_text, iso_request_limits,
    iso_room_rows, iso_take_notes,
};
use videorc_app_core::guests::wire::RoomPhase;
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::checkbox::{Checkbox, CheckboxChecked};
use videorc_kit::dialog::{Dialog, DialogSize};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::settings_row::{SettingsGroup, SettingsRow};
use videorc_kit::status_dot::StatusDot;
use videorc_kit::switch::Switch;
use videorc_kit::theme::TypeScale;
use videorc_kit::tokens::text;

use super::{GuestsPanel, tone_to_status};

const ISO_SECTION: &str = "Separate files";
const ISO_DESCRIPTION: &str = "Videorc Cloud can also record each person and each source as its own file, beside the show's recording.";
const ISO_SWITCH_LABEL: &str = "Record separate files";
const STATUS_CHECK_FAILED: &str = "Couldn't check separate files. Try again in a moment.";
const ENABLE_FAILED: &str = "Couldn't turn on separate files. Try again.";
const DISABLE_FAILED: &str = "Couldn't turn off separate files. Try again.";
const ENABLE_TITLE: &str = "Record separate files?";
const ENABLE_DESCRIPTION: &str = "Videorc Cloud records each person and each source as its own file, beside the show's recording.";
const ENABLE_CONFIRM: &str = "Turn on separate files";
const ENABLE_BUSY: &str = "Turning on…";
const AGREE_LABEL: &str = "I agree to record separate files of this show.";
const CANCEL: &str = "Cancel";
const UNREADABLE: &str = "A take's separate files couldn't be read.";
const ISO_STATUS_POLL: Duration = Duration::from_secs(5);

const AVAILABILITY_CODES: &[&str] = &["cloud-iso-plan", "cloud-iso-not-qualified"];

impl GuestsPanel {
    pub(super) fn show_id(&self) -> Option<String> {
        self.studio
            .cloud_now()
            .status
            .as_ref()
            .and_then(|status| status.show.as_ref())
            .map(|show| show.id.clone())
    }

    fn iso_requested(&self) -> bool {
        self.iso_answer
            .as_ref()
            .and_then(|answer| answer.iso.as_ref())
            .is_some_and(|iso| iso.request.is_some())
    }

    pub(super) fn sync_iso_show(&mut self, cx: &mut Context<Self>) {
        let show_id = self.show_id();
        if self.iso_for_show == show_id {
            return;
        }
        self.iso_for_show = show_id.clone();
        self.iso_answer = None;
        self.iso_status_code = None;
        self.iso_status_failed = false;
        self.iso_row_error = None;
        self.iso_enable_error = None;
        self.iso_asking = false;
        self.iso_agreed = false;
        self.iso_close_enable = true;
        if show_id.is_some() {
            self.load_iso(cx);
        }
        cx.notify();
    }

    pub(super) fn load_iso(&mut self, cx: &mut Context<Self>) {
        let Some(show_id) = self.show_id() else {
            return;
        };
        let room_open = self
            .room()
            .is_some_and(|room| room.phase == RoomPhase::Open);
        if !room_open || !self.connected {
            return;
        }
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        self.iso_load_generation = self.iso_load_generation.wrapping_add(1);
        let generation = self.iso_load_generation;
        let job = runtime.spawn(async move { studio.cloud_iso_status(&show_id).await });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                if this.iso_load_generation != generation {
                    return;
                }
                match result {
                    Ok(Ok(answer)) => {
                        this.iso_answer = Some(answer);
                        this.iso_status_code = None;
                        this.iso_status_failed = false;
                        this.schedule_iso_poll(cx);
                    }
                    Ok(Err(error)) => {
                        this.iso_status_code = Some(error.code.clone());
                        this.iso_status_failed = !AVAILABILITY_CODES.contains(&error.code.as_str());
                    }
                    Err(_) => {
                        this.iso_status_code = None;
                        this.iso_status_failed = true;
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn schedule_iso_poll(&mut self, cx: &mut Context<Self>) {
        if !self.iso_requested() {
            return;
        }
        let generation = self.iso_load_generation;
        cx.spawn(async move |entity, cx| {
            cx.background_executor().timer(ISO_STATUS_POLL).await;
            let _ = entity.update(cx, |this, cx| {
                if this.iso_load_generation != generation || !this.iso_requested() {
                    return;
                }
                this.load_iso(cx);
            });
        })
        .detach();
    }

    fn open_iso_enable(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.iso_enable_error = None;
        self.iso_agreed = false;
        self.iso_asking = true;
        self.iso_close_enable = false;
        self.iso_enable.open(window, cx);
        cx.notify();
    }

    fn close_iso_enable(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.iso_busy {
            return;
        }
        self.iso_asking = false;
        self.iso_agreed = false;
        self.iso_enable_error = None;
        self.iso_close_enable = false;
        self.iso_enable.close(window, cx);
        cx.notify();
    }

    pub(super) fn flush_iso_dialogs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.iso_close_enable && self.iso_enable.is_open() {
            self.iso_close_enable = false;
            self.iso_enable.close(window, cx);
        }
    }

    fn enable_iso(&mut self, cx: &mut Context<Self>) {
        if self.iso_busy || !self.iso_agreed {
            return;
        }
        let Some(show_id) = self.show_id() else {
            return;
        };
        let micros = iso_micros_per_file_minute(self.iso_answer.as_ref().map(|a| &a.availability));
        let Some(params) = iso_enable_params(&show_id, ISO_DEFAULT_LIMITS, micros) else {
            self.iso_enable_error = Some(ENABLE_FAILED.into());
            cx.notify();
            return;
        };
        self.iso_busy = true;
        self.iso_enable_error = None;
        cx.notify();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let job = runtime.spawn(async move { studio.cloud_iso_enable(&params).await });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                this.iso_busy = false;
                match result {
                    Ok(Ok(answer)) => {
                        this.iso_answer = Some(answer);
                        this.iso_asking = false;
                        this.iso_agreed = false;
                        this.iso_row_error = None;
                        this.iso_close_enable = true;
                        this.schedule_iso_poll(cx);
                    }
                    Ok(Err(error)) => {
                        this.iso_enable_error = Some(
                            iso_error_text(Some(&error.code))
                                .unwrap_or(ENABLE_FAILED)
                                .into(),
                        );
                    }
                    Err(_) => {
                        this.iso_enable_error = Some(ENABLE_FAILED.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn disable_iso(&mut self, cx: &mut Context<Self>) {
        if self.iso_busy {
            return;
        }
        let Some(show_id) = self.show_id() else {
            return;
        };
        self.iso_busy = true;
        self.iso_row_error = None;
        cx.notify();
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let job = runtime.spawn(async move { studio.cloud_iso_disable(&show_id).await });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                this.iso_busy = false;
                match result {
                    Ok(Ok(answer)) => {
                        this.iso_answer = Some(answer);
                        this.iso_row_error = None;
                    }
                    Ok(Err(error)) => {
                        this.iso_row_error = Some(
                            iso_error_text(Some(&error.code))
                                .unwrap_or(DISABLE_FAILED)
                                .into(),
                        );
                    }
                    Err(_) => {
                        this.iso_row_error = Some(DISABLE_FAILED.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn iso_section(
        &self,
        room_open: bool,
        offline: bool,
        entity: &Entity<Self>,
    ) -> AnyElement {
        let answer = self.iso_answer.as_ref();
        let requested = self.iso_requested();
        let blocked = iso_enable_blocked_reason(IsoRoomGate {
            offline,
            room_open,
            answer,
            error_code: self.iso_status_code.as_deref(),
        });
        let switch_reason = if requested {
            if offline { blocked } else { None }
        } else {
            blocked
        };
        let switch_disabled = self.iso_busy || switch_reason.is_some();
        let limits = iso_request_limits(
            answer
                .and_then(|a| a.iso.as_ref())
                .and_then(|iso| iso.request.as_ref()),
        );
        let description = if requested {
            format!("On for this show. {}", iso_limits_line(limits))
        } else {
            match blocked {
                Some(reason) => reason.to_string(),
                None => format!("Off. {}", iso_limits_line(limits)),
            }
        };
        let row_error = self
            .iso_row_error
            .clone()
            .or_else(|| self.iso_status_failed.then(|| STATUS_CHECK_FAILED.into()));

        let mut row = SettingsRow::new("guests-iso-row", ISO_SWITCH_LABEL).description(description);
        if let Some(error) = row_error {
            row = row.error(error);
        }
        row = row.child(
            Switch::new("guests-iso-switch")
                .accessibility_label(ISO_SWITCH_LABEL)
                .checked(requested)
                .disabled(switch_disabled)
                .on_change({
                    let entity = entity.clone();
                    move |on, window, cx| {
                        entity.update(cx, |this, cx| {
                            if on {
                                this.open_iso_enable(window, cx);
                            } else {
                                this.disable_iso(cx);
                            }
                        })
                    }
                }),
        );

        let mut section = PanelSection::new("guests-iso")
            .title(ISO_SECTION)
            .description(ISO_DESCRIPTION)
            .last(true)
            .child(SettingsGroup::new().row(row));

        let guests = self.room().map(|r| r.guests.as_slice()).unwrap_or(&[]);
        if requested {
            let consent = answer
                .and_then(|a| a.iso.as_ref())
                .map(|iso| iso.guest_consent.as_slice())
                .unwrap_or(&[]);
            let rows = iso_guest_consent_rows(guests, consent);
            if !rows.is_empty() {
                let mut list = GroupedList::new().label("Guests");
                for (index, row) in rows.iter().enumerate() {
                    list = list.item(
                        ListRow::new(("guests-iso-guest", index), row.name.clone()).child(
                            StatusDot::new(("guests-iso-guest-dot", index))
                                .tone(tone_to_status(row.status.tone))
                                .label(row.status.label.clone()),
                        ),
                    );
                }
                section = section.child(list);
            }
        }

        let takes = iso_parsed_takes(answer.and_then(|a| a.iso.as_ref()));
        let unreadable = takes.iter().any(|entry| entry.take.is_none());
        if let Some(take) = iso_current_take(&takes) {
            let file_rows = iso_room_rows(&take.manifest, guests);
            if !file_rows.is_empty() {
                let mut list = GroupedList::new().label("Files");
                for (index, row) in file_rows.iter().enumerate() {
                    let mut item = ListRow::new(("guests-iso-file", index), row.title.clone())
                        .child(
                            StatusDot::new(("guests-iso-file-dot", index))
                                .tone(tone_to_status(row.status.tone))
                                .label(row.status.label.clone()),
                        );
                    if let Some(detail) = row.detail {
                        item = item.context(detail);
                    }
                    list = list.item(item);
                }
                section = section.child(list);
            }
            for (index, note) in iso_take_notes(take).into_iter().enumerate() {
                section = section.child(
                    Alert::new(("guests-iso-note", index))
                        .variant(AlertVariant::Warning)
                        .title(note),
                );
            }
        }
        if let Some(refusal) = iso_refusal_text(answer.and_then(|a| a.iso.as_ref())) {
            section = section.child(
                Alert::new("guests-iso-refusal")
                    .variant(AlertVariant::Warning)
                    .title(refusal),
            );
        }
        if unreadable {
            section = section.child(
                Alert::new("guests-iso-unreadable")
                    .variant(AlertVariant::Warning)
                    .title(UNREADABLE),
            );
        }

        section.into_any_element()
    }

    pub(super) fn iso_enable_dialog(&self, entity: &Entity<Self>, _cx: &App) -> AnyElement {
        if !self.iso_asking && !self.iso_enable.is_open() {
            return div().into_any_element();
        }
        let micros = iso_micros_per_file_minute(self.iso_answer.as_ref().map(|a| &a.availability));
        let limits = ISO_DEFAULT_LIMITS;
        let entity = entity.clone();
        Dialog::new("guests-iso-enable", &self.iso_enable, ENABLE_TITLE)
            .size(DialogSize::Md)
            .description(ENABLE_DESCRIPTION)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .type_scale(text::META)
                    .child("• Your camera, microphone and screen, each as its own file.")
                    .child(
                        "• Your show sounds (soundboard and computer audio) combined in one file.",
                    )
                    .child(
                        "• Each guest who agrees: their camera, microphone, screen and screen audio, each as its own file.",
                    )
                    .child(
                        "Guests are asked on their page first. Only guests who agree are recorded separately, and a guest who stops agreeing stops being recorded.",
                    )
                    .child(format!(
                        "{} Files are kept as long as the show's recording, then deleted.",
                        iso_limits_line(limits)
                    ))
                    .child(iso_cost_line(limits, micros))
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .gap(px(8.))
                            .child(
                                Checkbox::new("guests-iso-agree")
                                    .accessibility_label(AGREE_LABEL)
                                    .checked(self.iso_agreed)
                                    .disabled(self.iso_busy)
                                    .on_change({
                                        let entity = entity.clone();
                                        move |state, _, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.iso_agreed = state == CheckboxChecked::Checked;
                                                cx.notify();
                                            })
                                        }
                                    }),
                            )
                            .child(div().flex_1().min_w(px(0.)).child(AGREE_LABEL)),
                    )
                    .children(self.iso_enable_error.as_ref().map(|error| {
                        Alert::new("guests-iso-enable-error")
                            .variant(AlertVariant::Destructive)
                            .title(error.clone())
                    })),
            )
            .footer(
                Button::new("guests-iso-enable-cancel")
                    .label(CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .disabled(self.iso_busy)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |this, cx| this.close_iso_enable(window, cx))
                        }
                    }),
            )
            .footer(
                Button::new("guests-iso-enable-confirm")
                    .label(if self.iso_busy {
                        ENABLE_BUSY
                    } else {
                        ENABLE_CONFIRM
                    })
                    .disabled(!self.iso_agreed || self.iso_busy)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, cx| this.enable_iso(cx))
                    }),
            )
            .into_any_element()
    }
}
