//! Plan 249 S22: the cloud ISO import model lives in `videorc-protocol`
//! (moved for plan 260 S1.6d, so the backend and the app core share one
//! parser). This module re-exports it so every `crate::cloud_source_iso::X`
//! path stays as it was; its tests moved with it.

pub use videorc_protocol::cloud_source_iso::*;
