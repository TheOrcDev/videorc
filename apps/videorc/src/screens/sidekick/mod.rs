//! Sidekick ⌘9 (plan 260 Phase 3): Overview, Chat, Community, Voice,
//! Reports and Clean cut from `videorc_app_core::buddy` and
//! `stream_manager::buddy`, drawn with `videorc-kit`. Words match Electron's
//! `tabs/buddy-tab.tsx`.

mod live;
mod overview;

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{Context, Window, div, prelude::*, px};
use serde_json::json;
use videorc_app_core::buddy::copy as words;
use videorc_app_core::stream_manager::buddy::{
    CLOUD_AI_KEEPS, CohostSettingsView, CohostState, cloud_ai_uses,
};
use videorc_app_core::studio::families::{self, write_ai_consent};
use videorc_app_core::studio::ui_local::UiLocal;
use videorc_app_core::{BackendClient, BackendEvent, Studio};
use videorc_kit::dialog::DialogHandle;
use videorc_kit::page_tabs::PageTabs;
use videorc_kit::theme::{self, FONT, TypeScale, hsla};
use videorc_kit::tokens::{size, text};

use live::{LiveInput, LiveView, live_view};
use overview::{OverviewState, render_overview};

pub type AppStudio = Studio<BackendClient>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Overview,
    Chat,
    Community,
    Voice,
    Reports,
    CleanCut,
}

impl Tab {
    fn id(self) -> &'static str {
        match self {
            Self::Overview => "live",
            Self::Chat => "chat",
            Self::Community => "community",
            Self::Voice => "voice",
            Self::Reports => "reports",
            Self::CleanCut => "clean-cut",
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Overview => 0,
            Self::Chat => 1,
            Self::Community => 2,
            Self::Voice => 3,
            Self::Reports => 4,
            Self::CleanCut => 5,
        }
    }

    fn from_index(index: usize) -> Self {
        match index {
            1 => Self::Chat,
            2 => Self::Community,
            3 => Self::Voice,
            4 => Self::Reports,
            5 => Self::CleanCut,
            _ => Self::Overview,
        }
    }

    fn from_id(id: &str) -> Self {
        match id {
            "chat" => Self::Chat,
            "community" => Self::Community,
            "voice" => Self::Voice,
            "reports" => Self::Reports,
            "clean-cut" => Self::CleanCut,
            _ => Self::Overview,
        }
    }

    fn label(self) -> &'static str {
        words::tab_label(self.id())
    }
}

pub struct SidekickScreen {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    local_dir: PathBuf,
    tab: Tab,
    settings: Option<CohostSettingsView>,
    state: CohostState,
    signed_in: bool,
    entitled: bool,
    consented: bool,
    live: bool,
    consent: DialogHandle,
    pending_on: bool,
}

