//! The Takeover section (`session-panel.tsx`'s `TakeoverSection`): the
//! takeover on-air switch, its one home (the Images page manages the
//! images; this flips them). It works mid-session: a takeover only needs the
//! backend, and it replaces the output whatever the scene.

use std::sync::Arc;

use gpui::{AnyElement, Context, EventEmitter, Hsla, Window, div, prelude::*, px};
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::{StudioBackend, connection_blocked_reason};
use videorc_app_core::{BackendClient, StudioSnapshot};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;
use videorc_kit::{Button, ButtonSize, ButtonVariant, PanelSection};
use videorc_protocol::{StreamScreen, StreamScreenStatus};

use super::transport::OpenPage;
use crate::app::bridge::Mirror;
use crate::lcd;

pub const TITLE: &str = "Takeover";
pub const EMPTY: &str = "No takeovers yet.";
pub const ADD_IN_IMAGES: &str = "Add in Images";
/// `OpenPageCog label="Open Images"`.
pub const OPEN_IMAGES: &str = "Open Images";
pub const IDLE_HINT: &str =
    "Click a takeover to cover the output. Works while you’re recording or live.";

/// One takeover button.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TakeoverButton {
    pub id: String,
    pub name: String,
    /// On air: the button is filled, and a click returns to the scene.
    pub active: bool,
}

/// `useTakeovers`: the takeovers that can go on air, and the line that says
/// what a click does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TakeoverView {
    pub buttons: Vec<TakeoverButton>,
    /// The buttons are off while Videorc is away, and say why.
    pub disconnected: Option<String>,
    pub hint: String,
}

impl TakeoverView {
    pub fn of(
        screens: &[StreamScreen],
        active: Option<&StreamScreen>,
        disconnected: Option<&str>,
    ) -> Self {
        let buttons = screens
            .iter()
            .filter(|screen| screen.status != StreamScreenStatus::Missing)
            .map(|screen| TakeoverButton {
                id: screen.id.clone(),
                name: screen.name.clone(),
                active: active.is_some_and(|on| on.id == screen.id),
            })
            .collect();
        let hint = match (disconnected, active) {
            (Some(reason), _) => {
                format!("{reason} Takeovers work once Videorc is connected.")
            }
            (None, Some(on)) => {
                format!("{} is covering the output. Click it to return.", on.name)
            }
            (None, None) => IDLE_HINT.to_string(),
        };
        Self {
            buttons,
            disconnected: disconnected.map(str::to_string),
            hint,
        }
    }
}

/// What the section follows from the snapshot: the connection's reason, and
/// which connection it is (a new one holds a fresh list).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TakeoverLink {
    pub disconnected: Option<&'static str>,
    pub generation: u64,
    /// Settings → General → Retro LCD.
    pub retro: bool,
}

impl TakeoverLink {
    pub fn of(snapshot: &StudioSnapshot) -> Self {
        Self {
            disconnected: connection_blocked_reason(&snapshot.connection),
            generation: snapshot.connection_generation,
            retro: snapshot.settings.studio.retro_lcd_studio(),
        }
    }
}

pub struct TakeoverSection {
    backend: Arc<BackendClient>,
    runtime: tokio::runtime::Handle,
    link: gpui::Entity<Mirror<TakeoverLink>>,
    screens: Vec<StreamScreen>,
    active: Option<StreamScreen>,
}

impl EventEmitter<OpenPage> for TakeoverSection {}

