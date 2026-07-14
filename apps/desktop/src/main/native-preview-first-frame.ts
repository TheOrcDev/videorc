// First-frame contract for the detached native preview (Definitive Fix Plan P2).
//
// From the moment the preview window opens, the app OWES the user one of three
// outcomes within budget: a native CAMetalLayer frame of the app's committed
// scene, a self-heal that gets there, or a declared fallback with the exact
// blocked link. "Waiting for preview" forever is not an outcome.
//
// This module is the pure decision core (electron-free, unit-tested): given a
// snapshot of the chain each tick, it says whether the contract is met, which
// healing action to fire next, and the truthful reason string for the preview
// window's waiting hint. index.ts owns the timers and executes the actions.

export interface FirstFrameSnapshot {
  elapsedMs: number
  surfaceLive: boolean
  /** transport === 'native-surface' && backing === 'cametal-layer' */
  nativePresenting: boolean
  /** compositor framesRendered advanced since the previous tick */
  framesAdvancing: boolean
  /** native presentedFrameId advanced since the previous tick */
  presentationAdvancing: boolean
  /** revision of the scene the renderer last pushed (null before first push) */
  rendererSceneRevision: number | null
  compositorSceneRevision: number | null
  compositorFrameSceneRevision: number | null
  metalTargetPresent: boolean
}

export type FirstFrameHealingAction = 'present-kick' | 'resync-scene' | 'reset-native-path'

export interface FirstFrameLedger {
  lastActionAtMs: number
  attempts: Record<FirstFrameHealingAction, number>
}

export interface FirstFrameBudgets {
  /** earliest elapsed time each action may fire */
  presentKickAfterMs: number
  resyncSceneAfterMs: number
  resetNativePathAfterMs: number
  /** minimum spacing between any two healing actions */
  actionSpacingMs: number
  /** attempts allowed per action before moving on */
  attemptsPerAction: number
  /** elapsed time after which the contract is declared failed */
  declareFallbackAfterMs: number
}

export const DEFAULT_FIRST_FRAME_BUDGETS: FirstFrameBudgets = {
  presentKickAfterMs: 1500,
  resyncSceneAfterMs: 3000,
  resetNativePathAfterMs: 6000,
  actionSpacingMs: 1200,
  attemptsPerAction: 2,
  declareFallbackAfterMs: 15000
}

/**
 * This watchdog proves a CAMetalLayer/IOSurface chain and may reset that native
 * presenter while healing. Windows uses the Electron proof surface instead, so
 * running the Metal contract there guarantees false healing and visible resets.
 */
export function nativePreviewFirstFrameWatchdogEnabled(platform: NodeJS.Platform): boolean {
  return platform === 'darwin'
}

export function nativePreviewProofWatchdogEnabled(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}

export const DEFAULT_PROOF_SOURCE_FRAME_STALE_MS = 1500
export const DEFAULT_PROOF_FIRST_FRAME_TIMEOUT_MS = 15_000
export const DEFAULT_PROOF_WATCHDOG_READ_TIMEOUT_MS = 500

export type ProofSourceFrameAssessment = 'not-applicable' | 'paused' | 'pending' | 'met' | 'stalled'

export function assessProofSourceFrame(params: {
  platform: NodeJS.Platform
  framePollingSuppressed: boolean
  sourceExpected?: boolean
  sourcePollerCount: number
  freshSourceLayerCount: number
  /** Every active source poller has decoded at least one frame in its current generation. */
  sourceFrameHistoryComplete: boolean
  sourceFrameAgeMs?: number
  staleAfterMs?: number
}): ProofSourceFrameAssessment {
  if (params.platform === 'darwin') {
    return 'not-applicable'
  }
  if (params.framePollingSuppressed) {
    return 'paused'
  }
  if (params.sourcePollerCount <= 0) {
    return params.sourceExpected ? 'pending' : 'not-applicable'
  }
  const staleAfterMs = params.staleAfterMs ?? DEFAULT_PROOF_SOURCE_FRAME_STALE_MS
  if (
    params.freshSourceLayerCount >= params.sourcePollerCount &&
    params.sourceFrameAgeMs != null &&
    params.sourceFrameAgeMs <= staleAfterMs
  ) {
    return 'met'
  }
  if (
    params.sourceFrameHistoryComplete &&
    params.sourceFrameAgeMs != null &&
    params.sourceFrameAgeMs > staleAfterMs
  ) {
    return 'stalled'
  }
  return 'pending'
}

