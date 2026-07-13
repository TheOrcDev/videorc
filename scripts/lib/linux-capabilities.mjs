import { readFile } from 'node:fs/promises'

/**
 * Build the Linux capability manifest payload.
 *
 * This manifest is intentionally conservative: if no runtime capability probe
 * runs, it records that state explicitly instead of fabricating support claims.
 * We keep this artifact focused on reproducible build context and visible, trusted
 * capability assertions.
 */
export function buildLinuxCapabilities({ artifactPath, runtimeCapabilities = {}, generatedAt = new Date().toISOString(), repoRoot = process.cwd() }) {
  return {
    schemaVersion: 1,
    platform: 'linux',
    architecture: process.arch,
    artifact: {
      path: artifactPath ? String(artifactPath) : null,
      generatedAt
    },
    runtime: {
      source: runtimeCapabilities.source ?? 'build-time-generator',
      probeAt: runtimeCapabilities.probeAt ?? null,
      capture: {
        gnomeWayland: runtimeCapabilities.capture?.gnomeWayland ?? false,
        portal: runtimeCapabilities.capture?.portal ?? false,
        pipewire: runtimeCapabilities.capture?.pipewire ?? false
      },
      audio: {
        microphone: runtimeCapabilities.audio?.microphone ?? false,
        systemAudio: runtimeCapabilities.audio?.systemAudio ?? false
      },
      preview: {
        nativeAvailable: runtimeCapabilities.preview?.nativeAvailable ?? false,
        webglAvailable: runtimeCapabilities.preview?.webglAvailable ?? false
      },
      encoding: {
        vaapi: runtimeCapabilities.encoding?.vaapi ?? false,
        openh264: runtimeCapabilities.encoding?.openh264 ?? false,
        x264: runtimeCapabilities.encoding?.x264 ?? false,
        qsv: runtimeCapabilities.encoding?.qsv ?? false
      }
    },
    selected: {
      capture: runtimeCapabilities.selected?.capture ?? null,
      audio: runtimeCapabilities.selected?.audio ?? null,
      preview: runtimeCapabilities.selected?.preview ?? null,
      recordingEncoder: runtimeCapabilities.selected?.recordingEncoder ?? null,
      streamingEncoder: runtimeCapabilities.selected?.streamingEncoder ?? null
    },
    policy: {
      fallbackPolicy: runtimeCapabilities.policy ?? 'unknown',
      requestedMode: runtimeCapabilities.requestedMode ?? 'automatic'
    },
    verification: {
      repo: artifactPath ? artifactPath.includes('linux') : false,
      notes: runtimeCapabilities.notes ?? ['No runtime probe output was attached at build time.']
    },
    git: {
      commit: (process.env.GITHUB_SHA || '').trim() || null,
      ref: (process.env.GITHUB_REF_NAME || '').trim() || null,
      runId: (process.env.GITHUB_RUN_ID || '').trim() || null
    },
    provenance: {
      script: 'scripts/build-linux-capabilities.mjs',
      workflow: (process.env.GITHUB_WORKFLOW || '').trim() || null
    },
    repository: {
      packageJsonVersion: runtimeCapabilities.repositoryVersion ?? null,
      rootVersion: runtimeCapabilities.rootVersion ?? null,
      appPackage: repoRoot ? `${repoRoot}/apps/desktop/package.json` : 'apps/desktop/package.json'
    }
  }
}

export async function readRuntimeCapabilities(path) {
  if (!path) {
    return null
  }
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}
