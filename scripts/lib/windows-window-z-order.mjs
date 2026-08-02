import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCallback)
const MAX_UINT32 = 0xffff_ffff
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn
const POWERSHELL_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/**
 * Enumerate top-level Windows windows in the order returned by EnumWindows
 * (highest z-order first). HWNDs are emitted as fixed-width hexadecimal
 * strings so a 64-bit pointer never passes through JSON's number type.
 */
export function windowsWindowZOrderPowerShellScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Videorc {
  public static class WindowZOrderNative {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
      public int Left;
      public int Top;
      public int Right;
      public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  }
}
'@

$startedAt = [DateTime]::UtcNow
$windows = [System.Collections.Generic.List[object]]::new()
$callback = [Videorc.WindowZOrderNative+EnumWindowsProc] {
  param([IntPtr]$hwnd, [IntPtr]$lParam)

  $rect = [Videorc.WindowZOrderNative+RECT]::new()
  $rectRead = [Videorc.WindowZOrderNative]::GetWindowRect($hwnd, [ref]$rect)
  $processId = [uint32]0
  $threadId = [Videorc.WindowZOrderNative]::GetWindowThreadProcessId(
    $hwnd,
    [ref]$processId
  )
  if ([IntPtr]::Size -eq 8) {
    $handleHex = $hwnd.ToInt64().ToString(
      'X16',
      [Globalization.CultureInfo]::InvariantCulture
    )
  } else {
    $handleHex = $hwnd.ToInt32().ToString(
      'X8',
      [Globalization.CultureInfo]::InvariantCulture
    ).PadLeft(16, '0')
  }

  $bounds = if ($rectRead) {
    [ordered]@{
      x = [int64]$rect.Left
      y = [int64]$rect.Top
      width = [int64]($rect.Right - $rect.Left)
      height = [int64]($rect.Bottom - $rect.Top)
    }
  } else {
    $null
  }

  $windows.Add([ordered]@{
    zOrder = [int64]$windows.Count
    hwnd = "0x$handleHex"
    pid = [int64]$processId
    threadId = [int64]$threadId
    visible = [bool][Videorc.WindowZOrderNative]::IsWindowVisible($hwnd)
    rectRead = [bool]$rectRead
    bounds = $bounds
  })
  return $true
}

$enumerated = [Videorc.WindowZOrderNative]::EnumWindows(
  $callback,
  [IntPtr]::Zero
)
if (-not $enumerated) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "EnumWindows failed with Win32 error $errorCode."
}

$completedAt = [DateTime]::UtcNow
[ordered]@{
  startedAt = $startedAt.ToString('o')
  sampledAt = $completedAt.ToString('o')
  completedAt = $completedAt.ToString('o')
  enumWindowsSucceeded = $true
  windows = @($windows)
} | ConvertTo-Json -Compress -Depth 5
`.trim()
}

export async function collectWindowsWindowZOrder({
  platform = process.platform,
  execFile = execFileAsync
} = {}) {
  if (platform !== 'win32') {
    throw new Error('Windows window z-order collection requires Windows.')
  }
  if (typeof execFile !== 'function') {
    throw new TypeError('Windows window z-order collection requires an execFile function.')
  }

  const script = windowsWindowZOrderPowerShellScript()
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  const result = await execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedScript
    ],
    {
      encoding: 'utf8',
      maxBuffer: POWERSHELL_MAX_BUFFER_BYTES,
      windowsHide: true
    }
  )
  const stdout = typeof result === 'string' ? result : result?.stdout
  return parseWindowsWindowZOrderOutput(stdout)
}

export function parseWindowsWindowZOrderOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (!text) {
    throw new Error('Windows window z-order collector returned no JSON.')
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Windows window z-order collector returned invalid JSON: ${message(error)}`)
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.windows)) {
    throw new Error('Windows window z-order collector JSON omitted the windows array.')
  }

  return {
    startedAt: timestampOrNull(parsed.startedAt),
    sampledAt: timestampOrNull(parsed.sampledAt),
    completedAt: timestampOrNull(parsed.completedAt),
    enumWindowsSucceeded: parsed.enumWindowsSucceeded === true,
    windows: parsed.windows.map((window, index) => normalizeCollectedWindow(window, index))
  }
}

