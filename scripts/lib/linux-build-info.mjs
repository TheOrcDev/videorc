import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'

export async function sha256(path) {
  const hash = createHash('sha256')
  return await new Promise((resolveHash, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

export async function loadVersions(repoRoot = process.cwd()) {
  const desktopPackage = JSON.parse(await readFile(resolve(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'))
  const rootPackage = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'))
  return {
    appVersion: desktopPackage.version,
    repoVersion: rootPackage.version
  }
}

export async function buildLinuxBuildInfo({ artifactPath, repoRoot = process.cwd() } = {}) {
  const versions = await loadVersions(repoRoot)
  const buildInfo = {
    app: {
      name: 'Videorc',
      platform: 'linux',
      package: 'deb',
      arch: process.arch,
      version: versions.appVersion
    },
    repoVersion: versions.repoVersion,
    git: {
      commit: (process.env.GITHUB_SHA || '').trim() || null,
      ref: (process.env.GITHUB_REF_NAME || '').trim() || null,
      runId: (process.env.GITHUB_RUN_ID || '').trim() || null
    },
    provenance: {
      workflow: (process.env.GITHUB_WORKFLOW || '').trim() || null,
      run: (process.env.GITHUB_RUN_NUMBER || '').trim() || null,
      timestamp: new Date().toISOString()
    },
    build: {
      rustVersion: process.env.RUSTC_VERSION || null,
      nodeVersion: process.version,
      requestedBy: process.env.GITHUB_ACTOR || null
    },
    artifacts: {}
  }

  if (artifactPath) {
    const checksum = await sha256(artifactPath)
    buildInfo.artifacts.mainDeb = {
      path: artifactPath,
      sha256: checksum,
      sha256File: `${artifactPath}.sha256`
    }
  }

  return buildInfo
}

export async function writeLinuxBuildInfo({ artifactPath, outputPath, repoRoot = process.cwd() }) {
  const buildInfo = await buildLinuxBuildInfo({ artifactPath, repoRoot })
  await import('node:fs/promises').then(async ({ writeFile }) => {
    await writeFile(outputPath, JSON.stringify(buildInfo, null, 2) + '\\n', 'utf8')
  })
  if (buildInfo.artifacts.mainDeb?.sha256) {
    await import('node:fs/promises').then(async ({ writeFile }) => {
      await writeFile(
        buildInfo.artifacts.mainDeb.sha256File,
        `${buildInfo.artifacts.mainDeb.sha256}  ${artifactPath}\\n`,
        'utf8'
      )
    })
  }
  return buildInfo
}
