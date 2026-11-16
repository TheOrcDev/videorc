/** Maintained S4 real-page acceptance. Never imported by lightweight tests.
 * Device and managed qualification remain separate. No paid calls or AI. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeBuddyPetFixturePack } from './buddy-pet-fixture.mjs'
import { waitFor, runMedia } from './cloud-managed-smoke.mjs'
import { colorFraction, MEDIA } from './cloud-parity-media.mjs'

const state = (h) => h.eval('return window.__videorcSmokeScenePresets.roomAvatar()')
const enable = (h, value) => h.eval(`return window.__videorcSmokeScenePresets.roomAvatar(${value})`)
const say = (h) =>
  h.rpc('cohost.utterance.say', {
    text: 'Parity public bubble. This long fixture remains visible while both real output pages paint the intended character and its public words. No private Sidekick state is sent.'
  })
export async function prepareAvatar({ h, report }) {
  const settings = await h.rpc('cohost.settings.get'),
    packId = randomUUID()
  writeBuddyPetFixturePack(
    join(h.env.VIDEORC_USER_DATA_DIR, 'buddy-assets', settings.persona.id, 'pets', packId)
  )
  await h.command('backend-debug-rpc', {
    method: 'cohost.pet.import',
    params: { folderToken: `${settings.persona.id}/pets/${packId}` },
    timeoutMs: 15000
  })
  await h.rpc('cohost.settings.set', {
    persona: { ...settings.persona, avatar: { kind: 'alive', packId } }
  })
  const layout = await h.rpc('overlays.layout.get')
  await h.rpc('overlays.layout.set', {
    ...layout,
    buddy: {
      ...layout.buddy,
      showOnStream: true,
      showInRecording: true,
      horizontal: { x: 0.65, y: 0.55, w: 0.3, h: 0.4 },
      vertical: { x: 0.4, y: 0.65, w: 0.5, h: 0.3 }
    }
  })
  assert.equal((await state(h)).enabled, false, 'Room avatar must start off')
  await enable(h, true)
  await say(h)
  await waitFor(
    () =>
      h.eval(
        `return [...document.querySelectorAll('[data-testid="show-stage-avatar"] img')].some(i=>i.naturalWidth>0)`
      ),
    'pre-egress preview pixels decoded'
  )
  assert.equal((await state(h)).state, 'preview')
  report.avatar = {
    status: 'running',
    previewBeforeEgress: true,
    cases: [],
    managed: 'not-run',
    devices: 'not-run',
    productionQualified: false
  }
}

export async function exerciseAvatar({
  h,
  report,
  clients,
  newPage,
  programUrl,
  captureAudio,
  output
}) {
  const program = clients.find((c) => c.name === 'program').page
  const recording = await newPage('avatar-recording')
  const url = new URL(programUrl)
  url.searchParams.set('rec', '1')
  url.searchParams.set('token', h.web.tokenFor(h.showId, 'EG_parity_avatar_recording', 'recorder'))
  await recording.goto(url.toString())
  const consumers = [
    { name: 'program', page: program },
    { name: 'avatar-recording', page: recording }
  ]
  // Plan 249 S5: an animation-capable page draws the avatar as an atlas canvas.
  const drawn = async (page, kind) => page.locator(`[data-avatar-layer="${kind}"]`).count()
  const check = async (label, { avatar = true, bubble = true } = {}) => {
    for (const consumer of consumers) {
      await waitFor(
        async () =>
          Boolean(await drawn(consumer.page, 'avatar')) === avatar &&
          Boolean(await drawn(consumer.page, 'bubble')) === bubble,
        `${label}: ${consumer.name} layer state`
      )
      // Decode a finished full-page image artifact, not a file-size or ack check.
      const path = join(output, `avatar-${label}-${consumer.name}.png`)
      await consumer.page.screenshot({ path })
      const raw = runMedia(h.ffmpeg, [
        '-v',
        'error',
        '-i',
        path,
        '-vf',
        'scale=160:90',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1'
      ])
      const fraction = colorFraction(raw, MEDIA.colors.avatar)
      assert.ok(
        avatar ? fraction > 0.001 : fraction < 0.001,
        `${label}: ${consumer.name} character pixels`
      )
      if (bubble) {
        const pixels = await consumer.page
          .locator('img[data-avatar-layer="bubble"]')
          .evaluate((img) => {
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            const ctx = c.getContext('2d')
            ctx.drawImage(img, 0, 0)
            const data = ctx.getImageData(0, 0, c.width, c.height).data
            let ink = 0,
              porcelain = 0
            for (let i = 0; i < data.length; i += 4)
              if (data[i + 3] > 200) {
                if (data[i] < 60) ink++
                if (data[i] > 230) porcelain++
              }
            return { ink, porcelain }
          })
        assert.ok(pixels.ink > 10 && pixels.porcelain > 100, `${label}: text and bubble pixels`)
      }
    }
    report.avatar.cases.push(label)
  }
  await say(h)
  await check('stream-recording')
  await waitFor(
    async () => Object.keys((await state(h)).observed).length === 2,
    'separate applied output receipts'
  )
  await captureAudio('avatar-both-artifacts', clients)
  await h.eval('return window.__videorcSmokeScenePresets.camera(null)')
  await say(h)
  await check('camera-off')
  const guests = clients
    .filter((c) => c.name !== 'program')
    .map((_, i) => `g_${String(i + 1).repeat(22)}`)
  await h.rpc('cloud.stage.set', { layout: 'spotlight', onStage: guests, spotlight: guests[0] })
  await say(h)
  await check('guest-spotlight')
  await waitFor(
    async () => !(await drawn(program, 'bubble')) && !(await drawn(recording, 'bubble')),
    'bubble expiry',
    15000
  )
  await check('expired', { bubble: false })
  await enable(h, false)
  await check('hidden', { avatar: false, bubble: false })
  await enable(h, true)
  await say(h)
  await check('shown-again')
  const layout = await h.rpc('overlays.layout.get')
  await h.rpc('overlays.layout.set', {
    ...layout,
    buddy: { ...layout.buddy, showOnStream: false, showInRecording: true }
  })
  await waitFor(
    async () => !(await drawn(program, 'avatar')) && !!(await drawn(recording, 'avatar')),
    'record-only visibility'
  )
  report.avatar.cases.push('record-only')
  await h.rpc('overlays.layout.set', {
    ...layout,
    buddy: { ...layout.buddy, showOnStream: true, showInRecording: false }
  })
  await waitFor(
    async () => !!(await drawn(program, 'avatar')) && !(await drawn(recording, 'avatar')),
    'stream-only visibility'
  )
  report.avatar.cases.push('stream-only')
  await h.rpc('overlays.layout.set', layout)
  await program.reload()
  await say(h)
  await check('reconnect-current-state')
  // Fail the real consumer's decode. It must not certify the new revision.
  await program.evaluate(() => {
    window.__avatarDecode = HTMLImageElement.prototype.decode
    HTMLImageElement.prototype.decode = function () {
      return Promise.reject(new Error('fixture asset failure'))
    }
  })
  await say(h)
  await waitFor(
    async () => (await state(h)).state === 'waiting',
    'asset failure remains unconfirmed'
  )
  report.avatar.cases.push('asset-failure')
  await program.evaluate(() => {
    HTMLImageElement.prototype.decode = window.__avatarDecode
    delete window.__avatarDecode
  })
  await enable(h, false)
  await enable(h, true)
  await say(h)
  await check('asset-recovery')
  for (const guest of clients.filter((c) => c.name !== 'program'))
    assert.equal(
      await guest.page.locator('[data-avatar-layer]').count(),
      0,
      'S4 grants no guest graphics'
    )
  report.avatar.cases.push('guest-projection-absent')
  await enable(h, false)
  report.avatar.status = 'passed-local-real-pages'
}
export function assertAvatarVideo(report) {
  for (const lane of ['program', 'avatar-recording'])
    assert.ok(
      report.videoMeasurements.frameHits[lane]?.avatar >= 5,
      `${lane}: finalized video artifact must contain character pixels`
    )
}