export function assessProofPresentationWatch(params: {
  platform: NodeJS.Platform
  framePollingSuppressed: boolean
  surfaceReady: boolean
  sourceExpected: boolean
  sourcePollerCount: number
  freshSourceLayerCount: number
  sourceFrameHistoryComplete: boolean
  sourceFrameAgeMs?: number
  pendingElapsedMs: number
  pendingTimeoutMs?: number
  staleAfterMs?: number
}): ProofSourceFrameAssessment {
  if (params.platform === 'darwin') {
    return 'not-applicable'
  }
  if (params.framePollingSuppressed) {
    return 'paused'
  }
  const pendingTimeoutMs = params.pendingTimeoutMs ?? DEFAULT_PROOF_FIRST_FRAME_TIMEOUT_MS
  if (!params.surfaceReady) {
    return params.pendingElapsedMs >= pendingTimeoutMs ? 'stalled' : 'pending'
  }
  const assessment = assessProofSourceFrame(params)
  return assessment === 'pending' && params.pendingElapsedMs >= pendingTimeoutMs
    ? 'stalled'
    : assessment
}

export function proofPresentationFallbackReason(params: {
  sourceFrameHistoryComplete: boolean
  sourceFrameAgeMs?: number
  pendingElapsedMs: number
}): string {
  if (!params.sourceFrameHistoryComplete) {
    return `Windows preview did not deliver a first frame within ${Math.round(params.pendingElapsedMs)}ms.`
  }
  if (params.sourceFrameAgeMs != null) {
    return `Windows preview source frames have not advanced for ${Math.round(params.sourceFrameAgeMs)}ms; keeping the last good frame while polling retries.`
  }
  return `Windows preview source frame liveness did not update within ${Math.round(params.pendingElapsedMs)}ms.`
}

export function boundedProofWatchdogRead<T>(
  read: Promise<T>,
  timeoutMs = DEFAULT_PROOF_WATCHDOG_READ_TIMEOUT_MS
): Promise<T | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    void read.then(
      (value) => finish(value),
      () => finish(null)
    )
  })
}

export interface ProofWatchdogRendererReadOwner {
  watchdogRun: object
  webContents: object
}

export interface WatchdogRunToken {
  readonly id: symbol
}

export interface WatchdogTickToken {
  readonly id: symbol
  readonly run: WatchdogRunToken
}

// A stopped run releases its slot immediately so close/reopen is responsive,
// but the old async tick still owns a distinct token. Its eventual `finally`
// therefore cannot clear a tick already acquired by the reopened run.
export class WatchdogTickOwnership {
  private currentRun: WatchdogRunToken | null = null
  private inFlight: WatchdogTickToken | null = null

  startRun(): WatchdogRunToken {
    const run = { id: Symbol('watchdog-run') }
    this.currentRun = run
    this.inFlight = null
    return run
  }

  stopRun(run: WatchdogRunToken): void {
    if (this.currentRun === run) {
      this.currentRun = null
      this.inFlight = null
    }
  }

  tryAcquire(run: WatchdogRunToken): WatchdogTickToken | null {
    if (this.currentRun !== run || this.inFlight) {
      return null
    }
    const tick = { id: Symbol('watchdog-tick'), run }
    this.inFlight = tick
    return tick
  }

  isCurrent(tick: WatchdogTickToken): boolean {
    return this.currentRun === tick.run && this.inFlight === tick
  }

  release(tick: WatchdogTickToken): void {
    if (this.inFlight === tick) {
      this.inFlight = null
    }
  }
}

