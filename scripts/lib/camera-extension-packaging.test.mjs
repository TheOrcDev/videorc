import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadCameraExtensionIdentifiers, plistXml } from './camera-extension-identifiers.mjs'
import {
  GENERATED_APP_ENTITLEMENTS_PATH,
  PROFILE_ENV_APP,
  PROFILE_ENV_CAMERA,
  cameraProfilesDecision,
  cameraSkippedLogLine,
  decodeProfileValue,
  embedCameraExtension,
  extensionSignArgs,
  localSignPlan,
  pickSigningIdentity,
  profileSummaryProblems
} from './camera-extension-packaging.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const identifiers = loadCameraExtensionIdentifiers(repoRoot)

describe('cameraProfilesDecision', () => {
  it('skips with one named reason when neither profile is set', () => {
    assert.deepEqual(cameraProfilesDecision({}), {
      mode: 'skip',
      reason: 'VIDEORC_MACOS_PROFILE_APP and VIDEORC_MACOS_PROFILE_CAMERA not set'
    })
    assert.equal(
      cameraProfilesDecision({ [PROFILE_ENV_APP]: '  ', [PROFILE_ENV_CAMERA]: '' }).mode,
      'skip'
    )
    assert.match(
      cameraSkippedLogLine('x'),
      /^Videorc Camera skipped: x\. The extension is not embedded/
    )
  })

  it('refuses one profile without the other', () => {
    const decision = cameraProfilesDecision({ [PROFILE_ENV_APP]: 'abc' })
    assert.equal(decision.mode, 'error')
    assert.match(
      decision.reason,
      /VIDEORC_MACOS_PROFILE_CAMERA is not set but VIDEORC_MACOS_PROFILE_APP is/
    )
    assert.equal(cameraProfilesDecision({ [PROFILE_ENV_CAMERA]: 'abc' }).mode, 'error')
  })

  it('embeds when both are set', () => {
    assert.deepEqual(
      cameraProfilesDecision({ [PROFILE_ENV_APP]: ' a ', [PROFILE_ENV_CAMERA]: 'b' }),
      {
        mode: 'embed',
        app: 'a',
        camera: 'b'
      }
    )
  })
})

describe('decodeProfileValue', () => {
  const der = Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.alloc(100, 7)])

  it('reads an existing path, expanding ~', () => {
    const files = { '/home/me/app.provisionprofile': der }
    const io = {
      exists: (path) => path in files,
      readFile: (path) => files[path],
      homeDir: '/home/me'
    }
    assert.equal(decodeProfileValue('~/app.provisionprofile', io), der)
    assert.equal(decodeProfileValue('/home/me/app.provisionprofile', io), der)
  })

  it('decodes base64 CMS data', () => {
    const io = { exists: () => false, readFile: () => null, homeDir: '/home/me' }
    assert.deepEqual(decodeProfileValue(der.toString('base64'), io), der)
    assert.deepEqual(
      decodeProfileValue(der.toString('base64').replace(/(.{20})/g, '$1\n'), io),
      der
    )
  })

  it('names a missing path and non-profile data', () => {
    const io = { exists: () => false, readFile: () => null, homeDir: '/home/me' }
    assert.throws(
      () => decodeProfileValue('/nope/app.provisionprofile', io),
      /profile path does not exist/
    )
    assert.throws(() => decodeProfileValue('not base64!!', io), /neither an existing/)
    assert.throws(
      () => decodeProfileValue(Buffer.from('hello').toString('base64'), io),
      /CMS provisioning profile/
    )
    assert.throws(() => decodeProfileValue('', io), /empty/)
  })
})

