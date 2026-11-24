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
//! - [`preview_scene`]: the scene reload rule L1's preview feed reads (S1.6s,
//!   L4); its Studio half comes with the driver.
//!
//! Health and the session's toasts, and the driver that runs all of it
//! against the typed client, follow in S1.6a's next parts.

pub mod camera_background;
pub mod capture_config;
pub mod families;
pub mod js_value;
pub mod latency;
pub mod preview_scene;
pub mod session;
pub mod settings;
pub mod ui_local;
pub mod ui_settings_wire;