/**
 * Prove that every protected HWND is visible over its evidence crop and that
 * no visible window from an unrelated PID is above it and intersects that
 * crop. `zOrder = 0` is the top-most window.
 *
 * A protected entry has:
 *   { role, hwnd, pid, cropRect, expectedBounds? }
 *
 * `expectedBounds` is optional. The live HWND rectangle must always contain
 * `cropRect`; when expectedBounds is supplied it must additionally match it.
 */
export function evaluateWindowsWindowZOrder({
  snapshot,
  protectedWindows,
  allowedOwnedPids,
  boundsTolerancePx = 0
} = {}) {
  const blockers = []
  const occluders = []
  const protectedEvidence = []

  if (!isRecord(snapshot) || snapshot.enumWindowsSucceeded !== true) {
    blockers.push('EnumWindows did not report a successful snapshot')
  }
  if (!Array.isArray(snapshot?.windows)) {
    blockers.push('EnumWindows snapshot omitted the windows array')
  }
  if (!Array.isArray(protectedWindows) || protectedWindows.length === 0) {
    blockers.push('protected HWND identities were missing')
  }
  if (!Array.isArray(allowedOwnedPids) && !(allowedOwnedPids instanceof Set)) {
    blockers.push('allowed owned PID set was missing')
  }
  if (!Number.isFinite(boundsTolerancePx) || boundsTolerancePx < 0) {
    throw new Error('Windows z-order bounds tolerance must be a non-negative number.')
  }

  const ownedPids = new Set()
  for (const value of allowedOwnedPids ?? []) {
    const pid = normalizePid(value)
    if (pid === null) {
      blockers.push(`allowed owned PID ${String(value)} was invalid`)
    } else {
      ownedPids.add(pid)
    }
  }

  const windows = []
  const windowsByHwnd = new Map()
  if (Array.isArray(snapshot?.windows)) {
    for (const [index, value] of snapshot.windows.entries()) {
      const normalized = normalizeEvaluationWindow(value, index)
      if (normalized.blockers.length > 0) {
        blockers.push(...normalized.blockers.map((blocker) => `window ${index + 1}: ${blocker}`))
        continue
      }
      const window = normalized.window
      windows.push(window)
      const matching = windowsByHwnd.get(window.hwnd) ?? []
      matching.push(window)
      windowsByHwnd.set(window.hwnd, matching)
    }
  }

  const orderedZValues = windows.map((window) => window.zOrder)
  if (orderedZValues.length > 0 && orderedZValues.some((zOrder, index) => zOrder !== index)) {
    blockers.push('EnumWindows snapshot did not preserve contiguous top-to-bottom z-order')
  }
  for (const [hwnd, matches] of windowsByHwnd) {
    if (matches.length > 1) {
      blockers.push(`EnumWindows snapshot repeated HWND ${hwnd}`)
    }
  }

  const exactProtectedHwnds = new Set(
    (protectedWindows ?? []).map((window) => normalizeWindowsHwnd(window?.hwnd)).filter(Boolean)
  )
  const seenProtectedHwnds = new Set()
  for (const [index, expected] of (protectedWindows ?? []).entries()) {
    const role = nonEmptyString(expected?.role) ?? `protected-${index + 1}`
    const roleBlockers = []
    const hwnd = normalizeWindowsHwnd(expected?.hwnd)
    const expectedPid = normalizePid(expected?.pid)
    const cropRect = normalizeRectangle(
      expected?.cropRect ?? expected?.cropBounds ?? expected?.crop
    )
    const expectedBounds =
      expected?.expectedBounds === undefined ? null : normalizeRectangle(expected.expectedBounds)

    if (hwnd === null) roleBlockers.push('HWND identity was invalid')
    if (expectedPid === null) roleBlockers.push('PID identity was invalid')
    if (cropRect === null) roleBlockers.push('crop rectangle was invalid')
    if (expected?.expectedBounds !== undefined && expectedBounds === null) {
      roleBlockers.push('expected window bounds were invalid')
    }
    if (hwnd !== null && seenProtectedHwnds.has(hwnd)) {
      roleBlockers.push('HWND identity was repeated in the protected set')
    } else if (hwnd !== null) {
      seenProtectedHwnds.add(hwnd)
    }
    if (expectedPid !== null && !ownedPids.has(expectedPid)) {
      roleBlockers.push(`PID ${expectedPid} was not in the allowed owned PID set`)
    }

    const matches = hwnd === null ? [] : (windowsByHwnd.get(hwnd) ?? [])
    const actual = matches.length === 1 ? matches[0] : null
    if (matches.length === 0 && hwnd !== null) {
      roleBlockers.push(`HWND ${hwnd} was absent from EnumWindows`)
    } else if (matches.length > 1) {
      roleBlockers.push(`HWND ${hwnd} was ambiguous in EnumWindows`)
    }
    if (actual) {
      if (actual.pid !== expectedPid) {
        roleBlockers.push(
          `HWND ${actual.hwnd} belonged to PID ${actual.pid}, expected PID ${expectedPid}`
        )
      }
      if (actual.visible !== true) {
        roleBlockers.push(`HWND ${actual.hwnd} was not visible`)
      }
      if (actual.rectRead !== true || actual.bounds === null) {
        roleBlockers.push(`HWND ${actual.hwnd} bounds could not be read`)
      } else {
        if (cropRect !== null && !rectangleContains(actual.bounds, cropRect)) {
          roleBlockers.push(`HWND ${actual.hwnd} did not contain its protected crop`)
        }
        if (
          expectedBounds !== null &&
          !rectanglesApproximatelyEqual(actual.bounds, expectedBounds, boundsTolerancePx)
        ) {
          roleBlockers.push(`HWND ${actual.hwnd} bounds did not match expected placement`)
        }
      }

      if (cropRect !== null) {
        for (const higherWindow of windows) {
          if (higherWindow.zOrder >= actual.zOrder) break
          if (
            higherWindow.visible !== true ||
            higherWindow.hwnd === actual.hwnd ||
            exactProtectedHwnds.has(higherWindow.hwnd)
          ) {
            continue
          }
          if (higherWindow.rectRead !== true || higherWindow.bounds === null) {
            roleBlockers.push(
              `higher unprotected HWND ${higherWindow.hwnd} bounds could not be read`
            )
            continue
          }
          if (!rectanglesIntersect(higherWindow.bounds, cropRect)) continue
          const occluder = {
            protectedRole: role,
            protectedHwnd: actual.hwnd,
            hwnd: higherWindow.hwnd,
            pid: higherWindow.pid,
            zOrder: higherWindow.zOrder,
            bounds: higherWindow.bounds,
            cropRect
          }
          occluders.push(occluder)
          roleBlockers.push(
            `visible unprotected HWND ${higherWindow.hwnd} from PID ${higherWindow.pid} was higher in z-order and intersected the protected crop`
          )
        }
      }
    }

    blockers.push(...roleBlockers.map((blocker) => `${role}: ${blocker}`))
    protectedEvidence.push({
      role,
      hwnd,
      pid: expectedPid,
      cropRect,
      expectedBounds,
      actualWindow: actual,
      blockers: roleBlockers
    })
  }

  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    allowedOwnedPids: [...ownedPids].sort((left, right) => left - right),
    protectedWindows: protectedEvidence,
    occluders
  }
}

