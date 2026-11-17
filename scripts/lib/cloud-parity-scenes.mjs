/** Plan 249 S12 maintained real-page acceptance (`--case scenes`). Heavy: never
 * imported by lightweight tests. Local LiveKit, real program pages (H stream,
 * H recording, V stream) and real guests; no managed egress, devices or paid
 * calls. Applies scenes by the user's routes (preset choice, saved scene by id)
 * and judges what the pages draw against the shared plan, plus decoded pixels. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { waitFor, runMedia } from './cloud-managed-smoke.mjs'
import {
  SCENE_CANVAS,
  SCENE_TIMING,
  SCREEN_FIXTURE,
  SCENE_CONTROL_CASES,
  compareSceneTiles,
  cornerOf,
  expectedCorner,
  guestsKept,
  judgeGlide,
  p95,
  sceneCaseMatrix,
  sceneRoster,
  screenCornerPoints
} from './cloud-parity-scenes-contract.mjs'

const hook = (h, body) => h.eval(`const s = window.__videorcSmokeScenePresets; ${body}`)
const sceneState = (h) => hook(h, 'return s.roomScenes()')

/** Same plan as the page (Node strips the shared module's types). */
async function shared(desktopRoot) {
  return import(join(desktopRoot, 'apps/desktop/src/shared/cloud-scene.ts'))
}

/** The host's room screen: four pure corner markers on a dark field. */
export async function shareFixtureScreen(h) {
  const { width, height, marker, ground, corners } = SCREEN_FIXTURE
  await h.eval(`
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = ${width}; canvas.height = ${height};
      const c = canvas.getContext('2d');
      const rgb = (v) => 'rgb(' + v.join(',') + ')';
      const draw = () => {
        c.fillStyle = rgb(${JSON.stringify(ground)}); c.fillRect(0, 0, ${width}, ${height});
        const m = ${marker}, k = ${JSON.stringify(corners)};
        c.fillStyle = rgb(k.tl); c.fillRect(0, 0, m, m);
        c.fillStyle = rgb(k.tr); c.fillRect(${width} - m, 0, m, m);
        c.fillStyle = rgb(k.br); c.fillRect(${width} - m, ${height} - m, m, m);
        c.fillStyle = rgb(k.bl); c.fillRect(0, ${height} - m, m, m);
      };
      draw(); const timer = setInterval(draw, 33);
      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    };
    await window.__videorcSmokeScenePresets.screenPrivacyCommand('show');
    await window.__videorcSmokeScenePresets.roomScreenShare();
  `)
}

/** Scene tiles as the page drew them, in canvas pixels, plus each picture clip. */
/** The desktop Program preview's scene tiles, as percent of its frame. */
const observePreview = (h) =>
  h.eval(`return [...document.querySelectorAll(
    '[data-testid="show-stage-program"] [data-testid="show-stage-tile"]'
  )].map((tile) => ({
    role: tile.dataset.sceneRole ?? null,
    identity: tile.dataset.stageIdentity,
    shape: tile.dataset.stageShape,
    left: Number.parseFloat(tile.style.left),
    top: Number.parseFloat(tile.style.top),
    width: Number.parseFloat(tile.style.width),
    height: Number.parseFloat(tile.style.height)
  }))`)

/** The preview draws the same shared plan as the program page (horizontal lane). */
function previewMatches(expected, preview, canvas = SCENE_CANVAS.h) {
  if (preview.length !== expected.length) return false
  return expected.every((tile) => {
    const seen = preview.find((p) => p.role === tile.role)
    return (
      seen &&
      seen.identity === tile.identity &&
      Math.abs(seen.left - (tile.rect.x / canvas.width) * 100) < 0.1 &&
      Math.abs(seen.top - (tile.rect.y / canvas.height) * 100) < 0.1 &&
      Math.abs(seen.width - (tile.rect.w / canvas.width) * 100) < 0.1 &&
      Math.abs(seen.height - (tile.rect.h / canvas.height) * 100) < 0.1
    )
  })
}

export const observeTiles = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.scenes .scene.current .tile')].map((tile) => {
      const px = (v) => Math.round(Number.parseFloat(v || '0'))
      const clip = tile.querySelector('.tile-scene-clip')
      return {
        role: tile.dataset.role ?? null,
        identity: tile.dataset.identity,
        scene: tile.classList.contains('tile-scene'),
        rect: {
          x: px(tile.style.left),
          y: px(tile.style.top),
          w: px(tile.style.width),
          h: px(tile.style.height)
        },
        shape: tile.dataset.shape ?? null,
        clip: clip
          ? {
              x: px(tile.style.left) + px(clip.style.left),
              y: px(tile.style.top) + px(clip.style.top),
              w: px(clip.style.width),
              h: px(clip.style.height),
              mirrored: clip.style.transform.includes('scaleX(-1)')
            }
          : null
      }
    })
  )

