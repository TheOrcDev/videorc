import { POLL_MAX_OPTIONS } from './backend'

// Plan 188 D2: a message is a vote when its whole text, trimmed, is one ASCII
// digit 1..optionCount, optionally followed by U+FE0F and/or U+20E3 (the
// keycap emoji). The backend's `polls::classify_vote` is the twin; both run
// `protocol-fixtures/poll-votes.json`.

// JavaScript's `\s` already covers U+FEFF; U+0085 is White_Space in Rust's
// `trim` but not in `\s`, so it is added here to keep the twins equal.
const VOTE = /^[\s\u0085]*([0-9])(?:️)?(?:⃣)?[\s\u0085]*$/

/** The 1-based option number a message votes for, or `null` for chat. */
export function classifyVote(text: string, optionCount: number): number | null {
  const match = VOTE.exec(text)
  if (!match) return null
  const digit = Number(match[1])
  return digit >= 1 && digit <= Math.min(optionCount, POLL_MAX_OPTIONS) ? digit : null
}