export function normalizeWindowsHwnd(value) {
  let numeric
  try {
    if (typeof value === 'bigint') {
      numeric = value
    } else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) return null
      numeric = BigInt(value)
    } else if (typeof value === 'string' && /^(?:0x[0-9a-f]+|\d+)$/i.test(value.trim())) {
      numeric = BigInt(value.trim())
    } else {
      return null
    }
  } catch {
    return null
  }
  if (numeric <= 0n || numeric > MAX_UINT64) return null
  return `0x${numeric.toString(16).padStart(16, '0')}`
}

function normalizeCollectedWindow(value, index) {
  if (!isRecord(value)) {
    throw new Error(`Windows window z-order entry ${index + 1} was not an object.`)
  }
  const hwnd = normalizeWindowsHwnd(value.hwnd)
  const pid = normalizePid(value.pid)
  const threadId = normalizePid(value.threadId)
  const zOrder = normalizeZOrder(value.zOrder)
  if (hwnd === null || pid === null || threadId === null || zOrder === null) {
    throw new Error(`Windows window z-order entry ${index + 1} had an invalid identity.`)
  }
  if (typeof value.visible !== 'boolean' || typeof value.rectRead !== 'boolean') {
    throw new Error(`Windows window z-order entry ${index + 1} had invalid Win32 state.`)
  }
  const bounds = value.rectRead ? normalizeWindowRectangle(value.bounds) : null
  if (value.rectRead && bounds === null) {
    throw new Error(`Windows window z-order entry ${index + 1} had invalid bounds.`)
  }
  return {
    zOrder,
    hwnd,
    pid,
    threadId,
    visible: value.visible,
    rectRead: value.rectRead,
    bounds
  }
}

