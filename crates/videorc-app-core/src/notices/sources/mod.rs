//! Where the reports come from (plan 250, Electron's
//! `lib/notifications/sources/`). Each source builds its [`Input`]s and
//! resolutions as plain data; an entry's buttons are data too. When the
//! streamer presses one, the store hands back the [`super::Action`] and the
//! source's `run_action` sends it to the Studio through two small traits:
//! [`HealthPage`] (the pages a door opens) and [`Transport`] (what the
//! backend and the shell do). L7 implements them on the Studio.
//!
//! [`Input`]: super::Input

pub mod devices;
pub mod health;
pub mod work;

/// `OPEN_HEALTH_LABEL`: the Health door's one name, as S1.6a's Health
/// page keeps it.
pub use crate::studio::health_page::OPEN_HEALTH_LABEL;

/// A page or section a door opens (`lib/health-door.ts`,
/// `lib/section-doors.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Door {
    /// `openHealth`: the Health page (id `diagnostics`).
    Health,
    /// `openOutputClips`: Output, at Clips.
    OutputClips,
    /// `openDestinations(targetId?)`.
    Destinations { target_id: Option<String> },
    /// Clean cut, for a recording (`clean-cut-auto` "Open Clean cut").
    CleanCut { session_id: String },
    /// A finished clean cut's review ("Review").
    CleanCutReview { job_id: String },
    /// `openStudioAudio`: the Studio's Audio section ("Open Audio").
    Audio,
    /// The Sources page ("Open Sources").
    Sources,
    /// `openSourcesSystemAudio`: Sources, at System audio ("Open Sources").
    SystemAudio,
    /// `openOutputRecordings`: Output, at Recordings ("Open Output").
    OutputRecordings,
    /// Settings, at Permissions ("Open Permissions").
    Permissions,
    /// `openLibraryRecording(id)`, or the Library tab when the entry names
    /// no take ("Open in Library").
    Library { session_id: Option<String> },
}

/// The Studio's pages, as the doors need them.
pub trait HealthPage {
    fn open(&mut self, door: Door);
}

/// What a fix asks of the Studio, the backend or the shell.
pub trait Transport {
    /// `window.videorc.revealSession`: the take's file in Finder or Explorer.
    fn reveal_session(&mut self, session_id: &str);
    /// The MP4 export again, for a take whose export failed.
    fn retry_mp4_export(&mut self, session_id: &str);
    /// A downloaded cloud recording's file in Finder or Explorer.
    fn reveal_cloud_download(&mut self, recording_id: &str);
    /// "Use it": the source that came back, by its key, in place of the
    /// stand-in the session runs on.
    fn use_returned_source(&mut self, key: &str);
    /// `requestSystemAudioResume`: System audio on again after the echo
    /// guard paused it.
    fn resume_system_audio(&mut self);
}

/// `revealInFileManagerLabel`, as S1.6a's toasts keep it: "Show in
/// Finder", "Show in Explorer" or "Show in folder".
pub use super::reveal_in_file_manager_label as reveal_label;
