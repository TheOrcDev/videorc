// Person-segmentation probe for plan 258 (background effects), slice S0.
//
// Measures Apple Vision VNGeneratePersonSegmentationRequest on a real camera
// (`live`) or a clip (`clip`), and writes a ground-truth matte from a green
// screen clip (`key`). Build and run through scripts/probe-person-segmentation.mjs.
//
//   seg-probe formats --device "MacBook Pro Camera"
//   seg-probe live --device NAME --size 1920x1080 --fps 30 --seconds 20 \
//       --quality fast|balanced|accurate [--scale-long 512] [--compute auto|cpu|gpu|ane] \
//       [--format 8|16h] --out result.json
//   seg-probe clip --in clip.mp4 --quality ... [--scale-long 512] [--compute ...] \
//       [--size WxH] [--format 8|16h] [--mattes out.gray] --out result.json
//   seg-probe key --in green.mp4 [--t0 6] [--t1 22] > matte.gray   (raw gray8, full size)

import AVFoundation
import CoreML
import CoreVideo
import Foundation
import VideoToolbox
import Vision

// MARK: - Arguments

var argv = Array(CommandLine.arguments.dropFirst())
let mode = argv.isEmpty ? "help" : argv.removeFirst()
var opts: [String: String] = [:]
var i = 0
while i < argv.count {
  let k = argv[i]
  if k.hasPrefix("--"), i + 1 < argv.count {
    opts[String(k.dropFirst(2))] = argv[i + 1]
    i += 2
  } else {
    i += 1
  }
}

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(2)
}

func parseSize(_ s: String?) -> (Int, Int)? {
  guard let s else { return nil }
  let p = s.split(separator: "x").compactMap { Int($0) }
  return p.count == 2 ? (p[0], p[1]) : nil
}

// MARK: - Clocks, stats and load

func nowSeconds() -> Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }

struct Stats: Encodable {
  let n: Int, mean: Double, p50: Double, p95: Double, p99: Double, max: Double
  init(_ xs: [Double]) {
    let s = xs.sorted()
    n = s.count
    func q(_ p: Double) -> Double { s.isEmpty ? 0 : s[min(s.count - 1, Int((Double(s.count - 1) * p).rounded()))] }
    mean = s.isEmpty ? 0 : s.reduce(0, +) / Double(s.count)
    p50 = q(0.5); p95 = q(0.95); p99 = q(0.99); max = s.last ?? 0
  }
}

func loadAvg() -> [Double] {
  var l = [Double](repeating: 0, count: 3)
  getloadavg(&l, 3)
  return l
}

func cpuTicks() -> (busy: UInt64, total: UInt64) {
  var info = host_cpu_load_info()
  var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info_data_t>.size / MemoryLayout<integer_t>.size)
  let r = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count)
    }
  }
  guard r == KERN_SUCCESS else { return (0, 0) }
  let u = UInt64(info.cpu_ticks.0), s = UInt64(info.cpu_ticks.1), idle = UInt64(info.cpu_ticks.2), n = UInt64(info.cpu_ticks.3)
  return (u + s + n, u + s + n + idle)
}

func processCpuSeconds() -> Double {
  var ru = rusage()
  getrusage(RUSAGE_SELF, &ru)
  return Double(ru.ru_utime.tv_sec) + Double(ru.ru_utime.tv_usec) / 1e6 + Double(ru.ru_stime.tv_sec)
    + Double(ru.ru_stime.tv_usec) / 1e6
}

struct LoadWindow {
  let wall0 = nowSeconds()
  let cpu0 = processCpuSeconds()
  let ticks0 = cpuTicks()
  let load0 = loadAvg()
  func finish() -> [String: AnyEncodable] {
    let wall = nowSeconds() - wall0
    let t = cpuTicks()
    let busy = Double(t.busy - ticks0.busy), total = Double(t.total - ticks0.total)
    return [
      "wallSeconds": AnyEncodable(wall),
      "processCpuPctOfOneCore": AnyEncodable(100 * (processCpuSeconds() - cpu0) / max(wall, 1e-6)),
      "systemCpuBusyPct": AnyEncodable(total > 0 ? 100 * busy / total : -1),
      "loadAvgStart": AnyEncodable(load0),
      "loadAvgEnd": AnyEncodable(loadAvg()),
      "logicalCpus": AnyEncodable(ProcessInfo.processInfo.activeProcessorCount),
    ]
  }
}

