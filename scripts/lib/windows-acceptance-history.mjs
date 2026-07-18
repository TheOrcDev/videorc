import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assertWindowsAcceptanceRecord } from './windows-acceptance-record.mjs'
import { compareNumericVersions } from './windows-alpha-release.mjs'

const ACCEPTED_RELEASE_FILENAME = /^(\d+\.\d+\.\d+-alpha\.1)\.json$/

export async function loadValidatedWindowsAcceptanceHistory(directory) {
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const releaseIds = names
    .map((name) => ACCEPTED_RELEASE_FILENAME.exec(name)?.[1])
    .filter(Boolean)
    .sort((left, right) => compareNumericVersions(numericCore(left), numericCore(right)))

  const validated = []
  for (const releaseId of releaseIds) {
    const recordPath = join(directory, `${releaseId}.json`)
    let record
    try {
      record = JSON.parse(await readFile(recordPath, 'utf8'))
    } catch (error) {
      throw new Error(
        `Prior Windows Alpha acceptance record ${releaseId} is not valid JSON: ${error?.message ?? 'parse error'}.`
      )
    }
    assertWindowsAcceptanceRecord(record, {
      filename: record?.installer?.filename,
      installerSha256: record?.installer?.sha256,
      publisherName: record?.installer?.publisherName,
      releaseId,
      sourceCommit: record?.sourceCommit,
      priorAcceptedReleaseIds: [...validated]
    })
    validated.push(releaseId)
  }

  return validated
}

function numericCore(releaseId) {
  return releaseId.slice(0, releaseId.indexOf('-'))
}
