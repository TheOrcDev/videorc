// Plan 260: the by-eye screen gallery (`pnpm gallery:gpui`,
// `scripts/gpui-gallery.mjs`). The pure half: which screens it shoots and how
// each opens, the parity rows each covers, the manifest, and the Live pages
// the owner answers on. The runner launches the app; this file never does.

import { createHash } from 'node:crypto'

/** The two looks the owner checks (Increase Contrast stays in the baseline). */
export const LOOKS = Object.freeze(['dark', 'light'])

/** The baseline's page sizes (S0.10 shot every screen at each). */
export const WINDOW_SIZES = Object.freeze(['1280x800', '1100x720', '960x660'])

/** A `WIDTHxHEIGHT` the baseline has, as a window size. */
export function parseWindowSize(size) {
  if (!WINDOW_SIZES.includes(size)) {
    throw new Error(`The baseline has no ${size} shots; pick one of ${WINDOW_SIZES.join(', ')}.`)
  }
  const [width, height] = size.split('x').map(Number)
  return Object.freeze({ width, height })
}

/**
 * The window's content size, the baseline's page size (CSS pixels, shot at
 * 2x). `VIDEORC_GALLERY_WINDOW=960x660` shoots a narrow window (one-column
 * layouts under 940 px of page) against the baseline's shots at that size.
 */
export const WINDOW = parseWindowSize(process.env.VIDEORC_GALLERY_WINDOW ?? '1280x800')

/** The pages a gallery is cut into, so each stays under a Live page's 8 MiB. */
export const DECKS = Object.freeze([
  { id: 'shell-studio', title: 'Shell, Studio, Sources and Scene' },
  { id: 'pages', title: 'Captions, Output, Library, Images, Sounds and Health' },
  { id: 'livestream', title: 'Destinations, Go Live, Guests and Avatar' },
  { id: 'sidekick', title: 'Sidekick' },
  { id: 'settings', title: 'Settings and first run' }
])

const page = (tab, extra = {}) => ({ tab, ...extra })

/**
 * Every screen on main the gallery shoots: how it opens (`open-tab`'s params,
 * or a toast), the S0.10 Electron baseline shot it pairs with (null when
 * Electron has none), and the `docs/gpui/parity.md` sections it covers
 * (heading prefixes).
 */
