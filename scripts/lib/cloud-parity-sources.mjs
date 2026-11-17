/** Plan 249 S14 maintained real-page acceptance (`--case sources`). Heavy: never
 * imported by lightweight tests. Runs inside the S12 scenes harness (local
 * LiveKit, real program pages: H stream, H recording, V stream; real guests).
 * The capturer is a fake that paints one colour per capturer id the Studio
 * asked the room to share, so the program's screen box names the source the
 * scene chose. Rules and verdict: cloud-parity-sources-contract.mjs. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { waitFor } from './cloud-managed-smoke.mjs'
import { SCENE_CANVAS, layoutOf, savedScene } from './cloud-parity-scenes-contract.mjs'
import { canvasFrame, observeTiles } from './cloud-parity-scenes.mjs'
import {
  SOURCES_TIMING,
  SOURCE_FIXTURE,
  analyzeSources,
  classifySource,
  ringMotion,
  ringPoints,
  ringShowsBackground,
  sourcesScenes
} from './cloud-parity-sources-contract.mjs'

const hook = (h, body) => h.eval(`const s = window.__videorcSmokeScenePresets; ${body}`)
const sceneState = (h) => hook(h, 'return s.roomScenes()')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The capturer: the colour of the source the Studio asked for; a gone window throws. */
async function installCapturer(h) {
  const { width, height, sources, refused } = SOURCE_FIXTURE
  await h.eval(`
    navigator.mediaDevices.getDisplayMedia = async () => {
      const id = window.__videorcSmokeScenePresets.roomScreenWanted() ?? 'window:4101:0';
      if (id === ${JSON.stringify(refused)}) throw new DOMException('The window has gone.', 'NotFoundError');
      const colour = ${JSON.stringify(sources)}[id] ?? [250, 250, 0];
      const canvas = document.createElement('canvas'); canvas.width = ${width}; canvas.height = ${height};
      const c = canvas.getContext('2d');
      const draw = () => { c.fillStyle = 'rgb(' + colour.join(',') + ')'; c.fillRect(0, 0, ${width}, ${height}); };
      draw(); const timer = setInterval(draw, 33);
      const track = canvas.captureStream(30).getVideoTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      return new MediaStream([track]);
    };
    await window.__videorcSmokeScenePresets.screenPrivacyCommand('show');
    await window.__videorcSmokeScenePresets.roomScreenShare();
  `)
}

/** What a lane's screen box shows now (centre pixel), classified. */
async function screenOn(h, page, canvas, output, label) {
  const tiles = await observeTiles(page)
  const screen = tiles.find((t) => t.role === 'screen')
  if (!screen) return null
  const shot = join(output, `sources-${label}.png`)
  await page.screenshot({ path: shot })
  const pixel = canvasFrame(h, shot, canvas)
  const { x, y, w, h: height } = screen.clip ?? screen.rect
  return classifySource(pixel(x + w / 2, y + height / 2))
}

