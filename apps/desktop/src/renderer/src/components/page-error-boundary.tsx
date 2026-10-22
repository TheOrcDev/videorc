import { Suspense, lazy, type ReactElement, type ReactNode } from 'react'

import { ErrorBoundary } from '@/components/error-boundary'

const PageErrorPanel = lazy(async () => ({
  default: (await import('@/components/page-error-panel')).PageErrorPanel
}))

/**
 * Catches a render crash in the active page (plan 174 S3.21, A-7): the
 * sidebar, the status bar and every other page keep working. Key it by the
 * page, so moving to another page always starts clean. "Reload page"
 * renders the page again; a chunk that failed to load fails again at once,
 * and the root panel's reload is the way out then. Main window only, so its
 * panel may lean on the main window's modules.
 */
export function PageErrorBoundary({ children }: { children: ReactNode }): ReactElement {
  return (
    <ErrorBoundary
      fallback={(caught, reset) => (
        <Suspense fallback={null}>
          <PageErrorPanel {...caught} onReset={reset} />
        </Suspense>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
