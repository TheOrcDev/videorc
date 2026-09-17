// Generates resources/app-update.yml for the unsigned Windows pack.
//
// electron-builder writes this file from its onAfterPack hook, but only for
// targets it considers updatable — isSuitableWindowsTarget() in
// app-builder-lib/out/publish/PublishManager.js accepts nsis/nsis-* and
// updater-aware appx, nothing else. The unsigned pack runs
// `electron-builder --win dir`, so the hook returns early and the file is
// never written.
//
// The later protected build cannot fill the gap either: PlatformPackager.doPack
// returns immediately when `prepackaged` is set, so onAfterPack never fires
// there. The file therefore has to exist before the signing handoff — exactly
// what electron-builder.windows-unsigned.cjs already assumes, and what the
// staging manifest requires so the updater config is covered by the signed
// payload hash.
//
// We reproduce app-builder-lib's payload exactly: the resolved publish config
// spread first, then updaterCacheDirName. The publish block is read from the
// same config file electron-builder loads, so the two cannot drift.

import { createRequire } from 'node:module'
import { dump as serializeYaml } from 'js-yaml'

const UPDATER_CACHE_DIR_SUFFIX = '-updater'

// sanitize-filename (used by app-builder-lib's sanitizeFileName) strips control
// characters and the Windows-illegal set. For a scoped package name only "/" is
// affected, but keep the full set so a future rename cannot silently diverge.
// eslint-disable-next-line no-control-regex
const ILLEGAL_FILENAME_CHARACTERS = /[\u0000-\u001f\u0080-\u009f<>:"/\\|?*]/g

/**
 * Mirror of app-builder-lib's AppInfo.updaterCacheDirName:
 * sanitizeFileName(metadata.name).toLowerCase() + "-updater".
 *
 * electron-updater derives its on-disk cache directory from this value, so a
 * mismatch against a real electron-builder pack would move the cache. The unit
 * test pins the value against a genuine electron-builder artifact.
 */
export function updaterCacheDirNameFor(packageName) {
  if (typeof packageName !== 'string' || packageName.trim().length === 0) {
    throw new Error('updaterCacheDirNameFor requires the desktop package name')
  }
  const sanitized = packageName.replace(ILLEGAL_FILENAME_CHARACTERS, '')
  return `${sanitized.toLowerCase()}${UPDATER_CACHE_DIR_SUFFIX}`
}

/** The publish block electron-builder itself would resolve for this pack. */
export function readWindowsPublishConfig(configPath) {
  const require = createRequire(import.meta.url)
  const config = require(configPath)
  const publish = config?.publish
  if (!publish || typeof publish !== 'object' || Array.isArray(publish)) {
    throw new Error(`${configPath} must export a publish object`)
  }
  if (!Array.isArray(publish.publisherName) || publish.publisherName.length !== 1) {
    throw new Error(`${configPath} publish.publisherName must be exactly one name`)
  }
  return publish
}

/**
 * Serialize the app-update.yml payload. Key order follows app-builder-lib:
 * publish config first, updaterCacheDirName last.
 */
export function buildWindowsAppUpdateYaml({ publish, updaterCacheDirName }) {
  if (!publish || typeof publish !== 'object') {
    throw new Error('buildWindowsAppUpdateYaml requires the resolved publish config')
  }
  if (typeof updaterCacheDirName !== 'string' || updaterCacheDirName.length === 0) {
    throw new Error('buildWindowsAppUpdateYaml requires updaterCacheDirName')
  }
  return serializeYaml({ ...publish, updaterCacheDirName })
}
