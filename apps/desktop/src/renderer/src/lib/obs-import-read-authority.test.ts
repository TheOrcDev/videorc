import { describe, expect, it } from 'vitest'

import { ObsImportReadAuthority } from './obs-import-read-authority'

describe('ObsImportReadAuthority', () => {
  it('rejects a stale read that resolves after a newer selection', () => {
    const authority = new ObsImportReadAuthority()
    const first = authority.begin('Gaming', 'High quality')
    const second = authority.begin('Tutorials', 'Streaming')

    expect(authority.accepts(first)).toBe(false)
    expect(authority.accepts(second)).toBe(true)
  })

  it('invalidates the displayed plan synchronously when selection changes', () => {
    const authority = new ObsImportReadAuthority()
    const current = authority.begin('Gaming', 'High quality')

    authority.invalidate()

    expect(authority.accepts(current)).toBe(false)
  })

  it('keeps a ticket valid throughout apply until another selection begins', () => {
    const authority = new ObsImportReadAuthority()
    const applying = authority.begin('Tutorials', 'Recording')

    expect(authority.accepts(applying)).toBe(true)
    authority.begin('Tutorials', 'Streaming')
    expect(authority.accepts(applying)).toBe(false)
  })
})
