//! Images ⇧⌘G: Backgrounds, Banners and Takeovers.

use std::path::Path;
use std::sync::Arc;

use gpui::{
    Context, Entity, ImageSource, ObjectFit, PathPromptOptions, SharedString, WeakEntity, Window,
    div, img, linear_color_stop, linear_gradient, prelude::*, px,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::watch;
use videorc_app_core::assets::{self, BannerImportKind, ImportPhase};
use videorc_app_core::nav::PageId;
use videorc_app_core::protocol::{Banner, StreamScreen};
use videorc_app_core::resources::{
    capability::{IssueOptions, ResourceKind},
    issue_capability,
};
use videorc_app_core::scenes::background::{BUNDLED_BACKGROUNDS, bundled_background_name};
use videorc_app_core::studio::StudioBackend;
use videorc_app_core::{BackendClient, BackendState, Studio};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::dialog::{Dialog, DialogHandle, DialogSize};
use videorc_kit::empty::Empty;
use videorc_kit::icon::{IconName, icon};
use videorc_kit::input::{Input, InputState};
use videorc_kit::kebab_menu::{KEBAB_HOST, KebabMenu, KebabMenuItem, KebabReveal};
use videorc_kit::list_row::{GroupedList, GroupedRow, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::scroll_area::ScrollArea;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::spinner::Spinner;
use videorc_kit::theme::{self, FONT, TypeScale, hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius, size, text};

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

/// A background the Images page imported this session (`backgrounds.import`).
#[derive(Debug, Clone)]
struct ImportedBackground {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundImportAnswer {
    id: String,
}

pub struct ImagesPanel {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    backend: watch::Receiver<BackendState>,
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
    backgrounds: Vec<ImportedBackground>,
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
        backend: watch::Receiver<BackendState>,
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
            backend,
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
            backgrounds: Vec::new(),
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

    fn import_banner(&mut self, kind: BannerImportKind, cx: &mut Context<Self>) {
        if self.banner_import != ImportPhase::Idle
            || assets::banner_import_blocked_reason(false, ImportPhase::Idle, self.banners.len())
                .is_some()
        {
            return;
        }
        self.banner_kind = kind;
        self.banner_import = ImportPhase::Choosing;
        cx.notify();
        let html = kind == BannerImportKind::Html;
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            // Folder HTML overlays need `input-directory` (not in app-core yet);
            // a single .html file still imports.
            directories: false,
            multiple: false,
            prompt: Some(
                if html {
                    assets::IMPORT_HTML
                } else {
                    assets::IMPORT_IMAGE
                }
                .into(),
            ),
        });
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let backend = self.backend.clone();
        let method = if html {
            "banners.importHtml"
        } else {
            "banners.importImage"
        };
        cx.spawn(async move |this, cx| {
            let path = match picked.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                _ => None,
            };
            let Some(path) = path else {
                let _ = this.update(cx, |panel, cx| {
                    panel.banner_import = ImportPhase::Idle;
                    cx.notify();
                });
                return;
            };
            let _ = this.update(cx, |panel, cx| {
                panel.banner_import = ImportPhase::Importing;
                cx.notify();
            });
            let job = runtime.spawn(async move {
                let bootstrap = backend
                    .borrow()
                    .bootstrap()
                    .cloned()
                    .ok_or_else(|| "Videorc is reconnecting.".to_string())?;
                let (_, issued) = issue_capability(
                    &bootstrap,
                    &path,
                    ResourceKind::InputFile,
                    IssueOptions::default(),
                )
                .await?;
                let _ = studio
                    .backend()
                    .scene_request(method, json!({ "sourceCapability": issued.capability_id }))
                    .await
                    .map_err(|error| error.message)?;
                Ok::<(), String>(())
            });
            let _ = job.await;
            let _ = this.update(cx, |panel, cx| {
                panel.banner_import = ImportPhase::Idle;
                panel.refresh(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn import_takeovers(&mut self, cx: &mut Context<Self>) {
        if self.takeover_importing || !self.connected || self.session_active {
            return;
        }
        self.takeover_importing = true;
        cx.notify();
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some(assets::IMPORT_IMAGES.into()),
        });
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let backend = self.backend.clone();
        cx.spawn(async move |this, cx| {
            let paths = match picked.await {
                Ok(Ok(Some(paths))) if !paths.is_empty() => paths,
                _ => {
                    let _ = this.update(cx, |panel, cx| {
                        panel.takeover_importing = false;
                        cx.notify();
                    });
                    return;
                }
            };
            let job = runtime.spawn(async move {
                let bootstrap = backend
                    .borrow()
                    .bootstrap()
                    .cloned()
                    .ok_or_else(|| "Videorc is reconnecting.".to_string())?;
                for path in paths {
                    let (_, issued) = issue_capability(
                        &bootstrap,
                        &path,
                        ResourceKind::InputFile,
                        IssueOptions::default(),
                    )
                    .await?;
                    let _ = studio
                        .backend()
                        .sources_request(
                            "screens.importImage",
                            json!({ "sourceCapability": issued.capability_id }),
                        )
                        .await
                        .map_err(|error| error.message)?;
                }
                Ok::<(), String>(())
            });
            let _ = job.await;
            let _ = this.update(cx, |panel, cx| {
                panel.takeover_importing = false;
                panel.refresh(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn import_background(&mut self, cx: &mut Context<Self>) {
        if self.background_importing || !self.connected {
            return;
        }
        self.background_importing = true;
        cx.notify();
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(assets::IMPORT_IMAGE.into()),
        });
        let studio = self.studio.clone();
        let runtime = self.runtime.clone();
        let backend = self.backend.clone();
        cx.spawn(async move |this, cx| {
            let path = match picked.await {
                Ok(Ok(Some(paths))) => paths.into_iter().next(),
                _ => None,
            };
            let Some(path) = path else {
                let _ = this.update(cx, |panel, cx| {
                    panel.background_importing = false;
                    cx.notify();
                });
                return;
            };
            let name = background_name_from_path(&path);
            let job = runtime.spawn(async move {
                let bootstrap = backend
                    .borrow()
                    .bootstrap()
                    .cloned()
                    .ok_or_else(|| "Videorc is reconnecting.".to_string())?;
                let (_, issued) = issue_capability(
                    &bootstrap,
                    &path,
                    ResourceKind::InputFile,
                    IssueOptions::default(),
                )
                .await?;
                let value = studio
                    .backend()
                    .sources_request(
                        "backgrounds.import",
                        json!({ "sourceCapability": issued.capability_id }),
                    )
                    .await
                    .map_err(|error| error.message)?;
                let imported: BackgroundImportAnswer =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                Ok::<ImportedBackground, String>(ImportedBackground {
                    id: imported.id,
                    name,
                })
            });
            let result = job.await;
            let _ = this.update(cx, |panel, cx| {
                panel.background_importing = false;
                if let Ok(Ok(imported)) = result {
                    if !panel.backgrounds.iter().any(|row| row.id == imported.id) {
                        panel.backgrounds.push(imported);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
}

fn background_name_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("Background")
        .to_string()
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
    Button::new(id.into())
        .label(label)
        .size(ButtonSize::Xs)
        .variant(ButtonVariant::Ghost)
        .disabled(disabled)
        .on_click(on_click)
}

/// A Gallery picture tile (`PresetTile`, `LiveBackgroundTile`): a 16:9
/// frame on a hairline (`rounded-row border`, `hover:border-foreground/30`)
/// with its name strip along the bottom (`px-2 pt-5 pb-1`, the name at
/// text-xs medium) and, for a live background, its outline Live tag.
fn picture_tile(
    id: SharedString,
    name: SharedString,
    live: bool,
    picture: Option<ImageSource>,
    t: &Theme,
) -> gpui::Stateful<gpui::Div> {
    // Over a picture the strip fades up from the background
    // (`bg-gradient-to-t from-background/95 to-transparent`), so the name
    // reads on any picture.
    let pictured = picture.is_some();
    let fade = linear_gradient(
        0.,
        linear_color_stop(hsla(with_alpha(t.background, 0.95)), 0.),
        linear_color_stop(hsla(with_alpha(t.background, 0.)), 1.),
    );
    div()
        .id(id)
        .relative()
        .w_full()
        .min_w(px(0.))
        .aspect_ratio(16. / 9.)
        .flex()
        .items_end()
        .overflow_hidden()
        .rounded(px(radius::ROW))
        .border_1()
        .border_color(hsla(t.border))
        .hover(|style| style.border_color(hsla(with_alpha(t.foreground, 0.3))))
        .bg(hsla(t.muted))
        // The picture fills the frame (`object-cover`) under the strip.
        .children(picture.map(|picture| {
            img(picture)
                .absolute()
                .inset_0()
                .size_full()
                .object_fit(ObjectFit::Cover)
        }))
        .child(
            div()
                .relative()
                .w_full()
                .min_w(px(0.))
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(8.))
                .pt(px(20.))
                .pb(px(4.))
                .when(pictured, |strip| strip.bg(fade))
                .child(
                    div()
                        .min_w(px(0.))
                        .truncate()
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hsla(t.foreground))
                        .child(name),
                )
                .when(live, |strip| {
                    strip.child(
                        div()
                            .flex_none()
                            .child(Badge::new(assets::LIVE_BADGE).variant(BadgeVariant::Outline)),
                    )
                }),
        )
}

/// `Gallery rowsOfFive`: five 16:9 tiles a row, `gap-3`.
fn gallery() -> gpui::Div {
    div().grid().grid_cols(5).gap(px(12.))
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

        let bg_importing = self.background_importing;
        let bg_import_btn = |id: &'static str| {
            let entity = entity.clone();
            Button::new(id)
                .variant(ButtonVariant::Outline)
                .disabled(offline || bg_importing)
                .child(if bg_importing {
                    Spinner::new(SharedString::from(format!("{id}-spinner")))
                        .size(16.)
                        .into_any_element()
                } else {
                    icon(IconName::ImageSquare, 16., hsla(t.foreground)).into_any_element()
                })
                .child(assets::background_import_label(bg_importing))
                .on_click(move |_, _, cx| {
                    entity.update(cx, |panel, cx| panel.import_background(cx));
                })
        };
        // The presets Videorc ships (`BUNDLED_BACKGROUND_MANIFEST`, from
        // `videorc_app_core::bundled`), then the pictures imported here.
        let bundled = &videorc_app_core::bundled::current().backgrounds;
        let presets: Vec<(&str, &str, std::path::PathBuf)> = BUNDLED_BACKGROUNDS
            .iter()
            .filter_map(|(id, file)| {
                let path = bundled.join(file);
                let name = bundled_background_name(id)?;
                path.is_file().then_some((*id, name, path))
            })
            .collect();
        let image_tiles = if presets.is_empty() && self.backgrounds.is_empty() {
            Empty::new()
                .title(assets::ADD_IMAGE)
                .description("Import a PNG, JPEG or WebP for your scenes.")
                .child(bg_import_btn("images-import-bg-empty"))
                .into_any_element()
        } else {
            let mut grid = gallery();
            for (id, name, path) in presets {
                grid = grid.child(picture_tile(
                    SharedString::from(format!("bg-asset-{id}")),
                    SharedString::from(name),
                    false,
                    Some(ImageSource::from(path)),
                    t,
                ));
            }
            for row in &self.backgrounds {
                grid = grid.child(picture_tile(
                    SharedString::from(format!("bg-asset-{}", row.id)),
                    SharedString::from(row.name.clone()),
                    false,
                    None,
                    t,
                ));
            }
            grid.into_any_element()
        };
        // Backgrounds: the Live group, then the Images group, each a label
        // over its gallery (`flex flex-col gap-2`).
        let mut live_grid = gallery();
        for id in assets::live_backgrounds_offered() {
            // The default look's thumbnail (`liveBackgroundThumbnail`), the
            // same embedded still first-run shows.
            live_grid = live_grid.child(picture_tile(
                SharedString::from(format!("live-bg-{id}")),
                SharedString::from(assets::live_background_name(id)),
                true,
                crate::screens::first_run::pictures::live_thumb(id).map(ImageSource::from),
                t,
            ));
        }
        let backgrounds = PanelSection::new("images-backgrounds")
            .icon(icon(IconName::ImageSquare, 16., hsla(t.muted_foreground)))
            .title(assets::BACKGROUNDS)
            .description(assets::BACKGROUNDS_DESCRIPTION)
            .action(bg_import_btn("images-import-bg"))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(SectionLabel::new(assets::LIVE_GROUP))
                    .child(live_grid),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(SectionLabel::new(assets::IMAGES_GROUP))
                    .child(image_tiles),
            );

        let banner_reason =
            assets::banner_import_blocked_reason(offline, self.banner_import, self.banners.len());
        // Import image… and Import HTML…, side by side (plan 232): each
        // wears its mark, or a spinner while its import runs.
        let banner_import = |id: &'static str, kind: BannerImportKind| {
            let entity = entity.clone();
            let reason = banner_reason;
            let running = self.banner_import != ImportPhase::Idle && self.banner_kind == kind;
            // Electron's CodeIcon leads Import HTML…
            let glyph = if running {
                Some(
                    Spinner::new(SharedString::from(format!("{id}-spinner")))
                        .size(16.)
                        .into_any_element(),
                )
            } else if kind == BannerImportKind::Image {
                Some(icon(IconName::ImageSquare, 16., hsla(t.foreground)).into_any_element())
            } else {
                Some(icon(IconName::Code, 16., hsla(t.foreground)).into_any_element())
            };
            let mut button = Button::new(id)
                .variant(ButtonVariant::Outline)
                .disabled(reason.is_some())
                .children(glyph)
                .child(assets::banner_import_label(
                    self.banner_import,
                    kind,
                    self.banner_kind,
                ));
            if let Some(reason) = reason {
                button = button.tooltip(reason);
            }
            button.on_click(move |_, _, cx| {
                if reason.is_none() {
                    entity.update(cx, |panel, cx| panel.import_banner(kind, cx));
                }
            })
        };
        let banner_actions = div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(8.))
            .child(banner_import(
                "banner-import-image",
                BannerImportKind::Image,
            ))
            .child(banner_import("banner-import-html", BannerImportKind::Html));

        let mut banners_section = PanelSection::new("images-banners")
            .icon(icon(IconName::ImageSquare, 16., hsla(t.muted_foreground)))
            .title(assets::BANNERS)
            .description(assets::BANNERS_DESCRIPTION)
            .action(banner_actions);
        if offline {
            // Alert already shown above.
        } else if !self.banners.is_empty() {
            let shown_count = self.banners.iter().filter(|banner| banner.shown).count();
            // Electron names the list for assistive tech only.
            let mut list = GroupedList::new();
            for (index, banner) in self.banners.iter().enumerate() {
                let id = banner.id.clone();
                let shown = banner.shown;
                let first = index == 0;
                let last = index + 1 == self.banners.len();
                let show_blocked = !shown && shown_count >= assets::BANNER_MAX_SHOWN;

                // `BannerTile`'s menu: Show or Hide and Place on Scene, then
                // Rename…, then the order, then Delete….
                let mut show =
                    KebabMenuItem::new("show", if shown { assets::HIDE } else { assets::SHOW }, {
                        let entity = entity.clone();
                        let id = id.clone();
                        move |_, cx| {
                            entity
                                .update(cx, |panel, cx| panel.toggle_banner(id.clone(), shown, cx))
                        }
                    })
                    .group("use");
                if show_blocked {
                    show = show
                        .disabled(true)
                        .disabled_reason(assets::BANNER_SHOWN_LIMIT_REASON);
                }
                let place = KebabMenuItem::new("place", assets::PLACE_ON_SCENE, {
                    let entity = entity.clone();
                    move |window, cx| {
                        entity.update(cx, |panel, cx| panel.place_on_scene(window, cx))
                    }
                })
                .group("use");
                let rename = KebabMenuItem::new("rename", assets::RENAME_ELLIPSIS, {
                    let entity = entity.clone();
                    let banner = banner.clone();
                    move |window, cx| {
                        entity.update(cx, |panel, cx| {
                            panel.open_rename_banner(&banner, window, cx)
                        })
                    }
                })
                .group("edit");
                let mut earlier = KebabMenuItem::new("move-earlier", assets::MOVE_EARLIER, {
                    let entity = entity.clone();
                    let id = id.clone();
                    move |_, cx| {
                        entity.update(cx, |panel, cx| panel.move_banner(id.clone(), true, cx))
                    }
                })
                .group("order");
                if first {
                    earlier = earlier
                        .disabled(true)
                        .disabled_reason(assets::BANNER_ALREADY_FIRST);
                }
                let mut later = KebabMenuItem::new("move-later", assets::MOVE_LATER, {
                    let entity = entity.clone();
                    let id = id.clone();
                    move |_, cx| {
                        entity.update(cx, |panel, cx| panel.move_banner(id.clone(), false, cx))
                    }
                })
                .group("order");
                if last {
                    later = later
                        .disabled(true)
                        .disabled_reason(assets::BANNER_ALREADY_LAST);
                }
                let delete = KebabMenuItem::new("delete", assets::DELETE_ELLIPSIS, {
                    let entity = entity.clone();
                    let id = id.clone();
                    move |window, cx| {
                        entity.update(cx, |panel, cx| {
                            panel.ask_delete_banner(id.clone(), window, cx)
                        })
                    }
                })
                .destructive(true)
                .group("delete");

                let mut row = ListRow::new(format!("banner-{}", banner.id), banner.name.clone())
                    .grouped()
                    .context(format!("{} × {}", banner.width, banner.height));
                if banner.kind == videorc_app_core::protocol::BannerKind::Html {
                    row = row.child(Badge::new(assets::HTML_BADGE).variant(BadgeVariant::Outline));
                }
                if shown {
                    // `InUseChip label="Showing"`: the default Badge.
                    row = row.child(Badge::new(assets::SHOWING));
                }
                row = row.child(
                    KebabMenu::new(
                        SharedString::from(format!("banner-actions-{id}")),
                        vec![show, place, rename, earlier, later, delete],
                    )
                    .label(format!("Actions for {}", banner.name))
                    .disabled(offline)
                    .reveal(KebabReveal::Hover),
                );
                list = list.item(
                    div()
                        .id(SharedString::from(format!("banner-host-{id}")))
                        .group(KEBAB_HOST)
                        .child(row),
                );
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
                    // Both imports, as in the section's header.
                    banners_section = banners_section.child(
                        Empty::new().title(assets::NO_BANNERS).child(
                            div()
                                .flex()
                                .flex_wrap()
                                .items_center()
                                .justify_center()
                                .gap(px(8.))
                                .child(banner_import(
                                    "banner-import-empty",
                                    BannerImportKind::Image,
                                ))
                                .child(banner_import(
                                    "banner-import-html-empty",
                                    BannerImportKind::Html,
                                )),
                        ),
                    );
                }
            }
        }

        let mut takeovers_section = PanelSection::new("images-takeovers")
            .icon(icon(IconName::FrameCorners, 16., hsla(t.muted_foreground)))
            .title(assets::TAKEOVERS)
            .description(assets::TAKEOVERS_DESCRIPTION)
            .last(true)
            .action({
                let entity = entity.clone();
                Button::new("takeover-import")
                    .variant(ButtonVariant::Outline)
                    .child(if self.takeover_importing {
                        Spinner::new("takeover-import-spinner")
                            .size(16.)
                            .into_any_element()
                    } else {
                        icon(IconName::ImageSquare, 16., hsla(t.foreground)).into_any_element()
                    })
                    .child(assets::takeover_import_label(
                        false,
                        self.takeover_importing,
                    ))
                    .disabled(offline || self.takeover_importing || session_lock)
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |panel, cx| panel.import_takeovers(cx));
                    })
            });
        if !self.takeovers.is_empty() {
            let mut list = GroupedList::new();
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
            // The title is the shell's toolbar band (#2206), not the page's.
            .child(
                div().flex_1().min_h(px(0.)).child(
                    ScrollArea::new("images-scroll").child(
                        div()
                            .flex()
                            .flex_col()
                            // `PageHeader`: `px-gutter pt-3 pb-1`, text-xs.
                            .child(
                                div()
                                    .px(px(size::GUTTER))
                                    .pt(px(12.))
                                    .pb(px(4.))
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(hsla(t.muted_foreground))
                                    .child(assets::DESCRIPTION),
                            )
                            .child(div().px(px(size::GUTTER)).child(notices))
                            // The sections are flush: each owns its gutter.
                            .child(backgrounds)
                            .child(banners_section)
                            .child(takeovers_section),
                    ),
                ),
            )
            .child(rename_dialog)
            .child(delete_dialog)
    }
}
