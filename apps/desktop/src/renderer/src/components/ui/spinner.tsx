import { SpinnerIcon, type AppIconProps } from '@/components/icons'
import { cn } from '@/lib/utils'

// shadcn `spinner`, on the registry's SpinnerIcon (plan 174 S1.5, J1-21).
// One spinner everywhere work is in flight. It announces itself as a status
// ("Loading", or the `aria-label` it is given); a spinner beside its own words
// (a busy button's label) or one a parent already announces passes
// `aria-hidden` and stays silent. Its size comes from the slot it sits in
// (a Button's or a Badge's icon rule, 1em elsewhere) unless a `size-*` class
// sets one. Reduced motion stops the turn (styles.css).
function Spinner({
  className,
  'aria-label': ariaLabel = 'Loading',
  'aria-hidden': ariaHidden,
  ...props
}: AppIconProps) {
  const hidden = ariaHidden === true || ariaHidden === 'true'
  return (
    <SpinnerIcon
      data-slot="spinner"
      {...(hidden ? { 'aria-hidden': true } : { role: 'status', 'aria-label': ariaLabel })}
      className={cn('animate-spin', className)}
      {...props}
    />
  )
}

export { Spinner }
