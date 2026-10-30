import { useEffect, useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Plan 203 S5 (from the retired permissions dialog): grants flip while
// Videorc is in the background, so setup re-reads them when the window
// comes back, the OS snapshot before the capture evidence.

const bridgeSpies = vi.hoisted(() => ({ refreshBackend: vi.fn(async () => undefined) }))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: vi.fn(),
  useRef: vi.fn((initial: unknown) => ({ current: initial })),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()]
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    runtimeInfo: { platform: 'darwin', hardwareAccelerationDisabled: true },
    refreshBackend: bridgeSpies.refreshBackend
  })
}))
vi.mock('@/hooks/use-studio-mic-visual', () => ({
  StudioMicVisualProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('./permissions-step', () => ({ PermissionsStep: () => null }))
vi.mock('./goal-step', () => ({ GoalStep: () => null }))

import { FirstRunSetup } from './first-run-setup'

describe('first-run setup focus refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('rechecks grants before reading capture evidence and removes its focus listener', async () => {
    let releaseRecheck!: () => void
    const recheck = vi.fn(
      () =>
        new Promise<{ restarted: boolean }>((resolve) => {
          releaseRecheck = () => resolve({ restarted: true })
        })
    )
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal('window', {
      videorc: { recheckPermissionGrants: recheck },
      addEventListener,
      removeEventListener
    })
    FirstRunSetup({ mode: { kind: 'first-run' }, onLeave: vi.fn() })
    const cleanups = vi.mocked(useEffect).mock.calls.map(([effect]) => effect())
    expect(addEventListener).toHaveBeenCalledTimes(1)
    const onFocus = addEventListener.mock.calls[0][1] as () => void
    onFocus()
    expect(recheck).toHaveBeenCalledOnce()
    expect(bridgeSpies.refreshBackend).not.toHaveBeenCalled()
    releaseRecheck()
    await vi.waitFor(() => expect(bridgeSpies.refreshBackend).toHaveBeenCalledOnce())
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()
    expect(removeEventListener).toHaveBeenCalledWith('focus', onFocus)
  })

  it('focuses the step a first run resumes at, and leaves Permissions to focus itself', () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const focus = vi.fn()
    const card = {
      querySelector: (selector: string) =>
        selector === '[data-first-run-autofocus]' ? { focus } : null
    }
    const mount = (initialStep?: 'goal'): void => {
      vi.mocked(useEffect).mockClear()
      // The first ref is the card's.
      vi.mocked(useRef).mockImplementationOnce(() => ({ current: card }))
      FirstRunSetup({ mode: { kind: 'first-run' }, initialStep, onLeave: vi.fn() })
      for (const [effect] of vi.mocked(useEffect).mock.calls) effect()
    }

    mount('goal')
    expect(focus).toHaveBeenCalledOnce()

    focus.mockClear()
    mount()
    expect(focus).not.toHaveBeenCalled()
  })
})
