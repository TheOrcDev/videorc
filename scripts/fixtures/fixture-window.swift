// Fixture window for the scene window-switch probe (plan 210 S0).
//
// A tiny AppKit app that opens one normal window filled with a solid colour,
// a large marker letter, a frame counter and a white block sweeping along the
// bottom-left edge, redrawn at 30 fps so ScreenCaptureKit keeps delivering
// frames and a repeated (frozen) frame is visible even at 160x90. Two copies of it, wrapped as
// "Fixture Alpha" (red) and "Fixture Beta" (blue) by
// scripts/fixtures/build-fixture-apps.mjs, stand in for the streamer's apps.
//
// Arguments (each overrides the matching Info.plist key):
//   --color red|blue|white|#rrggbb   VideorcFixtureColor
//   --title "Fixture Alpha"          VideorcFixtureTitle
//   --letter A                       VideorcFixtureLetter
//   --width 1280 --height 800        window frame size (default 1280x800); pass
//                                    1280x720 to fill a 16:9 canvas exactly
//   --x 80 --y 80                    bottom-left origin on the main display
//   --fps 30                         redraw cadence
//
// Signals: SIGUSR1 flashes the whole window white for 200 ms and prints
// `flash drawn_at_ms=<epoch ms>` when the first white frame is drawn. The
// probe uses that frame as a clock anchor between its wall clock and the
// recording's timeline.
//
// stdout, line buffered: `ready pid=<pid> window_number=<CGWindowID>
// title=<title>` once the window is on screen. The window number is the
// ScreenCaptureKit window id Videorc lists as
// `window:screencapturekit:<CGWindowID>`.

import AppKit
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

struct FixtureOptions {
  var color = NSColor(calibratedRed: 0.85, green: 0.10, blue: 0.10, alpha: 1)
  var colorName = "red"
  var title = "Fixture"
  var letter = "F"
  var width: CGFloat = 1280
  var height: CGFloat = 800
  var x: CGFloat = 80
  var y: CGFloat = 80
  var fps: Double = 30
}

func parseColor(_ text: String) -> NSColor? {
  switch text.lowercased() {
  case "red": return NSColor(calibratedRed: 0.85, green: 0.10, blue: 0.10, alpha: 1)
  case "blue": return NSColor(calibratedRed: 0.10, green: 0.20, blue: 0.90, alpha: 1)
  case "green": return NSColor(calibratedRed: 0.10, green: 0.75, blue: 0.20, alpha: 1)
  case "white": return NSColor.white
  default:
    var hex = text
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
    return NSColor(
      calibratedRed: CGFloat((value >> 16) & 0xff) / 255,
      green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255,
      alpha: 1)
  }
}

func parseOptions() -> FixtureOptions {
  var options = FixtureOptions()
  let info = Bundle.main.infoDictionary ?? [:]
  if let color = info["VideorcFixtureColor"] as? String, let parsed = parseColor(color) {
    options.color = parsed
    options.colorName = color
  }
  if let title = info["VideorcFixtureTitle"] as? String { options.title = title }
  if let letter = info["VideorcFixtureLetter"] as? String { options.letter = letter }

  var arguments = Array(CommandLine.arguments.dropFirst())
  while !arguments.isEmpty {
    let flag = arguments.removeFirst()
    guard flag.hasPrefix("--"), !arguments.isEmpty else { continue }
    let value = arguments.removeFirst()
    switch flag {
    case "--color":
      if let parsed = parseColor(value) {
        options.color = parsed
        options.colorName = value
      }
    case "--title": options.title = value
    case "--letter": options.letter = value
    case "--width": options.width = CGFloat(Double(value) ?? 1280)
    case "--height": options.height = CGFloat(Double(value) ?? 800)
    case "--x": options.x = CGFloat(Double(value) ?? 80)
    case "--y": options.y = CGFloat(Double(value) ?? 80)
    case "--fps": options.fps = max(1, Double(value) ?? 30)
    default: break
    }
  }
  return options
}

func epochMilliseconds() -> Int64 {
  Int64((Date().timeIntervalSince1970 * 1000).rounded())
}

final class FixtureView: NSView {
  let color: NSColor
  let letter: String
  var frameCounter: UInt64 = 0
  var flashUntil: TimeInterval = 0
  var flashReported = true

