import { describe, expect, it } from 'vitest'

import { NativePreviewRunAuthority } from './native-preview-run-authority'

describe('native preview compositor run authority', () => {
  it('rejects a retired compositor run after a newer run is committed', () => {
    const authority = new NativePreviewRunAuthority()

    expect(authority.decision('run-a')).toEqual({ accepted: true, changed: false })
    authority.commit('run-a')
    expect(authority.decision('run-b')).toEqual({ accepted: true, changed: true })
    authority.commit('run-b')

    expect(authority.decision('run-a')).toEqual({ accepted: false, changed: false })
    expect(authority.currentRunId).toBe('run-b')
  })
})