struct AnyEncodable: Encodable {
  let enc: (Encoder) throws -> Void
  init<T: Encodable>(_ v: T) { enc = v.encode }
  func encode(to e: Encoder) throws { try enc(e) }
}

func writeJSON(_ obj: [String: AnyEncodable], to path: String?) {
  let e = JSONEncoder()
  e.outputFormatting = [.prettyPrinted, .sortedKeys]
  let data = try! e.encode(obj)
  if let path { try! data.write(to: URL(fileURLWithPath: path)) }
  print(String(data: data, encoding: .utf8)!)
}

// MARK: - Vision request

func makeRequest() -> VNGeneratePersonSegmentationRequest {
  let r = VNGeneratePersonSegmentationRequest()
  switch opts["quality"] ?? "balanced" {
  case "fast": r.qualityLevel = .fast
  case "accurate": r.qualityLevel = .accurate
  default: r.qualityLevel = .balanced
  }
  r.outputPixelFormat = (opts["format"] ?? "8") == "16h" ? kCVPixelFormatType_OneComponent16Half : kCVPixelFormatType_OneComponent8
  let want = opts["compute"] ?? "auto"
  if want != "auto" {
    do {
      let devices = try r.supportedComputeStageDevices
      guard let main = devices[.main] else { fail("no main compute stage") }
      let pick = main.first { d in
        switch d {
        case .cpu: return want == "cpu"
        case .gpu: return want == "gpu"
        case .neuralEngine: return want == "ane"
        @unknown default: return false
        }
      }
      guard let pick else { fail("compute \(want) not supported; have \(main)") }
      r.setComputeDevice(pick, for: .main)
    } catch { fail("supportedComputeStageDevices: \(error)") }
  }
  return r
}

func describeComputeDevices() -> [String] {
  let r = VNGeneratePersonSegmentationRequest()
  guard let d = try? r.supportedComputeStageDevices else { return [] }
  return d.flatMap { stage, devs in devs.map { "\(stage.rawValue): \($0)" } }
}

// MARK: - Downscaler (VTPixelTransferSession into an IOSurface pool)

final class Downscaler {
  let session: VTPixelTransferSession
  var pool: CVPixelBufferPool?
  var poolSize = (0, 0)
  let longSide: Int
  init(longSide: Int) {
    self.longSide = longSide
    var s: VTPixelTransferSession?
    VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &s)
    session = s!
    VTSessionSetProperty(session, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Normal)
  }
  func scale(_ src: CVPixelBuffer) -> CVPixelBuffer {
    let w = CVPixelBufferGetWidth(src), h = CVPixelBufferGetHeight(src)
    let k = Double(longSide) / Double(max(w, h))
    let dw = Int((Double(w) * k / 2).rounded()) * 2, dh = Int((Double(h) * k / 2).rounded()) * 2
    if pool == nil || poolSize != (dw, dh) {
      let attrs: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: dw, kCVPixelBufferHeightKey as String: dh,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
      ]
      CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
      poolSize = (dw, dh)
    }
    var out: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool!, &out)
    VTPixelTransferSessionTransferImage(session, from: src, to: out!)
    return out!
  }
}

// MARK: - Matte capture

struct MatteInfo { var w = 0, h = 0, format = "" }

