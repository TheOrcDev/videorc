import { describe, expect, it } from 'vitest'

import type { AiCapabilities, GolemPetCreation, GolemPetCreationSource } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import {
  GOLEM_PET_CONSENT_OFF,
  GOLEM_PET_NOT_AVAILABLE,
  GOLEM_PET_REVIEW_ROWS,
  GOLEM_PET_SIGNED_OUT,
  golemPetAllowanceCopy,
  golemPetCanSave,
  golemPetCreatorGate,
  golemPetCreatorStep,
  golemPetGazeArrow,
  golemPetMarkRow,
  golemPetMarkedCount,
  golemPetNameToSave,
  golemPetNeedsNewCreation,
  golemPetNextSheet,
  golemPetNotesDraft,
  golemPetNotesFromDraft,
  golemPetRowMarked,
  golemPetSheetPhase,
  type GolemPetReviewMarks
} from './golem-pet-creator-view'
import { GOLEM_PET_ATLAS_SHEETS } from '../../../shared/golem-pet-creator'

const premium: EntitlementUiGate = { allowed: true }
const basic: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Golem requires Videorc Premium.',
  upgradeUrl: 'https://www.videorc.com/premium'
}
const petOn = (left: number, limit = 3): AiCapabilities =>
  ({
    cohost: { pet: { enabled: true, creationsRemainingThisMonth: left, monthlyLimit: limit } }
  }) as unknown as AiCapabilities

function source(sheet: string, version = 1, opaque = false): GolemPetCreationSource {
  return {
    sheet,
    version,
    file: `sources/${sheet}-v${version}.png`,
    sha256: 'a'.repeat(64),
    opaque,
    referenceVersion: 1,
    createdAt: '2026-10-09T10:00:00Z'
  }
}

function reviewCreation(overrides: Partial<GolemPetCreation> = {}): GolemPetCreation {
  return {
    buildId: '5f0c2a8e-3b1d-4c6e-9a7f-2d8b1e4c6a90',
    step: 'review',
    createdAt: '2026-10-09T10:00:00Z',
    expiresAt: '2026-10-10T10:00:00Z',
    expired: false,
    sheetsAllowed: 9,
    redosAllowed: 6,
    pilotsAllowed: 3,
    sheetsRemaining: 1,
    redosRemaining: 6,
    pilotsUsed: 1,
    reference: source('reference'),
    notes: {
      palette: ['stone grey'],
      materials: ['granite'],
      proportions: 'Stout.',
      asymmetric: [{ feature: 'a crack', side: 'left' }]
    },
    pilot: source('pilot'),
    pilotAccepted: true,
    sheets: GOLEM_PET_ATLAS_SHEETS.map((sheet) => source(sheet.key)),
    build: { state: 'built', fresh: true, finishedAt: '2026-10-09T10:30:00Z' },
    ...overrides
  }
}

describe('golemPetCreatorGate (plan 168 S-F5)', () => {
  const on = { signedIn: true, gate: premium, consented: true, capabilities: petOn(2) }

  it('names the one reason the creator is off, in the order a streamer fixes them', () => {
    expect(golemPetCreatorGate(on)).toEqual({
      allowed: true,
      reason: null,
      canStart: true,
      allowance: { left: 2, limit: 3 }
    })
    expect(golemPetCreatorGate({ ...on, signedIn: false }).reason).toBe(GOLEM_PET_SIGNED_OUT)
    expect(golemPetCreatorGate({ ...on, gate: basic }).reason).toBe(basic.reason)
    expect(golemPetCreatorGate({ ...on, consented: false }).reason).toBe(GOLEM_PET_CONSENT_OFF)
    expect(golemPetCreatorGate({ ...on, capabilities: null }).reason).toBe(GOLEM_PET_NOT_AVAILABLE)
    const basicBlock = {
      cohost: { pet: { enabled: false, creationsRemainingThisMonth: 0, monthlyLimit: 0 } }
    } as unknown as AiCapabilities
    expect(golemPetCreatorGate({ ...on, capabilities: basicBlock })).toEqual({
      allowed: false,
      reason: GOLEM_PET_NOT_AVAILABLE,
      canStart: false,
      allowance: null
    })
  })

  it('keeps an open creation going when the month is used up, but starts no new one', () => {
    const used = golemPetCreatorGate({ ...on, capabilities: petOn(0) })
    expect(used.allowed).toBe(true)
    expect(used.canStart).toBe(false)
    expect(golemPetAllowanceCopy(used.allowance!)).toBe('0 of 3 left this month')
    expect(golemPetAllowanceCopy({ left: 2, limit: 3 })).toBe('2 of 3 left this month')
  })
})

describe('identity notes as editable sentences', () => {
  it('round-trips the notes through the draft, trimming and dropping blanks', () => {
    const notes = reviewCreation().notes!
    const draft = golemPetNotesDraft(notes)
    expect(draft.palette).toBe('stone grey')
    expect(golemPetNotesFromDraft(draft)).toEqual({ notes })
    expect(
      golemPetNotesFromDraft({
        ...draft,
        palette: ' grey , , moss green ',
        asymmetric: [
          { feature: ' ', side: 'right' },
          { feature: ' horn ', side: 'right' }
        ]
      })
    ).toEqual({
      notes: {
        ...notes,
        palette: ['grey', 'moss green'],
        asymmetric: [{ feature: 'horn', side: 'right' }]
      }
    })
  })

  it('names the one thing to fix', () => {
    const draft = golemPetNotesDraft(reviewCreation().notes!)
    expect(golemPetNotesFromDraft({ ...draft, proportions: '  ' })).toEqual({
      error: 'Describe its proportions.'
    })
    expect(
      golemPetNotesFromDraft({
        ...draft,
        palette: Array.from({ length: 9 }, (_, n) => `c${n}`).join(',')
      })
    ).toEqual({ error: 'List at most 8 colours.' })
    expect('error' in golemPetNotesFromDraft({ ...draft, materials: 'x'.repeat(61) })).toBe(true)
  })
})

