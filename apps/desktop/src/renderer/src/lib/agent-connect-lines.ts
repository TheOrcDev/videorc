import type { AgentClientKind } from '@/lib/backend'
import {
  AGENT_BRIDGE_MOVE_FIRST,
  AGENT_SERVER_NAME,
  AGENT_TOKEN_ENV,
  agentBridgeRunsFromTemporaryCopy,
  agentClaudeCodeAddArgs,
  agentCodexTomlLines,
  agentJsonRootKey,
  agentJsonServerEntry,
  type AgentJsonConfigApp
} from '../../../shared/agent-config-entry'

// Plan 209 S7 (D6): the line a streamer pastes into an agent app. Each app
// gets its own config shape with the bridge's absolute path and the agent's
// token in VIDEORC_AGENT_TOKEN. The entries themselves are shared with
// Electron main, which writes the same ones for "Add to …" (S22). Pure: no
// DOM, no backend client.

export {
  AGENT_BRIDGE_MOVE_FIRST,
  AGENT_SERVER_NAME,
  AGENT_TOKEN_ENV,
  tomlString
} from '../../../shared/agent-config-entry'

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

function jsonConfig(app: AgentJsonConfigApp, connection: AgentConnection): string {
  return JSON.stringify(
    { [agentJsonRootKey(app)]: { [AGENT_SERVER_NAME]: agentJsonServerEntry(app, connection) } },
    null,
    2
  )
}

interface AgentConnection {
  bridgePath: string
  token: string
}

/** The config for `client`, with `bridgePath` and the agent's `token`. */
export function agentConnectLine(
  client: AgentClientKind,
  connection: AgentConnection
): AgentConnectLine {
  const { bridgePath, token } = connection
  const assignment = `${AGENT_TOKEN_ENV}=${token}`
  switch (client) {
    case 'claude-desktop':
      return {
        format: 'json',
        label: 'claude_desktop_config.json',
        where:
          'In Claude Desktop, open Settings → Developer → Edit Config. Add the videorc entry to mcpServers in claude_desktop_config.json, save, then quit and reopen Claude Desktop.',
        text: jsonConfig('claude-desktop', connection)
      }
    case 'claude-code': {
      const windows = isWindowsPath(bridgePath)
      return {
        format: 'command',
        label: 'Terminal',
        where: 'Run this in a terminal. Claude Code then reaches Videorc from every project.',
        text: ['claude', ...agentClaudeCodeAddArgs(connection)]
          .map((part) => shellArgument(part, windows))
          .join(' ')
      }
    }
    case 'cursor':
      return {
        format: 'json',
        label: 'mcp.json',
        where:
          'Add the videorc entry to mcpServers in .cursor/mcp.json in your home folder (Cursor Settings → MCP), then turn videorc on there.',
        text: jsonConfig('cursor', connection)
      }
    case 'codex':
      return {
        format: 'toml',
        label: 'config.toml',
        where:
          'Add this to config.toml in the .codex folder in your home folder, then restart Codex.',
        text: agentCodexTomlLines(connection).join('\n')
      }
    case 'vs-code':
      return {
        format: 'json',
        label: 'mcp.json',
        where:
          'In VS Code, run MCP: Open User Configuration and add the videorc entry to servers in mcp.json.',
        text: jsonConfig('vs-code', connection)
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

/** Why Connect refuses a bridge path that moves, under its title. */
export const AGENT_BRIDGE_MOVE_FIRST_DETAIL =
  "Videorc is running from a disk image or a temporary copy, so an agent's line would stop working. Open it from Applications, then connect."

/**
 * Videorc runs from somewhere that moves (a disk image, or macOS's
 * temporary copy of an app that was never moved out of Downloads): a line
 * pointing there breaks later, so Connect refuses (review #19) and main's
 * "Add to …" does too. The refusal, or null.
 */
export function agentBridgePathRefusal(path: string): string | null {
  return agentBridgeRunsFromTemporaryCopy(path) ? AGENT_BRIDGE_MOVE_FIRST : null
}
