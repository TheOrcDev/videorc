use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackPolicy {
    #[default]
    SafeAuto,
    AskFirst,
    Strict,
    HardwareOnly,
    SoftwareOnly,
    Custom,
}

pub fn select_benchmark_recommendation(allowed: bool, requested: bool) -> FallbackPolicy {
    if !allowed && requested {
        FallbackPolicy::AskFirst
    } else if allowed {
        FallbackPolicy::SafeAuto
    } else {
        FallbackPolicy::Custom
    }
}
