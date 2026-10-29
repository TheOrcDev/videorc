import { useEffect, useRef, useSyncExternalStore } from 'react'

import type { RecordingState, ScreenPrivacy, SourceSelection } from '@/lib/backend'
import {
  initialFollowFrontAppState,
  reduceFollowFrontApp,
  type FollowFrontAppAction,
  type FollowFrontAppContext,
  type FollowFrontAppEvent,
  type FollowFrontAppState
} from '@/lib/follow-front-app'
import { getFollowSettings, subscribeFollowSettings } from '@/lib/follow-settings'
import {
  getPrivacySettings,
  passwordManagerFollowContext,
  subscribePrivacySettings
} from '@/lib/privacy-settings'
import type { SavedScene, SceneOrientation } from '@/lib/scene-presets'
import type { FrontAppApi } from '../../../shared/front-app'

/** D10's settle gate: an app must stay in front this long before anything happens. */
export const FOLLOW_SETTLE_MS = 400

export type FollowSceneApply = (
  sceneId: string,
  preferWindowId?: string
) => Promise<{ ok: boolean }>

/**
 * What the follower needs from the Studio. Everything is read when an event
 * arrives, never captured, so a late scene list or privacy change counts.
 */
export type FollowFrontAppHost = {
  /** macOS only (D12): elsewhere nothing subscribes. */
  enabled: boolean
  scenes: readonly SavedScene[]
  /** The active saved scene, the program's. */
  activeSceneId: string | null
  /** The program's sources: which screen, window or app is on it now. */
  sources: Pick<SourceSelection, 'screenId' | 'windowId' | 'captureOff'>
  sessionState: RecordingState
  orientation: SceneOrientation
  screenPrivacy: Pick<ScreenPrivacy, 'hidden' | 'reason'>
  hideScreen: (reason: 'password-manager') => Promise<unknown>
  showScreen: () => Promise<unknown>
  /** The same latest-intent path as a click, marked as the follower's own. */
  applyScene: FollowSceneApply
  /** Every scene apply that is not the follower's: a click, key, remote or agent. */
  subscribeManualApply: (listener: (sceneId: string) => void) => () => void
  /** Tests pass a fake; the app uses the preload's. */
  api?: Pick<FrontAppApi, 'onFrontAppChanged' | 'setFrontWindowWatch' | 'getSelfBundleIds'>
}

function defaultApi(): FollowFrontAppHost['api'] {
  const api = (globalThis as { window?: { videorc?: Partial<FrontAppApi> } }).window?.videorc
  if (!api?.onFrontAppChanged || !api.setFrontWindowWatch || !api.getSelfBundleIds) return undefined
  return api as FollowFrontAppHost['api']
}

/** What the program shows, for D11 (only a whole display needs hiding). */
export function programScreenSource(
  scenes: readonly SavedScene[],
  activeSceneId: string | null,
  sources: FollowFrontAppHost['sources']
): FollowFrontAppContext['screenSource'] {
  const active = activeSceneId ? scenes.find((scene) => scene.id === activeSceneId) : undefined
  if (active?.visual.sources.app) return 'app'
  if (sources.windowId) return 'window'
  if (sources.screenId && !sources.captureOff) return 'display'
  return 'none'
}

/**
 * Plan 210 S10: the stream follows the app in front (D10) and hides for a
 * password manager (D11). One copy per Studio, macOS only. The rules live in
 * `reduceFollowFrontApp`; this hook feeds it the observer's events, a tick at
 * the settle deadline and the Studio's own changes, then runs its actions
 * through the Studio's apply and privacy paths. App names and bundle ids
 * never leave this module: nothing here logs them.
 */
