// Send one smoke command to the app launched by scripts/ui-driver.mjs.
//
//   pnpm ui:cmd open-tab '{"tab":"settings"}'
//   pnpm ui:cmd eval-js '{"code":"return document.title"}'
//   pnpm ui:cmd capture-page '{"name":"settings-dark"}'
//
// Prints the JSON result to stdout; exits non-zero on command errors.

import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertSmokeCommandConnection } from './lib/smoke-command-client.mjs'

const connectionFile = join(tmpdir(), 'videorc-ui-driver-connection.json')

let conn
try {
  conn = JSON.parse(readFileSync(connectionFile, 'utf8'))
} catch {
  console.error(`No UI driver connection at ${connectionFile} — start "pnpm ui:driver" first.`)
  process.exit(2)
}

const command = process.argv[2]
if (!command) {
  console.error('Usage: pnpm ui:cmd <command> [json-params]')
  process.exit(2)
}
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {}
assertSmokeCommandConnection(conn.smoke)

const body = JSON.stringify({ command, params })
const result = await new Promise((resolvePromise, reject) => {
  const req = httpRequest(
    {
      hostname: conn.smoke.host,
      port: conn.smoke.port,
      path: '/command',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${conn.smoke.capability}`
      }
    },
    (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => {
        try {
          const payload = JSON.parse(text)
          if (res.statusCode !== 200) {
            reject(new Error(payload.error ?? `HTTP ${res.statusCode}`))
          } else {
            resolvePromise(payload)
          }
        } catch {
          reject(new Error(`Bad response (${res.statusCode}): ${text.slice(0, 400)}`))
        }
      })
    }
  )
  req.on('error', reject)
  req.setTimeout(Number(process.env.VIDEORC_UI_CMD_TIMEOUT_MS ?? 30000), () =>
    req.destroy(new Error('ui-cmd timeout'))
  )
  req.end(body)
}).catch((error) => {
  console.error(`ui-cmd ${command} failed: ${error.message}`)
  process.exit(1)
})

console.log(JSON.stringify(result, null, 2))
