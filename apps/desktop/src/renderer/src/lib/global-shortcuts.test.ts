import { nextEligibleLayout } from '../../../shared/global-shortcuts'
import { describe, expect, it, vi } from 'vitest'
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
// Plan 250: shortcuts that did not register are an entry behind the bell
// with Open Shortcuts. The door to the store is stubbed here.
const app = vi.hoisted(() => ({
  publishGlobalShortcutsProblem: vi.fn(),
  resolveGlobalShortcuts: vi.fn()
}))
vi.mock('@/lib/notify', () => ({
  withAppNotifications: (run: (source: typeof app) => void) => run(app)
}))
import { toast } from 'sonner'
import {
  executeGlobalShortcut,
  globalShortcutLabel,
  GlobalShortcutsRegistrar
} from './global-shortcuts'
import {
  isGlobalShortcutConfigKey,
  withGlobalShortcut
} from '../../../shared/global-shortcut-bindings'
import {
  GLOBAL_SHORTCUT_ACTIONS,
  globalShortcutEntries,
  isGlobalShortcutAction
} from '../../../shared/global-shortcuts'
import type { GlobalShortcutAction } from '../../../shared/global-shortcuts'

describe('global layout shortcuts', () => {
  it('dispatches every layout action exactly once without microphone fallback', () => {
    const context = {
      sessionActive: false,
      startRecording: vi.fn(async () => true),
      startLivestream: vi.fn(async () => false),
      stopSession: vi.fn(),
      toggleMicrophoneMute: vi.fn(),
      markClip: vi.fn(),
      saveReplay: vi.fn(),
      switchLayout: vi.fn()
    }
    for (const action of GLOBAL_SHORTCUT_ACTIONS.filter((action) => action.startsWith('layout')))
      executeGlobalShortcut(action, context)
    expect(context.switchLayout).toHaveBeenCalledTimes(12)
    expect(context.toggleMicrophoneMute).not.toHaveBeenCalled()
    executeGlobalShortcut('clip-mark', context)
    expect(context.markClip).toHaveBeenCalledOnce()
    // Plan 199: the existing key stays the 30-second clip (no length).
    expect(context.markClip).toHaveBeenLastCalledWith()
    expect(context.toggleMicrophoneMute).not.toHaveBeenCalled()
    // Plan 199 D5: the second key saves the minute.
    executeGlobalShortcut('clip-mark-long', context)
    expect(context.markClip).toHaveBeenCalledTimes(2)
    expect(context.markClip).toHaveBeenLastCalledWith(60)
    // Plan 181 (redesign R4): one clip action; a replay-save key never registers.
    executeGlobalShortcut('replay-save' as GlobalShortcutAction, context)
    expect(context.markClip).toHaveBeenCalledTimes(2)
    expect(globalShortcutEntries({}).some(([id]) => (id as string) === 'replay-save')).toBe(false)
    executeGlobalShortcut('invalid' as GlobalShortcutAction, context)
    expect(context.toggleMicrophoneMute).not.toHaveBeenCalled()
    expect(context.switchLayout).toHaveBeenCalledTimes(12)
    expect(context.startRecording).not.toHaveBeenCalled()
    expect(context.startLivestream).not.toHaveBeenCalled()
  })

  // Plan 174 S3.1 (B-3, A-3): the record key records and the Go Live key goes
  // live, whatever mode was saved last; while a session runs both stop it.
  // The hotkey never refuses on its own: a Go Live with no destination is the
  // provider's refusal ("Set up a destination to go live"), not the key's.
  it('starts the explicit intents idle and stops the session while active', () => {
    const idle = {
      sessionActive: false,
      startRecording: vi.fn(async () => true),
      startLivestream: vi.fn(async () => false),
      stopSession: vi.fn(async () => true),
      toggleMicrophoneMute: vi.fn()
    }
    executeGlobalShortcut('record-toggle', idle)
    expect(idle.startRecording).toHaveBeenCalledOnce()
    expect(idle.startLivestream).not.toHaveBeenCalled()
    executeGlobalShortcut('stream-toggle', idle)
    expect(idle.startLivestream).toHaveBeenCalledOnce()
    expect(idle.startRecording).toHaveBeenCalledOnce()
    expect(idle.stopSession).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalledWith(
      'Set up a destination to go live',
      expect.anything()
    )

    const active = { ...idle, sessionActive: true, stopSession: vi.fn(async () => true) }
    executeGlobalShortcut('record-toggle', active)
    executeGlobalShortcut('stream-toggle', active)
    expect(active.stopSession).toHaveBeenCalledTimes(2)
    expect(active.startRecording).toHaveBeenCalledOnce()
    expect(active.startLivestream).toHaveBeenCalledOnce()
  })
  it('keeps stable IDs, unassigned defaults and validates unknown actions', () => {
    expect(globalShortcutEntries({})).toHaveLength(19)
    // Plan 068 D6 / plan 181 R4: Save a clip ships unbound.
    expect(globalShortcutEntries({}).find(([id]) => id === 'clip-mark')?.[1]).toBeUndefined()
    expect(withGlobalShortcut({}, 'clip-mark', 'Cmd+Shift+K').clipMark).toBe('Cmd+Shift+K')
    // Plan 199 D5: the 1-minute clip ships unbound too, with its own key.
    expect(globalShortcutEntries({}).find(([id]) => id === 'clip-mark-long')?.[1]).toBeUndefined()
    expect(withGlobalShortcut({}, 'clip-mark-long', 'Cmd+Shift+M').clipMarkLong).toBe('Cmd+Shift+M')
    expect(
      globalShortcutEntries({ clipMark: 'Alt+C', clipMarkLong: 'Alt+M' }).filter(([id]) =>
        id.startsWith('clip-mark')
      )
    ).toEqual([
      ['clip-mark', 'Alt+C'],
      ['clip-mark-long', 'Alt+M']
    ])
    expect(isGlobalShortcutConfigKey('clipMarkLong')).toBe(true)
    expect(globalShortcutLabel('clip-mark')).toBe('Save a 30-second clip')
    expect(globalShortcutLabel('clip-mark-long')).toBe('Save a 1-minute clip')
    // Plan 069 S6: System audio ships unbound too.
    expect(
      globalShortcutEntries({}).find(([id]) => id === 'system-audio-toggle')?.[1]
    ).toBeUndefined()
    expect(withGlobalShortcut({}, 'system-audio-toggle', 'Cmd+Shift+A').systemAudioToggle).toBe(
      'Cmd+Shift+A'
    )
    expect(
      globalShortcutEntries({ layouts: { 'camera-only': 'Control+Alt+C' } }).find(
        ([id]) => id === 'layout:camera-only'
      )?.[1]
    ).toBe('Control+Alt+C')
    expect(isGlobalShortcutAction('layout:made-up')).toBe(false)
    expect(isGlobalShortcutAction('layout-next')).toBe(true)
  })
})

