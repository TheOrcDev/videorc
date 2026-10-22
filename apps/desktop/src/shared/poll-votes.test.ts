import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { classifyVote } from './poll-votes'

interface VoteCase {
  text: string
  optionCount: number
  expected: number | null
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../../protocol-fixtures/poll-votes.json', import.meta.url), 'utf8')
) as { cases: VoteCase[] }

describe('classifyVote (plan 188 D2)', () => {
  it('agrees with the shared fixture the backend runs', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(30)
    for (const { text, optionCount, expected } of fixture.cases) {
      expect(classifyVote(text, optionCount), JSON.stringify({ text, optionCount })).toBe(expected)
    }
  })

  it('trims U+0085 like the backend does', () => {
    expect(classifyVote('\u00852\u0085', 2)).toBe(2)
  })
})
