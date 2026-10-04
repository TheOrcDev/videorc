import { describe, expect, it } from 'vitest'

import type { ClipMoment, CleanCutRemoval, CleanCutRemovalKind } from './backend'
import {
  CLEAN_CUT_KIND_GROUPS,
  EMPTY_CLEAN_CUT_DRAFT,
  activeWordIndex,
  addDraftManual,
  buildCleanCutParagraphs,
  cleanCutKindChips,
  cleanCutPins,
  cleanCutStats,
  cleanCutTranscriptItems,
  cutSkipRanges,
  draftChangeCount,
  effectiveRemovals,
  formatCutLength,
  navigableRemovals,
  normalizeTranscriptWords,
  prerollMs,
  rebaseDraft,
  removalRowIndex,
  removalTone,
  setRemovalsEnabled,
  stepRemoval,
  toggleKindGroup,
  toggleRemoval,
  updateEdlPayload,
  type CleanCutParagraph,
  type CleanCutTranscriptToken
} from './clean-cut-review'
import type { CleanCutTranscriptWord } from './clean-cut-view'

function removal(
  id: string,
  kind: CleanCutRemovalKind,
  startMs: number,
  endMs: number,
  enabled = true
): CleanCutRemoval {
  return {
    id,
    kind,
    startMs,
    endMs,
    startFrame: Math.round(startMs * 0.03),
    endFrame: Math.round(endMs * 0.03),
    reason: `${kind} reason`,
    enabled
  }
}

/** Words of `text`, 300 ms each with 100 ms between them, from `startMs`. */
function speak(text: string, startMs: number): CleanCutTranscriptWord[] {
  return text.split(' ').map((word, index) => ({
    text: word,
    startMs: startMs + index * 400,
    endMs: startMs + index * 400 + 300
  }))
}

function wordTokens(
  paragraph: CleanCutParagraph
): Array<Extract<CleanCutTranscriptToken, { type: 'word' }>> {
  return paragraph.tokens.filter(
    (token): token is Extract<CleanCutTranscriptToken, { type: 'word' }> => token.type === 'word'
  )
}

// "So today um we build it." (0–2.3 s), a 3 s pause, "We build it again." (5.3 s…)
const WORDS = [...speak('So today um we build it.', 1_000), ...speak('We build it again.', 6_300)]
const SEGMENTS = [
  { id: 's1', startMs: 1_000, endMs: 3_300 },
  { id: 's2', startMs: 6_300, endMs: 7_800 }
]
const SAVED: CleanCutRemoval[] = [
  removal('r1', 'head', 0, 700),
  removal('r2', 'filler', 1_770, 2_130),
  removal('r3', 'silence', 3_700, 5_900),
  removal('r4', 'retake', 1_000, 3_300, false),
  removal('r5', 'tail', 8_200, 9_000)
]

describe('kinds', () => {
  it('names the chips in the plan order, each with a semantic tone', () => {
    expect(CLEAN_CUT_KIND_GROUPS.map((group) => group.label)).toEqual([
      'Silences',
      'Ums',
      'Retakes',
      'False starts',
      'Start/end',
      'Your cuts'
    ])
    expect(removalTone('filler')).toBe('warning')
    expect(removalTone('retake')).toBe('destructive')
    expect(removalTone('false_start')).toBe('info')
    expect(removalTone('silence')).toBe('neutral')
  })

  it('writes short lengths for inline markers', () => {
    expect(formatCutLength(1_800)).toBe('1.8 s')
    expect(formatCutLength(12_400)).toBe('12 s')
    expect(formatCutLength(90_000)).toBe('1 min 30 s')
    expect(formatCutLength(120_000)).toBe('2 min')
  })
})

