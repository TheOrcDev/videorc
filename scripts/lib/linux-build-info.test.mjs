import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { writeFile, mkdir, readFile } from 'node:fs/promises'

import { buildLinuxBuildInfo, writeLinuxBuildInfo } from './linux-build-info.mjs'

it('builds linux build info with required metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'videorc-linux-build-info-'))
  try {
    const fakeDesktop = join(root, 'apps', 'desktop')
    const fakePackage = join(root, 'package.json')
    await mkdir(join(root, 'apps', 'desktop'), { recursive: true })
    await writeFile(fakePackage, JSON.stringify({ version: '0.9.0' }), 'utf8')
    await writeFile(
      join(fakeDesktop, 'package.json'),
      JSON.stringify({ version: '0.9.0' }),
      'utf8'
    )

    const artifactPath = join(root, 'videorc.deb')
    writeFileSync(artifactPath, 'artifact')

    const info = await buildLinuxBuildInfo({ artifactPath, repoRoot: root })
    assert.equal(info.app.platform, 'linux')
    assert.equal(info.app.version, '0.9.0')
    assert.equal(info.artifacts.mainDeb.path, artifactPath)
    assert.equal(typeof info.artifacts.mainDeb.sha256, 'string')
    assert.equal(info.artifacts.mainDeb.sha256.length > 10, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('writes build-info and checksum files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'videorc-linux-build-info-write-'))
  try {
    await mkdir(join(root, 'apps', 'desktop'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8')
    await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8')
    const artifactPath = join(root, 'Videorc-linux.deb')
    writeFileSync(artifactPath, 'artifact')
    const outputPath = join(root, 'linux-build-info.json')
    await writeLinuxBuildInfo({ artifactPath, outputPath, repoRoot: root })
    const written = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(written.artifacts.mainDeb.sha256.length > 0, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
