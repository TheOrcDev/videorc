// Which build serves www.videorc.com, and how to redeploy it safely.
//
// Between 2026-11-05 and 2026-11-07 three Linux-alpha releases "redeployed"
// videorc-web after changing a production env var by running a CLI deploy
// from a local checkout whose `main` had not been pulled since 2026-10-10.
// Production silently went back 24 merged web PRs, among them the X chat
// relay fix for 14-character broadcast ids, so every X chat read answered
// 400 `x-chat-broadcast-invalid` on every desktop version.
//
// The rule this module enforces: production is only ever (re)built from the
// GitHub source of videorc-web `main`, never from files on this machine.

export const WEB_PRODUCTION = Object.freeze({
  repo: 'TheOrcDev/videorc-web',
  branch: 'main',
  vercelScope: 'orc-dev',
  vercelProject: 'videorc-web',
  host: 'www.videorc.com'
})

/** Redeploys of redeploys are followed this far back to their first build. */
export const MAX_REDEPLOY_HOPS = 8

export function deploymentCommitSha(deployment) {
  const sha = deployment?.meta?.githubCommitSha ?? deployment?.gitSource?.sha
  return typeof sha === 'string' && sha ? sha : null
}

function deploymentId(deployment) {
  return deployment?.uid ?? deployment?.id ?? null
}

function deploymentReady(deployment) {
  return (deployment?.readyState ?? deployment?.state) === 'READY'
}

/**
 * The newest READY production deployment Vercel built from GitHub at
 * `mainSha`. A CLI deployment can carry the same sha in its metadata while
 * holding any local working tree, so it is never a redeploy source.
 */
export function pickRedeploySource(deployments, mainSha) {
  return (
    [...(deployments ?? [])]
      .filter(
        (deployment) =>
          deployment?.source === 'git' &&
          deploymentReady(deployment) &&
          deploymentCommitSha(deployment) === mainSha
      )
      .sort((left, right) => (right.created ?? 0) - (left.created ?? 0))[0] ?? null
  )
}

/**
 * Follows `meta.originalDeploymentId` from a redeploy back to the build that
 * uploaded its files. `git` means Vercel fetched the source from GitHub;
 * `local-upload` means someone deployed files from a machine.
 */
export async function resolveBuildOrigin(deployment, fetchDeployment) {
  const chain = []
  let current = deployment
  for (let hop = 0; hop <= MAX_REDEPLOY_HOPS && current; hop += 1) {
    chain.push(deploymentId(current))
    if (current.source === 'git') {
      return { origin: 'git', chain, root: current }
    }
    const original = current.meta?.action === 'redeploy' ? current.meta?.originalDeploymentId : null
    if (!original) {
      return { origin: 'local-upload', chain, root: current }
    }
    current = await fetchDeployment(original)
  }
  return { origin: 'unknown', chain, root: current ?? null }
}

/**
 * PASS only when production serves the GitHub build of the current `main`.
 * `aheadBy` is how many `main` commits production lacks (null when GitHub
 * cannot compare, e.g. a sha that only ever existed on someone's machine).
 */
export function evaluateWebProduction({ production, buildOrigin, mainSha, aheadBy }) {
  const productionSha = deploymentCommitSha(production)
  const problems = []
  if (!production) {
    problems.push(`no deployment answers for ${WEB_PRODUCTION.host}`)
  } else {
    if (!deploymentReady(production)) {
      problems.push(`production deployment is ${production.readyState ?? production.state}`)
    }
    if (productionSha !== mainSha) {
      const behind =
        typeof aheadBy === 'number' ? ` (${aheadBy} main commit(s) missing)` : ' (not on main)'
      problems.push(
        `production serves ${shortSha(productionSha)}, ${WEB_PRODUCTION.repo} ${WEB_PRODUCTION.branch} is ${shortSha(mainSha)}${behind}`
      )
    }
    if (buildOrigin?.origin === 'local-upload') {
      problems.push(
        `production was uploaded from a local checkout (${buildOrigin.root ? deploymentId(buildOrigin.root) : 'unknown'}); its files need not match any commit`
      )
    } else if (buildOrigin?.origin === 'unknown') {
      problems.push(
        `production's redeploy chain is longer than ${MAX_REDEPLOY_HOPS} hops or broken: ${buildOrigin.chain.join(' <- ')}`
      )
    }
  }
  return {
    ok: problems.length === 0,
    productionId: deploymentId(production),
    productionSha,
    mainSha,
    aheadBy: aheadBy ?? null,
    buildOrigin: buildOrigin?.origin ?? null,
    problems
  }
}

export function formatWebProductionReport(result) {
  const lines = [`web-production: ${result.ok ? 'PASS' : 'FAIL'}`]
  lines.push(`host: ${WEB_PRODUCTION.host}`)
  lines.push(`deployment: ${result.productionId ?? 'none'}`)
  lines.push(`production sha: ${shortSha(result.productionSha)}`)
  lines.push(`${WEB_PRODUCTION.branch} sha: ${shortSha(result.mainSha)}`)
  if (result.buildOrigin) {
    lines.push(`built from: ${result.buildOrigin}`)
  }
  for (const problem of result.problems) {
    lines.push(`problem: ${problem}`)
  }
  if (!result.ok) {
    lines.push('fix: pnpm release:web:redeploy (never vercel deploy --prod from a checkout)')
  }
  return lines.join('\n')
}

export function shortSha(sha) {
  return typeof sha === 'string' && sha ? sha.slice(0, 8) : 'unknown'
}
