import { describe, expect, it } from 'vitest'
import { defaultCaptureConfig } from './capture'
import { scenesForApps } from './scene-apps'
import {
  DEFAULT_PASSWORD_MANAGER_BUNDLE_IDS,
  initialFollowFrontAppState,
  reduceFollowFrontApp,
  type FollowFrontAppContext,
  type FollowFrontAppEvent,
  type FollowFrontAppState
} from './follow-front-app'

const front = { bundleId: 'com.figma.Desktop', name: 'Figma', pid: 12, frontWindowId: 'window' }
const scenes = scenesForApps(
  [front],
  {
    layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' },
    sources: {},
    background: null
  },
  [],
  { id: () => 'figma', now: () => 'today' }
)
function harness(overrides: Partial<FollowFrontAppContext> = {}) {
  let state: FollowFrontAppState = initialFollowFrontAppState()
  const context: FollowFrontAppContext = {
    now: 0,
    scenes,
    lastUsedAt: {},
    videorcBundleIds: ['com.videorc'],
    screenSource: 'display',
    sessionState: 'recording',
    orientation: 'horizontal',
    currentSceneId: null,
    ...overrides
  }
  return {
    context,
    send(event: FollowFrontAppEvent) {
      const result = reduceFollowFrontApp(state, event, context)
      state = result.state
      return result.actions
    },
    activate(bundleId = front.bundleId, pid = front.pid, windowId: string | undefined = 'window') {
      return this.send({ type: 'front-changed', ...front, bundleId, pid, frontWindowId: windowId })
    },
    settle(bundleId: string) {
      this.activate(bundleId)
      return this.tick(context.now + 400)
    },
    tick(now: number) {
      context.now = now
      return this.send({ type: 'tick', now })
    }
  }
}

describe('follow the app in front', () => {
  it('settles at exactly 400 ms and emits one switch', () => {
    const h = harness()
    expect(h.activate()).toEqual([])
    expect(h.tick(399)).toEqual([])
    expect(h.tick(400)).toEqual([{ type: 'switch-scene', sceneId: 'figma' }])
    expect(h.tick(900)).toEqual([])
  })
  it('does not reset settling on repeated observer events, but resets on a new process', () => {
    const h = harness()
    h.activate()
    h.tick(200)
    h.activate()
    expect(h.tick(400)).toHaveLength(1)
    h.activate(front.bundleId, 13)
    expect(h.tick(799)).toEqual([])
    expect(h.tick(800)).toHaveLength(1)
  })
  it('ignores command-tab passes, Videorc and apps without a scene', () => {
    const h = harness()
    h.activate()
    h.tick(200)
    h.activate('com.unknown')
    expect(h.tick(800)).toEqual([])
    h.activate('com.videorc')
    expect(h.tick(1400)).toEqual([])
  })
  it('ignores Videorc even if it has a following scene', () => {
    const h = harness({ videorcBundleIds: [front.bundleId.toUpperCase()] })
    h.activate()
    expect(h.tick(500)).toEqual([])
  })
  it('holds a manual pick until the app changes, including same-app window changes', () => {
    const h = harness()
    h.activate()
    h.tick(500)
    h.send({ type: 'manual-switch' })
    h.activate(front.bundleId, 12, 'window2')
    expect(h.tick(1000)).toEqual([])
    h.activate('other')
    h.tick(1500)
    h.activate()
    expect(h.tick(1900)).toEqual([{ type: 'switch-scene', sceneId: 'figma' }])
  })
  it.each(['idle', 'starting', 'recording', 'streaming', 'stopping'] as const)(
    'never crosses orientation while %s',
    (sessionState) => {
      const h = harness({ orientation: 'vertical', sessionState })
      h.activate()
      expect(h.tick(500)).toEqual([])
    }
  )
  it('does nothing without a normal on-screen front window', () => {
    const h = harness()
    h.send({ type: 'front-changed', ...front, frontWindowId: undefined })
    expect(h.tick(500)).toEqual([])
    h.activate()
    expect(h.tick(900)).toHaveLength(1)
  })
  it('swaps a settled changed front window on the current scene, once', () => {
    const h = harness({ currentSceneId: 'figma', currentWindowId: 'window' })
    h.activate()
    expect(h.tick(500)).toEqual([])
    h.activate(front.bundleId, 12, 'window2')
    expect(h.tick(899)).toEqual([])
    expect(h.tick(900)).toEqual([{ type: 'swap-window', windowId: 'window2' }])
    expect(h.tick(1200)).toEqual([])
  })
  it('can switch while manually hidden without ever showing', () => {
    const h = harness()
    h.send({ type: 'hide-changed', hidden: true, reason: 'you' })
    h.activate()
    expect(h.tick(500)).toEqual([{ type: 'switch-scene', sceneId: 'figma' }])
  })
  it('defaults Follow on, and respects a changed master switch', () => {
    const h = harness({ followEnabled: false })
    h.activate()
    expect(h.tick(500)).toEqual([])
    h.context.followEnabled = true
    expect(h.send({ type: 'settings-changed' })).toEqual([
      { type: 'switch-scene', sceneId: 'figma' }
    ])
  })
})

