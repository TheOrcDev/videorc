import assert from 'node:assert/strict'
import test from 'node:test'

import { renderMarkerFrame } from './card-markers.mjs'
import {
  DEFAULT_FRAME_OPTIONS,
  clipCovering,
  extractFrameArgs,
  judgeFeature,
  regionDiff,
  runFrameChecks
} from './frame-checks.mjs'

const W = 640
const H = 360
const options = DEFAULT_FRAME_OPTIONS

function cardFrame(sceneId = 1, stepIndex = 3) {
  return renderMarkerFrame({ width: W, height: H, sceneId, stepIndex })
}

/** The card with a bright overlay box painted over a normalized region. */
function withOverlay(frame, [rx, ry, rw, rh], color = [240, 240, 240]) {
  const out = new Uint8Array(frame)
  for (let y = Math.floor(ry * H); y < Math.floor((ry + rh) * H); y += 1) {
    for (let x = Math.floor(rx * W); x < Math.floor((rx + rw) * W); x += 1) {
      const offset = (y * W + x) * 3
      out[offset] = color[0]
      out[offset + 1] = color[1]
      out[offset + 2] = color[2]
    }
  }
  return out
}

test('extractFrameArgs asks ffmpeg for one scaled rgb24 frame', () => {
  const args = extractFrameArgs({ clipPath: '/c/clip.ts', atSeconds: 12.5, width: W, height: H })
  assert.deepEqual(args.slice(-9), [
    '-frames:v',
    '1',
    '-vf',
    'scale=640:360',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-'
  ])
  assert.ok(args.includes('12.5'))
  assert.equal(extractFrameArgs({ clipPath: 'x', atSeconds: -4, width: W, height: H })[5], '0')
})

test('regionDiff is near zero for identical frames and high for an overlay', () => {
  const base = cardFrame()
  assert.equal(regionDiff(base, base, W, H), 0)
  const overlay = withOverlay(base, options.regions.highlight)
  assert.ok(regionDiff(base, overlay, W, H, options.regions.highlight) > 0.5)
  // The caption band stays untouched by a highlight card.
  assert.ok(regionDiff(base, overlay, W, H, options.regions.caption) < 0.08)
})

test('clipCovering picks the clip whose window holds the moment', () => {
  const clips = [
    { recordedAt: '2026-10-12T06:00:00.000Z', seconds: 120, clipFile: '/c/a.ts' },
    { recordedAt: '2026-10-12T06:10:00.000Z', seconds: 120, clipFile: '/c/b.ts' }
  ]
  const hit = clipCovering(clips, Date.parse('2026-10-12T06:10:30.000Z'), 2)
  assert.equal(hit.clip.clipFile, '/c/b.ts')
  assert.equal(hit.offsetInClipSeconds, 32)
  assert.equal(clipCovering(clips, Date.parse('2026-10-12T06:05:00.000Z')), null)
  assert.equal(clipCovering([{ recordedAt: 'x', seconds: 10, clipFile: '/c' }], 0), null)
})

test('judgeFeature: scene markers, takeover cover, highlight presence', () => {
  const ctx = { width: W, height: H, options }
  const base = cardFrame(1, 3)
  const scene2 = cardFrame(2, 4)
  const frames = (frame) => [
    { offsetSeconds: 2, frame },
    { offsetSeconds: 5, frame }
  ]
  assert.equal(
    judgeFeature({ kind: 'scene', sceneId: 2 }, frames(scene2), base, ctx).status,
    'pass'
  )
  const wrong = judgeFeature({ kind: 'scene', sceneId: 2 }, frames(base), base, ctx)
  assert.equal(wrong.status, 'fail')
  assert.match(wrong.reason, /reads 1\/1, expected 2/)
  const blank = new Uint8Array(W * H * 3).fill(40)
  assert.equal(
    judgeFeature({ kind: 'scene', sceneId: 2 }, frames(blank), base, ctx).status,
    'needs-eyes'
  )
  assert.equal(
    judgeFeature({ kind: 'scene', sceneId: 2 }, frames(null), base, ctx).status,
    'needs-eyes'
  )

  const covered = withOverlay(base, [0, 0, 1, 1], [60, 70, 80])
  assert.equal(
    judgeFeature({ kind: 'takeover', shown: true }, frames(covered), base, ctx).status,
    'pass'
  )
  const stillCard = judgeFeature({ kind: 'takeover', shown: true }, frames(base), base, ctx)
  assert.equal(stillCard.status, 'fail')
  assert.equal(
    judgeFeature({ kind: 'takeover', shown: false }, frames(base), covered, ctx).status,
    'pass'
  )

  const card = withOverlay(base, options.regions.highlight)
  assert.equal(judgeFeature({ kind: 'highlight' }, frames(card), base, ctx).status, 'pass')
  const missing = judgeFeature({ kind: 'highlight' }, frames(base), base, ctx)
  assert.equal(missing.status, 'fail')
  assert.match(missing.reason, /highlight missing from frames/)
  assert.equal(judgeFeature({ kind: 'caption' }, frames(base), null, ctx).status, 'needs-eyes')
})

test('runFrameChecks: no clip is needs-eyes, a covering clip is judged and frames are written', async () => {
  const base = cardFrame(1, 3)
  const scene2 = cardFrame(2, 4)
  const features = [
    { id: 'scene-a', kind: 'scene', at: '2026-10-12T06:00:30.000Z', sceneId: 2 },
    { id: 'highlight-a', kind: 'highlight', at: '2026-10-12T06:01:00.000Z' },
    { id: 'orphan', kind: 'scene', at: '2026-10-12T07:00:00.000Z', sceneId: 1 },
    { id: 'note', kind: 'needs-eyes', question: 'ignored by frame checks' }
  ]
  const clips = [{ recordedAt: '2026-10-12T06:00:00.000Z', seconds: 120, clipFile: '/c/a.ts' }]
  const written = []
  const results = await runFrameChecks({
    runDir: '/run',
    features,
    clips,
    exists: () => true,
    write: async (path) => {
      written.push(path)
    },
    extract: async ({ atSeconds }) => {
      // Scene switch at t=30: frames after it show scene 2; the highlight at
      // t=60 never shows up (frames equal the baseline).
      if (atSeconds >= 31 && atSeconds <= 36) return scene2
      return base
    }
  })
  assert.deepEqual(
    results.map((entry) => [entry.id, entry.status]),
    [
      ['scene-a', 'pass'],
      ['highlight-a', 'fail'],
      ['orphan', 'needs-eyes']
    ]
  )
  assert.equal(results[0].frames.length, 0)
  assert.deepEqual(results[1].frames, [
    'frames/highlight-a-plus2s.png',
    'frames/highlight-a-plus5s.png',
    'frames/highlight-a-baseline.png'
  ])
  assert.equal(written.length, 3)
  assert.match(results[2].reason, /no clip covers/)

  const noClips = await runFrameChecks({ runDir: '/run', features, clips: [], exists: () => false })
  assert.ok(noClips.every((entry) => entry.status === 'needs-eyes'))
  assert.match(noClips[0].reason, /clipPull off/)
})
