import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  checkShardCoverage,
  mergeTimings,
  partitionByWeight,
  readTimings,
  shardBalance,
  shardPaths,
  weightsFor
} from './vitest-shards.mjs'

const files = Array.from(
  { length: 40 },
  (_, index) => `src/f${String(index).padStart(2, '0')}.test.ts`
)
const timings = Object.fromEntries(files.map((file, index) => [file, (index % 7) * 300 + 100]))
timings['src/f05.test.ts'] = 52_000

describe('vitest-shards', () => {
  it('puts every file in exactly one shard', () => {
    const shards = [1, 2, 3, 4].map((index) => shardPaths(files, timings, index, 4))
    const coverage = checkShardCoverage(files, shards)
    assert.deepEqual(coverage, { missing: [], duplicated: [], unexpected: [] })
    assert.equal(
      shards.reduce((sum, shard) => sum + shard.length, 0),
      files.length
    )
  })

  it('gives every shard the same split for the same input, whatever the order', () => {
    const a = shardPaths(files, timings, 2, 4)
    const b = shardPaths([...files].reverse(), timings, 2, 4)
    assert.deepEqual(a, b)
  })

  it('puts the heaviest file alone when it outweighs the rest of a shard', () => {
    const bins = partitionByWeight(files, weightsFor(files, timings), 4)
    const heavy = bins.find((bin) => bin.paths.includes('src/f05.test.ts'))
    assert.deepEqual(heavy.paths, ['src/f05.test.ts'])
  })

  it('balances shards far better than equal file counts', () => {
    const weights = weightsFor(files, timings)
    const bins = partitionByWeight(files, weights, 3)
    const light = bins.filter((bin) => !bin.paths.includes('src/f05.test.ts'))
    assert.ok(shardBalance(light.map((bin) => bin.total)) < 1.1)
  })

  it('weighs an unknown file at the median recorded time', () => {
    assert.deepEqual(
      weightsFor(['a', 'b', 'c', 'new'], { a: 100, b: 300, c: 200 }),
      [100, 300, 200, 200]
    )
    assert.deepEqual(weightsFor(['x'], {}), [1000])
  })

  it('reports missing, duplicated and unexpected files', () => {
    assert.deepEqual(
      checkShardCoverage(
        ['a', 'b', 'c'],
        [
          ['a', 'b'],
          ['b', 'z']
        ]
      ),
      {
        missing: ['c'],
        duplicated: ['b'],
        unexpected: ['z']
      }
    )
  })

  it('normalizes Windows separators', () => {
    assert.deepEqual(readTimings({ files: { 'src\\a.test.ts': 5, bad: 'x' } }), {
      'src/a.test.ts': 5
    })
    assert.deepEqual(checkShardCoverage(['src/a.test.ts'], [['src\\a.test.ts']]).missing, [])
  })

  it('merges shard reports into sorted, rounded timings', () => {
    assert.deepEqual(
      mergeTimings([{ files: { 'src/b.ts': 1234 } }, { files: { 'src/a.ts': 7 } }]),
      {
        version: 1,
        files: { 'src/a.ts': 10, 'src/b.ts': 1230 }
      }
    )
    assert.deepEqual(readTimings(null), {})
  })

  it('rejects an impossible shard', () => {
    assert.throws(() => shardPaths(files, timings, 5, 4))
    assert.throws(() => partitionByWeight(files, weightsFor(files, timings), 0))
  })
})
