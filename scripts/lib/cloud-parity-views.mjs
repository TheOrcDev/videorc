/** Plan 249 S6 maintained real-page `views` acceptance. NEVER imported by
 * focused tests, and not run in the current sequence (smoke and heavy gates
 * are deferred until all merges are on main).
 *
 * Checks, on the actual program page, the real guest components and the
 * desktop's Program preview:
 * - the stage key the page applied equals the stage the desktop sent, for
 *   several layouts, and the preview says `applied` (never more);
 * - each person marker sits where the shared geometry puts it on the program
 *   frame, and the card overlay where its normalized rect says;
 * - guests see the host and the other on-stage guest, never themselves as a
 *   remote; returns stay mix-minus, and the soundboard arrives once;
 * - a real 4:3 screen fixture (host, then a guest) is contained on the
 *   program frame at the shared geometry, decoded whole on the guest pages,
 *   and the guest's own screen never comes back to it;
 * - guest public graphics (D4): nothing until the host opts in; then each
 *   guest page draws the same decoded avatar layers at the program's rects
 *   and confirms the revision; recording-only and opt-out clear them.
 *
 * Fixture transport carries the page's `shown` into the fake managed web.
 * Managed egress, devices and the encoded stream are NOT covered: the
 * preview is a reconstruction, and this case never claims encoded output. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { waitFor, runMedia } from './cloud-managed-smoke.mjs'
import { MEDIA } from './cloud-parity-media.mjs'
import {
  assertAppliedStage,
  assertInside,
  assertSameLayers,
  assertTileGeometry,
  assertViewReturns,
  colorBox,
  containRect
} from './cloud-parity-views-contract.mjs'

const FRAME = { width: 192, height: 108 }
/** 4:3 on a 16:9 tile: contain pillarboxes it, cover would crop it. */
const SCREEN = { w: 640, h: 480 }
const SCREEN_COLORS = { host: [130, 0, 255], guest: [90, 255, 0] }

/** Replaces getDisplayMedia with a solid 4:3 canvas (no real capture). */
const screenFixture = (color) => `
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas'); canvas.width = ${SCREEN.w}; canvas.height = ${SCREEN.h};
    const context = canvas.getContext('2d');
    const draw = () => { context.fillStyle = 'rgb(${color.join(',')})'; context.fillRect(0, 0, ${SCREEN.w}, ${SCREEN.h}); };
    draw(); const timer = setInterval(draw, 33);
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
    track.stop = () => { clearInterval(timer); stop(); };
    return stream;
  };`

/** The page's decoded 4:3 videos (any simulcast layer) and their mean colour. */
const decodedScreens = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('video')]
      .filter(
        (v) =>
          v.readyState >= 2 &&
          v.videoHeight > 0 &&
          Math.abs(v.videoWidth / v.videoHeight - 4 / 3) < 0.03
      )
      .map((video) => {
        const canvas = document.createElement('canvas')
        canvas.width = 16
        canvas.height = 12
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(video, 0, 0, 16, 12)
        const data = context.getImageData(0, 0, 16, 12).data
        const mean = [0, 1, 2].map((c) => {
          let sum = 0
          for (let i = c; i < data.length; i += 4) sum += data[i]
          return sum / (data.length / 4)
        })
        return { fit: video.dataset.fit ?? null, mean }
      })
  )
const near = (a, b, tolerance = 45) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)

/** Public avatar layers a page draws: kind, inline rect and decoded size. */
const layersOf = (page, scope = '') =>
  page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((img) => ({
        kind: img.dataset.avatarLayer,
        left: img.style.left,
        top: img.style.top,
        width: img.style.width,
        height: img.style.height,
        natural: img.naturalWidth
      })),
    `${scope} img[data-avatar-layer]`.trim()
  )

/** A page screenshot, decoded to small rgb24 for marker boxes. */
async function pageFrame(h, page, path) {
  await page.screenshot({ path })
  return runMedia(h.ffmpeg, [
    '-v',
    'error',
    '-i',
    path,
    '-vf',
    `scale=${FRAME.width}:${FRAME.height}`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1'
  ])
}

