/**
 * The baseline profile (plan 220 S0.1a, step 1): one isolated profile both apps
 * can show the same screen from. The Electron app is shot from it by
 * `scripts/lib/rust-ui-baseline.mjs`; the Rust app's shooter (S3.0b) reads the
 * same pure pieces here, so the same seed gives the same screen in both:
 *
 *   - `baselineFixtureFiles(dir)` writes the small fixtures (two banners, two
 *     takeovers, two sounds, a background image) as bytes this file generates,
 *     the same bytes every run, so nothing binary is committed.
 *   - `baselineCaptureConfigPatch()`, `baselineScenes()`, `baselineWorkingScene()`
 *     and `baselineUiSettings()` are the product settings (UI settings keys and
 *     their string values) that every app reads.
 *   - `seedBaselineBackend()` puts what lives in the backend into an isolated
 *     profile: the fixtures through the smoke import paths, destinations with
 *     fake keys, the fake chat connector's rows and two Library sessions.
 *
 * Nothing here reaches a real account, device or channel: the sources are the
 * test pattern with the camera and the microphone off, every key is fake and
 * the only destination that can go on air is a local RTMP sink.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

/** The date every seeded record carries, so a screen never shows today's date. */
export const BASELINE_SEED_TIME = '2026-11-01T12:00:00.000Z'

/** The fake stream key every seeded destination holds (a canary, never real). */
export const BASELINE_FAKE_STREAM_KEY = 'live_baseline_fake_key_0000'

/** Platforms the seed turns on, with the label the Livestream page shows. */
export const BASELINE_ENABLED_DESTINATIONS = Object.freeze([
  { id: 'youtube', platform: 'youtube' },
  { id: 'twitch', platform: 'twitch' },
  { id: 'custom', platform: 'custom' }
])

/** Rows each fake platform sends: few and quick, so every look sees the same ones. */
export const BASELINE_CHAT_ROWS = 8

/** Each seeded test recording's length. Over Clean cut's 10 s minimum
 * (`CLEAN_CUT_MIN_SOURCE_MS`, Electron's `cleanCutEligibility`), so Clean
 * cut lists both takes, with their posters, in both apps. */
export const BASELINE_TAKE_MS = 12_000

/** The fake chat connector's destinations (smoke:live-chat-fake-providers' shape). */
export const BASELINE_CHAT_TARGETS = Object.freeze({
  youtube: 'baseline-youtube',
  twitch: 'baseline-twitch',
  x: 'baseline-x'
})

