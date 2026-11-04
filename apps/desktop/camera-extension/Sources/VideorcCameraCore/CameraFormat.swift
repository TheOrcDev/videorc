/// The camera's pixel format table. D11 fixes one format, 1920×1080 32BGRA at
/// 30 fps; the table exists so a second entry is a deliberate, tested edit.
public struct CameraFormat: Equatable {
    public let width: Int
    public let height: Int
    public let framesPerSecond: Int
    /// The CoreVideo pixel format as a four character code, e.g. "BGRA".
    public let fourCC: String

    public init(width: Int, height: Int, framesPerSecond: Int, fourCC: String) {
        self.width = width
        self.height = height
        self.framesPerSecond = framesPerSecond
        self.fourCC = fourCC
    }

    /// `kCVPixelFormatType_32BGRA` is the four character code 'BGRA'.
    public var pixelFormat: UInt32 { fourCharCode(fourCC) }

    public var frameDurationSeconds: Double { 1.0 / Double(framesPerSecond) }

    public static let program = CameraFormat(
        width: VideorcCameraIdentifiers.formatWidth,
        height: VideorcCameraIdentifiers.formatHeight,
        framesPerSecond: VideorcCameraIdentifiers.formatFramesPerSecond,
        fourCC: VideorcCameraIdentifiers.formatFourCC
    )

    public static let table: [CameraFormat] = [.program]
}

/// Packs a four character ASCII code the way CoreVideo and CoreMedia do.
public func fourCharCode(_ code: String) -> UInt32 {
    precondition(code.utf8.count == 4, "a four character code has four bytes")
    return code.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
}