describe('the draft', () => {
  it('applies toggles, new manual cuts and deletions over the saved list, in time order', () => {
    const draft = addDraftManual(
      { ...EMPTY_CLEAN_CUT_DRAFT, toggles: new Map([['r4', true]]), removeManual: new Set() },
      { startMs: 6_000, endMs: 6_200 }
    )
    const effective = effectiveRemovals(SAVED, draft)
    expect(effective.find((entry) => entry.id === 'r4')?.enabled).toBe(true)
    expect(effective.map((entry) => entry.id)).toEqual(['r1', 'r4', 'r2', 'r3', 'draft:1', 'r5'])
    expect(effective.find((entry) => entry.id === 'draft:1')).toMatchObject({
      kind: 'manual',
      enabled: true
    })
  })

  it('flips one removal, and flipping it back leaves nothing to save', () => {
    const once = toggleRemoval(EMPTY_CLEAN_CUT_DRAFT, SAVED, 'r2')
    expect(once.toggles.get('r2')).toBe(false)
    expect(draftChangeCount(once)).toBe(1)
    const twice = toggleRemoval(once, SAVED, 'r2')
    expect(draftChangeCount(twice)).toBe(0)
    expect(toggleRemoval(EMPTY_CLEAN_CUT_DRAFT, SAVED, 'missing')).toBe(EMPTY_CLEAN_CUT_DRAFT)
  })

  it('toggles a whole kind: all cut becomes all kept, anything else becomes all cut', () => {
    const saved = [
      removal('a', 'retake', 0, 100, true),
      removal('b', 'retake', 200, 300, false),
      removal('c', 'filler', 400, 500, true)
    ]
    const allCut = toggleKindGroup(EMPTY_CLEAN_CUT_DRAFT, saved, 'retakes')
    expect([...allCut.toggles]).toEqual([['b', true]])
    const allKept = toggleKindGroup(allCut, saved, 'retakes')
    expect([...allKept.toggles]).toEqual([['a', false]])
    expect(toggleKindGroup(EMPTY_CLEAN_CUT_DRAFT, saved, 'false-starts')).toBe(
      EMPTY_CLEAN_CUT_DRAFT
    )
    // Silences cover pauses with sound too.
    const pauses = [removal('s', 'silence', 0, 100), removal('g', 'gap', 200, 300)]
    expect([...toggleKindGroup(EMPTY_CLEAN_CUT_DRAFT, pauses, 'silences').toggles]).toEqual([
      ['s', false],
      ['g', false]
    ])
  })

  it('sends one updateEdl payload with only what changed', () => {
    expect(updateEdlPayload('job-1', 3, EMPTY_CLEAN_CUT_DRAFT)).toEqual({
      jobId: 'job-1',
      revision: 3
    })
    let draft = setRemovalsEnabled(EMPTY_CLEAN_CUT_DRAFT, SAVED, ['r2', 'r4'], false)
    draft = addDraftManual(draft, { startMs: 6_000.4, endMs: 6_200.6 })
    draft = { ...draft, removeManual: new Set(['m1']) }
    expect(updateEdlPayload('job-1', 3, draft)).toEqual({
      jobId: 'job-1',
      revision: 3,
      removals: [{ id: 'r2', enabled: false }],
      addManual: [{ startMs: 6_000, endMs: 6_201 }],
      removeManual: ['m1']
    })
  })

  it('carries a draft onto a newer saved list after a revision conflict', () => {
    let draft = setRemovalsEnabled(EMPTY_CLEAN_CUT_DRAFT, SAVED, ['r2'], false)
    draft = setRemovalsEnabled(draft, SAVED, ['r4'], true)
    draft = { ...draft, removeManual: new Set(['m1', 'm9']) }
    const newer = [
      // r2 was switched off elsewhere already; r4 still differs; m1 exists.
      { ...SAVED[1], enabled: false },
      SAVED[3],
      removal('m1', 'manual', 7_000, 7_100)
    ]
    const rebased = rebaseDraft(draft, newer)
    expect([...rebased.toggles]).toEqual([['r4', true]])
    expect([...rebased.removeManual]).toEqual(['m1'])
  })
})