// The timeout bounds each watchdog tick, not Electron's non-cancellable
// executeJavaScript call. Keep reusing both that underlying call and its one
// bounded result until the read settles; otherwise every timed-out tick would
// attach another reaction retained forever by a hung renderer promise. Only a
// new watchdog run or WebContents may supersede them.
export class ProofWatchdogRendererReadSingleFlight<T> {
  private owner: ProofWatchdogRendererReadOwner | null = null
  private pending: Promise<T> | null = null
  private bounded: Promise<T | null> | null = null

  read(
    owner: ProofWatchdogRendererReadOwner,
    startRead: () => Promise<T>,
    timeoutMs = DEFAULT_PROOF_WATCHDOG_READ_TIMEOUT_MS
  ): Promise<T | null> {
    if (!this.pending || !this.ownerMatches(owner)) {
      const pending = startRead()
      const bounded = boundedProofWatchdogRead(pending, timeoutMs)
      this.owner = owner
      this.pending = pending
      this.bounded = bounded
      const clear = (): void => {
        if (this.pending === pending && this.ownerMatches(owner)) {
          this.owner = null
          this.pending = null
          this.bounded = null
        }
      }
      void pending.then(clear, clear)
    }
    return this.bounded!
  }

  retire(owner?: ProofWatchdogRendererReadOwner): void {
    if (!owner || this.ownerMatches(owner)) {
      this.owner = null
      this.pending = null
      this.bounded = null
    }
  }

  private ownerMatches(owner: ProofWatchdogRendererReadOwner): boolean {
    return (
      this.owner?.watchdogRun === owner.watchdogRun && this.owner.webContents === owner.webContents
    )
  }
}

export function proofWatchdogRendererReadAllowed(input: {
  framePollingSuppressed: boolean
  intentionallyHidden: boolean
  proofWindowVisible: boolean
}): boolean {
  return !input.framePollingSuppressed && !input.intentionallyHidden && input.proofWindowVisible
}

export type FirstFrameAssessment =
  | { kind: 'met' }
  | { kind: 'pending'; reason: string }
  | { kind: 'heal'; action: FirstFrameHealingAction; reason: string }
  | { kind: 'fallback'; reason: string }

export function emptyFirstFrameLedger(): FirstFrameLedger {
  return {
    lastActionAtMs: 0,
    attempts: { 'present-kick': 0, 'resync-scene': 0, 'reset-native-path': 0 }
  }
}

export function firstFrameContractMet(snapshot: FirstFrameSnapshot): boolean {
  return (
    snapshot.surfaceLive &&
    snapshot.nativePresenting &&
    snapshot.framesAdvancing &&
    snapshot.metalTargetPresent &&
    snapshot.rendererSceneRevision != null &&
    snapshot.compositorSceneRevision === snapshot.rendererSceneRevision &&
    snapshot.compositorFrameSceneRevision === snapshot.compositorSceneRevision
  )
}

// The truthful waiting reason, ordered by which link of the chain is blocked
// first. This string is shown verbatim in the preview window hint.
export function firstFrameBlockedReason(snapshot: FirstFrameSnapshot): string {
  if (!snapshot.surfaceLive) {
    return 'Preview surface is starting.'
  }
  if (snapshot.rendererSceneRevision == null) {
    return 'Waiting for the app to commit its scene.'
  }
  if (
    snapshot.compositorSceneRevision != null &&
    snapshot.compositorSceneRevision !== snapshot.rendererSceneRevision
  ) {
    return `Compositor is on scene revision ${snapshot.compositorSceneRevision}, but the app committed ${snapshot.rendererSceneRevision}.`
  }
  if (
    snapshot.compositorFrameSceneRevision != null &&
    snapshot.compositorSceneRevision != null &&
    snapshot.compositorFrameSceneRevision !== snapshot.compositorSceneRevision
  ) {
    return `Waiting for the compositor to render scene revision ${snapshot.compositorSceneRevision}.`
  }
  if (!snapshot.metalTargetPresent) {
    return 'Compositor has not produced a Metal IOSurface target yet.'
  }
  if (!snapshot.framesAdvancing) {
    return 'Compositor frames are not advancing.'
  }
  if (!snapshot.presentationAdvancing) {
    return 'Native presentation is not advancing.'
  }
  if (!snapshot.nativePresenting) {
    return 'Native presenter has not confirmed a frame yet.'
  }
  return 'Waiting for the first native frame.'
}

