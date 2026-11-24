//! Plan 260 S1.6b part 5b: the camera's low-light compensation (issue
//! #1066), as the Sources page's Camera item reads and sets it
//! (`hooks/use-camera-low-light.ts`, `lib/camera-low-light.ts`, the
//! `requestCameraLowLight` of `use-studio.tsx`).
//!
//! The camera in use is read (`camera.lowLight.get`) whenever it or the
//! connection changes. Every read and save carries a revision, and an answer
//! for an older camera or request is dropped. A failed read (a stalled
//! camera, a driver error) is asked again 2, 4 and 8 s later and clears the
//! state only once the retries run out; a camera without the control
//! answers `supported: false`, which hides the switch. A save
//! (`camera.lowLight.set`) holds the switch disabled while it runs; a failed
//! one says so and reads the stored state back.
//!
//! Electron reads only while the Sources page is mounted (the hook lives in
//! its lazy chunk); app-core has no mount, so the core follows the camera
//! in use whenever Videorc answers.

use std::time::{Duration, Instant};

use serde_json::json;
use videorc_protocol::{CameraLowLightParams, CameraLowLightSetParams, CameraLowLightState};

use super::{Studio, StudioBackend};
use crate::user_error::{self, Failure, UserErrorContext};

/// `camera.lowLight.get` and `camera.lowLight.set`.
pub const GET_METHOD: &str = "camera.lowLight.get";
pub const SET_METHOD: &str = "camera.lowLight.set";

/// `CAMERA_LOW_LIGHT_READ_RETRY_DELAYS_MS`.
pub const READ_RETRY_DELAYS_MS: [u64; 3] = [2_000, 4_000, 8_000];

/// The failed save's toast id (Electron's `toastUserError` stacks; one id
/// keeps a repeated failure to one toast here).
pub const SAVE_FAILED_TOAST_ID: &str = "camera-low-light";

/// The switch's words (`video-sources.tsx`).
pub mod copy {
    pub const LABEL: &str = "Low-light compensation";
    pub const DESCRIPTION: &str =
        "Brightens a dark picture, but the camera may drop to half its frame rate.";
}

/// `cameraLowLightReadRetryDelayMs(failures)`: the wait after failed read
/// number `failures` (1 for the first), or `None` once the retries are
/// spent.
pub fn read_retry_delay_ms(failures: u32) -> Option<u64> {
    let index = usize::try_from(failures).ok()?.checked_sub(1)?;
    READ_RETRY_DELAYS_MS.get(index).copied()
}

/// What the Camera item reads (`useCameraLowLight`'s `state` and
/// `pending`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CameraLowLightView {
    pub state: Option<CameraLowLightState>,
    /// A save runs: the switch is disabled.
    pub pending: bool,
}

impl CameraLowLightView {
    /// Issue #1066: only the answer for the camera in use counts, and only
    /// where Videorc can set it.
    pub fn for_camera(&self, camera_id: Option<&str>) -> Option<&CameraLowLightState> {
        let camera_id = camera_id.filter(|id| !id.is_empty())?;
        self.state
            .as_ref()
            .filter(|state| state.camera_id == camera_id && state.supported)
    }
}

/// One read to run: when, for which camera, at which revision, and after
/// how many failed reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowLightRead {
    pub at: Instant,
    pub camera_id: String,
    pub revision: u64,
    pub failures: u32,
}

/// The hook's state and refs, without the UI: the view, the revision fence,
/// the camera and connection it follows, and the next read.
#[derive(Debug, Clone, Default)]
pub struct LowLightCore {
    pub view: CameraLowLightView,
    revision: u64,
    watched: Option<(Option<String>, bool)>,
    pub due: Option<LowLightRead>,
}

impl LowLightCore {
    /// The effect on `[cameraId, connected]`: a new camera or connection
    /// fences every answer in flight; with a camera and Videorc answering,
    /// a read is due now, else the state clears. True when it changed.
    pub fn follow(&mut self, camera_id: Option<&str>, connected: bool, now: Instant) -> bool {
        let camera_id = camera_id.filter(|id| !id.is_empty());
        let key = (camera_id.map(str::to_string), connected);
        if self.watched.as_ref() == Some(&key) {
            return false;
        }
        self.watched = Some(key);
        self.revision += 1;
        self.due = None;
        match camera_id.filter(|_| connected) {
            Some(id) => {
                self.due = Some(LowLightRead {
                    at: now,
                    camera_id: id.to_string(),
                    revision: self.revision,
                    failures: 0,
                });
            }
            None => self.view.state = None,
        }
        true
    }