describe('password-manager hide', () => {
  it('waits 400 ms and ignores password-manager command-tab passes', () => {
    const h = harness({ followEnabled: false })
    expect(h.activate('com.apple.Passwords')).toEqual([])
    expect(h.tick(399)).toEqual([])
    h.activate('other')
    expect(h.tick(800)).toEqual([])
    h.activate('com.apple.Passwords')
    expect(h.tick(1200)).toEqual([{ type: 'hide', reason: 'password-manager' }])
  })
  it.each(DEFAULT_PASSWORD_MANAGER_BUNDLE_IDS)(
    'hides after settling for %s on a display, even with Follow off',
    (bundleId) => {
      const h = harness({ followEnabled: false })
      expect(h.settle(bundleId)).toEqual([{ type: 'hide', reason: 'password-manager' }])
      expect(h.tick(500)).toEqual([])
      expect(h.settle('com.unknown')).toEqual([{ type: 'show' }])
      expect(h.tick(1000)).toEqual([])
    }
  )
  it.each(['window', 'app', 'none'] as const)('never hides a %s source', (screenSource) => {
    const h = harness({ screenSource })
    expect(h.settle('com.apple.Passwords')).toEqual([])
    expect(h.tick(500)).toEqual([])
  })
  it('respects its own switch and settings changes independently of Follow', () => {
    const h = harness({ passwordManagerHideEnabled: false, followEnabled: false })
    expect(h.settle('com.apple.Passwords')).toEqual([])
    h.context.passwordManagerHideEnabled = true
    expect(h.send({ type: 'settings-changed' })).toEqual([
      { type: 'hide', reason: 'password-manager' }
    ])
    h.context.passwordManagerHideEnabled = false
    expect(h.send({ type: 'settings-changed' })).toEqual([{ type: 'show' }])
  })
  it('uses defaults for an empty user list; supports additions and explicit removals', () => {
    const h = harness({
      passwordManagerBundleIds: [],
      removedPasswordManagerBundleIds: ['COM.APPLE.PASSWORDS']
    })
    expect(h.settle('com.apple.Passwords')).toEqual([])
    h.context.passwordManagerBundleIds = ['custom.manager']
    expect(h.settle('custom.manager')).toEqual([{ type: 'hide', reason: 'password-manager' }])
  })
  it('does not show between two password managers', () => {
    const h = harness()
    h.settle('com.apple.Passwords')
    expect(h.settle('com.bitwarden.desktop')).toEqual([])
  })
  it('never replaces or auto-shows a manual hide', () => {
    const h = harness()
    h.send({ type: 'hide-changed', hidden: true, reason: 'you' })
    expect(h.settle('com.apple.Passwords')).toEqual([])
    expect(h.settle('other')).toEqual([])
    h.settle('com.apple.Passwords')
    h.send({ type: 'hide-changed', hidden: true, reason: 'you' })
    expect(h.settle('other')).toEqual([])
  })
  it('auto-shows a confirmed password-manager hide on leave, including Videorc', () => {
    const h = harness()
    h.settle('com.apple.Passwords')
    h.send({ type: 'hide-changed', hidden: true, reason: 'password-manager' })
    expect(h.settle('com.videorc')).toEqual([{ type: 'show' }])
  })
  it('does not mutate inputs', () => {
    const state = initialFollowFrontAppState()
    const h = harness()
    const before = structuredClone(state)
    reduceFollowFrontApp(state, { type: 'front-changed', ...front }, h.context)
    expect(state).toEqual(before)
    expect(h.context.scenes).toEqual(scenes)
  })
})
