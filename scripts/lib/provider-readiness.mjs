export const REQUIRED_OAUTH_CALLBACK_URLS = [
  'http://127.0.0.1:17995/oauth/callback',
  'http://127.0.0.1:27995/oauth/callback',
  'http://127.0.0.1:37995/oauth/callback',
  // Twitch's console rejects every non-HTTPS redirect except the literal
  // http://localhost form — the backend sends these for Twitch; register
  // them in the Twitch app (the 127.0.0.1 forms are for X/Google).
  'http://localhost:17995/oauth/callback',
  'http://localhost:27995/oauth/callback',
  'http://localhost:37995/oauth/callback'
]

export const PROVIDER_CALLBACKS_READY_ENV = 'VIDEORC_SMOKE_PROVIDER_CALLBACKS_READY'
export const YOUTUBE_OAUTH_PAUSED_REASON =
  'YouTube OAuth is paused while Videorc awaits Google approval; use Manual RTMP for YouTube acceptance.'

export const PROVIDERS = [
  {
    label: 'YouTube',
    paused: true,
    pauseReason: YOUTUBE_OAUTH_PAUSED_REASON,
    enableVars: ['VIDEORC_ENABLE_YOUTUBE_OAUTH', 'VIDEORC_BUNDLED_YOUTUBE_OAUTH_ENABLED'],
    clientIdVars: ['VIDEORC_YOUTUBE_CLIENT_ID', 'VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID'],
    secretVars: ['VIDEORC_YOUTUBE_CLIENT_SECRET'],
    secretRequired: false,
    accountChecks: [
      {
        label: 'verified Live-enabled channel available',
        env: 'VIDEORC_SMOKE_YOUTUBE_CHANNEL_READY'
      }
    ]
  },
  {
    label: 'Twitch',
    clientIdVars: ['VIDEORC_TWITCH_CLIENT_ID', 'VIDEORC_BUNDLED_TWITCH_CLIENT_ID'],
    secretVars: ['VIDEORC_TWITCH_CLIENT_SECRET'],
    // Public client type: the id alone connects; a secret only upgrades
    // confidential setups.
    secretRequired: false,
    accountChecks: [
      {
        label: 'test broadcaster account available',
        env: 'VIDEORC_SMOKE_TWITCH_ACCOUNT_READY'
      }
    ]
  },
  {
    label: 'X',
    clientIdVars: ['VIDEORC_X_CLIENT_ID', 'VIDEORC_BUNDLED_X_CLIENT_ID'],
    secretVars: ['VIDEORC_X_CLIENT_SECRET'],
    secretRequired: false,
    accountChecks: [
      {
        label: 'OAuth 1.0a Livestream credentials configured',
        env: 'VIDEORC_SMOKE_X_LIVESTREAM_OAUTH1_READY',
        statusLabel: 'X OAuth 1.0a live credentials'
      },
      {
        label: 'allow-listed Livestream API access validated',
        env: 'VIDEORC_SMOKE_X_NATIVE_LIVE_ACCESS',
        statusLabel: 'X native live access'
      }
    ]
  }
]

export function evaluateProviderReadiness({
  env = {},
  strict = false,
  generatedAt = new Date().toISOString(),
  commit = 'unknown',
  runContext = detectRunContext(env)
} = {}) {
  const callbackCoverage = evaluateCallbackCoverage(env)
  const providers = PROVIDERS.map((provider) =>
    readinessForProvider(provider, env, callbackCoverage)
  )
  const failures = providers.filter((provider) => !provider.ready)

  return {
    generatedAt,
    commit,
    strict,
    runContext,
    callbackCoverage,
    providers,
    failures,
    ready: failures.length === 0
  }
}

