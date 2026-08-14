/// Camera-bubble mask shared by the CPU and Metal compositors. FFmpeg mirrors
/// the same geometry through `SceneMask` when it builds its filter graph.
///
/// This type deliberately lives in a platform-neutral module so Linux builds
/// and the standalone macOS native-preview helper do not need to reach through
/// the macOS-only Metal implementation to compile shared scene code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceMask {
    None,
    Circle,
    Rounded { radius_pct: u32 },
}
