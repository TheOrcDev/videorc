import type {
  LiveChatMessage,
  LiveChatSnapshot,
  StreamPlatform,
  LiveChatEventType
} from './backend'

export const MAX_CHAT_DELIVERIES = 2000
export interface ChatDeliveryBoundary {
  ownerId: string
  generation: number
}
export interface ChatDeliveryMessage {
  id: string
  platform: StreamPlatform
  eventType: LiveChatEventType
  authorName: string
  messageText: string
  isDeleted: boolean
  activity: boolean
  communityGiftId?: string
  gift?: 'community' | 'single'
}
export interface ChatDelivery extends ChatDeliveryBoundary {
  sequence: number
  /** Owned queue overflow; independent of known admission sequence. */
  lossRevision?: number
  entries: Array<{ sequence: number; message: ChatDeliveryMessage }>
  source?: ChatDeliveryBoundary
  cleared?: boolean
}
export interface ChatDeliveryCursor extends ChatDeliveryBoundary {
  sequence: number
  lossRevision?: number
}

export function validateChatDeliveryBoundary(value: ChatDeliveryBoundary): ChatDeliveryBoundary {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((key) => !['ownerId', 'generation'].includes(key)) ||
    typeof value.ownerId !== 'string' ||
    !value.ownerId ||
    value.ownerId.length > 128 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  )
    throw new Error('Invalid chat delivery boundary')
  return value
}
export const chatDeliveryBoundary = (delivery: ChatDelivery): ChatDeliveryBoundary => ({
  ownerId: delivery.ownerId,
  generation: delivery.generation
})

export function validateChatDelivery(value: ChatDelivery): ChatDelivery {
  const safe = (number: number) => Number.isSafeInteger(number) && number >= 0
  const boundary = (input: ChatDeliveryBoundary) =>
    input !== null &&
    typeof input === 'object' &&
    typeof input.ownerId === 'string' &&
    input.ownerId.length > 0 &&
    input.ownerId.length <= 128 &&
    safe(input.generation)
  if (
    !boundary(value) ||
    !safe(value.sequence) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_CHAT_DELIVERIES ||
    (value.source !== undefined && !validateChatDeliveryBoundary(value.source)) ||
    (value.cleared !== undefined && typeof value.cleared !== 'boolean') ||
    (value.lossRevision !== undefined && !safe(value.lossRevision))
  )
    throw new Error('Invalid chat delivery boundary')
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'ownerId',
          'generation',
          'sequence',
          'entries',
          'source',
          'cleared',
          'lossRevision'
        ].includes(key)
    )
  )
    throw new Error('Invalid chat delivery fields')
  if (value.entries.length !== Math.min(MAX_CHAT_DELIVERIES, value.sequence))
    throw new Error('Incomplete chat delivery journal')
  let previous = value.sequence - value.entries.length
  for (const entry of value.entries) {
    if (
      !safe(entry.sequence) ||
      entry.sequence !== previous + 1 ||
      entry.sequence > value.sequence ||
      typeof entry.message?.id !== 'string' ||
      typeof entry.message.messageText !== 'string' ||
      typeof entry.message.authorName !== 'string' ||
      typeof entry.message.isDeleted !== 'boolean' ||
      typeof entry.message.activity !== 'boolean' ||
      !['youtube', 'twitch', 'kick', 'x', 'tiktok', 'instagram', 'custom'].includes(
        entry.message.platform
      ) ||
      ![
        'message',
        'paid',
        'membership',
        'follow',
        'power-up',
        'redemption',
        'moderation',
        'system',
        'deleted'
      ].includes(entry.message.eventType) ||
      (entry.message.communityGiftId !== undefined &&
        typeof entry.message.communityGiftId !== 'string') ||
      (entry.message.gift !== undefined && !['community', 'single'].includes(entry.message.gift)) ||
      (entry.message.isDeleted &&
        (entry.message.messageText !== '' ||
          entry.message.authorName !== '' ||
          entry.message.activity ||
          entry.message.communityGiftId !== undefined ||
          entry.message.gift !== undefined))
    )
      throw new Error('Invalid chat delivery entry')
    if (
      Object.keys(entry).some((key) => !['sequence', 'message'].includes(key)) ||
      Object.keys(entry.message).some(
        (key) =>
          ![
            'id',
            'platform',
            'eventType',
            'authorName',
            'messageText',
            'isDeleted',
            'activity',
            'communityGiftId',
            'gift'
          ].includes(key)
      )
    )
      throw new Error('Invalid chat delivery fields')
    previous = entry.sequence
  }
  return value
}

