import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MOTION_STIMULUS_TITLE = 'Videorc Motion Stimulus'
const SIGNATURE_COLORS = Object.freeze([
  'cyan',
  'magenta',
  'yellow',
  'red',
  'green',
  'blue',
  'white',
  'dark'
])

export function resolveWindowsStimulusBrowser({
  env = process.env,
  exists = existsSync,
  requestedPath,
  legacyEnvironmentVariable
} = {}) {
  const candidates = []
  appendBrowserCandidate(candidates, requestedPath, 'option')
  appendBrowserCandidate(candidates, env.VIDEORC_STIMULUS_BROWSER, 'VIDEORC_STIMULUS_BROWSER')
  if (legacyEnvironmentVariable) {
    appendBrowserCandidate(candidates, env[legacyEnvironmentVariable], legacyEnvironmentVariable)
  }

  const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(nonEmptyString)
  const localAppData = nonEmptyString(env.LOCALAPPDATA) ? [env.LOCALAPPDATA] : []
  for (const root of [...programFiles, ...localAppData]) {
    appendBrowserCandidate(
      candidates,
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      `${root}:edge`
    )
  }
  for (const root of [...programFiles, ...localAppData]) {
    appendBrowserCandidate(
      candidates,
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      `${root}:chrome`
    )
  }

  const searchedPaths = []
  for (const candidate of candidates) {
    if (searchedPaths.includes(candidate.executablePath)) continue
    searchedPaths.push(candidate.executablePath)
    if (exists(candidate.executablePath)) {
      return { ...candidate, searchedPaths }
    }
  }
  return { executablePath: null, source: null, searchedPaths }
}

export function resolveScreenMotionStimulusBrowser(options = {}) {
  return resolveStimulusBrowser({
    ...options,
    legacyEnvironmentVariable: 'VIDEORC_SCREEN_MOTION_BROWSER_PATH'
  })
}

export async function launchScreenMotionStimulus(options = {}) {
  const displayOptions = stimulusWindowOptionsForSource(options.screenSource) ?? {}
  const x = Number(options.x ?? process.env.VIDEORC_SCREEN_MOTION_X ?? displayOptions.x ?? 32)
  const y = Number(options.y ?? process.env.VIDEORC_SCREEN_MOTION_Y ?? displayOptions.y ?? 32)
  const width = Number(
    options.width ?? process.env.VIDEORC_SCREEN_MOTION_WIDTH ?? displayOptions.width ?? 1360
  )
  const height = Number(
    options.height ?? process.env.VIDEORC_SCREEN_MOTION_HEIGHT ?? displayOptions.height ?? 820
  )
  const verifyVisible = Boolean(
    options.verifyVisible ?? process.env.VIDEORC_SCREEN_MOTION_VERIFY_VISIBLE === '1'
  )
  const driver =
    options.driver ??
    process.env.VIDEORC_SCREEN_MOTION_DRIVER ??
    (process.platform === 'darwin' ? 'native' : 'chromium')
  const settleMs = Number(
    options.settleMs ??
      process.env.VIDEORC_SCREEN_MOTION_SETTLE_MS ??
      (driver === 'native' ? 5000 : 1800)
  )

  if (driver === 'native' && process.platform === 'darwin') {
    return await launchNativeScreenMotionStimulus({
      x,
      y,
      width,
      height,
      settleMs,
      verifyVisible,
      outputDirectory: options.outputDirectory,
      ffmpegPath: options.ffmpegPath,
      teardownOptions: options.teardownOptions
    })
  }

  const browserResolution = resolveScreenMotionStimulusBrowser({
    requestedPath: options.browserPath,
    platform: process.platform
  })
  const browserPath = browserResolution.executablePath

  if (!browserPath) {
    throw new Error(
      `Screen motion stimulus requires a Chromium-compatible browser. ` +
        `Set VIDEORC_STIMULUS_BROWSER, or install Edge/Chrome. ` +
        `Checked: ${browserResolution.searchedPaths.join(', ') || 'no Windows browser roots were available'}.`
    )
  }

  const dir = mkdtempSync(join(tmpdir(), 'videorc-screen-motion-'))
  const htmlPath = join(dir, 'stimulus.html')
  const profileDir = join(dir, 'profile')
  writeFileSync(htmlPath, stimulusHtml(), 'utf8')

  const child = spawn(
    browserPath,
    [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-extensions',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--force-device-scale-factor=1',
      `--window-position=${x},${y}`,
      `--window-size=${width},${height}`,
      `--app=${pathToFileURL(htmlPath).href}`
    ],
    {
      detached: true,
      stdio: 'ignore'
    }
  )
  child.unref()
  const stimulus = {
    child,
    dir,
    htmlPath,
    browserPath,
    browserSource: browserResolution.source,
    driver: 'chromium',
    x,
    y,
    width,
    height,
    activation: null,
    visibility: null
  }
  try {
    await sleep(settleMs)
    if (child.exitCode !== null) {
      throw new Error(`Screen motion stimulus browser exited early with code ${child.exitCode}.`)
    }
    const visibility = verifyVisible
      ? await refreshScreenMotionStimulusVisibility(stimulus, {
          outputDirectory: options.outputDirectory ?? dir,
          ffmpegPath: options.ffmpegPath,
          settleMs: options.focusSettleMs ?? 500
        })
      : null
    if (visibility && !visibility.visible) {
      throw new Error(
        `Screen motion stimulus is not visible in the captured display (${visibility.reason}). ` +
          `Bring the Chromium stimulus window to the selected screen foreground or adjust VIDEORC_SCREEN_MOTION_* bounds.`
      )
    }
    return stimulus
  } catch (error) {
    await stopScreenMotionStimulus(stimulus, options.teardownOptions)
    throw error
  }
}

