//! The captions the page and the reader share (Electron's `useStudioCaptions`
//! and the captions part of `use-studio.tsx`): the lines from
//! `captions.update`, the plan's entitlements for the lock, and the rule
//! that starts captions with a session and stops them when the switch goes
//! off (`decideCaptionsRuntimeIntent`). The caption service's status is the
//! Studio's (`captions.status`).
//!
//! The bar on the stream and the recording is [`super::burn`]'s, driven
//! from here on every change.

use std::sync::Arc;

use gpui::{App, AppContext, Context, Entity, Global};
use serde_json::Value;
use videorc_app_core::account::entitlements::{EntitlementGate, cloud_ai_upload_gate};
use videorc_app_core::captions::{self as c, Lines, RuntimeIntent, Status, methods};
use videorc_app_core::livestream::captions_preflight;
use videorc_app_core::protocol::{EntitlementsSnapshot, RecordingState};
use videorc_app_core::{BackendClient, BackendEvent, Studio, StudioSnapshot};

use super::burn::Burn;

pub type AppStudio = Studio<BackendClient>;

/// The one feed, for the page and the reader window.
pub struct FeedGlobal(pub Entity<CaptionsFeed>);

impl Global for FeedGlobal {}

/// The feed, once [`install`] ran.
pub fn feed(cx: &App) -> Option<Entity<CaptionsFeed>> {
    cx.try_global::<FeedGlobal>().map(|global| global.0.clone())
}

/// Starts the feed. Call once, before the main window draws Captions.
pub fn install(
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    cx: &mut App,
) -> Entity<CaptionsFeed> {
    let feed = cx.new(|cx| CaptionsFeed::new(studio, runtime, cx));
    cx.set_global(FeedGlobal(feed.clone()));
    feed
}

/// The attempt's scope: a new scope may try once more
/// (`captionsAttemptScope`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Scope {
    enabled: bool,
    suppressed: bool,
    capture: Option<String>,
    language: String,
    generation: u64,
}

pub struct CaptionsFeed {
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    lines: Lines,
    entitlements: Option<EntitlementsSnapshot>,
    entitlements_generation: Option<u64>,
    scope: Option<Scope>,
    start_attempted: bool,
    stop_attempted: bool,
    pending: u32,
    was_capturing: bool,
    style_sent: Option<Value>,
    shown: Option<Value>,
    burn: Burn,
    /// The last start's failure, shown on the page until the next attempt.
    pub start_error: Option<String>,
}

