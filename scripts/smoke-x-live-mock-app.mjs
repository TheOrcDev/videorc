#!/usr/bin/env node
// smoke:x-live-mock — X Live against a loopback fake X, through the real
// renderer and backend (0.38.0 headline features, #1786 and #1788):
//   1. Stream details lists X's live categories, in X's order, and saves a pick.
//   2. Go Live (instant) shows the category in the confirmation and sends it
//      as `live_category_id`.
//   3. Live on X: the page changes the title and category while live
//      (`PUT /2/broadcasts/:id`) and shows X's answer; an empty title is refused.
//   4. A scheduled X show gets the saved category once it is live.
// Every X call goes to the fixture: the debug backend routes the fixture
// account there, and VIDEORC_X_LIVESTREAM_API_BASE_URL points the default X
// base at it too. It never reaches x.com and never uses a real X token.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { startScheduledStreamsFixture } from './lib/scheduled-streams-fixture.mjs'

const X_ACCOUNT = 'scheduled-smoke-x'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const directory =
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-x-live-mock-${Date.now()}`)
mkdirSync(directory, { recursive: true })
const port = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 12946)
const fixture = await startScheduledStreamsFixture({ ingestUrl: `rtmp://127.0.0.1:${port}/live` })
let app, smoke, ws, listener
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const log = (line) => console.log(`[x-live-mock] ${line}`)
const evaluate = async (code) => {
  const response = await requestSmokeCommand(smoke, 'eval-js', { code }, { timeoutMs })
  return response?.result ?? response
}
const waitFor = async (fn, label, deadlineMs = timeoutMs) => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await wait(150)
  }
  const diagnostics = await evaluate(
    'return ({streaming:window.__videorcSmokeScenePresets?.streamingState?.()})'
  ).catch(() => null)
  throw new Error(`Timed out waiting for ${label}; ${JSON.stringify(diagnostics)?.slice(0, 2000)}`)
}
const capture = async (name) =>
  log(
    `screenshot ${JSON.stringify(await requestSmokeCommand(smoke, 'capture-page', { name }, { timeoutMs }))}`
  )
const xCalls = (method, pathPattern) =>
  fixture.calls.filter((call) => call.method === method && pathPattern.test(call.path))
// A Base UI Select opened from the keyboard, as a person would.
const pickOption = async (triggerSelector, optionText) => {
  await evaluate(
    `const trigger=document.querySelector(${JSON.stringify(triggerSelector)}); trigger.scrollIntoView({block:'center'}); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); return true`
  )
  await waitFor(
    () => evaluate(`return document.querySelectorAll('[role="option"]').length > 0`),
    `${triggerSelector} options`,
    15000
  )
  const options = await evaluate(
    `return [...document.querySelectorAll('[role="option"]')].map(option=>option.textContent.trim())`
  )
  await evaluate(
    `const option=[...document.querySelectorAll('[role="option"]')].find(item=>item.textContent.trim()===${JSON.stringify(optionText)}); option.click(); return true`
  )
  await waitFor(
    () => evaluate(`return document.querySelectorAll('[role="option"]').length === 0`),
    `${triggerSelector} closed`,
    15000
  )
  return options
}
const setInput = (selector, value) =>
  evaluate(
    `const input=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true`
  )
const clickButton = (text) =>
  evaluate(
    `const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)} && !item.disabled); if(!button) return false; button.click(); return true`
  )