function resolveStimulusBrowser({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  requestedPath,
  legacyEnvironmentVariable
} = {}) {
  if (platform === 'win32') {
    return resolveWindowsStimulusBrowser({
      env,
      exists,
      requestedPath,
      legacyEnvironmentVariable
    })
  }
  const candidates = []
  appendBrowserCandidate(candidates, requestedPath, 'option')
  appendBrowserCandidate(candidates, env.VIDEORC_STIMULUS_BROWSER, 'VIDEORC_STIMULUS_BROWSER')
  appendBrowserCandidate(candidates, env[legacyEnvironmentVariable], legacyEnvironmentVariable)
  appendBrowserCandidate(candidates, DEFAULT_CHROME_PATH, 'macOS Chrome default')
  const searchedPaths = []
  for (const candidate of candidates) {
    if (searchedPaths.includes(candidate.executablePath)) continue
    searchedPaths.push(candidate.executablePath)
    if (exists(candidate.executablePath)) return { ...candidate, searchedPaths }
  }
  return { executablePath: null, source: null, searchedPaths }
}

function appendBrowserCandidate(candidates, executablePath, source) {
  if (!nonEmptyString(executablePath)) return
  candidates.push({ executablePath: executablePath.trim(), source })
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

async function launchNativeScreenMotionStimulus({
  x,
  y,
  width,
  height,
  settleMs,
  verifyVisible,
  outputDirectory,
  ffmpegPath,
  teardownOptions
}) {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-screen-motion-'))
  const swiftPath = join(dir, 'stimulus.swift')
  writeFileSync(swiftPath, nativeStimulusSwift(), 'utf8')

  const child = spawn('swift', [swiftPath, String(x), String(y), String(width), String(height)], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const stderr = []
  child.stderr?.on('data', (chunk) => {
    stderr.push(Buffer.from(chunk).toString('utf8'))
  })
  child.unref()
  const stimulus = {
    child,
    dir,
    htmlPath: null,
    browserPath: null,
    driver: 'native-swift',
    x,
    y,
    width,
    height,
    activation: { attempted: true, appName: MOTION_STIMULUS_TITLE, success: true },
    visibility: null,
    stderr
  }
  try {
    await sleep(settleMs)
    if (child.exitCode !== null) {
      throw new Error(
        `Native screen motion stimulus exited early with code ${child.exitCode}${formatNativeStimulusStderr(stderr)}.`
      )
    }
    const visibility = verifyVisible
      ? verifyScreenMotionStimulusVisible({
          x,
          y,
          width,
          height,
          outputDirectory: outputDirectory ?? dir,
          ffmpegPath
        })
      : null
    stimulus.visibility = visibility
    if (visibility && !visibility.visible) {
      throw new Error(
        `Screen motion stimulus is not visible in the captured display (${visibility.reason}). ` +
          `Move the native stimulus window to the selected screen foreground or adjust VIDEORC_SCREEN_MOTION_* bounds.`
      )
    }
    return stimulus
  } catch (error) {
    await stopScreenMotionStimulus(stimulus, teardownOptions)
    throw error
  }
}

function formatNativeStimulusStderr(stderr) {
  const text = stderr.join('').trim()
  return text ? `: ${text.slice(0, 2000)}` : ''
}

export function screenMotionStimulusOptionsForSource(source) {
  return stimulusWindowOptionsForSource(source)
}

export function stimulusWindowOptionsForSource(source) {
  const displayId = parseScreencaptureKitDisplayId(source?.id)
  if (!displayId || process.platform !== 'darwin') return null
  const bounds = queryMacDisplayBounds(displayId)
  return bounds ? stimulusWindowOptionsFromDisplayBounds(bounds) : null
}

export function stimulusWindowOptionsFromDisplayBounds(bounds, margin = 16) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null
  return {
    x: Math.round((bounds.x ?? 0) + margin),
    y: Math.round((bounds.y ?? 0) + margin),
    width: Math.max(640, Math.round(bounds.width - margin * 2)),
    height: Math.max(480, Math.round(bounds.height - margin * 2))
  }
}

function parseScreencaptureKitDisplayId(id) {
  const match = String(id ?? '').match(/^screen:screencapturekit:(\d+)$/)
  return match ? Number(match[1]) : null
}

function queryMacDisplayBounds(displayId) {
  const result = spawnSync(
    'swift',
    [
      '-e',
      `import CoreGraphics
let id = CGDirectDisplayID(${displayId})
let bounds = CGDisplayBounds(id)
print("\\(bounds.origin.x),\\(bounds.origin.y),\\(bounds.width),\\(bounds.height)")`
    ],
    { encoding: 'utf8', timeout: 5000 }
  )
  if (result.status !== 0) return null
  const values = result.stdout
    .trim()
    .split(',')
    .map((value) => Number(value))
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null
  const [x, y, width, height] = values
  return { x, y, width, height }
}

export function macApplicationNameFromPath(browserPath) {
  const match = String(browserPath ?? '').match(/\/([^/]+)\.app\//)
  return match ? match[1] : null
}

export function stimulusVisibilityFromRgb(rgb, options = {}) {
  const totalPixels = Math.floor((rgb?.length ?? 0) / 3)
  const minimumColorRatio = Number(options.minimumColorRatio ?? 0.0007)
  const minimumColorPixels = Math.max(
    Number(options.minimumColorPixels ?? 8),
    Math.ceil(totalPixels * minimumColorRatio)
  )
  const requiredColors = options.requiredColors ?? ['cyan', 'magenta', 'yellow', 'white', 'dark']
  const minimumDistinctColors = Number(options.minimumDistinctColors ?? 7)
  const counts = Object.fromEntries(SIGNATURE_COLORS.map((color) => [color, 0]))

  for (let offset = 0; offset + 2 < (rgb?.length ?? 0); offset += 3) {
    const red = rgb[offset]
    const green = rgb[offset + 1]
    const blue = rgb[offset + 2]
    if (red < 32 && green < 32 && blue < 32) counts.dark += 1
    if (red > 232 && green > 232 && blue > 232) counts.white += 1
    if (red > 220 && green < 90 && blue < 90) counts.red += 1
    if (red < 100 && green > 210 && blue < 170) counts.green += 1
    if (red < 100 && green > 70 && green < 180 && blue > 210) counts.blue += 1
    if (red < 100 && green > 185 && blue > 210) counts.cyan += 1
    if (red > 210 && green < 110 && blue > 175) counts.magenta += 1
    if (red > 210 && green > 190 && blue < 130) counts.yellow += 1
  }

  const missingColors = SIGNATURE_COLORS.filter((color) => counts[color] < minimumColorPixels)
  const passingColors = SIGNATURE_COLORS.filter((color) => counts[color] >= minimumColorPixels)
  const missingRequiredColors = requiredColors.filter((color) => counts[color] < minimumColorPixels)
  const colorRatios = Object.fromEntries(
    SIGNATURE_COLORS.map((color) => [color, totalPixels > 0 ? counts[color] / totalPixels : 0])
  )
  const visible =
    totalPixels > 0 &&
    missingRequiredColors.length === 0 &&
    passingColors.length >= minimumDistinctColors
  return {
    visible,
    reason:
      totalPixels <= 0
        ? 'no pixels decoded from visibility screenshot'
        : missingRequiredColors.length
          ? `missing required stimulus color signature: ${missingRequiredColors.join(', ')}`
          : passingColors.length < minimumDistinctColors
            ? `only ${passingColors.length}/${minimumDistinctColors} stimulus signature colors present`
            : 'stimulus color signature present',
    totalPixels,
    minimumColorPixels,
    minimumDistinctColors,
    counts,
    colorRatios,
    passingColors,
    missingColors,
    missingRequiredColors
  }
}

export function stimulusTemporalVisibilityFromRgb(rgb, options = {}) {
  const aggregateVisibility = stimulusVisibilityFromRgb(rgb, options)
  const width = Number(options.width)
  const height = Number(options.height)
  const minimumVisibleFrameRatio = Number(options.minimumVisibleFrameRatio ?? 0.95)
  // The capture-protection proof is intentionally strict: a static screenshot
  // repeated for an entire stream must not qualify as a live capture. A
  // transition counts only when at least one pixel (or 0.1% at larger sizes)
  // changes by a meaningful channel delta, and at least 95% of adjacent frame
  // pairs must contain that motion.
  const minimumChangedFrameRatio = Number(options.minimumChangedFrameRatio ?? 0.95)
  const minimumChangedPixelRatio = Number(options.minimumChangedPixelRatio ?? 0.001)
  const minimumChangedChannelDelta = Number(options.minimumChangedChannelDelta ?? 12)
  const expectedFrames =
    options.expectedFrames === undefined ? null : Number(options.expectedFrames)
  const byteLength = Number.isSafeInteger(rgb?.length) ? rgb.length : 0
  const configurationFailures = []

  if (!Number.isSafeInteger(width) || width <= 0) {
    configurationFailures.push('width must be a positive integer')
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    configurationFailures.push('height must be a positive integer')
  }
  if (
    !Number.isFinite(minimumVisibleFrameRatio) ||
    minimumVisibleFrameRatio < 0.95 ||
    minimumVisibleFrameRatio > 1
  ) {
    configurationFailures.push('minimumVisibleFrameRatio must be between 0.95 and 1')
  }
  if (
    !Number.isFinite(minimumChangedFrameRatio) ||
    minimumChangedFrameRatio < 0.95 ||
    minimumChangedFrameRatio > 1
  ) {
    configurationFailures.push('minimumChangedFrameRatio must be between 0.95 and 1')
  }
  if (
    !Number.isFinite(minimumChangedPixelRatio) ||
    minimumChangedPixelRatio <= 0 ||
    minimumChangedPixelRatio > 1
  ) {
    configurationFailures.push('minimumChangedPixelRatio must be greater than 0 and at most 1')
  }
  if (
    !Number.isSafeInteger(minimumChangedChannelDelta) ||
    minimumChangedChannelDelta <= 0 ||
    minimumChangedChannelDelta > 255
  ) {
    configurationFailures.push(
      'minimumChangedChannelDelta must be a positive integer no greater than 255'
    )
  }
  if (expectedFrames !== null && (!Number.isSafeInteger(expectedFrames) || expectedFrames <= 0)) {
    configurationFailures.push('expectedFrames must be a positive integer when provided')
  }
  if (!rgb || typeof rgb.subarray !== 'function' || !Number.isSafeInteger(rgb.length)) {
    configurationFailures.push('rgb must be a byte array')
  }

  const frameBytes =
    configurationFailures.length === 0 && Number.isSafeInteger(width * height * 3)
      ? width * height * 3
      : null
  if (configurationFailures.length === 0 && (!frameBytes || frameBytes <= 0)) {
    configurationFailures.push('fixed RGB frame size is invalid')
  }

  const completeFrames = frameBytes ? Math.floor(byteLength / frameBytes) : 0
  const trailingBytes = frameBytes ? byteLength % frameBytes : byteLength
  const frameCountMatches =
    expectedFrames === null ? completeFrames > 0 : completeFrames === expectedFrames
  let visibleFrames = 0
  const invisibleFrameIndices = []
  let changedFramePairs = 0
  const staticTransitionIndices = []
  const changedPixelsPerTransition = []
  const minimumChangedPixels =
    Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
      ? Math.max(1, Math.ceil(width * height * minimumChangedPixelRatio))
      : null

  if (frameBytes) {
    for (let index = 0; index < completeFrames; index += 1) {
      const offset = index * frameBytes
      const frame = rgb.subarray(offset, offset + frameBytes)
      const frameVisibility = stimulusVisibilityFromRgb(frame, options)
      if (frameVisibility.visible) {
        visibleFrames += 1
      } else {
        invisibleFrameIndices.push(index)
      }
      if (index > 0 && minimumChangedPixels !== null) {
        const previousFrame = rgb.subarray(offset - frameBytes, offset)
        const changedPixels = countMeaningfullyChangedPixels(
          previousFrame,
          frame,
          minimumChangedChannelDelta
        )
        changedPixelsPerTransition.push(changedPixels)
        if (changedPixels >= minimumChangedPixels) {
          changedFramePairs += 1
        } else {
          staticTransitionIndices.push(index)
        }
      }
    }
  }

  const visibleFrameRatio = completeFrames > 0 ? visibleFrames / completeFrames : 0
  const requiredVisibleFrames =
    completeFrames > 0 && Number.isFinite(minimumVisibleFrameRatio)
      ? Math.ceil(completeFrames * minimumVisibleFrameRatio)
      : null
  const frameTransitions = Math.max(0, completeFrames - 1)
  const changedFrameRatio = frameTransitions > 0 ? changedFramePairs / frameTransitions : 0
  const requiredChangedFramePairs =
    frameTransitions > 0 && Number.isFinite(minimumChangedFrameRatio)
      ? Math.ceil(frameTransitions * minimumChangedFrameRatio)
      : null
  const structuralFailures = [...configurationFailures]
  if (configurationFailures.length === 0 && completeFrames === 0) {
    structuralFailures.push('no complete RGB frames decoded')
  }
  if (configurationFailures.length === 0 && trailingBytes !== 0) {
    structuralFailures.push(
      `${trailingBytes} trailing RGB bytes do not form a complete ${frameBytes}-byte frame`
    )
  }
  if (
    configurationFailures.length === 0 &&
    expectedFrames !== null &&
    completeFrames !== expectedFrames
  ) {
    structuralFailures.push(`decoded ${completeFrames} frames, expected ${expectedFrames}`)
  }
  if (configurationFailures.length === 0 && completeFrames < 2) {
    structuralFailures.push('at least 2 complete RGB frames are required to prove temporal motion')
  }

  const visible =
    structuralFailures.length === 0 &&
    frameCountMatches &&
    aggregateVisibility.visible &&
    requiredVisibleFrames !== null &&
    visibleFrames >= requiredVisibleFrames &&
    requiredChangedFramePairs !== null &&
    changedFramePairs >= requiredChangedFramePairs
  const reason = structuralFailures.length
    ? structuralFailures.join('; ')
    : !aggregateVisibility.visible
      ? `aggregate stimulus signature missing (${aggregateVisibility.reason})`
      : visibleFrames < requiredVisibleFrames
        ? `stimulus visible in ${visibleFrames}/${completeFrames} frames (${(
            visibleFrameRatio * 100
          ).toFixed(2)}%); requires at least ${(minimumVisibleFrameRatio * 100).toFixed(2)}%`
        : changedFramePairs < requiredChangedFramePairs
          ? `stimulus changed in ${changedFramePairs}/${frameTransitions} adjacent frame pairs (${(
              changedFrameRatio * 100
            ).toFixed(2)}%); requires at least ${(minimumChangedFrameRatio * 100).toFixed(2)}%`
          : `stimulus signature present in ${visibleFrames}/${completeFrames} frames`

  return {
    visible,
    reason,
    width: Number.isSafeInteger(width) && width > 0 ? width : null,
    height: Number.isSafeInteger(height) && height > 0 ? height : null,
    frameBytes,
    expectedFrames,
    completeFrames,
    trailingBytes,
    minimumVisibleFrameRatio,
    requiredVisibleFrames,
    visibleFrames,
    invisibleFrames: completeFrames - visibleFrames,
    visibleFrameRatio,
    invisibleFrameIndices,
    frameTransitions,
    minimumChangedFrameRatio,
    minimumChangedPixelRatio,
    minimumChangedChannelDelta,
    minimumChangedPixels,
    requiredChangedFramePairs,
    changedFramePairs,
    changedFrameRatio,
    staticTransitionIndices,
    changedPixelsPerTransition,
    frameCountMatches,
    structuralFailures,
    aggregateVisibility
  }
}

function countMeaningfullyChangedPixels(previousFrame, frame, minimumChannelDelta) {
  let changedPixels = 0
  for (let offset = 0; offset + 2 < frame.length; offset += 3) {
    const changed =
      Math.abs(frame[offset] - previousFrame[offset]) >= minimumChannelDelta ||
      Math.abs(frame[offset + 1] - previousFrame[offset + 1]) >= minimumChannelDelta ||
      Math.abs(frame[offset + 2] - previousFrame[offset + 2]) >= minimumChannelDelta
    if (changed) changedPixels += 1
  }
  return changedPixels
}

export async function refreshScreenMotionStimulusVisibility(stimulus, options = {}) {
  if (!stimulus) return null
  const activation = focusScreenMotionStimulus(stimulus)
  const settleMs = Number(
    options.settleMs ?? process.env.VIDEORC_SCREEN_MOTION_REFOCUS_SETTLE_MS ?? 750
  )
  if (settleMs > 0) await sleep(settleMs)
  const visibility = verifyScreenMotionStimulusVisible({
    x: stimulus.x,
    y: stimulus.y,
    width: stimulus.width,
    height: stimulus.height,
    outputDirectory: options.outputDirectory ?? stimulus.dir,
    ffmpegPath: options.ffmpegPath
  })
  stimulus.activation = activation
  stimulus.visibility = visibility
  return visibility
}

export function focusScreenMotionStimulus(stimulus) {
  if (!stimulus) return { attempted: false, appName: null, success: false }
  if (stimulus.driver === 'native-swift') {
    return { attempted: false, appName: MOTION_STIMULUS_TITLE, success: true }
  }
  const activation = activateMacBrowserApp(stimulus.browserPath, MOTION_STIMULUS_TITLE)
  stimulus.activation = activation
  return activation
}

function verifyScreenMotionStimulusVisible({ x, y, width, height, outputDirectory, ffmpegPath }) {
  const dir = outputDirectory ?? mkdtempSync(join(tmpdir(), 'videorc-screen-motion-visibility-'))
  mkdirSync(dir, { recursive: true })
  const screenshotPath = join(dir, 'screen-motion-stimulus-visibility.png')
  const capture = spawnSync(
    'screencapture',
    [
      '-x',
      '-R',
      `${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`,
      screenshotPath
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )
  if (capture.status !== 0 || !existsSync(screenshotPath)) {
    // macOS 26.5 broke `screencapture -R` ("could not create image from rect")
    // while full captures still work: grab the whole main display and crop the
    // stimulus rect out with ffmpeg (point→pixel scaling via iw/ih ratios).
    const fallback = captureStimulusRectViaFullDisplay({
      x,
      y,
      width,
      height,
      dir,
      screenshotPath,
      ffmpegPath
    })
    if (!fallback.ok) {
      return {
        visible: false,
        reason:
          `screencapture failed${capture.stderr ? `: ${capture.stderr.trim()}` : ''}` +
          `; full-display fallback failed: ${fallback.reason}`,
        screenshotPath
      }
    }
  }

  const analysis = decodeVisibilityScreenshot(screenshotPath, ffmpegPath)
  return {
    ...analysis,
    screenshotPath,
    captureRegion: {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    }
  }
}

function captureStimulusRectViaFullDisplay({
  x,
  y,
  width,
  height,
  dir,
  screenshotPath,
  ffmpegPath
}) {
  const fullPath = join(dir, 'screen-motion-stimulus-full-display.png')
  const fullCapture = spawnSync('screencapture', ['-x', '-m', fullPath], {
    encoding: 'utf8',
    timeout: 10_000
  })
  if (fullCapture.status !== 0 || !existsSync(fullPath)) {
    return {
      ok: false,
      reason: `full screencapture failed${fullCapture.stderr ? `: ${fullCapture.stderr.trim()}` : ''}`
    }
  }
  const displayBounds = queryMacMainDisplayBounds()
  if (!displayBounds || !displayBounds.width || !displayBounds.height) {
    return { ok: false, reason: 'could not resolve main display bounds' }
  }
  const relX = Math.max(0, Math.round(x) - Math.round(displayBounds.x))
  const relY = Math.max(0, Math.round(y) - Math.round(displayBounds.y))
  const crop =
    `crop=iw*${Math.round(width)}/${Math.round(displayBounds.width)}` +
    `:ih*${Math.round(height)}/${Math.round(displayBounds.height)}` +
    `:iw*${relX}/${Math.round(displayBounds.width)}` +
    `:ih*${relY}/${Math.round(displayBounds.height)}`
  const ffmpeg = ffmpegPath ?? process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
  const cropResult = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      fullPath,
      '-vf',
      crop,
      '-frames:v',
      '1',
      screenshotPath
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )
  if (cropResult.status !== 0 || !existsSync(screenshotPath)) {
    return {
      ok: false,
      reason: `ffmpeg crop failed${cropResult.stderr ? `: ${cropResult.stderr.trim()}` : ''}`
    }
  }
  return { ok: true }
}

function queryMacMainDisplayBounds() {
  const result = spawnSync(
    'swift',
    [
      '-e',
      `import CoreGraphics
let bounds = CGDisplayBounds(CGMainDisplayID())
print("\\(bounds.origin.x),\\(bounds.origin.y),\\(bounds.width),\\(bounds.height)")`
    ],
    { encoding: 'utf8', timeout: 15_000 }
  )
  if (result.status !== 0) return null
  const values = result.stdout
    .trim()
    .split(',')
    .map((value) => Number(value))
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null
  const [x, y, width, height] = values
  return { x, y, width, height }
}

function decodeVisibilityScreenshot(screenshotPath, ffmpegPath) {
  const ffmpeg = ffmpegPath ?? process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
  const result = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      screenshotPath,
      '-vf',
      'scale=160:-1:flags=area,format=rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: 10_000 }
  )
  if (result.status !== 0) {
    return {
      visible: false,
      reason: `ffmpeg could not decode visibility screenshot${result.stderr ? `: ${result.stderr.toString().trim()}` : ''}`
    }
  }
  return stimulusVisibilityFromRgb(result.stdout)
}

function activateMacBrowserApp(browserPath, windowTitle = null) {
  if (process.platform !== 'darwin') return { attempted: false, appName: null, success: false }
  const appName = macApplicationNameFromPath(browserPath)
  if (!appName) return { attempted: false, appName: null, success: false }
  const script = windowTitle
    ? `tell application ${JSON.stringify(appName)}
activate
repeat with candidateWindow in windows
  if name of candidateWindow contains ${JSON.stringify(windowTitle)} then
    set index of candidateWindow to 1
    exit repeat
  end if
end repeat
end tell`
    : `tell application ${JSON.stringify(appName)} to activate`
  const result = spawnSync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: 5000
  })
  return {
    attempted: true,
    appName,
    success: result.status === 0,
    stderr: result.stderr?.trim() ?? ''
  }
}

