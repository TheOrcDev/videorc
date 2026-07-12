#!/usr/bin/env node

import { resolve } from 'node:path'

import { checkTrackedTextFiles } from './lib/text-file-integrity.mjs'

const root = resolve(import.meta.dirname, '..')
const { failures, scanned } = await checkTrackedTextFiles(root)
if (failures.length > 0) {
  throw new Error(`Tracked text integrity failed:\n${failures.join('\n')}`)
}
console.log(`Tracked text integrity OK (${scanned} files).`)
