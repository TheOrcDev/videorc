import type {
  RecordingState,
  SessionSourceKind,
  SessionSources,
  SourceSwitchParams
} from '@/lib/backend'

export interface LiveSourceSelectionState {
  snapshot: SessionSources | null
  pending: SessionSourceKind | null
  checking: boolean
  error: string | null
  errorKind?: SessionSourceKind
  targetName?: string
  outputPending?: boolean
}

/** One synchronous admission fence shared by every source picker. */
export class LiveSourceSelectionController {
  private proofTimer: ReturnType<typeof setTimeout> | null = null
  private proofRequest: string | null = null
  private proofReads = 0
  private epoch = 0
  private sessionId: string | null = null
  private sessionState: RecordingState = 'idle'
  private requestId: string | null = null
  private read: Promise<void> | null = null
  private readGeneration = 0
  private readDirty = false
  private request: SourceSwitchParams | null = null
  private attempts = 0
  private sending = false
  private sendGeneration = 0
  private lastFailureRequest: string | null = null
  private state: LiveSourceSelectionState = {
    snapshot: null,
    pending: null,
    checking: false,
    error: null
  }

  constructor(
    private readonly options: {
      get: (sessionId: string) => Promise<SessionSources>
      switch: (request: SourceSwitchParams) => Promise<SessionSources>
      changed: (state: LiveSourceSelectionState) => void
      confirmed: (snapshot: SessionSources) => void
      requestId: () => string
      failed?: (requestId: string, message: string) => void
    }
  ) {}

  private reportFailure(requestId: string, message: string): void {
    if (this.lastFailureRequest === requestId) return
    this.lastFailureRequest = requestId
    this.options.failed?.(requestId, message)
  }

  dispose(): void {
    this.clearProofTimer()
    this.epoch += 1
    this.readGeneration += 1
    this.read = null
    this.readDirty = false
    this.request = null
    this.requestId = null
    this.sessionId = null
    this.sessionState = 'idle'
    this.state = { snapshot: null, pending: null, checking: false, error: null }
  }

  setSession(sessionId: string | null | undefined, state: RecordingState): void {
    const identity = ['recording', 'streaming', 'starting'].includes(state)
      ? (sessionId ?? null)
      : null
    if (identity === this.sessionId && state === this.sessionState) return
    if (identity !== this.sessionId || !['recording', 'streaming', 'starting'].includes(state)) {
      this.clearProofTimer()
      this.proofRequest = null
      this.proofReads = 0
      this.epoch += 1
      this.sessionId = identity
      this.requestId = null
      this.request = null
      this.read = null
      this.readGeneration += 1
      this.sending = false
      this.attempts = 0
      this.publish({ snapshot: null, pending: null, checking: false, error: null })
    }
    this.sessionState = state
  }

  reason(kind: SessionSourceKind): string | null {
    if (this.sessionState === 'idle' || this.sessionState === 'failed') return null
    if (this.sessionState === 'starting') return 'Sources are available after the session starts.'
    if (this.sessionState === 'stopping') return 'The session is stopping.'
    if (this.state.pending || this.state.checking)
      return this.state.checking ? (this.state.error ?? 'Checking source…') : 'Changing source…'
    const capability = this.state.snapshot?.capabilities.find((item) => item.kind === kind)
    return capability?.supported
      ? null
      : (capability?.reason ?? 'Checking available source controls…')
  }

  private publish(state: LiveSourceSelectionState): void {
    this.state = state
    this.options.changed(state)
  }

  private accept(snapshot: SessionSources, epoch: number): boolean {
    if (epoch !== this.epoch || snapshot.sessionId !== this.sessionId) return false
    if (snapshot.sourceRevision < (this.state.snapshot?.sourceRevision ?? -1)) return false
    const operation = snapshot.lastOperation
    const completed =
      this.requestId !== null &&
      operation?.requestId === this.requestId &&
      ['applied', 'failed', 'cancelled'].includes(operation.stage)
    const pending =
      snapshot.pending?.kind ?? (completed || !this.requestId ? null : this.state.pending)
    const error = completed
      ? operation.stage !== 'applied'
        ? (operation.reason ?? 'The source could not be changed.')
        : null
      : this.state.checking && !this.requestId
        ? null
        : this.state.error
    if (completed && operation.stage === 'failed') {
      this.reportFailure(
        operation.requestId,
        operation.reason ?? 'The source could not be changed.'
      )
    }
    if (completed) {
      this.requestId = null
      this.request = null
    }
    const outputPending =
      operation?.stage === 'applied' && !operation.outputObserved && !operation.outputSuperseded
    if (this.proofRequest !== operation?.requestId) {
      this.proofRequest = operation?.requestId ?? null
      this.proofReads = 0
    }
    this.clearProofTimer()
    this.publish({
      snapshot,
      pending,
      targetName:
        pending && (!snapshot.pending || snapshot.pending.requestId === this.requestId)
          ? this.state.targetName
          : undefined,
      checking: this.requestId !== null && pending !== null && this.state.checking,
      outputPending,
      errorKind:
        completed && operation.stage !== 'applied'
          ? operation.kind
          : error
            ? this.state.errorKind
            : undefined,
      error:
        outputPending && this.proofReads >= 20
          ? 'The source changed, but output could not be confirmed. Retry status.'
          : !outputPending && this.state.outputPending
            ? null
            : error
    })
    if ((outputPending && this.proofReads < 20) || pending !== null) {
      this.proofTimer = setTimeout(() => {
        this.proofTimer = null
        if (epoch !== this.epoch) return
        if (outputPending) this.proofReads += 1
        void this.refresh()
      }, 250)
    }
    this.options.confirmed(snapshot)
    return true
  }