function nativeStimulusSwift() {
  return `import Cocoa

let title = "Videorc Motion Stimulus"

final class StimulusView: NSView {
  var frameNumber: Int = 0
  var timer: Timer?

  override var isFlipped: Bool { true }

  func start() {
    timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
      guard let self = self else { return }
      self.frameNumber += 1
      self.needsDisplay = true
    }
    RunLoop.main.add(timer!, forMode: .common)
  }

  override func draw(_ dirtyRect: NSRect) {
    let rect = bounds
    NSColor(calibratedWhite: 0.02, alpha: 1).setFill()
    NSBezierPath(rect: rect).fill()

    drawBackgroundStripes(rect)
    drawMovingBars(rect)
    drawTicker(rect)
    drawCounter(rect)
    drawCursor(rect)
    drawColorPatches(rect)
  }

  private func drawBackgroundStripes(_ rect: NSRect) {
    NSColor.white.withAlphaComponent(0.75).setFill()
    NSBezierPath(rect: NSRect(x: rect.width * 0.11, y: 0, width: max(8, rect.width * 0.012), height: rect.height)).fill()
    NSColor(calibratedRed: 0, green: 0.84, blue: 1, alpha: 0.86).setFill()
    NSBezierPath(rect: NSRect(x: rect.width * 0.23, y: 0, width: max(8, rect.width * 0.014), height: rect.height)).fill()
    NSColor.white.withAlphaComponent(0.18).setStroke()
    for y in stride(from: 0.0, through: Double(rect.height), by: 36.0) {
      let path = NSBezierPath()
      path.move(to: NSPoint(x: 0, y: y))
      path.line(to: NSPoint(x: rect.width, y: y))
      path.lineWidth = 2
      path.stroke()
    }
  }

  private func drawMovingBars(_ rect: NSRect) {
    let colors: [NSColor] = [
      NSColor(calibratedRed: 0.0, green: 0.90, blue: 1.0, alpha: 0.88),
      NSColor(calibratedRed: 1.0, green: 0.17, blue: 0.84, alpha: 0.88),
      NSColor(calibratedRed: 1.0, green: 0.91, blue: 0.29, alpha: 0.88),
      NSColor.white.withAlphaComponent(0.72),
    ]
    let barWidth = max(72, rect.width * 0.1)
    for (index, color) in colors.enumerated() {
      let travel = rect.width + barWidth * 2
      let speed = CGFloat(5 + index * 3)
      let phase = CGFloat((frameNumber * Int(speed) + index * 260) % max(1, Int(travel)))
      color.setFill()
      NSBezierPath(rect: NSRect(x: phase - barWidth, y: 0, width: barWidth, height: rect.height)).fill()
    }
  }

  private func drawTicker(_ rect: NSRect) {
    let text = "VIDEORC REAL-SCREEN MOTION STIMULUS - scrolling text, moving bars, cursor loop, color patches - OBS parity motion gate - "
    let fontSize = max(28, rect.height * 0.05)
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular),
      .foregroundColor: NSColor.black,
      .backgroundColor: NSColor.white,
    ]
    let y = rect.height * 0.86
    let x = -CGFloat((frameNumber * 9) % max(1, Int(rect.width)))
    text.draw(at: NSPoint(x: x, y: y), withAttributes: attrs)
    text.draw(at: NSPoint(x: x + rect.width, y: y), withAttributes: attrs)
  }

  private func drawCounter(_ rect: NSRect) {
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.monospacedSystemFont(ofSize: max(42, rect.height * 0.085), weight: .heavy),
      .foregroundColor: NSColor.white,
      .strokeColor: NSColor.black,
      .strokeWidth: -4,
    ]
    String(format: "frame %06d", frameNumber).draw(at: NSPoint(x: rect.width * 0.04, y: rect.height * 0.06), withAttributes: attrs)
  }

  private func drawCursor(_ rect: NSRect) {
    let radius = max(28, rect.height * 0.04)
    let x = (sin(Double(frameNumber) / 22.0) * 0.42 + 0.5) * Double(max(1, rect.width - radius * 2))
    let y = (cos(Double(frameNumber) / 27.0) * 0.38 + 0.5) * Double(max(1, rect.height - radius * 2))
    let circle = NSRect(x: CGFloat(x), y: CGFloat(y), width: radius * 2, height: radius * 2)
    NSColor(calibratedRed: 0.0, green: 1.0, blue: 0.42, alpha: 1).setStroke()
    let outer = NSBezierPath(ovalIn: circle)
    outer.lineWidth = max(8, radius * 0.22)
    outer.stroke()
    NSColor.white.setStroke()
    let inner = NSBezierPath(ovalIn: circle.insetBy(dx: radius * 0.22, dy: radius * 0.22))
    inner.lineWidth = max(6, radius * 0.18)
    inner.stroke()
  }

  private func drawColorPatches(_ rect: NSRect) {
    let colors: [NSColor] = [
      .white,
      .black,
      NSColor(calibratedRed: 1.0, green: 0.17, blue: 0.17, alpha: 1),
      NSColor(calibratedRed: 0.19, green: 1.0, blue: 0.45, alpha: 1),
      NSColor(calibratedRed: 0.11, green: 0.43, blue: 1.0, alpha: 1),
      NSColor(calibratedRed: 1.0, green: 0.91, blue: 0.29, alpha: 1),
      NSColor(calibratedRed: 1.0, green: 0.17, blue: 0.84, alpha: 1),
      NSColor(calibratedRed: 0.0, green: 0.90, blue: 1.0, alpha: 1),
    ]
    let size = max(54, rect.width * 0.07)
    let gap = max(6, rect.width * 0.008)
    let startX = rect.width - (size * 4 + gap * 3) - rect.width * 0.03
    let startY = rect.height * 0.05
    for index in 0..<colors.count {
      let column = index % 4
      let row = index / 4
      colors[index].setFill()
      let patch = NSRect(
        x: startX + CGFloat(column) * (size + gap),
        y: startY + CGFloat(row) * (size + gap),
        width: size,
        height: size
      )
      NSBezierPath(rect: patch).fill()
      NSColor.black.setStroke()
      let border = NSBezierPath(rect: patch)
      border.lineWidth = max(3, rect.width * 0.003)
      border.stroke()
    }
  }
}

let args = CommandLine.arguments
let x = Double(args.count > 1 ? args[1] : "32") ?? 32
let y = Double(args.count > 2 ? args[2] : "32") ?? 32
let width = Double(args.count > 3 ? args[3] : "1360") ?? 1360
let height = Double(args.count > 4 ? args[4] : "820") ?? 820
let xValue = CGFloat(x)
let yValue = CGFloat(y)
let heightValue = CGFloat(height)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let window = NSPanel(
  contentRect: NSRect(x: 0, y: 0, width: width, height: height),
  styleMask: [.borderless, .nonactivatingPanel],
  backing: .buffered,
  defer: false
)
let view = StimulusView(frame: NSRect(x: 0, y: 0, width: width, height: height))
window.title = title
window.contentView = view
window.isFloatingPanel = true
window.hidesOnDeactivate = false
window.level = .screenSaver
window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
let targetScreen = NSScreen.screens.first { screen in
  let convertedTopY = screen.frame.maxY - yValue
  return xValue >= screen.frame.minX && xValue <= screen.frame.maxX && convertedTopY >= screen.frame.minY && convertedTopY <= screen.frame.maxY
} ?? NSScreen.main
let appKitTopY = (targetScreen?.frame.maxY ?? heightValue) - yValue
window.setFrameTopLeftPoint(NSPoint(x: xValue, y: appKitTopY))
window.orderFrontRegardless()
view.start()
app.run()
`
}