impl CaptionsFeed {
    fn new(
        studio: Arc<AppStudio>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut snapshots = studio.watch();
        let mut events = studio.backend().subscribe();
        cx.spawn(async move |entity, cx| {
            loop {
                let event = tokio::select! {
                    changed = snapshots.changed() => {
                        if changed.is_err() { break; }
                        None
                    }
                    event = events.recv() => match event {
                        // Frames and the rest wake nothing here.
                        Ok(BackendEvent::Untyped { event, payload }) if wakes(&event) => {
                            Some(BackendEvent::Untyped { event, payload })
                        }
                        Ok(_) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => None,
                    },
                };
                snapshots.borrow_and_update();
                if entity
                    .update(cx, |this, cx| {
                        if let Some(event) = event {
                            this.on_event(event, cx);
                        }
                        this.drive(cx);
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Self {
            studio,
            runtime,
            lines: Lines::default(),
            entitlements: None,
            entitlements_generation: None,
            scope: None,
            start_attempted: false,
            stop_attempted: false,
            pending: 0,
            was_capturing: false,
            style_sent: None,
            shown: None,
            burn: Burn::default(),
            start_error: None,
        }
    }

    pub fn studio(&self) -> &Arc<AppStudio> {
        &self.studio
    }

    pub fn lines(&self) -> &Lines {
        &self.lines
    }

    pub fn status(&self) -> Status {
        Status::of(self.studio.snapshot().captions_status.as_ref())
    }

    /// `captionsCommandPending`: the switch and Retry wait for it.
    pub fn pending(&self) -> bool {
        self.pending > 0
    }

    /// `cloudAiUploadGate`.
    /// The plan as last read (`entitlements.get`, then
    /// `entitlements.updated`); Output's quality lock reads it too.
    pub fn entitlements(&self) -> Option<&EntitlementsSnapshot> {
        self.entitlements.as_ref()
    }

    pub fn gate(&self) -> EntitlementGate {
        cloud_ai_upload_gate(self.entitlements.as_ref())
    }

    /// A talk-show room is open (Guests).
    pub fn room_open(&self) -> bool {
        self.studio
            .cloud_now()
            .status
            .and_then(|status| status.room)
            .is_some_and(|room| room["phase"].as_str() == Some("open"))
    }

    fn show_id(&self) -> Option<String> {
        self.studio
            .cloud_now()
            .status
            .and_then(|status| status.show)
            .map(|show| show.id)
    }

    /// `captionsCaptureActive`: a recording or livestream runs, or a room
    /// is open.
    pub fn capture_active(&self, snapshot: &StudioSnapshot) -> bool {
        self.room_open()
            || matches!(
                snapshot.session.status.state,
                RecordingState::Recording | RecordingState::Streaming
            )
    }

    fn on_event(&mut self, event: BackendEvent, cx: &mut Context<Self>) {
        let BackendEvent::Untyped { event, payload } = event else {
            return;
        };
        let changed = match event.as_str() {
            methods::UPDATE_EVENT => self.lines.apply_update(&payload),
            methods::CLEARED_EVENT => self.lines.clear(),
            methods::OVERLAY_LAYOUT_EVENT => {
                self.burn.set_layout(payload);
                false
            }
            methods::ENTITLEMENTS_EVENT => {
                self.entitlements = read_entitlements(&payload).or(self.entitlements.take());
                true
            }
            _ => false,
        };
        if changed {
            cx.notify();
        }
    }

    /// The runtime rule, the session's rising edge, the style for the final
    /// copy, and the entitlements read on every connection.
    fn drive(&mut self, cx: &mut Context<Self>) {
        let snapshot = self.studio.snapshot();
        let connected = self.studio.is_connected();
        let generation = snapshot.connection_generation;
        if connected && self.entitlements_generation != Some(generation) {
            self.entitlements_generation = Some(generation);
            self.read_entitlements(cx);
        }
        let capture = &snapshot.settings.capture_doc;
        let captions = &capture["captions"];
        let enabled = captions["enabled"].as_bool().unwrap_or(false);
        let language = captions["language"].as_str().unwrap_or("auto").to_string();
        let room_open = self.room_open();
        let capturing = self.capture_active(&snapshot);
        // The page and the reader redraw when what they show changes, not
        // on every Studio snapshot.
        let shown = serde_json::json!([
            captions,
            capture["video"],
            capture["sources"]["microphoneId"],
            capture["sources"]["microphoneName"],
            capture["layout"]["layoutPreset"],
            snapshot.captions_status,
            snapshot.session.phase.is_active(),
            connected,
            room_open,
        ]);
        if self.shown.as_ref() != Some(&shown) {
            self.shown = Some(shown);
            cx.notify();
        }
        let suppressed =
            !room_open && captions_preflight::platform_unavailable_reason(platform()).is_some();
        if capturing && !self.was_capturing && self.lines.session_started() {
            cx.notify();
        }
        self.was_capturing = capturing;
        // The caption bar on the outputs.
        let status = Status::of(snapshot.captions_status.as_ref());
        let client = self.studio.backend().clone();
        self.burn.drive(
            &snapshot,
            self.lines.latest(),
            &status,
            room_open,
            capturing,
            connected,
            &client,
            &self.runtime,
            cx,
        );
        let scope = Scope {
            enabled,
            suppressed,
            capture: if room_open {
                Some(format!("room:{}", self.show_id().unwrap_or_default()))
            } else if capturing {
                Some(format!(
                    "capture:{}",
                    snapshot
                        .session
                        .status
                        .session_id
                        .clone()
                        .unwrap_or_default()
                ))
            } else {
                None
            },
            language: language.clone(),
            generation,
        };
        if self.scope.as_ref() != Some(&scope) {
            self.scope = Some(scope);
            self.start_attempted = false;
            self.stop_attempted = false;
        }
        if !connected || self.pending() {
            return;
        }
        match c::runtime_intent(
            enabled,
            suppressed,
            capturing,
            &status,
            self.start_attempted,
            self.stop_attempted,
        ) {
            RuntimeIntent::Start => {
                self.start_attempted = true;
                self.stop_attempted = false;
                self.start(language, cx);
            }
            RuntimeIntent::Stop => {
                self.start_attempted = false;
                self.stop_attempted = true;
                self.command(methods::STOP, Value::Null, cx);
            }
            RuntimeIntent::None => {}
        }
        // The backend draws the captioned copy's cues after capture stops,
        // so every look the session had is mirrored there.
        let session_active = snapshot.session.phase.is_active();
        if session_active && enabled && !suppressed {
            let style = c::style_params(captions);
            if self.style_sent.as_ref() != Some(&style) {
                self.style_sent = Some(style.clone());
                let client = self.studio.backend().clone();
                self.runtime.spawn(async move {
                    let _ = client.request(methods::STYLE_SET, style).await;
                });
            }
        } else {
            self.style_sent = None;
        }
    }

    pub(super) fn burn_mut(&mut self) -> &mut Burn {
        &mut self.burn
    }

    /// Runs the rules again (a read landed).
    pub(super) fn redrive(&mut self, cx: &mut Context<Self>) {
        self.drive(cx);
    }

    /// The latest line's dwell ran out.
    pub(super) fn dwell_ran_out(&mut self, ticket: u64, _cx: &mut Context<Self>) {
        let snapshot = self.studio.snapshot();
        let client = self.studio.backend().clone();
        self.burn.dwell_ran_out(
            ticket,
            self.lines.latest(),
            &snapshot.settings.capture_doc["captions"],
            &client,
            &self.runtime,
        );
    }

    /// `startCaptions(language)`: Retry, or the session's start.
    pub fn start(&mut self, language: String, cx: &mut Context<Self>) {
        self.start_error = None;
        self.lines.clear();
        self.command(methods::START, c::start_params(&language), cx);
    }

    fn command(&mut self, method: &'static str, params: Value, cx: &mut Context<Self>) {
        self.pending += 1;
        cx.notify();
        let client = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { client.request(method, params).await });
        cx.spawn(async move |entity, cx| {
            let result = job.await;
            let _ = entity.update(cx, |this, cx| {
                this.pending = this.pending.saturating_sub(1);
                if method == methods::START {
                    this.start_error = match result {
                        Ok(Ok(answer)) => {
                            let status = Status::of(Some(&answer));
                            (!status.is_active() && status.state != "ready").then(|| {
                                status.message.unwrap_or_else(|| {
                                    format!(
                                        "Live captions didn't start (status: {}).",
                                        status.state
                                    )
                                })
                            })
                        }
                        Ok(Err(error)) => Some(error.to_string()),
                        Err(_) => Some("Live captions didn't start.".into()),
                    };
                }
                this.drive(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn read_entitlements(&mut self, cx: &mut Context<Self>) {
        let client = self.studio.backend().clone();
        let job = self
            .runtime
            .spawn(async move { client.request(methods::ENTITLEMENTS_GET, Value::Null).await });
        cx.spawn(async move |entity, cx| {
            if let Ok(Ok(answer)) = job.await {
                let _ = entity.update(cx, |this, cx| {
                    if let Some(snapshot) = read_entitlements(&answer) {
                        this.entitlements = Some(snapshot);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }
}

/// The events the feed reads: its lines, the plan, and the cloud room.
fn wakes(event: &str) -> bool {
    matches!(
        event,
        methods::UPDATE_EVENT
            | methods::CLEARED_EVENT
            | methods::ENTITLEMENTS_EVENT
            | methods::OVERLAY_LAYOUT_EVENT
    ) || event.starts_with("cloud.")
}

fn read_entitlements(payload: &Value) -> Option<EntitlementsSnapshot> {
    serde_json::from_value(payload.clone())
        .ok()
        .or_else(|| serde_json::from_value(payload["snapshot"].clone()).ok())
}

/// `process.platform`'s words, as the caption rules read them.
pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}
