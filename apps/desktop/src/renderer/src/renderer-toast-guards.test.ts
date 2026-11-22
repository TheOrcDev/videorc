import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Plan 174 S2.4 (J2-7): raw error text never reaches a toast. A toast says
// what failed and what to do (`userErrorMessage` / `toastUserError` in
// lib/user-error.ts); the raw text goes to the console and the support
// bundle. This guard reads every `toast(…)`, `toast.<kind>(…)` and
// `notifyOnce(…)` call in the renderer and fails when its arguments read an
// error's `.message`, stringify an error, or pass the error text through
// `ipcErrorMessage`.

const RENDERER_ROOT = join(__dirname, '..')

/** Names an error usually goes by in a `catch` or a rejection handler. */
const ERROR_NAME = /^(?:e|err|error|cause|reason|rejection|\w+Error)$/

const TOAST_CALLEE =
  /^(?:toast(?:\.(?:error|warning|success|info|message|loading|problem))?|notifyOnce)$/

function rendererSources(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') walk(path)
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        files.push(path)
      }
    }
  }
  walk(RENDERER_ROOT)
  return files
}

function isErrorName(node: ts.Node): boolean {
  return ts.isIdentifier(node) && ERROR_NAME.test(node.text)
}

/** Each toast call in `source` whose arguments pass raw error text, as `path:line text`. */
function rawErrorToasts(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: string[] = []
  const leaks = (node: ts.Node): boolean => {
    // `error.message`
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'message' &&
      isErrorName(node.expression)
    ) {
      return true
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file)
      // `String(error)` and `ipcErrorMessage(error)`
      if (
        (callee === 'String' || callee === 'ipcErrorMessage') &&
        node.arguments.some((argument) => isErrorName(argument))
      ) {
        return true
      }
    }
    // A nested function (an action's onClick) is its own code, not this toast's text.
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false
    return ts.forEachChild(node, (child) => (leaks(child) ? true : undefined)) ?? false
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && TOAST_CALLEE.test(node.expression.getText(file))) {
      if (node.arguments.some((argument) => leaks(argument))) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
        found.push(`${path}:${line + 1} ${node.getText(file).replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// Whole-renderer source scans are CPU-bound: under a parallel full run on a
// laptop they pass vitest's 5 s default (ogre 2026-10-12: 6.9 s; 1.5 s alone).
const SOURCE_SCAN_TIMEOUT = { timeout: 30_000 }

describe('renderer toast guards (plan 174 S2.4)', SOURCE_SCAN_TIMEOUT, () => {
  it('never hands a toast raw error text', () => {
    const offenders = rendererSources().flatMap((path) =>
      rawErrorToasts(relative(RENDERER_ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8'))
    )
    expect(offenders).toEqual([])
  })

  it('catches error.message, String(error) and ipcErrorMessage, and leaves copy alone', () => {
    const source = [
      'toast.error(error instanceof Error ? error.message : "Import failed.")',
      'toast.error("Couldn\'t import the image", { description: String(error) })',
      "notifyOnce('k', 'error', ipcErrorMessage(chatError))",
      "toast(err.message, { id: 'x' })",
      'toast.warning(copy.title, { description: copy.description })',
      'toast.success(event.message)',
      "toast.info('Saved', { action: { label: 'Retry', onClick: () => log(error.message) } })",
      "toastUserError(error, { action: 'import', object: 'the image' })"
    ].join('\n')
    expect(rawErrorToasts('sample.ts', source).map((entry) => entry.split(' ')[0])).toEqual([
      'sample.ts:1',
      'sample.ts:2',
      'sample.ts:3',
      'sample.ts:4'
    ])
  })
})

// Plan 250: what Videorc notices on its own is an entry behind the bell, and
// only `lib/notifications/pop-up.ts` turns an entry into a toast. A toast is
// the answer to something the streamer just did, or one urgent problem, and
// it is never pinned: a toast that times out leaves its entry behind.

/** Files whose only job is unprompted news: they publish, and never toast. */
const UNPROMPTED_ONLY = /^src\/lib\/notifications\/sources\//

/**
 * The toasts that may still stay until closed, each for a reason a list
 * cannot serve.
 */
const PINNED_TOASTS_THAT_STAY = new Set([
  // "Remove this message?": a question with a 20 s deadline (D11).
  'src/lib/chat-moderation-relay.ts',
  // "Couldn't start": the answer to Record or Go Live, with its way out.
  'src/lib/session-start-failure.ts',
  // The same "Couldn't start", when the backend's refusal arrives first.
  'src/lib/studio-health.ts',
  // "Finish connecting in your browser": a step the streamer is in the middle of.
  'src/lib/studio-connection-toasts.ts'
])

/** Each `duration: Infinity` (or `Number.POSITIVE_INFINITY`) in `source`, as `path:line`. */
function pinnedDurations(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === 'duration' &&
      /^(?:Infinity|Number\.POSITIVE_INFINITY)$/.test(node.initializer.getText(file))
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push(`${path}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Each toast call in `source`, as `path:line`. */
function toastCalls(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && TOAST_CALLEE.test(node.expression.getText(file))) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push(`${path}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('notifications never toast around the store (plan 250)', SOURCE_SCAN_TIMEOUT, () => {
  const sources = (): { path: string; source: string }[] =>
    rendererSources().map((path) => ({
      path: relative(RENDERER_ROOT, path).split(sep).join('/'),
      source: readFileSync(path, 'utf8')
    }))

  it('the modules that only carry unprompted news call no toast', () => {
    const offenders = sources()
      .filter(({ path }) => UNPROMPTED_ONLY.test(path))
      .flatMap(({ path, source }) => [
        ...toastCalls(path, source),
        ...(/from '@\/lib\/toast'/.test(source) ? [`${path}: imports the toast door`] : [])
      ])
    expect(offenders).toEqual([])
  })

  it('no toast is pinned outside the named list', () => {
    const offenders = sources()
      .filter(({ path }) => !PINNED_TOASTS_THAT_STAY.has(path))
      .flatMap(({ path, source }) => pinnedDurations(path, source))
    expect(offenders).toEqual([])
  })

  it('every file on the list still pins a toast: a list entry is never stale', () => {
    const pinned = new Set(
      sources()
        .filter(({ source, path }) => pinnedDurations(path, source).length > 0)
        .map(({ path }) => path)
    )
    for (const path of PINNED_TOASTS_THAT_STAY) {
      expect(pinned.has(path), path).toBe(true)
    }
  })

  it('catches a pinned toast however the number is written, and a planted toast', () => {
    const source = [
      "toast.warning('Your stream is frozen', { duration: Infinity })",
      "toast('Saved', { duration: Number.POSITIVE_INFINITY, id: 'x' })",
      "toast.success('Saved', { duration: 8_000 })",
      'const limit = Number.POSITIVE_INFINITY'
    ].join('\n')
    expect(pinnedDurations('sample.ts', source)).toEqual(['sample.ts:1', 'sample.ts:2'])
    expect(
      toastCalls('src/lib/notifications/sources/health.ts', "toast.warning('Planted')")
    ).toEqual(['src/lib/notifications/sources/health.ts:1'])
    expect(UNPROMPTED_ONLY.test('src/lib/notifications/sources/health.ts')).toBe(true)
    expect(UNPROMPTED_ONLY.test('src/lib/notifications/pop-up.ts')).toBe(false)
  })
})

// The owner, 2026-11-22: "the first thing you see is a bunch of toasts". Plan
// 250 moved what Videorc notices on its own behind the bell; this keeps it
// there. Every toast call site in the renderer is on the inventory below,
// file by file. A new one fails until someone decides what it is:
// - the answer to something the streamer just did: raise the file's count;
// - something Videorc noticed on its own (a check at launch, a device, an
//   account, an update, a quota, the machine, a recovered take, the engine):
//   publish it to the notification store (`lib/notifications/sources/`)
//   instead. It is never a toast.
// A toast reached from a React effect runs without a press, so each of
// those is named on its own with the reason it is still an answer.

/** The calls that show a toast: sonner through the door, and its wrappers. */
const TOAST_SITE_CALLEE =
  /^(?:toast(?:\.(?:error|warning|success|info|message|loading|problem))?|notifyOnce|toastUserError|toastOffline|showBackendError|reportError|showStreamTargetNotice)$/

/** The bodies of the wrappers themselves, and the one door from the store. */
const TOAST_DOORS = new Set([
  'src/lib/toast.ts',
  'src/lib/notify-once.ts',
  'src/lib/user-error.ts',
  'src/lib/notifications/pop-up.ts'
])

const EFFECT_HOOK = /^(?:React\.)?(?:useEffect|useLayoutEffect|useInsertionEffect)$/
/** A backend event, a window event, or a bridge subscription: nobody pressed anything. */
const EVENT_SUBSCRIPTION = /(?:\.on|\.once|\.subscribe|\.addEventListener|\.videorc\.on[A-Z]\w*)$/
const TIMER = /^(?:window\.)?(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)$/

/** A function, or a hook that wraps one (`useCallback(() => …)`). */
function isFunctionLike(node: ts.Node): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true
  return (
    ts.isCallExpression(node) &&
    node.arguments.some(
      (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
    )
  )
}

/** The callee shows a toast, also behind `(pressed ? reportError : reportUnasked)(…)`. */
function isToastCallee(callee: ts.Expression, file: ts.SourceFile): boolean {
  if (ts.isParenthesizedExpression(callee)) return isToastCallee(callee.expression, file)
  if (ts.isConditionalExpression(callee)) {
    return isToastCallee(callee.whenTrue, file) || isToastCallee(callee.whenFalse, file)
  }
  return TOAST_SITE_CALLEE.test(callee.getText(file))
}

/** What runs the code with no press: the innermost effect, event or timer around it. */
type Unasked = 'effect' | 'event' | 'timer'

/** The name a call site goes by: the nearest named function, handler or prop above it. */
function siteOwner(node: ts.Node, file: ts.SourceFile): { name: string; unasked: Unasked | null } {
  let unasked: Unasked | null = null
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isCallExpression(at) && unasked === null) {
      const inside = at.arguments.some(
        (argument) =>
          (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
          argument.pos <= node.pos &&
          node.end <= argument.end
      )
      const callee = at.expression.getText(file)
      if (inside && EFFECT_HOOK.test(callee)) unasked = 'effect'
      else if (inside && EVENT_SUBSCRIPTION.test(callee)) unasked = 'event'
      else if (inside && TIMER.test(callee)) unasked = 'timer'
    }
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) {
      return { name: at.name.getText(file), unasked }
    }
    if (ts.isVariableDeclaration(at) || ts.isPropertyAssignment(at) || ts.isJsxAttribute(at)) {
      const value =
        at.initializer && ts.isJsxExpression(at.initializer)
          ? at.initializer.expression
          : at.initializer
      // Only a function names the site (a handler, a callback); a value such
      // as `const id = toast.loading(…)` runs where it stands.
      if (value && isFunctionLike(value) && value.pos <= node.pos && node.end <= value.end) {
        return { name: at.name.getText(file), unasked }
      }
    }
  }
  return { name: '(module)', unasked }
}

interface ToastSite {
  path: string
  line: number
  owner: string
  unasked: Unasked | null
}

function toastSites(path: string, source: string): ToastSite[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: ToastSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isToastCallee(node.expression, file)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      const owner = siteOwner(node, file)
      found.push({ path, line: line + 1, owner: owner.name, unasked: owner.unasked })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** `path > owner`, with `(effect)`, `(event)` or `(timer)` when no press runs it. */
function siteKey(site: ToastSite): string {
  return `${site.path} > ${site.owner}${site.unasked ? ` (${site.unasked})` : ''}`
}

/**
 * Every toast call site in the renderer, by file and the function it is in.
 * A new site, or one more in a function, fails until it is decided: the
 * answer to a press raises the number here; something Videorc noticed on its
 * own is published to the notification store instead.
 */
const TOAST_SITES: Record<string, number> = {
  'comments/main.tsx > CommentsWindowApp': 1,
  'comments/main.tsx > action': 2,
  'comments/main.tsx > answerBuddyConsent': 1,
  'comments/main.tsx > answerCommand': 1,
  'comments/main.tsx > answerRemoval': 1,
  'comments/main.tsx > onMarkClip': 2,
  'comments/main.tsx > onReconnectScopes': 2,
  'comments/main.tsx > onShowFollowNames': 2,
  'comments/main.tsx > openBuddyChatSettings': 1,
  'comments/main.tsx > openChatCommands': 1,
  'comments/main.tsx > openDestination': 1,
  'comments/main.tsx > removeFromChat': 1,
  'comments/main.tsx > runBanner': 2,
  'comments/main.tsx > runScreenPrivacy': 1,
  'comments/main.tsx > runSound': 2,
  'comments/main.tsx > sendBuddyAction': 1,
  'comments/main.tsx > sendCohostAction': 1,
  'comments/main.tsx > setBuddyAutoChat': 1,
  'comments/main.tsx > setBuddyLive': 1,
  'comments/main.tsx > signInToVideorc': 1,
  'comments/main.tsx > turnListeningOn': 1,
  'src/components/account-menu.tsx > requestOpen': 1,
  'src/components/buddy-persona-section.tsx > startOver': 1,
  'src/components/buddy-voice-commands.tsx > fix': 1,
  'src/components/buddy-voice-commands.tsx > save': 1,
  'src/components/captions/captions-controls.tsx > retry': 1,
  'src/components/clean-cut/clean-cut-card.tsx > cancel': 1,
  'src/components/clean-cut/clean-cut-card.tsx > retry': 1,
  'src/components/clean-cut/clean-cut-card.tsx > startCut': 1,
  'src/components/command-palette.tsx > onSelect': 1,
  'src/components/community/community-tab.tsx > answer': 1,
  'src/components/community/community-tab.tsx > exportCommunity': 3,
  'src/components/community/community-tab.tsx > importCommunity': 3,
  'src/components/community/community-tab.tsx > onConfirm': 1,
  'src/components/community/community-tab.tsx > save': 1,
  'src/components/community/person-card-body.tsx > onClick': 1,
  'src/components/community/person-card-body.tsx > run': 1,
  'src/components/community/remember-offer.tsx > answer': 1,
  'src/components/guests/guest-moderation.tsx > onConfirm': 1,
  'src/components/guests/guest-moderation.tsx > toggleMute': 1,
  'src/components/media/session-player.tsx > openExternally': 1,
  'src/components/notifications/notification-bell.tsx > change': 1,
  'src/components/notifications/notification-center.tsx > act': 2,
  'src/components/obs-import-dialog.tsx > apply': 1,
  'src/components/scheduled-streams.tsx > recover': 1,
  'src/components/session-markers-dialog.tsx > remove': 1,
  'src/components/settings/agents-section.tsx > onAgentChange': 1,
  'src/components/settings/agents-section.tsx > run': 1,
  'src/components/stream-manager/person-card-host.tsx > onConfirm': 2,
  'src/components/stream-manager/stream-manager.tsx > StreamManager': 1,
  'src/components/stream-manager/stream-manager.tsx > StreamManager (effect)': 3,
  'src/components/stream-manager/stream-manager.tsx > markAsBot': 2,
  'src/components/stream-manager/stream-manager.tsx > onClick': 1,
  'src/components/stream-manager/stream-manager.tsx > onUndo': 1,
  'src/components/streaming/stream-report-email-section.tsx > onEnabledChange': 1,
  'src/components/streaming/stream-report-email-section.tsx > onHistoryChange': 1,
  'src/components/streaming/watchdog-section.tsx > patch': 1,
  'src/components/studio/agents-session-row.tsx > onStop': 1,
  'src/components/studio/screen-privacy-control.tsx > toggle': 1,
  'src/components/studio/studio-chat.tsx > hide': 1,
  'src/components/tabs/assets-tab.tsx > importInto': 1,
  'src/components/tabs/buddy-tab.tsx > answer': 1,
  'src/components/tabs/buddy-tab.tsx > turnBuddyLive': 1,
  'src/components/tabs/diagnostics-tab.tsx > remove': 2,
  'src/components/tabs/library-cloud-iso.tsx > cancelImport': 1,
  'src/components/tabs/library-cloud-iso.tsx > importTake': 2,
  'src/components/tabs/library-cloud-recordings.tsx > download': 1,
  'src/components/tabs/library-tab.tsx > confirmDelete': 2,
  'src/components/tabs/library-tab.tsx > runCheck': 3,
  'src/components/tabs/library-tab.tsx > runDuplicate': 1,
  'src/components/tabs/library-tab.tsx > runImport': 1,
  'src/components/tabs/library-tab.tsx > runNoiseCleanupAction': 2,
  'src/components/tabs/library-tab.tsx > runRepair': 5,
  'src/components/tabs/library-tab.tsx > runRestore': 3,
  'src/components/tabs/recording-tab.tsx > chooseFolder': 1,
  'src/components/tabs/recording-tab.tsx > onChange': 1,
  'src/hooks/use-camera-low-light.ts > setCompensation': 1,
  'src/hooks/use-scenes.ts > rename': 1,
  'src/hooks/use-scenes.ts > write': 1,
  'src/hooks/use-screen-privacy.ts > turn': 1,
  'src/hooks/use-studio.tsx > StudioProviderReady (effect)': 2,
  'src/hooks/use-studio.tsx > StudioProviderReady (event)': 3,
  'src/hooks/use-studio.tsx > activateScreen': 3,
  'src/hooks/use-studio.tsx > apply': 1,
  'src/hooks/use-studio.tsx > applyDevice': 1,
  'src/hooks/use-studio.tsx > applySavedSceneResult': 8,
  'src/hooks/use-studio.tsx > applySceneInRoom': 2,
  'src/hooks/use-studio.tsx > applyVideoPreset': 1,
  'src/hooks/use-studio.tsx > authorizeXLive': 2,
  'src/hooks/use-studio.tsx > beginRemoteLanPairing': 1,
  'src/hooks/use-studio.tsx > clearActiveScreen': 3,
  'src/hooks/use-studio.tsx > commitSceneIdle': 1,
  'src/hooks/use-studio.tsx > completeAccountSignIn': 1,
  'src/hooks/use-studio.tsx > connectPlatformAccount': 2,
  'src/hooks/use-studio.tsx > deleteBanner': 1,
  'src/hooks/use-studio.tsx > deleteSavedScene': 2,
  'src/hooks/use-studio.tsx > deleteScreen': 2,
  'src/hooks/use-studio.tsx > disconnectPlatformAccount': 3,
  'src/hooks/use-studio.tsx > exhaustRetries': 1,
  'src/hooks/use-studio.tsx > exportSupportBundle': 3,
  'src/hooks/use-studio.tsx > failed': 1,
  'src/hooks/use-studio.tsx > handleRemoteIntent': 1,
  'src/hooks/use-studio.tsx > handleSystemPermission': 1,
  'src/hooks/use-studio.tsx > importBanner': 1,
  'src/hooks/use-studio.tsx > importScreenSelections': 1,
  'src/hooks/use-studio.tsx > loadSessionDetailsForClient': 1,
  'src/hooks/use-studio.tsx > markClip': 2,
  'src/hooks/use-studio.tsx > markCohostQuestionAnswered': 1,
  'src/hooks/use-studio.tsx > nudgeSceneSource': 1,
  'src/hooks/use-studio.tsx > offMarkerRefused (event)': 1,
  'src/hooks/use-studio.tsx > onClick': 1,
  'src/hooks/use-studio.tsx > openSessionCommentsWindow': 2,
  'src/hooks/use-studio.tsx > openSystemPermissionSettings': 1,
  'src/hooks/use-studio.tsx > persistWorkingVisual': 1,
  'src/hooks/use-studio.tsx > refreshBackend': 2,
  'src/hooks/use-studio.tsx > refreshDevices': 1,
  'src/hooks/use-studio.tsx > refreshPreview': 1,
  'src/hooks/use-studio.tsx > refreshYouTubeChannels': 1,
  'src/hooks/use-studio.tsx > refuseStart': 2,
  'src/hooks/use-studio.tsx > remoteControlRequest': 1,
  'src/hooks/use-studio.tsx > remoteLanRequest': 1,
  'src/hooks/use-studio.tsx > remuxSession': 1,
  'src/hooks/use-studio.tsx > renameScreen': 1,
  'src/hooks/use-studio.tsx > reorderScreen': 1,
  'src/hooks/use-studio.tsx > reportBannerError': 3,
  'src/hooks/use-studio.tsx > reportError': 1,
  'src/hooks/use-studio.tsx > reportSessionStartFailure': 1,
  'src/hooks/use-studio.tsx > requestCameraPresetTransaction': 3,
  'src/hooks/use-studio.tsx > requestLayoutTransaction': 7,
  'src/hooks/use-studio.tsx > requestRemoteMicrophoneMute': 1,
  'src/hooks/use-studio.tsx > requestStopSession': 1,
  'src/hooks/use-studio.tsx > resetSceneSource': 1,
  'src/hooks/use-studio.tsx > restartReplayForSources': 1,
  'src/hooks/use-studio.tsx > restorePreviousStreamKey': 2,
  'src/hooks/use-studio.tsx > retryCaptureRecovery': 1,
  'src/hooks/use-studio.tsx > revalidateGoLive': 1,
  'src/hooks/use-studio.tsx > revealPermissionTarget': 1,
  'src/hooks/use-studio.tsx > runBannerCommand': 1,
  'src/hooks/use-studio.tsx > runGoLiveConfirmation': 2,
  'src/hooks/use-studio.tsx > runPerformanceCheck': 1,
  'src/hooks/use-studio.tsx > runStartSession': 1,
  'src/hooks/use-studio.tsx > sampleAudioMeter': 2,
  'src/hooks/use-studio.tsx > save': 1,
  'src/hooks/use-studio.tsx > saveManualStreamKey': 2,
  'src/hooks/use-studio.tsx > saveStreamMetadataDraft': 4,
  'src/hooks/use-studio.tsx > scheduleHardwareAccelerationRetry': 1,
  'src/hooks/use-studio.tsx > scheduleRetry': 2,
  'src/hooks/use-studio.tsx > searchKickCategories': 1,
  'src/hooks/use-studio.tsx > searchTwitchCategories': 1,
  'src/hooks/use-studio.tsx > selectYouTubeChannel': 2,
  'src/hooks/use-studio.tsx > sendSimulcastLeg': 1,
  'src/hooks/use-studio.tsx > setSceneSourceVisible': 1,
  'src/hooks/use-studio.tsx > settlePreparedPlatformLifecycle': 1,
  'src/hooks/use-studio.tsx > settlePreviousPlatformLifecycle': 2,
  'src/hooks/use-studio.tsx > settleRetainedPreparedPlatformLifecycles': 3,
  'src/hooks/use-studio.tsx > signOutAccount': 1,
  'src/hooks/use-studio.tsx > startOnReadyDestinations': 2,
  'src/hooks/use-studio.tsx > startWithIntent': 1,
  'src/hooks/use-studio.tsx > stopReplayBuffer': 1,
  'src/hooks/use-studio.tsx > stopSession': 2,
  'src/hooks/use-studio.tsx > switchScene': 1,
  'src/hooks/use-studio.tsx > switchSourceDeviceLive': 2,
  'src/hooks/use-studio.tsx > talkShowError': 1,
  'src/hooks/use-studio.tsx > undoLayoutPatch': 1,
  'src/hooks/use-studio.tsx > warn': 1,
  'src/hooks/use-virtual-camera.ts > setOn': 1,
  'src/lib/audio/frame-loop.ts > tick': 1,
  'src/lib/chat-link-actions.ts > openChatLink': 1,
  'src/lib/chat-moderation-relay.ts > show': 1,
  'src/lib/cloud-notices.ts > endCloudShow': 1,
  'src/lib/cloud-notices.ts > handOffCloudShow': 2,
  'src/lib/cloud-notices.ts > runCloudTest': 1,
  'src/lib/cloud-notices.ts > setCloudSettings': 1,
  'src/lib/cloud-recording-downloads.ts > cancelCloudDownload': 1,
  'src/lib/cloud-recording-downloads.ts > revealCloudDownload': 1,
  'src/lib/cloud-recording-downloads.ts > startCloudDownload': 1,
  'src/lib/copy-text.ts > copyText': 2,
  'src/lib/global-shortcuts.ts > toggleSystemAudio': 2,
  'src/lib/marker-toast.ts > onClick': 1,
  'src/lib/marker-toast.ts > showMarkerToast': 1,
  'src/lib/notifications/relay.ts > applyNotificationAct': 1,
  'src/lib/replay-buffer.ts > showNothingToClip': 4,
  'src/lib/scene-transform-commit.ts > commitSceneTransform': 2,
  'src/lib/session-runtime-recovery.ts > showBackendError': 1,
  'src/lib/session-runtime-recovery.ts > showOAuthCallbackExhausted': 1,
  'src/lib/session-runtime-recovery.ts > showOAuthCallbackResult': 3,
  'src/lib/session-runtime-recovery.ts > showPlaybackProblem': 1,
  'src/lib/session-runtime-recovery.ts > showPremiumUpgrade': 1,
  'src/lib/session-runtime-recovery.ts > showSessionHealthEvent': 1,
  'src/lib/soundboard-actions.ts > change': 2,
  'src/lib/soundboard-actions.ts > importSounds': 5,
  'src/lib/soundboard-actions.ts > removeSoundWithUndo': 1,
  'src/lib/soundboard-actions.ts > restoreStarters': 4,
  'src/lib/soundboard-actions.ts > runSoundboardAction': 2,
  'src/lib/stream-manager-notifications.ts > showRelayedPopUp': 1,
  'src/lib/studio-connection-toasts.ts > onClick': 1,
  'src/lib/studio-connection-toasts.ts > showBrowserApproval': 1,
  'src/lib/studio-toasts.ts > showTakeoverEditRefused': 2,
  'src/lib/system-permission-orchestration.ts > runSystemPermissionAction': 4,
  'src/lib/talk-show-end.ts > onClick': 1,
  'src/lib/talk-show-end.ts > showTalkShowEndFailure': 1,
  'src/lib/watchdog-surface.ts > acknowledgeWatchdogAlert': 1,
  'src/lib/watchdog-surface.ts > runWatchdogFix': 2,
  'src/lib/watchdog-surface.ts > snoozeWatchdogAlert': 1,
  'src/lib/whats-new.ts > showReleaseNotesUnavailable': 1
}

/**
 * The sites an effect, an event or a timer runs, with the reason each is
 * still the answer to something the streamer did. Startup checks (devices,
 * accounts, updates, quotas, memory, a recovered take, the engine starting)
 * never belong here: they publish to the notification store.
 */
const UNASKED_TOASTS_THAT_STAY: Record<string, string> = {
  'src/components/stream-manager/stream-manager.tsx > StreamManager (effect)':
    "Sidekick's question, promise reminder and dead-air nudge (plan 250 D11)",
  'src/hooks/use-studio.tsx > offMarkerRefused (event)':
    'Answers a marker the streamer asked for by voice',
  'src/hooks/use-studio.tsx > StudioProviderReady (effect)':
    'Answers an image import the streamer started (the connection dropped under it), and a microphone permission the streamer just granted',
  'src/hooks/use-studio.tsx > StudioProviderReady (event)':
    'Answers a phone remote or Stream Deck press, a phone the streamer just paired, and a clip the streamer marked'
}

describe(
  'every toast call site is on the inventory (the owner, 2026-11-22)',
  SOURCE_SCAN_TIMEOUT,
  () => {
    const inventory = (): Record<string, number> => {
      const counts: Record<string, number> = {}
      for (const path of rendererSources()) {
        const relativePath = relative(RENDERER_ROOT, path).split(sep).join('/')
        if (TOAST_DOORS.has(relativePath)) continue
        for (const site of toastSites(relativePath, readFileSync(path, 'utf8'))) {
          const key = siteKey(site)
          counts[key] = (counts[key] ?? 0) + 1
        }
      }
      return counts
    }

    it('has no new toast: a new one is an answer to a press, or a notification', () => {
      const found = inventory()
      const changed = [...new Set([...Object.keys(found), ...Object.keys(TOAST_SITES)])]
        .filter((key) => (found[key] ?? 0) !== (TOAST_SITES[key] ?? 0))
        .map(
          (key) => `${key}: ${TOAST_SITES[key] ?? 0} on the list, ${found[key] ?? 0} in the code`
        )
      expect(changed).toEqual([])
    })

    it('no toast runs from an effect, an event or a timer without its reason', () => {
      const unasked = Object.keys(inventory()).filter((key) =>
        / \((?:effect|event|timer)\)$/.test(key)
      )
      expect(unasked.filter((key) => !(key in UNASKED_TOASTS_THAT_STAY))).toEqual([])
      expect(Object.keys(UNASKED_TOASTS_THAT_STAY).filter((key) => !unasked.includes(key))).toEqual(
        []
      )
    })

    it('names a planted startup toast by what runs it', () => {
      const source = [
        'function Panel() {',
        '  useEffect(() => {',
        "    void load().catch((error) => toastUserError(error, { action: 'load' }))",
        '  }, [])',
        "  client.on('health', () => toast.warning('This computer is overloaded'))",
        "  window.setTimeout(() => notifyOnce('k', 'info', 'Later'), 10)",
        "  useEffect(() => { const id = toast.loading('Starting') }, [])",
        "  return <Button onClick={() => toast.success('Saved')} />",
        '}',
        "const refresh = () => reportError(new Error('x'))",
        "const load = useCallback(() => (asked ? reportError : reportUnasked)(new Error('x')), [])"
      ].join('\n')
      expect(toastSites('src/sample.tsx', source).map(siteKey)).toEqual([
        'src/sample.tsx > Panel (effect)',
        'src/sample.tsx > Panel (event)',
        'src/sample.tsx > Panel (timer)',
        'src/sample.tsx > Panel (effect)',
        'src/sample.tsx > onClick',
        'src/sample.tsx > refresh',
        'src/sample.tsx > load'
      ])
    })
  }
)
