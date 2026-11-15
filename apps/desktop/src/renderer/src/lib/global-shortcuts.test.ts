import { describe, expect, it, vi } from 'vitest'
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
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
  SCENE_SLOT_ACTIONS,
  globalShortcutEntries,
  isGlobalShortcutAction
} from '../../../shared/global-shortcuts'
import type { GlobalShortcutAction } from '../../../shared/global-shortcuts'

describe('global scene shortcuts', () => {
  it.each(['darwin', 'win32', 'linux'])('defaults all nine positions on %s', (platform) => {
    const entries = globalShortcutEntries({}, platform)
    expect(entries.filter(([action]) => action.startsWith('scene-slot-'))).toEqual(
      SCENE_SLOT_ACTIONS.map((action, index) => [
        action,
        `Control+Alt+${platform === 'darwin' ? '' : 'Shift+'}${index + 1}`
      ])
    )
    const changed = withGlobalShortcut({}, 'scene-slot-1', 'F13')
    const cleared = withGlobalShortcut(changed, 'scene-slot-2', '')
    expect(globalShortcutEntries(cleared, platform)).toContainEqual(['scene-slot-1', 'F13'])
    expect(globalShortcutEntries(cleared, platform)).toContainEqual(['scene-slot-2', ''])
    expect(globalShortcutEntries(cleared, platform)).toContainEqual([
      'scene-slot-3',
      `Control+Alt+${platform === 'darwin' ? '' : 'Shift+'}3`
    ])
  })

  it('resolves positions at the key press, follows a reorder, and ignores empty slots', () => {
    const switchScene = vi.fn()
    const context = {
      sessionActive: false,
      startRecording: vi.fn(),
      startLivestream: vi.fn(),
      stopSession: vi.fn(),
      toggleMicrophoneMute: vi.fn(),
      switchScene,
      scenes: [{ id: 'figma' }, { id: 't3' }]
    }
    executeGlobalShortcut('scene-slot-1', context)
    context.scenes.reverse()
    executeGlobalShortcut('scene-slot-1', context)
    executeGlobalShortcut('scene:figma', context)
    executeGlobalShortcut('scene-slot-9', context)
    executeGlobalShortcut('scene-slot-0' as GlobalShortcutAction, context)
    executeGlobalShortcut('scene-slot-10' as GlobalShortcutAction, context)
    executeGlobalShortcut('layout:screen-only' as GlobalShortcutAction, context)
    expect(switchScene.mock.calls).toEqual([['scene:figma'], ['scene:t3'], ['scene:figma']])
  })
  it('dispatches Next and Previous scene exactly once without microphone fallback', () => {
    const context = {
      sessionActive: false,
      startRecording: vi.fn(async () => true),
      startLivestream: vi.fn(async () => false),
      stopSession: vi.fn(),
      toggleMicrophoneMute: vi.fn(),
      markClip: vi.fn(),
      saveReplay: vi.fn(),
      switchScene: vi.fn()
    }
    for (const action of GLOBAL_SHORTCUT_ACTIONS.filter((action) => action.startsWith('layout')))
      executeGlobalShortcut(action, context)
    expect(context.switchScene).toHaveBeenCalledTimes(2)
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
    expect(context.switchScene).toHaveBeenCalledTimes(2)
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
    expect(globalShortcutEntries({})).toHaveLength(18)
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
      globalShortcutEntries({ layouts: { 'camera-only': 'Control+Alt+C' } }).some(([id]) =>
        id.startsWith('layout:')
      )
    ).toBe(false)
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

describe('withGlobalShortcut', () => {
  it('writes an action row or a position row and keeps every other binding', () => {
    const config = { recordToggle: 'Cmd+Shift+R', layouts: { 'screen-only': 'Ctrl+Alt+2' } }
    expect(withGlobalShortcut(config, 'mic-toggle', 'Cmd+Shift+M')).toEqual({
      ...config,
      micToggle: 'Cmd+Shift+M'
    })
    expect(withGlobalShortcut(config, 'scene-slot-3', 'Ctrl+Alt+3')).toEqual({
      recordToggle: 'Cmd+Shift+R',
      layouts: { 'screen-only': 'Ctrl+Alt+2' },
      sceneSlots: { 3: 'Ctrl+Alt+3' }
    })
    expect(withGlobalShortcut(config, 'record-toggle', '').recordToggle).toBe('')
    expect(withGlobalShortcut(undefined, 'layout-next', 'F13')).toEqual({ layoutNext: 'F13' })
  })
})

describe('globalShortcutLabel (plan 174 A-22)', () => {
  it('names what a shortcut does, never its id', () => {
    expect(globalShortcutLabel('stream-toggle')).toBe('Go Live / end livestream')
    expect(globalShortcutLabel('layout-next')).toBe('Next scene')
    expect(globalShortcutLabel('scene-slot-1')).toBe('Scene 1')
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

  it('says why set keys do nothing where the session cannot hold them, never "another app"', async () => {
    const unavailable = "Global shortcuts can't work in this Wayland session."
    const setGlobalShortcuts = vi.fn(async () => ({ registered: {}, unavailable }))
    vi.stubGlobal('window', Object.assign(new EventTarget(), { videorc: { setGlobalShortcuts } }))
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.warning).mockClear()
    try {
      const registrar = new GlobalShortcutsRegistrar()
      // Only the default Hide screen key: nothing the person set, no toast.
      registrar.sync({ recordToggle: '' })
      await vi.waitFor(() => expect(setGlobalShortcuts).toHaveBeenCalledTimes(1))
      await Promise.resolve()
      expect(toast.warning).not.toHaveBeenCalled()

      registrar.sync({ recordToggle: 'Control+Shift+R' })
      await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1))
      const [title, options] = vi.mocked(toast.warning).mock.calls[0] ?? []
      expect(title).toBe("Global shortcuts don't work here")
      expect(options?.description).toBe(unavailable)
      expect((options?.action as { label: string }).label).toBe('Open Shortcuts')
      expect(toast.error).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

it('dispatches saved-scene keys through the scene handler', () => {
  const switchScene = vi.fn()
  executeGlobalShortcut('scene:figma', {
    sessionActive: false,
    startRecording: vi.fn(),
    startLivestream: vi.fn(),
    stopSession: vi.fn(),
    toggleMicrophoneMute: vi.fn(),
    switchScene
  })
  expect(switchScene).toHaveBeenCalledWith('scene:figma')
})
