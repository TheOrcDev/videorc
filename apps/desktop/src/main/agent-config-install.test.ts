import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentCodexTomlLines } from '../shared/agent-config-entry'
import {
  addAgentToApp,
  addToClaudeCode,
  agentConfigTarget,
  agentConfigWriteMessage,
  backupStamp,
  claudeCliCandidates,
  claudeCodeInstallMessage,
  mergeJsonConfig,
  nodeAgentConfigFs,
  writeAgentConfig,
  type AgentConfigTarget,
  type ExecFile
} from './agent-config-install'

// Plan 209 S22: "Add to …" writes the videorc entry into another app's own
// config file. It keeps every other server, backs the file up, writes
// atomically, refuses what it can't read, and never creates the app's folder.

const TOKEN = `vrc_agent_${'ab12'.repeat(16)}`
const MAC = '/Applications/Videorc.app/Contents/Resources/videorc-mcp'
const WINDOWS_BRIDGE =
  'C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Videorc\\resources\\videorc-mcp.exe'
const CONNECTION = { bridgePath: MAC, token: TOKEN }
const NOW = new Date('2026-10-27T22:15:30.123Z')
const ENTRY = { command: MAC, args: [], env: { VIDEORC_AGENT_TOKEN: TOKEN } }

let root: string

beforeEach(async () => {
  // The real path: macOS's temp folder is behind a symlink, and the install
  // reports the file it wrote.
  root = await realpath(await mkdtemp(join(tmpdir(), 'videorc-agent-config-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const target = (app: AgentConfigTarget['app'], file: string): AgentConfigTarget => ({
  app,
  file,
  format: app === 'codex' ? 'toml' : 'json'
})

async function folder(...parts: string[]): Promise<string> {
  const path = join(root, ...parts)
  await mkdir(path, { recursive: true })
  return path
}

const backups = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((name) => name.includes('.videorc-backup-')).sort()

describe('where each app keeps its servers (plan 209 S22)', () => {
  it('macOS', () => {
    const env = { platform: 'darwin' as const, homeDir: '/Users/ana' }
    expect(agentConfigTarget('claude-desktop', env).file).toBe(
      '/Users/ana/Library/Application Support/Claude/claude_desktop_config.json'
    )
    expect(agentConfigTarget('cursor', env).file).toBe('/Users/ana/.cursor/mcp.json')
    expect(agentConfigTarget('vs-code', env).file).toBe(
      '/Users/ana/Library/Application Support/Code/User/mcp.json'
    )
    expect(agentConfigTarget('codex', env)).toEqual({
      app: 'codex',
      format: 'toml',
      file: '/Users/ana/.codex/config.toml'
    })
  })

  it('Windows, from %APPDATA% or the profile when it is unset', () => {
    const env = {
      platform: 'win32' as const,
      homeDir: 'C:\\Users\\Ana Lee',
      appData: 'D:\\Roaming'
    }
    expect(agentConfigTarget('claude-desktop', env).file).toBe(
      'D:\\Roaming\\Claude\\claude_desktop_config.json'
    )
    expect(agentConfigTarget('vs-code', env).file).toBe('D:\\Roaming\\Code\\User\\mcp.json')
    expect(agentConfigTarget('cursor', env).file).toBe('C:\\Users\\Ana Lee\\.cursor\\mcp.json')
    expect(agentConfigTarget('codex', env).file).toBe('C:\\Users\\Ana Lee\\.codex\\config.toml')
    expect(
      agentConfigTarget('claude-desktop', { platform: 'win32', homeDir: 'C:\\Users\\Ana Lee' }).file
    ).toBe('C:\\Users\\Ana Lee\\AppData\\Roaming\\Claude\\claude_desktop_config.json')
  })

  it('Linux, from $XDG_CONFIG_HOME or ~/.config, and Codex from $CODEX_HOME', () => {
    const env = { platform: 'linux' as const, homeDir: '/home/ana' }
    expect(agentConfigTarget('claude-desktop', env).file).toBe(
      '/home/ana/.config/Claude/claude_desktop_config.json'
    )
    expect(agentConfigTarget('vs-code', env).file).toBe('/home/ana/.config/Code/User/mcp.json')
    expect(agentConfigTarget('vs-code', { ...env, xdgConfigHome: '/xdg' }).file).toBe(
      '/xdg/Code/User/mcp.json'
    )
    expect(agentConfigTarget('codex', { ...env, codexHome: '/opt/codex' }).file).toBe(
      '/opt/codex/config.toml'
    )
  })
})

describe('mergeJsonConfig (plan 209 S22)', () => {
  it('adds videorc after the other servers and keeps every other key', () => {
    const existing = JSON.stringify(
      { globalShortcut: 'Alt+Space', mcpServers: { github: { command: 'gh' } } },
      null,
      2
    )
    const result = mergeJsonConfig(existing, 'mcpServers', ENTRY)
    expect(result.ok && result.changed).toBe(true)
    const merged = JSON.parse(result.ok ? result.text : '')
    expect(merged).toEqual({
      globalShortcut: 'Alt+Space',
      mcpServers: { github: { command: 'gh' }, videorc: ENTRY }
    })
    expect(Object.keys(merged.mcpServers)).toEqual(['github', 'videorc'])
  })

  it('replaces an old videorc entry in its place, and keeps the file indent', () => {
    const existing =
      '{\n\t"mcpServers": {\n\t\t"videorc": {"command": "/old"},\n\t\t"z": {}\n\t}\n}\n'
    const result = mergeJsonConfig(existing, 'mcpServers', ENTRY)
    if (!result.ok) throw new Error(result.reason)
    expect(Object.keys(JSON.parse(result.text).mcpServers)).toEqual(['videorc', 'z'])
    expect(result.text).toContain('\n\t"mcpServers"')
  })

  it('gives VS Code its servers key with the stdio type and keeps its inputs', () => {
    const existing = JSON.stringify({ servers: {}, inputs: [{ id: 'key', type: 'promptString' }] })
    const entry = { type: 'stdio', ...ENTRY }
    const result = mergeJsonConfig(existing, 'servers', entry)
    if (!result.ok) throw new Error(result.reason)
    expect(JSON.parse(result.text)).toEqual({
      servers: { videorc: entry },
      inputs: [{ id: 'key', type: 'promptString' }]
    })
  })

  it('escapes a Windows bridge path so it reads back as the same path', () => {
    const entry = { ...ENTRY, command: WINDOWS_BRIDGE }
    const result = mergeJsonConfig(null, 'mcpServers', entry)
    if (!result.ok) throw new Error(result.reason)
    expect(result.text).toContain('"C:\\\\Users\\\\Ana Lee\\\\AppData')
    expect(JSON.parse(result.text).mcpServers.videorc.command).toBe(WINDOWS_BRIDGE)
  })

  it('reads a byte order mark, and says unchanged when the entry is already there', () => {
    const existing = `\uFEFF${JSON.stringify({ mcpServers: { videorc: ENTRY } })}`
    expect(mergeJsonConfig(existing, 'mcpServers', ENTRY)).toEqual({
      ok: true,
      text: existing,
      changed: false
    })
  })

  it.each([
    ['comments (JSONC)', '{\n  // mine\n  "mcpServers": {}\n}', 'not-json'],
    ['a trailing comma', '{"mcpServers": {},}', 'not-json'],
    ['a half-written file', '{"mcpServers": {', 'not-json'],
    ['an array', '[]', 'not-object'],
    ['null', 'null', 'not-object'],
    ['servers as an array', '{"mcpServers": []}', 'servers-not-object'],
    ['servers as a string', '{"mcpServers": "x"}', 'servers-not-object']
  ])('refuses %s', (_label, existing, reason) => {
    expect(mergeJsonConfig(existing, 'mcpServers', ENTRY)).toEqual({ ok: false, reason })
  })
})

describe('writeAgentConfig (plan 209 S22)', () => {
  it('keeps the other servers, backs the old file up beside it, and keeps its permissions', async () => {
    const dir = await folder('Claude')
    const file = join(dir, 'claude_desktop_config.json')
    const original = JSON.stringify({ mcpServers: { github: { command: 'gh' } } }, null, 2)
    await writeFile(file, original)
    await chmod(file, 0o640)

    const write = await writeAgentConfig(target('claude-desktop', file), CONNECTION, 'darwin', {
      now: () => NOW
    })

    expect(write).toEqual({
      outcome: 'added',
      file,
      backup: `${file}.videorc-backup-20261027-221530`
    })
    expect(JSON.parse(await readFile(file, 'utf8')).mcpServers).toEqual({
      github: { command: 'gh' },
      videorc: ENTRY
    })
    expect(await readFile(`${file}.videorc-backup-20261027-221530`, 'utf8')).toBe(original)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o640)
    // Nothing else beside it: no staging file left behind.
    expect((await readdir(dir)).sort()).toEqual([
      'claude_desktop_config.json',
      'claude_desktop_config.json.videorc-backup-20261027-221530'
    ])
  })

  it('creates a missing file owner-only, with no backup', async () => {
    const dir = await folder('.cursor')
    const file = join(dir, 'mcp.json')
    const write = await writeAgentConfig(target('cursor', file), CONNECTION, 'darwin')
    expect(write).toEqual({ outcome: 'added', file, backup: null })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mcpServers: { videorc: ENTRY } })
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await backups(dir)).toEqual([])
  })

  it("never creates the app's folder", async () => {
    const file = join(root, 'Code', 'User', 'mcp.json')
    const write = await writeAgentConfig(target('vs-code', file), CONNECTION, 'darwin')
    expect(write).toEqual({ outcome: 'refused', file, reason: 'no-app' })
    await expect(stat(join(root, 'Code'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a file it cannot read exactly as it was, with no backup', async () => {
    const dir = await folder('Code', 'User')
    const file = join(dir, 'mcp.json')
    const original = '{\n  // my servers\n  "servers": {}\n}\n'
    await writeFile(file, original)
    const write = await writeAgentConfig(target('vs-code', file), CONNECTION, 'darwin')
    expect(write).toEqual({ outcome: 'refused', file, reason: 'not-json' })
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(await readdir(dir)).toEqual(['mcp.json'])
  })

  it('writes nothing, and makes no backup, when the entry is already there', async () => {
    const dir = await folder('.cursor')
    const file = join(dir, 'mcp.json')
    await writeAgentConfig(target('cursor', file), CONNECTION, 'darwin', { now: () => NOW })
    const first = await readFile(file, 'utf8')
    const again = await writeAgentConfig(target('cursor', file), CONNECTION, 'darwin', {
      now: () => NOW
    })
    expect(again).toEqual({ outcome: 'unchanged', file })
    expect(await readFile(file, 'utf8')).toBe(first)
    expect(await backups(dir)).toEqual([])
  })

  it('keeps every backup when the entry changes twice in one second', async () => {
    const dir = await folder('.cursor')
    const file = join(dir, 'mcp.json')
    await writeFile(file, '{}')
    for (const token of ['vrc_agent_one', 'vrc_agent_two']) {
      await writeAgentConfig(target('cursor', file), { bridgePath: MAC, token }, 'darwin', {
        now: () => NOW
      })
    }
    expect(await backups(dir)).toEqual([
      'mcp.json.videorc-backup-20261027-221530',
      'mcp.json.videorc-backup-20261027-221530-2'
    ])
    expect(await readFile(join(dir, 'mcp.json.videorc-backup-20261027-221530'), 'utf8')).toBe('{}')
  })

  it.skipIf(process.platform === 'win32')(
    'writes a symlinked config through to its target and keeps the link',
    async () => {
      const dotfiles = await folder('dotfiles')
      const real = join(dotfiles, 'cursor-mcp.json')
      await writeFile(real, JSON.stringify({ mcpServers: { github: { command: 'gh' } } }))
      const dir = await folder('.cursor')
      const link = join(dir, 'mcp.json')
      await symlink(real, link)

      const write = await writeAgentConfig(target('cursor', link), CONNECTION, 'darwin', {
        now: () => NOW
      })

      expect(write.outcome).toBe('added')
      expect(await readlink(link)).toBe(real)
      expect(JSON.parse(await readFile(real, 'utf8')).mcpServers.videorc).toEqual(ENTRY)
      expect(await backups(dotfiles)).toEqual(['cursor-mcp.json.videorc-backup-20261027-221530'])
    }
  )

  it('keeps the old file when the final rename fails, and removes its staging file', async () => {
    const dir = await folder('Claude')
    const file = join(dir, 'claude_desktop_config.json')
    await writeFile(file, '{"mcpServers": {}}')
    const log = vi.fn()
    const write = await writeAgentConfig(target('claude-desktop', file), CONNECTION, 'darwin', {
      now: () => NOW,
      log,
      fs: {
        ...nodeAgentConfigFs,
        rename: async () => {
          throw Object.assign(new Error('EXDEV: cross-device'), { code: 'EXDEV' })
        }
      }
    })
    expect(write).toEqual({ outcome: 'failed', file })
    expect(await readFile(file, 'utf8')).toBe('{"mcpServers": {}}')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EXDEV'))
    expect(String(log.mock.calls[0][0])).not.toContain(TOKEN)
  })

  it("adds Codex's table to config.toml and keeps the rest", async () => {
    const dir = await folder('.codex')
    const file = join(dir, 'config.toml')
    const original = 'model = "o4"\n\n[mcp_servers.github]\ncommand = "gh"\n'
    await writeFile(file, original)
    const write = await writeAgentConfig(target('codex', file), CONNECTION, 'darwin', {
      now: () => NOW
    })
    expect(write.outcome).toBe('added')
    expect(await readFile(file, 'utf8')).toBe(
      `${original}\n${agentCodexTomlLines(CONNECTION).join('\n')}\n`
    )
    expect(await backups(dir)).toEqual(['config.toml.videorc-backup-20261027-221530'])
  })

  it('refuses TOML it cannot place, and logs why without the token', async () => {
    const dir = await folder('.codex')
    const file = join(dir, 'config.toml')
    await writeFile(file, '[mcp_servers]\nvideorc = { command = "x" }\n')
    const log = vi.fn()
    const write = await writeAgentConfig(target('codex', file), CONNECTION, 'darwin', { log })
    expect(write).toEqual({ outcome: 'refused', file, reason: 'unsafe-toml' })
    expect(log).toHaveBeenCalledOnce()
    expect(String(log.mock.calls[0][0])).not.toContain(TOKEN)
  })
})

describe('what the dialog says (plan 209 S22)', () => {
  it('names the app and the next step', () => {
    const file = '/Users/ana/.cursor/mcp.json'
    expect(
      agentConfigWriteMessage('claude-desktop', { outcome: 'added', file, backup: null })
    ).toBe('Added. Restart Claude Desktop to see Videorc.')
    expect(agentConfigWriteMessage('codex', { outcome: 'unchanged', file })).toBe(
      'Added. Restart Codex to see Videorc.'
    )
    expect(
      agentConfigWriteMessage('cursor', { outcome: 'refused', file, reason: 'not-json' })
    ).toBe("Cursor's mcp.json isn't plain JSON, so Videorc left it alone. Copy the line instead.")
    expect(agentConfigWriteMessage('vs-code', { outcome: 'refused', file, reason: 'no-app' })).toBe(
      "Videorc can't find VS Code's settings folder on this computer. Open VS Code once, or copy the line instead."
    )
    expect(
      agentConfigWriteMessage('codex', {
        outcome: 'refused',
        file: 'C:\\Users\\Ana\\.codex\\config.toml',
        reason: 'unsafe-toml'
      })
    ).toBe(
      "Videorc couldn't safely edit Codex's config.toml, so it left it alone. Copy the line instead."
    )
    expect(agentConfigWriteMessage('cursor', { outcome: 'failed', file })).toBe(
      "Couldn't add Videorc to Cursor. Copy the line instead."
    )
  })

  it('names the backup by the UTC second', () => {
    expect(backupStamp(NOW)).toBe('20261027-221530')
  })
})

describe('Claude Code through the claude CLI (plan 209 S22)', () => {
  const mac = { platform: 'darwin' as const, homeDir: '/Users/ana', pathVariable: '/usr/bin:/bin' }

  it("looks on the PATH, then in the installers' folders a Finder-opened app's PATH lacks", () => {
    expect(claudeCliCandidates(mac)).toEqual([
      '/usr/bin/claude',
      '/bin/claude',
      '/Users/ana/.local/bin/claude',
      '/Users/ana/.claude/local/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude'
    ])
    // Windows: claude.exe only (a .cmd needs a shell), relative entries ignored.
    expect(
      claudeCliCandidates({
        platform: 'win32',
        homeDir: 'C:\\Users\\Ana',
        pathVariable: 'C:\\Tools;relative;C:\\Users\\Ana\\.local\\bin'
      })
    ).toEqual(['C:\\Tools\\claude.exe', 'C:\\Users\\Ana\\.local\\bin\\claude.exe'])
  })

  it('removes an earlier videorc, then adds it for every project, with no shell', async () => {
    const calls: Array<{ file: string; args: string[]; path: string | undefined }> = []
    const execFile: ExecFile = vi.fn(async (file, args, options) => {
      calls.push({ file, args, path: options.env.PATH })
      expect(options.timeout).toBeGreaterThan(0)
      if (args[1] === 'remove') throw new Error('No MCP server named videorc')
      return { stdout: 'Added stdio MCP server videorc', stderr: '' }
    })
    const access = vi.fn(async (path: string) => {
      if (path !== '/Users/ana/.local/bin/claude') throw new Error('ENOENT')
    })
    const install = await addToClaudeCode(CONNECTION, mac, {
      execFile,
      fs: { access },
      baseEnv: { HOME: '/Users/ana' }
    })
    expect(install).toEqual({ outcome: 'added', cli: '/Users/ana/.local/bin/claude' })
    expect(calls.map((call) => call.args)).toEqual([
      ['mcp', 'remove', '--scope', 'user', 'videorc'],
      [
        'mcp',
        'add',
        '--scope',
        'user',
        'videorc',
        '--env',
        `VIDEORC_AGENT_TOKEN=${TOKEN}`,
        '--',
        MAC
      ]
    ])
    expect(calls[1].file).toBe('/Users/ana/.local/bin/claude')
    // Its own folder first on the PATH, so a script's `node` resolves.
    expect(calls[1].path?.split(':')[0]).toBe('/Users/ana/.local/bin')
    expect(calls[1].path).toContain('/opt/homebrew/bin')
    expect(claudeCodeInstallMessage(install)).toBe(
      'Added. Start a new Claude Code session to see Videorc.'
    )
  })

  it('says to run the line when there is no claude command, and runs nothing', async () => {
    const execFile = vi.fn()
    const install = await addToClaudeCode(CONNECTION, mac, {
      execFile,
      fs: { access: async () => Promise.reject(new Error('ENOENT')) }
    })
    expect(install).toEqual({ outcome: 'no-cli' })
    expect(execFile).not.toHaveBeenCalled()
    expect(claudeCodeInstallMessage(install)).toBe(
      "Videorc can't find Claude Code's claude command on this computer. Run the line in a terminal instead."
    )
  })

  it('says to run the line when the CLI fails or times out, and never logs the token', async () => {
    const log = vi.fn()
    const execFile: ExecFile = async (_file, args) => {
      if (args[1] === 'remove') return { stdout: '', stderr: '' }
      throw Object.assign(new Error(`Command failed: claude ${args.join(' ')}`), {
        killed: true,
        stderr: 'Invalid configuration'
      })
    }
    const install = await addToClaudeCode(CONNECTION, mac, {
      execFile,
      log,
      fs: { access: async () => undefined }
    })
    expect(install).toEqual({ outcome: 'failed', cli: '/usr/bin/claude' })
    expect(claudeCodeInstallMessage(install)).toBe(
      "Claude Code didn't add Videorc. Run the line in a terminal instead."
    )
    expect(log).toHaveBeenCalledWith(
      "claude mcp add didn't finish (timed out): Invalid configuration"
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
  })
})

describe('addAgentToApp (plan 209 S22)', () => {
  it('writes the config for a config app, and reports a refusal as not added', async () => {
    await folder('Library', 'Application Support', 'Claude')
    const environment = { platform: 'darwin' as const, homeDir: root, pathVariable: '' }
    const added = await addAgentToApp('claude-desktop', CONNECTION, environment)
    expect(added).toEqual({ added: true, message: 'Added. Restart Claude Desktop to see Videorc.' })
    const refused = await addAgentToApp('cursor', CONNECTION, environment)
    expect(refused.added).toBe(false)
    expect(refused.message).toContain("Videorc can't find Cursor's settings folder")
  })

  it('runs the CLI for Claude Code', async () => {
    const execFile: ExecFile = async () => ({ stdout: '', stderr: '' })
    const result = await addAgentToApp(
      'claude-code',
      CONNECTION,
      { platform: 'darwin', homeDir: root, pathVariable: '/usr/bin' },
      { execFile, fs: { ...nodeAgentConfigFs, access: async () => undefined } }
    )
    expect(result).toEqual({
      added: true,
      message: 'Added. Start a new Claude Code session to see Videorc.'
    })
  })
})
