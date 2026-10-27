// Observations from the real renderer, with no browser or filesystem dependencies.
export const FIRST_RUN_SMOKE_LIMITS = Object.freeze({
  // Plan target: 2 s. Allow 1 s for dev chunk loading and CDP/observer scheduling.
  movingWithinMs: 3000,
  sampleAtLeastMs: 1800,
  minimumChangedFrames: 10,
  maximumDrawFps: 31,
  whatsNewWatchMs: 1000,
  lookSampleAtLeastMs: 30000,
  clipsWatchMs: 10000
})

// Emitted at admission, BEFORE the native source is queued. Reuse is also
// forbidden in setup: it would hide an already-running source. Screen startup
// and native sizing are additional witnesses if a generation log ever drifts.
export const FIRST_RUN_SOURCE_START_PATTERNS = Object.freeze([
  String.raw`\[capture-generation\] source=(?:camera|screen|window)\b[^\r\n]* config=`,
  'screen capture startup phase',
  String.raw`\[videorc-capture-sizing\]`
])

export function firstRunSourceStartLines(lines) {
  return lines.filter((line) =>
    FIRST_RUN_SOURCE_START_PATTERNS.some((pattern) => new RegExp(pattern).test(line))
  )
}

const STEPS = ['permissions', 'goal', 'look', 'sound', 'destinations']
const STILL_REASONS = ['no-gpu', 'software-gpu', 'hardware-acceleration-off']

