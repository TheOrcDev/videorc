/// Mirrors `apps/desktop/camera-extension/identifiers.json`, the single source
/// of truth shared with Rust and the packaging scripts. Every literal here is
/// checked against the JSON by `scripts/lib/camera-extension-identifiers.test.mjs`
/// (`pnpm test:scripts`) and by the build script before it compiles anything.
public enum VideorcCameraIdentifiers {
    public static let cameraName = "Videorc Camera"
    public static let appBundleID = "dev.theorcdev.videorc"
    public static let extensionBundleID = "dev.theorcdev.videorc.camera"
    public static let teamID = "C2PA37RB58"
    public static let appGroup = "C2PA37RB58.dev.theorcdev.videorc"
    public static let machServiceName = "C2PA37RB58.dev.theorcdev.videorc.camera"
    public static let deviceUUID = "7C2B0687-25A9-44A9-A5FC-3293B79D2853"
    public static let sourceStreamUUID = "1CCC837F-7786-4724-BC71-925249A9FE86"
    public static let sinkStreamUUID = "5599A319-404B-4915-AB63-9ED972F48F71"
    /// Code-signing identifiers allowed to push into the sink: the app itself
    /// (Electron main) and the bare `videorc-backend` binary, whose signing
    /// identifier is its file name.
    public static let producerSigningIDs = ["dev.theorcdev.videorc", "videorc-backend"]
    /// Read-only: how many apps hold the source stream (D13).
    public static let clientCountProperty = "4cc_vccc_glob_0000"
    /// Writable by the producer: "on" or "off" (D12 picks the still from it).
    public static let producerWordProperty = "4cc_vcpw_glob_0000"
    public static let formatWidth = 1920
    public static let formatHeight = 1080
    public static let formatFramesPerSecond = 30
    public static let formatFourCC = "BGRA"
    public static let staleAfterSeconds = 1.0
    public static let stillNotRunningTitle = "Videorc isn't running"
    public static let stillOffTitle = "Videorc Camera is off"
    public static let stillOffSubtitle = "Output → Videorc Camera"
}
