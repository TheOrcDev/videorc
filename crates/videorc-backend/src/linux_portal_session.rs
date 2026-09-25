//! The D-Bus half of Linux portal screen capture (Plan 0006): one
//! `org.freedesktop.portal.ScreenCast` session per source start. Runs on a
//! current-thread tokio runtime owned by the capture thread so the session
//! object (and therefore the grant) lives exactly as long as the capture.
#![cfg(target_os = "linux")]

use std::os::fd::OwnedFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ashpd::desktop::screencast::{
    CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType,
    StartCastOptions,
};
use ashpd::desktop::{CreateSessionOptions, PersistMode, Session};
use ashpd::enumflags2::BitFlags;
use futures_util::StreamExt;

use crate::linux_portal_capture::{PortalCaptureState, PortalSourceType};

/// What the portal handed back for a granted session. Dropping it closes
/// the session (the compositor stops the stream).
pub struct PortalGrant {
    pub node_id: u32,
    pub fd: OwnedFd,
    pub restore_token: Option<String>,
    pub size: Option<(u32, u32)>,
    /// Set by the `Closed` signal watcher when the compositor ends the share.
    pub revoked: Arc<AtomicBool>,
    _session: Arc<Session<Screencast>>,
    _watcher: tokio::task::JoinHandle<()>,
}

pub enum PortalStart {
    Granted(PortalGrant),
    /// The state that explains why there is no stream.
    Denied(PortalCaptureState),
}

fn denied(reason: impl std::fmt::Display) -> PortalStart {
    PortalStart::Denied(PortalCaptureState::MissingSource {
        reason: reason.to_string(),
    })
}

fn is_cancelled(error: &ashpd::Error) -> bool {
    matches!(
        error,
        ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled)
    )
}

/// `CreateSession` → `SelectSources` → `Start` → `OpenPipeWireRemote`.
/// A refused restore token falls back to the picker once (the caller
/// forgets the token when `restore_token_refused` is set on the outcome).
pub async fn start_portal_session(
    source: PortalSourceType,
    restore_token: Option<String>,
    include_cursor: bool,
) -> PortalStart {
    let proxy = match Screencast::new().await {
        Ok(proxy) => proxy,
        Err(error) => return denied(format!("ScreenCast portal unreachable: {error}")),
    };
    let session = match proxy.create_session(CreateSessionOptions::default()).await {
        Ok(session) => session,
        Err(error) => return denied(format!("CreateSession failed: {error}")),
    };
    let types = match source {
        PortalSourceType::Monitor => SourceType::Monitor,
        PortalSourceType::Window => SourceType::Window,
    };
    let cursor = if include_cursor {
        CursorMode::Embedded
    } else {
        CursorMode::Hidden
    };
    let options = SelectSourcesOptions::default()
        .set_cursor_mode(cursor)
        .set_sources(BitFlags::from(types))
        .set_multiple(false)
        .set_persist_mode(PersistMode::ExplicitlyRevoked)
        .set_restore_token(restore_token.as_deref());
    let selected = match proxy.select_sources(&session, options).await {
        Ok(request) => request.response(),
        Err(error) => Err(error),
    };
    if let Err(error) = selected {
        if is_cancelled(&error) {
            return PortalStart::Denied(PortalCaptureState::Cancelled);
        }
        return denied(format!("SelectSources failed: {error}"));
    }
    let streams = match proxy
        .start(&session, None, StartCastOptions::default())
        .await
    {
        Ok(request) => match request.response() {
            Ok(streams) => streams,
            Err(error) if is_cancelled(&error) => {
                return PortalStart::Denied(PortalCaptureState::Cancelled);
            }
            Err(error) => return denied(format!("Start failed: {error}")),
        },
        Err(error) if is_cancelled(&error) => {
            return PortalStart::Denied(PortalCaptureState::Cancelled);
        }
        Err(error) => return denied(format!("Start failed: {error}")),
    };
    let Some(stream) = streams.streams().first() else {
        return denied("the portal granted no stream");
    };
    let node_id = stream.pipe_wire_node_id();
    let size = stream.size().and_then(|(width, height)| {
        Some((u32::try_from(width).ok()?, u32::try_from(height).ok()?))
    });
    let restore_token = streams.restore_token().map(str::to_string);
    let fd = match proxy
        .open_pipe_wire_remote(&session, OpenPipeWireRemoteOptions::default())
        .await
    {
        Ok(fd) => fd,
        Err(error) => return denied(format!("OpenPipeWireRemote failed: {error}")),
    };
    let revoked = Arc::new(AtomicBool::new(false));
    let session = Arc::new(session);
    let watcher = {
        let revoked = Arc::clone(&revoked);
        let session = Arc::clone(&session);
        tokio::spawn(async move {
            if let Ok(mut closed) = session.receive_closed().await {
                let _ = closed.next().await;
                revoked.store(true, Ordering::SeqCst);
            }
        })
    };
    PortalStart::Granted(PortalGrant {
        node_id,
        fd,
        restore_token,
        size,
        revoked,
        _session: session,
        _watcher: watcher,
    })
}
