import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { decodePng } from './image-stats.mjs'
import { SHARP_HIDDEN_MAX, SHARP_LIVE_MIN } from './smart-scenes-gate.mjs'
import {
  ANALYSIS_HEIGHT,
  ANALYSIS_WIDTH,
  CODE_BANNER_SIZE,
  CODE_BITS,
  CODE_PERIOD,
  MARKER_CELLS,
  STAGE_MARGIN,
  VIRTUAL_CAMERA,
  VIRTUAL_CAMERA_SMOKE_ASSERTIONS,
  VIRTUAL_CAMERA_SMOKE_BUDGET,
  analyzeFrame,
  cadenceStats,
  cadenceVerdict,
  cameraAccessDenied,
  cameraDeviceName,
  cameraHideVerdict,
  cameraListing,
  cameraReaderPlan,
  classifyCameraRead,
  classifyCameraStart,
  codeBannerRgb,
  codeBitsShown,
  codeStep,
  counterVerdict,
  decodeMarker,
  encodePngRgb,
  frostCropRegion,
  grayCode,
  grayDecode,
  markerBannerUpdate,
  markerSummary,
  matchCodeTracks,
  parseAvfoundationVideoDevices,
  parseDshowVideoDevices,
  parseShowinfoLine,
  parseV4l2Listing,
  presenceVerdict,
  ptsUsable,
  readerOutputArgs,
  selfListedCameras,
  smokeSceneBackground,
  smokeVerdict,
  wallOffsetMs
} from './virtual-camera-smoke.mjs'

const fixtures = JSON.parse(
  readFileSync(new URL('../../protocol-fixtures/virtual-camera.json', import.meta.url), 'utf8')
)

// --- Synthetic frames --------------------------------------------------------

function flatFrame(rgb = [40, 60, 90], width = ANALYSIS_WIDTH, height = ANALYSIS_HEIGHT) {
  const frame = new Uint8Array(width * height * 3)
  for (let index = 0; index < width * height; index += 1) frame.set(rgb, index * 3)
  return frame
}

function noiseFrame(seed = 7, width = ANALYSIS_WIDTH, height = ANALYSIS_HEIGHT) {
  const frame = new Uint8Array(width * height * 3)
  let state = seed
  for (let index = 0; index < frame.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    frame[index] = state & 0xff
  }
  return frame
}

/** Draws one banner the way the compositor blends it: the checker at `opacity`. */
function drawBanner(frame, cell, opacity = 1, width = ANALYSIS_WIDTH, height = ANALYSIS_HEIGHT) {
  const x0 = Math.round(cell.x * width)
  const x1 = Math.round((cell.x + cell.w) * width)
  const y0 = Math.round(cell.y * height)
  const y1 = Math.round((cell.y + cell.h) * height)
  const midX = (x0 + x1) / 2
  const midY = (y0 + y1) / 2
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const white = x < midX === y < midY
      const target = white ? 255 : 0
      const offset = (y * width + x) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        frame[offset + channel] = Math.round(
          frame[offset + channel] * (1 - opacity) + target * opacity
        )
      }
    }
  }
  return frame
}

/** A program frame showing code step `step` (the finder plus the shown bits). */
function programFrame(step, { base = flatFrame(), opacity = 1 } = {}) {
  const frame = Uint8Array.from(base)
  drawBanner(frame, MARKER_CELLS[0])
  codeBitsShown(step).forEach((shown, bit) => {
    if (shown) drawBanner(frame, MARKER_CELLS[bit + 1], opacity)
  })
  return frame
}

function fillRect(frame, x0, y0, width, height, rgb) {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) frame.set(rgb, (y * ANALYSIS_WIDTH + x) * 3)
  }
}

/**
 * The fixture window, live, inside the stage only: hard-edged blocks, and a
 * white block along the bottom-left edge that `shift` moves.
 */
function sharpStageFrame(shift = 0) {
  const frame = flatFrame([200, 30, 30])
  const region = frostCropRegion()
  const left = Math.round(region.x0 * ANALYSIS_WIDTH)
  const top = Math.round(region.y0 * ANALYSIS_HEIGHT)
  const bottom = Math.round(region.y1 * ANALYSIS_HEIGHT)
  for (let block = 0; block < 6; block += 1) {
    fillRect(frame, left + 24 + block * 43, top + 27, 12, 30, [255, 255, 255])
  }
  fillRect(frame, left + 10 + shift, bottom - 14, 20, 12, [255, 255, 255])
  return frame
}

