// Pure helpers for `smoke:gpui-studio` (plan 260 Phase 3), kept here for the unit test.

/** Every word under a tree node: labels and the values text nodes carry. */
export function nodeWords(node) {
  if (!node) return ''
  const words = []
  const walk = (current) => {
    if (current.visible === false) return
    if (typeof current.label === 'string' && current.label) words.push(current.label)
    if (typeof current.value === 'string' && current.value) words.push(current.value)
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return words.join(' ')
}

/** Whether the preview has converged: the committed scene is on screen. */
export function previewConverged(first, latest) {
  if (!latest || latest.sceneRevision == null) return false
  if (latest.sceneRevision !== latest.frameSceneRevision) return false
  return Number(latest.framesRendered ?? 0) > Number(first?.framesRendered ?? 0)
}
