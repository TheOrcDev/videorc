import { describe, expect, it, vi } from 'vitest'

import type { PreviewSurfaceBounds } from '../shared/backend'
import {
  previewDockedInsideMainWindow,
  proofSurfaceHostedInWindowOn,
  proofSurfaceParentWindow,
  withTrustedPreviewWindowStacking
} from './native-preview-window-stacking'

const bounds = (
  overrides: Partial<PreviewSurfaceBounds & Record<string, unknown>> = {}
): PreviewSurfaceBounds =>
  ({
    screenX: 10,
    screenY: 20,
    width: 960,
    height: 540,
    scaleFactor: 1,
    visible: true,
    ...overrides
  }) as PreviewSurfaceBounds

const windowWithHandle = (handle: Buffer) => ({
  isDestroyed: () => false,
  getNativeWindowHandle: vi.fn(() => handle)
})

describe('trusted preview-window stacking', () => {
  it('replaces a forged renderer handle with a fresh complete 64-bit HWND', () => {
    const handle = Buffer.alloc(8)
    handle.writeBigUInt64LE(0x1234_5678_90ab_cdefn)
    const previewWindow = windowWithHandle(handle)

    const result = withTrustedPreviewWindowStacking(
      {
        platform: 'win32',
        bounds: bounds({
          orderAboveWindowHandle: '0xffffffffffffffff',
          processId: 99
        }),
        generation: 7,
        currentGeneration: 7,
        previewWindowOpen: true,
        previewWindow,
        elevated: false
      },
      (params) => params
    )

    expect(result).toEqual({
      generation: 7,
      bounds: expect.objectContaining({
        orderAboveWindowHandle: '0x1234567890abcdef',
        elevated: false
      })
    })
    expect(result.bounds).not.toHaveProperty('processId')
    expect(previewWindow.getNativeWindowHandle).toHaveBeenCalledOnce()
  })

  it('supports a full 32-bit HWND without converting it through Number', () => {
    const handle = Buffer.alloc(4)
    handle.writeUInt32LE(0xfedcba98)
    const result = withTrustedPreviewWindowStacking(
      {
        platform: 'win32',
        bounds: bounds(),
        generation: 2,
        currentGeneration: 2,
        previewWindowOpen: true,
        previewWindow: windowWithHandle(handle),
        elevated: true
      },
      (params) => params
    )
    expect(result.bounds.orderAboveWindowHandle).toBe('0x00000000fedcba98')
  })

  it('reads a fresh handle for every command', () => {
    let value = 1n
    const previewWindow = {
      isDestroyed: () => false,
      getNativeWindowHandle: vi.fn(() => {
        const handle = Buffer.alloc(8)
        handle.writeBigUInt64LE(value++)
        return handle
      })
    }
    const input = {
      platform: 'win32' as const,
      bounds: bounds(),
      generation: 3,
      currentGeneration: 3,
      previewWindowOpen: true,
      previewWindow,
      elevated: false
    }

    expect(withTrustedPreviewWindowStacking(input, (params) => params).bounds).toHaveProperty(
      'orderAboveWindowHandle',
      '0x0000000000000001'
    )
    expect(withTrustedPreviewWindowStacking(input, (params) => params).bounds).toHaveProperty(
      'orderAboveWindowHandle',
      '0x0000000000000002'
    )
  })

  it('fails closed for stale, closed, destroyed, zero, and malformed handles', () => {
    const valid = windowWithHandle(Buffer.from([1, 0, 0, 0]))
    const input = {
      platform: 'win32' as const,
      bounds: bounds(),
      generation: 5,
      currentGeneration: 5,
      previewWindowOpen: true,
      previewWindow: valid,
      elevated: false
    }
    const invoke = (overrides: Partial<typeof input> = {}) =>
      withTrustedPreviewWindowStacking({ ...input, ...overrides }, (params) => params)

    expect(() => invoke({ currentGeneration: 6 })).toThrow('stale')
    expect(() => invoke({ previewWindowOpen: false })).toThrow('live preview window')
    expect(() =>
      invoke({
        previewWindow: {
          ...valid,
          isDestroyed: () => true
        }
      })
    ).toThrow('live preview window')
    expect(() => invoke({ previewWindow: windowWithHandle(Buffer.alloc(8)) })).toThrow('nonzero')
    expect(() => invoke({ previewWindow: windowWithHandle(Buffer.alloc(6)) })).toThrow(
      'four- or eight-byte'
    )
  })

  it('preserves main-owned macOS stacking while stripping Windows identities', () => {
    const result = withTrustedPreviewWindowStacking(
      {
        platform: 'darwin',
        bounds: bounds({ orderAboveWindowHandle: '0x0000000000000009' }),
        generation: 4,
        currentGeneration: 4,
        previewWindowOpen: true,
        previewWindow: windowWithHandle(Buffer.alloc(8)),
        orderAboveWindowId: 42,
        elevated: true
      },
      (params) => params
    )

    expect(result.bounds).toMatchObject({ orderAboveWindowId: 42, elevated: true })
    expect(result.bounds).not.toHaveProperty('orderAboveWindowHandle')
  })
})

