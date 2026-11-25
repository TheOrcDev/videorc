//! Connect an agent… (P1421, P1424, P1425; Electron's
//! `connect-agent-dialog.tsx`, plan 209 S7, D6, S22): pick the app, name it,
//! then the exact line for that app with the bridge's path and the agent's
//! own token, and "Add to {app}" to write it into the app's config.
//!
//! The token exists only here, once: never in a store or a log, drawn masked
//! until Show token (Settings may be on stream), and gone when the dialog
//! closes. Connecting turns Agents on when it is off. A bridge that is
//! missing, or that runs from a disk image or a temporary copy, never gets a
//! token or a line.

use std::sync::Arc;
use std::time::Duration;

use gpui::{
    App, AppContext, ClipboardItem, Context, Entity, Global, IntoElement, SharedString, Window,
    div, prelude::*, px,
};
use serde_json::{Value, json};
use videorc_app_core::desktop::agent_bridge::{self, BridgeInfo, BridgeLocation};
use videorc_app_core::desktop::camera_extension::admin_request;
use videorc_app_core::settings_page::agents::{
    self, AGENT_APPS, AGENT_NAME_MAX_CHARS, ConnectLine, app_label, bridge_path_refusal,
    connect_line, default_agent_name, line_display, refusal_message,
};
use videorc_app_core::supervisor::BackendState;
use videorc_app_core::user_error::{Failure, UserErrorContext, user_error_message};
use videorc_app_core::{BackendClient, Studio};
use videorc_kit::{
    alert::{Alert, AlertVariant},
    badge::{Badge, BadgeVariant},
    button::{Button, ButtonSize, ButtonVariant},
    command::InputEvent,
    dialog::{Dialog, DialogHandle, DialogSize},
    input::{Input, InputState},
    select::Select,
    theme::{self, TypeScale, hsla},
    tokens::text,
};

/// `AGENT_ADD_TIMEOUT_MS`: `claude mcp remove` then `add` take up to 28 s.
const ADD_TIMEOUT: Duration = Duration::from_millis(35_000);
/// `useCopyText`: how long Copy says Copied.
const COPIED_FOR: Duration = Duration::from_millis(2_000);
/// Main's answer when "Add to …" itself failed.
const ADD_FAILED: &str = "Couldn't add Videorc. Copy the line instead.";

/// Where this install's bridge lives, set by the app at launch.
#[derive(Clone)]
pub struct AgentBridge(pub BridgeLocation);

impl Global for AgentBridge {}

/// The line shown once, with the token it holds. No `Debug`: it holds the
/// token.
struct Shown {
    client: &'static str,
    name: String,
    token: String,
    line: ConnectLine,
}

enum Step {
    Choose,
    Show(Shown),
}

pub struct ConnectAgentDialog {
    handle: DialogHandle,
    studio: Arc<Studio<BackendClient>>,
    backend: tokio::sync::watch::Receiver<BackendState>,
    runtime: tokio::runtime::Handle,
    step: Step,
    app: &'static str,
    /// The streamer typed a name: it no longer follows the app.
    typed: bool,
    name: Entity<InputState>,
    /// Agents was on when the dialog opened.
    enabled: bool,
    /// The bridge as Settings reads it (no write).
    bridge: Option<BridgeInfo>,
    pending: bool,
    error: Option<String>,
    shown: bool,
    copied: u64,
    adding: bool,
    added: Option<(bool, String)>,
    /// Bumped at every open: an answer for an earlier one is dropped.
    epoch: u64,
}

