import { describe, expect, it } from 'vitest'

import {
  WINDOWS_CAMERA_DLL_FILE_NAME,
  WINDOWS_CAMERA_SETUP_EXE_FILE_NAME,
  WINDOWS_CAMERA_SETUP_TIMEOUT_MS,
  quoteForPowerShell,
  runWindowsCameraSetup,
  windowsCameraSetupCommand,
  windowsCameraSetupResultFromRun,
  type WindowsCameraSetupEnvironment
} from './virtual-camera-windows-setup'

const RESOURCES = 'C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Videorc\\resources'

function environment(
  overrides: Partial<WindowsCameraSetupEnvironment> & {
    runs?: { file: string; args: string[]; timeoutMs: number }[]
  } = {}
): WindowsCameraSetupEnvironment & { runs: { file: string; args: string[]; timeoutMs: number }[] } {
  const runs = overrides.runs ?? []
  return {
    platform: 'win32',
    resourcesPath: RESOURCES,
    exists: () => true,
    run: async (file, args, timeoutMs) => {
      runs.push({ file, args, timeoutMs })
      return { code: 0, stdout: 'Videorc Camera is set up.', stderr: '' }
    },
    ...overrides,
    runs
  }
}

describe('windowsCameraSetupCommand', () => {
  it('elevates the setup exe through PowerShell and exits with its code', () => {
    const command = windowsCameraSetupCommand({
      exePath: `${RESOURCES}\\${WINDOWS_CAMERA_SETUP_EXE_FILE_NAME}`,
      dllPath: `${RESOURCES}\\${WINDOWS_CAMERA_DLL_FILE_NAME}`
    })
    expect(command.file).toBe('powershell.exe')
    expect(command.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command'
    ])
    const script = command.args[5]
    expect(script).toContain('-Verb RunAs -Wait -PassThru')
    expect(script).toContain(`-FilePath '${RESOURCES}\\${WINDOWS_CAMERA_SETUP_EXE_FILE_NAME}'`)
    expect(script).toContain(
      `@('/install', '/dll', '${RESOURCES}\\${WINDOWS_CAMERA_DLL_FILE_NAME}')`
    )
    expect(script.endsWith('exit $process.ExitCode')).toBe(true)
  })

  it('passes /remove for removal and quotes apostrophes', () => {
    const command = windowsCameraSetupCommand({
      exePath: "C:\\O'Brien\\setup.exe",
      dllPath: "C:\\O'Brien\\camera.dll",
      remove: true
    })
    const script = command.args[5]
    expect(script).toContain("-FilePath 'C:\\O''Brien\\setup.exe'")
    expect(script).toContain("@('/remove')")
    expect(script).not.toContain('/dll')
    expect(quoteForPowerShell("it's")).toBe("'it''s'")
  })
})

describe('windowsCameraSetupResultFromRun', () => {
  it('is ok on exit 0 and names a declined UAC prompt', () => {
    expect(windowsCameraSetupResultFromRun({ code: 0, stdout: '', stderr: '' })).toEqual({
      ok: true
    })
    const declined = windowsCameraSetupResultFromRun({
      code: 1,
      stdout: '',
      stderr:
        'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.'
    })
    expect(declined.ok).toBe(false)
    expect(declined.message).toBe(
      'Windows needs your permission to set up Videorc Camera. Try again and choose Yes in the prompt.'
    )
  })

  it("relays the exe's last line and a spawn failure", () => {
    const failed = windowsCameraSetupResultFromRun({
      code: 1,
      stdout: '',
      stderr: 'Videorc Camera setup failed: the media source DLL is missing: C:\\x\\y.dll\n'
    })
    expect(failed).toEqual({
      ok: false,
      message:
        'Could not set up Videorc Camera: Videorc Camera setup failed: the media source DLL is missing: C:\\x\\y.dll'
    })
    const spawn = windowsCameraSetupResultFromRun(
      { code: null, stdout: '', stderr: '', error: new Error('spawn powershell.exe ENOENT') },
      { remove: true }
    )
    expect(spawn).toEqual({
      ok: false,
      message: 'Could not remove Videorc Camera: spawn powershell.exe ENOENT'
    })
    expect(windowsCameraSetupResultFromRun({ code: 3, stdout: '', stderr: '' })).toEqual({
      ok: false,
      message: 'Could not set up Videorc Camera (exit code 3).'
    })
  })
})

describe('runWindowsCameraSetup', () => {
  it('runs the bundled exe elevated once and reports ok', async () => {
    const env = environment()
    const result = await runWindowsCameraSetup({ environment: env })
    expect(result).toEqual({ ok: true })
    expect(env.runs).toHaveLength(1)
    expect(env.runs[0].file).toBe('powershell.exe')
    expect(env.runs[0].timeoutMs).toBe(WINDOWS_CAMERA_SETUP_TIMEOUT_MS)
    expect(env.runs[0].args[5]).toContain(WINDOWS_CAMERA_SETUP_EXE_FILE_NAME)
    expect(env.runs[0].args[5]).toContain(WINDOWS_CAMERA_DLL_FILE_NAME)
  })

  it('refuses off Windows and when the bundle lacks the files, without running anything', async () => {
    const mac = environment({ platform: 'darwin' })
    expect(await runWindowsCameraSetup({ environment: mac })).toEqual({
      ok: false,
      message: 'Videorc Camera setup is a Windows step.'
    })
    const missing = environment({
      exists: (path) => !path.endsWith(WINDOWS_CAMERA_DLL_FILE_NAME)
    })
    expect(await runWindowsCameraSetup({ environment: missing })).toEqual({
      ok: false,
      message: 'This Videorc build is missing the Videorc Camera files. Reinstall Videorc.'
    })
    expect(mac.runs).toHaveLength(0)
    expect(missing.runs).toHaveLength(0)
    // Removal needs only the exe.
    expect(await runWindowsCameraSetup({ environment: missing, remove: true })).toEqual({
      ok: true
    })
    expect(missing.runs[0].args[5]).toContain("@('/remove')")
  })
})