export async function stopScreenMotionStimulus(stimulus, options = {}) {
  return await stopStimulusBrowserTree(stimulus, options)
}

/**
 * Stop an exact stimulus browser tree and return auditable teardown proof.
 *
 * Windows first uses `taskkill /PID <pid> /T` so the browser receives a
 * graceful tree close. `/F` is reserved for bounded recovery when that tree is
 * still live. POSIX retains process-group SIGTERM -> SIGKILL escalation.
 */
export async function stopStimulusBrowserTree(stimulus, options = {}) {
  const platform = options.platform ?? process.platform
  const pid = Number(stimulus?.child?.pid)
  const gracefulWaitMs = finiteNonNegative(options.gracefulWaitMs, 800)
  const forceWaitMs = finiteNonNegative(options.forceWaitMs, 800)
  const isTreeAlive = options.isTreeAlive ?? processTreeIsAlive
  const waitForTreeExit = options.waitForTreeExit ?? waitForStimulusTreeExit
  const taskkill = options.taskkill ?? runWindowsTaskkill
  const signalTree = options.signalTree ?? signal
  const removeDirectory =
    options.removeDirectory ??
    ((directory) => {
      rmSync(directory, { recursive: true, force: true })
    })
  const result = {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    platform,
    state: 'skipped',
    forced: false,
    treeExited: true,
    livenessScope: platform === 'win32' ? 'root-pid-after-taskkill-tree' : 'posix-process-group',
    graceful: {
      attempted: false,
      method: platform === 'win32' ? 'taskkill-tree' : 'sigterm-process-group',
      succeeded: null,
      error: null
    },
    recovery: {
      attempted: false,
      method: platform === 'win32' ? 'taskkill-tree-force' : 'sigkill-process-group',
      succeeded: null,
      error: null
    },
    directoryRemoved: false
  }

  try {
    if (!result.pid || !isTreeAlive(result.pid, stimulus?.child, platform)) {
      return result
    }

    result.treeExited = false
    result.graceful.attempted = true
    if (platform === 'win32') {
      Object.assign(result.graceful, await attemptTaskkill(taskkill, result.pid, false))
    } else {
      Object.assign(result.graceful, await attemptSignal(signalTree, result.pid, 'SIGTERM'))
    }
    result.treeExited = await waitForTreeExit({
      pid: result.pid,
      child: stimulus?.child,
      platform,
      timeoutMs: gracefulWaitMs,
      isTreeAlive
    })
    if (result.treeExited) {
      result.state = 'terminated'
      return result
    }

    result.forced = true
    result.recovery.attempted = true
    if (platform === 'win32') {
      Object.assign(result.recovery, await attemptTaskkill(taskkill, result.pid, true))
    } else {
      Object.assign(result.recovery, await attemptSignal(signalTree, result.pid, 'SIGKILL'))
    }
    result.treeExited = await waitForTreeExit({
      pid: result.pid,
      child: stimulus?.child,
      platform,
      timeoutMs: forceWaitMs,
      isTreeAlive
    })
    result.state = result.treeExited
      ? platform === 'win32'
        ? 'force-terminated'
        : 'killed'
      : 'leaked'
    return result
  } finally {
    if (stimulus?.dir) {
      removeDirectory(stimulus.dir)
      result.directoryRemoved = true
    }
  }
}

