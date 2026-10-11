import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import yaml from 'js-yaml'

import { refuse } from './install-runner.mjs'

// Plan 178 U5: where a lab build comes from.
//   release            the public macOS feed the app's own updater reads
//                      (electron-builder.yml publish.url, updater-mirror.ts)
//   candidate:<run-id> an artifact of .github/workflows/lab-candidate-macos.yml
//   candidate:<sha>    the newest lab-candidate-<sha7> artifact

export const RELEASE_FEED_URL = 'https://www.videorc.com/api/updates/'
export const MIRROR_FEED_URL = 'https://www.videorc.com/api/updates/mirror/'
export const DEFAULT_REPO = 'TheOrcDev/videorc'
export const CANDIDATE_WORKFLOW_FILE = 'lab-candidate-macos.yml'
export const CANDIDATE_WORKFLOW_NAME = 'Lab candidate macOS'
export const SIDECAR_FILE = 'lab-candidate.json'

export function parseBuildSpec(value) {
  const text = String(value ?? '').trim()
  if (text === 'release') return { kind: 'release' }
  const match = /^candidate:(.+)$/.exec(text)
  if (match) {
    const target = match[1].trim()
    if (/^[0-9]+$/.test(target)) return { kind: 'candidate', runId: target }
    if (/^[0-9a-f]{7,40}$/i.test(target)) return { kind: 'candidate', sha: target.toLowerCase() }
  }
  throw new Error(
    `--build must be "release", "candidate:<run-id>" or "candidate:<sha (7-40 hex)>", got "${text}".`
  )
}

export function candidateArtifactName(sha) {
  return `lab-candidate-${sha.slice(0, 7)}`
}

// electron-builder's latest-mac.yml: version, files[{url, sha512 (base64),
// size}], path (the zip the updater installs).
export function parseUpdateFeed(text) {
  let doc
  try {
    doc = yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA })
  } catch (error) {
    throw new Error(`latest-mac.yml is not valid YAML: ${error.message}`)
  }
  const version = typeof doc?.version === 'string' ? doc.version.trim() : ''
  const files = Array.isArray(doc?.files) ? doc.files : []
  const zipName = typeof doc?.path === 'string' && doc.path.endsWith('.zip') ? doc.path : null
  const zip =
    files.find((file) => file?.url === zipName) ??
    files.find((file) => typeof file?.url === 'string' && file.url.endsWith('-mac-arm64.zip'))
  if (!version || !zip || typeof zip.sha512 !== 'string' || !zip.sha512) {
    throw new Error('latest-mac.yml has no version or no arm64 zip with a sha512.')
  }
  const size = Number(zip.size)
  return {
    version,
    zip: { url: zip.url, sha512: zip.sha512, size: Number.isFinite(size) ? size : null }
  }
}

function hashingStream(algorithm) {
  const hash = createHash(algorithm)
  let bytes = 0
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      callback(null, chunk)
    }
  })
  return { stream, digest: () => hash.digest('base64'), bytes: () => bytes }
}

export async function downloadVerified({ fetchImpl, url, dest, sha512, size }) {
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} for ${url}`)
  }
  const hasher = hashingStream('sha512')
  await pipeline(Readable.fromWeb(response.body), hasher.stream, createWriteStream(dest))
  if (size !== null && size !== undefined && hasher.bytes() !== size) {
    refuse('size-mismatch', `Downloaded ${hasher.bytes()} bytes, latest-mac.yml says ${size}.`)
  }
  if (hasher.digest() !== sha512) {
    refuse('sha512-mismatch', 'The downloaded zip does not match the sha512 in latest-mac.yml.')
  }
}

export async function fetchRelease({ fetchImpl, feedUrl = RELEASE_FEED_URL, downloadDir }) {
  const base = feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`
  const feedResponse = await fetchImpl(new URL('latest-mac.yml', base).href)
  if (!feedResponse.ok) {
    throw new Error(`Could not read latest-mac.yml: HTTP ${feedResponse.status}`)
  }
  const feed = parseUpdateFeed(await feedResponse.text())
  const zipUrl = new URL(feed.zip.url, base).href
  const zipPath = join(downloadDir, feed.zip.url.split('/').pop())
  await downloadVerified({
    fetchImpl,
    url: zipUrl,
    dest: zipPath,
    sha512: feed.zip.sha512,
    size: feed.zip.size
  })
  return {
    zipPath,
    expectedVersion: feed.version,
    record: { source: 'release', version: feed.version, sha: null, feedUrl: base }
  }
}

