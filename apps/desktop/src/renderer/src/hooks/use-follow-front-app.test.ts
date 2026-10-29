// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultCaptureConfig } from '@/lib/capture'
import {
  FOLLOW_SETTINGS_STORAGE_KEY,
  resetFollowSettingsForTest,
  setFollowFrontApp,
  updateFollowSettings
} from '@/lib/follow-settings'
import {
  PRIVACY_SETTINGS_STORAGE_KEY,
  resetPrivacySettingsForTest,
  setHideForPasswordManagers,
  updatePrivacySettings
} from '@/lib/privacy-settings'
import { normalizeSceneVisual, type SavedScene, type VisualSources } from '@/lib/scene-presets'
import type { FrontAppChanged } from '../../../shared/front-app'
import {
  FOLLOW_SETTLE_MS,
  useFollowFrontApp,
  type FollowFrontAppHost
} from './use-follow-front-app'

const VIDEORC = 'dev.theorcdev.videorc'
const ONE_PASSWORD = 'com.1password.1password'

const scene = (id: string, sources: VisualSources, preset = 'screen-camera'): SavedScene => ({
  id,
  name: id,
  createdAt: '2026-10-29',
  updatedAt: '2026-10-29',
  visual: normalizeSceneVisual({
    layout: { ...defaultCaptureConfig.layout, layoutPreset: preset as never },
    sources: { cameraId: 'camera', ...sources },
    background: null
  })
})
const figma = scene('figma', {
  windowId: 'window:screencapturekit:7',
  app: { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
})
const code = scene('code', {
  windowId: 'window:screencapturekit:8',
  app: { bundleId: 'com.t3.code', name: 'T3 Code', follows: true }
})
const desk = scene('desk', { screenId: 'screen:screencapturekit:1', screenName: 'Display 1' })

type Fake = {
  emit: (event: FrontAppChanged) => void
  watch: ReturnType<typeof vi.fn>
  applyScene: ReturnType<typeof vi.fn>
  hideScreen: ReturnType<typeof vi.fn>
  showScreen: ReturnType<typeof vi.fn>
  manual: (sceneId: string) => void
  host: FollowFrontAppHost
}

let root: Root
let container: HTMLDivElement
let fake: Fake
let offFront: ReturnType<typeof vi.fn>

function makeHost(overrides: Partial<FollowFrontAppHost> = {}): Fake {
  let listener: ((event: FrontAppChanged) => void) | null = null
  const manualListeners = new Set<(sceneId: string) => void>()
  offFront = vi.fn()
  const watch = vi.fn(async () => undefined)
  const applyScene = vi.fn(async () => ({ ok: true }))
  const hideScreen = vi.fn(async () => undefined)
  const showScreen = vi.fn(async () => undefined)
  const host: FollowFrontAppHost = {
    enabled: true,
    scenes: [figma, code, desk],
    activeSceneId: 'figma',
    sources: { windowId: 'window:screencapturekit:7' },
    sessionState: 'idle',
    orientation: 'horizontal',
    screenPrivacy: { hidden: false },
    hideScreen,
    showScreen,
    applyScene,
    subscribeManualApply: (callback) => {
      manualListeners.add(callback)
      return () => manualListeners.delete(callback)
    },
    api: {
      onFrontAppChanged: (callback) => {
        listener = callback
        return offFront
      },
      setFrontWindowWatch: watch,
      getSelfBundleIds: async () => [VIDEORC]
    },
    ...overrides
  }
  return {
    emit: (event) => listener?.(event),
    watch,
    applyScene,
    hideScreen,
    showScreen,
    manual: (sceneId) => manualListeners.forEach((callback) => callback(sceneId)),
    host
  }
}

function Probe({ host }: { host: FollowFrontAppHost }) {
  useFollowFrontApp(host)
  return null
}
const render = (host: FollowFrontAppHost) =>
  act(async () => root.render(createElement(Probe, { host })))
const front = (bundleId: string, frontWindowId?: string, pid = 1): FrontAppChanged => ({
  bundleId,
  name: bundleId,
  pid,
  frontWindowId,
  at: Date.now()
})
const emit = (event: FrontAppChanged) => act(async () => fake.emit(event))
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(FOLLOW_SETTLE_MS + 5)
  })
const switchTo = async (bundleId: string, windowId?: string): Promise<void> => {
  await emit(front(bundleId, windowId))
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'debug').mockImplementation(() => undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  fake = makeHost()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.removeItem(FOLLOW_SETTINGS_STORAGE_KEY)
  localStorage.removeItem(PRIVACY_SETTINGS_STORAGE_KEY)
  resetFollowSettingsForTest()
  resetPrivacySettingsForTest()
})

