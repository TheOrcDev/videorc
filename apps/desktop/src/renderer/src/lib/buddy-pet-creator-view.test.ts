import { describe, expect, it } from 'vitest'

import type { AiCapabilities, BuddyPetCreation, BuddyPetCreationSource } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import {
  BUDDY_PET_CONSENT_OFF,
  BUDDY_PET_NOT_AVAILABLE,
  BUDDY_PET_REVIEW_ROWS,
  BUDDY_PET_SIGNED_OUT,
  buddyPetAllowanceCopy,
  buddyPetCanSave,
  buddyPetCreatorGate,
  buddyPetCreatorStep,
  buddyPetGazeArrow,
  buddyPetMarkRow,
  buddyPetMarkedCount,
  buddyPetNameToSave,
  buddyPetNeedsNewCreation,
  buddyPetNextSheet,
  buddyPetNotesDraft,
  buddyPetNotesFromDraft,
  buddyPetRowMarked,
  buddyPetSaveNote,
  buddyPetSheetPhase,
  type BuddyPetReviewMarks
} from './buddy-pet-creator-view'
import { BUDDY_PET_ATLAS_SHEETS } from '../../../shared/buddy-pet-creator'

const premium: EntitlementUiGate = { allowed: true }
const basic: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Buddy requires Videorc Premium.',
  upgradeUrl: 'https://www.videorc.com/premium'
}
const petOn = (left: number, limit = 3): AiCapabilities =>
  ({
    cohost: { pet: { enabled: true, creationsRemainingThisMonth: left, monthlyLimit: limit } }
  }) as unknown as AiCapabilities

function source(sheet: string, version = 1, opaque = false): BuddyPetCreationSource {
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

function reviewCreation(overrides: Partial<BuddyPetCreation> = {}): BuddyPetCreation {
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
    sheets: BUDDY_PET_ATLAS_SHEETS.map((sheet) => source(sheet.key)),
    build: { state: 'built', fresh: true, finishedAt: '2026-10-09T10:30:00Z' },
    ...overrides
  }
}

describe('buddyPetCreatorGate (plan 168 S-F5)', () => {
  const on = { signedIn: true, gate: premium, consented: true, capabilities: petOn(2) }

  it('names the one reason the creator is off, in the order a streamer fixes them', () => {
    expect(buddyPetCreatorGate(on)).toEqual({
      allowed: true,
      reason: null,
      canStart: true,
      allowance: { left: 2, limit: 3 }
    })
    expect(buddyPetCreatorGate({ ...on, signedIn: false }).reason).toBe(BUDDY_PET_SIGNED_OUT)
    expect(buddyPetCreatorGate({ ...on, gate: basic }).reason).toBe(basic.reason)
    expect(buddyPetCreatorGate({ ...on, consented: false }).reason).toBe(BUDDY_PET_CONSENT_OFF)
    expect(buddyPetCreatorGate({ ...on, capabilities: null }).reason).toBe(BUDDY_PET_NOT_AVAILABLE)
    const basicBlock = {
      cohost: { pet: { enabled: false, creationsRemainingThisMonth: 0, monthlyLimit: 0 } }
    } as unknown as AiCapabilities
    expect(buddyPetCreatorGate({ ...on, capabilities: basicBlock })).toEqual({
      allowed: false,
      reason: BUDDY_PET_NOT_AVAILABLE,
      canStart: false,
      allowance: null
    })
  })

  it('keeps an open creation going when the month is used up, but starts no new one', () => {
    const used = buddyPetCreatorGate({ ...on, capabilities: petOn(0) })
    expect(used.allowed).toBe(true)
    expect(used.canStart).toBe(false)
    expect(buddyPetAllowanceCopy(used.allowance!)).toBe('0 of 3 left this month')
    expect(buddyPetAllowanceCopy({ left: 2, limit: 3 })).toBe('2 of 3 left this month')
  })
})

