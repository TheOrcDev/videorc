'use strict'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required Windows unsigned staging environment variable: ${name}`)
  }
  return value
}

module.exports = {
  extends: './electron-builder.yml',
  forceCodeSigning: false,
  // app-update.yml is created during this unsigned pack. A later
  // --prepackaged build does not recreate it, so bind update verification to
  // the release publisher before the protected signing handoff.
  publish: {
    provider: 'generic',
    publisherName: [required('VIDEORC_WINDOWS_PUBLISHER_NAME')],
    url: 'https://www.videorc.com/api/updates/'
  },
  win: {
    // Resource-edit the application before the handoff, but do not attach a
    // signature. The protected job signs this exact prepackaged directory.
    azureSignOptions: null,
    signAndEditExecutable: true,
    signtoolOptions: null,
    verifyUpdateCodeSignature: true
  }
}
