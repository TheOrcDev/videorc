import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  eagerJavascriptReferences,
  evaluateRendererAssetBudget,
  measureEagerRendererAssets
} from './renderer-asset-budget.mjs'

describe('renderer asset budget', () => {
  it('measures only the entry and initial modulepreloads', async () => {
    const root = join(tmpdir(), `videorc-renderer-budget-${process.pid}-${Date.now()}`)
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(
      join(root, 'index.html'),
      '<script type="module" src="./assets/main.js"></script><link rel="modulepreload" href="./assets/shared.js"><script>import("./assets/lazy.js")</script>'
    )
    await writeFile(join(root, 'assets', 'main.js'), 'export const main = true\n')
    await writeFile(join(root, 'assets', 'shared.js'), 'export const shared = true\n')
    await writeFile(join(root, 'assets', 'lazy.js'), 'export const lazy = true\n')

    const measurement = await measureEagerRendererAssets({ htmlPath: join(root, 'index.html') })

    assert.deepEqual(
      measurement.assets.map((asset) => asset.reference),
      ['./assets/main.js', './assets/shared.js']
    )
    assert.equal(measurement.entryRawBytes, 25)
    assert.equal(measurement.totalRawBytes, 52)
  })

  it('fails when the initial or entry bundle crosses its versioned ceiling', () => {
    assert.deepEqual(
      evaluateRendererAssetBudget(
        {
          totalRawBytes: 200,
          totalGzipBytes: 100,
          entryRawBytes: 150,
          entryGzipBytes: 75
        },
        {
          maxTotalRawBytes: 199,
          maxTotalGzipBytes: 99,
          maxEntryRawBytes: 149,
          maxEntryGzipBytes: 74
        }
      ),
      [
        'initial eager JavaScript raw bytes 200 exceeded 199',
        'initial eager JavaScript gzip bytes 100 exceeded 99',
        'main entry raw bytes 150 exceeded 149',
        'main entry gzip bytes 75 exceeded 74'
      ]
    )
  })

  it('recognizes attribute order variants without counting lazy imports', () => {
    assert.deepEqual(
      eagerJavascriptReferences(
        '<script src="a.js" type="module"></script><link href="b.js" rel="modulepreload"><script>import("c.js")</script>'
      ),
      ['a.js', 'b.js']
    )
  })
})
