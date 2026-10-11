#!/usr/bin/env node

// Plan 176 L0: is the live lab ready to go live? Prints PASS / WARN / FAIL /
// SKIP per check and exits non-zero on any FAIL. Spends 2 lab quota units
// (one channels.list per role), charged to the lab quota ledger (plan 178
// U8). Never prints more than the last 4 characters of a secret.

import { execFile } from 'node:child_process'
import { connect } from 'node:tls'
import { promisify } from 'node:util'

import { ROLES, configPath, inspectPermissions, labDir, readConfig, redact } from './lib/config.mjs'
import {
  FAIL,
  PASS,
  SKIP,
  check,
  evaluateBlackHole,
  evaluateChannelIdentity,
  evaluateClient,
  evaluateLabDisplay,
  evaluatePermissions,
  evaluateQuota,
  evaluateStreamKeys,
  evaluateTokenAge,
  evaluateTool,
  formatResult,
  summarize
} from './lib/doctor-checks.mjs'
import { fetchMyChannel, refreshAccessToken } from './lib/oauth.mjs'
import { createQuotaLedger } from './lib/quota-ledger.mjs'

const execFileAsync = promisify(execFile)
const RTMPS_HOST = 'a.rtmps.youtube.com'

async function run(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024
    })
    return stdout || stderr
  } catch {
    return ''
  }
}

async function profiler(type) {
  const output = await run('system_profiler', ['-json', type])
  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

function reachable(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const protocol = socket.getProtocol()
      socket.end()
      resolve({ ok: true, detail: `${host}:${port} TLS ok (${protocol})` })
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve({ ok: false, detail: `${host}:${port} timed out after ${timeoutMs / 1000} s` })
    })
    socket.on('error', (error) =>
      resolve({ ok: false, detail: `${host}:${port} ${error.code ?? error.message}` })
    )
  })
}

async function roleChecks(role, config, broadcasterChannelId, ledger) {
  const entry = config?.roles?.[role]
  if (!entry?.refreshToken) {
    return {
      results: [
        check(`${role} channel`, FAIL, `Not authorized. Run pnpm live:hookup --role ${role}.`)
      ],
      channelId: null
    }
  }
  const results = [evaluateTokenAge(role, entry.authorizedAt)]
  if (!config.client) {
    results.unshift(check(`${role} channel`, FAIL, 'No OAuth client stored.'))
    return { results, channelId: null }
  }
  let accessToken
  try {
    ledger.charge('channels.list')
    accessToken = await refreshAccessToken({
      clientId: config.client.id,
      clientSecret: config.client.secret,
      refreshToken: entry.refreshToken
    })
    const channel = await fetchMyChannel({ accessToken })
    results.unshift(
      evaluateChannelIdentity(role, channel, {
        expectedHandle: config.channel?.handle,
        broadcasterChannelId
      })
    )
    return { results, channelId: channel.channelId }
  } catch (error) {
    const hint =
      error.code === 'invalid_grant'
        ? ` The refresh token is expired or revoked. Run pnpm live:hookup --role ${role}.`
        : ''
    results.unshift(
      check(`${role} channel`, FAIL, `${redact(error.message, config, [accessToken])}${hint}`)
    )
    return { results, channelId: null }
  }
}

async function main() {
  const dir = labDir()
  const results = []
  results.push(evaluatePermissions(await inspectPermissions(dir), configPath(dir)))

  let config = null
  try {
    config = await readConfig(dir)
  } catch (error) {
    results.push(check('config', FAIL, error.message))
  }

  results.push(evaluateClient(config))
  results.push(...evaluateStreamKeys(config))

  const ledger = createQuotaLedger({ dir })
  let broadcasterChannelId = null
  for (const role of ROLES) {
    const outcome = await roleChecks(role, config, broadcasterChannelId, ledger)
    if (role === 'broadcaster') broadcasterChannelId = outcome.channelId
    results.push(...outcome.results)
  }

  const [displays, audio, ytDlp, ffmpeg, rtmps] = await Promise.all([
    profiler('SPDisplaysDataType'),
    profiler('SPAudioDataType'),
    run('yt-dlp', ['--version']),
    run('ffmpeg', ['-hide_banner', '-version']),
    reachable(RTMPS_HOST, 443)
  ])
  results.push(evaluateLabDisplay(displays, config?.labDisplay?.name))
  results.push(evaluateBlackHole(audio))
  results.push(evaluateTool('yt-dlp', ytDlp && `yt-dlp ${ytDlp}`, 'brew install yt-dlp'))
  results.push(evaluateTool('ffmpeg', ffmpeg, 'brew install ffmpeg'))
  results.push(check('rtmps ingest', rtmps.ok ? PASS : FAIL, rtmps.detail))

  try {
    results.push(evaluateQuota(ledger.today()))
  } catch (error) {
    results.push(evaluateQuota(null, error))
  }
  results.push(
    check(
      'build under test',
      SKIP,
      'Version + TCC test recording arrive with the harness launch (plan 176 L2).'
    )
  )
  results.push(
    check('network fault rules', SKIP, 'Fault injection arrives with suite E (plan 176 L5).')
  )

  for (const result of results) {
    console.log(formatResult({ ...result, detail: redact(result.detail, config) }))
  }
  const { counts, ok } = summarize(results)
  console.log(
    `\n${ok ? 'Lab ready' : 'Lab NOT ready'}: ${counts.PASS} pass, ${counts.WARN} warn, ${counts.FAIL} fail, ${counts.SKIP} skip.`
  )
  if (!ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(`live:doctor failed: ${error.message}`)
  process.exitCode = 1
})
