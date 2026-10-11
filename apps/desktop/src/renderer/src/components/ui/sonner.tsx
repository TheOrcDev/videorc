'use client'

import { useTheme } from 'next-themes'
import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { CloseIcon, ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'

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
        loading: <Spinner aria-hidden className="size-4" />,
        close: <CloseIcon className="size-3.5" />
      }}
      toastOptions={{
        ...toastOptions,
        closeButtonAriaLabel: toastOptions?.closeButtonAriaLabel ?? 'Dismiss notification',
        classNames: {
          ...toastOptions?.classNames,
          // Toasts are floating surfaces (plan 072): the float glass and the
          // typed tints live in styles.css (the sonner block), because sonner
          // injects unlayered CSS that a layered utility cannot beat.
          toast: toastOptions?.classNames?.toast
        }
      }}
      {...props}
    />
  )
}

export { Toaster }
