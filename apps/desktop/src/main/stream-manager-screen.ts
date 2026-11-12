// The Stream Manager Screen key (plan 230): the rules main applies on a tap
// (which screen, which frame, where the focus goes), on a hold (front or
// close), and for the screen list and the saved frames. Pure, so tested here.

import type {
  StreamManagerScreen,
  StreamManagerScreenOption,
  StreamManagerScreenRefusal,
  StreamManagerScreenRequest
} from '../shared/backend'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface StreamManagerPlace {
  open: boolean
  visible: boolean
  screenId: string | null
}

/** D3, the owner's call: closed, minimized or on a third screen, a tap
 * sends the window here. Change it with docs/remote-control.md and plan D3. */
export const SCREEN_FROM_ELSEWHERE: StreamManagerScreen = 'monitor'

/** Q13, the owner's call: on the Presenting screen the streamer answers
 * viewers, so the window takes the focus. `false` only means the window
 * does not take it; `focusAfterSwap` decides whether it is handed on. */
export const FOCUS_ON_ARRIVAL: Readonly<Record<StreamManagerScreen, boolean>> = {
  presenting: true,
  monitor: false
}

/** Q14: where a tap hands the focus on, if anywhere. */
export type FocusReturn = { kind: 'app'; bundleId: string; pid: number } | { kind: 'behind' } | null

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/

/** Q14: where a tap to the Monitor screen hands the focus while the Stream
 * Manager has it: the last app the streamer used that is not Videorc on
 * macOS (activated by pid and bundle id), the window behind on Windows
 * (`blur`), nothing on Linux. */
export function focusReturnTarget(
  platform: string,
  lastOther: { bundleId?: string | null; pid: number } | null,
  selfBundleIds: readonly string[]
): FocusReturn {
  if (platform === 'win32') return { kind: 'behind' }
  if (platform !== 'darwin' || !lastOther?.bundleId) return null
  if (!BUNDLE_ID.test(lastOther.bundleId) || selfBundleIds.includes(lastOther.bundleId)) {
    return null
  }
  return { kind: 'app', bundleId: lastOther.bundleId, pid: lastOther.pid }
}

/** Q13 and Q14 together: only a tap that sends a focused Stream Manager to
 * the Monitor screen hands the focus on. */
export function focusAfterSwap(swap: {
  to: StreamManagerScreen
  focused: boolean
  platform: string
  lastOther: { bundleId?: string | null; pid: number } | null
  selfBundleIds: readonly string[]
}): FocusReturn {
  if (swap.to !== 'monitor' || !swap.focused) return null
  return focusReturnTarget(swap.platform, swap.lastOther, swap.selfBundleIds)
}

export type StreamManagerScreenPlan =
  | { kind: 'move'; screen: StreamManagerScreen; screenId: string }
  | { kind: 'refuse'; reason: StreamManagerScreenRefusal }

function nextScreen(
  where: StreamManagerPlace,
  request: StreamManagerScreenRequest
): StreamManagerScreen {
  const shown = where.open && where.visible
  if (shown && where.screenId === request.presentingScreen) return 'monitor'
  if (shown && where.screenId === request.monitorScreen) return 'presenting'
  return SCREEN_FROM_ELSEWHERE
}

export function planStreamManagerScreenSwap(
  where: StreamManagerPlace,
  request: StreamManagerScreenRequest,
  screenIds: readonly string[]
): StreamManagerScreenPlan {
  if (request.presentingScreen === request.monitorScreen) {
    return { kind: 'refuse', reason: 'same-screen' }
  }
  if (![request.presentingScreen, request.monitorScreen].every((id) => screenIds.includes(id))) {
    return { kind: 'refuse', reason: 'screen-missing' }
  }
  const screen = nextScreen(where, request)
  const screenId = screen === 'presenting' ? request.presentingScreen : request.monitorScreen
  return { kind: 'move', screen, screenId }
}

/** A hold of the same key: close the window you are using, or bring it up. */
export function streamManagerHoldAction(window: {
  open: boolean
  visible: boolean
  focused: boolean
}): 'close' | 'front' {
  return window.open && window.visible && window.focused ? 'close' : 'front'
}

/** D4: the screen's own frame, else the current size centred on it. */
export function frameOnScreen(current: Rect, saved: Rect | undefined, workArea: Rect): Rect {
  const width = Math.min((saved ?? current).width, workArea.width)
  const height = Math.min((saved ?? current).height, workArea.height)
  const x = saved ? saved.x : workArea.x + Math.round((workArea.width - width) / 2)
  const y = saved ? saved.y : workArea.y + Math.round((workArea.height - height) / 2)
  return {
    width,
    height,
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height)
  }
}

interface DisplayLike {
  id: number
  label: string
  size: { width: number; height: number }
}

export function screenOptions(displays: readonly DisplayLike[]): StreamManagerScreenOption[] {
  const known = displays.filter((display) => display.id >= 0)
  const sizeOf = ({ size }: DisplayLike) => `${size.width} × ${size.height}`
  const count = (key: string, keys: string[]) => keys.filter((other) => other === key).length
  const labels = known.map(({ label }) => label)
  const looks = known.map((display) => `${display.label} (${sizeOf(display)})`)
  return known.map((display, index) => {
    const id = String(display.id)
    if (!display.label) return { id, name: `Screen ${index + 1}` }
    if (count(display.label, labels) === 1) return { id, name: display.label }
    if (count(looks[index], looks) === 1) return { id, name: looks[index] }
    const ordinal = count(looks[index], looks.slice(0, index + 1))
    return { id, name: `${display.label} ${ordinal} (${sizeOf(display)})` }
  })
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false
  const { x, y, width, height } = value as Record<string, unknown>
  return (
    [x, y, width, height].every((n) => Number.isInteger(n)) &&
    (width as number) > 0 &&
    (height as number) > 0
  )
}

/** The frames `comments-window.json` remembers per screen; a forged or
 * broken entry is dropped. */
export function screenFrames(value: unknown): Record<string, Rect> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const frames: Record<string, Rect> = {}
  for (const [id, frame] of Object.entries(value)) {
    if (isRect(frame)) {
      const { x, y, width, height } = frame
      frames[id] = { x, y, width, height }
    }
  }
  return frames
}
