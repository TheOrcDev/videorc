import XCTest

@testable import VideorcCameraCore

final class CameraFormatTests: XCTestCase {
    func testTableHoldsTheOneD11Format() {
        XCTAssertEqual(CameraFormat.table, [CameraFormat.program])
        XCTAssertEqual(CameraFormat.program.width, 1920)
        XCTAssertEqual(CameraFormat.program.height, 1080)
        XCTAssertEqual(CameraFormat.program.framesPerSecond, 30)
        XCTAssertEqual(CameraFormat.program.fourCC, "BGRA")
    }

    func testPixelFormatIsCoreVideo32BGRA() {
        // kCVPixelFormatType_32BGRA is 'BGRA'.
        XCTAssertEqual(CameraFormat.program.pixelFormat, 0x4247_5241)
        XCTAssertEqual(fourCharCode("BGRA"), 0x4247_5241)
        XCTAssertEqual(fourCharCode("420v"), 0x3432_3076)
    }

    func testFrameDurationIsOneThirtieth() {
        XCTAssertEqual(CameraFormat.program.frameDurationSeconds, 1.0 / 30.0, accuracy: 1e-12)
    }
}