// --- Identity ----------------------------------------------------------------

test('the camera identity mirrors identifiers.json and virtual_camera.rs', () => {
  const rust = readFileSync(
    new URL('../../crates/videorc-backend/src/virtual_camera.rs', import.meta.url),
    'utf8'
  )
  const rustString = (name) => new RegExp(`pub const ${name}: &str = "([^"]*)";`).exec(rust)?.[1]
  const rustNumber = (name) =>
    Number(new RegExp(`pub const ${name}: u32 = (\\d+);`).exec(rust)?.[1])
  assert.equal(rustString('VIRTUAL_CAMERA_NAME'), VIRTUAL_CAMERA.name)
  assert.equal(rustString('VIRTUAL_CAMERA_MACOS_DEVICE_UUID'), VIRTUAL_CAMERA.macosDeviceUuid)
  assert.equal(rustString('VIRTUAL_CAMERA_WINDOWS_SOURCE_CLSID'), VIRTUAL_CAMERA.windowsSourceClsid)
  assert.equal(rustString('VIRTUAL_CAMERA_WINDOWS_NAME_SUFFIX'), VIRTUAL_CAMERA.windowsNameSuffix)
  assert.equal(rustString('VIRTUAL_CAMERA_LINUX_CARD_LABEL'), VIRTUAL_CAMERA.linuxCardLabel)
  assert.equal(rustNumber('VIRTUAL_CAMERA_LINUX_VIDEO_NR'), VIRTUAL_CAMERA.linuxVideoNr)
  assert.equal(rustNumber('VIRTUAL_CAMERA_WIDTH'), VIRTUAL_CAMERA.width)
  assert.equal(rustNumber('VIRTUAL_CAMERA_HEIGHT'), VIRTUAL_CAMERA.height)
  assert.equal(rustNumber('VIRTUAL_CAMERA_FPS'), VIRTUAL_CAMERA.fps)
  assert.equal(cameraDeviceName('darwin'), 'Videorc Camera')
  assert.equal(cameraDeviceName('win32'), 'Videorc Camera Windows Virtual Camera')
  assert.equal(cameraDeviceName('linux'), '/dev/video42')
})

test('the reader opens the camera by its exact name with the platform input', () => {
  const mac = cameraReaderPlan('darwin')
  assert.deepEqual(mac.inputArgs, [
    '-f',
    'avfoundation',
    '-framerate',
    '30',
    '-video_size',
    '1920x1080',
    '-i',
    'Videorc Camera'
  ])
  const windows = cameraReaderPlan('win32')
  assert.equal(windows.format, 'dshow')
  assert.equal(windows.inputArgs.at(-1), 'video=Videorc Camera Windows Virtual Camera')
  assert.deepEqual(cameraReaderPlan('linux').inputArgs.slice(-2), ['-i', '/dev/video42'])
  assert.throws(() => cameraReaderPlan('freebsd'), /supports macOS, Windows and Linux/)
  const output = readerOutputArgs()
  assert.ok(output.includes('passthrough'), 'no frame is duplicated or dropped to a fixed rate')
  assert.ok(output.join(' ').includes('showinfo,scale=480:270:flags=area,format=rgb24'))
})

// --- The marker ----------------------------------------------------------------

test('each code step toggles exactly one bit banner and the code decodes back', () => {
  for (let n = 0; n < CODE_PERIOD * 2; n += 1) {
    const before = grayCode(n - 1)
    const after = grayCode(n)
    const changed = before ^ after
    assert.equal(changed & (changed - 1), 0, `step ${n} changes one bit`)
    assert.equal(grayDecode(after), n % CODE_PERIOD)
    const step = codeStep(n)
    assert.equal(codeBitsShown(n)[step.bit], step.shown)
    // The finder plus the shown bits never exceeds the four-banner cap.
    assert.ok(1 + codeBitsShown(n).filter(Boolean).length <= 4)
  }
  assert.equal(CODE_BITS, 3)
})

