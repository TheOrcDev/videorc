import { execFile } from 'node:child_process'
import { isDeepStrictEqual, promisify } from 'node:util'

import {
  assertCaptureDecayD3AcceptanceRecord,
  assertCaptureDecayD3PublicationSourceState,
  readCaptureDecayD3AcceptanceRecord
} from './capture-decay-release-acceptance.mjs'

const execFileAsync = promisify(execFile)
const DEFAULT_BRANCH = 'main'
const DEFAULT_REPOSITORY = 'TheOrcDev/videorc'
const DESKTOP_PACKAGE_PATH = 'apps/desktop/package.json'

export class CaptureDecayPublicationRefError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CaptureDecayPublicationRefError'
    this.code = code
  }
}

export function assertCaptureDecayD3PublicationMode(
  record,
  { exactPromotion = false, regularRelease = false } = {}
) {
  if (exactPromotion && regularRelease) {
    throw new Error('exact D3 promotion and regular macOS release modes are mutually exclusive')
  }
  if (exactPromotion && record?.status !== 'accepted') {
    throw new Error(
      'exact sealed-candidate promotion requires D3 acceptance status exactly accepted'
    )
  }
  if (regularRelease && record?.status === 'accepted') {
    throw new Error(
      'accepted D3 evidence must use the exact sealed-candidate promotion workflow; the regular macOS release workflow may not rebuild it'
    )
  }
  return record
}

export async function assertCaptureDecayD3CandidateCheckout({ repoRoot, sourceCommit }) {
  const headCommit = await gitText(repoRoot, ['rev-parse', 'HEAD'])
  if (headCommit !== sourceCommit) {
    throw new Error(
      `capture-decay D3 candidate commit is ${sourceCommit}, but this checkout is ${headCommit}`
    )
  }
  const sourceChanges = await gitText(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all'
  ])
  if (sourceChanges.length > 0) {
    throw new Error(
      'capture-decay D3 evidence requires a clean checkout, including no untracked source, at the tested commit'
    )
  }
  return headCommit
}

export async function captureDecayGitTree(repoRoot, commit = 'HEAD') {
  return await gitText(repoRoot, ['rev-parse', `${commit}^{tree}`])
}

// Owner-acknowledged local publication bridge (2026-08-29). The protected
// Actions lane shipped in #320 before its infrastructure existed (zero repo
// secrets, no macOS environment), and the D3-pending freeze would otherwise
// block every regular beta until the multi-day owner acceptance ceremony
// completes. With the EXACT acknowledgment value below, a regular beta may
// publish from the owner's keychain path with local provenance checks; the
// bridge NEVER weakens accepted-state D3 promotion rules, and it must be
// retired once the Actions lane is provisioned or the D3 record is
// satisfied.
export const LOCAL_PUBLICATION_ACK_ENV = 'VIDEORC_RELEASE_LOCAL_PUBLICATION_ACK'
export const LOCAL_PUBLICATION_ACK_VALUE = 'owner-keychain'

function localPublicationBridgeAcknowledged(env) {
  const value = env[LOCAL_PUBLICATION_ACK_ENV]
  if (value === undefined || value === '') return false
  if (value !== LOCAL_PUBLICATION_ACK_VALUE) {
    throw publicationRefError(
      'local-ack-invalid',
      `${LOCAL_PUBLICATION_ACK_ENV} must be exactly "${LOCAL_PUBLICATION_ACK_VALUE}" to acknowledge local publication.`
    )
  }
  return true
}

