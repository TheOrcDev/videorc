//! Wire types from `videorc-backend`'s `source_registry` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use crate::source_status::SourceLifecycleStatus;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct SourceKey {
    pub kind: SourceKind,
    pub id: String,
}

#[allow(dead_code)]
impl SourceKey {
    pub fn camera(id: impl Into<String>) -> Self {
        Self {
            kind: SourceKind::Camera,
            id: id.into(),
        }
    }

    pub fn screen(id: impl Into<String>) -> Self {
        Self {
            kind: SourceKind::Screen,
            id: id.into(),
        }
    }

    pub fn window(id: impl Into<String>) -> Self {
        Self {
            kind: SourceKind::Window,
            id: id.into(),
        }
    }

    pub fn image(id: impl Into<String>) -> Self {
        Self {
            kind: SourceKind::Image,
            id: id.into(),
        }
    }

    pub fn synthetic(id: impl Into<String>) -> Self {
        Self {
            kind: SourceKind::Synthetic,
            id: id.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    Camera,
    Screen,
    Window,
    Image,
    Synthetic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SourceConsumerReason {
    Preview,
    Recording,
    Streaming,
    Diagnostics,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SourceIdentityConfidence {
    #[default]
    Exact,
    NameRematch,
    Fallback,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRegistryEntrySnapshot {
    pub key: SourceKey,
    pub status: SourceLifecycleStatus,
    pub consumers: Vec<SourceConsumerReason>,
    pub identity_confidence: SourceIdentityConfidence,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRegistrySnapshot {
    #[serde(default)]
    pub entries: Vec<SourceRegistryEntrySnapshot>,
}