/** The Program preview's tiles as fractions of its frame (renderer DOM). */
const monitorTiles = (h) =>
  h.eval(`
    const monitor = document.querySelector('[data-testid="show-stage-program"]')
    const tiles = [...(monitor?.querySelectorAll('[data-testid="show-stage-tile"]') ?? [])]
    const pct = (value) => Number.parseFloat(value) / 100
    return {
      state: monitor?.dataset.programStage ?? null,
      source: monitor?.dataset.viewSource ?? null,
      tiles: tiles.map((tile) => ({
        identity: tile.dataset.stageIdentity,
        kind: tile.dataset.stageKind,
        rect: {
          x: pct(tile.style.left),
          y: pct(tile.style.top),
          w: pct(tile.style.width),
          h: pct(tile.style.height)
        }
      }))
    }
  `)

export async function exerciseViews({ h, clients, captureAudio, report, sound, guests, output }) {
  const outcome = {
    status: 'running',
    stages: [],
    managedEgress: 'not-run',
    encodedOutput: 'not-claimed',
    devices: 'not-run',
    screens: [],
    guestGraphics: { cases: [], productionQualified: false },
    guestLayout:
      'Guest fixture pages load no Tailwind; guest geometry is checked by DOM contract (data-fit, inline layer rects) and decoded frames, not by guest page pixels.'
  }
  report.views = outcome
  const host = `host:${h.showId}`
  const [guest1, guest2] = [...guests.values()].map((g) => g.identity)
  const colorOf = {
    [host]: MEDIA.colors.host,
    [guest1]: MEDIA.colors.guest1,
    [guest2]: MEDIA.colors.guest2
  }
  const program = clients.find((c) => c.name === 'program')
  const status = async () => (await h.rpc('cloud.status')).room

  // The preview is a labelled reconstruction, never a return.
  assert.equal(
    await h.eval(
      `return document.querySelector('[data-testid="show-stage-well"]')?.dataset.viewSource ?? null`
    ),
    'room-tracks'
  )

  const stages = [
    { layout: 'side-by-side', onStage: [host, guest1, guest2] },
    { layout: 'spotlight', onStage: [host, guest1, guest2], spotlight: guest1 },
    { layout: 'side-by-side', onStage: [host, guest2] }
  ]
  for (const [index, sent] of stages.entries()) {
    const label = `${sent.layout}-${index}`
    await h.rpc('cloud.stage.set', sent)
    await waitFor(async () => {
      const room = await status()
      const monitor = await monitorTiles(h)
      return room?.shown?.stageKey && monitor.state === 'applied'
    }, `${label}: page applies the sent stage`)
    const room = await status()
    const monitor = await monitorTiles(h)
    assertAppliedStage(label, { sent, shown: room.shown, monitorState: monitor.state })
    assert.equal(monitor.source, 'program-page-report', `${label}: preview names its source`)

    // The program frame puts each person where the preview's shared geometry does.
    const frame = await pageFrame(h, program.page, join(output, `views-${label}-program.png`))
    for (const tile of monitor.tiles.filter((t) => t.kind === 'person')) {
      const measured = colorBox(frame, FRAME.width, FRAME.height, colorOf[tile.identity])
      assertTileGeometry(`${label}/${tile.identity}`, measured, tile.rect)
    }
    // Guests see the people on stage, and never themselves as a remote tile.
    for (const { name, page } of clients.filter((c) => c.name !== 'program')) {
      const me = guests.get(name).identity
      const guestFrame = await pageFrame(h, page, join(output, `views-${label}-${name}.png`))
      for (const identity of sent.onStage.filter((id) => id !== me)) {
        assert.ok(
          colorBox(guestFrame, FRAME.width, FRAME.height, colorOf[identity]),
          `${label}/${name}: ${identity} not visible`
        )
      }
    }
    outcome.stages.push({ label, stageKey: room.shown.stageKey, tiles: monitor.tiles.length })
  }

  // A real screen fixture: the host's, then an on-stage guest's (D4).
  const screenCase = async (label, owner, color, viewers) => {
    const sent = { layout: 'screen-people', screen: owner, onStage: [host, guest1, guest2] }
    await h.rpc('cloud.stage.set', sent)
    await waitFor(
      async () => (await monitorTiles(h)).state === 'applied',
      `${label}: page applies the screen stage`
    )
    const monitor = await monitorTiles(h)
    const tile = monitor.tiles.find((t) => t.kind === 'screen')
    assert.ok(tile, `${label}: the preview has a screen tile`)
    const expected = containRect(tile.rect, SCREEN)
    await waitFor(async () => {
      const frame = await pageFrame(h, program.page, join(output, `views-${label}-program.png`))
      return colorBox(frame, FRAME.width, FRAME.height, color) !== null
    }, `${label}: the program draws the screen`)
    const frame = await pageFrame(h, program.page, join(output, `views-${label}-program.png`))
    assertTileGeometry(
      `${label}/contain`,
      colorBox(frame, FRAME.width, FRAME.height, color),
      expected
    )
    for (const { name, page } of viewers) {
      await waitFor(
        async () => (await decodedScreens(page)).some((v) => near(v.mean, color)),
        `${label}: ${name} decodes the whole 4:3 screen`
      )
      const screens = (await decodedScreens(page)).filter((v) => near(v.mean, color))
      assert.ok(
        screens.every((v) => v.fit === null || v.fit === 'contain'),
        `${label}: ${name} draws the screen contained`
      )
    }
    outcome.screens.push({ label, expected, monitorState: monitor.state })
  }
  await h.eval(`${screenFixture(SCREEN_COLORS.host)}
    await window.__videorcSmokeScenePresets.screenPrivacyCommand('show');
    await window.__videorcSmokeScenePresets.roomScreenShare();`)
  await screenCase(
    'host-screen',
    host,
    SCREEN_COLORS.host,
    clients.filter((c) => c.name !== 'program')
  )
  await h.eval('await window.__videorcSmokeScenePresets.roomScreenStop()')

  const sharer = clients.find((c) => c.name === 'guest1')
  const watcher = clients.find((c) => c.name === 'guest2')
  await h.rpc('cloud.guest.act', { guestId: guest1, action: 'allow-screen-share' })
  await sharer.page.evaluate(screenFixture(SCREEN_COLORS.guest))
  await sharer.page.getByRole('button', { name: 'Share screen' }).click()
  await screenCase('guest-screen', guest1, SCREEN_COLORS.guest, [watcher])
  // The sharer never receives its own screen back.
  assert.ok(
    !(await decodedScreens(sharer.page)).some((v) => near(v.mean, SCREEN_COLORS.guest)),
    'guest-screen: the sharer gets its own screen back'
  )
  await sharer.page.getByRole('button', { name: 'Stop sharing' }).click()
  await h.rpc('cloud.guest.act', { guestId: guest1, action: 'disallow-screen-share' })
  await h.rpc('cloud.stage.set', { layout: 'side-by-side', onStage: [host, guest1, guest2] })

  // Guest public graphics (D4): the avatar was prepared before the program
  // page joined. Nothing reaches a guest until the host opts in.
  const avatarGuests = (value = '') =>
    h.eval(`return window.__videorcSmokeScenePresets.roomAvatarGuests(${value})`)
  const viewersOnly = clients.filter((c) => c.name !== 'program')
  const say = () =>
    h.rpc('cohost.utterance.say', {
      text: 'Parity guest graphics. Public words only, drawn for guests after the host opts in.'
    })
  await say()
  await waitFor(
    async () => (await layersOf(program.page)).some((l) => l.kind === 'avatar'),
    'the program draws the avatar'
  )
  await waitFor(async () => (await avatarGuests())?.capable === 2, 'both guest pages can draw')
  for (const { name, page } of viewersOnly)
    assert.equal(
      (await layersOf(page, '[data-guest-graphics]')).length,
      0,
      `${name}: off by default`
    )
  outcome.guestGraphics.cases.push('off-by-default')

  await avatarGuests('true')
  await say()
  await waitFor(
    async () => (await avatarGuests())?.applied === 2,
    'each guest confirms the revision'
  )
  const programLayers = await layersOf(program.page)
  for (const { name, page } of viewersOnly) {
    await waitFor(
      async () => (await layersOf(page, '[data-guest-graphics]')).length === programLayers.length,
      `${name}: draws the program's layers`
    )
    assertSameLayers(name, await layersOf(page, '[data-guest-graphics]'), programLayers)
    // The decoded avatar asset carries the character, not a blank image.
    const pixels = await page
      .locator('[data-guest-graphics] img[data-avatar-layer="avatar"]')
      .evaluate((img, color) => {
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, c.width, c.height).data
        let hits = 0
        for (let i = 0; i < data.length; i += 4)
          if (data[i + 3] > 200 && [0, 1, 2].every((k) => Math.abs(data[i + k] - color[k]) <= 45))
            hits++
        return hits
      }, MEDIA.colors.avatar)
    assert.ok(pixels > 10, `${name}: decoded avatar pixels`)
  }
  // The program frame draws it inside its rect: the same layer, both places.
  const avatarRect = programLayers.find((l) => l.kind === 'avatar')
  const pct = (v) => Number.parseFloat(v) / 100
  assertInside(
    'program avatar',
    colorBox(
      await pageFrame(h, program.page, join(output, 'views-guest-graphics-program.png')),
      FRAME.width,
      FRAME.height,
      MEDIA.colors.avatar
    ),
    {
      x: pct(avatarRect.left),
      y: pct(avatarRect.top),
      w: pct(avatarRect.width),
      h: pct(avatarRect.height)
    }
  )
  // The guests' line lives with the switch in Destinations → Guests → Room
  // (0.31.1); the Studio comes back after, for the Program preview.
  assert.equal(
    await h.eval(`
      await openTab('streaming');
      const deadline = Date.now() + 15000;
      let line = null;
      while (Date.now() < deadline) {
        const tab = [...document.querySelectorAll('[role="tablist"][aria-label="Destinations view"] [role="tab"]')]
          .find((el) => el.textContent.trim() === 'Guests');
        if (tab && !tab.hasAttribute('data-active')) tab.click();
        line = document.querySelector('[data-testid="guests-program-avatar-guests"] [data-slot="field-description"]')?.textContent ?? null;
        if (line) break;
        await sleep(50);
      }
      await openTab('studio', '[data-testid="show-stage-program"]');
      return line;`),
    'Guests see the avatar'
  )
  outcome.guestGraphics.cases.push('opted-in-same-layers')

  // Recording only: guests are cleared, never sent a recording layer.
  const layout = await h.rpc('overlays.layout.get')
  await h.rpc('overlays.layout.set', {
    ...layout,
    buddy: { ...layout.buddy, showOnStream: false, showInRecording: true }
  })
  for (const { name, page } of viewersOnly)
    await waitFor(
      async () => (await layersOf(page, '[data-guest-graphics]')).length === 0,
      `${name}: recording-only clears guests`
    )
  outcome.guestGraphics.cases.push('recording-only-clears')
  await h.rpc('overlays.layout.set', layout)
  await say()
  for (const { name, page } of viewersOnly)
    await waitFor(
      async () => (await layersOf(page, '[data-guest-graphics]')).length > 0,
      `${name}: shown again`
    )

  // Opt-out clears at once, not at the lease.
  await avatarGuests('false')
  for (const { name, page } of viewersOnly)
    await waitFor(
      async () => (await layersOf(page, '[data-guest-graphics]')).length === 0,
      `${name}: opt-out clears`,
      5000
    )
  outcome.guestGraphics.cases.push('opt-out-clears')

  // The card overlay lands at its normalized rect on the program frame.
  const card = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }
  const png = runMedia(h.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=0x${MEDIA.colors.card.map((v) => v.toString(16).padStart(2, '0')).join('')}:s=64x64`,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-c:v',
    'png',
    'pipe:1'
  ])
  await h.rpc('cloud.overlay.set', {
    slot: 'card',
    orientation: 'h',
    pngBase64: png.toString('base64'),
    rect: card
  })
  await waitFor(async () => {
    const frame = await pageFrame(h, program.page, join(output, 'views-card-program.png'))
    return colorBox(frame, FRAME.width, FRAME.height, MEDIA.colors.card) !== null
  }, 'card drawn on the program')
  const cardFrame = await pageFrame(h, program.page, join(output, 'views-card-program.png'))
  assertTileGeometry(
    'card',
    colorBox(cardFrame, FRAME.width, FRAME.height, MEDIA.colors.card),
    card
  )
  await h.rpc('cloud.overlay.clear', { slot: 'card', orientation: 'h' })

  // Returns: mix-minus, and one soundboard copy everywhere (S3's aux, kept).
  await h.rpc('cloud.stage.set', { layout: 'side-by-side', onStage: [host, guest1, guest2] })
  const roomSounds = (value = '') =>
    h.eval(`return window.__videorcSmokeScenePresets.roomSounds(${value})`)
  await roomSounds('true')
  await waitFor(async () => (await roomSounds()).state === 'published', 'aux negotiated')
  await h.rpc('sounds.settings', { monitor: false, volumeDb: 0 })
  await h.rpc('sounds.update', { id: sound.id, mode: 'loop' })
  await h.rpc('sounds.play', { id: sound.id })
  const expected = 20 * Math.log10(MEDIA.tonePeak / Math.sqrt(2)) + sound.levelDb + sound.volumeDb
  assertViewReturns(await captureAudio('views-returns', clients), { soundDb: expected })
  await h.rpc('sounds.stop', { id: sound.id })
  await roomSounds('false')

  outcome.status = 'passed'
}
