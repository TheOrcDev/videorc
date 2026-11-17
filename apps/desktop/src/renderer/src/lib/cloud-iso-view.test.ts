import fixture from '../../../../../../protocol-fixtures/cloud-source-iso.json'
import { describe, expect, it } from 'vitest'

import type { CloudIsoAnswer, CloudIsoImportJournal, CloudIsoStatus } from '@/lib/backend'

import {
  ISO_CHECKING,
  ISO_DEFAULT_LIMITS,
  ISO_NOT_AVAILABLE,
  ISO_NOT_ON_PLAN,
  ISO_OPEN_ROOM_FIRST,
  formatUsdMicros,
  isoCostLine,
  isoCurrentTake,
  isoEnableBlockedReason,
  isoEnableParams,
  isoEstimateMicros,
  isoErrorText,
  isoFileWord,
  isoGuestConsentRows,
  isoImportAnswered,
  isoImportStarting,
  isoImportsFromJournal,
  isoJournalRows,
  isoLibraryRows,
  isoLimitsLine,
  isoMicrosPerFileMinute,
  isoParsedTakes,
  isoRoomRows,
  isoTakeImport,
  isoTakeImportSummary,
  isoRefusalText,
  isoTakeNotes,
  reduceIsoImportEvent,
  type IsoImports
} from './cloud-iso-view'

// Plan 249 S22: the words and states of "Separate files".

const manifest = structuredClone(fixture.valid)
const takeId = manifest.takeId
const now = manifest.createdAtMs + 1

function status(overrides: Partial<CloudIsoStatus> = {}): CloudIsoStatus {
  return {
    request: null,
    lastRefusal: null,
    guestConsent: [],
    takes: [{ manifest: structuredClone(fixture.valid), programRecordingId: 'rec_program' }],
    ...overrides
  }
}

function answer(qualified: boolean): CloudIsoAnswer {
  return {
    availability: { enabled: qualified, productionQualified: qualified },
    iso: status()
  }
}

describe('availability, limits and cost', () => {
  it('estimates the worst case at the published price and labels it an estimate', () => {
    expect(isoEstimateMicros(ISO_DEFAULT_LIMITS)).toBe(1_440_000)
    expect(formatUsdMicros(1_440_000)).toBe('$1.44')
    expect(formatUsdMicros(1_000)).toBe('$0.001')
    expect(isoLimitsLine(ISO_DEFAULT_LIMITS)).toBe('Up to 12 files at once, for up to 2 hours.')
    expect(isoLimitsLine({ maxActiveEntries: 1, maxMinutes: 45 })).toBe(
      'Up to 1 file at once, for up to 45 minutes.'
    )
    expect(isoCostLine(ISO_DEFAULT_LIMITS)).toBe(
      'Estimated cost: up to $1.44 (12 files × 120 minutes at $0.001 a minute, the published price). An estimate, not a bill.'
    )
  })

  it('reads the published price from the web, and falls back to the known one', () => {
    expect(isoMicrosPerFileMinute(null)).toBe(1_000)
    expect(
      isoMicrosPerFileMinute({
        enabled: false,
        productionQualified: false,
        provider: { adapter: 'a', sdkSupport: 's', facts: { microsPerTrackEgressMinute: 2_000 } }
      })
    ).toBe(2_000)
    expect(
      isoMicrosPerFileMinute({
        enabled: false,
        productionQualified: false,
        provider: { adapter: 'a', sdkSupport: 's', facts: { microsPerTrackEgressMinute: 'x' } }
      })
    ).toBe(1_000)
  })

  it('sends consent and a ceiling that covers the estimate', () => {
    expect(isoEnableParams('sh_x', ISO_DEFAULT_LIMITS)).toEqual({
      showId: 'sh_x',
      consent: true,
      maxActiveEntries: 12,
      maxMinutes: 120,
      costCeilingMicros: 1_440_000
    })
  })

  it('says why Turn on is disabled, never hiding the reason', () => {
    const base = { offline: false, roomOpen: true, answer: answer(false), errorCode: null }
    expect(isoEnableBlockedReason(base)).toBe(ISO_NOT_AVAILABLE)
    expect(ISO_NOT_AVAILABLE).toBe("Separate cloud files aren't available yet.")
    expect(isoEnableBlockedReason({ ...base, answer: answer(true) })).toBeNull()
    expect(isoEnableBlockedReason({ ...base, roomOpen: false })).toBe(ISO_OPEN_ROOM_FIRST)
    expect(isoEnableBlockedReason({ ...base, offline: true })).toMatch(/reconnecting/)
    expect(isoEnableBlockedReason({ ...base, answer: null })).toBe(ISO_CHECKING)
    expect(isoEnableBlockedReason({ ...base, answer: null, errorCode: 'cloud-iso-plan' })).toBe(
      ISO_NOT_ON_PLAN
    )
    expect(isoEnableBlockedReason({ ...base, answer: null, errorCode: 'cloud-iso-failed' })).toBe(
      ISO_NOT_AVAILABLE
    )
  })

  it('maps every backend error code to words, and nothing else', () => {
    for (const code of [
      'cloud-iso-not-qualified',
      'cloud-iso-plan',
      'cloud-iso-refused',
      'cloud-iso-controller',
      'cloud-iso-failed',
      'cloud-iso-import-failed',
      'resource-capability-rejected'
    ]) {
      expect(isoErrorText(code), code).toMatch(/^[A-Z].*\.$/)
    }
    expect(isoErrorText('invalid-params')).toBeNull()
    expect(isoErrorText(undefined)).toBeNull()
  })
})

