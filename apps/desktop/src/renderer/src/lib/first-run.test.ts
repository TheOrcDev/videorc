import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { ONBOARDING_DISMISSED_VALUE, STORAGE_KEYS } from './capture'
import {
  completeFirstRun,
  createFirstRunStartup,
  FIRST_RUN_STEPS,
  firstRunDecision,
  firstRunShellSurface,
  firstRunStepPosition,
  firstRunStepsFor,
  nextFirstRunStep,
  previousFirstRunStep,
  parseFirstRunRecord,
  writeFirstRunRecord,
  type FirstRunGoal,
  type FirstRunRecord,
  type FirstRunSetupMode
} from './first-run'
import { checkWhatsNew, WHATS_NEW_STORAGE_KEY } from './whats-new'
import { validateElectronInvokeResult } from '../../../shared/electron-ipc-contract'

const updatedAt = '2026-10-27T12:00:00.000Z'
const record = (status: FirstRunRecord['status']): FirstRunRecord => ({
  version: 2,
  status,
  step: 'permissions',
  goal: null,
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
      expect(FIRST_RUN_STEPS).toEqual(['permissions', 'goal', 'look', 'sound', 'destinations'])
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
    JSON.stringify({ ...record('done'), version: 3 }),
    JSON.stringify({ ...record('done'), status: 'unknown' }),
    JSON.stringify({ ...record('done'), status: ['done'] }),
    JSON.stringify({ ...record('done'), updatedAt: 123 }),
    JSON.stringify({ ...record('done'), updatedAt: 'invalid' })
  ])('treats an invalid or unknown record as absent: %s', (value) => {
    expect(parseFirstRunRecord(value)).toBeNull()
  })

  it.each(['in-progress', 'done', 'skipped', 'existing-install'] as const)(
    'normalizes a v1 %s record to v2 without reopening finished setup',
    (status) => {
      const legacy = { version: 1, status, step: 'permissions', updatedAt }
      const parsed = parseFirstRunRecord(JSON.stringify(legacy))
      expect(parsed).toEqual(record(status))
      const store = storage({ [STORAGE_KEYS.firstRun]: JSON.stringify(legacy) })
      const startup = createFirstRunStartup(store)
      expect(startup.snapshot).toBe(status === 'in-progress' ? 'resume' : 'finished')
      expect(startup.step).toBe('permissions')
      expect(startup.goal).toBeNull()
      expect(startup.finalize(runtime)).toBe(status === 'in-progress' ? 'show' : 'hide')
    }
  )

  it.each(['in-progress', 'done', 'skipped', 'existing-install'] as const)(
    'keeps %s and falls back to permissions for an unknown v2 step',
    (status) => {
      expect(
        parseFirstRunRecord(JSON.stringify({ ...record(status), step: 'unknown', goal: 'both' }))
      ).toEqual({ ...record(status), goal: 'both' })
    }
  )

  it.each(['record', 'stream', 'both'] as const)('parses the %s goal', (goal) => {
    expect(parseFirstRunRecord(JSON.stringify({ ...record('in-progress'), goal }))?.goal).toBe(goal)
  })

  it.each([undefined, null, 'unknown', 1, ['record'], {}])(
    'normalizes an unknown goal to null: %s',
    (goal) => {
      expect(parseFirstRunRecord(JSON.stringify({ ...record('in-progress'), goal }))).toEqual(
        record('in-progress')
      )
    }
  )

  it.each(['done', 'skipped'] as const)('preserves progress when completing as %s', (status) => {
    const progress = { step: 'sound', goal: 'record' } as const
    const store = storage()
    writeFirstRunRecord('in-progress', store, updatedAt, progress)
    completeFirstRun(status, store)
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))).toMatchObject({
      version: 2,
      status,
      ...progress
    })
    expect(store.getItem(STORAGE_KEYS.onboarding)).toBe(ONBOARDING_DISMISSED_VALUE)
  })

  it.each(['done', 'skipped'] as const)('completes as %s and dismisses older apps', (status) => {
    const store = storage()
    completeFirstRun(status, store)
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))?.status).toBe(status)
    expect(store.getItem(STORAGE_KEYS.onboarding)).toBe(ONBOARDING_DISMISSED_VALUE)
  })
})

