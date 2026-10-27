import type { AgentClientKind } from '@/lib/backend'

// Plan 209 S7 (D6): the line a streamer pastes into an agent app. Each app
// gets its own config shape with the bridge's absolute path and the agent's
// token in VIDEORC_AGENT_TOKEN. Pure: no DOM, no backend client.

/** The server name agent apps show (`mcp__videorc__…`), D21. A test pins it
 * to the catalog's `serverName`. */
export const AGENT_SERVER_NAME = 'videorc'

/** The variable the bridge reads its token from (S4). */
export const AGENT_TOKEN_ENV = 'VIDEORC_AGENT_TOKEN'

/** The apps Connect knows, in the order the picker lists them. */
export const AGENT_APPS: ReadonlyArray<{ id: AgentClientKind; label: string }> = [
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'vs-code', label: 'VS Code' },
  { id: 'other', label: 'Other' }
]

/** The app's name, and the default name of an agent connected from it. */
export function agentAppLabel(client: AgentClientKind): string {
  return AGENT_APPS.find((app) => app.id === client)?.label ?? 'Other'
}

/** "Other" names nothing: its agent starts as "My agent". */
export function defaultAgentName(client: AgentClientKind): string {
  return client === 'other' ? 'My agent' : agentAppLabel(client)
}

export interface AgentConnectLine {
  /** What the block is, for its label and its monospace well. */
  format: 'json' | 'command' | 'toml' | 'text'
  /** The file or place it goes, over the block. */
  label: string
  /** Where it goes, in the app's own words. */
  where: string
  text: string
}

/** A Windows path (`C:\…` or `\\server\…`): the command line quotes it the Windows way. */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * One argument for the shell the app's terminal runs: as it is when it has
 * nothing a shell reads, else single quotes (macOS, Linux) or double quotes
 * (PowerShell and cmd on Windows, where a path holds no `"`).
 */
export function shellArgument(value: string, windows: boolean): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value) && !(!windows && value.includes('\\'))) {
    return value
  }
  if (windows) return `"${value.replaceAll('"', '\\"')}"`
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** A TOML basic string: backslashes, quotes and control characters escaped. */
export function tomlString(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\') out += '\\\\'
    else if (char === '"') out += '\\"'
    else if (char === '\n') out += '\\n'
    else if (char === '\t') out += '\\t'
    else if (char === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `"${out}"`
}

function jsonConfig(rootKey: 'mcpServers' | 'servers', server: Record<string, unknown>): string {
  return JSON.stringify({ [rootKey]: { [AGENT_SERVER_NAME]: server } }, null, 2)
}

/** The config for `client`, with `bridgePath` and the agent's `token`. */
export function agentConnectLine(
  client: AgentClientKind,
  { bridgePath, token }: { bridgePath: string; token: string }
): AgentConnectLine {
  const env = { [AGENT_TOKEN_ENV]: token }
  const assignment = `${AGENT_TOKEN_ENV}=${token}`
  switch (client) {
    case 'claude-desktop':
      return {
        format: 'json',
        label: 'claude_desktop_config.json',
        where:
          'In Claude Desktop, open Settings → Developer → Edit Config. Add the videorc entry to mcpServers in claude_desktop_config.json, save, then quit and reopen Claude Desktop.',
        text: jsonConfig('mcpServers', { command: bridgePath, args: [], env })
      }
    case 'claude-code': {
      const windows = isWindowsPath(bridgePath)
      return {
        format: 'command',
        label: 'Terminal',
        where: 'Run this in a terminal. Claude Code then reaches Videorc from every project.',
        text: [
          'claude mcp add --scope user',
          AGENT_SERVER_NAME,
          '--env',
          shellArgument(assignment, windows),
          '--',
          shellArgument(bridgePath, windows)
        ].join(' ')
      }
    }
    case 'cursor':
      return {
        format: 'json',
        label: 'mcp.json',
        where:
          'Add the videorc entry to mcpServers in .cursor/mcp.json in your home folder (Cursor Settings → MCP), then turn videorc on there.',
        text: jsonConfig('mcpServers', { command: bridgePath, args: [], env })
      }
    case 'codex':
      return {
        format: 'toml',
        label: 'config.toml',
        where:
          'Add this to config.toml in the .codex folder in your home folder, then restart Codex.',
        text: [
          `[mcp_servers.${AGENT_SERVER_NAME}]`,
          `command = ${tomlString(bridgePath)}`,
          'args = []',
          `env = { ${AGENT_TOKEN_ENV} = ${tomlString(token)} }`
        ].join('\n')
      }
    case 'vs-code':
      return {
        format: 'json',
        label: 'mcp.json',
        where:
          'In VS Code, run MCP: Open User Configuration and add the videorc entry to servers in mcp.json.',
        text: jsonConfig('servers', { type: 'stdio', command: bridgePath, args: [], env })
      }
    case 'other':
      return {
        format: 'text',
        label: 'Command and variable',
        where:
          'Add Videorc to your agent app as a local (stdio) MCP server: this command, with this environment variable.',
        text: [`Command: ${bridgePath}`, `Environment: ${assignment}`].join('\n')
      }
  }
}

/** The token as the dialog draws it until "Show token": the prefix, then dots. */
export function maskedAgentToken(token: string): string {
  const prefix = token.startsWith('vrc_agent_') ? 'vrc_agent_' : ''
  return `${prefix}${'•'.repeat(12)}`
}

/** The block as drawn: the token masked until the streamer shows it (it could be on stream). */
export function agentConnectLineDisplay(
  line: AgentConnectLine,
  token: string,
  shown: boolean
): string {
  return shown || !token ? line.text : line.text.replaceAll(token, maskedAgentToken(token))
}

/**
 * Videorc runs from somewhere that moves (a disk image, or macOS's
 * temporary copy of an app that was never moved out of Downloads): a line
 * pointing there breaks later. The sentence that says so, or null.
 */
export function agentBridgePathWarning(path: string): string | null {
  if (path.includes('/AppTranslocation/') || path.startsWith('/Volumes/')) {
    return 'Videorc is running from a disk image or a temporary copy, so this path will stop working. Move Videorc to Applications, open it from there, then connect.'
  }
  return null
}
