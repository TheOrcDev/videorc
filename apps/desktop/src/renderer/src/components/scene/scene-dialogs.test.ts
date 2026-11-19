import { describe, expect, it } from 'vitest'

import { sceneKeyDescription } from './scene-dialogs'

// Linux L-01: on Wayland main registers no global shortcut, so the Set key
// dialog must not promise the key works from any app. Elsewhere it is unchanged.
describe('sceneKeyDescription', () => {
  it('keeps the original copy where global shortcuts can work', () => {
    const original = 'Puts “Talk” on stream from any app. Click the field and press the keys.'
    expect(sceneKeyDescription('Talk')).toBe(original)
    expect(sceneKeyDescription('Talk', null)).toBe(original)
  })

  it('does not promise "from any app" when global shortcuts are unavailable', () => {
    const copy = sceneKeyDescription('Talk', "Global shortcuts can't work in this Wayland session.")
    expect(copy).not.toContain('from any app')
    expect(copy).toContain('“Talk”')
    expect(copy).toContain('Click the field and press the keys.')
  })
})
