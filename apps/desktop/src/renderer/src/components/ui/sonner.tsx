'use client'

import { useTheme } from 'next-themes'
import { Toaster as Sonner, type ToasterProps } from 'sonner'
import {
  CloseIcon,
  ErrorIcon,
  InfoIcon,
  SpinnerIcon,
  SuccessIcon,
  WarningIcon
} from '@/components/icons'
const Toaster = ({ closeButton = true, toastOptions, ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      closeButton={closeButton}
      icons={{
        success: <SuccessIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
        error: <ErrorIcon className="size-4" />,
        loading: <SpinnerIcon className="size-4 animate-spin" />,
        close: <CloseIcon className="size-3.5" />
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)'
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        closeButtonAriaLabel: toastOptions?.closeButtonAriaLabel ?? 'Dismiss notification',
        classNames: {
          ...toastOptions?.classNames,
          // Toasts are floating surfaces (plan 050, D5): the near-opaque
          // popover token, one soft shadow, and a hairline ring. No backdrop
          // blur: it wedges the compositor on the vibrancy window.
          toast: ['cn-toast', 'shadow-soft', toastOptions?.classNames?.toast]
            .filter(Boolean)
            .join(' ')
        }
      }}
      {...props}
    />
  )
}

export { Toaster }
