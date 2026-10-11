import { useRef, useState, type ReactElement, type ReactNode } from 'react'

import type { CaughtError } from '@/components/error-boundary'
import { Button } from '@/components/ui/button'

// The root panel (plan 174 S3.21, A-7), loaded only once the root boundary
// caught something. Every window shares it, so it depends on nothing the
// main window alone loads (use-studio, copy-text, Empty): that would split
// those out of the main entry chunk into chunks of their own.

/** What "Copy details" puts on the clipboard: the error and where it rendered. */
export function errorDetails(error: Error, componentStack?: string | null): string {
  const lines = [error.stack || `${error.name}: ${error.message}`]
  if (componentStack?.trim()) lines.push('Rendered by:', componentStack.trim())
  return lines.join('\n')
}

/** copyText's "Copied" moment, without its toast: there may be no Toaster left. */
export function CopyDetailsButton({ details }: { details: string }): ReactElement {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<number | null>(null)
  const copy = async (): Promise<void> => {
    let next: 'copied' | 'failed' = 'copied'
    try {
      await navigator.clipboard.writeText(details)
    } catch (error) {
      console.warn('[copy] copy failed', error)
      next = 'failed'
    }
    setState(next)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setState('idle'), 1500)
  }
  return (
    <Button size="sm" type="button" variant="ghost" onClick={() => void copy()}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy details'}
    </Button>
  )
}

export function RootErrorPanel({
  error,
  componentStack,
  supportBundle,
  onReset
}: CaughtError & {
  /** The export button, where the studio provider is still there to serve it. */
  supportBundle?: ReactNode
  onReset: () => void
}): ReactElement {
  return (
    <div className="flex h-screen flex-col text-foreground" data-testid="app-error" role="alert">
      {/* The window's drag band: with the title bar hidden, nothing else
          lets the window move once the shell is gone. */}
      <div className="h-toolbar shrink-0 [-webkit-app-region:drag]" data-testid="app-error-drag" />
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="flex w-full max-w-md flex-col gap-3 rounded-panel border glass-float-dialog p-5">
          <h1 className="text-sm font-semibold">Videorc hit a problem</h1>
          <p className="text-[13px] text-muted-foreground">
            {supportBundle
              ? 'Try again, or reload Videorc. If it keeps happening, export a support bundle and send it to support.'
              : 'Try again, or reload Videorc. If it keeps happening, export a support bundle from Health after the reload.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="button" onClick={onReset}>
              Try again
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => location.reload()}>
              Reload Videorc
            </Button>
            <CopyDetailsButton details={errorDetails(error, componentStack)} />
            {supportBundle}
          </div>
        </div>
      </div>
    </div>
  )
}
