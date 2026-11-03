import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadCameraExtensionIdentifiers, plistXml } from './camera-extension-identifiers.mjs'
import {
  GENERATED_APP_ENTITLEMENTS_PATH,
  PROFILE_ENV_APP,
  RETIRED_PROFILE_ENV_CAMERA,
  cameraProfileDecision,
  cameraSkippedLogLine,
  collectNestedCodePaths,
  decodeProfileValue,
  developerCertificateSha1sFromPlistXml,
  embedCameraExtension,
  extensionSignArgs,
  localSignPlan,
  orderNestedCodePaths,
  pickSigningIdentity,
  profileSummaryProblems,
  readProfileSummary,
  signingCertificateSha1FromIdentity
} from './camera-extension-packaging.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const identifiers = loadCameraExtensionIdentifiers(repoRoot)

// Synthetic "certificates": never real DER, just bytes with a SHA-1. The
// signing one stands for the keychain's Developer ID Application identity
// (its `security find-identity` hash IS the certificate's SHA-1).
const SIGNING_CERT = Buffer.from('synthetic Developer ID Application certificate (not DER)')
const OTHER_CERT = Buffer.from('synthetic second certificate in the profile (not DER)')
const STALE_CERT = Buffer.from('synthetic certificate of a profile made before a renewal')
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex').toUpperCase()
const SIGNING_SHA1 = sha1(SIGNING_CERT)

// The shape `security cms -D` reads out of the real app profile (plan 214
// P0a): a "Mac Team Direct Provisioning Profile" for dev.theorcdev.videorc
// with the restricted key, the application and team identifiers and
// keychain-access-groups. It lists NO app group: the signature alone carries
// com.apple.security.application-groups and AMFI accepts that.
const realShapeProfile = {
  name: 'Mac Team Direct Provisioning Profile: dev.theorcdev.videorc',
  expirationDate: '2044-10-29T10:18:17Z',
  provisionedDevices: false,
  developerCertificateSha1s: [SIGNING_SHA1, sha1(OTHER_CERT)],
  entitlements: {
    'com.apple.developer.system-extension.install': true,
    'com.apple.application-identifier': 'C2PA37RB58.dev.theorcdev.videorc',
    'keychain-access-groups': ['C2PA37RB58.*'],
    'com.apple.developer.team-identifier': 'C2PA37RB58'
  }
}

