import { describe, expect, it } from 'vitest'

import { agentCodexTomlLines } from '../shared/agent-config-entry'
import { mergeCodexToml } from './agent-config-toml'

// Plan 209 S22: Codex's config.toml gets `[mcp_servers.videorc]` added or
// replaced, and every other byte stays; anything uncertain is refused.

const TOKEN = `vrc_agent_${'ab12'.repeat(16)}`
const MAC = '/Applications/Videorc.app/Contents/Resources/videorc-mcp'
const TABLE = agentCodexTomlLines({ bridgePath: MAC, token: TOKEN })
const OLD_TABLE = agentCodexTomlLines({ bridgePath: '/old/videorc-mcp', token: 'vrc_agent_old' })

const merge = (existing: string | null): ReturnType<typeof mergeCodexToml> =>
  mergeCodexToml(existing, TABLE, 'videorc')

const text = (result: ReturnType<typeof mergeCodexToml>): string => {
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result.text
}

describe('mergeCodexToml (plan 209 S22)', () => {
  it('writes the table alone into a missing or empty file', () => {
    expect(text(merge(null))).toBe(`${TABLE.join('\n')}\n`)
    expect(text(merge('  \n'))).toBe(`${TABLE.join('\n')}\n`)
  })

  it('appends after everything else, leaving it byte for byte', () => {
    const existing = [
      'model = "o4"',
      '',
      '[mcp_servers.github]',
      'command = "gh-mcp"',
      'env = { GITHUB_TOKEN = "secret" }',
      ''
    ].join('\n')
    const merged = text(merge(existing))
    expect(merged.startsWith(existing)).toBe(true)
    expect(merged).toBe(`${existing}\n${TABLE.join('\n')}\n`)
    // No final newline: one is added before the blank separator.
    expect(text(merge('model = "o4"'))).toBe(`model = "o4"\n\n${TABLE.join('\n')}\n`)
  })

  it('replaces the old table in place and keeps the comment that belongs to the next one', () => {
    const existing = [
      'model = "o4"',
      '',
      '[mcp_servers.videorc]',
      'command = "/old/videorc-mcp"',
      '# my own note inside',
      'args = [',
      '  "--old",',
      ']',
      'startup_timeout_sec = 30',
      '',
      '# GitHub, for work',
      '[mcp_servers.github]',
      'command = "gh-mcp"',
      ''
    ].join('\n')
    expect(text(merge(existing))).toBe(
      [
        'model = "o4"',
        '',
        ...TABLE,
        '',
        '# GitHub, for work',
        '[mcp_servers.github]',
        'command = "gh-mcp"',
        ''
      ].join('\n')
    )
  })

  it('removes a videorc sub-table wherever it is, and leaves a similar name alone', () => {
    const existing = [
      ...OLD_TABLE.slice(0, 3),
      '',
      '[mcp_servers.videorc-old]',
      'command = "keep-me"',
      '',
      '[mcp_servers.videorc.env]',
      'VIDEORC_AGENT_TOKEN = "vrc_agent_old"',
      '',
      '[profiles.fast]',
      'model = "o4-mini"'
    ].join('\n')
    expect(text(merge(existing))).toBe(
      [
        ...TABLE,
        '',
        '[mcp_servers.videorc-old]',
        'command = "keep-me"',
        '',
        '',
        '[profiles.fast]',
        'model = "o4-mini"'
      ].join('\n')
    )
  })

  it('finds quoted and spaced headers, and says unchanged when the table is already there', () => {
    const quoted = ['[ mcp_servers . "videorc" ]', 'command = "/old"', ''].join('\n')
    expect(text(merge(quoted))).toBe(`${TABLE.join('\n')}\n`)
    const literal = ["['mcp_servers'.'videorc']", 'command = "/old"'].join('\n')
    expect(text(merge(literal))).toBe(TABLE.join('\n'))
    const current = `model = "o4"\n\n${TABLE.join('\n')}\n`
    expect(merge(current)).toEqual({ ok: true, text: current, changed: false })
  })

  it('never reads a header inside a string or a multi-line array', () => {
    const existing = [
      'notes = """',
      '[mcp_servers.videorc]',
      'command = "inside a string"',
      '"""',
      "literal = '''",
      '[mcp_servers.videorc]',
      "'''",
      'matrix = [',
      '  [1],',
      '  [2]',
      ']',
      'url = "https://example.com/#[mcp_servers.videorc]" # a comment [x]',
      ''
    ].join('\n')
    const merged = text(merge(existing))
    expect(merged).toBe(`${existing}\n${TABLE.join('\n')}\n`)
  })

  it('keeps Windows line endings and a byte order mark', () => {
    const existing = '\uFEFFmodel = "o4"\r\n\r\n[mcp_servers.videorc]\r\ncommand = "/old"\r\n'
    expect(text(merge(existing))).toBe(`\uFEFFmodel = "o4"\r\n\r\n${TABLE.join('\r\n')}\r\n`)
  })

  it('escapes a Windows bridge path so it reads back as the same path', () => {
    const windows =
      'C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Videorc\\resources\\videorc-mcp.exe'
    const lines = agentCodexTomlLines({ bridgePath: windows, token: TOKEN })
    expect(lines[1]).toBe(
      'command = "C:\\\\Users\\\\Ana Lee\\\\AppData\\\\Local\\\\Programs\\\\Videorc\\\\resources\\\\videorc-mcp.exe"'
    )
    expect(text(mergeCodexToml('', lines, 'videorc'))).toContain(lines[1])
  })

  it.each([
    ['dotted keys at the root', 'mcp_servers.videorc.command = "x"\n'],
    ['an inline videorc table', '[mcp_servers]\nvideorc = { command = "x" }\n'],
    ['dotted videorc keys in [mcp_servers]', '[mcp_servers]\nvideorc.command = "x"\n'],
    ['mcp_servers as an inline table', 'mcp_servers = { github = { command = "gh" } }\n'],
    ['an array of videorc tables', '[[mcp_servers.videorc]]\ncommand = "x"\n'],
    ['the table twice', '[mcp_servers.videorc]\na = 1\n[mcp_servers.videorc]\nb = 2\n'],
    ['an unterminated multi-line string', 'notes = """\nnever closed\n'],
    ['an unterminated array', 'args = [\n "a",\n'],
    ['an unterminated string', 'name = "open\n'],
    ['a line that is not TOML', 'this is not toml\n'],
    ['a header with junk after it', '[mcp_servers.github] extra\n']
  ])('refuses %s', (_label, existing) => {
    const result = merge(existing)
    expect(result.ok).toBe(false)
  })

  it('accepts other servers written as dotted keys or inline tables', () => {
    const existing = '[mcp_servers]\ngithub = { command = "gh" }\n'
    expect(text(merge(existing))).toBe(`${existing}\n${TABLE.join('\n')}\n`)
    const dotted = 'mcp_servers.github.command = "gh"\n'
    expect(text(merge(dotted))).toBe(`${dotted}\n${TABLE.join('\n')}\n`)
  })
})