export const SCREENS = Object.freeze([
  {
    id: 'shell',
    title: 'Shell: sidebar, title bar and status bar',
    deck: 'shell-studio',
    open: page('studio'),
    baseline: { screen: 'shell', state: 'default' },
    sections: [
      'Shell: sidebar',
      'Shell: account row and menu',
      'Shell: status bar and bell',
      'Shell: window frame'
    ]
  },
  {
    id: 'studio',
    title: 'Studio ⌘1, idle',
    deck: 'shell-studio',
    open: page('studio'),
    baseline: { screen: 'studio', state: 'idle' },
    sections: [
      'Studio page shell',
      'Preview stage',
      'Session transport',
      'Session panel rows',
      'Audio section, default look',
      'Scenes section',
      'Scene card',
      'Studio dashboard bottom row'
    ]
  },
  {
    id: 'sources',
    title: 'Sources ⌘2',
    deck: 'shell-studio',
    open: page('sources'),
    baseline: { screen: 'sources', state: 'default' },
    sections: [
      'Sources page header',
      'Permission alerts',
      'Video column',
      'Source item shell',
      'Audio mixer column'
    ]
  },
  {
    id: 'scene',
    title: 'Scene ⌘3',
    deck: 'shell-studio',
    open: page('layout'),
    // The Scene page opens a closed Preview docked (P532); Electron's
    // baseline has none, so its Canvas draws the schematic. Close it here too.
    closePreview: true,
    baseline: { screen: 'scene', state: 'default' },
    sections: ['Scene ⌘3: Scenes list', 'Scene ⌘3: Layout section', 'Scene ⌘3: Hide screen']
  },
  {
    id: 'studio-retro',
    title: 'Studio ⌘1, Retro LCD look',
    deck: 'shell-studio',
    open: page('studio'),
    // Settings → General → Retro LCD Studio, on for this screen only.
    settings: { key: 'videorc.settings', patch: { retroLcdStudio: true } },
    baseline: { screen: 'studio-retro', state: 'default' },
    sections: ['Audio section, Retro LCD look', 'Retro LCD transport']
  },
  {
    id: 'palette',
    title: '⌘K command palette',
    deck: 'shell-studio',
    open: page('studio', { dialog: 'palette' }),
    close: 'Escape',
    baseline: { screen: 'palette', state: 'open' },
    sections: ['⌘K command palette']
  },
  {
    id: 'toast-success',
    title: 'Toast: success',
    deck: 'shell-studio',
    toast: 'success',
    baseline: { screen: 'toasts', state: 'success' },
    sections: ['Notification centre']
  },
  {
    id: 'toast-error',
    title: 'Toast: error',
    deck: 'shell-studio',
    toast: 'error',
    baseline: { screen: 'toasts', state: 'error' },
    sections: ['Notification centre']
  },
  {
    id: 'captions',
    title: 'Captions ⌘4',
    deck: 'pages',
    open: page('captions'),
    baseline: { screen: 'captions', state: 'default' },
    sections: ['Captions ⌘4']
  },
  {
    id: 'output',
    title: 'Output ⌘5',
    deck: 'pages',
    open: page('recording'),
    baseline: { screen: 'output', state: 'default' },
    sections: [
      'Output ⌘5: Local recording',
      'Output ⌘5: Clips',
      'Output ⌘5: Videorc Camera',
      'Output ⌘5: Where recordings go',
      'Encoder preference'
    ]
  },
  {
    id: 'library',
    title: 'Library ⌘0',
    deck: 'pages',
    open: page('library'),
    baseline: { screen: 'library', state: 'default' },
    sections: ['Library page']
  },
  {
    id: 'images',
    title: 'Images ⇧⌘G',
    deck: 'pages',
    open: page('assets'),
    baseline: { screen: 'assets', state: 'default' },
    sections: ['Images page']
  },
  {
    id: 'sounds',
    title: 'Sounds ⇧⌘S',
    deck: 'pages',
    open: page('sounds'),
    baseline: { screen: 'sounds', state: 'default' },
    sections: ['Sounds page']
  },
  {
    id: 'health',
    title: 'Health',
    deck: 'pages',
    open: page('diagnostics'),
    baseline: { screen: 'health', state: 'default' },
    sections: ['Health page']
  },
  {
    id: 'destinations',
    title: 'Destinations ⌘6, Setup',
    deck: 'livestream',
    open: page('live'),
    baseline: { screen: 'livestream-setup', state: 'default' },
    sections: [
      'Destinations ⌘6',
      'Destination card',
      'Stream details',
      'Broadcast info fields',
      'Stream quality',
      'Go Live panel',
      'Videorc Cloud section',
      'Watchdog section',
      'Stream report email',
      'Chat commands section'
    ]
  },
  {
    id: 'go-live',
    title: 'Go Live dialog',
    deck: 'livestream',
    open: page('studio', { dialog: 'go-live' }),
    // GPUI's dialog doesn't take the key focus Escape needs, and the UI
    // driver's tree doesn't reach real builds yet: Cancel, else a fresh app.
    close: { click: { name: 'Cancel', role: 'button' } },
    restart: true,
    baseline: { screen: 'go-live', state: 'dialog' },
    sections: ['Go Live dialog']
  },
  {
    id: 'guests',
    title: 'Guests ⌘7',
    deck: 'livestream',
    open: page('guests'),
    baseline: null,
    sections: ['Guests']
  },
  // Plan 260 C4: Show stage / Vertical stream / talk-show host. Seeds are
  // harness-only (`gallery-seed-show-stage` / `gallery-seed-vertical-stream`);
  // no LiveKit, X or YouTube.
  {
    id: 'show-stage-closed',
    title: 'Show stage, room closed (Preview stays)',
    deck: 'shell-studio',
    open: page('studio'),
    seed: { command: 'gallery-seed-show-stage', params: { kind: 'closed' } },
    // Electron PNGs land with the next `--screens=show-stage` baseline run
    // (`rust-ui-baseline.mjs` already shoots closed/open/screens/host-camera-off).
    baseline: null,
    sections: ['Preview stage', 'Show stage']
  },
  {
    id: 'show-stage-open',
    title: 'Show stage, room open (guests + layout cards, one disabled)',
    deck: 'shell-studio',
    open: page('studio'),
    seed: { command: 'gallery-seed-show-stage', params: { kind: 'open' } },
    // Layout / Screens / People sit under the Program well; scroll so the
    // kinds differ on screen (open vs screens vs host-camera-off).
    scroll: { dy: 420 },
    // Clear the seed after the looks so later Studio shots stay Preview.
    after: { command: 'gallery-seed-show-stage', params: { kind: 'closed' } },
    baseline: null,
    sections: ['Show stage']
  },
  {
    id: 'show-stage-screens',
    title: 'Show stage, Screens cards',
    deck: 'shell-studio',
    open: page('studio'),
    seed: { command: 'gallery-seed-show-stage', params: { kind: 'screens' } },
    scroll: { dy: 420 },
    after: { command: 'gallery-seed-show-stage', params: { kind: 'closed' } },
    baseline: null,
    sections: ['Show stage']
  },
  {
    id: 'talk-show-host-camera-off',
    title: 'Talk-show host, camera off',
    deck: 'shell-studio',
    open: page('studio'),
    seed: { command: 'gallery-seed-show-stage', params: { kind: 'host-camera-off' } },
    scroll: { dy: 420 },
    after: { command: 'gallery-seed-show-stage', params: { kind: 'closed' } },
    baseline: null,
    sections: ['Show stage', 'Talk-show room host']
  },
  {
    id: 'vertical-stream',
    title: 'Studio ⌘1, Vertical stream slot',
    deck: 'shell-studio',
    open: page('studio'),
    seed: { command: 'gallery-seed-vertical-stream', params: { on: true } },
    // After the seed, scroll the Vertical stream panel into view (Studio's
    // reveal door), as Electron scrolls the Studio scroller to its foot.
    afterSeed: { command: 'studio-reveal-vertical-stream' },
    after: { command: 'gallery-seed-vertical-stream', params: { on: false } },
    baseline: { screen: 'studio', state: 'vertical-leg' },
    sections: ['Vertical stream', 'Studio dashboard bottom row']
  },
  {
    id: 'avatar-profile',
    title: 'Avatar ⌘8, Profile',
    deck: 'livestream',
    open: page('avatar', { subTab: 'profile' }),
    baseline: { screen: 'avatar-profile', state: 'default' },
    sections: ['Avatar page', 'Avatar → Profile']
  },
  // Profile below the fold: the page scrolled down by `dy` CSS pixels (the
  // smoke driver's `ui-scroll`, a wheel at the window's centre; Electron's
  // shooter sets the page-tabs scroller's `scrollTop` to the same value).
  {
    id: 'avatar-profile-2',
    title: 'Avatar ⌘8, Profile scrolled: Name and personality, Look',
    deck: 'livestream',
    open: page('avatar', { subTab: 'profile' }),
    scroll: { dy: 600 },
    baseline: { screen: 'avatar-profile', state: 'scroll-2' },
    sections: ['Avatar → Profile: Name and personality', 'Avatar → Profile: Look']
  },
  {
    id: 'avatar-profile-3',
    title: 'Avatar ⌘8, Profile scrolled: Reactions and Motion',
    deck: 'livestream',
    open: page('avatar', { subTab: 'profile' }),
    scroll: { dy: 1200 },
    baseline: { screen: 'avatar-profile', state: 'scroll-3' },
    sections: ['Avatar → Profile: Reactions and Motion']
  },
  {
    id: 'avatar-greetings',
    title: 'Avatar ⌘8, Greetings',
    deck: 'livestream',
    open: page('avatar', { subTab: 'greetings' }),
    baseline: { screen: 'avatar-greetings', state: 'default' },
    sections: ['Avatar → Greetings']
  },
  ...[
    ['live', 'Overview', 'buddy-overview', 'Sidekick page'],
    ['chat', 'Chat', 'buddy-chat', 'Sidekick → Chat'],
    ['community', 'Community', 'buddy-community', 'Sidekick → Community'],
    ['voice', 'Voice', 'buddy-voice', 'Sidekick → Voice'],
    ['reports', 'Reports', 'buddy-reports', 'Sidekick → Reports'],
    ['clean-cut', 'Clean cut', 'buddy-clean-cut', 'Sidekick → Clean cut']
  ].map(([subTab, label, screen, section]) => ({
    id: `sidekick-${subTab}`,
    title: `Sidekick ⌘9, ${label} (signed out)`,
    deck: 'sidekick',
    open: page('ai', { subTab }),
    baseline: { screen, state: 'locked' },
    sections: [section]
  })),
  ...[
    ['general', 'General', 'Settings (⌘,)'],
    ['permissions', 'Permissions', 'Settings → Permissions'],
    ['shortcuts', 'Shortcuts', 'Settings → Shortcuts'],
    ['remote', 'Remote', 'Settings → Remote'],
    ['about', 'About', 'Settings → About']
  ].map(([subTab, label, section]) => ({
    id: `settings-${subTab}`,
    title: `Settings ⌘,, ${label}`,
    deck: 'settings',
    open: page('settings', { subTab }),
    baseline: { screen: `settings-${subTab}`, state: 'default' },
    sections: [section]
  })),
  ...['permissions', 'goal', 'look', 'sound', 'destinations'].map((step) => ({
    id: `first-run-${step}`,
    title: `First run: ${step}`,
    deck: 'settings',
    // The baseline's record: in progress at `step`, goal Stream.
    open: page('studio', { dialog: 'first-run', step, goal: 'stream' }),
    // First run holds the window until it is finished, so these go last.
    last: true,
    reduceMotion: true,
    baseline: { screen: 'first-run', state: step },
    sections: ['First run (']
  })),
  // Coverage (overnight 11-26): the states Electron's shooter has, opened
  // the way it opens them. `clicks` press the first name that exists, in
  // order; `window` shoots one of the app's other windows at the
  // baseline's size.
  ...['info', 'warning'].map((kind) => ({
    id: `toast-${kind}`,
    title: `Toast: ${kind}`,
    deck: 'shell-studio',
    toast: kind,
    baseline: { screen: 'toasts', state: kind },
    sections: ['Notification centre']
  })),
  {
    id: 'account-menu',
    title: 'Account menu (signed out)',
    deck: 'shell-studio',
    open: page('studio'),
    clicks: [{ names: ['Sign in'], role: 'button' }],
    close: 'Escape',
    baseline: { screen: 'account-menu', state: 'open' },
    sections: ['Shell: account row and menu']
  },
  {
    id: 'scene-item-selected',
    title: 'Scene ⌘3, Test pattern selected',
    deck: 'shell-studio',
    open: page('layout'),
    closePreview: true,
    clicks: [
      { names: ['Select Test pattern', 'Select Test pattern, on', 'Select Test pattern, off'] }
    ],
    close: 'Escape',
    baseline: { screen: 'scene', state: 'item-selected' },
    sections: ['Scene ⌘3: Layout section']
  },
  {
    id: 'destinations-stream-quality',
    title: 'Destinations ⌘6, Twitch open (Stream quality)',
    deck: 'livestream',
    open: page('live'),
    // The row's title opens the card; the same press closes it after each
    // look, since the page remembers an open card and the next look presses
    // it again.
    clicks: [{ names: ['Twitch'] }],
    close: { click: { name: 'Twitch' } },
    baseline: { screen: 'livestream-setup', state: 'stream-quality' },
    sections: ['Destination card', 'Stream quality']
  },
  {
    id: 'library-kebab',
    title: 'Library ⌘0, a session ⋯ menu',
    deck: 'pages',
    open: page('library'),
    clicks: [{ names: ['Session actions'], role: 'button' }],
    close: 'Escape',
    baseline: { screen: 'library', state: 'kebab-menu' },
    sections: ['Library page']
  },
  {
    id: 'library-player',
    title: 'Library ⌘0, a session in the player (Markers)',
    deck: 'pages',
    open: page('library'),
    // Electron's shooter: the row's ⋯, then Markers, which opens the player.
    clicks: [{ names: ['Session actions'], role: 'button' }, { names: ['Markers'] }],
    close: 'Escape',
    baseline: { screen: 'library-player', state: 'default' },
    sections: ['Library page']
  },
  {
    id: 'stream-manager-window',
    title: 'Stream Manager window ⇧⌘J, 1100 px band',
    deck: 'livestream',
    open: page('studio'),
    window: {
      role: 'comments',
      open: 'comments-window-open',
      bounds: 'comments-window-set-bounds',
      close: 'comments-window-close',
      width: 1100,
      height: 700
    },
    baseline: { screen: 'stream-manager', state: 'band-1100', size: { width: 1100, height: 700 } },
    sections: ['Stream Manager — window and tiers']
  },
  {
    id: 'captions-reader-window',
    title: 'Captions reader window ⇧⌘C',
    deck: 'pages',
    open: page('studio'),
    window: {
      role: 'captions',
      open: 'captions-window-open',
      bounds: 'captions-window-set-bounds',
      close: 'captions-window-close',
      width: 640,
      height: 320
    },
    baseline: { screen: 'captions-reader', state: 'default', size: { width: 640, height: 320 } },
    sections: ['Captions reader window (components/captions-reader.tsx)']
  }
])

