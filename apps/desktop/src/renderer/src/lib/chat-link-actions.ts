import { copyText, type CopyFailure } from '@/lib/copy-text'
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
  if (!opened) {
    toast.error("Couldn't open that link", {
      description: 'Copy it and open it in your browser.'
    })
  }
}

/** Copies the link. The menu closing is the confirmation, as with Copy. */
export function copyChatLink(href: string): Promise<void> {
  return copyChatText(href, {
    title: "Couldn't copy that link",
    description: 'Select the text and copy it from there.'
  })
}

/**
 * Copies chat text (a link, a message, an activity line) through the shared
 * copyText (plan 174 S1.6b): success is quiet, a refused write says so.
 */
export async function copyChatText(
  text: string,
  failure: CopyFailure = "Couldn't copy that."
): Promise<void> {
  await copyText(text, failure)
}
