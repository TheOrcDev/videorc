import { useEffect, useState } from 'react'

import { commandModifierKey, nextModifierHeldState } from '@/lib/shortcut-overlay'

/**
 * True while the command modifier (⌘ / Ctrl) is physically down.
 *
 * A thin DOM adapter over the state machine in `lib/shortcut-overlay` — the
 * rules, and the reasons for them, live there.
 */
export function useModifierHeld(platform: string | undefined): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const modifier = commandModifierKey(platform)

    // keydown fires repeatedly while a key is held; reducing from the real
    // modifier state makes repeats idempotent instead of thrash.
    const onKey = (event: KeyboardEvent): void => {
      setHeld((current) =>
        nextModifierHeldState(current, {
          kind: 'key',
          modifierDown: event.getModifierState(modifier)
        })
      )
    }
    const onBlur = (): void => {
      setHeld((current) => nextModifierHeldState(current, { kind: 'blur' }))
    }
    const onVisibilityChange = (): void => {
      setHeld((current) =>
        nextModifierHeldState(current, {
          kind: 'visibility',
          hidden: document.visibilityState === 'hidden'
        })
      )
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [platform])

  return held
}
