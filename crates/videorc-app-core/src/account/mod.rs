//! The Videorc account in the core (plan 260, from plan 220 S3.0j). For now
//! its entitlements: what Premium unlocks, read from the backend's signed
//! snapshot, for every page that gates on it (the Studio's start, the Go
//! Live gate, Sidekick, Clean cut, the avatar, Output's quality). Sign-in,
//! the account menu and its refresh land with S1.6f (L4).

pub mod entitlements;

pub use entitlements::{EntitlementGate, ProfileKind};