// Destinations › Setup holds Stream details and Live on X.
const openSetup = async () => {
  await requestSmokeCommand(smoke, 'open-tab', { tab: 'streaming' }, { timeoutMs })
  await waitFor(
    () =>
      evaluate(
        `const tab=[...document.querySelectorAll('[role="tab"]')].find(item=>item.textContent.trim()==='Setup'); if(tab && tab.getAttribute('aria-selected')!=='true') tab.click(); return Boolean(tab && tab.getAttribute('aria-selected')==='true')`
      ),
    'Destinations › Setup'
  )
}
const startListener = (receivePath) => {
  listener = spawn(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'info',
      '-listen',
      '1',
      '-i',
      `rtmp://127.0.0.1:${port}/live/scheduled-smoke-x`,
      '-c',
      'copy',
      '-f',
      'flv',
      receivePath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  listener.stderr.on('data', (bytes) => {
    if (/Input #0|Video:/.test(bytes.toString())) fixture.controls.xSourceActive = true
  })
}
const analyze = async (artifact, label) => {
  const report = await analyzeRecording(artifact, {
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    intendedFps: 30,
    expectAudio: false,
    gates: { requireMotion: false, avSyncTargetMs: Infinity, avSyncHardFailMs: Infinity }
  })
  assert.ok(report.verdict.pass, `${label}: ${report.verdict.failures.join('; ')}`)
  log(`${label} artifact: ${writeReports(report).mdPath}`)
}
const video = { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 }
const xTarget = (fields = {}) => {
  const stamp = new Date().toISOString()
  return {
    id: 'x',
    platform: 'x',
    label: 'X fixture',
    enabled: true,
    authMode: 'oauth',
    accountId: X_ACCOUNT,
    accountLabel: 'Local X scheduling fixture',
    serverUrl: '',
    streamKey: '',
    streamKeyPresent: false,
    outputPreset: 'custom',
    outputBitrateKbps: 2000,
    createdAt: stamp,
    updatedAt: stamp,
    ...fields
  }
}
const configureX = (target) =>
  evaluate(
    `window.__videorcSmokeScenePresets.configure(${JSON.stringify({ video, recordEnabled: false, streamEnabled: true, streaming: { enabled: true, mode: 'single', targets: [target], enabledTargetIds: ['x'], defaultOutputPreset: 'custom', defaultBitrateKbps: 2000 } })}); return true`
  )
const goLive = async (label) => {
  await waitFor(
    () => evaluate('return window.__videorcSmokeScenePresets.streamingState().canStart'),
    `${label}: Studio ready to start`
  )
  await evaluate('await window.__videorcSmokeScenePresets.start(); return true')
  await waitFor(
    () => evaluate('return window.__videorcSmokeScenePresets.streamingState().confirmationOpen'),
    `${label}: Go Live confirmation`
  )
}
const stopAndDrain = async (label) => {
  await evaluate('await window.__videorcSmokeScenePresets.stop(); return true')
  await waitFor(async () => {
    const status = await request(ws, timeoutMs, 'recording.status')
    return status.state === 'idle' || status.replayOnly === true
  }, `${label}: session stopped`)
  await waitFor(async () => listener.exitCode !== null, `${label}: RTMP receiver finalized`)
  fixture.controls.xSourceActive = false
}

try {
  app = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    onLine: (line) => {
      if (/error|failed|ready|Compiling|Finished|x-broadcast|x-live/i.test(line))
        console.log(line.replace(/("(?:token|capability)"\s*:\s*")[^"]*/g, '$1[redacted]'))
    },
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: directory,
      VIDEORC_SMOKE_STATE_DIR: directory,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      // The debug backend seeds the X (and YouTube) fixture accounts and
      // routes them here; the YouTube values are never real either.
      VIDEORC_SCHEDULED_STREAMS_SMOKE_URL: fixture.origin,
      VIDEORC_YOUTUBE_CLIENT_ID: 'x-live-mock-client-id',
      VIDEORC_YOUTUBE_CLIENT_SECRET: 'x-live-mock-client-secret',
      VIDEORC_YOUTUBE_API_BASE_URL: fixture.origin,
      // Belt and braces: the default X base is the fixture as well, so a path
      // that does not take the fixture account (the broadcast state watch)
      // still never reaches x.com.
      VIDEORC_X_LIVESTREAM_API_BASE_URL: fixture.origin,
      // No inherited real X token may claim the env credential path.
      VIDEORC_X_OAUTH1_ACCESS_TOKEN: '',
      VIDEORC_X_OAUTH1_ACCESS_TOKEN_SECRET: '',
      X_ACCESS_TOKEN: '',
      X_ACCESS_TOKEN_SECRET: ''
    }
  })
  smoke = app.connections['preview-motion-ready']
  ws = await connectBackend(app.connections['backend-ready'], timeoutMs)
  await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 500 }, { timeoutMs })
  await evaluate(
    `window.__videorcSmokeScenePresets.layout({layoutPreset:'screen-only'}); return true`
  )
  await configureX(xTarget())
  await openSetup()

  // 1. Stream details: X's categories, in X's order, and a saved pick.
  log('Stream details category')
  await waitFor(
    () =>
      evaluate(
        `return Boolean(document.querySelector('#x-category')) || [...document.querySelectorAll('[data-slot="accordion-trigger"]')].some(item=>/^X\\b/.test(item.textContent.trim()))`
      ),
    'X row in Stream details'
  )
  if (!(await evaluate(`return Boolean(document.querySelector('#x-category'))`))) {
    await evaluate(
      `const trigger=[...document.querySelectorAll('[data-slot="accordion-trigger"]')].find(item=>/^X\\b/.test(item.textContent.trim())); trigger.scrollIntoView({block:'center'}); trigger.click(); return true`
    )
  }
  await waitFor(
    () =>
      evaluate(
        `const trigger=document.querySelector('#x-category'); return Boolean(trigger && !trigger.disabled && trigger.getAttribute('data-disabled')===null)`
      ),
    'X category picker enabled (categories read)'
  )
  assert.ok(
    xCalls('GET', /^\/2\/broadcasts\/categories$/).length >= 1,
    'the picker read GET /2/broadcasts/categories'
  )
  const listed = await pickOption('#x-category', 'Just Chatting')
  assert.deepEqual(
    listed.filter((name) => name !== 'No category'),
    ['Gaming', 'Just Chatting', 'Science & Technology'],
    "the picker lists X's categories in X's order"
  )
  await capture('x-live-mock-stream-details-category')
  assert.ok(
    await evaluate(
      `const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()==='Save' && !item.disabled && (item.closest('section')?.textContent??'').includes('Stream details')); if(!button) return false; button.click(); return true`
    ),
    'Stream details Save'
  )
  await waitFor(async () => {
    const draft = await request(ws, timeoutMs, 'streamTargets.metadata.get', {})
    const x = (draft?.targetOverrides ?? draft?.draft?.targetOverrides ?? []).find(
      (override) => override.platform === 'x'
    )
    return x?.xCategoryId === 'just-chatting'
  }, 'Stream details saved the X category')
  log('category saved: just-chatting')

  // 2. Instant Go Live carries the category.
  log('instant Go Live')
  const instantReceive = join(directory, 'received-x-instant.flv')
  startListener(instantReceive)
  await wait(1000)
  assert.equal(listener.exitCode, null, 'RTMP receiver listening')
  await goLive('instant')
  log(
    `confirmation names the category: ${await evaluate(`return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(dialog=>dialog.textContent.includes('Just Chatting'))`)}`
  )
  await capture('x-live-mock-go-live-confirmation')
  await evaluate('await window.__videorcSmokeScenePresets.confirmGoLive(); return true')
  await waitFor(async () => fixture.xBroadcasts.size === 1, 'instant X broadcast created')
  const [created] = xCalls('POST', /^\/2\/broadcasts$/)
  assert.equal(created.body.live_category_id, 'just-chatting', 'Go Live sent the category')
  assert.equal(
    xCalls('POST', /^\/2\/broadcasts\/scheduled$/).length,
    0,
    'instant Go Live created no schedule'
  )
  const [broadcastId] = fixture.xBroadcasts.keys()
  log(`live on the fixture as ${broadcastId}: ${JSON.stringify(created.body)}`)

  // 3. Live on X: change the title and category while live.
  log('live edit')
  await openSetup()
  await waitFor(
    () => evaluate(`return Boolean(document.querySelector('#x-live-title'))`),
    'Live on X section'
  )
  await capture('x-live-mock-live-edit-before')
  await setInput('#x-live-title', '')
  await waitFor(
    () => evaluate(`return document.body.textContent.includes('X needs a title.')`),
    'empty title refused'
  )
  assert.equal(await clickButton('Update X'), false, 'Update X is disabled on an empty title')
  await setInput('#x-live-title', 'Renamed while live on X')
  await pickOption('#x-live-category', 'Gaming')
  const putsBefore = xCalls('PUT', /^\/2\/broadcasts\/[^/]+$/).length
  assert.ok(await clickButton('Update X'), 'Update X pressed')
  await waitFor(
    async () => xCalls('PUT', /^\/2\/broadcasts\/[^/]+$/).length > putsBefore,
    'PUT /2/broadcasts/:id'
  )
  const update = xCalls('PUT', /^\/2\/broadcasts\/[^/]+$/).at(-1)
  assert.equal(update.path, `/2/broadcasts/${broadcastId}`)
  assert.deepEqual(update.body, { title: 'Renamed while live on X', live_category_id: 'gaming' })
  assert.equal(fixture.xBroadcasts.get(broadcastId).title, 'Renamed while live on X')
  assert.equal(fixture.xBroadcasts.get(broadcastId).live_category_id, 'gaming')
  await waitFor(
    () =>
      evaluate(
        `const status=[...document.querySelectorAll('[role="status"]')].map(item=>item.textContent).join(' '); return status.includes('Renamed while live on X') && status.includes('Gaming')`
      ),
    "the page shows X's answer"
  )
  await capture('x-live-mock-live-edit-after')
  await wait(1500)
  await stopAndDrain('instant')
  await waitFor(
    async () => fixture.xBroadcasts.get(broadcastId).state === 'ENDED',
    'instant broadcast ENDED on the fixture'
  )
  await analyze(instantReceive, 'instant X RTMP')

  // 4. A scheduled X show gets the saved category once live.
  log('scheduled show')
  await requestSmokeCommand(smoke, 'open-tab', { tab: 'streaming' }, { timeoutMs })
  await waitFor(
    () =>
      evaluate(
        `const tab=[...document.querySelectorAll('[role="tab"]')].find(item=>item.textContent==='Upcoming'); if(tab) tab.click(); return Boolean(window.__videorcSmokeScheduledStreams && !window.__videorcSmokeScheduledStreams.state().loading)`
      ),
    'Upcoming provider actions'
  )
  const thumbnail = join(directory, 'thumbnail.png')
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=1280x720',
    '-frames:v',
    '1',
    thumbnail
  ])
  const asset = await requestSmokeCommand(
    smoke,
    'import-smoke-scheduled-thumbnail',
    { path: thumbnail },
    { timeoutMs }
  )
  const eventId = randomUUID()
  await evaluate(
    `return window.__videorcSmokeScheduledStreams.mutate('saveDraft', ${JSON.stringify({
      eventId,
      expectedRevision: 0,
      provider: 'x',
      accountId: X_ACCOUNT,
      metadata: {
        title: 'Scheduled X show with a category',
        description: 'X description',
        privacy: 'private',
        madeForKids: false,
        localStart: '2035-01-01T12:00',
        timeZone: 'Europe/Madrid',
        offsetChoice: null,
        thumbnailAssetId: asset.id,
        plannedEndLocal: '2035-01-01T13:00',
        availableForReplay: false
      }
    })})`
  )
  const saved = await request(ws, timeoutMs, 'scheduledStreams.get', { eventId })
  await evaluate(
    `return window.__videorcSmokeScheduledStreams.mutate('schedule', ${JSON.stringify({ eventId, expectedRevision: saved.revision })})`
  )
  const scheduled = await request(ws, timeoutMs, 'scheduledStreams.get', { eventId })
  assert.equal(scheduled.lifecycle, 'scheduled')
  const scheduleId = scheduled.providerEventId
  await configureX(
    xTarget({ scheduledEventId: eventId, scheduledEventTitle: 'Scheduled X show with a category' })
  )
  const scheduledReceive = join(directory, 'received-x-scheduled.flv')
  startListener(scheduledReceive)
  await wait(1000)
  await goLive('scheduled')
  await evaluate('await window.__videorcSmokeScenePresets.confirmGoLive(); return true')
  await waitFor(
    async () => fixture.xSchedules.get(scheduleId)?.state === 'Running',
    'scheduled X broadcast live'
  )
  await waitFor(
    async () =>
      xCalls('PUT', /^\/2\/broadcasts\/[^/]+$/).some(
        (call) => call.path === `/2/broadcasts/${scheduleId}`
      ),
    'the saved category attached to the scheduled broadcast'
  )
  const attach = xCalls('PUT', /^\/2\/broadcasts\/[^/]+$/).find(
    (call) => call.path === `/2/broadcasts/${scheduleId}`
  )
  assert.deepEqual(attach.body, { live_category_id: 'just-chatting' })
  await wait(1500)
  await stopAndDrain('scheduled')
  await waitFor(
    async () =>
      (await request(ws, timeoutMs, 'scheduledStreams.get', { eventId })).lifecycle === 'completed',
    'scheduled X show completed'
  )
  await analyze(scheduledReceive, 'scheduled X RTMP')

  const xPaths = [
    ...new Set(
      fixture.calls
        .filter((call) => call.path.startsWith('/2/'))
        .map((call) => `${call.method} ${call.path.replace(/\d{6,}|xlive\d+|xsched\d+/g, ':id')}`)
    )
  ].sort()
  log(`X routes the fixture answered: ${xPaths.join(', ')}`)
  console.log(
    'X live mock smoke PASS: categories in Stream details, the category on Go Live, a live title and category update, and the category on a scheduled show, all against the loopback fake X.'
  )
} finally {
  ws?.close()
  if (listener && listener.exitCode === null) {
    listener.kill('SIGTERM')
    await wait(1000)
    if (listener.exitCode === null) listener.kill('SIGKILL')
  }
  await app?.stop()
  await fixture.close()
}