describe('system audio shortcut', () => {
  const base = () => ({
    sessionActive: false,
    startRecording: vi.fn(),
    startLivestream: vi.fn(),
    stopSession: vi.fn(),
    toggleMicrophoneMute: vi.fn(),
    setSystemAudioEnabled: vi.fn()
  })

  it('flips the state the Studio shows, idle or live, and never touches the mic', () => {
    const off = { ...base(), systemAudio: ['available', false] as const }
    executeGlobalShortcut('system-audio-toggle', off)
    expect(off.setSystemAudioEnabled).toHaveBeenCalledExactlyOnceWith(true)
    const on = { ...base(), sessionActive: true, systemAudio: ['available', true] as const }
    executeGlobalShortcut('system-audio-toggle', on)
    expect(on.setSystemAudioEnabled).toHaveBeenCalledExactlyOnceWith(false)
    expect(off.toggleMicrophoneMute).not.toHaveBeenCalled()
    expect(on.toggleMicrophoneMute).not.toHaveBeenCalled()
    expect(off.startRecording).not.toHaveBeenCalled()
    expect(off.startLivestream).not.toHaveBeenCalled()
  })

  it('is a no-op that says why when the device cannot run', () => {
    vi.mocked(toast.warning).mockClear()
    for (const systemAudio of [
      ['permission-required', false] as const,
      ['unavailable', true] as const,
      [undefined, false] as const
    ]) {
      const context = { ...base(), systemAudio }
      executeGlobalShortcut('system-audio-toggle', context)
      expect(context.setSystemAudioEnabled).not.toHaveBeenCalled()
    }
    expect(toast.warning).toHaveBeenCalledTimes(3)
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(
      'System audio needs Screen Recording access'
    )
    expect(vi.mocked(toast.warning).mock.calls[0][1]).toMatchObject({
      id: 'global-shortcut-system-audio'
    })
    expect(vi.mocked(toast.warning).mock.calls[1][0]).toBe(
      "System audio isn't available on this computer"
    )
  })
})

