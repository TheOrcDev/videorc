import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'

import { isPathInsideAnyRoot } from './managed-asset-paths'

const MAX_PARAM_DEPTH = 8
const MAX_PARAM_KEYS = 2_000
const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const MAX_SMOKE_RESOURCE_PATH_LENGTH = 4_096
const SMOKE_PREVIEW_FRAME_ORIGIN = 'videorc-asset://smoke-preview/frame.svg'

export const SMOKE_COMMAND_NAMES = new Set([
  'app-quit',
  'apply-native-preview-host-commands',
  'authorize-smoke-resource',
  'backend-debug-rpc',
  'blank-main-window',
  'capture-page',
  'capture-page-alpha',
  'comments-window-authority-probe',
  'comments-window-capture-page',
  'comments-window-click-message',
  'comments-window-close',
  'comments-window-command-trace',
  'comments-window-open',
  'comments-window-push-snapshot',
  'comments-window-reader-state',
  'comments-window-route-send-result',
  'comments-window-set-bounds',
  'comments-window-set-command-fixture',
  'comments-window-set-view-mode',
  'comments-window-state',
  'comments-window-submit-message',
  'comments-window-toggle',
  'captions-window-close',
  'captions-window-open',
  'captions-window-set-bounds',
  'captions-window-state',
  'destroy-native-preview-surface',
  'dispatch-preview-shortcut',
  'enable-synthetic-source',
  'eval-js',
  'exercise-main-present-pump-reconnect',
  'exercise-main-present-scene-mismatch',
  'exercise-native-preview-proof-fallback',
  'exercise-native-preview-scene',
  'exercise-native-preview-scene-after-surface-loss',
  'exercise-native-preview-scene-background',
  'exercise-preview-click-focus',
  'heal-main-window',
  'inspect-native-preview-bootstrap',
  'inspect-backend-state-isolation',
  'inspect-packaged-bundled-background',
  'inspect-native-preview-runtime',
  'inspect-preview-stage-badges',
  'import-smoke-background',
  'ipc-send-counts',
  'main-present-pump-diagnostics',
  'main-window-focus',
  'main-window-id',
  'main-window-set-bounds',
  'main-window-state',
  'measure-native-preview-surface',
  'measure-preview-motion',
  'memory-infra-dump',
  'minimize-window',
  'move-window',
  'native-preview-surface-status',
  'notes-window-close',
  'notes-window-open',
  'notes-window-save-document',
  'notes-window-set-bounds',
  'notes-window-state',
  'open-backdrop-window',
  'open-layout-tab',
  'open-tab',
  'preview-lifecycle-allow-app-quit',
  'preview-lifecycle-attempt-app-quit',
  'preview-surface-scene-state',
  'preview-window-close',
  'preview-window-open',
  'preview-window-os-close',
  'preview-window-report-dock-slot',
  'preview-window-report-permission-required',
  'preview-window-set-bounds',
  'preview-window-set-dock-overlay',
  'preview-window-set-mode',
  'preview-window-state',
  'preview-window-toggle',
  'proof-window-state',
  'resize-window',
  'restore-window',
  'resume-native-preview-surface',
  'scroll-studio',
  'select-camera-device',
  'select-camera-shape',
  'select-layout-preset',
  'select-screen-device',
  'set-vibrancy',
  'suspend-native-preview-surface',
  'window-bounds-storm',
  'windows-live-audio-harness'
])

/**
 * Debug RPCs that an authenticated dev smoke harness may ask Electron main to
 * dispatch with its private backend credential. Keeping this list separate
 * from the ordinary backend method surface prevents the smoke command server
 * from becoming a generic admin proxy.
 */
export const SMOKE_BACKEND_RPC_METHOD_NAMES = new Set([
  'audio.test.inject-pcm',
  'captions.test.inject-audio',
  'captions.test.snapshot',
  'compositor.scene.update',
  'encoder_bridge.synthetic_record',
  'recording.start_test'
])

export type ValidatedSmokeBackendRpcRequest = {
  method: string
  params: Record<string, unknown>
  timeoutMs: number
}

export type SmokeResourceAuthorization = {
  kind: 'input-file' | 'output-directory'
  path: string
}

function validSmokeResourcePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SMOKE_RESOURCE_PATH_LENGTH &&
    value.trim() === value &&
    !value.includes('\0') &&
    isAbsolute(value)
  )
}

/**
 * Grants smoke fixtures access only to objects rooted in the per-run smoke
 * state directory. The canonical path is returned so later filesystem use is
 * not redirected through a symlink that was accepted here.
 */