export function formatProviderReadinessConsole(result) {
  const lines = []
  for (const provider of result.providers) {
    lines.push(
      `[${provider.paused ? 'paused' : provider.ready ? 'ready' : 'missing'}] ${provider.label}`
    )
    if (provider.paused) {
      lines.push(`  - ${provider.pauseReason}`)
      continue
    }
    lines.push(`  - run context: ${result.runContext}`)
    lines.push(`  - client ID: ${credentialSourceLabel(provider.clientId)}`)
    lines.push(`  - client secret: ${secretSourceLabel(provider.clientSecret)}`)
    lines.push(
      `  - callback URLs: ${result.callbackCoverage.ready ? 'confirmed' : `missing ${PROVIDER_CALLBACKS_READY_ENV}=1`}`
    )

    for (const check of provider.accountChecks) {
      lines.push(`  - ${check.env}: ${check.ready ? 'ready' : `missing (${check.label})`}`)
    }

    if (!provider.ready) {
      for (const item of provider.missing) {
        lines.push(`    missing: ${item}`)
      }
    }
  }

  const readyLabels = result.providers
    .filter((provider) => provider.ready && !provider.paused)
    .map((provider) => provider.label)
  if (readyLabels.length) {
    lines.push('')
    lines.push(`Ready providers: ${readyLabels.join(', ')}`)
  }
  const pausedLabels = result.providers
    .filter((provider) => provider.paused)
    .map((provider) => provider.label)
  if (pausedLabels.length) {
    lines.push('')
    lines.push(`Paused providers: ${pausedLabels.join(', ')}`)
  }

  if (result.failures.length) {
    lines.push('')
    lines.push('Provider live-smoke readiness is incomplete:')
    for (const failure of result.failures) {
      lines.push(`- ${failure.label}: missing ${failure.missing.join('; ')}`)
    }
    if (!result.strict) {
      lines.push('')
      lines.push(
        'Set VIDEORC_SMOKE_REQUIRE_PROVIDER_READY=1 to make missing provider prerequisites fail.'
      )
    }
  } else {
    lines.push('')
    lines.push('Provider live-smoke readiness OK.')
  }

  return lines.join('\n')
}

