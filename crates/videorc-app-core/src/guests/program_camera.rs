//! Plan 249 S23 (D10): the host's opt-in to show the room's Program preview
//! on Videorc Camera (`lib/room-program-camera.ts`'s `RoomProgramCameraStore`).
//!
//! - The opt-in is per room: it starts off, is never remembered, and ends
//!   with the room (`retire`). Turning it on opens one upload for a new
//!   generation; Videorc Camera follows that upload.
//! - A broken upload (the backend restarted or refused) reopens once under a
//!   new generation, at most once a second; generations only grow.
//! - The frames themselves (the producer and the raster) are the screens':
//!   the renderer draws its DOM, the GPUI app draws its own Program preview.
//!   The upload and the camera feed are the backend's (`room_program_camera.rs`).
//!
//! Disabled in production (`ROOM_PROGRAM_CAMERA_PRODUCTION_ENABLED`), as in
//! Electron: only a development run with `VIDEORC_ROOM_PROGRAM_CAMERA=1`
//! offers it.

/// `shared/room-program-camera.ts`: not offered in a production build.
pub const ROOM_PROGRAM_CAMERA_PRODUCTION_ENABLED: bool = false;
/// The variable that offers it in a development run.
pub const ROOM_PROGRAM_CAMERA_ENV: &str = "VIDEORC_ROOM_PROGRAM_CAMERA";

/// A broken upload reopens at most this often.
pub const ROOM_PROGRAM_REOPEN_SPACING_MS: i64 = 1_000;

pub const ROOM_PROGRAM_NO_ROOM: &str = "No room is open.";
pub const ROOM_PROGRAM_UNAVAILABLE: &str = "Videorc Camera is unavailable here.";
pub const ROOM_PROGRAM_LOST: &str = "Videorc Camera lost the room program.";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoomProgramCameraState {
    pub on: bool,
    /// The open upload's generation; none while off or reopening.
    pub generation: Option<u64>,
    /// The room the opt-in belongs to (`host:<showId>`).
    pub host_identity: Option<String>,
    pub error: Option<String>,
}

/// Seconds since the epoch, or one past the last: generations only grow,
/// even across a reload (the upload's owner remembers the last one it saw).
pub fn next_room_program_generation(last: u64, now_ms: i64) -> u64 {
    let seconds = u64::try_from(now_ms.div_euclid(1_000)).unwrap_or(0);
    last.saturating_add(1).max(seconds)
}

/// What the opt-in needs from the app: the upload, and a clock.
#[allow(async_fn_in_trait)]
pub trait RoomProgramCameraIo {
    /// Whether Videorc Camera is offered here at all.
    fn available(&self) -> bool;
    /// Open the upload for `generation`. An error is the reason it was refused.
    async fn open(&mut self, generation: u64) -> anyhow::Result<()>;
    /// Close the upload for `generation`. A failure changes nothing here.
    async fn close(&mut self, generation: u64);
    /// Wall clock, in epoch milliseconds.
    fn now_ms(&self) -> i64;
}

/// The opt-in. `&mut self` serializes open and close, as the renderer's
/// promise chain does, so a quick toggle never leaves two uploads.
#[derive(Debug, Default)]
pub struct RoomProgramCamera {
    state: RoomProgramCameraState,
    last_generation: u64,
    last_reopen_at: Option<i64>,
}

impl RoomProgramCamera {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> &RoomProgramCameraState {
        &self.state
    }

    /// Turn the room program on or off for `host_identity`'s room.
    pub async fn set_on(
        &mut self,
        io: &mut impl RoomProgramCameraIo,
        on: bool,
        host_identity: Option<&str>,
    ) -> anyhow::Result<()> {
        if !on {
            self.close_current(io).await;
            self.state = RoomProgramCameraState::default();
            return Ok(());
        }
        let Some(host_identity) = host_identity.filter(|identity| !identity.is_empty()) else {
            anyhow::bail!(ROOM_PROGRAM_NO_ROOM);
        };
        if self.state.on && self.state.host_identity.as_deref() == Some(host_identity) {
            return Ok(());
        }
        self.close_current(io).await;
        self.open(io, host_identity).await
    }

