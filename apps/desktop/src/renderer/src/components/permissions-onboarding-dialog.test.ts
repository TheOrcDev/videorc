import { Children, isValidElement, useEffect, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PermissionsOnboardingDialog } from './permissions-onboarding-dialog'
import { Button } from './ui/button'
import { DialogContent } from './ui/dialog'

const bridgeSpies = vi.hoisted(() => ({ refreshBackend: vi.fn(async () => undefined) }))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    deviceList: { devices: [] },
    refreshBackend: bridgeSpies.refreshBackend,
    handleSystemPermission: vi.fn(),
    runtimeInfo: { platform: 'linux' },
    mediaAccess: { camera: 'not-applicable', microphone: 'not-applicable' }
  }),
  useStudioAudio: () => ({ audioMeter: null })
}))

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return []
    return [child, ...elements(child.props.children as ReactNode)]
  })
}

describe('permissions setup dismissal', () => {
  it('blocks Escape and outside dismissal, hides the X, and only completes through footer buttons', () => {
    const onComplete = vi.fn()
    const dialog = PermissionsOnboardingDialog({ open: true, onComplete })
    const tree = elements(dialog)
    const content = tree.find((element) => element.type === DialogContent)!
    expect(dialog.props).not.toHaveProperty('onOpenChange')
    expect(content.props.showCloseButton).toBe(false)
    const escape = { preventDefault: vi.fn() }
    const outside = { preventDefault: vi.fn() }
    ;(content.props.onEscapeKeyDown as (event: typeof escape) => void)(escape)
    ;(content.props.onInteractOutside as (event: typeof outside) => void)(outside)
    expect(escape.preventDefault).toHaveBeenCalledOnce()
    expect(outside.preventDefault).toHaveBeenCalledOnce()
    expect(onComplete).not.toHaveBeenCalled()

    const buttons = tree.filter((element) => element.type === Button)
    expect(buttons).toHaveLength(1)
    expect(buttons[0].props.children).toContain('Continue')
    ;(buttons[0].props.onClick as () => void)()
    expect(onComplete).toHaveBeenLastCalledWith('done')
  })
})

describe('permission focus refresh', () => {
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
    PermissionsOnboardingDialog({ open: true, onComplete: vi.fn() })
    const cleanup = vi.mocked(useEffect).mock.calls.at(-1)![0]()
    const onFocus = addEventListener.mock.calls[0][1] as () => void
    onFocus()
    expect(recheck).toHaveBeenCalledOnce()
    expect(bridgeSpies.refreshBackend).not.toHaveBeenCalled()
    releaseRecheck()
    await vi.waitFor(() => expect(bridgeSpies.refreshBackend).toHaveBeenCalledOnce())
    if (typeof cleanup === 'function') cleanup()
    expect(removeEventListener).toHaveBeenCalledWith('focus', onFocus)
  })
})
