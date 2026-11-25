//! Global shortcuts (plan 260 S2.6a, part 2): the core's gate
//! (`desktop::global_shortcuts::GlobalShortcutGate`, Electron's
//! `global-shortcut-lifecycle.ts`) over the `global-hotkey` crate (Carbon
//! `RegisterEventHotKey` on macOS, which needs no Accessibility permission;
//! `RegisterHotKey` on Windows; X11 on Linux; Wayland has none, and says
//! so).
//!
//! Only an action the app can run registers ([`ShortcutActions`]): a global
//! key is never taken from every app for nothing. Each key goes to the OS
//! in its one spelling (`desktop::accelerator::normalize_accelerator`).
//! While the shortcut recorder is armed every app-owned key is released, a
//! change waits for the disarm, and 30 seconds without a disarm hand the
//! keys back (Electron main's rule).

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::str::FromStr;
use std::time::{Duration, Instant};

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use gpui::App;
use videorc_app_core::Logger;
use videorc_app_core::desktop::accelerator::normalize_accelerator;
use videorc_app_core::desktop::global_shortcuts::{
    GlobalShortcutGate, GlobalShortcutsConfig, RegistrationNotice, ShortcutRegistry,
    global_shortcut_entries, global_shortcut_label, registration_notice, unavailable_reason,
};

/// `SHORTCUT_RECORDER_IDLE_MS`: an armed recorder with no disarm hands the
/// keys back after this long.
const RECORDER_IDLE: Duration = Duration::from_secs(30);
/// How often the key presses are read on the main thread.
const POLL: Duration = Duration::from_millis(30);

/// Node's name for this platform (`process.platform`), which the core's
/// key spellings follow.
pub fn node_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// What the app can run when a global key fires. The Studio implements it
/// (Record, Go Live, Hide screen, the microphone, the scenes, the clips) as
/// it lands in the app; until then nothing registers.
pub trait ShortcutActions {
    /// Whether the app runs `action` now.
    fn supported(&self, action: &str) -> bool;
    /// `executeGlobalShortcut`.
    fn run(&self, action: &str);
}

/// Actions already owned by the Studio. Go Live waits for its confirmation
/// route; Hide screen waits for the app's privacy controller, so neither
/// steals a global key for a no-op.
pub struct StudioActions {
    pub studio: std::sync::Arc<videorc_app_core::Studio<videorc_app_core::BackendClient>>,
    pub runtime: tokio::runtime::Handle,
}
pub fn supported(action: &str) -> bool {
    matches!(
        action,
        "record-toggle"
            | "mic-toggle"
            | "system-audio-toggle"
            | "clip-mark"
            | "clip-mark-long"
            | "layout-next"
            | "layout-previous"
    ) || action.starts_with("scene:")
        || videorc_app_core::desktop::global_shortcuts::scene_slot_position(action).is_some()
}
impl ShortcutActions for StudioActions {
    fn supported(&self, action: &str) -> bool {
        supported(action)
    }
    fn run(&self, action: &str) {
        let studio = self.studio.clone();
        let action = action.to_string();
        self.runtime.spawn(async move {
            use videorc_app_core::studio::MicrophoneMode;
            use videorc_app_core::{SessionPhase, StopOrigin};
            let snapshot = studio.snapshot();
            match action.as_str() {
                "record-toggle" => match snapshot.session.phase {
                    SessionPhase::Idle | SessionPhase::Failed => {
                        studio.start_recording().await;
                    }
                    SessionPhase::Recording => {
                        studio.request_stop(StopOrigin::GlobalHotkey).await;
                    }
                    _ => {}
                },
                "mic-toggle" => {
                    studio.set_microphone_muted(MicrophoneMode::Toggle).await;
                }
                "system-audio-toggle" => {
                    studio
                        .set_system_audio_enabled(
                            !snapshot.settings.capture.audio.system_audio_enabled,
                        )
                        .await;
                }
                "clip-mark" => {
                    studio.mark_clip(Some(30)).await;
                }
                "clip-mark-long" => {
                    studio.mark_clip(Some(60)).await;
                }
                _ => {
                    let ids: Vec<&str> = snapshot
                        .scenes
                        .scenes
                        .iter()
                        .map(|s| s.id.as_str())
                        .collect();
                    let id = videorc_app_core::desktop::global_shortcuts::scene_for_action(
                        &action,
                        &ids,
                        snapshot.scenes.on_stream_id.as_deref(),
                    );
                    if let Some(id) = id {
                        studio.apply_saved_scene_by_id(&id).await;
                    }
                }
            }
        });
    }
}

