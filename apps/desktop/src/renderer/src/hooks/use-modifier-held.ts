import { useEffect, useState } from 'react'

import { commandModifierKey, nextModifierHeldState } from '@/lib/shortcut-overlay'

/**
 * True while the command modifier (⌘ / Ctrl) is physically down.
 *
 * Reads from two sources, because one of them is lossy:
 *
 * - **The main process**, which intercepts ⌘1–⌘9 in `before-input-event` and
 *   therefore sees every modifier transition. This is the authority.
 * - **Window key events**, which never see those chords — nor, in practice,
 *   the keyup that ends one — but still work in contexts without the Electron
 *   bridge.
 *
 * Plus two repairs that cost nothing: a fired page shortcut closes the layer
 * (the reminder did its job), and pointer movement without the modifier
 * clears any state that somehow survived both signals.
 *
 * The rules live in `lib/shortcut-overlay`; this is the DOM/IPC adapter.
 */
export function useModifierHeld(platform: string | undefined): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const modifier = commandModifierKey(platform)
    const apply = (probe: Parameters<typeof nextModifierHeldState>[1]): void => {
      setHeld((current) => nextModifierHeldState(current, probe))
    }

    // keydown repeats while a key is held; reducing from the real modifier
    // state makes repeats idempotent instead of thrash.
    const onKey = (event: KeyboardEvent): void =>
      apply({ kind: 'key', modifierDown: event.getModifierState(modifier) })
    const onBlur = (): void => apply({ kind: 'blur' })
    const onVisibilityChange = (): void =>
      apply({ kind: 'visibility', hidden: document.visibilityState === 'hidden' })
    const onPointerMove = (event: MouseEvent): void => {
      // Only ever a repair, never the thing that opens the layer: moving the
      // mouse with ⌘ already down must not make chips appear out of nowhere.
      if (!event.metaKey && !event.ctrlKey) {
        apply({ kind: 'pointer', modifierDown: false })
      }
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    window.addEventListener('mousemove', onPointerMove)
    document.addEventListener('visibilitychange', onVisibilityChange)
    const offModifier = window.videorc?.onShortcutModifier?.((modifierDown) =>
      apply({ kind: 'main', modifierDown })
    )
    const offNavigate = window.videorc?.onShortcutNavigate?.(() =>
      apply({ kind: 'shortcut-fired' })
    )

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('mousemove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      offModifier?.()
      offNavigate?.()
    }
  }, [platform])

  return held
}