describe('chips, stats and the preview', () => {
  it('counts every removal of a kind, and says which are cut', () => {
    const chips = cleanCutKindChips(SAVED)
    expect(chips.map((chip) => [chip.group.id, chip.total, chip.cut, chip.state])).toEqual([
      ['silences', 1, 1, 'on'],
      ['fillers', 1, 1, 'on'],
      ['retakes', 1, 0, 'off'],
      ['false-starts', 0, 0, 'empty'],
      ['start-end', 2, 2, 'on']
    ])
    const mixed = cleanCutKindChips([
      removal('a', 'filler', 0, 100, true),
      removal('b', 'filler', 200, 300, false),
      removal('m', 'manual', 400, 500)
    ])
    expect(mixed.find((chip) => chip.group.id === 'fillers')?.state).toBe('mixed')
    expect(mixed.find((chip) => chip.group.id === 'manual')).toMatchObject({ total: 1, cut: 1 })
  })

  it('skips only what is cut', () => {
    expect(cutSkipRanges(SAVED)).toEqual([
      { startMs: 0, endMs: 700 },
      { startMs: 1_770, endMs: 2_130 },
      { startMs: 3_700, endMs: 5_900 },
      { startMs: 8_200, endMs: 9_000 }
    ])
  })

  it('starts from the saved length and moves it by exactly what the draft changes', () => {
    expect(
      cleanCutStats({ durationMs: 9_000, saved: SAVED, effective: SAVED, savedKeptMs: 5_000 })
    ).toEqual({ durationMs: 9_000, keptMs: 5_000, savedMs: 4_000, cuts: 4 })
    // Keeping the 2.2 s silence gives back 2.2 s.
    const effective = effectiveRemovals(SAVED, toggleRemoval(EMPTY_CLEAN_CUT_DRAFT, SAVED, 'r3'))
    expect(
      cleanCutStats({ durationMs: 9_000, saved: SAVED, effective, savedKeptMs: 5_000 })
    ).toMatchObject({ keptMs: 7_200, savedMs: 1_800, cuts: 3 })
    // Without a saved length, the draft is measured on its own: 9000 - 1860.
    expect(
      cleanCutStats({ durationMs: 9_000, saved: SAVED, effective, savedKeptMs: null })
    ).toMatchObject({ keptMs: 7_140 })
  })

  it("pins the report's moments in time order", () => {
    const moments: ClipMoment[] = [
      { startMs: 9_000, endMs: 12_000, reason: '', excerpt: ' wow ', source: 'chat' },
      {
        startMs: 2_000,
        endMs: 2_000,
        reason: "You said 'clip that'",
        excerpt: '',
        source: 'voice'
      },
      { startMs: 4_000, endMs: 4_000, reason: '', excerpt: '', source: 'manual' }
    ]
    expect(
      cleanCutPins(moments).map((pin) => [pin.startMs, pin.kind, pin.label, pin.excerpt])
    ).toEqual([
      [2_000, 'voice', "You said 'clip that'", ''],
      [4_000, 'manual', 'Marked', ''],
      [9_000, 'chat', 'Chat got busy', 'wow']
    ])
    expect(cleanCutPins(null)).toEqual([])
  })
})

