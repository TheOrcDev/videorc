import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateNotesOverlayArtifactMetrics,
  evaluateOverlayArtifactPhases,
  measureNotesOverlayMarkerPixelsFromRgb,
  measureOverlayMarkerFramesFromRgb
} from './notes-overlay-artifact-gate.mjs'

describe('notes overlay artifact gate', () => {
  it('passes when sampled frames do not contain the red smoke marker', () => {
    const rgb = Buffer.alloc(4 * 2 * 3 * 2)

    const metrics = measureNotesOverlayMarkerPixelsFromRgb(rgb, { width: 4, height: 2 })
    const verdict = evaluateNotesOverlayArtifactMetrics(metrics)

    assert.equal(metrics.sampledFrames, 2)
    assert.equal(metrics.maxMarkerPixels, 0)
    assert.equal(verdict.pass, true)
  })

  it('fails when a red Notes marker covers part of any sampled frame', () => {
    const rgb = Buffer.alloc(4 * 2 * 3)
    for (let pixel = 0; pixel < 4; pixel += 1) {
      const offset = pixel * 3
      rgb[offset] = 255
      rgb[offset + 1] = 0
      rgb[offset + 2] = 0
    }

    const metrics = measureNotesOverlayMarkerPixelsFromRgb(rgb, { width: 4, height: 2 })
    const verdict = evaluateNotesOverlayArtifactMetrics(metrics, { maxMarkerPixelRatio: 0.1 })

    assert.equal(metrics.maxMarkerPixels, 4)
    assert.equal(metrics.maxMarkerPixelRatio, 0.5)
    assert.equal(verdict.pass, false)
    assert.match(verdict.failures.join('\n'), /red smoke marker leaked/)
  })

  it('does not count magenta or yellow stimulus colors as the red Notes marker', () => {
    const rgb = Buffer.from([255, 43, 214, 255, 232, 74, 0, 229, 255, 255, 255, 255])

    const metrics = measureNotesOverlayMarkerPixelsFromRgb(rgb, { width: 2, height: 2 })
    const verdict = evaluateNotesOverlayArtifactMetrics(metrics)

    assert.equal(metrics.maxMarkerPixels, 0)
    assert.equal(verdict.pass, true)
  })
})

// Plan 215 C5: the Stream Manager invisibility smoke judges three spans of
// one recording: hidden (absent), shown (present, proving the gate sees the
// window), hidden again after a toggle mid-recording (absent).
describe('overlay artifact phases', () => {
  it('measures the marker per frame in sample order', () => {
    const rgb = Buffer.alloc(2 * 2 * 3 * 3)
    // Frame 1 (bytes 12..24): two red pixels of four.
    rgb[12] = 255
    rgb[15] = 255
    assert.deepEqual(measureOverlayMarkerFramesFromRgb(rgb, { width: 2, height: 2 }), [
      0, 0.5, 0
    ])
  })

  it('passes hidden, shown, hidden spans and names the span that fails', () => {
    // 2 fps: frame i is at i * 500 ms. Hidden 0-2 s, shown 2-4 s, hidden 4-6 s.
    const ratios = [0, 0, 0, 0, 0.4, 0.4, 0.4, 0.4, 0, 0.001, 0, 0]
    const phases = [
      { name: 'hidden', fromMs: 0, toMs: 2000, expect: 'absent' },
      { name: 'shown', fromMs: 2000, toMs: 4000, expect: 'present' },
      { name: 'hidden again', fromMs: 4000, toMs: 6000, expect: 'absent' }
    ]
    const verdict = evaluateOverlayArtifactPhases(ratios, { sampleFps: 2, phases })
    assert.equal(verdict.pass, true)
    assert.deepEqual(
      verdict.metrics.phases.map((phase) => [phase.name, phase.sampledFrames]),
      [
        ['hidden', 4],
        ['shown', 4],
        ['hidden again', 4]
      ]
    )
    assert.equal(verdict.metrics.maxMarkerPixelRatio, 0.4)

    const leaked = evaluateOverlayArtifactPhases([...ratios.slice(0, 9), 0.01, 0, 0], {
      sampleFps: 2,
      phases
    })
    assert.equal(leaked.pass, false)
    assert.match(leaked.failures.join('\n'), /phase "hidden again" leaked/)

    const blind = evaluateOverlayArtifactPhases(
      ratios.map(() => 0),
      { sampleFps: 2, phases }
    )
    assert.equal(blind.pass, false)
    assert.match(blind.failures.join('\n'), /phase "shown" never showed the red smoke marker/)

    const short = evaluateOverlayArtifactPhases(ratios.slice(0, 6), { sampleFps: 2, phases })
    assert.equal(short.pass, false)
    assert.match(short.failures.join('\n'), /phase "hidden again" .* sampled no decoded frames/)
  })
})
