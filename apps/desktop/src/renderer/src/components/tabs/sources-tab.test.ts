import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { systemAudioSwitchView, type SystemAudioSwitchInput } from '@/lib/system-audio'
import { SystemAudioSettings } from './sources-tab'

const noop = (): void => {}

function render(input: Partial<SystemAudioSwitchInput>, macOS = true, echoGuard = true): string {
  const view = systemAudioSwitchView({
    device: { status: 'available' },
    requested: false,
    sessionActive: false,
    confirmed: null,
    issue: null,
    ...input
  })
  return renderToStaticMarkup(
    createElement(SystemAudioSettings, {
      view,
      gainDb: -6,
      macOS,
      echoGuard,
      onEnabledChange: noop,
      onGainChange: noop,
      onEchoGuardChange: noop,
      onOpenPermissions: noop,
      onResume: noop
    })
  )
}

describe('Sources System audio settings (plan 069)', () => {
  it('shows the switch, the level at -6 dB and the helper line', () => {
    const markup = render({})
    expect(markup).toContain('System audio')
    expect(markup).toContain('aria-label="System audio"')
    expect(markup).toContain('Level')
    expect(markup).toContain('value="-6"')
    expect(markup).toContain(
      'Everything your computer plays, except Videorc, including your own stream if it is open in a browser tab: mute that tab, because headphones don&#x27;t stop it.'
    )
    expect(markup).toContain('Use headphones so your mic doesn&#x27;t pick up your speakers.')
    expect(markup).toContain(
      'Your Mac&#x27;s volume and mute don&#x27;t change what&#x27;s recorded.'
    )
  })

  it('states the Mac volume fact only on macOS', () => {
    expect(render({}, false)).not.toContain('volume and mute')
  })

  it('keeps Windows copy free of Mac and Screen Recording wording', () => {
    const idle = render({}, false)
    expect(idle).toContain('Everything your computer plays, except Videorc,')
    expect(idle).not.toContain('Screen Recording')
    const failed = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'unavailable' },
      false
    )
    expect(failed).toContain('System audio could not start.')
    expect(failed).not.toContain('Open Settings')
    const bypassed = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'bypassed' },
      false
    )
    expect(bypassed).toContain(
      'System audio is off for this session because the microphone is on a fallback input.'
    )
  })

  it('has the echo guard On by default, and it can be turned off (plan 076)', () => {
    const guard = /<button[^>]*aria-label="Pause System audio if your stream echoes back"[^>]*>/
    expect(render({}).match(guard)?.[0]).toContain('aria-checked="true"')
    expect(render({}, true, false).match(guard)?.[0]).toContain('aria-checked="false"')
  })

  it('offers Resume when the echo guard paused it (plan 076)', () => {
    const markup = render({ requested: true, sessionActive: true, confirmed: false, issue: 'echo' })
    expect(markup).toContain('coming back as an echo. Mute that tab, then resume.')
    expect(markup).toContain('>Resume<')
  })

  it('disables the switch and the level without Screen Recording permission', () => {
    const markup = render({ device: { status: 'permission-required' } })
    expect(markup).toContain('Needs Screen Recording permission')
    expect(markup).toContain('Open Settings')
    expect(markup).toMatch(/role="switch"[^>]*disabled=""/)
  })
})
