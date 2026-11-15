import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  chromaKeyHex,
  greenScreenColor,
  greenScreenCommandLabel,
  greenScreenLabel,
  openSceneGreenScreen,
  requestSceneGreenScreen,
  SCENE_GREEN_SCREEN_EVENT,
  takeSceneGreenScreenRequest
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

describe('the Scene page request', () => {
  afterEach(() => {
    takeSceneGreenScreenRequest()
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
    requestSceneGreenScreen()
    expect(events).toEqual([SCENE_GREEN_SCREEN_EVENT])
    expect(takeSceneGreenScreenRequest()).toBe(true)
    expect(takeSceneGreenScreenRequest()).toBe(false)
  })

  it('asks first, then opens the Scene page', () => {
    const events = stubWindow()
    openSceneGreenScreen()
    expect(events).toEqual([SCENE_GREEN_SCREEN_EVENT, WORKSPACE_NAVIGATE_EVENT])
    expect(takeSceneGreenScreenRequest()).toBe(true)
  })
})
