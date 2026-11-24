//! Destinations ⌘6 (plan 260 Phase 3, L4): Setup from
//! `videorc_app_core::livestream::setup`, Upcoming and Discord as stubs until
//! their slices land. Words from `livestream::copy`.

use std::sync::Arc;

use gpui::{Context, Window, div, prelude::*, px};
use serde_json::json;
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::setup::{
    self as setup, DestinationView, PageMemory, SetupInput, SetupView, Tone,
};
use videorc_app_core::livestream::targets::TargetPatch;
use videorc_app_core::{BackendClient, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::switch::Switch;
use videorc_kit::tabs::Tabs;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

pub type AppStudio = Studio<BackendClient>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DestinationsTab {
    Setup,
    Upcoming,
    Discord,
}

impl DestinationsTab {
    fn index(self) -> usize {
        match self {
            Self::Setup => 0,
            Self::Upcoming => 1,
            Self::Discord => 2,
        }
    }

    fn from_index(index: usize) -> Self {
        match index {
            1 => Self::Upcoming,
            2 => Self::Discord,
            _ => Self::Setup,
        }
    }
}

fn badge_variant(tone: Tone) -> BadgeVariant {
    match tone {
        Tone::Success => BadgeVariant::Success,
        Tone::Warning => BadgeVariant::Warning,
        Tone::Destructive => BadgeVariant::Destructive,
        Tone::Live => BadgeVariant::Live,
        Tone::Outline => BadgeVariant::Outline,
    }
}

pub struct DestinationsPanel {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    tab: DestinationsTab,
    memory: PageMemory,
    setup: SetupView,
}

impl DestinationsPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let setup = Self::build_setup(&studio, &PageMemory::default());
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio_watch.watch();
            let mut platforms_rx = studio_watch.platforms();
            let mut telemetry_rx = studio_watch.telemetry();
            let mut go_live_rx = studio_watch.go_live();
            loop {
                tokio::select! {
                    changed = studio_rx.changed() => if changed.is_err() { break },
                    changed = platforms_rx.changed() => if changed.is_err() { break },
                    changed = telemetry_rx.changed() => if changed.is_err() { break },
                    changed = go_live_rx.changed() => if changed.is_err() { break },
                }
                let _ = this.update(cx, |panel, cx| {
                    panel.rebuild(cx);
                });
            }
        })
        .detach();
        Self {
            studio,
            runtime,
            tab: DestinationsTab::Setup,
            memory: PageMemory::default(),
            setup,
        }
    }

    fn build_setup(studio: &AppStudio, memory: &PageMemory) -> SetupView {
        let snapshot = studio.snapshot();
        let platforms = studio.platforms_now();
        let telemetry = studio.telemetry_now();
        let runtimes = setup::Runtime::read(&telemetry.stream_targets);
        let go_live = studio.go_live_now();
        setup::setup_view(
            &SetupInput {
                capture: &snapshot.settings.capture_doc,
                platforms: &platforms,
                runtimes: &runtimes,
                entitlements: None,
                session_active: snapshot.session.phase.is_active(),
                go_live_pending: go_live.open || go_live.pending,
                development: cfg!(debug_assertions),
            },
            memory,
        )
    }

    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let next = Self::build_setup(&self.studio, &self.memory);
        if self.setup != next {
            self.setup = next;
            cx.notify();
        }
    }

    fn set_tab(&mut self, tab: DestinationsTab, cx: &mut Context<Self>) {
        if self.tab != tab {
            self.tab = tab;
            cx.notify();
        }
    }

    fn toggle_expanded(&mut self, id: String, cx: &mut Context<Self>) {
        let open = !self
            .setup
            .destinations
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.expanded)
            .unwrap_or(false);
        self.memory.expanded.insert(id, open);
        self.rebuild(cx);
    }

    fn set_enabled(&mut self, id: String, enabled: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .patch_stream_target(&id, TargetPatch::default().set("enabled", json!(enabled)))
                .await;
        });
        self.rebuild(cx);
    }

    fn dismiss_failure(&mut self, key: String, cx: &mut Context<Self>) {
        self.memory.dismissed_problems = Some(key);
        self.rebuild(cx);
    }

    fn use_instant(&mut self, target_id: String, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            studio
                .patch_stream_target(
                    &target_id,
                    TargetPatch::default().set("scheduledEventId", json!(null)),
                )
                .await;
        });
        self.rebuild(cx);
    }

    fn destination_card(
        &self,
        dest: &DestinationView,
        t: &videorc_kit::tokens::Theme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let id = dest.id.clone();
        let enabled = dest.enabled;
        let switch_enabled = dest.switch_enabled && !dest.disabled;
        let entity = cx.entity();
        let mut trailing = div().flex().items_center().gap(px(8.));
        if let Some((tone, label)) = &dest.badge {
            trailing = trailing.child(Badge::new(label.clone()).variant(badge_variant(*tone)));
        }
        if dest.falling_behind {
            trailing = trailing
                .child(Badge::new(page_copy::FALLING_BEHIND).variant(BadgeVariant::Warning));
        }
        if let Some(tag) = &dest.quality_tag {
            trailing = trailing.child(Badge::new(tag.clone()).variant(BadgeVariant::Outline));
        }
        trailing = trailing
            .child(
                Switch::new(format!("dest-enable-{}", dest.id))
                    .accessibility_label(dest.switch_label.clone())
                    .checked(enabled)
                    .disabled(!switch_enabled)
                    .on_change({
                        let entity = entity.clone();
                        let id = id.clone();
                        move |value, _, cx| {
                            entity.update(cx, |this, cx| this.set_enabled(id.clone(), value, cx))
                        }
                    }),
            )
            .child(icon(
                if dest.expanded {
                    IconName::CaretDown
                } else {
                    IconName::CaretRight
                },
                12.0,
                hsla(t.muted_foreground),
            ));

        let mut card = div().child(
            ListRow::new(format!("dest-{}", dest.id), dest.label.clone())
                .context(dest.context.clone())
                .interactive(true)
                .child(trailing)
                .on_click({
                    let entity = entity.clone();
                    let id = id.clone();
                    move |_, _, cx| {
                        entity.update(cx, |this, cx| this.toggle_expanded(id.clone(), cx))
                    }
                }),
        );

        let mut detail = div().flex().flex_col().gap(px(4.)).px(px(12.)).pb(px(8.));
        let mut has_detail = false;
        if let Some(message) = &dest.status_message {
            has_detail = true;
            detail = detail.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(message.clone()),
            );
        }
        if let Some(line) = &dest.uplink_line {
            has_detail = true;
            detail = detail.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.warning))
                    .child(line.clone()),
            );
        }
        if !dest.switch_reason.is_empty() && !dest.switch_enabled {
            has_detail = true;
            detail = detail.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(dest.switch_reason.clone()),
            );
        }
        if dest.expanded {
            has_detail = true;
            if let Some(reason) = &dest.lock_reason {
                detail = detail.child(
                    Alert::new(format!("dest-lock-{}", dest.id))
                        .variant(AlertVariant::Warning)
                        .title(reason.clone()),
                );
            }
            if let Some(line) = &dest.key_only_line {
                detail = detail.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(line.clone()),
                );
            }
            if let Some((guidance, link)) = &dest.guidance {
                detail = detail.child(
                    div()
                        .type_scale(text::META)
                        .text_color(hsla(t.muted_foreground))
                        .child(guidance.clone()),
                );
                if let Some(link) = link {
                    let url = link.url.clone();
                    detail = detail.child(
                        Button::new(format!("dest-guide-{}", dest.id))
                            .label(link.label.clone())
                            .variant(ButtonVariant::Ghost)
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    );
                }
            }
            if let Some(oauth) = &dest.oauth {
                match oauth {
                    setup::OAuthView::Account(account) => {
                        detail = detail.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    Badge::new(page_copy::CONNECTED).variant(BadgeVariant::Success),
                                )
                                .child(div().type_scale(text::META).child(account.label.clone())),
                        );
                        if !account.handle.is_empty() {
                            detail = detail.child(
                                div()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(account.handle.clone()),
                            );
                        }
                    }
                    setup::OAuthView::SignIn {
                        connect_label,
                        connect_enabled,
                        pending,
                        ..
                    } => {
                        if let Some(pending) = pending {
                            detail = detail.child(
                                div()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(if pending.has_url {
                                        page_copy::WAITING_FOR_BROWSER.to_string()
                                    } else {
                                        pending.other_browser.clone()
                                    }),
                            );
                        } else {
                            detail = detail.child(
                                Button::new(format!("dest-connect-{}", dest.id))
                                    .label(connect_label.clone())
                                    .variant(ButtonVariant::Outline)
                                    .disabled(!*connect_enabled || dest.disabled),
                            );
                        }
                    }
                }
            }
        }
        if has_detail {
            card = card.child(detail);
        }
        card
    }
}

