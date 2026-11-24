//! Wire types from `videorc-backend`'s `repair` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use serde::{Deserialize, Serialize};

/// The post-recording quality-gate result for one finalized file. This is the backend
/// decision; the renderer-facing status strings (`checking`/`repairing`/`ready`/
/// `not-100%`/`cancelled`) are mapped in the protocol slice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum GateStatus {
    /// Passed every objective gate as-is.
    Ready {
        path: String,
        /// Plan 200 C8: a quick check of a long recording (sampled windows).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        sampled: bool,
    },
    /// Failed the gate but was repaired in place (backup kept) and now passes.
    Repaired { path: String, interpolated: bool },
    /// Could not be brought to 100%; the original visible file is kept, with reasons.
    /// `needs_attention` marks verdicts a user would actually notice (a missing
    /// stream) as opposed to pacing/skew residuals only visible to the analyzer.
    NotHundredPercent {
        path: String,
        reasons: Vec<String>,
        #[serde(default)]
        needs_attention: bool,
        /// Plan 200 C8: a quick check of a long recording (sampled windows).
        /// It is reported, never repaired automatically.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        sampled: bool,
    },
    /// The gate itself could not run (e.g. the file could not be probed).
    Failed { path: String, reason: String },
}
