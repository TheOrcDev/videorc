import { describe, expect, it } from 'vitest'

import {
  CAMERA_EXTENSION_ACTIVATE_AT_LAUNCH_ENV,
  CAMERA_EXTENSION_IDENTIFIER,
  applyCameraExtensionUpdate,
  cameraExtensionAvailability,
  cameraExtensionBindingFromModule,
  createCameraExtensionController,
  normalizeUpdate,
  shouldActivateCameraExtensionAtLaunch,
  updateSettlesRequest,
  type CameraExtensionBinding,
  type CameraExtensionState,
  type CameraExtensionUpdate
} from './camera-extension'

function fakeBinding() {
  const calls: { action: 'activate' | 'deactivate'; identifier: string }[] = []
  let callback: ((update: CameraExtensionUpdate) => void) | null = null
  const binding: CameraExtensionBinding = {
    activateCameraExtension(identifier, next) {
      calls.push({ action: 'activate', identifier })
      callback = next
    },
    deactivateCameraExtension(identifier, next) {
      calls.push({ action: 'deactivate', identifier })
      callback = next
    }
  }
  const emit = (
    update: Partial<CameraExtensionUpdate> & { kind: CameraExtensionUpdate['kind'] }
  ) => {
    if (!callback) throw new Error('no request pending')
    callback({ action: 'activate', identifier: CAMERA_EXTENSION_IDENTIFIER, ...update })
  }
  return { binding, calls, emit }
}

function controller(
  binding: CameraExtensionBinding | null,
  overrides: Partial<Parameters<typeof createCameraExtensionController>[0]> = {}
) {
  const states: CameraExtensionState[] = []
  const lines: string[] = []
  let tick = 1000
  const created = createCameraExtensionController({
    platform: 'darwin',
    isPackaged: true,
    binding,
    now: () => tick++,
    log: (line) => lines.push(line),
    onState: (state) => states.push(state),
    ...overrides
  })
  return { controller: created, states, lines }
}

describe('camera extension identifiers', () => {
  it('names the extension from identifiers.json', () => {
    expect(CAMERA_EXTENSION_IDENTIFIER).toBe('dev.theorcdev.videorc.camera')
  })
})

describe('cameraExtensionBindingFromModule', () => {
  it('reads both exports, also under default, and rejects an older addon', () => {
    const seen: unknown[] = []
    const module = {
      default: {
        activateCameraExtension: (_id: string, cb: (u: unknown) => void) =>
          cb({ kind: 'completed', action: 'activate', identifier: 'x' }),
        deactivateCameraExtension: (_id: string, cb: (u: unknown) => void) => cb({ nonsense: true })
      }
    }
    const binding = cameraExtensionBindingFromModule(module)
    expect(binding).not.toBeNull()
    binding!.activateCameraExtension('x', (update) => seen.push(update))
    binding!.deactivateCameraExtension('x', (update) => seen.push(update))
    expect(seen).toEqual([
      {
        kind: 'completed',
        action: 'activate',
        identifier: 'x',
        code: null,
        codeName: null,
        reason: null,
        detail: null,
        existingVersion: null,
        newVersion: null
      }
    ])
    expect(cameraExtensionBindingFromModule({ activateCameraExtension: () => {} })).toBeNull()
    expect(cameraExtensionBindingFromModule(null)).toBeNull()
  })

  it('normalizes updates defensively', () => {
    expect(
      normalizeUpdate({
        kind: 'failed',
        action: 'activate',
        identifier: 'x',
        code: 3,
        codeName: 'unsupportedParentBundleLocation',
        reason: 'Move it.',
        detail: 'd'
      })
    ).toEqual({
      kind: 'failed',
      action: 'activate',
      identifier: 'x',
      code: 3,
      codeName: 'unsupportedParentBundleLocation',
      reason: 'Move it.',
      detail: 'd',
      existingVersion: null,
      newVersion: null
    })
    expect(normalizeUpdate({ kind: 'exploded', action: 'activate', identifier: 'x' })).toBeNull()
    expect(normalizeUpdate({ kind: 'completed', action: 'install', identifier: 'x' })).toBeNull()
    expect(normalizeUpdate('completed')).toBeNull()
  })
})