func matteToGray8(_ pb: CVPixelBuffer) -> [UInt8] {
  CVPixelBufferLockBaseAddress(pb, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
  let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
  let stride = CVPixelBufferGetBytesPerRow(pb)
  let base = CVPixelBufferGetBaseAddress(pb)!
  var out = [UInt8](repeating: 0, count: w * h)
  if CVPixelBufferGetPixelFormatType(pb) == kCVPixelFormatType_OneComponent8 {
    for y in 0..<h { memcpy(&out[y * w], base + y * stride, w) }
  } else {
    for y in 0..<h {
      let row = (base + y * stride).assumingMemoryBound(to: Float16.self)
      for x in 0..<w { out[y * w + x] = UInt8(max(0, min(255, Float(row[x]) * 255 + 0.5))) }
    }
  }
  return out
}

// MARK: - formats

func findDevice(_ name: String) -> AVCaptureDevice {
  let ds = AVCaptureDevice.DiscoverySession(
    deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera, .deskViewCamera],
    mediaType: .video, position: .unspecified
  ).devices
  guard let d = ds.first(where: { $0.localizedName == name }) else {
    fail("no camera named \(name); have \(ds.map(\.localizedName))")
  }
  return d
}

if mode == "formats" {
  let d = findDevice(opts["device"] ?? "MacBook Pro Camera")
  for f in d.formats {
    let dim = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
    let rates = f.videoSupportedFrameRateRanges.map { "\($0.minFrameRate)-\($0.maxFrameRate)" }.joined(separator: ",")
    print("\(dim.width)x\(dim.height) fourcc=\(CMFormatDescriptionGetMediaSubType(f.formatDescription)) fps=\(rates)")
  }
  print("portraitEffectActive=\(d.isPortraitEffectActive) backgroundReplacementActive=\(d.isBackgroundReplacementActive) centerStageActive=\(d.isCenterStageActive)")
  print("vision compute devices: \(describeComputeDevices())")
  exit(0)
}

// MARK: - live

final class LiveProbe: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let request = makeRequest()
  let segQueue = DispatchQueue(label: "seg", qos: .userInitiated)
  let lock = NSLock()
  var busy = false
  var captured = 0, segmented = 0, skippedBusy = 0
  var perform: [Double] = [], scaleMs: [Double] = [], latency: [Double] = [], matteAge: [Double] = []
  var deliver: [Double] = [], arriveToMatte: [Double] = []
  var coldFirstMs = -1.0, coldFirstLatencyMs = -1.0
  var matte = MatteInfo()
  var lastMatteReady = 0.0
  var measuring = false
  let warmupFrames: Int
  var interFrame: [Double] = []
  var lastCapture = 0.0
  let downscaler: Downscaler?
  var frameSize = (0, 0)

  init(scaleLong: Int, warmup: Int) {
    downscaler = scaleLong > 0 ? Downscaler(longSide: scaleLong) : nil
    warmupFrames = warmup
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds
    let arrive = nowSeconds()
    lock.lock()
    captured += 1
    frameSize = (CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb))
    let n = captured
    if measuring {
      if lastCapture > 0 { interFrame.append((pts - lastCapture) * 1000) }
      // Age of the newest finished matte when this frame would be composited.
      if lastMatteReady > 0 { matteAge.append((arrive - lastMatteReady) * 1000) }
      deliver.append((arrive - pts) * 1000)
    }
    lastCapture = pts
    if busy {
      skippedBusy += measuring ? 1 : 0
      lock.unlock()
      return
    }
    busy = true
    lock.unlock()
    segQueue.async { [self] in
      let t0 = nowSeconds()
      let queued = t0 - arrive
      let input = downscaler?.scale(pb) ?? pb
      let t1 = nowSeconds()
      let h = VNImageRequestHandler(cvPixelBuffer: input, options: [:])
      do { try h.perform([request]) } catch { fail("perform: \(error)") }
      let t2 = nowSeconds()
      let res = request.results?.first?.pixelBuffer
      lock.lock()
      if let res, matte.w == 0 {
        matte = MatteInfo(
          w: CVPixelBufferGetWidth(res), h: CVPixelBufferGetHeight(res),
          format: CVPixelBufferGetPixelFormatType(res) == kCVPixelFormatType_OneComponent8 ? "OneComponent8" : "OneComponent16Half")
      }
      if coldFirstMs < 0 {
        coldFirstMs = (t2 - t0) * 1000
        coldFirstLatencyMs = (t2 - pts) * 1000
      }
      lastMatteReady = t2
      if measuring && n > warmupFrames {
        segmented += 1
        perform.append((t2 - t1) * 1000)
        scaleMs.append((t1 - t0) * 1000)
        latency.append((t2 - pts) * 1000)
        arriveToMatte.append((t2 - arrive) * 1000)
        _ = queued
      }
      busy = false
      lock.unlock()
    }
  }
}

