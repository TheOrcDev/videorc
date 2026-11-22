// Plan 250: the notification store. One entry per subject, updated in place,
// whichever system reported it. No React and no toast in here: the list reads
// `snapshot`, the bell reads the count it is handed, and a pop-up goes
// through the door `pop-up.ts` installs. The rules are `policy.ts`'s.

import { kindTone, NOTIFICATION_KINDS, type NotificationKind } from '@/lib/notifications/kinds'
import {
  cameBackWords,
  entriesToDrop,
  FLAP_WINDOW_MS,
  isNow,
  joinSentences,
  mergeReports,
  notificationCount,
  popUpDecision,
  repeatWords,
  sessionEndedWords,
  sortEntries,
  spanWords,
  toneRank,
  worseTone,
  type NotificationChange,
  type NotificationReport,
  type SessionEndReason
} from '@/lib/notifications/policy'
import type {
  NotificationAction,
  NotificationCount,
  NotificationEntry,
  NotificationInput,
  NotificationPopUpDoor,
  NotificationResolution,
  NotificationTone
} from '@/lib/notifications/types'

export interface NotificationStoreOptions {
  now?: () => number
  /** A recording or a livestream runs (`sessionOwnsTransport`). */
  live?: () => boolean
  /** "Quiet while recording or live" (Settings, General). Absent means on. */
  quiet?: () => boolean
  /**
   * The streamer has pressed something in this run (a click, a key, a global
   * shortcut). Absent means not yet: at launch nothing pops up unasked.
   */
  pressed?: () => boolean
  /**
   * How long the launch lasts (`LAUNCH_QUIET_MS` in the app). Absent means no
   * launch window, for tests that are about the other rules.
   */
  launchQuietMs?: number
  onCount?: (count: NotificationCount) => void
  /**
   * Every title and detail passes through it (the toast door's text guard:
   * a provider's raw error never reaches the list as HTML or a JSON blob).
   */
  guardText?: (text: string) => string
  /** A new entry, or one that got worse: what a screen reader is told. */
  onAnnounce?: (entry: NotificationEntry) => void
}

interface Held {
  entry: NotificationEntry
  /** A condition's reports, by who sent them. */
  reports: Map<string, NotificationReport>
  actions: NotificationAction[]
  /** What the reporter said, before "3 times." or "Came back once." is added. */
  detail?: string
  comebacks: number
  /**
   * Cleared while open ("I know"): kept out of the list until the problem
   * gets worse than this, or ends and starts again.
   */
  hidden: NotificationTone | null
  lastPop?: { at: number; tone: NotificationTone }
  /**
   * Resolved because its session ended, not because it recovered: the same
   * subject in the next session is a new problem, never a flap.
   */
  endedWithSession?: boolean
  onClear?: () => void
}

export interface NotificationStore {
  publish: (input: NotificationInput) => void
  /** A condition cleared. The entry stays, resolved, when no report is left. */
  resolve: (key: string, resolution?: NotificationResolution) => void
  /** A report was taken back (the alert was snoozed): no resolved entry is left. */
  withdraw: (key: string, source?: string) => void
  /** The streamer's Clear. An open problem is hidden; anything else is removed. */
  clear: (key: string) => void
  /** Removes everything that is no longer true. Open problems stay. */
  clearAll: () => void
  markRead: (key: string) => void
  markAllRead: () => void
  /**
   * Conditions that belong to the session resolve. `session` is its id, or
   * a test of an id; left out, every session.
   */
  sessionEnded: (reason: SessionEndReason, session?: string | ((id: string) => boolean)) => void
  runAction: (key: string, actionId: string) => Promise<void>
  has: (key: string) => boolean
  snapshot: () => readonly NotificationEntry[]
  count: () => NotificationCount
  subscribe: (listener: () => void) => () => void
  /**
   * The list is on screen in a window (`who`): nothing pops up while it is
   * open anywhere. The main window and the Stream Manager each say their own.
   */
  setListOpen: (open: boolean, who?: string) => void
  setPopUpDoor: (door: NotificationPopUpDoor | null) => void
  configure: (options: Pick<NotificationStoreOptions, 'live' | 'quiet' | 'pressed'>) => void
  /** Tests only: forgets every entry, and the launch is over. */
  reset: () => void
}

