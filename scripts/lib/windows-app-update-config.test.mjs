import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { load as parseYaml } from 'js-yaml'

import {
  buildWindowsAppUpdateYaml,
  updaterCacheDirNameFor
} from './windows-app-update-config.mjs'

const PUBLISH = Object.freeze({
  provider: 'generic',
  publisherName: ['Uros Miric'],
  url: 'https://www.videorc.com/api/updates/'
})

describe('updaterCacheDirNameFor', () => {
  it('reproduces the value in a genuine electron-builder artifact', () => {
    // Pinned against resources/app-update.yml from the real macOS 0.9.50 pack:
    //   updaterCacheDirName: '@videorcdesktop-updater'
    // electron-updater derives its on-disk cache directory from this, so a
    // rename that changes it must be a deliberate, reviewed change.
    assert.equal(updaterCacheDirNameFor('@videorc/desktop'), '@videorcdesktop-updater')
  })

  it('strips Windows-illegal characters and lowercases, like sanitize-filename', () => {
    assert.equal(updaterCacheDirNameFor('My:App*Name'), 'myappname-updater')
    assert.equal(updaterCacheDirNameFor('@scope/Thing'), '@scopething-updater')
  })

  it('refuses an empty or non-string package name', () => {
    assert.throws(() => updaterCacheDirNameFor(''), /package name/)
    assert.throws(() => updaterCacheDirNameFor(undefined), /package name/)
  })
})

describe('buildWindowsAppUpdateYaml', () => {
  it('emits the publish config plus updaterCacheDirName', () => {
    const yaml = buildWindowsAppUpdateYaml({
      publish: PUBLISH,
      updaterCacheDirName: '@videorcdesktop-updater'
    })
    assert.deepEqual(parseYaml(yaml), {
      provider: 'generic',
      publisherName: ['Uros Miric'],
      url: 'https://www.videorc.com/api/updates/',
      updaterCacheDirName: '@videorcdesktop-updater'
    })
  })

  it('keeps publisherName a single-entry list, which staging verification requires', () => {
    const config = parseYaml(
      buildWindowsAppUpdateYaml({ publish: PUBLISH, updaterCacheDirName: 'x-updater' })
    )
    assert.ok(Array.isArray(config.publisherName))
    assert.equal(config.publisherName.length, 1)
    assert.equal(config.publisherName[0], 'Uros Miric')
  })

  it('quotes the @-prefixed cache dir so the YAML stays parseable', () => {
    const yaml = buildWindowsAppUpdateYaml({
      publish: PUBLISH,
      updaterCacheDirName: '@videorcdesktop-updater'
    })
    assert.match(yaml, /updaterCacheDirName: '@videorcdesktop-updater'/)
    assert.equal(parseYaml(yaml).updaterCacheDirName, '@videorcdesktop-updater')
  })

  it('rejects a missing publish config or cache dir name', () => {
    assert.throws(() => buildWindowsAppUpdateYaml({ updaterCacheDirName: 'x' }), /publish config/)
    assert.throws(() => buildWindowsAppUpdateYaml({ publish: PUBLISH }), /updaterCacheDirName/)
  })
})