function initialDelivery(current?: ChatDelivery): ChatDelivery {
  return (
    current ?? {
      ownerId: crypto.randomUUID(),
      generation: 0,
      sequence: 0,
      lossRevision: 0,
      entries: []
    }
  )
}
const redacted = (message: ChatDeliveryMessage): ChatDeliveryMessage => ({
  id: message.id,
  platform: message.platform,
  eventType: 'deleted',
  authorName: '',
  messageText: '',
  isDeleted: true,
  activity: false
})
function redact(
  delivery: ChatDelivery,
  messages: readonly Pick<LiveChatMessage, 'id' | 'isDeleted'>[]
): ChatDelivery {
  const deleted = new Set(
    messages.filter((message) => message.isDeleted).map((message) => message.id)
  )
  if (!deleted.size) return delivery
  return {
    ...delivery,
    entries: delivery.entries.map((entry) =>
      deleted.has(entry.message.id) ? { ...entry, message: redacted(entry.message) } : entry
    )
  }
}

/** Local owner only: snapshot rows are hydration, never admission evidence.
 * Provider and main sequences are independent. Main remembers the provider's
 * boundary separately, adopted explicitly by the live publisher, to fence pre-clear/reload
 * replies. Its admitted rows survive the provider's older 16ms view. Detached
 * snapshots use trustOwner because only the broker can publish that owner.
 * Journals are capped independently of chronological paint retention. Dedupe
 * remains the retained reducer's policy, never a lifetime ID set. Tombstones
 * redact journal facts before classification; previously observed counts stay.
 * Facts cover the production platform/question/mention/search filters and
 * Activity membership/community-gift suppression. Avatars, fragments, amounts,
 * event detail values and author badges/roles are intentionally absent.
 * An owned bootstrap/recovery overflow advances lossRevision, not admissions.
 * A cursor overrun gives only retained matching evidence and an incomplete
 * indicator, never an inferred exact filtered count. Reopen baselines current
 * progress; clear/session replacement restarts it. Adoption is ordered through
 * authenticated publisher IPC and never forwarded as broker-owner authority.
 */
export function hydrateChatDelivery(
  incoming: LiveChatSnapshot,
  current?: LiveChatSnapshot | null,
  { reset = false, trustOwner = false, foreignSource = false } = {}
): LiveChatSnapshot {
  const incomingDelivery =
    incoming.delivery === undefined ? undefined : validateChatDelivery(incoming.delivery)
  const prior = current?.delivery && validateChatDelivery(current.delivery)
  let delivery = initialDelivery(prior)
  // Authorize the publisher before considering a session transition. Adoption
  // survives hydration of the first session and is not an arrival/reset.
  if (
    foreignSource &&
    delivery.source &&
    (!incomingDelivery ||
      incomingDelivery.ownerId !== delivery.source.ownerId ||
      incomingDelivery.generation !== delivery.source.generation)
  )
    return current!
  const sameSession = current?.sessionId === incoming.sessionId
  if (!current || !sameSession || reset) {
    if (trustOwner && incomingDelivery)
      delivery = { ...incomingDelivery, lossRevision: incomingDelivery.lossRevision ?? 0 }
    else
      delivery = {
        ownerId: delivery.ownerId,
        generation: prior ? prior.generation + 1 : 0,
        sequence: 0,
        lossRevision: 0,
        entries: [],
        ...(delivery.source ? { source: delivery.source } : {}),
        ...(reset ? { cleared: true } : {})
      }
    return { ...incoming, delivery: redact(validateChatDelivery(delivery), incoming.messages) }
  }
  if (incomingDelivery?.ownerId === delivery.ownerId) {
    if (incomingDelivery.generation < delivery.generation) return current
    if (incomingDelivery.generation > delivery.generation)
      return {
        ...incoming,
        delivery: redact(
          { ...incomingDelivery, lossRevision: incomingDelivery.lossRevision ?? 0 },
          incoming.messages
        )
      }
    if (incomingDelivery.sequence >= delivery.sequence)
      delivery = {
        ...incomingDelivery,
        lossRevision: Math.max(incomingDelivery.lossRevision ?? 0, delivery.lossRevision ?? 0)
      }
  } else if (trustOwner && incomingDelivery) {
    return {
      ...incoming,
      delivery: redact(
        { ...incomingDelivery, lossRevision: incomingDelivery.lossRevision ?? 0 },
        incoming.messages
      )
    }
  } else if (incomingDelivery && foreignSource && delivery.source) {
    delivery = { ...delivery, cleared: false }
  } else if (foreignSource && delivery.cleared) {
    // A legacy snapshot cannot prove it belongs after the clear barrier.
    return { ...current, providers: incoming.providers }
  }
  // A tombstone retained only in the admission journal remains authoritative
  // even when its chronological row was immediately trimmed.
  const deletedIds = new Set(
    prior?.entries.filter((entry) => entry.message.isDeleted).map((entry) => entry.message.id)
  )
  delivery = redact(
    redact(delivery, prior?.entries.map((entry) => entry.message) ?? []),
    incoming.messages
  )
  const admitted = new Set(delivery.entries.map((entry) => entry.message.id))
  const byId = new Map(
    incoming.messages.map((message) => [
      message.id,
      deletedIds.has(message.id) && !message.isDeleted
        ? {
            ...message,
            isDeleted: true,
            eventType: 'deleted' as const,
            messageText: '',
            fragments: [],
            details: undefined,
            amountText: undefined
          }
        : message
    ])
  )
  for (const message of current.messages) {
    if (message.isDeleted && byId.has(message.id)) byId.set(message.id, message)
    else if (admitted.has(message.id) && !byId.has(message.id)) byId.set(message.id, message)
  }
  delivery = redact(delivery, [...byId.values()])
  return { ...incoming, messages: [...byId.values()], delivery }
}

