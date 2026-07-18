import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatVersion,
  markdownToEmailHtml,
  markdownToPlainText,
  renderChangelogEmail,
  resolveWebBaseUrl
} from './changelog-email.mjs'

const entry = {
  version: '0.9.2-beta.1',
  date: '2026-07-01',
  channel: 'beta',
  platforms: ['macos'],
  title: 'Camera and microphone fixed in the installed app',
  summary: 'The capture bug is fixed & delivered through the in-app updater.',
  highlights: ['Camera and mic now work.', 'Delivered via **in-app updates**.'],
  body: [
    'Intro paragraph with **bold** and a [link](https://videorc.com).',
    '',
    '## The fix',
    '',
    '- First fix item',
    '- Second fix item with `code`',
    '',
    'Closing paragraph.'
  ].join('\n')
}

describe('renderChangelogEmail', () => {
  it('renders subject, html, and text with the release + download links', () => {
    const email = renderChangelogEmail(entry, { webBaseUrl: 'https://videorc.com/' })

    assert.equal(
      email.subject,
      'Videorc 0.9.2 Beta 1 — The capture bug is fixed & delivered through the in-app updater.'
    )
    assert.match(email.html, /Videorc 0\.9\.2 Beta 1/)
    assert.match(email.html, /href="https:\/\/videorc\.com\/releases\/0\.9\.2-beta\.1"/)
    assert.match(email.html, /href="https:\/\/videorc\.com\/account\/download"/)
    // Summary ampersand must be escaped in HTML but not doubled in text.
    assert.match(email.html, /fixed &amp; delivered/)
    assert.match(email.text, /fixed & delivered/)
    assert.match(email.text, /Update Videorc: https:\/\/videorc\.com\/account\/download/)
    assert.match(
      email.text,
      /Full release notes: https:\/\/videorc\.com\/releases\/0\.9\.2-beta\.1/
    )
  })

  it('renders highlight inline markdown in both formats', () => {
    const email = renderChangelogEmail(entry)
    assert.match(email.html, /<strong style="color:#ffffff;">in-app updates<\/strong>/)
    assert.match(email.text, /- Delivered via in-app updates\./)
  })

  it('renders Windows Alpha as a download instead of an established update', () => {
    const windowsAlpha = {
      ...entry,
      version: '0.10.0-alpha.1',
      channel: 'alpha',
      platforms: ['windows'],
      summary: 'The signed Windows test build is ready.'
    }
    const email = renderChangelogEmail(windowsAlpha, { webBaseUrl: 'https://videorc.com/' })

    assert.equal(
      email.subject,
      'Videorc 0.10.0 Alpha 1 for Windows — The signed Windows test build is ready.'
    )
    assert.match(email.html, /Videorc Windows Alpha changelog/)
    assert.match(email.html, /Videorc 0\.10\.0 Alpha 1 for Windows/)
    assert.match(email.html, /href="https:\/\/videorc\.com\/download\/windows"/)
    assert.match(email.html, />Download Windows Alpha<\/a>/)
    assert.match(email.text, /Download Windows Alpha: https:\/\/videorc\.com\/download\/windows/)
    assert.doesNotMatch(email.text, /Update Videorc:/)
  })
})

describe('markdown subset rendering', () => {
  it('converts headings, lists, paragraphs, and inline marks to email HTML', () => {
    const html = markdownToEmailHtml(entry.body)
    assert.match(html, /<h2[^>]*>The fix<\/h2>/)
    assert.match(html, /<li[^>]*>First fix item<\/li>/)
    assert.match(html, /<code[^>]*>code<\/code>/)
    assert.match(html, /<strong[^>]*>bold<\/strong>/)
    assert.match(html, /<a href="https:\/\/videorc\.com"[^>]*>link<\/a>/)
    assert.match(html, /<p[^>]*>Closing paragraph\.<\/p>/)
  })

  it('escapes raw HTML in the source markdown', () => {
    const html = markdownToEmailHtml('Watch out for <script>alert(1)</script> tags.')
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;/)
  })

  it('converts to readable plaintext', () => {
    const text = markdownToPlainText(entry.body)
    assert.match(text, /THE FIX/)
    assert.match(text, /- Second fix item with code/)
    assert.match(text, /link \(https:\/\/videorc\.com\)/)
    assert.doesNotMatch(text, /\*\*/)
  })
})

describe('helpers', () => {
  it('formats versions for subjects and headings', () => {
    assert.equal(formatVersion('0.10.0-alpha.1'), '0.10.0 Alpha 1')
    assert.equal(formatVersion('0.9.2-beta.1'), '0.9.2 Beta 1')
    assert.equal(formatVersion('1.0.0'), '1.0.0')
  })

  it('resolves the web base URL from the environment with a safe default', () => {
    assert.equal(resolveWebBaseUrl({}), 'https://www.videorc.com')
    assert.equal(
      resolveWebBaseUrl({ VIDEORC_WEB_BASE_URL: 'https://videorc.com/' }),
      'https://videorc.com'
    )
  })
})
