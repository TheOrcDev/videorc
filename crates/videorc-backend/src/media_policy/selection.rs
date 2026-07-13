use crate::media_policy::{BenchmarkPreset, MediaPolicyPreset, MediaPolicySelection};

/// Normalized policy selection where unrecognized preset strings are treated as
/// a safe automatic intent with an explicit reason, so UI copy and diagnostics
/// can explain the downgrade without silently changing the wire intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaPolicyNormalizeResult {
    pub selected_preset: MediaPolicyPreset,
    pub selected_fallback_reason: Option<String>,
}

pub fn normalize_media_policy_preset(raw: &str) -> MediaPolicyNormalizeResult {
    match raw {
        "automatic" => MediaPolicyNormalizeResult {
            selected_preset: MediaPolicyPreset::Automatic,
            selected_fallback_reason: None,
        },
        "performance" => MediaPolicyNormalizeResult {
            selected_preset: MediaPolicyPreset::Performance,
            selected_fallback_reason: None,
        },
        "balanced" => MediaPolicyNormalizeResult {
            selected_preset: MediaPolicyPreset::Balanced,
            selected_fallback_reason: None,
        },
        "quality" => MediaPolicyNormalizeResult {
            selected_preset: MediaPolicyPreset::Quality,
            selected_fallback_reason: None,
        },
        "compatibility" => MediaPolicyNormalizeResult {
            selected_preset: MediaPolicyPreset::Compatibility,
            selected_fallback_reason: None,
        },
        "custom" => MediaPolicyNormalizeResult {
            selected_preset: MediaPolicyPreset::Custom,
            selected_fallback_reason: None,
        },
        _ => MediaPolicyNormalizeResult {
            selected_preset: MediaPolicyPreset::Automatic,
            selected_fallback_reason: Some(
                "requested preset was unknown and fell back to automatic".to_string(),
            ),
        },
    }
}

pub fn normalized_selection_from_wire(raw_preset: &str) -> (MediaPolicySelection, Option<String>) {
    let result = normalize_media_policy_preset(raw_preset);
    let reason = result.selected_fallback_reason.clone();
    let policy = MediaPolicySelection {
        requested: crate::media_policy::MediaPolicyRequest {
            intent: result.selected_preset,
            requested: Default::default(),
        },
        selected: Default::default(),
        fallback_mode: Default::default(),
        fallback_reason: reason.clone(),
        capability_verdict: Default::default(),
        observed_runtime_path: None,
        hardware_fingerprint: None,
        benchmark_recommendation: Some(BenchmarkPreset::Balanced),
    };
    (policy, reason)
}

#[cfg(test)]
mod tests {
    use super::normalize_media_policy_preset;

    #[test]
    fn unknown_preset_normalizes_to_automatic_with_reason() {
        let result = normalize_media_policy_preset("quantum-ultra");
        assert!(matches!(
            result.selected_preset,
            crate::media_policy::MediaPolicyPreset::Automatic
        ));
        assert_eq!(
            result.selected_fallback_reason.as_deref(),
            Some("requested preset was unknown and fell back to automatic")
        );
    }
}
