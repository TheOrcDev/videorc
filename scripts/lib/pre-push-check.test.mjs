import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatCheckGlobs, prePushPlan, pushRanges } from './pre-push-check.mjs'

const a = 'a'.repeat(40)
const b = 'b'.repeat(40)
const zero = '0'.repeat(40)

describe('pre-push-check', () => {
  it('diffs an updated branch against what the remote had', () => {
    assert.deepEqual(pushRanges(`refs/heads/x ${a} refs/heads/x ${b}\n`, 'm'), [
      { base: b, head: a }
    ])
  })

  it('diffs a new branch against the merge-base and skips a deleted ref', () => {
    assert.deepEqual(
      pushRanges(
        `refs/heads/new ${a} refs/heads/new ${zero}\n(delete) ${zero} refs/heads/old ${b}\n`,
        'm'
      ),
      [{ base: 'm', head: a }]
    )
    assert.deepEqual(pushRanges(`refs/heads/new ${a} refs/heads/new ${zero}\n`, ''), [])
    assert.deepEqual(pushRanges('', 'm'), [])
  })

  it('checks only what the push changed, with the CI format scope', () => {
    const scope = new Set(['apps/desktop/src/a.ts', 'scripts/sync-ui.mjs'])
    assert.deepEqual(
      prePushPlan(
        ['apps/desktop/src/a.ts', 'scripts/other.mjs', 'docs/x.md', 'apps/desktop/src/a.ts'],
        scope
      ),
      { format: ['apps/desktop/src/a.ts'], lint: ['apps/desktop/src/a.ts'], typecheck: true }
    )
    assert.deepEqual(prePushPlan(['docs/x.md', 'crates/videorc-backend/src/main.rs'], scope), {
      format: [],
      lint: [],
      typecheck: false
    })
    assert.equal(prePushPlan(['apps/desktop/tsconfig.web.json'], scope).typecheck, true)
  })

  it('reads the format:check globs', () => {
    assert.deepEqual(formatCheckGlobs('node a.mjs && prettier --check "apps/**/*.ts" "*.json"'), [
      'apps/**/*.ts',
      '*.json'
    ])
    assert.deepEqual(formatCheckGlobs('echo'), [])
  })
})
