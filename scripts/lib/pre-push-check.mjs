// Plan 242 S20: what the pre-push hook checks. Pure helpers; the hook itself
// is .githooks/pre-push -> scripts/pre-push-check.mjs.

const ZERO_SHA_RE = /^0+$/

/**
 * Git feeds pre-push one line per ref: "<local ref> <local sha> <remote ref>
 * <remote sha>". Returns the branch ranges to diff. A deleted ref needs
 * nothing, and a tag points at commits already checked when their branch was
 * pushed; a new remote branch diffs against `fallbackBase` (the merge-base
 * with main).
 */
export function pushRanges(stdin, fallbackBase) {
  const ranges = []
  for (const line of String(stdin).split('\n')) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/)
    if (!localRef || !localSha || ZERO_SHA_RE.test(localSha)) continue
    if (!localRef.startsWith('refs/heads/')) continue
    const base = !remoteSha || ZERO_SHA_RE.test(remoteSha) ? fallbackBase : remoteSha
    if (base) ranges.push({ ref: localRef, base, head: localSha })
  }
  return ranges
}

const LINTABLE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const TYPECHECKED_RE = /^apps\/desktop\/(src\/|electron\.vite\.config\.ts$|tsconfig[^/]*\.json$)/

/**
 * What to run (paths relative to the repo root). `changed` includes deleted
 * files: deleting a module another still imports must still typecheck.
 * Format and lint read files, so they take only the ones that still exist.
 */
export function prePushPlan(changed, present, formatScope) {
  const files = [...new Set(present)].sort()
  return {
    format: files.filter((file) => formatScope.has(file)),
    lint: files.filter((file) => file.startsWith('apps/desktop/') && LINTABLE_RE.test(file)),
    typecheck: changed.some((file) => TYPECHECKED_RE.test(file))
  }
}

/** The files `pnpm format:check` covers, from its Prettier globs. */
export function formatCheckGlobs(formatCheckScript) {
  const match = String(formatCheckScript).match(/prettier --check (.*)$/)
  if (!match) return []
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
}
