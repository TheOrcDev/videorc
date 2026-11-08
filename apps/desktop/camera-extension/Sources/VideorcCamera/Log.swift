import os
import VideorcCameraCore

/// `log stream --predicate 'subsystem == "dev.theorcdev.videorc.camera"'` reads it.
let cameraLog = Logger(subsystem: VideorcCameraIdentifiers.extensionBundleID, category: "camera")