describe('the stream follows the app in front (plan 210 S10, D10)', () => {
  it('switches to the scene made for an app once it has stayed in front 400 ms', async () => {
    await render(fake.host)
    await emit(front('com.t3.code', 'window:screencapturekit:8'))
    expect(fake.applyScene).not.toHaveBeenCalled()
    await settle()
    expect(fake.applyScene).toHaveBeenCalledExactlyOnceWith('code')
  })

  it('lets a ⌘-Tab pass-through shorter than the settle gate through without a switch', async () => {
    await render(fake.host)
    await emit(front('com.t3.code', 'window:screencapturekit:8'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    await emit(front('com.figma.Desktop', 'window:screencapturekit:7'))
    await settle()
    expect(fake.applyScene).not.toHaveBeenCalled()
  })

  it('keeps the scene while Videorc itself is in front', async () => {
    await render(fake.host)
    await switchTo(VIDEORC, 'window:screencapturekit:99')
    expect(fake.applyScene).not.toHaveBeenCalled()
  })

  it('keeps the scene for an app without one', async () => {
    await render(fake.host)
    await switchTo('com.apple.Safari', 'window:screencapturekit:50')
    expect(fake.applyScene).not.toHaveBeenCalled()
  })

  it('holds a scene the streamer picked until the next app change', async () => {
    await render(fake.host)
    await switchTo('com.t3.code', 'window:screencapturekit:8')
    expect(fake.applyScene).toHaveBeenCalledTimes(1)
    await act(async () => fake.manual('desk'))
    await render({
      ...fake.host,
      activeSceneId: 'desk',
      sources: { screenId: 'screen:screencapturekit:1' }
    })
    // The follower's own apply is never a manual one: it was marked `follow`.
    await settle()
    expect(fake.applyScene).toHaveBeenCalledTimes(1)
    // Still T3 Code in front, another window: the hold stands.
    await switchTo('com.t3.code', 'window:screencapturekit:9')
    expect(fake.applyScene).toHaveBeenCalledTimes(1)
    // The next app change follows again.
    await switchTo('com.figma.Desktop', 'window:screencapturekit:7')
    expect(fake.applyScene).toHaveBeenLastCalledWith('figma')
  })

  it('swaps to the window in front of the active app scene, preferring that window id', async () => {
    await render(fake.host)
    await switchTo('com.figma.Desktop', 'window:screencapturekit:12')
    expect(fake.applyScene).toHaveBeenCalledExactlyOnceWith('figma', 'window:screencapturekit:12')
  })

  it('never crosses orientation', async () => {
    await render({ ...fake.host, orientation: 'vertical' })
    await switchTo('com.t3.code', 'window:screencapturekit:8')
    expect(fake.applyScene).not.toHaveBeenCalled()
  })

  it('stops switching with Follow off, and starts again when it comes back on', async () => {
    updateFollowSettings((current) => setFollowFrontApp(current, false))
    await render(fake.host)
    await switchTo('com.t3.code', 'window:screencapturekit:8')
    expect(fake.applyScene).not.toHaveBeenCalled()
    await act(async () => updateFollowSettings((current) => setFollowFrontApp(current, true)))
    expect(fake.applyScene).toHaveBeenCalledExactlyOnceWith('code')
  })

  it('subscribes nowhere off macOS', async () => {
    await render({ ...fake.host, enabled: false })
    expect(fake.watch).not.toHaveBeenCalled()
    await switchTo('com.t3.code', 'window:screencapturekit:8')
    expect(fake.applyScene).not.toHaveBeenCalled()
  })
})

describe('the front-window watch (plan 210 S9)', () => {
  it('is on only while a scene made for an app is on program with Follow on', async () => {
    await render(fake.host)
    expect(fake.watch).toHaveBeenLastCalledWith(true)
    await render({ ...fake.host, activeSceneId: 'desk', sources: { screenId: 'screen:1' } })
    expect(fake.watch).toHaveBeenLastCalledWith(false)
    await render(fake.host)
    expect(fake.watch).toHaveBeenLastCalledWith(true)
    await act(async () => updateFollowSettings((current) => setFollowFrontApp(current, false)))
    expect(fake.watch).toHaveBeenLastCalledWith(false)
    await act(async () => updateFollowSettings((current) => setFollowFrontApp(current, true)))
    expect(fake.watch).toHaveBeenLastCalledWith(true)
    fake.watch.mockClear()
    await act(async () => root.unmount())
    expect(fake.watch).toHaveBeenLastCalledWith(false)
    expect(offFront).toHaveBeenCalled()
    root = createRoot(container)
  })
})

describe('Hide screen for a password manager (plan 210 S10, D11)', () => {
  const onDisplay = (): FollowFrontAppHost => ({
    ...fake.host,
    activeSceneId: 'desk',
    sources: { screenId: 'screen:screencapturekit:1' }
  })

  it('hides a display scene while a password manager is in front, then shows it again', async () => {
    const host = onDisplay()
    await render(host)
    await switchTo(ONE_PASSWORD, 'window:screencapturekit:70')
    expect(fake.hideScreen).toHaveBeenCalledExactlyOnceWith('password-manager')
    await render({ ...host, screenPrivacy: { hidden: true, reason: 'password-manager' } })
    await switchTo('com.apple.Safari', 'window:screencapturekit:50')
    expect(fake.showScreen).toHaveBeenCalledTimes(1)
  })

  it('hides before the settle, and shows again only after another app has held the front for it', async () => {
    const host = onDisplay()
    await render(host)
    // D11: the manager's window never goes on air for the settle.
    await emit(front(ONE_PASSWORD, 'window:screencapturekit:70'))
    expect(fake.hideScreen).toHaveBeenCalledExactlyOnceWith('password-manager')
    await render({ ...host, screenPrivacy: { hidden: true, reason: 'password-manager' } })
    // A ⌘-Tab pass through Safari and back never shows the screen between.
    await emit(front('com.apple.Safari', 'window:screencapturekit:50'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(fake.showScreen).not.toHaveBeenCalled()
    await emit(front(ONE_PASSWORD, 'window:screencapturekit:70'))
    await settle()
    expect(fake.showScreen).not.toHaveBeenCalled()
    expect(fake.hideScreen).toHaveBeenCalledTimes(1)
    // Safari holding the front for the settle shows it.
    await emit(front('com.apple.Safari', 'window:screencapturekit:50'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOLLOW_SETTLE_MS - 50)
    })
    expect(fake.showScreen).not.toHaveBeenCalled()
    await settle()
    expect(fake.showScreen).toHaveBeenCalledTimes(1)
  })

  it('never hides for a window or app scene', async () => {
    await render(fake.host)
    await switchTo(ONE_PASSWORD, 'window:screencapturekit:70')
    expect(fake.hideScreen).not.toHaveBeenCalled()
  })

  it('never shows a screen the streamer hid', async () => {
    const host = onDisplay()
    await render({ ...host, screenPrivacy: { hidden: true, reason: 'you' } })
    await switchTo(ONE_PASSWORD, 'window:screencapturekit:70')
    expect(fake.hideScreen).not.toHaveBeenCalled()
    await switchTo('com.apple.Safari', 'window:screencapturekit:50')
    expect(fake.showScreen).not.toHaveBeenCalled()
  })

  it('shows only while the hide is still the password manager’s', async () => {
    const host = onDisplay()
    await render(host)
    await switchTo(ONE_PASSWORD, 'window:screencapturekit:70')
    // The streamer took over the hide (⌃⌥H) before the manager left the front.
    await render({ ...host, screenPrivacy: { hidden: true, reason: 'you' } })
    await switchTo('com.apple.Safari', 'window:screencapturekit:50')
    expect(fake.showScreen).not.toHaveBeenCalled()
  })

  it('keeps hiding with Follow off, and stops with its own switch off', async () => {
    updateFollowSettings((current) => setFollowFrontApp(current, false))
    const host = onDisplay()
    await render(host)
    await switchTo(ONE_PASSWORD, 'window:screencapturekit:70')
    expect(fake.hideScreen).toHaveBeenCalledTimes(1)
    expect(fake.applyScene).not.toHaveBeenCalled()
    await render({ ...host, screenPrivacy: { hidden: true, reason: 'password-manager' } })
    await switchTo('com.apple.Safari', 'window:screencapturekit:50')
    expect(fake.showScreen).toHaveBeenCalledTimes(1)
    await render(host)
    updatePrivacySettings((current) => setHideForPasswordManagers(current, false))
    await switchTo(ONE_PASSWORD, 'window:screencapturekit:71')
    expect(fake.hideScreen).toHaveBeenCalledTimes(1)
  })
})
