import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  publishAgentNotice,
  publishAppNews,
  publishBackendError,
  publishBackendLifecycle,
  publishBackgroundProblem,
  publishCaptionsOutputUnsupported,
  publishCaptionsProblem,
  publishGlobalShortcutsProblem,
  publishOutputTooHeavy,
  publishSourceReturn,
  publishVideorcCameraStopped,
  resolveGlobalShortcuts,
  resolveVideorcCamera,
  withdrawSourceReturn
} from '@/lib/notifications/sources/app'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'

describe('devices and the app as notifications (plan 250 S7)', () => {
  let store: NotificationStore
  let live = false
  const door = { show: vi.fn(), resolved: vi.fn(), dismiss: vi.fn() }
  const entry = (key: string) => store.snapshot().find((item) => item.key === key)

  beforeEach(() => {
    vi.clearAllMocks()
    live = false
    store = createNotificationStore({ live: () => live })
    store.setPopUpDoor(door)
  })

  it('"{device} is back" counts, offers Use it, and goes when used or unplugged', async () => {
    live = true
    const useIt = vi.fn()
    publishSourceReturn('camera:cam-1', 'Studio Cam', useIt, store)
    expect(entry('source-return:camera:cam-1')).toMatchObject({
      state: 'open',
      tone: 'warning',
      title: 'Studio Cam is back',
      detail: 'This session is running without it.',
      actions: [{ id: 'use-it', label: 'Use it', kind: 'fix' }]
    })
    // Never pinned: while live it raises the number and waits.
    expect(door.show).not.toHaveBeenCalled()
    expect(store.count()).toEqual({ unread: 1, urgent: 0, tone: 'warning' })
    await store.runAction('source-return:camera:cam-1', 'use-it')
    expect(useIt).toHaveBeenCalledTimes(1)
    // It does not end with the session on its own: the Studio takes it back.
    store.sessionEnded('recording')
    expect(entry('source-return:camera:cam-1')?.state).toBe('open')
    withdrawSourceReturn('camera:cam-1', store)
    expect(store.snapshot()).toEqual([])
  })

  it('Videorc Camera stopped is open until the camera is back', () => {
    publishVideorcCameraStopped(
      { title: 'Videorc Camera stopped', description: 'Videorc is starting it again.' },
      store
    )
    expect(entry('videorc-camera')).toMatchObject({
      state: 'open',
      tone: 'warning',
      title: 'Videorc Camera stopped',
      actions: [{ label: 'Open Output', kind: 'door' }]
    })
    resolveVideorcCamera(store)
    expect(entry('videorc-camera')).toMatchObject({
      state: 'resolved',
      title: 'Videorc Camera is back'
    })
  })

  it('global shortcuts that did not register are one entry, resolved by a clean registration', () => {
    publishGlobalShortcutsProblem(
      { title: "A global shortcut didn't register", description: 'Mute: another app uses it.' },
      store
    )
    publishGlobalShortcutsProblem(
      { title: "Some global shortcuts didn't register", description: 'Mute, Clip: taken.' },
      store
    )
    expect(store.snapshot()).toHaveLength(1)
    expect(entry('global-shortcuts')).toMatchObject({
      title: "Some global shortcuts didn't register",
      actions: [{ label: 'Open Shortcuts', kind: 'door' }]
    })
    resolveGlobalShortcuts(store)
    expect(entry('global-shortcuts')?.state).toBe('resolved')
  })

  describe('the engine', () => {
    it('recovering is a warning that resolves when it runs again', () => {
      publishBackendLifecycle({ state: 'restarting', attempt: 2 }, store)
      expect(entry('backend')).toMatchObject({
        state: 'open',
        tone: 'warning',
        title: 'Videorc is recovering',
        detail: 'Restarting automatically (attempt 2)…'
      })
      publishBackendLifecycle({ state: 'running' }, store)
      expect(entry('backend')).toMatchObject({ state: 'resolved', title: 'Videorc recovered' })
    })

    it('failed and lost are urgent, and always pop up', () => {
      live = true
      publishBackendLifecycle({ state: 'restarting' }, store)
      publishBackendLifecycle({ state: 'failed' }, store)
      expect(entry('backend')).toMatchObject({
        tone: 'urgent',
        title: "Videorc can't recover on its own",
        detail: 'Quit and reopen Videorc.'
      })
      expect(door.show).toHaveBeenCalledTimes(1)
      expect(door.show.mock.calls[0][1]).toBe(15_000)
      store.reset()
      publishBackendLifecycle({ state: 'lost' }, store)
      expect(entry('backend')).toMatchObject({ tone: 'urgent', title: 'Videorc needs a restart' })
    })

    it('a running engine with nothing open is not news', () => {
      publishBackendLifecycle({ state: 'running' }, store)
      expect(store.snapshot()).toEqual([])
    })

    it('an unexplained backend error is one counted entry with the door to Health', () => {
      publishBackendError(store)
      publishBackendError(store)
      publishBackendError(store)
      expect(store.snapshot()).toHaveLength(1)
      expect(entry('backend-error')).toMatchObject({
        tone: 'warning',
        title: 'Videorc hit a problem',
        occurrences: 3,
        actions: [{ label: 'Open Health', kind: 'door' }]
      })
      // It can repeat on every reconnect: one pop-up, not one per repeat.
      expect(door.show).toHaveBeenCalledTimes(1)
    })
  })

  it('what Videorc did on its own is news: never a pop-up, never counted', () => {
    publishAppNews(
      'notes-closed-for-recording',
      'Notes closed for this recording',
      'Videorc closed them so they stay out of the recording.',
      undefined,
      store
    )
    publishAgentNotice(
      'agent-notice:claude:end_livestream',
      'Claude Desktop ended the livestream',
      store
    )
    expect(entry('notes-closed-for-recording')).toMatchObject({ tone: 'news', actions: [] })
    expect(entry('agent-notice:claude:end_livestream')).toMatchObject({
      tone: 'news',
      title: 'Claude Desktop ended the livestream',
      actions: [{ label: 'Open Settings', kind: 'door' }]
    })
    expect(door.show).not.toHaveBeenCalled()
    expect(store.count().unread).toBe(0)
  })

  it('an output too heavy for this computer offers the lighter one, and goes once it is chosen', async () => {
    const apply = vi.fn()
    publishOutputTooHeavy(
      {
        title: '1440p60 is too heavy for this computer',
        description: 'Recordings will stutter. 1080p30 held steady.',
        actionLabel: 'Use 1080p30'
      },
      apply,
      store
    )
    expect(entry('output-too-heavy')).toMatchObject({
      tone: 'warning',
      actions: [{ id: 'use-preset', label: 'Use 1080p30', kind: 'fix' }]
    })
    await store.runAction('output-too-heavy', 'use-preset')
    expect(apply).toHaveBeenCalledTimes(1)
    expect(store.snapshot()).toEqual([])
  })

  it('what Videorc tried on its own and could not do is one entry per cause', () => {
    publishBackendError(store)
    publishBackgroundProblem({ title: 'Videorc hit a problem', description: 'Try again.' }, store)
    publishBackgroundProblem({ title: "Couldn't load your YouTube channels" }, store)
    publishBackgroundProblem({ title: "Couldn't load your YouTube channels" }, store)
    expect(store.snapshot()).toHaveLength(2)
    expect(entry('backend-error')).toMatchObject({ occurrences: 2 })
    expect(entry("background-problem:Couldn't load your YouTube channels")).toMatchObject({
      tone: 'warning',
      occurrences: 2,
      actions: [{ label: 'Open Health', kind: 'door' }]
    })
  })

  it('live captions that could not start on their own offer Retry', async () => {
    const retry = vi.fn()
    publishCaptionsProblem({ title: "Couldn't start live captions" }, retry, store)
    expect(entry('captions')).toMatchObject({
      tone: 'warning',
      actions: [{ id: 'retry', label: 'Retry', kind: 'fix' }]
    })
    await store.runAction('captions', 'retry')
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('an output that cannot carry captions says so, with no Retry to press', () => {
    publishCaptionsOutputUnsupported(undefined, store)
    expect(entry('captions')).toMatchObject({
      title: "Live captions can't start in this session",
      detail: "The active output configuration can't carry caption pixels.",
      actions: []
    })
  })
})
