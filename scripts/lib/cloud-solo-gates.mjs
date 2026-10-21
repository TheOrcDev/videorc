/**
 * Pure checks for the cloud solo smoke (plan 184 C8): the timings read off
 * the runner's state stream, the receivers' packet continuity, and whether
 * the viewers saw the hold card during a drop and motion after the resume.
 * Nothing here touches a process or a file, so every rule has a unit test.
 */

/** The plan's bound: no receiver gap over 2 s across a drop. */
export const MAX_RECEIVER_GAP_SECONDS = 2
/** D12: the runner holds 1.5 s after the last frame; the state reaches the
 * desktop within about 2 s more. Anything slower is a bug, not jitter. */
export const MAX_TIME_TO_HOLD_SECONDS = 6
/** Freezes shorter than this are ignored: the test pattern never stands
 * still that long, and the frozen last frame before the fade is 1 s. */
export const MIN_FREEZE_SECONDS = 1.5
/** The hold card settles 1 s (freeze) plus 0.3 s (fade) after the hold. */
export const HOLD_CARD_SETTLE_SECONDS = 1.3
/** C6b: the test's push must be live on the runner within this long of the click. */
export const MAX_TEST_TIME_TO_LIVE_SECONDS = 20
/** C6b: the web caps a test show at this long on the node (`maxShowSeconds`). */
export const TEST_SHOW_CAP_SECONDS = 30
/** The cap's end reaches a control client this long after the cap, at most:
 * the runner's state poll, its end sequence and the socket. */
export const TEST_SHOW_CAP_SLACK_SECONDS = 8

/** `ffprobe -show_entries packet=pts_time -of csv=p=0` output to numbers. */
export function parsePtsTimes(text) {
  const times = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const token = line.trim().replace(/,+$/, '')
    if (!token || token === 'N/A') continue
    const value = Number.parseFloat(token)
    if (Number.isFinite(value)) times.push(value)
  }
  return times
}

/**
 * The largest gap between consecutive packets, in presentation order. The
 * file order is not the display order (B-frames), so the times are sorted.
 */
export function sortedGapStats(times) {
  const sorted = [...times].sort((a, b) => a - b)
  if (sorted.length < 2) {
    return { packets: sorted.length, maxGapSeconds: null, maxGapAtSeconds: null, spanSeconds: null }
  }
  let worst = 0
  let worstAt = sorted[0]
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index] - sorted[index - 1]
    if (gap > worst) {
      worst = gap
      worstAt = sorted[index - 1]
    }
  }
  return {
    packets: sorted.length,
    maxGapSeconds: round3(worst),
    maxGapAtSeconds: round3(worstAt),
    spanSeconds: round3(sorted.at(-1) - sorted[0])
  }
}

/**
 * The first state at or after `afterMs` whose phase is `phase`, from a list
 * of `{ atMs, phase }` observations (the runner's `state` stream as a
 * client sees it). Null when none.
 */
export function firstPhaseAt(states, afterMs, phase) {
  for (const state of states) {
    if (state.atMs >= afterMs && state.phase === phase) return state.atMs
  }
  return null
}

/**
 * One drop's numbers: time to hold from the cut, time to resume from the
 * moment the feed could come back. `restoreMs` is when the proxy forwarded
 * again (drop 1) or when Resume was requested (drop 2).
 */
export function dropTimings(states, { cutMs, restoreMs }) {
  const holdMs = firstPhaseAt(states, cutMs, 'hold')
  const liveMs = restoreMs === null ? null : firstPhaseAt(states, restoreMs, 'live')
  return {
    cutAt: new Date(cutMs).toISOString(),
    holdAt: holdMs === null ? null : new Date(holdMs).toISOString(),
    timeToHoldSeconds: holdMs === null ? null : round3((holdMs - cutMs) / 1000),
    restoreAt: restoreMs === null ? null : new Date(restoreMs).toISOString(),
    liveAt: liveMs === null ? null : new Date(liveMs).toISOString(),
    timeToResumeSeconds: liveMs === null ? null : round3((liveMs - restoreMs) / 1000),
    holdMs,
    liveMs
  }
}