export function evaluateFirstRunSmokeStep(step, observation = {}) {
  const failures = []
  const skipped = []
  const check = (condition, message) => {
    if (!condition) failures.push(message)
  }
  const o = observation
  const validRecord = (status) =>
    [1, 2].includes(o.record?.version) &&
    STEPS.includes(o.record?.step) &&
    (o.record?.version === 1 || [null, 'record', 'stream', 'both'].includes(o.record?.goal)) &&
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
      check(
        validRecord(['in-progress']) && o.record.step === 'permissions',
        'fresh install did not write in-progress at permissions'
      )
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
        ['Open Studio', 'Skip setup'].includes(o.pressedPrimary) &&
          o.record?.status === (o.pressedPrimary === 'Open Studio' ? 'done' : 'skipped'),
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
      if ((o.expectedStep ?? 'permissions') === 'permissions') setup('first-run')
      else
        check(o.setup === 'open' && o.mode === 'first-run' && !o.sidebar, 'resumed outside setup')
      check(
        validRecord(['in-progress']) &&
          o.record.step === (o.expectedStep ?? 'permissions') &&
          o.cardStep === (o.expectedStep ?? 'permissions'),
        'in-progress record did not resume at the saved step'
      )
      if (o.beforeConfig !== undefined) {
        check(
          JSON.stringify(o.config?.layout) === JSON.stringify(o.beforeConfig.layout) &&
            JSON.stringify(o.config?.audio) === JSON.stringify(o.beforeConfig.audio),
          'resume changed the chosen layout or audio'
        )
        check(
          o.registry?.live?.activeId === o.beforeBackground,
          'resume changed the chosen background'
        )
      }
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
      check(
        o.configRaw === o.beforeConfigRaw && typeof o.configRaw === 'string',
        'leaving replay changed captureConfig'
      )
      check(
        JSON.stringify(o.visitedSteps) === JSON.stringify(STEPS),
        'replay did not walk every step'
      )
      check(o.pressedPrimary === 'Done', 'replay did not finish with Done')
      break
    case 'goal':
      check(
        o.setup === 'open' && o.cardStep === 'goal' && o.position === '2/5',
        'permissions did not advance to goal at 2/5'
      )
      check(validRecord(['in-progress']) && o.record.step === 'goal', 'goal record was not saved')
      check(
        o.primaryCount === 0 && o.goalOptions?.join(',') === 'record,stream,both',
        'goal must have three choice rows and no primary'
      )
      break
    case 'record-look':
      check(
        o.setup === 'open' && o.cardStep === 'look' && o.position === '3/4',
        'Recordings did not drop destinations'
      )
      check(
        validRecord(['in-progress']) && o.record.step === 'look' && o.record.goal === 'record',
        'Recordings goal/step was not saved'
      )
      break
    case 'look': {
      check(o.setup === 'open' && o.cardStep === 'look', 'look is not open')
      check(Array.isArray(o.layoutOptions) && o.layoutOptions.length >= 4, 'missing layout options')
      const available = o.layoutOptions?.filter((option) => !option.disabled) ?? []
      if (available.length)
        check(
          o.layoutClicked === o.layout && available.some((option) => option.preset === o.layout),
          'an available layout was not picked'
        )
      else {
        check(
          o.layoutClicked === null && o.layoutOptions?.every((option) => option.reason),
          'disabled layouts need reasons'
        )
        skipped.push('layout click: no available camera/screen layout (observed disabled reasons)')
      }
      check(
        typeof o.background === 'string' &&
          o.background !== 'none' &&
          o.registry?.live?.activeId === o.background &&
          o.registry?.activeSlotId === null,
        'live background choice did not reach the registry'
      )
      check(
        o.config?.layout?.layoutPreset === o.layout,
        'layout choice did not reach captureConfig'
      )
      check(
        o.committedLayout === o.layout && o.committedBackground === o.background,
        'look did not reach the committed scene'
      )
      if (o.picture === 'still' && STILL_REASONS.includes(o.reason))
        skipped.push(`picture motion: ${o.reason}`)
      else check(o.picture === 'moving', `look picture did not move (${o.picture}/${o.reason})`)
      break
    }
    case 'look-motion': {
      check(
        o.durationMs >= FIRST_RUN_SMOKE_LIMITS.lookSampleAtLeastMs,
        'two-player sample must last at least 30 s'
      )
      for (const name of ['backdrop', 'picture']) {
        if (o[name] === 'still' && STILL_REASONS.includes(o.reason)) {
          check(
            o[`${name}DrawCount`] === 0 && o[`${name}DrawFps`] === 0,
            `${name} drew while still`
          )
          skipped.push(`${name} motion: ${o.reason}`)
        } else {
          check(o[name] === 'moving', `${name} stopped during the two-player sample (${o.reason})`)
          check(
            Number.isInteger(o[`${name}DrawCount`]) &&
              o[`${name}DrawCount`] >= FIRST_RUN_SMOKE_LIMITS.minimumChangedFrames,
            `missing ${name} draw evidence`
          )
          check(
            Number.isFinite(o[`${name}DrawFps`]) &&
              o[`${name}DrawFps`] > 0 &&
              o[`${name}DrawFps`] <= FIRST_RUN_SMOKE_LIMITS.maximumDrawFps,
            `${name} exceeded 31 fps or has no draw rate`
          )
        }
      }
      if (o.gpuCpuPercent === null && o.reason === 'no-gpu') {
        skipped.push('GPU process CPU: no-gpu')
      } else {
        check(
          Number.isFinite(o.gpuCpuPercent) && o.gpuCpuPercent >= 0,
          'missing GPU process CPU measurement'
        )
      }
      break
    }
    case 'sound':
      check(
        o.cardStep === 'sound' && o.soundMicrophoneRow && o.soundSystemAudioRow,
        'missing Sound check rows'
      )
      if (o.soundBlocked) {
        check(
          ['denied', 'restricted', 'not-determined'].includes(o.microphoneGrant),
          'blocked alert without an observed missing microphone grant'
        )
        skipped.push(`Gain key press and real voice verdict: microphone ${o.microphoneGrant}`)
      } else {
        check(
          o.soundMeter &&
            o.gainKeyPressed === true &&
            Number.isFinite(o.gainBefore) &&
            Number.isFinite(o.config?.audio?.microphoneGainDb) &&
            o.config.audio.microphoneGainDb !== o.gainBefore,
          'Gain key press did not change microphoneGainDb beside the meter'
        )
      }
      break
    case 'workspace-look':
      workspace()
      check(validRecord(['done']), 'Open Studio did not finish setup')
      check(
        o.config?.layout?.layoutPreset === o.chosenLayout &&
          o.registry?.live?.activeId === o.chosenBackground &&
          o.committedLayout === o.chosenLayout &&
          o.committedBackground === o.chosenBackground,
        'Studio lost the chosen look'
      )
      check(
        o.watchMs >= FIRST_RUN_SMOKE_LIMITS.clipsWatchMs,
        'Clips toast watch was shorter than 10 s'
      )
      check(
        Array.isArray(o.toasts) && o.toasts.every((text) => !text.includes("Clips couldn't start")),
        'Clips failure toast appeared'
      )
      check(
        Array.isArray(o.refusedStarts) && o.refusedStarts.length === 0,
        'backend refused a session start'
      )
      break
    case 'destinations':
      check(o.cardStep === 'destinations' && o.position === '5/5', 'streaming step is missing')
      check(
        o.destinationRows?.map((row) => row.platform).join(',') === 'youtube,twitch,kick,x' &&
          o.destinationRows.every(
            (row) =>
              ['connected', 'waiting', 'not-connected'].includes(row.state) &&
              (row.state !== 'not-connected' || row.signIn || row.unavailable)
          ),
        'missing destination rows or honest sign-in availability'
      )
      check(o.streamKeyAction === 'Open Livestream', 'missing stream-key action')
      skipped.push(
        'real OAuth sign-in: smoke observes availability; release-like build and owner account required'
      )
      break
    case 'livestream':
      workspace()
      check(
        validRecord(['done']) && o.record.goal === 'stream',
        'Open Livestream did not write done for Livestreams'
      )
      check(o.livestreamSetup === true, 'Open Livestream did not land on Livestream → Setup')
      break
    case 'skip-look':
      workspace()
      check(
        validRecord(['skipped']) && o.record.step === 'look',
        'Skip setup did not write skipped from look'
      )
      check(
        o.configRaw === o.beforeConfigRaw &&
          typeof o.configRaw === 'string' &&
          o.registryRaw === o.beforeRegistryRaw &&
          typeof o.registryRaw === 'string',
        'Skip setup lost choices'
      )
      break
    case 'no-device-starts':
      check(
        o.backendReady === true && o.startMs < o.endMs && o.closedObserved === true,
        'missing backend/open-to-close log interval'
      )
      check(
        JSON.stringify(o.patterns) === JSON.stringify(FIRST_RUN_SOURCE_START_PATTERNS),
        'source-start scan did not use the maintained patterns'
      )
      check(
        Array.isArray(o.matches) && o.matches.length === 0,
        'camera/screen source started while setup was open'
      )
      check(
        (o.previewIdleAtOpen === true && o.previewIdleBeforeLeave === true) ||
          (o.allowExistingSources === true && o.previewIdentityUnchanged === true),
        'preview source started during setup (fresh sources must stay idle; replay may keep existing sources)'
      )
      break
    case 'theme-walk':
      check(
        o.theme === o.expectedTheme && ['dark', 'light'].includes(o.theme),
        'theme seed did not apply'
      )
      check(
        JSON.stringify(o.visitedSteps) === JSON.stringify(STEPS) &&
          o.screenshots?.length === 5 &&
          o.screenshots.every((path) => typeof path === 'string' && path.endsWith('.png')),
        'missing a step screenshot in the theme walk'
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
  return { pass: failures.length === 0, failures, ...(skipped.length ? { skipped } : {}) }
}
