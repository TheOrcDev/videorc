//! Global shortcuts on Wayland through the GlobalShortcuts portal (plan 257
//! S11, plan 260 S2.6c): the core's `PortalShortcuts` (one session, rebound
//! when the list changes, `Activated` read from the current session only)
//! over ashpd.
//!
//! The portal answers BindShortcuts after the desktop's own dialog, which can
//! stay open for minutes, so the whole client runs on a thread of its own:
//! the app sends it the list ([`PortalShortcutsHandle::apply`]) and reads
//! what was bound and which action fired from two channels, the way
//! `app/hotkeys.rs` reads `global-hotkey`'s events on the main thread.
//!
//! ashpd keeps a session's object path to itself, so each session gets a
//! handle of ours, and a signal is credited to the one live session (the
//! client closes the old one before binding a new one).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use ashpd::desktop::global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut};
use ashpd::desktop::{CreateSessionOptions, ResponseError, Session};
use futures_util::StreamExt;
use videorc_app_core::desktop::linux::portal_shortcuts::{
    BindRequest, BoundShortcut, GlobalShortcutsPortal, PortalError, PortalShortcut,
    PortalShortcuts, PortalShortcutsResult, SessionHandle,
};

use super::bus::{Bus, CALL_DEADLINE};

/// How long BindShortcuts may wait on the desktop's dialog.
const BIND_DEADLINE: Duration = Duration::from_secs(300);

enum Message {
    Apply(Vec<PortalShortcut>),
    Retry,
    Activated(String),
    Changed(Vec<BoundShortcut>),
    Close,
}

/// The app's side of the portal client.
pub struct PortalShortcutsHandle {
    sender: mpsc::Sender<Message>,
    /// What each apply bound, for Settings → Shortcuts and the notice.
    pub results: mpsc::Receiver<PortalShortcutsResult>,
    /// The action of each key the desktop says was pressed.
    pub actions: mpsc::Receiver<String>,
}

impl PortalShortcutsHandle {
    /// Starts the client's thread.
    pub fn start(bus: Arc<Bus>) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let (results_tx, results) = mpsc::channel();
        let (actions_tx, actions) = mpsc::channel();
        let signals = sender.clone();
        std::thread::Builder::new()
            .name("videorc-shortcuts-portal".into())
            .spawn(move || {
                let portal = AshpdPortal {
                    bus,
                    proxy: None,
                    sessions: HashMap::new(),
                    next_session: 0,
                    signals,
                    listening: false,
                };
                serve(
                    PortalShortcuts::new(portal),
                    &receiver,
                    &results_tx,
                    &actions_tx,
                );
            })
            .map_err(|error| format!("the shortcuts portal thread didn't start: {error}"))?;
        Ok(Self {
            sender,
            results,
            actions,
        })
    }

    /// Binds this list (unless it is what the session holds).
    pub fn apply(&self, shortcuts: Vec<PortalShortcut>) {
        let _ = self.sender.send(Message::Apply(shortcuts));
    }

    /// After a closed dialog or a closed session: binds the same list again.
    pub fn retry(&self) {
        let _ = self.sender.send(Message::Retry);
    }
}

impl Drop for PortalShortcutsHandle {
    fn drop(&mut self) {
        let _ = self.sender.send(Message::Close);
    }
}

fn serve(
    mut shortcuts: PortalShortcuts<AshpdPortal>,
    receiver: &mpsc::Receiver<Message>,
    results: &mpsc::Sender<PortalShortcutsResult>,
    actions: &mpsc::Sender<String>,
) {
    while let Ok(message) = receiver.recv() {
        match message {
            Message::Apply(list) => {
                let _ = results.send(shortcuts.apply(&list));
            }
            Message::Retry => {
                let _ = results.send(shortcuts.retry());
            }
            Message::Activated(id) => {
                let Some(session) = shortcuts.session().cloned() else {
                    continue;
                };
                if let Some(action) = shortcuts.activated(&session, &id) {
                    let _ = actions.send(action.to_string());
                }
            }
            Message::Changed(bound) => {
                let Some(session) = shortcuts.session().cloned() else {
                    continue;
                };
                if let Some(result) = shortcuts.shortcuts_changed(&session, bound) {
                    let _ = results.send(result);
                }
            }
            Message::Close => break,
        }
    }
    shortcuts.close();
}

fn portal_error(error: ashpd::Error) -> PortalError {
    match error {
        ashpd::Error::Response(ResponseError::Cancelled) => PortalError::Cancelled,
        ashpd::Error::PortalNotFound(_) | ashpd::Error::RequiresVersion(..) => {
            PortalError::NotAvailable
        }
        other => PortalError::Failed(other.to_string()),
    }
}

/// The core's `GlobalShortcutsPortal` over ashpd, on the bus's runtime.
struct AshpdPortal {
    bus: Arc<Bus>,
    proxy: Option<Arc<GlobalShortcuts>>,
    sessions: HashMap<SessionHandle, Arc<Session<GlobalShortcuts>>>,
    next_session: u64,
    /// The client's own queue: `Activated` and `ShortcutsChanged` land here.
    signals: mpsc::Sender<Message>,
    listening: bool,
}

