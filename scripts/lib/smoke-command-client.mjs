import { request as httpRequest } from 'node:http'

/**
 * Send one smoke command over a dedicated HTTP connection.
 *
 * Mutation commands such as preview-window-toggle are not safe to replay after
 * an ambiguous transport failure. A one-shot socket avoids stale pooled
 * connections while preserving exactly-once request semantics at the client.
 */
export function requestSmokeCommand(smoke, command, params = {}, { timeoutMs = 5000 } = {}) {
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
