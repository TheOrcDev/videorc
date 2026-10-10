import { useCallback, useRef, useState } from 'react'

import { toast } from '@/lib/toast'

// One way to copy (plan 174 S1.6b, I-31): success is quiet, because the
// control that copied says "Copied" for a moment (or a menu closing is the
// confirmation); a refused write always says so, because a silent no-op reads
// as a broken button.

/** How long a control says "Copied" after a copy. */
export const COPIED_FEEDBACK_MS = 1500

/**
 * Copies `text` to the clipboard. Resolves true when it landed; on failure it
 * toasts `failure` and resolves false. It never throws.
 */
export async function copyText(text: string, failure = "Couldn't copy that."): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    console.warn('[copy] copy failed', error)
    toast.error(failure)
    return false
  }
}

/**
 * copyText for a button: `copied` is true for 1.5 s after a copy lands, so
 * the button can read "Copied". A second copy restarts the moment.
 */
export function useCopyText(): {
  copied: boolean
  copy: (text: string, failure?: string) => Promise<boolean>
} {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)
  const copy = useCallback(async (text: string, failure?: string): Promise<boolean> => {
    const landed = await copyText(text, failure)
    if (!landed) return false
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setCopied(true)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setCopied(false)
    }, COPIED_FEEDBACK_MS)
    return true
  }, [])
  return { copied, copy }
}