// Local provenance replacement for the protected-ref context: the checkout's
// HEAD must be an ancestor of the canonical default branch, freshly fetched,
// so the bridge cannot publish an unpushed or foreign tree.
async function assertLocalPublicationBridgeRef({ defaultBranch = DEFAULT_BRANCH, repoRoot }) {
  try {
    await execFileAsync('git', ['fetch', '--quiet', 'origin', defaultBranch], { cwd: repoRoot })
  } catch {
    // No fetchable remote (offline or fixture repo): the existing
    // remote-tracking ref below is still required, so ancestry is judged
    // against the freshest available origin state rather than skipped.
    console.warn(
      `[release-upload] LOCAL PUBLICATION BRIDGE: could not fetch origin/${defaultBranch}; using the existing remote-tracking ref.`
    )
  }
  const headCommit = await gitText(repoRoot, ['rev-parse', 'HEAD^{commit}'])
  const remoteRef = `refs/remotes/origin/${defaultBranch}`
  const remoteCommit = await gitText(repoRoot, ['rev-parse', `${remoteRef}^{commit}`])
  if (!(await gitIsAncestor(repoRoot, headCommit, remoteCommit))) {
    throw publicationRefError(
      'local-ack-ancestry',
      `Local publication requires HEAD ${headCommit} to be an ancestor of origin/${defaultBranch} (${remoteCommit}).`
    )
  }
  console.warn(
    `[release-upload] LOCAL PUBLICATION BRIDGE ACTIVE (${LOCAL_PUBLICATION_ACK_ENV}=${LOCAL_PUBLICATION_ACK_VALUE}): ` +
      'publishing from the owner keychain path outside GitHub Actions. Retire this bridge once the ' +
      'release-macos.yml secrets are provisioned or the D3 acceptance record is satisfied.'
  )
  return { bridged: true, headCommit, refName: defaultBranch }
}

export async function assertCaptureDecayD3PublicationGate({
  env = process.env,
  recordPath,
  repoRoot,
  requireProtectedRef = false
}) {
  const bridgeAcknowledged = localPublicationBridgeAcknowledged(env)
  const protectedRef = requireProtectedRef
    ? bridgeAcknowledged
      ? await assertLocalPublicationBridgeRef({ repoRoot })
      : await assertCaptureDecayProtectedPublicationRef({ env, repoRoot })
    : null
  await assertCaptureDecayD3PublicationTrackedTreeClean({ repoRoot })
  const rawRecord = await readCaptureDecayD3AcceptanceRecord(recordPath)
  let record
  try {
    record = assertCaptureDecayD3AcceptanceRecord(rawRecord)
  } catch (error) {
    // The D3-pending freeze blocks every macOS publication until the owner
    // acceptance ceremony completes. The bridge lets a REGULAR beta through
    // with an explicit owner acknowledgment; accepted/satisfied records take
    // the normal strict path below, so no sealed-candidate or drift rule is
    // ever weakened by the bridge.
    if (bridgeAcknowledged && error?.code === 'd3-pending') {
      console.warn(
        '[release-upload] LOCAL PUBLICATION BRIDGE: publishing a regular beta while the D3 ' +
          `acceptance record is ${rawRecord?.status ?? 'missing'}; the D3 release freeze is ` +
          'owner-overridden for this upload only.'
      )
      const headCommit = await gitText(repoRoot, ['rev-parse', 'HEAD^{commit}'])
      return {
        headCommit,
        protectedRef,
        record: { profile: rawRecord?.profile, status: rawRecord?.status ?? 'pending' }
      }
    }
    throw error
  }
  const sourceState = await captureDecayD3PublicationSourceState({ record, repoRoot })
  assertCaptureDecayD3PublicationSourceState(record, sourceState)
  const { headCommit } = sourceState
  return { headCommit, protectedRef, record }
}

