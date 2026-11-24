//! Plan 220 S3.3a: Follow the app in front (plan 210 D10) and the
//! password-manager hide (D11), as the renderer's follower decides them
//! (`lib/follow-front-app.ts`'s `reduceFollowFrontApp`,
//! `hooks/use-follow-front-app.ts`'s `programScreenSource`,
//! `lib/privacy-settings.ts`'s `passwordManagerFollowContext`).
//!
//! The rules are pure: the app feeds them the front-app observer's events,
//! a tick at the settle deadline and the Studio's own changes, then runs
//! the actions through the Studio's apply and privacy paths. App names and
//! bundle ids never reach a log line.

use std::collections::HashMap;

use super::model::SavedScene;
use super::window::scene_for_front_app;
use crate::studio::families::{BUILT_IN_PASSWORD_MANAGERS, PrivacySettings};

/// D10's settle gate: an app must stay in front this long before the stream
/// follows it or a hidden screen shows again.
pub const FOLLOW_SETTLE_MS: u64 = 400;

/// The app in front (the observer's event).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontApp {
    pub bundle_id: String,
    pub name: String,
    pub pid: i32,
    pub front_window_id: Option<String>,
}

/// Why the screen is hidden (`ScreenHideReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HideReason {
    You,
    PasswordManager,
}

/// `FollowFrontAppState`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FollowState {
    pub front: Option<FrontApp>,
    pub since: u64,
    pub manual_hold: bool,
    pub hidden: bool,
    pub hide_reason: Option<HideReason>,
    pub issued: Option<String>,
}

/// `FollowFrontAppEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FollowEvent {
    FrontChanged(FrontApp),
    Tick(u64),
    ManualSwitch,
    HideChanged {
        hidden: bool,
        reason: Option<HideReason>,
    },
    SettingsChanged,
}

/// What the program shows, for D11 (only a whole display needs hiding).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenSource {
    Display,
    Window,
    App,
    None,
}

/// `FollowFrontAppContext`.
pub struct FollowContext<'a> {
    pub now: u64,
    pub scenes: &'a [SavedScene],
    pub last_used: &'a HashMap<String, u64>,
    pub follow_enabled: bool,
    pub password_manager_hide_enabled: bool,
    pub videorc_bundle_ids: &'a [String],
    /// Additions to the built-in list.
    pub password_manager_bundle_ids: &'a [String],
    /// Built-in ids taken off (removals win).
    pub removed_password_manager_bundle_ids: &'a [String],
    pub screen_source: ScreenSource,
    pub vertical: bool,
    pub current_scene_id: Option<&'a str>,
    pub current_window_id: Option<&'a str>,
    /// Plan 249: a cloud room's screen publication stays hidden until the
    /// streamer chooses Show, so the password-manager auto Show waits.
    pub explicit_show_required: bool,
}

/// `FollowFrontAppAction`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FollowAction {
    SwitchScene(String),
    SwapWindow(String),
    Hide,
    Show,
}

