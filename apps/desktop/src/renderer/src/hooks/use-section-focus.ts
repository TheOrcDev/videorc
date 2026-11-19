import { useEffect } from 'react'

import { smoothScrollBehavior } from '@/hooks/use-reduced-motion'
import {
  SECTION_FOCUS_ATTRIBUTE,
  SECTION_FOCUS_EVENT,
  takeSectionFocus,
  type SectionFocusId
} from '@/lib/section-focus'

const FIRST_CONTROL =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="switch"]:not([disabled]), [role="combobox"]:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Scrolls the section into view and moves focus to its first control. */
export function focusSection(id: SectionFocusId, root: ParentNode = document): boolean {
  const section = root.querySelector<HTMLElement>(`[${SECTION_FOCUS_ATTRIBUTE}="${id}"]`)
  if (!section) return false
  section.scrollIntoView({ behavior: smoothScrollBehavior(), block: 'start' })
  section.querySelector<HTMLElement>(FIRST_CONTROL)?.focus({ preventScroll: true })
  return true
}

/**
 * The section whose root carries `data-section-focus={id}` answers a
 * `requestSectionFocus(id)`: once, on mount or on a page already open (plan
 * 250 S4). A second mount does not scroll again.
 *
 * `rendered` is false while the section draws nothing (Videorc Camera before
 * its first status): the request then stays pending, and is taken when the
 * section appears, instead of being spent on a section that is not there.
 */
export function useSectionFocus(id: SectionFocusId, rendered = true): void {
  useEffect(() => {
    const focus = (): void => {
      if (!rendered || !takeSectionFocus(id)) return
      // The frame is never cancelled: a request is taken once, and React's
      // StrictMode unmounts and mounts an effect again at once in
      // development, which would drop the one scroll that was asked for
      // (seen by eye, 2026-11-19). On a section that is gone it finds nothing.
      requestAnimationFrame(() => focusSection(id))
    }
    focus()
    globalThis.addEventListener(SECTION_FOCUS_EVENT, focus)
    return () => globalThis.removeEventListener(SECTION_FOCUS_EVENT, focus)
  }, [id, rendered])
}