describe('identity notes as editable sentences', () => {
  it('round-trips the notes through the draft, trimming and dropping blanks', () => {
    const notes = reviewCreation().notes!
    const draft = buddyPetNotesDraft(notes)
    expect(draft.palette).toBe('stone grey')
    expect(buddyPetNotesFromDraft(draft)).toEqual({ notes })
    expect(
      buddyPetNotesFromDraft({
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
    const draft = buddyPetNotesDraft(reviewCreation().notes!)
    expect(buddyPetNotesFromDraft({ ...draft, proportions: '  ' })).toEqual({
      error: 'Describe its proportions.'
    })
    expect(
      buddyPetNotesFromDraft({
        ...draft,
        palette: Array.from({ length: 9 }, (_, n) => `c${n}`).join(',')
      })
    ).toEqual({ error: 'List at most 8 colours.' })
    expect('error' in buddyPetNotesFromDraft({ ...draft, materials: 'x'.repeat(61) })).toBe(true)
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
    expect(buddyPetNextSheet(partial)?.key).toBe('gaze-level')
    expect(buddyPetNextSheet(reviewCreation())).toBeNull()
    expect(buddyPetSheetPhase(partial, 'gaze-up2', {}).phase).toBe('done')
    expect(buddyPetSheetPhase(partial, 'gaze-up1', {})).toEqual({
      phase: 'done',
      version: 2,
      opaque: true,
      error: null
    })
    expect(buddyPetSheetPhase(partial, 'gaze-level', {}).phase).toBe('making')
    expect(buddyPetSheetPhase(partial, 'extras', { extras: 'Today is used up.' })).toEqual({
      phase: 'failed',
      version: null,
      opaque: false,
      error: 'Today is used up.'
    })
    expect(buddyPetSheetPhase(partial, 'reactions-a', {}).phase).toBe('waiting')
  })

  it('disables Save until every row is marked, and a redo clears that row', () => {
    const creation = reviewCreation()
    let marks: BuddyPetReviewMarks = {}
    expect(BUDDY_PET_REVIEW_ROWS).toHaveLength(8)
    for (const row of BUDDY_PET_REVIEW_ROWS.slice(0, 7)) {
      marks = buddyPetMarkRow(marks, creation, row.key, true)
    }
    expect(buddyPetMarkedCount(marks, creation)).toBe(7)
    expect(buddyPetCanSave(marks, creation)).toBe(false)
    marks = buddyPetMarkRow(marks, creation, 'extras', true)
    expect(buddyPetCanSave(marks, creation)).toBe(true)
    // A stale build never saves.
    expect(
      buddyPetCanSave(
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
    expect(buddyPetRowMarked(marks, redone, 'reactions-a')).toBe(false)
    expect(buddyPetRowMarked(marks, redone, 'reactions-b')).toBe(true)
    expect(buddyPetCanSave(marks, redone)).toBe(false)
    expect(buddyPetCanSave(buddyPetMarkRow(marks, redone, 'reactions-a', true), redone)).toBe(true)
    // Unmarking clears it.
    expect(
      buddyPetRowMarked(buddyPetMarkRow(marks, creation, 'gaze-up2', false), creation, 'gaze-up2')
    ).toBe(false)
  })

  it('points each gaze cell where page-pet says it looks', () => {
    expect(buddyPetGazeArrow(2, 2)).toEqual({ center: true, degrees: 0, label: 'Looking at you' })
    expect(buddyPetGazeArrow(0, 2)).toMatchObject({ degrees: 180, label: 'Looking left' })
    expect(buddyPetGazeArrow(4, 2)).toMatchObject({ degrees: 0, label: 'Looking right' })
    expect(buddyPetGazeArrow(2, 0)).toMatchObject({ degrees: -90, label: 'Looking up' })
    expect(buddyPetGazeArrow(2, 4)).toMatchObject({ degrees: 90, label: 'Looking down' })
    expect(buddyPetGazeArrow(3, 1)).toMatchObject({
      degrees: -45,
      label: 'Looking a little up and right'
    })
    expect(buddyPetGazeArrow(0, 4)).toMatchObject({ degrees: 135, label: 'Looking down and left' })
  })

  it('maps the backend step to the wizard step', () => {
    expect(buddyPetCreatorStep(null, false)).toBe('reference')
    expect(buddyPetCreatorStep(reviewCreation({ step: 'reference' }), false)).toBe('reference')
    expect(buddyPetCreatorStep(reviewCreation({ step: 'pilot', pilot: undefined }), false)).toBe(
      'reference'
    )
    expect(buddyPetCreatorStep(reviewCreation({ step: 'pilot' }), false)).toBe('pilot')
    expect(buddyPetCreatorStep(reviewCreation({ step: 'build' }), true)).toBe('build')
    expect(buddyPetCreatorStep(reviewCreation(), false)).toBe('review')
    expect(buddyPetCreatorStep(reviewCreation(), true)).toBe('save')
  })

  it('says where a saved pack is kept: with a library Buddy in the account, else here (plan 172 D10)', () => {
    // QA 2026-10-11: saving Ember QA's moves said "Kept on this computer."
    // while the app sent them to the account library.
    const aliveSync = {
      cohost: { tick: 4, buddyLibrary: { alive: true } }
    } as unknown as AiCapabilities
    const linked = { name: 'Ember QA', libraryAvatarId: '0c211fd7-75db-4900-afbc-0fb0ef84eadc' }
    expect(buddyPetSaveNote({ persona: linked, capabilities: aliveSync })).toBe(
      'Saved with Ember QA in your Videorc library, so it moves on every computer you sign in to. Your Buddy wears it right away; switch back to Still any time.'
    )
    const here =
      'Kept on this computer. Your Buddy wears it right away; switch back to Still any time.'
    // Only on this computer, an official Buddy, or a web that keeps no packs.
    expect(buddyPetSaveNote({ persona: { name: 'Rocky' }, capabilities: aliveSync })).toBe(here)
    expect(
      buddyPetSaveNote({
        persona: { name: 'Golmar', libraryAvatarId: 'official:orc' },
        capabilities: aliveSync
      })
    ).toBe(here)
    expect(
      buddyPetSaveNote({
        persona: linked,
        capabilities: {
          cohost: { tick: 4, buddyLibrary: { alive: false } }
        } as unknown as AiCapabilities
      })
    ).toBe(here)
    expect(buddyPetSaveNote({ persona: linked, capabilities: null })).toBe(here)
  })

  it('names a pack, and knows which errors need a new creation', () => {
    expect(buddyPetNameToSave('  Pebble ')).toBe('Pebble')
    expect(buddyPetNameToSave('  ')).toBeNull()
    expect(buddyPetNameToSave('p'.repeat(65))).toBeNull()
    expect(buddyPetNeedsNewCreation('pet-build-expired')).toBe(true)
    expect(buddyPetNeedsNewCreation('pet-build-not-found')).toBe(true)
    expect(buddyPetNeedsNewCreation('cohost-pet-creation-none')).toBe(true)
    expect(buddyPetNeedsNewCreation('pet-redos-used')).toBe(false)
  })
})
