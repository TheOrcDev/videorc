import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AiCapabilities,
  EntitlementsSnapshot,
  RecordingFinalizationEvent,
  SessionSummary
} from './backend'
import {
  CLEAN_CUT_ATTEMPTED_MAX,
  CLEAN_CUT_ATTEMPTED_STORAGE_KEY,
  CLEAN_CUT_AUTO_STORAGE_KEY,
  autoRunCleanCut,
  cleanCutAutoFromStorage,
  cleanCutAutoToStorage,
  decideCleanCutAutoRun,
  parseAttemptedSessionIds,
  resetCleanCutAutoClaims,
  withAttemptedSessionId,
  type CleanCutAutoContext,
  type CleanCutAutoInput,
  type CleanCutStorage
} from './clean-cut-auto'
import type { CleanCutSession } from './clean-cut-view'
import { DEFAULT_BASIC_ENTITLEMENTS } from './entitlements'

const toastMock = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('./toast', () => ({ toast: toastMock }))

const PREMIUM: EntitlementsSnapshot = {
  ...DEFAULT_BASIC_ENTITLEMENTS,
  tier: 'premium',
  capabilities: DEFAULT_BASIC_ENTITLEMENTS.capabilities.map((capability) => ({
    ...capability,
    state: 'enabled' as const,
    reason: undefined
  }))
}

const AVAILABLE = {
  cleanCut: { supported: true, available: true, reasonCode: null }
} as unknown as AiCapabilities

function session(overrides: Partial<CleanCutSession> = {}): CleanCutSession {
  return {
    id: 'rec-1',
    title: 'Tutorial',
    startedAt: '2026-10-03T14:00:00Z',
    durationMs: 600_000,
    status: 'completed',
    mode: 'record',
    mp4Path: '/videos/tutorial.mp4',
    finalizationState: 'finalizing',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

const FINALIZED: RecordingFinalizationEvent = {
  sessionId: 'rec-1',
  state: 'finalized',
  mp4Path: '/videos/tutorial.mp4',
  updatedAt: '2026-10-03T14:11:00Z'
}

function memoryStorage(initial: Record<string, string> = {}): CleanCutStorage & {
  values: Record<string, string>
} {
  const values = { ...initial }
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    }
  }
}

function input(overrides: Partial<CleanCutAutoInput> = {}): CleanCutAutoInput {
  return {
    event: FINALIZED,
    session: session({ finalizationState: 'finalized' }),
    autoEnabled: true,
    attempted: false,
    consent: true,
    premium: true,
    available: true,
    ...overrides
  }
}

beforeEach(() => {
  resetCleanCutAutoClaims()
  toastMock.warning.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the preference and the ledger', () => {
  it('is off unless chosen', () => {
    expect(cleanCutAutoFromStorage(null)).toBe(false)
    expect(cleanCutAutoFromStorage('0')).toBe(false)
    expect(cleanCutAutoFromStorage('1')).toBe(true)
    expect(cleanCutAutoToStorage(true)).toBe('1')
    expect(cleanCutAutoToStorage(false)).toBe('0')
  })

  it('remembers at most 50 sessions, newest last', () => {
    expect(parseAttemptedSessionIds('not json')).toEqual([])
    expect(parseAttemptedSessionIds('["a", 3, "", "b"]')).toEqual(['a', 'b'])
    expect(withAttemptedSessionId(['a', 'b'], 'a')).toEqual(['b', 'a'])
    const full = Array.from({ length: CLEAN_CUT_ATTEMPTED_MAX }, (_, index) => `s${index}`)
    const next = withAttemptedSessionId(full, 'new')
    expect(next).toHaveLength(CLEAN_CUT_ATTEMPTED_MAX)
    expect(next[0]).toBe('s1')
    expect(next.at(-1)).toBe('new')
  })
})

describe('decideCleanCutAutoRun (plan 119 S15)', () => {
  it('runs for a finished recording when everything says yes', () => {
    expect(decideCleanCutAutoRun(input())).toEqual({ kind: 'run' })
    expect(
      decideCleanCutAutoRun(
        input({ session: session({ mode: 'record+stream', finalizationState: 'finalized' }) })
      )
    ).toEqual({ kind: 'run' })
  })

  it.each([
    ['not-finalized', { event: { ...FINALIZED, state: 'finalizing' as const } }],
    ['setting-off', { autoEnabled: false }],
    ['already-attempted', { attempted: true }],
    ['unknown-session', { session: null }],
    ['not-eligible', { session: session({ mode: 'stream', mp4Path: undefined }) }],
    ['not-eligible', { session: session({ mode: 'imported' }) }],
    ['not-eligible', { session: session({ derivedFromSessionId: 'rec-0' }) }],
    ['not-eligible', { session: session({ cleanCutOfSessionId: 'rec-0' }) }],
    ['not-eligible', { session: session({ mp4Path: undefined }) }],
    ['not-eligible', { session: session({ durationMs: 4_000 }) }],
    ['no-consent', { consent: false }],
    ['not-premium', { premium: false }],
    ['unavailable', { available: false }]
  ] as Array<[string, Partial<CleanCutAutoInput>]>)('skips with %s', (reason, overrides) => {
    expect(decideCleanCutAutoRun(input(overrides))).toEqual({ kind: 'skip', reason })
  })
})

