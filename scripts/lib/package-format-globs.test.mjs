import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Prettier lstats each pattern as a literal path before it expands the glob,
// and only a missing path is expected there. A path segment longer than the
// filesystem's 255-byte name limit fails with ENAMETOOLONG instead, which
// stops `pnpm format:check` before it checks any file.
const NAME_MAX_BYTES = 255

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

function quotedPatterns(command) {
  return [...command.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

test('format and format:check name the same prettier patterns', () => {
  const { format, 'format:check': formatCheck } = packageJson.scripts
  assert.ok(format.startsWith('prettier --write '))
  assert.match(formatCheck, /&& prettier --check /)
  assert.deepEqual(quotedPatterns(formatCheck), quotedPatterns(format))
})

test('every prettier pattern segment fits a filesystem name', () => {
  const patterns = quotedPatterns(packageJson.scripts['format:check'])
  assert.ok(patterns.length > 0)
  for (const pattern of patterns) {
    for (const segment of pattern.split('/')) {
      const bytes = Buffer.byteLength(segment, 'utf8')
      assert.ok(
        bytes <= NAME_MAX_BYTES,
        `${pattern}: the segment ${segment.slice(0, 40)}... is ${bytes} bytes, over ${NAME_MAX_BYTES}; split its brace list`
      )
    }
  }
})
