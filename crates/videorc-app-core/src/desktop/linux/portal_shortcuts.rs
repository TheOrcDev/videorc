//! Global shortcuts on Wayland through the GlobalShortcuts portal (plan 257
//! S11, plan 260 S2.6c).
//!
//! Wayland gives no app a key grab, and Chromium's portal route never worked
//! ("An app id is required"), so Electron only ever said why the keys could
//! not fire (`global-shortcut-lifecycle.ts`). The GPUI app binds them itself:
//! it registers the app id `videorc` with the portal host Registry (the
//! managed `videorc.desktop`, [`super::desktop_entry`]), creates a session,
//! binds the whole list with descriptions and preferred triggers, and maps
//! `Activated` back to the action. The desktop shows its own bind dialog and
//! owns the keys from then on.
//!
//! The portal works on whole sessions, not single keys, so this is not
//! L7's per-key `ShortcutRegistry`: a changed list closes the session and
//! binds a new one. D-Bus is behind [`GlobalShortcutsPortal`] (the S2.1
//! implementation is the app's, on a worker thread); tests use a fake.

use std::collections::BTreeMap;

/// The app id the portal host Registry knows Videorc by.
pub const PORTAL_APP_ID: &str = "videorc";

/// Settings → Shortcuts under a portal: the desktop owns the keys.
pub const PORTAL_OWNS_KEYS_HINT: &str = "Change in your desktop's settings";

/// No portal on this desktop implements GlobalShortcuts (GNOME 46, Ubuntu
/// 24.04): today's reason, pointing to Phone remote and Stream Deck.
pub const PORTAL_MISSING_REASON: &str = "Global shortcuts can't work in this Wayland session: your desktop has no GlobalShortcuts portal. App shortcuts still work while Videorc is in front, and Phone remote and Stream Deck work while it is in the background.";

/// The portal is there but refused the session.
pub const PORTAL_FAILED_REASON: &str = "Your desktop's GlobalShortcuts portal didn't answer, so global shortcuts are off. Restart Videorc to try again; Phone remote and Stream Deck still work.";

/// One shortcut to bind: Videorc's action, its Settings label and the key
/// the streamer chose (an Electron accelerator, as Settings stores it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalShortcut {
    pub id: String,
    pub description: String,
    pub accelerator: Option<String>,
}

/// What `BindShortcuts` sends for one shortcut.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindRequest {
    pub id: String,
    pub description: String,
    /// `preferred_trigger` in the shortcuts spec's form (`CTRL+ALT+h`).
    pub preferred_trigger: Option<String>,
}

/// One shortcut the desktop bound, with the trigger it chose, in its words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundShortcut {
    pub id: String,
    pub trigger_description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalError {
    /// No portal backend offers the interface.
    NotAvailable,
    /// The streamer closed the desktop's bind dialog.
    Cancelled,
    Failed(String),
}

/// A session's object path.
pub type SessionHandle = String;

/// The portal calls the client needs.
pub trait GlobalShortcutsPortal {
    /// `org.freedesktop.portal.GlobalShortcuts`'s version; `None` when no
    /// backend implements it.
    fn version(&mut self) -> Result<Option<u32>, PortalError>;
    /// `org.freedesktop.host.portal.Registry.Register` (xdg-desktop-portal
    /// 1.19+). An older portal without the Registry is not an error.
    fn register_app_id(&mut self, app_id: &str) -> Result<(), PortalError>;
    fn create_session(&mut self) -> Result<SessionHandle, PortalError>;
    fn bind(
        &mut self,
        session: &SessionHandle,
        shortcuts: &[BindRequest],
    ) -> Result<Vec<BoundShortcut>, PortalError>;
    fn close_session(&mut self, session: &SessionHandle);
}

/// What one apply did, for Settings → Shortcuts and the registrar's notice.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PortalShortcutsResult {
    /// Each requested action: true when the desktop bound it.
    pub registered: BTreeMap<String, bool>,
    /// The trigger the desktop assigned, in its words, per bound action.
    pub triggers: BTreeMap<String, String>,
    /// This session can hold no global shortcut, and why.
    pub unavailable: Option<String>,
    /// The streamer closed the bind dialog; nothing is bound until the list
    /// changes or [`PortalShortcuts::retry`].
    pub cancelled: bool,
}