test('the marker banners sit in the left ring, square on a 1920x1080 canvas, apart', () => {
  for (const cell of MARKER_CELLS) {
    assert.ok(cell.x > 0 && cell.x + cell.w < STAGE_MARGIN, 'inside the left ring')
    assert.ok(cell.y > 0 && cell.y + cell.h < 1, 'inside the canvas')
    assert.ok(Math.abs(cell.w * 1920 - cell.h * 1080) < 0.5, 'square in pixels')
  }
  for (let index = 1; index < MARKER_CELLS.length; index += 1) {
    assert.ok(MARKER_CELLS[index].y >= MARKER_CELLS[index - 1].y + MARKER_CELLS[index - 1].h)
  }
  const update = markerBannerUpdate('banner-1', MARKER_CELLS[1])
  assert.deepEqual(update.horizontal, {
    x: MARKER_CELLS[1].x,
    y: MARKER_CELLS[1].y,
    w: MARKER_CELLS[1].w,
    h: MARKER_CELLS[1].h
  })
  assert.equal(update.showOnStream && update.showInRecording, true)
  const background = smokeSceneBackground({ id: 'bundled-a', managedAssetPath: '/x/a.webp' })
  assert.equal(background.visibilityPercent / 200, STAGE_MARGIN)
})

test('the banner image is a 2x2 checker PNG, distinct per banner', () => {
  const images = [0, 1, 2, 3].map((tag) => encodePngRgb(codeBannerRgb(tag)))
  assert.equal(new Set(images.map((png) => png.toString('base64'))).size, 4)
  const decoded = decodePng(images[2])
  assert.equal(decoded.width, CODE_BANNER_SIZE)
  assert.equal(decoded.height, CODE_BANNER_SIZE)
  const at = (x, y) => decoded.data[(y * decoded.width + x) * 4]
  const quarter = CODE_BANNER_SIZE / 4
  assert.equal(at(quarter, quarter), 255, 'top-left white')
  assert.equal(at(3 * quarter, 3 * quarter), 255, 'bottom-right white')
  assert.equal(at(3 * quarter, quarter), 0, 'top-right black')
  assert.equal(at(quarter, 3 * quarter), 0, 'bottom-left black')
})

test('the marker decodes over a flat ring, a white screen and busy content', () => {
  const bases = [flatFrame(), flatFrame([255, 255, 255]), flatFrame([0, 0, 0]), noiseFrame()]
  for (const base of bases) {
    for (let step = 0; step < CODE_PERIOD; step += 1) {
      const marker = decodeMarker(programFrame(step, { base }))
      assert.equal(marker.finder, true)
      assert.equal(marker.code, step)
    }
  }
})

test('a still without banners carries no marker, and a fading banner reads as unknown', () => {
  for (const still of [flatFrame(), flatFrame([255, 255, 255]), noiseFrame(3)]) {
    const marker = decodeMarker(still)
    assert.equal(marker.finder, false)
    assert.equal(marker.code, null)
  }
  // Step 1 shows bit 0 alone: halfway through its fade the bit is neither.
  assert.equal(decodeMarker(programFrame(1, { opacity: 0.3 })).code, null)
  assert.equal(decodeMarker(programFrame(1, { opacity: 0.1 })).code, 0)
  assert.equal(decodeMarker(programFrame(1, { opacity: 0.9 })).code, 1)
})

test('the frost crop sees the stage only: banners and the ring stay out', () => {
  const crop = frostCropRegion()
  for (const cell of MARKER_CELLS) assert.ok(cell.x + cell.w < crop.x0)
  // Banners alone (sharp checkers in the ring) leave the stage crop flat.
  const ringOnly = analyzeFrame(programFrame(5), null)
  assert.equal(ringOnly.sharp, 0)
  assert.ok(ringOnly.sharp <= SHARP_HIDDEN_MAX)
  const live = analyzeFrame(sharpStageFrame(0), null)
  assert.ok(live.sharp >= SHARP_LIVE_MIN, `live stage sharp ${live.sharp}`)
  const moved = analyzeFrame(sharpStageFrame(4), sharpStageFrame(0))
  assert.equal(moved.repeated, false)
  const same = analyzeFrame(sharpStageFrame(0), sharpStageFrame(0))
  assert.equal(same.repeated, true)
  assert.equal(same.stillDiff, 0)
})

// --- Time and cadence -------------------------------------------------------------

