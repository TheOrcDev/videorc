'use strict'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required Windows signing environment variable: ${name}`)
  }
  return value
}

function trustedSigningEndpoint() {
  const value = required('VIDEORC_WINDOWS_SIGNING_ENDPOINT')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('VIDEORC_WINDOWS_SIGNING_ENDPOINT must be a valid HTTPS URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-z0-9-]+\.codesigning\.azure\.net$/i.test(url.hostname)
  ) {
    throw new Error(
      'VIDEORC_WINDOWS_SIGNING_ENDPOINT must be a credential-free regional *.codesigning.azure.net HTTPS URL'
    )
  }
  return value
}

module.exports = {
  extends: './electron-builder.yml',
  // A release command must never quietly emit an unsigned installer.
  forceCodeSigning: true,
  win: {
    signAndEditExecutable: true,
    verifyUpdateCodeSignature: true,
    azureSignOptions: {
      ExcludeAzureDeveloperCliCredential: 'true',
      ExcludeAzurePowerShellCredential: 'true',
      ExcludeEnvironmentCredential: 'true',
      ExcludeInteractiveBrowserCredential: 'true',
      ExcludeManagedIdentityCredential: 'true',
      ExcludeSharedTokenCacheCredential: 'true',
      ExcludeVisualStudioCodeCredential: 'true',
      ExcludeVisualStudioCredential: 'true',
      ExcludeWorkloadIdentityCredential: 'true',
      endpoint: trustedSigningEndpoint(),
      codeSigningAccountName: required('VIDEORC_WINDOWS_SIGNING_ACCOUNT_NAME'),
      certificateProfileName: required('VIDEORC_WINDOWS_CERTIFICATE_PROFILE_NAME'),
      publisherName: required('VIDEORC_WINDOWS_PUBLISHER_NAME'),
      fileDigest: 'SHA256',
      timestampDigest: 'SHA256',
      timestampRfc3161: 'http://timestamp.acs.microsoft.com'
    }
  }
}
