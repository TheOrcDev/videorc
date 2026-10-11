import { Component, Suspense, lazy, type ErrorInfo, type ReactElement, type ReactNode } from 'react'

// The root boundary (plan 174 S3.21, A-7), shared by every window: a crash
// in the shell itself (or in the providers above it) shows the root panel,
// which keeps a drag band so the window still moves, and a way to the
// support bundle. The main window's pages have their own boundary
// (page-error-boundary.tsx). The panel lives in its own chunk: this module
// is in every window's eager bundle, and the panel must depend on nothing
// the main window alone loads.

/** What a boundary caught, for the panel's "Copy details". */
export interface CaughtError {
  error: Error
  componentStack: string | null
}

const RootErrorPanel = lazy(async () => ({
  default: (await import('@/components/root-error-panel')).RootErrorPanel
}))

/**
 * The one boundary: `fallback` draws the caught error and gets `reset`,
 * which renders the children again.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode
    fallback: (caught: CaughtError, reset: () => void) => ReactNode
  },
  { caught: CaughtError | null }
> {
  state: { caught: CaughtError | null } = { caught: null }

  static getDerivedStateFromError(error: Error): { caught: CaughtError } {
    return { caught: { error, componentStack: null } }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[shell] render crash:', error, info.componentStack)
    this.setState({ caught: { error, componentStack: info.componentStack ?? null } })
  }

  private reset = (): void => {
    this.setState({ caught: null })
  }

  render(): ReactNode {
    const { caught } = this.state
    return caught ? this.props.fallback(caught, this.reset) : this.props.children
  }
}

/**
 * Last-resort catch for render crashes. Without it React 19 unmounts the
 * entire root on an uncaught render error, which in a transparent window
 * means an empty see-through frame with no way back. `supportBundle` is the
 * export button, passed in by the shell where the studio provider is still
 * there to serve it; the root boundary in main.tsx and the other windows
 * pass none. Should the panel's own chunk fail to load, a bare reload
 * button remains.
 */
export function AppErrorBoundary({
  children,
  supportBundle
}: {
  children: ReactNode
  supportBundle?: ReactNode
}): ReactElement {
  return (
    <ErrorBoundary
      fallback={(caught, reset) => (
        <ErrorBoundary
          fallback={() => (
            <div className="flex h-screen items-center justify-center" role="alert">
              <button className="text-sm underline" type="button" onClick={() => location.reload()}>
                Reload Videorc
              </button>
            </div>
          )}
        >
          <Suspense fallback={null}>
            <RootErrorPanel {...caught} supportBundle={supportBundle} onReset={reset} />
          </Suspense>
        </ErrorBoundary>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
