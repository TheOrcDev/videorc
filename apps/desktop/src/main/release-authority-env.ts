const RELEASE_AUTHORITY_ENV =
  /^(?:AZURE_|APPLE_|CSC_|WIN_CSC_|VIDEORC_(?:DOWNLOAD|RELEASE_UPLOAD)_S3_|VIDEORC_WINDOWS_(?:SIGNING_|PILOT_UPDATE_TOKEN$))/

export function sanitizedChildProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env }
  scrubReleaseAuthorityEnvironment(sanitized)
  return sanitized
}

export function scrubReleaseAuthorityEnvironment(
  env: NodeJS.ProcessEnv,
  { preservePilotToken = false }: { preservePilotToken?: boolean } = {}
): void {
  for (const name of Object.keys(env)) {
    if (
      RELEASE_AUTHORITY_ENV.test(name) &&
      !(preservePilotToken && name === 'VIDEORC_WINDOWS_PILOT_UPDATE_TOKEN')
    ) {
      delete env[name]
    }
  }
}
