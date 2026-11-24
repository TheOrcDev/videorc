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
//! - [`preview_scene`]: the scene reload rule L1's preview feed reads (S1.6s,
//!   L4); its Studio half comes with the driver.
//!
//! The settings model, Health and the session's toasts, and the driver that
//! runs them against the typed client follow in S1.6a's next parts.

pub mod latency;
pub mod preview_scene;
pub mod session;
