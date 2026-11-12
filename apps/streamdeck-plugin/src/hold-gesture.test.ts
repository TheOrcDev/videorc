import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

import { HOLD_MS, createHoldGesture } from './hold-gesture.js'

function gesture() {
  const events: string[] = []
  const keys = createHoldGesture({
    onTap: (key) => events.push(`tap:${key}`),
    onHold: (key) => events.push(`hold:${key}`)
  })
  return { events, keys }
}

test('a press released before the hold time is a tap, on release', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { events, keys } = gesture()
    keys.down('a')
    mock.timers.tick(HOLD_MS - 1)
    assert.deepEqual(events, [])
    keys.up('a')
    assert.deepEqual(events, ['tap:a'])
    mock.timers.tick(HOLD_MS)
    assert.deepEqual(events, ['tap:a'])
  } finally {
    mock.timers.reset()
  }
})

test('a press still down at the hold time is a hold, once, while still down', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { events, keys } = gesture()
    keys.down('a')
    mock.timers.tick(HOLD_MS)
    assert.deepEqual(events, ['hold:a'])
    keys.up('a')
    assert.deepEqual(events, ['hold:a'])
  } finally {
    mock.timers.reset()
  }
})

test('two keys time their own presses', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { events, keys } = gesture()
    keys.down('a')
    mock.timers.tick(HOLD_MS / 2)
    keys.down('b')
    mock.timers.tick(HOLD_MS / 2)
    keys.up('b')
    mock.timers.tick(HOLD_MS)
    keys.up('a')
    assert.deepEqual(events, ['hold:a', 'tap:b'])
  } finally {
    mock.timers.reset()
  }
})

test('a press cancelled before the hold time is neither a tap nor a hold', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { events, keys } = gesture()
    keys.down('a')
    keys.cancel('a')
    mock.timers.tick(HOLD_MS)
    keys.up('a')
    assert.deepEqual(events, [])
  } finally {
    mock.timers.reset()
  }
})

test('a repeated key-down and a stray key-up do nothing', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { events, keys } = gesture()
    keys.up('a')
    keys.down('a')
    keys.down('a')
    keys.up('a')
    assert.deepEqual(events, ['tap:a'])
  } finally {
    mock.timers.reset()
  }
})