test('showinfo lines give the frame number and pts; the wall offset is their median', () => {
  const line =
    '[Parsed_showinfo_0 @ 0x600001] n:  12 pts: 412000 pts_time:0.412   duration:33333 fmt:bgr0 sar:1/1 s:1920x1080'
  assert.deepEqual(parseShowinfoLine(line), { n: 12, ptsMs: 412 })
  assert.deepEqual(parseShowinfoLine('n:   3 pts:NOPTS pts_time:NOPTS'), { n: 3, ptsMs: null })
  assert.equal(parseShowinfoLine('frame=  10 fps=30'), null)
  assert.equal(wallOffsetMs([0, 33, 67], [1000, 1040, 1068]), 1001)
  assert.equal(ptsUsable([0, 33, 67]), true)
  assert.equal(ptsUsable([0, 0, 67]), false)
  assert.equal(ptsUsable([0, null, 67]), false)
})

function frameTimes({ fromMs = 0, toMs = 10_000, fps = 30, gaps = [] } = {}) {
  const times = []
  for (let time = fromMs; time < toMs; time += 1000 / fps) {
    if (!gaps.some((gap) => time >= gap.fromMs && time < gap.toMs)) times.push(time)
  }
  return times
}

test('cadence: 30 fps passes, 28 fps fails, and a hitch at Record fails its window', () => {
  const judged = { fromMs: 0, toMs: 10_000 }
  const windows = [
    { label: 'Record', fromMs: 1500, toMs: 3500 },
    { label: 'Stop', fromMs: 7000, toMs: 9000 }
  ]
  const steady = cadenceVerdict({ timesMs: frameTimes(), judged, windows })
  assert.equal(steady.ok, true, steady.failures.join('; '))
  assert.ok(Math.abs(steady.overall.fps - 30) < 0.01)

  const slow = cadenceVerdict({ timesMs: frameTimes({ fps: 28 }), judged, windows })
  assert.equal(slow.ok, false)
  assert.match(slow.failures[0], /28 fps over the read, outside 30 ± 1 fps/)

  const hitch = cadenceVerdict({
    timesMs: frameTimes({ gaps: [{ fromMs: 2000, toMs: 2300 }] }),
    judged,
    windows
  })
  assert.equal(hitch.ok, false)
  assert.ok(hitch.failures.some((failure) => failure.startsWith('Record:')))
  assert.ok(!hitch.failures.some((failure) => failure.startsWith('Stop:')))
  assert.ok(hitch.windows[0].maxGapMs >= 300)

  const short = cadenceVerdict({ timesMs: frameTimes({ toMs: 6000 }), judged })
  assert.match(short.failures.join('; '), /covered 6 s of the judged 10 s/)
  assert.deepEqual(cadenceStats([], judged), { frames: 0, spanMs: 0, fps: null, maxGapMs: null })
  assert.match(
    cadenceVerdict({ timesMs: [], judged }).failures[0],
    /^no frames from Videorc Camera/
  )
})

// --- Content -------------------------------------------------------------------------

/** One track: frames at 30 fps whose code is the ticker's step `lagMs` earlier. */
function codeTrack({ fromMs, toMs, lagMs = 0, code = null, ringRgb = [30, 40, 120] }) {
  return frameTimes({ fromMs, toMs }).map((tMs) => ({
    tMs,
    code: code ?? Math.floor((tMs - lagMs) / 1000) % CODE_PERIOD,
    ringRgb
  }))
}

test('content: the camera matches the recording frame by frame within the drift', () => {
  const recording = codeTrack({ fromMs: 2000, toMs: 9000, lagMs: 80 })
  const camera = codeTrack({ fromMs: 0, toMs: 11_000, lagMs: 780 })
  const match = matchCodeTracks({ camera, recording })
  assert.equal(match.ok, true, match.failures.join('; '))
  assert.ok(Math.abs(match.offsetMs - 700) <= 34, `offset ${match.offsetMs}`)
  assert.ok(match.agreement >= 0.99)
  assert.ok(match.distinctCodes >= VIRTUAL_CAMERA_SMOKE_BUDGET.distinctCodesMin)
})

