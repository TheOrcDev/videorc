import { createHash } from 'node:crypto'

import { looksSensitive } from './card-state.mjs'

// Plan 178 U9. The backend events that prove an on-stream feature happened,
// reduced to what a verdict needs and nothing that identifies a viewer:
//
//   liveChat.message / liveChat.snapshot   -> chat        (id, platform, text only for lab-tagged messages)
//   comments.highlight.status              -> highlight   (phase, messageId)
//   captions.update                        -> caption     (partial|final, text: the lab's own scripted speech)
//   captions.status                        -> captions-status
//   clip.marked                            -> clip-mark   (atSeconds, source, saved)
//   session.marker.voice.status            -> voice-marker-status
//   cohost.state                           -> buddy-state
//
// The app observer appends each record to events.ndjson and emits it on the
// bus as `feature`, so scenario steps wait on them (no polling) and the
// verdict reads them back offline. Chat text is kept only when it carries
// the viewer bot's run tag; every other message is stored as a hash.

export const LAB_TAG = /^\[lab [A-Za-z0-9._-]{1,24}\]/
const MAX_TEXT = 240

export function textHash(text) {
  return createHash('sha256')
    .update(String(text ?? ''))
    .digest('hex')
    .slice(0, 12)
}

function str(value, max = 80) {
  return typeof value === 'string' && value.length <= max && !looksSensitive(value) ? value : null
}

function scalars(payload, keys) {
  const out = {}
  for (const key of keys) {
    const value = payload?.[key]
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value
    } else if (typeof value === 'string') {
      out[key] = str(value)
    }
  }
  return out
}

function chatRecord(message, ts) {
  if (!message || typeof message !== 'object' || typeof message.id !== 'string') return null
  const text = typeof message.messageText === 'string' ? message.messageText : ''
  const tagged = LAB_TAG.test(text) && !looksSensitive(text.slice(0, MAX_TEXT))
  return {
    kind: 'chat',
    ts: typeof message.receivedAt === 'string' ? message.receivedAt : ts,
    id: message.id.slice(0, 120),
    platform: str(message.platform, 24),
    eventType: str(message.eventType, 40),
    text: tagged ? text.slice(0, MAX_TEXT) : null,
    textHash: textHash(text),
    isDeleted: message.isDeleted === true,
    isOwner: Array.isArray(message.authorRoles) && message.authorRoles.includes('owner')
  }
}

/**
 * One feature record for a backend socket message, or null. `ts` is the
 * harness clock as ISO (payload times win when the backend gives one).
 */
export function featureRecordsFromEvent(message, ts = new Date().toISOString()) {
  const event = message?.event
  const payload = message?.payload ?? {}
  switch (event) {
    case 'liveChat.message': {
      const record = chatRecord(payload.message ?? payload, ts)
      return record ? [record] : []
    }
    case 'liveChat.snapshot': {
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      return messages.map((item) => chatRecord(item, ts)).filter(Boolean)
    }
    case 'comments.highlight.status':
      return [
        {
          kind: 'highlight',
          ts,
          phase: str(payload.phase, 16),
          messageId: str(payload.messageId, 120),
          generation: Number.isFinite(payload.generation) ? payload.generation : null,
          reason: str(payload.reason, 200)
        }
      ]
    case 'captions.update': {
      const text = typeof payload.text === 'string' ? payload.text.slice(0, MAX_TEXT) : ''
      return [
        {
          kind: 'caption',
          ts,
          captionKind: str(payload.kind, 16),
          seq: Number.isFinite(payload.seq) ? payload.seq : null,
          text: looksSensitive(text) ? null : text,
          textHash: textHash(text)
        }
      ]
    }
    case 'captions.status':
      return [
        {
          kind: 'captions-status',
          ts,
          ...scalars(payload, [
            'enabled',
            'state',
            'phase',
            'status',
            'reason',
            'code',
            'available'
          ])
        }
      ]
    case 'clip.marked':
      return [
        {
          kind: 'clip-mark',
          ts,
          atSeconds: Number.isFinite(payload.atSeconds) ? payload.atSeconds : null,
          source: str(payload.source, 32),
          saved: payload.saved === true,
          reason: str(payload.reason, 200)
        }
      ]
    case 'session.marker.voice.status': {
      const listening = payload.listening
      return [
        {
          kind: 'voice-marker-status',
          ts,
          listening:
            listening && typeof listening === 'object'
              ? scalars(listening, ['listening', 'state', 'reason', 'code', 'active', 'phase'])
              : typeof listening === 'boolean'
                ? { listening }
                : null
        }
      ]
    }
    case 'cohost.state':
      return [
        {
          kind: 'buddy-state',
          ts,
          ...scalars(payload, [
            'enabled',
            'listening',
            'phase',
            'state',
            'status',
            'reason',
            'consent',
            'available'
          ])
        }
      ]
    default:
      return []
  }
}

/** Pure: words shared between a caption and the phrase it should carry (0..1). */
export function phraseOverlap(phrase, caption) {
  const words = (text) =>
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1)
  const wanted = words(phrase)
  if (wanted.length === 0) return 0
  const seen = new Set(words(caption))
  const hits = wanted.filter((word) => seen.has(word)).length
  return hits / wanted.length
}
