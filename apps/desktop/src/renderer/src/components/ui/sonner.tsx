'use client'

import { useTheme } from 'next-themes'
import { Toaster as Sonner } from 'sonner'
import type { ToasterProps } from 'sonner'

import { CloseIcon, ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'

// Every toast is the same neutral float glass, and a type colours its 16 px
// icon only. The glass and the icon tones live in the theme's sonner block,
// not in a class here: sonner injects unlayered CSS that a layered utility
// cannot beat. Each toast can be dismissed, so the close button is on.
const Toaster = ({ closeButton = true, toastOptions, ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      className="toaster group"
      closeButton={closeButton}
      icons={{
        close: <CloseIcon className="size-3.5" />,
        error: <ErrorIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        loading: <Spinner aria-hidden className="size-4" />,
        success: <SuccessIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />
      }}
      theme={theme as ToasterProps['theme']}
      toastOptions={{
        ...toastOptions,
        closeButtonAriaLabel: toastOptions?.closeButtonAriaLabel ?? 'Dismiss notification'
      }}
      {...props}
    />
  )
}

export { Toaster }
