// Plan 096 live-trial guardrails. These are preflight decisions, not a quota
// price, a hard spending guarantee, or authorization to enable streaming.
export function assessYouTubeTrial(input, now = Date.now()) {
  const errors = []
  const finite = (key, minimum = 0) => {
    const value = input?.[key]
    if (!Number.isFinite(value) || value < minimum) errors.push(`invalid-${key}`)
    return value
  }
  const limit = finite('dailyLimit', 1)
  const used = finite('usedUnits')
  const sampleAt = Date.parse(input?.sampledAt)
  if (!Number.isFinite(sampleAt) || now - sampleAt > 600_000 || sampleAt > now) {
    errors.push('metrics-stale-or-invalid')
  }
  const lag = finite('measuredIngestionLagMs')
  if (lag > 600_000) errors.push('metrics-lag-too-large')
  const known = finite('knownSetupAndSendsUnits')
  const teardown = finite('reservedTeardownUnits', 50)
  const sends = finite('paidSends')
  const opens = finite('maximumOpens', 1)
  const duration = finite('maximumSeconds', 1)
  if (!Number.isInteger(sends) || sends > 2) errors.push('too-many-paid-sends')
  if (!Number.isInteger(opens) || opens > 3) errors.push('too-many-opens')
  if (duration > 60) errors.push('initial-trial-too-long')
  if (known < sends * 50) errors.push('sends-not-budgeted')
  if (known + teardown > 500) errors.push('known-call-budget-exceeded')
  const remaining = limit - used
  const reserve = limit * 0.2
  if (remaining < limit * 0.5) errors.push('less-than-half-daily-headroom')
  if (remaining - known - teardown < reserve) errors.push('protected-reserve-at-risk')
  if (input?.ownerWindowConfirmed !== true) errors.push('owner-window-not-confirmed')
  if (input?.privateOrUnlistedBroadcastConfirmed !== true)
    errors.push('test-broadcast-not-confirmed')
  if (input?.attributionAvailable !== true) errors.push('billing-attribution-unavailable')
  return {
    eligible: errors.length === 0,
    blockers: errors,
    measurementStatus: 'not-performed',
    protocolCandidate: 'documented-grpc',
    streamingEstimatedUnits: null,
    dailyLimit: Number.isFinite(limit) ? limit : null,
    remainingUnits: Number.isFinite(remaining) ? remaining : null,
    protectedReserveUnits: Number.isFinite(reserve) ? reserve : null,
    reservedTeardownUnits: Number.isFinite(teardown) ? teardown : null,
    knownCallBudgetUnits: Number.isFinite(known + teardown) ? known + teardown : null,
    maximumSeconds: Number.isFinite(duration) ? duration : null,
    maximumOpens: Number.isFinite(opens) ? opens : null,
    paidSends: Number.isFinite(sends) ? sends : null
  }
}

/** Track known exposure only. An unknown streaming charge never becomes zero. */
export class YouTubeTrialBudget {
  constructor(preflight, now = Date.now()) {
    if (!preflight.eligible) throw new Error('Live-trial preflight refused')
    this.preflight = preflight
    this.startedAt = now
    this.opens = 0
    this.sends = 0
    this.knownUnits = 0
  }
  reserve({ units, send = false, open = false }, now = Date.now()) {
    if (!Number.isFinite(units) || units < 0)
      throw new Error('Unknown cost cannot enter known-unit ledger')
    if (now - this.startedAt >= this.preflight.maximumSeconds * 1000)
      throw new Error('Trial deadline reached')
    if (this.opens + Number(open) > this.preflight.maximumOpens)
      throw new Error('Connection-open limit reached')
    if (this.sends + Number(send) > this.preflight.paidSends)
      throw new Error('Paid-send limit reached')
    // Reserved teardown is intentionally unavailable to normal trial activity.
    if (
      this.knownUnits + units >
      this.preflight.knownCallBudgetUnits - this.preflight.reservedTeardownUnits
    )
      throw new Error('Known-call budget exhausted')
    this.knownUnits += units
    this.opens += Number(open)
    this.sends += Number(send)
  }
}