/** Called only after the retained reducer admits a new ID or its tombstone. */
export function admitChatDelivery(
  snapshot: LiveChatSnapshot,
  incoming: readonly LiveChatMessage[]
): ChatDelivery {
  let delivery = initialDelivery(snapshot.delivery)
  const known = new Map(snapshot.messages.map((message) => [message.id, message]))
  const entries = delivery.entries.slice()
  for (const message of incoming) {
    const previous = known.get(message.id)
    if (message.isDeleted) {
      for (let index = 0; index < entries.length; index++)
        if (entries[index].message.id === message.id)
          entries[index] = { ...entries[index], message: redacted(entries[index].message) }
    } else if (!previous) {
      const details = message.details
      delivery = { ...delivery, sequence: delivery.sequence + 1 }
      entries.push({
        sequence: delivery.sequence,
        message: {
          id: message.id,
          platform: message.platform,
          eventType: message.eventType,
          authorName: message.authorName,
          messageText: message.messageText,
          isDeleted: false,
          activity: Boolean(details),
          ...(details?.kind === 'subscription' && details.communityGiftId
            ? {
                communityGiftId: details.communityGiftId,
                ...(details.subscription === 'community-sub-gift'
                  ? { gift: 'community' as const }
                  : details.subscription === 'sub-gift'
                    ? { gift: 'single' as const }
                    : {})
              }
            : {})
        }
      })
    }
    if (!previous || (message.isDeleted && !previous.isDeleted)) known.set(message.id, message)
  }
  return validateChatDelivery({ ...delivery, entries: entries.slice(-MAX_CHAT_DELIVERIES) })
}

export function resetChatDelivery(
  snapshot: LiveChatSnapshot,
  source?: ChatDeliveryBoundary
): ChatDelivery {
  const current = initialDelivery(snapshot.delivery)
  if (source) validateChatDeliveryBoundary(source)
  return validateChatDelivery({
    ownerId: current.ownerId,
    generation: current.generation + 1,
    sequence: 0,
    lossRevision: 0,
    entries: [],
    cleared: true,
    ...(source ? { source } : {})
  })
}
export const deliveryCursor = (delivery?: ChatDelivery): ChatDeliveryCursor | null =>
  delivery
    ? {
        ownerId: delivery.ownerId,
        generation: delivery.generation,
        sequence: delivery.sequence,
        lossRevision: delivery.lossRevision ?? 0
      }
    : null
export function chatDeliveryProgress(
  delivery: ChatDelivery | undefined,
  previous: ChatDeliveryCursor | null,
  matches: (message: ChatDeliveryMessage) => boolean
) {
  const cursor = deliveryCursor(delivery)
  if (
    !delivery ||
    !previous ||
    previous.ownerId !== delivery.ownerId ||
    previous.generation !== delivery.generation
  )
    return { cursor, count: 0, reset: true, incomplete: false }
  const first = delivery.entries[0]?.sequence ?? delivery.sequence + 1
  const fresh = delivery.entries.filter(
    (entry) => entry.sequence > previous.sequence && !entry.message.isDeleted
  )
  return {
    cursor,
    count: fresh.filter((entry) => matches(entry.message)).length,
    reset: false,
    incomplete:
      previous.sequence < first - 1 || (previous.lossRevision ?? 0) < (delivery.lossRevision ?? 0)
  }
}

/** Overflow is uncertainty, never a synthetic message admission. */
export function markChatDeliveryIncomplete(snapshot: LiveChatSnapshot): LiveChatSnapshot {
  const delivery = initialDelivery(snapshot.delivery)
  return {
    ...snapshot,
    delivery: validateChatDelivery({ ...delivery, lossRevision: (delivery.lossRevision ?? 0) + 1 })
  }
}

export function adoptChatDelivery(
  snapshot: LiveChatSnapshot,
  boundary: ChatDeliveryBoundary
): ChatDelivery {
  validateChatDeliveryBoundary(boundary)
  const delivery = initialDelivery(snapshot.delivery)
  return { ...delivery, source: boundary }
}

/** Same Activity admission rule as its painted rows: a community summary
 * supersedes its individual gifts, while ordinary notices remain distinct. */
export function chatDeliveryActivityMatches(
  message: ChatDeliveryMessage,
  communityGifts: ReadonlySet<string>
): boolean {
  return (
    message.activity &&
    !(
      message.gift === 'single' &&
      message.communityGiftId !== undefined &&
      communityGifts.has(message.communityGiftId)
    )
  )
}