impl AshpdPortal {
    fn proxy(&mut self) -> Result<Arc<GlobalShortcuts>, PortalError> {
        if let Some(proxy) = &self.proxy {
            return Ok(proxy.clone());
        }
        let connection = self.bus.connection();
        let proxy = self
            .bus
            .call(CALL_DEADLINE, async move {
                let connection = connection.await?;
                GlobalShortcuts::with_connection(connection)
                    .await
                    .map_err(|error| error.to_string())
            })
            .map(Arc::new)
            .map_err(|_| PortalError::NotAvailable)?;
        self.proxy = Some(proxy.clone());
        Ok(proxy)
    }

    /// Forwards the portal's signals into the client's queue, once.
    fn listen(&mut self, proxy: &Arc<GlobalShortcuts>) {
        if self.listening {
            return;
        }
        self.listening = true;
        let (activated, changed) = (proxy.clone(), proxy.clone());
        let (on_activated, on_changed) = (self.signals.clone(), self.signals.clone());
        self.bus.spawn(async move {
            let Ok(stream) = activated.receive_activated().await else {
                return;
            };
            let mut stream = Box::pin(stream);
            while let Some(event) = stream.next().await {
                if on_activated
                    .send(Message::Activated(event.shortcut_id().to_string()))
                    .is_err()
                {
                    return;
                }
            }
        });
        self.bus.spawn(async move {
            let Ok(stream) = changed.receive_shortcuts_changed().await else {
                return;
            };
            let mut stream = Box::pin(stream);
            while let Some(event) = stream.next().await {
                let bound = event
                    .shortcuts()
                    .iter()
                    .map(|shortcut| BoundShortcut {
                        id: shortcut.id().to_string(),
                        trigger_description: shortcut.trigger_description().to_string(),
                    })
                    .collect();
                if on_changed.send(Message::Changed(bound)).is_err() {
                    return;
                }
            }
        });
    }
}

impl GlobalShortcutsPortal for AshpdPortal {
    fn version(&mut self) -> Result<Option<u32>, PortalError> {
        match self.proxy() {
            Ok(proxy) => Ok(Some(proxy.version()).filter(|version| *version > 0)),
            Err(_) => Ok(None),
        }
    }

    fn register_app_id(&mut self, app_id: &str) -> Result<(), PortalError> {
        let app_id = ashpd::AppID::try_from(app_id).map_err(portal_error)?;
        let connection = self.bus.connection();
        self.bus
            .call(CALL_DEADLINE, async move {
                let connection = connection.await?;
                ashpd::register_host_app_with_connection(connection, app_id)
                    .await
                    .map_err(|error| error.to_string())
            })
            .map_err(PortalError::Failed)
    }

    fn create_session(&mut self) -> Result<SessionHandle, PortalError> {
        let proxy = self.proxy()?;
        self.listen(&proxy);
        let creating = proxy.clone();
        let session = self
            .bus
            .call(CALL_DEADLINE, async move {
                Ok(creating
                    .create_session(CreateSessionOptions::default())
                    .await
                    .map_err(portal_error))
            })
            .map_err(PortalError::Failed)??;
        self.next_session += 1;
        let handle = format!("videorc-shortcuts-{}", self.next_session);
        self.sessions.insert(handle.clone(), Arc::new(session));
        Ok(handle)
    }

    fn bind(
        &mut self,
        session: &SessionHandle,
        shortcuts: &[BindRequest],
    ) -> Result<Vec<BoundShortcut>, PortalError> {
        let proxy = self.proxy()?;
        let session = self
            .sessions
            .get(session)
            .cloned()
            .ok_or_else(|| PortalError::Failed("no such session".into()))?;
        let requests: Vec<NewShortcut> = shortcuts
            .iter()
            .map(|request| {
                NewShortcut::new(request.id.clone(), request.description.clone())
                    .preferred_trigger(request.preferred_trigger.as_deref())
            })
            .collect();
        self.bus
            .call(BIND_DEADLINE, async move {
                let request = match proxy
                    .bind_shortcuts(&session, &requests, None, BindShortcutsOptions::default())
                    .await
                {
                    Ok(request) => request,
                    Err(error) => return Ok(Err(portal_error(error))),
                };
                Ok(request.response().map_err(portal_error).map(|bound| {
                    bound
                        .shortcuts()
                        .iter()
                        .map(|shortcut| BoundShortcut {
                            id: shortcut.id().to_string(),
                            trigger_description: shortcut.trigger_description().to_string(),
                        })
                        .collect()
                }))
            })
            .map_err(PortalError::Failed)?
    }

    fn close_session(&mut self, session: &SessionHandle) {
        let Some(session) = self.sessions.remove(session) else {
            return;
        };
        let _ = self.bus.call(CALL_DEADLINE, async move {
            session.close().await.map_err(|error| error.to_string())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_dialog_is_a_cancel_and_an_old_portal_is_not_available() {
        assert_eq!(
            portal_error(ashpd::Error::Response(ResponseError::Cancelled)),
            PortalError::Cancelled
        );
        assert_eq!(
            portal_error(ashpd::Error::RequiresVersion(1, 0)),
            PortalError::NotAvailable
        );
        assert!(matches!(
            portal_error(ashpd::Error::NoResponse),
            PortalError::Failed(_)
        ));
    }
}
