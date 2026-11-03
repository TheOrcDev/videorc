import CoreMedia
import CoreMediaIO
import CoreVideo
import Foundation
import IOKit.audio
import VideorcCameraCore

/// One device, "Videorc Camera", with a source stream other apps read and a
/// sink stream the Videorc producer pushes into. The relay between them runs
/// on one serial queue: every `send` to the source stream goes through it.
final class VideorcCameraDeviceSource: NSObject, CMIOExtensionDeviceSource {
    private(set) var device: CMIOExtensionDevice!
    private var sourceStreamSource: VideorcCameraSourceStreamSource!
    private var sinkStreamSource: VideorcCameraSinkStreamSource!

    private let relayQueue = DispatchQueue(label: "\(VideorcCameraIdentifiers.extensionBundleID).relay")
    private var relay = RelayState()
    private var sinkClient: CMIOExtensionClient?
    private var stillTimer: DispatchSourceTimer?
    private let stills = StillRenderer(format: .program)
    private let frameDuration = CMTime(
        value: 1,
        timescale: CMTimeScale(CameraFormat.program.framesPerSecond)
    )

    private let clientCountProperty = CMIOExtensionProperty(
        rawValue: VideorcCameraIdentifiers.clientCountProperty
    )
    private let producerWordProperty = CMIOExtensionProperty(
        rawValue: VideorcCameraIdentifiers.producerWordProperty
    )