async function attemptTaskkill(taskkill, pid, force) {
  try {
    const outcome = await taskkill(pid, { force })
    return {
      succeeded: outcome?.succeeded !== false,
      error: outcome?.error ?? null
    }
  } catch (error) {
    return { succeeded: false, error: error?.message ?? String(error) }
  }
}

async function attemptSignal(signalTree, pid, requestedSignal) {
  try {
    const outcome = await signalTree(pid, requestedSignal)
    return {
      succeeded: outcome !== false && outcome?.succeeded !== false,
      error: outcome?.error ?? null
    }
  } catch (error) {
    return { succeeded: false, error: error?.message ?? String(error) }
  }
}

function runWindowsTaskkill(pid, { force }) {
  const args = windowsStimulusTaskkillArgs(pid, { force })
  const outcome = spawnSync('taskkill', args, {
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: true
  })
  return {
    succeeded: outcome.status === 0 && !outcome.error,
    error:
      outcome.error?.message ??
      (outcome.status === 0 ? null : `taskkill exited with status ${outcome.status ?? 'unknown'}`)
  }
}

export function windowsStimulusTaskkillArgs(pid, { force = false } = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    throw new Error('Stimulus taskkill PID must be a positive integer.')
  }
  return ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
}

function signal(pid, sig) {
  try {
    process.kill(-pid, sig)
    return true
  } catch {
    try {
      process.kill(pid, sig)
      return true
    } catch {
      // Already gone.
      return false
    }
  }
}