describe('the transcript layout', () => {
  const paragraphs = buildCleanCutParagraphs({
    words: WORDS,
    segments: SEGMENTS,
    removals: SAVED,
    pins: [{ key: 'p', kind: 'voice', label: 'Marked', startMs: 6_300, excerpt: '' }]
  })

  it('breaks paragraphs at long pauses', () => {
    expect(paragraphs).toHaveLength(2)
    expect(wordTokens(paragraphs[0]).map((token) => token.text)).toEqual([
      'So',
      'today',
      'um',
      'we',
      'build',
      'it.'
    ])
  })

  it('maps each word to the removals over its midpoint, innermost first', () => {
    const [, , um, we] = wordTokens(paragraphs[0])
    expect(um.removalIds).toEqual(['r2', 'r4'])
    expect(we.removalIds).toEqual(['r4'])
    expect(wordTokens(paragraphs[1])[0].removalIds).toEqual([])
  })

  it('puts wordless cuts and pins inline, where they happen', () => {
    const first = paragraphs[0].tokens
    expect(first[0]).toMatchObject({ type: 'marker', removalId: 'r1', kind: 'head' })
    expect(first[first.length - 1]).toMatchObject({ type: 'marker', removalId: 'r3' })
    const second = paragraphs[1].tokens
    expect(second[0]).toMatchObject({ type: 'pin' })
    expect(second[second.length - 1]).toMatchObject({ type: 'marker', removalId: 'r5' })
    expect(paragraphs[0].removalIds).toEqual(expect.arrayContaining(['r1', 'r2', 'r3', 'r4']))
  })

  it('builds sentences itself when the transcript has none', () => {
    const words = [...speak('One two three.', 0), ...speak('Four five.', 1_200)]
    const laidOut = buildCleanCutParagraphs({ words, segments: [], removals: [], pins: [] })
    expect(laidOut).toHaveLength(1)
    expect(wordTokens(laidOut[0])).toHaveLength(5)
  })

  it('never lets a paragraph cross a forced boundary', () => {
    const words = [...speak('One two three.', 0), ...speak('Four five.', 1_200)]
    const laidOut = buildCleanCutParagraphs({
      words,
      segments: [
        { id: 's1', startMs: 0, endMs: 1_100 },
        { id: 's2', startMs: 1_200, endMs: 1_900 }
      ],
      removals: [],
      pins: [],
      breaksMs: [1_200]
    })
    expect(laidOut.map((paragraph) => wordTokens(paragraph).length)).toEqual([3, 2])
  })

  it('leaves skipped kinds to other UI', () => {
    const laidOut = buildCleanCutParagraphs({
      words: WORDS,
      segments: SEGMENTS,
      removals: [removal('c1', 'condensed', 3_300, 9_000)],
      pins: [],
      skipKinds: ['condensed']
    })
    expect(laidOut.flatMap((paragraph) => paragraph.removalIds)).toEqual([])
  })

  it('shows only the cuts when nothing was said', () => {
    const laidOut = buildCleanCutParagraphs({
      words: [],
      segments: [],
      removals: [removal('h', 'head', 0, 500), removal('t', 'tail', 8_000, 9_000)],
      pins: []
    })
    expect(laidOut).toHaveLength(1)
    expect(laidOut[0].tokens.map((token) => token.type)).toEqual(['marker', 'marker'])
    expect(buildCleanCutParagraphs({ words: [], segments: [], removals: [], pins: [] })).toEqual([])
  })

  it('lays out a two-hour transcript quickly', () => {
    const words: CleanCutTranscriptWord[] = []
    const removals: CleanCutRemoval[] = []
    for (let index = 0; index < 30_000; index += 1) {
      words.push({
        text: index % 50 === 0 ? 'um' : 'word',
        startMs: index * 240,
        endMs: index * 240 + 200
      })
      if (index % 50 === 0)
        removals.push(removal(`f${index}`, 'filler', index * 240 - 10, index * 240 + 210))
    }
    const started = performance.now()
    const laidOut = buildCleanCutParagraphs({ words, segments: [], removals, pins: [] })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(laidOut.reduce((sum, paragraph) => sum + wordTokens(paragraph).length, 0)).toBe(30_000)
  })

  it('keeps words in time order', () => {
    expect(normalizeTranscriptWords(WORDS)).toBe(WORDS)
    const shuffled = [WORDS[2], WORDS[0], WORDS[1]]
    expect(normalizeTranscriptWords(shuffled).map((word) => word.text)).toEqual([
      'So',
      'today',
      'um'
    ])
  })

  it('finds the word under the playhead', () => {
    expect(activeWordIndex(WORDS, 1_100)).toBe(0)
    expect(activeWordIndex(WORDS, 1_350)).toBe(0)
    expect(activeWordIndex(WORDS, 1_450)).toBe(1)
    expect(activeWordIndex(WORDS, 500)).toBe(-1)
    expect(activeWordIndex(WORDS, 4_500)).toBe(-1)
  })
})

describe('keyboard navigation', () => {
  const paragraphs = buildCleanCutParagraphs({
    words: WORDS,
    segments: SEGMENTS,
    removals: SAVED,
    pins: []
  })
  const items = cleanCutTranscriptItems(paragraphs)
  const rows = removalRowIndex(items)
  const order = navigableRemovals(effectiveRemovals(SAVED, EMPTY_CLEAN_CUT_DRAFT), rows)

  it('walks the cuts in time order, and stays at either end', () => {
    expect(order.map((entry) => entry.id)).toEqual(['r1', 'r4', 'r2', 'r3', 'r5'])
    expect(stepRemoval(order, 'r2', 1, 0)).toBe('r3')
    expect(stepRemoval(order, 'r2', -1, 0)).toBe('r4')
    expect(stepRemoval(order, 'r5', 1, 0)).toBe('r5')
    expect(stepRemoval(order, 'r1', -1, 0)).toBe('r1')
    expect(rows.get('r5')).toBe(1)
  })

  it('starts from the playhead when nothing is selected', () => {
    expect(stepRemoval(order, null, 1, 3_000)).toBe('r4')
    expect(stepRemoval(order, null, 1, 6_000)).toBe('r5')
    expect(stepRemoval(order, null, -1, 3_000)).toBe('r2')
    expect(stepRemoval([], null, 1, 0)).toBeNull()
  })

  it('lands a moment before the cut', () => {
    expect(prerollMs({ startMs: 3_700 })).toBe(2_200)
    expect(prerollMs({ startMs: 500 })).toBe(0)
  })
})
