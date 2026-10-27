import type { WorkspaceTab } from '@/components/workspace-nav'

import type { RecordingStatus } from '../../../shared/backend'
import { sessionIsReplayOnly } from '../../../shared/capture-state'
import { ONBOARDING_DISMISSED_VALUE, STORAGE_KEYS } from './capture'

export const FIRST_RUN_STEPS = ['permissions', 'goal', 'look', 'sound', 'destinations'] as const
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number]
export type FirstRunGoal = 'record' | 'stream' | 'both'

export interface FirstRunRecord {
  version: 2
  status: 'in-progress' | 'done' | 'skipped' | 'existing-install'
  step: FirstRunStep
  goal: FirstRunGoal | null
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
      (candidate.version !== 1 && candidate.version !== 2) ||
      typeof candidate.status !== 'string' ||
      !['in-progress', 'done', 'skipped', 'existing-install'].includes(candidate.status) ||
      typeof candidate.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.updatedAt))
    ) {
      return null
    }
    return {
      version: 2,
      status: candidate.status as FirstRunRecord['status'],
      step:
        candidate.version === 2 && FIRST_RUN_STEPS.includes(candidate.step as FirstRunStep)
          ? (candidate.step as FirstRunStep)
          : 'permissions',
      goal:
        candidate.version === 2 &&
        (candidate.goal === 'record' || candidate.goal === 'stream' || candidate.goal === 'both')
          ? candidate.goal
          : null,
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

export interface FirstRunStepContext {
  goal: FirstRunGoal | null
  platform: string | undefined
  mode: FirstRunSetupMode
}

export function firstRunStepsFor({ goal, platform }: FirstRunStepContext): FirstRunStep[] {
  return FIRST_RUN_STEPS.filter(
    (step) =>
      (step !== 'permissions' || platform !== 'linux') &&
      (step !== 'destinations' || goal !== 'record')
  )
}

export function nextFirstRunStep(
  step: FirstRunStep,
  context: FirstRunStepContext
): FirstRunStep | null {
  return (
    firstRunStepsFor(context).find(
      (candidate) => FIRST_RUN_STEPS.indexOf(candidate) > FIRST_RUN_STEPS.indexOf(step)
    ) ?? null
  )
}

export function previousFirstRunStep(
  step: FirstRunStep,
  context: FirstRunStepContext
): FirstRunStep | null {
  return (
    firstRunStepsFor(context)
      .reverse()
      .find((candidate) => FIRST_RUN_STEPS.indexOf(candidate) < FIRST_RUN_STEPS.indexOf(step)) ??
    null
  )
}

export function firstRunStepPosition(
  step: FirstRunStep,
  context: FirstRunStepContext
): { index: number; count: number } {
  const steps = firstRunStepsFor(context)
  // A saved Permissions step on Linux starts at the first applicable step.
  const index = steps.filter(
    (candidate) => FIRST_RUN_STEPS.indexOf(candidate) < FIRST_RUN_STEPS.indexOf(step)
  ).length
  return { index: Math.min(index + 1, steps.length), count: steps.length }
}

type FirstRunProgress = Pick<FirstRunRecord, 'step' | 'goal'>
const INITIAL_PROGRESS: FirstRunProgress = { step: 'permissions', goal: null }
const FIRST_RUN_MODE: FirstRunSetupMode = { kind: 'first-run' }

export function writeFirstRunRecord(
  status: FirstRunRecord['status'],
  store: FirstRunStorage = localStorage,
  updatedAt = new Date().toISOString(),
  progress: FirstRunProgress = INITIAL_PROGRESS
): FirstRunRecord {
  const record: FirstRunRecord = {
    version: 2,
    status,
    step: progress.step,
    goal: progress.goal,
    updatedAt
  }
  store.setItem(STORAGE_KEYS.firstRun, JSON.stringify(record))
  return record
}

export function completeFirstRun(
  status: FirstRunCompletion,
  store: FirstRunStorage = localStorage,
  progress: FirstRunProgress = parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun)) ??
    INITIAL_PROGRESS
): void {
  writeFirstRunRecord(status, store, undefined, progress)
  // A downgrade must keep the retired onboarding dismissed too.
  store.setItem(STORAGE_KEYS.onboarding, ONBOARDING_DISMISSED_VALUE)
}

export interface FirstRunStartup {
  snapshot: FirstRunSnapshot
  readonly step: FirstRunStep
  readonly goal: FirstRunGoal | null
  finalize: (
    runtime: { platform: string; firstRunSuppressed: boolean } | null
  ) => FirstRunDecision | null
  enterStep: (step: FirstRunStep, mode?: FirstRunSetupMode) => void
  setGoal: (goal: FirstRunGoal, mode?: FirstRunSetupMode) => void
  complete: (status: FirstRunCompletion, mode?: FirstRunSetupMode) => void
}

/**
 * Construct once before rendering: What's New may write its marker on the
 * first launch. Finalize as soon as runtime info arrives, before enabling
 * useWhatsNew. Deferring writes until then lets suppressed smokes write nothing.
 */
export function createFirstRunStartup(store: FirstRunStorage = localStorage): FirstRunStartup {
  const record = parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))
  const snapshot = firstRunSnapshot({
    record,
    legacyOnboardingValue: store.getItem(STORAGE_KEYS.onboarding),
    whatsNewLastSeen: store.getItem(WHATS_NEW_LAST_SEEN_KEY)
  })
  let progress: FirstRunProgress = record
    ? { step: record.step, goal: record.goal }
    : INITIAL_PROGRESS
  let decision: FirstRunDecision | null = null
  const canWrite = (mode: FirstRunSetupMode): boolean =>
    decision === 'show' && mode.kind === 'first-run'
  return {
    snapshot,
    get step() {
      return progress.step
    },
    get goal() {
      return progress.goal
    },
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
          writeFirstRunRecord('in-progress', store, undefined, progress)
      }
      return decision
    },
    enterStep(step, mode = FIRST_RUN_MODE) {
      if (!canWrite(mode)) return
      progress = { ...progress, step }
      writeFirstRunRecord('in-progress', store, undefined, progress)
    },
    setGoal(goal, mode = FIRST_RUN_MODE) {
      if (!canWrite(mode)) return
      progress = { ...progress, goal }
      writeFirstRunRecord('in-progress', store, undefined, progress)
    },
    complete(status, mode = FIRST_RUN_MODE) {
      if (!canWrite(mode)) return
      completeFirstRun(status, store, progress)
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

/** How setup ends (plan 207): the record's word, and a page other than the usual one to land on. */
export interface FirstRunLeave {
  completion: FirstRunCompletion
  openTab?: WorkspaceTab
}

/** Why "Run setup again…" is off (plan 203 D5): setup holds capture back. */
export const FIRST_RUN_REPLAY_LOCKED_REASON = 'Finish your recording or livestream first.'

/**
 * "Run setup again…" waits while a recording or livestream starts, runs or
 * stops (plan 203 S6). The Clips ring alone is no session: setup only holds
 * its start, and a running ring keeps running.
 */
export function firstRunReplayLocked(
  recording: Pick<RecordingStatus, 'state' | 'replayOnly'>
): boolean {
  if (sessionIsReplayOnly(recording)) return false
  return (
    recording.state === 'starting' ||
    recording.state === 'recording' ||
    recording.state === 'streaming' ||
    recording.state === 'stopping'
  )
}