describe('cameraExtensionAvailability and launch activation', () => {
  const binding = fakeBinding().binding

  it('is available only on a packaged macOS app with the addon exports', () => {
    expect(cameraExtensionAvailability({ platform: 'darwin', isPackaged: true, binding })).toEqual({
      available: true
    })
    expect(
      cameraExtensionAvailability({ platform: 'win32', isPackaged: true, binding })
    ).toMatchObject({ available: false, reason: expect.stringContaining('macOS only') })
    expect(
      cameraExtensionAvailability({ platform: 'darwin', isPackaged: false, binding })
    ).toMatchObject({ available: false, reason: expect.stringContaining('dev app') })
    expect(
      cameraExtensionAvailability({ platform: 'darwin', isPackaged: true, binding: null })
    ).toMatchObject({
      available: false,
      reason: expect.stringContaining('activateCameraExtension')
    })
  })

  it('activates at launch when the switch is on or the lab env asks, never when unavailable', () => {
    const available = { available: true } as const
    const unavailable = { available: false, reason: 'no' } as const
    expect(
      shouldActivateCameraExtensionAtLaunch({ availability: available, switchOn: true, env: {} })
    ).toBe(true)
    expect(
      shouldActivateCameraExtensionAtLaunch({ availability: available, switchOn: false, env: {} })
    ).toBe(false)
    expect(
      shouldActivateCameraExtensionAtLaunch({
        availability: available,
        switchOn: false,
        env: { [CAMERA_EXTENSION_ACTIVATE_AT_LAUNCH_ENV]: '1' }
      })
    ).toBe(true)
    expect(
      shouldActivateCameraExtensionAtLaunch({
        availability: unavailable,
        switchOn: true,
        env: { [CAMERA_EXTENSION_ACTIVATE_AT_LAUNCH_ENV]: '1' }
      })
    ).toBe(false)
  })
})

describe('applyCameraExtensionUpdate', () => {
  const base = { action: 'activate' as const, identifier: 'x' }

  it('maps every update kind to a phase', () => {
    expect(applyCameraExtensionUpdate({ ...base, kind: 'needs-approval' }, 5).phase).toBe(
      'needs-approval'
    )
    expect(
      applyCameraExtensionUpdate(
        { ...base, kind: 'replacing', existingVersion: '0.17.0', newVersion: '0.18.0' },
        5
      )
    ).toMatchObject({ phase: 'replacing', existingVersion: '0.17.0', newVersion: '0.18.0' })
    expect(applyCameraExtensionUpdate({ ...base, kind: 'completed' }, 5).phase).toBe('active')
    expect(
      applyCameraExtensionUpdate({ ...base, action: 'deactivate', kind: 'completed' }, 5).phase
    ).toBe('removed')
    expect(
      applyCameraExtensionUpdate({ ...base, kind: 'will-complete-after-reboot' }, 5).phase
    ).toBe('reboot-required')
    expect(
      applyCameraExtensionUpdate(
        {
          ...base,
          kind: 'failed',
          code: 3,
          codeName: 'unsupportedParentBundleLocation',
          reason: 'Move Videorc to the Applications folder, then turn Videorc Camera on again.',
          detail: 'sys'
        },
        5
      )
    ).toMatchObject({
      phase: 'failed',
      code: 3,
      codeName: 'unsupportedParentBundleLocation',
      reason: 'Move Videorc to the Applications folder, then turn Videorc Camera on again.',
      detail: 'sys',
      updatedAt: 5
    })
    expect(applyCameraExtensionUpdate({ ...base, kind: 'failed' }, 5).reason).toMatch(
      /macOS reported an error/
    )
  })

  it('only replacing leaves the request open', () => {
    expect(updateSettlesRequest('replacing')).toBe(false)
    for (const kind of [
      'needs-approval',
      'completed',
      'will-complete-after-reboot',
      'failed'
    ] as const) {
      expect(updateSettlesRequest(kind)).toBe(true)
    }
  })
})

