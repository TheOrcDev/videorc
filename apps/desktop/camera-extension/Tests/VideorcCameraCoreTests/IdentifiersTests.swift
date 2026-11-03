import XCTest

@testable import VideorcCameraCore

final class IdentifiersTests: XCTestCase {
    func testUUIDsParse() {
        XCTAssertNotNil(UUID(uuidString: VideorcCameraIdentifiers.deviceUUID))
        XCTAssertNotNil(UUID(uuidString: VideorcCameraIdentifiers.sourceStreamUUID))
        XCTAssertNotNil(UUID(uuidString: VideorcCameraIdentifiers.sinkStreamUUID))
        XCTAssertNotEqual(VideorcCameraIdentifiers.sourceStreamUUID, VideorcCameraIdentifiers.sinkStreamUUID)
    }

    func testMachServiceNameIsPrefixedByTheAppGroup() {
        // Apple: the CMIOExtensionMachServiceName must start with an app group the extension holds.
        XCTAssertTrue(VideorcCameraIdentifiers.machServiceName.hasPrefix(VideorcCameraIdentifiers.appGroup + "."))
        XCTAssertTrue(VideorcCameraIdentifiers.appGroup.hasPrefix(VideorcCameraIdentifiers.teamID + "."))
    }

    func testExtensionLivesInsideTheApp() {
        XCTAssertTrue(VideorcCameraIdentifiers.extensionBundleID.hasPrefix(VideorcCameraIdentifiers.appBundleID + "."))
        XCTAssertTrue(VideorcCameraIdentifiers.producerSigningIDs.contains(VideorcCameraIdentifiers.appBundleID))
    }

    func testCustomPropertiesUseTheFourCCForm() {
        let pattern = try! NSRegularExpression(pattern: "^4cc_[a-z]{4}_glob_0000$")
        for name in [VideorcCameraIdentifiers.clientCountProperty, VideorcCameraIdentifiers.producerWordProperty] {
            XCTAssertEqual(pattern.numberOfMatches(in: name, range: NSRange(name.startIndex..., in: name)), 1, name)
        }
        XCTAssertNotEqual(VideorcCameraIdentifiers.clientCountProperty, VideorcCameraIdentifiers.producerWordProperty)
    }
}
