import type {
  ClipMoment,
  ClipMomentSource,
  CleanCutRemoval,
  CleanCutRemovalKind,
  CleanCutUpdateEdlParams
} from './backend'
import type { CleanCutTranscriptSegment, CleanCutTranscriptWord } from './clean-cut-view'
import { momentKind, momentLabel } from './orcle-report-view'
import { keptDurationMs, type SkipRange } from './skip-ranges'

// Clean cut review (plan 119 S14): what the player skips, what the
// transcript strikes through, the per-kind chips, and the one `updateEdl`
// payload "Save changes" sends. Edits stay a local draft over the saved cut
// list until they are saved, so a toggle is instant and the virtual preview
// follows it at once. Pure: no React, no DOM.

// --- Kinds ----------------------------------------------------------------------

/** Semantic tones only (styles.css): the strike colour says what a cut is. */
export type CleanCutTone = 'neutral' | 'warning' | 'destructive' | 'info'

export type CleanCutKindGroupId =
  | 'silences'
  | 'fillers'
  | 'retakes'
  | 'false-starts'
  | 'start-end'
  | 'manual'

export interface CleanCutKindGroup {
  id: CleanCutKindGroupId
  label: string
  kinds: readonly CleanCutRemovalKind[]
  tone: CleanCutTone
  /** Shown even when nothing of the kind was found, so the chips never move. */
  always: boolean
}

export const CLEAN_CUT_KIND_GROUPS: readonly CleanCutKindGroup[] = [
  { id: 'silences', label: 'Silences', kinds: ['silence', 'gap'], tone: 'neutral', always: true },
  { id: 'fillers', label: 'Ums', kinds: ['filler'], tone: 'warning', always: true },
  { id: 'retakes', label: 'Retakes', kinds: ['retake'], tone: 'destructive', always: true },
  {
    id: 'false-starts',
    label: 'False starts',
    kinds: ['false_start'],
    tone: 'info',
    always: true
  },
  { id: 'start-end', label: 'Start/end', kinds: ['head', 'tail'], tone: 'neutral', always: true },
  { id: 'manual', label: 'Your cuts', kinds: ['manual'], tone: 'neutral', always: false }
]

const TONE_BY_KIND: Readonly<Record<CleanCutRemovalKind, CleanCutTone>> = {
  head: 'neutral',
  tail: 'neutral',
  silence: 'neutral',
  gap: 'neutral',
  filler: 'warning',
  retake: 'destructive',
  false_start: 'info',
  condensed: 'neutral',
  manual: 'neutral'
}

export function removalTone(kind: CleanCutRemovalKind): CleanCutTone {
  return TONE_BY_KIND[kind] ?? 'neutral'
}

export function kindGroupOf(kind: CleanCutRemovalKind): CleanCutKindGroup | null {
  return CLEAN_CUT_KIND_GROUPS.find((group) => group.kinds.includes(kind)) ?? null
}

const KIND_NAMES: Readonly<Record<CleanCutRemovalKind, string>> = {
  head: 'Start',
  tail: 'End',
  silence: 'Silence',
  gap: 'Pause',
  filler: 'Um',
  retake: 'Retake',
  false_start: 'False start',
  condensed: 'Left out',
  manual: 'Your cut'
}

/** "Retake", "Um": one removal's kind in a word. */
export function removalKindName(kind: CleanCutRemovalKind): string {
  return KIND_NAMES[kind] ?? 'Cut'
}