describe('createCameraExtensionController', () => {
  it('starts idle, activates, and settles on completion', async () => {
    const fake = fakeBinding()
    const { controller: camera, states, lines } = controller(fake.binding)
    expect(camera.state().phase).toBe('idle')
    expect(camera.identifier).toBe('dev.theorcdev.videorc.camera')

    const pending = camera.activate()
    expect(camera.state().phase).toBe('activating')
    expect(fake.calls).toEqual([{ action: 'activate', identifier: 'dev.theorcdev.videorc.camera' }])
    fake.emit({ kind: 'completed' })
    const settled = await pending
    expect(settled.phase).toBe('active')
    expect(states.map((state) => state.phase)).toEqual(['activating', 'active'])
    expect(lines).toEqual([
      'Videorc Camera extension: activating',
      'Videorc Camera extension: active'
    ])
  })

  it('resolves at needs-approval and keeps reporting the later approval', async () => {
    const fake = fakeBinding()
    const { controller: camera, states } = controller(fake.binding)
    const pending = camera.activate()
    fake.emit({ kind: 'needs-approval' })
    expect((await pending).phase).toBe('needs-approval')
    fake.emit({ kind: 'completed' })
    expect(camera.state().phase).toBe('active')
    expect(states.map((state) => state.phase)).toEqual(['activating', 'needs-approval', 'active'])
  })

  it('replacing stays open until the request finishes', async () => {
    const fake = fakeBinding()
    const { controller: camera } = controller(fake.binding)
    const pending = camera.activate()
    fake.emit({ kind: 'replacing', existingVersion: '0.17.0', newVersion: '0.18.0' })
    expect(camera.state()).toMatchObject({
      phase: 'replacing',
      existingVersion: '0.17.0',
      newVersion: '0.18.0'
    })
    fake.emit({ kind: 'will-complete-after-reboot' })
    expect((await pending).phase).toBe('reboot-required')
  })

  it('carries the mapped failure reason and code', async () => {
    const fake = fakeBinding()
    const { controller: camera, lines } = controller(fake.binding)
    const pending = camera.activate()
    fake.emit({
      kind: 'failed',
      code: 3,
      codeName: 'unsupportedParentBundleLocation',
      reason: 'Move Videorc to the Applications folder, then turn Videorc Camera on again.',
      detail: 'parent bundle'
    })
    const failed = await pending
    expect(failed).toMatchObject({
      phase: 'failed',
      code: 3,
      codeName: 'unsupportedParentBundleLocation',
      detail: 'parent bundle'
    })
    expect(failed.reason).toBe(
      'Move Videorc to the Applications folder, then turn Videorc Camera on again.'
    )
    expect(lines.at(-1)).toBe(
      'Videorc Camera extension: failed (Move Videorc to the Applications folder, then turn Videorc Camera on again.) [unsupportedParentBundleLocation]'
    )
  })

  it("joins a pending request of the same action and drops a superseded request's late words", async () => {
    const fake = fakeBinding()
    const { controller: camera } = controller(fake.binding)
    const first = camera.activate()
    const second = camera.activate()
    expect(second).toBe(first)
    expect(fake.calls).toHaveLength(1)

    const firstCallback = fake
    const removal = camera.deactivate()
    expect(camera.state().phase).toBe('deactivating')
    // The older activation reports now: ignored, the deactivation owns the state.
    firstCallback.emit({ kind: 'completed', action: 'deactivate' })
    expect((await removal).phase).toBe('removed')
    expect(fake.calls.map((call) => call.action)).toEqual(['activate', 'deactivate'])
  })

  it('a throwing addon becomes a failed state with the addon marker', async () => {
    const throwing: CameraExtensionBinding = {
      activateCameraExtension() {
        throw new Error('Camera extension requests must be made on the macOS main thread.')
      },
      deactivateCameraExtension() {}
    }
    const { controller: camera } = controller(throwing)
    const failed = await camera.activate()
    expect(failed.phase).toBe('failed')
    expect(failed.codeName).toBe('addon')
    expect(failed.reason).toContain(
      'could not be activated: Camera extension requests must be made on the macOS main thread.'
    )
  })

  it('an unavailable host resolves immediately with the reason and never calls the addon', async () => {
    const fake = fakeBinding()
    const { controller: camera } = controller(fake.binding, { isPackaged: false })
    expect(camera.state()).toMatchObject({
      phase: 'unavailable',
      reason: expect.stringContaining('dev app')
    })
    const result = await camera.activate()
    expect(result.phase).toBe('unavailable')
    expect(result.action).toBe('activate')
    expect(fake.calls).toEqual([])
    expect(camera.availability()).toEqual({
      available: false,
      reason: expect.stringContaining('dev app')
    })
  })
})
