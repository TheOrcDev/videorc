use std::collections::VecDeque;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use uuid::Uuid;

pub const INTERRUPTION_LEASE_TTL: Duration = Duration::from_secs(5);
pub const CONSUMED_INTERRUPTION_LEASE_TTL: Duration = Duration::from_secs(30);
const RELEASED_LEASE_HISTORY_LIMIT: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureAdmissionBlocker {
    SessionStarting,
    CaptureActive,
    InterruptionInProgress,
}

impl fmt::Display for CaptureAdmissionBlocker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::SessionStarting => "A capture session is starting",
            Self::CaptureActive => "A capture session is active or finalizing",
            Self::InterruptionInProgress => "A privileged backend interruption is in progress",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterruptionLeaseGrant {
    pub lease_id: String,
    pub expires_in_ms: u64,
    pub consumed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CaptureAdmissionState {
    Idle,
    SessionStarting {
        admission_id: u64,
    },
    CaptureActive,
    InterruptionInProgress {
        lease_id: String,
        owner_id: String,
        action: String,
        expires_at: Instant,
        consumed: bool,
    },
}

#[derive(Debug)]
struct CaptureAdmissionInner {
    state: CaptureAdmissionState,
    /// Makes release retries safe when the first response was lost. Bounded so
    /// arbitrary historical IDs cannot accumulate for the backend lifetime.
    released_lease_ids: VecDeque<String>,
}

/// Backend-authoritative admission edge shared by capture startup and
/// privileged process interruptions (permission restarts / update installs).
///
/// Acquisitions are short leases rather than permanent locks. The caller uses
/// one stable owner/action pair across retries, so a lost acquire response
/// returns the same lease. `consume` marks the destructive edge and grants a
/// longer bounded window; renewal keeps a genuinely active operation alive.
/// If the client disappears, both acquired and consumed leases eventually
/// expire and a future capture can recover without restarting the backend.
#[derive(Debug)]
pub struct CaptureInterruptionCoordinator {
    inner: Mutex<CaptureAdmissionInner>,
    next_admission_id: AtomicU64,
}

impl Default for CaptureInterruptionCoordinator {
    fn default() -> Self {
        Self {
            inner: Mutex::new(CaptureAdmissionInner {
                state: CaptureAdmissionState::Idle,
                released_lease_ids: VecDeque::new(),
            }),
            next_admission_id: AtomicU64::new(1),
        }
    }
}

impl CaptureInterruptionCoordinator {
    pub fn try_begin_session_start(
        self: &Arc<Self>,
    ) -> Result<SessionStartAdmission, CaptureAdmissionBlocker> {
        self.try_begin_session_start_at(Instant::now())
    }

    fn try_begin_session_start_at(
        self: &Arc<Self>,
        now: Instant,
    ) -> Result<SessionStartAdmission, CaptureAdmissionBlocker> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        expire_interruption_if_needed(&mut inner, now);
        match &inner.state {
            CaptureAdmissionState::Idle => {
                let admission_id = self.next_admission_id.fetch_add(1, Ordering::Relaxed);
                inner.state = CaptureAdmissionState::SessionStarting { admission_id };
                Ok(SessionStartAdmission {
                    coordinator: Arc::clone(self),
                    admission_id,
                    committed: false,
                })
            }
            CaptureAdmissionState::SessionStarting { .. } => {
                Err(CaptureAdmissionBlocker::SessionStarting)
            }
            CaptureAdmissionState::CaptureActive => Err(CaptureAdmissionBlocker::CaptureActive),
            CaptureAdmissionState::InterruptionInProgress { .. } => {
                Err(CaptureAdmissionBlocker::InterruptionInProgress)
            }
        }
    }

    pub fn try_acquire_interruption(
        &self,
        owner_id: &str,
        action: &str,
    ) -> Result<InterruptionLeaseGrant, CaptureAdmissionBlocker> {
        self.try_acquire_interruption_at(owner_id, action, Instant::now())
    }

    fn try_acquire_interruption_at(
        &self,
        owner_id: &str,
        action: &str,
        now: Instant,
    ) -> Result<InterruptionLeaseGrant, CaptureAdmissionBlocker> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        expire_interruption_if_needed(&mut inner, now);
        match &mut inner.state {
            CaptureAdmissionState::Idle => {
                let lease_id = Uuid::new_v4().to_string();
                inner.state = CaptureAdmissionState::InterruptionInProgress {
                    lease_id: lease_id.clone(),
                    owner_id: owner_id.to_string(),
                    action: action.to_string(),
                    expires_at: now + INTERRUPTION_LEASE_TTL,
                    consumed: false,
                };
                Ok(lease_grant(lease_id, INTERRUPTION_LEASE_TTL, false))
            }
            CaptureAdmissionState::SessionStarting { .. } => {
                Err(CaptureAdmissionBlocker::SessionStarting)
            }
            CaptureAdmissionState::CaptureActive => Err(CaptureAdmissionBlocker::CaptureActive),
            CaptureAdmissionState::InterruptionInProgress {
                lease_id,
                owner_id: active_owner_id,
                action: active_action,
                expires_at,
                consumed,
            } if active_owner_id == owner_id && active_action == action => {
                let ttl = interruption_ttl(*consumed);
                *expires_at = now + ttl;
                Ok(lease_grant(lease_id.clone(), ttl, *consumed))
            }
            CaptureAdmissionState::InterruptionInProgress { .. } => {
                Err(CaptureAdmissionBlocker::InterruptionInProgress)
            }
        }
    }

    pub fn consume_interruption(&self, lease_id: &str) -> Option<InterruptionLeaseGrant> {
        self.consume_interruption_at(lease_id, Instant::now())
    }

    fn consume_interruption_at(
        &self,
        lease_id: &str,
        now: Instant,
    ) -> Option<InterruptionLeaseGrant> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        expire_interruption_if_needed(&mut inner, now);
        match &mut inner.state {
            CaptureAdmissionState::InterruptionInProgress {
                lease_id: active_lease_id,
                expires_at,
                consumed,
                ..
            } if active_lease_id == lease_id => {
                *consumed = true;
                *expires_at = now + CONSUMED_INTERRUPTION_LEASE_TTL;
                Some(lease_grant(
                    active_lease_id.clone(),
                    CONSUMED_INTERRUPTION_LEASE_TTL,
                    true,
                ))
            }
            _ => None,
        }
    }

    pub fn renew_interruption(&self, lease_id: &str) -> Option<InterruptionLeaseGrant> {
        self.renew_interruption_at(lease_id, Instant::now())
    }

    fn renew_interruption_at(
        &self,
        lease_id: &str,
        now: Instant,
    ) -> Option<InterruptionLeaseGrant> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        expire_interruption_if_needed(&mut inner, now);
        match &mut inner.state {
            CaptureAdmissionState::InterruptionInProgress {
                lease_id: active_lease_id,
                expires_at,
                consumed,
                ..
            } if active_lease_id == lease_id => {
                let ttl = interruption_ttl(*consumed);
                *expires_at = now + ttl;
                Some(lease_grant(active_lease_id.clone(), ttl, *consumed))
            }
            _ => None,
        }
    }

    /// Releases an interruption that did not stop the backend. Returning true
    /// for a recently released/expired exact ID makes a retry idempotent when
    /// the first 204 response was lost.
    pub fn release_interruption(&self, lease_id: &str) -> bool {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        expire_interruption_if_needed(&mut inner, Instant::now());
        let active_matches = matches!(
            &inner.state,
            CaptureAdmissionState::InterruptionInProgress {
                lease_id: active_lease_id,
                ..
            } if active_lease_id == lease_id
        );
        if active_matches {
            inner.state = CaptureAdmissionState::Idle;
            remember_released_lease(&mut inner, lease_id.to_string());
            true
        } else {
            inner
                .released_lease_ids
                .iter()
                .any(|released| released == lease_id)
        }
    }

    /// Called only after finalization is complete and immediately before the
    /// terminal recording status is published.
    pub fn capture_finished(&self) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(inner.state, CaptureAdmissionState::CaptureActive) {
            inner.state = CaptureAdmissionState::Idle;
        }
    }

    fn commit_session_start(&self, admission_id: u64) -> bool {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(
            inner.state,
            CaptureAdmissionState::SessionStarting {
                admission_id: active_admission_id
            } if active_admission_id == admission_id
        ) {
            inner.state = CaptureAdmissionState::CaptureActive;
            true
        } else {
            false
        }
    }

    fn abandon_session_start(&self, admission_id: u64) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(
            inner.state,
            CaptureAdmissionState::SessionStarting {
                admission_id: active_admission_id
            } if active_admission_id == admission_id
        ) {
            inner.state = CaptureAdmissionState::Idle;
        }
    }
}

