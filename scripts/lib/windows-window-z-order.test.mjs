import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  collectWindowsWindowZOrder,
  evaluateWindowsWindowZOrder,
  normalizeWindowsHwnd,
  parseWindowsWindowZOrderOutput,
  windowsWindowZOrderPowerShellScript
} from './windows-window-z-order.mjs'

const OWNED_PID = 4_242
const PROTECTED_HWND = '0x00000001ABCDEF01'
const OWNED_OVERLAY_HWND = '0x00000001ABCDEF02'
const UNRELATED_HWND = '0x00000002ABCDEF01'
const CROP = { x: 120, y: 140, width: 200, height: 120 }
const WINDOW_BOUNDS = { x: 100, y: 100, width: 400, height: 300 }

describe('Windows window z-order evidence', () => {
  it('passes when all higher unrelated windows are clear of the protected crop', () => {
    const result = evaluateWindowsWindowZOrder({
      snapshot: snapshot([
        windowRow(0, UNRELATED_HWND, 9_999, { x: 800, y: 100, width: 200, height: 200 }),
        windowRow(1, PROTECTED_HWND, OWNED_PID, WINDOW_BOUNDS)
      ]),
      protectedWindows: [protectedWindow()],
      allowedOwnedPids: [OWNED_PID]
    })

    assert.equal(result.verdict, 'PASS')
    assert.deepEqual(result.blockers, [])
    assert.deepEqual(result.occluders, [])
    assert.equal(result.protectedWindows[0].actualWindow.zOrder, 1)
  })

  it('blocks a visible unrelated higher-z-order window that intersects a protected crop', () => {
    const result = evaluateWindowsWindowZOrder({
      snapshot: snapshot([
        windowRow(0, UNRELATED_HWND, 9_999, { x: 200, y: 180, width: 300, height: 200 }),
        windowRow(1, PROTECTED_HWND, OWNED_PID, WINDOW_BOUNDS)
      ]),
      protectedWindows: [protectedWindow()],
      allowedOwnedPids: [OWNED_PID]
    })

    assert.equal(result.verdict, 'BLOCKED')
    assert.match(result.blockers.join('\n'), /visible unprotected HWND.*higher in z-order/)
    assert.deepEqual(
      result.occluders.map((entry) => entry.hwnd),
      [normalizeWindowsHwnd(UNRELATED_HWND)]
    )
  })

  it('blocks an owned but unprotected higher-z-order window that intersects the crop', () => {
    const result = evaluateWindowsWindowZOrder({
      snapshot: snapshot([
        windowRow(0, OWNED_OVERLAY_HWND, OWNED_PID, {
          x: 200,
          y: 180,
          width: 300,
          height: 200
        }),
        windowRow(1, PROTECTED_HWND, OWNED_PID, WINDOW_BOUNDS)
      ]),
      protectedWindows: [protectedWindow()],
      allowedOwnedPids: [OWNED_PID]
    })

    assert.equal(result.verdict, 'BLOCKED')
    assert.match(result.blockers.join('\n'), /visible unprotected HWND/)
    assert.deepEqual(result.occluders.map((entry) => entry.hwnd), [
      normalizeWindowsHwnd(OWNED_OVERLAY_HWND)
    ])
  })

  it('allows only an exact protected higher-z-order window over another protected crop', () => {
    const overlayBounds = { x: 200, y: 180, width: 300, height: 200 }
    const result = evaluateWindowsWindowZOrder({
      snapshot: snapshot([
        windowRow(0, OWNED_OVERLAY_HWND, OWNED_PID, overlayBounds),
        windowRow(1, PROTECTED_HWND, OWNED_PID, WINDOW_BOUNDS)
      ]),
      protectedWindows: [
        protectedWindow(),
        {
          role: 'proof-surface',
          hwnd: OWNED_OVERLAY_HWND,
          pid: OWNED_PID,
          cropRect: { x: 220, y: 200, width: 40, height: 40 },
          expectedBounds: overlayBounds
        }
      ],
      allowedOwnedPids: [OWNED_PID]
    })

    assert.equal(result.verdict, 'PASS')
    assert.deepEqual(result.occluders, [])
  })

  it('blocks an absent protected HWND', () => {
    const result = evaluateWindowsWindowZOrder({
      snapshot: snapshot([
        windowRow(0, UNRELATED_HWND, 9_999, { x: 800, y: 100, width: 200, height: 200 })
      ]),
      protectedWindows: [protectedWindow()],
      allowedOwnedPids: [OWNED_PID]
    })

    assert.equal(result.verdict, 'BLOCKED')
    assert.match(result.blockers.join('\n'), /was absent from EnumWindows/)
  })

  it('blocks invisible and misbounded protected HWNDs', () => {
    const invisible = evaluateWindowsWindowZOrder({
      snapshot: snapshot([
        windowRow(0, PROTECTED_HWND, OWNED_PID, WINDOW_BOUNDS, { visible: false })
      ]),
      protectedWindows: [protectedWindow()],
      allowedOwnedPids: [OWNED_PID]
    })
    assert.match(invisible.blockers.join('\n'), /was not visible/)

    const misbounded = evaluateWindowsWindowZOrder({
      snapshot: snapshot([
        windowRow(0, PROTECTED_HWND, OWNED_PID, { x: 0, y: 0, width: 50, height: 50 })
      ]),
      protectedWindows: [protectedWindow()],
      allowedOwnedPids: [OWNED_PID]
    })
    assert.match(misbounded.blockers.join('\n'), /did not contain its protected crop/)
  })

  it('keeps 64-bit HWNDs as strings and rejects unsafe numeric handles', () => {
    assert.equal(normalizeWindowsHwnd('0xFEDCBA9876543210'), '0xfedcba9876543210')
    assert.equal(normalizeWindowsHwnd(0x1a2b), '0x0000000000001a2b')
    assert.equal(normalizeWindowsHwnd(Number.MAX_SAFE_INTEGER + 1), null)

    const parsed = parseWindowsWindowZOrderOutput(
      JSON.stringify({
        startedAt: '2026-07-29T12:00:00.000Z',
        sampledAt: '2026-07-29T12:00:00.010Z',
        completedAt: '2026-07-29T12:00:00.010Z',
        enumWindowsSucceeded: true,
        windows: [
          {
            zOrder: 0,
            hwnd: '0xFEDCBA9876543210',
            pid: OWNED_PID,
            threadId: 777,
            visible: true,
            rectRead: true,
            bounds: WINDOW_BOUNDS
          }
        ]
      })
    )
    assert.equal(parsed.windows[0].hwnd, '0xfedcba9876543210')
  })

  it('preserves harmless zero-area invisible Win32 windows in the snapshot', () => {
    const parsed = parseWindowsWindowZOrderOutput(
      JSON.stringify({
        startedAt: '2026-07-29T12:00:00.000Z',
        sampledAt: '2026-07-29T12:00:00.010Z',
        completedAt: '2026-07-29T12:00:00.010Z',
        enumWindowsSucceeded: true,
        windows: [
          {
            zOrder: 0,
            hwnd: '0x0000000000001234',
            pid: 100,
            threadId: 101,
            visible: false,
            rectRead: true,
            bounds: { x: 0, y: 0, width: 0, height: 0 }
          },
          {
            zOrder: 1,
            hwnd: PROTECTED_HWND,
            pid: OWNED_PID,
            threadId: OWNED_PID + 100,
            visible: true,
            rectRead: true,
            bounds: WINDOW_BOUNDS
          }
        ]
      })
    )
    const result = evaluateWindowsWindowZOrder({
      snapshot: parsed,
      protectedWindows: [protectedWindow()],
      allowedOwnedPids: [OWNED_PID]
    })

    assert.equal(result.verdict, 'PASS')
  })

  it('builds and executes an encoded PowerShell EnumWindows collector', async () => {
    const script = windowsWindowZOrderPowerShellScript()
    assert.match(script, /EnumWindows/)
    assert.match(script, /GetWindowRect/)
    assert.match(script, /GetWindowThreadProcessId/)
    assert.match(script, /IsWindowVisible/)
    assert.match(script, /\[IntPtr\]::Size -eq 8/)
    assert.match(script, /\$hwnd\.ToInt64\(\)\.ToString/)
    assert.match(script, /hwnd = "0x\$handleHex"/)
    assert.match(script, /zOrder = \[int64\]\$windows\.Count/)

    let invocation
    const result = await collectWindowsWindowZOrder({
      platform: 'win32',
      execFile: async (...args) => {
        invocation = args
        return {
          stdout: JSON.stringify({
            startedAt: '2026-07-29T12:00:00.000Z',
            sampledAt: '2026-07-29T12:00:00.010Z',
            completedAt: '2026-07-29T12:00:00.010Z',
            enumWindowsSucceeded: true,
            windows: []
          })
        }
      }
    })

    assert.equal(invocation[0], 'powershell.exe')
    assert.deepEqual(invocation[1].slice(0, 5), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ])
    const decoded = Buffer.from(invocation[1][5], 'base64').toString('utf16le')
    assert.equal(decoded, script)
    assert.equal(result.enumWindowsSucceeded, true)
  })
})

function protectedWindow() {
  return {
    role: 'comments',
    hwnd: PROTECTED_HWND,
    pid: OWNED_PID,
    cropRect: CROP,
    expectedBounds: WINDOW_BOUNDS
  }
}

function snapshot(windows) {
  return {
    enumWindowsSucceeded: true,
    windows
  }
}

function windowRow(zOrder, hwnd, pid, bounds, { visible = true, rectRead = true } = {}) {
  return {
    zOrder,
    hwnd,
    pid,
    threadId: pid + 100,
    visible,
    rectRead,
    bounds: rectRead ? bounds : null
  }
}
