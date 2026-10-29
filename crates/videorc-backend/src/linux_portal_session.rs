//! The D-Bus half of Linux portal screen capture (Plan 0006): one
//! `org.freedesktop.portal.ScreenCast` session per source start. Runs on a
//! current-thread tokio runtime owned by the capture thread so the session
//! object (and therefore the grant) lives exactly as long as the capture.
#![cfg(target_os = "linux")]

use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ashpd::desktop::screencast::{
    CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType,
    StartCastOptions,
};
use ashpd::desktop::{CreateSessionOptions, PersistMode, Session};
use ashpd::enumflags2::BitFlags;
use futures_util::StreamExt;

use crate::linux_portal_capture::{PortalCaptureState, PortalSourceType};

/// Bounds the non-interactive portal calls (proxy, `CreateSession`,
/// `Close`). The picker steps stay unbounded: a person may take a while.
const PORTAL_CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// The one runtime every portal D-Bus call runs on, for the whole process.
///
/// ashpd caches a single process-wide zbus connection, and with zbus's tokio
/// backend that connection's socket reader is a task on whichever runtime
/// first opened it. Opening it on a per-capture runtime killed the reader when
/// the first capture ended, so every later portal call waited forever on a
/// dead connection (ogre, 2026-09-27: the second start hung, and
/// `session.start` queued behind that screen transition until it timed out).
pub fn portal_runtime() -> Result<&'static tokio::runtime::Runtime, String> {
    static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .thread_name("videorc-portal")
                .enable_all()
                .build()
                .map_err(|error| format!("portal capture runtime could not start: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// What the portal handed back for a granted session. Call
/// [`PortalGrant::close`] when the capture ends so the compositor stops the
/// stream; dropping it leaves the portal session open.
pub struct PortalGrant {
    pub node_id: u32,
    pub fd: OwnedFd,
    pub restore_token: Option<String>,
    pub size: Option<(u32, u32)>,
    /// Set by the `Closed` signal watcher when the compositor ends the share.
    pub revoked: Arc<AtomicBool>,
    session: Arc<Session<Screencast>>,
    watcher: tokio::task::JoinHandle<()>,
}

impl PortalGrant {
    /// Ends the share. ashpd's `Session` does not close itself on drop, and
    /// on the persistent connection an unclosed session would keep the
    /// compositor's stream (and its screencast indicator) alive.
    pub async fn close(self) {
        self.watcher.abort();
        close_session(&self.session).await;
    }
}

async fn close_session(session: &Session<Screencast>) {
    match tokio::time::timeout(PORTAL_CALL_TIMEOUT, session.close()).await {
        Ok(Ok(())) => {}
        // A cancelled or revoked share is already gone on the portal side;
        // closing it again is expected to fail and is not a problem.
        Ok(Err(error)) if session_already_gone(&error.to_string()) => {
            tracing::debug!(error = %error, "portal session was already closed")
        }
        Ok(Err(error)) => tracing::warn!(error = %error, "portal session Close failed"),
        Err(_) => tracing::warn!("portal session Close timed out"),
    }
}

fn session_already_gone(error: &str) -> bool {
    error.contains("UnknownObject") || error.contains("does not exist")
}

pub enum PortalStart {
    Granted(PortalGrant),
    /// The state that explains why there is no stream.
    Denied(PortalCaptureState),
    /// Videorc stopped waiting (the source was stopped or replaced while the
    /// share dialog was open). The session is closed; nobody waits for this.
    Abandoned,
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

/// The portal ended a share dialog without the person choosing: its backend
/// (xdg-desktop-portal-hyprland, ...) or the picker went away mid-dialog, so
/// the frontend answered `Other` (ogre, 2026-10-29). With a restore token no
/// dialog was shown, so that stays a refused token (the caller asks again).
fn dialog_lost(error: &ashpd::Error, dialog_shown: bool) -> bool {
    dialog_shown
        && matches!(
            error,
            ashpd::Error::Response(ashpd::desktop::ResponseError::Other)
        )
}

/// A picker step's error, as the state that explains it.
fn picker_step_failed(step: &str, error: ashpd::Error, dialog_shown: bool) -> PortalStart {
    if is_cancelled(&error) {
        PortalStart::Denied(PortalCaptureState::Cancelled)
    } else if dialog_lost(&error, dialog_shown) {
        PortalStart::Denied(PortalCaptureState::PortalLost)
    } else {
        denied(format!("{step} failed: {error}"))
    }
}

/// `CreateSession` → `SelectSources` → `Start` → `OpenPipeWireRemote`.
/// A refused restore token falls back to the picker once (the caller
/// forgets the token when `restore_token_refused` is set on the outcome).
/// Run it on [`portal_runtime`]; a session that is not granted is closed.
/// `cancelled` ends the negotiation (the picker steps can wait on a person
/// indefinitely); closing the session then lets the portal dismiss its dialog.
pub async fn start_portal_session(
    source: PortalSourceType,
    restore_token: Option<String>,
    include_cursor: bool,
    cancelled: impl std::future::Future<Output = ()>,
) -> PortalStart {
    let proxy = match tokio::time::timeout(PORTAL_CALL_TIMEOUT, Screencast::new()).await {
        Ok(Ok(proxy)) => proxy,
        Ok(Err(error)) => return denied(format!("ScreenCast portal unreachable: {error}")),
        Err(_) => return denied("ScreenCast portal did not answer within 10s"),
    };
    let session = match tokio::time::timeout(
        PORTAL_CALL_TIMEOUT,
        proxy.create_session(CreateSessionOptions::default()),
    )
    .await
    {
        Ok(Ok(session)) => session,
        Ok(Err(error)) => return denied(format!("CreateSession failed: {error}")),
        Err(_) => return denied("CreateSession did not answer within 10s"),
    };
    let session = Arc::new(session);
    // Subscribe before the first picker call so a portal that dies while its
    // dialog is open cannot slip between the call and the watch.
    let portal_lost = portal_owner_lost(&proxy).await;
    let outcome = tokio::select! {
        outcome = until_portal_lost(
            negotiate_stream(&proxy, &session, source, restore_token, include_cursor),
            portal_lost,
        ) => outcome,
        () = cancelled => PortalStart::Abandoned,
    };
    match outcome {
        PortalStart::Granted(_) => {}
        // The portal answers Close only after its share dialog is gone, so
        // waiting here held the next transition (and Record) for the whole
        // 10 s call bound (ogre, 2026-10-12). Close on the persistent portal
        // runtime instead; nothing waits for the answer. A portal that went
        // away may be restarting and answer late (or not at all), too.
        PortalStart::Abandoned | PortalStart::Denied(PortalCaptureState::PortalLost) => {
            let session = Arc::clone(&session);
            tokio::spawn(async move { close_session(&session).await });
        }
        PortalStart::Denied(_) => close_session(&session).await,
    }
    outcome
}

/// Resolves when `org.freedesktop.portal.Desktop` loses or changes its bus
/// owner. The share dialog's answer arrives as a `Response` signal from the
/// owner that was asked; once that owner is gone (the portal crashed or was
/// restarted, ogre 2026-10-29) the answer never comes, and without this watch
/// the source waited for a person on a dialog that no longer existed.
async fn portal_owner_lost(
    proxy: &Screencast,
) -> impl std::future::Future<Output = ()> + Send + 'static {
    let changes = match proxy.receive_owner_changed().await {
        Ok(changes) => Some(changes),
        Err(error) => {
            tracing::warn!(error = %error, "portal screen capture: cannot watch the portal's bus owner");
            None
        }
    };
    async move {
        let Some(mut changes) = changes else {
            return std::future::pending().await;
        };
        // Any change ends the wait: a new owner never saw this request.
        let new_owner = changes.next().await.flatten();
        tracing::warn!(
            new_owner = ?new_owner.as_ref().map(|owner| owner.as_str()),
            "portal screen capture: the portal went away while its share dialog was open"
        );
    }
}

/// How long a failed portal answer waits to learn whether the portal itself
/// is going away. Stopping the compositor backend first makes the frontend
/// fail the pending call a few ms before it loses its own bus name (ogre,
/// 2026-10-29: 21 ms), and that failure is the portal going away, not a
/// missing portal.
const PORTAL_LOSS_GRACE: Duration = Duration::from_millis(500);

/// Races the picker negotiation against the portal going away. A finished
/// negotiation wins a tie: its answer is real. A failure, though, that the
/// portal's loss follows within [`PORTAL_LOSS_GRACE`] is reported as the loss.
async fn until_portal_lost(
    negotiation: impl std::future::Future<Output = PortalStart>,
    portal_lost: impl std::future::Future<Output = ()>,
) -> PortalStart {
    tokio::pin!(portal_lost);
    let outcome = tokio::select! {
        biased;
        outcome = negotiation => outcome,
        () = &mut portal_lost => return PortalStart::Denied(PortalCaptureState::PortalLost),
    };
    if matches!(
        outcome,
        PortalStart::Denied(PortalCaptureState::MissingSource { .. })
    ) && tokio::time::timeout(PORTAL_LOSS_GRACE, portal_lost)
        .await
        .is_ok()
    {
        return PortalStart::Denied(PortalCaptureState::PortalLost);
    }
    outcome
}

async fn negotiate_stream(
    proxy: &Screencast,
    session: &Arc<Session<Screencast>>,
    source: PortalSourceType,
    restore_token: Option<String>,
    include_cursor: bool,
) -> PortalStart {
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
    let dialog_shown = restore_token.is_none();
    let selected = match proxy.select_sources(session, options).await {
        Ok(request) => request.response(),
        Err(error) => Err(error),
    };
    if let Err(error) = selected {
        return picker_step_failed("SelectSources", error, dialog_shown);
    }
    let started = match proxy
        .start(session, None, StartCastOptions::default())
        .await
    {
        Ok(request) => request.response(),
        Err(error) => Err(error),
    };
    let streams = match started {
        Ok(streams) => streams,
        Err(error) => return picker_step_failed("Start", error, dialog_shown),
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
        .open_pipe_wire_remote(session, OpenPipeWireRemoteOptions::default())
        .await
    {
        Ok(fd) => fd,
        Err(error) => return denied(format!("OpenPipeWireRemote failed: {error}")),
    };
    let revoked = Arc::new(AtomicBool::new(false));
    let watcher = {
        let revoked = Arc::clone(&revoked);
        let session = Arc::clone(session);
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
        session: Arc::clone(session),
        watcher,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;

    use super::*;

    #[test]
    fn closing_a_session_the_portal_already_ended_is_not_a_warning() {
        assert!(session_already_gone(
            "org.freedesktop.DBus.Error.UnknownObject: Object does not exist at path"
        ));
        assert!(!session_already_gone(
            "org.freedesktop.DBus.Error.AccessDenied"
        ));
    }

    #[test]
    fn a_share_dialog_the_portal_ended_is_portal_lost_not_a_missing_source() {
        use ashpd::desktop::ResponseError;
        let other = || ashpd::Error::Response(ResponseError::Other);
        assert!(matches!(
            picker_step_failed("SelectSources", other(), true),
            PortalStart::Denied(PortalCaptureState::PortalLost)
        ));
        // No dialog was shown for a restore token: still a refused token,
        // which the caller answers by showing the picker once.
        assert!(matches!(
            picker_step_failed("Start", other(), false),
            PortalStart::Denied(PortalCaptureState::MissingSource { .. })
        ));
        assert!(matches!(
            picker_step_failed(
                "Start",
                ashpd::Error::Response(ResponseError::Cancelled),
                true
            ),
            PortalStart::Denied(PortalCaptureState::Cancelled)
        ));
    }

    #[tokio::test]
    async fn portal_loss_ends_a_share_dialog_wait_as_portal_lost() {
        let (lost_tx, lost_rx) = tokio::sync::oneshot::channel::<()>();
        let wait = tokio::spawn(until_portal_lost(std::future::pending(), async move {
            let _ = lost_rx.await;
        }));
        tokio::task::yield_now().await;
        assert!(
            !wait.is_finished(),
            "nothing ends the wait before the portal goes"
        );
        lost_tx.send(()).unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .expect("portal loss must end the wait")
            .expect("wait task");
        assert!(matches!(
            outcome,
            PortalStart::Denied(PortalCaptureState::PortalLost)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failure_the_portal_loss_follows_is_the_portal_loss() {
        let failed =
            || async { denied("SelectSources failed: org.freedesktop.DBus.Error.NoReply") };
        let lost_soon = until_portal_lost(failed(), async {
            tokio::time::sleep(Duration::from_millis(20)).await;
        })
        .await;
        assert!(matches!(
            lost_soon,
            PortalStart::Denied(PortalCaptureState::PortalLost)
        ));
        // A portal that stays up keeps the real failure.
        let still_up = until_portal_lost(failed(), std::future::pending()).await;
        assert!(matches!(
            still_up,
            PortalStart::Denied(PortalCaptureState::MissingSource { .. })
        ));
        let lost_late = until_portal_lost(failed(), async {
            tokio::time::sleep(PORTAL_LOSS_GRACE * 2).await;
        })
        .await;
        assert!(matches!(
            lost_late,
            PortalStart::Denied(PortalCaptureState::MissingSource { .. })
        ));
    }

    #[tokio::test]
    async fn portal_loss_watch_never_overrides_a_finished_answer() {
        let cancelled = until_portal_lost(
            async { PortalStart::Denied(PortalCaptureState::Cancelled) },
            async {},
        )
        .await;
        assert!(matches!(
            cancelled,
            PortalStart::Denied(PortalCaptureState::Cancelled)
        ));
        let answered = until_portal_lost(
            async { PortalStart::Denied(PortalCaptureState::Cancelled) },
            std::future::pending(),
        )
        .await;
        assert!(matches!(
            answered,
            PortalStart::Denied(PortalCaptureState::Cancelled)
        ));
    }

    /// The zbus socket reader is spawned by whichever capture thread opens
    /// the connection first. It must keep running after that thread (and its
    /// capture) ends, or the next portal start waits forever.
    #[test]
    fn portal_runtime_keeps_tasks_alive_after_the_spawning_thread_exits() {
        let ticks = Arc::new(AtomicU64::new(0));
        let first = {
            let ticks = Arc::clone(&ticks);
            std::thread::spawn(move || {
                let runtime = portal_runtime().expect("portal runtime");
                runtime.block_on(async move {
                    tokio::spawn(async move {
                        loop {
                            ticks.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                    });
                });
                runtime as *const tokio::runtime::Runtime as usize
            })
            .join()
            .expect("first capture thread")
        };

        let second = std::thread::spawn(|| {
            let runtime = portal_runtime().expect("portal runtime");
            runtime.block_on(async { tokio::time::sleep(Duration::from_millis(50)).await });
            runtime as *const tokio::runtime::Runtime as usize
        });
        let before = ticks.load(Ordering::SeqCst);
        let second = second.join().expect("second capture thread");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while ticks.load(Ordering::SeqCst) <= before + 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }

        assert_eq!(first, second, "every capture must share one portal runtime");
        assert!(
            ticks.load(Ordering::SeqCst) > before + 2,
            "a task spawned by an exited capture thread stopped running"
        );
    }
}