    /// The room ended or changed: an opt-in for another room ends.
    pub async fn retire(&mut self, io: &mut impl RoomProgramCameraIo, host_identity: Option<&str>) {
        if !self.state.on || self.state.host_identity.as_deref() == host_identity {
            return;
        }
        self.close_current(io).await;
        self.state = RoomProgramCameraState::default();
    }

    /// The upload for `generation` broke: reopen under a new generation, at
    /// most once a second. A stale generation's report changes nothing.
    pub async fn reopen(
        &mut self,
        io: &mut impl RoomProgramCameraIo,
        generation: u64,
    ) -> anyhow::Result<()> {
        if !self.state.on || self.state.generation != Some(generation) {
            return Ok(());
        }
        let now = io.now_ms();
        let too_soon = self
            .last_reopen_at
            .is_some_and(|at| now - at < ROOM_PROGRAM_REOPEN_SPACING_MS);
        let host_identity = self.state.host_identity.clone().filter(|_| !too_soon);
        let Some(host_identity) = host_identity else {
            // No loop: a plain reason, and the host turns it on again.
            self.state.generation = None;
            self.state.error = Some(ROOM_PROGRAM_LOST.to_string());
            return Ok(());
        };
        self.last_reopen_at = Some(now);
        self.open(io, &host_identity).await
    }

    async fn open(
        &mut self,
        io: &mut impl RoomProgramCameraIo,
        host_identity: &str,
    ) -> anyhow::Result<()> {
        if !io.available() {
            anyhow::bail!(ROOM_PROGRAM_UNAVAILABLE);
        }
        let generation = next_room_program_generation(self.last_generation, io.now_ms());
        self.last_generation = generation;
        match io.open(generation).await {
            Ok(()) => {
                self.state = RoomProgramCameraState {
                    on: true,
                    generation: Some(generation),
                    host_identity: Some(host_identity.to_string()),
                    error: None,
                };
                Ok(())
            }
            Err(error) => {
                self.state = RoomProgramCameraState {
                    error: Some(error.to_string()),
                    ..RoomProgramCameraState::default()
                };
                Err(error)
            }
        }
    }

    async fn close_current(&mut self, io: &mut impl RoomProgramCameraIo) {
        let Some(generation) = self.state.generation.take() else {
            return;
        };
        if io.available() {
            io.close(generation).await;
        }
    }
}

#[cfg(test)]
mod tests {
    //! Ported from `lib/room-program-camera.test.ts`'s opt-in cases.

    use super::*;

    struct FakeIo {
        calls: Vec<String>,
        now: i64,
        available: bool,
        refuse: Option<&'static str>,
    }

    impl FakeIo {
        fn at(now: i64) -> Self {
            Self {
                calls: Vec::new(),
                now,
                available: true,
                refuse: None,
            }
        }
    }

    impl RoomProgramCameraIo for FakeIo {
        fn available(&self) -> bool {
            self.available
        }

        async fn open(&mut self, generation: u64) -> anyhow::Result<()> {
            if let Some(reason) = self.refuse {
                anyhow::bail!(reason);
            }
            self.calls.push(format!("open {generation}"));
            Ok(())
        }

        async fn close(&mut self, generation: u64) {
            self.calls.push(format!("close {generation}"));
        }

        fn now_ms(&self) -> i64 {
            self.now
        }
    }

    #[test]
    fn generations_only_grow_even_across_a_reload() {
        assert_eq!(next_room_program_generation(0, 1_000_000), 1_000);
        assert_eq!(next_room_program_generation(1_000, 1_000_000), 1_001);
        assert_eq!(next_room_program_generation(5, 9_000), 9);
        assert_eq!(next_room_program_generation(5, -9_000), 6);
    }

