import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'

import { createPreviewLifecycleEvidence } from './preview-lifecycle-evidence.mjs'
import { requestSmokeCommand } from './smoke-command-client.mjs'

const capability = 'a'.repeat(43)
const notReady = 'Main window is not ready for preview motion smoke.'
const evidencePrefix = '[smoke] preview-lifecycle-evidence '

async function ownedServer(handler, run) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    await run({ host: '127.0.0.1', port: address.port, capability })
  } finally {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned HTTP fixture did not close.')), 2000)
      server.close((error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
      server.closeAllConnections()
    })
  }
}

for (const scenario of [
  {
    cycle: 29,
    action: 'toggle-open',
    command: 'preview-window-toggle',
    params: { expectedOpen: true }
  },
  { cycle: 11, action: 'dock', command: 'preview-window-set-mode', params: { mode: 'docked' } }
]) {
  test('retains exact failed phase through the HTTP client: ' + scenario.action, async () => {
    let requests = 0
    const evidence = createPreviewLifecycleEvidence({ request: requestSmokeCommand })
    evidence.setContext({ cycle: scenario.cycle, action: scenario.action })
    await ownedServer(
      (_request, response) => {
        requests += 1
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: notReady }))
      },
      async (smoke) => {
        await assert.rejects(
          evidence.request(smoke, scenario.command, scenario.params, { timeoutMs: 1000 }),
          (error) => error.message === notReady
        )
      }
    )
    assert.equal(requests, 1)
    assert.deepEqual(evidence.snapshot().failedRequest, {
      cycle: scenario.cycle,
      action: scenario.action,
      command: scenario.command,
      errorKind: 'main-not-ready'
    })
  })
}

test('forwards the existing target-state retry and preserves successful results', async () => {
  const evidence = createPreviewLifecycleEvidence()
  const observed = []
  let requests = 0
  await ownedServer(
    (request, response) => {
      requests += 1
      if (requests === 1) {
        request.socket.destroy()
        return
      }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        observed.push(JSON.parse(body))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, result: { open: true } }))
      })
    },
    async (smoke) => {
      evidence.setContext({ cycle: 1, action: 'toggle-open' })
      assert.deepEqual(
        await evidence.request(
          smoke,
          'preview-window-toggle',
          { expectedOpen: true },
          {
            timeoutMs: 1000,
            retryDelayMs: 1
          }
        ),
        { open: true }
      )
    }
  )
  assert.equal(requests, 2)
  assert.deepEqual(observed, [{ command: 'preview-window-toggle', params: { expectedOpen: true } }])
  assert.equal(evidence.snapshot().failedRequest, null)
})

test('keeps the exact rejection object instead of replacing it with diagnostic failure', async () => {
  const failure = new Error('preview generation is stale')
  const evidence = createPreviewLifecycleEvidence({
    request: async () => {
      throw failure
    }
  })
  evidence.setContext({ cycle: 1, action: 'stale-destroy' })
  await assert.rejects(evidence.request({}, 'apply-native-preview-host-commands'), (error) => {
    assert.equal(error, failure)
    return true
  })
})

test('retains only allowlisted main evidence without readiness capabilities or private window data', () => {
  const evidence = createPreviewLifecycleEvidence()
  evidence.observeLine(
    '[smoke] preview-motion-ready ' +
      JSON.stringify({
        capability: 'private-capability-canary',
        appPid: 123,
        windowId: 456
      })
  )
  evidence.observeLine(
    evidencePrefix +
      JSON.stringify({
        events: [
          {
            event: 'closed-after-cleanup',
            atMs: 1000,
            callbackOwnerIsCurrent: false,
            disposition: 'absent',
            quitPrevented: true,
            appIsQuitting: false,
            title: 'private-title-canary',
            handle: 'private-handle-canary'
          }
        ],
        omittedEvents: 2,
        failedCommand: {
          command: 'preview-window-toggle',
          disposition: 'absent',
          firstAtMs: 1001,
          lastAtMs: 1010,
          attempts: 2,
          params: { token: 'private-token-canary' }
        }
      })
  )
  assert.deepEqual(evidence.snapshot().main, {
    events: [
      {
        event: 'closed-after-cleanup',
        atMs: 1000,
        callbackOwnerIsCurrent: false,
        disposition: 'absent',
        quitPrevented: true,
        appIsQuitting: false
      }
    ],
    omittedEvents: 2,
    failedCommand: {
      command: 'preview-window-toggle',
      disposition: 'absent',
      firstAtMs: 1001,
      lastAtMs: 1010,
      attempts: 2
    }
  })
  assert.doesNotMatch(
    JSON.stringify(evidence.snapshot()),
    /private-|capability|appPid|windowId|handle|title|params/
  )
})

