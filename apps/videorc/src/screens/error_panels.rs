//! Root and page crash panels (P1445–P1446): the GPUI twin of Electron's
//! `root-error-panel` / `page-error-panel`. The shell mounts
//! [`ErrorPanels`]; pages call [`ErrorPanels::show_page`] when they catch a
//! draw failure. A true panic boundary waits on GPUI's own catch story —
//! these panels are the words and actions once something is known broken.

use gpui::{ClipboardItem, Context, IntoElement, Window, div, prelude::*, px};
use videorc_kit::{
    button::{Button, ButtonVariant},
    empty::Empty,
    theme::{self, FONT, hsla},
    tokens::{radius, text},
    window_frame::WindowHeader,
};

const ROOT_TITLE: &str = "Videorc hit a problem";
const ROOT_BODY_WITH_BUNDLE: &str = "Try again, or reload Videorc. If it keeps happening, export a support bundle and send it to support.";
const ROOT_BODY: &str = "Try again, or reload Videorc. If it keeps happening, export a support bundle from Health after the reload.";
const PAGE_TITLE: &str = "This page hit a problem";
const PAGE_BODY: &str = "Other pages still work.";
const TRY_AGAIN: &str = "Try again";
const RELOAD: &str = "Reload Videorc";
const RELOAD_PAGE: &str = "Reload page";
const COPY: &str = "Copy details";
const COPIED: &str = "Copied";
const COPY_FAILED: &str = "Couldn't copy";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopyState {
    Idle,
    Copied,
    Failed,
}

/// Which panel is up.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    Root {
        details: String,
        /// Health export is still reachable (main shell alive).
        support_bundle: bool,
    },
    Page {
        details: String,
    },
}

/// Shell-hosted root / page error panels.
pub struct ErrorPanels {
    kind: Option<Kind>,
    copy: CopyState,
}

impl ErrorPanels {
    pub fn new(_cx: &mut Context<Self>) -> Self {
        Self {
            kind: None,
            copy: CopyState::Idle,
        }
    }

    /// Full-window crash panel (sidebar and pages gone).
    pub fn show_root(
        &mut self,
        details: impl Into<String>,
        support_bundle: bool,
        cx: &mut Context<Self>,
    ) {
        self.kind = Some(Kind::Root {
            details: details.into(),
            support_bundle,
        });
        self.copy = CopyState::Idle;
        cx.notify();
    }

    /// Per-page crash panel (sidebar and other pages stay).
    pub fn show_page(&mut self, details: impl Into<String>, cx: &mut Context<Self>) {
        self.kind = Some(Kind::Page {
            details: details.into(),
        });
        self.copy = CopyState::Idle;
        cx.notify();
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.kind = None;
        self.copy = CopyState::Idle;
        cx.notify();
    }

    pub fn is_root(&self) -> bool {
        matches!(self.kind, Some(Kind::Root { .. }))
    }

    pub fn is_page(&self) -> bool {
        matches!(self.kind, Some(Kind::Page { .. }))
    }

    fn copy_details(&mut self, details: &str, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(details.to_string()));
        self.copy = CopyState::Copied;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(1500))
                .await;
            let _ = this.update(cx, |panels, cx| {
                if panels.copy == CopyState::Copied {
                    panels.copy = CopyState::Idle;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn copy_label(&self) -> &'static str {
        match self.copy {
            CopyState::Idle => COPY,
            CopyState::Copied => COPIED,
            CopyState::Failed => COPY_FAILED,
        }
    }
}

impl Render for ErrorPanels {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let Some(kind) = self.kind.clone() else {
            return div().into_any_element();
        };
        let copy_label = self.copy_label();
        let entity = cx.entity();
        match kind {
            Kind::Root {
                details,
                support_bundle,
            } => {
                let body = if support_bundle {
                    ROOT_BODY_WITH_BUNDLE
                } else {
                    ROOT_BODY
                };
                let details_for_copy = details.clone();
                div()
                    .id("app-error")
                    .role(gpui::Role::Alert)
                    .size_full()
                    .flex()
                    .flex_col()
                    .font_family(FONT)
                    .bg(hsla(t.glass_solid))
                    .text_color(hsla(t.foreground))
                    .child(WindowHeader::new("Videorc"))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .items_center()
                            .justify_center()
                            .p(px(16.))
                            .child(
                                div()
                                    .w_full()
                                    .max_w(px(448.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(12.))
                                    .p(px(20.))
                                    .rounded(px(radius::PANEL))
                                    .border_1()
                                    .border_color(hsla(t.border))
                                    .child(
                                        div()
                                            .text_size(px(14.))
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .child(ROOT_TITLE),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(hsla(t.muted_foreground))
                                            .child(body),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .flex_wrap()
                                            .gap(px(8.))
                                            .child(
                                                Button::new("error-try-again")
                                                    .label(TRY_AGAIN)
                                                    .on_click({
                                                        let entity = entity.clone();
                                                        move |_, _, cx| {
                                                            entity.update(cx, |panels, cx| {
                                                                panels.clear(cx)
                                                            });
                                                        }
                                                    }),
                                            )
                                            .child(
                                                Button::new("error-reload")
                                                    .label(RELOAD)
                                                    .variant(ButtonVariant::Outline)
                                                    .on_click(|_, _, _| {
                                                        eprintln!(
                                                            "[videorc-app] Reload Videorc was asked from the root error panel"
                                                        );
                                                    }),
                                            )
                                            .child(
                                                Button::new("error-copy")
                                                    .label(copy_label)
                                                    .variant(ButtonVariant::Ghost)
                                                    .on_click({
                                                        let entity = entity.clone();
                                                        move |_, _, cx| {
                                                            entity.update(cx, |panels, cx| {
                                                                panels.copy_details(
                                                                    &details_for_copy,
                                                                    cx,
                                                                );
                                                            });
                                                        }
                                                    }),
                                            ),
                                    ),
                            ),
                    )
                    .into_any_element()
            }
            Kind::Page { details } => {
                let details_for_copy = details;
                div()
                    .id("page-error-host")
                    .size_full()
                    .flex()
                    .flex_col()
                    .font_family(FONT)
                    .type_scale(text::META)
                    .bg(hsla(t.glass_solid))
                    .text_color(hsla(t.foreground))
                    .child(
                        Empty::new().title(PAGE_TITLE).description(PAGE_BODY).child(
                            div()
                                .id("page-error")
                                .role(gpui::Role::Alert)
                                .flex()
                                .gap(px(8.))
                                .child(
                                    Button::new("page-error-reload")
                                        .label(RELOAD_PAGE)
                                        .on_click({
                                            let entity = entity.clone();
                                            move |_, _, cx| {
                                                entity.update(cx, |panels, cx| panels.clear(cx));
                                            }
                                        }),
                                )
                                .child(
                                    Button::new("page-error-copy")
                                        .label(copy_label)
                                        .variant(ButtonVariant::Ghost)
                                        .on_click({
                                            let entity = entity.clone();
                                            move |_, _, cx| {
                                                entity.update(cx, |panels, cx| {
                                                    panels.copy_details(&details_for_copy, cx);
                                                });
                                            }
                                        }),
                                ),
                        ),
                    )
                    .into_any_element()
            }
        }
    }
}
