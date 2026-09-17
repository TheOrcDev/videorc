#!/usr/bin/env node

import { join, resolve } from 'node:path'

import {
  assertCaptureDecayD3AcceptanceRecord,
  readCaptureDecayD3AcceptanceRecord
} from './lib/capture-decay-release-acceptance.mjs'
import {
  downloadMacosD3SealedCandidate,
  getMacosD3CandidateS3Config,
  MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME,
  macosD3CandidateStorageIdentity,
  normalizeMacosD3SealedCandidateBinding,
  sha256MacosD3CanonicalJson,
  writeMacosD3CanonicalJsonExclusive
} from './lib/macos-d3-sealed-candidate.mjs'

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const acceptedRecordPath = resolve(requiredOption(options.acceptedRecord, '--accepted-record'))
  const outputDir = resolve(requiredOption(options.outputDir, '--output-dir'))
  const record = assertCaptureDecayD3AcceptanceRecord(
    await readCaptureDecayD3AcceptanceRecord(acceptedRecordPath)
  )
  const sealedCandidate = normalizeMacosD3SealedCandidateBinding(
    acceptedRecord(record)?.sealedCandidate
  )
  const candidateStorageConfig = getMacosD3CandidateS3Config()
  const storage = macosD3CandidateStorageIdentity(candidateStorageConfig)
  if (
    sha256MacosD3CanonicalJson(storage) !== sealedCandidate.storageBindingSha256 ||
    JSON.stringify(storage) !== JSON.stringify(sealedCandidate.sealReceipt.document.storage)
  ) {
    throw new Error(
      'Candidate storage credentials do not target the storage authority reviewed in the accepted record.'
    )
  }

  const downloaded = await downloadMacosD3SealedCandidate({
    candidateStorageConfig,
    expectedManifest: sealedCandidate.manifest,
    outputDir
  })
  await writeMacosD3CanonicalJsonExclusive(
    join(outputDir, MACOS_D3_CANDIDATE_SEAL_RECEIPT_FILENAME),
    sealedCandidate.sealReceipt.document
  )
  console.log(
    `macos-d3-candidate-download: PASS (${downloaded.document.release.releaseId}, ${sealedCandidate.manifest.sha256})`
  )
}

function acceptedRecord(record) {
  if (record.status === 'accepted') return record
  if (record.status === 'satisfied') return record.acceptedRecord
  throw new Error(`Capture-decay D3 record is ${record.status ?? 'missing'}, not accepted.`)
}

function parseOptions(args) {
  const allowed = new Map([
    ['--accepted-record', 'acceptedRecord'],
    ['--output-dir', 'outputDir']
  ])
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const key = allowed.get(name)
    const value = args[index + 1]
    if (!key || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`Invalid candidate-download option near ${name ?? '(missing)'}.`)
    }
    if (options[key] !== undefined) throw new Error(`Duplicate candidate-download option ${name}.`)
    options[key] = value
  }
  return options
}

function requiredOption(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is required.`)
  }
  return value.trim()
}

main().catch((error) => {
  console.error(`macos-d3-candidate-download: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exitCode = 1
})
