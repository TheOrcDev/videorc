//! Images ⇧⌘G: Backgrounds, Banners and Takeovers.

use std::sync::Arc;

use gpui::{Context, Window, div, prelude::*, px};
use serde_json::Value;
use videorc_app_core::assets::{self, BannerImportKind, ImportPhase};
use videorc_app_core::protocol::{Banner, StreamScreen};
use videorc_app_core::{BackendClient, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::empty::Empty;
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

pub type AppStudio = Studio<BackendClient>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoadState {
    Loading,
    Ready,
    Failed,
}

pub struct ImagesPanel {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    connected: bool,
    session_active: bool,
    banners: Vec<Banner>,
    banners_state: LoadState,
    takeovers: Vec<StreamScreen>,
    takeovers_state: LoadState,
    banner_import: ImportPhase,
    banner_kind: BannerImportKind,
    takeover_importing: bool,
    background_importing: bool,
    load_epoch: u64,
}

impl ImagesPanel {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let studio_watch = studio.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio_watch.watch();
            loop {
                if studio_rx.changed().await.is_err() {
                    break;
                }
                let _ = this.update(cx, |panel, cx| panel.rebuild(cx));
            }
        })
        .detach();
        let mut panel = Self {
            studio,
            runtime,
            connected: false,
            session_active: false,
            banners: Vec::new(),
            banners_state: LoadState::Loading,
            takeovers: Vec::new(),
            takeovers_state: LoadState::Loading,
            banner_import: ImportPhase::Idle,
            banner_kind: BannerImportKind::Image,
            takeover_importing: false,
            background_importing: false,
            load_epoch: 0,
        };
        panel.rebuild(cx);
        panel.refresh(cx);
        panel
    }

    fn rebuild(&mut self, cx: &mut Context<Self>) {
        let connected = self.studio.is_connected();
        let session_active = self.studio.snapshot().session.phase.is_active();
        let was = self.connected;
        if self.connected != connected || self.session_active != session_active {
            self.connected = connected;
            self.session_active = session_active;
            if connected && !was {
                self.refresh(cx);
            }
            if !connected {
                self.banners_state = LoadState::Loading;
                self.takeovers_state = LoadState::Loading;
            }
            cx.notify();
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.connected {
            return;
        }
        self.load_epoch = self.load_epoch.wrapping_add(1);
        let epoch = self.load_epoch;
        self.banners_state = LoadState::Loading;
        self.takeovers_state = LoadState::Loading;
        cx.notify();

        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let banners = runtime
                .spawn({
                    let studio = studio.clone();
                    async move {
                        match studio.banners().await {
                            Ok(value) => parse_banners(value),
                            Err(_) => None,
                        }
                    }
                })
                .await
                .ok()
                .flatten();
            let takeovers = runtime
                .spawn({
                    let studio = studio.clone();
                    async move { studio.backend().screens_list().await.ok() }
                })
                .await
                .ok()
                .flatten();
            let _ = this.update(cx, |panel, cx| {
                if panel.load_epoch != epoch {
                    return;
                }
                match banners {
                    Some(list) => {
                        panel.banners = list;
                        panel.banners_state = LoadState::Ready;
                    }
                    None => panel.banners_state = LoadState::Failed,
                }
                match takeovers {
                    Some(list) => {
                        panel.takeovers = list;
                        panel.takeovers_state = LoadState::Ready;
                    }
                    None => panel.takeovers_state = LoadState::Failed,
                }
                cx.notify();
            });
        })
        .detach();
    }
}

fn parse_banners(value: Value) -> Option<Vec<Banner>> {
    if let Ok(list) = serde_json::from_value::<Vec<Banner>>(value.clone()) {
        return Some(list);
    }
    value
        .get("banners")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
}

