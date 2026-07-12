export interface NativePreviewProofPollingProfile {
  intervalMs: number
  maxWidth: number
}

const IDLE_PROOF_POLLING_PROFILE: NativePreviewProofPollingProfile = {
  intervalMs: 40,
  maxWidth: 1920
}

const RECORDING_PROOF_POLLING_PROFILE: NativePreviewProofPollingProfile = {
  // Windows' proof surface is production preview, so it must stay live while
  // recording. Keep it useful without spending the recording's CPU budget on
  // 25 full-resolution channel swaps, Lanczos resizes, and PNG encodes/sec.
  intervalMs: 125,
  maxWidth: 960
}

export function nativePreviewProofFrameUrl(url: string, maxWidth?: number): string {
  if (typeof maxWidth !== 'number' || !Number.isFinite(maxWidth) || maxWidth <= 0) {
    return url
  }
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('maxWidth', String(Math.max(1, Math.round(maxWidth))))
    return parsed.toString()
  } catch {
    return url
  }
}

export function nativePreviewProofPollingProfile(
  recordingActive: boolean
): NativePreviewProofPollingProfile {
  return recordingActive
    ? { ...RECORDING_PROOF_POLLING_PROFILE }
    : { ...IDLE_PROOF_POLLING_PROFILE }
}

export function nativePreviewProofPollingProfileKey(
  surfaceWindowId: number,
  profile: NativePreviewProofPollingProfile
): string {
  return `${surfaceWindowId}:${profile.intervalMs}:${profile.maxWidth}`
}
