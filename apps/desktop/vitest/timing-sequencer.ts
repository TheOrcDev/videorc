import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { BaseSequencer, type TestSpecification } from 'vitest/node'

import {
  DESKTOP_VITEST_TIMINGS_FILE,
  readTimings,
  shardPaths,
  toPosixPath
} from '../../../scripts/lib/vitest-shards.mjs'

function loadTimings(root: string): Record<string, number> {
  const file = process.env.VIDEORC_VITEST_TIMINGS ?? resolve(root, DESKTOP_VITEST_TIMINGS_FILE)
  try {
    return readTimings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // No recorded times: equal weights. Still every file in exactly one shard.
    return {}
  }
}

/**
 * Plan 242 S7: `--shard=k/n` splits by recorded per-file time instead of
 * vitest's hash split into equal file counts. Ordering inside a shard is
 * BaseSequencer's (failed first, then slowest first).
 */
export default class TimingSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard
    if (!shard) return files
    const root = this.ctx.config.root
    const byPath = new Map(files.map((spec) => [toPosixPath(relative(root, spec.moduleId)), spec]))
    const chosen = shardPaths([...byPath.keys()], loadTimings(root), shard.index, shard.count)
    return chosen.map((path) => byPath.get(path) as TestSpecification)
  }
}