describe('sheets and review (D21)', () => {
  it('finds the next sheet to make and each row phase', () => {
    const partial = reviewCreation({
      step: 'build',
      sheets: [source('gaze-up2'), source('gaze-up1', 2, true)],
      running: { job: 'sheet', sheet: 'gaze-level' },
      build: undefined
    })
    expect(golemPetNextSheet(partial)?.key).toBe('gaze-level')
    expect(golemPetNextSheet(reviewCreation())).toBeNull()
    expect(golemPetSheetPhase(partial, 'gaze-up2', {}).phase).toBe('done')
    expect(golemPetSheetPhase(partial, 'gaze-up1', {})).toEqual({
      phase: 'done',
      version: 2,
      opaque: true,
      error: null
    })
    expect(golemPetSheetPhase(partial, 'gaze-level', {}).phase).toBe('making')
    expect(golemPetSheetPhase(partial, 'extras', { extras: 'Today is used up.' })).toEqual({
      phase: 'failed',
      version: null,
      opaque: false,
      error: 'Today is used up.'
    })
    expect(golemPetSheetPhase(partial, 'reactions-a', {}).phase).toBe('waiting')
  })

  it('disables Save until every row is marked, and a redo clears that row', () => {
    const creation = reviewCreation()
    let marks: GolemPetReviewMarks = {}
    expect(GOLEM_PET_REVIEW_ROWS).toHaveLength(8)
    for (const row of GOLEM_PET_REVIEW_ROWS.slice(0, 7)) {
      marks = golemPetMarkRow(marks, creation, row.key, true)
    }
    expect(golemPetMarkedCount(marks, creation)).toBe(7)
    expect(golemPetCanSave(marks, creation)).toBe(false)
    marks = golemPetMarkRow(marks, creation, 'extras', true)
    expect(golemPetCanSave(marks, creation)).toBe(true)
    // A stale build never saves.
    expect(
      golemPetCanSave(
        marks,
        reviewCreation({ step: 'build', build: { state: 'built', fresh: false, finishedAt: 'x' } })
      )
    ).toBe(false)
    // Redoing reactions-a makes version 2: its mark no longer counts.
    const redone = reviewCreation({
      sheets: creation.sheets.map((sheet) =>
        sheet.sheet === 'reactions-a' ? source('reactions-a', 2) : sheet
      )
    })
    expect(golemPetRowMarked(marks, redone, 'reactions-a')).toBe(false)
    expect(golemPetRowMarked(marks, redone, 'reactions-b')).toBe(true)
    expect(golemPetCanSave(marks, redone)).toBe(false)
    expect(golemPetCanSave(golemPetMarkRow(marks, redone, 'reactions-a', true), redone)).toBe(true)
    // Unmarking clears it.
    expect(
      golemPetRowMarked(golemPetMarkRow(marks, creation, 'gaze-up2', false), creation, 'gaze-up2')
    ).toBe(false)
  })

  it('points each gaze cell where page-pet says it looks', () => {
    expect(golemPetGazeArrow(2, 2)).toEqual({ center: true, degrees: 0, label: 'Looking at you' })
    expect(golemPetGazeArrow(0, 2)).toMatchObject({ degrees: 180, label: 'Looking left' })
    expect(golemPetGazeArrow(4, 2)).toMatchObject({ degrees: 0, label: 'Looking right' })
    expect(golemPetGazeArrow(2, 0)).toMatchObject({ degrees: -90, label: 'Looking up' })
    expect(golemPetGazeArrow(2, 4)).toMatchObject({ degrees: 90, label: 'Looking down' })
    expect(golemPetGazeArrow(3, 1)).toMatchObject({
      degrees: -45,
      label: 'Looking a little up and right'
    })
    expect(golemPetGazeArrow(0, 4)).toMatchObject({ degrees: 135, label: 'Looking down and left' })
  })

  it('maps the backend step to the wizard step', () => {
    expect(golemPetCreatorStep(null, false)).toBe('reference')
    expect(golemPetCreatorStep(reviewCreation({ step: 'reference' }), false)).toBe('reference')
    expect(golemPetCreatorStep(reviewCreation({ step: 'pilot', pilot: undefined }), false)).toBe(
      'reference'
    )
    expect(golemPetCreatorStep(reviewCreation({ step: 'pilot' }), false)).toBe('pilot')
    expect(golemPetCreatorStep(reviewCreation({ step: 'build' }), true)).toBe('build')
    expect(golemPetCreatorStep(reviewCreation(), false)).toBe('review')
    expect(golemPetCreatorStep(reviewCreation(), true)).toBe('save')
  })

  it('names a pack, and knows which errors need a new creation', () => {
    expect(golemPetNameToSave('  Pebble ')).toBe('Pebble')
    expect(golemPetNameToSave('  ')).toBeNull()
    expect(golemPetNameToSave('p'.repeat(65))).toBeNull()
    expect(golemPetNeedsNewCreation('pet-build-expired')).toBe(true)
    expect(golemPetNeedsNewCreation('pet-build-not-found')).toBe(true)
    expect(golemPetNeedsNewCreation('cohost-pet-creation-none')).toBe(true)
    expect(golemPetNeedsNewCreation('pet-redos-used')).toBe(false)
  })
})
