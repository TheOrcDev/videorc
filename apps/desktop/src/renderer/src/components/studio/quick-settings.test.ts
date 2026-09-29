import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { systemAudioSwitchView, type SystemAudioSwitchInput } from '@/lib/system-audio'
import { SystemAudioInspectorValue } from './quick-settings'

const noop = (): void => {}

function render(input: Partial<SystemAudioSwitchInput>): string {
  const view = systemAudioSwitchView({
    device: { status: 'available' },
    requested: false,
    sessionActive: false,
    confirmed: null,
    issue: null,
    ...input
  })
  return renderToStaticMarkup(
    createElement(SystemAudioInspectorValue, {
      view,
      onEnabledChange: noop,
      onOpenPermissions: noop,
      onResume: noop
    })
  )
}

describe('Studio inputs System audio row (plan 069)', () => {
  it('shows Off and On beside a labelled switch', () => {
    expect(render({})).toContain('>Off<')
    expect(render({})).toContain('aria-label="System audio"')
    expect(render({ requested: true })).toContain('>On<')
    expect(render({ requested: true })).toContain('aria-checked="true"')
  })

  it('offers the permission route instead of a switch without Screen Recording', () => {
    const markup = render({ device: { status: 'permission-required' }, requested: true })
    expect(markup).toContain('Needs permission')
    expect(markup).not.toContain('role="switch"')
  })

  it('keeps a lost source On with a short status and the full copy on hover', () => {
    const markup = render({ requested: true, sessionActive: true, confirmed: false, issue: 'lost' })
    expect(markup).toContain('>Stopped<')
    expect(markup).toContain('title="System audio stopped. The session keeps going."')
    expect(markup).toContain('aria-checked="true"')
  })

  it('puts Resume where the status goes when the echo guard paused it (plan 076)', () => {
    const markup = render({ requested: true, sessionActive: true, confirmed: false, issue: 'echo' })
    expect(markup).toContain('>Resume<')
    expect(markup).toContain('coming back as an echo')
    expect(markup).toContain('aria-checked="true"')
  })

  it('says a fallback microphone keeps system audio out of this session', () => {
    const markup = render({
      requested: true,
      sessionActive: true,
      confirmed: false,
      issue: 'bypassed'
    })
    expect(markup).toContain('>Off for this session<')
    expect(markup).toContain(
      'title="System audio is off for this session because the microphone is on a fallback input."'
    )
  })
})
