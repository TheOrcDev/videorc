//! Captions on the outputs (Electron's burn-in driver, `use-studio.tsx`):
//! while a session runs with Live captions on, every new line or look goes to
//! the backend, which draws the bar into each compositor target the session
//! has (`captions.overlay.set`, or `cloud.speech.overlay` in a talk-show
//! room). The bar comes down when captions stop, the session ends, or the
//! line has shown for its dwell. Pushes are serial and latest-wins: one runs,
//! the newest waits, the partials between are dropped.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use gpui::{AsyncApp, Context, WeakEntity};
use serde_json::Value;
use videorc_app_core::captions::overlay::{self as o, Decision, Output};
use videorc_app_core::captions::{CaptionLine, Status, methods};
use videorc_app_core::studio::session::{SessionActivity, SessionStartIntent};
use videorc_app_core::{BackendClient, StudioSnapshot};

use super::feed::CaptionsFeed;

/// One push: the line, the look and the outputs it is drawn for.
struct Work {
    key: String,
    line: CaptionLine,
    captions: Value,
    outputs: Vec<Output>,
    room: bool,
    expires_at_ms: i64,
}

#[derive(Default)]
pub struct Burn {
    /// The captions rects (`overlays.layout.get` / `overlays.layout`).
    layout: Option<Value>,
    layout_generation: Option<u64>,
    /// Bumped by every clear: a push from before it never lands after it.
    epoch: Arc<AtomicU64>,
    pushed_key: Option<String>,
    /// A push is running; the newest waits in `pending`.
    running: bool,
    pending: Option<Work>,
    /// A bar is up or on its way.
    active: bool,
    /// The line whose dwell ran out, so it is not drawn again.
    expired: Option<String>,
    /// The latest line, when it last changed.
    latest: Option<(String, Instant)>,
    dwell_ticket: u64,
}

/// `remoteOutputIntent` for a running session: what it was started for, or
/// what it is doing.
fn session_intent(snapshot: &StudioSnapshot, capture: &Value) -> SessionStartIntent {
    if !snapshot.session.phase.is_active() {
        return SessionStartIntent {
            record: capture["recordEnabled"].as_bool().unwrap_or(false),
            stream: capture["streamEnabled"].as_bool().unwrap_or(false),
        };
    }
    snapshot
        .session
        .intent
        .unwrap_or(match snapshot.session.activity {
            SessionActivity::Recording => SessionStartIntent {
                record: true,
                stream: false,
            },
            SessionActivity::LiveStream => SessionStartIntent {
                record: false,
                stream: true,
            },
            SessionActivity::RecordAndStream => SessionStartIntent {
                record: true,
                stream: true,
            },
        })
}

impl Burn {
    /// `overlays.layout`: the streamer moved the captions in Scene.
    pub fn set_layout(&mut self, layout: Value) {
        self.layout = Some(layout);
    }

    /// A new connection: nothing it had is on screen any more.
    fn reset(&mut self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.pending = None;
        self.pushed_key = None;
        self.active = false;
    }

    /// The bar comes down now, on every target.
    fn clear(
        &mut self,
        client: &Arc<BackendClient>,
        runtime: &tokio::runtime::Handle,
        captions: &Value,
    ) {
        self.reset();
        let client = client.clone();
        let params = o::clear_params(captions);
        runtime.spawn(async move {
            let _ = client.request(methods::OVERLAY_CLEAR, params).await;
        });
    }

    /// Every change: the decision, then a push or a clear.
    #[allow(clippy::too_many_arguments)]
    pub fn drive(
        &mut self,
        snapshot: &StudioSnapshot,
        latest: Option<&CaptionLine>,
        status: &Status,
        room_open: bool,
        capturing: bool,
        connected: bool,
        client: &Arc<BackendClient>,
        runtime: &tokio::runtime::Handle,
        cx: &mut Context<CaptionsFeed>,
    ) {
        let generation = snapshot.connection_generation;
        if !connected {
            return;
        }
        if self.layout_generation != Some(generation) {
            self.layout_generation = Some(generation);
            self.reset();
            self.read_layout(client, runtime, cx);
        }
        let capture = &snapshot.settings.capture_doc;
        let captions = &capture["captions"];

        // The dwell clock restarts whenever the latest line changes.
        match latest {
            Some(line) => {
                let identity = format!("{}#{}", line.identity(), line.text);
                if self.latest.as_ref().map(|(id, _)| id) != Some(&identity) {
                    self.latest = Some((identity, Instant::now()));
                    self.expired = None;
                    self.schedule_dwell(o::expiry(line), cx);
                }
            }
            None => self.latest = None,
        }

        let session = o::session_config(capture, session_intent(snapshot, capture));
        let outputs = o::targets(&session, self.layout.as_ref(), room_open);
        let burn_in = !outputs.is_empty();
        let running = o::bar_running(status, latest, room_open);
        let candidate = latest.map(|line| o::key(line, captions, &outputs));
        let decision = o::decide(
            burn_in,
            running,
            capturing,
            latest,
            self.pushed_key.as_deref(),
            candidate,
            self.expired.as_deref(),
        );
        if decision == Decision::Clear || ((!burn_in || !running || !capturing) && self.active) {
            self.clear(client, runtime, captions);
            return;
        }
        let (Decision::Push(key), Some(line)) = (decision, latest) else {
            return;
        };
        if self.pending.as_ref().is_some_and(|work| work.key == key) {
            return;
        }
        let since = self
            .latest
            .as_ref()
            .map_or(Duration::ZERO, |(_, at)| at.elapsed());
        let expires_at_ms = chrono::Utc::now().timestamp_millis()
            + o::expiry(line).saturating_sub(since).as_millis() as i64;
        self.active = true;
        self.pending = Some(Work {
            key,
            line: line.clone(),
            captions: captions.clone(),
            outputs,
            room: room_open,
            expires_at_ms,
        });
        self.run(client, runtime, cx);
    }

