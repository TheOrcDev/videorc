// Plan 209 S7 and S22 (D6): the `videorc` server entry each agent app's own
// config holds, with the bridge's absolute path and the agent's token in
// VIDEORC_AGENT_TOKEN. The Connect dialog shows it as the line to paste
// (`lib/agent-connect-lines.ts`), and Electron main writes the same entry
// into the app's config file for "Add to …" (`main/agent-config-install.ts`),
// so the two can never disagree. Pure: no DOM, no Node.

/** The server name agent apps show (`mcp__videorc__…`), D21. A test pins it
 * to the catalog's `serverName`. */
export const AGENT_SERVER_NAME = 'videorc'

/** The variable the bridge reads its token from (S4). */
export const AGENT_TOKEN_ENV = 'VIDEORC_AGENT_TOKEN'

/** The shape `agents.create` mints: the prefix and 64 hex characters. */
export const AGENT_TOKEN_PATTERN = /^vrc_agent_[0-9a-f]{64}$/

/** Plan 209 review #19: what Connect and "Add to …" answer when Videorc runs
 * from a disk image or macOS's temporary copy of it. */
export const AGENT_BRIDGE_MOVE_FIRST = 'Move Videorc to Applications first.'

/**
 * macOS runs this Videorc from somewhere that goes away: an app opened from
 * Downloads without being moved runs from a per-launch `AppTranslocation`
 * copy, and an app opened inside its disk image sits at the volume's root
 * (`/Volumes/Videorc/Videorc.app`). A config line naming either path breaks
 * at the next launch or eject. An app on an external drive's own folder
 * (`/Volumes/SSD/Applications/Videorc.app`) stays put and is fine.
 */
export function agentBridgeRunsFromTemporaryCopy(path: string): boolean {
  return path.includes('/AppTranslocation/') || /^\/Volumes\/[^/]+\/[^/]+\.app\//.test(path)
}

/** The apps whose JSON config takes a `videorc` entry. */
export type AgentJsonConfigApp = 'claude-desktop' | 'cursor' | 'vs-code'

/** Claude Desktop and Cursor keep servers under `mcpServers`; VS Code's
 * `mcp.json` keeps them under `servers`, with a `type`. */
export function agentJsonRootKey(app: AgentJsonConfigApp): 'mcpServers' | 'servers' {
  return app === 'vs-code' ? 'servers' : 'mcpServers'
}

/** The `videorc` entry for a JSON config. */
export function agentJsonServerEntry(
  app: AgentJsonConfigApp,
  { bridgePath, token }: { bridgePath: string; token: string }
): Record<string, unknown> {
  const entry = { command: bridgePath, args: [], env: { [AGENT_TOKEN_ENV]: token } }
  return app === 'vs-code' ? { type: 'stdio', ...entry } : entry
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

/** Codex's `[mcp_servers.videorc]` table, one line per item. */
export function agentCodexTomlLines({
  bridgePath,
  token
}: {
  bridgePath: string
  token: string
}): string[] {
  return [
    `[mcp_servers.${AGENT_SERVER_NAME}]`,
    `command = ${tomlString(bridgePath)}`,
    'args = []',
    `env = { ${AGENT_TOKEN_ENV} = ${tomlString(token)} }`
  ]
}

/** `claude` CLI arguments that add Videorc for every project (user scope). */
export function agentClaudeCodeAddArgs({
  bridgePath,
  token
}: {
  bridgePath: string
  token: string
}): string[] {
  return [
    'mcp',
    'add',
    '--scope',
    'user',
    AGENT_SERVER_NAME,
    '--env',
    `${AGENT_TOKEN_ENV}=${token}`,
    '--',
    bridgePath
  ]
}
