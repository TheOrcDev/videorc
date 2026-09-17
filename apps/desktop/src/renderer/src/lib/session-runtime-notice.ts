export type SessionRuntimeActivity = 'recording' | 'live-stream'

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
      activity: SessionRuntimeActivity
      phase: 'active' | 'ending' | 'ended'
      message: string
      sessionId?: string
      at: number
    }

export function sessionRuntimeNoticeTitle(notice: SessionRuntimeNotice): string {
  if (notice.kind === 'recording-failed') {
    return notice.activity === 'live-stream'
      ? 'Live session stopped unexpectedly'
      : 'Recording stopped unexpectedly'
  }

  if (notice.phase === 'ended') {
    return notice.activity === 'live-stream'
      ? 'Microphone stopped during the live session'
      : 'Microphone stopped — saved recording contains silence'
  }

  if (notice.phase === 'ending') {
    return notice.activity === 'live-stream'
      ? 'Microphone stopped as the live session ends'
      : 'Microphone stopped — finishing recording with silence'
  }

  return notice.activity === 'live-stream'
    ? 'Microphone stopped — live session continues with silence'
    : 'Microphone stopped — recording continues with silence'
}
