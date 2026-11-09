import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateWebProduction,
  formatWebProductionReport,
  MAX_REDEPLOY_HOPS,
  pickRedeploySource,
  resolveBuildOrigin
} from './web-production-deploy.mjs'

const MAIN = '3c8d1593a7bc57e53f450355ceb313e0b3b127aa'
const STALE = '76d7fc0ae2bfab0eae1bfd501ebe3a5177087f9d'

function deployment(
  uid,
  { source = 'cli', sha = MAIN, state = 'READY', created = 0, meta = {} } = {}
) {
  return {
    uid,
    id: uid,
    source,
    readyState: state,
    created,
    meta: { githubCommitSha: sha, ...meta }
  }
}

describe('pickRedeploySource', () => {
  it("picks the newest READY GitHub build of main, never a CLI upload carrying main's sha", () => {
    const picked = pickRedeploySource(
      [
        deployment('dpl_cli_newest', { source: 'cli', created: 30 }),
        deployment('dpl_git_old', { source: 'git', created: 10 }),
        deployment('dpl_git_new', { source: 'git', created: 20 }),
        deployment('dpl_git_building', { source: 'git', state: 'BUILDING', created: 40 })
      ],
      MAIN
    )
    assert.equal(picked?.uid, 'dpl_git_new')
  })

  it('finds nothing when the only GitHub builds are of another commit', () => {
    assert.equal(
      pickRedeploySource([deployment('dpl_git_stale', { source: 'git', sha: STALE })], MAIN),
      null
    )
    assert.equal(pickRedeploySource(undefined, MAIN), null)
  })
})

describe('resolveBuildOrigin', () => {
  it('follows redeploys back to the GitHub build', async () => {
    const git = deployment('dpl_git', { source: 'git' })
    const first = deployment('dpl_redeploy_1', {
      meta: { action: 'redeploy', originalDeploymentId: 'dpl_git' }
    })
    const second = deployment('dpl_redeploy_2', {
      meta: { action: 'redeploy', originalDeploymentId: 'dpl_redeploy_1' }
    })
    const byId = { dpl_git: git, dpl_redeploy_1: first }
    const origin = await resolveBuildOrigin(second, async (id) => byId[id])
    assert.equal(origin.origin, 'git')
    assert.deepEqual(origin.chain, ['dpl_redeploy_2', 'dpl_redeploy_1', 'dpl_git'])
  })

  it('names a redeploy of a local upload as a local upload (the 0.20.3 case)', async () => {
    const upload = deployment('dpl_8UqF', { sha: STALE })
    const redeploy = deployment('dpl_CKE4', {
      sha: STALE,
      meta: { action: 'redeploy', originalDeploymentId: 'dpl_8UqF' }
    })
    const origin = await resolveBuildOrigin(redeploy, async () => upload)
    assert.equal(origin.origin, 'local-upload')
    assert.equal(origin.root.uid, 'dpl_8UqF')
  })

  it('gives up on a chain longer than the hop limit', async () => {
    let hops = 0
    const loop = async () => {
      hops += 1
      return deployment(`dpl_${hops}`, {
        meta: { action: 'redeploy', originalDeploymentId: `dpl_${hops + 1}` }
      })
    }
    const origin = await resolveBuildOrigin(await loop(), loop)
    assert.equal(origin.origin, 'unknown')
    assert.equal(origin.chain.length, MAX_REDEPLOY_HOPS + 1)
  })
})

describe('evaluateWebProduction', () => {
  it('passes when production is a GitHub build (or a redeploy of one) of main', () => {
    const result = evaluateWebProduction({
      production: deployment('dpl_E7mL', {
        meta: { action: 'redeploy', originalDeploymentId: 'dpl_33nv' }
      }),
      buildOrigin: { origin: 'git', chain: ['dpl_E7mL', 'dpl_33nv'] },
      mainSha: MAIN,
      aheadBy: 0
    })
    assert.equal(result.ok, true)
    assert.match(formatWebProductionReport(result), /^web-production: PASS/)
  })

  it('fails a stale local upload and says how far behind it is', () => {
    const result = evaluateWebProduction({
      production: deployment('dpl_CKE4', { sha: STALE }),
      buildOrigin: {
        origin: 'local-upload',
        chain: ['dpl_CKE4', 'dpl_8UqF'],
        root: { uid: 'dpl_8UqF' }
      },
      mainSha: MAIN,
      aheadBy: 24
    })
    const report = formatWebProductionReport(result)
    assert.equal(result.ok, false)
    assert.match(report, /^web-production: FAIL/)
    assert.match(
      report,
      /production serves 76d7fc0a, TheOrcDev\/videorc-web main is 3c8d1593 \(24 main commit\(s\) missing\)/
    )
    assert.match(report, /uploaded from a local checkout \(dpl_8UqF\)/)
    assert.match(report, /fix: pnpm release:web:redeploy/)
  })

  it("fails a local upload even when it carries main's sha", () => {
    const result = evaluateWebProduction({
      production: deployment('dpl_cli'),
      buildOrigin: { origin: 'local-upload', chain: ['dpl_cli'], root: { uid: 'dpl_cli' } },
      mainSha: MAIN,
      aheadBy: 0
    })
    assert.equal(result.ok, false)
    assert.equal(result.problems.length, 1)
  })

  it('fails when nothing answers for the host or the build is not ready', () => {
    assert.equal(
      evaluateWebProduction({ production: null, buildOrigin: null, mainSha: MAIN }).ok,
      false
    )
    const building = evaluateWebProduction({
      production: deployment('dpl_git', { source: 'git', state: 'BUILDING' }),
      buildOrigin: { origin: 'git', chain: ['dpl_git'] },
      mainSha: MAIN,
      aheadBy: 0
    })
    assert.deepEqual(building.problems, ['production deployment is BUILDING'])
  })

  it('says "not on main" when GitHub cannot compare the production sha', () => {
    const result = evaluateWebProduction({
      production: deployment('dpl_git', { source: 'git', sha: 'f'.repeat(40) }),
      buildOrigin: { origin: 'git', chain: ['dpl_git'] },
      mainSha: MAIN,
      aheadBy: null
    })
    assert.match(result.problems[0], /\(not on main\)$/)
  })
})
