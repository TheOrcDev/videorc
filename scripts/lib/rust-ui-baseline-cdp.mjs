/**
 * A small CDP client for the baseline shooter: find a window of the dev app by
 * its page, evaluate in it, shoot it, and emulate Increase Contrast. Every shot
 * is `Page.captureScreenshot`, which reads the page's own surface, so it is
 * immune to other windows covering the app (plan 220 S0.1a: the shared Mac's
 * window server throttles occluded windows, and this does not depend on it).
 */
import { get } from 'node:http'

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.setTimeout(5000, () => request.destroy(new Error('CDP target list timed out')))
    request.on('error', reject)
  })
}

export async function listTargets(host) {
  return (await getJson(`http://${host}/json/list`)).filter((target) => target.type === 'page')
}

/** Which window of the app a page URL is. */
export function windowRoleOfUrl(url = '') {
  if (/comments\.html/.test(url)) return 'stream-manager'
  if (/captions\.html/.test(url)) return 'captions'
  if (/notes\.html/.test(url)) return 'notes'
  if (/^https?:\/\/localhost/.test(url) || /index\.html/.test(url)) return 'main'
  return 'other'
}

export class CdpPage {
  #ws
  #next = 0
  #pending = new Map()

  constructor(ws, target) {
    this.#ws = ws
    this.target = target
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiting = message.id ? this.#pending.get(message.id) : null
      if (!waiting) return
      this.#pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`))
      else waiting.resolve(message.result)
    })
    ws.addEventListener('close', () => {
      for (const waiting of this.#pending.values()) {
        clearTimeout(waiting.timer)
        waiting.reject(new Error(`CDP closed during ${waiting.method}`))
      }
      this.#pending.clear()
    })
  }

  static async connect(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timed out')), 8000)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('CDP connect failed'))
        },
        { once: true }
      )
    })
    return new CdpPage(ws, target)
  }

  call(method, params = {}, { timeoutMs = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.#next
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, method })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, { timeoutMs = 20_000 } = {}) {
    const result = await this.call(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      { timeoutMs }
    )
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      )
    }
    return result.result?.value
  }

  /**
   * The page's media: Increase Contrast (`prefers-contrast: more`), and for a
   * window that follows the system scheme, the scheme too. Replaces every
   * feature a previous call set.
   */
  async emulate({ contrast, colorScheme, reducedMotion = false }) {
    const features = [
      { name: 'prefers-contrast', value: contrast === 'more' ? 'more' : 'no-preference' }
    ]
    if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme })
    if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' })
    await this.call('Emulation.setEmulatedMedia', { features })
  }

  /** Two painted frames, so a style change has reached the surface. */
  async settled(extraMs = 350) {
    await this.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await new Promise((resolve) => setTimeout(resolve, extraMs))
  }

  async screenshot() {
    const { data } = await this.call('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(data, 'base64')
  }

  close() {
    this.#ws.close()
  }
}

/** Waits for a window of `role` to have a page, then connects to it. */
export async function connectWindow(host, role, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const target = (await listTargets(host)).find(
      (candidate) => windowRoleOfUrl(candidate.url) === role
    )
    if (target) return CdpPage.connect(target)
    if (Date.now() > deadline) throw new Error(`No ${role} window page appeared.`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
