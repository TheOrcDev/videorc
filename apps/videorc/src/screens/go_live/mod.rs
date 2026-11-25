//! Go Live dialog (plan 260 Phase 3, L4): `videorc_app_core::livestream::golive`
//! + `studio::go_live`, drawn with `videorc-kit`. Words from
//! `livestream::go_live_copy` and Electron's Cancel / Ready.

use std::sync::Arc;

use gpui::{Context, Window, div, prelude::*, px};
use videorc_app_core::desktop::permissions::PermissionPlatform;
use videorc_app_core::livestream::accounts::{destination_label, platform_label};
use videorc_app_core::livestream::captions_preflight::{self, go_live_readiness};
use videorc_app_core::livestream::copy as dest_copy;
use videorc_app_core::livestream::go_live_copy as copy;
use videorc_app_core::livestream::golive::{self, CaptionsStatus, DialogView};
use videorc_app_core::livestream::plan;
use videorc_app_core::livestream::targets::{self, Target};
use videorc_app_core::studio::captions_readiness::captions_platform_unavailable_reason;
use videorc_app_core::studio::go_live::GoLiveState;
use videorc_app_core::{BackendClient, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

pub type AppStudio = Studio<BackendClient>;

const CANCEL: &str = "Cancel";
const READY: &str = "Ready";

pub struct GoLiveDialog {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    dialog: DialogHandle,
    /// The kit handle was open for this Go Live (so Escape can cancel).
    was_open: bool,
    state: GoLiveState,
    view: DialogView,
    gate_blocked: bool,
    confirm_label: String,
    through_cloud: bool,
    excluded: Vec<Target>,
    has_scheduled: bool,
    has_instant: bool,
    title_issue: Option<String>,
    description_issue: Option<String>,
    entitlement: Option<String>,
    captions: CaptionsStatus,
    /// "Go live without captions this time".
    suppress_captions: bool,
}

impl GoLiveDialog {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut go_live_rx = studio_watch.go_live();
            let mut details_rx = studio_watch.details();
            let mut studio_rx = studio_watch.watch();
            loop {
                tokio::select! {
                    changed = go_live_rx.changed() => if changed.is_err() { break },
                    changed = details_rx.changed() => if changed.is_err() { break },
                    changed = studio_rx.changed() => if changed.is_err() { break },
                }
                let _ = this.update(cx, |panel, cx| {
                    panel.rebuild(cx);
                });
            }
        })
        .detach();
        let mut panel = Self {
            studio,
            runtime,
            dialog: DialogHandle::new(false),
            was_open: false,
            state: GoLiveState::default(),
            view: DialogView::default(),
            gate_blocked: true,
            confirm_label: copy::GO_LIVE.to_string(),
            through_cloud: false,
            excluded: Vec::new(),
            has_scheduled: false,
            has_instant: false,
            title_issue: None,
            description_issue: None,
            entitlement: None,
            captions: CaptionsStatus::Hidden,
            suppress_captions: false,
        };
        panel.rebuild(cx);
        panel
    }

    /// Opens the confirmation as the Studio's Go Live button does (the
    /// smokes' `open-tab {dialog: "go-live"}`, the screen gallery).
    pub fn open(&self) {
        let studio = self.studio.clone();
        self.runtime
            .spawn(async move { studio.open_go_live().await });
    }

    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let state = self.studio.go_live_now();
        let snapshot = self.studio.snapshot();
        let details = self.studio.details_now();
        let capture = &snapshot.settings.capture_doc;
        let all_targets = targets::targets(capture);
        let excluded: Vec<Target> = all_targets
            .iter()
            .filter(|t| state.excluded.iter().any(|id| id == &t.id))
            .cloned()
            .collect();
        let sent: Vec<Target> = all_targets
            .into_iter()
            .filter(|t| t.enabled && !state.excluded.iter().any(|id| id == &t.id))
            .collect();
        let through_cloud = capture
            .get("streaming")
            .and_then(|s| s.get("throughVideorcCloud"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let captions_enabled = capture
            .get("captions")
            .and_then(|c| c.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let platform = match PermissionPlatform::current() {
            PermissionPlatform::Other => "linux",
            _ => "darwin",
        };
        let platform_unavailable = captions_platform_unavailable_reason(platform);
        let recording = plan::recording_video(capture);
        let stream_plan = plan::go_live_plan(capture, &recording, false);
        let output_rule = captions_preflight::session_output_readiness(
            captions_preflight::BurnTarget::Stream,
            capture
                .get("recordEnabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            capture
                .get("streamEnabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            &recording,
            std::slice::from_ref(&stream_plan.stream_video),
        );
        let readiness = go_live_readiness(
            captions_enabled,
            self.suppress_captions,
            None,
            output_rule,
            platform_unavailable,
        );
        let captions = golive::captions_status(&readiness);
        let gate = golive::confirm_gate(
            state.preflight.as_ref(),
            details.draft.as_ref(),
            &sent,
            readiness.blocks_start,
            None,
            false,
        );
        let confirm_label = if state.pending {
            golive::pending_label(state.phase.as_ref(), through_cloud)
        } else if let Some(partial) = &state.partial {
            copy::go_live_on_ready_label(&partial.ready_labels)
        } else {
            golive::confirm_label(
                state
                    .preflight
                    .as_ref()
                    .map(|p| p.destinations.len())
                    .unwrap_or(0),
            )
        };
        let changed = self.state != state
            || self.view != gate.view
            || self.gate_blocked != gate.blocked
            || self.confirm_label != confirm_label
            || self.through_cloud != through_cloud
            || self.excluded != excluded
            || self.has_scheduled != gate.has_scheduled
            || self.has_instant != gate.has_instant
            || self.title_issue != gate.title_issue
            || self.description_issue != gate.description_issue
            || self.entitlement != gate.entitlement
            || self.captions != captions;
        self.state = state;
        self.view = gate.view;
        self.gate_blocked = gate.blocked;
        self.confirm_label = confirm_label;
        self.through_cloud = through_cloud;
        self.excluded = excluded;
        self.has_scheduled = gate.has_scheduled;
        self.has_instant = gate.has_instant;
        self.title_issue = gate.title_issue;
        self.description_issue = gate.description_issue;
        self.entitlement = gate.entitlement;
        self.captions = captions;
        if !self.state.open {
            self.suppress_captions = false;
        }
        if changed {
            cx.notify();
        }
    }

    fn sync_handle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.open {
            if !self.dialog.is_open() {
                if self.was_open {
                    self.was_open = false;
                    self.cancel();
                } else {
                    self.dialog.open(window, cx);
                    self.was_open = true;
                }
            } else {
                self.was_open = true;
            }
        } else {
            if self.dialog.is_open() {
                self.dialog.close(window, cx);
            }
            self.was_open = false;
        }
    }

    fn cancel(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.cancel_go_live().await;
        });
    }

    fn confirm(&self) {
        let studio = self.studio.clone();
        if self.state.partial.is_some() {
            self.runtime.spawn(async move {
                studio.continue_go_live_partial().await;
            });
        } else {
            self.runtime.spawn(async move {
                studio.confirm_go_live().await;
            });
        }
    }

    fn resolve(&self, target_id: String, resolution: &'static str) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.resolve_go_live_blocker(&target_id, resolution).await;
        });
    }

    fn recheck(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio.recheck_go_live().await;
        });
    }

    fn destination_rows(
        &self,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let pending = self.state.pending;
        let mut list = GroupedList::new();
        for row in &self.view.destinations {
            let dest = &row.destination;
            let id = dest.target_id.clone();
            let ready = row.ready;
            let context = if dest.auth_mode == "oauth" {
                dest.account_label
                    .clone()
                    .unwrap_or_else(|| dest_copy::AUTH_SIGN_IN.to_string())
            } else {
                dest_copy::ROW_STREAM_KEY.to_string()
            };
            let badge = if ready {
                Badge::new(READY).variant(BadgeVariant::Success)
            } else {
                Badge::new(copy::NEEDS_ATTENTION_BADGE).variant(BadgeVariant::Warning)
            };
            let mut block = div().child(
                ListRow::new(
                    format!("go-live-dest-{}", dest.target_id),
                    destination_label(&dest.label),
                )
                .context(context)
                .child(badge),
            );
            let mut body = div().flex().flex_col().gap(px(4.)).px(px(12.)).pb(px(8.));
            if let Some(scheduled) = &dest.scheduled {
                let title = scheduled
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let line = if title.is_empty() {
                    copy::SCHEDULED_EVENT.to_string()
                } else {
                    copy::scheduled_title(title)
                };
                body = body.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(line),
                );
            }
            if let Some(problem) = &row.problem {
                body = body.child(div().type_scale(text::META).child(problem.clone()));
            }
            let (read_label, read_tone) = golive::read_label(&dest.chat_read);
            let (write_label, write_tone) = golive::write_label(&dest.chat_write);
            body = body.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(Badge::new(format!("Read · {read_label}")).variant(chat_tone(read_tone)))
                    .child(
                        Badge::new(format!("Send · {write_label}")).variant(chat_tone(write_tone)),
                    ),
            );
            if !dest.chat_message.is_empty() {
                body = body.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(dest.chat_message.clone()),
                );
            }
            if !ready {
                let entity = cx.entity();
                let mut actions = div().flex().flex_wrap().gap(px(8.));
                if dest.auth_mode == "oauth" {
                    let reconnected = self.state.reconnected.iter().any(|r| r == &id);
                    if reconnected {
                        actions = actions.child(
                            Button::new(format!("go-live-recheck-{id}"))
                                .label(dest_copy::CHECK_AGAIN)
                                .variant(ButtonVariant::Outline)
                                .disabled(pending)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, _, cx| entity.update(cx, |this, _| this.recheck())
                                }),
                        );
                    }
                    actions = actions.child(
                        Button::new(format!("go-live-manual-{id}"))
                            .label(dest_copy::USE_STREAM_KEY)
                            .variant(ButtonVariant::Outline)
                            .disabled(pending)
                            .on_click({
                                let entity = entity.clone();
                                let id = id.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |this, _| {
                                        this.resolve(id.clone(), "manual-rtmp")
                                    })
                                }
                            }),
                    );
                }
                actions = actions.child(
                    Button::new(format!("go-live-exclude-{id}"))
                        .label(golive::without_label(&dest.label))
                        .variant(ButtonVariant::Outline)
                        .disabled(pending)
                        .on_click({
                            let entity = entity.clone();
                            let id = id.clone();
                            move |_, _, cx| {
                                entity.update(cx, |this, _| this.resolve(id.clone(), "exclude"))
                            }
                        }),
                );
                body = body.child(actions);
            }
            block = block.child(body);
            list = list.item(block);
        }
        for target in &self.excluded {
            let id = target.id.clone();
            let entity = cx.entity();
            let context = if target.auth_mode == "oauth" {
                dest_copy::AUTH_SIGN_IN
            } else {
                dest_copy::ROW_STREAM_KEY
            };
            list = list.item(
                div()
                    .child(
                        ListRow::new(
                            format!("go-live-excluded-{id}"),
                            destination_label(&target.label),
                        )
                        .context(context)
                        .child(Badge::new(copy::LEFT_OUT).variant(BadgeVariant::Outline)),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .px(px(12.))
                            .pb(px(8.))
                            .child(
                                div()
                                    .flex_1()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(copy::GO_LIVE_EXCLUDED_NOTE),
                            )
                            .child(
                                Button::new(format!("go-live-include-{id}"))
                                    .label(copy::ADD_BACK)
                                    .variant(ButtonVariant::Outline)
                                    .disabled(pending)
                                    .on_click(move |_, _, cx| {
                                        entity.update(cx, |this, _| {
                                            this.resolve(id.clone(), "include")
                                        })
                                    }),
                            ),
                    ),
            );
        }
        list
    }
}

