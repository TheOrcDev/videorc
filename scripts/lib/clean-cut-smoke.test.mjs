import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  CLEAN_CUT_SMOKE_TIMELINE,
  REQUIRED_CLEAN_CUT_RULES,
  compareRemovals,
  compareShapes,
  countByKind,
  detectSpeechBursts,
  expectedCleanCutRemovals,
  frameDurationMs,
  frameToMs,
  joinFrameIndices,
  keptFrameCount,
  keptRangesFromEdl,
  layScriptOverBursts,
  measuredShape,
  msToFrame,
  parseRustNumericConstants,
  parseSrtCues,
  readCleanCutRules,
  scenarioProblems,
  streamCounts,
  timelineShape
} from './clean-cut-smoke.mjs'

const RULES_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'crates',
  'videorc-backend',
  'src',
  'clean_cut',
  'rules.rs'
)
const RULES = {
  HEAD_LEAD_MS: 300,
  TAIL_TRAIL_MS: 600,
  SILENCE_MIN_GAP_MS: 1_000,
  SILENCE_KEEP_MS: 400,
  FILLER_PAD_MS: 30,
  DROP_CONFIDENCE_ON: 0.6,
  SLIVER_MAX_MS: 250
}
const FPS30 = { num: 30, den: 1 }
const NTSC = { num: 30_000, den: 1_001 }

/** s16le mono PCM: `[ms, peak]` segments, a 440 Hz sine where peak > 0. */
function pcm(segments, sampleRate = 16_000) {
  const total = segments.reduce((sum, [ms]) => sum + Math.round((ms * sampleRate) / 1_000), 0)
  const bytes = Buffer.alloc(total * 2)
  let offset = 0
  for (const [ms, peak] of segments) {
    const count = Math.round((ms * sampleRate) / 1_000)
    for (let index = 0; index < count; index += 1) {
      const value = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * peak
      bytes.writeInt16LE(Math.round(value * 32_767), (offset + index) * 2)
    }
    offset += count
  }
  return bytes
}