  private clearProofTimer(): void {
    if (this.proofTimer !== null) clearTimeout(this.proofTimer)
    this.proofTimer = null
  }

  refresh(): Promise<void> {
    if (this.read) {
      this.readDirty = true
      return this.read
    }
    const sessionId = this.sessionId
    if (!sessionId || !['recording', 'streaming'].includes(this.sessionState))
      return Promise.resolve()
    const epoch = this.epoch
    const generation = ++this.readGeneration
    const read = this.options
      .get(sessionId)
      .then(async (snapshot) => {
        if (generation !== this.readGeneration || !this.accept(snapshot, epoch)) return
        // A lost request is retried using its original identity; cached commits
        // and a never-admitted request have the same reconciliation path.
        if (
          this.request &&
          this.state.checking &&
          !snapshot.pending &&
          !this.sending &&
          this.attempts < 3
        ) {
          await this.send(this.request, epoch)
        }
      })
      .catch(() => {
        if (epoch === this.epoch && generation === this.readGeneration)
          this.publish({
            ...this.state,
            checking: true,
            error: 'The backend could not confirm source status. Retry status to reconnect.'
          })
      })
      .finally(() => {
        if (this.read === read) {
          this.read = null
          if (this.readDirty) {
            this.readDirty = false
            void this.refresh()
          }
        }
      })
    this.read = read
    return read
  }

  /** Explicit recovery keeps the original operation identity until resolved. */
  async retryStatus(): Promise<void> {
    if (this.sending || this.read) return
    this.attempts = 0
    this.proofReads = 0
    this.publish({ ...this.state, error: null })
    await this.refresh()
    await this.reconcile()
  }

  private async reconcile(): Promise<void> {
    const epoch = this.epoch
    for (let reads = 0; reads < 3 && epoch === this.epoch && this.state.checking; reads += 1) {
      await this.refresh()
      if (this.attempts >= 3) break
    }
    if (epoch === this.epoch && this.state.checking && !this.state.error) {
      this.publish({
        ...this.state,
        error: 'The source change could not be confirmed. Retry status to reconnect.'
      })
    }
  }

  private async send(request: SourceSwitchParams, epoch: number): Promise<void> {
    this.sending = true
    const sendGeneration = ++this.sendGeneration
    const current = (): boolean =>
      epoch === this.epoch &&
      sendGeneration === this.sendGeneration &&
      this.requestId === request.requestId
    this.attempts += 1
    try {
      const snapshot = await this.options.switch(request)
      if (!current()) return
      this.readGeneration += 1
      this.read = null
      this.accept(snapshot, epoch)
    } catch (error) {
      if (!current()) return
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (
        typeof code === 'string' &&
        (code.startsWith('source-switch-') || code === 'invalid-params')
      ) {
        this.readGeneration += 1
        this.read = null
        this.request = null
        this.requestId = null
        this.publish({
          ...this.state,
          pending: null,
          checking: false,
          error: error instanceof Error ? error.message : 'The source change was rejected.',
          errorKind: request.kind
        })
        if (code !== 'source-switch-stopping' && code !== 'source-switch-inactive-session') {
          this.reportFailure(
            request.requestId,
            error instanceof Error ? error.message : 'The source change was rejected.'
          )
        }
        await this.refresh()
      } else {
        this.publish({
          ...this.state,
          checking: true,
          error:
            this.attempts >= 3
              ? 'The source change could not be confirmed. Retry status to reconnect.'
              : null
        })
      }
    } finally {
      if (epoch === this.epoch && sendGeneration === this.sendGeneration) this.sending = false
    }
  }

  async select(
    kind: SessionSourceKind,
    deviceId: string | null,
    protectedOverlayWindowIds: number[] | Promise<number[]>,
    targetName?: string
  ): Promise<void> {
    const reason = this.reason(kind)
    if (reason || !this.sessionId || !this.state.snapshot)
      throw new Error(reason ?? 'No running session.')
    const epoch = this.epoch
    const requestId = this.options.requestId()
    this.requestId = requestId
    const request = {
      sessionId: this.sessionId,
      requestId,
      expectedSourceRevision: this.state.snapshot.sourceRevision,
      kind,
      deviceId,
      protectedOverlayWindowIds: [] as number[]
    }
    this.request = request
    this.attempts = 0
    this.readGeneration += 1
    this.read = null
    // Runs before the first await, closing competing same-render-turn clicks.
    this.clearProofTimer()
    this.publish({
      ...this.state,
      pending: kind,
      targetName: targetName ?? (deviceId === null ? 'None' : deviceId),
      outputPending: false,
      checking: false,
      error: null
    })
    try {
      request.protectedOverlayWindowIds = await protectedOverlayWindowIds
    } catch (error) {
      if (epoch === this.epoch) {
        this.request = null
        this.requestId = null
        this.publish({
          ...this.state,
          pending: null,
          checking: false,
          error: 'Protected windows could not be checked.',
          errorKind: kind
        })
      }
      throw error
    }
    if (epoch !== this.epoch) return
    await this.send(request, epoch)
    if (epoch === this.epoch && this.requestId === requestId && this.state.checking)
      await this.reconcile()
  }
}

export { confirmedSourceSelection } from './source-selection-confirmed'
