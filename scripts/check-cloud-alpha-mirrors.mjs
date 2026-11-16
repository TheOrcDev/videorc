/** Lightweight canonical-source check; never bundles or starts media/browser acquisition. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const webRoot = process.argv[2]
assert.ok(webRoot, 'Pass the isolated paired web root')
const prettier = createRequire(resolve(webRoot, 'package.json'))('prettier')
const canonical = (text) =>
  prettier.format(text.replaceAll('./cloud-alpha', './alpha-transport'), {
    parser: 'typescript',
    singleQuote: false,
    semi: true,
    trailingComma: 'all',
    printWidth: 80
  })
for (const [desktop, web] of [
  ['cloud-alpha', 'alpha-transport'],
  ['cloud-alpha-gpu', 'alpha-gpu']
]) {
  assert.equal(
    await canonical(await readFile(`apps/desktop/src/shared/${desktop}.ts`, 'utf8')),
    await canonical(await readFile(resolve(webRoot, `lib/cloud/program/${web}.ts`), 'utf8')),
    `${desktop} mirror drift`
  )
}
console.log('Alpha protocol and GPU source mirrors match')
