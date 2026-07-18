import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildDiscordReleaseMessage } from '../notify-discord-release.mjs'

describe('buildDiscordReleaseMessage', () => {
  it('drops the -beta suffix and renders a short titled bullet list', () => {
    const message = buildDiscordReleaseMessage({
      version: '0.9.17-beta.1',
      channel: 'beta',
      platforms: ['macos'],
      title: 'A calmer permission grant, a steadier preview',
      highlights: ['Grant no longer errors', 'Preview no longer stretches']
    })
    assert.match(message, /🚀 \*\*Videorc 0\.9\.17 — A calmer permission grant/)
    assert.ok(!message.includes('beta'))
    assert.match(message, /• Grant no longer errors/)
    assert.match(message, /• Preview no longer stretches/)
    assert.match(message, /Update from Settings/)
  })

  it('labels Windows Alpha and directs users to the Windows download', () => {
    const message = buildDiscordReleaseMessage({
      version: '0.10.0-alpha.1',
      channel: 'alpha',
      platforms: ['windows'],
      title: 'The first Windows test build',
      highlights: ['Signed for Windows 11 x64.']
    })

    assert.match(
      message,
      /🚀 \*\*Videorc 0\.10\.0 Alpha 1 for Windows — The first Windows test build\*\*/
    )
    assert.match(
      message,
      /Download the Windows Alpha: https:\/\/www\.videorc\.com\/download\/windows/
    )
    assert.doesNotMatch(message, /Update from Settings/)
  })

  it('preserves both platform names when an Alpha entry applies to both', () => {
    const message = buildDiscordReleaseMessage({
      version: '0.10.0-alpha.2',
      channel: 'alpha',
      platforms: ['macos', 'windows'],
      title: 'A shared Alpha build',
      highlights: ['Available on both desktop platforms.']
    })

    assert.match(message, /0\.10\.0 Alpha 2 for macOS and Windows/)
    assert.match(message, /Choose your Alpha download: https:\/\/www\.videorc\.com\/download/)
    assert.doesNotMatch(message, /download\/windows/)
  })

  it('caps at 4 highlights and adds an "and more" line', () => {
    const message = buildDiscordReleaseMessage({
      version: '1.0.0',
      title: 'Big one',
      highlights: ['a', 'b', 'c', 'd', 'e', 'f']
    })
    assert.equal((message.match(/^• /gm) ?? []).length, 4)
    assert.match(message, /…and more\./)
  })

  it('strips inline markdown emphasis and links from highlights', () => {
    const message = buildDiscordReleaseMessage({
      version: '1.2.3',
      title: 'T',
      highlights: ['See **bold** and [the page](https://videorc.com/x) and `code`']
    })
    assert.match(message, /• See bold and the page and code$/m)
    assert.ok(!message.includes('https://videorc.com/x'))
  })
})
