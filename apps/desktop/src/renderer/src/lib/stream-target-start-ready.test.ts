import { describe, expect, it } from 'vitest'

import fixture from '../../../../../../protocol-fixtures/stream-target-start-ready.json'
import { isStreamTargetStartReady, type StreamTargetSettings } from './capture'

// `isStreamTargetStartReady` for every destination kind. The same cases drive
// `livestream::lifecycle::start_ready` and the GPUI transport's gate in
// videorc-app-core (`studio/inspector_tests.rs`), so a drift on either side
// fails there or here. Sign-in state is not read: an account kind is ready
// whenever its platform can sign in at all.
describe('isStreamTargetStartReady over the shared fixture', () => {
  it.each(fixture.cases)('$kind: $name', ({ target, ready }) => {
    const settings = { ...fixture.base, ...target } as unknown as StreamTargetSettings
    expect(isStreamTargetStartReady(settings)).toBe(ready)
  })

  it('covers the destination kinds the owner goes live to', () => {
    const kinds = new Set(fixture.cases.map((entry) => entry.kind))
    for (const kind of [
      'youtube-oauth',
      'x-oauth',
      'twitch-oauth',
      'kick-oauth',
      'custom-key',
      'secret-store-key'
    ]) {
      expect(kinds, kind).toContain(kind)
    }
    // Each kind has a ready case; the key kinds also have a not-ready one.
    for (const kind of ['custom-key', 'secret-store-key']) {
      const answers = fixture.cases.filter((entry) => entry.kind === kind).map((e) => e.ready)
      expect(answers, kind).toContain(true)
      expect(answers, kind).toContain(false)
    }
  })
})
