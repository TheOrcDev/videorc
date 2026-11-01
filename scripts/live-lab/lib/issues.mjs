// Plan 178 U10. One GitHub issue per failure signature in TheOrcDev/videorc,
// label `live-lab`. An open issue carries its signature in a body marker
// (`<!-- live-lab-signature: <sig> -->`); a repeat failure becomes a comment
// on that issue, never a second issue. All calls go through an injected
// `gh(args, { input }) -> { code, stdout, stderr }`; bodies go over stdin
// (`--body-file -`), never on the command line. The caller guards every
// title and body before it gets here.

export const ISSUES_REPO = 'TheOrcDev/videorc'
export const ISSUE_LABEL = 'live-lab'
export const LABEL_COLOR = 'B60205'
export const LABEL_DESCRIPTION = 'Found by the unattended live lab (plan 178)'
const SIGNATURE_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,99}$/
const EVIDENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const MAX_TITLE = 120

export class GhError extends Error {
  constructor(action, result) {
    const detail = String(result?.stderr ?? '')
      .trim()
      .split('\n')
      .pop()
    super(`gh ${action} failed (exit ${result?.code})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    this.name = 'GhError'
    this.code = result?.code
  }
}

export function isValidSignature(value) {
  return typeof value === 'string' && SIGNATURE_RE.test(value) && !value.includes('--')
}

export function signatureMarker(signature) {
  if (!isValidSignature(signature)) throw new Error('invalid incident signature')
  return `<!-- live-lab-signature: ${signature} -->`
}

/** Pure: the open issue whose body holds this signature's exact marker, or null. */
export function findIssueForSignature(issues, signature) {
  const marker = signatureMarker(signature)
  return (
    issues.find((issue) => typeof issue?.body === 'string' && issue.body.includes(marker)) ?? null
  )
}

function oneLine(text, max) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function issueTitle(signature, summary) {
  return oneLine(`[live-lab] ${signature}: ${oneLine(summary, 200) || 'failure'}`, MAX_TITLE)
}

/** Pure: evidence names that are safe relative paths inside a run folder. */
export function safeEvidence(list) {
  return (Array.isArray(list) ? list : []).filter(
    (item) => typeof item === 'string' && EVIDENCE_RE.test(item) && !item.includes('..')
  )
}

function evidenceLines(evidence, fileUrl) {
  return safeEvidence(evidence).map((item) => {
    const url = fileUrl?.(item)
    return url ? `- [${item}](${url})` : `- \`${item}\` (lab run folder only)`
  })
}

function runLine(run) {
  const build = run.build
    ? `${run.build.source ?? '?'} ${run.build.version ?? ''}${run.build.sha ? ` (${String(run.build.sha).slice(0, 12)})` : ''}`.trim()
    : 'unknown build'
  return `\`${run.runId}\`, scenario \`${run.scenario}\`, ${run.trigger ?? 'run'}, ${build}, outcome **${run.outcome ?? 'unknown'}**`
}

/**
 * Pure: the body of a new incident issue. `links.report` is the report URL
 * (or null); `links.file(name)` maps an evidence name to a URL when that file
 * was published, else null.
 */
export function incidentIssueBody({ incident, run, links = {} }) {
  const lines = [
    signatureMarker(incident.signature),
    `**Signature:** \`${incident.signature}\``,
    `**Severity:** ${incident.severity ?? 'unknown'}`,
    `**First seen:** ${runLine(run)}${incident.firstAt ? ` at ${incident.firstAt}` : ''}`,
    '',
    oneLine(incident.summary, 500) || '(no summary)',
    ''
  ]
  if (links.report) lines.push(`Report: ${links.report}`, '')
  const evidence = evidenceLines(incident.evidence, links.file)
  if (evidence.length) lines.push('**Evidence**', ...evidence, '')
  lines.push(
    'Filed by `pnpm live:publish` (plan 178 U10). A repeat of this signature is added here as a comment.'
  )
  return lines.join('\n')
}

/** Pure: the comment for a repeat of a signature. */
export function incidentCommentBody({ incident, run, links = {} }) {
  const lines = [
    `Seen again: ${runLine(run)}${incident.firstAt ? ` at ${incident.firstAt}` : ''}.`,
    `Severity ${incident.severity ?? 'unknown'}: ${oneLine(incident.summary, 500) || '(no summary)'}`
  ]
  if (links.report) lines.push(`Report: ${links.report}`)
  const evidence = evidenceLines(incident.evidence, links.file)
  if (evidence.length) lines.push('', ...evidence)
  return lines.join('\n')
}

