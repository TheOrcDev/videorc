// A hand-rolled MCP client for smokes (plan 209 S9): it drives the REAL
// `videorc-mcp` bridge binary over stdio, exactly as Claude Desktop, Cursor
// or Codex do (newline-delimited JSON-RPC on stdin/stdout), and talks raw
// HTTP to the Agents listener for the guard checks the bridge would never
// make (an Origin header, a foreign Host). Every helper is bounded by the
// caller's timeout, and every line the bridge prints is kept for the leak
// scan.

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { delimiter, join } from 'node:path'

/** The bridge `cargo build -p videorc-backend` produced, or an explicit one. */
export function agentBridgeBinary({
  repoRoot,
  env = process.env,
  platform = process.platform
} = {}) {
  if (env.VIDEORC_SMOKE_AGENT_BRIDGE) return env.VIDEORC_SMOKE_AGENT_BRIDGE
  const profile = env.VIDEORC_DEV_BACKEND_PROFILE === 'release' ? 'release' : 'debug'
  return join(repoRoot, 'target', profile, platform === 'win32' ? 'videorc-mcp.exe' : 'videorc-mcp')
}

/**
 * Stand-ins for the launchers the bridge uses to open Videorc (D7): macOS
 * `open -g -b <bundle id>` and Linux's `videorc`. Put first on the bridge's
 * PATH, they record the attempt and fail, so a smoke can never open the
 * streamer's installed app, and can prove the bridge never tried.
 */
export function createLauncherStandIns(directory) {
  mkdirSync(directory, { recursive: true })
  const markerPath = join(directory, 'open-attempts.log')
  const script = `#!/bin/sh\necho "$0 $*" >> "${markerPath}"\nexit 1\n`
  for (const name of ['open', 'videorc']) {
    const path = join(directory, name)
    writeFileSync(path, script)
    chmodSync(path, 0o755)
  }
  return {
    binDir: directory,
    markerPath,
    attempts: () => (existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : '')
  }
}

export class AgentBridge {
  /**
   * Start `videorc-mcp` with a clean environment: only PATH (stand-ins first),
   * HOME, the discovery file and, when given, the agent token. Nothing about
   * the streamer's real profile reaches it.
   */
  static start({ binary, discoveryPath, token, pathPrefix, timeoutMs = 90000, debug = false }) {
    if (!existsSync(binary)) {
      throw new Error(
        `videorc-mcp is missing at ${binary}; run cargo build -p videorc-backend first.`
      )
    }
    const env = {
      PATH: [pathPrefix, process.env.PATH].filter(Boolean).join(delimiter),
      HOME: process.env.HOME ?? '',
      VIDEORC_AGENTS_DISCOVERY: discoveryPath,
      ...(process.platform === 'win32' && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
      ...(token ? { VIDEORC_AGENT_TOKEN: token } : {}),
      ...(debug ? { VIDEORC_MCP_DEBUG: '1' } : {})
    }
    const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    return new AgentBridge(child, { timeoutMs, debug })
  }

  constructor(child, { timeoutMs, debug }) {
    this.child = child
    this.timeoutMs = timeoutMs
    this.debug = debug
    this.nextId = 1
    this.pending = new Map()
    /** Every stdout line, for the leak scan. */
    this.transcript = []
    this.stderr = []
    this.exited = null
    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      buffered += text
      let newline
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        if (line) this.onLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => {
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        this.stderr.push(line)
        if (this.debug) console.log(`[videorc-mcp] ${line}`)
      }
    })
    child.on('exit', (code, signal) => {
      this.exited = { code, signal }
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error(`videorc-mcp exited (${code ?? signal}) before answering`))
      }
      this.pending.clear()
    })
  }

  onLine(line) {
    this.transcript.push(line)
    let message
    try {
      message = JSON.parse(line)
    } catch {
      throw new Error(`videorc-mcp printed a line that is not JSON on stdout: ${line}`)
    }
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    clearTimeout(waiter.timer)
    waiter.resolve(message)
  }

  /** One JSON-RPC request; resolves to the whole response message. */
  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    const id = this.nextId++
    return new Promise((resolveRequest, rejectRequest) => {
      if (this.exited) {
        rejectRequest(new Error('videorc-mcp is not running'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(`videorc-mcp did not answer ${method} in ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`
      )
    })
  }

  notify(method, params) {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`
    )
  }

  /** `initialize` then `notifications/initialized`, like a client app. */
  async initialize() {
    const answer = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'videorc-agent-smoke', version: '1' }
    })
    this.notify('notifications/initialized')
    return answer
  }

  /** `tools/call`; resolves to the CallToolResult (`content`, `isError`, ...). */
  async callTool(name, args = {}, options) {
    const answer = await this.request('tools/call', { name, arguments: args }, options)
    if (answer.error) {
      throw new Error(
        `tools/call ${name} answered a protocol error: ${JSON.stringify(answer.error)}`
      )
    }
    return answer.result
  }

  async close() {
    if (this.exited) return
    const exited = new Promise((resolveExit) => this.child.once('exit', resolveExit))
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000)
    this.child.kill('SIGTERM')
    await exited
    clearTimeout(timer)
  }
}

/** The first text content of a tool result. */
export function resultText(result) {
  return result?.content?.find((block) => block.type === 'text')?.text ?? ''
}

/** The first image content of a tool result, decoded. */
export function resultImage(result) {
  const block = result?.content?.find((entry) => entry.type === 'image')
  return block ? { mimeType: block.mimeType, bytes: Buffer.from(block.data, 'base64') } : null
}

/**
 * One raw POST to the Agents listener, with any headers: the guard checks.
 * `host` overrides the Host header (node:http allows it; fetch does not).
 */
export function postMcp({ port, token, body, headers = {}, host, timeoutMs = 15000 }) {
  const payload = JSON.stringify(body ?? { jsonrpc: '2.0', id: 1, method: 'ping' })
  return new Promise((resolvePost, rejectPost) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        // A fresh connection per check: a kept-alive socket would reach a
        // draining listener after Stop instead of a closed port.
        agent: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          'content-length': Buffer.byteLength(payload),
          ...(host ? { host } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers
        },
        timeout: timeoutMs
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () =>
          resolvePost({ status: response.statusCode, headers: response.headers, body: text })
        )
      }
    )
    request.on('timeout', () => request.destroy(new Error('Agents listener timed out')))
    request.on('error', rejectPost)
    request.end(payload)
  })
}
