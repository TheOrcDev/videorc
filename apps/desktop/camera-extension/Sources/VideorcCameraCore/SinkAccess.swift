/// Who may push into the sink stream. CMIO reports the client's code-signing
/// identifier; OBS checks nothing, we check what we can.
public enum SinkAccess: Equatable {
    /// The identifier is one of Videorc's.
    case allowed
    /// CMIO reported no identifier at all. Refusing would leave the camera
    /// black whenever CMIO cannot read the producer's identity, so the push is
    /// accepted and logged; F2 on the lab Mac records what CMIO reports.
    case allowedUnverified
    /// A signed process that is not Videorc.
    case denied
}

public enum SinkAccessPolicy {
    public static func decide(
        signingID: String?,
        allowlist: [String] = VideorcCameraIdentifiers.producerSigningIDs
    ) -> SinkAccess {
        guard let signingID, !signingID.isEmpty else {
            return .allowedUnverified
        }
        return allowlist.contains(signingID) ? .allowed : .denied
    }
}