    /// The read due by `now`, taken.
    pub fn take_due(&mut self, now: Instant) -> Option<LowLightRead> {
        if self.due.as_ref().is_some_and(|read| read.at <= now) {
            self.due.take()
        } else {
            None
        }
    }

    /// A read answered (`None`: it failed). An answer for an older camera
    /// or request is dropped; a failure is asked again on the backoff, and
    /// clears the state once the retries are spent.
    pub fn read_answered(
        &mut self,
        read: &LowLightRead,
        answer: Option<CameraLowLightState>,
        now: Instant,
    ) {
        if read.revision != self.revision {
            return;
        }
        if let Some(state) = answer {
            self.view.state = Some(state);
            return;
        }
        let failures = read.failures + 1;
        match read_retry_delay_ms(failures) {
            Some(delay) => {
                self.due = Some(LowLightRead {
                    at: now + Duration::from_millis(delay),
                    camera_id: read.camera_id.clone(),
                    revision: read.revision,
                    failures,
                });
            }
            None => self.view.state = None,
        }
    }

    /// `setCompensation`'s start: a new revision (any read in flight is
    /// dropped) and the switch held.
    pub fn begin_set(&mut self) -> u64 {
        self.revision += 1;
        self.due = None;
        self.view.pending = true;
        self.revision
    }

    /// The save answered (`None`: it failed, and the stored state is read
    /// back at once with the save's revision).
    pub fn set_answered(
        &mut self,
        revision: u64,
        camera_id: &str,
        answer: Option<CameraLowLightState>,
        now: Instant,
    ) {
        self.view.pending = false;
        if revision != self.revision {
            return;
        }
        match answer {
            Some(state) => self.view.state = Some(state),
            None => {
                self.due = Some(LowLightRead {
                    at: now,
                    camera_id: camera_id.to_string(),
                    revision,
                    failures: 0,
                });
            }
        }
    }
}

impl<B: StudioBackend> Studio<B> {
    /// The driver's low-light read, when it falls due.
    pub(super) async fn camera_low_light_due(&self) {
        let read = self.lock().low_light.take_due(Instant::now());
        let Some(read) = read else {
            return;
        };
        let params = serde_json::to_value(CameraLowLightParams {
            camera_id: read.camera_id.clone(),
        })
        .unwrap_or_else(|_| json!({ "cameraId": read.camera_id }));
        let answer = self
            .backend
            .sources_request(GET_METHOD, params)
            .await
            .and_then(|value| super::backend::read_json::<CameraLowLightState>(GET_METHOD, value));
        if let Err(error) = &answer {
            self.config.logger.info(format!(
                "Studio: {GET_METHOD} for {} failed ({}): {}",
                read.camera_id, error.code, error.message
            ));
        }
        self.lock()
            .low_light
            .read_answered(&read, answer.ok(), Instant::now());
        self.settings_retry.notify_one();
        self.publish();
    }