export async function assertCaptureDecayProtectedPublicationRef({
  defaultBranch = DEFAULT_BRANCH,
  env = process.env,
  expectedRepository = DEFAULT_REPOSITORY,
  repoRoot
}) {
  if (env.GITHUB_ACTIONS !== 'true') {
    throw publicationRefError(
      'github-actions-required',
      'Release publication requires the protected GitHub Actions ref context.'
    )
  }
  const repository = requiredPublicationEnvironment(env, 'GITHUB_REPOSITORY')
  if (repository !== expectedRepository) {
    throw publicationRefError(
      'repository-mismatch',
      `Release publication must run in ${expectedRepository}.`
    )
  }
  if (env.GITHUB_REF_PROTECTED !== 'true') {
    throw publicationRefError(
      'unprotected-ref',
      'Release publication requires GitHub to identify the triggering ref as protected.'
    )
  }

  const eventName = requiredPublicationEnvironment(env, 'GITHUB_EVENT_NAME')
  const ref = requiredPublicationEnvironment(env, 'GITHUB_REF')
  const refName = requiredPublicationEnvironment(env, 'GITHUB_REF_NAME')
  const refType = requiredPublicationEnvironment(env, 'GITHUB_REF_TYPE')
  const githubSha = requiredCommitEnvironment(env, 'GITHUB_SHA')
  const headCommit = await gitText(repoRoot, ['rev-parse', 'HEAD^{commit}'])
  if (githubSha !== headCommit) {
    throw publicationRefError(
      'github-sha-mismatch',
      `GitHub publication SHA ${githubSha} does not match checkout ${headCommit}.`
    )
  }

  const refCommit = await resolvePublicationRef(repoRoot, ref, 'trigger-ref-unavailable')
  if (refCommit !== headCommit) {
    throw publicationRefError(
      'trigger-ref-mismatch',
      `Protected trigger ref ${ref} does not resolve to checkout ${headCommit}.`
    )
  }
  const originDefaultRef = `refs/remotes/origin/${defaultBranch}`
  const originDefaultCommit = await resolvePublicationRef(
    repoRoot,
    originDefaultRef,
    'origin-default-branch-unavailable'
  )

  if (eventName === 'workflow_dispatch') {
    if (
      ref !== `refs/heads/${defaultBranch}` ||
      refName !== defaultBranch ||
      refType !== 'branch'
    ) {
      throw publicationRefError(
        'dispatch-ref-not-default-branch',
        `Manual release publication must be dispatched from protected ${defaultBranch}.`
      )
    }
    if (headCommit !== originDefaultCommit) {
      throw publicationRefError(
        'default-branch-not-current',
        `Manual release publication checkout must equal current ${originDefaultRef}.`
      )
    }
  } else if (eventName === 'push') {
    if (refType !== 'tag' || refName !== ref.slice('refs/tags/'.length) || !isReleaseTagRef(ref)) {
      throw publicationRefError(
        'push-ref-not-release-tag',
        'Release push publication requires a protected v* tag ref.'
      )
    }
    if (!(await gitIsAncestor(repoRoot, headCommit, originDefaultCommit))) {
      throw publicationRefError(
        'release-tag-not-on-default-branch',
        `Protected release tag ${refName} is not reachable from current ${originDefaultRef}.`
      )
    }
  } else {
    throw publicationRefError(
      'unsupported-publication-event',
      'Release publication may run only from workflow_dispatch or a protected release tag push.'
    )
  }

  return {
    eventName,
    headCommit,
    originDefaultCommit,
    ref,
    refName,
    refType,
    repository
  }
}