async function ghJson(runner, args) {
  const result = await runner('gh', args, { timeoutMs: 60_000 })
  if (result.code !== 0) {
    throw new Error(`gh ${args[0]} ${args[1] ?? ''} failed: ${result.stderr.trim().slice(-400)}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`gh ${args[0]} ${args[1] ?? ''} returned invalid JSON.`)
  }
}

// A workflow_dispatch run's headSha is the commit the workflow FILE came from
// (main), not the built ref, so a sha is resolved through the artifact name.
export async function resolveCandidate({ runner, repo, spec }) {
  if (spec.runId) {
    return { runId: spec.runId, artifactName: null }
  }
  const artifactName = candidateArtifactName(spec.sha)
  const listing = await ghJson(runner, [
    'api',
    '-X',
    'GET',
    `repos/${repo}/actions/artifacts`,
    '-f',
    `name=${artifactName}`,
    '-f',
    'per_page=20'
  ])
  const live = (listing?.artifacts ?? [])
    .filter((artifact) => artifact?.name === artifactName && !artifact.expired)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
  const runId = live[0]?.workflow_run?.id
  if (!runId) {
    refuse(
      'candidate-not-found',
      `No unexpired ${artifactName} artifact in ${repo}. Dispatch ${CANDIDATE_WORKFLOW_FILE} for that ref first (artifacts live 7 days).`
    )
  }
  return { runId: String(runId), artifactName }
}

async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const found = await findFile(path, name)
      if (found) return found
    }
  }
  return null
}

export function validateSidecar(sidecar, { spec, runId }) {
  const problems = []
  if (!/^[0-9a-f]{40}$/.test(sidecar?.sha ?? '')) problems.push('sha is not a 40-hex commit')
  if (typeof sidecar?.version !== 'string' || !/-lab\.g?[0-9a-f]{7}$/.test(sidecar.version)) {
    problems.push('version is not <base>-lab.<sha7>')
  }
  if (typeof sidecar?.zip?.name !== 'string' || !/^[^/\\]+\.zip$/.test(sidecar.zip.name)) {
    problems.push('zip.name is missing')
  }
  if (!/^[0-9a-f]{64}$/.test(sidecar?.zip?.sha256 ?? '')) problems.push('zip.sha256 is missing')
  if (problems.length > 0) {
    refuse('sidecar-invalid', `${SIDECAR_FILE} is invalid: ${problems.join('; ')}.`)
  }
  if (spec.sha && !sidecar.sha.startsWith(spec.sha)) {
    refuse(
      'sha-mismatch',
      `The candidate was built from ${sidecar.sha.slice(0, 12)}, not ${spec.sha}. Refusing to install it.`
    )
  }
  if (sidecar.runId !== undefined && String(sidecar.runId) !== String(runId)) {
    refuse('sha-mismatch', `${SIDECAR_FILE} names run ${sidecar.runId}, downloaded from ${runId}.`)
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export async function fetchCandidate({ runner, repo = DEFAULT_REPO, spec, downloadDir }) {
  const { runId, artifactName } = await resolveCandidate({ runner, repo, spec })
  const run = await ghJson(runner, [
    'run',
    'view',
    runId,
    '--repo',
    repo,
    '--json',
    'workflowName,conclusion,status,event'
  ])
  if (run.workflowName !== CANDIDATE_WORKFLOW_NAME) {
    refuse(
      'not-a-lab-candidate',
      `Run ${runId} is "${run.workflowName}", not ${CANDIDATE_WORKFLOW_NAME}.`
    )
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    refuse(
      'candidate-run-not-green',
      `Run ${runId} is ${run.status}/${run.conclusion ?? 'pending'}; only a successful run installs.`
    )
  }
  const download = await runner(
    'gh',
    [
      'run',
      'download',
      runId,
      '--repo',
      repo,
      '--dir',
      downloadDir,
      ...(artifactName ? ['--name', artifactName] : ['--pattern', 'lab-candidate-*'])
    ],
    { timeoutMs: 20 * 60_000 }
  )
  if (download.code !== 0) {
    throw new Error(`gh run download ${runId} failed: ${download.stderr.trim().slice(-400)}`)
  }
  const sidecarPath = await findFile(downloadDir, SIDECAR_FILE)
  if (!sidecarPath) {
    refuse('sidecar-invalid', `Run ${runId} has no ${SIDECAR_FILE}.`)
  }
  let sidecar
  try {
    sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
  } catch {
    refuse('sidecar-invalid', `${SIDECAR_FILE} is not valid JSON.`)
  }
  validateSidecar(sidecar, { spec, runId })
  const zipPath = join(dirname(sidecarPath), sidecar.zip.name)
  const zipSha256 = await sha256File(zipPath).catch(() => null)
  if (zipSha256 === null) {
    refuse('sidecar-invalid', `Run ${runId} has no ${sidecar.zip.name} next to ${SIDECAR_FILE}.`)
  }
  if (zipSha256 !== sidecar.zip.sha256) {
    refuse('sha256-mismatch', `${sidecar.zip.name} does not match the sha256 in ${SIDECAR_FILE}.`)
  }
  return {
    zipPath,
    expectedVersion: sidecar.version,
    record: {
      source: 'candidate',
      version: sidecar.version,
      sha: sidecar.sha,
      ref: sidecar.ref ?? null,
      runId,
      builtAt: sidecar.builtAt ?? null
    }
  }
}
