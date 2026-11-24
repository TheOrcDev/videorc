//! The Videorc account and what Premium unlocks (plan 220 S3.0j).
//!
//! - [`entitlements`]: the gates and their sentences (`goLiveEntitlementGate`,
//!   `streamingDestinationEnableGate`, `videoProfileEntitlementGate` …) over
//!   the backend's snapshot, which alone decides the plan.
//!
//! Plan 260 S1.6c lands the gates with the destinations that read them; the
//! sign-in flows, the account row and the refreshes come with their slice.

pub mod entitlements;

pub use entitlements::{EntitlementGate, ProfileKind};
