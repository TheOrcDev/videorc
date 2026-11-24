//! Toasts from the session (plan 260 S1.6a, from `videorc-rust`'s plan 220
//! S3.0f): the news the session, the backend and the app give the streamer,
//! as Electron's renderer toasts it, in plain data.
//!
//! S1.6a lands this area in parts. This first part holds only the words the
//! session state machine ([`crate::studio::session`]) writes into its own
//! notices; the toasts themselves (`lib/toast.ts`, `lib/notify-once.ts`,
//! `lib/session-runtime-recovery.ts` and friends) arrive with the Studio's
//! driver.

/// The words, exactly as Electron's renderer shows them.
pub mod copy {
    /// `sessionRuntimeNoticeTitle` for a session that died
    /// (`lib/session-runtime-notice.ts`).
    pub const LIVESTREAM_STOPPED_UNEXPECTEDLY: &str = "Livestream stopped unexpectedly";
    pub const RECORDING_STOPPED_UNEXPECTEDLY: &str = "Recording stopped unexpectedly";
    /// `recordingFailurePresentation`'s message when the backend gave none
    /// (`lib/session-runtime-recovery.ts`).
    pub const COULDNT_FINISH_LIVESTREAM: &str = "Videorc couldn't finish this livestream.";
    pub const COULDNT_FINISH_RECORDING: &str = "Videorc couldn't finish this recording.";
}
