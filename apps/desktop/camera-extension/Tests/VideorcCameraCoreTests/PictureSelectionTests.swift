import XCTest

@testable import VideorcCameraCore

final class PictureSelectionTests: XCTestCase {
    func testLiveWhileThePushIsFresh() {
        XCTAssertEqual(PictureSelection.picture(producerWord: .on, lastPushAt: 10.0, now: 10.5), .live)
        XCTAssertEqual(PictureSelection.picture(producerWord: .unknown, lastPushAt: 10.0, now: 10.99), .live)
    }

    func testStaleAtExactlyOneSecond() {
        XCTAssertEqual(
            PictureSelection.picture(producerWord: .on, lastPushAt: 10.0, now: 11.0),
            .still(.notRunning)
        )
    }

    func testNeverPushedShowsNotRunning() {
        XCTAssertEqual(
            PictureSelection.picture(producerWord: .unknown, lastPushAt: nil, now: 0),
            .still(.notRunning)
        )
    }

    func testOffWordShowsTheOffStillOnceStale() {
        XCTAssertEqual(PictureSelection.picture(producerWord: .off, lastPushAt: 10.0, now: 10.2), .live)
        XCTAssertEqual(
            PictureSelection.picture(producerWord: .off, lastPushAt: 10.0, now: 12.0),
            .still(.off)
        )
        XCTAssertEqual(PictureSelection.picture(producerWord: .off, lastPushAt: nil, now: 0), .still(.off))
    }

    func testCustomStaleWindow() {
        XCTAssertEqual(
            PictureSelection.picture(producerWord: .on, lastPushAt: 0, now: 2.5, staleAfter: 3),
            .live
        )
    }

    func testStillCopyComesFromTheIdentifiers() {
        XCTAssertEqual(Still.notRunning.title, "Videorc isn't running")
        XCTAssertNil(Still.notRunning.subtitle)
        XCTAssertEqual(Still.off.title, "Videorc Camera is off")
        XCTAssertEqual(Still.off.subtitle, "Output → Videorc Camera")
    }

    func testProducerWordParsing() {
        XCTAssertEqual(ProducerWord(word: "on"), .on)
        XCTAssertEqual(ProducerWord(word: "ON"), .on)
        XCTAssertEqual(ProducerWord(word: "off"), .off)
        XCTAssertEqual(ProducerWord(word: "paused"), .unknown)
        XCTAssertEqual(ProducerWord(word: nil), .unknown)
    }

    func testRelayStateForgetsTheProducerWhenTheSinkStops() {
        var relay = RelayState()
        relay.sinkStarted()
        relay.producerWord = .off
        relay.pushed(at: 5)
        XCTAssertEqual(relay.picture(now: 5.5), .live)
        XCTAssertEqual(relay.picture(now: 7), .still(.off))

        relay.sinkStopped()
        XCTAssertFalse(relay.sinkStreaming)
        XCTAssertEqual(relay.picture(now: 7), .still(.notRunning), "a gone producer is not running, whatever it said last")
    }

    func testRelayStateLiveAgainAfterAPush() {
        var relay = RelayState()
        relay.sinkStarted()
        XCTAssertEqual(relay.picture(now: 1), .still(.notRunning))
        relay.pushed(at: 1)
        XCTAssertEqual(relay.picture(now: 1.5), .live)
    }
}