describe('autoRunCleanCut', () => {
  function context(overrides: Partial<CleanCutAutoContext> = {}): CleanCutAutoContext & {
    request: ReturnType<typeof vi.fn>
  } {
    const request = vi.fn(async (method: string) => {
      if (method === 'cleanCut.start') return { id: 'job-1' }
      return { items: [] }
    })
    return {
      request,
      sessions: [session()],
      consent: true,
      entitlements: PREMIUM,
      capabilities: AVAILABLE,
      storage: memoryStorage({ [CLEAN_CUT_AUTO_STORAGE_KEY]: '1' }),
      ...overrides
    } as CleanCutAutoContext & { request: ReturnType<typeof vi.fn> }
  }

  it('starts one clean cut per session, remembering it before the call', async () => {
    const storage = memoryStorage({ [CLEAN_CUT_AUTO_STORAGE_KEY]: '1' })
    const studio = context({ storage })
    studio.request.mockImplementation(async (method: string) => {
      if (method === 'cleanCut.start') {
        // Written before the job starts, so a crash never retries by itself.
        expect(parseAttemptedSessionIds(storage.values[CLEAN_CUT_ATTEMPTED_STORAGE_KEY])).toEqual([
          'rec-1'
        ])
      }
      return { id: 'job-1' }
    })
    await expect(autoRunCleanCut(FINALIZED, studio)).resolves.toEqual({ kind: 'run' })
    expect(studio.request).toHaveBeenCalledTimes(1)
    expect(studio.request).toHaveBeenCalledWith('cleanCut.start', {
      sessionId: 'rec-1',
      mode: 'clean',
      consentToUploadAudio: true
    })

    await expect(autoRunCleanCut(FINALIZED, studio)).resolves.toEqual({
      kind: 'skip',
      reason: 'already-attempted'
    })
    // Another window (a reload) reads the ledger.
    resetCleanCutAutoClaims()
    await expect(autoRunCleanCut(FINALIZED, studio)).resolves.toMatchObject({
      reason: 'already-attempted'
    })
    expect(studio.request).toHaveBeenCalledTimes(1)
  })

  it('reads nothing and starts nothing with the switch off', async () => {
    const studio = context({ storage: memoryStorage() })
    await expect(autoRunCleanCut(FINALIZED, studio)).resolves.toEqual({
      kind: 'skip',
      reason: 'setting-off'
    })
    expect(studio.request).not.toHaveBeenCalled()
  })

  it('needs consent, Premium and the capability', async () => {
    for (const overrides of [
      { consent: false },
      { entitlements: DEFAULT_BASIC_ENTITLEMENTS },
      { entitlements: null },
      { capabilities: null },
      {
        capabilities: {
          cleanCut: { supported: true, available: false, reasonCode: 'quota-exhausted' }
        } as unknown as AiCapabilities
      }
    ]) {
      resetCleanCutAutoClaims()
      const studio = context(overrides)
      const decision = await autoRunCleanCut(FINALIZED, studio)
      expect(decision.kind).toBe('skip')
      expect(studio.request).not.toHaveBeenCalledWith('cleanCut.start', expect.anything())
    }
  })

  it('never cuts a stream-only, imported or derived session', async () => {
    for (const row of [
      session({ mode: 'stream', mp4Path: undefined }),
      session({ mode: 'imported' }),
      session({ derivedFromSessionId: 'rec-0' })
    ]) {
      resetCleanCutAutoClaims()
      const studio = context({ sessions: [row as SessionSummary] })
      await expect(
        autoRunCleanCut({ ...FINALIZED, mp4Path: row.mp4Path }, studio)
      ).resolves.toEqual({
        kind: 'skip',
        reason: 'not-eligible'
      })
      expect(studio.request).not.toHaveBeenCalledWith('cleanCut.start', expect.anything())
    }
  })

  it('reads the row again when the loaded page lacks it or still says running', async () => {
    const studio = context({ sessions: [session({ status: 'running' })] })
    studio.request.mockImplementation(async (method: string) =>
      method === 'sessions.list' ? { items: [session()] } : { id: 'job-1' }
    )
    await expect(autoRunCleanCut(FINALIZED, studio)).resolves.toEqual({ kind: 'run' })
    expect(studio.request.mock.calls.map(([method]) => method)).toEqual([
      'sessions.list',
      'cleanCut.start'
    ])
  })

  it('says quietly when the start was refused, but not for a job already running', async () => {
    const refused = Object.assign(new Error('This month is used up.'), { code: 'unavailable' })
    const studio = context()
    studio.request.mockRejectedValueOnce(refused)
    await autoRunCleanCut(FINALIZED, studio)
    expect(toastMock.warning).toHaveBeenCalledWith(
      "Your clean cut didn't start",
      expect.objectContaining({ description: 'This month is used up.' })
    )

    resetCleanCutAutoClaims()
    toastMock.warning.mockClear()
    const running = Object.assign(new Error('Already.'), { code: 'already-running' })
    const again = context({ sessions: [session({ id: 'rec-2' })] })
    again.request.mockRejectedValueOnce(running)
    await autoRunCleanCut({ ...FINALIZED, sessionId: 'rec-2' }, again)
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('works without storage, once per window', async () => {
    const studio = context({ storage: null })
    // No storage: the switch reads off.
    await expect(autoRunCleanCut(FINALIZED, studio)).resolves.toMatchObject({
      reason: 'setting-off'
    })
    const throwing: CleanCutStorage = {
      getItem: (key) => (key === CLEAN_CUT_AUTO_STORAGE_KEY ? '1' : null),
      setItem: () => {
        throw new Error('quota')
      }
    }
    const guarded = context({ storage: throwing })
    await expect(autoRunCleanCut(FINALIZED, guarded)).resolves.toEqual({ kind: 'run' })
    await expect(autoRunCleanCut(FINALIZED, guarded)).resolves.toMatchObject({
      reason: 'already-attempted'
    })
  })
})