/**
 * A receiver file's clock is the runner's output clock: its packets carry the
 * render time of each frame, which the encoder's lookahead and the first
 * keyframe wait put a second or two ahead of the wall clock at which the
 * file first grew. Anchoring on the first hold (the card's edge is the first
 * long freeze near where the hold should be) gives the offset to add to
 * every wall-clock instant mapped into the file. Null when no freeze sits
 * within `maxShiftSeconds` of the expected card edge.
 */
export function estimateReceiverClockOffset({
  freezes,
  fileStartMs,
  holdMs,
  maxShiftSeconds = 3,
  minFreezeSeconds = 3
}) {
  if (holdMs === null || holdMs === undefined) return null
  const expectedStart = (holdMs - fileStartMs) / 1000 + HOLD_CARD_SETTLE_SECONDS
  let best = null
  for (const freeze of freezes) {
    if (freeze.duration < minFreezeSeconds) continue
    const shift = freeze.start - expectedStart
    if (Math.abs(shift) > maxShiftSeconds) continue
    if (!best || Math.abs(shift) < Math.abs(best.offsetSeconds)) {
      best = {
        offsetSeconds: round3(shift),
        freeze: { start: round3(freeze.start), duration: round3(freeze.duration) }
      }
    }
  }
  return best
}

/**
 * Whether a receiver file shows the hold card for a drop and motion again
 * after it. `freezes` come from freezedetect (`{ start, duration }` in file
 * seconds); `fileStartMs` is the wall clock of the file's zero (see
 * `estimateReceiverClockOffset`). The card settles 1.3 s into the hold, so
 * the expected still interval runs from there to the resume; a freeze must
 * cover most of it, and no freeze longer than `MIN_FREEZE_SECONDS` may start
 * between the settled resume and `untilMs` (the next drop's cut, or the end).
 */
export function evaluateHoldOnReceiver({
  freezes,
  fileStartMs,
  holdMs,
  liveMs,
  endMs,
  untilMs = endMs,
  minCoverage = 0.7,
  settleAfterResumeSeconds = 2.5
}) {
  if (holdMs === null || liveMs === null) {
    return { pass: false, reason: 'the drop never reached hold or live', coverage: 0 }
  }
  const expectedStart = (holdMs - fileStartMs) / 1000 + HOLD_CARD_SETTLE_SECONDS
  const expectedEnd = (liveMs - fileStartMs) / 1000
  const expected = Math.max(0, expectedEnd - expectedStart)
  let covered = 0
  let best = null
  for (const freeze of freezes) {
    const start = Math.max(expectedStart, freeze.start)
    const end = Math.min(expectedEnd, freeze.start + freeze.duration)
    const overlap = Math.max(0, end - start)
    if (overlap > covered) {
      covered = overlap
      best = freeze
    }
  }
  const coverage = expected > 0 ? covered / expected : 0
  const resumeSettled = expectedEnd + settleAfterResumeSeconds
  const motionUntil = ((untilMs ?? endMs) - fileStartMs) / 1000
  const frozenAfterResume = freezes.filter(
    (freeze) =>
      freeze.duration >= MIN_FREEZE_SECONDS &&
      freeze.start >= resumeSettled &&
      freeze.start < motionUntil
  )
  const pass = coverage >= minCoverage && frozenAfterResume.length === 0
  return {
    pass,
    reason: pass
      ? null
      : coverage < minCoverage
        ? `the hold card covered ${Math.round(coverage * 100)}% of the ${expected.toFixed(1)} s hold window (need ${Math.round(minCoverage * 100)}%)`
        : `the picture froze again ${frozenAfterResume.length} time(s) after the resume`,
    coverage: round3(coverage),
    expectedWindowSeconds: [round3(expectedStart), round3(expectedEnd)],
    motionCheckedUntilSeconds: round3(motionUntil),
    bestFreeze: best ? { start: round3(best.start), duration: round3(best.duration) } : null,
    frozenAfterResume: frozenAfterResume.map((freeze) => ({
      start: round3(freeze.start),
      duration: round3(freeze.duration)
    }))
  }
}