/// `reduceFollowFrontApp`: the 400 ms settle gate is D10's (a scene switch,
/// a window swap and the auto-show wait for the app in front to stay
/// there); the password-manager hide (D11) never waits, and the screen comes
/// back only once another app has held the front for the settle. Privacy
/// works with Follow off and during a manual scene hold. Orientation stays
/// within the Studio's.
pub fn reduce_follow(
    previous: &FollowState,
    event: &FollowEvent,
    context: &FollowContext<'_>,
) -> (FollowState, Vec<FollowAction>) {
    let mut state = previous.clone();
    let mut actions = Vec::new();
    let now = match event {
        FollowEvent::Tick(now) => *now,
        _ => context.now,
    };
    match event {
        FollowEvent::FrontChanged(front) => {
            let changed = state.front.as_ref().is_none_or(|current| {
                current.bundle_id.to_lowercase() != front.bundle_id.to_lowercase()
                    || current.pid != front.pid
            });
            if changed
                || state
                    .front
                    .as_ref()
                    .and_then(|f| f.front_window_id.as_ref())
                    != front.front_window_id.as_ref()
            {
                state.since = now;
                state.issued = None;
            }
            if changed {
                state.manual_hold = false;
            }
            state.front = Some(front.clone());
        }
        FollowEvent::ManualSwitch => {
            state.manual_hold = true;
            state.issued = None;
        }
        FollowEvent::HideChanged { hidden, reason } => {
            state.hidden = *hidden;
            state.hide_reason = if *hidden { *reason } else { None };
            return (state, actions);
        }
        FollowEvent::Tick(_) | FollowEvent::SettingsChanged => {}
    }
    let Some(front) = state.front.clone() else {
        return (state, actions);
    };
    let bundle = front.bundle_id.to_lowercase();
    let is_password_manager = {
        let built_in = BUILT_IN_PASSWORD_MANAGERS
            .iter()
            .flat_map(|(_, ids)| ids.iter())
            .any(|id| id.to_lowercase() == bundle);
        let added = context
            .password_manager_bundle_ids
            .iter()
            .any(|id| id.to_lowercase() == bundle);
        let removed = context
            .removed_password_manager_bundle_ids
            .iter()
            .any(|id| id.to_lowercase() == bundle);
        (built_in || added) && !removed
    };
    let should_hide = context.password_manager_hide_enabled
        && context.screen_source == ScreenSource::Display
        && is_password_manager;
    if should_hide && !state.hidden {
        actions.push(FollowAction::Hide);
        state.hidden = true;
        state.hide_reason = Some(HideReason::PasswordManager);
    }
    if now.saturating_sub(state.since) < FOLLOW_SETTLE_MS {
        return (state, actions);
    }
    if !context.explicit_show_required
        && !should_hide
        && state.hidden
        && state.hide_reason == Some(HideReason::PasswordManager)
    {
        actions.push(FollowAction::Show);
        state.hidden = false;
        state.hide_reason = None;
    }
    if !context.follow_enabled
        || state.manual_hold
        || context
            .videorc_bundle_ids
            .iter()
            .any(|id| id.to_lowercase() == bundle)
    {
        return (state, actions);
    }
    let Some(window) = front.front_window_id.clone() else {
        return (state, actions);
    };
    let Some(scene) = scene_for_front_app(
        context.scenes,
        &front.bundle_id,
        context.last_used,
        context.vertical,
    ) else {
        return (state, actions);
    };
    let key = format!("{}:{window}", scene.id);
    if state.issued.as_deref() == Some(key.as_str()) {
        return (state, actions);
    }
    if context.current_scene_id != Some(scene.id.as_str()) {
        actions.push(FollowAction::SwitchScene(scene.id.clone()));
        state.issued = Some(key);
    } else if Some(window.as_str()) != context.current_window_id {
        actions.push(FollowAction::SwapWindow(window));
        state.issued = Some(key);
    }
    (state, actions)
}

/// `programScreenSource`: what the program shows.
pub fn program_screen_source(
    active_is_app_scene: bool,
    window_id: Option<&str>,
    screen_id: Option<&str>,
    capture_off: bool,
) -> ScreenSource {
    if active_is_app_scene {
        ScreenSource::App
    } else if window_id.is_some_and(|id| !id.is_empty()) {
        ScreenSource::Window
    } else if screen_id.is_some_and(|id| !id.is_empty()) && !capture_off {
        ScreenSource::Display
    } else {
        ScreenSource::None
    }
}