if mode == "live" {
  let device = findDevice(opts["device"] ?? "MacBook Pro Camera")
  guard let (w, h) = parseSize(opts["size"] ?? "1920x1080") else { fail("bad --size") }
  let fps = Double(opts["fps"] ?? "30")!
  let seconds = Double(opts["seconds"] ?? "20")!
  let probe = LiveProbe(scaleLong: Int(opts["scale-long"] ?? "0")!, warmup: 0)
  let session = AVCaptureSession()
  session.beginConfiguration()
  let input = try! AVCaptureDeviceInput(device: device)
  session.addInput(input)
  let output = AVCaptureVideoDataOutput()
  output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
  output.alwaysDiscardsLateVideoFrames = true
  let capQueue = DispatchQueue(label: "capture", qos: .userInteractive)
  output.setSampleBufferDelegate(probe, queue: capQueue)
  session.addOutput(output)
  guard
    let fmt = device.formats.first(where: { f in
      let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
      return Int(d.width) == w && Int(d.height) == h
        && f.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= fps && $0.minFrameRate <= fps }
    })
  else { fail("no \(w)x\(h)@\(fps) format") }
  try! device.lockForConfiguration()
  device.activeFormat = fmt
  device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))
  device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))
  device.unlockForConfiguration()
  session.commitConfiguration()
  let tStart = nowSeconds()
  session.startRunning()
  // Warm-up: 3 s for auto exposure and the first (cold) request.
  while nowSeconds() - tStart < 3 { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
  probe.lock.lock(); probe.measuring = true; probe.lock.unlock()
  let lw = LoadWindow()
  let c0 = probe.captured
  while nowSeconds() - lw.wall0 < seconds { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
  probe.lock.lock(); probe.measuring = false; probe.lock.unlock()
  let load = lw.finish()
  session.stopRunning()
  probe.lock.lock()
  let wall = nowSeconds() - lw.wall0
  var out: [String: AnyEncodable] = [
    "mode": AnyEncodable("live"),
    "device": AnyEncodable(device.localizedName),
    "captureSize": AnyEncodable("\(probe.frameSize.0)x\(probe.frameSize.1)"),
    "fps": AnyEncodable(fps),
    "quality": AnyEncodable(opts["quality"] ?? "balanced"),
    "compute": AnyEncodable(opts["compute"] ?? "auto"),
    "scaleLong": AnyEncodable(Int(opts["scale-long"] ?? "0")!),
    "matte": AnyEncodable("\(probe.matte.w)x\(probe.matte.h) \(probe.matte.format)"),
    "coldFirstPerformMs": AnyEncodable(probe.coldFirstMs),
    "coldFirstLatencyMs": AnyEncodable(probe.coldFirstLatencyMs),
    "framesCaptured": AnyEncodable(probe.captured - c0),
    "framesSegmented": AnyEncodable(probe.segmented),
    "framesSkippedBusy": AnyEncodable(probe.skippedBusy),
    "captureHz": AnyEncodable(Double(probe.captured - c0) / wall),
    "matteHz": AnyEncodable(Double(probe.segmented) / wall),
    "performMs": AnyEncodable(Stats(probe.perform)),
    "downscaleMs": AnyEncodable(Stats(probe.scaleMs)),
    "captureToMatteMs": AnyEncodable(Stats(probe.latency)),
    "captureToDeliveryMs": AnyEncodable(Stats(probe.deliver)),
    "deliveryToMatteMs": AnyEncodable(Stats(probe.arriveToMatte)),
    "matteAgeAtFrameMs": AnyEncodable(Stats(probe.matteAge)),
    "captureIntervalMs": AnyEncodable(Stats(probe.interFrame)),
    "load": AnyEncodable(load),
    "portraitEffectActive": AnyEncodable(device.isPortraitEffectActive),
    "backgroundReplacementActive": AnyEncodable(device.isBackgroundReplacementActive),
  ]
  probe.lock.unlock()
  out["os"] = AnyEncodable(ProcessInfo.processInfo.operatingSystemVersionString)
  writeJSON(out, to: opts["out"])
  exit(0)
}

// MARK: - clip reader

func openReader(_ path: String, size: (Int, Int)?) -> (AVAssetReader, AVAssetReaderTrackOutput, Double) {
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  let sem = DispatchSemaphore(value: 0)
  var track: AVAssetTrack?
  var fps = 30.0
  Task {
    track = try? await asset.loadTracks(withMediaType: .video).first
    if let t = track { fps = Double((try? await t.load(.nominalFrameRate)) ?? 30) }
    sem.signal()
  }
  sem.wait()
  guard let track else { fail("no video track in \(path)") }
  let reader = try! AVAssetReader(asset: asset)
  var settings: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferIOSurfacePropertiesKey as String: [:],
  ]
  if let (w, h) = size { settings[kCVPixelBufferWidthKey as String] = w; settings[kCVPixelBufferHeightKey as String] = h }
  let out = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
  out.alwaysCopiesSampleData = false
  reader.add(out)
  reader.startReading()
  return (reader, out, fps)
}