describe('the room', () => {
  it('reads takes strictly and keeps an unreadable one as unreadable', () => {
    const takes = isoParsedTakes(
      status({
        takes: [
          { manifest: structuredClone(fixture.valid), programRecordingId: 'rec_program' },
          {
            manifest: { ...structuredClone(fixture.valid), productionQualified: true },
            programRecordingId: 'rec_bad'
          }
        ]
      })
    )
    expect(takes.map((take) => take.ok)).toEqual([true, false])
    expect(isoCurrentTake(takes)?.takeId).toBe(takeId)
    expect(isoCurrentTake([{ ok: false, programRecordingId: 'x' }])).toBeNull()
  })

  it('lists each file by person, the host first, with failures said', () => {
    const [take] = isoParsedTakes(status())
    if (!take?.ok) throw new Error('fixture')
    const rows = isoRoomRows(take.manifest, [
      { guestId: 'g_ann', name: 'Ann', joinedAt: '', muted: false, screenShareAllowed: true }
    ])
    expect(rows.map((row) => `${row.title} · ${row.status.label}`)).toEqual([
      'Your camera · Saved',
      'Your microphone · Saved',
      'Your microphone (part 2) · Saved',
      'Your show sounds · Saved',
      "Ann's camera · Partial",
      "Ann's microphone · Failed"
    ])
    expect(rows[4]?.detail).toBe("Reached the cloud's time limit")
    expect(rows[5]?.detail).toBe("Couldn't start")
    expect(rows[5]?.status.tone).toBe('error')
    expect(isoRoomRows(take.manifest)[4]?.title).toBe("A guest's camera")
  })

  it("shows each guest's consent", () => {
    const rows = isoGuestConsentRows(
      [
        { guestId: 'g_ann', name: 'Ann', joinedAt: '', muted: false, screenShareAllowed: true },
        { guestId: 'g_bob', name: 'Bob', joinedAt: '', muted: false, screenShareAllowed: true }
      ],
      [{ identity: 'g_ann', atMs: 1 }]
    )
    expect(rows.map((row) => `${row.name} · ${row.status.label}`)).toEqual([
      'Ann · Agreed',
      "Bob · Hasn't agreed"
    ])
  })

  it('says when sources were left out or the take stopped early', () => {
    const [take] = isoParsedTakes(status())
    if (!take?.ok) throw new Error('fixture')
    expect(isoTakeNotes(take.manifest)).toEqual([
      "2 sources weren't recorded separately: a guest who hasn't agreed, or audio Videorc can't tell apart."
    ])
    expect(isoTakeNotes({ ...take.manifest, stopReason: 'budget-exhausted', refused: [] })).toEqual(
      ['Separate files stopped: the cost limit was reached.']
    )
  })
})