// The workflow performs a full source-authority check before candidate credentials
// exist. Exact promotion repeats this narrower authoritative GitHub check inside
// the uploader immediately before its first public write so a main-branch advance
// between workflow steps cannot be hidden by a stale local origin/main ref.
export async function assertCaptureDecayCurrentProtectedMain({
  defaultBranch = DEFAULT_BRANCH,
  env = process.env,
  expectedRepository = DEFAULT_REPOSITORY,
  fetchImpl = globalThis.fetch,
  headCommit
}) {
  if (env.GITHUB_ACTIONS !== 'true') {
    throw publicationRefError(
      'github-actions-required',
      'Exact release publication requires the protected GitHub Actions ref context.'
    )
  }
  const repository = requiredPublicationEnvironment(env, 'GITHUB_REPOSITORY')
  if (repository !== expectedRepository) {
    throw publicationRefError(
      'repository-mismatch',
      `Exact release publication must run in ${expectedRepository}.`
    )
  }
  if (env.GITHUB_REF_PROTECTED !== 'true') {
    throw publicationRefError(
      'unprotected-ref',
      'Exact release publication requires GitHub to identify main as protected.'
    )
  }
  if (
    requiredPublicationEnvironment(env, 'GITHUB_EVENT_NAME') !== 'workflow_dispatch' ||
    requiredPublicationEnvironment(env, 'GITHUB_REF') !== `refs/heads/${defaultBranch}` ||
    requiredPublicationEnvironment(env, 'GITHUB_REF_NAME') !== defaultBranch ||
    requiredPublicationEnvironment(env, 'GITHUB_REF_TYPE') !== 'branch'
  ) {
    throw publicationRefError(
      'dispatch-ref-not-default-branch',
      `Exact release publication must be dispatched from protected ${defaultBranch}.`
    )
  }

  const githubSha = requiredCommitEnvironment(env, 'GITHUB_SHA')
  if (!/^[a-f0-9]{40}$/.test(headCommit ?? '')) {
    throw publicationRefError(
      'head-commit-invalid',
      'Exact release publication requires a lowercase full checkout commit SHA.'
    )
  }
  if (headCommit !== githubSha) {
    throw publicationRefError(
      'github-sha-mismatch',
      `GitHub publication SHA ${githubSha} does not match checkout ${headCommit}.`
    )
  }
  if (typeof fetchImpl !== 'function') {
    throw publicationRefError(
      'github-main-ref-request-unavailable',
      'Exact release publication cannot query the authoritative GitHub main ref.'
    )
  }

  const token = requiredPublicationEnvironment(env, 'VIDEORC_GITHUB_API_TOKEN')
  let response
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${expectedRepository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'videorc-exact-release-publication',
          'x-github-api-version': '2022-11-28'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
      }
    )
  } catch (cause) {
    throw publicationRefError(
      'github-main-ref-request-failed',
      'Exact release publication could not query the authoritative GitHub main ref.',
      cause
    )
  }
  if (!response?.ok) {
    throw publicationRefError(
      'github-main-ref-request-failed',
      'Exact release publication could not verify the authoritative GitHub main ref.'
    )
  }

  let payload
  try {
    payload = await response.json()
  } catch (cause) {
    throw publicationRefError(
      'github-main-ref-response-invalid',
      'GitHub returned an invalid authoritative main-ref response.',
      cause
    )
  }
  const currentMainCommit = payload?.object?.sha
  if (!/^[a-f0-9]{40}$/.test(currentMainCommit ?? '')) {
    throw publicationRefError(
      'github-main-ref-response-invalid',
      'GitHub returned an invalid authoritative main-ref commit.'
    )
  }
  if (currentMainCommit !== headCommit) {
    throw publicationRefError(
      'default-branch-advanced-at-publication',
      `Protected ${defaultBranch} advanced before exact release publication; dispatch again from current ${defaultBranch}.`
    )
  }

  return { currentMainCommit, headCommit, repository }
}

// Release output is intentionally generated outside Git's tracked source
// authority. A dependency install, test, generator, or packaging hook that
// mutates a tracked file must therefore stop both the pre-build gate and the
// uploader's final gate. Untracked/ignored artifacts are allowed because the
// signed DMG, updater files, and evidence receipts are produced there.
export async function assertCaptureDecayD3PublicationTrackedTreeClean({ repoRoot }) {
  const trackedChanges = await gitText(repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=no'
  ])
  if (trackedChanges.length > 0) {
    throw new Error(
      'capture-decay D3 publication refuses tracked source changes created after checkout'
    )
  }
}