/** Pure: issue body / comment for a boot doctor FAIL (`doctor:<check>`). */
export function doctorIssueBody({ signature, check, detail, file }) {
  return [
    signatureMarker(signature),
    `**Signature:** \`${signature}\``,
    `**Check:** ${check}`,
    `**First seen:** the boot doctor run \`${file}\` on the lab machine`,
    '',
    detail ? `\`FAIL  ${check}\`: ${oneLine(detail, 500)}` : `\`FAIL  ${check}\` (detail withheld)`,
    '',
    'Filed by `pnpm live:publish` (plan 178 U10) from the post-boot `live:doctor` (U11). Fix it at the lab machine, not over SSH.'
  ].join('\n')
}

export function doctorCommentBody({ check, detail, file }) {
  return `Still failing after boot (\`${file}\`): \`FAIL  ${check}\`${detail ? `: ${oneLine(detail, 500)}` : ''}`
}

/** Pure: a doctor check name as a signature slug. */
export function doctorSignature(check) {
  const slug = String(check ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `doctor:${slug || 'unknown'}`
}

/** Pure: the FAIL lines of a `live:doctor` output (doctor-checks formatResult). */
export function parseDoctorFails(text) {
  const fails = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('FAIL  ')) continue
    // formatResult: `FAIL  <name padded to 22> <detail>`.
    const rest = line.slice(6).trimEnd()
    const check = rest.slice(0, 22).trim()
    const detail = rest.slice(23).trim()
    if (check) fails.push({ check, detail })
  }
  return fails
}

function parseJson(text, action) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`gh ${action} returned unreadable JSON`)
  }
}

/** Open `live-lab` issues: [{ number, title, body, url }]. A missing label reads as none. */
export async function listOpenLabIssues({ gh, repo = ISSUES_REPO }) {
  const result = await gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--label',
    ISSUE_LABEL,
    '--state',
    'open',
    '--limit',
    '300',
    '--json',
    'number,title,body,url'
  ])
  if (result.code !== 0) {
    if (/label/i.test(result.stderr ?? '') && /not found|could not/i.test(result.stderr ?? '')) {
      return []
    }
    throw new GhError('issue list', result)
  }
  const parsed = parseJson(result.stdout || '[]', 'issue list')
  return Array.isArray(parsed) ? parsed : []
}

/** Creates (or updates) the label. Resolves true when it exists afterwards. */
export async function ensureLabel({ gh, repo = ISSUES_REPO }) {
  const result = await gh([
    'label',
    'create',
    ISSUE_LABEL,
    '--repo',
    repo,
    '--color',
    LABEL_COLOR,
    '--description',
    LABEL_DESCRIPTION,
    '--force'
  ])
  return result.code === 0
}

function issueRef(url) {
  const match = /\/issues\/(\d+)\s*$/.exec(String(url ?? '').trim())
  return match ? Number(match[1]) : null
}

/**
 * Comments on the open issue for `signature` when there is one, else creates
 * it. `issues` is the open-issue list (it is updated in place, so a second
 * incident with the same signature in one publish comments). Resolves
 * { action: 'commented' | 'created', number, url, labeled? }.
 */
export async function fileSignature({
  gh,
  repo = ISSUES_REPO,
  issues,
  signature,
  title,
  body,
  comment,
  labelReady
}) {
  const existing = findIssueForSignature(issues, signature)
  if (existing) {
    const result = await gh(
      ['issue', 'comment', String(existing.number), '--repo', repo, '--body-file', '-'],
      {
        input: comment
      }
    )
    if (result.code !== 0) throw new GhError('issue comment', result)
    return { action: 'commented', number: existing.number, url: existing.url ?? null }
  }
  const base = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-']
  // labelReady: a boolean, or a lazy () => Promise<boolean> (gh label create
  // runs only when an issue is about to be created).
  let labeled = typeof labelReady === 'function' ? await labelReady() : labelReady !== false
  let result = await gh(labeled ? [...base, '--label', ISSUE_LABEL] : base, { input: body })
  if (result.code !== 0 && labeled && /label/i.test(result.stderr ?? '')) {
    labeled = false
    result = await gh(base, { input: body })
  }
  if (result.code !== 0) throw new GhError('issue create', result)
  const url = String(result.stdout ?? '')
    .trim()
    .split('\n')
    .pop()
  const number = issueRef(url)
  issues.push({ number, title, body, url })
  return { action: 'created', number, url, labeled }
}
