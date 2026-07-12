import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cjs',
  '.cpp',
  '.css',
  '.csv',
  '.h',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.lock',
  '.md',
  '.mjs',
  '.mts',
  '.ps1',
  '.py',
  '.rs',
  '.sh',
  '.svg',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
])
const TEXT_BASENAMES = new Set([
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.npmrc',
  '.prettierignore',
  '.env.example',
  'Dockerfile',
  'LICENSE',
  'Makefile',
  'NOTICE'
])
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export function isTrackedTextPath(path) {
  return TEXT_BASENAMES.has(basename(path)) || TEXT_EXTENSIONS.has(extname(path).toLowerCase())
}

export function inspectTextBuffer(path, contents) {
  if (!isTrackedTextPath(path)) return []

  const nulOffset = contents.indexOf(0)
  if (nulOffset !== -1) {
    return [`${path}: contains a NUL byte at offset ${nulOffset}`]
  }

  try {
    UTF8_DECODER.decode(contents)
    return []
  } catch {
    return [`${path}: is not valid UTF-8`]
  }
}

export async function checkTrackedTextFiles(root) {
  // Include non-ignored, untracked candidates so a newly added source file is
  // checked before it is staged as well as after it becomes tracked in CI.
  const files = repositoryFiles(root)
  const failures = []
  let scanned = 0

  for (const path of files) {
    if (!isTrackedTextPath(path)) continue
    let contents
    try {
      contents = await readFile(resolve(root, path))
    } catch (error) {
      // `git ls-files` includes a tracked file deleted in the current worktree.
      // The deletion itself is handled by Git; there is no current text to inspect.
      if (error?.code === 'ENOENT') continue
      throw error
    }
    scanned += 1
    failures.push(...inspectTextBuffer(path, contents))
  }

  return { failures, scanned }
}

function repositoryFiles(root) {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root }
  )
  return output.toString('utf8').split('\0').filter(Boolean)
}