test('content: more than 2 s of drift, a stuck code and a different ring each fail', () => {
  const recording = codeTrack({ fromMs: 2000, toMs: 9000 })
  const drifted = matchCodeTracks({
    camera: codeTrack({ fromMs: 0, toMs: 13_000, lagMs: 2700 }),
    recording
  })
  assert.equal(drifted.ok, false)
  assert.match(drifted.failures.join('; '), /more than 2000 ms of drift/)

  const stuck = matchCodeTracks({
    camera: codeTrack({ fromMs: 0, toMs: 11_000, code: 3 }),
    recording
  })
  assert.equal(stuck.ok, false)
  assert.match(stuck.failures.join('; '), /agrees with the recording on/)

  const otherRing = matchCodeTracks({
    camera: codeTrack({ fromMs: 0, toMs: 11_000, ringRgb: [200, 200, 200] }),
    recording
  })
  assert.equal(otherRing.ok, false)
  assert.match(otherRing.failures.join('; '), /not showing the bundled image/)

  const unreadable = matchCodeTracks({
    camera: codeTrack({ fromMs: 0, toMs: 11_000 }),
    recording: recording.map((frame) => ({ ...frame, code: null }))
  })
  assert.match(unreadable.failures[0], /recording carries no readable marker/)
})

// --- Hide screen ------------------------------------------------------------------

function hideFeatures({ frostAfterMs = 200, liveAfterShowMs = 200, movingAfter = true } = {}) {
  const hideAtMs = 4000
  const showAtMs = 6000
  const ptsMs = frameTimes({ fromMs: 0, toMs: 9000 })
  const features = ptsMs.map((pts, index) => {
    const frosted = pts >= hideAtMs + frostAfterMs && pts < showAtMs + liveAfterShowMs
    return {
      index,
      sharp: frosted ? 0 : 0.002,
      repeated: frosted || (!movingAfter && pts >= showAtMs)
    }
  })
  return { features, ptsMs, offsetMs: 0, hideAtMs, showAtMs, untilMs: 9000 }
}

test('Hide screen: frost within 1 s of the hide and live within 1 s of Show', () => {
  const good = cameraHideVerdict(hideFeatures())
  assert.equal(good.ok, true, good.failures.join('; '))
  const lateFrost = cameraHideVerdict(hideFeatures({ frostAfterMs: 1300 }))
  assert.equal(lateFrost.ok, false)
  assert.match(lateFrost.failures.join('; '), /first frosted frame 13\d\d ms after the press/)
  const lateLive = cameraHideVerdict(hideFeatures({ liveAfterShowMs: 1200 }))
  assert.equal(lateLive.ok, false)
  assert.match(lateLive.failures.join('; '), /first live frame 12\d\d ms after Show/)
})

test('Hide screen on a still display drops only the motion rule', () => {
  const still = hideFeatures({ movingAfter: false })
  assert.match(cameraHideVerdict(still).failures.join('; '), /never moved/)
  const display = cameraHideVerdict({ ...still, requireMotion: false })
  assert.equal(display.ok, true, display.failures.join('; '))
  const leak = cameraHideVerdict({ ...hideFeatures({ frostAfterMs: 1300 }), requireMotion: false })
  assert.equal(leak.ok, false)
})

// --- Listings and presence ------------------------------------------------------------

const AVFOUNDATION_LIST = `[AVFoundation indev @ 0x7f8] AVFoundation video devices:
[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8] [1] OBS Virtual Camera
[AVFoundation indev @ 0x7f8] [2] Videorc Camera
[AVFoundation indev @ 0x7f8] [3] Capture screen 0
[AVFoundation indev @ 0x7f8] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8] [0] Videorc Camera
[AVFoundation indev @ 0x7f8] [1] MacBook Pro Microphone
: Input/output error`

test('avfoundation listing: exact names, video only, duplicates counted', () => {
  assert.deepEqual(parseAvfoundationVideoDevices(AVFOUNDATION_LIST), [
    'FaceTime HD Camera',
    'OBS Virtual Camera',
    'Videorc Camera',
    'Capture screen 0'
  ])
  assert.deepEqual(cameraListing('darwin', AVFOUNDATION_LIST), {
    listed: true,
    count: 1,
    names: ['FaceTime HD Camera', 'OBS Virtual Camera', 'Videorc Camera', 'Capture screen 0']
  })
  const twice = AVFOUNDATION_LIST.replace('[3] Capture screen 0', '[3] Videorc Camera')
  assert.equal(cameraListing('darwin', twice).count, 2)
  const withoutIt = AVFOUNDATION_LIST.replace('[2] Videorc Camera', '[2] Videorc Camera Spike')
  assert.equal(cameraListing('darwin', withoutIt).listed, false)
})

