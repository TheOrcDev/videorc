// Plan 186 S7: banners from the live controls. The Stream Manager, the chat
// composer's `/banner`, ⌘K and the remotes see a banner the same way: its
// opaque id, the name the streamer typed and whether it shows. Never its
// image, a file name or a path. Pure and schema-free, so the Stream Manager
// carries only what it runs: the IPC schemas live in `electron-ipc-contract`.

/** One banner as the live controls see it. */
export interface BannerSummary {
  id: string
  name: string
  shown: boolean
}

/**
 * A show or hide asked for away from Studio. Explicit, never a toggle: the
 * asking surface picks the verb from the state it shows, so a repeat or a
 * stale list can never flip a banner back. `hideAll` hides every banner.
 */
export type BannerRelayAction = { action: 'show' | 'hide'; id: string } | { action: 'hideAll' }

/** Stream Manager → main → Studio: one banner action with main's request id. */
export type BannerRelayCommand = BannerRelayAction & { requestId: string }

/** The projection: only the three fields, whatever the list carries. */
export function bannerSummaries(banners: readonly BannerSummary[]): BannerSummary[] {
  return banners.map(({ id, name, shown }) => ({ id, name, shown }))
}

export type BannerNameMatch =
  | { kind: 'match'; banner: BannerSummary }
  | { kind: 'none' }
  | { kind: 'ambiguous'; names: string[] }

const folded = (name: string): string => name.trim().toLowerCase()

/**
 * The banner `/banner <name>` means (plan 186): case-insensitive, an exact
 * name wins, otherwise a prefix only one banner has.
 */
export function matchBannerName(query: string, banners: readonly BannerSummary[]): BannerNameMatch {
  const wanted = folded(query)
  if (!wanted) return { kind: 'none' }
  const exact = banners.filter((banner) => folded(banner.name) === wanted)
  const candidates = exact.length
    ? exact
    : banners.filter((banner) => folded(banner.name).startsWith(wanted))
  if (candidates.length === 1) return { kind: 'match', banner: candidates[0] }
  return candidates.length
    ? { kind: 'ambiguous', names: candidates.map((banner) => banner.name) }
    : { kind: 'none' }
}

/** "Sponsor and Spring sale", "Logo, Sponsor, and Spring sale". */
function namesInWords(names: readonly string[]): string {
  return new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' }).format(names)
}

/** What `/banner` alone says. */
export const BANNER_COMMAND_USAGE =
  "Type a banner's name after /banner, or /banner off to hide them all."
/** `/banner` with nothing to show or hide. */
export const NO_BANNERS_YET = 'No banners yet. Import banners in Assets.'

/**
 * `/banner <name>` and `/banner off` (plan 186): the explicit action for the
 * banner the name means, with its verb from the state the window shows, or
 * the composer's words for why not. "off" is reserved: it hides them all.
 */
export function classifyBannerCommand(
  query: string,
  banners: readonly BannerSummary[]
): { kind: 'banner'; action: BannerRelayAction } | { kind: 'error'; message: string } {
  const typed = query.trim()
  if (!banners.length) return { kind: 'error', message: NO_BANNERS_YET }
  if (!typed) return { kind: 'error', message: BANNER_COMMAND_USAGE }
  if (typed.toLowerCase() === 'off') return { kind: 'banner', action: { action: 'hideAll' } }
  const match = matchBannerName(typed, banners)
  if (match.kind === 'none') return { kind: 'error', message: `No banner called “${typed}”.` }
  if (match.kind === 'ambiguous') {
    return { kind: 'error', message: `“${typed}” matches ${namesInWords(match.names)}.` }
  }
  return {
    kind: 'banner',
    action: { action: match.banner.shown ? 'hide' : 'show', id: match.banner.id }
  }
}

/** One row of the composer's completion list: the text and what it does. */
export interface ComposerCompletion {
  value: string
  hint: string
}

const BANNER_COMMAND = /^\/banner(?:\s+([\s\S]*))?$/i

/**
 * The completions under `/banner` (plan 186): each banner whose name starts
 * with what follows, with what Enter does to it, then `/banner off`. Null
 * when the draft isn't a `/banner` command.
 */
export function bannerCompletions(
  draft: string,
  banners: readonly BannerSummary[]
): ComposerCompletion[] | null {
  const command = BANNER_COMMAND.exec(draft.trimStart())
  if (!command) return null
  const typed = folded(command[1] ?? '')
  const seen = new Set<string>()
  const completions: ComposerCompletion[] = []
  for (const banner of banners) {
    const value = `/banner ${banner.name.trim()}`
    if (!folded(banner.name).startsWith(typed) || seen.has(value)) continue
    seen.add(value)
    completions.push({ value, hint: banner.shown ? ' · Hide' : ' · Show' })
  }
  if (banners.length && 'off'.startsWith(typed)) {
    completions.push({ value: '/banner off', hint: ' · Hide all banners' })
  }
  return completions
}
