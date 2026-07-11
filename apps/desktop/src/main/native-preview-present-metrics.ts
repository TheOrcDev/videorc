export interface NativePreviewPresentMetricInput {
  frameAgeMs?: number
  compositorUpdatedAt?: string
}

export interface NativePreviewPresentMetricSnapshot {
  presentFps?: number
  intervalP95Ms?: number
  intervalP99Ms?: number
  inputToPresentLatencyMs?: number
  inputToPresentLatencyP50Ms?: number
  inputToPresentLatencyP95Ms?: number
  inputToPresentLatencyP99Ms?: number
}

const SAMPLE_LIMIT = 900

export class NativePreviewPresentMetrics {
  private presentTimestampsMs: number[] = []
  private presentIntervalsMs: number[] = []
  private inputLatenciesMs: number[] = []
  private cachedPercentiles:
    | { computedAtMs: number; fields: NativePreviewPresentMetricSnapshot }
    | undefined
  private refreshCount = 0

  constructor(
    private readonly nowMs: () => number = () => Date.now(),
    private readonly percentileCacheTtlMs = 250
  ) {}

  record(input: NativePreviewPresentMetricInput): NativePreviewPresentMetricSnapshot {
    const nowMs = this.nowMs()
    const previousPresentMs = this.presentTimestampsMs.at(-1)
    recordLimited(this.presentTimestampsMs, nowMs)
    if (typeof previousPresentMs === 'number' && nowMs >= previousPresentMs) {
      recordLimited(this.presentIntervalsMs, nowMs - previousPresentMs)
    }

    const inputToPresentLatencyMs = inputLatencyMs(input, nowMs)
    if (inputToPresentLatencyMs !== undefined) {
      recordLimited(this.inputLatenciesMs, inputToPresentLatencyMs)
    }

    const telemetryFields = this.telemetryFields(nowMs)
    return {
      ...telemetryFields,
      inputToPresentLatencyMs
    }
  }

  get telemetryRefreshCount(): number {
    return this.refreshCount
  }

  reset(): void {
    this.presentTimestampsMs = []
    this.presentIntervalsMs = []
    this.inputLatenciesMs = []
    this.cachedPercentiles = undefined
    this.refreshCount = 0
  }

  private telemetryFields(nowMs: number): NativePreviewPresentMetricSnapshot {
    const cached = this.cachedPercentiles
    if (
      cached &&
      nowMs >= cached.computedAtMs &&
      nowMs - cached.computedAtMs < this.percentileCacheTtlMs
    ) {
      return cached.fields
    }
    const firstPresentMs = this.presentTimestampsMs[0]
    const elapsedMs = nowMs - firstPresentMs
    const fields = {
      presentFps:
        this.presentTimestampsMs.length > 1 && elapsedMs > 0
          ? ((this.presentTimestampsMs.length - 1) * 1000) / elapsedMs
          : undefined,
      intervalP95Ms: percentile(this.presentIntervalsMs, 0.95),
      intervalP99Ms: percentile(this.presentIntervalsMs, 0.99),
      inputToPresentLatencyP50Ms: percentile(this.inputLatenciesMs, 0.5),
      inputToPresentLatencyP95Ms: percentile(this.inputLatenciesMs, 0.95),
      inputToPresentLatencyP99Ms: percentile(this.inputLatenciesMs, 0.99)
    }
    this.cachedPercentiles = { computedAtMs: nowMs, fields }
    this.refreshCount += 1
    return fields
  }
}

function inputLatencyMs(input: NativePreviewPresentMetricInput, nowMs: number): number | undefined {
  if (typeof input.frameAgeMs !== 'number' || !Number.isFinite(input.frameAgeMs)) {
    return undefined
  }
  const updatedAtMs =
    typeof input.compositorUpdatedAt === 'string' ? Date.parse(input.compositorUpdatedAt) : NaN
  const handoffAgeMs = Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : 0
  return Math.max(0, Math.round(input.frameAgeMs + handoffAgeMs))
}

function recordLimited(samples: number[], value: number): void {
  if (!Number.isFinite(value)) {
    return
  }
  samples.push(value)
  if (samples.length > SAMPLE_LIMIT) {
    samples.splice(0, samples.length - SAMPLE_LIMIT)
  }
}

function percentile(samples: number[], rank: number): number | undefined {
  if (samples.length === 0) {
    return undefined
  }
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * rank) - 1))]
}
