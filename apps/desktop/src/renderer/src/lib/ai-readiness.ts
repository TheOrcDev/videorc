import type { AiCapabilities, AiQuotaStatus, VideorcAccountSnapshot } from './backend'

export type CloudAiReadinessState =
  | 'signed-out'
  | 'session-expired'
  | 'checking'
  | 'premium-required'
  | 'server-unconfigured'
  | 'quota-exhausted'
  | 'error'
  | 'ready'

export interface CloudAiReadiness {
  ready: boolean
  state: CloudAiReadinessState
  title: string
  description: string
  inputModeLabels: string[]
  quotaLabel: string | null
}

export function cloudAiReadiness({
  account,
  capabilities,
  error,
  loading,
  quota
}: {
  account: VideorcAccountSnapshot | null
  capabilities: AiCapabilities | null
  error: string | null
  loading: boolean
  quota: AiQuotaStatus | null
}): CloudAiReadiness {
  if (account?.status !== 'signed-in') {
    return disabled('signed-out', 'Sign in required', 'Sign in to use cloud AI.')
  }

  if (loading && !capabilities) {
    return disabled('checking', 'Checking cloud AI', 'Checking Videorc AI readiness.')
  }

  if (error && !capabilities) {
    // FX2: the local account snapshot can say signed-in while the web API
    // rejects the stored token (401 surfaces as a "Sign in…" message — the
    // same signal the backend matches on). Rendering the raw error read as
    // "you are signed out" next to a signed-in sidebar; name the real
    // problem instead.
    if (/sign in/i.test(error)) {
      return disabled(
        'session-expired',
        'Videorc session expired',
        'Your sign-in expired on this device — sign in again to use cloud AI.'
      )
    }
    return disabled('error', 'Cloud AI unavailable', error)
  }

  if (!capabilities) {
    return disabled('checking', 'Checking cloud AI', 'Checking Videorc AI readiness.')
  }

  const inputModeLabels = capabilities.workflow.inputModes
    .filter((mode) => mode.enabled)
    .map((mode) => inputModeLabel(mode.kind))
  const quotaLabel = quota
    ? `${quota.today.remaining}/${quota.today.limit} today, ${quota.monthly.remaining}/${quota.monthly.limit} this month`
    : null

  if (!capabilities.entitlement.cloudAi || !capabilities.readiness.access.cloudAiEntitled) {
    return disabled(
      'premium-required',
      'Cloud AI requires Videorc Premium',
      'Upgrade to use cloud transcription, summaries, chapters, highlights, and suggestions.',
      inputModeLabels,
      quotaLabel
    )
  }

  if (capabilities.readiness.access.globallyDisabled) {
    return disabled(
      'server-unconfigured',
      'Cloud AI disabled',
      'Cloud AI is disabled on the Videorc server.',
      inputModeLabels,
      quotaLabel
    )
  }

  if (!capabilities.readiness.gateway.configured) {
    return disabled(
      'server-unconfigured',
      'Gateway not configured',
      capabilities.readiness.gateway.configError ?? 'Videorc AI Gateway is not configured.',
      inputModeLabels,
      quotaLabel
    )
  }

  if (!capabilities.readiness.worker.configured) {
    return disabled(
      'server-unconfigured',
      'AI worker not configured',
      capabilities.readiness.worker.configError ?? 'Videorc AI worker is not configured.',
      inputModeLabels,
      quotaLabel
    )
  }

  const hasTranscriptMode = capabilities.workflow.inputModes.some(
    (mode) => mode.enabled && mode.kind === 'transcript'
  )

  if (!capabilities.readiness.transcription.configured && !hasTranscriptMode) {
    return disabled(
      'server-unconfigured',
      'Transcription not configured',
      capabilities.readiness.transcription.configError ??
        'Videorc cloud transcription is not configured.',
      inputModeLabels,
      quotaLabel
    )
  }

  if (!capabilities.features.cloudAiEnabled) {
    return disabled(
      'server-unconfigured',
      'Cloud AI not ready',
      'Videorc cloud AI is not ready for this account.',
      inputModeLabels,
      quotaLabel
    )
  }

  if (quota && !quota.access.allowed) {
    return disabled(
      'quota-exhausted',
      'AI quota exhausted',
      quota.access.message ?? 'AI quota exhausted.',
      inputModeLabels,
      quotaLabel
    )
  }

  return {
    ready: true,
    state: 'ready',
    title: 'Cloud AI ready',
    description: readinessDescription(capabilities, quotaLabel),
    inputModeLabels,
    quotaLabel
  }
}

function disabled(
  state: Exclude<CloudAiReadinessState, 'ready'>,
  title: string,
  description: string,
  inputModeLabels: string[] = [],
  quotaLabel: string | null = null
): CloudAiReadiness {
  return {
    ready: false,
    state,
    title,
    description,
    inputModeLabels,
    quotaLabel
  }
}

function inputModeLabel(kind: string): string {
  switch (kind) {
    case 'multipart-audio':
      return 'audio upload'
    case 'stored-audio-object':
      return 'object upload'
    case 'transcript':
      return 'transcript'
    default:
      return kind
  }
}

function readinessDescription(capabilities: AiCapabilities, quotaLabel: string | null): string {
  const modes = capabilities.workflow.inputModes
    .filter((mode) => mode.enabled)
    .map((mode) => inputModeLabel(mode.kind))
    .join(', ')
  const model = capabilities.models.defaultTextModel ?? 'default model'
  const quota = quotaLabel ? ` ${quotaLabel}.` : ''

  return `Ready for ${modes || 'cloud AI'} with ${model}.${quota}`
}
