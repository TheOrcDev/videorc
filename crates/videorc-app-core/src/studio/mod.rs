//! The Studio's state and view-models without a UI (plan 260 S1.6a, L7),
//! from `videorc-rust`'s app-core Studio, caught up with today's
//! `apps/desktop/src/renderer/src/hooks/use-studio.tsx`.
//!
//! S1.6a lands this area in parts:
//!
//! - [`session`]: the session state machine (idle, starting, recording,
//!   live, stopping, failed), the start and stop flows' pure halves, the
//!   stop door and the failure notices.
//! - [`latency`]: the record click-to-status samples.
//! - [`settings`]: the persisted UI settings (`UiSettingsCache`, the write
//!   journal, `StudioSettings` from `videorc.settings`), with
//!   [`capture_config`] (`lib/capture.ts`'s loader, repairs and writer),
//!   [`families`] (every other key family), [`camera_background`] (plan
//!   258's normalizers), [`js_value`] (JavaScript's value rules the loaders
//!   need) and [`ui_local`] (this device's conveniences). The wire shapes
//!   wait in [`ui_settings_wire`] until L2's S1.4 adds them to the protocol.
//! - [`health`] and [`health_page`]: `health.ping`, the health events and
//!   the Health page's telemetry, checks, verdict and metric groups, with
//!   [`virtual_camera`] (Videorc Camera's words) and [`timecode`]
//!   (`shared/timecode.ts`).
//! - [`start_blocked_copy`] and [`support_bundle_copy`]: the start's and
//!   the support bundle's words. The session's toasts are
//!   [`crate::notices`], a failed action's words [`crate::user_error`].
//! - [`preview_scene`]: the scene reload rule L1's preview feed reads (S1.6s,
//!   L4); its Studio half comes with the driver.
//! - [`source_selection`]: only the picker's kind for now (S1.6b brings the
//!   rest).
//!
//! The driver that runs all of it against the typed client follows in
//! S1.6a's next part.

pub mod camera_background;
pub mod capture_config;
pub mod families;
pub mod health;
pub mod health_page;
pub mod js_value;
pub mod latency;
pub mod preview_scene;
pub mod session;
pub mod settings;
pub mod source_selection;
pub mod timecode;
pub mod ui_local;
pub mod ui_settings_wire;
pub mod virtual_camera;

/// `lib/start-blocked-copy.ts`: why a start waits, in the streamer's words
/// (plan 174 B-22).
pub mod start_blocked_copy {
    /// `connectionBlockedReason('waiting' | 'connecting')`.
    pub const ENGINE_STARTING: &str = "Starting Videorc's capture engine…";
    /// `connectionBlockedReason` for every other non-connected status.
    pub const RECONNECTING: &str = "Videorc is reconnecting. Try again in a moment.";
    /// `START_BLOCKED_COPY.sessionRunning`.
    pub const SESSION_RUNNING: &str = "A recording or livestream is already running.";
    /// `START_BLOCKED_COPY.noOutput`.
    pub const NO_OUTPUT: &str = "Turn on Save local recording in Output, or go live.";
    /// `START_BLOCKED_COPY.destinationSetup` (#1357: the page is
    /// Destinations): a destination on that is not ready to start.
    pub const DESTINATION_SETUP: &str =
        "Finish setting up your destination in Destinations before you go live.";
    /// `START_BLOCKED_COPY.noDestination`: a livestream with no destination
    /// turned on.
    pub const NO_DESTINATION: &str = "Turn on a destination in Destinations before you go live.";
    /// `START_BLOCKED_COPY.checkingRecorder`.
    pub const CHECKING_RECORDER: &str = "Checking the recorder…";
    /// `START_BLOCKED_COPY.recorderMissing`.
    pub const RECORDER_MISSING: &str =
        "Videorc's recorder isn't available. Export a support bundle from Health.";
}

/// The support bundle's words (`exportSupportBundle` in `use-studio.tsx`,
/// and `reportError`'s `userErrorMessage` for its failures: `couldNotTitle`
/// and `UNKNOWN_REASON` in `lib/user-error.ts`).
pub mod support_bundle_copy {
    pub const EXPORTED: &str = "Support bundle exported";
    pub const EXPORT_FAILED: &str = "Couldn't export a support bundle";
    pub const REVEAL_FAILED: &str = "Couldn't show the support bundle";
    /// `UNKNOWN_REASON`: the next step when Videorc doesn't know why.
    pub const UNKNOWN_REASON: &str =
        "Try again. If it keeps happening, export a support bundle from Health.";
}