// MARK: - clip

if mode == "clip" {
  guard let path = opts["in"] else { fail("--in required") }
  let (reader, out, fps) = openReader(path, size: parseSize(opts["size"]))
  let request = makeRequest()
  let scaleLong = Int(opts["scale-long"] ?? "0")!
  let ds = scaleLong > 0 ? Downscaler(longSide: scaleLong) : nil
  let realtime = (opts["pace"] ?? "") == "realtime"
  let matteFile: FileHandle? = opts["mattes"].map {
    FileManager.default.createFile(atPath: $0, contents: nil)
    return FileHandle(forWritingAtPath: $0)!
  }
  var perform: [Double] = [], scaleMs: [Double] = []
  let maxW = Int(opts["mattes-max-w"] ?? "100000")!
  let keepFrames = Set((opts["keep-frames"] ?? "").split(separator: ",").compactMap { Int($0) })
  var storedSize = (0, 0)
  var cold = -1.0
  var matte = MatteInfo()
  var n = 0
  var frameSize = (0, 0)
  let lw = LoadWindow()
  let t0 = nowSeconds()
  while let sb = out.copyNextSampleBuffer() {
    guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
    frameSize = (CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb))
    if realtime {
      let due = t0 + Double(n) / fps
      let wait = due - nowSeconds()
      if wait > 0 { usleep(useconds_t(wait * 1e6)) }
    }
    let a = nowSeconds()
    let input = ds?.scale(pb) ?? pb
    let b = nowSeconds()
    try! VNImageRequestHandler(cvPixelBuffer: input, options: [:]).perform([request])
    let c = nowSeconds()
    guard let res = request.results?.first?.pixelBuffer else { fail("no matte at frame \(n)") }
    if matte.w == 0 {
      matte = MatteInfo(
        w: CVPixelBufferGetWidth(res), h: CVPixelBufferGetHeight(res),
        format: CVPixelBufferGetPixelFormatType(res) == kCVPixelFormatType_OneComponent8 ? "OneComponent8" : "OneComponent16Half")
    }
    if n == 0 { cold = (c - a) * 1000 } else if n >= 30 { perform.append((c - b) * 1000); scaleMs.append((b - a) * 1000) }
    if matteFile != nil || keepFrames.contains(n) {
      let g = matteToGray8(res)
      let mw = CVPixelBufferGetWidth(res), mh = CVPixelBufferGetHeight(res)
      if keepFrames.contains(n), let base = opts["mattes"] {
        FileManager.default.createFile(atPath: "\(base).f\(n).\(mw)x\(mh).gray", contents: Data(g))
      }
      if let matteFile {
        // Box-downsample by an integer factor so long sequences stay small.
        let k = max(1, Int((Double(mw) / Double(maxW)).rounded(.up)))
        if k == 1 { matteFile.write(Data(g)) } else {
          let dw = mw / k, dh = mh / k
          var d = [UInt8](repeating: 0, count: dw * dh)
          for y in 0..<dh { for x in 0..<dw {
            var acc = 0
            for yy in 0..<k { for xx in 0..<k { acc += Int(g[(y * k + yy) * mw + x * k + xx]) } }
            d[y * dw + x] = UInt8(acc / (k * k))
          } }
          storedSize = (dw, dh)
          matteFile.write(Data(d))
        }
        if k == 1 { storedSize = (mw, mh) }
      }
    }
    n += 1
  }
  if reader.status == .failed { fail("reader: \(String(describing: reader.error))") }
  try? matteFile?.close()
  let load = lw.finish()
  writeJSON([
    "mode": AnyEncodable("clip"),
    "input": AnyEncodable((path as NSString).lastPathComponent),
    "frameSize": AnyEncodable("\(frameSize.0)x\(frameSize.1)"),
    "frames": AnyEncodable(n),
    "pace": AnyEncodable(realtime ? "realtime" : "max"),
    "quality": AnyEncodable(opts["quality"] ?? "balanced"),
    "compute": AnyEncodable(opts["compute"] ?? "auto"),
    "scaleLong": AnyEncodable(scaleLong),
    "matte": AnyEncodable("\(matte.w)x\(matte.h) \(matte.format)"),
    "matteW": AnyEncodable(matte.w), "matteH": AnyEncodable(matte.h),
    "storedMatte": AnyEncodable("\(storedSize.0)x\(storedSize.1)"),
    "coldFirstMs": AnyEncodable(cold),
    "performMs": AnyEncodable(Stats(perform)),
    "downscaleMs": AnyEncodable(Stats(scaleMs)),
    "load": AnyEncodable(load),
  ], to: opts["out"])
  exit(0)
}

