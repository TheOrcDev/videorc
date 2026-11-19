// Plan 250 S8: the Stream Manager's bell. The notification store lives in the
// main window, which owns the backend socket; the Stream Manager has none.
// Main relays a copy of the list to it, and what is pressed there back:
//
//   main window  ── comments-window:notifications-push ──▶  main  ──▶  Stream Manager
//   Stream Manager  ── comments-window:notification-act ──▶  main  ──▶  main window
//
// An entry is plain data: the functions behind its buttons stay in the store,
// and a press travels as the entry's key and the action's id.

import {
  arraySchema,
  booleanSchema,
  enumSchema,
  literalSchema,
  nullableSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
  unionSchema
} from './runtime-schema'

export type RelayedNotificationTone = 'urgent' | 'warning' | 'news' | 'done'

export interface RelayedNotificationAction {
  id: string
  label: string
  /** A fix runs in place; a door opens a page in the main window. */
  kind: 'fix' | 'door'
}

export interface RelayedNotification {
  key: string
  kind: string
  tone: RelayedNotificationTone
  peakTone: RelayedNotificationTone
  life: 'condition' | 'event' | 'progress'
  state: 'open' | 'resolved' | 'happened' | 'running' | 'done' | 'failed'
  title: string
  detail?: string
  openedAt: number
  updatedAt: number
  resolvedAt?: number
  occurrences: number
  read: boolean
  sessionId?: string
  actions: RelayedNotificationAction[]
}

export interface NotificationsSnapshot {
  entries: RelayedNotification[]
  count: { unread: number; tone: 'urgent' | 'warning' | null; urgent: number }
  /** "Quiet while recording or live" is on (the list's footer says so). */
  quiet: boolean
}

/** What the Stream Manager asks the main window's store to do. */
export type NotificationActRequest =
  | { type: 'run'; key: string; actionId: string; door: boolean }
  | { type: 'clear'; key: string }
  | { type: 'clear-all' }
  | { type: 'mark-read'; key: string }
  | { type: 'mark-all-read' }
  | { type: 'list-open'; open: boolean }
  /** The footer's link: Settings, General, at the quiet switch. */
  | { type: 'open-settings' }

/** An urgent entry popping up in the Stream Manager, when that window is in front. */
export type NotificationPopUp =
  | {
      type: 'show'
      entry: RelayedNotification
      durationMs: number
      action?: RelayedNotificationAction
    }
  /** The problem cleared: the toast gives way to the recovery's words. */
  | { type: 'resolved'; key: string; title: string }
  | { type: 'dismiss'; key: string }

/** The list keeps 50 entries; the relay never carries more than this. */
export const RELAYED_NOTIFICATIONS_MAX = 64

const strict = { allowUnknown: false } as const
const key = stringSchema({ minLength: 1, maxLength: 512 })
const tone = enumSchema(['urgent', 'warning', 'news', 'done'])
const words = stringSchema({ maxLength: 2000 })
const time = numberSchema({ min: 0 })

const relayedActionSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1, maxLength: 128 }),
    label: stringSchema({ minLength: 1, maxLength: 200 }),
    kind: enumSchema(['fix', 'door'])
  },
  strict
)

export const relayedNotificationSchema = objectSchema(
  {
    key,
    kind: stringSchema({ minLength: 1, maxLength: 128 }),
    tone,
    peakTone: tone,
    life: enumSchema(['condition', 'event', 'progress']),
    state: enumSchema(['open', 'resolved', 'happened', 'running', 'done', 'failed']),
    title: words,
    detail: optionalSchema(words),
    openedAt: time,
    updatedAt: time,
    resolvedAt: optionalSchema(time),
    occurrences: numberSchema({ integer: true, min: 1 }),
    read: booleanSchema,
    sessionId: optionalSchema(stringSchema({ maxLength: 512 })),
    actions: arraySchema(relayedActionSchema, { maxLength: 2 })
  },
  strict
)

export const notificationsSnapshotSchema = nullableSchema(
  objectSchema(
    {
      entries: arraySchema(relayedNotificationSchema, { maxLength: RELAYED_NOTIFICATIONS_MAX }),
      count: objectSchema(
        {
          unread: numberSchema({ integer: true, min: 0 }),
          tone: nullableSchema(enumSchema(['urgent', 'warning'])),
          urgent: numberSchema({ integer: true, min: 0 })
        },
        strict
      ),
      quiet: booleanSchema
    },
    strict
  )
)

export const notificationActRequestSchema = unionSchema([
  objectSchema(
    {
      type: literalSchema('run'),
      key,
      actionId: stringSchema({ minLength: 1, maxLength: 128 }),
      door: booleanSchema
    },
    strict
  ),
  objectSchema({ type: literalSchema('clear'), key }, strict),
  objectSchema({ type: literalSchema('clear-all') }, strict),
  objectSchema({ type: literalSchema('mark-read'), key }, strict),
  objectSchema({ type: literalSchema('mark-all-read') }, strict),
  objectSchema({ type: literalSchema('list-open'), open: booleanSchema }, strict),
  objectSchema({ type: literalSchema('open-settings') }, strict)
])

export const notificationPopUpSchema = unionSchema([
  objectSchema(
    {
      type: literalSchema('show'),
      entry: relayedNotificationSchema,
      durationMs: numberSchema({ min: 0, max: 60_000 }),
      action: optionalSchema(relayedActionSchema)
    },
    strict
  ),
  objectSchema({ type: literalSchema('resolved'), key, title: words }, strict),
  objectSchema({ type: literalSchema('dismiss'), key }, strict)
])

/** A request that brings the main window forward first: it opens a page there. */
export function notificationActRaisesMainWindow(request: NotificationActRequest): boolean {
  return request.type === 'open-settings' || (request.type === 'run' && request.door)
}
