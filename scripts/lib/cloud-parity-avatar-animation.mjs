/** Maintained S5 real-page acceptance (`pnpm smoke:cloud-parity -- --case avatar-animation`).
 * Never imported by lightweight tests. Device and managed qualification stay
 * separate. No paid calls or AI: reactions are manual, the bubble is Say.
 *
 * Reference: the desktop producer's own simulation (`roomAvatarMotion()`),
 * the same rules the compositor runs (pinned cell by cell in
 * buddy-animator.test.ts). Each real program page publishes, on its atlas
 * canvas, the public cell id and the show tick it drew. At every tick seen
 * by both, the page must draw the producer's cell for its orientation. The
 * desktop's own Program preview (Show stage) is held to the same rule: it
 * draws the producer's simulation, so a still or frozen preview fails.
 */
import assert from 'node:assert/strict'
import { waitFor } from './cloud-managed-smoke.mjs'

const probe = (h) => h.eval('return window.__videorcSmokeScenePresets.roomAvatarMotion()')
const enable = (h, value) => h.eval(`return window.__videorcSmokeScenePresets.roomAvatar(${value})`)
const drawn = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-avatar-layer="avatar"]')
    return canvas
      ? {
          cell: canvas.dataset.avatarCell ?? null,
          tick: Number(canvas.dataset.avatarTick),
          stills: document.querySelectorAll('img[data-avatar-layer="avatar"]').length
        }
      : null
  })
/** The desktop Program preview's atlas canvas, read in the app's renderer. */
const previewDrawn = (h) =>
  h.eval(`const root = document.querySelector('[data-testid="show-stage-avatar"]')
    const canvas = root && root.querySelector('canvas[data-avatar-layer="avatar"]')
    return canvas
      ? {
          cell: canvas.dataset.avatarCell ?? null,
          tick: Number(canvas.dataset.avatarTick),
          stills: root.querySelectorAll('img[data-avatar-layer="avatar"]').length
        }
      : null`)

/** Sample the desktop reference and every page for `ms`; return ordered (tick, cell) runs. */
async function sample(h, pages, ms) {
  const reference = new Map()
  const seen = new Map(pages.map((p) => [p.name, new Map()]))
  const until = Date.now() + ms
  while (Date.now() < until) {
    const ref = await probe(h)
    if (ref) reference.set(ref.tick, ref.cells)
    for (const p of pages) {
      const d = await p.read()
      if (d && Number.isFinite(d.tick)) seen.get(p.name).set(d.tick, d.cell)
    }
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  return { reference, seen }
}

function compare({ reference, seen }, pages, label, minimum = 20) {
  for (const p of pages) {
    let common = 0
    for (const [tick, cell] of seen.get(p.name)) {
      const ref = reference.get(tick)
      if (!ref) continue
      common++
      assert.equal(
        cell,
        ref[p.orientation],
        `${label}: ${p.name} tick ${tick} draws the desktop's pose`
      )
    }
    assert.ok(
      common >= minimum,
      `${label}: ${p.name} shares ${common} ticks with the desktop (< ${minimum})`
    )
  }
}

/** Contiguous runs of `cell` in tick order: one press, one run. */
function runsOf(map, cell) {
  let runs = 0
  let inside = false
  for (const [, id] of [...map].sort((a, b) => a[0] - b[0])) {
    if (id === cell && !inside) runs++
    inside = id === cell
  }
  return runs
}

export async function exerciseAvatarAnimation({ h, report, clients, newPage, programUrl }) {
  const program = clients.find((c) => c.name === 'program').page
  const recording = await newPage('avatar-animation-recording')
  const url = new URL(programUrl)
  url.searchParams.set('rec', '1')
  url.searchParams.set('token', h.web.tokenFor(h.showId, 'EG_parity_avatar_recording', 'recorder'))
  await recording.goto(url.toString())
  const pages = [
    { name: 'program', read: () => drawn(program), orientation: 'h' },
    { name: 'avatar-recording', read: () => drawn(recording), orientation: 'h' },
    { name: 'desktop-preview', read: () => previewDrawn(h), orientation: 'h' }
  ]
  report.avatarAnimation = {
    status: 'running',
    cases: [],
    managed: 'not-run',
    devices: 'not-run',
    productionQualified: false
  }
  const done = (name) => report.avatarAnimation.cases.push(name)

  await enable(h, true)
  for (const p of pages)
    await waitFor(async () => {
      const d = await p.read()
      return d && d.stills === 0 && Number.isFinite(d.tick)
    }, `${p.name}: negotiated atlas layer animating`)
  done('negotiated-atlas')

  // Idle life: breathing, blinks and glances on the producer's seed.
  compare(await sample(h, pages, 15000), pages, 'idle', 60)
  done('idle-poses')

  // One press, one reaction, on every output, at the same ticks.
  await h.rpc('cohost.pet.react', { reaction: 'wave' })
  const pressed = await sample(h, pages, 4000)
  compare(pressed, pages, 'reaction')
  for (const p of pages)
    assert.equal(runsOf(pressed.seen.get(p.name), 'wave'), 1, `${p.name}: wave once`)
  done('reaction-once')

  // Talk cadence follows the producer's talk steps.
  await h.rpc('cohost.utterance.say', { text: 'Parity animation talk cadence fixture line.' })
  const talking = await sample(h, pages, 3000)
  compare(talking, pages, 'talk')
  assert.ok(
    [...talking.reference.values()].some((cells) => /^talk-/.test(cells.h ?? '')),
    'the fixture pack talks with its talk frames'
  )
  done('talk-cadence')

  // Late join: a reloaded consumer starts from a keyframe, never replays history.
  await recording.reload()
  await waitFor(
    async () => Number.isFinite((await drawn(recording))?.tick),
    'rejoined consumer animating'
  )
  const rejoined = await sample(h, pages, 6000)
  compare(rejoined, pages, 'late-join')
  assert.equal(
    runsOf(rejoined.seen.get('avatar-recording'), 'wave'),
    0,
    'an expired reaction never replays'
  )
  done('late-join')

  await enable(h, false)
  for (const p of pages)
    await waitFor(async () => (await p.read()) === null, `${p.name}: hidden avatar removed`)
  done('hidden')
  report.avatarAnimation.status = 'passed-local-real-pages'
}
