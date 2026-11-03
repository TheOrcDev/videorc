import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  WINDOWS_CAMERA_DLL_FILE_NAME,
  WINDOWS_CAMERA_SETUP_DECLINED_EXIT_CODE,
  WINDOWS_CAMERA_SETUP_EXE_FILE_NAME,
  WINDOWS_CAMERA_SETUP_TIMEOUT_MS,
  runWindowsCameraSetup,
  windowsCameraSetupArgs,
  windowsCameraSetupResultFromRun,
  type WindowsCameraSetupEnvironment,
  type WindowsCameraSetupRun
} from './virtual-camera-windows-setup'

const RESOURCES = 'C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Videorc\\resources'

type RecordedRun = { file: string; args: string[]; timeoutMs: number }

function environment(
  overrides: Partial<WindowsCameraSetupEnvironment> & {
    runs?: RecordedRun[]
    result?: WindowsCameraSetupRun
  } = {}
): WindowsCameraSetupEnvironment & { runs: RecordedRun[] } {
  const runs = overrides.runs ?? []
  const result = overrides.result ?? { code: 0, stdout: 'Videorc Camera is set up.', stderr: '' }
  return {
    platform: 'win32',
    resourcesPath: RESOURCES,
    exists: () => true,
    run: async (file, args, timeoutMs) => {
      runs.push({ file, args, timeoutMs })
      return result
    },
    ...overrides,
    runs
  }
}

describe('windowsCameraSetupArgs', () => {
  it('is one fixed verb, never a path or a shell string', () => {
    expect(windowsCameraSetupArgs()).toEqual(['/install'])
    expect(windowsCameraSetupArgs({ remove: true })).toEqual(['/remove'])
  })
})

describe('windowsCameraSetupResultFromRun', () => {
  it('is ok on exit 0 and names a declined UAC prompt by its exit code', () => {
    expect(windowsCameraSetupResultFromRun({ code: 0, stdout: '', stderr: '' })).toEqual({
      ok: true
    })
    const declined = windowsCameraSetupResultFromRun({
      code: WINDOWS_CAMERA_SETUP_DECLINED_EXIT_CODE,
      stdout: '',
      stderr: 'Windows did not get permission to change Videorc Camera.\n'
    })
    expect(declined).toEqual({
      ok: false,
      message:
        'Windows needs your permission to set up Videorc Camera. Try again and choose Yes in the prompt.'
    })
    expect(
      windowsCameraSetupResultFromRun(
        { code: WINDOWS_CAMERA_SETUP_DECLINED_EXIT_CODE, stdout: '', stderr: '' },
        { remove: true }
      ).message
    ).toBe(
      'Windows needs your permission to remove Videorc Camera. Try again and choose Yes in the prompt.'
    )
  })

  it("shows the exe's first line, not the administrator detail after it", () => {
    expect(
      windowsCameraSetupResultFromRun({
        code: 5,
        stdout: '',
        stderr:
          'Videorc Camera is in use. Close every app that uses it and set it up again.\r\n' +
          'C:\\ProgramData\\Videorc\\camera\\1.0.0\\videorc_virtual_camera_windows.dll: Access is denied.\r\n'
      })
    ).toEqual({
      ok: false,
      message: 'Videorc Camera is in use. Close every app that uses it and set it up again.'
    })
    expect(windowsCameraSetupResultFromRun({ code: 1, stdout: '', stderr: '' })).toEqual({
      ok: false,
      message: 'Could not set up Videorc Camera (exit code 1).'
    })
  })

  it('names a spawn failure and a timeout', () => {
    expect(
      windowsCameraSetupResultFromRun(
        {
          code: null,
          stdout: '',
          stderr: '',
          error: new Error('spawn videorc-camera-setup.exe ENOENT')
        },
        { remove: true }
      )
    ).toEqual({
      ok: false,
      message: 'Could not remove Videorc Camera: spawn videorc-camera-setup.exe ENOENT'
    })
    expect(
      windowsCameraSetupResultFromRun({
        code: null,
        stdout: '',
        stderr: '',
        error: new Error('Command failed'),
        timedOut: true
      })
    ).toEqual({
      ok: false,
      message: 'Could not set up Videorc Camera: it did not finish within 3 minutes.'
    })
  })
})

describe('runWindowsCameraSetup', () => {
  it('runs the bundled exe once with an argv and reports ok', async () => {
    const env = environment()
    expect(await runWindowsCameraSetup({ environment: env })).toEqual({ ok: true })
    expect(env.runs).toEqual([
      {
        file: join(RESOURCES, WINDOWS_CAMERA_SETUP_EXE_FILE_NAME),
        args: ['/install'],
        timeoutMs: WINDOWS_CAMERA_SETUP_TIMEOUT_MS
      }
    ])
  })

  it('relays what the exe said when it fails', async () => {
    const env = environment({
      result: {
        code: 7,
        stdout: '',
        stderr: "The Videorc Camera file is not signed by Videorc's publisher. Reinstall Videorc.\n"
      }
    })
    expect(await runWindowsCameraSetup({ environment: env })).toEqual({
      ok: false,
      message: "The Videorc Camera file is not signed by Videorc's publisher. Reinstall Videorc."
    })
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
    expect(missing.runs[0].args).toEqual(['/remove'])
  })
})
