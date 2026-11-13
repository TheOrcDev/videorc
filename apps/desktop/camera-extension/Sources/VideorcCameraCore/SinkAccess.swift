/// Who may push into the sink stream. CMIO reports the client's code-signing
/// identifier; OBS checks nothing, we check what we can.
public enum SinkAccess: Equatable {
    /// The identifier is one of Videorc's.
    case allowed
    /// CMIO could not read the producer's identity (nil, empty, or the literal
    /// "unknown"). Refusing would leave the camera showing its not-running
    /// still, so the push is accepted and logged as unverified.
    case allowedUnverified
    /// A signed process that is not Videorc.
    case denied
}

public enum SinkAccessPolicy {
    public static func decide(
        signingID: String?,
        allowlist: [String] = VideorcCameraIdentifiers.producerSigningIDs
    ) -> SinkAccess {
        // CMIO can return "unknown" even for our Developer ID signed backend.
        // Treat only that exact sentinel as missing identity information.
        guard let signingID, !signingID.isEmpty, signingID != "unknown" else {
            return .allowedUnverified
        }
        return allowlist.contains(signingID) ? .allowed : .denied
    }
}