describe('first-run step logic', () => {
  const modes: FirstRunSetupMode[] = [
    { kind: 'first-run' },
    { kind: 'replay', returnTo: 'settings' }
  ]
  const goals: (FirstRunGoal | null)[] = [null, 'record', 'stream', 'both']
  for (const mode of modes) {
    for (const platform of ['darwin', 'win32', 'linux', undefined]) {
      it.each(goals)(`${mode.kind} on ${platform} walks the applicable steps for %s`, (goal) => {
        const context = { goal, platform, mode }
        const expected = [
          'permissions',
          'goal',
          'look',
          'sound',
          ...(goal === 'record' ? [] : ['destinations'])
        ]
        expect(firstRunStepsFor(context)).toEqual(expected)
        firstRunStepsFor(context).forEach((step, index) => {
          expect(firstRunStepPosition(step, context)).toEqual({
            index: index + 1,
            count: expected.length
          })
          expect(nextFirstRunStep(step, context)).toBe(expected[index + 1] ?? null)
          expect(previousFirstRunStep(step, context)).toBe(expected[index - 1] ?? null)
        })
      })
    }
  }

  it('counts five steps before a goal is picked and four for recordings', () => {
    const context = { goal: null, platform: 'darwin', mode: modes[0] }
    expect(firstRunStepPosition('look', context)).toEqual({ index: 3, count: 5 })
    expect(firstRunStepPosition('sound', { ...context, goal: 'record' })).toEqual({
      index: 4,
      count: 4
    })
    expect(nextFirstRunStep('sound', { ...context, goal: 'record' })).toBeNull()
  })

  it('keeps Linux sharing guidance and handles saved steps excluded by the goal', () => {
    const context = { goal: 'record', platform: 'linux', mode: modes[1] } as const
    expect(nextFirstRunStep('permissions', context)).toBe('goal')
    expect(previousFirstRunStep('permissions', context)).toBeNull()
    expect(firstRunStepPosition('permissions', context)).toEqual({ index: 1, count: 4 })
    expect(nextFirstRunStep('destinations', context)).toBeNull()
    expect(previousFirstRunStep('destinations', context)).toBe('sound')
    expect(firstRunStepPosition('destinations', context)).toEqual({ index: 4, count: 4 })
  })
})

