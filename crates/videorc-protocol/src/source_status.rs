//! Wire types from `videorc-backend`'s `source_status` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SourceLifecycleStatus {
    #[default]
    Stopped,
    Starting,
    Live,
    PermissionNeeded,
    SourceMissing,
    Failed,
}