export function useFollowFrontApp(host: FollowFrontAppHost): void {
  const hostRef = useRef(host)
  hostRef.current = host
  const stateRef = useRef<FollowFrontAppState>(initialFollowFrontAppState())
  const lastUsedAtRef = useRef<Record<string, number>>({})
  const selfBundleIdsRef = useRef<readonly string[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const followSettings = useSyncExternalStore(
    subscribeFollowSettings,
    getFollowSettings,
    getFollowSettings
  )
  const api = host.api ?? defaultApi()
  const { enabled } = host

  useEffect(() => {
    if (!enabled || !api) return
    let active = true
    const run = (action: FollowFrontAppAction): void => {
      const current = hostRef.current
      switch (action.type) {
        case 'switch-scene':
          lastUsedAtRef.current[action.sceneId] = Date.now()
          console.debug('[follow-front-app] switching to the scene made for the app in front')
          void current.applyScene(action.sceneId).catch(() => undefined)
          return
        case 'swap-window':
          if (!current.activeSceneId) return
          console.debug('[follow-front-app] swapping to the window in front')
          void current.applyScene(current.activeSceneId, action.windowId).catch(() => undefined)
          return
        case 'hide':
          console.debug('[follow-front-app] hiding the screen for a password manager')
          void current.hideScreen('password-manager').catch(() => undefined)
          return
        case 'show':
          // A hide the streamer asked for is never undone by the follower.
          if (current.screenPrivacy.hidden && current.screenPrivacy.reason === 'password-manager') {
            console.debug('[follow-front-app] showing the screen again')
            void current.showScreen().catch(() => undefined)
          }
          return
      }
    }
    const context = (): FollowFrontAppContext => {
      const current = hostRef.current
      return {
        now: Date.now(),
        scenes: current.scenes,
        lastUsedAt: lastUsedAtRef.current,
        followEnabled: getFollowSettings().followFrontApp,
        ...passwordManagerFollowContext(getPrivacySettings()),
        videorcBundleIds: selfBundleIdsRef.current,
        screenSource: programScreenSource(current.scenes, current.activeSceneId, current.sources),
        sessionState: current.sessionState,
        orientation: current.orientation,
        currentSceneId: current.activeSceneId,
        currentWindowId: current.sources.windowId
      }
    }
    const clearTick = (): void => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const dispatch = (event: FollowFrontAppEvent): void => {
      if (!active) return
      const result = reduceFollowFrontApp(stateRef.current, event, context())
      stateRef.current = result.state
      for (const action of result.actions) run(action)
    }
    const scheduleTick = (): void => {
      clearTick()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        dispatch({ type: 'tick', now: Date.now() })
      }, FOLLOW_SETTLE_MS + 1)
    }
    void api
      .getSelfBundleIds()
      .then((ids) => {
        if (active) selfBundleIdsRef.current = ids
      })
      .catch(() => undefined)
    const offFront = api.onFrontAppChanged((event) => {
      if (!event.bundleId) return
      dispatch({
        type: 'front-changed',
        bundleId: event.bundleId,
        name: event.name,
        pid: event.pid,
        frontWindowId: event.frontWindowId
      })
      scheduleTick()
    })
    const offManual = hostRef.current.subscribeManualApply((sceneId) => {
      lastUsedAtRef.current[sceneId] = Date.now()
      dispatch({ type: 'manual-switch' })
    })
    const onSettings = (): void => dispatch({ type: 'settings-changed' })
    const offFollow = subscribeFollowSettings(onSettings)
    const offPrivacy = subscribePrivacySettings(onSettings)
    hideChangedRef.current = (hidden, reason) =>
      dispatch({ type: 'hide-changed', hidden, reason: reason ?? null })
    return () => {
      active = false
      clearTick()
      offFront()
      offManual()
      offFollow()
      offPrivacy()
      hideChangedRef.current = null
    }
  }, [enabled, api])

  const hideChangedRef = useRef<
    ((hidden: boolean, reason: ScreenPrivacy['reason']) => void) | null
  >(null)
  const { hidden, reason } = host.screenPrivacy
  useEffect(() => {
    hideChangedRef.current?.(hidden, reason)
  }, [hidden, reason])

  const activeScene = host.activeSceneId
    ? host.scenes.find((scene) => scene.id === host.activeSceneId)
    : undefined
  const watch = Boolean(
    enabled && api && followSettings.followFrontApp && activeScene?.visual.sources.app
  )
  useEffect(() => {
    if (!enabled || !api) return
    void api.setFrontWindowWatch(watch).catch(() => undefined)
    return () => {
      void api.setFrontWindowWatch(false).catch(() => undefined)
    }
  }, [enabled, api, watch])
}
