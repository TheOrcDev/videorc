// The Stream Manager Screen key (plan 230): the rules main applies on a tap
// (which screen, which frame, where the focus goes), on a hold (front or
// close), and for the screen list and the saved frames. Pure, so tested here.

import type {
  StreamManagerScreen,
  StreamManagerScreenOption,
  StreamManagerScreenRefusal,
  StreamManagerScreenMoves,
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
 * (`blur`, past Videorc's own windows: `handFocusPastOwnWindows`), nothing
 * on Linux. */
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

/** Q13 and Q14 together: only a tap that sends the Stream Manager to the
 * Monitor screen hands the focus on, and only when the window has the focus
 * or may take it on the way: a minimized window is restored, and on macOS
 * `restore()` activates Videorc. */
export function focusAfterSwap(swap: {
  to: StreamManagerScreen
  focused: boolean
  minimized?: boolean
  platform: string
  lastOther: { bundleId?: string | null; pid: number } | null
  selfBundleIds: readonly string[]
}): FocusReturn {
  if (swap.to !== 'monitor' || !(swap.focused || swap.minimized)) return null
  return focusReturnTarget(swap.platform, swap.lastOther, swap.selfBundleIds)
}

export interface ShowableWindow {
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  showInactive(): void
}

/** Shows an open Stream Manager, with or without the focus. Without it, a
 * minimized window on Windows comes back through `showInactive()`
 * (`SW_SHOWNOACTIVATE`), since `restore()` activates it there. macOS and
 * Linux still need `restore()` to bring a window out of the Dock or the
 * panel; on macOS `runStreamManagerScreenSwap` hands the focus back after. */
export function showStreamManagerWindow(
  window: ShowableWindow,
  focus: boolean,
  platform: string
): void {
  if (window.isMinimized() && (focus || platform !== 'win32')) {
    window.restore()
  }
  if (focus) {
    window.show()
    window.focus()
  } else {
    window.showInactive()
  }
}

export type StreamManagerMoveResult = 'moved' | 'not-moved' | 'screen-missing'

/** A tap's steps in order (plan 230), with main's window calls injected so
 * the focus rules are tested end to end. */
export async function runStreamManagerScreenSwap(io: {
  plan: { screen: StreamManagerScreen; screenId: string }
  platform: string
  window: () => { isFocused(): boolean; isMinimized(): boolean } | null
  /** Videorc's focused window (the Studio, the preview), if any. */
  focusedOwnWindow: () => { focus(): void } | null
  lastOther: { bundleId?: string | null; pid: number } | null
  selfBundleIds: readonly string[]
  placeMinimized: (screenId: string) => void
  open: (options: { focus: boolean; screenId: string }) => Promise<unknown>
  move: (screenId: string) => StreamManagerMoveResult
  giveFocusBack: (target: Exclude<FocusReturn, null>) => unknown
  warn: (message: string) => void
}): Promise<
  { ok: true; screen: StreamManagerScreen } | { ok: false; reason: 'not-moved' | 'screen-missing' }
> {
  const { plan } = io
  const before = io.window()
  const focused = Boolean(before?.isFocused())
  const minimized = Boolean(before?.isMinimized())
  // The streamer works in another Videorc window: a restore that takes the
  // focus gives it back to that window, not to the app used before Videorc.
  const ownBefore = focused || !minimized ? null : io.focusedOwnWindow()
  // Worked out before anything moves: the restore below may take the focus.
  const giveBack = focusAfterSwap({
    to: plan.screen,
    focused,
    minimized: minimized && !ownBefore,
    platform: io.platform,
    lastOther: io.lastOther,
    selfBundleIds: io.selfBundleIds
  })
  if (plan.screen === 'monitor' && focused && !giveBack && io.platform !== 'linux') {
    io.warn('[stream-manager] no app to hand the focus to; it stays on the window')
  }
  // D3: a minimized window restores where it already is, so it goes to its
  // screen first; otherwise viewers would see it on the old one.
  io.placeMinimized(plan.screenId)
  await io.open({ focus: FOCUS_ON_ARRIVAL[plan.screen], screenId: plan.screenId })
  const moved = io.move(plan.screenId)
  if (moved !== 'moved') {
    return { ok: false, reason: moved }
  }
  // A window that never had the focus and did not take it keeps its hands
  // off: a `blur()` on Windows would push the focus down the z-order. On
  // macOS the activation after a restore can land late, so a minimized
  // window always hands it back to the app the streamer used last.
  if (giveBack && (focused || giveBack.kind === 'app' || io.window()?.isFocused())) {
    await io.giveFocusBack(giveBack)
  } else if (ownBefore && plan.screen === 'monitor' && io.window()?.isFocused()) {
    ownBefore.focus()
  }
  return { ok: true, screen: plan.screen }
}

/** Q14 on Windows: `blur()` activates the next visible window in the
 * z-order, which can be Videorc's own main or preview window rather than
 * the app the streamer presents from. Windows lets no app read or pick that
 * app, so each Videorc window that ends up with the focus is blurred in
 * turn until the focus leaves Videorc. `maxSteps` bounds it (one per
 * Videorc window). True when the focus left Videorc. */
export async function handFocusPastOwnWindows(io: {
  first: { blur(): void }
  focusedOwnWindow: () => { blur(): void } | null
  settle: () => Promise<void>
  maxSteps: number
}): Promise<boolean> {
  io.first.blur()
  for (let step = 0; step < io.maxSteps; step += 1) {
    await io.settle()
    const focused = io.focusedOwnWindow()
    if (!focused) return true
    focused.blur()
  }
  await io.settle()
  return io.focusedOwnWindow() === null
}

/** Windows across displays with different scale factors: one `setBounds`
 * can land the right spot with the size scaled by the old display's DPI,
 * so a frame that came out different is set once more on the new display. */
export function setBoundsExactly(
  window: { setBounds(frame: Rect): void; getBounds(): Rect },
  frame: Rect
): boolean {
  window.setBounds(frame)
  if (sameRect(window.getBounds(), frame)) return true
  window.setBounds(frame)
  return sameRect(window.getBounds(), frame)
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Wayland gives no app a say in where its window goes: `setBounds` keeps
 * the size and drops the position. The key's tap is X11, macOS and Windows
 * only; a hold still works. `ozonePlatform` is Electron's resolved
 * `ozone-platform` switch, the same test the global shortcuts use. */
export function streamManagerScreenMoves(input: {
  platform: string
  ozonePlatform: string
}): StreamManagerScreenMoves {
  return input.platform === 'linux' && input.ozonePlatform.trim().toLowerCase() === 'wayland'
    ? 'wayland'
    : 'supported'
}

/** D4 after a display change: frames stay held until the streamer places
 * the window by hand (`will-move`/`will-resize`). Linux sends neither, so
 * there the hold ends with its time window instead of lasting for good. */
export function framesHeldBySystem(input: {
  platform: string
  placedBySystem: boolean
  now: number
  heldUntil: number
}): boolean {
  if (!input.placedBySystem) return false
  return !(input.platform === 'linux' && input.now >= input.heldUntil)
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
