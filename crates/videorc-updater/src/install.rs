//! When a downloaded update may install.

/// What became of a request to install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateInstallAdmission {
    /// The app itself knows a recording, a stream or a Clips buffer runs.
    BlockedByLocalCaptureState,
    /// The backend refused: a start won after the app looked.
    BlockedByBackend,
    Installing,
}

/// Keeps the immediate sampled-state guard for the streamer's sake, then
/// closes its race with a start by asking the backend, which is the
/// authority, before quitting.
///
/// `acquire` asks the backend for an interruption lease and answers `None`
/// when it refuses. `quit_and_install` is given the lease and holds it while
/// the app quits, so nothing can start in between.
pub async fn install_update_with_interruption_lease<Lease, Acquire, Acquiring>(
    capture_install_blocked: impl FnOnce() -> bool,
    acquire: Acquire,
    quit_and_install: impl FnOnce(Lease),
) -> UpdateInstallAdmission
where
    Acquire: FnOnce() -> Acquiring,
    Acquiring: Future<Output = Option<Lease>>,
{
    if capture_install_blocked() {
        return UpdateInstallAdmission::BlockedByLocalCaptureState;
    }
    match acquire().await {
        Some(lease) => {
            quit_and_install(lease);
            UpdateInstallAdmission::Installing
        }
        None => UpdateInstallAdmission::BlockedByBackend,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use super::*;

    /// Runs a future that never waits.
    fn now<Output>(future: impl Future<Output = Output>) -> Output {
        let mut future = pin!(future);
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the future waited"),
        }
    }

    struct Lease;

    // authoritative update installation admission

    #[test]
    fn preserves_the_immediate_local_capture_guard() {
        let acquired = Cell::new(false);
        let quit = Cell::new(false);
        let admission = now(install_update_with_interruption_lease(
            || true,
            || {
                acquired.set(true);
                async { Some(Lease) }
            },
            |_| quit.set(true),
        ));
        assert_eq!(
            admission,
            UpdateInstallAdmission::BlockedByLocalCaptureState
        );
        assert!(!acquired.get());
        assert!(!quit.get());
    }

    #[test]
    fn blocks_a_start_that_wins_after_the_sampled_idle_state() {
        let quit = Cell::new(false);
        let admission = now(install_update_with_interruption_lease(
            || false,
            || async { None::<Lease> },
            |_| quit.set(true),
        ));
        assert_eq!(admission, UpdateInstallAdmission::BlockedByBackend);
        assert!(!quit.get());
    }

    #[test]
    fn quits_only_while_holding_the_backend_lease() {
        let quits = Cell::new(0);
        let admission = now(install_update_with_interruption_lease(
            || false,
            || async { Some(Lease) },
            |_lease: Lease| quits.set(quits.get() + 1),
        ));
        assert_eq!(admission, UpdateInstallAdmission::Installing);
        assert_eq!(quits.get(), 1);
    }
}
