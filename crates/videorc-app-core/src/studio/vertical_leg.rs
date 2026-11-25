//! Plan 260 S1.6b part 4c-2 (L7): the vertical stream's live sends
//! (`use-studio.tsx`: `sendSimulcastLeg` and the two effects after it,
//! `legBorrowsScreen`), beside `vertical_stream`'s builders.
//!
//! - **After a commit.** A scene commit during a session sends the 9:16
//!   layout of the scene it puts or keeps on stream, over the committed
//!   program, at the backend's answer and again after its proof (that one
//!   only when the leg did not end on it). `scene_switch` calls
//!   [`Inner::queue_committed_leg`].
//! - **The scene on stream.** An edit of its 9:16 layout from a 16:9 studio
//!   (the Vertical stream panel) is no commit of the program: it goes live
//!   from here. Any other write of that scene derives the leg already sent,
//!   which is never sent twice ([`Inner::follow_vertical_leg`], after every
//!   publish, as the effect follows `sceneOnStream`).
//! - **Its own screen (plan 231 D18).** A leg that would draw a capture the
//!   scene doesn't own waits: the scene goes on again with its own screen,
//!   asked once per scene, screen and 9:16 layout.
//!
//! A send is an explicit leg request (`simulcastLeg`): the backend commits
//! it to the leg only and refuses it when no leg runs. The requests go out
//! in call order through one drain ([`Studio::drive`]'s), so the latest
//! derivation is the one the leg ends on.

use std::collections::VecDeque;
use std::sync::Arc;

use serde_json::{Value, json};

use super::capture_config::simulcast_armed;
use super::scene_switch::APPLY_LIVE_METHOD;
use super::vertical_stream::simulcast_leg_live_request_of;
use super::{Connection, Inner, Studio, StudioBackend};
use crate::scenes::v2::{Scene, layout_preset};
use crate::scenes::view::vertical_leg_borrows_screen;
use crate::user_error::backend_error_toast_without_context;

/// The live leg's bookkeeping.
#[derive(Debug, Default)]
pub(super) struct VerticalLeg {
    /// `lastSimulcastLegKeyRef`: the last request sent, as text.
    last_key: Option<String>,
    /// The requests waiting for the drain, in call order.
    queue: VecDeque<Value>,
    /// What the scene-on-stream effect last ran for (its dependencies: the
    /// scene on stream as stored, and the connection).
    followed: Option<(Option<Scene>, bool)>,
    /// `ownScreenAskedRef`: the scene, screen and 9:16 layout last asked for.
    own_screen_asked: Option<String>,
    /// The scene the drain puts on again with its own screen.
    own_screen_due: Option<String>,
}

impl Inner {
    /// The scene on stream, as the library holds it now.
    fn scene_on_stream_ref(&self) -> Option<&Scene> {
        let id = self.scenes.on_stream.as_deref()?;
        self.scenes
            .state
            .as_ref()?
            .library
            .scenes
            .iter()
            .find(|scene| scene.id == id)
    }

    /// `legBorrowsScreen` (plan 231 D18): the vertical leg would show a
    /// capture the scene on stream doesn't own, judged on the config as it
    /// is.
    fn leg_borrows_screen(&self, scene: &Scene) -> bool {
        let config = &self.capture.config;
        vertical_leg_borrows_screen(
            scene,
            &config["layout"],
            simulcast_armed(config),
            &self.working_shows(),
        )
    }

    /// `sendSimulcastLeg`: `scene`'s 9:16 layout over the program `config`,
    /// queued for the drain. Nothing while offline or with no session, or
    /// when no vertical stream is armed; `skip_if_unchanged` skips a request
    /// equal to the last one sent. True when a request was queued.
    pub(super) fn queue_vertical_leg(
        &mut self,
        config: &Value,
        scene: Option<&Scene>,
        skip_if_unchanged: bool,
    ) -> bool {
        if !matches!(self.connection, Connection::Connected { .. }) || !self.session.is_active() {
            return false;
        }
        let Some(mut request) = simulcast_leg_live_request_of(config, scene) else {
            return false;
        };
        let key = request.to_string();
        if skip_if_unchanged && self.vertical_leg.last_key.as_deref() == Some(key.as_str()) {
            return false;
        }
        self.vertical_leg.last_key = Some(key);
        // Echoed back, never registered: the leg must not supersede a
        // horizontal intent that is still in flight.
        request["intentId"] = json!(self.scenes.switch.intent().max(1));
        self.vertical_leg.queue.push_back(request);
        true
    }

    /// A commit's leg: the 9:16 layout of the scene the commit puts or keeps
    /// on stream (`saved_id`, else the one on stream), over the committed
    /// program (`{...captureConfigRef.current, sources, layout}`).
    pub(super) fn queue_committed_leg(
        &mut self,
        sources: &Value,
        layout: &Value,
        saved_id: Option<&str>,
        skip_if_unchanged: bool,
    ) -> bool {
        let mut config = self.capture.config.clone();
        if let Value::Object(map) = &mut config {
            map.insert("sources".into(), sources.clone());
            map.insert("layout".into(), layout.clone());
        }
        let scene = saved_id
            .map(str::to_string)
            .or_else(|| self.scenes.on_stream.clone())
            .and_then(|id| self.stored_scene(&id));
        self.queue_vertical_leg(&config, scene.as_ref(), skip_if_unchanged)
    }