    override init() {
        super.init()
        guard let deviceID = UUID(uuidString: VideorcCameraIdentifiers.deviceUUID),
            let sourceStreamID = UUID(uuidString: VideorcCameraIdentifiers.sourceStreamUUID),
            let sinkStreamID = UUID(uuidString: VideorcCameraIdentifiers.sinkStreamUUID)
        else {
            fatalError("identifiers.json holds an invalid UUID")
        }
        device = CMIOExtensionDevice(
            localizedName: VideorcCameraIdentifiers.cameraName,
            deviceID: deviceID,
            legacyDeviceID: nil,
            source: self
        )

        let format = CameraFormat.program
        var formatDescription: CMFormatDescription?
        let status = CMVideoFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            codecType: format.pixelFormat,
            width: Int32(format.width),
            height: Int32(format.height),
            extensions: nil,
            formatDescriptionOut: &formatDescription
        )
        guard status == noErr, let formatDescription else {
            fatalError("CMVideoFormatDescriptionCreate failed: \(status)")
        }
        let streamFormat = CMIOExtensionStreamFormat(
            formatDescription: formatDescription,
            maxFrameDuration: frameDuration,
            minFrameDuration: frameDuration,
            validFrameDurations: nil
        )
        sourceStreamSource = VideorcCameraSourceStreamSource(
            streamID: sourceStreamID,
            streamFormat: streamFormat,
            frameDuration: frameDuration,
            deviceSource: self
        )
        sinkStreamSource = VideorcCameraSinkStreamSource(
            streamID: sinkStreamID,
            streamFormat: streamFormat,
            frameDuration: frameDuration,
            deviceSource: self
        )
        do {
            try device.addStream(sourceStreamSource.stream)
            try device.addStream(sinkStreamSource.stream)
        } catch {
            fatalError("Could not add the Videorc Camera streams: \(error.localizedDescription)")
        }
    }

    // MARK: - CMIOExtensionDeviceSource

    var availableProperties: Set<CMIOExtensionProperty> {
        [.deviceTransportType, .deviceModel, clientCountProperty, producerWordProperty]
    }

    func deviceProperties(
        forProperties properties: Set<CMIOExtensionProperty>
    ) throws -> CMIOExtensionDeviceProperties {
        let deviceProperties = CMIOExtensionDeviceProperties(dictionary: [:])
        if properties.contains(.deviceTransportType) {
            deviceProperties.transportType = kIOAudioDeviceTransportTypeVirtual
        }
        if properties.contains(.deviceModel) {
            deviceProperties.model = VideorcCameraIdentifiers.cameraName
        }
        let snapshot = relayQueue.sync { relay }
        if properties.contains(clientCountProperty) {
            deviceProperties.setPropertyState(
                CMIOExtensionPropertyState(value: NSNumber(value: snapshot.sourceClients.count)),
                forProperty: clientCountProperty
            )
        }
        if properties.contains(producerWordProperty) {
            deviceProperties.setPropertyState(
                CMIOExtensionPropertyState(value: snapshot.producerWord.rawValue as NSString),
                forProperty: producerWordProperty
            )
        }
        return deviceProperties
    }

    func setDeviceProperties(_ deviceProperties: CMIOExtensionDeviceProperties) throws {
        if let state = deviceProperties.propertiesDictionary[producerWordProperty],
            let word = state.value as? String
        {
            relayQueue.async {
                self.relay.producerWord = ProducerWord(word: word)
                cameraLog.info("producer word: \(word, privacy: .public)")
            }
        }
    }

    // MARK: - Source clients (D13)

    func sourceClientStarted() {
        relayQueue.async {
            let count = self.relay.sourceClients.clientStarted()
            self.publishClientCount(count)
            self.ensureStillTimer()
        }
    }

    func sourceClientStopped() {
        relayQueue.async {
            let count = self.relay.sourceClients.clientStopped()
            self.publishClientCount(count)
            if count == 0 {
                self.stopStillTimer()
            }
        }
    }

    private func publishClientCount(_ count: Int) {
        cameraLog.info("viewers: \(count)")
        device.notifyPropertiesChanged([
            clientCountProperty: CMIOExtensionPropertyState<AnyObject>(value: NSNumber(value: count))
        ])
    }

    // MARK: - The sink (the Videorc producer)

    func sinkAuthorized(_ client: CMIOExtensionClient) -> Bool {
        let signingID = client.signingID
        switch SinkAccessPolicy.decide(signingID: signingID) {
        case .denied:
            cameraLog.error("refused a sink client signed as \(signingID ?? "nil", privacy: .public)")
            return false
        case .allowedUnverified:
            cameraLog.notice("sink client has no signing id; accepted unverified")
        case .allowed:
            break
        }
        relayQueue.sync { sinkClient = client }
        return true
    }

    func sinkStarted() {
        relayQueue.async {
            self.relay.sinkStarted()
            self.consumeNextSinkBuffer()
        }
    }

    func sinkStopped() {
        relayQueue.async {
            self.relay.sinkStopped()
            self.sinkClient = nil
        }
    }

    /// Runs on `relayQueue`. Re-arms itself after every buffer while the sink
    /// streams; the newest pushed buffer goes straight to the source stream.
    private func consumeNextSinkBuffer() {
        guard relay.sinkStreaming, let client = sinkClient else {
            return
        }
        sinkStreamSource.stream.consumeSampleBuffer(from: client) { [weak self] sampleBuffer, sequenceNumber, _, _, error in
            guard let self else {
                return
            }
            self.relayQueue.async {
                if let sampleBuffer {
                    let now = CMClockGetTime(CMClockGetHostTimeClock())
                    self.relay.pushed(at: now.seconds)
                    if self.relay.sourceClients.isStreaming {
                        self.sourceStreamSource.stream.send(
                            sampleBuffer,
                            discontinuity: [],
                            hostTimeInNanoseconds: UInt64(sampleBuffer.presentationTimeStamp.seconds * Double(NSEC_PER_SEC))
                        )
                    }
                    self.sinkStreamSource.stream.notifyScheduledOutputChanged(
                        CMIOExtensionScheduledOutput(
                            sequenceNumber: sequenceNumber,
                            hostTimeInNanoseconds: UInt64(now.seconds * Double(NSEC_PER_SEC))
                        )
                    )
                    self.consumeNextSinkBuffer()
                } else {
                    if let error {
                        cameraLog.error("sink consume failed: \(error.localizedDescription, privacy: .public)")
                    }
                    // A failed consume without a buffer must not spin.
                    self.relayQueue.asyncAfter(deadline: .now() + .milliseconds(50)) {
                        self.consumeNextSinkBuffer()
                    }
                }
            }
        }
    }

    // MARK: - Stills (D12)

    /// Runs on `relayQueue`. Ticks at the frame rate while any app watches;
    /// each tick draws the still only when the sink has gone quiet.
    private func ensureStillTimer() {
        guard stillTimer == nil else {
            return
        }
        let timer = DispatchSource.makeTimerSource(queue: relayQueue)
        timer.schedule(
            deadline: .now(),
            repeating: CameraFormat.program.frameDurationSeconds,
            leeway: .milliseconds(2)
        )
        timer.setEventHandler { [weak self] in
            self?.stillTick()
        }
        timer.resume()
        stillTimer = timer
    }

    private func stopStillTimer() {
        stillTimer?.cancel()
        stillTimer = nil
    }

    private func stillTick() {
        guard relay.sourceClients.isStreaming else {
            return
        }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        guard case .still(let still) = relay.picture(now: now.seconds) else {
            return
        }
        guard let sampleBuffer = stills.sampleBuffer(for: still, presentationTime: now, duration: frameDuration) else {
            cameraLog.error("could not render the \(String(describing: still), privacy: .public) still")
            return
        }
        sourceStreamSource.stream.send(
            sampleBuffer,
            discontinuity: [],
            hostTimeInNanoseconds: UInt64(now.seconds * Double(NSEC_PER_SEC))
        )
    }
}