describe('firstRunDecision', () => {
  const fresh = {
    record: null,
    legacyOnboardingValue: null,
    whatsNewLastSeen: null,
    suppressed: false
  }

  it.each(['darwin', 'win32', 'linux'])(
    'shows every fresh %s install regardless of grants',
    (platform) => {
      expect(firstRunDecision({ ...fresh, platform })).toBe('show')
    }
  )

  it('waits until the platform is known', () => {
    expect(firstRunDecision({ ...fresh, platform: undefined })).toBe('hide')
    expect(firstRunDecision({ ...fresh, record: record('in-progress'), platform: undefined })).toBe(
      'hide'
    )
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
    startup.enterStep('look')
    startup.setGoal('record')
    startup.complete('done')
    expect(store.setItem).not.toHaveBeenCalled()
  })

  it.each(FIRST_RUN_STEPS)('resumes at %s with the chosen goal', (step) => {
    const store = storage()
    const startup = createFirstRunStartup(store)
    startup.finalize(runtime)
    startup.setGoal('both')
    startup.enterStep(step)
    expect(startup.step).toBe(step)
    expect(startup.goal).toBe('both')
    const resumed = createFirstRunStartup(store)
    expect(resumed.snapshot).toBe('resume')
    expect(resumed.step).toBe(step)
    expect(resumed.goal).toBe('both')
    expect(resumed.finalize(runtime)).toBe('show')
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))).toMatchObject({
      version: 2,
      status: 'in-progress',
      step,
      goal: 'both'
    })
  })

  it('saves a new goal without losing the current step, including after going back', () => {
    const store = storage()
    const startup = createFirstRunStartup(store)
    startup.finalize(runtime)
    startup.enterStep('look')
    startup.setGoal('stream')
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))).toMatchObject({
      step: 'look',
      goal: 'stream'
    })
    startup.enterStep('goal')
    startup.setGoal('record')
    startup.complete('done')
    expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))).toMatchObject({
      status: 'done',
      step: 'goal',
      goal: 'record'
    })
  })

  it.each(['in-progress', 'done', 'skipped', 'existing-install'] as const)(
    'replay leaves a %s record and legacy keys byte-identical',
    (status) => {
      const saved = { ...record(status), step: 'sound', goal: 'stream' }
      const raw = JSON.stringify(saved)
      const store = storage({
        [STORAGE_KEYS.firstRun]: raw,
        [STORAGE_KEYS.onboarding]: 'legacy-marker',
        [WHATS_NEW_STORAGE_KEY]: '1.0.0'
      })
      const startup = createFirstRunStartup(store)
      startup.finalize(runtime)
      const mode = { kind: 'replay', returnTo: 'settings' } as const
      startup.enterStep('look', mode)
      startup.setGoal('record', mode)
      startup.complete('skipped', mode)
      expect(store.setItem).not.toHaveBeenCalled()
      expect(store.getItem(STORAGE_KEYS.firstRun)).toBe(raw)
      expect(startup.step).toBe('sound')
      expect(startup.goal).toBe('stream')
    }
  )

  it('writes nothing before finalization or after suppression or completion', () => {
    const store = storage()
    const startup = createFirstRunStartup(store)
    startup.enterStep('look')
    startup.setGoal('record')
    startup.complete('done')
    expect(store.setItem).not.toHaveBeenCalled()
    startup.finalize({ ...runtime, firstRunSuppressed: true })
    startup.enterStep('sound')
    startup.setGoal('both')
    startup.complete('skipped')
    expect(store.setItem).not.toHaveBeenCalled()
    const active = createFirstRunStartup(store)
    active.finalize(runtime)
    active.complete('done')
    store.setItem.mockClear()
    active.enterStep('goal')
    active.setGoal('stream')
    active.complete('skipped')
    expect(store.setItem).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'])(
    'shows the %s existing workspace before runtime info but persists migration only afterward',
    (platform) => {
      const store = storage({ [WHATS_NEW_STORAGE_KEY]: '999.0.0' })
      const startup = createFirstRunStartup(store)
      const decision = startup.finalize(null)
      expect(firstRunShellSurface({ snapshot: startup.snapshot, decision, setupOpen: false })).toBe(
        'workspace'
      )
      expect(store.getItem(STORAGE_KEYS.firstRun)).toBeNull()
      expect(store.setItem).not.toHaveBeenCalled()

      expect(startup.finalize({ ...runtime, platform })).toBe('hide')
      expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))).toMatchObject({
        version: 2,
        status: 'existing-install'
      })
      startup.finalize({ ...runtime, platform })
      expect(store.setItem).toHaveBeenCalledTimes(1)
    }
  )

  it.each([STORAGE_KEYS.onboarding, WHATS_NEW_STORAGE_KEY])(
    'a malformed record still migrates the existing install holding %s',
    (key) => {
      for (const malformed of [
        'garbage',
        '{}',
        JSON.stringify({ ...record('done'), version: 3 }),
        JSON.stringify({ ...record('done'), updatedAt: 'invalid' }),
        JSON.stringify({ ...record('done'), status: 'unknown' })
      ]) {
        const store = storage({ [key]: '', [STORAGE_KEYS.firstRun]: malformed })
        const startup = createFirstRunStartup(store)
        expect(startup.snapshot).toBe('existing-install')
        expect(startup.finalize(runtime)).toBe('hide')
        expect(parseFirstRunRecord(store.getItem(STORAGE_KEYS.firstRun))).toMatchObject({
          version: 2,
          status: 'existing-install'
        })
        expect(store.setItem).toHaveBeenCalledTimes(1)
        expect(createFirstRunStartup(store).finalize(runtime)).toBe('hide')
        expect(store.setItem).toHaveBeenCalledTimes(1)
      }
    }
  )

  it('starts and resumes Linux setup without reopening a completed or suppressed setup', () => {
    const store = storage()
    const linux = { ...runtime, platform: 'linux' }
    const startup = createFirstRunStartup(store)
    expect(startup.finalize(linux)).toBe('show')
    startup.setGoal('record')
    startup.enterStep('sound')
    const resumed = createFirstRunStartup(store)
    expect(resumed.finalize(linux)).toBe('show')
    expect(resumed.step).toBe('sound')
    expect(resumed.goal).toBe('record')
    resumed.complete('done')
    expect(createFirstRunStartup(store).finalize(linux)).toBe('hide')
    const suppressed = storage()
    expect(createFirstRunStartup(suppressed).finalize({ ...linux, firstRunSuppressed: true })).toBe(
      'hide'
    )
    expect(suppressed.setItem).not.toHaveBeenCalled()
    const existing = storage({ [WHATS_NEW_STORAGE_KEY]: '0.14.0' })
    expect(createFirstRunStartup(existing).finalize(linux)).toBe('hide')
    expect(parseFirstRunRecord(existing.getItem(STORAGE_KEYS.firstRun))?.status).toBe(
      'existing-install'
    )
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
    expect(shell).toContain("whatsNew.open && firstRunVisibility === 'hide' && !setupOpen")
    expect(shell).not.toContain('shouldShowPermissionsOnboarding')
  })

  it('renders setup or the placeholder in place of the workspace, and writes the record only on the first launch (plan 203 S5)', () => {
    const shell = readFileSync(new URL('../components/app-shell.tsx', import.meta.url), 'utf8')
    expect(shell).not.toContain('PermissionsOnboarding')
    expect(shell).toContain("surface === 'setup' && setupMode")
    expect(shell).toContain('<FirstRunPlaceholder />')
    expect(shell).toContain("initialStep={replay ? 'permissions' : firstRunStartup?.step}")
    expect(shell).toContain('initialGoal={firstRunStartup?.goal ?? null}')
    expect(shell).toContain('onEnterStep={(step) => firstRunStartup?.enterStep(step, setupMode)}')
    expect(shell).toContain('onGoalChange={(goal) => firstRunStartup?.setGoal(goal, setupMode)}')
    // A replay returns to its page before the record could be written.
    const leave = shell.slice(
      shell.indexOf('const leaveFirstRunSetup'),
      shell.indexOf('[replay, selectLivestreamView, setActive]')
    )
    expect(leave.indexOf('setActive(openTab ?? replay.returnTo)')).toBeGreaterThan(0)
    expect(leave.indexOf('setActive(openTab ?? replay.returnTo)')).toBeLessThan(
      leave.indexOf('firstRunStartup?.complete(completion)')
    )
    // Setup lands on the Studio unless a step names another page (plan 207 D10).
    expect(leave).toContain("setActive(openTab ?? 'studio')")
    // The shell's chords and command-digit navigation ask setup first, like a dialog.
    expect(shell.match(/setupOpenRef\.current \|\| isModalOpen\(document\)/g)).toHaveLength(2)
    expect(shell).toContain('setFirstRunSetupOpen(setupOpen)')
  })
})

