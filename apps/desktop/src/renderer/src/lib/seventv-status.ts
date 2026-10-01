import type { SevenTvStatus } from '@/lib/backend'

/**
 * The muted line under Settings → General → "Show 7TV emotes in chat"
 * (plan 089). `null` when the switch is off: there is nothing to report.
 */
export function sevenTvStatusLine(status: SevenTvStatus): string | null {
  switch (status.state) {
    case 'off':
      return null
    case 'idle':
      return 'Loads when you go live.'
    case 'loading':
      return 'Loading your 7TV emotes…'
    case 'linked': {
      const count = status.emoteCount ?? 0
      const emotes = `${count.toLocaleString('en-US')} ${count === 1 ? 'emote' : 'emotes'}`
      return status.setName ? `“${status.setName}” · ${emotes}` : emotes
    }
    case 'notLinked':
      return 'No 7TV account is linked to your Twitch, Kick or YouTube channel.'
    case 'error':
      return "7TV couldn't be reached. Chat works without its emotes."
  }
}
