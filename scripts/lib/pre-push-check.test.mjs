import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatCheckGlobs, prePushPlan, pushRanges } from './pre-push-check.mjs'

const a = 'a'.repeat(40)
const b = 'b'.repeat(40)
const zero = '0'.repeat(40)

describe('pre-push-check', () => {
  it('diffs an updated branch against what the remote had', () => {
    assert.deepEqual(pushRanges(`refs/heads/x ${a} refs/heads/x ${b}\n`, 'm'), [
      { ref: 'refs/heads/x', base: b, head: a }
    ])
    assert.deepEqual(pushRanges(`refs/tags/v1 ${a} refs/tags/v1 ${zero}\n`, 'm'), [])
  })

  it('diffs a new branch against the merge-base and skips a deleted ref', () => {
    assert.deepEqual(
      pushRanges(
        `refs/heads/new ${a} refs/heads/new ${zero}\n(delete) ${zero} refs/heads/old ${b}\n`,
        'm'
      ),
      [{ ref: 'refs/heads/new', base: 'm', head: a }]
    )
    assert.deepEqual(pushRanges(`refs/heads/new ${a} refs/heads/new ${zero}\n`, ''), [])
    assert.deepEqual(pushRanges('', 'm'), [])
  })

  it('checks only what the push changed, with the CI format scope', () => {
    const scope = new Set(['apps/desktop/src/a.ts', 'scripts/sync-ui.mjs'])
    const files = [
      'apps/desktop/src/a.ts',
      'scripts/other.mjs',
      'docs/x.md',
      'apps/desktop/src/a.ts'
    ]
    assert.deepEqual(prePushPlan(files, files, scope), {
      format: ['apps/desktop/src/a.ts'],
      lint: ['apps/desktop/src/a.ts'],
      typecheck: true
    })
    const rust = ['docs/x.md', 'crates/videorc-backend/src/main.rs']
    assert.deepEqual(prePushPlan(rust, rust, scope), { format: [], lint: [], typecheck: false })
    const tsconfig = ['apps/desktop/tsconfig.web.json']
    assert.equal(prePushPlan(tsconfig, tsconfig, scope).typecheck, true)
  })

  it('typechecks a push that only deletes a module (review 6)', () => {
    const deleted = ['apps/desktop/src/renderer/src/lib/gone.ts']
    assert.deepEqual(prePushPlan(deleted, [], new Set(deleted)), {
      format: [],
      lint: [],
      typecheck: true
    })
  })

  it('reads the format:check globs', () => {
    assert.deepEqual(formatCheckGlobs('node a.mjs && prettier --check "apps/**/*.ts" "*.json"'), [
      'apps/**/*.ts',
      '*.json'
    ])
    assert.deepEqual(formatCheckGlobs('echo'), [])
  })
})
