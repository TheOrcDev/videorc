import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { ONBOARDING_DISMISSED_VALUE, STORAGE_KEYS } from './capture'
import {
  completeFirstRun,
  createFirstRunStartup,
  FIRST_RUN_STEPS,
  firstRunDecision,
  parseFirstRunRecord,
  writeFirstRunRecord,
  type FirstRunRecord
} from './first-run'
import { checkWhatsNew, WHATS_NEW_STORAGE_KEY } from './whats-new'
import { validateElectronInvokeResult } from '../../../shared/electron-ipc-contract'

const updatedAt = '2026-10-27T12:00:00.000Z'
const record = (status: FirstRunRecord['status']): FirstRunRecord => ({
  version: 1,
  status,
  step: 'permissions',
  updatedAt
})
const runtime = { platform: 'darwin', firstRunSuppressed: false }

function storage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed))
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    })
  }
}

describe('first-run record', () => {
  it.each(['in-progress', 'done', 'skipped', 'existing-install'] as const)(
    'round trips %s with an injectable store',
    (status) => {
      const store = storage()
      expect(writeFirstRunRecord(status, store, updatedAt)).toEqual(record(status))
      expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))).toEqual(record(status))
      expect(FIRST_RUN_STEPS).toEqual(['permissions'])
    }
  )

  it.each([
    null,
    '',
    '{',
    'null',
    '[]',
    '1',
    '{}',
    JSON.stringify({ ...record('done'), version: 2 }),
    JSON.stringify({ ...record('done'), status: 'unknown' }),
    JSON.stringify({ ...record('done'), status: ['done'] }),
    JSON.stringify({ ...record('done'), step: 'unknown' }),
    JSON.stringify({ ...record('done'), updatedAt: 123 }),
    JSON.stringify({ ...record('done'), updatedAt: 'invalid' })
  ])('treats an invalid or unknown record as absent: %s', (value) => {
    expect(parseFirstRunRecord(value)).toBeNull()
  })

  it.each(['done', 'skipped'] as const)('completes as %s and dismisses older apps', (status) => {
    const store = storage()
    completeFirstRun(status, store)
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))?.status).toBe(status)
    expect(store.getItem(STORAGE_KEYS.onboarding)).toBe(ONBOARDING_DISMISSED_VALUE)
  })
})

describe('firstRunDecision', () => {
  const fresh = {
    record: null,
    legacyOnboardingValue: null,
    whatsNewLastSeen: null,
    suppressed: false
  }

  it.each(['darwin', 'win32'])('shows every fresh %s install regardless of grants', (platform) => {
    expect(firstRunDecision({ ...fresh, platform })).toBe('show')
  })

  it.each(['linux', undefined])('waits or hides on %s', (platform) => {
    expect(firstRunDecision({ ...fresh, platform })).toBe('hide')
    expect(firstRunDecision({ ...fresh, record: record('in-progress'), platform })).toBe('hide')
  })

  it.each(['creator-ux-v1', ONBOARDING_DISMISSED_VALUE, ''])(
    'keeps a legacy seeded profile hidden: %s',
    (legacyOnboardingValue) => {
      expect(firstRunDecision({ ...fresh, platform: 'darwin', legacyOnboardingValue })).toBe('hide')
    }
  )

  it('keeps an install holding only the What’s New key hidden', () => {
    expect(firstRunDecision({ ...fresh, platform: 'darwin', whatsNewLastSeen: '0.9.2' })).toBe(
      'hide'
    )
  })

  it.each(['in-progress', 'done', 'skipped', 'existing-install'] as const)(
    'lets the %s record take precedence over migration markers',
    (status) => {
      const input = {
        ...fresh,
        platform: 'darwin',
        record: record(status),
        legacyOnboardingValue: 'creator-ux-v1',
        whatsNewLastSeen: '0.9.2'
      }
      expect(firstRunDecision(input)).toBe(status === 'in-progress' ? 'show' : 'hide')
      expect(firstRunDecision({ ...input, suppressed: true })).toBe('hide')
    }
  )
})

