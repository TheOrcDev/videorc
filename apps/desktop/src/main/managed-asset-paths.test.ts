import { posix, win32 } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isPathInsideRoot } from './managed-asset-paths'

describe('isPathInsideRoot', () => {
  it('accepts Windows drive children across case and separator variations', () => {
    const root = 'C:\\Users\\Creator\\AppData\\Roaming\\Videorc\\background-assets'

    expect(isPathInsideRoot(`${root}\\abc.png`, root, win32)).toBe(true)
    expect(
      isPathInsideRoot(
        'c:/users/creator/appdata/roaming/videorc/background-assets/nested/abc.png',
        root,
        win32
      )
    ).toBe(true)
  })

  it('accepts Windows UNC children across case and separator variations', () => {
    const root = '\\\\SERVER\\Share\\Videorc\\background-assets'

    expect(
      isPathInsideRoot('\\\\server\\share\\videorc\\background-assets\\abc.png', root, win32)
    ).toBe(true)
    expect(
      isPathInsideRoot('//server/share/videorc/background-assets/nested/abc.png', root, win32)
    ).toBe(true)
  })

  it('rejects roots, traversal, sibling prefixes, and other Windows volumes', () => {
    const root = 'C:\\Videorc\\background-assets'

    expect(isPathInsideRoot(root, root, win32)).toBe(false)
    expect(isPathInsideRoot('C:\\Videorc\\background-assets\\..\\secret.png', root, win32)).toBe(
      false
    )
    expect(isPathInsideRoot('C:\\Videorc\\background-assets-evil\\abc.png', root, win32)).toBe(
      false
    )
    expect(isPathInsideRoot('D:\\Videorc\\background-assets\\abc.png', root, win32)).toBe(false)
    expect(isPathInsideRoot('background-assets\\abc.png', root, win32)).toBe(false)
    expect(
      isPathInsideRoot(
        '\\\\server\\other-share\\videorc\\background-assets\\abc.png',
        '\\\\server\\share\\videorc\\background-assets',
        win32
      )
    ).toBe(false)
  })

  it('preserves POSIX containment behavior', () => {
    expect(
      isPathInsideRoot('/managed/background-assets/abc.png', '/managed/background-assets', posix)
    ).toBe(true)
    expect(
      isPathInsideRoot('/managed/background-assets', '/managed/background-assets', posix)
    ).toBe(false)
    expect(
      isPathInsideRoot(
        '/managed/background-assets-evil/abc.png',
        '/managed/background-assets',
        posix
      )
    ).toBe(false)
    expect(isPathInsideRoot('/managed/secret.png', '/managed/background-assets', posix)).toBe(false)
  })
})
