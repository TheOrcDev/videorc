import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  agentBridgeRunsFromTemporaryCopy,
  agentClaudeCodeAddArgs,
  agentCodexTomlLines,
  agentJsonRootKey,
  agentJsonServerEntry,
  type AgentJsonConfigApp
} from './agent-config-entry'

// Plan 260 S1.6f: the Connect dialog shows the entry from this module and
// Electron main writes it ("Add to …", `main/agent-config-install.ts`);
// videorc-app-core's `settings_page::agents` spells it in Rust. Both sides'
// tests read the same fixture, so the GPUI app's line and Electron's can
// never disagree.

interface EntryCase {
  bridgePath: string
  token: string
  temporaryCopy: boolean
  jsonRootKey: Record<AgentJsonConfigApp, string>
  json: Record<AgentJsonConfigApp, unknown>
  codexTomlLines: string[]
  claudeCodeAddArgs: string[]
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/agent-config-entries.json', import.meta.url),
    'utf8'
  )
) as { cases: EntryCase[] }

const APPS: AgentJsonConfigApp[] = ['claude-desktop', 'cursor', 'vs-code']

describe('the agent config entry (plan 260 S1.6f fixture)', () => {
  it('has the cases the Rust side reads', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(5)
  })

  it.each(fixture.cases.map((entry) => [entry.bridgePath, entry] as const))(
    'matches the fixture for %s',
    (_label, entry) => {
      const connection = { bridgePath: entry.bridgePath, token: entry.token }
      for (const app of APPS) {
        // The key order is part of the text: compare the serialized form.
        expect(JSON.stringify(agentJsonServerEntry(app, connection))).toBe(
          JSON.stringify(entry.json[app])
        )
        expect(agentJsonRootKey(app)).toBe(entry.jsonRootKey[app])
      }
      expect(agentCodexTomlLines(connection)).toEqual(entry.codexTomlLines)
      expect(agentClaudeCodeAddArgs(connection)).toEqual(entry.claudeCodeAddArgs)
      expect(agentBridgeRunsFromTemporaryCopy(entry.bridgePath)).toBe(entry.temporaryCopy)
    }
  )
})
