use serde::{Deserialize, Serialize};

/// Canonical media policy presets shared by Linux-aware Linux and future desktop
/// adapters.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MediaPolicyPreset {
    #[default]
    Automatic,
    Performance,
    Balanced,
    Quality,
    Compatibility,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MediaPolicyFallbackMode {
    #[default]
    SafeAuto,
    AskFirst,
    Strict,
    HardwareOnly,
    SoftwareOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MediaPolicyCapabilityVerdict {
    Supported,
    Degraded,
    Unavailable,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MediaCaptureBackendId {
    PipewirePortal,
    ElectronPortal,
    #[serde(rename = "ffmpeg-x11")]
    FfmpegX11,
    TestPattern,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MediaAudioBackendId {
    Pipewire,
    PulseCompat,
    AlsaCompat,
    TestTone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MediaCompositorBackendId {
    #[default]
    Automatic,
    Cpu,
    Wgpu,
    #[serde(rename = "ffmpeg-compat")]
    FfmpegCompat,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MediaPreviewBackendId {
    #[default]
    Automatic,
    #[serde(rename = "native-wgpu")]
    NativeWgpu,
    #[serde(rename = "electron-webgl")]
    ElectronWebgl,
    MjpegDebug,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum MediaEncoderBackendId {
    H264Vaapi,
    H264Qsv,
    Libx264,
    Libopenh264,
    #[default]
    Automatic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum BenchmarkPreset {
    Performance,
    #[default]
    Balanced,
    Quality,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaBackendPolicy {
    pub capture: MediaCaptureBackendId,
    pub audio: MediaAudioBackendId,
    pub compositor: MediaCompositorBackendId,
    pub preview: MediaPreviewBackendId,
    pub recording_encoder: MediaEncoderBackendId,
    pub streaming_encoder: MediaEncoderBackendId,
    #[serde(default)]
    pub benchmark_recommendation: Option<BenchmarkPreset>,
}

impl Default for MediaBackendPolicy {
    fn default() -> Self {
        Self {
            capture: MediaCaptureBackendId::PipewirePortal,
            audio: MediaAudioBackendId::Pipewire,
            compositor: MediaCompositorBackendId::Automatic,
            preview: MediaPreviewBackendId::Automatic,
            recording_encoder: MediaEncoderBackendId::Automatic,
            streaming_encoder: MediaEncoderBackendId::Automatic,
            benchmark_recommendation: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPolicyRequest {
    #[serde(default)]
    pub intent: MediaPolicyPreset,
    #[serde(default)]
    pub requested: MediaBackendPolicy,
}

impl Default for MediaPolicyRequest {
    fn default() -> Self {
        Self {
            intent: MediaPolicyPreset::Automatic,
            requested: MediaBackendPolicy::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaPolicySelection {
    #[serde(default)]
    pub requested: MediaPolicyRequest,
    #[serde(default)]
    pub selected: MediaBackendPolicy,
    #[serde(default)]
    pub fallback_mode: MediaPolicyFallbackMode,
    #[serde(default)]
    pub fallback_reason: Option<String>,
    #[serde(default)]
    pub capability_verdict: MediaPolicyCapabilityVerdict,
    #[serde(default)]
    pub observed_runtime_path: Option<String>,
    #[serde(default)]
    pub hardware_fingerprint: Option<String>,
    #[serde(default)]
    pub benchmark_recommendation: Option<BenchmarkPreset>,
}

impl Default for MediaPolicySelection {
    fn default() -> Self {
        Self {
            requested: MediaPolicyRequest::default(),
            selected: MediaBackendPolicy::default(),
            fallback_mode: MediaPolicyFallbackMode::SafeAuto,
            fallback_reason: None,
            capability_verdict: MediaPolicyCapabilityVerdict::Unknown,
            observed_runtime_path: None,
            hardware_fingerprint: None,
            benchmark_recommendation: None,
        }
    }
}