describe('cameraProfileDecision', () => {
  it('skips with one named reason when the profile is not set', () => {
    assert.deepEqual(cameraProfileDecision({}), {
      mode: 'skip',
      reason: 'VIDEORC_MACOS_PROFILE_APP not set'
    })
    assert.equal(cameraProfileDecision({ [PROFILE_ENV_APP]: '  ' }).mode, 'skip')
    assert.match(
      cameraSkippedLogLine('x'),
      /^Videorc Camera skipped: x\. The extension is not embedded/
    )
  })

  it('embeds when the app profile is set', () => {
    assert.deepEqual(cameraProfileDecision({ [PROFILE_ENV_APP]: ' a ' }), {
      mode: 'embed',
      app: 'a'
    })
  })

  it('refuses the retired camera profile variable, with or without the app one (P0a)', () => {
    const alone = cameraProfileDecision({ [RETIRED_PROFILE_ENV_CAMERA]: 'stale' })
    assert.equal(alone.mode, 'error')
    assert.match(alone.reason, /VIDEORC_MACOS_PROFILE_CAMERA is set but no longer used/)
    assert.match(alone.reason, /only VIDEORC_MACOS_PROFILE_APP is read/)
    assert.doesNotMatch(alone.reason, /stale/)
    assert.equal(
      cameraProfileDecision({ [PROFILE_ENV_APP]: 'a', [RETIRED_PROFILE_ENV_CAMERA]: 'b' }).mode,
      'error'
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

function certificatesXml(certificates) {
  // plutil -extract DeveloperCertificates xml1 wraps base64 at 68 columns.
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<array>',
    ...certificates.map(
      (bytes) => `\t<data>\n\t${bytes.toString('base64').replace(/(.{68})/g, '$1\n\t')}\n\t</data>`
    ),
    '</array>',
    '</plist>',
    ''
  ].join('\n')
}

describe('developerCertificateSha1sFromPlistXml', () => {
  it('fingerprints every <data> entry, matching the identity hash form', () => {
    assert.deepEqual(
      developerCertificateSha1sFromPlistXml(certificatesXml([SIGNING_CERT, OTHER_CERT])),
      [SIGNING_SHA1, sha1(OTHER_CERT)]
    )
    assert.deepEqual(developerCertificateSha1sFromPlistXml('<array/>'), [])
    assert.deepEqual(developerCertificateSha1sFromPlistXml(''), [])
    assert.equal(signingCertificateSha1FromIdentity(SIGNING_SHA1.toLowerCase()), SIGNING_SHA1)
    assert.equal(signingCertificateSha1FromIdentity('Developer ID Application: X (T)'), null)
  })
})

describe('profileSummaryProblems', () => {
  const now = new Date('2026-11-03T00:00:00Z')
  const judge = (summary, extra = {}) =>
    profileSummaryProblems(summary, {
      identifiers,
      now,
      signingCertificateSha1: SIGNING_SHA1,
      ...extra
    })

  it('accepts the real-shaped app profile: no app group needed, signing certificate embedded', () => {
    assert.deepEqual(judge(realShapeProfile), { problems: [], warnings: [] })
    assert.deepEqual(
      judge(realShapeProfile, { signingCertificateSha1: SIGNING_SHA1.toLowerCase() }),
      {
        problems: [],
        warnings: []
      }
    )
  })

  it('catches a profile generated for another certificate (the renewal case) by name', () => {
    const stale = { ...realShapeProfile, developerCertificateSha1s: [sha1(STALE_CERT)] }
    const { problems } = judge(stale)
    assert.equal(problems.length, 1)
    assert.match(
      problems[0],
      /does not embed the Developer ID Application certificate signing this build/
    )
    assert.ok(problems[0].includes(`SHA-1 ${SIGNING_SHA1}`))
    assert.match(problems[0], /after a certificate renewal, regenerate the profile/)
    assert.match(problems[0], /"Renewal"/)
    const none = judge({ ...realShapeProfile, developerCertificateSha1s: [] })
    assert.ok(none.problems.some((line) => line.includes('lists no DeveloperCertificates')))
  })

  it('skips the certificate comparison when no signing identity is known', () => {
    const stale = { ...realShapeProfile, developerCertificateSha1s: [sha1(STALE_CERT)] }
    assert.deepEqual(judge(stale, { signingCertificateSha1: null }).problems, [])
  })

  it('names a wrong team, app id, missing restricted key and expiry', () => {
    const bad = {
      ...realShapeProfile,
      expirationDate: '2026-01-01T00:00:00Z',
      entitlements: {
        'com.apple.developer.team-identifier': 'OTHER',
        'com.apple.application-identifier': 'OTHER.dev.theorcdev.videorc'
      }
    }
    const { problems } = judge(bad)
    assert.ok(problems.some((line) => line.includes('team identifier is "OTHER"')))
    assert.ok(problems.some((line) => line.includes('expected C2PA37RB58.dev.theorcdev.videorc')))
    assert.ok(
      problems.some((line) => line.includes('com.apple.developer.system-extension.install'))
    )
    assert.ok(problems.some((line) => line.includes('expired on 2026-01-01')))
    assert.ok(problems.every((line) => !line.includes('app groups')))
  })

  it('refuses a profile for the extension id (the retired camera profile)', () => {
    const cameraProfile = {
      ...realShapeProfile,
      entitlements: {
        'com.apple.developer.team-identifier': 'C2PA37RB58',
        'com.apple.application-identifier': 'C2PA37RB58.dev.theorcdev.videorc.camera',
        'com.apple.security.application-groups': ['C2PA37RB58.dev.theorcdev.videorc']
      }
    }
    const { problems } = judge(cameraProfile)
    assert.ok(problems.some((line) => line.includes('expected C2PA37RB58.dev.theorcdev.videorc')))
    assert.ok(problems.some((line) => line.includes('system-extension.install')))
  })

  it('warns about a Development profile and an expiry inside 30 days', () => {
    const soon = {
      ...realShapeProfile,
      expirationDate: '2026-11-20T00:00:00Z',
      provisionedDevices: true
    }
    const { problems, warnings } = judge(soon)
    assert.deepEqual(problems, [])
    assert.equal(warnings.length, 2)
    assert.match(warnings[0], /expires on 2026-11-20/)
    assert.match(warnings[1], /Development profile/)
  })

  it('requires the identifiers', () => {
    assert.throws(() => profileSummaryProblems(realShapeProfile, {}), /identifiers are required/)
  })
})

describe('readProfileSummary', () => {
  it('reduces the decoded profile to entitlements, dates and certificate fingerprints', () => {
    const commands = []
    const run = (command, args) => {
      commands.push([command, ...args])
      if (command === 'security') return { status: 0, stdout: '', stderr: '' }
      const key = args[1]
      if (key === 'Entitlements')
        return { status: 0, stdout: JSON.stringify(realShapeProfile.entitlements), stderr: '' }
      if (key === 'ExpirationDate')
        return { status: 0, stdout: '2044-10-29T10:18:17Z\n', stderr: '' }
      if (key === 'Name') return { status: 0, stdout: `${realShapeProfile.name}\n`, stderr: '' }
      if (key === 'DeveloperCertificates')
        return { status: 0, stdout: certificatesXml([SIGNING_CERT, OTHER_CERT]), stderr: '' }
      return { status: 1, stdout: '', stderr: 'No value at that key path' }
    }
    const summary = readProfileSummary('/p/app.provisionprofile', '/p/app.plist', { run })
    assert.deepEqual(summary, realShapeProfile)
    assert.deepEqual(commands[0], [
      'security',
      'cms',
      '-D',
      '-i',
      '/p/app.provisionprofile',
      '-o',
      '/p/app.plist'
    ])
    assert.ok(
      commands.some(
        (command) =>
          command[1] === '-extract' &&
          command[2] === 'DeveloperCertificates' &&
          command[3] === 'xml1'
      )
    )
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

// A packaged Electron app as the signer walks it (paths as the spike's nested
// Videorc.app has them). Symlinks, non-Mach-O files, the main executable and
// the extension's own binary must not be in the nested set.
function fakeAppTree(app) {
  const p = (...parts) => join(app, 'Contents', ...parts)
  const files = new Map([
    [p('MacOS', 'Videorc'), 'mach-o'],
    [p('Resources', 'app.asar'), 'text'],
    [p('Resources', 'videorc-backend'), 'mach-o'],
    [p('Resources', 'videorc_native_preview.node'), 'mach-o'],
    [p('Resources', 'ffmpeg', 'bin', 'ffmpeg'), 'mach-o'],
    [
      p('Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'),
      'mach-o'
    ],
    [
      p(
        'Frameworks',
        'Electron Framework.framework',
        'Versions',
        'A',
        'Libraries',
        'libffmpeg.dylib'
      ),
      'mach-o'
    ],
    [
      p(
        'Frameworks',
        'Electron Framework.framework',
        'Versions',
        'A',
        'Helpers',
        'chrome_crashpad_handler'
      ),
      'mach-o'
    ],
    [
      p('Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Info.plist'),
      'text'
    ],
    [p('Frameworks', 'Electron Framework.framework', 'Electron Framework'), 'symlink'],
    [p('Frameworks', 'Squirrel.framework', 'Versions', 'A', 'Squirrel'), 'mach-o'],
    [p('Frameworks', 'Squirrel.framework', 'Versions', 'A', 'Resources', 'ShipIt'), 'mach-o'],
    [
      p('Frameworks', 'Videorc Helper (GPU).app', 'Contents', 'MacOS', 'Videorc Helper (GPU)'),
      'mach-o'
    ],
    [p('Frameworks', 'Videorc Helper.app', 'Contents', 'MacOS', 'Videorc Helper'), 'mach-o'],
    [
      p(
        'Library',
        'SystemExtensions',
        'dev.theorcdev.videorc.camera.systemextension',
        'Contents',
        'MacOS',
        'dev.theorcdev.videorc.camera'
      ),
      'mach-o'
    ],
    [p('embedded.provisionprofile'), 'text']
  ])
  const dirs = new Set()
  for (const path of files.keys()) {
    let dir = dirname(path)
    while (dir.length >= app.length) {
      dirs.add(dir)
      if (dir === app) break
      dir = dirname(dir)
    }
  }
  const readdir = (dir) =>
    [
      ...new Set(
        [...files.keys(), ...dirs]
          .filter((path) => dirname(path) === dir)
          .map((path) => path.slice(dir.length + 1).split(sep)[0])
      )
    ].sort()
  const lstat = (path) => ({
    isSymbolicLink: () => files.get(path) === 'symlink',
    isDirectory: () => dirs.has(path) && !files.has(path),
    isFile: () => files.has(path) && files.get(path) !== 'symlink'
  })
  const isMachO = (path) => files.get(path) === 'mach-o'
  return { readdir, lstat, isMachO, p }
}

describe('nested code paths', () => {
  it('walks the app the way osx-sign does, minus the main executable, the extension and symlinks', () => {
    const app = resolve('/out/Videorc.app')
    const tree = fakeAppTree(app)
    const nested = collectNestedCodePaths(app, tree)
    const relativePaths = nested.map((entry) => [
      entry.kind,
      entry.path
        .slice(app.length + 1)
        .split(sep)
        .join('/')
    ])
    assert.deepEqual(relativePaths, [
      [
        'mach-o',
        'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler'
      ],
      [
        'mach-o',
        'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib'
      ],
      ['mach-o', 'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'],
      ['mach-o', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'],
      ['mach-o', 'Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel'],
      [
        'mach-o',
        'Contents/Frameworks/Videorc Helper (GPU).app/Contents/MacOS/Videorc Helper (GPU)'
      ],
      ['mach-o', 'Contents/Frameworks/Videorc Helper.app/Contents/MacOS/Videorc Helper'],
      ['mach-o', 'Contents/Resources/ffmpeg/bin/ffmpeg'],
      ['mach-o', 'Contents/Resources/videorc-backend'],
      ['mach-o', 'Contents/Resources/videorc_native_preview.node'],
      ['framework', 'Contents/Frameworks/Electron Framework.framework'],
      ['framework', 'Contents/Frameworks/Squirrel.framework'],
      ['app', 'Contents/Frameworks/Videorc Helper (GPU).app'],
      ['app', 'Contents/Frameworks/Videorc Helper.app']
    ])
  })

  it('orders inside out: deepest Mach-O first, then frameworks, then helper apps', () => {
    const ordered = orderNestedCodePaths([
      { path: '/A.app/Contents/Frameworks/X.app', kind: 'app' },
      { path: '/A.app/Contents/Frameworks/F.framework', kind: 'framework' },
      { path: '/A.app/Contents/Resources/tool', kind: 'mach-o' },
      {
        path: '/A.app/Contents/Frameworks/F.framework/Versions/A/Resources/ShipIt',
        kind: 'mach-o'
      },
      { path: '/A.app/Contents/Frameworks/F.framework/Versions/A/F', kind: 'mach-o' }
    ])
    assert.deepEqual(
      ordered.map((entry) => entry.path),
      [
        '/A.app/Contents/Frameworks/F.framework/Versions/A/Resources/ShipIt',
        '/A.app/Contents/Frameworks/F.framework/Versions/A/F',
        '/A.app/Contents/Resources/tool',
        '/A.app/Contents/Frameworks/F.framework',
        '/A.app/Contents/Frameworks/X.app'
      ]
    )
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

  const nestedCodePaths = [
    {
      path: '/A.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt',
      kind: 'mach-o'
    },
    { path: '/A.app/Contents/Resources/videorc-backend', kind: 'mach-o' },
    { path: '/A.app/Contents/Frameworks/Squirrel.framework', kind: 'framework' },
    { path: '/A.app/Contents/Frameworks/Videorc Helper.app', kind: 'app' }
  ]

  it('without the extension: every nested object with inherit, then the app with its plist, never --deep', () => {
    const steps = localSignPlan({
      appPath: '/A.app',
      identity: 'ID',
      nestedCodePaths,
      appEntitlementsPath: '/app.plist',
      inheritEntitlementsPath: '/inherit.plist'
    })
    assert.deepEqual(
      steps.map((step) => step.label),
      [
        'nested Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt',
        'nested Contents/Resources/videorc-backend',
        'nested Contents/Frameworks/Squirrel.framework',
        'nested Contents/Frameworks/Videorc Helper.app',
        'app (last, no --deep)'
      ]
    )
    for (const step of steps.slice(0, -1)) {
      assert.deepEqual(step.args.slice(0, 5), [
        '--force',
        '--options',
        'runtime',
        '--entitlements',
        '/inherit.plist'
      ])
    }
    assert.deepEqual(steps.at(-1).args, [
      '--force',
      '--options',
      'runtime',
      '--entitlements',
      '/app.plist',
      '--sign',
      'ID',
      '/A.app'
    ])
    assert.ok(steps.every((step) => !step.args.includes('--deep')))
  })

  it('with the extension: nested, then the extension with its own plist, then the app last', () => {
    const steps = localSignPlan({
      appPath: '/A.app',
      identity: 'ID',
      nestedCodePaths,
      appEntitlementsPath: '/app.plist',
      inheritEntitlementsPath: '/inherit.plist',
      extensionPath:
        '/A.app/Contents/Library/SystemExtensions/dev.theorcdev.videorc.camera.systemextension',
      extensionEntitlementsPath: '/ext.plist'
    })
    assert.deepEqual(
      steps.slice(-2).map((step) => step.label),
      ['camera extension', 'app (last, no --deep)']
    )
    assert.ok(steps.at(-2).args.includes('/ext.plist'))
    assert.ok(steps.at(-2).args.includes('--timestamp'))
    assert.ok(steps.at(-1).args.includes('/app.plist'))
    assert.ok(steps.every((step) => !step.args.includes('--deep')))
    assert.throws(
      () =>
        localSignPlan({
          appPath: '/A.app',
          identity: 'ID',
          nestedCodePaths: [],
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
  const built =
    '/repo/apps/desktop/build/camera-extension/dev.theorcdev.videorc.camera.systemextension'
  const extension =
    '/out/Videorc.app/Contents/Library/SystemExtensions/dev.theorcdev.videorc.camera.systemextension'
  const twoKeysShown = plistXml({
    'com.apple.security.app-sandbox': true,
    'com.apple.security.application-groups': ['C2PA37RB58.dev.theorcdev.videorc']
  })

  it('without the profile writes the base entitlements, embeds nothing and logs once', async () => {
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
    assert.deepEqual(lines, [cameraSkippedLogLine('VIDEORC_MACOS_PROFILE_APP not set')])
    assert.equal(
      [...fs.files.keys()].some((path) => path.includes('SystemExtensions')),
      false
    )
  })

  it('an unsigned build with the profile set still skips, naming the reason', async () => {
    const fs = fakeFs(baseFiles)
    const lines = []
    const result = await embedCameraExtension({
      appPath: app,
      repoRoot: root,
      env: { [PROFILE_ENV_APP]: 'x' },
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

  it('refuses the retired camera profile variable', async () => {
    const fs = fakeFs(baseFiles)
    await assert.rejects(
      embedCameraExtension({
        appPath: app,
        repoRoot: root,
        env: { [PROFILE_ENV_APP]: der.toString('base64'), [RETIRED_PROFILE_ENV_CAMERA]: 'x' },
        version: '0.18.0',
        identity: SIGNING_SHA1,
        log: () => {},
        run: () => ({ status: 0, stdout: '', stderr: '' }),
        fs
      }),
      /VIDEORC_MACOS_PROFILE_CAMERA is set but no longer used/
    )
  })

  it('requires the built extension, without a profile of its own, and an identity hash', async () => {
    const fs = fakeFs(baseFiles)
    const base = {
      appPath: app,
      repoRoot: root,
      env: { [PROFILE_ENV_APP]: der.toString('base64') },
      version: '0.18.0',
      log: () => {},
      run: () => ({ status: 0, stdout: '', stderr: '' })
    }
    await assert.rejects(
      embedCameraExtension({ ...base, identity: SIGNING_SHA1, fs }),
      /pnpm build:camera-extension/
    )
    await assert.rejects(
      embedCameraExtension({ ...base, identity: 'Developer ID Application: X', fs }),
      /SHA-1 hash/
    )
    const stale = fakeFs({
      ...baseFiles,
      [built]: 'bundle',
      [`${built}/Contents/embedded.provisionprofile`]: 'stale B0 shape'
    })
    stale.dirs.add(built)
    await assert.rejects(
      embedCameraExtension({ ...base, identity: SIGNING_SHA1, fs: stale }),
      /the built extension carries an embedded.provisionprofile; the extension embeds no profile/
    )
  })

  function profileRun(
    profile,
    { signStatus = 0, shown = twoKeysShown, certificates = [SIGNING_CERT, OTHER_CERT] } = {}
  ) {
    const commands = []
    const run = (command, args) => {
      commands.push([command, ...args])
      if (command === 'security') return { status: 0, stdout: '', stderr: '' }
      if (command === 'plutil' && args[0] === '-extract') {
        if (args[1] === 'Entitlements')
          return { status: 0, stdout: JSON.stringify(profile.entitlements), stderr: '' }
        if (args[1] === 'ExpirationDate')
          return { status: 0, stdout: `${profile.expirationDate}\n`, stderr: '' }
        if (args[1] === 'Name') return { status: 0, stdout: `${profile.name}\n`, stderr: '' }
        if (args[1] === 'DeveloperCertificates')
          return { status: 0, stdout: certificatesXml(certificates), stderr: '' }
        return { status: 1, stdout: '', stderr: 'absent' }
      }
      if (command === 'plutil' && args[0] === '-replace')
        return { status: 0, stdout: '', stderr: '' }
      if (command === 'codesign' && args[0] === '-d')
        return { status: 0, stdout: '', stderr: `Executable=${args.at(-1)}\n${shown}` }
      if (command === 'codesign')
        return { status: signStatus, stdout: '', stderr: signStatus ? 'boom' : '' }
      throw new Error(`unexpected command ${command}`)
    }
    return { run, commands }
  }

  it('embeds: stamps the version, copies the one profile to the app only, signs the extension with two keys and widens the app entitlements', async () => {
    const fs = fakeFs({ ...baseFiles, [built]: 'bundle' })
    fs.dirs.add(built)
    const { run, commands } = profileRun(realShapeProfile)
    const lines = []
    const result = await embedCameraExtension({
      appPath: app,
      repoRoot: root,
      env: { [PROFILE_ENV_APP]: der.toString('base64') },
      version: '0.18.0',
      buildVersion: '18',
      identity: SIGNING_SHA1,
      keychain: '/tmp/k.keychain',
      log: (line) => lines.push(line),
      run,
      fs,
      now: new Date('2026-11-03T00:00:00Z')
    })

    assert.equal(result.embedded, true)
    assert.equal(result.extensionPath, extension)
    assert.ok(fs.files.has('/out/Videorc.app/Contents/embedded.provisionprofile'))
    assert.equal(fs.files.has(`${extension}/Contents/embedded.provisionprofile`), false)
    assert.deepEqual(
      [...fs.files.keys()].filter((path) => path.endsWith('embedded.provisionprofile')),
      ['/out/Videorc.app/Contents/embedded.provisionprofile']
    )
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
    assert.ok(sign.includes(SIGNING_SHA1))
    assert.ok(sign.includes('--keychain'))
    assert.ok(sign.includes(result.extensionEntitlementsPath))
    assert.equal(sign.at(-1), extension)
    assert.ok(!sign.includes('--deep'))
    const extensionPlist = String(fs.files.get(result.extensionEntitlementsPath))
    assert.match(extensionPlist, /com\.apple\.security\.app-sandbox/)
    assert.match(extensionPlist, /C2PA37RB58\.dev\.theorcdev\.videorc</)
    assert.doesNotMatch(
      extensionPlist,
      /application-identifier|team-identifier|system-extension\.install/
    )
    const verify = commands.find(
      (command) => command[0] === 'codesign' && command.includes('--verify')
    )
    assert.ok(verify)
    assert.ok(commands.some((command) => command[0] === 'codesign' && command[1] === '-d'))
    const written = String(fs.files.get(result.appEntitlementsPath))
    assert.match(written, /com\.apple\.developer\.system-extension\.install/)
    assert.match(written, /C2PA37RB58\.dev\.theorcdev\.videorc</)
    assert.match(written, /com\.apple\.security\.device\.camera/)
    assert.ok(lines.some((line) => line.includes('embeds the signing certificate')))
    assert.ok(
      lines.some((line) =>
        line.startsWith(
          'Videorc Camera embedded at Contents/Library/SystemExtensions/dev.theorcdev.videorc.camera.systemextension'
        )
      )
    )
  })

  it('refuses a profile made for another certificate, a failed codesign and wrong read-back entitlements', async () => {
    const env = { [PROFILE_ENV_APP]: der.toString('base64') }
    const base = {
      appPath: app,
      repoRoot: root,
      env,
      version: '0.18.0',
      identity: SIGNING_SHA1,
      log: () => {}
    }
    const freshFs = () => {
      const fs = fakeFs({ ...baseFiles, [built]: 'bundle' })
      fs.dirs.add(built)
      return fs
    }
    const stale = profileRun(realShapeProfile, { certificates: [STALE_CERT] })
    await assert.rejects(
      embedCameraExtension({ ...base, run: stale.run, fs: freshFs() }),
      /VIDEORC_MACOS_PROFILE_APP is not the app profile[\s\S]*does not embed the Developer ID Application certificate/
    )
    const failing = profileRun(realShapeProfile, { signStatus: 1 })
    await assert.rejects(
      embedCameraExtension({ ...base, run: failing.run, fs: freshFs() }),
      /codesign failed on the camera extension: boom/
    )
    const b0Shape = profileRun(realShapeProfile, {
      shown: plistXml({
        'com.apple.security.app-sandbox': true,
        'com.apple.security.application-groups': ['C2PA37RB58.dev.theorcdev.videorc'],
        'com.apple.application-identifier': 'C2PA37RB58.dev.theorcdev.videorc.camera',
        'com.apple.developer.team-identifier': 'C2PA37RB58'
      })
    })
    await assert.rejects(
      embedCameraExtension({ ...base, run: b0Shape.run, fs: freshFs() }),
      /wrong entitlements[\s\S]*carries com\.apple\.application-identifier/
    )
  })
})
