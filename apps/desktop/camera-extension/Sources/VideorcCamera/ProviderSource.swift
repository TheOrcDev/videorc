import CoreMediaIO
import Foundation
import VideorcCameraCore

/// The provider owns the one device. Clients (Meet, Zoom, the Videorc
/// producer) connect to the provider and read the device's streams.
final class VideorcCameraProviderSource: NSObject, CMIOExtensionProviderSource {
    private(set) var provider: CMIOExtensionProvider!
    private var deviceSource: VideorcCameraDeviceSource!

    init(clientQueue: DispatchQueue?) {
        super.init()
        provider = CMIOExtensionProvider(source: self, clientQueue: clientQueue)
        deviceSource = VideorcCameraDeviceSource()
        do {
            try provider.addDevice(deviceSource.device)
        } catch {
            cameraLog.fault("Could not add Videorc Camera: \(error.localizedDescription, privacy: .public)")
            fatalError("Could not add Videorc Camera: \(error.localizedDescription)")
        }
    }

    func connect(to client: CMIOExtensionClient) throws {
        cameraLog.info("client connected: \(client.signingID ?? "(no signing id)", privacy: .public)")
    }

    func disconnect(from client: CMIOExtensionClient) {
        cameraLog.info("client disconnected: \(client.signingID ?? "(no signing id)", privacy: .public)")
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.providerManufacturer]
    }

    func providerProperties(
        forProperties properties: Set<CMIOExtensionProperty>
    ) throws -> CMIOExtensionProviderProperties {
        let providerProperties = CMIOExtensionProviderProperties(dictionary: [:])
        if properties.contains(.providerManufacturer) {
            providerProperties.manufacturer = "Videorc"
        }
        return providerProperties
    }

    func setProviderProperties(_ providerProperties: CMIOExtensionProviderProperties) throws {
        // Nothing on the provider is writable.
    }
}