function mainEvidence() {
  return {
    events: [
      {
        event: 'renderer-gone',
        atMs: 1000,
        callbackOwnerIsCurrent: true,
        disposition: 'ready',
        quitPrevented: true,
        appIsQuitting: false,
        rendererGoneReason: 'crashed'
      }
    ],
    omittedEvents: 0,
    failedCommand: null
  }
}

test('rejects malformed or oversized evidence without replacing the last valid projection', () => {
  const evidence = createPreviewLifecycleEvidence()
  evidence.observeLine(evidencePrefix + JSON.stringify(mainEvidence()))
  const valid = evidence.snapshot()
  const malformed = [
    null,
    [],
    {},
    { ...mainEvidence(), events: Array(33).fill(mainEvidence().events[0]) },
    { ...mainEvidence(), omittedEvents: -1 },
    { ...mainEvidence(), omittedEvents: Number.MAX_SAFE_INTEGER + 1 },
    { ...mainEvidence(), events: [{ ...mainEvidence().events[0], atMs: '1000' }] },
    {
      ...mainEvidence(),
      events: [{ ...mainEvidence().events[0], callbackOwnerIsCurrent: 'true' }]
    },
    { ...mainEvidence(), events: [{ ...mainEvidence().events[0], event: 'private-event-canary' }] },
    {
      ...mainEvidence(),
      events: [{ ...mainEvidence().events[0], disposition: 'private-disposition-canary' }]
    },
    {
      ...mainEvidence(),
      failedCommand: {
        command: 'app-quit',
        disposition: 'absent',
        firstAtMs: 2,
        lastAtMs: 1,
        attempts: 1
      }
    },
    {
      ...mainEvidence(),
      failedCommand: {
        command: 'app-quit',
        disposition: 'absent',
        firstAtMs: 1,
        lastAtMs: 2,
        attempts: 0
      }
    }
  ]
  for (const value of malformed) {
    assert.doesNotThrow(() => evidence.observeLine(evidencePrefix + JSON.stringify(value)))
    assert.deepEqual(evidence.snapshot(), valid)
  }
  for (const line of [null, evidencePrefix + '{', evidencePrefix + ' '.repeat(16384)]) {
    assert.doesNotThrow(() => evidence.observeLine(line))
    assert.deepEqual(evidence.snapshot(), valid)
  }
})

test('accepts the full bounded ring and returns independent snapshots', () => {
  const evidence = createPreviewLifecycleEvidence()
  evidence.observeLine(
    evidencePrefix +
      JSON.stringify({
        ...mainEvidence(),
        events: Array.from({ length: 32 }, (_, index) => ({
          ...mainEvidence().events[0],
          atMs: 1000 + index
        })),
        omittedEvents: 10
      })
  )
  const snapshot = evidence.snapshot()
  assert.equal(snapshot.main.events.length, 32)
  assert.equal(snapshot.main.omittedEvents, 10)
  snapshot.main.events[0].disposition = 'unknown'
  snapshot.main.events.length = 0
  assert.equal(evidence.snapshot().main.events.length, 32)
  assert.equal(evidence.snapshot().main.events[0].disposition, 'ready')
})

