import type { EntitlementsSnapshot, NoiseCleanupJob, SessionSummary } from './backend'
import { noiseCleanupGate } from './entitlement-ui'

export type NoiseCleanupAction = 'upgrade' | 'start' | 'cancel' | 'open-output' | 'show-source'

export interface NoiseCleanupView {
  directAction: NoiseCleanupAction | null
  menuAction: NoiseCleanupAction | null
  directLabel: string | null
  menuLabel: string | null
  disabledReason: string | null
  detail: string | null
  statusAnnouncement: string | null
  busy: boolean
  conflictsWithFileActions: boolean
  premiumLocked: boolean
  derivative: boolean
}

export interface NoiseCleanupViewInput {
  session: Pick<
    SessionSummary,
    'id' | 'status' | 'mode' | 'outputPath' | 'mp4Path' | 'derivedFromSessionId' | 'processingKind'
  >
  entitlements: EntitlementsSnapshot | null
  job: NoiseCleanupJob | null
  captureActive: boolean
}

export interface NoiseCleanupCancellationNotice {
  title: string
  description: string
}

export function deriveNoiseCleanupView({
  session,
  entitlements,
  job,
  captureActive
}: NoiseCleanupViewInput): NoiseCleanupView {
  if (session.processingKind === 'noise-cleanup') {
    return view({
      menuAction: session.derivedFromSessionId ? 'show-source' : null,
      menuLabel: session.derivedFromSessionId ? 'Show source recording' : null,
      detail: session.derivedFromSessionId ? null : 'The source recording is no longer in Library.',
      derivative: true
    })
  }

  if (job?.status === 'queued') {
    return view({
      menuAction: 'cancel',
      directLabel: 'Queued…',
      menuLabel: 'Cancel cleanup',
      detail: 'Noise cleanup is queued and will start when media processing is available.',
      statusAnnouncement: 'Noise cleanup queued.',
      busy: true,
      conflictsWithFileActions: true
    })
  }
  if (job?.status === 'processing') {
    const progress = clampProgress(job.progressPercent)
    return view({
      menuAction: 'cancel',
      directLabel: `Cleaning ${Math.round(progress)}%`,
      menuLabel: `Cancel cleanup — ${Math.round(progress)}%`,
      detail: `Cleaning noise: ${Math.round(progress)}% complete.`,
      statusAnnouncement: `Cleaning noise, ${coarseProgress(progress)} percent.`,
      busy: true,
      conflictsWithFileActions: true
    })
  }
  if (job?.status === 'validating') {
    return view({
      menuAction: 'cancel',
      directLabel: 'Validating…',
      menuLabel: 'Cancel cleanup',
      detail: 'Validating the cleaned copy before it appears in Library.',
      statusAnnouncement: 'Validating cleaned copy.',
      busy: true,
      conflictsWithFileActions: true
    })
  }
  if (job?.status === 'completed' && job.outputSessionId) {
    return view({
      directAction: 'open-output',
      menuAction: 'open-output',
      directLabel: 'Open cleaned copy',
      menuLabel: 'Open cleaned copy',
      detail: 'Noise cleanup completed. The original recording was not changed.',
      statusAnnouncement: 'Noise cleanup completed.'
    })
  }

  if (captureActive || session.status === 'running') {
    const reason = 'Available after the live session ends.'
    return view({ directLabel: 'Clean noise', menuLabel: 'Clean noise', disabledReason: reason })
  }
  if (session.mode === 'imported') {
    const reason = 'Imported recordings are not supported by Noise Cleanup yet.'
    return view({ directLabel: 'Clean noise', menuLabel: 'Clean noise', disabledReason: reason })
  }
  if (!session.mp4Path && !session.outputPath) {
    const reason = 'The local recording file is missing.'
    return view({ directLabel: 'Clean noise', menuLabel: 'Clean noise', disabledReason: reason })
  }
  if (session.status !== 'completed') {
    const reason = 'Noise Cleanup requires a finished recording.'
    return view({ directLabel: 'Clean noise', menuLabel: 'Clean noise', disabledReason: reason })
  }

  const gate = noiseCleanupGate(entitlements)
  if (!gate.allowed) {
    return view({
      directAction: 'upgrade',
      menuAction: 'upgrade',
      directLabel: 'Clean noise',
      menuLabel: 'Clean noise — Premium',
      detail: gate.reason,
      premiumLocked: true
    })
  }

  const retry = job?.status === 'failed' || job?.status === 'cancelled'
  return view({
    directAction: 'start',
    menuAction: 'start',
    directLabel: retry ? 'Retry cleanup' : 'Clean noise',
    menuLabel: retry ? 'Retry cleanup' : 'Clean noise',
    detail: retry ? (job.errorMessage ?? 'The previous cleanup did not finish.') : null
  })
}