test('dshow listing: the FFmpeg 5+ form and the older header form', () => {
  const modern = `[dshow @ 000001] "Integrated Camera" (video)
[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2"
[dshow @ 000001] "Videorc Camera Windows Virtual Camera" (video)
[dshow @ 000001] "Microphone (Realtek)" (audio)`
  assert.deepEqual(parseDshowVideoDevices(modern), [
    'Integrated Camera',
    'Videorc Camera Windows Virtual Camera'
  ])
  assert.equal(cameraListing('win32', modern).listed, true)
  const legacy = `[dshow @ 01] DirectShow video devices (some may be both video and audio devices)
[dshow @ 01]  "Integrated Camera"
[dshow @ 01] DirectShow audio devices
[dshow @ 01]  "Videorc Camera Windows Virtual Camera"`
  assert.deepEqual(parseDshowVideoDevices(legacy), ['Integrated Camera'])
  assert.equal(cameraListing('win32', legacy).listed, false)
})

test('v4l2 listing: a capture device lists its formats, a bare node does not', () => {
  const listed = `[video4linux2,v4l2 @ 0x55] Raw       :     yuyv422 :           YUYV 4:2:2 : 1920x1080`
  assert.equal(parseV4l2Listing(listed).listed, true)
  assert.equal(cameraListing('linux', listed).count, 1)
  assert.equal(
    parseV4l2Listing('[video4linux2,v4l2 @ 0x55] Not a video capture device.').listed,
    false
  )
})

test('presence: Windows and Linux only while on; macOS keeps the off still (D12)', () => {
  const listed = { listed: true, count: 1 }
  const absent = { listed: false, count: 0 }
  const still = { frames: 70, markerFrames: 0, distinctCodes: 0 }
  for (const platform of ['win32', 'linux']) {
    assert.equal(presenceVerdict({ platform, phase: 'off', listing: absent }).ok, true)
    const leaked = presenceVerdict({ platform, phase: 'off', listing: listed })
    assert.match(leaked.failures[0], /exists only while the switch is on/)
    assert.equal(presenceVerdict({ platform, phase: 'on', listing: listed }).ok, true)
    assert.equal(presenceVerdict({ platform, phase: 'on', listing: absent }).ok, false)
  }
  assert.equal(
    presenceVerdict({ platform: 'darwin', phase: 'off', listing: listed, read: still }).ok,
    true
  )
  assert.match(
    presenceVerdict({ platform: 'darwin', phase: 'off', listing: absent, read: still }).failures[0],
    /keeps it in every app's list/
  )
  assert.match(
    presenceVerdict({
      platform: 'darwin',
      phase: 'off',
      listing: listed,
      read: { frames: 70, markerFrames: 12, distinctCodes: 2 }
    }).failures[0],
    /the program shows while the switch is off/
  )
  assert.match(
    presenceVerdict({ platform: 'darwin', phase: 'off', listing: listed, read: { frames: 0 } })
      .failures[0],
    /gave no frames while the switch is off/
  )
  const duplicate = presenceVerdict({
    platform: 'darwin',
    phase: 'on',
    listing: { listed: true, count: 2 }
  })
  assert.match(duplicate.failures[0], /2 cameras are named exactly "Videorc Camera"/)
})

// --- Classification ---------------------------------------------------------------------

test('start: ready and streaming go on; approval, setup and unsupported SKIP with the state named', () => {
  for (const status of [fixtures.ready, fixtures.streaming, fixtures.streamingUnknownViewers]) {
    assert.deepEqual(classifyCameraStart({ status, listed: true, platform: 'darwin' }), {
      action: 'proceed',
      expectProgram: true
    })
  }
  const approval = classifyCameraStart({
    status: fixtures.needsApproval,
    listed: true,
    platform: 'darwin'
  })
  assert.equal(approval.action, 'skip')
  assert.match(approval.reason, /state needs-approval, platformStep needs-approval/)
  assert.match(approval.reason, /Camera Extensions/)
  const setup = classifyCameraStart({
    status: fixtures.needsSetup,
    listed: false,
    platform: 'win32'
  })
  assert.equal(setup.action, 'skip')
  assert.match(setup.reason, /state needs-setup/)
  const linux = classifyCameraStart({
    status: { on: true, available: false, state: 'unavailable', platformStep: 'unsupported' },
    listed: false,
    platform: 'linux'
  })
  assert.equal(linux.action, 'skip')
  assert.match(linux.reason, /platformStep unsupported/)
})