  init(frame: NSRect, color: NSColor, letter: String) {
    self.color = color
    self.letter = letter
    super.init(frame: frame)
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  override var isOpaque: Bool { true }

  func flash(durationMs: Double) {
    flashUntil = Date().timeIntervalSince1970 + durationMs / 1000
    flashReported = false
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    let now = Date().timeIntervalSince1970
    let flashing = now < flashUntil
    (flashing ? NSColor.white : color).setFill()
    bounds.fill()
    if flashing && !flashReported {
      flashReported = true
      print("flash drawn_at_ms=\(epochMilliseconds())")
    }

    // The marker letter is a darker shade of the fill, so the centre of the
    // frame still classifies as the fixture's colour at any sample size.
    let letterStyle = NSMutableParagraphStyle()
    letterStyle.alignment = .center
    let letterFont = NSFont.boldSystemFont(ofSize: bounds.height * 0.55)
    let letterAttributes: [NSAttributedString.Key: Any] = [
      .font: letterFont,
      .foregroundColor: NSColor.black.withAlphaComponent(flashing ? 0.08 : 0.22),
      .paragraphStyle: letterStyle,
    ]
    let letterSize = (letter as NSString).size(withAttributes: letterAttributes)
    let letterRect = NSRect(
      x: 0, y: (bounds.height - letterSize.height) / 2, width: bounds.width,
      height: letterSize.height)
    (letter as NSString).draw(in: letterRect, withAttributes: letterAttributes)

    // A small counter in the top-left corner changes every tick so the window
    // never goes still and ScreenCaptureKit keeps publishing frames.
    let counterAttributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedDigitSystemFont(ofSize: 28, weight: .semibold),
      .foregroundColor: NSColor.white.withAlphaComponent(flashing ? 0.0 : 0.9),
    ]
    let counterText = String(format: "%08llu", frameCounter) as NSString
    counterText.draw(
      at: NSPoint(x: 16, y: bounds.height - 56), withAttributes: counterAttributes)

    // Motion the probe can see after downscaling: a white block that sweeps
    // the bottom-left 40% of the window in 12 steps (bottom 8% of the height).
    if !flashing {
      let sweepWidth = bounds.width * 0.4
      let blockWidth = bounds.width * 0.06
      let step = CGFloat(frameCounter % 12) / 12
      let blockRect = NSRect(
        x: step * (sweepWidth - blockWidth), y: 0, width: blockWidth, height: bounds.height * 0.08)
      NSColor.white.withAlphaComponent(0.95).setFill()
      blockRect.fill()
    }
  }
}

final class FixtureDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let options: FixtureOptions
  var window: NSWindow?
  var view: FixtureView?
  var timer: Timer?
  var signalSource: DispatchSourceSignal?

  init(options: FixtureOptions) {
    self.options = options
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let contentRect = NSRect(
      x: options.x, y: options.y, width: options.width, height: options.height)
    let window = NSWindow(
      contentRect: contentRect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false)
    window.title = options.title
    // The colour runs under the title bar, so the whole captured window is
    // one solid picture (no chrome strip at the top).
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isReleasedWhenClosed = false
    window.delegate = self
    // The requested size is the whole window frame (title bar included), so a
    // 1280x720 fixture fills a 16:9 canvas edge to edge.
    window.setFrame(contentRect, display: false)
    let view = FixtureView(frame: contentRect, color: options.color, letter: options.letter)
    window.contentView = view
    window.makeKeyAndOrderFront(nil)
    self.window = window
    self.view = view

    NSApp.activate(ignoringOtherApps: true)

    timer = Timer.scheduledTimer(withTimeInterval: 1.0 / options.fps, repeats: true) {
      [weak view] _ in
      guard let view else { return }
      view.frameCounter &+= 1
      view.needsDisplay = true
    }
    RunLoop.main.add(timer!, forMode: .common)

    signal(SIGUSR1, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
    source.setEventHandler { [weak view] in
      print("flash requested_at_ms=\(epochMilliseconds())")
      view?.flash(durationMs: 200)
    }
    source.resume()
    signalSource = source

    print(
      "ready pid=\(ProcessInfo.processInfo.processIdentifier) window_number=\(window.windowNumber) title=\(options.title) color=\(options.colorName) frame=\(Int(window.frame.width))x\(Int(window.frame.height))"
    )
  }

  func windowWillClose(_ notification: Notification) {
    NSApp.terminate(nil)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}

let options = parseOptions()
// App Nap would throttle the redraw timer once the window is covered, and a
// still window stops ScreenCaptureKit's frames: hold a user-initiated activity.
let activity = ProcessInfo.processInfo.beginActivity(
  options: [.userInitiated, .latencyCritical, .idleDisplaySleepDisabled],
  reason: "Videorc fixture keeps animating while captured")
_ = activity
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = FixtureDelegate(options: options)
app.delegate = delegate
app.run()