// ---------------------------------------------------------------------------
// Fixture bytes
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * An RGBA PNG from `pixel(x, y) => [r, g, b, a]`. Deterministic: the same call
 * returns the same bytes (zlib's level and the filter byte are fixed).
 */
export function encodePng(width, height, pixel) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Not a PNG size: ${width}x${height}`)
  }
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const base = y * (width * 4 + 1)
    rows[base] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixel(x, y)
      const at = base + 1 + x * 4
      rows[at] = r
      rows[at + 1] = g
      rows[at + 2] = b
      rows[at + 3] = a
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** A 16-bit mono PCM WAV of a sine tone, `seconds` long. */
export function encodeToneWav({ hz, seconds, amplitude = 0.4, sampleRate = 48_000 }) {
  const samples = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(samples * 2)
  const fade = Math.round(sampleRate * 0.02)
  for (let i = 0; i < samples; i += 1) {
    const edge = Math.min(1, i / fade, (samples - 1 - i) / fade)
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amplitude * edge * 32_767),
      i * 2
    )
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const mix = (a, b, t) => Math.round(a + (b - a) * t)

/** The fixtures: name to bytes. Pure, so a test can pin them. */
export function baselineFixtureBytes() {
  return {
    'banner-lower-third.png': encodePng(1200, 200, (x, y) => {
      const edge = x < 12 || y < 4 || y > 195
      return edge ? [255, 255, 255, 255] : [mix(20, 70, x / 1200), mix(90, 150, y / 200), 220, 235]
    }),
    'banner-logo.png': encodePng(256, 256, (x, y) => {
      const dx = x - 128
      const dy = y - 128
      const inside = dx * dx + dy * dy < 120 * 120
      return inside ? [mix(240, 255, y / 256), 130, 40, 255] : [0, 0, 0, 0]
    }),
    'takeover-be-right-back.png': encodePng(640, 360, (x, y) => [
      mix(30, 90, y / 360),
      40,
      mix(110, 190, x / 640),
      255
    ]),
    'takeover-starting-soon.png': encodePng(640, 360, (x, y) => [
      mix(150, 230, x / 640),
      mix(60, 100, y / 360),
      70,
      255
    ]),
    'background-baseline.png': encodePng(1280, 720, (x, y) => [
      mix(15, 60, x / 1280),
      mix(25, 90, y / 720),
      mix(60, 140, (x + y) / 2000),
      255
    ]),
    'sound-ding.wav': encodeToneWav({ hz: 880, seconds: 0.5 }),
    'sound-low.wav': encodeToneWav({ hz: 220, seconds: 0.7 })
  }
}

/** Writes the fixtures under `dir` and answers name to absolute path. */
export function baselineFixtureFiles(dir) {
  mkdirSync(dir, { recursive: true })
  const paths = {}
  for (const [name, bytes] of Object.entries(baselineFixtureBytes())) {
    const path = join(dir, name)
    writeFileSync(path, bytes)
    paths[name] = path
  }
  return paths
}

// ---------------------------------------------------------------------------
// Product settings
// ---------------------------------------------------------------------------

/** The sources every app starts from: the test pattern, nothing from a device. */
export const BASELINE_SOURCES = Object.freeze({
  testPattern: true,
  cameraOff: true,
  captureOff: false,
  microphoneOff: true
})

/**
 * What the capture config gets over its defaults (`videorc.captureConfig`, one
 * level deep): the sources, the output and the saved destinations. The
 * destinations' stream keys are added by `seedBaselineBackend`, which holds the
 * secret references.
 */
export function baselineCaptureConfigPatch({ sinkPort = 13_990 } = {}) {
  return {
    sources: { ...BASELINE_SOURCES },
    video: { preset: 'tutorial-1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
    recordEnabled: true,
    streamEnabled: false,
    // The clips ring's counter ticks; the baseline holds it off.
    replayBuffer: { enabled: false, explicit: true },
    baselineSink: { serverUrl: `rtmp://127.0.0.1:${sinkPort}/live`, streamKey: 'baseline' }
  }
}

/** The three saved scenes, from the working scene's visual (a layout each). */
export function baselineScenes(visual) {
  const scene = (id, name, layoutPreset) => ({
    id,
    name,
    createdAt: BASELINE_SEED_TIME,
    updatedAt: BASELINE_SEED_TIME,
    visual: { ...visual, layout: { ...visual.layout, layoutPreset } }
  })
  return {
    version: 1,
    scenes: [
      scene('baseline-scene-talk', 'Talking head', 'screen-camera'),
      scene('baseline-scene-demo', 'Demo', 'screen-only'),
      scene('baseline-scene-side', 'Side by side', 'side-by-side')
    ]
  }
}

/**
 * The working scene: Demo (screen only), so the Studio is ready with the camera
 * off; the two camera scenes show the app's own "Resolve sources" until a
 * camera exists.
 */
export function baselineWorkingScene(visual) {
  return {
    version: 1,
    origin: 'saved',
    sceneId: 'baseline-scene-demo',
    visual: {
      ...visual,
      layout: { ...visual.layout, layoutPreset: 'screen-only' },
      sources: { ...visual.sources, ...BASELINE_SOURCES }
    }
  }
}

/**
 * The plain string keys: nothing that needs the app's own defaults. The theme
 * is set per look by the shooter. `whatsNewLastSeenVersion` is the app's own
 * version, so What's new stays closed until a state asks for it.
 */
export function baselineUiSettings({ whatsNewVersion }) {
  return {
    'videorc.onboardingComplete': 'creator-ux-v1',
    'videorc.whatsNewLastSeenVersion': whatsNewVersion,
    'videorc.aiConsent': '1'
  }
}

// ---------------------------------------------------------------------------
// The backend half
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Seeds an isolated backend. `rpc(method, params)` is the renderer-socket
 * request, `smoke(command, params)` the smoke command; both are the shooter's.
 * Each step reports itself in `seeded`, and one that cannot run lands in
 * `failed` with its reason (the manifest lists what depends on it as missing).
 */