test('start: installing past the wait, off and nonsense states FAIL', () => {
  const installing = classifyCameraStart({
    status: { on: true, available: true, state: 'installing', message: 'Starting Videorc Camera…' },
    listed: false,
    waitedMs: 20_000
  })
  assert.equal(installing.action, 'fail')
  assert.match(installing.reason, /still installing after 20 s/)
  assert.equal(classifyCameraStart({ status: fixtures.off, listed: true }).action, 'fail')
  assert.equal(classifyCameraStart({ status: null, listed: true }).action, 'fail')
  assert.equal(
    classifyCameraStart({ status: { on: true, available: true, state: 'sleeping' }, listed: true })
      .action,
    'fail'
  )
})

test("red first: today's base, where nothing pushes frames, FAILS and never passes", () => {
  // The backend has no sink yet (B4 unshipped) and says so.
  const status = fixtures.unavailableNoSink
  assert.match(status.message, /hasn't shipped/)

  // With an approved extension (or the same-name P0a spike) the platform
  // lists Videorc Camera, so the read goes on instead of skipping.
  const start = classifyCameraStart({ status, listed: true, platform: 'darwin' })
  assert.equal(start.action, 'proceed')
  assert.equal(start.expectProgram, false)

  // The extension draws its still: frames, but no marker.
  const stillFrames = Array.from({ length: 150 }, () => analyzeFrame(flatFrame([20, 20, 24]), null))
  const still = classifyCameraRead({ summary: markerSummary(stillFrames), start })
  assert.equal(still.kind, 'fail')
  assert.match(still.reason, /^still instead of program: 150 frame\(s\) from Videorc Camera/)
  assert.match(still.reason, /backend says unavailable/)

  // Or the reader opens it and nothing arrives.
  const silent = classifyCameraRead({
    summary: markerSummary([]),
    start,
    readerError: 'no frame within 5 s of opening the camera'
  })
  assert.equal(silent.kind, 'fail')
  assert.match(silent.reason, /^no frames from Videorc Camera: no frame within 5 s/)

  for (const reason of [still.reason, silent.reason]) {
    const verdict = smokeVerdict({ fatal: reason })
    assert.equal(verdict.result, 'FAIL')
    assert.equal(verdict.failures[0], reason)
  }

  // A program while the status says unavailable is a lie, not a pass.
  const lying = classifyCameraRead({
    summary: { frames: 300, markerFrames: 300, distinctCodes: 6 },
    start
  })
  assert.equal(lying.kind, 'fail')
  assert.match(lying.reason, /while the backend reports it unavailable/)

  // With nothing listed at all no app can pick a camera: a SKIP that names
  // the backend's own sentence, never a pass.
  const unlisted = classifyCameraStart({ status, listed: false, platform: 'darwin' })
  assert.equal(unlisted.action, 'skip')
  assert.match(unlisted.reason, /unavailable and no app lists it/)
  assert.match(unlisted.reason, /plan 214 B4, hasn't shipped/)
  assert.equal(smokeVerdict({ skip: unlisted.reason }).result, 'SKIP')
})

test('read: the program passes; a frozen marker fails; a denied grant SKIPs by name', () => {
  const frames = Array.from({ length: 60 }, (_, index) =>
    analyzeFrame(programFrame(Math.floor(index / 30)), null)
  )
  assert.deepEqual(markerSummary(frames), { frames: 60, markerFrames: 60, distinctCodes: 2 })
  assert.deepEqual(classifyCameraRead({ summary: markerSummary(frames) }), { kind: 'program' })
  const frozen = classifyCameraRead({ summary: { frames: 90, markerFrames: 90, distinctCodes: 1 } })
  assert.match(frozen.reason, /^frozen program/)
  const denied = classifyCameraRead({
    summary: markerSummary([]),
    accessDenied: cameraAccessDenied(
      'darwin',
      'Failed to create AV capture input device: Cannot use Videorc Camera',
      {
        terminal: 'iTerm.app'
      }
    )
  })
  assert.equal(denied.kind, 'skip')
  assert.match(denied.reason, /allow iTerm.app .* Privacy & Security > Camera/)
})

test('camera access: each platform names its own grant, and other errors are not grants', () => {
  assert.match(cameraAccessDenied('darwin', 'Not authorized to capture video') ?? '', /Camera/)
  assert.equal(
    cameraAccessDenied('darwin', 'Selected framerate (30.000000) is not supported'),
    null
  )
  assert.match(
    cameraAccessDenied(
      'win32',
      'Could not run graph (sometimes caused by a device already in use by other application): Access is denied.'
    ) ?? '',
    /Let desktop apps access your camera/
  )
  assert.match(cameraAccessDenied('linux', '/dev/video42: Permission denied') ?? '', /video group/)
  assert.equal(cameraAccessDenied('linux', 'No such file or directory'), null)
})

// --- Counters, self-listing and the verdict ------------------------------------------------

test('counters: pushes rise; macOS stays zero-copy; Windows and Linux fit under 4 ms', () => {
  const before = { virtualCameraPushed: 10 }
  assert.equal(
    counterVerdict({ platform: 'darwin', before, after: { virtualCameraPushed: 330 } }).ok,
    true
  )
  assert.match(
    counterVerdict({
      platform: 'darwin',
      before,
      after: { virtualCameraPushed: 330, virtualCameraConvertMsMax: 1.2 }
    }).failures[0],
    /zero-copy/
  )
  assert.equal(
    counterVerdict({
      platform: 'win32',
      before,
      after: { virtualCameraPushed: 330, virtualCameraConvertMsMax: 3.9 }
    }).ok,
    true
  )
  assert.match(
    counterVerdict({
      platform: 'linux',
      before,
      after: { virtualCameraPushed: 330, virtualCameraConvertMsMax: 4.2 }
    }).failures[0],
    /4.2 ms, not under 4 ms/
  )
  // Today's base: the counters are absent (0 while nothing pushes).
  assert.match(
    counterVerdict({ platform: 'darwin', before: {}, after: {} }).failures[0],
    /did not rise over the read \(0 then 0\)/
  )
})

test('self-listing: the backend never offers Videorc Camera as a source', () => {
  const list = {
    devices: [
      { id: 'camera:avfoundation:0x1', name: 'FaceTime HD Camera', kind: 'camera' },
      { id: 'camera:avfoundation:obs', name: 'OBS Virtual Camera', kind: 'camera' },
      { id: 'screen:1', name: 'Videorc Camera', kind: 'screen' }
    ]
  }
  assert.deepEqual(selfListedCameras(list), [])
  for (const device of [
    { id: 'camera:avfoundation:x', name: 'Videorc Camera' },
    { id: `camera:avfoundation:${VIRTUAL_CAMERA.macosDeviceUuid.toLowerCase()}`, name: 'Camera' },
    { id: 'camera:dshow:x', name: 'Videorc Camera Windows Virtual Camera' },
    { id: `camera:mf:\\\\?\\swd#${VIRTUAL_CAMERA.windowsSourceClsid}`, name: 'Camera' },
    { id: 'camera:v4l2:/dev/video42', name: 'Dummy video device' }
  ]) {
    assert.equal(
      selfListedCameras({ devices: [{ ...device, kind: 'camera' }] }).length,
      1,
      device.id
    )
  }
})

test('the verdict: every assertion judged and green is a PASS; a SKIP must say why', () => {
  const green = Object.fromEntries(
    VIRTUAL_CAMERA_SMOKE_ASSERTIONS.map(({ id }) => [id, { ok: true, failures: [] }])
  )
  assert.equal(smokeVerdict({ assertions: green }).result, 'PASS')
  const { cadence: _cadence, ...missing } = green
  const notJudged = smokeVerdict({ assertions: missing })
  assert.equal(notJudged.result, 'FAIL')
  assert.deepEqual(notJudged.failures, ['cadence: not judged'])
  const red = smokeVerdict({
    assertions: { ...green, counters: { ok: false, failures: ['pushes did not rise'] } }
  })
  assert.deepEqual(red.failures, ['counters: pushes did not rise'])
  assert.throws(() => smokeVerdict({ skip: '  ' }), /must name its reason/)
  assert.equal(VIRTUAL_CAMERA_SMOKE_ASSERTIONS.length, 7)
})
