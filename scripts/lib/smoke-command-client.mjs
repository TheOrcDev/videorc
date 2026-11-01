import { request as httpRequest } from 'node:http'

const SMOKE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function assertSmokeCommandConnection(smoke) {
  if (!smoke || typeof smoke !== 'object') {
    throw new Error('Smoke command connection is missing.')
  }
  if (smoke.host !== '127.0.0.1') {
    throw new Error('Smoke command connection must use the IPv4 loopback host.')
  }
  if (!Number.isInteger(smoke.port) || smoke.port < 1 || smoke.port > 65_535) {
    throw new Error('Smoke command connection has an invalid port.')
  }
  if (typeof smoke.capability !== 'string' || !SMOKE_CAPABILITY_PATTERN.test(smoke.capability)) {
    throw new Error('Smoke command connection is missing its per-run capability.')
  }
  return smoke
}

/**
 * Send one smoke command over a dedicated HTTP connection.
 *
 * Mutation commands such as preview-window-toggle are not safe to replay after
 * an ambiguous transport failure. A one-shot socket avoids stale pooled
 * connections while preserving exactly-once request semantics at the client.
 */
export function requestSmokeCommand(smoke, command, params = {}, { timeoutMs = 5000 } = {}) {
  assertSmokeCommandConnection(smoke)
  const body = JSON.stringify({ command, params })

  return new Promise((resolveCommand, rejectCommand) => {
    const request = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${smoke.capability}`,
          connection: 'close'
        },
        timeout: timeoutMs
      },
      (response) => {
        let responseBody = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          responseBody += chunk
        })
        response.on('end', () => {
          let payload
          try {
            payload = responseBody ? JSON.parse(responseBody) : {}
          } catch (error) {
            rejectCommand(new Error(`${command} returned invalid JSON: ${error?.message ?? error}`))
            return
          }

          const statusCode = response.statusCode ?? 0
          if (statusCode < 200 || statusCode >= 300 || payload.ok === false || payload.error) {
            rejectCommand(
              new Error(payload.error ?? `${command} smoke command failed (${statusCode})`)
            )
            return
          }
          resolveCommand(payload.result ?? payload)
        })
      }
    )

    request.on('timeout', () => {
      request.destroy(new Error(`${command} smoke command timed out after ${timeoutMs}ms`))
    })
    request.on('error', rejectCommand)
    request.end(body)
  })
}

/**
 * Retry an idempotent or explicit-target smoke command across transient command
 * server disconnects. Callers must not pass an ordinary toggle/mutation whose
 * effect could be applied twice after a response-side reset.
 */
export async function requestSmokeCommandWithRetry(
  smoke,
  command,
  params = {},
  {
    timeoutMs = 5000,
    requestTimeoutMs = 2000,
    retryDelayMs = 150,
    isRetryable = isRetryableSmokeCommandError
  } = {}
) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  do {
    try {
      return await requestSmokeCommand(smoke, command, params, {
        timeoutMs: Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now()))
      })
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) {
        throw error
      }
      await sleep(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())))
    }
  } while (Date.now() < deadline)

  throw lastError ?? new Error(`${command} smoke command failed`)
}

/**
 * Wait until the main window's renderer exposes a DEV smoke hook
 * (`window.<hook>` is a function). The smoke command server answers as soon
 * as main is up; on a slow machine the renderer still has the React tree to
 * mount (retest 153: an empty page 10 s after `preview-motion-ready`), so a
 * one-shot `window.<hook>?.()` read `null` and the smoke failed with "the
 * renderer has no clip buffer smoke hook". Returns once the hook exists;
 * throws with the last answer at the deadline.
 */
export async function waitForRendererHook(
  smoke,
  hook,
  { timeoutMs = 60_000, pollMs = 250, requestTimeoutMs = 5000 } = {}
) {
  if (!/^__videorc[A-Za-z0-9]+$/.test(hook)) {
    throw new Error(`Not a renderer smoke hook name: ${hook}`)
  }
  const deadline = Date.now() + timeoutMs
  let last = null
  do {
    try {
      const response = await requestSmokeCommand(
        smoke,
        'eval-js',
        { hook, code: 'return typeof window[params.hook] === "function"' },
        { timeoutMs: Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now())) }
      )
      if (response?.result === true) return
      last = `window.${hook} is not defined yet`
    } catch (error) {
      // A read-only poll may also outlive a renderer busy loading its bundle
      // (eval-js waits for the page): that is the wait, not a failure.
      const timedOut = isSmokeCommandTimeout(error)
      if (!isRetryableSmokeCommandError(error) && !timedOut) throw error
      // The last poll before the deadline gets a clamped request timeout;
      // keep the renderer's own answer over that timeout.
      if (!timedOut || last === null) last = String(error?.message ?? error)
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)
  throw new Error(`Timed out after ${timeoutMs}ms waiting for window.${hook}: ${last}`)
}

function isSmokeCommandTimeout(error) {
  return errorMessages(error).some((message) => /smoke command timed out after \d+ms/.test(message))
}

export function isRetryableSmokeCommandError(error) {
  const messages = errorMessages(error)
  return messages.some(
    (message) =>
      message.includes('Main window is not ready') ||
      message.includes('Timed out waiting for active tab') ||
      message.includes('fetch failed') ||
      message.includes('ECONNRESET') ||
      message.includes('ECONNREFUSED') ||
      message.includes('socket hang up')
  )
}

function errorMessages(error) {
  const messages = []
  let current = error
  const seen = new Set()
  while (current && !seen.has(current)) {
    seen.add(current)
    messages.push(String(current?.message ?? current))
    if (typeof current?.code === 'string') {
      messages.push(current.code)
    }
    current = current?.cause
  }
  return messages
}

function sleep(delayMs) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs))
}
