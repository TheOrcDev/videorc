import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  countNotifications,
  describeNotifications,
  findNotifications,
  normalizeNotifications,
  notificationTexts,
  READ_NOTIFICATIONS_CODE,
  readNotificationsExpression
} from './notifications-smoke.mjs'

const read = {
  hook: true,
  bellCount: 2,
  bellTone: 'urgent',
  count: { unread: 2, urgent: 1, tone: 'urgent' },
  entries: [
    {
      key: 'microphone',
      kind: 'microphone',
      tone: 'urgent',
      state: 'open',
      title: 'Microphone is silent',
      detail: 'No sound for 40 s.',
      read: false,
      actions: [{ id: 'open-audio', label: 'Open Audio', kind: 'door' }]
    },
    { key: 'youtube-budget', tone: 'news', state: 'happened', title: 'YouTube is paused' },
    { title: 'no key: dropped' },
    null
  ]
}

test('normalizes a read into plain entries, and survives a page with nothing to say', () => {
  assert.deepEqual(normalizeNotifications(read).entries, [
    {
      key: 'microphone',
      kind: 'microphone',
      tone: 'urgent',
      state: 'open',
      title: 'Microphone is silent',
      detail: 'No sound for 40 s.',
      read: false,
      occurrences: 1,
      actions: ['Open Audio']
    },
    {
      key: 'youtube-budget',
      kind: null,
      tone: 'news',
      state: 'happened',
      title: 'YouTube is paused',
      detail: '',
      read: false,
      occurrences: 1,
      actions: []
    }
  ])
  assert.deepEqual(normalizeNotifications(undefined), {
    hook: false,
    bellCount: null,
    bellTone: null,
    count: null,
    entries: []
  })
})

test('finds entries by key, title, tone and state; every field given must match', () => {
  assert.equal(findNotifications(read, { key: 'microphone' }).length, 1)
  assert.equal(findNotifications(read, { key: /^youtube-/ }).length, 1)
  assert.equal(findNotifications(read, { title: /paused/, tone: 'news' }).length, 1)
  assert.equal(findNotifications(read, { title: /paused/, tone: 'urgent' }).length, 0)
  assert.equal(findNotifications(read, { state: 'open' }).length, 1)
  assert.equal(findNotifications(read).length, 2)
})

test('counts a notice once per occurrence, so a repeat on one row is still a storm', () => {
  const repeated = {
    entries: [{ key: 'youtube-budget:paused', title: 'YouTube is paused', occurrences: 3 }]
  }
  assert.equal(countNotifications(repeated, { title: /YouTube/i }), 3)
  assert.equal(countNotifications(read, { title: /YouTube/i }), 1)
  assert.equal(countNotifications(read, { title: /Kick/i }), 0)
})

test('a /g pattern counts every matching entry, on every read', () => {
  const two = {
    ...read,
    entries: [
      { key: 'youtube-budget', title: 'YouTube is paused' },
      { key: 'youtube-chat', title: 'YouTube is paused' }
    ]
  }
  // A global RegExp remembers where its last match ended.
  const pattern = /YouTube/gi
  assert.equal(countNotifications(two, { title: pattern }), 2)
  assert.equal(countNotifications(two, { title: pattern }), 2)
  assert.equal(findNotifications(two, { key: /^youtube-/g }).length, 2)
})

test('reads like the toast text a smoke used to collect', () => {
  assert.deepEqual(notificationTexts(read), [
    'Microphone is silent: No sound for 40 s.',
    'YouTube is paused'
  ])
  assert.equal(
    describeNotifications(read),
    ' Notifications: Microphone is silent: No sound for 40 s. | YouTube is paused'
  )
  assert.equal(describeNotifications({ entries: [] }), '')
})

test('the renderer code reads the hook and the bell, and never opens the list', () => {
  assert.match(READ_NOTIFICATIONS_CODE, /__videorcSmokeNotifications/)
  assert.match(READ_NOTIFICATIONS_CODE, /data-videorc-notification-count/)
  assert.doesNotMatch(READ_NOTIFICATIONS_CODE, /\.click\(/)
  assert.match(readNotificationsExpression(), /^\(async \(\) => \{/)
  // It must parse as an async function body, the way eval-js runs it.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.doesNotThrow(() => new AsyncFunction(READ_NOTIFICATIONS_CODE))
})
