import { execFileSync } from 'node:child_process'

const strict = process.env.VIDEORC_SMOKE_REQUIRE_PROVIDER_READY === '1'
const markdown = process.argv.includes('--markdown')
const timestamp = new Date().toISOString()

const providers = [
  {
    label: 'YouTube',
    clientIdVars: ['VIDEORC_YOUTUBE_CLIENT_ID', 'VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID'],
    secretVars: ['VIDEORC_YOUTUBE_CLIENT_SECRET'],
    secretRequired: false,
    extraChecks: [
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
    secretRequired: true,
    extraChecks: [
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
    extraChecks: [
      {
        label: 'native live partner/API access available',
        env: 'VIDEORC_SMOKE_X_NATIVE_LIVE_ACCESS'
      }
    ]
  }
]

const results = providers.map((provider) => readiness(provider))
const failures = results.filter((result) => !result.ready)
const readyLabels = results.filter((result) => result.ready).map((result) => result.label)

if (markdown) {
  printMarkdown(results, failures)
} else {
  printConsole(results, failures, readyLabels)
}

if (failures.length && strict) {
  process.exitCode = 1
}

function readiness(provider) {
  const clientId = firstPresent(provider.clientIdVars)
  const secret = firstPresent(provider.secretVars)
  const missing = []

  if (!clientId) {
    missing.push(`one of ${provider.clientIdVars.join(', ')}`)
  }
  if (provider.secretRequired && !secret) {
    missing.push(provider.secretVars.join(' or '))
  }
  for (const check of provider.extraChecks) {
    if (process.env[check.env] !== '1') {
      missing.push(`${check.env}=1 (${check.label})`)
    }
  }

  return {
    label: provider.label,
    ready: missing.length === 0,
    clientIdPresent: Boolean(clientId),
    clientIdSource: clientId ?? null,
    clientSecretPresent: Boolean(secret),
    clientSecretRequired: provider.secretRequired,
    missing
  }
}

function printConsole(results, failures, readyLabels) {
  for (const result of results) {
    if (result.ready) {
      console.log(`[ready] ${result.label}`)
      continue
    }

    console.log(`[missing] ${result.label}`)
    for (const item of result.missing) {
      console.log(`  - ${item}`)
    }
  }

  if (readyLabels.length) {
    console.log('')
    console.log(`Ready providers: ${readyLabels.join(', ')}`)
  }

  if (failures.length) {
    console.log('')
    console.log('Provider live-smoke readiness is incomplete:')
    for (const failure of failures) {
      console.log(`- ${failure.label}: missing ${failure.missing.join('; ')}`)
    }
    if (!strict) {
      console.log('')
      console.log('Set VIDEORC_SMOKE_REQUIRE_PROVIDER_READY=1 to make missing provider prerequisites fail.')
    }
  } else {
    console.log('')
    console.log('Provider live-smoke readiness OK.')
  }
}

function printMarkdown(results, failures) {
  console.log(`# Provider Live-Smoke Readiness - ${timestamp}`)
  console.log('')
  console.log(`- Commit: ${commitSha()}`)
  console.log(`- Strict mode: ${strict ? 'yes' : 'no'}`)
  console.log(`- Overall: ${failures.length ? 'incomplete' : 'ready'}`)
  console.log('- Secret values: redacted; this report only records presence or missing prerequisites.')
  console.log('')
  console.log('| Provider | Status | Client ID | Client secret | Missing prerequisites |')
  console.log('| --- | --- | --- | --- | --- |')
  for (const result of results) {
    console.log(
      `| ${escapeMarkdown(result.label)} | ${result.ready ? 'ready' : 'missing'} | ${clientIdLabel(
        result
      )} | ${secretLabel(result)} | ${result.missing.length ? escapeMarkdown(result.missing.join('; ')) : 'none'} |`
    )
  }
  console.log('')

  if (failures.length) {
    console.log('## Remaining External Prerequisites')
    console.log('')
    for (const failure of failures) {
      console.log(`- ${failure.label}: ${failure.missing.join('; ')}`)
    }
    console.log('')
  }

  console.log('## Next Acceptance Step')
  console.log('')
  if (failures.length) {
    console.log('- Set the missing provider credentials/account flags above, then rerun `pnpm smoke:provider-readiness:strict`.')
  } else {
    console.log('- Run the real YouTube, Twitch, and X OAuth/live acceptance steps from `docs/oauth-live-smoke.md`.')
  }
}

function firstPresent(names) {
  return names.find((name) => typeof process.env[name] === 'string' && process.env[name].trim().length > 0)
}

function clientIdLabel(result) {
  return result.clientIdPresent ? `present (${escapeMarkdown(result.clientIdSource)})` : 'missing'
}

function secretLabel(result) {
  if (result.clientSecretPresent) {
    return 'present'
  }
  return result.clientSecretRequired ? 'missing' : 'optional'
}

function escapeMarkdown(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function commitSha() {
  if (process.env.GITHUB_SHA?.trim()) {
    return process.env.GITHUB_SHA.trim()
  }
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}
