//! Images ⇧⌘G: Backgrounds, Banners and Takeovers.

use std::sync::Arc;

use gpui::{Context, Entity, SharedString, WeakEntity, Window, div, prelude::*, px};
use serde_json::{Value, json};
use videorc_app_core::assets::{self, BannerImportKind, ImportPhase};
use videorc_app_core::nav::PageId;
use videorc_app_core::protocol::{Banner, StreamScreen};
use videorc_app_core::studio::StudioBackend;
use videorc_app_core::{BackendClient, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::input::{Input, InputState};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{radius, size, text};

use crate::app::shell::Shell;

pub type AppStudio = Studio<BackendClient>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoadState {
    Loading,
    Ready,
    Failed,
}

enum PendingDelete {
    Banner { id: String },
    Takeover { id: String, name: String },
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
    rename: DialogHandle,
    rename_banner: bool,
    rename_id: Option<String>,
    rename_input: Option<Entity<InputState>>,
    delete: DialogHandle,
    pending_delete: Option<PendingDelete>,
    shell: Option<WeakEntity<Shell>>,
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
            rename: DialogHandle::new(false),
            rename_banner: true,
            rename_id: None,
            rename_input: None,
            delete: DialogHandle::new(false),
            pending_delete: None,
            shell: None,
        };
        panel.rebuild(cx);
        panel.refresh(cx);
        panel
    }

    fn rename_input(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(input) = &self.rename_input {
            return input.clone();
        }
        let input = cx.new(|cx| InputState::new(window, cx));
        self.rename_input = Some(input.clone());
        input
    }

    pub fn bind_shell(&mut self, shell: WeakEntity<Shell>) {
        self.shell = Some(shell);
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

    fn banner_request(&self, method: &'static str, params: Value, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let _ = runtime
                .spawn(async move {
                    let _ = studio.backend().scene_request(method, params).await;
                })
                .await;
            let _ = this.update(cx, |panel, cx| panel.refresh(cx));
        })
        .detach();
    }

    fn screens_request(&self, method: &'static str, params: Value, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        cx.spawn(async move |this, cx| {
            let _ = runtime
                .spawn(async move {
                    let _ = studio.backend().sources_request(method, params).await;
                })
                .await;
            let _ = this.update(cx, |panel, cx| panel.refresh(cx));
        })
        .detach();
    }

    fn toggle_banner(&mut self, id: String, shown: bool, cx: &mut Context<Self>) {
        if shown {
            self.banner_request("banners.hide", json!({ "id": id }), cx);
        } else {
            self.banner_request("banners.show", json!({ "id": id }), cx);
        }
    }

    fn move_banner(&mut self, id: String, earlier: bool, cx: &mut Context<Self>) {
        let mut ids: Vec<String> = self.banners.iter().map(|b| b.id.clone()).collect();
        let Some(from) = ids.iter().position(|entry| entry == &id) else {
            return;
        };
        let to = if earlier {
            from.saturating_sub(1)
        } else {
            (from + 1).min(ids.len().saturating_sub(1))
        };
        if from == to {
            return;
        }
        ids.swap(from, to);
        self.banner_request("banners.reorder", json!({ "ids": ids }), cx);
    }

    fn move_takeover(&mut self, id: String, earlier: bool, cx: &mut Context<Self>) {
        let mut ids: Vec<String> = self.takeovers.iter().map(|s| s.id.clone()).collect();
        let Some(from) = ids.iter().position(|entry| entry == &id) else {
            return;
        };
        let to = if earlier {
            from.saturating_sub(1)
        } else {
            (from + 1).min(ids.len().saturating_sub(1))
        };
        if from == to {
            return;
        }
        ids.swap(from, to);
        self.screens_request("screens.reorder", json!({ "screenIds": ids }), cx);
    }

    fn open_rename_banner(&mut self, banner: &Banner, window: &mut Window, cx: &mut Context<Self>) {
        self.rename_banner = true;
        self.rename_id = Some(banner.id.clone());
        let input = self.rename_input(window, cx);
        input.update(cx, |input, cx| {
            input.set_value(banner.name.clone(), window, cx);
        });
        self.rename.open(window, cx);
    }

    fn open_rename_takeover(
        &mut self,
        screen: &StreamScreen,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.rename_banner = false;
        self.rename_id = Some(screen.id.clone());
        let input = self.rename_input(window, cx);
        input.update(cx, |input, cx| {
            input.set_value(screen.name.clone(), window, cx);
        });
        self.rename.open(window, cx);
    }

    fn save_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.rename_id.clone() else {
            return;
        };
        let Some(input) = self.rename_input.clone() else {
            return;
        };
        let name = input.read(cx).value().trim().to_string();
        if name.is_empty() {
            return;
        }
        let banner = self.rename_banner;
        self.rename.close(window, cx);
        self.rename_id = None;
        if banner {
            self.banner_request("banners.update", json!({ "id": id, "name": name }), cx);
        } else {
            self.screens_request(
                "screens.rename",
                json!({ "screenId": id, "name": name }),
                cx,
            );
        }
    }

    fn ask_delete_banner(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.pending_delete = Some(PendingDelete::Banner { id });
        self.delete.open(window, cx);
    }

    fn ask_delete_takeover(
        &mut self,
        id: String,
        name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending_delete = Some(PendingDelete::Takeover { id, name });
        self.delete.open(window, cx);
    }

    fn confirm_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pending) = self.pending_delete.take() else {
            return;
        };
        self.delete.close(window, cx);
        match pending {
            PendingDelete::Banner { id } => {
                self.banner_request("banners.delete", json!({ "id": id }), cx);
            }
            PendingDelete::Takeover { id, .. } => {
                self.screens_request("screens.delete", json!({ "screenId": id }), cx);
            }
        }
    }

    fn place_on_scene(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(shell) = self.shell.clone() {
            let _ = shell.update(cx, |shell, cx| {
                shell.open_page(PageId::Layouts, window, cx);
            });
        }
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

fn ghost_btn(
    id: impl Into<SharedString>,
    label: &'static str,
    disabled: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> Button {
    Button::new(id)
        .label(label)
        .size(ButtonSize::Xs)
        .variant(ButtonVariant::Ghost)
        .disabled(disabled)
        .on_click(on_click)
}

impl Render for ImagesPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let offline = !self.connected;
        let entity = cx.entity();
        let session_lock = self.session_active;

        let mut notices = div().flex().flex_col().gap(px(8.));
        if offline {
            notices = notices.child(
                Alert::new("images-offline")
                    .variant(AlertVariant::Locked)
                    .title(assets::OFFLINE_LOCK),
            );
        } else if session_lock {
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
                                    .rounded(px(radius::CHIP))
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
            for (index, banner) in self.banners.iter().enumerate() {
                let id = banner.id.clone();
                let shown = banner.shown;
                let first = index == 0;
                let last = index + 1 == self.banners.len();
                let mut row = ListRow::new(format!("banner-{}", banner.id), banner.name.clone())
                    .context(format!("{} × {}", banner.width, banner.height));
                if shown {
                    row = row.child(Badge::new(assets::SHOWING).variant(BadgeVariant::Success));
                }
                row = row.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(ghost_btn(
                            format!("banner-show-{id}"),
                            if shown { assets::HIDE } else { assets::SHOW },
                            offline,
                            {
                                let entity = entity.clone();
                                let id = id.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |panel, cx| {
                                        panel.toggle_banner(id.clone(), shown, cx)
                                    })
                                }
                            },
                        ))
                        .child(ghost_btn(
                            format!("banner-place-{id}"),
                            assets::PLACE_ON_SCENE,
                            offline,
                            {
                                let entity = entity.clone();
                                move |_, window, cx| {
                                    entity.update(cx, |panel, cx| panel.place_on_scene(window, cx))
                                }
                            },
                        ))
                        .child(ghost_btn(
                            format!("banner-rename-{id}"),
                            assets::RENAME_ELLIPSIS,
                            offline,
                            {
                                let entity = entity.clone();
                                let banner = banner.clone();
                                move |_, window, cx| {
                                    entity.update(cx, |panel, cx| {
                                        panel.open_rename_banner(&banner, window, cx)
                                    })
                                }
                            },
                        ))
                        .child(ghost_btn(
                            format!("banner-earlier-{id}"),
                            assets::MOVE_EARLIER,
                            offline || first,
                            {
                                let entity = entity.clone();
                                let id = id.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |panel, cx| {
                                        panel.move_banner(id.clone(), true, cx)
                                    })
                                }
                            },
                        ))
                        .child(ghost_btn(
                            format!("banner-later-{id}"),
                            assets::MOVE_LATER,
                            offline || last,
                            {
                                let entity = entity.clone();
                                let id = id.clone();
                                move |_, _, cx| {
                                    entity.update(cx, |panel, cx| {
                                        panel.move_banner(id.clone(), false, cx)
                                    })
                                }
                            },
                        ))
                        .child(ghost_btn(
                            format!("banner-delete-{id}"),
                            assets::DELETE_ELLIPSIS,
                            offline,
                            {
                                let entity = entity.clone();
                                let id = id.clone();
                                move |_, window, cx| {
                                    entity.update(cx, |panel, cx| {
                                        panel.ask_delete_banner(id.clone(), window, cx)
                                    })
                                }
                            },
                        )),
                );
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
            .last(true)
            .action(
                Button::new("takeover-import")
                    .label(assets::takeover_import_label(
                        false,
                        self.takeover_importing,
                    ))
                    .variant(ButtonVariant::Outline)
                    .disabled(offline || self.takeover_importing || session_lock),
            );
        if !self.takeovers.is_empty() {
            let mut list = GroupedList::new().label(assets::TAKEOVERS);
            for (index, screen) in self.takeovers.iter().enumerate() {
                let id = screen.id.clone();
                let name = screen.name.clone();
                let first = index == 0;
                let last = index + 1 == self.takeovers.len();
                let edit_locked = offline || session_lock;
                list = list.item(
                    ListRow::new(format!("takeover-{}", screen.id), screen.name.clone())
                        .context(format!("{}", screen.sort_order))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .child(ghost_btn(
                                    format!("takeover-rename-{id}"),
                                    assets::RENAME_ELLIPSIS,
                                    edit_locked,
                                    {
                                        let entity = entity.clone();
                                        let screen = screen.clone();
                                        move |_, window, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.open_rename_takeover(&screen, window, cx)
                                            })
                                        }
                                    },
                                ))
                                .child(ghost_btn(
                                    format!("takeover-earlier-{id}"),
                                    assets::MOVE_EARLIER,
                                    edit_locked || first,
                                    {
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        move |_, _, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.move_takeover(id.clone(), true, cx)
                                            })
                                        }
                                    },
                                ))
                                .child(ghost_btn(
                                    format!("takeover-later-{id}"),
                                    assets::MOVE_LATER,
                                    edit_locked || last,
                                    {
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        move |_, _, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.move_takeover(id.clone(), false, cx)
                                            })
                                        }
                                    },
                                ))
                                .child(ghost_btn(
                                    format!("takeover-delete-{id}"),
                                    assets::DELETE_TAKEOVER,
                                    edit_locked,
                                    {
                                        let entity = entity.clone();
                                        let id = id.clone();
                                        let name = name.clone();
                                        move |_, window, cx| {
                                            entity.update(cx, |panel, cx| {
                                                panel.ask_delete_takeover(
                                                    id.clone(),
                                                    name.clone(),
                                                    window,
                                                    cx,
                                                )
                                            })
                                        }
                                    },
                                )),
                        ),
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

        let rename_title = if self.rename_banner {
            assets::RENAME_ELLIPSIS
        } else {
            assets::TAKEOVER_NAME
        };
        let rename_input = self
            .rename_input
            .get_or_insert_with(|| cx.new(|cx| InputState::new(window, cx)))
            .clone();
        let rename_dialog = Dialog::new("images-rename", &self.rename, rename_title)
            .size(DialogSize::Sm)
            .child(
                Input::new("images-rename-name", &rename_input).accessibility_label(
                    if self.rename_banner {
                        "Banner name"
                    } else {
                        assets::TAKEOVER_NAME
                    },
                ),
            )
            .footer(
                Button::new("images-rename-cancel")
                    .label(assets::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |panel, cx| panel.rename.close(window, cx))
                        }
                    }),
            )
            .footer(
                Button::new("images-rename-save")
                    .label(if self.rename_banner {
                        videorc_app_core::soundboard::SAVE
                    } else {
                        assets::SAVE_TAKEOVER_NAME
                    })
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |panel, cx| panel.save_rename(window, cx))
                        }
                    }),
            );

        let (delete_title, delete_description) = match &self.pending_delete {
            Some(PendingDelete::Banner { .. }) => (assets::DELETE_BANNER_TITLE.to_string(), None),
            Some(PendingDelete::Takeover { name, .. }) => (
                format!(
                    "{}{name}{}",
                    assets::DELETE_TAKEOVER_PREFIX,
                    assets::DELETE_TAKEOVER_SUFFIX
                ),
                Some(assets::DELETE_TAKEOVER_DESCRIPTION),
            ),
            None => (assets::DELETE_BANNER_TITLE.to_string(), None),
        };
        let mut delete_dialog =
            Dialog::new("images-delete", &self.delete, delete_title).size(DialogSize::Sm);
        if let Some(description) = delete_description {
            delete_dialog = delete_dialog.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(description),
            );
        }
        delete_dialog = delete_dialog
            .footer(
                Button::new("images-delete-cancel")
                    .label(assets::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |panel, cx| {
                                panel.pending_delete = None;
                                panel.delete.close(window, cx);
                            })
                        }
                    }),
            )
            .footer(
                Button::new("images-delete-confirm")
                    .label(match &self.pending_delete {
                        Some(PendingDelete::Takeover { .. }) => assets::DELETE_TAKEOVER,
                        _ => assets::DELETE_BANNER,
                    })
                    .variant(ButtonVariant::Destructive)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |panel, cx| panel.confirm_delete(window, cx))
                        }
                    }),
            );

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
            .child(rename_dialog)
            .child(delete_dialog)
    }
}
