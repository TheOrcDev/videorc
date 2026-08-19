import { describe, expect, it } from 'vitest'

import { validateMainOwnedPreviewSurfaceBoundsParams } from './backend-rpc-contract'
import { validateBackendRpcResult } from './backend-rpc-contract'
import { validateElectronInvokeResult } from './electron-ipc-contract'

// One preview-bounds shape, three independent allowUnknown:false validators
// (backend RPC result, main-owned backend params, Electron IPC). Three times
// in one week a new field was added to N−1 of N validation layers and the
// missed layer threw RuntimeSchemaError in production (issue #232 —
// cornerRadius missing from the Electron IPC schema). This test feeds ONE
// maximal fixture through every layer, so adding a field to any schema
// without the others fails HERE instead of in a shipped build.
//
// When you add a bounds field: set it in MAXIMAL_BOUNDS and update every
// schema this test exercises.
const MAXIMAL_BOUNDS = {
  screenX: 12,
  screenY: 34,
  width: 1280,
  height: 720,
  scaleFactor: 2,
  screenHeight: 1080,
  clipX: 12,
  clipY: 34,
  clipWidth: 1280,
  clipHeight: 720,
  visible: true,
  orderAboveWindowId: 42,
  elevated: false,
  cornerRadius: 18
}

const SURFACE_STATUS = {
  state: 'live',
  source: 'screen',
  transport: 'native-surface',
  backing: 'cametal-layer',
  targetFps: 30,
  width: 1280,
  height: 720,
  framesRendered: 42,
  droppedFrames: 0,
  framePollingSuppressed: true,
  sourcePixelsPresent: true,
  pendingHostCommandCount: 0,
  bounds: MAXIMAL_BOUNDS,
  updatedAt: '2026-08-20T00:00:00.000Z'
}

describe('preview bounds schema parity', () => {
  it('every validation layer accepts the same maximal bounds', () => {
    expect(() =>
      validateElectronInvokeResult('preview-surface:status', SURFACE_STATUS)
    ).not.toThrow()
    expect(() =>
      validateElectronInvokeResult('preview-surface:drain-host-commands', SURFACE_STATUS)
    ).not.toThrow()
    expect(() => validateBackendRpcResult('preview.surface.status', SURFACE_STATUS)).not.toThrow()
    expect(() =>
      validateMainOwnedPreviewSurfaceBoundsParams({
        bounds: MAXIMAL_BOUNDS,
        generation: 1
      })
    ).not.toThrow()
  })
})
