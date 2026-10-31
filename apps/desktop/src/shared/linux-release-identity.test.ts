import { describe, expect, it } from 'vitest'
import { linuxReleaseIdentityForBuild } from './linux-release-identity'

describe('Linux build release identity', () => {
  const build = { platform: 'linux', packageVersion: '0.16.1' }
  it('keeps ordinary Linux packaging Alpha and other platforms unchanged', () => {
    expect(linuxReleaseIdentityForBuild(build)?.channel).toBe('alpha')
    for (const platform of ['darwin', 'win32']) {
      expect(linuxReleaseIdentityForBuild({ ...build, platform })).toBeNull()
    }
  })
  it('accepts Beta only with matching package version and exact source', () => {
    expect(
      linuxReleaseIdentityForBuild({
        ...build,
        releaseId: '0.16.1-beta.1',
        sourceCommit: 'a'.repeat(40)
      })
    ).toEqual({
      platform: 'linux',
      bundleVersion: build.packageVersion,
      channel: 'beta',
      releaseId: '0.16.1-beta.1',
      sourceCommit: 'a'.repeat(40)
    })
    for (const releaseId of [
      '0.16.0-beta.1',
      '0.16.1-beta.0',
      '0.16.1-beta.01',
      '0.16.1-stable.1'
    ]) {
      expect(() =>
        linuxReleaseIdentityForBuild({ ...build, releaseId, sourceCommit: 'a'.repeat(40) })
      ).toThrow()
    }
    expect(() => linuxReleaseIdentityForBuild({ ...build, releaseId: '0.16.1-beta.1' })).toThrow(
      /source commit/
    )
  })
})
