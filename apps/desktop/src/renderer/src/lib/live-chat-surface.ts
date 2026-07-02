import type { LiveChatSnapshot, RecordingState } from '@/lib/backend'

export function hasLiveChatTranscript(snapshot: Pick<LiveChatSnapshot, 'messages'>): boolean {
  return snapshot.messages.length > 0
}

export function liveChatRailAvailable(
  recordingState: RecordingState,
  snapshot: Pick<LiveChatSnapshot, 'messages'>
): boolean {
  return recordingState === 'streaming' || hasLiveChatTranscript(snapshot)
}

export function shouldAutoOpenLiveChatRail({
  alreadyAutoOpened,
  providersAttached,
  recordingState,
  snapshot
}: {
  alreadyAutoOpened: boolean
  providersAttached: boolean
  recordingState: RecordingState
  snapshot: Pick<LiveChatSnapshot, 'messages'>
}): boolean {
  if (alreadyAutoOpened) {
    return false
  }
  if (recordingState === 'streaming') {
    return providersAttached
  }
  return hasLiveChatTranscript(snapshot)
}