/** Screens in the order the runner shoots them: first run last. */
export function shootingOrder(screens = SCREENS) {
  return [...screens.filter((s) => !s.last), ...screens.filter((s) => s.last)]
}

/** `--screens=studio,settings-*` narrowed list (a trailing `*` is a prefix). */
export function pickScreens(list, screens = SCREENS) {
  if (!list) return [...screens]
  const wanted = list
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const unknown = wanted.filter((name) => !screens.some((screen) => matches(name, screen.id)))
  if (unknown.length) throw new Error(`No gallery screen is called ${unknown.join(', ')}.`)
  return screens.filter((screen) => wanted.some((name) => matches(name, screen.id)))
}

function matches(pattern, id) {
  return pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : pattern === id
}

/** A shot's file stem: `<screen>-<look>-<app>`. */
export function shotName(screenId, look, app) {
  return `${screenId}-${look}-${app}`
}

/** The baseline PNG a screen pairs with in `look`, relative to the baseline folder. */
export function baselinePath(screen, look) {
  if (!screen.baseline) return null
  const { screen: folder, state, size = WINDOW } = screen.baseline
  return `${folder}/${state}-${size.width}x${size.height}-${look}.png`
}

/**
 * The parity rows a screen covers: every control row under a section whose
 * heading starts with one of `screen.sections`, with its macOS cell.
 */