/** One decoded full-page frame at canvas size, for pixel reads. */
export function canvasFrame(h, path, canvas) {
  const raw = runMedia(h.ffmpeg, [
    '-v',
    'error',
    '-i',
    path,
    '-vf',
    `scale=${canvas.width}:${canvas.height}:flags=neighbor`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1'
  ])
  assert.equal(raw.length, canvas.width * canvas.height * 3, 'decoded frame size')
  return (x, y) => {
    const at = (Math.round(y) * canvas.width + Math.round(x)) * 3
    return [raw[at], raw[at + 1], raw[at + 2]]
  }
}

export async function prepareScenes({ h, report }) {
  assert.equal((await sceneState(h)).enabled, false, 'Room scenes must start off')
  // Off: a preset choice in the room changes nothing and says why.
  await hook(h, "await s.roomScenePreset('side-by-side')")
  assert.equal((await sceneState(h)).status?.generation ?? 0, 0, 'off sends no scene')
  report.scenes = {
    status: 'running',
    offByDefault: true,
    cases: [],
    applyMs: [],
    managed: 'not-run',
    devices: 'not-run',
    productionQualified: false
  }
}

export async function exerciseScenes({
  h,
  report,
  clients,
  newPage,
  programUrl,
  output,
  desktopRoot,
  guestIds
}) {
  const S = await shared(desktopRoot)
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
  const recording = await lanePage('scenes-recording', 'EG_parity_avatar_recording', { rec: '1' })
  const vertical = await lanePage('scenes-vertical', 'EG_parity_graphics_v', { layout: 'v' })
  const lanes = { h: [program, recording], v: [vertical] }

  // A scene showing a screen is refused, untouched, until the screen is in the room.
  await hook(h, 's.roomScenes(true)')
  const before = (await sceneState(h)).status?.generation ?? 0
  await hook(h, "await s.roomScenePreset('screen-only')")
  assert.equal((await sceneState(h)).status?.generation ?? 0, before, 'refused scene not committed')
  report.scenes.cases.push('refused-without-screen')
  await shareFixtureScreen(h)

  const stageWith = async (guests) => {
    await h.rpc('cloud.stage.set', {
      layout: 'side-by-side',
      onStage: [host, ...guestIds.slice(0, guests)],
      screen: host
    })
  }
  const apply = async (one) => {
    const started = Date.now()
    if (one.kind === 'saved') {
      await hook(h, `s.roomSceneSave(${JSON.stringify(one.scene)})`)
      await hook(h, `await s.apply(${JSON.stringify(one.scene.id)})`)
    } else await hook(h, `await s.roomScenePreset(${JSON.stringify(one.preset)})`)
    await waitFor(
      async () => (await sceneState(h)).status?.state === 'applied',
      `${one.id}: every egress lane rendered the revision`
    )
    report.scenes.applyMs.push(Date.now() - started)
  }

  for (const one of sceneCaseMatrix().filter((c) => c.kind !== 'transition')) {
    await stageWith(one.guests)
    await apply(one)
    const content = await hook(h, 'return s.roomSceneContent()')
    const scene = content[one.orientation]
    assert.ok(scene, `${one.id}: no scene for its own orientation`)
    const other = one.orientation === 'h' ? 'v' : 'h'
    assert.equal(content[other], null, `${one.id}: the other orientation keeps room layouts`)
    const roster = sceneRoster({ host, guestIds, guests: one.guests, screen: host })
    const expected = S.planSceneTiles(scene, SCENE_CANVAS[one.orientation], roster)
    for (const page of lanes[one.orientation]) {
      await waitFor(
        async () =>
          compareSceneTiles(
            expected,
            (await observeTiles(page)).filter((t) => t.scene)
          ).length === 0,
        `${one.id}: drawn boxes match the shared plan`
      )
      const tiles = await observeTiles(page)
      assert.deepEqual(guestsKept(roster.guests, tiles), [], `${one.id}: guest removed`)
      // Pixels: screen corners show their fixture markers (mirrored or cropped
      // markers are judged by the expectation), the camera tile its colour,
      // a circle leaves its box corner unpainted by the camera.
      const shot = join(
        output,
        `scenes-${one.id.replaceAll(':', '-')}-${page === recording ? 'rec' : one.orientation}.png`
      )
      await page.screenshot({ path: shot })
      const pixel = canvasFrame(h, shot, SCENE_CANVAS[one.orientation])
      const screenTile = tiles.find((t) => t.role === 'screen')
      const screenItem = scene.items.find((i) => i.role === 'screen')
      if (screenTile?.clip && screenItem && screenItem.fit === 'contain') {
        const crop = screenItem.crop
        for (const [corner, [x, y]] of Object.entries(screenCornerPoints(screenTile.clip))) {
          const cropped =
            (corner.endsWith('l') && crop.l > 0) ||
            (corner.endsWith('r') && crop.r > 0) ||
            (corner.startsWith('t') && crop.t > 0) ||
            (corner.startsWith('b') && crop.b > 0)
          if (cropped) continue
          assert.equal(
            cornerOf(pixel(x, y)),
            expectedCorner(corner, screenItem.mirror),
            `${one.id}: screen ${corner} marker`
          )
        }
      }
      const cameraTile = tiles.find((t) => t.role === 'host-camera')
      const cameraItem = scene.items.find((i) => i.role === 'host-camera')
      if (cameraTile && cameraItem) {
        const { x, y, w, h: height } = cameraTile.rect
        const center = pixel(x + w / 2, y + height / 2)
        assert.ok(
          center.every((v, i) => Math.abs(v - [200, 40, 40][i]) <= 45),
          `${one.id}: host camera at its box`
        )
        if (cameraItem.mask.shape === 'circle' && w > 40 && height > 40) {
          const corner = pixel(x + 3, y + 3)
          assert.ok(
            !corner.every((v, i) => Math.abs(v - [200, 40, 40][i]) <= 45),
            `${one.id}: circle mask leaves the box corner`
          )
        }
      } else assert.equal(cameraTile, undefined, `${one.id}: hidden camera stays hidden`)
    }
    report.scenes.cases.push(one.id)
  }

  // Real controls while a scene is on the program: the Scene editor's
  // Freeform drag and Show/Hide, and ⋯ → Guests in the room…, each reaching
  // the program by the edit sync, confirmed by every horizontal lane and
  // drawn by the desktop Program preview with the same plan.
  {
    const free = sceneCaseMatrix().find((c) => c.id === 'freeform:h:2')
    await stageWith(2)
    await hook(h, `s.roomSceneSave(${JSON.stringify(free.scene)})`)
    await hook(h, `await s.apply(${JSON.stringify(free.scene.id)})`)
    await waitFor(async () => (await sceneState(h)).status?.state === 'applied', 'freeform on')
    const roster = sceneRoster({ host, guestIds, guests: 2, screen: host })
    const settled = async (label, check) => {
      let expected = null
      await waitFor(async () => {
        const state = await sceneState(h)
        const scene = (await hook(h, 'return s.roomSceneContent()'))?.h
        if (state.status?.state !== 'applied' || !scene || !check(scene)) return false
        expected = S.planSceneTiles(scene, SCENE_CANVAS.h, roster)
        const pages = await Promise.all(lanes.h.map((page) => observeTiles(page)))
        return (
          pages.every(
            (tiles) =>
              compareSceneTiles(
                expected,
                tiles.filter((t) => t.scene)
              ).length === 0
          ) && previewMatches(expected, await observePreview(h))
        )
      }, `${label}: program lanes and Program preview draw the edited scene`)
      report.scenes.cases.push(label)
      return expected
    }
    const camera = (scene) => scene.items.find((i) => i.role === 'host-camera')
    // One drag.
    await hook(
      h,
      "await s.roomSceneDrag('source:camera', { x: 0.55, y: 0.5, width: 0.3, height: 0.3 })"
    )
    await settled('control:freeform-drag', (scene) => Math.abs(camera(scene)?.rect.x - 0.55) < 0.01)
    // A burst of drags: coalesced, the last box wins, far fewer sends than drags.
    const before = (await sceneState(h)).status.generation
    for (let i = 0; i < 12; i++)
      await hook(
        h,
        `await s.roomSceneDrag('source:camera', { x: ${0.3 + i * 0.02}, y: 0.4, width: 0.25, height: 0.25 })`
      )
    await settled('control:rapid-drags', (scene) => Math.abs(camera(scene)?.rect.x - 0.52) < 0.01)
    const commits = (await sceneState(h)).status.generation - before
    assert.ok(commits >= 1 && commits < 12, `rapid drags coalesced (${commits} commits)`)
    report.scenes.rapidDragCommits = commits
    // Show/Hide.
    await hook(h, "await s.roomSceneVisible('source:camera', false)")
    await settled('control:hide-camera', (scene) => !camera(scene))
    await hook(h, "await s.roomSceneVisible('source:camera', true)")
    await settled('control:show-camera', (scene) => Boolean(camera(scene)))
    // Guest roles chosen for the scene on the program.
    await hook(h, `await s.roomSceneGuests(${JSON.stringify(free.scene.id)}, 'over')`)
    await settled('control:guest-roles-over', (scene) => scene.guests.slots.length === 6)
    // Edits then a clear: nothing lands after the clear.
    for (let i = 0; i < 5; i++)
      await hook(
        h,
        `await s.roomSceneDrag('source:camera', { x: ${0.1 + i * 0.05}, y: 0.1, width: 0.2, height: 0.2 })`
      )
    await hook(h, 'await s.roomSceneClear()')
    await waitFor(
      async () =>
        !(await hook(h, 'return s.roomSceneContent()')) &&
        !(await observeTiles(program)).some((t) => t.scene) &&
        !(await observePreview(h)).some((t) => t.role),
      'edits then clear: room layouts on the program and in the preview'
    )
    const cleared = (await sceneState(h)).status.generation
    await program.waitForTimeout(1000)
    assert.equal((await sceneState(h)).status.generation, cleared, 'no edit sent after the clear')
    report.scenes.cases.push('control:edits-then-clear')
  }

  // Transitions: the native glide on the page clock, and a cut.
  for (const one of sceneCaseMatrix().filter((c) => c.kind === 'transition')) {
    await stageWith(one.guests)
    await hook(h, `s.roomSceneAnimate(${one.transition === 'motion'})`)
    await waitFor(async () => (await hook(h, 'return true')) === true, 'settings render')
    await hook(h, `await s.roomScenePreset(${JSON.stringify(one.from)})`)
    await waitFor(async () => (await sceneState(h)).status?.state === 'applied', 'from scene')
    const from = (await observeTiles(program)).find((t) => t.role === 'host-camera').rect
    await program.evaluate(() => {
      window.__sceneSamples = []
      const sample = () => {
        const tile = document.querySelector('.scenes .scene.current .tile[data-role="host-camera"]')
        if (tile)
          window.__sceneSamples.push({
            t: performance.now(),
            rect: Object.fromEntries(
              ['left', 'top', 'width', 'height'].map((k, i) => [
                'xywh'[i],
                Number.parseFloat(tile.style[k])
              ])
            )
          })
        if (window.__sceneSamples.length < 400) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await hook(h, `await s.roomScenePreset(${JSON.stringify(one.preset)})`)
    await waitFor(async () => (await sceneState(h)).status?.state === 'applied', 'to scene')
    await program.waitForTimeout(SCENE_TIMING.motionMs + 400)
    const samples = await program.evaluate(() => window.__sceneSamples)
    const to = (await observeTiles(program)).find((t) => t.role === 'host-camera').rect
    const moved = samples.filter((s) =>
      ['x', 'y', 'w', 'h'].some((k) => Math.abs(s.rect[k] - from[k]) > 1)
    )
    if (one.transition === 'motion')
      assert.deepEqual(
        judgeGlide(
          moved.length ? [samples[samples.indexOf(moved[0]) - 1] ?? moved[0], ...moved] : samples,
          from,
          to
        ),
        [],
        'native glide'
      )
    else
      assert.ok(
        !moved.some((s) =>
          ['x', 'w'].some(
            (k) =>
              Math.min(from[k], to[k]) + 2 < s.rect[k] && s.rect[k] < Math.max(from[k], to[k]) - 2
          )
        ),
        'a cut has no intermediate box'
      )
    report.scenes.cases.push(one.id)
  }
  await hook(h, 's.roomSceneAnimate(false)')

  // Late join: a reloaded page draws the current scene and confirms it again.
  await program.reload()
  await waitFor(
    async () => (await sceneState(h)).status?.state === 'applied',
    'late join re-confirmed'
  )
  assert.ok(
    (await observeTiles(program)).some((t) => t.scene),
    'late join draws the scene'
  )
  report.scenes.cases.push('late-join')

  // A guest page never receives a scene, and the guest call view is unchanged.
  for (const guest of clients.filter((c) => c.name !== 'program'))
    assert.equal(await guest.page.locator('.tile-scene').count(), 0, 'no scene on guest pages')
  report.scenes.cases.push('guest-projection-absent')

  // Clear: the room's own layouts return on every lane, confirmed.
  await hook(h, 'await s.roomSceneClear()')
  for (const page of [program, recording, vertical])
    await waitFor(
      async () => !(await observeTiles(page)).some((t) => t.scene),
      'room layouts after clear'
    )
  report.scenes.cases.push('clear')
  await hook(h, 's.roomScenes(false)')

  for (const label of SCENE_CONTROL_CASES)
    assert.ok(report.scenes.cases.includes(label), `${label} not exercised`)
  report.scenes.applyP95Ms = p95(report.scenes.applyMs)
  assert.ok(
    report.scenes.applyP95Ms <= SCENE_TIMING.applyBudgetMs,
    `scene apply p95 ${report.scenes.applyP95Ms} ms over the local budget`
  )
  report.scenes.status = 'passed-local-real-pages'
}

/** The finalized browser videos must hold the screen markers, not only the DOM. */
export function assertScenesVideo(report) {
  for (const lane of ['program', 'scenes-vertical'])
    assert.ok(
      (report.videoMeasurements.frameHits[lane]?.host ?? 0) >= 5,
      `${lane}: finalized video artifact must contain the host camera`
    )
}