describe('profileSummaryProblems', () => {
  const now = new Date('2026-11-03T00:00:00Z')
  const goodApp = {
    name: 'Videorc Developer ID',
    expirationDate: '2027-11-03T00:00:00Z',
    provisionedDevices: false,
    entitlements: {
      'com.apple.developer.team-identifier': 'C2PA37RB58',
      'com.apple.application-identifier': 'C2PA37RB58.dev.theorcdev.videorc',
      'com.apple.security.application-groups': ['C2PA37RB58.dev.theorcdev.videorc'],
      'com.apple.developer.system-extension.install': true
    }
  }
  const goodCamera = {
    ...goodApp,
    entitlements: {
      'com.apple.developer.team-identifier': 'C2PA37RB58',
      'com.apple.application-identifier': 'C2PA37RB58.dev.theorcdev.videorc.camera',
      'com.apple.security.application-groups': ['C2PA37RB58.dev.theorcdev.videorc']
    }
  }

  it('accepts the two profiles B0 asks for', () => {
    assert.deepEqual(profileSummaryProblems(goodApp, { role: 'app', identifiers, now }), {
      problems: [],
      warnings: []
    })
    assert.deepEqual(profileSummaryProblems(goodCamera, { role: 'camera', identifiers, now }), {
      problems: [],
      warnings: []
    })
  })

  it('names a wrong team, app id, group, missing restricted key and expiry', () => {
    const bad = {
      ...goodApp,
      expirationDate: '2026-01-01T00:00:00Z',
      entitlements: {
        'com.apple.developer.team-identifier': 'OTHER',
        'com.apple.application-identifier': 'OTHER.dev.theorcdev.videorc',
        'com.apple.security.application-groups': ['OTHER.group']
      }
    }
    const { problems } = profileSummaryProblems(bad, { role: 'app', identifiers, now })
    assert.ok(problems.some((line) => line.includes('team identifier is "OTHER"')))
    assert.ok(problems.some((line) => line.includes('expected C2PA37RB58.dev.theorcdev.videorc')))
    assert.ok(
      problems.some((line) => line.includes('do not include C2PA37RB58.dev.theorcdev.videorc'))
    )
    assert.ok(
      problems.some((line) => line.includes('com.apple.developer.system-extension.install'))
    )
    assert.ok(problems.some((line) => line.includes('expired on 2026-01-01')))
  })

  it('swapped profiles are refused', () => {
    assert.ok(
      profileSummaryProblems(goodApp, { role: 'camera', identifiers, now }).problems.length > 0
    )
    assert.ok(
      profileSummaryProblems(goodCamera, { role: 'app', identifiers, now }).problems.length > 0
    )
  })

  it('warns about a Development profile and an expiry inside 30 days', () => {
    const soon = { ...goodCamera, expirationDate: '2026-11-20T00:00:00Z', provisionedDevices: true }
    const { problems, warnings } = profileSummaryProblems(soon, {
      role: 'camera',
      identifiers,
      now
    })
    assert.deepEqual(problems, [])
    assert.equal(warnings.length, 2)
    assert.match(warnings[0], /expires on 2026-11-20/)
    assert.match(warnings[1], /Development profile/)
  })
})

describe('pickSigningIdentity', () => {
  const output = [
    'Policy: Code Signing',
    '  Matching identities',
    '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: Uros Miric (ABC123)"',
    '  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Developer ID Application: Uros Miric (C2PA37RB58)"',
    '     2 identities found'
  ].join('\n')

  it('prefers the Developer ID Application identity', () => {
    assert.deepEqual(pickSigningIdentity(output), {
      hash: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      name: 'Developer ID Application: Uros Miric (C2PA37RB58)'
    })
  })

  it('honours a preferred name or hash and reports none found', () => {
    assert.equal(
      pickSigningIdentity(output, { preferred: 'Apple Development' }).hash,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    )
    assert.equal(
      pickSigningIdentity(output, {
        preferred: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
      }).name.startsWith('Developer ID'),
      true
    )
    assert.equal(pickSigningIdentity(output, { preferred: 'Nobody' }), null)
    assert.equal(pickSigningIdentity('0 identities found'), null)
  })
})

