import { describe, expect, it, vi } from 'vitest'

import {
  agentBridgeUsesCopy,
  bundledAgentBridgePath,
  installAgentBridgeCopy,
  linuxAgentBridgeCopyPath,
  refreshAgentBridgeCopy,
  resolveAgentBridge,
  type AgentBridgeFs,
  type AgentBridgeLocation
} from './agent-bridge'

// Plan 209 S7 (D6, D20): the path a config line names. macOS and Windows
// point at the app's own copy; Linux copies it out of the AppImage and
// refreshes that copy after an update; development uses the cargo build.

const MAC: AgentBridgeLocation = {
  packaged: true,
  platform: 'darwin',
  resourcesPath: '/Applications/Videorc.app/Contents/Resources',
  workspaceRoot: '/Applications/Videorc.app/Contents',
  cargoProfile: 'debug',
  homeDir: '/Users/ana'
}
const WINDOWS: AgentBridgeLocation = {
  packaged: true,
  platform: 'win32',
  resourcesPath: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Videorc\\resources',
  workspaceRoot: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Videorc',
  cargoProfile: 'debug',
  homeDir: 'C:\\Users\\Ana'
}
const LINUX: AgentBridgeLocation = {
  packaged: true,
  platform: 'linux',
  resourcesPath: '/tmp/.mount_VideorcAbc123/resources',
  workspaceRoot: '/tmp/.mount_VideorcAbc123',
  cargoProfile: 'debug',
  homeDir: '/home/ana'
}

/** A file system of names to bytes; every listed file is runnable. */
function memoryFs(files: Record<string, string>) {
  const store = new Map(Object.entries(files).map(([path, body]) => [path, Buffer.from(body)]))
  const fs: AgentBridgeFs = {
    access: vi.fn(async (path: string) => {
      if (!store.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    readFile: vi.fn(async (path: string) => {
      const body = store.get(path)
      if (!body) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return body
    }),
    mkdir: vi.fn(async () => undefined),
    copyFile: vi.fn(async (from: string, to: string) => {
      const body = store.get(from)
      if (!body) throw new Error('ENOENT')
      store.set(to, body)
    }),
    chmod: vi.fn(async () => undefined),
    rename: vi.fn(async (from: string, to: string) => {
      store.set(to, store.get(from)!)
      store.delete(from)
    }),
    rm: vi.fn(async (path: string) => void store.delete(path))
  }
  return { fs, store }
}

describe('the agent bridge path (plan 209 S7, D20)', () => {
  it("points macOS and Windows at the app's own bridge", () => {
    expect(bundledAgentBridgePath(MAC)).toBe(
      '/Applications/Videorc.app/Contents/Resources/videorc-mcp'
    )
    expect(bundledAgentBridgePath(WINDOWS)).toBe(
      'C:\\Users\\Ana\\AppData\\Local\\Programs\\Videorc\\resources\\videorc-mcp.exe'
    )
    expect(agentBridgeUsesCopy(MAC)).toBe(false)
    expect(agentBridgeUsesCopy(WINDOWS)).toBe(false)
  })

  it("points development at the repo's cargo build", () => {
    expect(
      bundledAgentBridgePath({
        ...MAC,
        packaged: false,
        workspaceRoot: '/repo',
        cargoProfile: 'debug'
      })
    ).toBe('/repo/target/debug/videorc-mcp')
    expect(agentBridgeUsesCopy({ ...LINUX, packaged: false, workspaceRoot: '/repo' })).toBe(false)
  })

  it('reports a missing bridge without writing anything', async () => {
    const { fs } = memoryFs({})
    await expect(resolveAgentBridge(MAC, true, fs)).resolves.toEqual({
      path: '/Applications/Videorc.app/Contents/Resources/videorc-mcp',
      exists: false
    })
    expect(fs.copyFile).not.toHaveBeenCalled()
  })

  it('names the stable Linux copy, and writes it only on Connect', async () => {
    const bundled = bundledAgentBridgePath(LINUX)
    const copy = linuxAgentBridgeCopyPath('/home/ana')
    expect(copy).toBe('/home/ana/.local/share/videorc/bin/videorc-mcp')
    const { fs, store } = memoryFs({ [bundled]: 'v1' })

    await expect(resolveAgentBridge(LINUX, false, fs)).resolves.toEqual({
      path: copy,
      exists: true
    })
    expect(store.has(copy)).toBe(false)

    await expect(resolveAgentBridge(LINUX, true, fs)).resolves.toEqual({ path: copy, exists: true })
    expect(store.get(copy)?.toString()).toBe('v1')
    expect(fs.chmod).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), 0o755)
    // Renamed over, never written in place: a running agent keeps its file.
    expect(fs.rename).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), copy)
  })

  it('refreshes the Linux copy after an update, and leaves a current or absent one alone', async () => {
    const bundled = bundledAgentBridgePath(LINUX)
    const copy = linuxAgentBridgeCopyPath('/home/ana')

    const none = memoryFs({ [bundled]: 'v2' })
    await expect(refreshAgentBridgeCopy(LINUX, none.fs)).resolves.toBe('skipped')
    expect(none.store.has(copy)).toBe(false)

    const old = memoryFs({ [bundled]: 'v2', [copy]: 'v1' })
    await expect(refreshAgentBridgeCopy(LINUX, old.fs)).resolves.toBe('installed')
    expect(old.store.get(copy)?.toString()).toBe('v2')

    const current = memoryFs({ [bundled]: 'v2', [copy]: 'v2' })
    await expect(refreshAgentBridgeCopy(LINUX, current.fs)).resolves.toBe('current')
    expect(current.fs.copyFile).not.toHaveBeenCalled()

    await expect(refreshAgentBridgeCopy(MAC, current.fs)).resolves.toBe('skipped')
  })

  it('cleans up its staging file when the copy fails', async () => {
    const { fs, store } = memoryFs({ '/b': 'v1' })
    fs.chmod = vi.fn(async () => {
      throw new Error('EPERM')
    })
    await expect(installAgentBridgeCopy('/b', '/c', fs, 42)).rejects.toThrow('EPERM')
    expect(store.has('/c.42.tmp')).toBe(false)
    expect(store.has('/c')).toBe(false)
  })
})
