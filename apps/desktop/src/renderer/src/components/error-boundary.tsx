import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'

/**
 * Last-resort catch for render crashes. Without it React 19 unmounts the
 * entire root on an uncaught render error, which in a transparent window
 * means an empty see-through frame with no way back. This keeps the shell
 * alive and offers a reload instead.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render crash caught by AppErrorBoundary:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children
    }
    return (
      <div className="flex h-screen items-center justify-center text-foreground">
        <div className="flex max-w-md flex-col gap-3 rounded-panel border border-border bg-popover p-5 shadow-glass">
          <h1 className="text-sm font-medium">Something broke in the interface</h1>
          <p className="text-[13px] text-muted-foreground">
            {this.state.error.message || 'An unexpected rendering error occurred.'}
          </p>
          <div>
            <Button size="sm" onClick={() => location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