describe('firstRunShellSurface (plan 203 S5)', () => {
  it.each(['fresh', 'resume'] as const)(
    'holds a solid placeholder for a %s install until the decision is final',
    (snapshot) => {
      expect(firstRunShellSurface({ snapshot, decision: null, setupOpen: false })).toBe(
        'placeholder'
      )
    }
  )

  it.each(['finished', 'existing-install'] as const)(
    'shows the workspace at once for a %s install',
    (snapshot) => {
      expect(firstRunShellSurface({ snapshot, decision: null, setupOpen: false })).toBe('workspace')
    }
  )

  it('shows setup while it is open, on the first launch and on a replay', () => {
    expect(firstRunShellSurface({ snapshot: 'fresh', decision: 'show', setupOpen: true })).toBe(
      'setup'
    )
    expect(firstRunShellSurface({ snapshot: 'finished', decision: 'hide', setupOpen: true })).toBe(
      'setup'
    )
  })

  it('shows the workspace once setup is left or hidden', () => {
    expect(firstRunShellSurface({ snapshot: 'fresh', decision: 'hide', setupOpen: false })).toBe(
      'workspace'
    )
    expect(firstRunShellSurface({ snapshot: 'resume', decision: 'hide', setupOpen: false })).toBe(
      'workspace'
    )
  })
})
