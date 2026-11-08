import { describe, expect, it, vi } from 'vitest'

import {
  AGENT_BRIDGE_APP_POINTER,
  agentBridgeUsesCopy,
  bundledAgentBridgePath,
  installAgentBridgeCopy,
  linuxAgentBridgeCopyPath,
  refreshAgentBridgeCopy,
  resolveAgentBridge,
  windowsAgentBridgeCopyPath,
  type AgentBridgeFs,
  type AgentBridgeLocation
} from './agent-bridge'

// Plan 209 S7 (D6, D20): the path a config line names. macOS points at the
// app's own copy; Linux copies it out of the AppImage and Windows out of the
// install (review #8), and both refresh that copy after an update;
// development uses the cargo build.

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
  homeDir: 'C:\\Users\\Ana',
  localAppData: 'C:\\Users\\Ana\\AppData\\Local',
  appExecutable: 'D:\\Apps\\Videorc\\Videorc.exe'
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
    rm: vi.fn(async (path: string) => void store.delete(path)),
    writeFile: vi.fn(async (path: string, text: string) => void store.set(path, Buffer.from(text)))
  }
  return { fs, store }
}

describe('the agent bridge path (plan 209 S7, D20)', () => {
  it("points macOS at the app's own bridge, and Windows at a copy outside the install", () => {
    expect(bundledAgentBridgePath(MAC)).toBe(
      '/Applications/Videorc.app/Contents/Resources/videorc-mcp'
    )
    expect(bundledAgentBridgePath(WINDOWS)).toBe(
      'C:\\Users\\Ana\\AppData\\Local\\Programs\\Videorc\\resources\\videorc-mcp.exe'
    )
    expect(agentBridgeUsesCopy(MAC)).toBe(false)
    expect(agentBridgeUsesCopy(WINDOWS)).toBe(true)
    expect(agentBridgeUsesCopy({ ...WINDOWS, packaged: false })).toBe(false)
    expect(windowsAgentBridgeCopyPath('C:\\Users\\Ana', 'E:\\Local')).toBe(
      'E:\\Local\\Videorc\\bin\\videorc-mcp.exe'
    )
    // %LOCALAPPDATA% unset: the profile's own.
    expect(windowsAgentBridgeCopyPath('C:\\Users\\Ana')).toBe(
      'C:\\Users\\Ana\\AppData\\Local\\Videorc\\bin\\videorc-mcp.exe'
    )
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

  it('copies the Windows bridge out of the install on Connect and names Videorc beside it', async () => {
    const bundled = bundledAgentBridgePath(WINDOWS)
    const copy = 'C:\\Users\\Ana\\AppData\\Local\\Videorc\\bin\\videorc-mcp.exe'
    const pointer = `C:\\Users\\Ana\\AppData\\Local\\Videorc\\bin\\${AGENT_BRIDGE_APP_POINTER}`
    const { fs, store } = memoryFs({ [bundled]: 'v1' })

    await expect(resolveAgentBridge(WINDOWS, false, fs)).resolves.toEqual({
      path: copy,
      exists: true
    })
    expect(store.has(copy)).toBe(false)

    await expect(resolveAgentBridge(WINDOWS, true, fs)).resolves.toEqual({
      path: copy,
      exists: true
    })
    expect(store.get(copy)?.toString()).toBe('v1')
    // The folder from the Windows path, not a POSIX reading of it.
    expect(fs.mkdir).toHaveBeenCalledWith('C:\\Users\\Ana\\AppData\\Local\\Videorc\\bin', {
      recursive: true,
      mode: 0o755
    })
    expect(store.get(pointer)?.toString()).toBe('D:\\Apps\\Videorc\\Videorc.exe\r\n')

    // After an update: refreshed, and the pointer rewritten only when it moved.
    store.set(bundled, Buffer.from('v2'))
    await expect(refreshAgentBridgeCopy(WINDOWS, fs)).resolves.toBe('installed')
    expect(store.get(copy)?.toString()).toBe('v2')
    expect(fs.writeFile).toHaveBeenCalledTimes(1)
    await refreshAgentBridgeCopy({ ...WINDOWS, appExecutable: 'E:\\Videorc\\Videorc.exe' }, fs)
    expect(store.get(pointer)?.toString()).toBe('E:\\Videorc\\Videorc.exe\r\n')
  })

  it('moves a Windows copy an agent app is running aside, or keeps it and says busy', async () => {
    const bundled = bundledAgentBridgePath(WINDOWS)
    const copy = 'C:\\Users\\Ana\\AppData\\Local\\Videorc\\bin\\videorc-mcp.exe'
    const running = (path: string): boolean => path === copy
    const busy = (): Error => Object.assign(new Error('EPERM'), { code: 'EPERM' })

    // Windows won't replace a running .exe but renames one: the running copy
    // moves aside, the new one takes its name.
    const swap = memoryFs({ [bundled]: 'v2', [copy]: 'v1' })
    const rename = swap.fs.rename
    swap.fs.rename = vi.fn(async (from: string, to: string) => {
      if (running(to) && swap.store.has(to)) throw busy()
      return rename(from, to)
    })
    // The aside copy is still running, so removing it fails quietly.
    swap.fs.rm = vi.fn(async (path: string) => {
      if (path === `${copy}.old`) throw busy()
      swap.store.delete(path)
    })
    await expect(refreshAgentBridgeCopy(WINDOWS, swap.fs)).resolves.toBe('installed')
    expect(swap.store.get(copy)?.toString()).toBe('v2')
    expect(swap.store.get(`${copy}.old`)?.toString()).toBe('v1')
    expect([...swap.store.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)

    // Neither replace nor rename: the old copy stays and still runs.
    const stuck = memoryFs({ [bundled]: 'v2', [copy]: 'v1' })
    stuck.fs.rename = vi.fn(async () => {
      throw busy()
    })
    await expect(refreshAgentBridgeCopy(WINDOWS, stuck.fs)).resolves.toBe('busy')
    expect(stuck.store.get(copy)?.toString()).toBe('v1')
    expect([...stuck.store.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)
    // Connect still names the old copy, which works.
    await expect(resolveAgentBridge(WINDOWS, true, stuck.fs)).resolves.toEqual({
      path: copy,
      exists: true
    })

    // The same error elsewhere is a real failure.
    const linux = memoryFs({ '/b': 'v2', '/c': 'v1' })
    linux.fs.rename = vi.fn(async () => {
      throw busy()
    })
    await expect(installAgentBridgeCopy('/b', '/c', linux.fs, 7, 'linux')).rejects.toThrow('EPERM')
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
