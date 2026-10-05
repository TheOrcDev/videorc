import { toast } from '@/lib/toast'

// Open link and Copy link on a chat row (plan 151, D10). Opening goes through
// main (`chat:open-link`), which checks the URL again and hands it to the
// browser; the app itself never navigates to a chat link.

/** Opens the link in the browser; says so when it could not. */
export async function openChatLink(href: string): Promise<void> {
  let opened = false
  try {
    opened = (await window.videorc?.openChatLink?.(href)) ?? false
  } catch (error) {
    console.warn('[chat-link] open failed', error)
  }
  if (!opened) toast.error("Couldn't open that link.")
}

/** Copies the link. The menu closing is the confirmation, as with Copy. */
export function copyChatLink(href: string): Promise<void> {
  return copyChatText(href, "Couldn't copy that link.")
}

/**
 * Copies chat text (a link, a message, an activity line). Success is quiet;
 * a refused write says so, because a silent no-op reads as a broken menu.
 */
export async function copyChatText(text: string, failure = "Couldn't copy that."): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
  } catch (error) {
    console.warn('[chat-link] copy failed', error)
    toast.error(failure)
  }
}