/// An Electron accelerator (`Control+Alt+H`, `CommandOrControl+Shift+1`)
/// in the shortcuts spec's trigger form (`CTRL+ALT+h`, `CTRL+SHIFT+1`):
/// modifiers `CTRL`, `ALT`, `SHIFT`, `LOGO`, then one XKB keysym name.
/// `None` when a part has no keysym; the desktop then asks for a key.
pub fn xdg_trigger(accelerator: &str) -> Option<String> {
    let parts: Vec<&str> = accelerator
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    // `Plus` is the only way to name `+`; a trailing empty part is a typo.
    let (key, modifiers) = parts.split_last()?;
    let mut flags = [false; 4];
    for modifier in modifiers {
        let index = match modifier.to_ascii_lowercase().as_str() {
            "control" | "ctrl" | "commandorcontrol" | "cmdorctrl" => 0,
            "alt" | "option" | "altgr" => 1,
            "shift" => 2,
            "super" | "meta" | "command" | "cmd" => 3,
            _ => return None,
        };
        flags[index] = true;
    }
    let mut out: Vec<String> = ["CTRL", "ALT", "SHIFT", "LOGO"]
        .iter()
        .zip(flags)
        .filter(|(_, on)| *on)
        .map(|(name, _)| name.to_string())
        .collect();
    out.push(keysym(key)?);
    Some(out.join("+"))
}

fn keysym(key: &str) -> Option<String> {
    let lower = key.to_ascii_lowercase();
    if key.len() == 1 {
        let c = key.chars().next()?;
        if c.is_ascii_alphanumeric() {
            return Some(c.to_ascii_lowercase().to_string());
        }
        let name = match c {
            '-' => "minus",
            '=' => "equal",
            ',' => "comma",
            '.' => "period",
            '/' => "slash",
            ';' => "semicolon",
            '\'' => "apostrophe",
            '[' => "bracketleft",
            ']' => "bracketright",
            '\\' => "backslash",
            '`' => "grave",
            _ => return None,
        };
        return Some(name.to_string());
    }
    if let Some(n) = lower.strip_prefix('f')
        && let Ok(n) = n.parse::<u8>()
        && (1..=24).contains(&n)
    {
        return Some(format!("F{n}"));
    }
    if let Some(n) = lower.strip_prefix("num")
        && n.len() == 1
        && n.chars().all(|c| c.is_ascii_digit())
    {
        return Some(format!("KP_{n}"));
    }
    let name = match lower.as_str() {
        "plus" => "plus",
        "space" => "space",
        "tab" => "Tab",
        "backspace" => "BackSpace",
        "delete" => "Delete",
        "insert" => "Insert",
        "return" | "enter" => "Return",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        "home" => "Home",
        "end" => "End",
        "pageup" => "Page_Up",
        "pagedown" => "Page_Down",
        "escape" | "esc" => "Escape",
        "printscreen" => "Print",
        "numadd" => "KP_Add",
        "numsub" => "KP_Subtract",
        "nummult" => "KP_Multiply",
        "numdiv" => "KP_Divide",
        "numdec" => "KP_Decimal",
        "volumeup" => "XF86AudioRaiseVolume",
        "volumedown" => "XF86AudioLowerVolume",
        "volumemute" => "XF86AudioMute",
        "medianexttrack" => "XF86AudioNext",
        "mediaprevioustrack" => "XF86AudioPrev",
        "mediastop" => "XF86AudioStop",
        "mediaplaypause" => "XF86AudioPlay",
        _ => return None,
    };
    Some(name.to_string())
}

fn bind_requests(requested: &[PortalShortcut]) -> Vec<BindRequest> {
    requested
        .iter()
        .map(|shortcut| BindRequest {
            id: shortcut.id.clone(),
            description: shortcut.description.clone(),
            preferred_trigger: shortcut
                .accelerator
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(xdg_trigger),
        })
        .collect()
}