export async function captureDecayD3PublicationSourceState({ record, repoRoot }) {
  const valid = assertCaptureDecayD3AcceptanceRecord(record)
  const headCommit = await gitText(repoRoot, ['rev-parse', 'HEAD'])
  if (valid.status === 'accepted') {
    const candidateCommit = valid.candidate.sourceCommit
    return {
      headCommit,
      candidateIsAncestor: await gitIsAncestor(repoRoot, candidateCommit, headCommit),
      changedPaths: await captureDecayD3CommittedChangedPaths({
        fromCommit: candidateCommit,
        repoRoot,
        toCommit: headCommit
      }),
      publicationSourceIsAncestor: false
    }
  }
  const publicationSourceCommit = valid.publicationReceipt.publicationSourceCommit
  const changedPaths = await captureDecayD3CommittedChangedPaths({
    fromCommit: publicationSourceCommit,
    repoRoot,
    toCommit: headCommit
  })
  return {
    headCommit,
    candidateIsAncestor: false,
    changedPaths,
    desktopPackageVersionOnlyChange:
      changedPaths.includes(DESKTOP_PACKAGE_PATH) &&
      (await captureDecayD3DesktopPackageVersionOnlyChange({
        fromCommit: publicationSourceCommit,
        repoRoot,
        toCommit: headCommit
      })),
    publicationSourceIsAncestor: await gitIsAncestor(repoRoot, publicationSourceCommit, headCommit)
  }
}

export async function captureDecayD3CommittedChangedPaths({
  fromCommit,
  repoRoot,
  toCommit = 'HEAD'
}) {
  return await gitNulFields(repoRoot, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    '--diff-filter=ACDMRTUXB',
    `${fromCommit}..${toCommit}`,
    '--'
  ])
}

export async function captureDecayD3DesktopPackageVersionOnlyChange({
  fromCommit,
  repoRoot,
  toCommit = 'HEAD'
}) {
  try {
    const [before, after] = await Promise.all([
      gitJsonAtCommit(repoRoot, fromCommit, DESKTOP_PACKAGE_PATH),
      gitJsonAtCommit(repoRoot, toCommit, DESKTOP_PACKAGE_PATH)
    ])
    if (typeof before.version !== 'string' || typeof after.version !== 'string') return false
    const beforeWithoutVersion = { ...before }
    const afterWithoutVersion = { ...after }
    delete beforeWithoutVersion.version
    delete afterWithoutVersion.version
    return isDeepStrictEqual(beforeWithoutVersion, afterWithoutVersion)
  } catch {
    return false
  }
}

async function gitIsAncestor(repoRoot, ancestor, descendant) {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoRoot
    })
    return true
  } catch (error) {
    if (error?.code === 1) return false
    throw error
  }
}

async function gitJsonAtCommit(repoRoot, commit, path) {
  const text = await gitText(repoRoot, ['show', `${commit}:${path}`])
  const document = JSON.parse(text)
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Git JSON object is invalid: ${path}.`)
  }
  return document
}

async function resolvePublicationRef(repoRoot, ref, code) {
  if (!/^refs\/(?:heads|remotes|tags)\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(ref)) {
    throw publicationRefError(code, `Release publication ref is invalid: ${ref}.`)
  }
  try {
    return await gitText(repoRoot, ['rev-parse', `${ref}^{commit}`])
  } catch (cause) {
    throw publicationRefError(
      code,
      `Required release publication ref is unavailable: ${ref}.`,
      cause
    )
  }
}

function isReleaseTagRef(ref) {
  return /^refs\/tags\/v[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref)
}

function requiredPublicationEnvironment(env, name) {
  const value = env[name]
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw publicationRefError(
      'github-context-missing',
      `Release publication requires a valid ${name}.`
    )
  }
  return value
}

function requiredCommitEnvironment(env, name) {
  const value = requiredPublicationEnvironment(env, name)
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw publicationRefError(
      'github-sha-invalid',
      `Release publication requires ${name} to be a lowercase full commit SHA.`
    )
  }
  return value
}

function publicationRefError(code, message, cause) {
  return new CaptureDecayPublicationRefError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  )
}

async function gitLines(repoRoot, args) {
  const text = await gitText(repoRoot, args)
  return text.length > 0 ? text.split('\n') : []
}

async function gitNulFields(repoRoot, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout.split('\0').filter((value) => value.length > 0)
}

async function gitText(repoRoot, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout.trim()
}
