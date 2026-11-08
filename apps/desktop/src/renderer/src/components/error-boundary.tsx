'use client'

// An error boundary is a class, and a class keeps its state with setState.
/* oxlint-disable react/no-set-state */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

/** What a boundary caught, for a fallback's "Copy details". */
interface CaughtError {
  error: Error
  componentStack: string | null
}

interface ErrorBoundaryProps {
  children: ReactNode
  /** Draws the caught error; `reset` renders the children again. */
  fallback: (caught: CaughtError, reset: () => void) => ReactNode
  /** Reports the crash (a log line, a crash reporter). React logs it as well. */
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  caught: CaughtError | null
}

/**
 * The one boundary: `fallback` draws the caught error and gets `reset`,
 * which renders the children again. Without a boundary React 19 unmounts the
 * whole root on an uncaught render error, which in a window means an empty
 * frame with no way back. Wrap the window's shell in one, so a crash still
 * leaves a way to reload; wrap each page in another, keyed by the page, so
 * a crash stays in the page and the rest of the window keeps working.
 *
 * A class, because only a class component can catch a render error.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { caught: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { caught: { componentStack: null, error } }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
    this.setState({
      caught: { componentStack: info.componentStack ?? null, error }
    })
  }

  private readonly reset = (): void => {
    this.setState({ caught: null })
  }

  render(): ReactNode {
    const { caught } = this.state
    return caught ? this.props.fallback(caught, this.reset) : this.props.children
  }
}

/** What "Copy details" puts on the clipboard: the error and where it rendered. */
function errorDetails(error: Error, componentStack?: string | null): string {
  const lines = [error.stack || `${error.name}: ${error.message}`]
  if (componentStack?.trim()) {
    lines.push('Rendered by:', componentStack.trim())
  }
  return lines.join('\n')
}

export { ErrorBoundary, errorDetails, type CaughtError, type ErrorBoundaryProps }
