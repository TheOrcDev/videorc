#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { downloadFile, sourceUrlsFromPin } from './lib/download-file.mjs'

export async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  output = console,
  download = downloadFile
} = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', multiple: true },
      out: { type: 'string' },
      sha256: { type: 'string' },
      pin: { type: 'string' },
      attempts: { type: 'string' }
    }
  })

  let urls = values.url ?? []
  let sha256 = values.sha256
  if (values.pin) {
    const pin = JSON.parse(await readFile(resolve(cwd, values.pin), 'utf8'))
    urls = [...sourceUrlsFromPin(pin), ...urls]
    sha256 = sha256 ?? pin.sourceSha256
  }

  const result = await download({
    urls,
    destination: resolve(cwd, values.out ?? ''),
    sha256,
    attempts: values.attempts ? Number(values.attempts) : undefined
  })
  if (result.reused) {
    output.log(`download-file: reusing verified ${result.destination}`)
  } else {
    output.log(`download-file: fetched ${result.url} on attempt ${result.attempt}`)
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`download-file: ${error.code ?? 'error'}: ${error.message}`)
    process.exitCode = 1
  })
}