    /// The two effects that follow the scene on stream, after a publish.
    /// True when the drain has work.
    pub(super) fn follow_vertical_leg(&mut self) -> bool {
        let connected = matches!(self.connection, Connection::Connected { .. });
        // The effect on `[sceneOnStream, sendSimulcastLeg]`: it runs when
        // the scene on stream (the stored scene, or which one it is) or the
        // connection changed, never for a change of the config alone.
        let changed = {
            let scene = self.scene_on_stream_ref();
            let unchanged = self
                .vertical_leg
                .followed
                .as_ref()
                .is_some_and(|(seen, was)| *was == connected && seen.as_ref() == scene);
            (!unchanged).then(|| scene.cloned())
        };
        let mut woke = false;
        if let Some(scene) = changed {
            self.vertical_leg.followed = Some((scene.clone(), connected));
            // A leg that would show a capture the scene doesn't own waits
            // for the scene to go on again with its own screen (below),
            // whose commit sends it.
            let borrows = scene
                .as_ref()
                .is_some_and(|scene| self.leg_borrows_screen(scene));
            if !borrows {
                let config = self.capture.config.clone();
                woke |= self.queue_vertical_leg(&config, scene.as_ref(), true);
            }
        }
        woke |= self.ask_for_own_screen(connected);
        woke
    }

    /// Plan 231 D18: the vertical leg starts drawing a screen for the scene
    /// on stream (its 9:16 layout edited, a vertical stream armed) while the
    /// capture is one an earlier scene left: the scene goes on again with
    /// its own screen. Asked once per scene, screen and 9:16 layout, so a
    /// refusal ("Figma isn't open") is said once. Never while a commit
    /// awaits its proof.
    fn ask_for_own_screen(&mut self, connected: bool) -> bool {
        if !connected || self.scenes.switch.awaits_proof() || !simulcast_armed(&self.capture.config)
        {
            return false;
        }
        let ask = {
            let Some(scene) = self.scene_on_stream_ref() else {
                return false;
            };
            if !self.leg_borrows_screen(scene) {
                return false;
            }
            (
                scene.id.clone(),
                format!(
                    "{}|{:?}|{}",
                    scene.id,
                    scene.shows,
                    layout_preset(&scene.vertical)
                ),
            )
        };
        let (id, ask) = ask;
        if self.vertical_leg.own_screen_asked.as_deref() == Some(ask.as_str()) {
            return false;
        }
        self.vertical_leg.own_screen_asked = Some(ask);
        self.vertical_leg.own_screen_due = Some(id);
        true
    }

    /// The drain's next work: a request to send, and the scene to put on
    /// again with its own screen.
    fn take_vertical_leg_work(&mut self) -> (Option<Value>, Option<String>) {
        let request = self.vertical_leg.queue.pop_front();
        // The scene goes on again once every request before it went out.
        let own_screen = if self.vertical_leg.queue.is_empty() {
            self.vertical_leg.own_screen_due.take()
        } else {
            None
        };
        (request, own_screen)
    }
}

impl<B: StudioBackend> Studio<B> {
    /// [`Self::drive`]'s drain of the live leg, its only drainer: woken by
    /// every pass that leaves work waiting.
    pub(super) async fn drain_vertical_leg_when_kicked(self: &Arc<Self>) {
        loop {
            self.vertical_leg_kick.notified().await;
            self.drain_vertical_leg().await;
        }
    }

    /// Sends what waits, in order, then puts the scene on stream on again
    /// when its leg borrows a screen. Never holds the Studio's lock across a
    /// request. The driver runs it; a test without a driver calls it.
    #[doc(hidden)]
    pub async fn drain_vertical_leg(self: &Arc<Self>) {
        loop {
            let (request, own_screen) = self.lock().take_vertical_leg_work();
            if request.is_none() && own_screen.is_none() {
                return;
            }
            if let Some(request) = request
                && let Err(error) = self.backend.scene_request(APPLY_LIVE_METHOD, request).await
            {
                // A request that raced Stop is refused by design; only a
                // failure while the session is still running is news. A
                // connection that went away rejects what it still had in
                // flight: that is teardown.
                let news = {
                    let inner = self.lock();
                    matches!(inner.connection, Connection::Connected { .. })
                        && inner.session.is_active()
                };
                self.config.logger.warn(format!(
                    "[scenes] the vertical stream's layout was not sent: {} ({})",
                    error.message, error.code
                ));
                if news && let Some(command) = backend_error_toast_without_context(&error, true) {
                    self.post(vec![command]);
                }
            }
            if let Some(id) = own_screen {
                let _ = self.apply_saved_scene_by_id(&id).await;
            }
        }
    }

    /// The live leg's drain has work.
    pub(super) fn kick_vertical_leg(&self) {
        self.vertical_leg_kick.notify_one();
    }
}
