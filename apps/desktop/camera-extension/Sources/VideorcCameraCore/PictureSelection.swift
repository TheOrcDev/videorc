/// What the producer last said about itself through the writable property.
public enum ProducerWord: String, Equatable {
    case unknown
    case on
    case off

    public init(word: String?) {
        switch word?.lowercased() {
        case "on": self = .on
        case "off": self = .off
        default: self = .unknown
        }
    }
}

/// The D12 stills drawn by the extension itself.
public enum Still: Hashable {
    case notRunning
    case off

    public var title: String {
        switch self {
        case .notRunning: return VideorcCameraIdentifiers.stillNotRunningTitle
        case .off: return VideorcCameraIdentifiers.stillOffTitle
        }
    }

    public var subtitle: String? {
        switch self {
        case .notRunning: return nil
        case .off: return VideorcCameraIdentifiers.stillOffSubtitle
        }
    }
}

public enum Picture: Equatable {
    /// Relay the newest buffer the producer pushed into the sink.
    case live
    /// Nothing fresh in the sink: draw a still.
    case still(Still)
}

public enum PictureSelection {
    /// Live while the newest push is younger than `staleAfter`; otherwise the
    /// off still when the producer said off, else "isn't running".
    public static func picture(
        producerWord: ProducerWord,
        lastPushAt: Double?,
        now: Double,
        staleAfter: Double = VideorcCameraIdentifiers.staleAfterSeconds
    ) -> Picture {
        if let lastPushAt, now - lastPushAt < staleAfter {
            return .live
        }
        return .still(producerWord == .off ? .off : .notRunning)
    }
}

/// Everything the relay needs to decide what the source stream shows, kept
/// pure so the rules are testable without CoreMediaIO.
public struct RelayState: Equatable {
    public var sourceClients = ClientCounter()
    public var producerWord: ProducerWord = .unknown
    public var lastPushAt: Double?
    public var sinkStreaming = false

    public init() {}

    public mutating func sinkStarted() {
        sinkStreaming = true
    }

    /// The producer let go of the sink (Videorc quit or crashed): whatever it
    /// said before no longer describes a running Videorc.
    public mutating func sinkStopped() {
        sinkStreaming = false
        lastPushAt = nil
        producerWord = .unknown
    }

    public mutating func pushed(at now: Double) {
        lastPushAt = now
    }

    public func picture(now: Double) -> Picture {
        PictureSelection.picture(producerWord: producerWord, lastPushAt: lastPushAt, now: now)
    }
}
