import { describe, expect, it } from 'vitest'

import {
  PreviewSupervisorModel,
  isPreviewTerminalState,
  previewWindowTargetAction
} from './preview-supervisor'

function supervisor(): PreviewSupervisorModel {
  let tick = 0
  return new PreviewSupervisorModel({
    now: () => `2026-06-19T12:00:00.${String(tick++).padStart(3, '0')}Z`
  })
}

describe('PreviewSupervisorModel', () => {
  it('tracks the happy path from closed window to live native surface', () => {
    const model = supervisor()

    expect(model.snapshot()).toMatchObject({
      lifecycleState: 'closed',
      generation: 0,
      windowOpen: false,
      surfaceRequested: false,
      surfaceActive: false
    })

    const opening = model.openWindow()
    expect(opening).toMatchObject({
      lifecycleState: 'opening-window',
      generation: 1,
      windowOpen: false
    })

    const open = model.windowOpened()
    expect(open).toMatchObject({
      lifecycleState: 'open-no-surface',
      generation: 1,
      windowOpen: true,
      windowVisible: true
    })

    const starting = model.requestSurface()
    expect(starting).toMatchObject({
      lifecycleState: 'starting-surface',
      surfaceRequested: true,
      surfaceActive: false
    })

    const live = model.surfaceLive({ generation: 1 })
    expect(live).toMatchObject({
      lifecycleState: 'surface-live',
      generation: 1,
      surfaceRequested: true,
      surfaceActive: true,
      transport: 'native-surface',
      backing: 'cametal-layer',
      permissionStatus: 'ok'
    })
  })

  it('makes close idempotent and finishes only the active generation', () => {
    const model = supervisor()
    model.openWindow()
    model.windowOpened()
    model.requestSurface()
    model.surfaceLive({ generation: 1 })

    const closing = model.closeWindow()
    expect(closing).toMatchObject({
      lifecycleState: 'closing',
      generation: 1,
      windowVisible: false,
      surfaceRequested: false,
      surfaceActive: false,
      transport: 'none',
      backing: 'none'
    })

    expect(model.closeWindow()).toEqual(closing)

    const closed = model.finishClose(1)
    expect(closed).toMatchObject({
      lifecycleState: 'closed',
      generation: 1,
      windowOpen: false,
      surfaceRequested: false,
      surfaceActive: false
    })

    expect(model.finishClose(1)).toEqual(closed)
  })

  it('opens a fresh generation while an older close is still settling', () => {
    const model = supervisor()
    model.openWindow()
    model.windowOpened()
    model.requestSurface()
    model.surfaceLive({ generation: 1 })
    model.closeWindow()

    const reopened = model.openWindow()
    expect(reopened).toMatchObject({
      lifecycleState: 'opening-window',
      generation: 2,
      windowOpen: false,
      surfaceRequested: false
    })

    model.windowOpened()
    model.requestSurface()
    model.surfaceLive({ generation: 2 })

    const afterStaleClose = model.finishClose(1)
    expect(afterStaleClose).toMatchObject({
      lifecycleState: 'surface-live',
      generation: 2,
      windowOpen: true,
      surfaceActive: true
    })
  })

  it('ignores stale surface callbacks from previous generations', () => {
    const model = supervisor()
    model.openWindow()
    model.windowOpened()
    model.requestSurface()
    model.surfaceLive({ generation: 1 })
    model.closeWindow()
    model.openWindow()
    model.windowOpened()
    model.requestSurface()

    const before = model.snapshot()
    model.surfaceFallback(1, 'old helper fell back late')
    model.surfaceFailed({ generation: 1, message: 'old helper failed late' })
    model.surfaceLive({ generation: 1 })

    expect(model.snapshot()).toEqual(before)
  })

  it('does not allow permission-required sessions to become live from a late callback', () => {
    const model = supervisor()
    model.openWindow()
    model.windowOpened()
    model.requestSurface()

    const permissionRequired = model.permissionRequired({
      generation: 1,
      permissionStatus: 'screen-recording-required',
      message: 'Screen Recording permission is required.'
    })
    expect(permissionRequired).toMatchObject({
      lifecycleState: 'permission-required',
      surfaceRequested: false,
      surfaceActive: false,
      permissionStatus: 'screen-recording-required',
      lastError: 'Screen Recording permission is required.'
    })

    model.surfaceLive({ generation: 1 })
    expect(model.snapshot()).toEqual(permissionRequired)
  })

  it('accepts permission-required while the preview window is open before surface start', () => {
    const model = supervisor()
    model.openWindow()
    model.windowOpened()

    const permissionRequired = model.permissionRequired({
      generation: 1,
      permissionStatus: 'screen-recording-required',
      message: 'Screen Recording permission is required.'
    })

    expect(permissionRequired).toMatchObject({
      lifecycleState: 'permission-required',
      windowOpen: true,
      surfaceRequested: false,
      surfaceActive: false,
      permissionStatus: 'screen-recording-required',
      lastError: 'Screen Recording permission is required.'
    })
  })

  it('marks fallback as explicit instead of native-live', () => {
    const model = supervisor()
    model.openWindow()
    model.windowOpened()
    model.requestSurface()

    const fallback = model.surfaceFallback(1, 'No Metal IOSurface target was available.')
    expect(fallback).toMatchObject({
      lifecycleState: 'surface-fallback',
      surfaceRequested: true,
      surfaceActive: false,
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      fallbackReason: 'No Metal IOSurface target was available.'
    })
  })

  it('classifies terminal lifecycle states for callers that gate recovery paths', () => {
    expect(isPreviewTerminalState('closed')).toBe(true)
    expect(isPreviewTerminalState('failed')).toBe(true)
    expect(isPreviewTerminalState('permission-required')).toBe(true)
    expect(isPreviewTerminalState('surface-live')).toBe(false)
    expect(isPreviewTerminalState('closing')).toBe(false)
  })
})

describe('previewWindowTargetAction', () => {
  it('turns an expected state into an idempotent open or close action', () => {
    expect(previewWindowTargetAction(false, true)).toBe('open')
    expect(previewWindowTargetAction(true, true)).toBe('none')
    expect(previewWindowTargetAction(true, false)).toBe('close')
    expect(previewWindowTargetAction(false, false)).toBe('none')
  })

  it('preserves ordinary toggle behavior when no target is supplied', () => {
    expect(previewWindowTargetAction(false)).toBe('open')
    expect(previewWindowTargetAction(true)).toBe('close')
  })
})
