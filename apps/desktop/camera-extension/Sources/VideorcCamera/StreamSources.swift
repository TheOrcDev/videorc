import CoreMedia
import CoreMediaIO
import Foundation
import VideorcCameraCore

/// The stream other apps read. Frames come from the device relay: the newest
/// sink buffer, or a still when the producer is quiet.
final class VideorcCameraSourceStreamSource: NSObject, CMIOExtensionStreamSource {
    private(set) var stream: CMIOExtensionStream!
    private let streamFormat: CMIOExtensionStreamFormat
    private let frameDuration: CMTime
    private unowned let deviceSource: VideorcCameraDeviceSource

    init(
        streamID: UUID,
        streamFormat: CMIOExtensionStreamFormat,
        frameDuration: CMTime,
        deviceSource: VideorcCameraDeviceSource
    ) {
        self.streamFormat = streamFormat
        self.frameDuration = frameDuration
        self.deviceSource = deviceSource
        super.init()
        stream = CMIOExtensionStream(
            localizedName: VideorcCameraIdentifiers.cameraName,
            streamID: streamID,
            direction: .source,
            clockType: .hostTime,
            source: self
        )
    }

    var formats: [CMIOExtensionStreamFormat] {
        [streamFormat]
    }

    /// D11: one format, so the only valid index is 0.
    var activeFormatIndex = 0 {
        didSet {
            if activeFormatIndex != 0 {
                cameraLog.error("A client asked for format index \(self.activeFormatIndex); only 0 exists.")
                activeFormatIndex = 0
            }
        }
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.streamActiveFormatIndex, .streamFrameDuration]
    }

    func streamProperties(
        forProperties properties: Set<CMIOExtensionProperty>
    ) throws -> CMIOExtensionStreamProperties {
        let streamProperties = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) {
            streamProperties.activeFormatIndex = 0
        }
        if properties.contains(.streamFrameDuration) {
            streamProperties.frameDuration = frameDuration
        }
        return streamProperties
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        if let index = streamProperties.activeFormatIndex {
            activeFormatIndex = index
        }
    }

    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        // Any app may watch the camera; that is the point of it.
        true
    }

    func startStream() throws {
        deviceSource.sourceClientStarted()
    }

    func stopStream() throws {
        deviceSource.sourceClientStopped()
    }
}

/// The stream the Videorc producer pushes into (the OBS model). Clients read
/// its `kCMIOStreamPropertyDirection` as 0 (the source stream's is 1; plan
/// 214 P0a, measured), and that is how the backend picks it; its name,
/// "Videorc Camera Sink", is the fallback.
final class VideorcCameraSinkStreamSource: NSObject, CMIOExtensionStreamSource {
    private(set) var stream: CMIOExtensionStream!
    private let streamFormat: CMIOExtensionStreamFormat
    private let frameDuration: CMTime
    private unowned let deviceSource: VideorcCameraDeviceSource

    init(
        streamID: UUID,
        streamFormat: CMIOExtensionStreamFormat,
        frameDuration: CMTime,
        deviceSource: VideorcCameraDeviceSource
    ) {
        self.streamFormat = streamFormat
        self.frameDuration = frameDuration
        self.deviceSource = deviceSource
        super.init()
        stream = CMIOExtensionStream(
            localizedName: "\(VideorcCameraIdentifiers.cameraName) Sink",
            streamID: streamID,
            direction: .sink,
            clockType: .hostTime,
            source: self
        )
    }

    var formats: [CMIOExtensionStreamFormat] {
        [streamFormat]
    }

    var activeFormatIndex = 0 {
        didSet {
            if activeFormatIndex != 0 {
                cameraLog.error("The producer asked for format index \(self.activeFormatIndex); only 0 exists.")
                activeFormatIndex = 0
            }
        }
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.streamActiveFormatIndex, .streamFrameDuration, .streamSinkBufferQueueSize, .streamSinkBuffersRequiredForStartup]
    }

    func streamProperties(
        forProperties properties: Set<CMIOExtensionProperty>
    ) throws -> CMIOExtensionStreamProperties {
        let streamProperties = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) {
            streamProperties.activeFormatIndex = 0
        }
        if properties.contains(.streamFrameDuration) {
            streamProperties.frameDuration = frameDuration
        }
        if properties.contains(.streamSinkBufferQueueSize) {
            // Three in flight matches the compositor's ring; a full queue is a drop the producer counts.
            streamProperties.sinkBufferQueueSize = 3
        }
        if properties.contains(.streamSinkBuffersRequiredForStartup) {
            streamProperties.sinkBuffersRequiredForStartup = 1
        }
        return streamProperties
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        if let index = streamProperties.activeFormatIndex {
            activeFormatIndex = index
        }
    }

    /// Only Videorc's own binaries may push (plan 214 B1). CMIO hands us the
    /// client here and not in `startStream`, so the device remembers it.
    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        deviceSource.sinkAuthorized(client)
    }

    func startStream() throws {
        deviceSource.sinkStarted()
    }

    func stopStream() throws {
        deviceSource.sinkStopped()
    }
}
