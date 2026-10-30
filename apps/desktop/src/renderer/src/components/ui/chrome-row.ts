const CHROME_ROW_CLASS = Object.freeze({
  /** The row that is on stream: a plate with a polished edge down its left. */
  live: 'chrome-row-live',
  /** A member's row: a quieter plate with an edge in the member hue. */
  member: 'chrome-row-member'
} as const)

export { CHROME_ROW_CLASS }