describe('layout cycle order', () => {
  it('wraps and finds the correct predecessor when the current layout is unavailable', () => {
    expect(
      nextEligibleLayout('camera-only', -1, ['screen-camera', 'screen-only', 'side-by-side'])
    ).toBe('screen-only')
    expect(nextEligibleLayout('screen-camera', -1, ['screen-camera', 'side-by-side'])).toBe(
      'side-by-side'
    )
    expect(
      nextEligibleLayout('vertical-camera-top', -1, ['vertical-camera-top', 'vertical-camera-only'])
    ).toBe('vertical-camera-only')
    expect(nextEligibleLayout('screen-only', 1, ['screen-only'])).toBeNull()
  })
})

describe('withGlobalShortcut', () => {
  it('writes an action row or a layout row and keeps every other binding', () => {
    const config = { recordToggle: 'Cmd+Shift+R', layouts: { 'screen-only': 'Ctrl+Alt+2' } }
    expect(withGlobalShortcut(config, 'mic-toggle', 'Cmd+Shift+M')).toEqual({
      ...config,
      micToggle: 'Cmd+Shift+M'
    })
    expect(withGlobalShortcut(config, 'layout:camera-only', 'Ctrl+Alt+3')).toEqual({
      recordToggle: 'Cmd+Shift+R',
      layouts: { 'screen-only': 'Ctrl+Alt+2', 'camera-only': 'Ctrl+Alt+3' }
    })
    expect(withGlobalShortcut(config, 'record-toggle', '').recordToggle).toBe('')
    expect(withGlobalShortcut(undefined, 'layout-next', 'F13')).toEqual({ layoutNext: 'F13' })
  })
})

describe('globalShortcutLabel (plan 174 A-22)', () => {
  it('names what a shortcut does, never its id', () => {
    expect(globalShortcutLabel('stream-toggle')).toBe('Go Live / end livestream')
    expect(globalShortcutLabel('layout-next')).toBe('Next scene')
    expect(globalShortcutLabel('layout:camera-only')).not.toContain('camera-only')
    // Out of its list, a vertical layout says so (plan 174 S2.3a).
    expect(globalShortcutLabel('layout:vertical-screen-camera')).toBe('Vertical screen + camera')
    expect(globalShortcutLabel('record-toggle')).toBe('Record / stop recording')
    expect(globalShortcutLabel('mic-toggle')).toBe('Mute / unmute microphone')
    expect(globalShortcutLabel('unknown-action')).toBe('unknown-action')
  })
})

