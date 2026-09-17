import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  finalizePreparedJsonArtifact,
  prepareExclusiveJsonArtifact
} from './exclusive-json-artifact.mjs'

describe('exclusive PASS JSON artifacts', () => {
  it('publishes the exact pre-serialized bytes and returns their precomputed digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videorc-exclusive-json-'))
    const path = join(root, 'pass.json')
    const document = { status: 'PASS', nested: { value: 1 } }
    try {
      const prepared = await prepareExclusiveJsonArtifact(path, document)
      document.nested.value = 2
      const published = await finalizePreparedJsonArtifact(prepared, async () => undefined)
      assert.match(published.sha256, /^[a-f0-9]{64}$/)
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
        status: 'PASS',
        nested: { value: 1 }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves no PASS artifact when pre-publication hashing fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videorc-exclusive-json-'))
    const path = join(root, 'pass.json')
    let hashCalls = 0
    try {
      await assert.rejects(
        prepareExclusiveJsonArtifact(
          path,
          { status: 'PASS' },
          {
            hashBytes() {
              hashCalls += 1
              if (hashCalls === 2) throw new Error('injected hash failure after temporary write')
              return 'a'.repeat(64)
            }
          }
        ),
        /injected hash failure after temporary write/
      )
      assert.equal(hashCalls, 2)
      await assert.rejects(stat(path), /ENOENT/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves no PASS artifact when intended bytes mutate in temporary storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videorc-exclusive-json-'))
    const path = join(root, 'pass.json')
    try {
      await assert.rejects(
        prepareExclusiveJsonArtifact(
          path,
          { status: 'PASS' },
          {
            readTemporary: async (temporaryPath) => {
              await writeFile(temporaryPath, '{"status":"FAIL"}\n')
              return readFile(temporaryPath)
            }
          }
        ),
        /bytes changed before publication/
      )
      await assert.rejects(stat(path), /ENOENT/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves no PASS artifact after an integrity assertion or publication failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videorc-exclusive-json-'))
    try {
      const assertionPath = join(root, 'assertion-pass.json')
      const assertionPrepared = await prepareExclusiveJsonArtifact(assertionPath, {
        status: 'PASS'
      })
      await assert.rejects(
        finalizePreparedJsonArtifact(assertionPrepared, async () => {
          throw new Error('injected retained-artifact mutation')
        }),
        /injected retained-artifact mutation/
      )
      await assert.rejects(stat(assertionPath), /ENOENT/)

      const publicationPath = join(root, 'publication-pass.json')
      const publicationPrepared = await prepareExclusiveJsonArtifact(
        publicationPath,
        { status: 'PASS' },
        {
          publishTemporary: async (temporaryPath, destinationPath) => {
            await writeFile(destinationPath, await readFile(temporaryPath))
            throw new Error('injected publication failure')
          }
        }
      )
      await assert.rejects(
        finalizePreparedJsonArtifact(publicationPrepared, async () => undefined),
        /injected publication failure/
      )
      await assert.rejects(stat(publicationPath), /ENOENT/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