export function validateSmokeResourceAuthorization(
  params: Record<string, unknown>,
  stateDirectory: string | undefined
): SmokeResourceAuthorization {
  if (
    !validSmokeResourcePath(stateDirectory) ||
    Object.keys(params).length !== 2 ||
    !validSmokeResourcePath(params.path) ||
    (params.kind !== 'input-file' && params.kind !== 'output-directory')
  ) {
    throw new Error('Invalid smoke resource authorization request.')
  }

  let canonicalRoot: string
  let canonicalPath: string
  let rootStats: ReturnType<typeof statSync>
  let pathStats: ReturnType<typeof statSync>
  try {
    if (lstatSync(stateDirectory).isSymbolicLink()) {
      throw new Error('Smoke state directory cannot be a symbolic link.')
    }
    if (lstatSync(params.path).isSymbolicLink()) {
      throw new Error('Smoke resource cannot be a symbolic link.')
    }
    canonicalRoot = realpathSync(stateDirectory)
    canonicalPath = realpathSync(params.path)
    rootStats = statSync(canonicalRoot)
    pathStats = statSync(canonicalPath)
  } catch (error) {
    if (error instanceof Error && /symbolic link/.test(error.message)) {
      throw error
    }
    throw new Error('Smoke resource path does not exist or cannot be inspected.', {
      cause: error
    })
  }

  if (!rootStats.isDirectory()) {
    throw new Error('Smoke state path must be a directory.')
  }
  const insideStateDirectory =
    canonicalPath === canonicalRoot || isPathInsideAnyRoot(canonicalPath, [canonicalRoot])
  if (!insideStateDirectory) {
    throw new Error('Smoke resource must be inside the smoke state directory.')
  }
  if (params.kind === 'input-file' && !pathStats.isFile()) {
    throw new Error('Smoke input resource must be a regular file.')
  }
  if (params.kind === 'output-directory' && !pathStats.isDirectory()) {
    throw new Error('Smoke output resource must be a directory.')
  }

  return { kind: params.kind, path: canonicalPath }
}

export function validateSmokeBackendRpcRequest(
  value: Record<string, unknown>
): ValidatedSmokeBackendRpcRequest | null {
  if (
    typeof value.method !== 'string' ||
    !SMOKE_BACKEND_RPC_METHOD_NAMES.has(value.method) ||
    !value.params ||
    typeof value.params !== 'object' ||
    Array.isArray(value.params) ||
    Object.getPrototypeOf(value.params) !== Object.prototype
  ) {
    return null
  }
  const requestedTimeout = value.timeoutMs
  if (
    requestedTimeout !== undefined &&
    (typeof requestedTimeout !== 'number' ||
      !Number.isFinite(requestedTimeout) ||
      requestedTimeout < 1 ||
      requestedTimeout > 5 * 60_000)
  ) {
    return null
  }
  return {
    method: value.method,
    params: value.params as Record<string, unknown>,
    timeoutMs: requestedTimeout ?? 15_000
  }
}

/** Minimal command surface used by packaged preview/recording acceptance gates. */
export const PACKAGED_SMOKE_COMMAND_NAMES = new Set([
  'captions-window-open',
  'captions-window-set-bounds',
  'comments-window-open',
  'comments-window-set-bounds',
  'destroy-native-preview-surface',
  'exercise-main-present-pump-reconnect',
  'exercise-native-preview-scene',
  'exercise-native-preview-scene-after-surface-loss',
  'exercise-native-preview-scene-background',
  'inspect-native-preview-bootstrap',
  'inspect-native-preview-runtime',
  'inspect-preview-stage-badges',
  'inspect-packaged-bundled-background',
  'measure-native-preview-surface',
  'main-window-focus',
  'main-window-set-bounds',
  'minimize-window',
  'move-window',
  'native-preview-surface-status',
  'notes-window-open',
  'notes-window-set-bounds',
  'open-tab',
  'preview-window-state',
  'preview-window-open',
  'resize-window',
  'restore-window',
  'resume-native-preview-surface',
  'suspend-native-preview-surface',
  'windows-live-audio-harness'
])

export type ValidatedSmokeCommand = {
  command: string
  params: Record<string, unknown>
}

export type SmokeCommandRequestOptions = {
  capability: string
  allowedCommands?: ReadonlySet<string>
  runCommand: (command: string, params: Record<string, unknown>) => Promise<unknown>
}

export function smokeCommandServerAllowed(
  enabled: boolean,
  packaged: boolean,
  packagedHarnessCapability?: string
): boolean {
  return enabled && (!packaged || smokeCommandCapabilityValid(packagedHarnessCapability))
}