describe('sign plans', () => {
  it('signs the extension hardened, timestamped, with its own entitlements', () => {
    assert.deepEqual(
      extensionSignArgs({
        bundlePath: '/A.app/x.systemextension',
        entitlementsPath: '/e.plist',
        identity: 'HASH',
        keychain: '/k'
      }),
      [
        '--force',
        '--options',
        'runtime',
        '--timestamp',
        '--entitlements',
        '/e.plist',
        '--sign',
        'HASH',
        '--keychain',
        '/k',
        '/A.app/x.systemextension'
      ]
    )
  })

  it('keeps the pre-camera local plan when no extension is embedded', () => {
    const steps = localSignPlan({
      appPath: '/A.app',
      identity: 'ID',
      toolPaths: ['/A.app/Contents/Resources/videorc-backend'],
      appEntitlementsPath: '/app.plist',
      inheritEntitlementsPath: '/inherit.plist'
    })
    assert.deepEqual(
      steps.map((step) => step.args),
      [
        [
          '--force',
          '--options',
          'runtime',
          '--entitlements',
          '/app.plist',
          '--sign',
          'ID',
          '/A.app/Contents/Resources/videorc-backend'
        ],
        [
          '--force',
          '--deep',
          '--options',
          'runtime',
          '--entitlements',
          '/app.plist',
          '--sign',
          'ID',
          '/A.app'
        ]
      ]
    )
  })

  it('with the extension: inherit for tools and the deep pass, its own plist, then the app shallow', () => {
    const steps = localSignPlan({
      appPath: '/A.app',
      identity: 'ID',
      toolPaths: ['/A.app/Contents/Resources/videorc-backend'],
      appEntitlementsPath: '/app.plist',
      inheritEntitlementsPath: '/inherit.plist',
      extensionPath: '/A.app/Contents/Library/SystemExtensions/VideorcCamera.systemextension',
      extensionEntitlementsPath: '/ext.plist'
    })
    assert.deepEqual(
      steps.map((step) => step.label),
      [
        'tool /A.app/Contents/Resources/videorc-backend',
        'app (deep)',
        'camera extension',
        'app (shallow, app entitlements)'
      ]
    )
    assert.ok(steps[0].args.includes('/inherit.plist'))
    assert.ok(steps[1].args.includes('/inherit.plist'))
    assert.ok(steps[2].args.includes('/ext.plist'))
    assert.ok(!steps[3].args.includes('--deep'))
    assert.ok(steps[3].args.includes('/app.plist'))
    assert.throws(
      () =>
        localSignPlan({
          appPath: '/A.app',
          identity: 'ID',
          toolPaths: [],
          appEntitlementsPath: '/a',
          inheritEntitlementsPath: '/i',
          extensionPath: '/x'
        }),
      /extensionEntitlementsPath/
    )
  })
})