/// `passwordManagerFollowContext`: the switch, the additions and the
/// removals; a list that would be empty gives the built-in one back (an
/// empty user list never means silence).
pub fn password_manager_context(settings: &PrivacySettings) -> (bool, Vec<String>, Vec<String>) {
    let added: Vec<String> = settings
        .added_password_managers
        .iter()
        .map(|app| app.bundle_id.clone())
        .collect();
    let removed = &settings.removed_password_manager_bundle_ids;
    let built_in_left = BUILT_IN_PASSWORD_MANAGERS.iter().any(|(_, ids)| {
        !ids.iter().all(|id| {
            removed
                .iter()
                .any(|gone| gone.to_lowercase() == id.to_lowercase())
        })
    });
    let empty = added.is_empty() && !built_in_left;
    (
        settings.hide_for_password_managers,
        added,
        if empty { Vec::new() } else { removed.clone() },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenes::model::normalize_scene_visual;
    use serde_json::json;

    fn app_scene(id: &str, bundle: &str) -> SavedScene {
        SavedScene {
            id: id.into(),
            name: id.into(),
            created_at: "t".into(),
            updated_at: "t".into(),
            visual: normalize_scene_visual(&json!({
                "layout": {"layoutPreset": "screen-only"},
                "sources": {"app": {"bundleId": bundle, "name": id, "follows": true}},
                "background": null,
            }))
            .unwrap(),
            audio: None,
            cloud: None,
        }
    }

    fn front(bundle: &str, pid: i32, window: Option<&str>) -> FollowEvent {
        FollowEvent::FrontChanged(FrontApp {
            bundle_id: bundle.into(),
            name: "App".into(),
            pid,
            front_window_id: window.map(str::to_string),
        })
    }

    fn context<'a>(
        now: u64,
        scenes: &'a [SavedScene],
        used: &'a HashMap<String, u64>,
        source: ScreenSource,
        current: Option<&'a str>,
    ) -> FollowContext<'a> {
        FollowContext {
            now,
            scenes,
            last_used: used,
            follow_enabled: true,
            password_manager_hide_enabled: true,
            videorc_bundle_ids: &[],
            password_manager_bundle_ids: &[],
            removed_password_manager_bundle_ids: &[],
            screen_source: source,
            vertical: false,
            current_scene_id: current,
            current_window_id: None,
            explicit_show_required: false,
        }
    }

    #[test]
    fn a_scene_follows_its_app_once_it_held_the_front_for_the_settle() {
        let scenes = vec![app_scene("alpha", "com.fixture.alpha")];
        let used = HashMap::new();
        let (state, actions) = reduce_follow(
            &FollowState::default(),
            &front("com.fixture.alpha", 7, Some("window:1")),
            &context(1000, &scenes, &used, ScreenSource::Window, None),
        );
        assert!(actions.is_empty(), "inside the settle");
        let (state, actions) = reduce_follow(
            &state,
            &FollowEvent::Tick(1401),
            &context(1401, &scenes, &used, ScreenSource::Window, None),
        );
        assert_eq!(actions, [FollowAction::SwitchScene("alpha".into())]);
        let (_, again) = reduce_follow(
            &state,
            &FollowEvent::Tick(1500),
            &context(1500, &scenes, &used, ScreenSource::Window, None),
        );
        assert!(again.is_empty(), "issued once");
        let (held, _) = reduce_follow(
            &state,
            &FollowEvent::ManualSwitch,
            &context(1600, &scenes, &used, ScreenSource::Window, None),
        );
        let (_, none) = reduce_follow(
            &held,
            &FollowEvent::Tick(2100),
            &context(2100, &scenes, &used, ScreenSource::Window, None),
        );
        assert!(
            none.is_empty(),
            "a manual switch holds until another app comes forward"
        );
    }

    #[test]
    fn a_password_manager_hides_at_once_and_shows_after_the_settle() {
        let used = HashMap::new();
        let (state, actions) = reduce_follow(
            &FollowState::default(),
            &front("com.1password.1password", 3, Some("window:2")),
            &context(10, &[], &used, ScreenSource::Display, None),
        );
        assert_eq!(actions, [FollowAction::Hide]);
        let (state, actions) = reduce_follow(
            &state,
            &front("com.apple.finder", 4, Some("window:3")),
            &context(20, &[], &used, ScreenSource::Display, None),
        );
        assert!(actions.is_empty());
        let (_, actions) = reduce_follow(
            &state,
            &FollowEvent::Tick(421),
            &context(421, &[], &used, ScreenSource::Display, None),
        );
        assert_eq!(actions, [FollowAction::Show]);
        let manual = FollowState {
            hidden: true,
            hide_reason: Some(HideReason::You),
            ..FollowState::default()
        };
        let (_, actions) = reduce_follow(
            &manual,
            &front("com.apple.finder", 4, None),
            &context(1000, &[], &used, ScreenSource::Display, None),
        );
        assert!(actions.is_empty(), "a hide the streamer asked for stays");
    }

    #[test]
    fn a_room_screen_publication_waits_for_an_explicit_show() {
        // Plan 249: the password-manager auto Show never reveals a cloud
        // room's screen; the streamer chooses Show.
        let used = HashMap::new();
        let (state, _) = reduce_follow(
            &FollowState::default(),
            &front("com.1password.1password", 3, Some("window:2")),
            &context(10, &[], &used, ScreenSource::Display, None),
        );
        let (state, _) = reduce_follow(
            &state,
            &front("com.apple.finder", 4, Some("window:3")),
            &context(20, &[], &used, ScreenSource::Display, None),
        );
        let room = FollowContext {
            explicit_show_required: true,
            ..context(421, &[], &used, ScreenSource::Display, None)
        };
        let (_, actions) = reduce_follow(&state, &FollowEvent::Tick(421), &room);
        assert!(actions.is_empty());
    }

    #[test]
    fn an_empty_list_falls_back_to_the_built_in_one() {
        let all: Vec<String> = BUILT_IN_PASSWORD_MANAGERS
            .iter()
            .flat_map(|(_, ids)| ids.iter().map(|id| (*id).to_string()))
            .collect();
        let settings = PrivacySettings {
            removed_password_manager_bundle_ids: all,
            ..PrivacySettings::default()
        };
        let (on, added, removed) = password_manager_context(&settings);
        assert!(on);
        assert!(added.is_empty());
        assert!(removed.is_empty());
        assert_eq!(
            program_screen_source(false, None, Some("screen:1"), false),
            ScreenSource::Display
        );
        assert_eq!(
            program_screen_source(true, Some("w"), None, false),
            ScreenSource::App
        );
    }
}
