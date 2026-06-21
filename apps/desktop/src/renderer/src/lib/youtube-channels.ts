import type { PlatformAccount, PlatformAccountValidation } from './backend'

export function shouldAutoRefreshYouTubeChannels(
  account: PlatformAccount | undefined,
  validations: PlatformAccountValidation[]
): boolean {
  if (!account || account.platform !== 'youtube' || account.status !== 'connected') {
    return false
  }

  return validations.some(
    (validation) =>
      validation.platform === 'youtube' &&
      validation.accountId === account.accountId &&
      (validation.state === 'valid' || validation.state === 'refreshed')
  )
}

export function isYouTubeChannelAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()

  return (
    normalized.includes('youtube channel list request failed') &&
    (normalized.includes('401 unauthorized') ||
      normalized.includes('invalid credentials') ||
      normalized.includes('autherror'))
  )
}