describe('embedCameraExtension', () => {
  const basePlist = plistXml({
    'com.apple.security.cs.allow-jit': true,
    'com.apple.security.device.camera': true,
    'com.apple.security.device.audio-input': true
  })
  const der = Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.alloc(100, 1)])

  function fakeFs(initial = {}) {
    const files = new Map(Object.entries(initial))
    const dirs = new Set()
    return {
      files,
      dirs,
      exists: (path) => files.has(path) || dirs.has(path),
      readFile: (path, encoding) => {
        if (!files.has(path)) throw new Error(`ENOENT ${path}`)
        const value = files.get(path)
        return encoding
          ? String(value)
          : Buffer.isBuffer(value)
            ? value
            : Buffer.from(String(value))
      },
      writeFile: (path, data) => files.set(path, data),
      mkdir: (path) => dirs.add(path),
      rm: (path) => files.delete(path),
      copy: (from, to) => {
        files.set(to, files.get(from) ?? `copy of ${from}`)
        dirs.add(to)
      },
      chmod: () => {}
    }
  }

  const identifiersJson = JSON.stringify(identifiers)
  const root = '/repo'
  const app = '/out/Videorc.app'
  const baseFiles = {
    '/repo/apps/desktop/camera-extension/identifiers.json': identifiersJson,
    '/repo/apps/desktop/build-resources/entitlements.mac.plist': basePlist
  }

  it('without profiles writes the base entitlements, embeds nothing and logs once', async () => {
    const fs = fakeFs(baseFiles)
    const lines = []
    const result = await embedCameraExtension({
      appPath: app,
      repoRoot: root,
      env: {},
      version: '0.18.0',
      log: (line) => lines.push(line),
      run: () => {
        throw new Error('no commands expected')
      },
      fs
    })
    assert.equal(result.embedded, false)
    assert.equal(result.appEntitlementsPath, join(root, GENERATED_APP_ENTITLEMENTS_PATH))
    const written = String(fs.files.get(result.appEntitlementsPath))
    assert.match(written, /com\.apple\.security\.device\.camera/)
    assert.doesNotMatch(written, /system-extension\.install/)
    assert.deepEqual(lines, [
      cameraSkippedLogLine('VIDEORC_MACOS_PROFILE_APP and VIDEORC_MACOS_PROFILE_CAMERA not set')
    ])
    assert.equal(
      [...fs.files.keys()].some((path) => path.includes('SystemExtensions')),
      false
    )
  })

  it('an unsigned build with profiles set still skips, naming the reason', async () => {
    const fs = fakeFs(baseFiles)
    const lines = []
    const result = await embedCameraExtension({
      appPath: app,
      repoRoot: root,
      env: { [PROFILE_ENV_APP]: 'x', [PROFILE_ENV_CAMERA]: 'y' },
      version: '0.18.0',
      unsignedReason: 'unsigned build (mac.identity=null)',
      log: (line) => lines.push(line),
      run: () => {
        throw new Error('no commands expected')
      },
      fs
    })
    assert.equal(result.embedded, false)
    assert.match(lines[0], /unsigned build/)
  })

  it('refuses one profile without the other', async () => {
    const fs = fakeFs(baseFiles)
    await assert.rejects(
      embedCameraExtension({
        appPath: app,
        repoRoot: root,
        env: { [PROFILE_ENV_APP]: der.toString('base64') },
        version: '0.18.0',
        identity: 'ID',
        log: () => {},
        run: () => ({ status: 0, stdout: '', stderr: '' }),
        fs
      }),
      /VIDEORC_MACOS_PROFILE_CAMERA is not set/
    )
  })

  it('requires the built extension', async () => {
    const fs = fakeFs(baseFiles)
    await assert.rejects(
      embedCameraExtension({
        appPath: app,
        repoRoot: root,
        env: {
          [PROFILE_ENV_APP]: der.toString('base64'),
          [PROFILE_ENV_CAMERA]: der.toString('base64')
        },
        version: '0.18.0',
        identity: 'ID',
        log: () => {},
        run: () => ({ status: 0, stdout: '', stderr: '' }),
        fs
      }),
      /pnpm build:camera-extension/
    )
  })

  function profileRun(entitlementsByRole, { signStatus = 0 } = {}) {
    const commands = []
    const run = (command, args) => {
      commands.push([command, ...args])
      if (command === 'security') return { status: 0, stdout: '', stderr: '' }
      if (command === 'plutil' && args[0] === '-extract') {
        const role = args[5].endsWith('/app.plist') ? 'app' : 'camera'
        if (args[1] === 'Entitlements')
          return { status: 0, stdout: JSON.stringify(entitlementsByRole[role]), stderr: '' }
        if (args[1] === 'ExpirationDate')
          return { status: 0, stdout: '2027-11-03T00:00:00Z\n', stderr: '' }
        if (args[1] === 'Name') return { status: 0, stdout: `${role} profile\n`, stderr: '' }
        return { status: 1, stdout: '', stderr: 'absent' }
      }
      if (command === 'plutil' && args[0] === '-replace')
        return { status: 0, stdout: '', stderr: '' }
      if (command === 'codesign')
        return { status: signStatus, stdout: '', stderr: signStatus ? 'boom' : '' }
      throw new Error(`unexpected command ${command}`)
    }
    return { run, commands }
  }

  const appEntitlements = {
    'com.apple.developer.team-identifier': 'C2PA37RB58',
    'com.apple.application-identifier': 'C2PA37RB58.dev.theorcdev.videorc',
    'com.apple.security.application-groups': ['C2PA37RB58.dev.theorcdev.videorc'],
    'com.apple.developer.system-extension.install': true
  }
  const cameraEntitlements = {
    'com.apple.developer.team-identifier': 'C2PA37RB58',
    'com.apple.application-identifier': 'C2PA37RB58.dev.theorcdev.videorc.camera',
    'com.apple.security.application-groups': ['C2PA37RB58.dev.theorcdev.videorc']
  }
  const built = '/repo/apps/desktop/build/camera-extension/VideorcCamera.systemextension'

  it('embeds, stamps the version, copies both profiles, signs the extension and widens the app entitlements', async () => {
    const fs = fakeFs({ ...baseFiles, [built]: 'bundle' })
    fs.dirs.add(built)
    const { run, commands } = profileRun({ app: appEntitlements, camera: cameraEntitlements })
    const lines = []
    const result = await embedCameraExtension({
      appPath: app,
      repoRoot: root,
      env: {
        [PROFILE_ENV_APP]: der.toString('base64'),
        [PROFILE_ENV_CAMERA]: der.toString('base64')
      },
      version: '0.18.0',
      buildVersion: '18',
      identity: 'HASH',
      keychain: '/tmp/k.keychain',
      log: (line) => lines.push(line),
      run,
      fs,
      now: new Date('2026-11-03T00:00:00Z')
    })

    assert.equal(result.embedded, true)
    const extension =
      '/out/Videorc.app/Contents/Library/SystemExtensions/VideorcCamera.systemextension'
    assert.equal(result.extensionPath, extension)
    assert.ok(fs.files.has(`${extension}/Contents/embedded.provisionprofile`))
    assert.ok(fs.files.has('/out/Videorc.app/Contents/embedded.provisionprofile'))
    const replaced = commands.filter(
      (command) => command[0] === 'plutil' && command[1] === '-replace'
    )
    assert.deepEqual(
      replaced.map((command) => [command[2], command[4]]),
      [
        ['CFBundleShortVersionString', '0.18.0'],
        ['CFBundleVersion', '18']
      ]
    )
    const sign = commands.find((command) => command[0] === 'codesign' && command.includes('--sign'))
    assert.ok(sign.includes('HASH'))
    assert.ok(sign.includes('--keychain'))
    assert.ok(sign.includes(result.extensionEntitlementsPath))
    assert.equal(sign.at(-1), extension)
    const verify = commands.find(
      (command) => command[0] === 'codesign' && command.includes('--verify')
    )
    assert.ok(verify)
    const written = String(fs.files.get(result.appEntitlementsPath))
    assert.match(written, /com\.apple\.developer\.system-extension\.install/)
    assert.match(written, /C2PA37RB58\.dev\.theorcdev\.videorc</)
    assert.match(written, /com\.apple\.security\.device\.camera/)
    assert.ok(
      lines.some((line) =>
        line.startsWith('Videorc Camera embedded at Contents/Library/SystemExtensions/')
      )
    )
  })

  it('refuses swapped profiles and a failed codesign, naming the variable', async () => {
    const fs = fakeFs({ ...baseFiles, [built]: 'bundle' })
    const swapped = profileRun({ app: cameraEntitlements, camera: appEntitlements })
    await assert.rejects(
      embedCameraExtension({
        appPath: app,
        repoRoot: root,
        env: {
          [PROFILE_ENV_APP]: der.toString('base64'),
          [PROFILE_ENV_CAMERA]: der.toString('base64')
        },
        version: '0.18.0',
        identity: 'HASH',
        log: () => {},
        run: swapped.run,
        fs
      }),
      /VIDEORC_MACOS_PROFILE_APP is not the app profile/
    )
    const failing = profileRun(
      { app: appEntitlements, camera: cameraEntitlements },
      { signStatus: 1 }
    )
    await assert.rejects(
      embedCameraExtension({
        appPath: app,
        repoRoot: root,
        env: {
          [PROFILE_ENV_APP]: der.toString('base64'),
          [PROFILE_ENV_CAMERA]: der.toString('base64')
        },
        version: '0.18.0',
        identity: 'HASH',
        log: () => {},
        run: failing.run,
        fs
      }),
      /codesign failed on the camera extension: boom/
    )
  })
})