fn interruption_ttl(consumed: bool) -> Duration {
    if consumed {
        CONSUMED_INTERRUPTION_LEASE_TTL
    } else {
        INTERRUPTION_LEASE_TTL
    }
}

fn lease_grant(lease_id: String, ttl: Duration, consumed: bool) -> InterruptionLeaseGrant {
    InterruptionLeaseGrant {
        lease_id,
        expires_in_ms: ttl.as_millis() as u64,
        consumed,
    }
}

fn expire_interruption_if_needed(inner: &mut CaptureAdmissionInner, now: Instant) {
    let expired_lease_id = match &inner.state {
        CaptureAdmissionState::InterruptionInProgress {
            lease_id,
            expires_at,
            ..
        } if *expires_at <= now => Some(lease_id.clone()),
        _ => None,
    };
    if let Some(lease_id) = expired_lease_id {
        inner.state = CaptureAdmissionState::Idle;
        remember_released_lease(inner, lease_id);
    }
}

fn remember_released_lease(inner: &mut CaptureAdmissionInner, lease_id: String) {
    if inner
        .released_lease_ids
        .iter()
        .any(|released| released == &lease_id)
    {
        return;
    }
    inner.released_lease_ids.push_back(lease_id);
    while inner.released_lease_ids.len() > RELEASED_LEASE_HISTORY_LIMIT {
        inner.released_lease_ids.pop_front();
    }
}