export async function exerciseSources({ h, report, clients, newPage, programUrl, output }) {
  const host = `host:${h.showId}`
  const program = clients.find((c) => c.name === 'program').page
  const lanePage = async (name, identity, params) => {
    const page = await newPage(name)
    const url = new URL(programUrl)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    url.searchParams.set('token', h.web.tokenFor(h.showId, identity, 'recorder'))
    await page.goto(url.toString())
    return page
  }
  const recording = await lanePage('sources-recording', 'EG_parity_avatar_recording', {
    rec: '1'
  })
  const lanes = [
    ['h-stream', program],
    ['h-recording', recording]
  ]
  report.sources = {
    status: 'running',
    steps: [],
    backgrounds: [],
    frostLeaks: [],
    switchMs: [],
    productionQualified: false
  }
  const steps = report.sources.steps
  const scenes = sourcesScenes(layoutOf, savedScene)
  for (const scene of Object.values(scenes))
    await hook(h, `s.roomSceneSave(${JSON.stringify(scene)})`)
  await hook(h, 's.roomScenes(true)')
  await h.rpc('cloud.stage.set', { layout: 'side-by-side', onStage: [host], screen: host })
  await installCapturer(h)

  const applied = async (label, before) =>
    waitFor(async () => {
      const state = await sceneState(h)
      return state.status?.state === 'applied' && state.status.generation > before
    }, `${label}: every lane rendered the revision`)
  const generation = async () => (await sceneState(h)).status?.generation ?? 0
  const expectSource = async (label, id) => {
    for (const [lane, page] of lanes)
      await waitFor(
        async () => (await screenOn(h, page, SCENE_CANVAS.h, output, `${label}-${lane}`)) === id,
        `${label}: ${lane} screen box shows ${id}`
      )
  }
  const follow = async (label, scene, id, how = 'apply') => {
    const started = Date.now()
    const before = await generation()
    await hook(
      h,
      how === 'follow'
        ? `await s.roomFollowApply(${JSON.stringify(scene.id)})`
        : `await s.apply(${JSON.stringify(scene.id)})`
    )
    await applied(label, before)
    assert.equal(await hook(h, 'return s.roomScreenSource()'), id, `${label}: room shares ${id}`)
    await expectSource(label, id)
    report.sources.switchMs.push(Date.now() - started)
    assert.ok(Date.now() - started <= SOURCES_TIMING.switchMs + 5000, `${label}: switch time`)
    steps.push(label)
  }

  // Source follow: a scene's window, another window, a gone window, a Follow display.
  await follow('follow:window-a', scenes.windowA, 'window:4101:0')
  await follow('follow:window-b', scenes.windowB, 'window:4102:0')
  {
    const before = await generation()
    await hook(h, `await s.apply(${JSON.stringify(scenes.refused.id)})`)
    await pause(1500)
    assert.equal(await generation(), before, 'a refused source commits nothing')
    assert.equal(await hook(h, 'return s.roomScreenSource()'), 'window:4102:0')
    await expectSource('follow-refused', 'window:4102:0')
    steps.push('follow:refused-keeps-share')
  }
  await follow('follow:front-app-display', scenes.display, 'screen:4103:0', 'follow')

  // Hidden span: a switch while hidden shows frost, never the new source.
  await hook(h, "await s.screenPrivacyCommand('hide')")
  await expectSource('hidden-before', 'frost')
  {
    const before = await generation()
    const switching = hook(h, `await s.apply(${JSON.stringify(scenes.windowA.id)})`)
    for (let i = 0; i < 8; i++) {
      for (const [lane, page] of lanes) {
        const seen = await screenOn(h, page, SCENE_CANVAS.h, output, `hidden-${i}-${lane}`)
        if (seen && seen !== 'frost' && seen !== 'ground') report.sources.frostLeaks.push(seen)
      }
      await pause(250)
    }
    await switching
    await applied('hidden:switch', before)
    await expectSource('hidden-after', 'frost')
    steps.push('hidden:switch-stays-frosted')
  }
  await hook(h, "await s.screenPrivacyCommand('show')")
  await expectSource('hidden-show', 'window:4101:0')
  steps.push('hidden:show-reveals-new-source')

  // Backgrounds, key off and on: what each lane drew, its margin ring, its motion.
  const margin = 20 / 200
  for (const [step, scene, expect] of [
    ['background:picture:key-off', scenes.pictureKeyOff, 'picture'],
    ['background:picture:key-on', scenes.pictureKeyOn, 'picture'],
    ['background:live:key-off', scenes.liveKeyOff, 'shader'],
    ['background:live:key-on', scenes.liveKeyOn, 'shader']
  ]) {
    const before = await generation()
    await hook(h, `await s.apply(${JSON.stringify(scene.id)})`)
    await applied(step, before)
    let status = null
    await waitFor(async () => {
      status = (await sceneState(h)).status?.background ?? null
      const drawn = Object.values(status?.drawn ?? {})
      return (
        status?.unsupported === 0 &&
        drawn.length >= lanes.length &&
        drawn.every((d) => d.key === status.wanted.h)
      )
    }, `${step}: every lane reports the background`)
    const drawnByLane = Object.values(status.drawn)
    for (const [index, [lane, page]] of lanes.entries()) {
      const sample = async (suffix) => {
        const shot = join(output, `sources-${step.replaceAll(':', '-')}-${lane}-${suffix}.png`)
        await page.screenshot({ path: shot })
        const pixel = canvasFrame(h, shot, SCENE_CANVAS.h)
        return ringPoints(SCENE_CANVAS.h, margin).map(([x, y]) => pixel(x, y))
      }
      const first = await sample('a')
      await pause(SOURCES_TIMING.motionGapMs)
      const second = await sample('b')
      report.sources.backgrounds.push({
        step,
        lane,
        expect,
        drawn: drawnByLane[index] ?? null,
        ring: ringShowsBackground(first),
        motion: ringMotion(first, second)
      })
    }
    steps.push(step)
  }
  await hook(h, 's.roomSceneClear()')
  for (const [lane, page] of lanes)
    await waitFor(
      async () => page.evaluate(() => document.querySelector('#talk .background')?.hidden === true),
      `background:clear: ${lane} hides the background layer`
    )
  steps.push('background:clear')

  const verdict = analyzeSources(report.sources)
  Object.assign(report.sources, verdict)
  assert.equal(verdict.status, 'passed', verdict.failures.join('; '))
}
