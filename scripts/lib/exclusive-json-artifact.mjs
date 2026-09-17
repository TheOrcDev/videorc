import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export function serializeJsonArtifact(document, { hashBytes = sha256Bytes } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
  const sha256 = hashBytes(bytes)
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
    throw new Error('Prepared JSON artifact did not produce a lowercase SHA-256 digest.')
  }
  return { bytes, sha256, size: bytes.length }
}

export async function prepareExclusiveJsonArtifact(
  path,
  document,
  {
    hashBytes = sha256Bytes,
    makeParentDirectory = (directory) => mkdir(directory, { recursive: true }),
    inspectDestination = lstat,
    writeTemporary = (temporaryPath, bytes) => writeFile(temporaryPath, bytes, { flag: 'wx' }),
    readTemporary = readFile,
    publishTemporary = link,
    removePath = (target) => rm(target, { force: true })
  } = {}
) {
  if (!isAbsolute(path ?? '')) {
    throw new Error('Exclusive JSON artifact path must be absolute.')
  }
  const destinationPath = resolve(path)
  const prepared = serializeJsonArtifact(document, { hashBytes })
  await makeParentDirectory(dirname(destinationPath))
  const existing = await inspectDestination(destinationPath).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    throw new Error(`Immutable JSON artifact already exists: ${destinationPath}`)
  }
  const temporaryPath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.prepared-${process.pid}-${randomBytes(16).toString('hex')}`
  )
  try {
    await writeTemporary(temporaryPath, prepared.bytes)
    const persisted = await readTemporary(temporaryPath)
    if (
      !Buffer.isBuffer(persisted) ||
      persisted.length !== prepared.size ||
      !persisted.equals(prepared.bytes) ||
      hashBytes(persisted) !== prepared.sha256
    ) {
      throw new Error('Prepared JSON artifact bytes changed before publication.')
    }
  } catch (error) {
    await removePath(temporaryPath).catch(() => undefined)
    throw error
  }

  let state = 'prepared'
  return {
    path: destinationPath,
    sha256: prepared.sha256,
    size: prepared.size,
    async publish() {
      if (state !== 'prepared') {
        throw new Error(`Prepared JSON artifact cannot publish from state ${state}.`)
      }
      try {
        await publishTemporary(temporaryPath, destinationPath)
      } catch (error) {
        state = 'discarded'
        const cleanup = [removePath(temporaryPath).catch(() => undefined)]
        if (error?.code !== 'EEXIST') {
          cleanup.push(removePath(destinationPath).catch(() => undefined))
        }
        await Promise.all(cleanup)
        throw error
      }
      state = 'published'
      await removePath(temporaryPath).catch(() => undefined)
      return {
        path: destinationPath,
        sha256: prepared.sha256,
        size: prepared.size
      }
    },
    async discard() {
      if (state !== 'prepared') return
      state = 'discarded'
      await removePath(temporaryPath)
    }
  }
}

export async function finalizePreparedJsonArtifact(prepared, verifyImmediatelyBeforePublish) {
  if (typeof prepared?.publish !== 'function' || typeof prepared?.discard !== 'function') {
    throw new Error('Final PASS publication requires one prepared JSON artifact.')
  }
  if (typeof verifyImmediatelyBeforePublish !== 'function') {
    throw new Error('Final PASS publication requires an immediate verification callback.')
  }
  try {
    await verifyImmediatelyBeforePublish()
    return await prepared.publish()
  } catch (error) {
    await prepared.discard().catch(() => undefined)
    throw error
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