#[derive(Debug)]
pub struct SessionStartAdmission {
    coordinator: Arc<CaptureInterruptionCoordinator>,
    admission_id: u64,
    committed: bool,
}

impl SessionStartAdmission {
    pub fn commit(mut self) {
        assert!(
            self.coordinator.commit_session_start(self.admission_id),
            "session-start admission must still own the authoritative Starting state"
        );
        self.committed = true;
    }
}

impl Drop for SessionStartAdmission {
    fn drop(&mut self) {
        if !self.committed {
            self.coordinator.abandon_session_start(self.admission_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{
        CONSUMED_INTERRUPTION_LEASE_TTL, CaptureAdmissionBlocker, CaptureInterruptionCoordinator,
        INTERRUPTION_LEASE_TTL,
    };

    #[test]
    fn lost_acquire_response_recovers_same_owner_action_lease() {
        let coordinator = CaptureInterruptionCoordinator::default();
        let now = Instant::now();
        let first = coordinator
            .try_acquire_interruption_at("main/action-1", "permission-restart", now)
            .unwrap();
        let recovered = coordinator
            .try_acquire_interruption_at(
                "main/action-1",
                "permission-restart",
                now + Duration::from_millis(100),
            )
            .unwrap();

        assert_eq!(recovered.lease_id, first.lease_id);
        assert!(!recovered.consumed);
        assert_eq!(
            coordinator
                .try_acquire_interruption_at(
                    "main/action-2",
                    "permission-restart",
                    now + Duration::from_millis(100),
                )
                .unwrap_err(),
            CaptureAdmissionBlocker::InterruptionInProgress
        );
    }

    #[test]
    fn release_is_idempotent_when_first_response_is_lost() {
        let coordinator = CaptureInterruptionCoordinator::default();
        let lease = coordinator
            .try_acquire_interruption("main/action-1", "update-install")
            .unwrap();

        assert!(coordinator.release_interruption(&lease.lease_id));
        assert!(coordinator.release_interruption(&lease.lease_id));
        assert!(!coordinator.release_interruption("unrelated-lease"));
    }

    #[test]
    fn abandoned_lease_expires_and_another_owner_can_reacquire() {
        let coordinator = CaptureInterruptionCoordinator::default();
        let now = Instant::now();
        let abandoned = coordinator
            .try_acquire_interruption_at("main/action-1", "update-install", now)
            .unwrap();
        let recovered = coordinator
            .try_acquire_interruption_at(
                "main/action-2",
                "permission-restart",
                now + INTERRUPTION_LEASE_TTL + Duration::from_millis(1),
            )
            .unwrap();

        assert_ne!(recovered.lease_id, abandoned.lease_id);
        assert!(coordinator.release_interruption(&abandoned.lease_id));
    }

    #[test]
    fn consumed_and_renewed_action_never_overlaps_session_start() {
        let coordinator = Arc::new(CaptureInterruptionCoordinator::default());
        let now = Instant::now();
        let lease = coordinator
            .try_acquire_interruption_at("main/action-1", "permission-restart", now)
            .unwrap();
        coordinator
            .consume_interruption_at(&lease.lease_id, now + Duration::from_secs(1))
            .unwrap();
        let renewed_at = now + CONSUMED_INTERRUPTION_LEASE_TTL;
        coordinator
            .renew_interruption_at(&lease.lease_id, renewed_at)
            .unwrap();

        assert_eq!(
            coordinator
                .try_begin_session_start_at(
                    renewed_at + CONSUMED_INTERRUPTION_LEASE_TTL - Duration::from_millis(1)
                )
                .unwrap_err(),
            CaptureAdmissionBlocker::InterruptionInProgress
        );
        let admission = coordinator
            .try_begin_session_start_at(
                renewed_at + CONSUMED_INTERRUPTION_LEASE_TTL + Duration::from_millis(1),
            )
            .unwrap();
        drop(admission);
    }

    #[test]
    fn starting_and_active_capture_both_reject_interruption() {
        let coordinator = Arc::new(CaptureInterruptionCoordinator::default());
        let admission = coordinator.try_begin_session_start().unwrap();
        assert_eq!(
            coordinator
                .try_acquire_interruption("main/action-1", "update-install")
                .unwrap_err(),
            CaptureAdmissionBlocker::SessionStarting
        );

        admission.commit();
        assert_eq!(
            coordinator
                .try_acquire_interruption("main/action-1", "update-install")
                .unwrap_err(),
            CaptureAdmissionBlocker::CaptureActive
        );

        coordinator.capture_finished();
        assert!(
            coordinator
                .try_acquire_interruption("main/action-1", "update-install")
                .is_ok()
        );
    }

    #[test]
    fn failed_session_start_returns_admission_to_idle() {
        let coordinator = Arc::new(CaptureInterruptionCoordinator::default());
        let admission = coordinator.try_begin_session_start().unwrap();
        drop(admission);

        assert!(
            coordinator
                .try_acquire_interruption("main/action-1", "permission-restart")
                .is_ok()
        );
    }

    #[test]
    fn concurrent_start_and_interruption_have_exactly_one_winner() {
        for _ in 0..256 {
            let coordinator = Arc::new(CaptureInterruptionCoordinator::default());
            let barrier = Arc::new(Barrier::new(3));

            let start_coordinator = Arc::clone(&coordinator);
            let start_barrier = Arc::clone(&barrier);
            let start = thread::spawn(move || {
                start_barrier.wait();
                start_coordinator.try_begin_session_start().ok()
            });

            let interruption_coordinator = Arc::clone(&coordinator);
            let interruption_barrier = Arc::clone(&barrier);
            let interruption = thread::spawn(move || {
                interruption_barrier.wait();
                interruption_coordinator
                    .try_acquire_interruption("main/action-1", "update-install")
                    .ok()
            });

            barrier.wait();
            let start_admission = start.join().unwrap();
            let interruption_lease = interruption.join().unwrap();
            assert_ne!(start_admission.is_some(), interruption_lease.is_some());

            drop(start_admission);
            if let Some(lease) = interruption_lease {
                assert!(coordinator.release_interruption(&lease.lease_id));
            }
            assert!(coordinator.try_begin_session_start().is_ok());
        }
    }
}
