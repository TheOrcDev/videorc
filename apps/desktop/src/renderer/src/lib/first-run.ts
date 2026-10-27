import type { WorkspaceTab } from '@/components/workspace-nav'

import { ONBOARDING_DISMISSED_VALUE, STORAGE_KEYS } from './capture'

export const FIRST_RUN_STEPS = ['permissions'] as const

export interface FirstRunRecord {
  version: 1
  status: 'in-progress' | 'done' | 'skipped' | 'existing-install'
  step: (typeof FIRST_RUN_STEPS)[number]
  updatedAt: string
}

export type FirstRunCompletion = Extract<FirstRunRecord['status'], 'done' | 'skipped'>
export type FirstRunDecision = 'show' | 'hide'
export type FirstRunSnapshot = 'fresh' | 'resume' | 'finished' | 'existing-install'
type FirstRunStorage = Pick<Storage, 'getItem' | 'setItem'>

// Keep this lightweight: importing What's New here would eagerly load its UI
// dependencies. This is its persisted migration marker, not a version check.
const WHATS_NEW_LAST_SEEN_KEY = 'videorc.whatsNewLastSeenVersion'

export function parseFirstRunRecord(value: string | null): FirstRunRecord | null {
  if (value === null) return null
  try {
    const record: unknown = JSON.parse(value)
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return null
    const candidate = record as Record<string, unknown>
    if (
      candidate.version !== 1 ||
      typeof candidate.status !== 'string' ||
      !['in-progress', 'done', 'skipped', 'existing-install'].includes(candidate.status) ||
      candidate.step !== 'permissions' ||
      typeof candidate.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.updatedAt))
    ) {
      return null
    }
    return {
      version: 1,
      status: candidate.status as FirstRunRecord['status'],
      step: 'permissions',
      updatedAt: candidate.updatedAt
    }
  } catch {
    return null
  }
}

export function firstRunSnapshot({
  record,
  legacyOnboardingValue,
  whatsNewLastSeen
}: {
  record: FirstRunRecord | null
  legacyOnboardingValue: string | null
  whatsNewLastSeen: string | null
}): FirstRunSnapshot {
  if (record) return record.status === 'in-progress' ? 'resume' : 'finished'
  return legacyOnboardingValue !== null || whatsNewLastSeen !== null ? 'existing-install' : 'fresh'
}

export function firstRunSnapshotDecision({
  snapshot,
  suppressed,
  platform
}: {
  snapshot: FirstRunSnapshot
  suppressed: boolean
  platform: string | undefined
}): FirstRunDecision {
  if (suppressed || !platform || platform === 'linux') return 'hide'
  return snapshot === 'fresh' || snapshot === 'resume' ? 'show' : 'hide'
}

export function firstRunDecision({
  suppressed,
  platform,
  ...input
}: Parameters<typeof firstRunSnapshot>[0] & {
  suppressed: boolean
  platform: string | undefined
}): FirstRunDecision {
  return firstRunSnapshotDecision({ snapshot: firstRunSnapshot(input), suppressed, platform })
}

export function writeFirstRunRecord(
  status: FirstRunRecord['status'],
  store: FirstRunStorage = localStorage,
  updatedAt = new Date().toISOString()
): FirstRunRecord {
  const record: FirstRunRecord = { version: 1, status, step: 'permissions', updatedAt }
  store.setItem(STORAGE_KEYS.firstRun, JSON.stringify(record))
  return record
}

export function completeFirstRun(
  status: FirstRunCompletion,
  store: FirstRunStorage = localStorage
): void {
  writeFirstRunRecord(status, store)
  // A downgrade must keep the retired onboarding dismissed too.
  store.setItem(STORAGE_KEYS.onboarding, ONBOARDING_DISMISSED_VALUE)
}

/**
 * Construct once before rendering: What's New may write its marker on the
 * first launch. Finalize as soon as runtime info arrives, before enabling
 * useWhatsNew. Deferring writes until then lets suppressed smokes write nothing.
 */
export function createFirstRunStartup(store: FirstRunStorage = localStorage): {
  snapshot: FirstRunSnapshot
  finalize: (
    runtime: { platform: string; firstRunSuppressed: boolean } | null
  ) => FirstRunDecision | null
  complete: (status: FirstRunCompletion) => void
} {
  const snapshot = firstRunSnapshot({
    record: parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun)),
    legacyOnboardingValue: store.getItem(STORAGE_KEYS.onboarding),
    whatsNewLastSeen: store.getItem(WHATS_NEW_LAST_SEEN_KEY)
  })
  let decision: FirstRunDecision | null = null
  return {
    snapshot,
    finalize(runtime) {
      if (decision !== null || runtime === null) return decision
      decision = firstRunSnapshotDecision({
        snapshot,
        platform: runtime.platform,
        suppressed: runtime.firstRunSuppressed
      })
      if (!runtime.firstRunSuppressed) {
        if (snapshot === 'existing-install') writeFirstRunRecord('existing-install', store)
        else if (snapshot === 'fresh' && decision === 'show')
          writeFirstRunRecord('in-progress', store)
      }
      return decision
    },
    complete(status) {
      completeFirstRun(status, store)
      // Keep the in-memory decision finished across shell remounts too.
      decision = 'hide'
    }
  }
}

export type FirstRunShellSurface = 'placeholder' | 'setup' | 'workspace'

/**
 * What the main window renders (plan 203 S5). Setup while it is open. Before
 * the decision is final, a solid placeholder for an install that may be
 * fresh or resuming, so neither the Studio nor a preview mounts and then
 * vanishes behind setup. The workspace at once for everyone else: an
 * existing install never waits on the decision.
 */
export function firstRunShellSurface({
  snapshot,
  decision,
  setupOpen
}: {
  snapshot: FirstRunSnapshot
  decision: FirstRunDecision | null
  setupOpen: boolean
}): FirstRunShellSurface {
  if (setupOpen) return 'setup'
  if (decision === null && (snapshot === 'fresh' || snapshot === 'resume')) return 'placeholder'
  return 'workspace'
}

/**
 * How setup was opened (plan 203 S5): the first launch writes the record and
 * opens the Studio; a replay from Settings or ⌘K writes nothing and returns
 * to `returnTo`.
 */
export type FirstRunSetupMode = { kind: 'first-run' } | { kind: 'replay'; returnTo: WorkspaceTab }