impl ConnectAgentDialog {
    pub fn new(
        studio: Arc<Studio<BackendClient>>,
        backend: tokio::sync::watch::Receiver<BackendState>,
        runtime: tokio::runtime::Handle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let app = AGENT_APPS[0].0;
        let name = cx.new(|cx| {
            let mut input = InputState::new(window, cx)
                .validate(|value, _| value.chars().count() <= AGENT_NAME_MAX_CHARS);
            input.set_value(default_agent_name(app), window, cx);
            input
        });
        cx.subscribe_in(
            &name,
            window,
            |this, input, event: &InputEvent, _, cx| match event {
                InputEvent::Change => {
                    let value = input.read(cx).value().to_string();
                    if value != default_agent_name(this.app) {
                        this.typed = true;
                    }
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => this.connect(cx),
                _ => {}
            },
        )
        .detach();
        Self {
            handle: DialogHandle::new(false),
            studio,
            backend,
            runtime,
            step: Step::Choose,
            app,
            typed: false,
            name,
            enabled: false,
            bridge: None,
            pending: false,
            error: None,
            shown: false,
            copied: 0,
            adding: false,
            added: None,
            epoch: 0,
        }
    }

    fn location(cx: &App) -> Option<BridgeLocation> {
        cx.try_global::<AgentBridge>()
            .map(|bridge| bridge.0.clone())
    }

    /// Opens on the first step; `enabled` is whether Agents is on.
    pub fn open(&mut self, enabled: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.epoch += 1;
        self.step = Step::Choose;
        self.app = AGENT_APPS[0].0;
        self.typed = false;
        self.enabled = enabled;
        self.pending = false;
        self.error = None;
        self.shown = false;
        self.adding = false;
        self.added = None;
        let app = self.app;
        self.name.update(cx, |input, cx| {
            input.set_value(default_agent_name(app), window, cx)
        });
        // Settings reads the path; nothing is written until Connect.
        self.bridge = Self::location(cx).map(|location| agent_bridge::resolve(&location, false));
        self.handle.open(window, cx);
        cx.notify();
    }

    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.forget();
        self.handle.close(window, cx);
        cx.notify();
    }

    /// The token goes with the dialog.
    fn forget(&mut self) {
        self.epoch += 1;
        self.step = Step::Choose;
        self.added = None;
    }

    fn pick_app(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(&(app, _)) = AGENT_APPS.iter().find(|(app, _)| *app == id) else {
            return;
        };
        self.app = app;
        if !self.typed {
            let name = default_agent_name(app);
            self.name
                .update(cx, |input, cx| input.set_value(name, window, cx));
        }
        cx.notify();
    }

    fn bridge_missing(&self) -> bool {
        self.bridge.as_ref().is_some_and(|bridge| !bridge.exists)
    }

