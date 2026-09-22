#!/usr/bin/env node
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
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { startScheduledStreamsFixture } from './lib/scheduled-streams-fixture.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const directory =
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-scheduling-${Date.now()}`)
mkdirSync(directory, { recursive: true })
const port = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 12945)
const fixture = await startScheduledStreamsFixture({ ingestUrl: `rtmp://127.0.0.1:${port}/live` })
let app, smoke, ws, listener
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const evaluate = async (code) => {
  const response = await requestSmokeCommand(smoke, 'eval-js', { code }, { timeoutMs })
  return response?.result ?? response
}
const waitFor = async (fn, label) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await wait(100)
  }
  const diagnostics = await evaluate(
    'return ({scene:window.__videorcSmokeScenePresets?.state(),streaming:window.__videorcSmokeScenePresets?.streamingState()})'
  ).catch(() => null)
  throw new Error(`Timed out waiting for ${label}; ${JSON.stringify(diagnostics)}`)
}
const openUpcoming = async () => {
  await requestSmokeCommand(smoke, 'open-tab', { tab: 'streaming' }, { timeoutMs })
  await waitFor(
    () =>
      evaluate(
        `const tab=[...document.querySelectorAll('[role="tab"]')].find(item=>item.textContent==='Upcoming'); if(tab) tab.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true})); return Boolean(tab)`
      ),
    'Upcoming tab mounted'
  )
  await waitFor(
    () =>
      evaluate(
        'return Boolean(window.__videorcSmokeScheduledStreams && !window.__videorcSmokeScheduledStreams.state().loading)'
      ),
    'Upcoming provider actions'
  )
  console.log('[scheduling] Upcoming ready')
}
const launch = async () => {
  app = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    onLine: (line) => {
      if (/error|failed|ready|Compiling|Finished/.test(line))
        console.log(line.replace(/("(?:token|capability)"\s*:\s*")[^"]*/g, '$1[redacted]'))
    },
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: directory,
      VIDEORC_SMOKE_STATE_DIR: directory,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_ENABLE_YOUTUBE_OAUTH: '1',
      VIDEORC_SCHEDULED_STREAMS_SMOKE_URL: fixture.origin
    }
  })
  smoke = app.connections['preview-motion-ready']
  ws = await connectBackend(app.connections['backend-ready'], timeoutMs)
  await openUpcoming()
}
const get = (eventId) => request(ws, timeoutMs, 'scheduledStreams.get', { eventId })
const action = async (name, eventId, fields = {}) => {
  console.log(`[scheduling] ${name}`)
  const event = await get(eventId)
  return evaluate(
    `return window.__videorcSmokeScheduledStreams.mutate(${JSON.stringify(name)}, ${JSON.stringify({ eventId, expectedRevision: event.revision, ...fields })})`
  )
}
const create = async (title, thumbnailAssetId) => {
  const id = randomUUID()
  const metadata = {
    title,
    description: `${title} description`,
    privacy: 'private',
    madeForKids: false,
    localStart: '2035-01-01T12:00',
    timeZone: 'Europe/Madrid',
    offsetChoice: null,
    thumbnailAssetId
  }
  await evaluate(
    `return window.__videorcSmokeScheduledStreams.mutate('saveDraft', ${JSON.stringify({ eventId: id, expectedRevision: 0, accountId: 'scheduled-smoke-channel', metadata })})`
  )
  return id
}
try {
  await (async () => {
    await launch()
    const thumbnails = []
    for (const [index, color] of ['red', 'blue'].entries()) {
      const file = join(directory, `thumbnail-${index}.png`)
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=1280x720`,
        '-frames:v',
        '1',
        file
      ])
      thumbnails.push(
        await requestSmokeCommand(
          smoke,
          'import-smoke-scheduled-thumbnail',
          { path: file },
          { timeoutMs }
        )
      )
    }
    // Opening the real form has no provider side effect.
    await evaluate(
      `const button=[...document.querySelectorAll('button')].find(item=>item.textContent==='Schedule stream'); button.click(); return true`
    )
    assert.equal(fixture.events.size, 0)
    await waitFor(
      () => evaluate(`return Boolean(document.querySelector('#schedule-title'))`),
      'schedule form'
    )
    await evaluate(
      `const title=document.querySelector('#schedule-title'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(title,'A detailed upcoming livestream title with a long channel name and international guests'); title.dispatchEvent(new Event('input',{bubbles:true})); return true`
    )
    await evaluate(
      `const channel=document.querySelector('#schedule-channel');channel.focus();channel.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));return true`
    )
    await waitFor(
      () => evaluate(`return Boolean(document.querySelector('[role="option"]'))`),
      'keyboard channel menu'
    )
    await evaluate(`document.querySelector('[role="option"]').click();return true`)
    for (const theme of ['dark', 'light']) {
      await evaluate(
        `if(document.documentElement.classList.contains('dark')!==${theme === 'dark'}) document.dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true})); return true`
      )
      await waitFor(
        () =>
          evaluate(
            `return document.documentElement.classList.contains('dark')===${theme === 'dark'}`
          ),
        `${theme} theme`
      )
      await evaluate(
        `await new Promise(resolve=>setTimeout(resolve,350)); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); return getComputedStyle(document.querySelector('[role="dialog"]')).backgroundColor`
      )
      console.log(
        await requestSmokeCommand(
          smoke,
          'capture-page',
          { name: `scheduled-form-${theme}` },
          { timeoutMs }
        )
      )
    }
    await requestSmokeCommand(smoke, 'set-page-zoom', { factor: 2 }, { timeoutMs })
    await evaluate(
      `await new Promise(resolve=>setTimeout(resolve,350)); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); return true`
    )
    assert.equal(
      await evaluate(
        `const dialog=document.querySelector('[role="dialog"]').getBoundingClientRect();return dialog.top>=0&&dialog.bottom<=innerHeight`
      ),
      true,
      '200% dialog must fit the CSS viewport'
    )
    console.log(
      await requestSmokeCommand(
        smoke,
        'capture-page',
        { name: 'scheduled-form-200-percent' },
        { timeoutMs }
      )
    )
    const scrolling = await evaluate(
      `const dialog=document.querySelector('[role="dialog"]');const scroller=dialog.querySelector('[data-radix-scroll-area-viewport]');const footer=dialog.querySelector('[data-slot="dialog-footer"]');const initial=scroller.scrollTop;scroller.scrollTop=scroller.scrollHeight;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const thumbnail=[...dialog.querySelectorAll('button')].find(button=>button.textContent==='Choose thumbnail');return {initial,after:scroller.scrollTop,viewportHeight:scroller.clientHeight,viewportBottom:scroller.getBoundingClientRect().bottom,footerTop:footer.getBoundingClientRect().top,thumbnailBottom:thumbnail.getBoundingClientRect().bottom}`
    )
    assert.ok(scrolling.viewportHeight >= 64, '200% form must retain a usable scroll viewport')
    assert.ok(scrolling.after > scrolling.initial, '200% form must actually scroll')
    assert.ok(
      scrolling.viewportBottom <= scrolling.footerTop,
      'scroll viewport must not overlap footer'
    )
    assert.ok(
      scrolling.thumbnailBottom <= scrolling.viewportBottom,
      'bottom thumbnail field must be reachable'
    )
    console.log('[scheduling] 200% scroll geometry', scrolling)
    console.log(
      await requestSmokeCommand(
        smoke,
        'capture-page',
        { name: 'scheduled-form-200-percent-footer' },
        { timeoutMs }
      )
    )
    await requestSmokeCommand(smoke, 'set-page-zoom', { factor: 1 }, { timeoutMs })
    await evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true`
    )
    await waitFor(
      () => evaluate(`return document.body.textContent.includes('Discard changes?')`),
      'dirty dismissal guard'
    )
    await evaluate(
      `const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='Discard');button.click();return true`
    )
    await waitFor(
      () => evaluate(`return !document.querySelector('#schedule-title')`),
      'form dismissal'
    )
    assert.equal(await evaluate(`return document.activeElement?.textContent`), 'Schedule stream')
    if (process.argv.includes('--ui-only')) {
      console.log(
        'Scheduled stream UI smoke PASS: theme, 200% viewport, scroll, keyboard, dirty-dismiss and focus restoration.'
      )
      return
    }
    const first = await create('Scheduled smoke A', thumbnails[0].id)
    fixture.controls.failThumbnail = true
    await assert.rejects(action('schedule', first))
    const partial = await get(first)
    assert.equal(partial.thumbnailState, 'error')
    assert.ok(partial.watchUrl)
    fixture.controls.failThumbnail = false
    await action('schedule', first)
    assert.equal(fixture.events.size, 1)
    const second = await create('Scheduled smoke B', thumbnails[1].id)
    await action('schedule', second)
    const remoteId = (await get(first)).providerEventId
    const watchUrl = (await get(first)).watchUrl
    assert.equal(fixture.streams.size, 0)
    assert.ok(
      [...fixture.events.values()].every(
        (event) =>
          !event.contentDetails.enableAutoStart &&
          !event.contentDetails.enableAutoStop &&
          event.thumbnailBytes > 0
      )
    )
    ws.close()
    await app.stop()
    app = null
    await launch()
    assert.equal((await get(first)).watchUrl, watchUrl)
    const originalSecond = JSON.stringify(fixture.events.get((await get(second)).providerEventId))
    const saved = await get(first)
    await action('update', first, {
      metadata: { ...saved.requested, title: 'Edited after restart' }
    })
    assert.equal(
      JSON.stringify(fixture.events.get((await get(second)).providerEventId)),
      originalSecond
    )
    // Accepted creation with a lost response requires explicit adoption, never a second POST.
    const unknown = await create('Unknown create response', null)
    fixture.controls.loseCreateResponse = true
    await assert.rejects(action('schedule', unknown))
    const count = fixture.events.size
    await assert.rejects(action('schedule', unknown))
    assert.equal(fixture.events.size, count)
    const candidate = [...fixture.events.values()].find(
      (event) => event.snippet.title === 'Unknown create response'
    )
    await action('recover', unknown, { candidateId: candidate.id })
    await action('cancel', unknown)
    await action('cancel', second)
    assert.equal((await get(second)).lifecycle, 'canceled')
    // Crossing the advertised time has no publishing/start side effect.
    await evaluate(
      `window.__scheduleOriginalNow=Date.now; Date.now=()=>new Date('2036-01-01').getTime(); return true`
    )
    await wait(600)
    assert.equal((await request(ws, timeoutMs, 'recording.status')).state, 'idle')
    assert.equal(fixture.calls.filter((call) => call.path.endsWith('/transition')).length, 0)
    await evaluate(
      `Date.now=window.__scheduleOriginalNow; delete window.__scheduleOriginalNow; return true`
    )
    // Select an OAuth destination in the actual StudioProvider and use its
    // confirmation/cancel/prepare/start/Stop flow end to end.
    console.log('[scheduling] Preparing the Studio scene')
    await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 500 }, { timeoutMs })
    await requestSmokeCommand(smoke, 'select-camera-device', { settleMs: 500 }, { timeoutMs })
    const video = { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 }
    const stamp = new Date().toISOString()
    const target = {
      id: 'youtube',
      platform: 'youtube',
      label: 'Scheduled fixture',
      enabled: true,
      authMode: 'oauth',
      accountId: 'scheduled-smoke-channel',
      accountLabel: 'Local scheduling fixture',
      scheduledEventId: first,
      scheduledEventTitle: 'Edited after restart',
      scheduledPrivacy: 'private',
      serverUrl: '',
      streamKey: '',
      streamKeyPresent: false,
      outputPreset: 'custom',
      outputBitrateKbps: 2000,
      createdAt: stamp,
      updatedAt: stamp
    }
    await evaluate(
      `window.__videorcSmokeScenePresets.configure(${JSON.stringify({ video, recordEnabled: true, streamEnabled: true, streaming: { enabled: true, mode: 'single', targets: [target], enabledTargetIds: ['youtube'], defaultOutputPreset: 'custom', defaultBitrateKbps: 2000 } })}); window.__videorcSmokeScenePresets.layout({layoutPreset:'screen-only'}); return true`
    )
    await waitFor(
      () => evaluate(`return window.__videorcSmokeScenePresets.state().canSave`),
      'confirmed synthetic scene'
    )
    await waitFor(
      () => evaluate('return window.__videorcSmokeScenePresets.streamingState().canStart'),
      'Studio ready to start'
    )
    await evaluate('await window.__videorcSmokeScenePresets.start(); return true')
    await waitFor(
      () => evaluate('return window.__videorcSmokeScenePresets.streamingState().confirmationOpen'),
      'Go Live confirmation'
    )
    await evaluate('window.__videorcSmokeScenePresets.cancelGoLive(); return true')
    assert.equal(fixture.events.get(remoteId).status.lifeCycleStatus, 'ready')
    assert.equal(fixture.streams.size, 0)
    const receivePath = join(directory, 'received.flv')
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
        `rtmp://127.0.0.1:${port}/live/scheduled-smoke`,
        '-c',
        'copy',
        '-f',
        'flv',
        receivePath
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let listenerError = ''
    listener.stderr.on('data', (bytes) => {
      const text = bytes.toString()
      listenerError += text
      if (/Input #0|Video:/.test(text))
        for (const stream of fixture.streams.values()) stream.status.streamStatus = 'active'
    })
    await wait(1000)
    assert.equal(listener.exitCode, null, listenerError)
    await evaluate('await window.__videorcSmokeScenePresets.start(); return true')
    await waitFor(
      () => evaluate('return window.__videorcSmokeScenePresets.streamingState().confirmationOpen'),
      'second Go Live confirmation'
    )
    fixture.controls.loseStreamResponse = true
    await evaluate('await window.__videorcSmokeScenePresets.confirmGoLive(); return true')
    assert.equal((await get(first)).preparation.phase, 'creating-stream')
    assert.equal(fixture.streams.size, 1)
    await evaluate('window.__videorcSmokeScenePresets.cancelGoLive();return true')
    await openUpcoming()
    const ingestCandidates = await request(ws, timeoutMs, 'scheduledStreams.candidates', {
      eventId: first
    })
    assert.equal(ingestCandidates.length, 1)
    assert.equal(ingestCandidates[0].candidateKind, 'ingest')
    assert.ok(!JSON.stringify(ingestCandidates).includes('ingestionInfo'))
    await evaluate(
      `const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='Recover');button.click();return true`
    )
    await waitFor(
      () =>
        evaluate(
          `return Boolean(document.querySelector('[aria-label="Ingest stream to recover"]'))`
        ),
      'explicit ingest recovery dialog'
    )
    await evaluate(
      `const select=document.querySelector('[aria-label="Ingest stream to recover"]');select.focus();select.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));return true`
    )
    await waitFor(
      () => evaluate(`return Boolean(document.querySelector('[role="option"]'))`),
      'compatible owned ingest candidate'
    )
    await evaluate(`document.querySelector('[role="option"]').click();return true`)
    await evaluate(
      `const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='Use selected candidate');button.click();return true`
    )
    await waitFor(async () => {
      const event = await get(first)
      return !event.preparation && event.operationState === 'idle'
    }, 'ingest recovery checkpoint')
    assert.equal((await get(first)).watchUrl, watchUrl)
    // Failure cleanup follows the production Google gate and clears this debug-only
    // account. Restore only the fixture connection, then use the real selection UI.
    await evaluate(
      `const current=window.__videorcSmokeScenePresets.streamingState().captureConfig; window.__videorcSmokeScenePresets.configure({streamEnabled:false,streaming:{...current.streaming,enabled:false,enabledTargetIds:[],targets:[${JSON.stringify({ ...target, enabled: false })}]}}); return true`
    )
    await waitFor(
      () =>
        evaluate(
          `return [...document.querySelectorAll('button')].some(button=>button.textContent==='Go Live…' && !button.disabled)`
        ),
      'recovered event selectable'
    )
    await evaluate(
      `const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='Go Live…' && !button.disabled);button.click();return true`
    )
    await waitFor(
      () =>
        evaluate(`return Boolean(document.querySelector('[aria-label="Livestream destination"]'))`),
      'saved event destination dialog'
    )
    await evaluate(
      `const select=document.querySelector('[aria-label="Livestream destination"]');select.focus();select.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));return true`
    )
    await waitFor(
      () => evaluate(`return Boolean(document.querySelector('[role="option"]'))`),
      'saved event destination option'
    )
    await evaluate(`document.querySelector('[role="option"]').click();return true`)
    await evaluate(
      `const button=[...document.querySelectorAll('button')].find(button=>button.textContent==='Use saved event');button.click();return true`
    )
    await waitFor(
      () =>
        evaluate(
          `const config=window.__videorcSmokeScenePresets.streamingState().captureConfig;return config.streamEnabled && config.streaming.enabled && config.streaming.targets.some(target=>target.enabled && target.scheduledEventId===${JSON.stringify(first)})`
        ),
      'saved selection enabled streaming and target'
    )
    await waitFor(
      () => evaluate('return window.__videorcSmokeScenePresets.streamingState().canStart'),
      'recovered Studio output path ready'
    )
    await evaluate('await window.__videorcSmokeScenePresets.start();return true')
    await waitFor(
      () => evaluate('return window.__videorcSmokeScenePresets.streamingState().confirmationOpen'),
      'recovered Go Live confirmation'
    )
    await evaluate('await window.__videorcSmokeScenePresets.confirmGoLive(); return true')
    await waitFor(
      async () => fixture.events.get(remoteId).status.lifeCycleStatus === 'live',
      'same scheduled event live'
    )
    const started = await request(ws, timeoutMs, 'recording.status')
    assert.equal(fixture.streams.size, 1)
    await wait(3000)
    await evaluate('await window.__videorcSmokeScenePresets.stop(); return true')
    await waitFor(
      async () => (await get(first)).lifecycle === 'completed',
      'provider-confirmed completion'
    )
    const stopped = await request(ws, timeoutMs, 'recording.status')
    assert.equal(fixture.events.get(remoteId).status.lifeCycleStatus, 'complete')
    const path = await resolveFinalRecordingPath({ started, stopped, timeoutMs })
    await waitFor(async () => listener.exitCode !== null, 'RTMP receiver finalization')
    for (const artifact of [path, receivePath]) {
      const report = await analyzeRecording(artifact, {
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        intendedFps: 30,
        expectAudio: false,
        gates: { requireMotion: false, avSyncTargetMs: Infinity, avSyncHardFailMs: Infinity }
      })
      assert.ok(report.verdict.pass, report.verdict.failures.join('; '))
      console.log(`Scheduled stream artifact: ${writeReports(report).mdPath}`)
    }
    assert.equal(
      fixture.calls.filter(
        (call) => call.method === 'POST' && call.path === '/youtube/v3/liveBroadcasts'
      ).length,
      3
    )
    assert.deepEqual(
      fixture.calls.filter((call) => call.path.endsWith('/transition')).map((call) => call.id),
      [remoteId, remoteId]
    )
    console.log(
      'Scheduled streams smoke PASS: durable events, thumbnails, restart, recovery, cancellation, manual exact-ID start and final media artifacts.'
    )
  })()
} finally {
  ws?.close()
  if (listener && listener.exitCode === null) {
    listener.kill('SIGTERM')
    await wait(1000)
    if (listener.exitCode === null) {
      listener.kill('SIGKILL')
      await new Promise((resolve) => listener.once('exit', resolve))
    }
  }
  await app?.stop()
  await fixture.close()
}