// Which healing action does this blocked link call for? The ladder is ordered
// cheapest-first, but a diagnosed link can skip ahead (a scene-revision divergence
// goes straight to resync; a dead native presenter goes straight to path reset).
function preferredAction(snapshot: FirstFrameSnapshot): FirstFrameHealingAction {
  if (
    snapshot.rendererSceneRevision != null &&
    snapshot.compositorSceneRevision != null &&
    snapshot.compositorSceneRevision !== snapshot.rendererSceneRevision
  ) {
    return 'resync-scene'
  }
  if (
    snapshot.surfaceLive &&
    snapshot.metalTargetPresent &&
    snapshot.framesAdvancing &&
    (!snapshot.nativePresenting || !snapshot.presentationAdvancing)
  ) {
    return 'reset-native-path'
  }
  return 'present-kick'
}

const ACTION_ORDER: FirstFrameHealingAction[] = [
  'present-kick',
  'resync-scene',
  'reset-native-path'
]

function actionAvailableAtMs(action: FirstFrameHealingAction, budgets: FirstFrameBudgets): number {
  switch (action) {
    case 'present-kick':
      return budgets.presentKickAfterMs
    case 'resync-scene':
      return budgets.resyncSceneAfterMs
    case 'reset-native-path':
      return budgets.resetNativePathAfterMs
  }
}

// --- Mid-session presenting contract (plan 021 F1) -------------------------
// The first-frame contract used to end at 'met': nothing watched for a stall
// afterwards, so a dead pump / suspended helper / lost surface showed the
// "Waiting for preview" placeholder forever (external tester, 2026-07-06 —
// clicking the window revived it because focus re-kicked placement). These
// helpers keep assessing the SAME chain snapshot after the first frame:
// consecutive broken ticks re-enter the healing ladder, exhaustion declares a
// truthful stall, and a recovery re-arms a fresh ladder.

export interface PresentingWatchBudgets {
  /** consecutive broken ticks before the healing ladder arms */
  stallTicksBeforeHealing: number
  /** ladder budgets, with elapsed measured from the start of the stall */
  healing: FirstFrameBudgets
}

export const DEFAULT_PRESENTING_WATCH_BUDGETS: PresentingWatchBudgets = {
  stallTicksBeforeHealing: 3,
  healing: {
    // The tick threshold already absorbed the transient window, so the cheap
    // kick fires immediately once a stall is confirmed.
    presentKickAfterMs: 0,
    resyncSceneAfterMs: 2500,
    resetNativePathAfterMs: 5000,
    actionSpacingMs: 1500,
    attemptsPerAction: 2,
    declareFallbackAfterMs: 20000
  }
}

export interface PresentingWatchState {
  brokenTicks: number
  stallElapsedMs: number
  ledger: FirstFrameLedger
  exhausted: boolean
}

export function emptyPresentingWatch(): PresentingWatchState {
  return {
    brokenTicks: 0,
    stallElapsedMs: 0,
    ledger: emptyFirstFrameLedger(),
    exhausted: false
  }
}

export type PresentingAssessment =
  | { kind: 'presenting' }
  | { kind: 'observing'; reason: string }
  | { kind: 'heal'; action: FirstFrameHealingAction; reason: string }
  | { kind: 'stalled'; reason: string }

// Everything healthy except frame advancement. Could be a legitimately static
// scene (the compositor renders on source frames), so the disruptive native
// path reset must never fire for it — kick/resync only.
function isSoftStall(snapshot: FirstFrameSnapshot): boolean {
  return (
    snapshot.surfaceLive &&
    snapshot.nativePresenting &&
    snapshot.metalTargetPresent &&
    snapshot.rendererSceneRevision != null &&
    snapshot.compositorSceneRevision === snapshot.rendererSceneRevision &&
    snapshot.compositorFrameSceneRevision === snapshot.compositorSceneRevision &&
    !snapshot.framesAdvancing
  )
}