impl Render for ImagesPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let offline = !self.connected;
        let entity = cx.entity();

        let mut notices = div().flex().flex_col().gap(px(8.));
        if offline {
            notices = notices.child(
                Alert::new("images-offline")
                    .variant(AlertVariant::Locked)
                    .title(assets::OFFLINE_LOCK),
            );
        } else if self.session_active {
            notices = notices.child(
                Alert::new("images-takeover-quiet")
                    .variant(AlertVariant::Quiet)
                    .title(assets::QUIET_ALERT),
            );
        }

        let backgrounds = PanelSection::new("images-backgrounds")
            .title(assets::BACKGROUNDS)
            .description(assets::BACKGROUNDS_DESCRIPTION)
            .action(
                Button::new("images-import-bg")
                    .label(assets::background_import_label(self.background_importing))
                    .variant(ButtonVariant::Outline)
                    .disabled(offline || self.background_importing),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(SectionLabel::new(assets::LIVE_GROUP))
                    .child({
                        let mut grid = div().flex().flex_wrap().gap(px(8.));
                        for id in assets::live_backgrounds_offered() {
                            grid = grid.child(
                                div()
                                    .id(format!("live-bg-{id}"))
                                    .w(px(120.))
                                    .h(px(72.))
                                    .rounded(px(6.))
                                    .border_1()
                                    .border_color(hsla(t.border))
                                    .bg(hsla(t.muted))
                                    .flex()
                                    .items_end()
                                    .px(px(8.))
                                    .py(px(6.))
                                    .child(
                                        div()
                                            .type_scale(text::META)
                                            .text_color(hsla(t.foreground))
                                            .child(assets::live_background_name(id)),
                                    ),
                            );
                        }
                        grid
                    })
                    .child(SectionLabel::new(assets::IMAGES_GROUP))
                    .child(
                        Empty::new()
                            .title(assets::ADD_IMAGE)
                            .description("Import a PNG, JPEG or WebP for your scenes."),
                    ),
            );

        let banner_reason =
            assets::banner_import_blocked_reason(offline, self.banner_import, self.banners.len());
        let banner_actions = div()
            .flex()
            .gap(px(8.))
            .child(
                Button::new("banner-import-image")
                    .label(assets::banner_import_label(
                        self.banner_import,
                        BannerImportKind::Image,
                        self.banner_kind,
                    ))
                    .variant(ButtonVariant::Outline)
                    .disabled(banner_reason.is_some()),
            )
            .child(
                Button::new("banner-import-html")
                    .label(assets::banner_import_label(
                        self.banner_import,
                        BannerImportKind::Html,
                        self.banner_kind,
                    ))
                    .variant(ButtonVariant::Outline)
                    .disabled(banner_reason.is_some()),
            );

        let mut banners_section = PanelSection::new("images-banners")
            .title(assets::BANNERS)
            .description(assets::BANNERS_DESCRIPTION)
            .action(banner_actions);
        if offline {
            // Alert already shown above.
        } else if !self.banners.is_empty() {
            let mut list = GroupedList::new().label(assets::BANNERS);
            for banner in &self.banners {
                let mut row = ListRow::new(format!("banner-{}", banner.id), banner.name.clone())
                    .context(format!("{} × {}", banner.width, banner.height));
                if banner.shown {
                    row = row.child(Badge::new(assets::SHOWING).variant(BadgeVariant::Success));
                }
                list = list.item(row);
            }
            banners_section = banners_section.child(list);
        } else {
            match self.banners_state {
                LoadState::Loading => {
                    banners_section =
                        banners_section.child(Empty::new().title(assets::LOADING_BANNERS));
                }
                LoadState::Failed => {
                    banners_section = banners_section.child(
                        Empty::new().title(assets::LOADING_BANNERS).child(
                            Button::new("banners-retry")
                                .label(videorc_app_core::soundboard::RETRY)
                                .variant(ButtonVariant::Outline)
                                .on_click({
                                    let entity = entity.clone();
                                    move |_, _, cx| entity.update(cx, |panel, cx| panel.refresh(cx))
                                }),
                        ),
                    );
                }
                LoadState::Ready => {
                    banners_section = banners_section.child(
                        Empty::new().title(assets::NO_BANNERS).child(
                            Button::new("banner-import-empty")
                                .label(assets::IMPORT_IMAGE)
                                .variant(ButtonVariant::Outline)
                                .disabled(banner_reason.is_some()),
                        ),
                    );
                }
            }
        }

        let mut takeovers_section = PanelSection::new("images-takeovers")
            .title(assets::TAKEOVERS)
            .description(assets::TAKEOVERS_DESCRIPTION)
            .last()
            .action(
                Button::new("takeover-import")
                    .label(assets::takeover_import_label(
                        false,
                        self.takeover_importing,
                    ))
                    .variant(ButtonVariant::Outline)
                    .disabled(offline || self.takeover_importing || self.session_active),
            );
        if !self.takeovers.is_empty() {
            let mut list = GroupedList::new().label(assets::TAKEOVERS);
            for screen in &self.takeovers {
                list = list.item(
                    ListRow::new(format!("takeover-{}", screen.id), screen.name.clone())
                        .context(format!("{}", screen.sort_order)),
                );
            }
            takeovers_section = takeovers_section.child(list);
        } else {
            match self.takeovers_state {
                LoadState::Loading if !offline => {
                    takeovers_section =
                        takeovers_section.child(Empty::new().title(assets::LOADING_TAKEOVERS));
                }
                LoadState::Ready => {
                    takeovers_section = takeovers_section.child(
                        Empty::new()
                            .title(assets::NO_TAKEOVERS)
                            .description(assets::NO_TAKEOVERS_HINT),
                    );
                }
                _ => {}
            }
        }

        div()
            .id("images-page")
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .type_scale(text::META)
            .child(
                ScrollArea::new("images-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .px(px(size::GUTTER))
                        .py(px(8.))
                        .gap(px(16.))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(
                                    div()
                                        .type_scale(text::SECTION)
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .child(assets::TITLE),
                                )
                                .child(
                                    div()
                                        .type_scale(text::META)
                                        .text_color(hsla(t.muted_foreground))
                                        .child(assets::DESCRIPTION),
                                ),
                        )
                        .child(notices)
                        .child(backgrounds)
                        .child(banners_section)
                        .child(takeovers_section),
                ),
            )
    }
}
