import { MAX_CHAT_LINK_LENGTH, openableChatLink } from '../../../shared/chat-link'

// Links in chat text (plan 151, D7). No platform sends a link fragment, so
// the Stream Manager finds them itself: `http(s)://` URLs, `www.` hosts, and
// bare `host.tld` names on a short list of TLDs people actually paste in
// chat. Anything else (`javascript:`, `mailto:`, `file:`, an email address)
// stays text. A hand-written scan: no dependency in the Stream Manager chunk.

export interface ChatLinkPiece {
  kind: 'link'
  /** What the viewer wrote, shown as is. */
  text: string
  /** What Open and Copy use: the text, with `https://` when it had no scheme. */
  href: string
  /** Where it goes, shown above Open link: "videorc.com". */
  host: string
}

export type ChatTextPiece = { kind: 'text'; text: string } | ChatLinkPiece

/** Bare `host.tld` names become links only on these TLDs; `node.js` and
 * `file.txt` stay text. A scheme or `www.` needs no list. */
const BARE_TLDS = new Set([
  'com',
  'net',
  'org',
  'io',
  'gg',
  'tv',
  'dev',
  'app',
  'co',
  'me',
  'ly',
  'be',
  'fm',
  'to',
  'sh',
  'xyz',
  'live'
])

// A scheme or `www.` URL runs to whitespace, a quote, an angle bracket or an
// emoji. A bare name is ASCII labels and a TLD, not inside a word, a path or
// an email address, with an optional path.
const CANDIDATE =
  /(?:https?:\/\/|www\.)[^\s<>"\p{Extended_Pictographic}]+|(?<![\p{L}\p{N}_@./:-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,6}(?:[/?#][^\s<>"\p{Extended_Pictographic}]*)?/giu

const TRAILING = new Set(['.', ',', '!', '?', ';', ':', "'", '"', '。', '，', '、', '！', '？'])
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

function count(text: string, char: string): number {
  let total = 0
  for (const c of text) if (c === char) total += 1
  return total
}

/** Sentence punctuation after a link is not part of it; a closing bracket
 * is, when the link opened it ("Foo_(bar)"). */
function trimTrailing(candidate: string): string {
  let end = candidate.length
  while (end > 0) {
    const last = candidate[end - 1]
    if (TRAILING.has(last)) {
      end -= 1
      continue
    }
    const opener = CLOSERS[last]
    if (opener && count(candidate.slice(0, end), last) > count(candidate.slice(0, end), opener)) {
      end -= 1
      continue
    }
    break
  }
  return candidate.slice(0, end)
}

/** The link a candidate names, or null when it is not one Videorc opens. */
export function chatLinkFrom(raw: string): ChatLinkPiece | null {
  if (raw.length > MAX_CHAT_LINK_LENGTH) return null
  const schemed = /^https?:\/\//i.test(raw)
  const href = schemed ? raw : `https://${raw}`
  const openable = openableChatLink(href)
  if (!openable) return null
  const host = new URL(openable).hostname
  if (!host.includes('.')) return null
  if (!schemed && !/^www\./i.test(raw)) {
    const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase()
    if (!BARE_TLDS.has(tld)) return null
  }
  return { kind: 'link', text: raw, href, host: host.replace(/^www\./, '') }
}

/** The text in order, with each link it holds as its own piece. */
export function splitLinks(text: string): ChatTextPiece[] {
  const pieces: ChatTextPiece[] = []
  let cursor = 0
  const pushText = (value: string): void => {
    if (!value) return
    const last = pieces.at(-1)
    if (last?.kind === 'text') last.text += value
    else pieces.push({ kind: 'text', text: value })
  }
  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index
    const raw = trimTrailing(match[0])
    const link = raw ? chatLinkFrom(raw) : null
    if (!link) continue
    pushText(text.slice(cursor, start))
    pieces.push(link)
    cursor = start + raw.length
  }
  pushText(text.slice(cursor))
  return pieces
}

/** The distinct links in a text, first seen first. */
export function chatLinksIn(text: string): ChatLinkPiece[] {
  const seen = new Set<string>()
  const links: ChatLinkPiece[] = []
  for (const piece of splitLinks(text)) {
    if (piece.kind !== 'link' || seen.has(piece.href)) continue
    seen.add(piece.href)
    links.push(piece)
  }
  return links
}