export function formatProviderReadinessMarkdown(result) {
  const lines = [
    `# Provider Live-Smoke Readiness - ${result.generatedAt}`,
    '',
    `- Commit: ${result.commit}`,
    `- Strict mode: ${result.strict ? 'yes' : 'no'}`,
    `- Run context: ${result.runContext}`,
    `- Overall: ${result.ready ? 'ready' : 'incomplete'}`,
    '- Secret values: redacted; this report only records presence, source type, and missing prerequisites.',
    '',
    '## OAuth Callback Coverage',
    '',
    `- Confirmation flag: ${PROVIDER_CALLBACKS_READY_ENV}=${result.callbackCoverage.ready ? '1' : 'missing'}`,
    '- Required callback URLs:',
    ...result.callbackCoverage.urls.map((url) => `  - ${url}`),
    '',
    '## Provider Matrix',
    '',
    '| Provider | Status | Client ID source | Client ID env vars | Client secret | Account readiness | Callback coverage | Missing prerequisites |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ]

  for (const provider of result.providers) {
    lines.push(
      `| ${escapeMarkdown(provider.label)} | ${provider.paused ? 'paused' : provider.ready ? 'ready' : 'missing'} | ${escapeMarkdown(
        provider.clientId.source
      )} | ${escapeMarkdown(provider.clientId.envVars.join(', '))} | ${escapeMarkdown(
        secretSourceLabel(provider.clientSecret)
      )} | ${escapeMarkdown(accountChecksLabel(provider.accountChecks))} | ${
        result.callbackCoverage.ready ? 'confirmed' : 'missing'
      } | ${provider.missing.length ? escapeMarkdown(provider.missing.join('; ')) : 'none'} |`
    )
  }

  lines.push('')

  const paused = result.providers.filter((provider) => provider.paused)
  if (paused.length) {
    lines.push('## Paused Provider Paths')
    lines.push('')
    for (const provider of paused) {
      lines.push(`- ${provider.label}: ${provider.pauseReason}`)
    }
    lines.push('')
  }

  const x = result.providers.find((provider) => provider.label === 'X')
  if (x) {
    const nativeLive = x.accountChecks.find((check) => check.statusLabel === 'X native live access')
    lines.push('## X Native Live Access')
    lines.push('')
    lines.push(
      `- Status: ${
        nativeLive?.ready
          ? 'ready - allow-listed source and broadcast path validated'
          : `blocked - set ${nativeLive?.env ?? 'VIDEORC_SMOKE_X_NATIVE_LIVE_ACCESS'}=1 only after live API validation`
      }`
    )
    const oauth1 = x.accountChecks.find(
      (check) => check.statusLabel === 'X OAuth 1.0a live credentials'
    )
    lines.push(
      `- OAuth 1.0a credentials: ${
        oauth1?.ready
          ? 'ready - backend live credential set configured'
          : `missing - set ${oauth1?.env ?? 'VIDEORC_SMOKE_X_LIVESTREAM_OAUTH1_READY'}=1 only after the bundled consumer pair is baked (or VIDEORC_X_OAUTH1_* env values are configured) and Authorize X Live minted a user token`
      }`
    )
    lines.push('')
  }

  if (result.failures.length) {
    lines.push('## Remaining External Prerequisites')
    lines.push('')
    for (const failure of result.failures) {
      lines.push(`- ${failure.label}: ${failure.missing.join('; ')}`)
    }
    lines.push('')
  }

  lines.push('## Next Acceptance Step')
  lines.push('')
  if (result.failures.length) {
    lines.push(
      '- Set the missing provider credentials/account flags above, then rerun `pnpm smoke:provider-readiness:strict`.'
    )
  } else {
    lines.push(
      '- Run the real Twitch and X OAuth/live acceptance steps from `docs/oauth-live-smoke.md`; use Manual RTMP for YouTube until Google approval completes.'
    )
  }

  return lines.join('\n')
}

export function detectRunContext(env = {}) {
  const explicit = stringValue(env.VIDEORC_PROVIDER_READINESS_RUN_CONTEXT)
  if (explicit) {
    return explicit
  }
  if (stringValue(env.VIDEORC_PACKAGED_APP_EXECUTABLE) || env.VIDEORC_SMOKE_PACKAGED_APP === '1') {
    return 'packaged'
  }
  return 'dev'
}

function readinessForProvider(provider, env, callbackCoverage) {
  const explicitlyEnabled = provider.enableVars?.some((name) => env[name] === '1') ?? false
  if (provider.paused && !explicitlyEnabled) {
    return {
      label: provider.label,
      ready: true,
      paused: true,
      pauseReason: provider.pauseReason,
      clientId: {
        source: 'paused',
        envVar: null,
        envVars: provider.clientIdVars
      },
      clientSecret: {
        source: 'paused',
        required: false,
        envVar: null,
        envVars: provider.secretVars
      },
      accountChecks: [],
      missing: []
    }
  }
  const clientId = credentialPresence(provider.clientIdVars, env)
  const clientSecret = secretPresence(provider.secretVars, env, provider.secretRequired)
  const accountChecks = provider.accountChecks.map((check) => ({
    ...check,
    ready: env[check.env] === '1'
  }))
  const missing = []

  if (clientId.source === 'missing') {
    missing.push(`one of ${provider.clientIdVars.join(', ')}`)
  }
  if (clientSecret.required && clientSecret.source === 'missing') {
    missing.push(provider.secretVars.join(' or '))
  }
  if (!callbackCoverage.ready) {
    missing.push(
      `${PROVIDER_CALLBACKS_READY_ENV}=1 (fixed loopback callback URLs registered/verified)`
    )
  }
  for (const check of accountChecks) {
    if (!check.ready) {
      missing.push(`${check.env}=1 (${check.label})`)
    }
  }

  return {
    label: provider.label,
    ready: missing.length === 0,
    paused: false,
    pauseReason: null,
    clientId,
    clientSecret,
    accountChecks,
    missing
  }
}

function evaluateCallbackCoverage(env) {
  return {
    ready: env[PROVIDER_CALLBACKS_READY_ENV] === '1',
    env: PROVIDER_CALLBACKS_READY_ENV,
    urls: REQUIRED_OAUTH_CALLBACK_URLS
  }
}

function credentialPresence(names, env) {
  const present = names.find((name) => stringValue(env[name]))
  if (!present) {
    return {
      source: 'missing',
      envVar: null,
      envVars: names
    }
  }
  return {
    source: present.includes('_BUNDLED_') ? 'bundled' : 'environment',
    envVar: present,
    envVars: names
  }
}

function secretPresence(names, env, required) {
  const present = names.find((name) => stringValue(env[name]))
  if (present) {
    return {
      source: 'environment',
      required,
      envVar: present,
      envVars: names
    }
  }
  return {
    source: required ? 'missing' : 'optional',
    required,
    envVar: null,
    envVars: names
  }
}

function credentialSourceLabel(credential) {
  if (credential.source === 'paused') {
    return 'paused'
  }
  if (credential.source === 'missing') {
    return `missing (expected ${credential.envVars.join(' or ')})`
  }
  return `${credential.source} (${credential.envVar})`
}

function secretSourceLabel(secret) {
  if (secret.source === 'paused') {
    return 'paused'
  }
  if (secret.source === 'environment') {
    return `present (${secret.envVar})`
  }
  return secret.required ? `missing (${secret.envVars.join(' or ')})` : 'optional'
}

function accountChecksLabel(checks) {
  if (!checks.length) {
    return 'none'
  }
  return checks.map((check) => `${check.env}=${check.ready ? '1' : 'missing'}`).join('; ')
}

function stringValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
}

function escapeMarkdown(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}
