import { createContext, useContext, type ReactElement, type ReactNode } from 'react'

import {
  DEFAULT_TWITCH_GIF_MODE,
  effectiveTwitchGifMode,
  type TwitchGifMode
} from '../../../shared/chat-gif'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import type { LiveChatMessageFragment } from '@/lib/backend'

// Twitch GIF Keyboard rows (plan 155). A `gif` fragment is not an emote: it
// is drawn as its own block under the text (D5), and whether it animates
// comes from Settings → General → "GIFs in Twitch chat" (D6), relayed into
// the Stream Manager window by main.

/** A message body split around its GIFs: runs of ordinary fragments (text,
 * emotes) and the GIF fragments between them. Order is kept. */
export type ChatBodyPart =
  | { kind: 'fragments'; fragments: LiveChatMessageFragment[] }
  | { kind: 'gif'; fragment: LiveChatMessageFragment }

/** Whether a fragment is a Twitch GIF that passed the backend's asset gate. */
export function isGifFragment(fragment: LiveChatMessageFragment): boolean {
  return fragment.type === 'gif' && Boolean(fragment.imageUrl)
}

/**
 * Splits fragments into text/emote runs and GIFs. A `gif` fragment whose URL
 * the backend refused (not on the asset allowlist) has no `imageUrl` and
 * stays in the run as its title text, so the row still says what was sent.
 */
export function splitGifFragments(fragments: readonly LiveChatMessageFragment[]): ChatBodyPart[] {
  const parts: ChatBodyPart[] = []
  let run: LiveChatMessageFragment[] = []
  const flush = (): void => {
    if (run.some((fragment) => fragment.text.trim() !== '' || fragment.imageUrl)) {
      parts.push({ kind: 'fragments', fragments: run })
    }
    run = []
  }
  for (const fragment of fragments) {
    if (isGifFragment(fragment)) {
      flush()
      parts.push({ kind: 'gif', fragment })
      continue
    }
    run.push(fragment)
  }
  flush()
  return parts
}

const ChatGifModeContext = createContext<TwitchGifMode>(DEFAULT_TWITCH_GIF_MODE)

/** Supplies the GIF setting to every row below it. Without a provider rows
 * animate, the setting's default. */
export function ChatGifModeProvider({
  mode,
  children
}: {
  mode: TwitchGifMode
  children: ReactNode
}): ReactElement {
  return <ChatGifModeContext.Provider value={mode}>{children}</ChatGifModeContext.Provider>
}

/** The mode a row should draw with: the setting, forced to Still when the
 * system asks to reduce motion. */
export function useChatGifMode(): TwitchGifMode {
  const mode = useContext(ChatGifModeContext)
  const reducedMotion = useReducedMotion()
  return effectiveTwitchGifMode(mode, reducedMotion)
}