export function assessPresenting(
  snapshot: FirstFrameSnapshot,
  watch: PresentingWatchState,
  tickMs: number,
  budgets: PresentingWatchBudgets = DEFAULT_PRESENTING_WATCH_BUDGETS
): { assessment: PresentingAssessment; watch: PresentingWatchState } {
  if (firstFrameContractMet(snapshot) && snapshot.presentationAdvancing) {
    // Recovery resets everything, so the next stall gets a fresh ladder.
    return { assessment: { kind: 'presenting' }, watch: emptyPresentingWatch() }
  }

  const next: PresentingWatchState = {
    ...watch,
    brokenTicks: watch.brokenTicks + 1,
    stallElapsedMs: watch.stallElapsedMs + tickMs
  }
  const reason = firstFrameBlockedReason(snapshot)

  if (next.brokenTicks < budgets.stallTicksBeforeHealing) {
    return { assessment: { kind: 'observing', reason }, watch: next }
  }
  if (next.exhausted) {
    return { assessment: { kind: 'stalled', reason }, watch: next }
  }

  const { assessment, ledger } = assessFirstFrame(
    { ...snapshot, elapsedMs: next.stallElapsedMs },
    next.ledger,
    budgets.healing,
    { requirePresentationAdvancing: true }
  )
  next.ledger = ledger

  switch (assessment.kind) {
    case 'met':
      // Unreachable (contract checked above), but keep the mapping total.
      return { assessment: { kind: 'presenting' }, watch: emptyPresentingWatch() }
    case 'pending':
      return { assessment: { kind: 'observing', reason: assessment.reason }, watch: next }
    case 'heal':
      if (assessment.action === 'reset-native-path' && isSoftStall(snapshot)) {
        // The attempt stays charged in the ledger so the ladder still exhausts
        // toward a declared stall — the reset just never fires.
        return { assessment: { kind: 'observing', reason: assessment.reason }, watch: next }
      }
      return { assessment, watch: next }
    case 'fallback':
      next.exhausted = true
      return { assessment: { kind: 'stalled', reason: assessment.reason }, watch: next }
  }
}

export function assessFirstFrame(
  snapshot: FirstFrameSnapshot,
  ledger: FirstFrameLedger,
  budgets: FirstFrameBudgets = DEFAULT_FIRST_FRAME_BUDGETS,
  { requirePresentationAdvancing = false }: { requirePresentationAdvancing?: boolean } = {}
): { assessment: FirstFrameAssessment; ledger: FirstFrameLedger } {
  if (
    firstFrameContractMet(snapshot) &&
    (!requirePresentationAdvancing || snapshot.presentationAdvancing)
  ) {
    return { assessment: { kind: 'met' }, ledger }
  }

  const reason = firstFrameBlockedReason(snapshot)
  if (snapshot.elapsedMs >= budgets.declareFallbackAfterMs) {
    return { assessment: { kind: 'fallback', reason }, ledger }
  }

  const sinceLastAction = snapshot.elapsedMs - ledger.lastActionAtMs
  if (ledger.lastActionAtMs > 0 && sinceLastAction < budgets.actionSpacingMs) {
    return { assessment: { kind: 'pending', reason }, ledger }
  }

  // Try the diagnosed action first, then the rest of the ladder in order.
  const preferred = preferredAction(snapshot)
  const candidates = [preferred, ...ACTION_ORDER.filter((action) => action !== preferred)]
  for (const action of candidates) {
    if (snapshot.elapsedMs < actionAvailableAtMs(action, budgets)) {
      continue
    }
    if (ledger.attempts[action] >= budgets.attemptsPerAction) {
      continue
    }
    const nextLedger: FirstFrameLedger = {
      lastActionAtMs: snapshot.elapsedMs,
      attempts: { ...ledger.attempts, [action]: ledger.attempts[action] + 1 }
    }
    return { assessment: { kind: 'heal', action, reason }, ledger: nextLedger }
  }

  return { assessment: { kind: 'pending', reason }, ledger }
}