describe('clean cut smoke helpers', () => {
  it('reads the scripted take as lead, sentences, pauses and tail', () => {
    const shape = timelineShape(CLEAN_CUT_SMOKE_TIMELINE)
    assert.equal(shape.leadMs, 3_000)
    assert.equal(shape.tailMs, 4_000)
    assert.equal(shape.totalMs, 37_900)
    assert.deepEqual(
      shape.sentences.map((sentence) => sentence.gapAfterMs),
      [800, 800, 4_500, 5_000, 4_000, null]
    )
    assert.deepEqual(
      shape.sentences.map((sentence) => sentence.retaken),
      [false, true, false, false, false, false]
    )
    assert.equal(shape.sentences[3].text, 'So um that is the whole trick.')
  })

  it('reads the rule numbers from rules.rs and refuses a file without them', () => {
    assert.deepEqual(
      parseRustNumericConstants(
        [
          '/// A doc line.',
          'pub const HEAD_LEAD_MS: u64 = 1_300;',
          'pub const DROP_CONFIDENCE_ON: f64 = 0.65;',
          'pub const SENTENCE_MAX_WORDS: usize = 40;',
          'pub const FILLER_LEXICON: &[&str] = &["um"];',
          'const PRIVATE_MS: u64 = 7;'
        ].join('\n')
      ),
      { HEAD_LEAD_MS: 1_300, DROP_CONFIDENCE_ON: 0.65, SENTENCE_MAX_WORDS: 40 }
    )
    const rules = readCleanCutRules(readFileSync(RULES_PATH, 'utf8'))
    for (const name of REQUIRED_CLEAN_CUT_RULES) {
      assert.ok(Number.isFinite(rules[name]) && rules[name] > 0, `${name} = ${rules[name]}`)
    }
    assert.throws(
      () => readCleanCutRules('pub const HEAD_LEAD_MS: u64 = 300;'),
      /no longer defines TAIL_TRAIL_MS/
    )
  })

  it('keeps the scripted take valid for the rules in rules.rs', () => {
    // A retune of decision 16 that breaks the smoke's take fails here first,
    // with the reason, instead of halfway through a recording.
    const rules = readCleanCutRules(readFileSync(RULES_PATH, 'utf8'))
    assert.deepEqual(scenarioProblems(timelineShape(CLEAN_CUT_SMOKE_TIMELINE), rules), [])
  })

  it('names every way a take could not prove the cut list', () => {
    const take = (sentences, leadMs = 3_000, tailMs = 3_000) => ({ leadMs, tailMs, sentences })
    const sentence = (text, gapAfterMs, retaken = false) => ({
      text,
      speechMs: 2_000,
      gapAfterMs,
      retaken
    })
    assert.deepEqual(
      scenarioProblems(
        take([sentence('One two.', 800), sentence('Three four.', 4_000), sentence('Five.', null)]),
        RULES
      ),
      []
    )
    const problems = scenarioProblems(
      take(
        [
          sentence('Um we start.', 1_000),
          sentence('This one. Goes', 3_000, true),
          sentence('Let me say that again, done.', null)
        ],
        200,
        100
      ),
      RULES
    )
    assert.ok(problems.some((problem) => problem.includes('lead silence')))
    assert.ok(problems.some((problem) => problem.includes('tail silence')))
    assert.ok(problems.some((problem) => problem.includes('after sentence 1 (1000 ms)')))
    assert.ok(problems.some((problem) => problem.includes('retaken sentence 2')))
    assert.ok(problems.some((problem) => problem.includes('"Um"')))
    assert.ok(problems.some((problem) => problem.includes('sentence 2 ends early at "one."')))
    assert.ok(problems.some((problem) => problem.includes('sentence 2 must end')))
    const unmarked = scenarioProblems(
      take([sentence('One.', 800), sentence('Two.', 800, true), sentence('Three.', null)]),
      RULES
    )
    assert.ok(unmarked.some((problem) => problem.includes('would drop []')))
  })

  it('finds speech bursts, bridging dropouts and ignoring blips', () => {
    const bursts = detectSpeechBursts(
      pcm([
        [1_000, 0],
        [600, 0.12],
        [40, 0],
        [400, 0.12],
        [1_000, 0],
        [100, 0.12],
        [500, 0],
        [900, 0.12],
        [300, 0]
      ])
    )
    assert.deepEqual(bursts, [
      { startMs: 1_000, endMs: 2_040 },
      { startMs: 3_640, endMs: 4_540 }
    ])
    assert.deepEqual(detectSpeechBursts(pcm([[2_000, 0]])), [])
    assert.deepEqual(detectSpeechBursts(Buffer.alloc(0)), [])
  })

  it('measures a take and compares it with the script', () => {
    const scripted = timelineShape([
      { silenceMs: 1_000 },
      { speechMs: 1_000, text: 'One.' },
      { silenceMs: 800 },
      { speechMs: 600, text: 'Two.', retaken: true },
      { silenceMs: 500 }
    ])
    const measured = measuredShape(
      [
        { startMs: 1_100, endMs: 2_080 },
        { startMs: 2_900, endMs: 3_480 }
      ],
      4_000,
      scripted.sentences
    )
    assert.equal(measured.leadMs, 1_100)
    assert.equal(measured.tailMs, 520)
    assert.deepEqual(measured.sentences, [
      { text: 'One.', speechMs: 980, retaken: false, gapAfterMs: 820 },
      { text: 'Two.', speechMs: 580, retaken: true, gapAfterMs: null }
    ])
    assert.deepEqual(compareShapes(measured, scripted, { toleranceMs: 50 }), [])
    assert.deepEqual(compareShapes(measured, scripted, { toleranceMs: 10 }), [
      'sentence 1 lasts 980 ms, the script says 1000 ms',
      'the pause after sentence 1 lasts 820 ms, the script says 800 ms',
      'sentence 2 lasts 580 ms, the script says 600 ms'
    ])
    assert.deepEqual(compareShapes(measuredShape([{ startMs: 0, endMs: 10 }], 20, []), scripted), [
      'measured 1 speech burst(s), the script has 2 sentence(s)'
    ])
  })

  it('lays the script over the bursts word by word', () => {
    const words = layScriptOverBursts(
      [{ text: 'So um that.' }, { text: 'Done.' }],
      [
        { startMs: 1_000, endMs: 2_000 },
        { startMs: 3_000, endMs: 3_500 }
      ]
    )
    assert.deepEqual(words, [
      { text: 'So', startMs: 1_000, endMs: 1_250 },
      { text: 'um', startMs: 1_250, endMs: 1_500, filler: true },
      { text: 'that.', startMs: 1_500, endMs: 2_000 },
      { text: 'Done.', startMs: 3_000, endMs: 3_500 }
    ])
    assert.throws(() => layScriptOverBursts([{ text: 'One.' }], []), /cannot be laid over 0/)
  })

  it('expects head, tail, silences, padded fillers and retakes from decision 16', () => {
    const sentences = [
      { text: 'Hello there.', retaken: false },
      { text: 'Wrong take.', retaken: true },
      { text: 'So um right.', retaken: false }
    ]
    const bursts = [
      { startMs: 2_000, endMs: 3_000 },
      { startMs: 3_800, endMs: 4_800 },
      { startMs: 8_000, endMs: 9_200 }
    ]
    const words = layScriptOverBursts(sentences, bursts)
    const expected = expectedCleanCutRemovals({
      words,
      sentences,
      bursts,
      durationMs: 12_000,
      rules: RULES
    })
    // "um" fills 8277-8554 between "So" and "right.": its 30 ms pads are
    // clamped to those neighbours, as `edl.rs` clamps them.
    assert.deepEqual(expected, [
      { kind: 'head', startMs: 0, endMs: 1_700 },
      { kind: 'retake', startMs: 3_800, endMs: 4_800 },
      { kind: 'silence', startMs: 5_000, endMs: 7_800 },
      { kind: 'filler', startMs: 8_277, endMs: 8_554 },
      { kind: 'tail', startMs: 9_800, endMs: 12_000 }
    ])
    assert.deepEqual(countByKind(expected), [
      { kind: 'head', count: 1 },
      { kind: 'retake', count: 1 },
      { kind: 'silence', count: 1 },
      { kind: 'filler', count: 1 },
      { kind: 'tail', count: 1 }
    ])
    assert.deepEqual(
      expectedCleanCutRemovals({
        words: [],
        sentences: [],
        bursts: [],
        durationMs: 1_000,
        rules: RULES
      }),
      []
    )
  })

  it('compares a cut list with the expected removals within a tolerance', () => {
    const expected = [
      { kind: 'head', startMs: 0, endMs: 1_700 },
      { kind: 'silence', startMs: 5_000, endMs: 7_800 }
    ]
    const actual = [
      { kind: 'silence', startMs: 5_000, endMs: 7_800, enabled: true },
      { kind: 'retake', startMs: 3_000, endMs: 4_000, enabled: false },
      { kind: 'head', startMs: 0, endMs: 1_700, enabled: true }
    ]
    assert.deepEqual(compareRemovals(actual, expected, { toleranceMs: 34 }), [])
    const drifted = compareRemovals(
      [
        { kind: 'head', startMs: 0, endMs: 1_767, enabled: true },
        { kind: 'gap', startMs: 5_000, endMs: 7_800, enabled: true }
      ],
      expected,
      { toleranceMs: 34 }
    )
    assert.equal(drifted.length, 2)
    assert.match(drifted[0], /head removal 1 spans 0-1767 ms, expected 0-1700 ms/)
    assert.match(drifted[1], /removal 2 is gap, expected silence/)
    assert.match(
      compareRemovals([], expected, { toleranceMs: 34 })[0],
      /expected 2 enabled removal\(s\) \[head 0-1700, silence 5000-7800\], the cut list has 0/
    )
  })

  it('mirrors the backend frame math', () => {
    assert.equal(frameDurationMs(FPS30), 1_000 / 30)
    assert.equal(msToFrame(1_000, FPS30), 30)
    assert.equal(msToFrame(1_017, FPS30), 31, 'nearest frame')
    assert.equal(frameToMs(31, FPS30), 1_033)
    // The same boundaries as `kept_spans_round_each_frame_boundary_once` (srt.rs).
    assert.deepEqual(
      [30, 300, 1_000, 1_001].map((frame) => frameToMs(frame, NTSC)),
      [1_001, 10_010, 33_367, 33_400]
    )
    assert.equal(msToFrame(1_001, NTSC), 30)

    const edl = {
      durationMs: 10_000,
      frameRate: FPS30,
      removals: [
        { startFrame: 0, endFrame: 30, enabled: true },
        { startFrame: 60, endFrame: 90, enabled: false },
        { startFrame: 100, endFrame: 130, enabled: true },
        { startFrame: 120, endFrame: 150, enabled: true },
        { startFrame: 290, endFrame: 400, enabled: true }
      ]
    }
    const ranges = keptRangesFromEdl(edl)
    assert.deepEqual(ranges, [
      { startFrame: 30, endFrame: 100 },
      { startFrame: 150, endFrame: 290 }
    ])
    assert.equal(keptFrameCount(ranges), 210)
    assert.deepEqual(joinFrameIndices(ranges), [70])
    assert.deepEqual(joinFrameIndices([{ startFrame: 0, endFrame: 10 }]), [])
    assert.deepEqual(keptRangesFromEdl({ ...edl, removals: [] }), [
      { startFrame: 0, endFrame: 300 }
    ])
  })

  it('reads SRT cues with or without index lines', () => {
    const cues = parseSrtCues(
      '1\r\n00:00:01,000 --> 00:00:03,240\r\nWelcome back\r\neveryone\r\n\r\n' +
        '00:00:03,500 --> 00:00:06.1\ntoday we build\n\n2\n00:00:07,000 --> 00:00:08,000\n\n' +
        'garbage --> here\nnot a cue\n'
    )
    assert.deepEqual(cues, [
      { startMs: 1_000, endMs: 3_240, text: 'Welcome back everyone' },
      { startMs: 3_500, endMs: 6_100, text: 'today we build' }
    ])
    assert.deepEqual(parseSrtCues(''), [])
  })

  it('counts streams by type', () => {
    assert.deepEqual(
      streamCounts({
        streams: [{ codec_type: 'video' }, { codec_type: 'audio' }, { codec_type: 'audio' }, {}]
      }),
      { video: 1, audio: 2, unknown: 1 }
    )
    assert.deepEqual(streamCounts(null), {})
  })
})
