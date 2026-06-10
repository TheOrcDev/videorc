import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'

import type {
  NativePreviewHostCommand,
  PreviewSurfaceBacking,
  PreviewSurfaceSceneState,
  PreviewSurfaceSource,
  PreviewSurfaceStatus,
  PreviewTransport
} from '../shared/backend'
import type {
  NativePreviewRealSurfaceDriver,
  NativePreviewRealSurfacePresentRequest
} from '../shared/native-preview-host-driver'
import { normalizePreviewSurfaceBounds } from '../shared/native-preview-bounds'

type HelperChildProcess = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'kill' | 'on'> & {
  pid?: number
}
type HelperSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => HelperChildProcess

export interface NativePreviewHelperProcessDriverOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  iosurfaceImportRetryDelayMs?: number
  iosurfaceImportRetryAttempts?: number
  iosurfaceImportFailureWarnThreshold?: number
  spawnProcess?: HelperSpawn
  now?: () => string
  nowMs?: () => number
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  onProcessStarted?: (pid: number, label: string) => void
  onProcessExited?: (pid: number) => void
}

interface PendingRequest {
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
}

interface HelperResponse {
  id?: string
  ok: boolean
  payload?: unknown
  error?: string
}

interface HelperPresentPayload {
  hasOverlay: boolean
  presentFailureReason?: string | null
  activation?: HelperActivation | null
}

interface HelperActivation {
  transport: PreviewTransport
  backing: PreviewSurfaceBacking
  presentedFrameId: number
  framePollingSuppressed: boolean
  sourcePixelsPresent: boolean
  message?: string
}

interface NativePresentMetrics {
  presentFps?: number
  intervalP95Ms?: number
  intervalP99Ms?: number
  inputToPresentLatencyMs?: number
  inputToPresentLatencyP50Ms?: number
  inputToPresentLatencyP95Ms?: number
  inputToPresentLatencyP99Ms?: number
  nativePreviewHelperRoundTripP95Ms?: number
}

const NATIVE_PRESENT_SAMPLE_LIMIT = 900
// A wedged helper must never freeze the surface mutation queue: every placement AND
// hide for both surface windows serializes behind these requests.
const HELPER_REQUEST_TIMEOUT_MS = 4000

export function createNativePreviewHelperProcessDriver(
  options: NativePreviewHelperProcessDriverOptions
): NativePreviewRealSurfaceDriver {
  return new NativePreviewHelperProcessDriver(options)
}

class NativePreviewHelperProcessDriver implements NativePreviewRealSurfaceDriver {
  private child: HelperChildProcess | null = null
  private requestSerial = 0
  private stdoutBuffer = ''
  private readonly pending = new Map<string, PendingRequest>()
  private readonly spawnProcess: HelperSpawn
  private readonly now: () => string
  private readonly nowMs: () => number
  private readonly iosurfaceImportRetryDelayMs: number
  private readonly iosurfaceImportRetryAttempts: number
  private readonly iosurfaceImportFailureWarnThreshold: number
  private consecutiveIosurfaceImportFailures = 0
  private lastPresentFailureKey: string | null = null
  private suppressedPresentFailureCount = 0
  private presentTimestampsMs: number[] = []
  private presentIntervalsMs: number[] = []
  private inputToPresentLatenciesMs: number[] = []
  private helperRoundTripMs: number[] = []

