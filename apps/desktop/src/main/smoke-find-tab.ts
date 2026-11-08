/**
 * How long the smoke command server's `openTab` waits for a tab trigger.
 *
 * Smokes seed `localStorage` and reload the renderer, then open a tab. Since
 * first-run setup (plans 203 and 207) the shell shows a placeholder until the
 * runtime info arrives over IPC, so for a moment after a reload there is no
 * sidebar. On a slow Linux laptop that moment outlasted the old single lookup,
 * and the Clips and record-latency smokes failed with "Could not find tab
 * sources" before doing anything (retest 153).
 */
export const SMOKE_FIND_TAB_TIMEOUT_MS = 15_000

/**
 * The renderer-side lookup, as JavaScript source for the smoke script
 * template. It polls for the trigger (or a `data-videorc-open-tab` button)
 * until the deadline, then throws the same "Could not find tab" error as
 * before, so callers that treat that message as retryable still do.
 */
export const SMOKE_FIND_TAB_SOURCE = `async (doc, tabId, sleep, timeoutMs = ${SMOKE_FIND_TAB_TIMEOUT_MS}, now = () => performance.now()) => {
  const deadline = now() + timeoutMs;
  for (;;) {
    const tab =
      Array.from(doc.querySelectorAll('[data-videorc-tab-trigger]'))
        .find((candidate) => candidate.getAttribute('data-videorc-tab-trigger') === tabId) ??
      doc.querySelector('[data-videorc-open-tab="' + tabId + '"]');
    if (tab) return tab;
    if (now() >= deadline) throw new Error('Could not find tab ' + tabId);
    await sleep(50);
  }
}`
