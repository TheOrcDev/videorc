use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum WindowsD3d11EncoderRole {
    Record,
    Stream,
}

impl WindowsD3d11EncoderRole {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Record => "record",
            Self::Stream => "stream",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11EncoderSubmissionMetadata {
    pub(crate) generation: u64,
    pub(crate) role: WindowsD3d11EncoderRole,
    pub(crate) lease_id: u64,
    pub(crate) input_pts_100ns: i64,
    pub(crate) duration_100ns: i64,
    pub(crate) submitted_at_micros: u64,
}

impl WindowsD3d11EncoderSubmissionMetadata {
    fn validate(
        self,
        generation: u64,
        role: WindowsD3d11EncoderRole,
    ) -> Result<Self, WindowsD3d11EncoderContractError> {
        if self.generation != generation || self.generation == 0 {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::StaleGeneration,
                format!(
                    "submission generation {} does not match active generation {generation}",
                    self.generation
                ),
            ));
        }
        if self.role != role {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::RoleMismatch,
                format!(
                    "submission role {} does not match encoder role {}",
                    self.role.as_str(),
                    role.as_str()
                ),
            ));
        }
        if self.lease_id == 0 || self.input_pts_100ns < 0 || self.duration_100ns <= 0 {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidSubmission,
                "submission requires a non-zero lease, non-negative PTS, and positive duration",
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11EncoderReleaseCallback {
    pub(crate) generation: u64,
    pub(crate) role: WindowsD3d11EncoderRole,
    pub(crate) lease_id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsD3d11EncoderLeaseRelease {
    pub(crate) generation: u64,
    pub(crate) role: WindowsD3d11EncoderRole,
    pub(crate) lease_id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11EncoderReleaseDisposition {
    Released(WindowsD3d11EncoderLeaseRelease),
    StaleGeneration,
    WrongRole,
    UnknownLease,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11EncoderContractErrorCode {
    InvalidGeneration,
    InvalidCapacity,
    InvalidSubmission,
    StaleGeneration,
    RoleMismatch,
    NoInputCredit,
    Backpressure,
    DuplicateLease,
    UnknownReservation,
    InvalidPhase,
    DrainTimedOut,
    FlushTimedOut,
}

impl WindowsD3d11EncoderContractErrorCode {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidGeneration => "d3d11-encoder-invalid-generation",
            Self::InvalidCapacity => "d3d11-encoder-invalid-capacity",
            Self::InvalidSubmission => "d3d11-encoder-invalid-submission",
            Self::StaleGeneration => "d3d11-encoder-stale-generation",
            Self::RoleMismatch => "d3d11-encoder-role-mismatch",
            Self::NoInputCredit => "d3d11-encoder-no-input-credit",
            Self::Backpressure => "d3d11-encoder-backpressure",
            Self::DuplicateLease => "d3d11-encoder-duplicate-lease",
            Self::UnknownReservation => "d3d11-encoder-unknown-reservation",
            Self::InvalidPhase => "d3d11-encoder-invalid-phase",
            Self::DrainTimedOut => "d3d11-encoder-drain-timeout",
            Self::FlushTimedOut => "d3d11-encoder-flush-timeout",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsD3d11EncoderContractError {
    pub(crate) code: WindowsD3d11EncoderContractErrorCode,
    pub(crate) detail: String,
}

impl WindowsD3d11EncoderContractError {
    fn new(code: WindowsD3d11EncoderContractErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for WindowsD3d11EncoderContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for WindowsD3d11EncoderContractError {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct WindowsD3d11EncoderDiagnostics {
    pub(crate) generation: u64,
    pub(crate) role: Option<WindowsD3d11EncoderRole>,
    pub(crate) gpu_nv12_samples_submitted: u64,
    pub(crate) system_memory_i420_samples_submitted: u64,
    pub(crate) encoded_output_frames: u64,
    pub(crate) input_credit_events: u64,
    pub(crate) input_credit_overflow_events: u64,
    pub(crate) process_input_failures: u64,
    pub(crate) backpressure_events: u64,
    pub(crate) release_callbacks: u64,
    pub(crate) stale_release_callbacks: u64,
    pub(crate) wrong_role_callbacks: u64,
    pub(crate) unknown_release_callbacks: u64,
    pub(crate) drain_timeouts: u64,
    pub(crate) flush_timeouts: u64,
    pub(crate) current_in_flight: u32,
    pub(crate) max_in_flight: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowsD3d11EncoderPhase {
    Running,
    Draining {
        deadline_micros: u64,
        transform_complete: bool,
    },
    Flushing {
        deadline_micros: u64,
    },
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsD3d11EncoderWaitStatus {
    Pending { in_flight: usize },
    Complete,
}

#[derive(Debug)]
pub(crate) struct WindowsD3d11EncoderOwnershipState {
    generation: u64,
    role: WindowsD3d11EncoderRole,
    capacity: usize,
    input_credits: usize,
    reserved: BTreeMap<u64, WindowsD3d11EncoderSubmissionMetadata>,
    in_flight: BTreeMap<u64, WindowsD3d11EncoderSubmissionMetadata>,
    phase: WindowsD3d11EncoderPhase,
    diagnostics: WindowsD3d11EncoderDiagnostics,
}

impl WindowsD3d11EncoderOwnershipState {
    pub(crate) fn new(
        generation: u64,
        role: WindowsD3d11EncoderRole,
        capacity: usize,
    ) -> Result<Self, WindowsD3d11EncoderContractError> {
        if generation == 0 {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidGeneration,
                "encoder generation zero is reserved",
            ));
        }
        if capacity == 0 || capacity > u16::MAX as usize {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidCapacity,
                "encoder in-flight capacity must be between 1 and 65535",
            ));
        }
        Ok(Self {
            generation,
            role,
            capacity,
            input_credits: 0,
            reserved: BTreeMap::new(),
            in_flight: BTreeMap::new(),
            phase: WindowsD3d11EncoderPhase::Running,
            diagnostics: WindowsD3d11EncoderDiagnostics {
                generation,
                role: Some(role),
                ..WindowsD3d11EncoderDiagnostics::default()
            },
        })
    }

    pub(crate) fn note_input_credit(&mut self) -> Result<(), WindowsD3d11EncoderContractError> {
        self.require_running()?;
        self.diagnostics.input_credit_events =
            self.diagnostics.input_credit_events.saturating_add(1);
        if self.input_credits >= self.capacity {
            self.diagnostics.input_credit_overflow_events = self
                .diagnostics
                .input_credit_overflow_events
                .saturating_add(1);
            return Ok(());
        }
        self.input_credits += 1;
        Ok(())
    }

    pub(crate) const fn has_input_credit(&self) -> bool {
        self.input_credits > 0
    }

    pub(crate) fn reserve_submission(
        &mut self,
        metadata: WindowsD3d11EncoderSubmissionMetadata,
    ) -> Result<(), WindowsD3d11EncoderContractError> {
        self.require_running()?;
        let metadata = metadata.validate(self.generation, self.role)?;
        if self.input_credits == 0 {
            self.diagnostics.backpressure_events =
                self.diagnostics.backpressure_events.saturating_add(1);
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::NoInputCredit,
                "asynchronous MFT has not issued an input credit",
            ));
        }
        if self.reserved.len().saturating_add(self.in_flight.len()) >= self.capacity {
            self.diagnostics.backpressure_events =
                self.diagnostics.backpressure_events.saturating_add(1);
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::Backpressure,
                format!("bounded encoder capacity {} is exhausted", self.capacity),
            ));
        }
        if self.reserved.contains_key(&metadata.lease_id)
            || self.in_flight.contains_key(&metadata.lease_id)
        {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::DuplicateLease,
                format!("lease {} is already tracked", metadata.lease_id),
            ));
        }
        self.input_credits -= 1;
        self.reserved.insert(metadata.lease_id, metadata);
        Ok(())
    }

    pub(crate) fn commit_process_input(
        &mut self,
        lease_id: u64,
    ) -> Result<(), WindowsD3d11EncoderContractError> {
        self.require_running()?;
        let metadata = self.reserved.remove(&lease_id).ok_or_else(|| {
            WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::UnknownReservation,
                format!("lease {lease_id} has no pending ProcessInput reservation"),
            )
        })?;
        self.in_flight.insert(lease_id, metadata);
        self.diagnostics.gpu_nv12_samples_submitted = self
            .diagnostics
            .gpu_nv12_samples_submitted
            .saturating_add(1);
        self.refresh_in_flight_diagnostics();
        Ok(())
    }

    pub(crate) fn fail_process_input(
        &mut self,
        lease_id: u64,
    ) -> Result<WindowsD3d11EncoderLeaseRelease, WindowsD3d11EncoderContractError> {
        self.require_running()?;
        let metadata = self.reserved.remove(&lease_id).ok_or_else(|| {
            WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::UnknownReservation,
                format!("lease {lease_id} has no failed ProcessInput reservation"),
            )
        })?;
        self.diagnostics.process_input_failures =
            self.diagnostics.process_input_failures.saturating_add(1);
        Ok(WindowsD3d11EncoderLeaseRelease {
            generation: metadata.generation,
            role: metadata.role,
            lease_id: metadata.lease_id,
        })
    }

    pub(crate) fn note_output(&mut self, input_pts_100ns: i64) -> bool {
        // The tracked-sample callback is allowed to run before the transform's
        // HaveOutput event, so released leases are intentionally absent from
        // `in_flight`. The media-thread caller validates this PTS against its
        // ordered submitted-PTS queue before reporting it here.
        if input_pts_100ns < 0 {
            return false;
        }
        self.diagnostics.encoded_output_frames =
            self.diagnostics.encoded_output_frames.saturating_add(1);
        true
    }

    pub(crate) fn release_callback(
        &mut self,
        callback: WindowsD3d11EncoderReleaseCallback,
    ) -> WindowsD3d11EncoderReleaseDisposition {
        self.diagnostics.release_callbacks = self.diagnostics.release_callbacks.saturating_add(1);
        if callback.generation != self.generation {
            self.diagnostics.stale_release_callbacks =
                self.diagnostics.stale_release_callbacks.saturating_add(1);
            return WindowsD3d11EncoderReleaseDisposition::StaleGeneration;
        }
        if callback.role != self.role {
            self.diagnostics.wrong_role_callbacks =
                self.diagnostics.wrong_role_callbacks.saturating_add(1);
            return WindowsD3d11EncoderReleaseDisposition::WrongRole;
        }
        let Some(metadata) = self.in_flight.remove(&callback.lease_id) else {
            self.diagnostics.unknown_release_callbacks =
                self.diagnostics.unknown_release_callbacks.saturating_add(1);
            return WindowsD3d11EncoderReleaseDisposition::UnknownLease;
        };
        self.refresh_in_flight_diagnostics();
        WindowsD3d11EncoderReleaseDisposition::Released(WindowsD3d11EncoderLeaseRelease {
            generation: metadata.generation,
            role: metadata.role,
            lease_id: metadata.lease_id,
        })
    }

    pub(crate) fn begin_drain(
        &mut self,
        now_micros: u64,
        timeout_micros: u64,
    ) -> Result<(), WindowsD3d11EncoderContractError> {
        self.require_running()?;
        if !self.reserved.is_empty() {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidPhase,
                "ProcessInput reservation must resolve before drain",
            ));
        }
        let deadline_micros = now_micros.checked_add(timeout_micros).ok_or_else(|| {
            WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidPhase,
                "drain deadline overflowed",
            )
        })?;
        self.phase = WindowsD3d11EncoderPhase::Draining {
            deadline_micros,
            transform_complete: false,
        };
        Ok(())
    }

    pub(crate) fn note_transform_drain_complete(
        &mut self,
    ) -> Result<(), WindowsD3d11EncoderContractError> {
        let WindowsD3d11EncoderPhase::Draining {
            deadline_micros, ..
        } = self.phase
        else {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidPhase,
                "transform drain completion arrived outside drain",
            ));
        };
        self.phase = WindowsD3d11EncoderPhase::Draining {
            deadline_micros,
            transform_complete: true,
        };
        Ok(())
    }

    pub(crate) fn drain_status(
        &mut self,
        now_micros: u64,
    ) -> Result<WindowsD3d11EncoderWaitStatus, WindowsD3d11EncoderContractError> {
        let WindowsD3d11EncoderPhase::Draining {
            deadline_micros,
            transform_complete,
        } = self.phase
        else {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidPhase,
                "drain status requested outside drain",
            ));
        };
        if transform_complete && self.reserved.is_empty() && self.in_flight.is_empty() {
            self.phase = WindowsD3d11EncoderPhase::Closed;
            return Ok(WindowsD3d11EncoderWaitStatus::Complete);
        }
        if now_micros >= deadline_micros {
            self.diagnostics.drain_timeouts = self.diagnostics.drain_timeouts.saturating_add(1);
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::DrainTimedOut,
                format!(
                    "bounded drain expired with {} tracked surfaces",
                    self.reserved.len().saturating_add(self.in_flight.len())
                ),
            ));
        }
        Ok(WindowsD3d11EncoderWaitStatus::Pending {
            in_flight: self.reserved.len().saturating_add(self.in_flight.len()),
        })
    }

    pub(crate) fn begin_flush(
        &mut self,
        now_micros: u64,
        timeout_micros: u64,
    ) -> Result<(), WindowsD3d11EncoderContractError> {
        if matches!(self.phase, WindowsD3d11EncoderPhase::Closed) {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidPhase,
                "closed encoder cannot begin flush",
            ));
        }
        if !self.reserved.is_empty() {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidPhase,
                "ProcessInput reservation must resolve before flush",
            ));
        }
        let deadline_micros = now_micros.checked_add(timeout_micros).ok_or_else(|| {
            WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidPhase,
                "flush deadline overflowed",
            )
        })?;
        self.input_credits = 0;
        self.phase = WindowsD3d11EncoderPhase::Flushing { deadline_micros };
        Ok(())
    }

    pub(crate) fn flush_status(
        &mut self,
        now_micros: u64,
    ) -> Result<WindowsD3d11EncoderWaitStatus, WindowsD3d11EncoderContractError> {
        let WindowsD3d11EncoderPhase::Flushing { deadline_micros } = self.phase else {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidPhase,
                "flush status requested outside flush",
            ));
        };
        if self.in_flight.is_empty() {
            self.phase = WindowsD3d11EncoderPhase::Closed;
            return Ok(WindowsD3d11EncoderWaitStatus::Complete);
        }
        if now_micros >= deadline_micros {
            self.diagnostics.flush_timeouts = self.diagnostics.flush_timeouts.saturating_add(1);
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::FlushTimedOut,
                format!(
                    "bounded flush expired with {} tracked surfaces",
                    self.in_flight.len()
                ),
            ));
        }
        Ok(WindowsD3d11EncoderWaitStatus::Pending {
            in_flight: self.in_flight.len(),
        })
    }

    pub(crate) fn diagnostics(&self) -> WindowsD3d11EncoderDiagnostics {
        self.diagnostics
    }

    pub(crate) fn in_flight_count(&self) -> usize {
        self.in_flight.len()
    }

    pub(crate) fn reserved_count(&self) -> usize {
        self.reserved.len()
    }

    fn require_running(&self) -> Result<(), WindowsD3d11EncoderContractError> {
        if self.phase != WindowsD3d11EncoderPhase::Running {
            return Err(WindowsD3d11EncoderContractError::new(
                WindowsD3d11EncoderContractErrorCode::InvalidPhase,
                "encoder does not accept submissions outside the running phase",
            ));
        }
        Ok(())
    }

    fn refresh_in_flight_diagnostics(&mut self) {
        self.diagnostics.current_in_flight =
            u32::try_from(self.in_flight.len()).unwrap_or(u32::MAX);
        self.diagnostics.max_in_flight = self
            .diagnostics
            .max_in_flight
            .max(self.diagnostics.current_in_flight);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn submission(
        generation: u64,
        role: WindowsD3d11EncoderRole,
        lease_id: u64,
        pts: i64,
    ) -> WindowsD3d11EncoderSubmissionMetadata {
        WindowsD3d11EncoderSubmissionMetadata {
            generation,
            role,
            lease_id,
            input_pts_100ns: pts,
            duration_100ns: 166_667,
            submitted_at_micros: 10,
        }
    }

    fn committed(
        state: &mut WindowsD3d11EncoderOwnershipState,
        metadata: WindowsD3d11EncoderSubmissionMetadata,
    ) {
        state.note_input_credit().expect("input credit");
        state
            .reserve_submission(metadata)
            .expect("submission reservation");
        state
            .commit_process_input(metadata.lease_id)
            .expect("successful ProcessInput");
    }

    #[test]
    fn windows_d3d11_encoder_requires_credit_and_bounded_capacity() {
        let mut state =
            WindowsD3d11EncoderOwnershipState::new(4, WindowsD3d11EncoderRole::Stream, 1)
                .expect("valid state");
        assert_eq!(
            state
                .reserve_submission(submission(4, WindowsD3d11EncoderRole::Stream, 1, 0))
                .expect_err("credit is mandatory")
                .code,
            WindowsD3d11EncoderContractErrorCode::NoInputCredit
        );
        committed(
            &mut state,
            submission(4, WindowsD3d11EncoderRole::Stream, 1, 0),
        );
        state.note_input_credit().expect("second credit");
        assert_eq!(
            state
                .reserve_submission(submission(4, WindowsD3d11EncoderRole::Stream, 2, 166_667))
                .expect_err("pool capacity remains bounded")
                .code,
            WindowsD3d11EncoderContractErrorCode::Backpressure
        );
        assert_eq!(state.diagnostics().max_in_flight, 1);
    }

    #[test]
    fn windows_d3d11_encoder_process_input_failure_returns_unsubmitted_lease() {
        let mut state =
            WindowsD3d11EncoderOwnershipState::new(2, WindowsD3d11EncoderRole::Record, 2)
                .expect("valid state");
        state.note_input_credit().expect("input credit");
        state
            .reserve_submission(submission(2, WindowsD3d11EncoderRole::Record, 9, 0))
            .expect("reservation");
        let release = state
            .fail_process_input(9)
            .expect("failed input explicitly returns its lease");
        assert_eq!(release.lease_id, 9);
        assert_eq!(state.in_flight_count(), 0);
        assert_eq!(state.reserved_count(), 0);
        assert_eq!(state.diagnostics().process_input_failures, 1);
        assert_eq!(state.diagnostics().gpu_nv12_samples_submitted, 0);
    }

    #[test]
    fn windows_d3d11_encoder_release_callback_is_generation_bound() {
        let mut state =
            WindowsD3d11EncoderOwnershipState::new(8, WindowsD3d11EncoderRole::Stream, 2)
                .expect("valid state");
        committed(
            &mut state,
            submission(8, WindowsD3d11EncoderRole::Stream, 1, 0),
        );
        assert_eq!(
            state.release_callback(WindowsD3d11EncoderReleaseCallback {
                generation: 7,
                role: WindowsD3d11EncoderRole::Stream,
                lease_id: 1,
            }),
            WindowsD3d11EncoderReleaseDisposition::StaleGeneration
        );
        assert_eq!(state.in_flight_count(), 1);
        assert_eq!(
            state.release_callback(WindowsD3d11EncoderReleaseCallback {
                generation: 8,
                role: WindowsD3d11EncoderRole::Stream,
                lease_id: 1,
            }),
            WindowsD3d11EncoderReleaseDisposition::Released(WindowsD3d11EncoderLeaseRelease {
                generation: 8,
                role: WindowsD3d11EncoderRole::Stream,
                lease_id: 1,
            })
        );
        assert_eq!(state.in_flight_count(), 0);
        assert!(state.note_output(0));
        assert_eq!(state.diagnostics().encoded_output_frames, 1);
        assert_eq!(state.diagnostics().stale_release_callbacks, 1);
    }

    #[test]
    fn windows_d3d11_encoder_need_input_and_output_never_release_leases() {
        let mut state =
            WindowsD3d11EncoderOwnershipState::new(3, WindowsD3d11EncoderRole::Record, 3)
                .expect("valid state");
        committed(
            &mut state,
            submission(3, WindowsD3d11EncoderRole::Record, 4, 0),
        );
        assert!(state.note_output(0));
        state.note_input_credit().expect("new input credit");
        assert_eq!(state.in_flight_count(), 1);
        assert_eq!(state.diagnostics().encoded_output_frames, 1);
    }

    #[test]
    fn windows_d3d11_encoder_callbacks_recycle_more_than_pool_capacity() {
        let mut state =
            WindowsD3d11EncoderOwnershipState::new(5, WindowsD3d11EncoderRole::Stream, 2)
                .expect("valid state");
        for lease_id in 1..=8 {
            committed(
                &mut state,
                submission(
                    5,
                    WindowsD3d11EncoderRole::Stream,
                    lease_id,
                    (lease_id as i64 - 1) * 166_667,
                ),
            );
            assert!(matches!(
                state.release_callback(WindowsD3d11EncoderReleaseCallback {
                    generation: 5,
                    role: WindowsD3d11EncoderRole::Stream,
                    lease_id,
                }),
                WindowsD3d11EncoderReleaseDisposition::Released(_)
            ));
        }
        assert_eq!(state.in_flight_count(), 0);
        assert_eq!(state.diagnostics().gpu_nv12_samples_submitted, 8);
        assert_eq!(state.diagnostics().max_in_flight, 1);
    }

    #[test]
    fn windows_d3d11_encoder_drain_waits_for_tracked_callbacks() {
        let mut state =
            WindowsD3d11EncoderOwnershipState::new(6, WindowsD3d11EncoderRole::Record, 2)
                .expect("valid state");
        committed(
            &mut state,
            submission(6, WindowsD3d11EncoderRole::Record, 1, 0),
        );
        state.begin_drain(100, 50).expect("begin drain");
        state
            .note_transform_drain_complete()
            .expect("MFT drain event");
        assert_eq!(
            state.drain_status(120).expect("pending tracked callback"),
            WindowsD3d11EncoderWaitStatus::Pending { in_flight: 1 }
        );
        assert_eq!(
            state.release_callback(WindowsD3d11EncoderReleaseCallback {
                generation: 6,
                role: WindowsD3d11EncoderRole::Record,
                lease_id: 1,
            }),
            WindowsD3d11EncoderReleaseDisposition::Released(WindowsD3d11EncoderLeaseRelease {
                generation: 6,
                role: WindowsD3d11EncoderRole::Record,
                lease_id: 1,
            })
        );
        assert_eq!(
            state.drain_status(130).expect("drain after callback"),
            WindowsD3d11EncoderWaitStatus::Complete
        );

        let mut timed_out =
            WindowsD3d11EncoderOwnershipState::new(7, WindowsD3d11EncoderRole::Record, 1)
                .expect("valid state");
        committed(
            &mut timed_out,
            submission(7, WindowsD3d11EncoderRole::Record, 2, 0),
        );
        timed_out.begin_flush(200, 10).expect("begin flush");
        assert_eq!(
            timed_out
                .flush_status(210)
                .expect_err("flush cannot force-recycle retained sample")
                .code,
            WindowsD3d11EncoderContractErrorCode::FlushTimedOut
        );
        assert_eq!(timed_out.in_flight_count(), 1);
    }

    #[test]
    fn windows_d3d11_encoder_roles_are_isolated() {
        let mut record =
            WindowsD3d11EncoderOwnershipState::new(9, WindowsD3d11EncoderRole::Record, 1)
                .expect("record state");
        let mut stream =
            WindowsD3d11EncoderOwnershipState::new(9, WindowsD3d11EncoderRole::Stream, 1)
                .expect("stream state");
        committed(
            &mut record,
            submission(9, WindowsD3d11EncoderRole::Record, 1, 0),
        );
        committed(
            &mut stream,
            submission(9, WindowsD3d11EncoderRole::Stream, 1, 0),
        );
        assert_eq!(
            record.release_callback(WindowsD3d11EncoderReleaseCallback {
                generation: 9,
                role: WindowsD3d11EncoderRole::Stream,
                lease_id: 1,
            }),
            WindowsD3d11EncoderReleaseDisposition::WrongRole
        );
        assert_eq!(record.in_flight_count(), 1);
        assert_eq!(stream.in_flight_count(), 1);
    }
}
