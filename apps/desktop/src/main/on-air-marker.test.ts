import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ON_AIR_MARKER_FILE, OnAirMarker, onAirMarkerPath } from './on-air-marker'

const PATH = '/data/Videorc/on-air.json'

function fakeIo() {
  const files = new Map<string, string>()
  return {
    files,
    io: {
      write: vi.fn((path: string, text: string) => void files.set(path, text)),
      remove: vi.fn((path: string) => void files.delete(path))
    }
  }
}

describe('OnAirMarker', () => {
  it('lives in the app data folder', () => {
    // The OS's own separators: Windows CI joins with a backslash.
    expect(onAirMarkerPath('/data/Videorc')).toBe(join('/data/Videorc', 'on-air.json'))
    expect(ON_AIR_MARKER_FILE).toBe('on-air.json')
  })

  it('names this process while on air and goes away when the livestream ends', () => {
    const { files, io } = fakeIo()
    const marker = new OnAirMarker(PATH, io, 4242, () => new Date('2026-11-19T14:17:51Z'))

    marker.update(true)
    expect(JSON.parse(files.get(PATH) ?? 'null')).toEqual({
      v: 1,
      onAir: true,
      pid: 4242,
      since: '2026-11-19T14:17:51.000Z'
    })

    marker.update(false)
    expect(files.has(PATH)).toBe(false)
  })

  it('touches the file only when on air changes', () => {
    const { io } = fakeIo()
    const marker = new OnAirMarker(PATH, io, 1)

    marker.update(true)
    marker.update(true)
    marker.update(true)
    expect(io.write).toHaveBeenCalledTimes(1)

    marker.update(false)
    marker.update(false)
    expect(io.remove).toHaveBeenCalledTimes(1)
  })

  it('removes a marker a previous run may have left when the first status is off air', () => {
    const { files, io } = fakeIo()
    files.set(PATH, '{"v":1,"onAir":true,"pid":1}')
    new OnAirMarker(PATH, io, 2).update(false)
    expect(files.has(PATH)).toBe(false)
  })

  it('never throws when the disk refuses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const marker = new OnAirMarker(PATH, {
      write: () => {
        throw new Error('read-only')
      },
      remove: () => {
        throw new Error('gone')
      }
    })
    expect(() => marker.update(true)).not.toThrow()
    expect(() => marker.update(false)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
