// Renders one changelog entry into newsletter-ready HTML + plaintext.
// Content side of the newsletter only — sending stays manual (no ESP wired);
// paste the output into the sending tool of choice.

const DEFAULT_WEB_BASE_URL = 'https://www.videorc.com'

export function resolveWebBaseUrl(env = process.env) {
  const raw = env.VIDEORC_WEB_BASE_URL?.trim()
  return (raw && raw.length > 0 ? raw : DEFAULT_WEB_BASE_URL).replace(/\/+$/, '')
}

export function renderChangelogEmail(entry, { webBaseUrl = DEFAULT_WEB_BASE_URL } = {}) {
  const base = webBaseUrl.replace(/\/+$/, '')
  const releaseUrl = `${base}/releases/${entry.version}`
  const presentation = releasePresentation(entry, base)
  return {
    subject: `Videorc ${formatVersion(entry.version)}${presentation.audience} — ${entry.summary}`,
    html: renderHtml(entry, { ...presentation, releaseUrl }),
    text: renderText(entry, { ...presentation, releaseUrl })
  }
}

export function formatVersion(version) {
  const [core, preRelease] = version.split('-')
  if (!preRelease) {
    return core
  }
  const [tag, number] = preRelease.split('.')
  const capitalized = tag.charAt(0).toUpperCase() + tag.slice(1)
  return number ? `${core} ${capitalized} ${number}` : `${core} ${capitalized}`
}

function renderHtml(entry, { audience, changelogLabel, ctaLabel, downloadUrl, releaseUrl }) {
  const highlights = entry.highlights
    .map((item) => `<li style="margin:0 0 8px;">${renderInline(item)}</li>`)
    .join('\n')

  return [
    '<div style="margin:0 auto;max-width:600px;padding:32px 20px;background:#0b0b0e;color:#e7e7ea;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;">',
    `<p style="margin:0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#9a9aa2;">${escapeHtml(changelogLabel)} · ${escapeHtml(entry.date)}</p>`,
    `<h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;font-weight:600;color:#ffffff;">Videorc ${escapeHtml(formatVersion(entry.version))}${escapeHtml(audience)}</h1>`,
    `<p style="margin:16px 0 0;font-size:16px;line-height:1.6;color:#c9c9cf;">${renderInline(entry.summary)}</p>`,
    `<h2 style="margin:28px 0 0;font-size:18px;font-weight:600;color:#ffffff;">${renderInline(entry.title)}</h2>`,
    `<ul style="margin:16px 0 0;padding:0 0 0 20px;font-size:15px;line-height:1.6;color:#c9c9cf;">`,
    highlights,
    '</ul>',
    markdownToEmailHtml(entry.body),
    `<a href="${escapeAttribute(downloadUrl)}" style="display:inline-block;margin:28px 0 0;padding:12px 24px;border-radius:8px;background:#ffffff;color:#0b0b0e;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(ctaLabel)}</a>`,
    `<p style="margin:20px 0 0;font-size:14px;line-height:1.6;"><a href="${escapeAttribute(releaseUrl)}" style="color:#9a9aa2;">Read the full release notes</a></p>`,
    '</div>'
  ].join('\n')
}

function renderText(entry, { audience, ctaLabel, downloadUrl, releaseUrl }) {
  return [
    `Videorc ${formatVersion(entry.version)}${audience} — ${entry.date}`,
    '',
    entry.summary,
    '',
    entry.title,
    ...entry.highlights.map((item) => `- ${stripInline(item)}`),
    '',
    markdownToPlainText(entry.body),
    '',
    `${ctaLabel}: ${downloadUrl}`,
    `Full release notes: ${releaseUrl}`
  ].join('\n')
}

function releasePresentation(entry, base) {
  const platforms =
    Array.isArray(entry.platforms) && entry.platforms.length > 0 ? entry.platforms : ['macos']
  const macosOnly = platforms.length === 1 && platforms[0] === 'macos'
  if (macosOnly) {
    return {
      audience: '',
      changelogLabel: 'Videorc changelog',
      ctaLabel: 'Update Videorc',
      downloadUrl: `${base}/account/download`
    }
  }

  const windowsOnly = platforms.length === 1 && platforms[0] === 'windows'
  const platformLabel = formatPlatforms(platforms)
  return {
    audience: ` for ${platformLabel}`,
    changelogLabel:
      windowsOnly && entry.channel === 'alpha'
        ? 'Videorc Windows Alpha changelog'
        : `Videorc ${platformLabel} changelog`,
    ctaLabel:
      windowsOnly && entry.channel === 'alpha'
        ? 'Download Windows Alpha'
        : windowsOnly
          ? 'Download Videorc for Windows'
          : 'Choose your download',
    downloadUrl: windowsOnly ? `${base}/download/windows` : `${base}/download`
  }
}

function formatPlatforms(platforms) {
  return platforms.map((platform) => (platform === 'macos' ? 'macOS' : 'Windows')).join(' and ')
}

// The changelog body is a constrained markdown subset (see changelog/README.md):
// ## headings, paragraphs, - lists, **bold**, `code`, [links](url). Enough for
// email without pulling in a markdown dependency.
export function markdownToEmailHtml(markdown) {
  return splitBlocks(markdown)
    .map((block) => {
      if (block.type === 'heading') {
        return `<h2 style="margin:28px 0 0;font-size:18px;font-weight:600;color:#ffffff;">${renderInline(block.text)}</h2>`
      }
      if (block.type === 'list') {
        const items = block.items
          .map((item) => `<li style="margin:0 0 8px;">${renderInline(item)}</li>`)
          .join('\n')
        return `<ul style="margin:16px 0 0;padding:0 0 0 20px;font-size:15px;line-height:1.6;color:#c9c9cf;">\n${items}\n</ul>`
      }
      return `<p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#c9c9cf;">${renderInline(block.text)}</p>`
    })
    .join('\n')
}

export function markdownToPlainText(markdown) {
  return splitBlocks(markdown)
    .map((block) => {
      if (block.type === 'heading') {
        return `${stripInline(block.text).toUpperCase()}`
      }
      if (block.type === 'list') {
        return block.items.map((item) => `- ${stripInline(item)}`).join('\n')
      }
      return stripInline(block.text)
    })
    .join('\n\n')
}

function splitBlocks(markdown) {
  const blocks = []
  for (const raw of String(markdown).split(/\n{2,}/)) {
    const block = raw.trim()
    if (!block) continue

    const headingMatch = /^#{1,3}\s+(.*)$/.exec(block)
    if (headingMatch && !block.includes('\n')) {
      blocks.push({ type: 'heading', text: headingMatch[1] })
      continue
    }

    const lines = block.split('\n').map((line) => line.trim())
    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      blocks.push({ type: 'list', items: lines.map((line) => line.replace(/^[-*]\s+/, '')) })
      continue
    }

    blocks.push({ type: 'paragraph', text: lines.join(' ') })
  }
  return blocks
}

function renderInline(text) {
  let escaped = escapeHtml(text)
  escaped = escaped.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label, url) => `<a href="${escapeAttribute(url)}" style="color:#ffffff;">${label}</a>`
  )
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#ffffff;">$1</strong>')
  escaped = escaped.replace(
    /`([^`]+)`/g,
    '<code style="font-family:ui-monospace,monospace;font-size:14px;">$1</code>'
  )
  return escaped
}

function stripInline(text) {
  return String(text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

function escapeHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(text) {
  return escapeHtml(text).replaceAll('"', '&quot;')
}
