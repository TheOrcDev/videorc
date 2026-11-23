import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  chromaKeyHex,
  greenScreenColor,
  greenScreenCommandLabel,
  greenScreenLabel,
  openSceneBackground,
  requestSceneBackground,
  SCENE_BACKGROUND_EVENT,
  takeSceneBackgroundRequest
} from './green-screen'
import { WORKSPACE_NAVIGATE_EVENT } from './workspace-navigation'

describe('green screen words', () => {
  it('reads the key colour in either case', () => {
    expect(greenScreenColor({ cameraChromaKeyColor: '#0000FF' })).toBe('blue')
    expect(greenScreenColor({ cameraChromaKeyColor: '#0000ff' })).toBe('blue')
    expect(greenScreenColor({ cameraChromaKeyColor: '#00ff00' })).toBe('green')
    expect(chromaKeyHex('blue')).toBe('#0000FF')
    expect(chromaKeyHex('green')).toBe('#00FF00')
  })

  it('says Blue screen only while a blue key is on', () => {
    const blue = { cameraChromaKeyColor: '#0000FF' }
    expect(greenScreenLabel({ ...blue, cameraChromaKeyEnabled: true })).toBe('Blue screen')
    expect(greenScreenLabel({ ...blue, cameraChromaKeyEnabled: false })).toBe('Green screen')
    expect(greenScreenCommandLabel({ ...blue, cameraChromaKeyEnabled: true })).toBe(
      'Turn off blue screen'
    )
    expect(
      greenScreenCommandLabel({ cameraChromaKeyColor: '#00FF00', cameraChromaKeyEnabled: false })
    ).toBe('Turn on green screen')
  })
})

describe('the Scene page request for the camera’s Background section', () => {
  afterEach(() => {
    takeSceneBackgroundRequest()
    vi.unstubAllGlobals()
  })

  function stubWindow(): string[] {
    const events: string[] = []
    vi.stubGlobal('window', {
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      }
    })
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(readonly type: string) {}
      }
    )
    return events
  }

  it('waits for the page and is taken once', () => {
    const events = stubWindow()
    requestSceneBackground()
    expect(events).toEqual([SCENE_BACKGROUND_EVENT])
    expect(takeSceneBackgroundRequest()).toBe(true)
    expect(takeSceneBackgroundRequest()).toBe(false)
  })

  it('asks first, then opens the Scene page', () => {
    const events = stubWindow()
    openSceneBackground()
    expect(events).toEqual([SCENE_BACKGROUND_EVENT, WORKSPACE_NAVIGATE_EVENT])
    expect(takeSceneBackgroundRequest()).toBe(true)
  })
})
