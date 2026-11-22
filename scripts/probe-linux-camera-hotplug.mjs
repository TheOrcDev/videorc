// Linux camera hotplug probe (plan 257 S2): launch the dev app, start the
// camera preview, then remove and re-add the camera and time each kernel
// edge against the app's `devices.changed` event (the picker refreshes from
// that event).
//
//   done when: the camera leaves the device list within 2 s of its node going,
//   comes back within 2 s of its node appearing, the running preview reports
//   Disconnected, and goes Live again on its own after the camera returns.
//
// Two ways to remove the camera:
//   manual (default)   you unplug and replug a USB webcam when asked
//   VIDEORC_HOTPLUG_UVC_INTERFACE=7-2:1.0
//                      unbinds and rebinds that USB interface from uvcvideo
//                      with `sudo -n` (a real kernel remove/add of the node;
//                      the lab's stand-in until a USB webcam is plugged in)
//
//   VIDEORC_HOTPLUG_CAMERA_NAME   substring of the camera to use (default: the
//                                 first available camera)
//   VIDEORC_HOTPLUG_CYCLES        remove/add cycles (default 2)
//   VIDEORC_HOTPLUG_WAIT_MS       how long to wait for each manual edge (120000)
//   VIDEORC_HOTPLUG_MAX_MS        the latency gate (default 2000)
//   VIDEORC_SMOKE_OUTPUT_DIR      evidence directory

import { spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

if (process.platform !== 'linux') {
  console.error('Linux camera hotplug probe FAILED: this probe only runs on Linux')
  process.exit(1)
}

const uvcInterface = process.env.VIDEORC_HOTPLUG_UVC_INTERFACE?.trim() || null
const cameraName = process.env.VIDEORC_HOTPLUG_CAMERA_NAME?.trim() || null
const cycles = Number(process.env.VIDEORC_HOTPLUG_CYCLES ?? 2)
const manualWaitMs = Number(process.env.VIDEORC_HOTPLUG_WAIT_MS ?? 120000)
const maxLatencyMs = Number(process.env.VIDEORC_HOTPLUG_MAX_MS ?? 2000)
const stepTimeoutMs = 45000
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-hotplug-'))
)
mkdirSync(outputDirectory, { recursive: true })
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  join(resolve(import.meta.dirname, '..'), 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffmpeg')

const evidence = {
  generatedAt: new Date().toISOString(),
  contract: 'plan-257-s2-camera-hotplug',
  mode: uvcInterface ? `uvcvideo unbind/bind ${uvcInterface}` : 'manual USB plug',
  maxLatencyMs,
  cycles: [],
  failures: []
}
const save = () =>
  writeFileSync(join(outputDirectory, 'camera-hotplug.json'), JSON.stringify(evidence, null, 2))
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const log = (line) => console.log(`[hotplug] ${line}`)

const SYSFS = '/sys/class/video4linux'
const sysfsName = (node) => {
  try {
    return readFileSync(`${SYSFS}/${node}/name`, 'utf8').trim()
  } catch {
    return null
  }
}
const captureNodes = () => {
  try {
    return readdirSync(SYSFS).filter((node) => {
      try {
        return (
          node.startsWith('video') && readFileSync(`${SYSFS}/${node}/index`, 'utf8').trim() === '0'
        )
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/** Polls sysfs every 10 ms until `done()`; the time the edge was seen. */
async function waitUntil(done, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (done()) return Date.now()
    await sleep(10)
  }
  return null
}

/** Unbinds or binds the interface without blocking the poll or the socket. */
function uvc(action) {
  return new Promise((resolveAction, rejectAction) => {
    const child = spawn('sudo', ['-n', 'tee', `/sys/bus/usb/drivers/uvcvideo/${action}`], {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', rejectAction)
    child.on('close', (code) =>
      code === 0
        ? resolveAction()
        : rejectAction(new Error(`uvcvideo ${action} ${uvcInterface} failed: ${stderr.trim()}`))
    )
    child.stdin.end(uvcInterface)
  })
}

let stopApp = async () => {}
try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_LINUX_H264_ENCODER: process.env.VIDEORC_LINUX_H264_ENCODER ?? 'openh264',
      // The probe drives the camera itself (see smoke-linux-av-devices.mjs).
      VIDEORC_DISABLE_AUTO_SOURCE_PREVIEW: '1'
    },
    timeoutMs: 180000,
    requiredMarkers: ['backend-ready'],
    onLine: (line) => {
      if (/device-watch|camera-modes|v4l2/i.test(line)) console.log(line)
    }
  })
  stopApp = launch.stop
  const ws = await connectBackend(launch.connections['backend-ready'], 60000)

  // Every devices.changed and camera status, stamped on arrival.
  const deviceEvents = []
  const cameraEvents = []
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.event === 'devices.changed') {
      deviceEvents.push({ at: Date.now(), devices: message.payload?.devices ?? [] })
    } else if (message.event === 'preview.camera.status') {
      cameraEvents.push({
        at: Date.now(),
        state: message.payload?.state,
        message: message.payload?.message
      })
    }
  })
  const waitFor = async (events, since, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = events.find((entry) => entry.at >= since && predicate(entry))
      if (hit) return hit
      await sleep(10)
    }
    return null
  }
  const listsCamera = (devices, id) =>
    devices.some((device) => device.id === id && device.status === 'available')

  const list = await request(ws, stepTimeoutMs, 'devices.list', { ffmpegPath })
  const cameras = (list.devices ?? []).filter(
    (device) => device.kind === 'camera' && device.status === 'available'
  )
  const camera = cameraName
    ? cameras.find((device) => device.name.includes(cameraName))
    : cameras[0]
  if (!camera) throw new Error(`no available camera${cameraName ? ` named ${cameraName}` : ''}`)
  camera.devicePath = Buffer.from(camera.id.slice('camera:linux-v4l2:'.length), 'hex').toString()
  evidence.camera = { id: camera.id, name: camera.name, devicePath: camera.devicePath }
  log(`camera: ${camera.name}`)

  const video = { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 6000 }
  const layout = {
    layoutPreset: 'camera-only',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideCameraSide: 'right'
  }
  const sources = {
    screenId: null,
    windowId: null,
    cameraId: camera.id,
    microphoneId: null,
    testPattern: false
  }
  let status = await request(ws, stepTimeoutMs, 'preview.camera.start', {
    sources,
    layout,
    video,
    ffmpegPath
  })
  const liveDeadline = Date.now() + stepTimeoutMs
  while (status.state !== 'live' && Date.now() < liveDeadline) {
    await sleep(250)
    status = await request(ws, stepTimeoutMs, 'preview.camera.status')
  }
  if (status.state !== 'live') throw new Error(`camera preview never went live: ${status.message}`)
  evidence.preview = { state: status.state, message: status.message }
  log(`preview live: ${status.message}`)

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const record = { cycle }
    evidence.cycles.push(record)
    // Only the selected camera's own node counts, so another camera's
    // change cannot stand in for this one.
    const node = realpathSync(camera.devicePath).split('/').pop()
    const name = sysfsName(node)

    // Remove; the poll runs while the unbind does.
    const removeAsked = Date.now()
    const unbind = uvcInterface ? uvc('unbind') : null
    if (!uvcInterface) log(`cycle ${cycle}: UNPLUG ${camera.name} now`)
    const removedAt = await waitUntil(
      () => sysfsName(node) === null,
      uvcInterface ? 10000 : manualWaitMs
    )
    await unbind
    if (!removedAt) throw new Error(`cycle ${cycle}: ${node} never went away`)
    const gone = await waitFor(
      deviceEvents,
      removeAsked,
      (entry) => !listsCamera(entry.devices, camera.id),
      10000
    )
    const disconnected = await waitFor(
      cameraEvents,
      removeAsked,
      (entry) => entry.state === 'disconnected',
      10000
    )
    record.removedMs = gone ? gone.at - removedAt : null
    record.previewDisconnectedMs = disconnected ? disconnected.at - removedAt : null
    record.disconnectedMessage = disconnected?.message ?? null
    log(
      `cycle ${cycle}: list dropped it in ${record.removedMs} ms; preview ${disconnected ? `disconnected in ${record.previewDisconnectedMs} ms` : 'never reported disconnected'}`
    )
    save()

    // Re-add.
    const leftNodes = new Set(captureNodes())
    await sleep(1000)
    const addAsked = Date.now()
    const bind = uvcInterface ? uvc('bind') : null
    if (!uvcInterface) log(`cycle ${cycle}: PLUG ${camera.name} back in now`)
    // Its capture node returns, under the same name, at any number.
    const addedAt = await waitUntil(
      () =>
        captureNodes().some(
          (candidate) => !leftNodes.has(candidate) && sysfsName(candidate) === name
        ),
      uvcInterface ? 10000 : manualWaitMs
    )
    await bind
    if (!addedAt) throw new Error(`cycle ${cycle}: ${camera.name} never came back`)
    const back = await waitFor(
      deviceEvents,
      addAsked,
      (entry) => listsCamera(entry.devices, camera.id),
      10000
    )
    const live = await waitFor(cameraEvents, addAsked, (entry) => entry.state === 'live', 20000)
    record.addedMs = back ? back.at - addedAt : null
    record.previewLiveAgainMs = live ? live.at - addedAt : null
    log(
      `cycle ${cycle}: list showed it in ${record.addedMs} ms; preview ${live ? `live again in ${record.previewLiveAgainMs} ms` : 'never went live again'}`
    )
    const checks = [
      [record.removedMs !== null && record.removedMs < maxLatencyMs, 'left the list'],
      [record.addedMs !== null && record.addedMs < maxLatencyMs, 'came back to the list'],
      [record.previewDisconnectedMs !== null, 'preview reported Disconnected'],
      [record.previewLiveAgainMs !== null, 'preview went Live again']
    ]
    for (const [ok, label] of checks) {
      if (!ok) evidence.failures.push(`cycle ${cycle}: camera ${label} late or never`)
    }
    save()
    await sleep(2000)
  }
  await request(ws, stepTimeoutMs, 'preview.camera.stop').catch(() => {})
  ws.close()
} catch (error) {
  evidence.failures.push(String(error?.stack ?? error))
  console.error(`[hotplug] ${error?.stack ?? error}`)
  // Never leave the lab camera unbound.
  if (uvcInterface && !readdirSync('/sys/bus/usb/drivers/uvcvideo').includes(uvcInterface)) {
    try {
      await uvc('bind')
    } catch (bindError) {
      console.error(`[hotplug] ${bindError.message}`)
    }
  }
} finally {
  evidence.outcome = evidence.failures.length === 0 ? 'pass' : 'fail'
  save()
  await stopApp()
}
if (evidence.outcome === 'pass') {
  console.log(`Linux camera hotplug probe PASS; evidence in ${outputDirectory}`)
} else {
  console.error(`Linux camera hotplug probe FAILED:\n- ${evidence.failures.join('\n- ')}`)
  process.exitCode = 1
}
