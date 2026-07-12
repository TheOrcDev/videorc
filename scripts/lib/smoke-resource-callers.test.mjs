import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const scriptsRoot = join(repoRoot, 'scripts')

test('renderer smoke output objects never send raw recording directories', () => {
  const violations = []
  for (const path of scriptFiles()) {
    const source = readFileSync(path, 'utf8')
    for (const line of rawOutputDirectoryPropertyLines(source)) {
      violations.push(`${path.slice(repoRoot.length + 1)}:${line}`)
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Smoke recording output objects must use one-shot outputDirectoryCapability: ${violations.join(', ')}`
  )
})

function rawOutputDirectoryPropertyLines(source) {
  const lines = source.split('\n')
  const violations = []
  let outputObjectDepth = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (outputObjectDepth === 0) {
      if (/\boutput\s*:\s*\{/.test(line)) {
        outputObjectDepth = braceDelta(line)
      }
      continue
    }

    if (/^\s*outputDirectory\s*(?:,|:)/.test(line)) {
      violations.push(index + 1)
    }
    outputObjectDepth += braceDelta(line)
  }
  return violations
}

function braceDelta(line) {
  return [...line].reduce(
    (depth, character) => depth + (character === '{' ? 1 : character === '}' ? -1 : 0),
    0
  )
}

function scriptFiles(directory = scriptsRoot) {
  const paths = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      paths.push(...scriptFiles(path))
    } else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
      paths.push(path)
    }
  }
  return paths
}
