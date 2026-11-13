import XCTest

@testable import VideorcCameraCore

final class SinkAccessTests: XCTestCase {
    func testVideorcBinariesAreAllowed() {
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: "dev.theorcdev.videorc"), .allowed)
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: "videorc-backend"), .allowed)
    }

    func testOtherSignedProcessesAreDenied() {
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: "com.obsproject.obs-studio"), .denied)
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: "dev.theorcdev.videorc.camera"), .denied)
    }

    func testUnknownIdentityIsAcceptedUnverified() {
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: nil), .allowedUnverified)
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: ""), .allowedUnverified)
    }

    func testCMIOUnknownSigningIdentityIsAcceptedUnverified() {
        // CMIO reports this literal for the signed, packaged backend on macOS.
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: "unknown"), .allowedUnverified)
    }

    func testUnknownSentinelDoesNotAllowOtherSigningIdentities() {
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: "com.example.unknown"), .denied)
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: "unknown-producer"), .denied)
    }

    func testAllowlistIsInjectable() {
        XCTAssertEqual(SinkAccessPolicy.decide(signingID: "x", allowlist: ["x"]), .allowed)
    }
}
