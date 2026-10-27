import { describe, expect, it } from 'vitest'

import { AGENT_TOOL_CATALOG } from '../../../shared/agent-tools'
import {
  AGENT_APPS,
  AGENT_SERVER_NAME,
  AGENT_TOKEN_ENV,
  agentBridgePathWarning,
  agentConnectLine,
  agentConnectLineDisplay,
  defaultAgentName,
  isWindowsPath,
  maskedAgentToken,
  shellArgument,
  tomlString
} from './agent-connect-lines'

// Plan 209 S7 (D6): the exact line per app, with the bridge's absolute path
// and the token in VIDEORC_AGENT_TOKEN.

const MAC = '/Applications/Videorc.app/Contents/Resources/videorc-mcp'
const WINDOWS = 'C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Videorc\\resources\\videorc-mcp.exe'
const TOKEN = `vrc_agent_${'ab12'.repeat(16)}`

describe('agent connect lines (plan 209 S7, D6)', () => {
  it('lists the six apps, and names an agent after its app', () => {
    expect(AGENT_APPS.map((app) => app.id)).toEqual([
      'claude-desktop',
      'claude-code',
      'cursor',
      'codex',
      'vs-code',
      'other'
    ])
    expect(defaultAgentName('claude-desktop')).toBe('Claude Desktop')
    expect(defaultAgentName('vs-code')).toBe('VS Code')
    // "Other" is not a name.
    expect(defaultAgentName('other')).toBe('My agent')
  })

  it('names the server as the catalog does, and the variable the bridge reads', () => {
    expect(AGENT_SERVER_NAME).toBe(AGENT_TOOL_CATALOG.serverName)
    expect(AGENT_TOKEN_ENV).toBe('VIDEORC_AGENT_TOKEN')
  })

  it('gives Claude Desktop and Cursor an mcpServers entry', () => {
    for (const client of ['claude-desktop', 'cursor'] as const) {
      const line = agentConnectLine(client, { bridgePath: MAC, token: TOKEN })
      expect(line.format).toBe('json')
      expect(JSON.parse(line.text)).toEqual({
        mcpServers: {
          videorc: { command: MAC, args: [], env: { VIDEORC_AGENT_TOKEN: TOKEN } }
        }
      })
    }
    expect(agentConnectLine('claude-desktop', { bridgePath: MAC, token: TOKEN }).label).toBe(
      'claude_desktop_config.json'
    )
  })

  it("gives VS Code its servers entry with the stdio type (VS Code's mcp.json shape)", () => {
    const line = agentConnectLine('vs-code', { bridgePath: MAC, token: TOKEN })
    expect(JSON.parse(line.text)).toEqual({
      servers: {
        videorc: { type: 'stdio', command: MAC, args: [], env: { VIDEORC_AGENT_TOKEN: TOKEN } }
      }
    })
    expect(line.label).toBe('mcp.json')
  })

  it('escapes a Windows path in JSON so it parses back to the same path', () => {
    const line = agentConnectLine('claude-desktop', { bridgePath: WINDOWS, token: TOKEN })
    expect(line.text).toContain(
      '"C:\\\\Users\\\\Ana Lee\\\\AppData\\\\Local\\\\Programs\\\\Videorc\\\\resources\\\\videorc-mcp.exe"'
    )
    expect(JSON.parse(line.text).mcpServers.videorc.command).toBe(WINDOWS)
  })

  it('gives Claude Code one command for every project, the path quoted for its shell', () => {
    expect(agentConnectLine('claude-code', { bridgePath: MAC, token: TOKEN }).text).toBe(
      `claude mcp add --scope user videorc --env VIDEORC_AGENT_TOKEN=${TOKEN} -- ${MAC}`
    )
    expect(
      agentConnectLine('claude-code', { bridgePath: '/home/ana/My Apps/videorc-mcp', token: TOKEN })
        .text
    ).toBe(
      `claude mcp add --scope user videorc --env VIDEORC_AGENT_TOKEN=${TOKEN} -- '/home/ana/My Apps/videorc-mcp'`
    )
    // Windows: PowerShell and cmd both take double quotes; backslashes stay as they are.
    expect(agentConnectLine('claude-code', { bridgePath: WINDOWS, token: TOKEN }).text).toBe(
      `claude mcp add --scope user videorc --env VIDEORC_AGENT_TOKEN=${TOKEN} -- "${WINDOWS}"`
    )
  })

  it('gives Codex a TOML table with basic strings, backslashes and quotes escaped', () => {
    const line = agentConnectLine('codex', { bridgePath: WINDOWS, token: TOKEN })
    expect(line.format).toBe('toml')
    expect(line.text).toBe(
      [
        '[mcp_servers.videorc]',
        'command = "C:\\\\Users\\\\Ana Lee\\\\AppData\\\\Local\\\\Programs\\\\Videorc\\\\resources\\\\videorc-mcp.exe"',
        'args = []',
        `env = { VIDEORC_AGENT_TOKEN = "${TOKEN}" }`
      ].join('\n')
    )
    expect(tomlString('say "hi"\\ok\n')).toBe('"say \\"hi\\"\\\\ok\\n"')
    expect(tomlString('bell\u0007')).toBe('"bell\\u0007"')
  })

  it('gives Other the plain command and variable', () => {
    expect(agentConnectLine('other', { bridgePath: MAC, token: TOKEN }).text).toBe(
      `Command: ${MAC}\nEnvironment: VIDEORC_AGENT_TOKEN=${TOKEN}`
    )
  })

  it('tells each app where the line goes', () => {
    for (const { id } of AGENT_APPS) {
      const line = agentConnectLine(id, { bridgePath: MAC, token: TOKEN })
      expect(line.where.length, id).toBeGreaterThan(20)
      expect(line.where, id).toMatch(/\.$/)
      expect(line.label.length, id).toBeGreaterThan(0)
    }
  })

  it('quotes shell arguments only when a shell would read them', () => {
    expect(shellArgument('/usr/local/bin/videorc-mcp', false)).toBe('/usr/local/bin/videorc-mcp')
    expect(shellArgument("/tmp/it's here", false)).toBe(`'/tmp/it'\\''s here'`)
    expect(shellArgument('/tmp/back\\slash', false)).toBe(`'/tmp/back\\slash'`)
    expect(shellArgument('C:\\Videorc\\videorc-mcp.exe', true)).toBe('C:\\Videorc\\videorc-mcp.exe')
    expect(isWindowsPath(WINDOWS)).toBe(true)
    expect(isWindowsPath('\\\\server\\share\\videorc-mcp.exe')).toBe(true)
    expect(isWindowsPath(MAC)).toBe(false)
  })

  it('draws the token masked until it is shown, and copies it whole', () => {
    const line = agentConnectLine('claude-desktop', { bridgePath: MAC, token: TOKEN })
    const masked = agentConnectLineDisplay(line, TOKEN, false)
    expect(masked).not.toContain(TOKEN)
    expect(masked).toContain(maskedAgentToken(TOKEN))
    expect(maskedAgentToken(TOKEN)).toMatch(/^vrc_agent_•+$/)
    expect(agentConnectLineDisplay(line, TOKEN, true)).toBe(line.text)
  })

  it('warns when Videorc runs from a disk image or a translocated copy', () => {
    expect(agentBridgePathWarning(MAC)).toBeNull()
    expect(agentBridgePathWarning(WINDOWS)).toBeNull()
    expect(
      agentBridgePathWarning('/Volumes/Videorc/Videorc.app/Contents/Resources/videorc-mcp')
    ).toMatch(/Move Videorc to Applications/)
    expect(
      agentBridgePathWarning(
        '/private/var/folders/x/AppTranslocation/ABC/d/Videorc.app/Contents/Resources/videorc-mcp'
      )
    ).toMatch(/temporary copy/)
  })
})
