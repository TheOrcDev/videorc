#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertCaptureDecayD3PublicationGate,
  assertCaptureDecayD3PublicationMode
} from './lib/capture-decay-publication-git.mjs'
import {
  assertCaptureDecayD3PublicationReceipt,
  captureDecayCanonicalJsonSha256
} from './lib/capture-decay-release-acceptance.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const recordPath = join(repoRoot, 'docs', 'acceptance', 'macos-capture-decay-d3.json')
const options = parseOptions(process.argv.slice(2))

assertCaptureDecayD3PublicationGate({
  recordPath,
  repoRoot,
  requireProtectedRef: options.protectedPublicationRef
})
  .then(async ({ headCommit, record }) => {
    assertCaptureDecayD3PublicationMode(record, options)
    if (options.publicationReceiptPath && record.status === 'accepted') {
      const receiptText = await readFile(options.publicationReceiptPath, 'utf8')
      const receipt = JSON.parse(receiptText)
      if (`${JSON.stringify(receipt, null, 2)}\n` !== receiptText) {
        throw new Error('first-publication D3 receipt is not canonical JSON')
      }
      assertCaptureDecayD3PublicationReceipt(receipt, {
        acceptedRecord: record,
        acceptedRecordSha256: captureDecayCanonicalJsonSha256(record)
      })
      if (receipt.publicationSourceCommit !== headCommit) {
        throw new Error('first-publication D3 receipt does not identify this publication commit')
      }
    }
    console.log(
      `macos-capture-decay-d3: PASS (${record.status}; source ${headCommit}; evidence ${
        record.evidenceManifestSha256 ?? record.acceptedRecord?.evidenceManifestSha256
      })`
    )
  })
  .catch((error) => {
    console.error(`macos-capture-decay-d3: FAIL (${error?.message ?? 'unexpected error'})`)
    process.exit(1)
  })

function parseOptions(args) {
  const options = {
    exactPromotion: false,
    protectedPublicationRef: false,
    publicationReceiptPath: null,
    regularRelease: false
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--protected-publication-ref' && !options.protectedPublicationRef) {
      options.protectedPublicationRef = true
      continue
    }
    if (argument === '--regular-release' && !options.regularRelease) {
      options.regularRelease = true
      continue
    }
    if (argument === '--exact-promotion' && !options.exactPromotion) {
      options.exactPromotion = true
      continue
    }
    if (argument === '--publication-receipt' && options.publicationReceiptPath === null) {
      const path = args[index + 1]
      if (typeof path === 'string' && !path.startsWith('--')) {
        options.publicationReceiptPath = resolve(path)
        index += 1
        continue
      }
    }
    throw new Error(
      'usage: verify-macos-capture-decay-d3.mjs [--protected-publication-ref] [--regular-release | --exact-promotion] [--publication-receipt <path>]'
    )
  }
  if (options.exactPromotion && options.regularRelease) {
    throw new Error(
      'usage: verify-macos-capture-decay-d3.mjs [--protected-publication-ref] [--regular-release | --exact-promotion] [--publication-receipt <path>]'
    )
  }
  return options
}
