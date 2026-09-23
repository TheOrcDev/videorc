/**
 * Notes text bound. Its own module so the Notes renderer can import it
 * without pulling the whole IPC contract (and the backend types it drags in)
 * into a chunk the main window then loads eagerly (plan 050, asset budget).
 */
export const MAX_NOTES_TEXT_LENGTH = 1_000_000
