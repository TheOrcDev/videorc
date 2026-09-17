import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

export class CaptureDecayEvidenceArtifactError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CaptureDecayEvidenceArtifactError'
    this.code = code
  }
}

/**
 * Read/hash an immutable evidence artifact through one file descriptor.
 *
 * The lexical path is only a locator. The artifact is accepted only when its
 * canonical path remains inside the canonical root, its final component is a
 * regular file rather than a symlink, and the path still names the same stable
 * file after the descriptor has been consumed.
 */
export async function readCaptureDecayEvidenceArtifact({
  label = 'capture-decay evidence artifact',
  path,
  readBytes = false,
  root
}) {
  const rootPath = resolve(requiredPath(root, 'evidence root'))
  const suppliedPath = requiredPath(path, `${label} path`)
  const artifactPath = isAbsolute(suppliedPath)
    ? resolve(suppliedPath)
    : resolve(rootPath, suppliedPath)
  assertContained(rootPath, artifactPath, label)

  const beforePathStat = await artifactLstat(artifactPath, label)
  assertRegularFile(beforePathStat, label)
  const [rootRealPathBefore, artifactRealPathBefore] = await Promise.all([
    realpath(rootPath),
    realpath(artifactPath)
  ])
  assertContained(rootRealPathBefore, artifactRealPathBefore, label)

  const noFollow = constants.O_NOFOLLOW ?? 0
  let handle
  try {
    handle = await open(artifactPath, constants.O_RDONLY | noFollow)
  } catch (cause) {
    if (cause?.code === 'ELOOP') {
      throw artifactError(
        'evidence-artifact-symlink',
        `${label} became a symbolic link before it could be opened.`,
        cause
      )
    }
    throw artifactError(
      'evidence-artifact-race',
      `${label} changed before it could be opened.`,
      cause
    )
  }

  try {
    const beforeFdStat = await handle.stat({ bigint: true })
    assertRegularFile(beforeFdStat, label)
    if (!sameFileIdentity(beforePathStat, beforeFdStat)) {
      throw artifactError(
        'evidence-artifact-race',
        `${label} path no longer names the file that was opened.`
      )
    }

    const hash = createHash('sha256')
    const chunks = readBytes ? [] : null
    let bytesRead = 0n
    const stream = handle.createReadStream({ autoClose: false, start: 0 })
    for await (const chunk of stream) {
      hash.update(chunk)
      bytesRead += BigInt(chunk.length)
      chunks?.push(chunk)
    }

    const afterFdStat = await handle.stat({ bigint: true })
    if (!sameFileSnapshot(beforeFdStat, afterFdStat) || bytesRead !== afterFdStat.size) {
      throw artifactError(
        'evidence-artifact-race',
        `${label} changed while its immutable bytes were being read.`
      )
    }
    if (afterFdStat.size <= 0n) {
      throw artifactError('evidence-artifact-empty', `${label} must be a non-empty file.`)
    }
    if (afterFdStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw artifactError(
        'evidence-artifact-size',
        `${label} is too large to retain an exact JavaScript byte size.`
      )
    }

    const afterPathStat = await artifactLstat(artifactPath, label, {
      missingCode: 'evidence-artifact-race'
    })
    assertRegularFile(afterPathStat, label)
    if (
      !sameFileIdentity(afterPathStat, afterFdStat) ||
      !sameFileSnapshot(beforePathStat, afterPathStat)
    ) {
      throw artifactError(
        'evidence-artifact-race',
        `${label} path changed while its immutable bytes were being read.`
      )
    }

    const [rootRealPathAfter, artifactRealPathAfter] = await Promise.all([
      realpath(rootPath),
      realpath(artifactPath)
    ])
    if (
      rootRealPathAfter !== rootRealPathBefore ||
      artifactRealPathAfter !== artifactRealPathBefore
    ) {
      throw artifactError(
        'evidence-artifact-race',
        `${label} canonical path changed while its immutable bytes were being read.`
      )
    }
    assertContained(rootRealPathAfter, artifactRealPathAfter, label)

    return {
      bytes: chunks === null ? null : Buffer.concat(chunks),
      filename: basename(artifactRealPathAfter),
      path: artifactRealPathAfter,
      relativePath: relative(rootRealPathAfter, artifactRealPathAfter).split(sep).join('/'),
      sha256: hash.digest('hex'),
      sizeBytes: Number(afterFdStat.size)
    }
  } finally {
    await handle.close()
  }
}

async function artifactLstat(path, label, { missingCode = 'evidence-artifact-missing' } = {}) {
  try {
    return await lstat(path, { bigint: true })
  } catch (cause) {
    throw artifactError(missingCode, `${label} could not be inspected as a regular file.`, cause)
  }
}

function assertRegularFile(metadata, label) {
  if (metadata.isSymbolicLink()) {
    throw artifactError('evidence-artifact-symlink', `${label} must not be a symbolic link.`)
  }
  if (!metadata.isFile()) {
    throw artifactError('evidence-artifact-type', `${label} must be a regular file.`)
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

function sameFileSnapshot(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function assertContained(root, path, label) {
  const traversal = relative(resolve(root), resolve(path))
  if (
    traversal.length === 0 ||
    traversal === '..' ||
    traversal.startsWith(`..${sep}`) ||
    isAbsolute(traversal)
  ) {
    throw artifactError(
      'evidence-artifact-path',
      `${label} must stay inside its immutable evidence root.`
    )
  }
}

function requiredPath(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\0\r\n]/.test(value)) {
    throw artifactError('evidence-artifact-path', `${label} must be a non-empty path.`)
  }
  return value
}

function artifactError(code, message, cause) {
  return new CaptureDecayEvidenceArtifactError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  )
}
