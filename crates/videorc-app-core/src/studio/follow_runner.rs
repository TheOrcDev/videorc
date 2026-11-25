//! Plan 260 (L6): Follow the app in front (plan 210 D10) and the
//! password-manager hide (D11) on the GPUI app, as Electron's
//! `use-follow-front-app.ts` runs them. The rules are
//! [`crate::scenes::follow`]'s; this feeds them the front-app watcher's
//! events, a tick at the settle deadline and the Studio's own changes, then
//! runs their actions through the Studio's apply path and the backend's
//! `screen.hide` / `screen.show`.
//!
//! The watcher is the app's (NSWorkspace on macOS; other platforms say they
//! have none yet). App names and bundle ids never reach a log line.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use super::scene_switch::ApplyOptions;
use super::{Studio, StudioSnapshot};
use crate::client::{BackendClient, BackendEvent};
use crate::log::Logger;
use crate::protocol::{ScreenPrivacy, ScreenPrivacyReason};
use crate::scenes::follow::{
    FOLLOW_SETTLE_MS, FollowAction, FollowContext, FollowEvent, FollowState, FrontApp, HideReason,
    password_manager_context, program_screen_source, reduce_follow,
};

/// What the app's watcher hands the follower, and what it reads back.
pub struct FrontAppFeed {
    /// The app in front, each time it changes (or its front window does).
    pub sender: mpsc::UnboundedSender<FrontApp>,
    /// True while the scene on stream is an app scene and Follow is on: the
    /// watcher then also reads the front window every 500 ms
    /// (`setFrontWindowWatch`), so a window swap inside the app follows.
    pub watch_windows: Arc<AtomicBool>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// The on-stream scene is an app scene (`visual.sources.app`).
fn active_is_app_scene(snapshot: &StudioSnapshot) -> bool {
    let Some(id) = snapshot.scenes.on_stream_id.as_deref() else {
        return false;
    };
    snapshot
        .scenes
        .scenes
        .iter()
        .find(|scene| scene.id == id)
        .is_some_and(|scene| {
            let app = &scene.visual["sources"]["app"];
            !app.is_null() && app != &Value::Bool(false)
        })
}

/// What the follower reads besides the reducer's own state: the settings
/// the reducer needs re-checked when they change.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SettingsKey {
    follow: bool,
    privacy: (bool, Vec<String>, Vec<String>),
}

fn settings_key(snapshot: &StudioSnapshot) -> SettingsKey {
    SettingsKey {
        follow: snapshot.settings.families.follow.follow_front_app,
        privacy: password_manager_context(&snapshot.settings.families.privacy),
    }
}

struct Follower {
    studio: Arc<Studio<BackendClient>>,
    state: FollowState,
    last_used: HashMap<String, u64>,
    self_bundle_ids: Vec<String>,
    privacy: ScreenPrivacy,
    watch_windows: Arc<AtomicBool>,
    logger: Logger,
}

impl Follower {
    fn dispatch(&mut self, event: FollowEvent) {
        let snapshot = self.studio.snapshot();
        let (follow_enabled, (hide_enabled, added, removed)) = {
            let key = settings_key(&snapshot);
            (key.follow, key.privacy)
        };
        let sources = &snapshot.settings.capture.sources;
        let capture_off = snapshot.settings.capture_doc["sources"]["captureOff"]
            .as_bool()
            .unwrap_or(false);
        let layout_preset = serde_json::to_value(&snapshot.settings.capture.layout.layout_preset)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        let context = FollowContext {
            now: now_ms(),
            scenes: &snapshot.scenes.scenes,
            last_used: &self.last_used,
            follow_enabled,
            password_manager_hide_enabled: hide_enabled,
            videorc_bundle_ids: &self.self_bundle_ids,
            password_manager_bundle_ids: &added,
            removed_password_manager_bundle_ids: &removed,
            screen_source: program_screen_source(
                active_is_app_scene(&snapshot),
                sources.window_id.as_deref(),
                sources.screen_id.as_deref(),
                capture_off,
            ),
            vertical: layout_preset.starts_with("vertical-"),
            current_scene_id: snapshot.scenes.on_stream_id.as_deref(),
            current_window_id: sources.window_id.as_deref(),
            // A cloud room's screen publication (plan 249) is not on the
            // GPUI app yet; when it lands, its Show waits for the streamer.
            explicit_show_required: false,
        };
        let (state, actions) = reduce_follow(&self.state, &event, &context);
        self.state = state;
        for action in actions {
            self.run(action, &snapshot);
        }
        self.watch_windows.store(
            follow_enabled && active_is_app_scene(&self.studio.snapshot()),
            Ordering::Relaxed,
        );
    }