    /// Review #19: a path that moves never gets a token or a line.
    fn path_refusal(&self) -> Option<&'static str> {
        self.bridge
            .as_ref()
            .filter(|bridge| bridge.exists)
            .and_then(|bridge| bridge_path_refusal(&bridge.path))
    }

    fn can_connect(&self, cx: &App) -> bool {
        !self.name.read(cx).value().trim().is_empty()
            && !self.pending
            && !self.bridge_missing()
            && self.path_refusal().is_none()
    }

    /// Connect: the bridge's copy first (D20, a token is never minted for a
    /// line whose path does not exist), Agents on, then the agent.
    fn connect(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.step, Step::Choose) || !self.can_connect(cx) {
            return;
        }
        let Some(location) = Self::location(cx) else {
            self.error = Some(agents::copy::BRIDGE_MISSING.to_string());
            cx.notify();
            return;
        };
        self.pending = true;
        self.error = None;
        let name = self.name.read(cx).value().trim().to_string();
        let client = self.app;
        let enabled = self.enabled;
        let backend = self.studio.backend().clone();
        let epoch = self.epoch;
        let job = self.runtime.spawn(async move {
            let bridge =
                tokio::task::spawn_blocking(move || agent_bridge::resolve(&location, true))
                    .await
                    .map_err(|_| agents::copy::BRIDGE_MISSING.to_string())?;
            if !bridge.exists {
                return Err(agents::copy::BRIDGE_MISSING.to_string());
            }
            if let Some(refusal) = bridge_path_refusal(&bridge.path) {
                return Err(refusal.to_string());
            }
            let failed = |error: videorc_app_core::client::RpcError| {
                refusal_message(Some(error.code.as_str()), &error.message).unwrap_or_else(|| {
                    let copy = user_error_message(
                        Failure::Rpc(&error),
                        Some(UserErrorContext {
                            action: "connect",
                            object: "the agent",
                        }),
                    );
                    format!("{}. {}", copy.title, copy.description)
                })
            };
            if !enabled {
                backend
                    .request("agents.enable", json!({}))
                    .await
                    .map_err(failed)?;
            }
            let created = backend
                .request("agents.create", json!({ "name": name, "client": client }))
                .await
                .map_err(failed)?;
            let token = created
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = created
                .pointer("/agent/name")
                .and_then(Value::as_str)
                .map_or(name, str::to_string);
            Ok::<_, String>((bridge.path, name, token))
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            let _ = this.update(cx, |this, cx| {
                if this.epoch != epoch {
                    return;
                }
                this.pending = false;
                match answer {
                    Ok(Ok((path, name, token))) if !token.is_empty() => {
                        let line = connect_line(client, &path, &token);
                        this.shown = false;
                        this.step = Step::Show(Shown {
                            client,
                            name,
                            token,
                            line,
                        });
                    }
                    Ok(Err(message)) => this.error = Some(message),
                    _ => this.error = Some("Couldn't connect the agent. Try again.".to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// "Add to {app}" (S22): the app's own config gets the videorc entry, or
    /// `claude mcp add` runs, in the backend (admin `agents.config.add`).
    fn add(&mut self, cx: &mut Context<Self>) {
        let Step::Show(shown) = &self.step else {
            return;
        };
        if shown.client == "other" || self.adding {
            return;
        }
        let (Some(location), Some(bootstrap)) = (
            Self::location(cx),
            self.backend.borrow().bootstrap().cloned(),
        ) else {
            self.added = Some((false, ADD_FAILED.to_string()));
            cx.notify();
            return;
        };
        self.adding = true;
        let app = shown.client;
        let token = shown.token.clone();
        let label = app_label(app);
        let epoch = self.epoch;
        let job = self.runtime.spawn(async move {
            let bridge =
                tokio::task::spawn_blocking(move || agent_bridge::resolve(&location, true))
                    .await
                    .ok()?;
            if !bridge.exists {
                return Some((false, agents::copy::BRIDGE_MISSING.to_string()));
            }
            let answer = admin_request(
                &bootstrap,
                "agents.config.add",
                json!({ "app": app, "bridgePath": bridge.path, "token": token }),
                ADD_TIMEOUT,
            )
            .await
            .ok()?;
            Some((
                answer
                    .get("added")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                answer
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or(ADD_FAILED)
                    .to_string(),
            ))
        });
        cx.spawn(async move |this, cx| {
            let answer = job.await.ok().flatten();
            let _ = this.update(cx, |this, cx| {
                if this.epoch != epoch {
                    return;
                }
                this.adding = false;
                this.added =
                    Some(answer.unwrap_or_else(|| (false, agents::copy::add_failed(label))));
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn copy_line(&mut self, cx: &mut Context<Self>) {
        let Step::Show(shown) = &self.step else {
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(shown.line.text.clone()));
        self.copied += 1;
        let copied = self.copied;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(COPIED_FOR).await;
            let _ = this.update(cx, |this, cx| {
                if this.copied == copied {
                    this.copied = 0;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn choose_step(&self, window: &mut Window, cx: &mut Context<Self>) -> Dialog {
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let mut apps = Select::new("connect-agent-app")
            .accessibility_label(agents::copy::APP)
            .disabled(self.pending)
            .value(Some(SharedString::from(self.app)));
        for (id, label) in AGENT_APPS {
            apps = apps.option(id, label);
        }
        let apps = apps.on_change(move |id, window, cx| {
            entity.update(cx, |this, cx| this.pick_app(&id, window, cx))
        });
        let label = |words: &'static str| {
            div()
                .type_scale(text::LABEL)
                .text_color(hsla(t.foreground))
                .child(words)
        };
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(label(agents::copy::APP))
                    .child(apps),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(label(agents::copy::NAME))
                    .child(
                        Input::new("connect-agent-name", &self.name)
                            .accessibility_label(agents::copy::NAME)
                            .disabled(self.pending),
                    )
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(if self.enabled {
                                agents::copy::NAME_DESCRIPTION
                            } else {
                                agents::copy::NAME_DESCRIPTION_OFF
                            }),
                    )
                    .children(self.error.clone().map(|error| {
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.destructive))
                            .child(error)
                    })),
            );
        if self.bridge_missing() {
            body = body.child(
                Alert::new("connect-agent-bridge-missing")
                    .variant(AlertVariant::Warning)
                    .title(agents::copy::BRIDGE_MISSING),
            );
        } else if let Some(refusal) = self.path_refusal() {
            body = body.child(
                Alert::new("connect-agent-move-first")
                    .variant(AlertVariant::Warning)
                    .title(refusal)
                    .description(agents::copy::MOVE_FIRST_DETAIL),
            );
        }
        Dialog::new("connect-agent", &self.handle, agents::copy::CONNECT_TITLE)
            .description(agents::copy::CONNECT_DESCRIPTION)
            .size(DialogSize::Lg)
            .child(body)
            .footer(
                Button::new("connect-agent-cancel")
                    .label(agents::copy::CANCEL)
                    .variant(ButtonVariant::Ghost)
                    .disabled(self.pending)
                    .on_click(cx.listener(|this, _, window, cx| this.close(window, cx))),
            )
            .footer(
                Button::new("connect-agent-create")
                    .label(if self.pending {
                        agents::copy::CONNECTING
                    } else {
                        agents::copy::CONNECT
                    })
                    .disabled(!self.can_connect(cx))
                    .on_click(cx.listener(|this, _, _, cx| this.connect(cx))),
            )
    }

    fn show_step(&self, shown: &Shown, window: &mut Window, cx: &mut Context<Self>) -> Dialog {
        let t = theme::current(window, cx).theme();
        let app = app_label(shown.client);
        let toolbar = div()
            .flex()
            .min_w(px(0.))
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .truncate()
                    .type_scale(text::LABEL)
                    .text_color(hsla(t.muted_foreground))
                    .child(shown.line.label),
            )
            .child(Badge::new(agents::copy::SHOWN_ONCE).variant(BadgeVariant::Outline))
            .child(
                Button::new("connect-agent-show-token")
                    .label(if self.shown {
                        agents::copy::HIDE_TOKEN
                    } else {
                        agents::copy::SHOW_TOKEN
                    })
                    .size(ButtonSize::Xs)
                    .variant(ButtonVariant::Ghost)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.shown = !this.shown;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("connect-agent-copy")
                    .label(if self.copied > 0 {
                        agents::copy::COPIED
                    } else {
                        agents::copy::COPY
                    })
                    .size(ButtonSize::Xs)
                    .variant(ButtonVariant::Outline)
                    .on_click(cx.listener(|this, _, _, cx| this.copy_line(cx))),
            );
        let line = div()
            .id("connect-agent-line")
            .max_h(px(288.))
            .overflow_y_scroll()
            .rounded(px(videorc_kit::tokens::radius::ROW))
            .border_1()
            .border_color(hsla(t.border))
            .bg(hsla(t.muted))
            .p(px(12.))
            .font_family(videorc_kit::theme::FONT_MONO)
            .type_scale(text::META)
            .text_color(hsla(t.foreground))
            .child(line_display(&shown.line, &shown.token, self.shown));
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(toolbar)
            .child(line)
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(agents::copy::TOKEN_NOTE),
            );
        if let Some((added, message)) = &self.added {
            body = body.child(
                Alert::new("connect-agent-add-result")
                    .variant(if *added {
                        AlertVariant::Success
                    } else {
                        AlertVariant::Warning
                    })
                    .title(message.clone()),
            );
        }
        let mut dialog = Dialog::new(
            "connect-agent",
            &self.handle,
            agents::copy::connect_named(&shown.name),
        )
        .description(shown.line.where_)
        .size(DialogSize::Lg)
        .child(body);
        if shown.client != "other" {
            dialog = dialog.footer(
                Button::new("connect-agent-add")
                    .label(if self.adding {
                        agents::copy::ADDING.to_string()
                    } else {
                        agents::copy::add_to(app)
                    })
                    .variant(ButtonVariant::Outline)
                    .disabled(self.adding)
                    .on_click(cx.listener(|this, _, _, cx| this.add(cx))),
            );
        }
        dialog.footer(
            Button::new("connect-agent-done")
                .label(agents::copy::DONE)
                .on_click(cx.listener(|this, _, window, cx| this.close(window, cx))),
        )
    }
}

impl Render for ConnectAgentDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dialog = match &self.step {
            Step::Choose => self.choose_step(window, cx),
            Step::Show(shown) => self.show_step(shown, window, cx),
        };
        let weak = cx.entity().downgrade();
        dialog
            // Deferred: a close from this dialog's own buttons runs inside
            // its update.
            .on_open_change(move |open, _, _, cx| {
                if !open {
                    let weak = weak.clone();
                    cx.defer(move |cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.forget();
                            cx.notify();
                        });
                    });
                }
            })
            .into_any_element()
    }
}

/// The Settings screen's door: one dialog for the screen.
pub fn dialog(
    studio: Arc<Studio<BackendClient>>,
    backend: tokio::sync::watch::Receiver<BackendState>,
    runtime: tokio::runtime::Handle,
    window: &mut Window,
    cx: &mut App,
) -> Entity<ConnectAgentDialog> {
    cx.new(|cx| ConnectAgentDialog::new(studio, backend, runtime, window, cx))
}
