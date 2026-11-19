// Plan 250: what a smoke reads now that Videorc's own news is a notification
// behind the bell and not a toast. The dev renderer exposes the store's list
// as `window.__videorcSmokeNotifications()`; reading it has no side effect
// (opening the list on screen would mark every entry read).
//
// Use `READ_NOTIFICATIONS_CODE` as the body of the smoke server's `eval-js`,
// or `readNotificationsExpression()` with CDP's `Runtime.evaluate`
// (`awaitPromise: true`).

/** An async function body: returns `{ hook, bellCount, bellTone, count, entries }`. */
export const READ_NOTIFICATIONS_CODE = `
  const bell = document.querySelector('[data-videorc-notification-bell]');
  const bellCount = bell ? Number(bell.getAttribute('data-videorc-notification-count') ?? 0) : null;
  const bellTone = bell ? bell.getAttribute('data-videorc-notification-tone') : null;
  const read = window.__videorcSmokeNotifications;
  if (typeof read !== 'function') {
    return { hook: false, bellCount, bellTone, count: null, entries: [] };
  }
  const state = read();
  return { hook: true, bellCount, bellTone, count: state.count, entries: state.entries };
`

/** The same read as one expression, for `Runtime.evaluate`. */
export function readNotificationsExpression() {
  return `(async () => {${READ_NOTIFICATIONS_CODE}})()`
}

/** What a read returns when the page had nothing to say. */
export function normalizeNotifications(read) {
  const entries = Array.isArray(read?.entries) ? read.entries : []
  return {
    hook: read?.hook === true,
    bellCount: Number.isFinite(read?.bellCount) ? read.bellCount : null,
    bellTone: typeof read?.bellTone === 'string' ? read.bellTone : null,
    count: read?.count ?? null,
    entries: entries
      .filter((entry) => entry && typeof entry.key === 'string')
      .map((entry) => ({
        key: entry.key,
        kind: entry.kind ?? null,
        tone: entry.tone ?? null,
        state: entry.state ?? null,
        title: String(entry.title ?? ''),
        detail: entry.detail == null ? '' : String(entry.detail),
        read: entry.read === true,
        occurrences: Number.isFinite(entry.occurrences) ? entry.occurrences : 1,
        actions: Array.isArray(entry.actions) ? entry.actions.map((action) => action.label) : []
      }))
  }
}

function matches(value, wanted) {
  if (wanted === undefined) return true
  return wanted instanceof RegExp ? wanted.test(value) : value === wanted
}

/**
 * The entries that match: by key (a string or a RegExp), title, detail,
 * tone and state. Every field given must match.
 */
export function findNotifications(read, wanted = {}) {
  return normalizeNotifications(read).entries.filter(
    (entry) =>
      matches(entry.key, wanted.key) &&
      matches(entry.title, wanted.title) &&
      matches(entry.detail, wanted.detail) &&
      matches(entry.tone, wanted.tone) &&
      matches(entry.state, wanted.state)
  )
}

/**
 * How many times the matching news was raised: each entry counts once per
 * occurrence, so a notice that repeats is a storm even on one row.
 */
export function countNotifications(read, wanted = {}) {
  return findNotifications(read, wanted).reduce((sum, entry) => sum + entry.occurrences, 0)
}

/** "title: detail" for each entry, the way a smoke used to collect toast text. */
export function notificationTexts(read) {
  return normalizeNotifications(read).entries.map((entry) =>
    entry.detail ? `${entry.title}: ${entry.detail}` : entry.title
  )
}

/** One line for a failure message: " Notifications: a | b", or nothing. */
export function describeNotifications(read, limit = 4) {
  const texts = notificationTexts(read).slice(0, limit)
  return texts.length > 0 ? ` Notifications: ${texts.join(' | ')}` : ''
}
