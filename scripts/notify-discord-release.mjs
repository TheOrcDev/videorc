#!/usr/bin/env node
// Post a short release announcement to the Videorc Discord channel.
//
// Runs at the END of the release process (after that platform is publicly
// live) so followers see what the update brings. The message is intentionally
// SHORT: the release title + up to a few highlights from the changelog
// entry — the full notes live on the website.
//
//   node scripts/notify-discord-release.mjs [releaseId] [--dry-run]
//       [--platform macos|windows|linux]
//
// - releaseId defaults to the newest changelog entry (the one just shipped).
// - --dry-run prints the exact payload without posting.
// - --platform announces one OS from a shared changelog entry (typical for
//   a Windows+Linux Alpha file) and links that platform's download page.
//
// SECURITY: the webhook URL is a post-anywhere credential and this repo is
// public — it is NEVER hardcoded here. It is read from the env var
// VIDEORC_DISCORD_RELEASE_WEBHOOK, which lives in ~/.videorc-release.env
// (gitignored, already sourced by the release build). The script refuses to
// run without it and never echoes the URL.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { loadChangelogEntries } from './lib/changelog.mjs'

const WEBHOOK_ENV = 'VIDEORC_DISCORD_RELEASE_WEBHOOK'
const MAX_HIGHLIGHTS = 4
const DOWNLOAD_CHOOSER_URL = 'https://www.videorc.com/download'
const PLATFORM_LABELS = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux'
}
const ALPHA_DOWNLOAD_URLS = {
  windows: 'https://www.videorc.com/download/windows',
  linux: 'https://www.videorc.com/download/linux'
}
const ANNOUNCEABLE_PLATFORMS = Object.keys(PLATFORM_LABELS)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Strip inline markdown emphasis/links so a highlight reads clean in Discord. */
function stripInline(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()
}

export function parseNotifyArgs(argv) {
  let dryRun = false
  let platform
  const positionals = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--platform') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('Use --platform macos, --platform windows, or --platform linux.')
      }
      platform = value
      i += 1
      continue
    }
    if (arg.startsWith('--platform=')) {
      platform = arg.slice('--platform='.length).trim()
      continue
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}.`)
    }
    positionals.push(arg)
  }

  if (platform !== undefined && !ANNOUNCEABLE_PLATFORMS.includes(platform)) {
    throw new Error(`Unknown platform "${platform}". Use macos, windows, or linux.`)
  }
  if (positionals.length > 1) {
    throw new Error('Pass at most one releaseId.')
  }

  return { dryRun, platform, releaseId: positionals[0] }
}

/** Build the short Discord message from a changelog entry. */
export function buildDiscordReleaseMessage(entry, options = {}) {
  const listed = entry.platforms ?? ['macos']
  const platforms = resolveAnnouncementPlatforms(listed, options.platform, entry.version)
  const isAlpha = entry.channel === 'alpha'
  const version = isAlpha
    ? formatReleaseVersion(entry.version)
    : entry.version.replace(/-beta\.\d+$/, '')
  const audience = isAlpha ? ` for ${formatPlatforms(platforms)}` : ''
  const highlights = entry.highlights
    .slice(0, MAX_HIGHLIGHTS)
    .map((item) => `• ${stripInline(item)}`)
  const lines = [`🚀 **Videorc ${version}${audience} — ${entry.title}**`, '', ...highlights]
  if (entry.highlights.length > MAX_HIGHLIGHTS) {
    lines.push('', '…and more.')
  }
  lines.push('', announcementFooter({ isAlpha, platforms }))
  return lines.join('\n')
}

function resolveAnnouncementPlatforms(listed, requested, version) {
  if (!requested) return listed
  if (!listed.includes(requested)) {
    throw new Error(`Changelog entry ${version} does not include platform ${requested}.`)
  }
  return [requested]
}

function announcementFooter({ isAlpha, platforms }) {
  if (!isAlpha) {
    return 'Update from Settings → About, or it applies on next launch.'
  }
  if (platforms.length === 1 && ALPHA_DOWNLOAD_URLS[platforms[0]]) {
    return `Download the ${PLATFORM_LABELS[platforms[0]]} Alpha: ${ALPHA_DOWNLOAD_URLS[platforms[0]]}`
  }
  return `Choose your Alpha download: ${DOWNLOAD_CHOOSER_URL}`
}

function formatPlatforms(platforms) {
  return platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform).join(' and ')
}

function formatReleaseVersion(version) {
  const [core, preRelease] = version.split('-')
  if (!preRelease) return core
  const [tag, number] = preRelease.split('.')
  const capitalized = tag.charAt(0).toUpperCase() + tag.slice(1)
  return number ? `${core} ${capitalized} ${number}` : `${core} ${capitalized}`
}

async function main() {
  const { releaseControllerEnabled } = await import('./lib/release-coordinator.mjs')
  if (await releaseControllerEnabled())
    throw new Error(
      'Controller enabled: use release:announce with the exact --request and --platform for durable notification identity.'
    )

  const { dryRun, platform, releaseId } = parseNotifyArgs(process.argv.slice(2))

  const entries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  const entry = releaseId
    ? entries.find((candidate) => candidate.version === releaseId)
    : entries[0]
  if (!entry) {
    console.error(`No changelog entry found${releaseId ? ` for ${releaseId}` : ''}.`)
    process.exit(1)
  }

  const content = buildDiscordReleaseMessage(entry, { platform })

  if (dryRun) {
    console.log('--- Discord release message (dry run, not posted) ---')
    console.log(content)
    return
  }

  const webhook = process.env[WEBHOOK_ENV]?.trim()
  if (!webhook) {
    console.error(
      `${WEBHOOK_ENV} is not set. Add it to ~/.videorc-release.env (never commit it) and source that file, or pass --dry-run.`
    )
    process.exit(1)
  }

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // flags:4 = SUPPRESS_EMBEDS — keep it a plain text post, no link unfurls.
    body: JSON.stringify({ content, flags: 4, allowed_mentions: { parse: [] } })
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    // Never surface the webhook URL in the error.
    console.error(
      `Discord webhook POST failed: ${response.status} ${response.statusText} ${detail}`
    )
    process.exit(1)
  }

  console.log(`Posted ${entry.version} release announcement to Discord.`)
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
