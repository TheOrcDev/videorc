// Chrome rows (plan 0011): the Stream Manager's on-stream row and a member's
// row wear the Liquid Chrome plates defined in styles.css. Screens take the
// class from here, so the chrome materials stay in the primitives (plan 208
// S4; renderer-style-guards.test.ts holds it).
export const CHROME_ROW_CLASS = Object.freeze({
  /** The row that is on stream: a plate with a polished edge down its left. */
  live: 'chrome-row-live',
  /** A member's row: a quieter plate with an edge in the member hue. */
  member: 'chrome-row-member'
} as const)