/// An accelerator as `global-hotkey` reads it: Electron's spelling, with the
/// numpad operators by their full names.
fn to_hotkey(accelerator: &str) -> Result<HotKey, String> {
    let parts: Vec<&str> = accelerator
        .split('+')
        .map(|part| match part {
            "numsub" => "NumpadSubtract",
            "nummult" => "NumpadMultiply",
            "numdiv" => "NumpadDivide",
            "numdec" => "NumpadDecimal",
            other => other,
        })
        .collect();
    if parts.last() == Some(&"Plus") {
        return Err("the Plus key cannot be held globally".into());
    }
    HotKey::from_str(&parts.join("+")).map_err(|error| error.to_string())
}

/// The OS registry, as the core's gate drives it.
pub struct HotkeyRegistry {
    manager: GlobalHotKeyManager,
    /// accelerator → (the OS's key, the action)
    active: BTreeMap<String, (HotKey, String)>,
    logger: Logger,
}

impl ShortcutRegistry for HotkeyRegistry {
    fn register(&mut self, accelerator: &str, action: &str) -> Result<bool, String> {
        let hotkey = to_hotkey(accelerator)?;
        match self.manager.register(hotkey) {
            Ok(()) => {
                self.active
                    .insert(accelerator.to_string(), (hotkey, action.to_string()));
                Ok(true)
            }
            Err(error) => {
                self.logger.warn(format!(
                    "[shortcuts] {accelerator} for {action} was refused: {error}"
                ));
                Ok(false)
            }
        }
    }

    fn unregister(&mut self, accelerator: &str) {
        if let Some((hotkey, _)) = self.active.remove(accelerator) {
            let _ = self.manager.unregister(hotkey);
        }
    }
}

struct State {
    gate: Option<GlobalShortcutGate<HotkeyRegistry>>,
    actions: Rc<dyn ShortcutActions>,
    armed_at: Option<Instant>,
    result: videorc_app_core::desktop::global_shortcuts::GlobalShortcutsResult,
    logger: Logger,
}

/// The app's global shortcuts, on the main thread.
#[derive(Clone)]
pub struct Hotkeys {
    state: Rc<RefCell<State>>,
}

impl Hotkeys {
    /// Creates the OS registry and reads the key presses on the main thread.
    pub fn install(cx: &mut App, actions: Rc<dyn ShortcutActions>, logger: Logger) -> Self {
        let wayland = cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some();
        let unavailable =
            unavailable_reason(cfg!(target_os = "linux"), wayland).map(str::to_string);
        let gate = match GlobalHotKeyManager::new() {
            Ok(manager) => Some(GlobalShortcutGate::new(
                HotkeyRegistry {
                    manager,
                    active: BTreeMap::new(),
                    logger: logger.clone(),
                },
                unavailable,
            )),
            Err(error) => {
                logger.warn(format!("[shortcuts] no global shortcuts here: {error}"));
                None
            }
        };
        let hotkeys = Self {
            state: Rc::new(RefCell::new(State {
                gate,
                actions,
                armed_at: None,
                result: Default::default(),
                logger,
            })),
        };
        let pump = hotkeys.clone();
        cx.spawn(async move |cx| {
            loop {
                cx.background_executor().timer(POLL).await;
                while let Ok(event) = GlobalHotKeyEvent::receiver().try_recv() {
                    if event.state == HotKeyState::Pressed {
                        pump.fire(event.id);
                    }
                }
                pump.disarm_if_idle();
            }
        })
        .detach();
        hotkeys
    }

