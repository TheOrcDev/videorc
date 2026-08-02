import { describe, expect, it, vi } from 'vitest'

import type { PreviewSurfaceBounds } from '../shared/backend'
import { withTrustedPreviewWindowStacking } from './native-preview-window-stacking'

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