impl Render for DestinationsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let tabs = Tabs::new("destinations-views")
            .tab(page_copy::VIEW_SETUP)
            .tab(page_copy::VIEW_UPCOMING)
            .tab(page_copy::VIEW_DISCORD)
            .selected(self.tab.index())
            .on_select(move |index, _, cx| {
                entity.update(cx, |this, cx| {
                    this.set_tab(DestinationsTab::from_index(index), cx)
                });
            });

        let body = match self.tab {
            DestinationsTab::Setup => {
                let setup = self.setup.clone();
                let mut notices = div().flex().flex_col().gap(px(8.));
                if let Some((reason, action)) = &setup.notices.entitlement {
                    let mut alert = Alert::new("dest-entitlement")
                        .variant(AlertVariant::Locked)
                        .title(reason.clone());
                    if action.as_deref() == Some(page_copy::VIEW_PREMIUM) {
                        alert = alert.action(
                            Button::new("view-premium")
                                .label(page_copy::VIEW_PREMIUM)
                                .variant(ButtonVariant::Outline)
                                .on_click(|_, _, cx| cx.open_url("https://videorc.com/account")),
                        );
                    }
                    notices = notices.child(alert);
                }
                if let Some(lock) = &setup.notices.session_lock {
                    notices = notices.child(
                        Alert::new("dest-session-lock")
                            .variant(AlertVariant::Locked)
                            .title(lock.clone()),
                    );
                }
                if let Some(failure) = &setup.notices.failure {
                    let key = failure.key.clone();
                    let entity = cx.entity();
                    notices = notices.child(
                        Alert::new("dest-failure")
                            .variant(AlertVariant::Destructive)
                            .title(page_copy::FAILURE_TITLE)
                            .description(failure.lines.join("\n"))
                            .action(
                                Button::new("dest-continue")
                                    .label(page_copy::CONTINUE_STREAMING)
                                    .variant(ButtonVariant::Outline)
                                    .on_click(move |_, _, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.dismiss_failure(key.clone(), cx)
                                        })
                                    }),
                            ),
                    );
                }
                for (target_id, line) in &setup.notices.scheduled {
                    let id = target_id.clone();
                    let entity = cx.entity();
                    let mut alert = Alert::new(format!("dest-scheduled-{target_id}"))
                        .variant(AlertVariant::Warning)
                        .title(line.clone());
                    if setup.notices.scheduled_enabled {
                        alert = alert.action(
                            Button::new(format!("instant-{target_id}"))
                                .label(page_copy::USE_INSTANT_BROADCAST)
                                .variant(ButtonVariant::Outline)
                                .on_click(move |_, _, cx| {
                                    entity.update(cx, |this, cx| this.use_instant(id.clone(), cx))
                                }),
                        );
                    }
                    notices = notices.child(alert);
                }
                if let Some(cap) = &setup.cap_notice {
                    notices = notices.child(
                        Alert::new("dest-cap")
                            .variant(AlertVariant::Warning)
                            .title(cap.clone()),
                    );
                }

                let mut list = GroupedList::new();
                for dest in &setup.destinations {
                    list = list.item(self.destination_card(dest, t, cx));
                }

                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(notices)
                    .child(
                        PanelSection::new("destinations-list")
                            .title(page_copy::DESTINATIONS)
                            .description(setup.destinations_description.clone())
                            .last(true)
                            .child(list),
                    )
                    .into_any_element()
            }
            DestinationsTab::Upcoming => div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child("Loading upcoming streams…")
                .into_any_element(),
            DestinationsTab::Discord => div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(page_copy::LOADING_DISCORD)
                .into_any_element(),
        };

        div()
            .id("destinations-page")
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .type_scale(text::META)
            .child(
                ScrollArea::new("destinations-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .px(px(size::GUTTER))
                        .py(px(8.))
                        .gap(px(8.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .type_scale(text::LABEL)
                                        .text_color(hsla(t.muted_foreground))
                                        .child(page_copy::VIEWS_LABEL),
                                )
                                .child(tabs),
                        )
                        .child(body),
                ),
            )
    }
}