/**
 * Pixel statistics of one rgb24 frame: the default hold card is #0D0D0F
 * with white "Be right back" text, so nearly every pixel is dark neutral and
 * a few are bright. The test pattern is neither.
 */
export function holdCardStats(rgb, width, height, { darkMax = 48, brightMin = 160 } = {}) {
  const pixels = width * height
  if (!rgb || rgb.length < pixels * 3 || pixels === 0) {
    return { pixels: 0, darkRatio: 0, brightRatio: 0, meanLuma: 0, isHoldCard: false }
  }
  let dark = 0
  let bright = 0
  let luma = 0
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 3
    const r = rgb[offset]
    const g = rgb[offset + 1]
    const b = rgb[offset + 2]
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (r <= darkMax && g <= darkMax && b <= darkMax) dark += 1
    else if (r >= brightMin && g >= brightMin && b >= brightMin) bright += 1
  }
  const darkRatio = dark / pixels
  const brightRatio = bright / pixels
  return {
    pixels,
    darkRatio: round3(darkRatio),
    brightRatio: round3(brightRatio),
    meanLuma: round3(luma / pixels),
    isHoldCard: darkRatio >= 0.8 && brightRatio >= 0.001 && brightRatio <= 0.2
  }
}

/**
 * How one FFmpeg publish through the feed's TLS options ended (C1c), from
 * its stderr lines at `-loglevel level+debug`:
 * - `certificate-rejected`: OpenSSL refused the certificate (chain or name);
 * - `handshake-passed`: the RTMP layer ran over the TLS connection. FFmpeg
 *   opens RTMP only after the TLS handshake, the certificate check
 *   included, succeeded, so its RTMP debug lines prove it whatever RTMP did
 *   next. The node's MediaMTX configures no catch-all path (runner C1b), so
 *   a probe's path is refused right after the RTMP connect and FFmpeg's only
 *   error is "Input/output error"; an RTMP-level refusal counts as well;
 * - `unknown`: anything else.
 */
export function classifyFeedHandshake(lines) {
  const errors = lines.filter((line) => line.includes('[error]'))
  if (errors.some((line) => line.includes('certificate verify failed'))) {
    return 'certificate-rejected'
  }
  const rtmpRan = lines.some((line) =>
    /\[rtmps @ [^\]]+\] \[debug\] (?:Handshaking\.\.\.|Server version )/.test(line)
  )
  const rtmpRefused = errors.some(
    (line) =>
      line.includes('RTMP handshake') ||
      line.includes('Server error') ||
      line.includes('End of file') ||
      line.includes('Connection reset')
  )
  return rtmpRan || rtmpRefused ? 'handshake-passed' : 'unknown'
}

/**
 * The whole run's verdict: every gate the smoke enforces, as a list of
 * failures (empty is a pass). `report` is the smoke's report object.
 */
