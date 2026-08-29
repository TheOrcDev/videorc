#!/usr/bin/env node

import { resolve } from 'node:path'

import {
  assertCaptureDecayD3AcceptanceRecord,
  readCaptureDecayD3AcceptanceRecord
} from './lib/capture-decay-release-acceptance.mjs'
import {
  MACOS_D3_PUBLICATION_VERIFICATION_FILENAME,
  normalizeMacosD3SealedCandidateBinding,
  verifyDownloadedMacosD3SealedCandidate,
  writeMacosD3PublicationVerificationDescriptor
} from './lib/macos-d3-sealed-candidate.mjs'

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Full signed/notarized macOS candidate verification requires a macOS host.')
  }
  const options = parseOptions(process.argv.slice(2))
  const acceptedRecordPath = resolve(requiredOption(options.acceptedRecord, '--accepted-record'))
  const candidateDir = resolve(requiredOption(options.candidateDir, '--candidate-dir'))
  const record = assertCaptureDecayD3AcceptanceRecord(
    await readCaptureDecayD3AcceptanceRecord(acceptedRecordPath)
  )
  const sealedCandidate = normalizeMacosD3SealedCandidateBinding(
    acceptedRecord(record)?.sealedCandidate
  )
  const verified = await verifyDownloadedMacosD3SealedCandidate(
    {
      expectedSealedCandidate: sealedCandidate,
      outputDir: candidateDir
    },
    {
      requireFullVerification: true
    }
  )
  if (options.writePublicationDescriptor) {
    await writeMacosD3PublicationVerificationDescriptor({
      descriptorPath: resolve(options.writePublicationDescriptor),
      expectedSealedCandidate: sealedCandidate,
      outputDir: candidateDir
    })
  }
  console.log(
    `macos-d3-candidate-verify: PASS (${verified.document.release.releaseId}, ${sealedCandidate.manifest.sha256}${
      options.writePublicationDescriptor
        ? `; wrote ${MACOS_D3_PUBLICATION_VERIFICATION_FILENAME}`
        : ''
    })`
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
    ['--candidate-dir', 'candidateDir'],
    ['--write-publication-descriptor', 'writePublicationDescriptor']
  ])
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const key = allowed.get(name)
    const value = args[index + 1]
    if (!key || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`Invalid candidate-verification option near ${name ?? '(missing)'}.`)
    }
    if (options[key] !== undefined) {
      throw new Error(`Duplicate candidate-verification option ${name}.`)
    }
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
  console.error(`macos-d3-candidate-verify: FAIL (${error?.message ?? 'unexpected error'})`)
  process.exitCode = 1
})