  constructor(private readonly options: NativePreviewHelperProcessDriverOptions) {
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams)
    this.now = options.now ?? (() => new Date().toISOString())
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.iosurfaceImportRetryDelayMs = options.iosurfaceImportRetryDelayMs ?? 8
    this.iosurfaceImportRetryAttempts = Math.max(1, Math.floor(options.iosurfaceImportRetryAttempts ?? 3))
    this.iosurfaceImportFailureWarnThreshold = Math.max(
      1,
      Math.floor(options.iosurfaceImportFailureWarnThreshold ?? 3)
    )
  }

  async applyHostCommands(commands: NativePreviewHostCommand[]): Promise<PreviewSurfaceStatus | null> {
    if (commands.length === 0) {
      return null
    }
    const normalizedCommands = commands.map(normalizeHostCommand)
    this.options.onLog?.(
      'info',
      `Native preview host helper applying commands: ${normalizedCommands.map(formatHostCommand).join(', ')}.`
    )
    this.resetMetrics()
    await this.request('applyHostCommands', { commands: normalizedCommands })
    return null
  }

  resetMetrics(): void {
    this.presentTimestampsMs = []
    this.presentIntervalsMs = []
    this.inputToPresentLatenciesMs = []
    this.helperRoundTripMs = []
  }

  async presentCompositorHandoff(
    request: NativePreviewRealSurfacePresentRequest
  ): Promise<PreviewSurfaceStatus | null> {
    let payload = await this.requestPresentCompositorHandoff(request)
    for (let attempt = 1; attempt < this.iosurfaceImportRetryAttempts && !payload.activation && payload.presentFailureReason === 'iosurface-import-failed'; attempt += 1) {
      await delay(this.iosurfaceImportRetryDelayMs * attempt)
      payload = await this.requestPresentCompositorHandoff(request)
    }
    if (!payload.activation) {
      this.logPresentFailure(payload, request)
      return null
    }
    this.consecutiveIosurfaceImportFailures = 0
    this.lastPresentFailureKey = null
    this.suppressedPresentFailureCount = 0
    return helperActivationToPreviewSurfaceStatus(
      payload.activation,
      request,
      this.now(),
      this.recordPresentMetrics(request)
    )
  }

  private async requestPresentCompositorHandoff(
    request: NativePreviewRealSurfacePresentRequest
  ): Promise<HelperPresentPayload> {
    const startedAtMs = this.nowMs()
    try {
      return await this.request<HelperPresentPayload>('presentCompositorHandoff', {
        handoff: {
          iosurfaceId: request.handoff.iosurfaceId,
          width: request.handoff.width,
          height: request.handoff.height,
          frameId: request.handoff.frameId
        }
      })
    } finally {
      recordLimitedSample(this.helperRoundTripMs, Math.max(0, this.nowMs() - startedAtMs))
    }
  }

  private logPresentFailure(
    payload: HelperPresentPayload,
    request: NativePreviewRealSurfacePresentRequest
  ): void {
    const reason = payload.presentFailureReason ?? 'unknown'
    if (reason === 'iosurface-import-failed') {
      this.consecutiveIosurfaceImportFailures += 1
      if (this.consecutiveIosurfaceImportFailures < this.iosurfaceImportFailureWarnThreshold) {
        return
      }
    } else {
      this.consecutiveIosurfaceImportFailures = 0
    }
    const failureKey = [
      payload.hasOverlay,
      request.handoff.iosurfaceId,
      request.handoff.width,
      request.handoff.height,
      reason
    ].join(':')
    if (failureKey === this.lastPresentFailureKey) {
      this.suppressedPresentFailureCount += 1
      return
    }
    const suppressedMessage =
      this.suppressedPresentFailureCount > 0
        ? ` Suppressed ${this.suppressedPresentFailureCount} repeated present failures.`
        : ''
    this.options.onLog?.(
      'warn',
      `Native preview host helper did not activate compositor frame ${request.handoff.frameId} ` +
        `(hasOverlay=${payload.hasOverlay}, iosurface=${request.handoff.iosurfaceId}, ` +
        `size=${request.handoff.width}x${request.handoff.height}, reason=${reason}).` +
        suppressedMessage
    )
    this.lastPresentFailureKey = failureKey
    this.suppressedPresentFailureCount = 0
  }

  private recordPresentMetrics(request: NativePreviewRealSurfacePresentRequest): NativePresentMetrics {
    const nowMs = this.nowMs()
    const previousPresentMs = this.presentTimestampsMs.at(-1)
    this.presentTimestampsMs.push(nowMs)
    if (typeof previousPresentMs === 'number' && nowMs >= previousPresentMs) {
      this.presentIntervalsMs.push(nowMs - previousPresentMs)
    }
    while (this.presentTimestampsMs.length > NATIVE_PRESENT_SAMPLE_LIMIT) {
      this.presentTimestampsMs.shift()
    }
    while (this.presentIntervalsMs.length > NATIVE_PRESENT_SAMPLE_LIMIT - 1) {
      this.presentIntervalsMs.shift()
    }
    const inputToPresentLatencyMs = nativeInputToPresentLatencyMs(request, nowMs)
    if (inputToPresentLatencyMs !== undefined) {
      this.inputToPresentLatenciesMs.push(inputToPresentLatencyMs)
      if (this.inputToPresentLatenciesMs.length > NATIVE_PRESENT_SAMPLE_LIMIT) {
        this.inputToPresentLatenciesMs.shift()
      }
    }
    const latencyMetrics =
      inputToPresentLatencyMs === undefined
        ? {}
        : {
            inputToPresentLatencyMs,
            inputToPresentLatencyP50Ms: percentile(this.inputToPresentLatenciesMs, 0.5),
            inputToPresentLatencyP95Ms: percentile(this.inputToPresentLatenciesMs, 0.95),
            inputToPresentLatencyP99Ms: percentile(this.inputToPresentLatenciesMs, 0.99)
          }
    const helperMetrics = {
      nativePreviewHelperRoundTripP95Ms: percentile(this.helperRoundTripMs, 0.95)
    }
    if (this.presentTimestampsMs.length < 2) {
      return {
        ...helperMetrics,
        ...latencyMetrics
      }
    }
    const elapsedMs = this.presentTimestampsMs.at(-1)! - this.presentTimestampsMs[0]
    return {
      presentFps: elapsedMs > 0 ? ((this.presentTimestampsMs.length - 1) * 1000) / elapsedMs : undefined,
      intervalP95Ms: percentile(this.presentIntervalsMs, 0.95),
      intervalP99Ms: percentile(this.presentIntervalsMs, 0.99),
      ...helperMetrics,
      ...latencyMetrics
    }
  }

  private request<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const child = this.ensureChild()
    const id = `native-preview-helper:${++this.requestSerial}`
    const message = `${JSON.stringify({ id, method, ...body })}\n`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(`Native preview host helper request ${method} timed out after ${HELPER_REQUEST_TIMEOUT_MS}ms`)
          )
        }
      }, HELPER_REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (payload) => {
          clearTimeout(timer)
          resolve(payload as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      try {
        child.stdin.write(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`Native preview host helper write failed: ${errorMessage(error)}`))
      }
    })
  }

  /** Kill the helper child so its NSWindow cannot outlive a disabled driver. */
  stop(): void {
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    this.rejectAll('Native preview host helper was stopped.')
  }

  private ensureChild(): HelperChildProcess {
    if (this.child) {
      return this.child
    }

    const child = this.spawnProcess(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: 'pipe'
    })
    const pid = child.pid
    this.child = child
    if (typeof pid === 'number') {
      this.options.onProcessStarted?.(pid, 'native-preview-helper')
    }
    child.stdout.on('data', (chunk: Buffer | string) => this.handleStdout(String(chunk)))
    child.stderr.on('data', (chunk: Buffer | string) => this.handleStderr(String(chunk)))
    child.on('error', (error: Error) => this.rejectAll(`Native preview host helper error: ${error.message}`))
    child.on('close', (code: number | null, signal: string | null) => {
      if (typeof pid === 'number') {
        this.options.onProcessExited?.(pid)
      }
      this.child = null
      this.rejectAll(`Native preview host helper exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`)
    })
    this.options.onLog?.('info', `Started native preview host helper: ${this.options.command}`)
    return child
  }

  private handleStdout(text: string): void {
    this.stdoutBuffer += text
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      let response: HelperResponse
      try {
        response = JSON.parse(trimmed) as HelperResponse
      } catch (error) {
        this.options.onLog?.('warn', `Ignoring invalid native preview helper response: ${errorMessage(error)}`)
        continue
      }
      this.handleResponse(response)
    }
  }

  private handleResponse(response: HelperResponse): void {
    if (!response.id) {
      this.options.onLog?.('warn', 'Ignoring native preview helper response without request id.')
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending) {
      this.options.onLog?.('warn', `Ignoring unknown native preview helper response id ${response.id}.`)
      return
    }
    this.pending.delete(response.id)
    if (!response.ok) {
      pending.reject(new Error(response.error ?? 'Native preview host helper request failed.'))
      return
    }
    pending.resolve(response.payload)
  }

  private handleStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed) {
        this.options.onLog?.('warn', `native preview host helper: ${trimmed}`)
      }
    }
  }

  private rejectAll(message: string): void {
    if (this.pending.size === 0) {
      return
    }
    const error = new Error(message)
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function helperActivationToPreviewSurfaceStatus(
  activation: HelperActivation,
  request: NativePreviewRealSurfacePresentRequest,
  updatedAt: string,
  metrics: NativePresentMetrics = {}
): PreviewSurfaceStatus {
  const bounds = request.bounds ? normalizePreviewSurfaceBounds(request.bounds) : undefined
  const width = Math.max(1, Math.round(bounds?.width ?? request.handoff.width))
  const height = Math.max(1, Math.round(bounds?.height ?? request.handoff.height))
  return {
    state: 'live',
    source: previewSurfaceSourceFromScene(request.scene),
    transport: activation.transport,
    backing: activation.backing,
    targetFps: 60,
    width,
    height,
    framesRendered: request.handoff.frameId,
    presentedFrameId: activation.presentedFrameId,
    compositorFrameLag: 0,
    droppedFrames: 0,
    presentFps: metrics.presentFps,
    intervalP95Ms: metrics.intervalP95Ms,
    intervalP99Ms: metrics.intervalP99Ms,
    nativePreviewHelperRoundTripP95Ms: metrics.nativePreviewHelperRoundTripP95Ms,
    inputToPresentLatencyMs: metrics.inputToPresentLatencyMs,
    inputToPresentLatencyP50Ms: metrics.inputToPresentLatencyP50Ms,
    inputToPresentLatencyP95Ms: metrics.inputToPresentLatencyP95Ms,
    inputToPresentLatencyP99Ms: metrics.inputToPresentLatencyP99Ms,
    framePollingSuppressed: request.suppressFramePolling || activation.framePollingSuppressed,
    sourcePixelsPresent: activation.sourcePixelsPresent,
    pendingHostCommandCount: 0,
    bounds,
    updatedAt,
    message: activation.message
  }
}

function normalizeHostCommand(command: NativePreviewHostCommand): NativePreviewHostCommand {
  return command.bounds
    ? {
        ...command,
        bounds: normalizePreviewSurfaceBounds(command.bounds)
      }
    : command
}

function nativeInputToPresentLatencyMs(
  request: NativePreviewRealSurfacePresentRequest,
  nowMs: number
): number | undefined {
  if (typeof request.frameAgeMs !== 'number' || !Number.isFinite(request.frameAgeMs)) {
    return undefined
  }
  const compositorUpdatedAtMs =
    typeof request.compositorUpdatedAt === 'string' ? Date.parse(request.compositorUpdatedAt) : NaN
  const handoffAgeMs =
    Number.isFinite(compositorUpdatedAtMs) && Number.isFinite(nowMs)
      ? Math.max(0, nowMs - compositorUpdatedAtMs)
      : 0
  return Math.max(0, Math.round(request.frameAgeMs + handoffAgeMs))
}

function percentile(values: number[], percentileRank: number): number | undefined {
  if (values.length === 0) {
    return undefined
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileRank) - 1))
  return sorted[index]
}

function recordLimitedSample(samples: number[], value: number): void {
  if (!Number.isFinite(value)) {
    return
  }
  samples.push(value)
  while (samples.length > NATIVE_PRESENT_SAMPLE_LIMIT) {
    samples.shift()
  }
}

function previewSurfaceSourceFromScene(scene?: PreviewSurfaceSceneState | null): PreviewSurfaceSource {
  if (scene?.sources.some((source) => source.visible && (source.kind === 'screen' || source.kind === 'window'))) {
    return 'screen'
  }
  if (scene?.sources.some((source) => source.visible && source.kind === 'camera')) {
    return 'camera'
  }
  return 'synthetic'
}

function formatHostCommand(command: NativePreviewHostCommand): string {
  if (!command.bounds) {
    return command.kind
  }
  const { screenX, screenY, width, height, scaleFactor, screenHeight } = command.bounds
  const screenHeightLabel = typeof screenHeight === 'number' ? ` screenH=${Math.round(screenHeight)}` : ''
  return (
    `${command.kind}@(${Math.round(screenX)},${Math.round(screenY)}) ` +
    `${Math.round(width)}x${Math.round(height)} scale=${Number(scaleFactor.toFixed(2))}${screenHeightLabel}`
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