export function latestNoiseCleanupJobForSession(
  jobs: readonly NoiseCleanupJob[],
  sessionId: string
): NoiseCleanupJob | null {
  let latest: NoiseCleanupJob | null = null
  for (const job of jobs) {
    if (
      job.sourceSessionId === sessionId &&
      (!latest || job.updatedAt.localeCompare(latest.updatedAt) > 0)
    ) {
      latest = job
    }
  }
  return latest
}

export function activeNoiseCleanupSourceIds(jobs: readonly NoiseCleanupJob[]): ReadonlySet<string> {
  return new Set(
    jobs
      .filter((job) => ['queued', 'processing', 'validating'].includes(job.status))
      .map((job) => job.sourceSessionId)
  )
}

export function noiseCleanupCancellationNotice(
  job: NoiseCleanupJob
): NoiseCleanupCancellationNotice {
  if (job.status === 'cancelled') {
    return {
      title: 'Noise cleanup cancelled',
      description: 'The original recording was not changed.'
    }
  }
  if (['queued', 'processing', 'validating'].includes(job.status)) {
    return {
      title: 'Cancellation requested',
      description:
        'Noise cleanup is still stopping. Its status will update when cancellation finishes.'
    }
  }
  if (job.status === 'completed') {
    return {
      title: 'Noise cleanup already completed',
      description: 'The cleaned copy is ready in Library.'
    }
  }
  return {
    title: 'Noise cleanup stopped',
    description: job.errorMessage ?? 'The cleanup job is no longer running.'
  }
}

export function withNoiseCleanupConnectionState(
  cleanupView: NoiseCleanupView,
  connected: boolean
): NoiseCleanupView {
  if (connected || cleanupView.directAction !== 'start') {
    return cleanupView
  }
  return {
    ...cleanupView,
    directAction: null,
    disabledReason: 'Videorc is reconnecting. Try again in a moment.'
  }
}

export function upsertNoiseCleanupJob(
  jobs: readonly NoiseCleanupJob[],
  next: NoiseCleanupJob
): NoiseCleanupJob[] {
  const index = jobs.findIndex((job) => job.id === next.id)
  if (index < 0) {
    return [...jobs, next]
  }
  if (jobs[index]?.updatedAt.localeCompare(next.updatedAt) > 0) {
    return [...jobs]
  }
  return jobs.map((job, jobIndex) => (jobIndex === index ? next : job))
}

function view(overrides: Partial<NoiseCleanupView>): NoiseCleanupView {
  return {
    directAction: null,
    menuAction: null,
    directLabel: null,
    menuLabel: null,
    disabledReason: null,
    detail: null,
    statusAnnouncement: null,
    busy: false,
    conflictsWithFileActions: false,
    premiumLocked: false,
    derivative: false,
    ...overrides
  }
}

function clampProgress(progress: number): number {
  return Math.min(100, Math.max(0, progress))
}

function coarseProgress(progress: number): number {
  return Math.round(progress / 10) * 10
}
