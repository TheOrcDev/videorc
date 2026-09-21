#!/usr/bin/env node

import { resolve } from 'node:path'

import { checkEmDashes } from './lib/em-dash-gate.mjs'

const root = resolve(import.meta.dirname, '..')
const { failures, scanned } = await checkEmDashes(root)
if (failures.length > 0) {
  throw new Error(
    `App copy must not use an em dash. Reword with a period, comma or colon:\n${failures.join('\n')}`
  )
}
console.log(`Em dash gate OK (${scanned} files).`)
