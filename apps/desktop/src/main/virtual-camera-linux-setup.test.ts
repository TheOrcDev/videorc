import { describe, expect, it } from 'vitest'

import {
  LOAD_MODULE_ARGS,
  LOAD_MODULE_TERMINAL_LINE,
  LOAD_MODULE_TIMEOUT_MS,
  PKEXEC,
  STDERR_DETAIL_MAX,
  classifyLoadModuleRun,
  createLinuxModuleLoader,
  runLinuxLoadModule,
  type LoadModuleRun
} from './virtual-camera-linux-setup'

function run(overrides: Partial<LoadModuleRun> = {}): LoadModuleRun {
  return {
    spawnErrorCode: null,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderr: '',
    ...overrides
  }
}

describe('the modprobe argv', () => {
  it('is one array with the shared label and number, and no shell quoting', () => {
    expect(LOAD_MODULE_ARGS).toEqual([
      'modprobe',
      'v4l2loopback',
      'exclusive_caps=1',
      'card_label=Videorc Camera',
      'video_nr=42'
    ])
    expect(Object.isFrozen(LOAD_MODULE_ARGS)).toBe(true)
    for (const arg of LOAD_MODULE_ARGS) {
      expect(arg).not.toMatch(/["';&|]/)
    }
    expect(PKEXEC).toBe('pkexec')
    expect(LOAD_MODULE_TERMINAL_LINE).toBe(
      'sudo modprobe v4l2loopback exclusive_caps=1 card_label="Videorc Camera" video_nr=42'
    )
    expect(LOAD_MODULE_TIMEOUT_MS).toBe(120_000)
  })
})

describe('classifyLoadModuleRun', () => {
  it('a clean exit is loaded with nothing to say', () => {
    expect(classifyLoadModuleRun(run())).toEqual({ ok: true, outcome: 'loaded' })
  })

  it('names a missing pkexec with the terminal fallback', () => {
    expect(classifyLoadModuleRun(run({ spawnErrorCode: 'ENOENT', exitCode: null }))).toEqual({
      ok: false,
      outcome: 'no-pkexec',
      message: expect.stringContaining('sudo modprobe v4l2loopback exclusive_caps=1')
    })
    expect(classifyLoadModuleRun(run({ spawnErrorCode: 'EACCES', exitCode: null }))).toMatchObject({
      ok: false,
      outcome: 'failed',
      message: expect.stringContaining('EACCES')
    })
  })

  it('a dismissed dialog is cancelled, a refused one is not authorized', () => {
    expect(classifyLoadModuleRun(run({ exitCode: 126 }))).toEqual({
      ok: false,
      outcome: 'cancelled',
      message: 'Loading was cancelled. Choose Load module to try again.'
    })
    expect(
      classifyLoadModuleRun(
        run({
          exitCode: 127,
          stderr: 'Error executing command as another user: Not authorized\n'
        })
      )
    ).toMatchObject({ ok: false, outcome: 'not-authorized' })
  })

  it('reads a missing module and a Secure Boot refusal from stderr', () => {
    expect(
      classifyLoadModuleRun(
        run({
          exitCode: 1,
          stderr:
            'modprobe: FATAL: Module v4l2loopback not found in directory /lib/modules/6.8.0-45-generic\n'
        })
      )
    ).toMatchObject({
      ok: false,
      outcome: 'not-installed',
      message: expect.stringContaining('not installed for this kernel')
    })
    expect(
      classifyLoadModuleRun(
        run({
          exitCode: 1,
          stderr: "modprobe: ERROR: could not insert 'v4l2loopback': Key was rejected by service\n"
        })
      )
    ).toMatchObject({
      ok: false,
      outcome: 'secure-boot',
      message: expect.stringContaining('Machine Owner Key (MOK)')
    })
    expect(
      classifyLoadModuleRun(
        run({
          exitCode: 1,
          stderr: "modprobe: ERROR: could not insert 'v4l2loopback': Required key not available\n"
        })
      )
    ).toMatchObject({ outcome: 'secure-boot' })
  })

  it('a timeout, a signal and anything else say what happened', () => {
    expect(
      classifyLoadModuleRun(run({ exitCode: null, signal: 'SIGTERM', timedOut: true }))
    ).toMatchObject({ ok: false, outcome: 'timed-out' })
    expect(classifyLoadModuleRun(run({ exitCode: null, signal: 'SIGKILL' }))).toMatchObject({
      ok: false,
      outcome: 'failed',
      message: 'pkexec ended by SIGKILL. Choose Load module to try again.'
    })
    expect(
      classifyLoadModuleRun(
        run({
          exitCode: 1,
          stderr: "modprobe: ERROR: could not insert 'v4l2loopback': Invalid argument\nsee dmesg\n"
        })
      )
    ).toEqual({
      ok: false,
      outcome: 'failed',
      message: 'modprobe failed: see dmesg'
    })
    expect(classifyLoadModuleRun(run({ exitCode: 3 }))).toMatchObject({
      outcome: 'failed',
      message: expect.stringContaining('modprobe exited with 3')
    })
  })

  it('caps a long stderr line so the message fits the IPC contract (512)', () => {
    const long = `modprobe: ERROR: ${'x'.repeat(2000)}`
    const result = classifyLoadModuleRun(run({ exitCode: 1, stderr: `${long}\n` }))
    expect(result.outcome).toBe('failed')
    expect(result.message?.startsWith('modprobe failed: modprobe: ERROR: x')).toBe(true)
    expect(result.message?.endsWith('…')).toBe(true)
    expect(result.message?.length).toBeLessThanOrEqual(
      'modprobe failed: '.length + STDERR_DETAIL_MAX
    )
    expect(result.message?.length).toBeLessThanOrEqual(512)
  })
})

describe('createLinuxModuleLoader', () => {
  it('runs pkexec with the argv and the timeout, and logs the outcome', async () => {
    const calls: { file: string; args: string[]; timeout: number }[] = []
    const lines: string[] = []
    const loader = createLinuxModuleLoader({
      platform: 'linux',
      exec: async (file, args, options) => {
        calls.push({ file, args, timeout: options.timeout })
        return run()
      },
      log: (line) => lines.push(line)
    })
    expect(await loader.load()).toEqual({ ok: true, outcome: 'loaded' })
    expect(calls).toEqual([
      {
        file: 'pkexec',
        args: [
          'modprobe',
          'v4l2loopback',
          'exclusive_caps=1',
          'card_label=Videorc Camera',
          'video_nr=42'
        ],
        timeout: 120_000
      }
    ])
    expect(lines).toEqual([
      'Videorc Camera: pkexec modprobe v4l2loopback exclusive_caps=1 card_label=Videorc Camera video_nr=42',
      'Videorc Camera: v4l2loopback load loaded'
    ])
  })

  it('joins a load already running, then runs again', async () => {
    let started = 0
    let release: (() => void) | null = null
    const loader = createLinuxModuleLoader({
      platform: 'linux',
      exec: () =>
        new Promise((resolve) => {
          started += 1
          release = () => resolve(run({ exitCode: 126 }))
        })
    })
    const first = loader.load()
    const second = loader.load()
    expect(second).toBe(first)
    expect(started).toBe(1)
    release!()
    expect((await first).outcome).toBe('cancelled')
    const third = loader.load()
    expect(third).not.toBe(first)
    expect(started).toBe(2)
    release!()
    await third
  })

  it('refuses off Linux without running anything', async () => {
    let ran = false
    const loader = createLinuxModuleLoader({
      platform: 'darwin',
      exec: async () => {
        ran = true
        return run()
      }
    })
    expect(await loader.load()).toEqual({
      ok: false,
      outcome: 'not-linux',
      message: "Videorc Camera's module load runs on Linux only."
    })
    expect(ran).toBe(false)
  })

  it('runLinuxLoadModule has the plain shape and refuses on this host when it is not Linux', async () => {
    if (process.platform === 'linux') return
    const result = await runLinuxLoadModule()
    expect(result.ok).toBe(false)
    expect(typeof result.message).toBe('string')
  })
})