describe('the Library', () => {
  const [take] = isoParsedTakes(status())
  if (!take?.ok) throw new Error('fixture')
  const rows = isoLibraryRows(take.manifest, now)

  it('lists every file: importable ones from the import plan, the rest with why', () => {
    expect(rows.map((row) => [row.title, row.importable, row.unavailable])).toEqual([
      ['Host camera', true, null],
      ['Host microphone', true, null],
      ['Host microphone (part 2)', true, null],
      ['Host sounds', true, null],
      ['Guest camera', true, null],
      ['Guest microphone', false, "Not recorded: Couldn't start"]
    ])
    expect(rows[4]?.partial).toBe(true)
    expect(rows[0]?.layoutUnknown).toBe(true)
    expect(rows.filter((row) => row.layoutUnknown)).toHaveLength(1)
    expect(rows[0]?.localSessionId).toBe(`cloud-iso-${takeId}-host-host-camera-g1`)
    // One guest: no ordinal needed.
    expect(rows[4]?.context).toBeNull()
  })

  it('nothing imports past retention', () => {
    const late = isoLibraryRows(take.manifest, take.manifest.expiresAtMs)
    expect(late.every((row) => !row.importable)).toBe(true)
    expect(late[0]?.unavailable).toBe('Expired in the cloud')
  })

  it('rebuilds rows from the journal when the cloud no longer lists the take', () => {
    const journal: CloudIsoImportJournal = {
      showId: manifest.showId,
      takeId,
      programRecordingId: 'rec_program',
      records: [
        {
          entryId: 'host/host-camera/g1',
          objectKey: 'k',
          expectedBytes: 10,
          state: 'complete',
          attempts: 1,
          localFileName: 'a.webm',
          bytes: 10,
          error: null
        },
        {
          entryId: 'g_ann/guest-camera/g1',
          objectKey: 'k2',
          expectedBytes: 10,
          state: 'expired',
          attempts: 0,
          localFileName: 'b.webm',
          bytes: null,
          error: null
        }
      ]
    }
    const journalRows = isoJournalRows(journal)
    expect(journalRows.map((row) => [row.title, row.layoutUnknown, row.unavailable])).toEqual([
      ['Host camera', true, null],
      ['Guest camera', false, 'Expired in the cloud']
    ])
  })

  it('follows an import from the journal and its events', () => {
    let imports: IsoImports = new Map()
    imports = isoImportStarting(imports, takeId)
    expect(isoTakeImportSummary(rows, isoTakeImport(imports, takeId)).action).toBe('Starting…')
    imports = isoImportAnswered(imports, takeId, 'job_1')
    const event = {
      jobId: 'job_1',
      showId: manifest.showId,
      takeId,
      entryId: 'host/host-camera/g1',
      state: 'downloading' as const,
      bytes: 450_000,
      error: null,
      localSessionId: null
    }
    imports = reduceIsoImportEvent(imports, event)
    const running = isoTakeImport(imports, takeId)
    expect(running.jobId).toBe('job_1')
    expect(isoTakeImportSummary(rows, running)).toMatchObject({
      running: true,
      action: 'Importing…'
    })
    expect(isoFileWord(running.files.get('host/host-camera/g1'), 900_000)?.label).toBe(
      'Downloading 50%'
    )
    imports = reduceIsoImportEvent(imports, {
      ...event,
      state: 'complete',
      bytes: 900_000,
      localSessionId: 'cloud-iso-x'
    })
    imports = reduceIsoImportEvent(imports, {
      ...event,
      entryId: 'host/host-aux/g1',
      state: 'failed',
      error: 'size mismatch'
    })
    const settled = isoTakeImport(imports, takeId)
    expect(settled.jobId).toBeNull()
    expect(settled.files.get('host/host-camera/g1')?.localSessionId).toBe('cloud-iso-x')
    expect(isoFileWord(settled.files.get('host/host-aux/g1'), null)?.label).toBe("Couldn't import")
    expect(isoTakeImportSummary(rows, settled)).toMatchObject({
      running: false,
      imported: 1,
      failed: 1,
      action: 'Import again'
    })

    // The journal on reconnect keeps what the events said about the session.
    imports = isoImportsFromJournal(imports, [
      {
        showId: manifest.showId,
        takeId,
        programRecordingId: 'rec_program',
        records: [
          {
            entryId: 'host/host-camera/g1',
            objectKey: 'k',
            expectedBytes: 900_000,
            state: 'complete',
            attempts: 1,
            localFileName: 'a.webm',
            bytes: 900_000,
            error: null
          }
        ]
      }
    ])
    expect(isoTakeImport(imports, takeId).files.get('host/host-camera/g1')?.localSessionId).toBe(
      'cloud-iso-x'
    )
  })

  it('a job that fails as a whole asks to try again', () => {
    let imports: IsoImports = isoImportStarting(new Map(), takeId)
    imports = reduceIsoImportEvent(imports, {
      jobId: 'job_1',
      showId: manifest.showId,
      takeId,
      entryId: null,
      state: 'failed',
      error: 'manifest gone'
    })
    expect(isoTakeImport(imports, takeId).failed).toBe(true)
    expect(isoTakeImportSummary(rows, isoTakeImport(imports, takeId)).action).toBe('Import again')
    expect(
      isoTakeImportSummary(rows, isoTakeImport(isoImportAnswered(new Map(), takeId, null), takeId))
        .action
    ).toBe('Import again')
    expect(isoTakeImportSummary(rows, isoTakeImport(new Map(), takeId)).action).toBe(
      'Import separate files'
    )
  })
})

describe('isoRefusalText', () => {
  it('says why a recording has no separate files, in plain words', () => {
    expect(isoRefusalText(status())).toBeNull()
    expect(
      isoRefusalText(status({ lastRefusal: { reason: 'cost-ceiling-too-low', atMs: 1, takeId } }))
    ).toBe('The cost limit is too low for these limits.')
    expect(
      isoRefusalText(status({ lastRefusal: { reason: 'something-new', atMs: 1, takeId: null } }))
    ).toContain('something-new')
  })
})
