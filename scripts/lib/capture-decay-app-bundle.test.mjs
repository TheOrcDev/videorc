import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

import {
  CAPTURE_DECAY_APP_BUNDLE_PROFILE,
  captureDecayAppBundleIdentityFromExecutable,
  captureDecayAppBundleManifest,
  verifyCaptureDecayDmgAppBundle
} from './capture-decay-app-bundle.mjs'
import {
  assertCaptureDecayCandidateIdentityUnchanged,
  assertCaptureDecayRunnerIdentityUnchanged,
  captureDecayBoundCandidateExecutablePath,
  captureDecayCandidateIdentityFromFiles,
  captureDecayRunnerIdentity
} from './capture-decay-release-acceptance.mjs'
import { SYMLINK_TEST_SKIP } from './symlink-test-support.mjs'

const run = promisify(execFile)

describe('capture-decay app bundle identity', { skip: SYMLINK_TEST_SKIP }, () => {
  it('deterministically binds paths, significant modes, file contents, and symlink targets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-app-bundle-test-'))
    try {
      const first = await createBundleFixture(join(directory, 'first'), {
        resourceMode: 0o600,
        reverseCreationOrder: false
      })
      const second = await createBundleFixture(join(directory, 'second'), {
        resourceMode: 0o644,
        reverseCreationOrder: true
      })

      const firstIdentity = await captureDecayAppBundleIdentityFromExecutable(first.executable)
      const secondIdentity = await captureDecayAppBundleIdentityFromExecutable(second.executable)
      assert.deepEqual(secondIdentity, firstIdentity)
      assert.equal(firstIdentity.profile, CAPTURE_DECAY_APP_BUNDLE_PROFILE)
      assert.equal(firstIdentity.bundleFilename, 'Videorc.app')
      assert.equal(firstIdentity.executableRelativePath, 'Contents/MacOS/Videorc')

      const manifest = await captureDecayAppBundleManifest(first.bundle)
      assert.deepEqual(
        manifest.entries.map((entry) => entry.path),
        [
          'Contents',
          'Contents/MacOS',
          'Contents/MacOS/Videorc',
          'Contents/Resources',
          'Contents/Resources/config-current.json',
          'Contents/Resources/config.json'
        ]
      )
      assert.deepEqual(
        manifest.entries.find((entry) => entry.path === 'Contents/Resources/config-current.json'),
        {
          path: 'Contents/Resources/config-current.json',
          type: 'symlink',
          mode: process.platform === 'win32' ? '0000' : '0111',
          target: 'config.json'
        }
      )
      assert.equal(
        manifest.entries.find((entry) => entry.path === 'Contents/MacOS/Videorc').mode,
        process.platform === 'win32' ? '0000' : '0111'
      )
      assert.equal(
        manifest.entries.find((entry) => entry.path === 'Contents/Resources/config.json').mode,
        '0000'
      )

      if (process.platform !== 'win32') {
        await chmod(second.resource, 0o755)
        assert.notEqual(
          (await captureDecayAppBundleIdentityFromExecutable(second.executable)).manifestSha256,
          firstIdentity.manifestSha256
        )
        await chmod(second.resource, 0o644)
      }
      await writeFile(second.resource, '{"channel":"mutated"}\n')
      assert.notEqual(
        (await captureDecayAppBundleIdentityFromExecutable(second.executable)).manifestSha256,
        firstIdentity.manifestSha256
      )

      // Windows fixture files do not expose POSIX execute bits. The explicit
      // Darwin profile must still reject a non-executable candidate so the
      // production macOS check cannot be weakened by cross-platform tests.
      await chmod(first.executable, 0o644)
      assert.equal(
        (
          await captureDecayAppBundleIdentityFromExecutable(first.executable, {
            platform: 'win32'
          })
        ).profile,
        CAPTURE_DECAY_APP_BUNDLE_PROFILE
      )
      await assert.rejects(
        () =>
          captureDecayAppBundleIdentityFromExecutable(first.executable, {
            platform: 'darwin'
          }),
        hasCode('app-bundle-executable')
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('rejects escaping symlinks and special filesystem entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vab-'))
    const fixture = await createBundleFixture(directory, {
      resourceMode: 0o644,
      reverseCreationOrder: false
    })
    const resources = join(fixture.bundle, 'Contents', 'Resources')
    const unsafeLink = join(resources, 'unsafe-link')
    try {
      await symlink('../../../outside-the-bundle', unsafeLink)
      await assert.rejects(
        () => captureDecayAppBundleIdentityFromExecutable(fixture.executable),
        hasCode('app-bundle-unsafe-symlink')
      )
      await unlink(unsafeLink)

      if (process.platform !== 'win32') {
        const fifoPath = join(resources, 'special.fifo')
        await run('mkfifo', [fifoPath])
        await assert.rejects(
          () => captureDecayAppBundleIdentityFromExecutable(fixture.executable),
          hasCode('app-bundle-special-entry')
        )
      }
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('proves a DMG contains the exact bundle through an injected read-only hdiutil mount', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-dmg-bundle-test-'))
    try {
      const fixture = await createBundleFixture(join(directory, 'candidate'), {
        resourceMode: 0o644,
        reverseCreationOrder: false
      })
      const dmgPath = join(directory, 'Videorc.dmg')
      await writeFile(dmgPath, 'fixture-dmg')
      const expectedIdentity = await captureDecayAppBundleIdentityFromExecutable(fixture.executable)
      const calls = []
      let ownedMountpoint = null
      const runHdiutil = async (args) => {
        calls.push([...args])
        if (args[0] !== 'attach') return
        ownedMountpoint = args[args.indexOf('-mountpoint') + 1]
        await cp(fixture.bundle, join(ownedMountpoint, 'Videorc.app'), {
          recursive: true,
          verbatimSymlinks: true
        })
      }

      assert.deepEqual(
        await verifyCaptureDecayDmgAppBundle({ dmgPath, expectedIdentity }, { runHdiutil }),
        expectedIdentity
      )
      assert.deepEqual(calls[0].slice(0, 5), [
        'attach',
        '-readonly',
        '-nobrowse',
        '-noautoopen',
        '-mountpoint'
      ])
      assert.deepEqual(calls.at(-1), ['detach', ownedMountpoint])
      await assert.rejects(() => stat(ownedMountpoint), { code: 'ENOENT' })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('fails closed on DMG bundle mismatch and force-detaches before cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-dmg-mismatch-test-'))
    try {
      const fixture = await createBundleFixture(join(directory, 'candidate'), {
        resourceMode: 0o644,
        reverseCreationOrder: false
      })
      const dmgPath = join(directory, 'Videorc.dmg')
      await writeFile(dmgPath, 'fixture-dmg')
      const expectedIdentity = await captureDecayAppBundleIdentityFromExecutable(fixture.executable)
      const calls = []
      let ownedMountpoint = null
      const runHdiutil = async (args) => {
        calls.push([...args])
        if (args[0] === 'attach') {
          ownedMountpoint = args[args.indexOf('-mountpoint') + 1]
          const mountedBundle = join(ownedMountpoint, 'Videorc.app')
          await cp(fixture.bundle, mountedBundle, {
            recursive: true,
            verbatimSymlinks: true
          })
          await writeFile(
            join(mountedBundle, 'Contents', 'Resources', 'config.json'),
            '{"channel":"different-dmg"}\n'
          )
          return
        }
        if (args[0] === 'detach' && args[1] !== '-force') {
          throw new Error('busy once')
        }
      }

      await assert.rejects(
        () => verifyCaptureDecayDmgAppBundle({ dmgPath, expectedIdentity }, { runHdiutil }),
        hasCode('app-bundle-identity-mismatch')
      )
      assert.deepEqual(calls.slice(-2), [
        ['detach', ownedMountpoint],
        ['detach', '-force', ownedMountpoint]
      ])
      await assert.rejects(() => stat(ownedMountpoint), { code: 'ENOENT' })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('uses the DMG-proven bundle identity for candidate and runner evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-candidate-bundle-test-'))
    try {
      const fixture = await createBundleFixture(join(directory, 'candidate'), {
        resourceMode: 0o644,
        reverseCreationOrder: false
      })
      const dmgPath = join(directory, 'Videorc.dmg')
      await writeFile(dmgPath, 'fixture-dmg')
      let attachCount = 0
      const runHdiutil = async (args) => {
        if (args[0] !== 'attach') return
        attachCount += 1
        const mountpoint = args[args.indexOf('-mountpoint') + 1]
        await cp(fixture.bundle, join(mountpoint, 'Videorc.app'), {
          recursive: true,
          verbatimSymlinks: true
        })
      }

      const candidate = await captureDecayCandidateIdentityFromFiles(
        {
          sourceCommit: 'a'.repeat(40),
          sourceTree: 'b'.repeat(40),
          candidateExecutablePath: fixture.executable,
          candidateDmgPath: dmgPath
        },
        { runHdiutil }
      )
      const runner = await captureDecayRunnerIdentity(fixture.executable)

      assert.equal(attachCount, 1)
      assert.deepEqual(candidate.appBundle, runner.appBundle)
      assert.equal(candidate.executableFilename, 'Videorc')
      assert.equal(candidate.dmgFilename, 'Videorc.dmg')
      assert.equal(
        captureDecayBoundCandidateExecutablePath(fixture.executable, candidate),
        fixture.executable
      )
      assert.throws(
        () =>
          captureDecayBoundCandidateExecutablePath(
            join(fixture.bundle, 'Contents', 'MacOS', 'substitute'),
            candidate
          ),
        hasCode('candidate-launch-path')
      )

      const mutatedCandidate = structuredClone(candidate)
      mutatedCandidate.appBundle.manifestSha256 = '0'.repeat(64)
      assert.throws(
        () => assertCaptureDecayCandidateIdentityUnchanged(candidate, mutatedCandidate),
        hasCode('app-bundle-identity-mismatch')
      )
      const mutatedRunner = structuredClone(runner)
      mutatedRunner.appBundle.manifestSha256 = '0'.repeat(64)
      assert.throws(
        () => assertCaptureDecayRunnerIdentityUnchanged(runner, mutatedRunner),
        hasCode('app-bundle-identity-mismatch')
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('rejects a DMG that changes while its mounted bundle is being proven', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-dmg-race-test-'))
    try {
      const fixture = await createBundleFixture(join(directory, 'candidate'), {
        resourceMode: 0o644,
        reverseCreationOrder: false
      })
      const dmgPath = join(directory, 'Videorc.dmg')
      await writeFile(dmgPath, 'fixture-dmg')
      const runHdiutil = async (args) => {
        if (args[0] !== 'attach') return
        const mountpoint = args[args.indexOf('-mountpoint') + 1]
        await cp(fixture.bundle, join(mountpoint, 'Videorc.app'), {
          recursive: true,
          verbatimSymlinks: true
        })
        await writeFile(dmgPath, 'mutated-dmg')
      }

      await assert.rejects(
        () =>
          captureDecayCandidateIdentityFromFiles(
            {
              sourceCommit: 'a'.repeat(40),
              sourceTree: 'b'.repeat(40),
              candidateExecutablePath: fixture.executable,
              candidateDmgPath: dmgPath
            },
            { runHdiutil }
          ),
        hasCode('candidate-dmg-mutated')
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('rejects a local app bundle that changes while the DMG proof is mounted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'videorc-app-race-test-'))
    try {
      const fixture = await createBundleFixture(join(directory, 'candidate'), {
        resourceMode: 0o644,
        reverseCreationOrder: false
      })
      const dmgPath = join(directory, 'Videorc.dmg')
      await writeFile(dmgPath, 'fixture-dmg')
      const runHdiutil = async (args) => {
        if (args[0] !== 'attach') return
        const mountpoint = args[args.indexOf('-mountpoint') + 1]
        await cp(fixture.bundle, join(mountpoint, 'Videorc.app'), {
          recursive: true,
          verbatimSymlinks: true
        })
        await writeFile(fixture.resource, '{"channel":"mutated-local-app"}\n')
      }

      await assert.rejects(
        () =>
          captureDecayCandidateIdentityFromFiles(
            {
              sourceCommit: 'a'.repeat(40),
              sourceTree: 'b'.repeat(40),
              candidateExecutablePath: fixture.executable,
              candidateDmgPath: dmgPath
            },
            { runHdiutil }
          ),
        hasCode('candidate-app-bundle-mutated')
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})

async function createBundleFixture(root, { resourceMode, reverseCreationOrder }) {
  const bundle = join(root, 'Videorc.app')
  const executable = join(bundle, 'Contents', 'MacOS', 'Videorc')
  const resource = join(bundle, 'Contents', 'Resources', 'config.json')
  await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(join(bundle, 'Contents', 'Resources'), { recursive: true })
  await chmod(bundle, 0o755)
  const writes = [
    () => writeFile(executable, '#!/bin/sh\nexit 0\n'),
    () => writeFile(resource, '{"channel":"stable"}\n')
  ]
  for (const write of reverseCreationOrder ? writes.reverse() : writes) await write()
  await chmod(executable, 0o755)
  await chmod(resource, resourceMode)
  await symlink('config.json', join(bundle, 'Contents', 'Resources', 'config-current.json'))
  return { bundle, executable, resource }
}

function hasCode(code) {
  return (error) => error?.code === code
}
