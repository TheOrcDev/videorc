import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DECKS,
  SCREENS,
  baselinePath,
  deckHtml,
  needsLook,
  pickScreens,
  rowRanges,
  rowsFor,
  shootingOrder
} from './gpui-gallery.mjs'
import { parseParity } from './gpui-parity.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const parsed = parseParity(readFileSync(join(repoRoot, 'docs', 'gpui', 'parity.md'), 'utf8'))
const manifest = JSON.parse(
  readFileSync(join(repoRoot, 'docs', 'gpui', 'baseline-manifest.json'), 'utf8')
)

test('every screen covers parity rows and sits in a deck', () => {
  const decks = new Set(DECKS.map((deck) => deck.id))
  const ids = new Set()
  for (const screen of SCREENS) {
    assert.ok(!ids.has(screen.id), `${screen.id} is listed twice`)
    ids.add(screen.id)
    assert.ok(decks.has(screen.deck), `${screen.id} names no deck`)
    assert.ok(rowsFor(parsed, screen).rows.length > 0, `${screen.id} matches no parity row`)
  }
})

test('every baseline pair is a shot in the S0.10 manifest', () => {
  const shots = new Set(manifest.entries.map((entry) => entry.path))
  for (const screen of SCREENS.filter((s) => s.baseline)) {
    for (const look of ['dark', 'light']) {
      const path = baselinePath(screen, look)
      assert.ok(shots.has(path), `${screen.id} pairs with ${path}, which the baseline lacks`)
    }
  }
})

test('first run is shot last, and a narrowed list keeps its order', () => {
  const order = shootingOrder()
  const firstRun = order.findIndex((screen) => screen.id.startsWith('first-run-'))
  assert.ok(order.slice(firstRun).every((screen) => screen.last))
  assert.deepEqual(
    pickScreens('studio,settings-*').map((screen) => screen.id),
    [
      'studio',
      'settings-general',
      'settings-permissions',
      'settings-shortcuts',
      'settings-remote',
      'settings-about'
    ]
  )
  assert.throws(() => pickScreens('nope'), /nope/)
})

test('a scrolled screen is its page shot again lower down, picked by the prefix', () => {
  assert.deepEqual(
    pickScreens('avatar-profile*').map((screen) => screen.id),
    ['avatar-profile', 'avatar-profile-2', 'avatar-profile-3']
  )
  for (const screen of SCREENS.filter((s) => s.scroll)) {
    assert.ok(screen.scroll.dy > 0, `${screen.id} scrolls down`)
    assert.ok(screen.open && !screen.toast, `${screen.id} opens a page to scroll`)
    // Avatar below-the-fold shots pair with scroll-N; Vertical stream reuses
    // the Electron baseline's vertical-leg state.
    assert.ok(
      /^scroll-\d+$/.test(screen.baseline.state) || screen.baseline.state === 'vertical-leg',
      `${screen.id} pairs with a scrolled or vertical-leg shot`
    )
  }
  assert.equal(
    baselinePath(
      SCREENS.find((s) => s.id === 'avatar-profile-2'),
      'dark'
    ),
    'avatar-profile/scroll-2-1280x800-dark.png'
  )
})

test('row ranges join neighbours', () => {
  assert.equal(rowRanges(['P003', 'P001', 'P002', 'P010', 'P1200']), 'P001–P003, P010, P1200')
})

test('a ticked or unchanged screen stays off the page', () => {
  const entry = (open, digest, changedShare) => ({
    id: 'studio',
    parity: { open, rows: [{ id: 'P1' }] },
    shots: [{ look: 'dark', gpui: { digest }, changedShare }]
  })
  const previous = { screens: [entry(1, 'aaa')] }
  assert.equal(needsLook(entry(0, 'bbb'), null), false)
  assert.equal(needsLook(entry(1, 'aaa'), previous), false)
  assert.equal(needsLook(entry(1, 'bbb', 0.0001), previous), false)
  assert.equal(needsLook(entry(1, 'bbb', 0.05), previous), true)
  assert.equal(needsLook(entry(1, 'bbb'), null), true)
})

test('a deck is a question page with one question per screen', () => {
  const entries = SCREENS.filter((screen) => screen.deck === 'pages').map((screen) => ({
    ...screen,
    parity: rowsFor(parsed, screen),
    shots: [
      { look: 'dark', gpui: { image: `img/${screen.id}-dark-gpui.jpg` } },
      { look: 'light', gpui: { error: 'not shot' } }
    ]
  }))
  const html = deckHtml({ deck: DECKS[1], entries, date: '2026-11-25', sha: 'abc1234' })
  assert.match(html, /<meta name="ghostex-page" content="v2">/)
  assert.match(html, /<title>GPUI gallery: 2026-11-25 abc1234, /)
  assert.equal(html.match(/<gx-question /g).length, entries.length)
  assert.match(html, /<gx-choice value="Small issues">/)
})
