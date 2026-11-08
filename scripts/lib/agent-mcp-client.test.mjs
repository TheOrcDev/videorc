import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  agentBridgeBinary,
  createLauncherStandIns,
  resultImage,
  resultText
} from './agent-mcp-client.mjs'

test('the bridge is the cargo build output, or the one the run names', () => {
  assert.equal(
    agentBridgeBinary({ repoRoot: '/repo', env: {}, platform: 'darwin' }),
    join('/repo', 'target', 'debug', 'videorc-mcp')
  )
  assert.equal(
    agentBridgeBinary({
      repoRoot: '/repo',
      env: { VIDEORC_DEV_BACKEND_PROFILE: 'release' },
      platform: 'win32'
    }),
    join('/repo', 'target', 'release', 'videorc-mcp.exe')
  )
  assert.equal(
    agentBridgeBinary({ repoRoot: '/repo', env: { VIDEORC_SMOKE_AGENT_BRIDGE: '/x/mcp' } }),
    '/x/mcp'
  )
})

test(
  'the launcher stand-ins fail and record every attempt to open Videorc',
  { skip: process.platform === 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-mcp-launchers-'))
    try {
      const launchers = createLauncherStandIns(directory)
      assert.equal(launchers.attempts(), '')
      const opened = spawnSync('open', ['-g', '-b', 'dev.theorcdev.videorc'], {
        env: { PATH: launchers.binDir }
      })
      assert.equal(opened.status, 1)
      assert.match(launchers.attempts(), /open -g -b dev\.theorcdev\.videorc/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test('tool results read their text and decode their image', () => {
  const result = {
    content: [
      { type: 'text', text: 'The program picture, 1280×720.' },
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8]).toString('base64') }
    ]
  }
  assert.equal(resultText(result), 'The program picture, 1280×720.')
  assert.deepEqual(resultImage(result), {
    mimeType: 'image/jpeg',
    bytes: Buffer.from([0xff, 0xd8])
  })
  assert.equal(resultText({}), '')
  assert.equal(resultImage({ content: [] }), null)
})
