#!/usr/bin/env node
// Post a short release announcement to the Videorc Discord channel.
//
// Runs at the END of the release process (after the feed is verified) so
// followers see what the update brings. The message is intentionally SHORT:
// the release title + up to a few highlights from the changelog entry — the
// full notes live on the website.
//
//   node scripts/notify-discord-release.mjs [releaseId] [--dry-run]
//
// - releaseId defaults to the newest changelog entry (the one just shipped).
// - --dry-run prints the exact payload without posting.
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
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Strip inline markdown emphasis/links so a highlight reads clean in Discord. */
function stripInline(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()
}

/** Build the short Discord message from a changelog entry. */
export function buildDiscordReleaseMessage(entry) {
  const version = entry.version.replace(/-beta\.\d+$/, '')
  const highlights = entry.highlights
    .slice(0, MAX_HIGHLIGHTS)
    .map((item) => `• ${stripInline(item)}`)
  const lines = [`🚀 **Videorc ${version} — ${entry.title}**`, '', ...highlights]
  if (entry.highlights.length > MAX_HIGHLIGHTS) {
    lines.push('', '…and more.')
  }
  lines.push('', 'Update from Settings → About, or it applies on next launch.')
  return lines.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const releaseId = argv.find((arg) => !arg.startsWith('--'))

  const entries = await loadChangelogEntries(join(repoRoot, 'changelog'))
  const entry = releaseId
    ? entries.find((candidate) => candidate.version === releaseId)
    : entries[0]
  if (!entry) {
    console.error(`No changelog entry found${releaseId ? ` for ${releaseId}` : ''}.`)
    process.exit(1)
  }

  const content = buildDiscordReleaseMessage(entry)

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
