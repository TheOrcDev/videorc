import type { SessionActivity } from '../../../shared/capture-state'

/**
 * What the session was doing when the notice was raised (`sessionActivity`).
 * The copy follows whether viewers were watching; the recovery actions follow
 * whether a file was being saved. Go Live's record+stream gets both (plan 174
 * B-6).
 */
export type SessionRuntimeActivity = SessionActivity

/** Viewers were watching: the notice speaks of the live session. */
export function activityIsLive(activity: SessionRuntimeActivity): boolean {
  return activity !== 'recording'
}

/** A local file was being saved: the notice can open it in the Library or reveal it. */
export function activitySavesRecording(activity: SessionRuntimeActivity): boolean {
  return activity !== 'live-stream'
}

export type SessionRuntimeNotice =
  | {
      kind: 'recording-failed'
      activity: SessionRuntimeActivity
      message: string
      sessionId?: string
      outputPath?: string
      at: number
    }
  | {
      kind: 'microphone-input-lost'
      audioIssues?: { code: string; message: string }[]
      activity: SessionRuntimeActivity
      phase: 'active' | 'ending' | 'ended'
      message: string
      sessionId?: string
      at: number
    }

export function sessionRuntimeNoticeTitle(notice: SessionRuntimeNotice): string {
  if (notice.kind === 'recording-failed') {
    return activityIsLive(notice.activity)
      ? 'Live session stopped unexpectedly'
      : 'Recording stopped unexpectedly'
  }

  if (notice.audioIssues?.some((issue) => issue.code !== 'microphone-input-lost')) {
    const sources = new Set(
      notice.audioIssues.map((issue) =>
        issue.code.startsWith('microphone-')
          ? 'microphone'
          : issue.code === 'system-audio-lost'
            ? 'system'
            : 'both'
      )
    )
    const subject =
      sources.size > 1 || sources.has('both')
        ? 'Microphone and system audio lost'
        : sources.has('system')
          ? 'System audio lost'
          : 'Microphone audio could not be recorded'
    return notice.phase === 'ended' ? `${subject}: saved session has missing audio` : subject
  }

  if (notice.phase === 'ended') {
    return activityIsLive(notice.activity)
      ? 'Microphone stopped during the live session'
      : 'Microphone stopped: saved recording contains silence'
  }

  if (notice.phase === 'ending') {
    return activityIsLive(notice.activity)
      ? 'Microphone stopped as the live session ends'
      : 'Microphone stopped: finishing recording with silence'
  }

  return activityIsLive(notice.activity)
    ? 'Microphone stopped: live session continues with silence'
    : 'Microphone stopped: recording continues with silence'
}
