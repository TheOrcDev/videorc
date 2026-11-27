import assert from 'node:assert/strict'
import test from 'node:test'
import { createLiveServiceGpui } from './live-service-gpui.mjs'

test('native service operations survive relaunch without retaining the old command connection', async () => {
  let connection = { id: 'first' }
  const calls = []
  const driver = createLiveServiceGpui(() => connection, {
    request: async (socket, command, params) => {
      calls.push({ socket, command, params })
      return { open: command === 'studio-go-live' }
    }
  })
  await driver.mutate('recover', { eventId: 'show', expectedRevision: 4, candidateId: 'ingest' })
  connection = { id: 'restarted' }
  assert.equal(await driver.confirmationOpen(), true)
  assert.equal(calls[0].socket.id, 'first')
  assert.deepEqual(calls[0].params, {
    action: 'recover',
    params: { eventId: 'show', expectedRevision: 4, candidateId: 'ingest' }
  })
  assert.equal(calls[1].socket.id, 'restarted')
  assert.ok(calls.every((call) => call.command !== 'eval-js'))
})

test('only the transient scene-change refusal is retried; provider failures propagate once', async () => {
  let calls = 0
  const retry = createLiveServiceGpui(() => ({}), {
    request: async () => {
      if (++calls === 1) throw new Error('The scene is changing.')
      return { configured: true }
    }
  })
  assert.deepEqual(await retry.configure({ streamEnabled: true }), { configured: true })
  assert.equal(calls, 2)
  calls = 0
  const refuse = createLiveServiceGpui(() => ({}), {
    request: async () => {
      calls++
      throw new Error('Provider revision conflict')
    }
  })
  await assert.rejects(refuse.mutate('schedule', { eventId: 'show' }), /revision conflict/)
  assert.equal(calls, 1)
})

test('a disabled button is not clicked and a disconnected driver is not mistaken for missing UI', async () => {
  const commands = []
  const driver = createLiveServiceGpui(() => ({}), {
    request: async (_, command) => {
      commands.push(command)
      return { element: { enabled: false } }
    }
  })
  assert.equal(await driver.clickEnabled({ name: 'Update X' }), false)
  assert.deepEqual(commands, ['ui-find'])
  const lost = createLiveServiceGpui(() => ({}), {
    request: async () => {
      throw new Error('ECONNREFUSED')
    }
  })
  await assert.rejects(lost.exists({ id: 'x-live-title' }), /ECONNREFUSED/)
})

test('select evidence preserves displayed order and scopes picks to the open popup', async () => {
  const calls = []
  const driver = createLiveServiceGpui(() => ({}), {
    request: async (_, command, params) => {
      calls.push({ command, params })
      if (command === 'ui-find') return { element: { id: 'select-content', enabled: true } }
      if (command === 'ui-tree')
        return {
          id: 'select-content',
          children: [
            { id: '0', label: '', children: [{ label: 'No category' }] },
            { id: '1', label: '', children: [{ label: 'Gaming' }] },
            { id: '2', label: '', children: [{ label: 'Just Chatting' }] }
          ]
        }
      return { clicked: true }
    }
  })
  assert.deepEqual(await driver.options(), ['No category', 'Gaming', 'Just Chatting'])
  await driver.pickFirst()
  const click = calls.find((call) => call.command === 'ui-click')
  assert.equal(click.params.label, 'No category')
  assert.deepEqual(click.params.within, { id: 'select-content' })
})

test('offscreen native controls scroll before retry; ambiguous failures never replay a click', async () => {
  const commands = []
  let clicks = 0
  const driver = createLiveServiceGpui(() => ({}), {
    request: async (_, command) => {
      commands.push(command)
      if (command === 'ui-click' && ++clicks === 1)
        throw new Error(
          'X category is outside the window (640, 1013 in 1650×880); scroll it into view first.'
        )
      return { clicked: true }
    }
  })
  await driver.ui().click({ id: 'x-category' })
  assert.deepEqual(commands, ['ui-click', 'ui-scroll', 'ui-click'])
  const lost = createLiveServiceGpui(() => ({}), {
    request: async () => {
      throw new Error('socket hang up')
    }
  })
  await assert.rejects(lost.ui().click({ id: 'x-category' }), /socket hang up/)
})
