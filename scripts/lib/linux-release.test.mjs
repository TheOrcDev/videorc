import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertLinuxReleaseManifest,
  buildLinuxReleaseManifest,
  parseLinuxReleaseId
} from './linux-release.mjs'
import {
  assertPendingLinuxCandidateManifest,
  linuxCandidatePrefix,
  linuxCandidateObjectDescriptors
} from './linux-release-candidate.mjs'
import { evaluateLinuxReleasePreflight } from './linux-release-preflight.mjs'
import { RELEASE_BUNDLED_OAUTH_ENV } from './release-bundled-oauth.mjs'

function candidate() {
  return buildLinuxReleaseManifest({
    artifactPath: '/tmp/Videorc-0.16.1-linux-x64.AppImage',
    packageVersion: '0.16.1',
    sha256: 'b'.repeat(64),
    sizeBytes: 1234,
    sourceCommit: 'a'.repeat(40),
    env: { VIDEORC_RELEASE_ID: '0.16.1-beta.1' }
  })
}

describe('Linux Beta release contract', () => {
  it('keeps Beta candidates private and separate from Alpha', () => {
    const manifest = candidate()
    assert.equal(manifest.channel, 'beta')
    assert.equal(manifest.stage, 'candidate')
    assert.equal(manifest.acceptanceStatus, 'pending')
    assert.equal(manifest.knownIssuesUrl, 'https://www.videorc.com/linux-beta')
    assert.match(manifest.minimumOS, /Ubuntu 24.04.*GNOME.*Omarchy.*Hyprland/)
    assert.match(manifest.objectKey, /^releases\/linux-beta\/0.16.1-beta.1\//)
    assert.equal(assertPendingLinuxCandidateManifest(manifest), manifest)
    const prefix = linuxCandidatePrefix(manifest)
    assert.equal(prefix, `candidates/linux-beta/0.16.1-beta.1/${'a'.repeat(40)}`)
    assert.ok(
      linuxCandidateObjectDescriptors(manifest).every((item) =>
        item.objectKey.startsWith(`${prefix}/`)
      )
    )
  })

  it('refuses cross-channel manifests and unsigned acceptance claims', () => {
    for (const override of [
      { channel: 'alpha' },
      { filename: `../${candidate().filename}` },
      { filename: `/tmp/${candidate().filename}` },
      { filename: ` ${candidate().filename}` },
      { objectKey: candidate().objectKey.replace('linux-beta', 'linux-alpha') },
      { knownIssuesUrl: 'https://www.videorc.com/linux-alpha' },
      { minimumOS: 'Ubuntu 24.04 LTS or later' },
      { acceptanceStatus: 'waived', stage: 'public' },
      { stage: 'public' },
      {
        acceptanceStatus: 'pass',
        stage: 'public',
        acceptanceRecordUrl: `https://github.com/TheOrcDev/videorc/blob/${'c'.repeat(40)}/docs/acceptance/linux-beta/0.16.2-beta.1.json`
      },
      {
        acceptanceStatus: 'pass',
        stage: 'public',
        acceptanceRecordUrl: 'https://example.test/pass.json'
      },
      {
        acceptanceStatus: 'pass',
        stage: 'public',
        acceptanceRecordUrl:
          'https://github.com/TheOrcDev/videorc/blob/main/docs/acceptance/linux-beta/0.16.1-beta.1.json'
      }
    ])
      assert.throws(() => assertLinuxReleaseManifest({ ...candidate(), ...override }))
  })

  it('accepts a passed public manifest only with a commit-pinned record location', () => {
    const manifest = {
      ...candidate(),
      acceptanceStatus: 'pass',
      stage: 'public',
      acceptanceRecordUrl: `https://github.com/TheOrcDev/videorc/blob/${'c'.repeat(40)}/docs/acceptance/linux-beta/0.16.1-beta.1.json`
    }
    assert.equal(assertLinuxReleaseManifest(manifest, { requireAccepted: true }), manifest)
  })

  it('accepts only positive, canonical supported channel IDs', () => {
    assert.deepEqual(parseLinuxReleaseId('0.16.1-beta.1'), {
      bundleVersion: '0.16.1',
      channel: 'beta',
      prereleaseNumber: 1
    })
    for (const id of [
      '0.16.1-beta.0',
      '0.16.1-beta.01',
      '0.16.1-stable.1',
      '0.16.1',
      '0.16.1-beta.9007199254740992'
    ]) {
      assert.throws(() => parseLinuxReleaseId(id))
    }
  })

  it('preflights a Beta candidate with the same host, source and OAuth requirements', () => {
    const env = {
      VIDEORC_RELEASE_ID: '0.16.1-beta.1',
      ...Object.fromEntries(RELEASE_BUNDLED_OAUTH_ENV.map((name) => [name, 'test-credential']))
    }
    const facts = {
      arch: 'x64',
      platform: 'linux',
      gitClean: true,
      packageVersion: '0.16.1',
      paths: { pin: true },
      tools: { cargo: true },
      changelogEntrySupportsLinux: true,
      env
    }
    assert.equal(evaluateLinuxReleasePreflight(facts).ok, true)
    assert.equal(evaluateLinuxReleasePreflight({ ...facts, gitClean: false }).ok, false)
    assert.equal(
      evaluateLinuxReleasePreflight({
        ...facts,
        env: { ...env, VIDEORC_LINUX_RELEASE_STAGE: 'public' }
      }).ok,
      false
    )
  })
})