// MARK: - key (ground-truth matte from a green screen clip)

if mode == "key" {
  guard let path = opts["in"] else { fail("--in required") }
  let t0 = Double(opts["t0"] ?? "6")!, t1 = Double(opts["t1"] ?? "22")!
  let (reader, out, _) = openReader(path, size: nil)
  defer { withExtendedLifetime(reader) {} }
  let so = FileHandle.standardOutput
  var buf: [UInt8] = []
  while let sb = out.copyNextSampleBuffer() {
    guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), stride = CVPixelBufferGetBytesPerRow(pb)
    let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
    if buf.count != w * h { buf = [UInt8](repeating: 0, count: w * h) }
    for y in 0..<h {
      let row = base + y * stride
      for x in 0..<w {
        let b = Double(row[x * 4]), g = Double(row[x * 4 + 1]), r = Double(row[x * 4 + 2])
        let d = g - max(r, b)  // green dominance
        let a = 1 - min(1, max(0, (d - t0) / (t1 - t0)))
        buf[y * w + x] = UInt8(a * 255 + 0.5)
      }
    }
    CVPixelBufferUnlockBaseAddress(pb, .readOnly)
    so.write(Data(buf))
  }
  if reader.status == .failed { fail("reader: \(String(describing: reader.error))") }
  exit(0)
}

fail("modes: formats | live | clip | key")