export function rowsFor(parsed, screen) {
  const rows = parsed.controls.filter((row) =>
    screen.sections.some((prefix) => row.section.startsWith(prefix))
  )
  const sections = [...new Set(rows.map((row) => row.section))]
  return {
    sections,
    rows: rows.map((row) => ({ id: row.id, macos: row.platforms.macos })),
    ticked: rows.filter((row) => row.platforms.macos === '[x]').length,
    open: rows.filter((row) => row.platforms.macos === '[ ]').length
  }
}

/** `P101–P104, P120`: row ids as ranges. */
export function rowRanges(ids) {
  const numbers = ids
    .map((id) => /^P(\d+)$/.exec(id))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b)
  const parts = []
  for (let i = 0; i < numbers.length; i += 1) {
    let end = i
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end] + 1) end += 1
    const pad = (n) => `P${String(n).padStart(3, '0')}`
    parts.push(end > i ? `${pad(numbers[i])}–${pad(numbers[end])}` : pad(numbers[i]))
    i = end
  }
  return parts.join(', ')
}

/** Short content hash of a file's bytes (the manifest's change check). */
export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/**
 * Whether a screen goes on today's page: its rows are not all ticked, and
 * (with a previous manifest) one of its GPUI shots differs from last time by
 * more than `changedShare` of its pixels.
 */