    fn run(&mut self, action: FollowAction, snapshot: &StudioSnapshot) {
        let studio = self.studio.clone();
        let logger = self.logger.clone();
        match action {
            FollowAction::SwitchScene(id) => {
                self.last_used.insert(id.clone(), now_ms());
                self.logger
                    .info("Follow: switching to the scene made for the app in front.");
                tokio::spawn(async move {
                    let options = ApplyOptions {
                        origin_follow: true,
                        ..ApplyOptions::default()
                    };
                    let _ = studio.apply_saved_scene(&id, None, options).await;
                });
            }
            FollowAction::SwapWindow(window) => {
                let Some(active) = snapshot.scenes.on_stream_id.clone() else {
                    return;
                };
                self.logger.info("Follow: swapping to the window in front.");
                tokio::spawn(async move {
                    let options = ApplyOptions {
                        origin_follow: true,
                        prefer_window: Some(window),
                        ..ApplyOptions::default()
                    };
                    let _ = studio.apply_saved_scene(&active, None, options).await;
                });
            }
            FollowAction::Hide => {
                self.logger
                    .info("Follow: hiding the screen for a password manager.");
                tokio::spawn(async move {
                    let reason = ScreenPrivacyReason::PasswordManager;
                    if let Err(error) = studio
                        .backend()
                        .request("screen.hide", json!({ "reason": reason }))
                        .await
                    {
                        logger.warn(format!("Follow: the password-manager hide failed: {error}"));
                    }
                });
            }
            FollowAction::Show => {
                // A hide the streamer asked for is never undone here.
                if !(self.privacy.hidden
                    && self.privacy.reason == Some(ScreenPrivacyReason::PasswordManager))
                {
                    return;
                }
                self.logger.info("Follow: showing the screen again.");
                tokio::spawn(async move {
                    if let Err(error) = studio.backend().request("screen.show", Value::Null).await {
                        logger.warn(format!("Follow: showing the screen again failed: {error}"));
                    }
                });
            }
        }
    }

    fn privacy_changed(&mut self, privacy: ScreenPrivacy) {
        let reason = privacy.reason.map(|reason| match reason {
            ScreenPrivacyReason::You => HideReason::You,
            ScreenPrivacyReason::PasswordManager => HideReason::PasswordManager,
        });
        let hidden = privacy.hidden;
        self.privacy = privacy;
        self.dispatch(FollowEvent::HideChanged { hidden, reason });
    }
}

/// Starts the follower on the core's runtime and hands back the feed the
/// app's watcher writes to. `self_bundle_ids` are Videorc's own, never
/// followed (the app id and the bundle's, when it has one).
pub fn start(
    runtime: &tokio::runtime::Handle,
    studio: Arc<Studio<BackendClient>>,
    self_bundle_ids: Vec<String>,
    logger: Logger,
) -> FrontAppFeed {
    let (sender, mut fronts) = mpsc::unbounded_channel::<FrontApp>();
    let watch_windows = Arc::new(AtomicBool::new(false));
    let mut events = studio.backend().subscribe();
    let mut manual = studio.manual_scene_applies();
    let mut snapshots = studio.watch();
    let mut follower = Follower {
        studio: studio.clone(),
        state: FollowState::default(),
        last_used: HashMap::new(),
        self_bundle_ids,
        privacy: ScreenPrivacy::default(),
        watch_windows: watch_windows.clone(),
        logger,
    };
    runtime.spawn(async move {
        // The hide state at start; `screen.privacy.changed` keeps it after.
        if let Ok(value) = studio
            .backend()
            .request("screen.privacy.get", Value::Null)
            .await
            && let Ok(privacy) = serde_json::from_value::<ScreenPrivacy>(value)
        {
            follower.privacy = privacy;
        }
        let mut settings = settings_key(&studio.snapshot());
        let mut tick_at: Option<tokio::time::Instant> = None;
        loop {
            let tick = async {
                match tick_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                front = fronts.recv() => {
                    let Some(front) = front else { break };
                    if front.bundle_id.is_empty() {
                        continue;
                    }
                    follower.dispatch(FollowEvent::FrontChanged(front));
                    tick_at = Some(
                        tokio::time::Instant::now() + Duration::from_millis(FOLLOW_SETTLE_MS + 1),
                    );
                }
                () = tick => {
                    tick_at = None;
                    follower.dispatch(FollowEvent::Tick(now_ms()));
                }
                applied = manual.recv() => match applied {
                    Ok(id) => {
                        follower.last_used.insert(id, now_ms());
                        follower.dispatch(FollowEvent::ManualSwitch);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                event = events.recv() => match event {
                    Ok(BackendEvent::Untyped { event, payload })
                        if event == "screen.privacy.changed" =>
                    {
                        if let Ok(privacy) = serde_json::from_value::<ScreenPrivacy>(payload) {
                            follower.privacy_changed(privacy);
                        }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                changed = snapshots.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let next = settings_key(&snapshots.borrow_and_update());
                    if next != settings {
                        settings = next;
                        follower.dispatch(FollowEvent::SettingsChanged);
                    }
                }
            }
        }
    });
    FrontAppFeed {
        sender,
        watch_windows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_is_milliseconds_since_the_epoch() {
        // After 2026-01-01 and before 2100: milliseconds, not seconds.
        let now = now_ms();
        assert!(now > 1_767_225_600_000 && now < 4_102_444_800_000, "{now}");
    }
}
