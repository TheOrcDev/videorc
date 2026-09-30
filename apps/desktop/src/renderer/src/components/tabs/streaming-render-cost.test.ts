import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('Livestream Setup render cost (plan 080 S7)', () => {
  it('keeps the diagnostics subscription out of the destination list', () => {
    // Stats tick several times a second while live. When StreamingSetup
    // subscribed, every tick re-rendered every destination card and the
    // Broadcast info form; the right column owns the subscription now.
    expect(read('./streaming-tab.tsx')).not.toContain('useStudioDiagnostics')
    expect(read('../streaming/destination-card.tsx')).not.toContain('useStudioDiagnostics')
    expect(read('../streaming/go-live-panel.tsx')).toContain('useStudioDiagnostics()')
  })
})