export function needsLook(entry, previous, changedShare = 0.002) {
  if (entry.parity.open === 0 && entry.parity.rows.length > 0) return false
  if (!previous) return true
  const before = previous.screens?.find((screen) => screen.id === entry.id)
  if (!before) return true
  return entry.shots.some((shot) => {
    const old = before.shots?.find((candidate) => candidate.look === shot.look)
    if (!old?.gpui || !shot.gpui) return true
    if (old.gpui.digest === shot.gpui.digest) return false
    return (shot.changedShare ?? 1) > changedShare
  })
}

const escape = (text) =>
  String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const PAGE_STYLE = `
  gx-wide > section[data-question] { min-width: 0; max-width: 100%; box-sizing: border-box; --gx-option-min: 0px; }
  .pair { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); }
  .pair figure { margin: 0; min-width: 0; }
  .pair img { display: block; box-sizing: border-box; width: 100%; max-width: 100%; height: auto; border-radius: 10px; border: 1px solid var(--gx-line); }
  .pair figcaption { margin-top: 4px; font-size: 12px; color: var(--gx-muted); }
  .none { display: grid; place-items: center; min-height: 120px; border-radius: 10px; border: 1px dashed var(--gx-line-strong); color: var(--gx-muted); font-size: 13px; padding: 12px; text-align: center; }
  .rows { font-size: 12.5px; color: var(--gx-muted); overflow-wrap: anywhere; }
  .rows b { color: var(--gx-text); font-weight: 600; }
  .why { font-size: 13px; color: var(--gx-muted); }
`

