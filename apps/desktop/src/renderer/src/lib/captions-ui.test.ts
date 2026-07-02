import { describe, expect, it } from 'vitest'

import type { CaptionsUpdate } from '@/lib/backend'
import { appendCaptionLine, captionStripLines } from './captions-ui'

const update = (seq: number, overrides: Partial<CaptionsUpdate> = {}): CaptionsUpdate => ({
  sessionClientId: 'captions-session-a',
  seq,
  text: `line ${seq}`,
  chunkSeconds: 3,
  ...overrides
})

describe('appendCaptionLine', () => {
  it('appends in order and drops duplicate or out-of-order seqs', () => {
    let lines: CaptionsUpdate[] = []
    lines = appendCaptionLine(lines, update(1))
    lines = appendCaptionLine(lines, update(2))
    lines = appendCaptionLine(lines, update(2))
    lines = appendCaptionLine(lines, update(1))
    expect(lines.map((line) => line.seq)).toEqual([1, 2])
  })

  it('resets the buffer when a new caption session starts', () => {
    let lines = [update(5)]
    lines = appendCaptionLine(lines, update(1, { sessionClientId: 'captions-session-b' }))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.sessionClientId).toBe('captions-session-b')
  })

  it('ignores empty text and caps the buffer', () => {
    let lines: CaptionsUpdate[] = []
    lines = appendCaptionLine(lines, update(1, { text: '   ' }))
    expect(lines).toHaveLength(0)
    for (let seq = 1; seq <= 60; seq += 1) {
      lines = appendCaptionLine(lines, update(seq), 50)
    }
    expect(lines).toHaveLength(50)
    expect(lines.at(0)?.seq).toBe(11)
    expect(lines.at(-1)?.seq).toBe(60)
  })
})

describe('captionStripLines', () => {
  it('returns only the most recent lines', () => {
    const lines = [update(1), update(2), update(3), update(4)]
    expect(captionStripLines(lines, 2).map((line) => line.seq)).toEqual([3, 4])
  })
})
