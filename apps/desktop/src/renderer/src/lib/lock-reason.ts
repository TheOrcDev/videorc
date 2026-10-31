const SESSION_LOCK_REASON =
  "Locked while you're recording or live. Changes apply the next time you record or go live."

// The one wording for each lock, so LockAlert, a toast, a tooltip and a
// disabled control's reason all say the same words. SESSION_LOCK_REASON, above,
// is for the controls a running recording or livestream locks. Strings only:
// code that isn't UI imports them without pulling in a component.

/** The one wording for controls that wait for the app to reconnect. */
const OFFLINE_LOCK_REASON = 'Videorc is reconnecting. These controls come back in a moment.'

/**
 * The session lock that names what it locks: "Destinations and stream
 * details are locked while you're recording or live. …". Without `locks` it
 * is the plain SESSION_LOCK_REASON.
 */
function sessionLockReason(locks?: string): string {
  if (!locks) {
    return SESSION_LOCK_REASON
  }
  return `${locks} are locked while you're recording or live. Changes apply the next time you record or go live.`
}

export { OFFLINE_LOCK_REASON, SESSION_LOCK_REASON, sessionLockReason }