function processTreeIsAlive(pid, _child, platform) {
  const target = platform === 'win32' ? pid : -pid
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForStimulusTreeExit({
  pid,
  child,
  platform,
  timeoutMs,
  isTreeAlive,
  sleepFn = sleep
}) {
  const startedAt = Date.now()
  while (isTreeAlive(pid, child, platform)) {
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) return false
    await sleepFn(Math.min(50, remainingMs))
  }
  return true
}

function finiteNonNegative(value, fallback) {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stimulusHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Videorc Motion Stimulus</title>
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #050505;
      color: white;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #stage {
      position: fixed;
      inset: 0;
      background:
        linear-gradient(90deg, #050505 0 11%, #ffffff 11% 12%, #050505 12% 23%, #00d5ff 23% 24%, #050505 24% 100%),
        repeating-linear-gradient(0deg, transparent 0 34px, rgba(255,255,255,0.18) 34px 36px);
    }
    .bar {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 10vw;
      mix-blend-mode: screen;
      opacity: 0.86;
      will-change: transform;
    }
    #cyan { background: #00e5ff; }
    #magenta { background: #ff2bd6; }
    #yellow { background: #ffe84a; }
    #white { background: white; opacity: 0.72; }
    #ticker {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 5vh;
      font-size: 4.2vh;
      white-space: nowrap;
      color: #050505;
      background: #f8f8f8;
      padding: 0.35em 0;
      will-change: transform;
    }
    #counter {
      position: absolute;
      left: 4vw;
      top: 5vh;
      font-size: 8vh;
      font-weight: 800;
      color: #ffffff;
      text-shadow: 0 0 8px #000, 0 0 2px #000;
    }
    #cursor {
      position: absolute;
      width: 8vh;
      height: 8vh;
      border: 1.2vh solid #fff;
      border-radius: 50%;
      box-shadow: 0 0 0 0.8vh #111, 0 0 0 1.4vh #00ff6a;
      will-change: transform;
    }
    #patches {
      position: absolute;
      right: 3vw;
      top: 4vh;
      display: grid;
      grid-template-columns: repeat(4, 7vw);
      grid-auto-rows: 7vw;
      gap: 0.6vw;
    }
    #patches div { border: 0.25vw solid #111; }
  </style>