fn chat_tone(tone: &str) -> BadgeVariant {
    match tone {
        "good" => BadgeVariant::Success,
        "warn" => BadgeVariant::Warning,
        "error" => BadgeVariant::Destructive,
        _ => BadgeVariant::Outline,
    }
}

impl Render for GoLiveDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_handle(window, cx);
        if !self.state.open && !self.dialog.is_open() {
            return div().into_any_element();
        }
        let t = theme::current(window, cx).theme();
        let pending = self.state.pending;
        let entity = cx.entity();
        let mut body = div().flex().flex_col().gap(px(12.));

        if let Some(entitlement) = &self.entitlement {
            body = body.child(
                Alert::new("go-live-entitlement")
                    .variant(AlertVariant::Locked)
                    .title(entitlement.clone())
                    .action(
                        Button::new("go-live-view-premium")
                            .label(dest_copy::VIEW_PREMIUM)
                            .variant(ButtonVariant::Outline)
                            .on_click(|_, _, cx| cx.open_url("https://videorc.com/premium")),
                    ),
            );
        }

        if self.has_scheduled {
            let others = if self.has_instant {
                copy::SCHEDULED_OTHERS
            } else {
                ""
            };
            body = body.child(
                Alert::new("go-live-scheduled")
                    .variant(AlertVariant::Warning)
                    .title(copy::scheduled_starts_now(others)),
            );
        }

        if let Some(issue) = &self.title_issue {
            body = body.child(
                Alert::new("go-live-title")
                    .variant(AlertVariant::Destructive)
                    .title(issue.clone()),
            );
        }
        if let Some(issue) = &self.description_issue {
            body = body.child(
                Alert::new("go-live-description")
                    .variant(AlertVariant::Destructive)
                    .title(issue.clone()),
            );
        }

        match &self.captions {
            CaptionsStatus::Blocked { description } => {
                let entity = cx.entity();
                body = body.child(
                    Alert::new("go-live-captions-blocked")
                        .variant(AlertVariant::Destructive)
                        .title(copy::CAPTIONS_CANT_START)
                        .description(description.clone())
                        .action(
                            Button::new("go-live-without-captions")
                                .label(copy::GO_LIVE_WITHOUT_CAPTIONS)
                                .variant(ButtonVariant::Outline)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |this, cx| {
                                        this.suppress_captions = true;
                                        this.rebuild(cx);
                                    })
                                }),
                        ),
                );
            }
            CaptionsStatus::Skipped { description } => {
                body = body.child(
                    Alert::new("go-live-captions-skipped")
                        .variant(AlertVariant::Warning)
                        .title(copy::NO_CAPTIONS_THIS_TIME)
                        .description(description.clone()),
                );
            }
            CaptionsStatus::Row { good, description } => {
                body = body.child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.))
                        .child(
                            div()
                                .type_scale(text::LABEL)
                                .text_color(hsla(t.muted_foreground))
                                .child(copy::CAPTIONS),
                        )
                        .child(
                            Badge::new(if *good {
                                READY.to_string()
                            } else {
                                copy::CAPTIONS_NOT_READY.to_string()
                            })
                            .variant(if *good {
                                BadgeVariant::Success
                            } else {
                                BadgeVariant::Warning
                            }),
                        )
                        .child(
                            div()
                                .type_scale(text::META)
                                .text_color(hsla(t.muted_foreground))
                                .child(description.clone()),
                        ),
                );
            }
            CaptionsStatus::Hidden => {}
        }

        body = body.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .child(
                    div()
                        .type_scale(text::LABEL)
                        .text_color(hsla(t.muted_foreground))
                        .child(dest_copy::DESTINATIONS),
                )
                .children(self.view.summary.as_ref().map(|summary| {
                    Badge::new(summary.clone()).variant(if self.view.destinations_ready {
                        BadgeVariant::Success
                    } else {
                        BadgeVariant::Warning
                    })
                })),
        );

        if self.view.destinations.is_empty() && self.excluded.is_empty() {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(copy::NO_DESTINATION_ON),
            );
        } else {
            body = body.child(self.destination_rows(t, cx));
        }

        if !self.view.general_errors.is_empty() {
            body = body.child(
                Alert::new("go-live-fix")
                    .variant(AlertVariant::Destructive)
                    .title(copy::FIX_BEFORE_GOING_LIVE)
                    .description(self.view.general_errors.join("\n")),
            );
        }
        if !self.view.warnings.is_empty() {
            body = body.child(
                Alert::new("go-live-chat-limits")
                    .variant(AlertVariant::Warning)
                    .title(copy::CHAT_LIMITS)
                    .description(self.view.warnings.join("\n")),
            );
        }
        if let Some(partial) = &self.state.partial {
            let lines: Vec<String> = partial
                .failures
                .iter()
                .map(|f| {
                    copy::setup_failure(
                        platform_label(&f.platform),
                        &destination_label(&f.label),
                        &f.message,
                    )
                })
                .collect();
            body = body.child(
                Alert::new("go-live-partial")
                    .variant(AlertVariant::Warning)
                    .title(copy::SOME_COULDNT_BE_SET_UP)
                    .description(format!(
                        "{}\n{}",
                        lines.join("\n"),
                        copy::ready_list(&partial.ready_labels.join(", "))
                    )),
            );
        }

        let can_confirm = if self.state.partial.is_some() {
            !pending
                && self
                    .state
                    .partial
                    .as_ref()
                    .is_some_and(|p| !p.ready_labels.is_empty())
        } else {
            !pending && !self.gate_blocked
        };

        Dialog::new("go-live-dialog", &self.dialog, copy::GO_LIVE)
            .size(DialogSize::Xl)
            .description(copy::GO_LIVE_DESCRIPTION)
            .child(body)
            .footer(
                Button::new("go-live-cancel")
                    .label(CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .disabled(pending)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |this, _| this.cancel())
                    }),
            )
            .footer(
                Button::new("go-live-confirm")
                    .label(self.confirm_label.clone())
                    .variant(ButtonVariant::GoLive)
                    .disabled(!can_confirm)
                    .when(
                        !pending && self.gate_blocked && self.state.partial.is_none(),
                        |b| b.tooltip(copy::GO_LIVE_BLOCKED_REASON),
                    )
                    .on_click(move |_, _, cx| entity.update(cx, |this, _| this.confirm())),
            )
            .into_any_element()
    }
}