describe('proof surface parent window', () => {
  const live = (name: string) => ({ name, isDestroyed: () => false })
  const destroyed = (name: string) => ({ name, isDestroyed: () => true })

  it('hangs off the main window while the Preview is docked inside it', () => {
    // The preview window is hidden then; a child shown on it would bring it on screen.
    expect(
      proofSurfaceParentWindow({
        dockedInMainWindow: true,
        mainWindow: live('main'),
        previewWindow: live('preview')
      })?.name
    ).toBe('main')
  })

  it('hangs off the preview window when it is the visible Preview', () => {
    expect(
      proofSurfaceParentWindow({
        dockedInMainWindow: false,
        mainWindow: live('main'),
        previewWindow: live('preview')
      })?.name
    ).toBe('preview')
  })

  it('falls back to the main window without a preview window, and never a destroyed one', () => {
    expect(
      proofSurfaceParentWindow({
        dockedInMainWindow: false,
        mainWindow: live('main'),
        previewWindow: null
      })?.name
    ).toBe('main')
    expect(
      proofSurfaceParentWindow({
        dockedInMainWindow: true,
        mainWindow: destroyed('main'),
        previewWindow: live('preview')
      })
    ).toBeNull()
  })
})

describe('docked preview host (plan 216 C)', () => {
  const live = (name: string) => ({ name, isDestroyed: () => false })
  const docked = (
    platform: NodeJS.Platform,
    driverKind: Parameters<typeof previewDockedInsideMainWindow>[0]['driverKind']
  ) => previewDockedInsideMainWindow({ mode: 'docked', platform, driverKind })

  it('draws the macOS in-process layer inside the main window', () => {
    expect(docked('darwin', 'in-process')).toBe(true)
  })

  it('keeps the proof fallback inside the main window after a driver reset', () => {
    // The watchdog's reset-native-path leaves no driver; the Electron proof
    // surface takes the dock, and its host must stay the main window, not a
    // second window the mouse has to cross.
    expect(docked('darwin', null)).toBe(true)
    expect(
      proofSurfaceParentWindow({
        dockedInMainWindow: docked('darwin', null),
        mainWindow: live('main'),
        previewWindow: live('preview')
      })?.name
    ).toBe('main')
  })

  it('keeps the child window for the macOS helper-process and external drivers', () => {
    expect(docked('darwin', 'helper-process')).toBe(false)
    expect(docked('darwin', 'external-module')).toBe(false)
    expect(
      proofSurfaceParentWindow({
        dockedInMainWindow: docked('darwin', 'helper-process'),
        mainWindow: live('main'),
        previewWindow: live('preview')
      })?.name
    ).toBe('preview')
  })

  it('leaves Linux in the window and Windows in its own, whatever the driver', () => {
    expect(docked('linux', null)).toBe(true)
    expect(docked('linux', 'external-module')).toBe(true)
    expect(docked('win32', null)).toBe(false)
    expect(docked('win32', 'in-process')).toBe(false)
    expect(proofSurfaceHostedInWindowOn('darwin')).toBe(true)
    expect(proofSurfaceHostedInWindowOn('linux')).toBe(true)
    expect(proofSurfaceHostedInWindowOn('win32')).toBe(false)
  })

  it('never applies to a floating Preview, which keeps its own window', () => {
    expect(
      previewDockedInsideMainWindow({ mode: 'floating', platform: 'darwin', driverKind: null })
    ).toBe(false)
    expect(
      previewDockedInsideMainWindow({ mode: 'floating', platform: 'linux', driverKind: null })
    ).toBe(false)
  })
})
