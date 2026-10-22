// Plan 178 U10. A short Discord ping when a lab run has a P0 incident, in the
// pattern of scripts/notify-discord-release.mjs: plain text, embeds
// suppressed, no mentions. The webhook URL is a post-anywhere credential:
// it lives only in the lab config (`pnpm live:hookup --discord-webhook`,
// 0600) or the VIDEORC_LIVE_LAB_DISCORD_WEBHOOK environment variable, and is
// never printed.

export const DISCORD_WEBHOOK_ENV = 'VIDEORC_LIVE_LAB_DISCORD_WEBHOOK'
const WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/
const MAX_INCIDENTS = 5

/** Validates a Discord webhook URL; returns it trimmed or throws (without echoing it). */
export function validateWebhookUrl(value) {
  const text = String(value ?? '').trim()
  if (!WEBHOOK_RE.test(text)) {
    throw new Error(
      'That is not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>).'
    )
  }
  return text
}

/** The webhook from the lab config, else the environment, else null. */
export function webhookUrlFrom(config, env = process.env) {
  const candidates = [config?.discord?.webhookUrl, env[DISCORD_WEBHOOK_ENV]]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return validateWebhookUrl(value)
  }
  return null
}

/** Pure: the P0 incidents of a verdict (schema 1). */
export function p0Incidents(verdict) {
  return (Array.isArray(verdict?.incidents) ? verdict.incidents : []).filter(
    (incident) => incident?.severity === 'P0'
  )
}

/** Pure: the Discord message for a run with P0 incidents, or null when there are none. */
export function buildP0Message(verdict, { reportUrl, issueLinks = new Map() } = {}) {
  const incidents = p0Incidents(verdict)
  if (incidents.length === 0) return null
  const build = verdict.build
    ? `${verdict.build.source ?? '?'} ${verdict.build.version ?? ''}`.trim()
    : 'unknown build'
  const lines = [
    `🚨 **Live lab P0** in \`${verdict.scenario}\` (${verdict.trigger ?? 'run'}, ${build}): ${verdict.outcome ?? 'unknown'}`
  ]
  for (const incident of incidents.slice(0, MAX_INCIDENTS)) {
    const issue = issueLinks.get(incident.signature)
    lines.push(
      `• \`${incident.signature}\`: ${String(incident.summary ?? '').slice(0, 200)}${issue ? ` (${issue})` : ''}`
    )
  }
  if (incidents.length > MAX_INCIDENTS) lines.push(`…and ${incidents.length - MAX_INCIDENTS} more.`)
  if (reportUrl) lines.push(`Report: ${reportUrl}`)
  return lines.join('\n')
}

/** Posts `content` to the webhook. Throws with the HTTP status only. */
export async function postDiscord({ webhookUrl, content, fetchImpl = fetch }) {
  const response = await fetchImpl(validateWebhookUrl(webhookUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // flags:4 = SUPPRESS_EMBEDS, as in notify-discord-release.mjs.
    body: JSON.stringify({ content, flags: 4, allowed_mentions: { parse: [] } })
  })
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}`)
}