    /// `setCompensation`: the selected camera's low-light compensation,
    /// saved. A failure says so (`Couldn't turn on low-light compensation`)
    /// and reads the stored state back.
    pub async fn set_camera_low_light(&self, compensation: bool) {
        let (camera_id, revision) = {
            let mut guard = self.lock();
            let inner = &mut *guard;
            inner
                .capture
                .sync(inner.settings.get(super::keys::CAPTURE_CONFIG));
            let Some(camera_id) = inner
                .capture
                .view
                .config
                .sources
                .camera_id
                .clone()
                .filter(|id| !id.is_empty())
            else {
                return;
            };
            (camera_id, inner.low_light.begin_set())
        };
        self.publish();
        let params = serde_json::to_value(CameraLowLightSetParams {
            camera_id: camera_id.clone(),
            compensation,
        })
        .unwrap_or_else(|_| json!({ "cameraId": camera_id, "compensation": compensation }));
        let answer = self
            .backend
            .sources_request(SET_METHOD, params)
            .await
            .and_then(|value| super::backend::read_json::<CameraLowLightState>(SET_METHOD, value));
        if let Err(error) = &answer {
            let context = UserErrorContext {
                action: if compensation { "turn on" } else { "turn off" },
                object: "low-light compensation",
            };
            self.post(
                user_error::toast_user_error(Failure::Rpc(error), context, SAVE_FAILED_TOAST_ID)
                    .into_iter()
                    .collect(),
            );
        }
        self.lock()
            .low_light
            .set_answered(revision, &camera_id, answer.ok(), Instant::now());
        self.settings_retry.notify_one();
        self.publish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(camera_id: &str, supported: bool, compensation: bool) -> CameraLowLightState {
        CameraLowLightState {
            camera_id: camera_id.to_string(),
            supported,
            compensation,
        }
    }

    #[test]
    fn failed_reads_wait_two_four_and_eight_seconds_then_stop() {
        assert_eq!(read_retry_delay_ms(0), None);
        assert_eq!(read_retry_delay_ms(1), Some(2_000));
        assert_eq!(read_retry_delay_ms(2), Some(4_000));
        assert_eq!(read_retry_delay_ms(3), Some(8_000));
        assert_eq!(read_retry_delay_ms(4), None);
    }

    #[test]
    fn a_camera_is_read_when_it_or_the_connection_changes() {
        let now = Instant::now();
        let mut core = LowLightCore::default();
        assert!(core.follow(Some("cam:1"), true, now));
        assert!(!core.follow(Some("cam:1"), true, now), "nothing changed");
        let read = core.take_due(now).expect("a read is due");
        assert_eq!(read.camera_id, "cam:1");
        core.read_answered(&read, Some(state("cam:1", true, false)), now);
        assert_eq!(
            core.view.for_camera(Some("cam:1")),
            Some(&state("cam:1", true, false))
        );
        // Another camera's answer never counts, nor an unsupported one.
        assert_eq!(core.view.for_camera(Some("cam:2")), None);
        // Offline: the state clears and nothing is read.
        assert!(core.follow(Some("cam:1"), false, now));
        assert_eq!(core.view.state, None);
        assert_eq!(core.take_due(now), None);
        core.follow(Some("cam:2"), true, now);
        let read = core.take_due(now).unwrap();
        core.read_answered(&read, Some(state("cam:2", false, false)), now);
        assert_eq!(core.view.for_camera(Some("cam:2")), None, "no control here");
    }

    #[test]
    fn a_failed_read_keeps_the_state_through_its_retries_then_clears_it() {
        let now = Instant::now();
        let mut core = LowLightCore::default();
        core.follow(Some("cam:1"), true, now);
        let first = core.take_due(now).unwrap();
        core.read_answered(&first, Some(state("cam:1", true, true)), now);
        // A read after that fails three times, then once more.
        core.due = Some(LowLightRead {
            failures: 0,
            ..first.clone()
        });
        let mut read = core.take_due(now).unwrap();
        for wait in READ_RETRY_DELAYS_MS {
            core.read_answered(&read, None, now);
            assert!(core.view.state.is_some(), "kept while the retries run");
            assert_eq!(core.take_due(now), None, "not due yet");
            let later = now + Duration::from_millis(wait);
            read = core.take_due(later).expect("asked again");
        }
        core.read_answered(&read, None, now);
        assert_eq!(core.view.state, None, "the retries are spent");
        assert_eq!(core.due, None);
    }

    #[test]
    fn a_save_fences_older_answers_and_a_failed_one_reads_back() {
        let now = Instant::now();
        let mut core = LowLightCore::default();
        core.follow(Some("cam:1"), true, now);
        let read = core.take_due(now).unwrap();
        let revision = core.begin_set();
        assert!(core.view.pending);
        // The read that was in flight answers late: dropped.
        core.read_answered(&read, Some(state("cam:1", true, false)), now);
        assert_eq!(core.view.state, None);
        core.set_answered(revision, "cam:1", Some(state("cam:1", true, true)), now);
        assert!(!core.view.pending);
        assert_eq!(
            core.view
                .for_camera(Some("cam:1"))
                .map(|state| state.compensation),
            Some(true)
        );
        // A failed save reads the stored state back at once.
        let revision = core.begin_set();
        core.set_answered(revision, "cam:1", None, now);
        let back = core.take_due(now).expect("read back");
        assert_eq!((back.revision, back.failures), (revision, 0));
        assert_eq!(
            core.view.state.as_ref().map(|state| state.compensation),
            Some(true),
            "the last answer stays until the read back answers"
        );
    }
}