export function createNotificationStore(options: NotificationStoreOptions = {}): NotificationStore {
  const now = options.now ?? Date.now
  let live = options.live ?? (() => false)
  let quiet = options.quiet ?? (() => true)
  let pressed = options.pressed ?? (() => false)
  // The run starts with the store: its first minute is the launch.
  const startedAt = now()
  let launchQuietMs = options.launchQuietMs ?? 0
  const held = new Map<string, Held>()
  const listeners = new Set<() => void>()
  let door: NotificationPopUpDoor | null = null
  const listsOpen = new Set<string>()
  let listOpen = false
  let cached: readonly NotificationEntry[] = []
  let counted: NotificationCount = { unread: 0, urgent: 0, tone: null }

  function visible(): NotificationEntry[] {
    const entries: NotificationEntry[] = []
    for (const item of held.values()) if (item.hidden === null) entries.push(item.entry)
    return entries
  }

  function commit(): void {
    const at = now()
    for (const [key, item] of held) {
      // A cleared problem that ended is remembered for the flap window only.
      if (
        item.hidden !== null &&
        item.entry.state === 'resolved' &&
        at - (item.entry.resolvedAt ?? at) >= FLAP_WINDOW_MS
      ) {
        held.delete(key)
      }
    }
    for (const key of entriesToDrop(visible())) held.delete(key)
    cached = sortEntries(visible())
    const next = notificationCount(cached)
    if (
      next.unread !== counted.unread ||
      next.tone !== counted.tone ||
      next.urgent !== counted.urgent
    ) {
      counted = next
      options.onCount?.(next)
    }
    for (const listener of listeners) listener()
  }

  function setEntry(item: Held, patch: Partial<NotificationEntry>): void {
    item.entry = { ...item.entry, ...patch }
  }

  function view(actions: readonly NotificationAction[]): NotificationEntry['actions'] {
    return actions.slice(0, 2).map(({ id, label, kind }) => ({ id, label, kind }))
  }

  function popUp(item: Held, kind: NotificationKind, change: NotificationChange, fineForMs = 0) {
    if (item.hidden !== null) return
    // Only a first appearance and a change for the worse speak: the clock in
    // an open entry's detail moves every second.
    if (change !== 'updated' && change !== 'flapped') options.onAnnounce?.(item.entry)
    if (!door) return
    const at = now()
    const durationMs = popUpDecision({
      change,
      tone: item.entry.tone,
      answersAPress: kind.answersAPress === true,
      announcement: kind.announcement === true,
      launching: at - startedAt < launchQuietMs,
      pressed: pressed(),
      popUpMs: kind.popUpMs,
      hasDetail: Boolean(item.entry.detail),
      live: live(),
      quiet: quiet(),
      listOpen,
      now: at,
      lastPop: item.lastPop,
      fineForMs
    })
    if (durationMs === null) return
    item.lastPop = { at, tone: item.entry.tone }
    door.show(item.entry, durationMs, item.actions[0])
  }

  function publishCondition(input: NotificationInput, kind: NotificationKind): void {
    const at = now()
    const source = input.source ?? 'self'
    const report: NotificationReport = {
      source,
      tone: kindTone(kind, input.tone),
      title: input.title,
      detail: input.detail,
      actions: input.actions ?? [],
      lead: input.lead ?? false,
      at,
      onClear: input.onClear
    }
    let item = held.get(input.key)
    let change: NotificationChange
    let fineForMs = 0
    if (!item || item.entry.life !== 'condition' || item.endedWithSession) {
      // A subject whose last session ended starts clean: it may pop up again.
      const lastPop = item?.endedWithSession ? undefined : item?.lastPop
      item = {
        entry: {
          key: input.key,
          kind: input.kind,
          tone: report.tone,
          peakTone: report.tone,
          life: 'condition',
          state: 'open',
          title: report.title,
          openedAt: at,
          updatedAt: at,
          occurrences: 1,
          read: false,
          actions: []
        },
        reports: new Map(),
        actions: [],
        comebacks: 0,
        hidden: null,
        lastPop
      }
      held.set(input.key, item)
      change = 'opened'
    } else if (item.entry.state === 'open') {
      change = 'updated'
    } else {
      fineForMs = at - (item.entry.resolvedAt ?? at)
      if (fineForMs < FLAP_WINDOW_MS) {
        change = 'flapped'
        item.comebacks += 1
        setEntry(item, { state: 'open', resolvedAt: undefined })
      } else {
        change = 'returned'
        item.comebacks = 0
        item.hidden = null
        setEntry(item, {
          state: 'open',
          resolvedAt: undefined,
          openedAt: at,
          read: false,
          peakTone: report.tone
        })
      }
    }
    const before = item.entry.state === 'open' && change !== 'opened' ? item.entry.tone : null
    item.reports.set(source, report)
    const merged = mergeReports([...item.reports.values()])
    if (!merged) return
    if (change === 'flapped' || change === 'updated') {
      // Worse than it was (or than what was cleared): it is news again.
      const was = item.hidden ?? (change === 'updated' ? before : item.entry.peakTone)
      if (was !== null && toneRank(merged.tone) > toneRank(was)) {
        change = 'escalated'
        item.hidden = null
        setEntry(item, { read: false })
      }
    }
    item.actions = merged.actions
    item.detail = merged.detail
    setEntry(item, {
      kind: input.kind,
      tone: merged.tone,
      peakTone: worseTone(item.entry.peakTone, merged.tone),
      title: merged.title,
      detail: joinSentences(cameBackWords(item.comebacks), merged.detail),
      updatedAt: at,
      sessionId: input.sessionId ?? item.entry.sessionId,
      actions: view(merged.actions)
    })
    popUp(item, kind, change, fineForMs)
    commit()
  }

  function publishOnce(input: NotificationInput, kind: NotificationKind): void {
    const at = now()
    const progress = kind.life === 'progress'
    const state = progress ? (input.state ?? 'running') : 'happened'
    const tone = progress
      ? state === 'failed'
        ? 'warning'
        : state === 'done'
          ? 'done'
          : 'news'
      : kindTone(kind, input.tone)
    const previous = held.get(input.key)
    const again = previous?.entry.life === kind.life ? previous : undefined
    // One happening two systems report (a full disk, then the failed take)
    // is not a repeat.
    const same = again !== undefined && input.once === true
    const repeated = again !== undefined && !progress && !same
    const occurrences = repeated ? again.entry.occurrences + 1 : (again?.entry.occurrences ?? 1)
    const actions = input.actions ?? []
    const item: Held = {
      entry: {
        key: input.key,
        kind: input.kind,
        tone,
        peakTone: tone,
        life: kind.life,
        state,
        title: input.title,
        detail: joinSentences(repeatWords(occurrences), input.detail),
        openedAt: again?.entry.openedAt ?? at,
        updatedAt: at,
        occurrences,
        // The same news with new words (an export's progress line) is not new.
        read:
          again !== undefined && (same || (again.entry.state === state && progress))
            ? again.entry.read
            : false,
        sessionId: input.sessionId,
        actions: view(actions)
      },
      reports: new Map(),
      actions,
      detail: input.detail,
      comebacks: 0,
      hidden: null,
      lastPop: previous?.lastPop,
      onClear: input.onClear
    }
    held.set(input.key, item)
    if (state !== 'running') {
      const settled = same || (progress && again !== undefined && again.entry.state === state)
      popUp(item, kind, settled ? 'updated' : repeated ? 'repeated' : 'opened')
    }
    commit()
  }

  function dropReports(item: Held, source: string | undefined): void {
    if (source === undefined) item.reports.clear()
    else item.reports.delete(source)
  }

  function remerge(item: Held): void {
    const merged = mergeReports([...item.reports.values()])
    if (!merged) return
    item.actions = merged.actions
    item.detail = merged.detail
    setEntry(item, {
      tone: merged.tone,
      title: merged.title,
      detail: joinSentences(cameBackWords(item.comebacks), merged.detail),
      updatedAt: now(),
      actions: view(merged.actions)
    })
  }

  function settle(item: Held, patch: Partial<NotificationEntry>, recovered = true): void {
    const at = now()
    item.reports.clear()
    item.actions = []
    setEntry(item, {
      state: 'resolved',
      // A session that ended is not a recovery: no green tick, and no
      // recovery toast in the place of the problem's.
      tone: recovered ? 'done' : 'news',
      resolvedAt: at,
      updatedAt: at,
      actions: [],
      ...patch
    })
    if (item.hidden !== null) return
    if (recovered) door?.resolved(item.entry)
    else door?.dismiss(item.entry.key)
  }

  const guard = options.guardText
  function guarded<T extends { title?: string; detail?: string; ownWords?: boolean }>(words: T): T {
    if (!guard || words.ownWords) return words
    return {
      ...words,
      ...(words.title !== undefined ? { title: guard(words.title) } : {}),
      ...(words.detail !== undefined ? { detail: guard(words.detail) } : {})
    }
  }

  const store: NotificationStore = {
    publish(raw) {
      const input = guarded(raw)
      const kind = NOTIFICATION_KINDS[input.kind]
      if (kind.life === 'condition') publishCondition(input, kind)
      else publishOnce(input, kind)
    },

    resolve(key, rawResolution = {}) {
      const resolution = guarded(rawResolution)
      const item = held.get(key)
      if (!item || item.entry.life !== 'condition' || item.entry.state !== 'open') return
      if (resolution.source !== undefined && !item.reports.has(resolution.source)) return
      dropReports(item, resolution.source)
      if (item.reports.size > 0) {
        remerge(item)
      } else {
        const lasted = spanWords(now() - item.entry.openedAt)
        settle(item, {
          title: resolution.title ?? item.entry.title,
          detail:
            resolution.detail ??
            (resolution.was ? `${resolution.was} for ${lasted}.` : `It lasted ${lasted}.`)
        })
      }
      commit()
    },

    withdraw(key, source) {
      const item = held.get(key)
      if (!item || item.entry.life !== 'condition' || item.entry.state !== 'open') return
      if (source !== undefined && !item.reports.has(source)) return
      dropReports(item, source)
      if (item.reports.size > 0) {
        remerge(item)
      } else {
        held.delete(key)
        door?.dismiss(key)
      }
      commit()
    },

    clear(key) {
      const item = held.get(key)
      if (!item || item.hidden !== null) return
      door?.dismiss(key)
      if (item.entry.state === 'open') {
        item.hidden = item.entry.tone
        for (const report of [...item.reports.values()]) report.onClear?.()
      } else {
        held.delete(key)
        item.onClear?.()
      }
      commit()
    },

    clearAll() {
      for (const [key, item] of held) {
        if (item.hidden !== null || isNow(item.entry)) continue
        held.delete(key)
        // Its toast may still be on screen, with a button that now does nothing.
        door?.dismiss(key)
        item.onClear?.()
      }
      commit()
    },

    markRead(key) {
      const item = held.get(key)
      if (!item || item.entry.read) return
      setEntry(item, { read: true })
      commit()
    },

    markAllRead() {
      let changed = false
      for (const item of held.values()) {
        if (item.hidden !== null || item.entry.read) continue
        setEntry(item, { read: true })
        changed = true
      }
      if (changed) commit()
    },

    sessionEnded(reason, session) {
      let changed = false
      for (const [key, item] of held) {
        const { entry } = item
        if (entry.life !== 'condition' || !entry.sessionId) continue
        if (typeof session === 'string' && entry.sessionId !== session) continue
        if (typeof session === 'function' && !session(entry.sessionId)) continue
        if (entry.state !== 'open') {
          // It cleared before the session ended. Its row stays as it is, but
          // the same subject in the next session is a new problem, not this
          // one coming back.
          item.endedWithSession = true
          continue
        }
        changed = true
        if (item.hidden !== null) {
          held.delete(key)
          continue
        }
        settle(item, { detail: joinSentences(item.detail, sessionEndedWords(reason)) }, false)
        item.endedWithSession = true
      }
      if (changed) commit()
    },

    async runAction(key, actionId) {
      const item = held.get(key)
      const action = item?.actions.find((candidate) => candidate.id === actionId)
      if (!item || !action) return
      store.markRead(key)
      await action.run()
    },

    has(key) {
      const item = held.get(key)
      return item !== undefined && item.hidden === null
    },

    snapshot: () => cached,
    count: () => counted,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    setListOpen(open, who = 'main') {
      if (open) listsOpen.add(who)
      else listsOpen.delete(who)
      listOpen = listsOpen.size > 0
    },

    setPopUpDoor(next) {
      door = next
    },

    configure(next) {
      if (next.live) live = next.live
      if (next.quiet) quiet = next.quiet
      if (next.pressed) pressed = next.pressed
    },

    reset() {
      // Tests only: a reset is past the launch, so the plan 250 rules apply.
      launchQuietMs = 0
      for (const key of held.keys()) door?.dismiss(key)
      held.clear()
      listsOpen.clear()
      listOpen = false
      commit()
    }
  }
  return store
}
