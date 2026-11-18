/** Full S9 acquisition against the real desktop publisher and emitted pages.
 * Authored for the post-merge run; never imported by a smoke/test shortcut.
 * Local fixture APIs only; managed/provider/device qualification is separate. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { waitFor, runMedia } from './cloud-managed-smoke.mjs'
import {
  graphicsPatchPng,
  GRAPHICS_PLACEMENT,
  assertGraphicsPixel,
  assertGraphicsRect,
  assertGraphicsFade
} from './cloud-parity-graphics-contract.mjs'
const state = (h) => h.eval('return window.__videorcSmokeScenePresets.roomGraphics()')
const enable = (h, on) => h.eval(`return window.__videorcSmokeScenePresets.roomGraphics(${on})`)
export async function prepareGraphics({ h, report, output }) {
  await h.rpc('banners.hide', {})
  const previous = (await h.rpc('banners.list')).map((b) => b.id)
  const imported = []
  for (const base of [true, false]) {
    const path = join(output, base ? 'graphics-base.png' : 'graphics-alpha.png')
    writeFileSync(path, graphicsPatchPng(base))
    const grant = await h.command('authorize-smoke-resource', { path, kind: 'input-file' })
    const banner = await h.rpc('banners.importImage', { sourceCapability: grant.capabilityId })
    imported.push(
      await h.rpc('banners.update', {
        id: banner.id,
        ...GRAPHICS_PLACEMENT,
        opacity: 1,
        showOnStream: true,
        showInRecording: true
      })
    )
  }
  assert.equal((await state(h)).enabled, false)
  await enable(h, true)
  await waitFor(
    () =>
      h.eval('return document.querySelectorAll("[data-testid=show-stage-banners] img").length===2'),
    'graphics decoded in preview before egress'
  )
  assert.equal((await state(h)).state, 'preview')
  report.graphics = {
    status: 'running',
    previous,
    base: imported[0].id,
    patch: imported[1].id,
    cases: ['preview-before-egress'],
    artifacts: [],
    managed: 'not-run',
    devices: 'not-run',
    productionQualified: false
  }
}
export async function exerciseGraphics({ h, report, clients, newPage, programUrl, output }) {
  const record = report.graphics,
    base = record.base,
    patch = record.patch
  const consumers = [
    {
      name: 'program',
      page: clients.find((c) => c.name === 'program').page,
      orientation: 'h',
      recording: false
    }
  ]
  for (const [name, orientation, recording, identity] of [
    ['graphics-recording', 'h', true, 'EG_parity_avatar_recording'],
    ['graphics-vertical', 'v', false, 'EG_parity_graphics_v'],
    ['graphics-vertical-recording', 'v', true, 'EG_parity_graphics_vrec']
  ]) {
    const page = await newPage(name)
    const url = new URL(programUrl)
    url.searchParams.set('layout', orientation)
    if (recording) url.searchParams.set('rec', '1')
    url.searchParams.set('token', h.web.tokenFor(h.showId, identity, 'recorder'))
    await page.goto(url.toString())
    consumers.push({ name, page, orientation, recording })
  }
  const selector = (id) => `img[data-graphics-id="banner:${id}"]`
  const waitLayer = async (c, id, present) =>
    waitFor(
      async () => Boolean(await c.page.locator(selector(id)).count()) === present,
      `${c.name} ${id} visible=${present}`
    )
  const artifact = async (c, label) => {
    const path = join(output, `graphics-${label}-${c.name}.png`)
    await c.page.screenshot({ path })
    record.artifacts.push({ kind: 'decoded-phase-image', path, label, lane: c.name })
    return path
  }
  const pixel = (path, x, y) =>
    Array.from(
      runMedia(h.ffmpeg, [
        '-v',
        'error',
        '-i',
        path,
        '-vf',
        `crop=1:1:${Math.floor(x)}:${Math.floor(y)},format=rgb24`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        'pipe:1'
      ]).subarray(0, 3)
    )
  const checkPatches = async (
    label,
    expected = [
      [0, 255, 255],
      [127, 128, 128],
      [255, 0, 0]
    ]
  ) => {
    for (const c of consumers) {
      await waitLayer(c, patch, true)
      await waitFor(
        async () =>
          Number(await c.page.locator(selector(patch)).evaluate((img) => img.style.opacity)) === 1,
        `${c.name} fade settled`
      )
      const shape = await c.page.locator(selector(patch)).evaluate((img) => {
        const r = img.getBoundingClientRect(),
          root = img.closest('.overlays').getBoundingClientRect()
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          normalized: {
            x: (r.x - root.x) / root.width,
            y: (r.y - root.y) / root.height,
            w: r.width / root.width,
            h: r.height / root.height
          }
        }
      })
      assertGraphicsRect(shape.normalized, c.orientation)
      const path = await artifact(c, label)
      for (let i = 0; i < 3; i++)
        assertGraphicsPixel(
          pixel(path, shape.x + (shape.w * (i + 0.5)) / 3, shape.y + shape.h / 2),
          expected[i],
          `${label} ${c.name} alpha patch ${i}`
        )
    }
    record.cases.push(label)
  }
  await checkPatches('alpha-native-placement-both-orientations')
  await h.rpc('banners.reorder', { ids: [...record.previous, patch, base] })
  await checkPatches('reordered-z-stack', [
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0]
  ])
  await h.rpc('banners.reorder', { ids: [...record.previous, base, patch] })
  await h.rpc('banners.update', { id: patch, opacity: 0.5 })
  for (const c of consumers)
    await waitFor(
      async () =>
        Number(await c.page.locator(selector(patch)).evaluate((img) => img.style.opacity)) === 0.5,
      `${c.name} opacity`
    )
  for (const c of consumers) {
    const r = await c.page.locator(selector(patch)).boundingBox()
    const path = await artifact(c, 'opacity')
    assertGraphicsPixel(
      pixel(path, r.x + r.width / 6, r.y + r.height / 2),
      [128, 128, 128],
      `${c.name} opacity multiplied once`
    )
  }
  await h.rpc('banners.update', {
    id: patch,
    opacity: 1,
    showOnStream: false,
    showInRecording: true
  })
  for (const c of consumers) await waitLayer(c, patch, c.recording)
  record.cases.push('record-only-switch')
  await h.rpc('banners.update', { id: patch, showOnStream: true, showInRecording: false })
  for (const c of consumers) await waitLayer(c, patch, !c.recording)
  record.cases.push('stream-only-switch')
  await h.rpc('banners.update', { id: patch, showInRecording: true })
  await checkPatches('switch-restored')
  // This fixture creates only a local fake recording state: it cannot call a provider.
  await h.rpc('cloud.recording.start')
  await h.status((s) => s.recording?.active === true, 'record-only output facts')
  await h.rpc('banners.update', { id: patch, hideAfterSec: 1, repeatEveryMin: 1 })
  await h.rpc('banners.hide', { id: patch })
  await h.rpc('banners.show', { id: patch })
  await waitFor(
    async () => !(await h.rpc('banners.list')).find((b) => b.id === patch).shown,
    'Hide after timer'
  )
  for (const c of consumers) await waitLayer(c, patch, false)
  await waitFor(
    async () => (await h.rpc('banners.list')).find((b) => b.id === patch).shown,
    'Show every while record-only',
    75000
  )
  record.cases.push('hide-after-show-every-record-only')
  await h.rpc('banners.update', { id: patch, hideAfterSec: 0, repeatEveryMin: 0 })
  await h.rpc('banners.show', { id: patch })
  // Observe real frames across Show/Hide; retain samples and compare the native curve.
  const observer = consumers[0].page.evaluate(async (id) => {
    const rows = [],
      end = performance.now() + 2500
    while (performance.now() < end) {
      await new Promise(requestAnimationFrame)
      const img = document.querySelector(`img[data-graphics-id="banner:${id}"]`)
      rows.push({ at: Date.now(), opacity: img ? Number(img.style.opacity) : 0 })
    }
    return rows
  }, patch)
  const fadeOf = async () =>
    (await h.rpc('cloud.graphics.snapshot', { showId: h.showId })).content.h.find(
      (l) => l.id === `banner:${patch}`
    )?.fade
  await h.rpc('banners.hide', { id: patch })
  const hiding = await fadeOf()
  for (const c of consumers) await waitLayer(c, patch, false)
  await h.rpc('banners.show', { id: patch })
  const showing = await fadeOf()
  const fades = await observer
  assertGraphicsFade(fades, [hiding, showing].filter(Boolean))
  writeFileSync(join(output, 'graphics-fades.json'), JSON.stringify(fades, null, 2) + '\n')
  assert.ok(
    fades.some((r) => r.opacity > 0 && r.opacity < 1),
    'Real consumer must show intermediate fade values'
  )
  record.cases.push('native-200ms-fades')
  // Curated chat/emote and milestone travel through the normal renderer painter.
  const emote = graphicsPatchPng(),
    server = createServer((req, res) => {
      if (req.url !== '/emote.png') {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(emote)
    })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    await h.rpc('cohost.settings.set', { enabled: false })
    await h.rpc('liveChat.emotes.set', { sevenTv: false, twitchGifs: 'still' })
    await h.rpc('liveChat.start', {
      sessionId: h.showId,
      destinations: [{ platform: 'twitch', targetId: 'graphics', read: 'ready', write: 'ready' }],
      fakes: [
        {
          platform: 'twitch',
          targetId: 'graphics',
          count: 5,
          intervalMs: 100,
          texts: ['Public graphics fixture 🙂'],
          authors: ['Graphics viewer'],
          emote: { text: 'ALPHA', imageUrl: `http://127.0.0.1:${server.address().port}/emote.png` }
        }
      ]
    })
    const layout = await h.rpc('overlays.layout.get')
    await h.rpc('overlays.layout.set', {
      ...layout,
      chat: { ...layout.chat, ...GRAPHICS_PLACEMENT, showOnStream: true, showInRecording: true },
      highlight: {
        ...layout.highlight,
        ...GRAPHICS_PLACEMENT,
        showOnStream: true,
        showInRecording: true
      }
    })
    for (const c of consumers)
      await waitFor(
        () => c.page.locator('img[data-graphics-layer="chat"]').count(),
        `${c.name} chat painter`
      )
    for (const c of consumers) {
      const cyan = await c.page.locator('img[data-graphics-layer="chat"]').evaluate((img) => {
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const p = ctx.getImageData(0, 0, c.width, c.height).data
        let hits = 0
        for (let i = 0; i < p.length; i += 4)
          if (p[i] < 20 && p[i + 1] > 230 && p[i + 2] > 230 && p[i + 3] > 200) hits++
        return hits
      })
      assert.ok(cyan > 5, `${c.name}: the curated chat raster must contain the emote pixels`)
      await artifact(c, 'chat-emote')
    }
    for (const milestone of [false, true]) {
      await h.eval(`return window.__videorcSmokeScenePresets.roomHighlight(${milestone})`)
      const nativeSnapshot = await h.rpc('cloud.graphics.snapshot', { showId: h.showId })
      for (const c of consumers) {
        await waitFor(
          () => c.page.locator('img[data-graphics-layer="highlight"]').count(),
          `${c.name} card painter`
        )
        const pixels = await c.page
          .locator('img[data-graphics-layer="highlight"]')
          .evaluate((img) => {
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            const ctx = c.getContext('2d')
            ctx.drawImage(img, 0, 0)
            let ink = 0,
              light = 0
            const p = ctx.getImageData(0, 0, c.width, c.height).data
            for (let i = 0; i < p.length; i += 4)
              if (p[i + 3] > 200) {
                if (p[i] < 60) ink++
                if (p[i] > 230) light++
              }
            return { ink, light }
          })
        assert.ok(
          pixels.ink > 10 && pixels.light > 100,
          `${c.name}: real card has text and surface pixels`
        )
        const card = await c.page
          .locator('img[data-graphics-layer="highlight"]')
          .evaluate((img) => {
            const canvas = document.createElement('canvas')
            canvas.width = img.naturalWidth
            canvas.height = img.naturalHeight
            const ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0)
            const p = ctx.getImageData(0, 0, canvas.width, canvas.height).data
            const box = img.getBoundingClientRect(),
              parent = img.closest('.overlays').getBoundingClientRect()
            // Sample an opaque surface pixel that overlaps the banner beneath it.
            const banner = document
              .querySelector('img[data-graphics-layer="banner"]')
              .getBoundingClientRect()
            for (let y = 1; y < canvas.height - 1; y++)
              for (let x = 1; x < canvas.width - 1; x++) {
                const offset = (y * canvas.width + x) * 4
                const px = box.x + ((x + 0.5) * box.width) / canvas.width
                const py = box.y + ((y + 0.5) * box.height) / canvas.height
                if (
                  p[offset + 3] === 255 &&
                  p[offset] > 230 &&
                  px > banner.x + 2 &&
                  px < banner.right - 2 &&
                  py > banner.y + 2 &&
                  py < banner.bottom - 2
                )
                  return {
                    x: px,
                    y: py,
                    expected: Array.from(p.slice(offset, offset + 3)),
                    normalized: {
                      x: (box.x - parent.x) / parent.width,
                      y: (box.y - parent.y) / parent.height,
                      w: box.width / parent.width,
                      h: box.height / parent.height
                    }
                  }
              }
            return null
          })
        assert.ok(card, `${c.name}: card fixture must collide with the banner`)
        const path = await artifact(c, milestone ? 'milestone' : 'chat-card')
        assertGraphicsPixel(
          pixel(path, card.x, card.y),
          card.expected,
          `${c.name}: highlight wins the overlapping native stack`
        )
        record.artifacts.at(-1).cardRect = card.normalized
        const nativeRect = nativeSnapshot.content[c.orientation].find(
          (l) => l.kind === 'highlight'
        ).rect
        for (const axis of ['x', 'y', 'w', 'h'])
          assert.ok(
            Math.abs(card.normalized[axis] - nativeRect[axis]) < 0.002,
            `${c.name}: card ${axis} preserves native collision ownership`
          )
      }
    }
    record.cases.push('chat-emoji-and-milestone', 'overlapping-highlight-above-chat-and-banners')
    for (const stream of [false, true]) {
      await h.rpc('overlays.layout.set', {
        ...layout,
        chat: {
          ...layout.chat,
          ...GRAPHICS_PLACEMENT,
          showOnStream: stream,
          showInRecording: !stream
        },
        highlight: {
          ...layout.highlight,
          ...GRAPHICS_PLACEMENT,
          showOnStream: stream,
          showInRecording: !stream
        }
      })
      await h.eval('return window.__videorcSmokeScenePresets.roomHighlight(false)')
      for (const c of consumers)
        for (const kind of ['chat', 'highlight'])
          await waitFor(
            async () =>
              Boolean(await c.page.locator(`img[data-graphics-layer="${kind}"]`).count()) ===
              (c.recording ? !stream : stream),
            `${c.name}: ${kind} respects its output switch`
          )
    }
    await h.rpc('overlays.layout.set', {
      ...layout,
      chat: { ...layout.chat, ...GRAPHICS_PLACEMENT, showOnStream: true, showInRecording: true },
      highlight: {
        ...layout.highlight,
        ...GRAPHICS_PLACEMENT,
        showOnStream: true,
        showInRecording: true
      }
    })
    record.cases.push('chat-card-output-switches')
    await h.rpc('comments.highlight.clear')
    for (const c of consumers)
      await waitFor(
        async () => !(await c.page.locator('img[data-graphics-layer="highlight"]').count()),
        `${c.name} card clear`
      )
    // Decode stalled at receiver; a clear must not wait, and late completion cannot restore it.
    const page = consumers[0].page
    await page.evaluate(() => {
      window.__graphicsOriginalDecode = HTMLImageElement.prototype.decode
      window.__graphicsFinish = []
      HTMLImageElement.prototype.decode = function () {
        const image = this
        return new Promise((resolve, reject) => {
          window.__graphicsFinish.push(() =>
            window.__graphicsOriginalDecode.call(image).then(resolve, reject)
          )
        })
      }
    })
    await h.rpc('banners.update', { id: patch, opacity: 0.7 })
    await waitFor(
      () => page.evaluate(() => window.__graphicsFinish.length > 0),
      'Stalled asset decode reached'
    )
    await enable(h, false)
    await waitFor(
      async () => !(await page.locator('[data-graphics-layer]').count()),
      'Clear outranks pending decode'
    )
    await page.evaluate(() => {
      HTMLImageElement.prototype.decode = window.__graphicsOriginalDecode
      window.__graphicsFinish.forEach((fn) => fn())
      delete window.__graphicsFinish
      delete window.__graphicsOriginalDecode
    })
    assert.equal(await page.locator('[data-graphics-layer]').count(), 0)
    await enable(h, true)
    await h.rpc('banners.update', { id: patch, opacity: 1 })
    await page.reload()
    await checkPatches('late-join-current-snapshot')
    record.cases.push('clear-beats-stalled-set')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  await h.rpc('cloud.recording.stop')
  await enable(h, false)
  record.status = 'passed-local-real-pages'
}
export function assertGraphicsArtifacts(report) {
  assert.equal(report.graphics.status, 'passed-local-real-pages')
  for (const lane of [
    'program',
    'graphics-recording',
    'graphics-vertical',
    'graphics-vertical-recording'
  ])
    assert.ok(
      report.videoMeasurements.frameHits[lane]?.graphics >= 5,
      `${lane}: finalized video must contain graphic marker pixels`
    )
  for (const lane of [
    'program',
    'graphics-recording',
    'graphics-vertical',
    'graphics-vertical-recording'
  ])
    assert.ok(
      report.graphics.artifacts.some((a) => a.lane === lane && a.label === 'chat-card'),
      `${lane} must have an inspected card artifact`
    )
}
