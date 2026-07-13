use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackPolicy {
    SafeAuto,
    AskFirst,
    Strict,
    HardwareOnly,
    SoftwareOnly,
    Custom,
}

impl Default for FallbackPolicy {
    fn default() -> Self {
        Self::SafeAuto
    }
}

pub fn select_benchmark_recommendation(
    allowed: bool,
    requested: bool,
) -> FallbackPolicy {
    if !allowed && requested {
        FallbackPolicy::AskFirst
    } else if allowed {
        FallbackPolicy::SafeAuto
    } else {
        FallbackPolicy::Custom
    }
}
