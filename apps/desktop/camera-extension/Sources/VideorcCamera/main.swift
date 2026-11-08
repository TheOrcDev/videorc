// Plan 214 B1: the Videorc Camera extension entry point. CMIO launches this
// executable as `_cmiodalassistants` inside the app sandbox and talks to it
// over the mach service named in Info.plist (CMIOExtensionMachServiceName).
import CoreMediaIO
import Foundation

let providerSource = VideorcCameraProviderSource(clientQueue: nil)
CMIOExtensionProvider.startService(provider: providerSource.provider)
CFRunLoopRun()