export async function seedBaselineBackend({ rpc, smoke, fixtures, recordingsDir, log = () => {} }) {
  const seeded = []
  const failed = []
  const step = async (name, work) => {
    try {
      const detail = await work()
      seeded.push(name)
      log(`seeded ${name}`)
      return detail
    } catch (error) {
      failed.push({ name, reason: String(error?.message ?? error) })
      log(`could not seed ${name}: ${error?.message ?? error}`)
      return null
    }
  }
  const authorize = async (path, kind = 'input-file') =>
    (await smoke('authorize-smoke-resource', { path, kind })).capabilityId
  const importWhenFree = async (work) => {
    const until = Date.now() + 30_000
    for (;;) {
      try {
        return await work()
      } catch (error) {
        if (!/already being imported/.test(error?.message ?? '') || Date.now() > until) throw error
        await sleep(200)
      }
    }
  }

  const keys = {}
  await step('stream keys', async () => {
    for (const { id } of BASELINE_ENABLED_DESTINATIONS) {
      const stored = await rpc('streamTargets.manualKey.store', {
        targetId: id,
        streamKey: BASELINE_FAKE_STREAM_KEY
      })
      if (!stored?.streamKeySecretRef) throw new Error(`no secret reference for ${id}`)
      keys[id] = stored.streamKeySecretRef
    }
  })

  await step('banners', async () => {
    for (const name of ['banner-lower-third.png', 'banner-logo.png']) {
      const sourceCapability = await authorize(fixtures[name])
      await importWhenFree(() => rpc('banners.importImage', { sourceCapability }))
    }
  })
  await step('takeovers', async () => {
    for (const name of ['takeover-be-right-back.png', 'takeover-starting-soon.png']) {
      // The import waits on the Assets page's own import control; a cold
      // window can miss its first try.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await smoke('import-takeover-image', { path: fixtures[name] })
          break
        } catch (error) {
          if (attempt >= 3) throw error
          await sleep(1500)
        }
      }
    }
  })
  await step('sounds', async () => {
    // The app seeds its twelve starter sounds on connection (plan 189); the
    // fixtures go in after, as in a real profile, so the starters keep keys
    // 1 to 9 and the fixtures come last. Racing it interleaves the order
    // and hands a fixture a starter's key.
    const until = Date.now() + 45_000
    while (!(await rpc('sounds.list', {}).catch(() => null))?.startersSeeded) {
      if (Date.now() > until) {
        log('the starter sounds were not seeded within 45 s; seeding the fixtures anyway')
        break
      }
      await sleep(500)
    }
    for (const name of ['sound-ding.wav', 'sound-low.wav']) {
      const sourceCapability = await authorize(fixtures[name])
      await importWhenFree(() => rpc('sounds.import', { sourceCapability }))
    }
  })
  await step('background', async () => {
    await smoke('import-smoke-background', { path: fixtures['background-baseline.png'] })
  })

  await step('library sessions', async () => {
    for (let take = 0; take < 2; take += 1) {
      // A capability is spent by the session that takes it.
      const outputDirectoryCapability = await authorize(recordingsDir, 'output-directory')
      const started = await rpc('session.start', {
        sources: { testPattern: true, microphoneId: 'microphone:coreaudio:4294967295' },
        layout: {
          layoutPreset: 'screen-only',
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
          sideBySideSplit: '70-30',
          sideBySideCameraSide: 'right'
        },
        output: {
          recordEnabled: true,
          streamEnabled: false,
          outputDirectoryCapability,
          video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
          rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
        }
      })
      if (!started?.sessionId) throw new Error(`session.start answered ${JSON.stringify(started)}`)
      await sleep(BASELINE_TAKE_MS)
      await rpc('session.stop')
      await sleep(1500)
    }
  })

  return { seeded, failed, keys }
}

/** The fake chat connector's rows (what `liveChat.start` takes), for the Stream Manager. */
export function baselineLiveChatStart(sessionId = 'baseline-chat') {
  return {
    sessionId,
    platforms: Object.keys(BASELINE_CHAT_TARGETS),
    destinations: Object.entries(BASELINE_CHAT_TARGETS).map(([platform, targetId]) => ({
      platform,
      targetId
    })),
    fakes: Object.entries(BASELINE_CHAT_TARGETS).map(([platform, targetId]) => ({
      platform,
      targetId,
      count: BASELINE_CHAT_ROWS,
      intervalMs: 100,
      send: platform === 'x' ? undefined : 'sent'
    }))
  }
}
