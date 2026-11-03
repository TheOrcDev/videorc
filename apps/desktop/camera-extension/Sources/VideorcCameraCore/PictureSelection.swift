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
    /// The producer said on but no frame has arrived yet: the moment between
    /// an app picking the camera and the program's first frame.
    case starting

    public var title: String {
        switch self {
        case .notRunning: return VideorcCameraIdentifiers.stillNotRunningTitle
        case .off: return VideorcCameraIdentifiers.stillOffTitle
        case .starting: return VideorcCameraIdentifiers.stillStartingTitle
        }
    }

    public var subtitle: String? {
        switch self {
        case .notRunning: return nil
        case .off: return VideorcCameraIdentifiers.stillOffSubtitle
        case .starting: return nil
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
    /// Live while the newest push is younger than `staleAfter`. Otherwise the
    /// off still when the producer said off, "Starting…" when it said on (an
    /// app just picked the camera and the first frame is on its way), else
    /// "isn't running".
    public static func picture(
        producerWord: ProducerWord,
        lastPushAt: Double?,
        now: Double,
        staleAfter: Double = VideorcCameraIdentifiers.staleAfterSeconds
    ) -> Picture {
        if let lastPushAt, now - lastPushAt < staleAfter {
            return .live
        }
        switch producerWord {
        case .off: return .still(.off)
        case .on: return .still(.starting)
        case .unknown: return .still(.notRunning)
        }
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
