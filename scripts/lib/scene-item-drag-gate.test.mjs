import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  draftCarriesRectFor,
  evaluateIdleSelection,
  evaluateItemDrag,
  normalizeToCanvas,
  overlayRectAsStage
} from './scene-item-drag-gate.mjs'

const STAGE_ID = 'banner:strip'
const dropped = { x: 0.1, y: 0.2, width: 0.6, height: 0.1 }
const sample = (x, matchMs = 12) => ({
  ghost: { ...dropped, x },
  draft: { sourceId: STAGE_ID, transform: { ...dropped, x } },
  matchMs
})
const hold = { sourceId: STAGE_ID }
const releasedDraft = { sourceId: STAGE_ID, transform: dropped }

describe('scene item drag gate', () => {
  it('normalizes a DOM box to the canvas', () => {
    assert.deepEqual(
      normalizeToCanvas(
        { x: 150, y: 80, width: 200, height: 45 },
        { x: 100, y: 35, width: 800, height: 450 }
      ),
      { x: 0.0625, y: 0.1, width: 0.25, height: 0.1 }
    )
    assert.deepEqual(overlayRectAsStage({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), {
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4
    })
  })

  it('matches a draft only for the dragged item and its rect', () => {
    assert.equal(draftCarriesRectFor(releasedDraft, STAGE_ID, dropped), true)
    assert.equal(draftCarriesRectFor(releasedDraft, STAGE_ID, { ...dropped, x: 0.2 }), false)
    assert.equal(draftCarriesRectFor(releasedDraft, 'overlay:buddy', dropped), false)
    assert.equal(draftCarriesRectFor(hold, STAGE_ID, dropped), false, 'a hold carries no rect')
    assert.equal(draftCarriesRectFor(null, STAGE_ID, dropped), false)
  })

  it('passes a live drag that followed the pointer, held the drop and rested on the hold', () => {
    const gate = evaluateItemDrag({
      stageId: STAGE_ID,
      mode: 'live',
      samples: [sample(0.3), sample(0.2), sample(0.1)],
      released: dropped,
      after: [releasedDraft, releasedDraft, hold],
      rest: hold,
      committed: dropped
    })
    assert.deepEqual(gate, { ok: true, failures: [] })
  })

  it('fails a drag whose picture stayed put, flashed back, or landed elsewhere', () => {
    const gate = evaluateItemDrag({
      stageId: STAGE_ID,
      mode: 'live',
      samples: [sample(0.3, null)],
      released: dropped,
      after: [{ sourceId: STAGE_ID, transform: { ...dropped, x: 0.5 } }],
      rest: null,
      committed: { ...dropped, x: 0.4 }
    })
    assert.equal(gate.ok, false)
    assert.match(gate.failures.join('\n'), /never followed the drag/)
    assert.match(gate.failures.join('\n'), /did not land where it was shown/)
    assert.match(gate.failures.join('\n'), /not the drop/)
    assert.match(gate.failures.join('\n'), /not the chrome-only hold/)
    assert.equal(
      evaluateItemDrag({
        stageId: STAGE_ID,
        mode: 'live',
        samples: [],
        released: dropped,
        after: [],
        rest: hold,
        committed: null
      }).failures.length,
      2
    )
  })

  it('wants the floating preview to rest with no draft at all', () => {
    const base = {
      stageId: STAGE_ID,
      mode: 'floating',
      samples: [sample(0.1)],
      released: dropped,
      after: [releasedDraft],
      committed: dropped
    }
    assert.equal(evaluateItemDrag({ ...base, rest: null }).ok, true)
    assert.match(evaluateItemDrag({ ...base, rest: hold }).failures[0], /rested on a draft/)
  })

  it('holds the selection on the live canvas only', () => {
    assert.equal(evaluateIdleSelection({ stageId: STAGE_ID, mode: 'live', draft: hold }).ok, true)
    assert.match(
      evaluateIdleSelection({ stageId: STAGE_ID, mode: 'live', draft: null }).failures[0],
      /no hold/
    )
    assert.match(
      evaluateIdleSelection({
        stageId: STAGE_ID,
        mode: 'live',
        draft: { sourceId: 'overlay:buddy' }
      }).failures[0],
      /names overlay:buddy/
    )
    assert.match(
      evaluateIdleSelection({ stageId: STAGE_ID, mode: 'live', draft: releasedDraft }).failures[0],
      /chrome-only/
    )
    assert.equal(
      evaluateIdleSelection({ stageId: STAGE_ID, mode: 'floating', draft: null }).ok,
      true
    )
    assert.match(
      evaluateIdleSelection({ stageId: STAGE_ID, mode: 'floating', draft: hold }).failures[0],
      /at rest/
    )
  })
})