/** "1.8 s", "12 s": a short length for inline markers. */
export function formatCutLength(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} s`
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

// --- Draft ----------------------------------------------------------------------

/** Keys of ranges the draft cuts that the saved list does not have yet. */
export const DRAFT_MANUAL_PREFIX = 'draft:'

export interface CleanCutDraftManual {
  key: string
  startMs: number
  endMs: number
}

export interface CleanCutDraft {
  /** Removal id → the state the user wants, only where it differs from the saved list. */
  toggles: ReadonlyMap<string, boolean>
  /** New ranges to cut (a dropped Condensed part). */
  addManual: readonly CleanCutDraftManual[]
  /** Saved manual removals to delete (a dropped part kept again). */
  removeManual: ReadonlySet<string>
  nextKey: number
}

export const EMPTY_CLEAN_CUT_DRAFT: CleanCutDraft = {
  toggles: new Map(),
  addManual: [],
  removeManual: new Set(),
  nextKey: 1
}

export function draftChangeCount(draft: CleanCutDraft): number {
  return draft.toggles.size + draft.addManual.length + draft.removeManual.size
}

function byTime(left: CleanCutRemoval, right: CleanCutRemoval): number {
  return left.startMs - right.startMs || left.endMs - right.endMs
}

/** The cut list as it stands with the draft applied, in time order. */
export function effectiveRemovals(
  saved: readonly CleanCutRemoval[],
  draft: CleanCutDraft
): CleanCutRemoval[] {
  const out: CleanCutRemoval[] = []
  for (const removal of saved) {
    if (draft.removeManual.has(removal.id)) continue
    const wanted = draft.toggles.get(removal.id)
    out.push(
      wanted === undefined || wanted === removal.enabled ? removal : { ...removal, enabled: wanted }
    )
  }
  for (const manual of draft.addManual) {
    out.push({
      id: manual.key,
      startMs: manual.startMs,
      endMs: manual.endMs,
      startFrame: 0,
      endFrame: 0,
      kind: 'manual',
      reason: 'Removed by you',
      enabled: true
    })
  }
  return out.sort(byTime)
}

/** Set removals on or off. Back at its saved state, a removal leaves the draft. */
export function setRemovalsEnabled(
  draft: CleanCutDraft,
  saved: readonly CleanCutRemoval[],
  ids: readonly string[],
  enabled: boolean
): CleanCutDraft {
  const savedById = new Map(saved.map((removal) => [removal.id, removal]))
  const toggles = new Map(draft.toggles)
  let addManual = draft.addManual
  for (const id of ids) {
    if (id.startsWith(DRAFT_MANUAL_PREFIX)) {
      if (!enabled) addManual = addManual.filter((manual) => manual.key !== id)
      continue
    }
    const removal = savedById.get(id)
    if (!removal) continue
    if (removal.enabled === enabled) toggles.delete(id)
    else toggles.set(id, enabled)
  }
  return { ...draft, toggles, addManual }
}

/** Flip one removal (a click on a struck span, or Enter on the selection). */
export function toggleRemoval(
  draft: CleanCutDraft,
  saved: readonly CleanCutRemoval[],
  id: string
): CleanCutDraft {
  const current = effectiveRemovals(saved, draft).find((removal) => removal.id === id)
  if (!current) return draft
  return setRemovalsEnabled(draft, saved, [id], !current.enabled)
}

/** A chip: when every removal of its kind is cut, keep them all; else cut them all. */
export function toggleKindGroup(
  draft: CleanCutDraft,
  saved: readonly CleanCutRemoval[],
  groupId: CleanCutKindGroupId
): CleanCutDraft {
  const group = CLEAN_CUT_KIND_GROUPS.find((entry) => entry.id === groupId)
  if (!group) return draft
  const members = effectiveRemovals(saved, draft).filter((removal) =>
    group.kinds.includes(removal.kind)
  )
  if (members.length === 0) return draft
  const allCut = members.every((removal) => removal.enabled)
  return setRemovalsEnabled(
    draft,
    saved,
    members.map((removal) => removal.id),
    !allCut
  )
}

/** Cut a new range (a dropped Condensed part). */
export function addDraftManual(
  draft: CleanCutDraft,
  range: { startMs: number; endMs: number }
): CleanCutDraft {
  if (!(range.endMs > range.startMs)) return draft
  const key = `${DRAFT_MANUAL_PREFIX}${draft.nextKey}`
  return {
    ...draft,
    addManual: [...draft.addManual, { key, startMs: range.startMs, endMs: range.endMs }],
    nextKey: draft.nextKey + 1
  }
}

/** Delete manual removals: draft ones leave the draft, saved ones are queued. */
export function removeManualRemovals(draft: CleanCutDraft, ids: readonly string[]): CleanCutDraft {
  const drop = new Set(ids)
  const removeManual = new Set(draft.removeManual)
  for (const id of ids) if (!id.startsWith(DRAFT_MANUAL_PREFIX)) removeManual.add(id)
  const toggles = new Map(draft.toggles)
  for (const id of removeManual) toggles.delete(id)
  return {
    ...draft,
    toggles,
    addManual: draft.addManual.filter((manual) => !drop.has(manual.key)),
    removeManual
  }
}

/**
 * The one `cleanCut.updateEdl` call "Save changes" sends, against the saved
 * revision. Empty lists are left out, as the contract allows.
 */
export function updateEdlPayload(
  jobId: string,
  revision: number,
  draft: CleanCutDraft
): CleanCutUpdateEdlParams {
  const params: CleanCutUpdateEdlParams = { jobId, revision }
  if (draft.toggles.size > 0) {
    params.removals = [...draft.toggles].map(([id, enabled]) => ({ id, enabled }))
  }
  if (draft.addManual.length > 0) {
    params.addManual = draft.addManual.map((manual) => ({
      startMs: Math.max(0, Math.round(manual.startMs)),
      endMs: Math.max(0, Math.round(manual.endMs))
    }))
  }
  if (draft.removeManual.size > 0) params.removeManual = [...draft.removeManual]
  return params
}

/**
 * After an `edl-revision-conflict` the newest saved list is loaded and the
 * draft is carried onto it: a toggle survives while its removal still exists
 * and still differs; a queued manual deletion survives while its removal does.
 */
export function rebaseDraft(
  draft: CleanCutDraft,
  saved: readonly CleanCutRemoval[]
): CleanCutDraft {
  const savedById = new Map(saved.map((removal) => [removal.id, removal]))
  const toggles = new Map<string, boolean>()
  for (const [id, enabled] of draft.toggles) {
    const removal = savedById.get(id)
    if (removal && removal.enabled !== enabled) toggles.set(id, enabled)
  }
  const removeManual = new Set(
    [...draft.removeManual].filter((id) => savedById.get(id)?.kind === 'manual')
  )
  return { ...draft, toggles, removeManual }
}

// --- Chips and stats --------------------------------------------------------------

export type CleanCutChipState = 'on' | 'off' | 'mixed' | 'empty'

export interface CleanCutKindChip {
  group: CleanCutKindGroup
  /** Every removal of the kind, suggestions included. */
  total: number
  /** The ones that are cut. */
  cut: number
  cutMs: number
  state: CleanCutChipState
}

export function cleanCutKindChips(effective: readonly CleanCutRemoval[]): CleanCutKindChip[] {
  return CLEAN_CUT_KIND_GROUPS.flatMap((group) => {
    let total = 0
    let cut = 0
    let cutMs = 0
    for (const removal of effective) {
      if (!group.kinds.includes(removal.kind)) continue
      total += 1
      if (removal.enabled) {
        cut += 1
        cutMs += removal.endMs - removal.startMs
      }
    }
    if (total === 0 && !group.always) return []
    const state: CleanCutChipState =
      total === 0 ? 'empty' : cut === total ? 'on' : cut === 0 ? 'off' : 'mixed'
    return [{ group, total, cut, cutMs, state }]
  })
}

/** What the player skips: every removal that is cut. */
export function cutSkipRanges(effective: readonly CleanCutRemoval[]): SkipRange[] {
  return effective
    .filter((removal) => removal.enabled)
    .map((removal) => ({ startMs: removal.startMs, endMs: removal.endMs }))
}

export interface CleanCutStats {
  durationMs: number
  keptMs: number
  savedMs: number
  cuts: number
}

/**
 * Original → cut. The saved, frame-exact `keptMs` is the base; a draft moves
 * it by exactly what the draft adds or gives back, so a 2 s toggle reads as
 * 2 s and an undone draft lands on the saved number again.
 */
export function cleanCutStats({
  durationMs,
  saved,
  effective,
  savedKeptMs
}: {
  durationMs: number
  saved: readonly CleanCutRemoval[]
  effective: readonly CleanCutRemoval[]
  savedKeptMs: number | null
}): CleanCutStats {
  const draftKept = keptDurationMs(durationMs, cutSkipRanges(effective))
  const keptMs =
    typeof savedKeptMs === 'number'
      ? Math.min(
          durationMs,
          Math.max(0, savedKeptMs + draftKept - keptDurationMs(durationMs, cutSkipRanges(saved)))
        )
      : draftKept
  return {
    durationMs,
    keptMs,
    savedMs: Math.max(0, durationMs - keptMs),
    cuts: effective.filter((removal) => removal.enabled && removal.kind !== 'condensed').length
  }
}

// --- Pins -------------------------------------------------------------------------

export interface CleanCutPin {
  key: string
  kind: ClipMomentSource
  label: string
  startMs: number
  excerpt: string
}

/** The stream report's moments (plan 119 decision 7) as review pins, in time order. */
export function cleanCutPins(moments: readonly ClipMoment[] | null | undefined): CleanCutPin[] {
  return [...(moments ?? [])]
    .filter((moment) => Number.isFinite(moment.startMs))
    .sort((left, right) => left.startMs - right.startMs)
    .map((moment, index) => ({
      key: `${index}-${momentKind(moment)}-${moment.startMs}`,
      kind: momentKind(moment),
      label: momentLabel(moment),
      startMs: Math.max(0, moment.startMs),
      excerpt: moment.excerpt.trim()
    }))
}

// --- Transcript layout --------------------------------------------------------------

const PARAGRAPH_PAUSE_MS = 2_000
const PARAGRAPH_MAX_SENTENCES = 5
const PARAGRAPH_MAX_WORDS = 90
const FALLBACK_SENTENCE_PAUSE_MS = 1_200
const FALLBACK_SENTENCE_MAX_WORDS = 40
const SENTENCE_END = /[.?!…]["')\]]*$/
/** A part boundary lands on a sentence start, give or take frame snapping. */
const BOUNDARY_TOLERANCE_MS = 250

export type CleanCutTranscriptToken =
  | {
      type: 'word'
      index: number
      text: string
      startMs: number
      endMs: number
      /** Removals covering the word, innermost first. */
      removalIds: readonly string[]
    }
  | {
      /** A removal that covers no word: a silence, a pause, the start or the end. */
      type: 'marker'
      removalId: string
      kind: CleanCutRemovalKind
      startMs: number
      endMs: number
    }
  | { type: 'pin'; pin: CleanCutPin }

export interface CleanCutParagraph {
  type: 'paragraph'
  key: string
  startMs: number
  endMs: number
  tokens: CleanCutTranscriptToken[]
  /** Every removal the paragraph shows, for re-render keys and navigation. */
  removalIds: readonly string[]
}

/** Words in time order; the same array when it already is. */
export function normalizeTranscriptWords(
  words: readonly CleanCutTranscriptWord[]
): readonly CleanCutTranscriptWord[] {
  for (let index = 1; index < words.length; index += 1) {
    if (words[index].startMs < words[index - 1].startMs) {
      return [...words].sort((left, right) => left.startMs - right.startMs)
    }
  }
  return words
}

/** Word indices that start a sentence: from the cut list's segments, or from
 * punctuation and pauses when there are none. */
function sentenceStarts(
  words: readonly CleanCutTranscriptWord[],
  segments: readonly CleanCutTranscriptSegment[]
): number[] {
  if (words.length === 0) return []
  const starts = [0]
  if (segments.length > 1) {
    const sorted = [...segments].sort((left, right) => left.startMs - right.startMs)
    let word = 0
    for (let index = 1; index < sorted.length; index += 1) {
      const startMs = sorted[index].startMs
      while (word < words.length && words[word].startMs < startMs - 1) word += 1
      if (word >= words.length) break
      if (word > starts[starts.length - 1]) starts.push(word)
    }
    return starts
  }
  let count = 0
  for (let index = 1; index < words.length; index += 1) {
    count += 1
    const previous = words[index - 1]
    if (
      SENTENCE_END.test(previous.text.trim()) ||
      words[index].startMs - previous.endMs >= FALLBACK_SENTENCE_PAUSE_MS ||
      count >= FALLBACK_SENTENCE_MAX_WORDS
    ) {
      starts.push(index)
      count = 0
    }
  }
  return starts
}

/** Word index ranges [start, end) of the paragraphs. */
function paragraphRanges(
  words: readonly CleanCutTranscriptWord[],
  sentences: readonly number[],
  breaksMs: readonly number[]
): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const breaks = breaksMs
    .map((ms) => ms - BOUNDARY_TOLERANCE_MS)
    .sort((left, right) => left - right)
  let breakIndex = 0
  let start = 0
  let sentenceCount = 0
  for (let index = 0; index < sentences.length; index += 1) {
    const first = sentences[index]
    const end = index + 1 < sentences.length ? sentences[index + 1] : words.length
    if (index > 0) {
      const previousWord = words[first - 1]
      const firstWord = words[first]
      while (breakIndex < breaks.length && breaks[breakIndex] <= previousWord.startMs)
        breakIndex += 1
      const crossesBreak = breakIndex < breaks.length && breaks[breakIndex] <= firstWord.startMs
      const pause = firstWord.startMs - previousWord.endMs >= PARAGRAPH_PAUSE_MS
      const full = sentenceCount >= PARAGRAPH_MAX_SENTENCES || end - start > PARAGRAPH_MAX_WORDS
      if (crossesBreak || pause || full) {
        ranges.push([start, first])
        start = first
        sentenceCount = 0
      }
    }
    sentenceCount += 1
  }
  if (words.length > 0) ranges.push([start, words.length])
  return ranges
}

/** The paragraph that owns a time: from its start to the next one's start. */
function paragraphAt(starts: readonly number[], ms: number): number {
  let low = 0
  let high = starts.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (starts[middle] <= ms) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

export interface CleanCutLayoutInput {
  words: readonly CleanCutTranscriptWord[]
  segments: readonly CleanCutTranscriptSegment[]
  /** The saved cut list (the layout does not change with the draft). */
  removals: readonly CleanCutRemoval[]
  pins: readonly CleanCutPin[]
  /** Times a paragraph must not straddle (Condensed part boundaries). */
  breaksMs?: readonly number[]
  /** Kinds the transcript leaves to other UI (Condensed parts). */
  skipKinds?: readonly CleanCutRemovalKind[]
}

/**
 * The transcript as paragraphs of words, with removals mapped onto them. A
 * word belongs to every removal that covers its midpoint; a removal that
 * covers no word becomes an inline marker at its start. Linear in words plus
 * removals, so 30k words lay out in a few milliseconds; the draft never
 * re-runs it, the view looks states up per removal id.
 */
export function buildCleanCutParagraphs({
  words,
  segments,
  removals,
  pins,
  breaksMs = [],
  skipKinds = []
}: CleanCutLayoutInput): CleanCutParagraph[] {
  const skip = new Set(skipKinds)
  const cuts = removals.filter((removal) => !skip.has(removal.kind)).sort(byTime)

  // Coverage: a sweep over words and removals, both in time order.
  const covering: Array<readonly string[]> = new Array(words.length)
  const coveredIds = new Set<string>()
  let open: CleanCutRemoval[] = []
  let next = 0
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const middle = (word.startMs + word.endMs) / 2
    while (next < cuts.length && cuts[next].startMs <= middle) open.push(cuts[next++])
    open = open.filter((removal) => removal.endMs > middle)
    if (open.length === 0) {
      covering[index] = []
      continue
    }
    const ids = [...open]
      .sort((left, right) => left.endMs - left.startMs - (right.endMs - right.startMs))
      .map((removal) => removal.id)
    for (const id of ids) coveredIds.add(id)
    covering[index] = ids
  }

  const ranges = paragraphRanges(words, sentenceStarts(words, segments), breaksMs)
  type Extra = { ms: number; token: CleanCutTranscriptToken }
  const extras: Extra[] = [
    ...cuts
      .filter((removal) => !coveredIds.has(removal.id))
      .map((removal) => ({
        ms: removal.startMs,
        token: {
          type: 'marker' as const,
          removalId: removal.id,
          kind: removal.kind,
          startMs: removal.startMs,
          endMs: removal.endMs
        }
      })),
    ...pins.map((pin) => ({ ms: pin.startMs, token: { type: 'pin' as const, pin } }))
  ].sort((left, right) => left.ms - right.ms)

  if (ranges.length === 0) {
    if (extras.length === 0) return []
    return [
      {
        type: 'paragraph',
        key: 'p-0',
        startMs: extras[0].ms,
        endMs: extras[extras.length - 1].ms,
        tokens: extras.map((extra) => extra.token),
        removalIds: extras.flatMap((extra) =>
          extra.token.type === 'marker' ? [extra.token.removalId] : []
        )
      }
    ]
  }

  const starts = ranges.map(([start]) => words[start].startMs)
  const extrasByParagraph: Extra[][] = ranges.map(() => [])
  for (const extra of extras) extrasByParagraph[paragraphAt(starts, extra.ms)].push(extra)

  return ranges.map(([start, end], paragraph) => {
    const tokens: CleanCutTranscriptToken[] = []
    const ids = new Set<string>()
    const own = extrasByParagraph[paragraph]
    let extra = 0
    for (let index = start; index < end; index += 1) {
      const word = words[index]
      while (extra < own.length && own[extra].ms <= word.startMs) {
        const token = own[extra++].token
        if (token.type === 'marker') ids.add(token.removalId)
        tokens.push(token)
      }
      for (const id of covering[index]) ids.add(id)
      tokens.push({
        type: 'word',
        index,
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
        removalIds: covering[index]
      })
    }
    while (extra < own.length) {
      const token = own[extra++].token
      if (token.type === 'marker') ids.add(token.removalId)
      tokens.push(token)
    }
    return {
      type: 'paragraph' as const,
      key: `p-${words[start].startMs}-${start}`,
      startMs: words[start].startMs,
      endMs: words[end - 1].endMs,
      tokens,
      removalIds: [...ids]
    }
  })
}

/** The word under the playhead, or -1 between words. */
export function activeWordIndex(
  words: readonly CleanCutTranscriptWord[],
  positionMs: number
): number {
  if (!Number.isFinite(positionMs) || words.length === 0) return -1
  let low = 0
  let high = words.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (words[middle].startMs <= positionMs) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (found === -1) return -1
  return positionMs < words[found].endMs + 250 ? found : -1
}

/** One row of the virtual transcript list. */
export type CleanCutTranscriptItem = CleanCutParagraph

/** The rows the transcript shows: its paragraphs. */
export function cleanCutTranscriptItems(
  paragraphs: readonly CleanCutParagraph[]
): CleanCutTranscriptItem[] {
  return [...paragraphs]
}

/** Removal id → the row that shows it. */
export function removalRowIndex(items: readonly CleanCutTranscriptItem[]): Map<string, number> {
  const rows = new Map<string, number>()
  items.forEach((item, index) => {
    if (item.type !== 'paragraph') return
    for (const id of item.removalIds) if (!rows.has(id)) rows.set(id, index)
  })
  return rows
}

/** The removals ↑ and ↓ walk, in time order: the ones the transcript shows. */
export function navigableRemovals(
  effective: readonly CleanCutRemoval[],
  rows: ReadonlyMap<string, number>
): CleanCutRemoval[] {
  return effective.filter((removal) => rows.has(removal.id))
}

/**
 * ↑ / ↓: the previous or next removal. With nothing selected, ↓ picks the
 * first removal at or after the playhead and ↑ the last one before it. At
 * either end the selection stays.
 */
export function stepRemoval(
  order: readonly CleanCutRemoval[],
  currentId: string | null,
  direction: 1 | -1,
  positionMs: number
): string | null {
  if (order.length === 0) return currentId
  const index = currentId ? order.findIndex((removal) => removal.id === currentId) : -1
  if (index !== -1) {
    const nextIndex = index + direction
    return nextIndex >= 0 && nextIndex < order.length ? order[nextIndex].id : currentId
  }
  if (direction === 1) {
    return (order.find((removal) => removal.endMs > positionMs) ?? order[order.length - 1]).id
  }
  const before = order.filter((removal) => removal.startMs < positionMs)
  return (before[before.length - 1] ?? order[0]).id
}

/** Where ↑ / ↓ put the playhead: a moment before the cut, to hear it land. */
export const REVIEW_PREROLL_MS = 1_500

export function prerollMs(removal: Pick<CleanCutRemoval, 'startMs'>): number {
  return Math.max(0, removal.startMs - REVIEW_PREROLL_MS)
}
