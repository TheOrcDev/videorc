// A Windows D3D11 preview gate needs a live D3D11 media generation before the
// backend presenter has anything to present. The renderer's default camera
// scene never starts one on a box without a camera, so D3D11-mode smokes and
// probes point the renderer at one real DXGI screen through the smoke-only
// `windows-d3d11-preview-harness` command.

import { connectBackend, request } from '../smoke-recording-session.mjs'
import { nativeWindowsScreenCandidates } from './windows-native-screen-gates.mjs'

export const WINDOWS_D3D11_PREVIEW_HARNESS_COMMAND = 'windows-d3d11-preview-harness'

/** The renderer selected `screenId` as its only source in ScreenOnly. */
export function windowsD3d11HarnessStateFailures(state, screenId) {
  const failures = []
  const sources = state?.sources
  if (sources?.screenId !== screenId) failures.push(`screenId=${sources?.screenId ?? 'missing'}`)
  if (sources?.cameraId !== undefined) failures.push(`cameraId=${sources.cameraId}`)
  if (sources?.cameraOff !== true) failures.push('camera is not off')
  if (sources?.microphoneId !== undefined) failures.push(`microphoneId=${sources.microphoneId}`)
  if (sources?.testPattern !== false) failures.push('test pattern is selected')
  if (state?.layout?.layoutPreset !== 'screen-only') {
    failures.push(`layout=${state?.layout?.layoutPreset ?? 'missing'}`)
  }
  return failures
}

/** Desktop Duplication only: the gdigrab fallback never feeds D3D11 media. */
export function windowsD3d11ProbeScreenId(devices) {
  return (
    nativeWindowsScreenCandidates(devices).find((candidate) =>
      candidate.id.startsWith('screen:dxgi:')
    )?.id ?? null
  )
}

export async function configureWindowsD3d11RendererSources(smokeCommand, screenId) {
  const state = await smokeCommand(WINDOWS_D3D11_PREVIEW_HARNESS_COMMAND, {
    action: 'configure',
    screenId
  })
  const failures = windowsD3d11HarnessStateFailures(state, screenId)
  if (failures.length > 0) {
    throw new Error(
      `Renderer did not select screen ${screenId} as its only ScreenOnly source (${failures.join(', ')}): ${JSON.stringify(state)}`
    )
  }
  return state
}

/**
 * The renderer's capture config alone does not retire the backend's committed
 * camera scene; a scene with a camera and no camera frames marks every
 * preview frame source-stalled, so the presenter never claims.
 */
export function windowsD3d11ScreenOnlyLayoutIntent({ intentId, screenId, video }) {
  return {
    intentId,
    sources: { screenId, testPattern: false },
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
    video,
    background: null,
    protectedOverlayWindowIds: []
  }
}

export function windowsD3d11MediaReady(media) {
  return (
    media?.state === 'live' &&
    !(typeof media.fallbackReason === 'string' && media.fallbackReason.trim())
  )
}

/** Before its first device refresh the renderer does not know the screen yet. */
export function windowsD3d11HarnessScreenNotListed(error) {
  return /could not select available screen/.test(String(error?.message ?? error))
}

/** For probes that hold only the app's backend-ready marker. */
export async function configureWindowsD3d11ProbeSources({
  backendConnection,
  smokeCommand,
  timeoutMs
}) {
  const ws = await connectBackend(backendConnection, timeoutMs)
  try {
    const devices = await request(ws, timeoutMs, 'devices.list', {})
    const screenId = windowsD3d11ProbeScreenId(devices?.devices ?? [])
    if (!screenId) {
      throw new Error(
        `No DXGI screen is available for the Windows D3D11 preview probe: ${JSON.stringify(devices?.devices ?? [])}`
      )
    }
    // Commit the ScreenOnly scene before the renderer starts its session: a
    // scene commit that restarts the screen capture under a live D3D11
    // generation drops it to the BGRA upload route.
    const { video } = await smokeCommand(WINDOWS_D3D11_PREVIEW_HARNESS_COMMAND, {
      action: 'state'
    })
    const intent = windowsD3d11ScreenOnlyLayoutIntent({ intentId: Date.now(), screenId, video })
    const status = await request(ws, timeoutMs, 'scene.layout.apply_preview', intent)
    if (
      status?.intentId !== intent.intentId ||
      status?.compositorStatus?.sceneLayout?.layoutPreset !== 'screen-only'
    ) {
      throw new Error(
        `Backend did not commit ScreenOnly layout intent ${intent.intentId}: ${JSON.stringify(status)}`
      )
    }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        await configureWindowsD3d11RendererSources(smokeCommand, screenId)
        break
      } catch (error) {
        if (!windowsD3d11HarnessScreenNotListed(error) || Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    // Opening Preview before the generation is live leaves the proof surface
    // polling until the claim, so the probes start from a live generation.
    let media = null
    while (Date.now() < deadline) {
      media = (await request(ws, timeoutMs, 'diagnostics.stats', {}))?.windowsD3d11Media ?? null
      if (windowsD3d11MediaReady(media)) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!windowsD3d11MediaReady(media)) {
      throw new Error(`Windows D3D11 media did not go live: ${JSON.stringify(media)}`)
    }
    return screenId
  } finally {
    ws.close()
  }
}