    /// The streamer's keys (`settings.globalShortcuts`), again on every
    /// change. `platform` is Node's name (`darwin`, `win32`, `linux`).
    pub fn apply(&self, config: &GlobalShortcutsConfig, platform: &str) {
        let mut state = self.state.borrow_mut();
        let mut requested = Vec::new();
        for (action, value) in global_shortcut_entries(config, Some(platform)) {
            let value = value
                .map(|value| normalize_accelerator(Some(&value), Some(platform)).unwrap_or(value));
            if state.actions.supported(&action) {
                requested.push((action, value));
            } else if let Some(key) = value.filter(|key| !key.trim().is_empty()) {
                state.logger.info(format!(
                    "[shortcuts] {key} for {} is left unregistered: the app can't run it yet",
                    global_shortcut_label(&action)
                ));
            }
        }
        let State {
            gate,
            logger,
            result: last_result,
            ..
        } = &mut *state;
        let Some(gate) = gate.as_mut() else {
            last_result.unavailable = Some("Global shortcuts didn't register".into());
            return;
        };
        let result = gate.apply(requested);
        *last_result = result.clone();
        match registration_notice(config, &result) {
            Some(RegistrationNotice::Problem { title, description }) => {
                logger.warn(format!("[shortcuts] {title}: {description}"))
            }
            Some(RegistrationNotice::Resolve) | Some(RegistrationNotice::Withdraw) | None => {}
        }
    }

    /// The Settings recorder armed (`true`) or disarmed: while armed every
    /// app-owned key is released so the recorder hears the combination.
    /// Settings → Shortcuts' recorder calls it when that page lands.
    #[allow(dead_code)]
    pub fn set_recorder_armed(&self, armed: bool) {
        let mut state = self.state.borrow_mut();
        let State { gate, armed_at, .. } = &mut *state;
        let Some(gate) = gate.as_mut() else {
            return;
        };
        if armed {
            gate.arm();
            *armed_at = Some(Instant::now());
        } else {
            let result = gate.disarm();
            *armed_at = None;
            if let Some(result) = result {
                state.result = result;
            }
        }
    }

    pub fn registration(
        &self,
    ) -> videorc_app_core::desktop::global_shortcuts::GlobalShortcutsResult {
        self.state.borrow().result.clone()
    }

    /// At quit: every key goes back to the OS.
    pub fn release_all(&self) {
        if let Some(gate) = self.state.borrow_mut().gate.as_mut() {
            gate.release_all();
        }
    }

    fn disarm_if_idle(&self) {
        let idle = self
            .state
            .borrow()
            .armed_at
            .is_some_and(|at| at.elapsed() >= RECORDER_IDLE);
        if idle {
            self.set_recorder_armed(false);
        }
    }

    fn fire(&self, id: u32) {
        let (action, actions) = {
            let state = self.state.borrow();
            let action = state.gate.as_ref().and_then(|gate| {
                gate.registry()
                    .active
                    .values()
                    .find(|(hotkey, _)| hotkey.id() == id)
                    .map(|(_, action)| action.clone())
            });
            (action, state.actions.clone())
        };
        // Run outside the borrow: an action may change the keys.
        if let Some(action) = action {
            actions.run(&action);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::to_hotkey;

    #[test]
    fn electron_spellings_reach_the_os_registry() {
        assert!(to_hotkey("Cmd+Shift+R").is_ok());
        assert!(to_hotkey("Ctrl+Alt+Shift+1").is_ok());
        assert!(to_hotkey("F13").is_ok());
        assert!(to_hotkey("Ctrl+numsub").is_ok());
        assert!(to_hotkey("Ctrl+Plus").is_err());
    }
}