export function evaluateCloudSoloReport(report) {
  const failures = []
  const drops = report.drops ?? []
  if (drops.length < 1) failures.push('no drop was measured')
  for (const drop of drops) {
    const label = drop.kind ?? 'drop'
    if (drop.timeToHoldSeconds === null || drop.timeToHoldSeconds === undefined) {
      failures.push(`${label}: the runner never reached hold`)
    } else if (drop.timeToHoldSeconds > MAX_TIME_TO_HOLD_SECONDS) {
      failures.push(
        `${label}: hold took ${drop.timeToHoldSeconds} s (limit ${MAX_TIME_TO_HOLD_SECONDS} s)`
      )
    }
    if (drop.timeToResumeSeconds === null || drop.timeToResumeSeconds === undefined) {
      failures.push(`${label}: the show never came back live after the resume`)
    } else if (drop.maxResumeSeconds && drop.timeToResumeSeconds > drop.maxResumeSeconds) {
      failures.push(
        `${label}: resume took ${drop.timeToResumeSeconds} s (limit ${drop.maxResumeSeconds} s)`
      )
    }
    if (drop.desktopSawHold === false) failures.push(`${label}: the desktop never showed Hold`)
    if (drop.desktopSawLive === false)
      failures.push(`${label}: the desktop never showed Live again`)
    // C5b: a Resume never hands destinations over; the runner keeps its legs.
    if (Number.isFinite(drop.destinationsSetAfterResume) && drop.destinationsSetAfterResume > 0) {
      failures.push(
        `${label}: the runner applied destinations.set ${drop.destinationsSetAfterResume} time(s) after the Resume click`
      )
    }
  }
  const receivers = report.receivers ?? []
  if (receivers.length < 2) failures.push(`expected 2 receivers, found ${receivers.length}`)
  for (const receiver of receivers) {
    const name = receiver.name ?? receiver.file ?? 'receiver'
    if (!receiver.video?.codec) failures.push(`${name}: no video stream`)
    if (!receiver.audio?.codec) failures.push(`${name}: no audio stream`)
    if (receiver.stayedConnected === false)
      failures.push(`${name}: its connection dropped during a drop`)
    if (receiver.exitedAfterStop === false) failures.push(`${name}: still connected after Stop`)
    const gap = receiver.gaps?.maxGapSeconds
    if (gap === null || gap === undefined) {
      failures.push(`${name}: too few packets to measure a gap`)
    } else if (gap > MAX_RECEIVER_GAP_SECONDS) {
      failures.push(`${name}: largest packet gap ${gap} s (limit ${MAX_RECEIVER_GAP_SECONDS} s)`)
    }
    if (
      Number.isFinite(receiver.minDurationSeconds) &&
      Number.isFinite(receiver.durationSeconds) &&
      receiver.durationSeconds < receiver.minDurationSeconds
    ) {
      failures.push(
        `${name}: ${receiver.durationSeconds} s recorded, expected at least ${receiver.minDurationSeconds} s`
      )
    }
    for (const hold of receiver.holds ?? []) {
      if (!hold.pass) failures.push(`${name} ${hold.kind}: ${hold.reason}`)
      if (hold.card && !hold.card.isHoldCard) {
        failures.push(
          `${name} ${hold.kind}: the frame inside the hold is not the hold card (dark ${hold.card.darkRatio}, bright ${hold.card.brightRatio})`
        )
      }
    }
  }
  if (report.stop) {
    if (report.stop.webEndCalled === false) failures.push('Stop never ended the show on the web')
    if (report.stop.showEndedOnNode === false)
      failures.push('the node still lists the show as live after Stop')
    if (report.stop.runnerExited === false) failures.push('the runner is still running after Stop')
    if (report.stop.recordingFinalized === false)
      failures.push('the local recording did not finalize')
  }
  if (report.platformRowsLive === false) {
    failures.push("the runner's platform leg states never reached the desktop as live")
  }
  // C1c: FFmpeg itself must prove the feed checks the node's certificate.
  if (report.tls) {
    if (report.tls.rightRoots?.outcome !== 'handshake-passed') {
      failures.push(
        `the feed with the right roots did not pass the TLS handshake (${report.tls.rightRoots?.outcome ?? 'not run'})`
      )
    }
    if (report.tls.wrongCa?.outcome !== 'certificate-rejected') {
      failures.push(
        `the feed accepted a certificate its roots did not sign (${report.tls.wrongCa?.outcome ?? 'not run'})`
      )
    }
    if (report.tls.otherName?.outcome !== 'certificate-rejected') {
      failures.push(
        `the feed accepted a certificate for another name (${report.tls.otherName?.outcome ?? 'not run'})`
      )
    }
  }
  if (Array.isArray(report.secretLeaks) && report.secretLeaks.length > 0) {
    failures.push(`a secret reached the renderer events: ${report.secretLeaks.join(', ')}`)
  }
  // C1b: every `srt` block the node sent must pass the web's own check. One
  // the web drops leaves that feed RTMPS only: the node and the web drifted.
  if (Array.isArray(report.web?.droppedSrt) && report.web.droppedSrt.length > 0) {
    failures.push(
      `the web dropped the node's srt block (${report.web.droppedSrt
        .map((dropped) => `${dropped.orientation}: ${dropped.problem}`)
        .join(', ')})`
    )
  }
  // C6b: Test cloud ran before Go Live, against the same runner, with no
  // platforms, no metering and nothing to resume.
  if (report.cloudTest) {
    const test = report.cloudTest
    if (test.ok !== true) {
      failures.push(
        `the cloud test failed (${test.reason ?? 'no reason'}: ${test.message ?? 'no detail'})`
      )
    }
    if (!Number.isFinite(test.timeToLiveMs)) {
      failures.push('the cloud test never saw the runner live')
    } else if (test.timeToLiveMs > MAX_TEST_TIME_TO_LIVE_SECONDS * 1000) {
      failures.push(
        `the cloud test took ${test.timeToLiveMs} ms to go live (limit ${MAX_TEST_TIME_TO_LIVE_SECONDS} s)`
      )
    }
    const upload = test.uploads?.[0]
    if (!upload || !Number.isFinite(upload.measuredKbps)) {
      failures.push('the cloud test measured no upload')
    }
    if (test.webCreateStatus !== 201) failures.push('the web did not see the test show created')
    // The node knows no test kind: a solo show with the short cap.
    if (test.agentKind !== 'solo' || test.agentMaxShowSeconds !== TEST_SHOW_CAP_SECONDS) {
      failures.push(
        `the web asked the node for a ${test.agentKind ?? '?'} show capped at ${test.agentMaxShowSeconds ?? '?'} s, not a solo show capped at ${TEST_SHOW_CAP_SECONDS} s`
      )
    }
    if (test.webEndStatus !== 200) failures.push('the web did not see the test show ended')
    if (test.currentDuringTest !== null) {
      failures.push('GET /api/cloud/shows/current listed the test show as current')
    }
    if (test.destinationsSet !== 0) {
      failures.push(
        `the runner applied destinations.set ${test.destinationsSet} time(s) during the test`
      )
    }
    if (test.receiversUntouched !== true) failures.push('a receiver took bytes during the test')
    if (test.desktopShowStayedOff === false) {
      failures.push("the desktop's own cloud show changed during the test")
    }
    if (test.usageMetered !== 0) {
      failures.push(`${test.usageMetered} usage report(s) of the test show were metered`)
    }
    if (test.usageIgnored === 0) {
      failures.push("the node's usage report for the test show never reached the web")
    }
  }
  // C6b: a test show nobody ends (a desktop that died mid-test) ends on the
  // runner at the web's cap after its first feed frame, and the web closes
  // it from the node's heartbeat.
  if (report.testCap) {
    const cap = report.testCap
    if (cap.agentKind !== 'solo' || cap.agentMaxShowSeconds !== TEST_SHOW_CAP_SECONDS) {
      failures.push(
        `the capped test show reached the node as a ${cap.agentKind ?? '?'} show capped at ${cap.agentMaxShowSeconds ?? '?'} s`
      )
    }
    if (cap.endReason !== 'max-show') {
      failures.push(`the unended test show ended with ${cap.endReason ?? 'nothing'}, not max-show`)
    } else if (
      !Number.isFinite(cap.liveToEndSeconds) ||
      cap.liveToEndSeconds < TEST_SHOW_CAP_SECONDS - 1 ||
      cap.liveToEndSeconds > TEST_SHOW_CAP_SECONDS + TEST_SHOW_CAP_SLACK_SECONDS
    ) {
      failures.push(
        `the unended test show ended ${cap.liveToEndSeconds} s after it went live (cap ${TEST_SHOW_CAP_SECONDS} s)`
      )
    }
    if (cap.webClosed !== true) failures.push('the web never closed the capped test show')
  }
  return failures
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}