describe('GlobalShortcutsRegistrar conflicts', () => {
  it('names the Shortcuts tab and offers a button that opens it (plan 064)', async () => {
    const target = new EventTarget()
    const opened: unknown[] = []
    target.addEventListener('videorc:navigate-workspace', (event) =>
      opened.push((event as CustomEvent).detail)
    )
    const setGlobalShortcuts = vi.fn(async () => ({ registered: { 'record-toggle': false } }))
    vi.stubGlobal('window', Object.assign(target, { videorc: { setGlobalShortcuts } }))
    app.publishGlobalShortcutsProblem.mockClear()
    app.resolveGlobalShortcuts.mockClear()
    try {
      const registrar = new GlobalShortcutsRegistrar()
      registrar.sync({ recordToggle: 'Cmd+Shift+R' })
      await vi.waitFor(() => expect(app.publishGlobalShortcutsProblem).toHaveBeenCalledTimes(1))
      expect(app.publishGlobalShortcutsProblem).toHaveBeenCalledWith({
        title: "A global shortcut didn't register",
        description:
          'Record / stop recording: another app uses it, or the keys are taken twice. Choose different keys in Settings → Shortcuts.'
      })
      // The entry's button is Open Shortcuts (`notifications/sources/app.ts`).
      const { publishGlobalShortcutsProblem } = await vi.importActual<
        typeof import('@/lib/notifications/sources/app')
      >('@/lib/notifications/sources/app')
      const { createNotificationStore } = await vi.importActual<
        typeof import('@/lib/notifications/store')
      >('@/lib/notifications/store')
      const store = createNotificationStore()
      publishGlobalShortcutsProblem({ title: 'x', description: 'y' }, store)
      expect(store.snapshot()[0].actions).toEqual([
        { id: 'open-shortcuts', label: 'Open Shortcuts', kind: 'door' }
      ])
      await store.runAction('global-shortcuts', 'open-shortcuts')
      expect(opened).toEqual([{ tab: 'settings', settingsTab: 'shortcuts' }])

      // A later registration that takes every key resolves the entry.
      setGlobalShortcuts.mockResolvedValueOnce({ registered: { 'record-toggle': true } })
      registrar.sync({ recordToggle: 'Cmd+Shift+F9' })
      await vi.waitFor(() => expect(app.resolveGlobalShortcuts).toHaveBeenCalledTimes(1))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('says why set keys do nothing where the session cannot hold them, never "another app"', async () => {
    const unavailable = "Global shortcuts can't work in this Wayland session."
    const setGlobalShortcuts = vi.fn(async () => ({ registered: {}, unavailable }))
    vi.stubGlobal('window', Object.assign(new EventTarget(), { videorc: { setGlobalShortcuts } }))
    app.publishGlobalShortcutsProblem.mockClear()
    try {
      const registrar = new GlobalShortcutsRegistrar()
      // Only the default Hide screen key: nothing the person set, no notice.
      registrar.sync({ recordToggle: '' })
      await vi.waitFor(() => expect(setGlobalShortcuts).toHaveBeenCalledTimes(1))
      await Promise.resolve()
      expect(app.publishGlobalShortcutsProblem).not.toHaveBeenCalled()

      registrar.sync({ recordToggle: 'Control+Shift+R' })
      await vi.waitFor(() => expect(app.publishGlobalShortcutsProblem).toHaveBeenCalledTimes(1))
      expect(app.publishGlobalShortcutsProblem).toHaveBeenCalledWith({
        title: "Global shortcuts don't work here",
        description: unavailable
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

it('dispatches saved-scene keys through the scene handler', () => {
  const switchLayout = vi.fn()
  executeGlobalShortcut('scene:figma', {
    sessionActive: false,
    startRecording: vi.fn(),
    startLivestream: vi.fn(),
    stopSession: vi.fn(),
    toggleMicrophoneMute: vi.fn(),
    switchLayout
  })
  expect(switchLayout).toHaveBeenCalledWith('scene:figma')
})

it('keeps the cloud record and live keys independent', () => {
  const context = {
    sessionActive: true,
    recordingActive: true,
    liveActive: true,
    startRecording: vi.fn(async () => true),
    startLivestream: vi.fn(async () => true),
    stopSession: vi.fn(async () => true),
    stopRecording: vi.fn(async () => true),
    toggleMicrophoneMute: vi.fn()
  }
  executeGlobalShortcut('record-toggle', context)
  expect(context.stopRecording).toHaveBeenCalledOnce()
  expect(context.stopSession).not.toHaveBeenCalled()
  executeGlobalShortcut('stream-toggle', context)
  expect(context.stopSession).toHaveBeenCalledOnce()
  executeGlobalShortcut('record-toggle', { ...context, recordingActive: false })
  expect(context.startRecording).toHaveBeenCalledOnce()
})