describe('first-run startup ordering', () => {
  it('snapshots once, waits for runtime, persists before What’s New, and resumes after quitting', async () => {
    const store = storage()
    const startup = createFirstRunStartup(store)
    expect(startup.snapshot).toBe('fresh')
    expect(store.getItem.mock.calls).toEqual([
      [STORAGE_KEYS.firstRun],
      [STORAGE_KEYS.onboarding],
      [WHATS_NEW_STORAGE_KEY]
    ])
    expect(startup.finalize(null)).toBeNull()
    expect(store.setItem).not.toHaveBeenCalled()

    expect(startup.finalize(runtime)).toBe('show')
    await checkWhatsNew({ version: '1.0.0', runtimePlatform: 'darwin', store })
    expect(store.setItem.mock.calls.map(([key]) => key)).toEqual([
      STORAGE_KEYS.firstRun,
      WHATS_NEW_STORAGE_KEY
    ])
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))?.status).toBe('in-progress')
    expect(createFirstRunStartup(store).finalize(runtime)).toBe('show')
    // React StrictMode and later runtime refreshes do not re-read or re-write.
    store.getItem.mockClear()
    store.setItem.mockClear()
    expect(startup.finalize(runtime)).toBe('show')
    expect(store.getItem).not.toHaveBeenCalled()
    expect(store.setItem).not.toHaveBeenCalled()
  })

  it('keeps the synchronous snapshot even if a legacy key changes while runtime loads', () => {
    const store = storage()
    const startup = createFirstRunStartup(store)
    store.setItem(WHATS_NEW_STORAGE_KEY, '1.0.0')
    expect(startup.finalize(runtime)).toBe('show')
  })

  it.each(['done', 'skipped'] as const)('keeps %s hidden across shell remounts', (status) => {
    const store = storage()
    const startup = createFirstRunStartup(store)
    expect(startup.finalize(runtime)).toBe('show')
    startup.complete(status)
    expect(startup.finalize(runtime)).toBe('hide')
    expect(createFirstRunStartup(store).finalize(runtime)).toBe('hide')
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))?.status).toBe(status)
    expect(store.getItem(STORAGE_KEYS.onboarding)).toBe(ONBOARDING_DISMISSED_VALUE)
  })

  it.each([STORAGE_KEYS.onboarding, WHATS_NEW_STORAGE_KEY])('migrates %s exactly once', (key) => {
    const store = storage({ [key]: '' })
    const startup = createFirstRunStartup(store)
    expect(startup.finalize(runtime)).toBe('hide')
    expect(startup.finalize(runtime)).toBe('hide')
    expect(store.setItem).toHaveBeenCalledTimes(1)
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))?.status).toBe(
      'existing-install'
    )
    createFirstRunStartup(store).finalize(runtime)
    expect(store.setItem).toHaveBeenCalledTimes(1)
  })

  it.each<Record<string, string>>([
    {},
    { [WHATS_NEW_STORAGE_KEY]: '1.0.0' },
    { [STORAGE_KEYS.firstRun]: JSON.stringify(record('in-progress')) }
  ])('suppresses without any first-run or legacy writes', (seed) => {
    const store = storage(seed)
    const startup = createFirstRunStartup(store)
    expect(startup.finalize({ ...runtime, firstRunSuppressed: true })).toBe('hide')
    expect(startup.finalize(runtime)).toBe('hide')
    expect(store.setItem).not.toHaveBeenCalled()
  })

  it('does not start setup on a fresh Linux profile', () => {
    const store = storage()
    expect(createFirstRunStartup(store).finalize({ ...runtime, platform: 'linux' })).toBe('hide')
    expect(store.setItem).not.toHaveBeenCalled()
  })

  it('treats a corrupt record as fresh', () => {
    const store = storage({ [STORAGE_KEYS.firstRun]: 'garbage' })
    expect(createFirstRunStartup(store).finalize(runtime)).toBe('show')
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))?.status).toBe('in-progress')
  })

  it('preserves the suppression flag through preload’s runtime result validator', () => {
    expect(validateElectronInvokeResult('app:get-runtime-info', runtime)).toEqual(runtime)
    expect(
      validateElectronInvokeResult('app:get-runtime-info', { ...runtime, firstRunSuppressed: true })
    ).toEqual({ ...runtime, firstRunSuppressed: true })
  })

  it('wires the shell to snapshot before rendering and withholds What’s New until finalized', () => {
    const shell = readFileSync(new URL('../components/app-shell.tsx', import.meta.url), 'utf8')
    expect(shell.indexOf('createFirstRunStartup(localStorage)')).toBeLessThan(
      shell.indexOf('export function AppShell')
    )
    expect(shell).toContain('firstRunStartup?.finalize(runtimeInfo)')
    expect(shell).toContain('if (!runtimeInfo || firstRunVisibility !== null) return')
    expect(shell).toContain('firstRunVisibility === null ? undefined : runtimeInfo?.version')
    expect(shell).toContain("whatsNew.open && firstRunVisibility === 'hide' && !onboardingOpen")
    expect(shell).not.toContain('shouldShowPermissionsOnboarding')
  })
})
