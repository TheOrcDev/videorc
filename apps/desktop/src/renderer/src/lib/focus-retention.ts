// Focus retention across a commit (plan 174 S3.9, C-5). The Scene inspector
// used to disable its whole column while an edit committed, which blurred the
// control the streamer was on: every toggle, nudge or Enter cost the keyboard
// its place. The column now stays enabled, and as a safety net an edit
// remembers the focused control and gives focus back if the commit's
// re-render dropped it to the body. A control the streamer moved on from, or
// one that left the page or became disabled, is left alone.

type Focusable = HTMLElement & { disabled?: boolean }

function stillFocusable(element: Focusable): boolean {
  return (
    element.isConnected &&
    element.disabled !== true &&
    element.closest('[inert], fieldset:disabled') === null
  )
}

/**
 * Remembers the focused element now; the returned function restores focus to
 * it when focus has since fallen to the body (or nowhere) and the element can
 * still take it.
 */
export function rememberFocus(root: Document = document): () => void {
  const remembered = root.activeElement
  if (!(remembered instanceof HTMLElement) || remembered === root.body) return () => {}
  return () => {
    const active = root.activeElement
    if (active === remembered) return
    // The streamer went somewhere else on purpose: never pull focus back.
    if (active && active !== root.body) return
    if (!stillFocusable(remembered)) return
    remembered.focus({ preventScroll: true })
  }
}