    /// Runs the newest waiting push unless one is running.
    fn run(
        &mut self,
        client: &Arc<BackendClient>,
        runtime: &tokio::runtime::Handle,
        cx: &mut Context<CaptionsFeed>,
    ) {
        if self.running {
            return;
        }
        let Some(work) = self.pending.take() else {
            return;
        };
        self.running = true;
        let epoch = self.epoch.clone();
        let at = epoch.load(Ordering::SeqCst);
        let client_for_job = client.clone();
        let job = runtime.spawn(async move {
            let mut pushed = false;
            for output in &work.outputs {
                if epoch.load(Ordering::SeqCst) != at {
                    return None;
                }
                let (method, params) = if work.room {
                    (
                        methods::ROOM_OVERLAY,
                        o::room_params(&work.line, work.expires_at_ms, &work.captions, output),
                    )
                } else {
                    (
                        methods::OVERLAY_SET,
                        o::set_params(&work.line.text, &work.captions, output),
                    )
                };
                // One failed target never strands the rest or the next push.
                if client_for_job.request(method, params).await.is_ok() {
                    pushed = true;
                }
            }
            (pushed && epoch.load(Ordering::SeqCst) == at).then_some(work.key)
        });
        let client = client.clone();
        let runtime = runtime.clone();
        cx.spawn(
            async move |feed: WeakEntity<CaptionsFeed>, cx: &mut AsyncApp| {
                let key = job.await.ok().flatten();
                let _ = feed.update(cx, |feed, cx| {
                    let burn = feed.burn_mut();
                    burn.running = false;
                    if key.is_some() {
                        burn.pushed_key = key;
                    }
                    burn.run(&client, &runtime, cx);
                });
            },
        )
        .detach();
    }

    /// Takes the bar down once the latest line has shown for its dwell.
    fn schedule_dwell(&mut self, dwell: Duration, cx: &mut Context<CaptionsFeed>) {
        self.dwell_ticket = self.dwell_ticket.wrapping_add(1);
        let ticket = self.dwell_ticket;
        cx.spawn(
            async move |feed: WeakEntity<CaptionsFeed>, cx: &mut AsyncApp| {
                cx.background_executor().timer(dwell).await;
                let _ = feed.update(cx, |feed, cx| feed.dwell_ran_out(ticket, cx));
            },
        )
        .detach();
    }

    /// The latest line's dwell ran out: nothing newer came, so the bar goes.
    pub fn dwell_ran_out(
        &mut self,
        ticket: u64,
        latest: Option<&CaptionLine>,
        captions: &Value,
        client: &Arc<BackendClient>,
        runtime: &tokio::runtime::Handle,
    ) {
        if ticket != self.dwell_ticket || !self.active {
            return;
        }
        if let Some(line) = latest {
            self.expired = Some(line.identity());
        }
        self.clear(client, runtime, captions);
    }

    fn read_layout(
        &mut self,
        client: &Arc<BackendClient>,
        runtime: &tokio::runtime::Handle,
        cx: &mut Context<CaptionsFeed>,
    ) {
        let client = client.clone();
        let job = runtime.spawn(async move {
            client
                .request(methods::OVERLAY_LAYOUT_GET, Value::Null)
                .await
        });
        cx.spawn(
            async move |feed: WeakEntity<CaptionsFeed>, cx: &mut AsyncApp| {
                if let Ok(Ok(layout)) = job.await {
                    let _ = feed.update(cx, |feed, cx| {
                        feed.burn_mut().set_layout(layout);
                        feed.redrive(cx);
                    });
                }
            },
        )
        .detach();
    }
}
