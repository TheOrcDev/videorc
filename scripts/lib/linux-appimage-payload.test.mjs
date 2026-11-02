import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  assertLinuxX64Elf,
  payloadFilePresent,
  withLinuxAppImagePayload
} from './linux-appimage-payload.mjs'
import { sha256File } from './linux-release.mjs'

test('payload inspection uses hash-checked AppImage copy and removes it even on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'appimage-test-'))
  try {
    const artifactPath = join(directory, 'test.AppImage')
    const elf = Buffer.alloc(64)
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    elf.writeUInt16LE(62, 18)
    await writeFile(artifactPath, elf)
    const candidate = {
      artifactPath,
      sha256: await sha256File(artifactPath),
      sizeBytes: elf.length
    }
    let extractedDirectory
    const extract = (path, args, options) => {
      assert.notEqual(path, artifactPath)
      assert.deepEqual(args, ['--appimage-extract'])
      assert.equal(dirname(path), options.cwd)
      assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR'])
      extractedDirectory = options.cwd
      mkdirSync(join(options.cwd, 'squashfs-root', 'resources'), { recursive: true })
      writeFileSync(join(options.cwd, 'squashfs-root', 'resources', 'from-artifact'), 'payload')
    }
    assert.equal(
      await withLinuxAppImagePayload(
        candidate,
        async (root) => {
          assert.equal(await payloadFilePresent(root, 'resources/from-artifact'), true)
          assert.equal(await payloadFilePresent(root, 'resources/missing'), false)
          if (process.platform !== 'win32') {
            await symlink(artifactPath, join(root, 'outside'))
            assert.equal(await payloadFilePresent(root, 'outside'), false)
          }
          return readFile(join(root, 'resources/from-artifact'), 'utf8')
        },
        { extract }
      ),
      'payload'
    )
    await assert.rejects(readFile(join(extractedDirectory, 'candidate.AppImage')), {
      code: 'ENOENT'
    })
    await assert.rejects(
      withLinuxAppImagePayload(
        candidate,
        () => {
          throw new Error('inspection failed')
        },
        { extract }
      ),
      /inspection failed/
    )
    await assert.rejects(readFile(join(extractedDirectory, 'candidate.AppImage')), {
      code: 'ENOENT'
    })
    await assert.rejects(
      withLinuxAppImagePayload(
        { ...candidate, sha256: '0'.repeat(64) },
        () => assert.fail('must not inspect'),
        { extract: () => assert.fail('must not execute') }
      ),
      /candidate hash/
    )
    elf.writeUInt16LE(183, 18)
    await writeFile(artifactPath, elf)
    await assert.rejects(assertLinuxX64Elf(artifactPath), /x64 ELF/)
    await assert.rejects(
      withLinuxAppImagePayload(
        { ...candidate, sha256: await sha256File(artifactPath) },
        () => assert.fail('must not inspect'),
        { extract: () => assert.fail('must not execute') }
      ),
      /x64 ELF/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function payloadFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'appimage-root-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const artifactPath = join(directory, 'candidate.AppImage')
  const elf = Buffer.alloc(64)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  elf.writeUInt16LE(62, 18)
  await writeFile(artifactPath, elf)
  return {
    directory,
    candidate: { artifactPath, sha256: await sha256File(artifactPath), sizeBytes: elf.length }
  }
}

test('accepts a temporary-parent alias without mistaking it for an extracted symlink', async (t) => {
  const { directory, candidate } = await payloadFixture(t)
  const parent = join(directory, 'actual-parent')
  const alias = join(directory, 'parent-alias')
  await mkdir(parent)
  // Directory junctions also work on Windows without symlink privileges.
  await symlink(parent, alias, 'junction')
  let extractedDirectory
  const result = await withLinuxAppImagePayload(
    candidate,
    async (root) => {
      assert.equal(await payloadFilePresent(root, 'payload'), true)
      return readFile(join(root, 'payload'), 'utf8')
    },
    {
      temporaryParent: alias,
      extract: (_path, _args, { cwd }) => {
        extractedDirectory = cwd
        mkdirSync(join(cwd, 'squashfs-root'))
        writeFileSync(join(cwd, 'squashfs-root', 'payload'), 'exact payload')
      }
    }
  )
  assert.equal(result, 'exact payload')
  assert.equal(dirname(extractedDirectory), await realpath(parent))
  assert.deepEqual(await readdir(parent), [])
})

test('rejects an extracted root symlink and cleans only the owned extraction directory', async (t) => {
  const { directory, candidate } = await payloadFixture(t)
  const outside = join(directory, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'unrelated data')
  let extractedDirectory
  await assert.rejects(
    withLinuxAppImagePayload(candidate, () => assert.fail('must not inspect a redirected root'), {
      extract: (_path, _args, { cwd }) => {
        extractedDirectory = cwd
        symlinkSync(outside, join(cwd, 'squashfs-root'), 'junction')
      }
    }),
    /extraction root is a symlink/
  )
  await assert.rejects(readFile(join(extractedDirectory, 'candidate.AppImage')), { code: 'ENOENT' })
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'unrelated data')
})
