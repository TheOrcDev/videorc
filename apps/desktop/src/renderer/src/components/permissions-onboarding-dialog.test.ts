import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { PermissionsOnboardingDialog } from './permissions-onboarding-dialog'
import { Button } from './ui/button'
import { DialogContent } from './ui/dialog'

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    deviceList: { devices: [] },
    refreshBackend: vi.fn(),
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
    expect(buttons).toHaveLength(2)
    expect(buttons[0].props.variant).toBe('ghost')
    expect(buttons[0].props.children).toBe('Skip for now')
    ;(buttons[0].props.onClick as () => void)()
    expect(onComplete).toHaveBeenLastCalledWith('skipped')
    ;(buttons[1].props.onClick as () => void)()
    expect(onComplete).toHaveBeenLastCalledWith('done')
  })
})
