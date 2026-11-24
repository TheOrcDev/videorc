import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  AGENT_TOKEN_PATTERN,
  agentBridgeRunsFromTemporaryCopy,
  agentClaudeCodeAddArgs,
  agentCodexTomlLines,
  agentJsonRootKey,
  agentJsonServerEntry,
  type AgentJsonConfigApp
} from './agent-config-entry'

// Plan 260 S1.6f: the Connect dialog shows the entry from this module and
// the backend writes it ("Add to …", plan 260 S1.5c); videorc-app-core's
// `settings_page::agents` spells it in Rust. Both sides' tests read the same
// fixture, so the GPUI app's line and Electron's can never disagree.

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

// Plan 260 S1.5c: the backend writes the entry "Add to …" puts in an app's
// config, and the dialog shows the same line built here; one fixture pins both.

interface AgentConfigEntryFixture {
  connection: { bridgePath: string; token: string }
  json: Record<AgentJsonConfigApp, { rootKey: string; entry: Record<string, unknown> }>
  codexTomlLines: string[]
  claudeCodeAddArgs: string[]
}

const writtenFixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/agent-config-entry.json', import.meta.url),
    'utf8'
  )
) as AgentConfigEntryFixture

describe('agent config entry (plan 260 S1.5c)', () => {
  it('builds what the backend writes, key order included', () => {
    expect(writtenFixture.connection.token).toMatch(AGENT_TOKEN_PATTERN)
    for (const app of APPS) {
      const expected = writtenFixture.json[app]
      expect(agentJsonRootKey(app)).toBe(expected.rootKey)
      const entry = agentJsonServerEntry(app, writtenFixture.connection)
      expect(JSON.stringify(entry)).toBe(JSON.stringify(expected.entry))
    }
    expect(agentCodexTomlLines(writtenFixture.connection)).toStrictEqual(
      writtenFixture.codexTomlLines
    )
    expect(agentClaudeCodeAddArgs(writtenFixture.connection)).toStrictEqual(
      writtenFixture.claudeCodeAddArgs
    )
  })
})