impl TakeoverSection {
    pub fn new(
        backend: Arc<BackendClient>,
        runtime: tokio::runtime::Handle,
        link: gpui::Entity<Mirror<TakeoverLink>>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&link, |section, link, cx| {
            if link.read(cx).value().disconnected.is_none() {
                section.refresh(cx);
            }
            cx.notify();
        })
        .detach();
        let mut section = Self {
            backend,
            runtime,
            link,
            screens: Vec::new(),
            active: None,
        };
        section.refresh(cx);
        section
    }

    /// Reads the takeovers and the one on air again.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let backend = self.backend.clone();
        let read = self.runtime.spawn(async move {
            let screens = backend.screens_list().await;
            let active = backend.screens_active().await;
            (screens, active)
        });
        cx.spawn(async move |this, cx| {
            let Ok((screens, active)) = read.await else {
                return;
            };
            this.update(cx, |section, cx| {
                match screens {
                    Ok(screens) => section.screens = screens,
                    Err(error) => eprintln!("[videorc-app] Takeover list: {error}"),
                }
                match active {
                    Ok(active) => section.active = active,
                    Err(error) => eprintln!("[videorc-app] Takeover on air: {error}"),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Puts `id` on air, or returns to the scene when it already is.
    fn flip(&mut self, id: String, active: bool, cx: &mut Context<Self>) {
        let backend = self.backend.clone();
        let answer = self.runtime.spawn(async move {
            if active {
                backend.screens_clear().await.map(|()| None)
            } else {
                backend.screens_activate(&id).await.map(Some)
            }
        });
        cx.spawn(async move |this, cx| {
            let Ok(answer) = answer.await else {
                return;
            };
            this.update(cx, |section, cx| match answer {
                Ok(on_air) => {
                    section.active = on_air;
                    cx.notify();
                }
                Err(error) => {
                    eprintln!("[videorc-app] Takeover: {error}");
                    section.refresh(cx);
                }
            })
            .ok();
        })
        .detach();
    }
}

impl TakeoverSection {
    fn render_default(
        &self,
        theme: &videorc_kit::tokens::Theme,
        view: TakeoverView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let muted = hsla(theme.muted_foreground);
        let ghost_ink = hsla(theme.foreground);
        let outline_ink = hsla(theme.foreground);
        let default_ink = hsla(theme.chrome_fill_ink);
        let section = PanelSection::new("studio-takeover").title(TITLE).action(
            Button::new("takeover-open-images")
                .variant(ButtonVariant::Ghost)
                .size(ButtonSize::IconXs)
                .accessibility_label(OPEN_IMAGES)
                .tooltip(OPEN_IMAGES)
                .child(icon(IconName::GearSix, 16., ghost_ink))
                .on_click(cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Assets)))),
        );
        if view.buttons.is_empty() {
            return section
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(icon(IconName::ImageSquare, 14., muted))
                        .child(div().min_w_0().child(EMPTY))
                        .child(
                            Button::new("takeover-add-in-images")
                                .variant(ButtonVariant::Link)
                                .size(ButtonSize::Xs)
                                .label(ADD_IN_IMAGES)
                                .on_click(
                                    cx.listener(|_, _, _, cx| {
                                        cx.emit(OpenPage::of(PageId::Assets))
                                    }),
                                ),
                        ),
                )
                .into_any_element();
        }
        let disconnected = view.disconnected.clone();
        let mut row = div().flex().flex_wrap().gap(px(6.));
        for (index, button) in view.buttons.into_iter().enumerate() {
            let TakeoverButton { id, name, active } = button;
            let ink: Hsla = if active { default_ink } else { outline_ink };
            row = row.child(
                Button::new(("takeover", index))
                    .variant(if active {
                        ButtonVariant::Default
                    } else {
                        ButtonVariant::Outline
                    })
                    .accessibility_label(name.clone())
                    .child(icon(IconName::ImageSquare, 16., ink))
                    .child(name)
                    .disabled(disconnected.is_some())
                    .when_some(disconnected.clone(), |button, reason| {
                        button.tooltip(reason)
                    })
                    .on_click(
                        cx.listener(move |section, _, _, cx| section.flip(id.clone(), active, cx)),
                    ),
            );
        }
        section
            .child(row)
            .child(
                div()
                    .min_h(px(32.))
                    .type_scale(text::META)
                    .text_color(muted)
                    .child(view.hint),
            )
            .into_any_element()
    }

    /// Retro LCD Takeover (P244–P247): title + Open Images cog, empty nav
    /// row or press rows, and the hint as a screen message.
    fn render_retro(
        &self,
        theme: &videorc_kit::tokens::Theme,
        view: TakeoverView,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let cog = lcd::cog(
            "takeover-open-images",
            theme,
            OPEN_IMAGES,
            cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Assets))),
        );
        let mut screen =
            div()
                .flex()
                .flex_col()
                .child(lcd::header(theme, TITLE, Some(cog.into_any_element())));
        if view.buttons.is_empty() {
            screen = screen.child(lcd::nav_row(
                "takeover-empty",
                theme,
                "None yet",
                lcd::caps(ADD_IN_IMAGES),
                cx.listener(|_, _, _, cx| cx.emit(OpenPage::of(PageId::Assets))),
            ));
        } else {
            let disconnected = view.disconnected.is_some();
            for (index, button) in view.buttons.iter().enumerate() {
                if index > 0 {
                    screen = screen.child(lcd::separator(theme));
                }
                let id = button.id.clone();
                let active = button.active;
                screen = screen.child(lcd::press_row(
                    ("takeover", index),
                    theme,
                    button.name.clone(),
                    active,
                    disconnected,
                    cx.listener(move |section, _, _, cx| {
                        section.flip(id.clone(), active, cx);
                    }),
                ));
            }
            // Two lines held, so the longer on-air hint never pushes the
            // inspector down.
            screen = screen.child(
                div()
                    .min_h(px(40.))
                    .child(lcd::message(theme, view.hint.clone())),
            );
        }
        PanelSection::new("studio-takeover")
            .child(lcd::panel("studio-lcd-takeover", theme, TITLE, screen))
            .into_any_element()
    }
}

impl Render for TakeoverSection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme::resolve(None, window, cx);
        let link = self.link.read(cx).value().clone();
        let view = TakeoverView::of(&self.screens, self.active.as_ref(), link.disconnected);
        if link.retro {
            self.render_retro(&theme, view, cx)
        } else {
            self.render_default(&theme, view, cx)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(id: &str, name: &str, status: StreamScreenStatus) -> StreamScreen {
        StreamScreen {
            id: id.to_string(),
            name: name.to_string(),
            image_path: String::new(),
            thumbnail_path: None,
            sort_order: 0,
            status,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn missing_takeovers_never_show() {
        let screens = [
            screen("a", "Intro", StreamScreenStatus::Ready),
            screen("b", "Gone", StreamScreenStatus::Missing),
        ];
        let view = TakeoverView::of(&screens, None, None);
        let names: Vec<_> = view.buttons.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["Intro"]);
        assert_eq!(view.hint, IDLE_HINT);
    }

    #[test]
    fn the_hint_names_the_takeover_on_air() {
        let intro = screen("a", "Intro", StreamScreenStatus::Ready);
        let view = TakeoverView::of(std::slice::from_ref(&intro), Some(&intro), None);
        assert!(view.buttons[0].active);
        assert_eq!(
            view.hint,
            "Intro is covering the output. Click it to return."
        );
    }

    #[test]
    fn away_says_why_and_turns_the_buttons_off() {
        let intro = screen("a", "Intro", StreamScreenStatus::Ready);
        let view = TakeoverView::of(
            std::slice::from_ref(&intro),
            Some(&intro),
            Some("Videorc is reconnecting."),
        );
        assert_eq!(
            view.disconnected.as_deref(),
            Some("Videorc is reconnecting.")
        );
        assert_eq!(
            view.hint,
            "Videorc is reconnecting. Takeovers work once Videorc is connected."
        );
    }
}