</head>
<body>
  <div id="stage"></div>
  <div id="cyan" class="bar"></div>
  <div id="magenta" class="bar"></div>
  <div id="yellow" class="bar"></div>
  <div id="white" class="bar"></div>
  <div id="counter">frame 000000</div>
  <div id="cursor"></div>
  <div id="ticker">VIDEORC REAL-SCREEN MOTION STIMULUS - scrolling text, moving bars, cursor loop, color patches - OBS parity motion gate - </div>
  <div id="patches">
    <div style="background:#fff"></div><div style="background:#000"></div><div style="background:#ff2b2b"></div><div style="background:#31ff74"></div>
    <div style="background:#1d6fff"></div><div style="background:#ffe84a"></div><div style="background:#ff2bd6"></div><div style="background:#00e5ff"></div>
  </div>
  <script>
    const bars = [
      document.getElementById('cyan'),
      document.getElementById('magenta'),
      document.getElementById('yellow'),
      document.getElementById('white'),
    ];
    const counter = document.getElementById('counter');
    const cursor = document.getElementById('cursor');
    const ticker = document.getElementById('ticker');
    let frame = 0;
    function tick(now) {
      frame += 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      bars.forEach((bar, index) => {
        const phase = (now * (0.05 + index * 0.012) + index * 260) % (w + 240);
        bar.style.transform = 'translateX(' + (phase - 140) + 'px)';
      });
      const x = (Math.sin(now / 730) * 0.42 + 0.5) * (w - 120);
      const y = (Math.cos(now / 910) * 0.38 + 0.5) * (h - 120);
      cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      ticker.style.transform = 'translateX(' + (-((now / 9) % Math.max(1, w))) + 'px)';
      counter.textContent = 'frame ' + String(frame).padStart(6, '0');
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  </script>
</body>
</html>`
}