/// Videorc's GlobalShortcuts session: one at a time, rebound when the list
/// changes, and `Activated` read only from the current one.
pub struct PortalShortcuts<P: GlobalShortcutsPortal> {
    portal: P,
    /// `Some` once the portal was asked; `None` until the first apply.
    supported: Option<bool>,
    registered_app_id: bool,
    session: Option<SessionHandle>,
    requested: Vec<BindRequest>,
    bound: BTreeMap<String, String>,
    last: PortalShortcutsResult,
}

impl<P: GlobalShortcutsPortal> PortalShortcuts<P> {
    pub fn new(portal: P) -> Self {
        Self {
            portal,
            supported: None,
            registered_app_id: false,
            session: None,
            requested: Vec::new(),
            bound: BTreeMap::new(),
            last: PortalShortcutsResult::default(),
        }
    }

    pub fn portal(&self) -> &P {
        &self.portal
    }

    pub fn session(&self) -> Option<&SessionHandle> {
        self.session.as_ref()
    }

    /// Binds `requested` unless it is what the current session holds.
    pub fn apply(&mut self, requested: &[PortalShortcut]) -> PortalShortcutsResult {
        let wanted = bind_requests(requested);
        if wanted == self.requested && (self.session.is_some() || self.last.unavailable.is_some()) {
            return self.last.clone();
        }
        self.requested = wanted;
        self.bind_requested()
    }

    /// After a cancelled dialog or a closed session: bind the same list again.
    pub fn retry(&mut self) -> PortalShortcutsResult {
        self.bind_requested()
    }

    fn bind_requested(&mut self) -> PortalShortcutsResult {
        self.close();
        let result = self.try_bind();
        self.last = result.clone();
        result
    }

    fn try_bind(&mut self) -> PortalShortcutsResult {
        let refused =
            |requested: &[BindRequest], unavailable: Option<&str>| PortalShortcutsResult {
                registered: requested
                    .iter()
                    .map(|request| (request.id.clone(), false))
                    .collect(),
                triggers: BTreeMap::new(),
                unavailable: unavailable.map(str::to_string),
                cancelled: false,
            };
        if self.supported.is_none() {
            self.supported = Some(matches!(self.portal.version(), Ok(Some(_))));
        }
        if self.supported == Some(false) {
            return refused(&self.requested, Some(PORTAL_MISSING_REASON));
        }
        if self.requested.is_empty() {
            return PortalShortcutsResult::default();
        }
        if !self.registered_app_id {
            // An old portal without the host Registry reads the app id from
            // the sandbox or the `.desktop` match; carry on either way.
            let _ = self.portal.register_app_id(PORTAL_APP_ID);
            self.registered_app_id = true;
        }
        let session = match self.portal.create_session() {
            Ok(session) => session,
            Err(PortalError::NotAvailable) => {
                self.supported = Some(false);
                return refused(&self.requested, Some(PORTAL_MISSING_REASON));
            }
            Err(_) => return refused(&self.requested, Some(PORTAL_FAILED_REASON)),
        };
        match self.portal.bind(&session, &self.requested) {
            Ok(bound) => {
                self.bound = bound
                    .into_iter()
                    .filter(|shortcut| self.requested.iter().any(|r| r.id == shortcut.id))
                    .map(|shortcut| (shortcut.id, shortcut.trigger_description))
                    .collect();
                self.session = Some(session);
                PortalShortcutsResult {
                    registered: self
                        .requested
                        .iter()
                        .map(|request| (request.id.clone(), self.bound.contains_key(&request.id)))
                        .collect(),
                    triggers: self.bound.clone(),
                    unavailable: None,
                    cancelled: false,
                }
            }
            Err(error) => {
                self.portal.close_session(&session);
                let mut result = refused(
                    &self.requested,
                    match error {
                        PortalError::Cancelled => None,
                        _ => Some(PORTAL_FAILED_REASON),
                    },
                );
                result.cancelled = error == PortalError::Cancelled;
                result
            }
        }
    }

    /// `Activated` from the portal: the action, when the signal is from the
    /// current session and names a bound shortcut.
    pub fn activated(&self, session: &str, id: &str) -> Option<&str> {
        if self.session.as_deref() != Some(session) {
            return None;
        }
        self.bound.get_key_value(id).map(|(id, _)| id.as_str())
    }

