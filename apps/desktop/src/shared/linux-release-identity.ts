export interface LinuxReleaseIdentity {
  platform: 'linux'
  channel: 'alpha' | 'beta'
  releaseId: string
  bundleVersion: string
  sourceCommit: string | null
}

/** Build-time identity. Runtime environment variables cannot relabel a package. */
export function linuxReleaseIdentityForBuild({
  platform,
  packageVersion,
  releaseId,
  sourceCommit
}: {
  platform: string
  packageVersion: string
  releaseId?: string
  sourceCommit?: string
}): LinuxReleaseIdentity | null {
  if (platform !== 'linux') return null
  const id = releaseId?.trim() || `${packageVersion}-alpha.1`
  const match = /^(\d+\.\d+\.\d+)-(alpha|beta)\.([1-9]\d*)$/.exec(id)
  if (!match || match[1] !== packageVersion || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error('Linux release ID must match the package version and use alpha.N or beta.N.')
  }
  const source = sourceCommit?.trim() || null
  if ((source !== null && !/^[a-f0-9]{40}$/.test(source)) || (match[2] === 'beta' && !source)) {
    throw new Error('Linux Beta builds require an exact source commit.')
  }
  return {
    platform: 'linux',
    channel: match[2] as 'alpha' | 'beta',
    releaseId: id,
    bundleVersion: packageVersion,
    sourceCommit: source
  }
}
