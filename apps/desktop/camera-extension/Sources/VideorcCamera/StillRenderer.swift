import CoreGraphics
import CoreMedia
import CoreText
import CoreVideo
import Foundation
import VideorcCameraCore

/// Draws the D12 stills once each into IOSurface-backed 32BGRA buffers and
/// re-sends the cached buffer with fresh timestamps at the frame rate.
final class StillRenderer {
    private let format: CameraFormat
    private var pool: CVPixelBufferPool?
    private var cache: [Still: (CVPixelBuffer, CMFormatDescription)] = [:]

    init(format: CameraFormat) {
        self.format = format
    }

    func sampleBuffer(for still: Still, presentationTime: CMTime, duration: CMTime) -> CMSampleBuffer? {
        guard let (pixelBuffer, formatDescription) = rendered(still) else {
            return nil
        }
        var timing = CMSampleTimingInfo(
            duration: duration,
            presentationTimeStamp: presentationTime,
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        let status = CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            dataReady: true,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: formatDescription,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )
        return status == noErr ? sampleBuffer : nil
    }

    private func rendered(_ still: Still) -> (CVPixelBuffer, CMFormatDescription)? {
        if let cached = cache[still] {
            return cached
        }
        guard let pixelBuffer = makePixelBuffer() else {
            return nil
        }
        draw(still, into: pixelBuffer)
        var formatDescription: CMFormatDescription?
        let status = CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDescription
        )
        guard status == noErr, let formatDescription else {
            return nil
        }
        cache[still] = (pixelBuffer, formatDescription)
        return (pixelBuffer, formatDescription)
    }

    private func makePixelBuffer() -> CVPixelBuffer? {
        if pool == nil {
            let attributes: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: format.pixelFormat,
                kCVPixelBufferWidthKey: format.width,
                kCVPixelBufferHeightKey: format.height,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary
            ]
            var created: CVPixelBufferPool?
            CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &created)
            pool = created
        }
        guard let pool else {
            return nil
        }
        var pixelBuffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixelBuffer)
        return pixelBuffer
    }

    private func draw(_ still: Still, into pixelBuffer: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer),
            let context = CGContext(
                data: base,
                width: format.width,
                height: format.height,
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
            )
        else {
            return
        }
        let width = CGFloat(format.width)
        let height = CGFloat(format.height)
        context.setFillColor(CGColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))

        let titleColor = CGColor(red: 0.96, green: 0.96, blue: 0.97, alpha: 1)
        let subtitleColor = CGColor(red: 0.62, green: 0.63, blue: 0.66, alpha: 1)
        if let subtitle = still.subtitle {
            drawCentered(still.title, fontSize: 64, color: titleColor, baseline: height / 2 + 16, in: context)
            drawCentered(subtitle, fontSize: 36, color: subtitleColor, baseline: height / 2 - 56, in: context)
        } else {
            drawCentered(still.title, fontSize: 64, color: titleColor, baseline: height / 2 - 22, in: context)
        }
    }

    private func drawCentered(
        _ text: String,
        fontSize: CGFloat,
        color: CGColor,
        baseline: CGFloat,
        in context: CGContext
    ) {
        let font = CTFontCreateUIFontForLanguage(.system, fontSize, nil)
            ?? CTFontCreateWithName("Helvetica" as CFString, fontSize, nil)
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color
        ]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
        let lineWidth = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
        context.textPosition = CGPoint(x: (CGFloat(format.width) - lineWidth) / 2, y: baseline)
        CTLineDraw(line, context)
    }
}