function head(title) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ghostex-page" content="v2">
<title>${escape(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>`
}

function figure(src, caption, missing) {
  if (!src)
    return `<figure><div class="none">${escape(missing)}</div><figcaption>${escape(caption)}</figcaption></figure>`
  return `<figure><img src="${escape(src)}" alt="${escape(caption)}"><figcaption>${escape(caption)}</figcaption></figure>`
}

/** One screen: Electron and GPUI side by side, dark and light, then its question. */
export function screenCard(entry) {
  const tabs = entry.shots
    .map((shot) => {
      const electron = figure(
        shot.electron?.image,
        'Electron (S0.10 baseline)',
        entry.baseline ? 'Missing from the baseline' : 'Electron has no shot of this screen'
      )
      const gpui = figure(shot.gpui?.image, 'GPUI', shot.gpui?.error ?? 'Not captured')
      return `<section data-tab="${shot.look === 'dark' ? 'Dark' : 'Light'}"><div class="pair">${electron}${gpui}</div></section>`
    })
    .join('\n')
  const parity = entry.parity
  const rows = parity.rows.length
    ? `<p class="rows"><b>${parity.rows.length} rows</b> (${parity.ticked} ticked on macOS): ${escape(rowRanges(parity.rows.map((row) => row.id)))}. Sections: ${escape(parity.sections.join('; '))}.</p>`
    : '<p class="rows">No parity rows matched this screen.</p>'
  return `
  <gx-wide><section data-question="${escape(entry.id)}" data-choice="Matches">
  <h2 id="${escape(entry.id)}">${escape(entry.title)}</h2>
  ${rows}
  <gx-tabs>
${tabs}
  </gx-tabs>
  </section></gx-wide>
  <gx-question tag="${escape(entry.id)}" title="${escape(entry.title)}: does GPUI match Electron?">
    <gx-choice value="Matches">Matches<small>I tick this screen's rows on macOS.</small></gx-choice>
    <gx-choice value="Small issues">Small issues<small>Say what in the note; the owning lane gets it.</small></gx-choice>
    <gx-choice value="Wrong">Wrong<small>The owning lane redoes it.</small></gx-choice>
  </gx-question>`
}

/** A deck: its screens' cards in one question page. */
export function deckHtml({ deck, entries, date, sha }) {
  const title = `GPUI gallery: ${date} ${sha}, ${deck.title}`
  const captured = entries.filter((entry) => entry.shots.some((shot) => shot.gpui?.image)).length
  return `${head(title)}
<gx-questions submit="Send to the coordinator">
  <header>
    <span class="gx-eyebrow">Plan 260 · by-eye check</span>
    <h1>${escape(title)}</h1>
    <p class="gx-lede">Electron on the left, GPUI on the right, both at a 1280×800 window. Flip Dark and Light on each card, then answer per screen.</p>
    <div class="gx-chips">
      <span class="gx-chip"><b>${entries.length}</b> screens</span>
      <span class="gx-chip"><b>${captured}</b> shot on GPUI</span>
      <span class="gx-chip">main ${escape(sha)}</span>
    </div>
  </header>
  <p class="why">"Matches" ticks the screen's macOS rows in docs/gpui/parity.md. "Small issues" and "Wrong" go to the owning lane's queue with your note.</p>
${entries.map(screenCard).join('\n')}
</gx-questions>
</body>
</html>
`
}

/** The cover: one link per deck, with its counts. */
export function coverHtml({ decks, date, sha, skipped = [] }) {
  const title = `GPUI gallery: ${date} ${sha}`
  const cards = decks
    .map(
      ({ deck, file, entries }) => `
    <div class="gx-card">
      <h3><a href="${escape(file)}">${escape(deck.title)}</a></h3>
      <div class="gx-chips"><span class="gx-chip"><b>${entries.length}</b> screens</span><span class="gx-chip"><b>${entries.reduce((sum, entry) => sum + entry.parity.rows.length, 0)}</b> parity rows</span></div>
    </div>`
    )
    .join('')
  const skippedList = skipped.length
    ? `<h2>Not on these pages</h2><ul>${skipped.map((item) => `<li><b>${escape(item.id)}</b>: ${escape(item.reason)}</li>`).join('')}</ul>`
    : ''
  return `${head(title)}
<gx-page>
  <header>
    <span class="gx-eyebrow">Plan 260 · by-eye check</span>
    <h1>${escape(title)}</h1>
    <p class="gx-lede">Every GPUI screen on main next to Electron, in dark and light. Open a page, answer each screen, and send it.</p>
    <div class="gx-chips">
      <span class="gx-chip"><b>${decks.reduce((sum, d) => sum + d.entries.length, 0)}</b> screens</span>
      <span class="gx-chip"><b>${decks.length}</b> pages</span>
      <span class="gx-chip">main ${escape(sha)}</span>
    </div>
  </header>
  <div class="gx-grid">${cards}
  </div>
  ${skippedList}
</gx-page>
</body>
</html>
`
}
