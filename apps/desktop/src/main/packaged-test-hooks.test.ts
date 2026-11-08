import { describe, expect, it } from 'vitest'

import {
  PACKAGED_TEST_HOOK_ENV_NAMES,
  buildAllowsPackagedTestHooks,
  ignoreInspectorSignal,
  packagedTestHooksAllowed,
  packagedTestHooksBuildEnabled,
  refusePackagedTestHooks
} from './packaged-test-hooks'

function commandLine(switches: string[]) {
  const present = new Set(switches)
  return {
    present,
    hasSwitch: (name: string) => present.has(name),
    removeSwitch: (name: string) => {
      present.delete(name)
    }
  }
}

function hookEnv(): NodeJS.ProcessEnv {
  return {
    VIDEORC_REMOTE_DEBUG_PORT: '0',
    VIDEORC_NATIVE_PREVIEW_HOST_MODULE: '/tmp/evil.node',
    VIDEORC_NATIVE_PREVIEW_IN_PROCESS_MODULE: '/tmp/evil.node',
    VIDEORC_NATIVE_PREVIEW_HOST_HELPER: '/tmp/evil',
    VIDEORC_USER_DATA_DIR: '/tmp/profile',
    PATH: '/usr/bin'
  }
}

describe('packaged test hooks', () => {
  it('a release build drops the CDP port, module overrides and DevTools switches', () => {
    const env = hookEnv()
    const switches = commandLine(['remote-debugging-port', 'remote-debugging-pipe', 'disable-gpu'])
    const refused = refusePackagedTestHooks(env, switches, {
      isPackaged: true,
      buildAllowsTestHooks: false
    })
    expect(refused).toEqual([
      ...PACKAGED_TEST_HOOK_ENV_NAMES,
      '--remote-debugging-port',
      '--remote-debugging-pipe'
    ])
    expect(env).toEqual({ VIDEORC_USER_DATA_DIR: '/tmp/profile', PATH: '/usr/bin' })
    expect([...switches.present]).toEqual(['disable-gpu'])
  })

  it('a release build with no hooks set refuses nothing', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    expect(
      refusePackagedTestHooks(env, commandLine([]), {
        isPackaged: true,
        buildAllowsTestHooks: false
      })
    ).toEqual([])
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('development runs and packaged test builds keep every hook', () => {
    for (const options of [
      { isPackaged: false, buildAllowsTestHooks: false },
      { isPackaged: true, buildAllowsTestHooks: true }
    ]) {
      const env = hookEnv()
      const switches = commandLine(['remote-debugging-port'])
      expect(packagedTestHooksAllowed(options)).toBe(true)
      expect(refusePackagedTestHooks(env, switches, options)).toEqual([])
      expect(env).toEqual(hookEnv())
      expect(switches.present.has('remote-debugging-port')).toBe(true)
    }
  })

  it('only VIDEORC_PACKAGED_TEST_HOOKS=1 makes a test build', () => {
    expect(packagedTestHooksBuildEnabled({ VIDEORC_PACKAGED_TEST_HOOKS: '1' })).toBe(true)
    expect(packagedTestHooksBuildEnabled({ VIDEORC_PACKAGED_TEST_HOOKS: ' 1 ' })).toBe(true)
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      expect(packagedTestHooksBuildEnabled({ VIDEORC_PACKAGED_TEST_HOOKS: value })).toBe(false)
    }
  })

  it('an unbundled main process (vitest) is not a test build', () => {
    expect(buildAllowsPackagedTestHooks()).toBe(false)
  })

  it('a packaged build on macOS or Linux survives SIGUSR1 instead of dying', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const listeners: string[] = []
      const target = { on: (signal: string) => listeners.push(signal) }
      expect(ignoreInspectorSignal(target, { isPackaged: true, platform }, () => {})).toBe(true)
      expect(listeners).toEqual(['SIGUSR1'])
    }
    for (const options of [
      { isPackaged: false, platform: 'linux' as const },
      { isPackaged: true, platform: 'win32' as const }
    ]) {
      const listeners: string[] = []
      const target = { on: (signal: string) => listeners.push(signal) }
      expect(ignoreInspectorSignal(target, options, () => {})).toBe(false)
      expect(listeners).toEqual([])
    }
  })
})