impl SidekickScreen {
    pub fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        local_dir: PathBuf,
        cx: &mut Context<Self>,
    ) -> Self {
        let tab = Tab::from_id(UiLocal::in_dir(&local_dir).buddy_tab());
        let consented = studio.read_ui_settings(families::ai_consent);
        let mut screen = Self {
            studio: studio.clone(),
            runtime: runtime.clone(),
            local_dir,
            tab,
            settings: None,
            state: CohostState::default(),
            signed_in: false,
            entitled: false,
            consented,
            live: false,
            consent: DialogHandle::new(false),
            pending_on: false,
        };
        screen.refresh(cx);
        screen.watch(cx);
        screen
    }

    fn watch(&self, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        cx.spawn(async move |this, cx| {
            let mut studio_rx = studio.watch();
            let mut events = studio.backend().subscribe();
            loop {
                tokio::select! {
                    changed = studio_rx.changed() => {
                        if changed.is_err() { break; }
                        let _ = this.update(cx, |screen, cx| {
                            screen.live = studio_rx.borrow().session.phase.is_active();
                            screen.consented = studio.read_ui_settings(families::ai_consent);
                            cx.notify();
                        });
                    }
                    event = events.recv() => {
                        match event {
                            Ok(BackendEvent::Untyped { event, payload }) => {
                                let refresh = matches!(
                                    event.as_str(),
                                    "cohost.state" | "cohost.settings.changed" | "account.changed"
                                );
                                if event == "cohost.state" {
                                    if let Ok(state) =
                                        serde_json::from_value::<CohostState>(payload)
                                    {
                                        let _ = this.update(cx, |screen, cx| {
                                            screen.state = state;
                                            cx.notify();
                                        });
                                    }
                                }
                                if refresh {
                                    let _ = this.update(cx, |screen, cx| screen.refresh(cx));
                                }
                            }
                            Ok(_) => {}
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                            Err(_) => break,
                        }
                    }
                }
            }
        })
        .detach();
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let read = self.runtime.spawn(async move {
            let settings = backend
                .request("cohost.settings.get", json!(null))
                .await
                .ok()
                .and_then(|value| CohostSettingsView::from_json(&value));
            let account = backend.request("account.get", json!(null)).await.ok();
            let signed_in = account
                .as_ref()
                .and_then(|value| value.get("status"))
                .and_then(|status| status.as_str())
                == Some("signed-in");
            let entitled = account
                .as_ref()
                .and_then(|value| value.pointer("/entitlements/liveCohost/allowed"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            (settings, signed_in, entitled)
        });
        cx.spawn(async move |this, cx| {
            let Ok((settings, signed_in, entitled)) = read.await else {
                return;
            };
            let _ = this.update(cx, |screen, cx| {
                screen.settings = settings;
                screen.signed_in = signed_in;
                screen.entitled = entitled;
                screen.live = screen.studio.snapshot().session.phase.is_active();
                screen.consented = screen.studio.read_ui_settings(families::ai_consent);
                cx.notify();
            });
        })
        .detach();
    }

    fn view(&self) -> LiveView {
        live_view(LiveInput {
            settings_known: self.settings.is_some(),
            enabled: self.settings.as_ref().map(|s| s.enabled).unwrap_or(false),
            signed_in: self.signed_in,
            entitled: self.entitled,
            consented: self.consented,
            live: self.live,
            state: Some(&self.state),
        })
    }

    pub(crate) fn select_tab(&mut self, index: usize, cx: &mut Context<Self>) {
        let tab = Tab::from_index(index);
        if self.tab == tab {
            return;
        }
        self.tab = tab;
        let _ = UiLocal::in_dir(&self.local_dir).set_buddy_tab(tab.id());
        cx.notify();
    }

    pub(crate) fn set_live(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        if on && !self.consented {
            self.pending_on = true;
            self.consent.open(window, cx);
            cx.notify();
            return;
        }
        self.apply_live(on, cx);
    }

    pub(crate) fn answer_consent(
        &mut self,
        accept: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.consent.close(window, cx);
        if !accept {
            self.pending_on = false;
            cx.notify();
            return;
        }
        let studio = self.studio.clone();
        let turn_on = self.pending_on;
        self.pending_on = false;
        let write = self
            .runtime
            .spawn(async move { studio.write_settings(vec![write_ai_consent(true)]).await });
        cx.spawn(async move |this, cx| {
            let _ = write.await;
            let _ = this.update(cx, |screen, cx| {
                screen.consented = true;
                if turn_on {
                    screen.apply_live(true, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_live(&mut self, on: bool, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.settings.set", json!({ "enabled": on }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Ok(Ok(value)) = result {
                    screen.settings = CohostSettingsView::from_json(&value);
                } else if let Ok(Err(error)) = result {
                    eprintln!("[videorc-app] Sidekick Live: {error}");
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn set_listen(&mut self, on: bool, cx: &mut Context<Self>) {
        let backend = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            backend
                .request("cohost.settings.set", json!({ "listen": on }))
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |screen, cx| {
                if let Ok(Ok(value)) = result {
                    screen.settings = CohostSettingsView::from_json(&value);
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn set_consent(&mut self, on: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let write = self
            .runtime
            .spawn(async move { studio.write_settings(vec![write_ai_consent(on)]).await });
        cx.spawn(async move |this, cx| {
            let _ = write.await;
            let _ = this.update(cx, |screen, cx| {
                screen.consented = on;
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn open_stream_manager(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.dispatch_action(Box::new(crate::app::menus::ToggleStreamManager), cx);
    }

    fn later_tab(&self, name: &str, theme: &videorc_kit::tokens::Theme) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(size::GUTTER))
            .child(
                div()
                    .type_scale(text::SECTION)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(name.to_string()),
            )
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(theme.muted_foreground))
                    .child("This Sidekick section comes in the next slice."),
            )
    }
}

impl Render for SidekickScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme::resolve(None, window, cx);
        let view = self.view();
        let listen = self.settings.as_ref().map(|s| s.listen).unwrap_or(false);
        let cloud_uses = cloud_ai_uses();
        let overview = OverviewState {
            view: &view,
            listen,
            consented: self.consented,
            cloud_uses: &cloud_uses,
            cloud_keeps: CLOUD_AI_KEEPS,
        };
        let body = match self.tab {
            Tab::Overview => render_overview(overview, window, cx),
            Tab::Chat => self.later_tab(Tab::Chat.label(), &theme).into_any_element(),
            Tab::Community => self
                .later_tab(Tab::Community.label(), &theme)
                .into_any_element(),
            Tab::Voice => self
                .later_tab(Tab::Voice.label(), &theme)
                .into_any_element(),
            Tab::Reports => self
                .later_tab(Tab::Reports.label(), &theme)
                .into_any_element(),
            Tab::CleanCut => self
                .later_tab(Tab::CleanCut.label(), &theme)
                .into_any_element(),
        };

        let entity = cx.entity();
        let mut tabs = PageTabs::new("sidekick-page", words::TABS_LABEL);
        for tab in [
            Tab::Overview,
            Tab::Chat,
            Tab::Community,
            Tab::Voice,
            Tab::Reports,
            Tab::CleanCut,
        ] {
            tabs = tabs.tab(tab.label());
        }
        tabs = tabs
            .selected(self.tab.index())
            .on_select(move |index, _, cx| {
                entity.update(cx, |screen, cx| screen.select_tab(index, cx));
            });

        let consent = overview::consent_dialog(&self.consent, cx);

        div()
            .id("sidekick-screen")
            .size_full()
            .flex()
            .flex_col()
            .font_family(FONT)
            .child(tabs.child(body))
            .child(consent)
    }
}