    #[tokio::test]
    async fn it_is_off_until_the_host_turns_it_on_and_ends_with_its_room() {
        let mut io = FakeIo::at(50_000);
        let mut camera = RoomProgramCamera::new();
        assert_eq!(camera.state(), &RoomProgramCameraState::default());
        camera.set_on(&mut io, true, Some("host:a")).await.unwrap();
        assert_eq!(
            camera.state(),
            &RoomProgramCameraState {
                on: true,
                generation: Some(50),
                host_identity: Some("host:a".into()),
                error: None,
            }
        );
        // The same room again: nothing new.
        camera.set_on(&mut io, true, Some("host:a")).await.unwrap();
        // Still the same room: retire keeps it.
        camera.retire(&mut io, Some("host:a")).await;
        assert!(camera.state().on);
        // The room ended.
        io.now += 10;
        camera.retire(&mut io, None).await;
        assert_eq!(camera.state(), &RoomProgramCameraState::default());
        assert_eq!(io.calls, ["open 50", "close 50"]);
    }

    #[tokio::test]
    async fn another_room_closes_the_old_upload_first() {
        let mut io = FakeIo::at(50_000);
        let mut camera = RoomProgramCamera::new();
        camera.set_on(&mut io, true, Some("host:a")).await.unwrap();
        camera.set_on(&mut io, true, Some("host:b")).await.unwrap();
        assert_eq!(camera.state().host_identity.as_deref(), Some("host:b"));
        assert_eq!(camera.state().generation, Some(51));
        assert_eq!(io.calls, ["open 50", "close 50", "open 51"]);
    }

    #[tokio::test]
    async fn a_broken_upload_reopens_once_under_a_new_generation_then_waits() {
        let mut io = FakeIo::at(100_000);
        let mut camera = RoomProgramCamera::new();
        camera.set_on(&mut io, true, Some("host:a")).await.unwrap();
        camera.reopen(&mut io, 100).await.unwrap();
        assert!(camera.state().on);
        assert_eq!(camera.state().generation, Some(101));
        // A stale generation's report changes nothing.
        camera.reopen(&mut io, 100).await.unwrap();
        assert_eq!(camera.state().generation, Some(101));
        // A second break within a second: no loop, a plain reason.
        io.now += 200;
        camera.reopen(&mut io, 101).await.unwrap();
        assert!(camera.state().on);
        assert_eq!(camera.state().generation, None);
        assert_eq!(camera.state().error.as_deref(), Some(ROOM_PROGRAM_LOST));
        assert_eq!(io.calls, ["open 100", "open 101"]);
    }

    #[tokio::test]
    async fn a_refused_open_leaves_it_off_with_the_reason() {
        let mut io = FakeIo::at(1_000);
        io.refuse = Some("Room program camera is disabled.");
        let mut camera = RoomProgramCamera::new();
        let error = camera
            .set_on(&mut io, true, Some("host:a"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("disabled"));
        assert!(!camera.state().on);
        assert_eq!(
            camera.state().error.as_deref(),
            Some("Room program camera is disabled.")
        );
    }

    #[tokio::test]
    async fn no_room_or_no_camera_is_said_plainly() {
        let mut io = FakeIo::at(1_000);
        let mut camera = RoomProgramCamera::new();
        let error = camera.set_on(&mut io, true, None).await.unwrap_err();
        assert_eq!(error.to_string(), ROOM_PROGRAM_NO_ROOM);
        let error = camera.set_on(&mut io, true, Some("")).await.unwrap_err();
        assert_eq!(error.to_string(), ROOM_PROGRAM_NO_ROOM);
        io.available = false;
        let error = camera
            .set_on(&mut io, true, Some("host:a"))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), ROOM_PROGRAM_UNAVAILABLE);
        assert!(io.calls.is_empty());
    }
}
