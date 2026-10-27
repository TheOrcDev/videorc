// Observations from the real renderer, with no browser or filesystem dependencies.
export const FIRST_RUN_SMOKE_LIMITS = Object.freeze({
  // Plan target: 2 s. Allow 1 s for dev chunk loading and CDP/observer scheduling.
  movingWithinMs: 3000,
  sampleAtLeastMs: 1800,
  minimumChangedFrames: 10,
  maximumDrawFps: 31,
  whatsNewWatchMs: 1000
})

export function evaluateFirstRunSmokeStep(step, observation = {}) {
  const failures = []
  const check = (condition, message) => {
    if (!condition) failures.push(message)
  }
  const o = observation
  const validRecord = (status) =>
    o.record?.version === 1 &&
    o.record?.step === 'permissions' &&
    status.includes(o.record?.status) &&
    typeof o.record?.updatedAt === 'string' &&
    Number.isFinite(Date.parse(o.record.updatedAt))
  const setup = (mode) => {
    check(o.setup === 'open' && o.mode === mode, `expected open ${mode} setup`)
    check(o.cardStep === 'permissions', 'missing permissions card')
    check(o.rows?.length === 4 && !o.loading, 'expected four resolved macOS permission rows')
    check(o.sidebar === false, 'workspace sidebar appeared during setup')
    check(o.primaryCount === 1, 'expected exactly one primary')
    check(['Continue', 'Skip for now'].includes(o.primary), 'unexpected primary label')
    check(o.whatsNew === false && o.whatsNewOverSetup === false, "What's New appeared over setup")
  }
  const workspace = () => {
    check(o.setup === null && o.sidebar === true, 'expected workspace without setup')
    check(o.canvasCount === 0, 'backdrop canvas survived setup')
  }
  switch (step) {
    case 'fresh':
      setup('first-run')
      check(validRecord(['in-progress']), 'fresh install did not write in-progress')
      check(o.workspaceBeforeSetup === false, 'workspace appeared before fresh setup')
      break
    case 'moving':
      check(o.backdrop === 'moving', `backdrop did not move (reason: ${o.reason ?? 'none'})`)
      check(o.look === 'polished', 'expected Polished Liquid Chrome')
      check(
        Number.isFinite(o.mountToMovingMs) &&
          o.mountToMovingMs >= 0 &&
          o.mountToMovingMs <= FIRST_RUN_SMOKE_LIMITS.movingWithinMs,
        `backdrop must move within ${FIRST_RUN_SMOKE_LIMITS.movingWithinMs} ms of setup mount (observed ${o.mountToMovingMs ?? 'missing'})`
      )
      break
    case 'motion':
      check(o.backdrop === 'moving', `backdrop stopped (reason: ${o.reason ?? 'none'})`)
      check(
        Number.isFinite(o.durationMs) && o.durationMs >= FIRST_RUN_SMOKE_LIMITS.sampleAtLeastMs,
        'motion sample is missing or too short'
      )
      check(
        Number.isInteger(o.frameCount) &&
          o.frameCount >= FIRST_RUN_SMOKE_LIMITS.minimumChangedFrames,
        'too few screencast frames to prove changing pixels'
      )
      check(o.firstLastDiffer === true, 'first and last screencast pixels did not change')
      check(
        Number.isInteger(o.drawCount) && o.drawCount >= FIRST_RUN_SMOKE_LIMITS.minimumChangedFrames,
        'missing backdrop draw evidence'
      )
      check(
        Number.isFinite(o.drawFps) &&
          o.drawFps > 0 &&
          o.drawFps <= FIRST_RUN_SMOKE_LIMITS.maximumDrawFps,
        `backdrop draw rate ${o.drawFps ?? 'missing'} fps exceeds ${FIRST_RUN_SMOKE_LIMITS.maximumDrawFps} fps or is missing`
      )
      break
    case 'reduced-motion':
      check(
        o.backdrop === 'still' && o.reason === 'reduced-motion',
        `expected reduced-motion still, got ${o.backdrop}/${o.reason}`
      )
      check(o.canvasCount === 0, 'reduced motion left a backdrop canvas')
      break
    case 'finish':
      workspace()
      check(validRecord(['done', 'skipped']), 'primary did not write done or skipped')
      check(
        o.record?.status === (o.pressedPrimary === 'Continue' ? 'done' : 'skipped'),
        'record disagrees with pressed primary'
      )
      check(o.retainedContextsLost === true, 'a retained backdrop WebGL context was not released')
      break
    case 'reload':
      workspace()
      check(validRecord(['done', 'skipped']), 'finished record lost on reload')
      check(o.recordRaw === o.beforeRecordRaw, 'reload changed the finished record')
      check(o.setupEver === false, 'finished setup flashed on reload')
      break
    case 'existing-install':
      workspace()
      check(
        validRecord(['existing-install']),
        "What's New marker did not migrate to existing-install"
      )
      check(o.setupEver === false, 'existing install saw setup')
      break
    case 'resume':
      setup('first-run')
      check(validRecord(['in-progress']), 'in-progress record did not resume')
      break
    case 'replay-open':
      setup('replay')
      check(
        o.recordRaw === o.beforeRecordRaw && typeof o.recordRaw === 'string',
        'replay changed the record'
      )
      break
    case 'replay-return':
      workspace()
      check(o.settingsGeneral === true, 'replay did not return to Settings → General')
      check(
        o.recordRaw === o.beforeRecordRaw && typeof o.recordRaw === 'string',
        'leaving replay changed the record'
      )
      break
    case 'whats-new':
      setup('first-run')
      check(o.seededWhatsNew === '0.0.1', 'missing old-version test seed')
      check(o.watchMs >= FIRST_RUN_SMOKE_LIMITS.whatsNewWatchMs, "What's New watch was too short")
      break
    default:
      failures.push(`unknown first-run smoke step: ${step}`)
  }
  return { pass: failures.length === 0, failures }
}
