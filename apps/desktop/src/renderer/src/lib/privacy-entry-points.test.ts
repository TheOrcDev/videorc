import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { globalShortcutEntries } from '../../../shared/global-shortcuts'
import { withGlobalShortcut } from '../../../shared/global-shortcut-bindings'
import { validateBackendEventPayload } from '../../../shared/backend-rpc-contract'
import { classifyComposerDraft } from '../../../shared/session-markers'

describe('Hide screen entry points', () => {
  it('defaults only unset keys, preserving an explicitly cleared key', () => {
    expect(globalShortcutEntries({})).toContainEqual(['screen-hide-toggle', 'Control+Alt+H'])
    const cleared = JSON.parse(JSON.stringify(withGlobalShortcut({}, 'screen-hide-toggle', '')))
    expect(globalShortcutEntries(cleared)).toContainEqual(['screen-hide-toggle', ''])
  })
  it('keeps slash commands local and supports escape', () => {
    expect(classifyComposerDraft('/hide')).toEqual({ kind: 'privacy', hidden: true })
    expect(classifyComposerDraft('/show')).toEqual({ kind: 'privacy', hidden: false })
    expect(classifyComposerDraft('//hide')).toEqual({ kind: 'chat', text: '/hide' })
  })
  it('has a stateful search command and Settings registration failure', () => {
    const palette = readFileSync('src/renderer/src/components/command-palette.tsx', 'utf8')
    expect(palette).toContain("screenPrivacy.hidden ? 'Show screen' : 'Hide screen'")
    expect(palette).toContain('settings.globalShortcuts?.screenHideToggle')
    const settings = readFileSync(
      'src/renderer/src/components/settings/shortcuts-settings.tsx',
      'utf8'
    )
    expect(settings).toContain("'screen-hide-toggle'")
    expect(settings).toContain('registrationFailed={shortcutRegistration[action] === false}')
  })
})

it('validates privacy on remote.state while preserving the existing projection', () => {
  const state = { screenHidden: true, sessionState: 'idle', micMuted: false }
  expect(validateBackendEventPayload('remote.state', state)).toEqual(state)
  expect(() => validateBackendEventPayload('remote.state', { screenHidden: 'true' })).toThrow()
})