export function createSmokeCommandCapability(): string {
  return randomBytes(32).toString('base64url')
}

export function smokeCommandCapabilityValid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

export function smokePreviewFrameUrl(maxWidth?: number): string {
  const url = new URL(SMOKE_PREVIEW_FRAME_ORIGIN)
  if (typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0) {
    url.searchParams.set('maxWidth', String(Math.max(1, Math.round(maxWidth))))
  }
  return url.toString()
}

export function smokeRequestAuthorized(
  authorizationHeader: string | string[] | undefined,
  capability: string
): boolean {
  if (
    !capability ||
    typeof authorizationHeader !== 'string' ||
    !authorizationHeader.startsWith('Bearer ')
  ) {
    return false
  }
  const supplied = Buffer.from(authorizationHeader.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(capability, 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function validateJsonValue(
  value: unknown,
  depth: number,
  keyBudget: { remaining: number }
): boolean {
  if (depth > MAX_PARAM_DEPTH) {
    return false
  }
  if (value === null || ['string', 'boolean'].includes(typeof value)) {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    keyBudget.remaining -= value.length
    return (
      keyBudget.remaining >= 0 &&
      value.every((entry) => validateJsonValue(entry, depth + 1, keyBudget))
    )
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return false
  }
  const entries = Object.entries(value)
  keyBudget.remaining -= entries.length
  return (
    keyBudget.remaining >= 0 &&
    entries.every(
      ([key, entry]) =>
        key !== '__proto__' &&
        key !== 'constructor' &&
        key !== 'prototype' &&
        validateJsonValue(entry, depth + 1, keyBudget)
    )
  )
}

export function validateSmokeCommandPayload(value: unknown): ValidatedSmokeCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const body = value as Record<string, unknown>
  if (typeof body.command !== 'string' || !SMOKE_COMMAND_NAMES.has(body.command)) {
    return null
  }
  const params = body.params ?? {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return null
  }
  if (!validateJsonValue(params, 0, { remaining: MAX_PARAM_KEYS })) {
    return null
  }
  if (
    body.command === 'eval-js' &&
    (typeof (params as Record<string, unknown>).code !== 'string' ||
      ((params as Record<string, unknown>).code as string).length > 256 * 1024)
  ) {
    return null
  }
  return { command: body.command, params: params as Record<string, unknown> }
}

/**
 * The complete loopback command-server policy lives here so every endpoint is
 * authenticated before routing and the HTTP status contract can be exercised
 * without booting Electron.
 */
export async function handleSmokeCommandRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: SmokeCommandRequestOptions
): Promise<void> {
  if (!smokeRequestAuthorized(request.headers.authorization, options.capability)) {
    writeJson(response, 401, { ok: false, error: 'Invalid smoke command capability.' })
    return
  }

  if (request.method === 'GET' && request.url === '/health') {
    writeJson(response, 200, { ok: true })
    return
  }

  if (request.method !== 'POST' || request.url !== '/command') {
    writeJson(response, 404, { ok: false, error: 'Unknown smoke endpoint.' })
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(request)
  } catch (error) {
    const statusCode = error instanceof SmokeRequestBodyError ? error.statusCode : 400
    writeJson(response, statusCode, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }

  const validated = validateSmokeCommandPayload(body)
  if (!validated) {
    writeJson(response, 400, { ok: false, error: 'Invalid smoke command or parameters.' })
    return
  }
  if (options.allowedCommands && !options.allowedCommands.has(validated.command)) {
    writeJson(response, 403, { ok: false, error: 'Smoke command is unavailable in this mode.' })
    return
  }

  try {
    const result = await options.runCommand(validated.command, validated.params)
    writeJson(response, 200, { ok: true, result })
  } catch (error) {
    writeJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

class SmokeRequestBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message)
  }
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveRead, rejectRead) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    let settled = false

    request.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteLength += buffer.length
      if (byteLength > MAX_REQUEST_BODY_BYTES) {
        settled = true
        rejectRead(new SmokeRequestBodyError('Smoke request body is too large.', 413))
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      try {
        const body = Buffer.concat(chunks).toString('utf8')
        resolveRead(body ? JSON.parse(body) : {})
      } catch (error) {
        rejectRead(
          new SmokeRequestBodyError(
            error instanceof Error ? error.message : 'Invalid JSON request body.',
            400
          )
        )
      }
    })
    request.on('error', (error) => {
      if (settled) return
      settled = true
      rejectRead(error)
    })
  })
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  })
  response.end(JSON.stringify(payload))
}