test('captures context before await and preserves the first failure through teardown', async () => {
  let rejectRequest
  const firstError = new Error(notReady)
  const laterError = new Error('private-teardown-error-canary')
  const evidence = createPreviewLifecycleEvidence({
    request: (_smoke, command) => {
      if (command === 'preview-window-toggle') {
        return new Promise((_resolve, reject) => {
          rejectRequest = reject
        })
      }
      throw laterError
    }
  })
  evidence.setContext({ cycle: 29, action: 'toggle-open' })
  const pending = evidence.request({}, 'preview-window-toggle')
  const caught = assert.rejects(pending, (error) => error === firstError)
  evidence.setContext({ cycle: null, action: 'final-close' })
  rejectRequest(firstError)
  await caught
  await assert.rejects(evidence.request({}, 'app-quit'), (error) => error === laterError)
  assert.deepEqual(evidence.snapshot().failedRequest, {
    cycle: 29,
    action: 'toggle-open',
    command: 'preview-window-toggle',
    errorKind: 'main-not-ready'
  })
})

test('uses finite fallbacks for unknown action, command and renderer reason', async () => {
  const failure = new Error('private-error-canary')
  const evidence = createPreviewLifecycleEvidence({
    request: async () => {
      throw failure
    }
  })
  evidence.setContext({ cycle: Number.MAX_SAFE_INTEGER + 1, action: 'private-action-canary' })
  await assert.rejects(
    evidence.request({}, 'private-command-canary', { token: 'private-token-canary' }),
    (error) => error === failure
  )
  evidence.observeLine(
    evidencePrefix +
      JSON.stringify({
        ...mainEvidence(),
        events: [{ ...mainEvidence().events[0], rendererGoneReason: 'private-reason-canary' }],
        failedCommand: {
          command: 'private-command-canary',
          disposition: 'absent',
          firstAtMs: 1,
          lastAtMs: 2,
          attempts: 1
        }
      })
  )
  assert.deepEqual(evidence.snapshot().failedRequest, {
    cycle: null,
    action: 'other-action',
    command: 'other-command',
    errorKind: 'request-failed'
  })
  assert.equal(evidence.snapshot().main.events[0].rendererGoneReason, 'unknown')
  assert.equal(evidence.snapshot().main.failedCommand.command, 'other-command')
  assert.doesNotMatch(JSON.stringify(evidence.snapshot()), /private-|token|params/)
})

test('ignores throwing diagnostic getters and preserves the original rejected object', async () => {
  const failure = {
    get message() {
      throw new Error('private-error-getter-canary')
    }
  }
  const evidence = createPreviewLifecycleEvidence({
    request: async () => {
      throw failure
    }
  })
  evidence.setContext({
    get action() {
      throw new Error('private-context-getter-canary')
    }
  })
  await assert.rejects(evidence.request({}, 'app-quit'), (error) => error === failure)
  assert.deepEqual(evidence.snapshot(), {
    failedRequest: {
      cycle: null,
      action: 'other-action',
      command: 'app-quit',
      errorKind: 'request-failed'
    },
    main: null
  })
})

test('preserves the maintained main-readiness retry and eventual successful result', async () => {
  const evidence = createPreviewLifecycleEvidence()
  let requests = 0
  await ownedServer(
    (_request, response) => {
      requests += 1
      response.writeHead(requests === 1 ? 500 : 200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          requests === 1 ? { ok: false, error: notReady } : { ok: true, result: { open: true } }
        )
      )
    },
    async (smoke) => {
      evidence.setContext({ cycle: 1, action: 'toggle-open' })
      assert.deepEqual(
        await evidence.request(
          smoke,
          'preview-window-toggle',
          { expectedOpen: true },
          {
            timeoutMs: 1000,
            retryDelayMs: 1
          }
        ),
        { open: true }
      )
    }
  )
  assert.equal(requests, 2)
  assert.equal(evidence.snapshot().failedRequest, null)
})
