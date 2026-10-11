import { nextEligibleLayout } from '../../../shared/global-shortcuts'
import { describe, expect, it, vi } from 'vitest'
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
import { toast } from 'sonner'
import {
  executeGlobalShortcut,
  globalShortcutLabel,
  GlobalShortcutsRegistrar
} from './global-shortcuts'
import { withGlobalShortcut } from '../../../shared/global-shortcut-bindings'
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
      switchLayout: vi.fn()
    }
    for (const action of GLOBAL_SHORTCUT_ACTIONS.filter((action) => action.startsWith('layout')))
      executeGlobalShortcut(action, context)
    expect(context.switchLayout).toHaveBeenCalledTimes(12)
    expect(context.toggleMicrophoneMute).not.toHaveBeenCalled()
    executeGlobalShortcut('clip-mark', context)
    expect(context.markClip).toHaveBeenCalledOnce()
    expect(context.toggleMicrophoneMute).not.toHaveBeenCalled()
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
    expect(globalShortcutEntries({})).toHaveLength(17)
    // Plan 068 D6: Mark clip ships unbound.
    expect(globalShortcutEntries({}).find(([id]) => id === 'clip-mark')?.[1]).toBeUndefined()
    expect(withGlobalShortcut({}, 'clip-mark', 'Cmd+Shift+K').clipMark).toBe('Cmd+Shift+K')
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
      'System audio is not available on this computer'
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
    vi.mocked(toast.error).mockClear()
    try {
      new GlobalShortcutsRegistrar().sync({ recordToggle: 'Cmd+Shift+R' })
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))

      const [title, options] = vi.mocked(toast.error).mock.calls[0] ?? []
      expect(title).toBe("A global shortcut didn't register")
      expect(options?.description).toBe(
        'Record / stop recording: another app uses it, or the keys are taken twice. Choose different keys in Settings → Shortcuts.'
      )
      const action = options?.action as { label: string; onClick: () => void }
      expect(action.label).toBe('Open Shortcuts')
      action.onClick()
      expect(opened).toEqual([{ tab: 'settings', settingsTab: 'shortcuts' }])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
