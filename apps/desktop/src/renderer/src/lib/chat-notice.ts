import type { LiveChatMessage } from '@/lib/backend'

/**
 * The viewer's own words on a Twitch notice (plan 151, D3). A sub, resub or
 * watch streak carries Twitch's sentence in `messageText` and whatever the
 * viewer typed with it in `fragments`. Undefined for every other row, for an
 * announcement (its `messageText` already is the words), and when the
 * viewer typed nothing.
 */
export function noticeViewerWords(
  message: Pick<LiveChatMessage, 'rawProviderType' | 'fragments' | 'messageText' | 'details'>
): string | undefined {
  if (!message.rawProviderType?.startsWith('channel.chat.notification')) return undefined
  if (message.details?.kind === 'announcement') return undefined
  const words = message.fragments
    .map((fragment) => fragment.text)
    .join('')
    .trim()
  if (!words || words === message.messageText.trim()) return undefined
  return words
}
