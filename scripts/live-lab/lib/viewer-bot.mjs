import { setTimeout as delay } from 'node:timers/promises'

import { createYoutubeClient } from './youtube-api.mjs'

// Plan 178 U8 (plan 176 L4 step 2, suite C). A real viewer in the stream's
// chat: the viewer role's token (the D3 account) on the lab Google project.
// It posts scripted messages, deletes one, and records when each was sent so
// the scenario can measure how long the app took to show it. 50 units per
// send and per delete, charged to the ledger before the call.
//
// YouTube caps a chat message at 200 characters. Slow mode applies to
// viewers (not the owner or moderators), so the script spaces every message
// by the slow-mode interval plus a margin; with slow mode off it still waits
// MIN_SPACING_MS between sends.

export const MAX_MESSAGE_CHARS = 200
export const DEFAULT_SLOW_MODE_SECONDS = 30
export const SLOW_MODE_MARGIN_MS = 1500
export const MIN_SPACING_MS = 1000
export const BURST_SIZE = 10

/** Pure: the wait between two viewer messages for a chat's slow mode. */
export function messageSpacingMs(slowModeSeconds = DEFAULT_SLOW_MODE_SECONDS) {
  const seconds = Number(slowModeSeconds) || 0
  return seconds > 0 ? seconds * 1000 + SLOW_MODE_MARGIN_MS : MIN_SPACING_MS
}

function padTo(text, length) {
  const filler = ' lorem ipsum dolor sit amet'
  let output = text
  while (output.length < length) output += filler
  return output.slice(0, length)
}

/**
 * Pure: plan 176 suite C's message set. Every message carries the run tag so
 * the scenario matches arrivals by text, never by author identity.
 * Kinds: plain, emoji, link, long (exactly 200 chars), burst-1..burst-10.
 */
export function scriptedMessages(tag) {
  const label = `[lab ${String(tag ?? 'run').slice(0, 24)}]`
  const messages = [
    { kind: 'plain', text: `${label} hello from the viewer bot` },
    { kind: 'emoji', text: `${label} emoji check 🎉🔥👋 ✅` },
    { kind: 'link', text: `${label} link check https://www.videorc.com` },
    { kind: 'long', text: padTo(`${label} 200 character message:`, MAX_MESSAGE_CHARS) }
  ]
  for (let index = 1; index <= BURST_SIZE; index += 1) {
    messages.push({ kind: `burst-${index}`, text: `${label} burst ${index} of ${BURST_SIZE}` })
  }
  return messages
}

export function validateMessage(text) {
  const value = String(text ?? '')
  if (value.trim().length === 0) throw new Error('A chat message cannot be empty.')
  // YouTube counts characters; count code points, not UTF-16 units.
  if ([...value].length > MAX_MESSAGE_CHARS) {
    throw new Error(`A chat message is at most ${MAX_MESSAGE_CHARS} characters.`)
  }
  return value
}

/**
 * @param {object} options
 * @param {(role: string) => Promise<string>} options.getToken
 * @param {object} options.ledger
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.apiBase]
 * @param {() => Date} [options.now]
 */
export function createViewerBot({
  getToken,
  ledger,
  fetch: fetchImpl = fetch,
  apiBase,
  now = () => new Date(),
  role = 'viewer',
  sleep = (ms, signal) => delay(ms, undefined, { signal })
}) {
  const client = createYoutubeClient({ getToken, ledger, fetch: fetchImpl, apiBase })

  async function send(liveChatId, text) {
    if (!liveChatId) throw new Error('send needs the broadcast liveChatId.')
    const messageText = validateMessage(text)
    const sentAt = now().toISOString()
    const result = await client.call({
      role,
      method: 'liveChatMessages.insert',
      httpMethod: 'POST',
      resource: 'liveChat/messages',
      query: { part: 'snippet' },
      body: {
        snippet: {
          liveChatId,
          type: 'textMessageEvent',
          textMessageDetails: { messageText }
        }
      }
    })
    if (!result?.id) throw new Error('liveChatMessages.insert returned no message id.')
    return { id: result.id, sentAt, publishedAt: result.snippet?.publishedAt ?? null }
  }

  async function deleteMessage(id) {
    if (!id) throw new Error('delete needs a message id.')
    await client.call({
      role,
      method: 'liveChatMessages.delete',
      httpMethod: 'DELETE',
      resource: 'liveChat/messages',
      query: { id }
    })
    return { id, deletedAt: now().toISOString() }
  }

  /**
   * Posts the suite C set, then deletes the plain message (a viewer may
   * delete their own). Stops early on abort. 14 sends + 1 delete = 750 units;
   * the caller checks `ledger.canSpend(scriptCost())` before starting.
   */
  async function runScript(
    liveChatId,
    { tag, slowModeSeconds = DEFAULT_SLOW_MODE_SECONDS, deleteKind = 'plain', signal } = {}
  ) {
    const spacing = messageSpacingMs(slowModeSeconds)
    const sent = []
    const messages = scriptedMessages(tag)
    for (const [index, message] of messages.entries()) {
      if (signal?.aborted) break
      if (index > 0) {
        try {
          await sleep(spacing, signal)
        } catch (error) {
          if (error?.name === 'AbortError') break
          throw error
        }
      }
      const result = await send(liveChatId, message.text)
      sent.push({ kind: message.kind, text: message.text, ...result })
    }
    let deleted = null
    const target = sent.find((entry) => entry.kind === deleteKind)
    if (target && !signal?.aborted) {
      deleted = await deleteMessage(target.id)
    }
    return { sent, deleted, spacingMs: spacing }
  }

  return { send, delete: deleteMessage, runScript }
}

/** Pure: units the full suite C script spends (sends + one delete). */
export function scriptCost(tag) {
  return scriptedMessages(tag).length * 50 + 50
}
