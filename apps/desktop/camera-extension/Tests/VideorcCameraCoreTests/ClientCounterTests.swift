import XCTest

@testable import VideorcCameraCore

final class ClientCounterTests: XCTestCase {
    func testCountsStartsAndStops() {
        var counter = ClientCounter()
        XCTAssertFalse(counter.isStreaming)
        XCTAssertEqual(counter.clientStarted(), 1)
        XCTAssertEqual(counter.clientStarted(), 2)
        XCTAssertTrue(counter.isStreaming)
        XCTAssertEqual(counter.clientStopped(), 1)
        XCTAssertEqual(counter.clientStopped(), 0)
        XCTAssertFalse(counter.isStreaming)
    }

    func testNeverGoesNegative() {
        var counter = ClientCounter()
        XCTAssertEqual(counter.clientStopped(), 0)
        XCTAssertEqual(counter.clientStopped(), 0)
        XCTAssertEqual(counter.clientStarted(), 1)
    }
}
