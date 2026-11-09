import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assertPackagedSmokePlatform,
  bundledFfmpegPathForPackagedApp,
  defaultPackagedAppExecutable,
  isLinuxAppImageExecutable,
  linuxAppImageCheckPayload,
  packagedSmokeLaunchOptions
} from './packaged-smoke-paths.mjs'

// resolve() emits platform separators (and resolves POSIX-style roots against
// the current drive on Windows), so path assertions must not hardcode '/' —
// these tests run on both macOS and Windows boxes.
function posixPath(value) {
  return value.replaceAll('\\', '/')
}

describe('packaged smoke paths', () => {
  it('resolves the default macOS packaged executable and bundled FFmpeg', () => {
    const executable = defaultPackagedAppExecutable({ repoRoot: '/repo', platform: 'darwin' })

    assert.match(
      posixPath(executable),
      /\/repo\/apps\/desktop\/release\/mac-arm64\/Videorc\.app\/Contents\/MacOS\/Videorc$/
    )
    assert.match(
      posixPath(bundledFfmpegPathForPackagedApp({ appExecutable: executable, platform: 'darwin' })),
      /\/repo\/apps\/desktop\/release\/mac-arm64\/Videorc\.app\/Contents\/Resources\/ffmpeg\/bin\/ffmpeg$/
    )
  })

  it('resolves the default Windows packaged executable and bundled FFmpeg', () => {
    const executable = defaultPackagedAppExecutable({ repoRoot: 'C:/repo', platform: 'win32' })

    assert.match(posixPath(executable), /C:\/repo\/apps\/desktop\/release\/win-unpacked\/Videorc\.exe$/)
    assert.match(
      posixPath(bundledFfmpegPathForPackagedApp({ appExecutable: executable, platform: 'win32' })),
      /C:\/repo\/apps\/desktop\/release\/win-unpacked\/resources\/ffmpeg\/bin\/ffmpeg\.exe$/
    )
  })

  it('resolves the default Linux unpacked executable and bundled FFmpeg', () => {
    const executable = defaultPackagedAppExecutable({ repoRoot: '/repo', platform: 'linux' })

    assert.match(posixPath(executable), /\/repo\/apps\/desktop\/release\/linux-unpacked\/videorc$/)
    assert.match(
      posixPath(bundledFfmpegPathForPackagedApp({ appExecutable: executable, platform: 'linux' })),
      /\/repo\/apps\/desktop\/release\/linux-unpacked\/resources\/ffmpeg\/bin\/ffmpeg$/
    )
    assert.equal(isLinuxAppImageExecutable('/x/Videorc-0.9.108-linux-x86_64.AppImage', 'linux'), true)
    assert.equal(isLinuxAppImageExecutable(executable, 'linux'), false)
    assert.equal(isLinuxAppImageExecutable('/x/Videorc.AppImage', 'win32'), false)
    assert.doesNotThrow(() => assertPackagedSmokePlatform('linux'))
  })

  it('names the AppImage members the packaged app check extracts', () => {
    const payload = linuxAppImageCheckPayload('/tmp/check')

    assert.deepEqual(payload.members, ['videorc', 'resources/app.asar', 'videorc.desktop'])
    assert.match(posixPath(payload.executable), /\/tmp\/check\/squashfs-root\/videorc$/)
    assert.match(
      posixPath(payload.desktopEntry),
      /\/tmp\/check\/squashfs-root\/videorc\.desktop$/
    )
  })

  it('launches the dev app when no packaged executable is given', () => {
    assert.deepEqual(packagedSmokeLaunchOptions({}), { env: {} })
    assert.deepEqual(packagedSmokeLaunchOptions({ capability: 'unused' }), { env: {} })
  })

  it('launches a packaged executable with the smoke command capability', () => {
    const options = packagedSmokeLaunchOptions({
      appExecutable: '/x/Videorc 0.20.1.AppImage',
      capability: 'cap-123'
    })

    assert.deepEqual(options.env, {
      VIDEORC_SMOKE_PACKAGED_APP: '1',
      VIDEORC_PACKAGED_SMOKE_TEST: '1',
      VIDEORC_SMOKE_COMMAND_CAPABILITY: 'cap-123',
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
    })
    assert.equal(options.packagedSmokeCommandCapability, 'cap-123')
    assert.match(posixPath(options.spawnSpec.command), /\/x\/Videorc 0\.20\.1\.AppImage$/)
    assert.deepEqual(options.spawnSpec.args, [])
    assert.throws(
      () => packagedSmokeLaunchOptions({ appExecutable: '/x/videorc' }),
      /capability is required/
    )
  })

  it('rejects unsupported packaged smoke platforms', () => {
    assert.throws(() => assertPackagedSmokePlatform('freebsd'), /supports macOS, Windows and Linux/)
    assert.throws(() => defaultPackagedAppExecutable({ repoRoot: '/repo', platform: 'freebsd' }), /does not support freebsd/)
  })
})