    /// `ShortcutsChanged`: the streamer changed a trigger in the desktop's
    /// settings. Returns the new result for Settings → Shortcuts.
    pub fn shortcuts_changed(
        &mut self,
        session: &str,
        shortcuts: Vec<BoundShortcut>,
    ) -> Option<PortalShortcutsResult> {
        if self.session.as_deref() != Some(session) {
            return None;
        }
        for shortcut in shortcuts {
            if let Some(trigger) = self.bound.get_mut(&shortcut.id) {
                *trigger = shortcut.trigger_description;
            }
        }
        self.last.triggers = self.bound.clone();
        Some(self.last.clone())
    }

    /// The session's `Closed` signal (the portal went away): nothing is bound
    /// until [`Self::retry`].
    pub fn session_closed(&mut self, session: &str) {
        if self.session.as_deref() == Some(session) {
            self.session = None;
            self.bound.clear();
            self.last.registered.values_mut().for_each(|ok| *ok = false);
            self.last.triggers.clear();
        }
    }

    /// At quit, or before binding a new list.
    pub fn close(&mut self) {
        if let Some(session) = self.session.take() {
            self.portal.close_session(&session);
        }
        self.bound.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakePortal {
        version: Option<u32>,
        registry_missing: bool,
        create_error: Option<PortalError>,
        bind_error: Option<PortalError>,
        /// Ids the desktop refuses to bind (another app holds the key).
        refuse: Vec<String>,
        sessions: u32,
        calls: Vec<String>,
        binds: Vec<Vec<BindRequest>>,
    }

    impl GlobalShortcutsPortal for FakePortal {
        fn version(&mut self) -> Result<Option<u32>, PortalError> {
            self.calls.push("version".into());
            Ok(self.version)
        }

        fn register_app_id(&mut self, app_id: &str) -> Result<(), PortalError> {
            self.calls.push(format!("register {app_id}"));
            if self.registry_missing {
                Err(PortalError::Failed("no Registry".into()))
            } else {
                Ok(())
            }
        }

        fn create_session(&mut self) -> Result<SessionHandle, PortalError> {
            if let Some(error) = self.create_error.clone() {
                return Err(error);
            }
            self.sessions += 1;
            let session = format!("/session/{}", self.sessions);
            self.calls.push(format!("create {session}"));
            Ok(session)
        }

        fn bind(
            &mut self,
            session: &SessionHandle,
            shortcuts: &[BindRequest],
        ) -> Result<Vec<BoundShortcut>, PortalError> {
            self.calls.push(format!("bind {session}"));
            self.binds.push(shortcuts.to_vec());
            if let Some(error) = self.bind_error.clone() {
                return Err(error);
            }
            Ok(shortcuts
                .iter()
                .filter(|s| !self.refuse.contains(&s.id))
                .map(|s| BoundShortcut {
                    id: s.id.clone(),
                    trigger_description: s
                        .preferred_trigger
                        .clone()
                        .unwrap_or_else(|| "Unassigned".into()),
                })
                .collect())
        }

        fn close_session(&mut self, session: &SessionHandle) {
            self.calls.push(format!("close {session}"));
        }
    }

    fn shortcut(id: &str, accelerator: Option<&str>) -> PortalShortcut {
        PortalShortcut {
            id: id.into(),
            description: format!("{id} label"),
            accelerator: accelerator.map(str::to_string),
        }
    }

    fn portal() -> FakePortal {
        FakePortal {
            version: Some(1),
            ..FakePortal::default()
        }
    }

    #[test]
    fn writes_electron_accelerators_as_shortcuts_spec_triggers() {
        assert_eq!(xdg_trigger("Control+Alt+H").as_deref(), Some("CTRL+ALT+h"));
        assert_eq!(
            xdg_trigger("CommandOrControl+Shift+1").as_deref(),
            Some("CTRL+SHIFT+1")
        );
        assert_eq!(
            xdg_trigger("Shift+Alt+Control+9").as_deref(),
            Some("CTRL+ALT+SHIFT+9")
        );
        assert_eq!(xdg_trigger("Super+F12").as_deref(), Some("LOGO+F12"));
        assert_eq!(xdg_trigger("Control+Plus").as_deref(), Some("CTRL+plus"));
        assert_eq!(
            xdg_trigger("Alt+PageDown").as_deref(),
            Some("ALT+Page_Down")
        );
        assert_eq!(xdg_trigger("Control+num5").as_deref(), Some("CTRL+KP_5"));
        assert_eq!(xdg_trigger("Control+/").as_deref(), Some("CTRL+slash"));
        assert_eq!(
            xdg_trigger("MediaPlayPause").as_deref(),
            Some("XF86AudioPlay")
        );
    }

    #[test]
    fn leaves_a_key_without_a_keysym_to_the_desktop() {
        assert_eq!(xdg_trigger(""), None);
        assert_eq!(xdg_trigger("Control+"), None);
        assert_eq!(xdg_trigger("Hyper+H"), None);
        assert_eq!(xdg_trigger("Control+F25"), None);
        assert_eq!(xdg_trigger("Control+§"), None);
    }

    #[test]
    fn registers_the_app_id_then_binds_the_list_with_preferred_triggers() {
        let mut shortcuts = PortalShortcuts::new(portal());
        let result = shortcuts.apply(&[
            shortcut("record", Some("Control+Alt+R")),
            shortcut("scene-slot-1", Some("Control+Alt+Shift+1")),
            shortcut("go-live", None),
        ]);
        assert_eq!(
            shortcuts.portal().calls,
            [
                "version",
                "register videorc",
                "create /session/1",
                "bind /session/1"
            ]
        );
        let sent = &shortcuts.portal().binds[0];
        assert_eq!(sent[0].preferred_trigger.as_deref(), Some("CTRL+ALT+r"));
        assert_eq!(sent[0].description, "record label");
        assert_eq!(sent[2].preferred_trigger, None);
        assert!(result.registered.values().all(|ok| *ok));
        assert_eq!(result.triggers["scene-slot-1"], "CTRL+ALT+SHIFT+1");
        assert_eq!(result.unavailable, None);
    }

    #[test]
    fn says_what_the_desktop_refused() {
        let mut fake = portal();
        fake.refuse = vec!["record".into()];
        let mut shortcuts = PortalShortcuts::new(fake);
        let result = shortcuts.apply(&[
            shortcut("record", Some("Control+Alt+R")),
            shortcut("go-live", Some("Control+Alt+G")),
        ]);
        assert!(!result.registered["record"]);
        assert!(result.registered["go-live"]);
        assert!(!result.triggers.contains_key("record"));
        assert_eq!(shortcuts.activated("/session/1", "record"), None);
    }

    #[test]
    fn keeps_the_session_for_the_same_list_and_rebinds_a_changed_one() {
        let mut shortcuts = PortalShortcuts::new(portal());
        let list = [shortcut("record", Some("Control+Alt+R"))];
        shortcuts.apply(&list);
        shortcuts.apply(&list);
        assert_eq!(shortcuts.portal().sessions, 1);
        shortcuts.apply(&[shortcut("record", Some("Control+Alt+T"))]);
        assert_eq!(shortcuts.portal().sessions, 2);
        assert!(
            shortcuts
                .portal()
                .calls
                .contains(&"close /session/1".to_string())
        );
        assert_eq!(shortcuts.session().map(String::as_str), Some("/session/2"));
    }

    #[test]
    fn maps_activated_from_the_current_session_only() {
        let mut shortcuts = PortalShortcuts::new(portal());
        shortcuts.apply(&[shortcut("record", Some("Control+Alt+R"))]);
        assert_eq!(shortcuts.activated("/session/1", "record"), Some("record"));
        assert_eq!(shortcuts.activated("/session/1", "go-live"), None);
        shortcuts.apply(&[shortcut("record", Some("Control+Alt+T"))]);
        // A late signal from the session just closed.
        assert_eq!(shortcuts.activated("/session/1", "record"), None);
        assert_eq!(shortcuts.activated("/session/2", "record"), Some("record"));
    }

    #[test]
    fn says_so_when_no_portal_implements_global_shortcuts() {
        let mut shortcuts = PortalShortcuts::new(FakePortal::default());
        let result = shortcuts.apply(&[shortcut("record", Some("Control+Alt+R"))]);
        assert_eq!(result.unavailable.as_deref(), Some(PORTAL_MISSING_REASON));
        assert!(!result.registered["record"]);
        // Asked once; a new list does not ask again.
        shortcuts.apply(&[shortcut("go-live", None)]);
        assert_eq!(shortcuts.portal().calls, ["version"]);
        assert!(PORTAL_MISSING_REASON.contains("Phone remote and Stream Deck"));
    }

    #[test]
    fn binds_on_a_portal_without_the_host_registry() {
        let mut fake = portal();
        fake.registry_missing = true;
        let mut shortcuts = PortalShortcuts::new(fake);
        let result = shortcuts.apply(&[shortcut("record", Some("Control+Alt+R"))]);
        assert!(result.registered["record"]);
        shortcuts.apply(&[shortcut("record", Some("Control+Alt+T"))]);
        let registers = shortcuts
            .portal()
            .calls
            .iter()
            .filter(|call| call.starts_with("register"))
            .count();
        assert_eq!(registers, 1);
    }

    #[test]
    fn a_closed_dialog_binds_nothing_and_retry_asks_again() {
        let mut fake = portal();
        fake.bind_error = Some(PortalError::Cancelled);
        let mut shortcuts = PortalShortcuts::new(fake);
        let list = [shortcut("record", Some("Control+Alt+R"))];
        let result = shortcuts.apply(&list);
        assert!(result.cancelled);
        assert_eq!(result.unavailable, None);
        assert!(!result.registered["record"]);
        assert_eq!(shortcuts.session(), None);
        assert!(
            shortcuts
                .portal()
                .calls
                .contains(&"close /session/1".to_string())
        );
        // The same list after a cancel binds again rather than replaying it.
        shortcuts.apply(&list);
        assert_eq!(shortcuts.portal().binds.len(), 2);
    }

    #[test]
    fn a_failing_portal_says_why() {
        let mut fake = portal();
        fake.create_error = Some(PortalError::Failed("timeout".into()));
        let mut shortcuts = PortalShortcuts::new(fake);
        let result = shortcuts.apply(&[shortcut("record", Some("Control+Alt+R"))]);
        assert_eq!(result.unavailable.as_deref(), Some(PORTAL_FAILED_REASON));
    }

    #[test]
    fn follows_trigger_changes_from_the_desktops_settings() {
        let mut shortcuts = PortalShortcuts::new(portal());
        shortcuts.apply(&[shortcut("record", Some("Control+Alt+R"))]);
        let changed = shortcuts
            .shortcuts_changed(
                "/session/1",
                vec![BoundShortcut {
                    id: "record".into(),
                    trigger_description: "Super+R".into(),
                }],
            )
            .unwrap();
        assert_eq!(changed.triggers["record"], "Super+R");
        assert_eq!(shortcuts.shortcuts_changed("/session/9", Vec::new()), None);
    }

    #[test]
    fn a_closed_session_unbinds_until_retry() {
        let mut shortcuts = PortalShortcuts::new(portal());
        shortcuts.apply(&[shortcut("record", Some("Control+Alt+R"))]);
        shortcuts.session_closed("/session/1");
        assert_eq!(shortcuts.activated("/session/1", "record"), None);
        let result = shortcuts.retry();
        assert!(result.registered["record"]);
        assert_eq!(shortcuts.activated("/session/2", "record"), Some("record"));
    }

    #[test]
    fn an_empty_list_holds_no_session() {
        let mut shortcuts = PortalShortcuts::new(portal());
        shortcuts.apply(&[shortcut("record", Some("Control+Alt+R"))]);
        let result = shortcuts.apply(&[]);
        assert!(result.registered.is_empty());
        assert_eq!(shortcuts.session(), None);
        shortcuts.close();
        assert_eq!(shortcuts.portal().sessions, 1);
    }
}
