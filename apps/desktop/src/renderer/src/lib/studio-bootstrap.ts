export type StudioBootstrapDomain =
  | 'activeScreen'
  | 'compositor'
  | 'devices'
  | 'diagnostics'
  | 'liveChat'
  | 'platformAccounts'
  | 'previewCamera'
  | 'previewLive'
  | 'previewScreen'
  | 'previewSurface'
  | 'recording'
  | 'scene'
  | 'screenList'
  | 'sessions'
  | 'streamMetadata'

export type StudioBootstrapSnapshot = ReadonlyMap<StudioBootstrapDomain, number>

/**
 * Tracks live events that land while the initial request batch is in flight.
 * A request snapshot may only commit a domain whose event version is unchanged.
 */
export class StudioBootstrapGuard {
  private readonly versions = new Map<StudioBootstrapDomain, number>()

  mark(domain: StudioBootstrapDomain): void {
    this.versions.set(domain, (this.versions.get(domain) ?? 0) + 1)
  }

  snapshot(): StudioBootstrapSnapshot {
    return new Map(this.versions)
  }

  isCurrent(snapshot: StudioBootstrapSnapshot, domain: StudioBootstrapDomain): boolean {
    return (snapshot.get(domain) ?? 0) === (this.versions.get(domain) ?? 0)
  }
}

export async function loadValidatedPlatformAccountBootstrap<TAccount, TValidation, TCredential>(
  request: <TPayload>(method: string) => Promise<TPayload>
): Promise<{
  accounts: TAccount[]
  validations: TValidation[]
  credentials: TCredential[]
}> {
  // Validation persists refreshed statuses and emits platformAccounts.changed.
  // Fetch the rows afterwards so bootstrap cannot overwrite that event with a
  // pre-validation account snapshot.
  const validations = await request<TValidation[]>('platformAccounts.validate')
  const [accounts, credentials] = await Promise.all([
    request<TAccount[]>('platformAccounts.list'),
    request<TCredential[]>('platformAccounts.oauth.providerCredentials')
  ])
  return { accounts, validations, credentials }
}

interface IsolatedBootstrapClient {
  connect: () => Promise<void>
  request: <TPayload>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal }
  ) => Promise<TPayload>
  close: () => void
}

export async function loadValidatedPlatformAccountsOnIsolatedClient<
  TAccount,
  TValidation,
  TCredential
>(
  client: IsolatedBootstrapClient,
  signal?: AbortSignal
): Promise<{
  accounts: TAccount[]
  validations: TValidation[]
  credentials: TCredential[]
}> {
  await client.connect()
  try {
    // Provider validation can take tens of seconds. Keep it on a command-only
    // socket so telemetry and later UI commands never queue behind it.
    await client.request('events.setIncluded', { events: [] }, { signal })
    return await loadValidatedPlatformAccountBootstrap<TAccount, TValidation, TCredential>(
      <TPayload>(method: string) => client.request<TPayload>(method, undefined, { signal })
    )
  } finally {
    client.close()
  }
}
