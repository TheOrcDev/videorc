// swift-tools-version: 5.9
// Plan 214 B1: the Videorc Camera system extension. `VideorcCameraCore` is the
// pure half (format table, client counting, still selection, sink access) and
// has XCTest coverage; `VideorcCamera` is the CMIOExtension executable that
// scripts/build-camera-extension.mjs wraps into VideorcCamera.systemextension.
// The deployment target is pinned here (macOS 13, the app's floor).
import PackageDescription

let package = Package(
    name: "VideorcCamera",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "VideorcCamera", targets: ["VideorcCamera"])
    ],
    targets: [
        .target(name: "VideorcCameraCore"),
        .executableTarget(
            name: "VideorcCamera",
            dependencies: ["VideorcCameraCore"],
            linkerSettings: [
                .linkedFramework("CoreMediaIO"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CoreText"),
                .linkedFramework("IOKit")
            ]
        ),
        .testTarget(name: "VideorcCameraCoreTests", dependencies: ["VideorcCameraCore"])
    ]
)
