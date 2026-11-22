import { useEffect } from 'react'

import { smoothScrollBehavior } from '@/hooks/use-reduced-motion'
import {
  SECTION_FOCUS_ATTRIBUTE,
  SECTION_FOCUS_CONTROL_ATTRIBUTE,
  SECTION_FOCUS_EVENT,
  SECTION_FOCUS_MARK_ATTRIBUTE,
  SECTION_FOCUS_MARK_MS,
  SECTION_FOCUS_TARGET_ATTRIBUTE,
  takeSectionFocus,
  type SectionFocusId
} from '@/lib/section-focus'

const FIRST_CONTROL =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="switch"]:not([disabled]), [role="combobox"]:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The first control inside a target's `data-section-focus-control`. */
const NAMED_CONTROL = FIRST_CONTROL.split(', ')
  .map((control) => `[${SECTION_FOCUS_CONTROL_ATTRIBUTE}] ${control}`)
  .join(', ')

const markTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/**
 * Marks the row a door landed on for a moment, so the eye finds it. A second
 * door while the mark shows starts it over.
 */
function markLanding(target: HTMLElement): void {
  const running = markTimers.get(target)
  if (running !== undefined) clearTimeout(running)
  target.removeAttribute(SECTION_FOCUS_MARK_ATTRIBUTE)
  // A reflow between the two, so the animation runs again from its start.
  void target.offsetWidth
  target.setAttribute(SECTION_FOCUS_MARK_ATTRIBUTE, '')
  markTimers.set(
    target,
    setTimeout(() => {
      markTimers.delete(target)
      target.removeAttribute(SECTION_FOCUS_MARK_ATTRIBUTE)
    }, SECTION_FOCUS_MARK_MS)
  )
}

/**
 * Scrolls the section into view and moves focus to its first control. A
 * section that names a target (`data-section-focus-target`) lands there
 * instead: the row is centred, marked for a moment, and its
 * `data-section-focus-control` (else its first control) takes focus.
 * Navigation only: nothing it touches changes a setting.
 */
export function focusSection(id: SectionFocusId, root: ParentNode = document): boolean {
  const section = root.querySelector<HTMLElement>(`[${SECTION_FOCUS_ATTRIBUTE}="${id}"]`)
  if (!section) return false
  const target = section.querySelector<HTMLElement>(`[${SECTION_FOCUS_TARGET_ATTRIBUTE}]`)
  if (!target) {
    section.scrollIntoView({ behavior: smoothScrollBehavior(), block: 'start' })
    section.querySelector<HTMLElement>(FIRST_CONTROL)?.focus({ preventScroll: true })
    return true
  }
  target.scrollIntoView({ behavior: smoothScrollBehavior(), block: 'center' })
  const control =
    target.querySelector<HTMLElement>(NAMED_CONTROL) ??
    target.querySelector<HTMLElement>(FIRST_CONTROL)
  control?.focus({ preventScroll: true })
  markLanding(target)
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
