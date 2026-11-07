import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { sha256File } from './linux-release.mjs'

// Inspect an isolated copy of the exact hashed artifact, never linux-unpacked.
// The AppImage runtime executes only to extract, without release credentials,
// Electron overrides, or the operator's profile in its environment.
export async function withLinuxAppImagePayload(
  { artifactPath, sha256, sizeBytes },
  inspect,
  { extract = execFileSync, temporaryParent = tmpdir() } = {}
) {
  let directory = await mkdtemp(join(temporaryParent, 'videorc-appimage-validation-'))
  try {
    // Resolve legitimate temporary-parent aliases before extraction, so the
    // exact root comparison below still rejects links created by the payload.
    directory = await realpath(directory)
    const artifact = join(directory, 'candidate.AppImage')
    await copyFile(artifactPath, artifact)
    if (
      (await stat(artifact)).size !== sizeBytes ||
      (await sha256File(artifact)) !== sha256.toLowerCase()
    ) {
      throw new Error('AppImage changed or does not match the candidate hash and size.')
    }
    await assertLinuxX64Elf(artifact)
    await chmod(artifact, 0o500)
    extract(artifact, ['--appimage-extract'], {
      cwd: directory,
      env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024
    })
    const root = join(directory, 'squashfs-root')
    if ((await realpath(root)) !== root) throw new Error('AppImage extraction root is a symlink.')
    const result = await inspect(root)
    if ((await sha256File(artifact)) !== sha256.toLowerCase())
      throw new Error('AppImage changed during inspection.')
    return result
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function assertLinuxX64Elf(path) {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(20)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (
      bytesRead !== 20 ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header.readUInt16LE(18) !== 62
    ) {
      throw new Error('AppImage and bundled executables must be Linux x64 ELF binaries.')
    }
  } finally {
    await file.close()
  }
}

export async function payloadFilePresent(root, relativePath, { executable = false } = {}) {
  try {
    const path = await realpath(join(root, relativePath))
    if (!path.startsWith(`${root}${sep}`)) return false
    const info = await stat(path)
    return info.isFile() && info.size > 0 && (!executable || (info.mode & 0o111) !== 0)
  } catch {
    return false
  }
}