function normalizeEvaluationWindow(value, index) {
  const blockers = []
  if (!isRecord(value)) {
    return { window: null, blockers: ['entry was not an object'] }
  }
  const hwnd = normalizeWindowsHwnd(value.hwnd)
  const pid = normalizePid(value.pid)
  const zOrder = normalizeZOrder(value.zOrder)
  const visible = value.visible
  const rectRead = value.rectRead
  const bounds = rectRead === true ? normalizeWindowRectangle(value.bounds) : null
  if (hwnd === null) blockers.push('HWND was invalid')
  if (pid === null) blockers.push('PID was invalid')
  if (zOrder === null) blockers.push('z-order index was invalid')
  if (typeof visible !== 'boolean') blockers.push('visibility state was invalid')
  if (typeof rectRead !== 'boolean') blockers.push('rectangle-read state was invalid')
  if (rectRead === true && bounds === null) blockers.push('bounds were invalid')
  return {
    window:
      blockers.length === 0
        ? {
            zOrder,
            hwnd,
            pid,
            threadId: normalizePid(value.threadId),
            visible,
            rectRead,
            bounds
          }
        : null,
    blockers: blockers.map((blocker) => `${blocker} at z-order input ${index}`)
  }
}

function normalizePid(value) {
  const numeric = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return Number.isInteger(numeric) && numeric > 0 && numeric <= MAX_UINT32 ? numeric : null
}

function normalizeZOrder(value) {
  const numeric = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null
}

function normalizeRectangle(value) {
  return normalizeRectangleWithMinimumSize(value, 1)
}

function normalizeWindowRectangle(value) {
  return normalizeRectangleWithMinimumSize(value, 0)
}

function normalizeRectangleWithMinimumSize(value, minimumSize) {
  if (!isRecord(value)) return null
  const x = Number(value.x)
  const y = Number(value.y)
  const width = Number(value.width)
  const height = Number(value.height)
  if (
    ![x, y, width, height].every(Number.isSafeInteger) ||
    width < minimumSize ||
    height < minimumSize
  ) {
    return null
  }
  return { x, y, width, height }
}

function rectanglesApproximatelyEqual(left, right, tolerance) {
  return (
    Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  )
}

function rectangleContains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

function rectanglesIntersect(left, right) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  )
}

function timestampOrNull(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
