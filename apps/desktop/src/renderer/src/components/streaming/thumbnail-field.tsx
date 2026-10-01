import { useState, type ReactElement } from 'react'

import { ImageBrokenIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { scheduledThumbnailUrl } from '@/lib/scheduled-streams'

/** YouTube thumbnails are 16:9; anything else is letterboxed. 1% tolerance. */
export function isSixteenByNine(width: number, height: number): boolean {
  if (!width || !height) return true
  return Math.abs(width / height / (16 / 9) - 1) <= 0.01
}

/**
 * A livestream thumbnail picked into the managed thumbnail root (plan 083):
 * shared by Broadcast info and the schedule dialog. The native picker
 * validates and stores the image; this only holds its content id.
 */
export function ThumbnailField({
  assetId,
  alt,
  hint,
  disabled = false,
  removable = true,
  onChange,
  onError
}: {
  assetId: string | null | undefined
  alt: string
  hint: string
  disabled?: boolean
  removable?: boolean
  onChange: (assetId: string | null) => void
  /** Import failures. Without it the message shows under the field. */
  onError?: (message: string) => void
}): ReactElement {
  const [error, setError] = useState('')
  // Measured from the loaded preview, so a thumbnail saved earlier is checked too.
  const [size, setSize] = useState<{ id: string; width: number; height: number } | null>(null)
  const [brokenId, setBrokenId] = useState<string | null>(null)
  const broken = Boolean(assetId) && brokenId === assetId
  const measured = size && size.id === assetId ? size : null

  const choose = (): void => {
    setError('')
    void window.videorc
      .importScheduledThumbnail()
      .then((image) => {
        if (image) onChange(image.id)
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (onError) onError(message)
        else setError(message)
      })
  }

  return (
    <Field>
      <FieldLabel>Thumbnail</FieldLabel>
      {assetId && !broken ? (
        <img
          alt={alt}
          className="aspect-video max-h-40 w-fit rounded-row border border-border object-contain"
          draggable={false}
          src={scheduledThumbnailUrl(assetId)}
          onError={() => setBrokenId(assetId)}
          onLoad={(event) =>
            setSize({
              id: assetId,
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight
            })
          }
        />
      ) : null}
      {broken ? (
        <FieldDescription className="flex items-center gap-2">
          <ImageBrokenIcon className="size-4 shrink-0" />
          The thumbnail file is missing. Choose it again.
        </FieldDescription>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} size="sm" variant="outline" onClick={choose}>
          {assetId ? 'Replace thumbnail' : 'Choose thumbnail'}
        </Button>
        {assetId && removable ? (
          <Button
            disabled={disabled}
            size="sm"
            variant="ghost"
            onClick={() => {
              setError('')
              onChange(null)
            }}
          >
            Remove thumbnail
          </Button>
        ) : null}
      </div>
      {error ? <FieldDescription role="alert">{error}</FieldDescription> : null}
      {measured && !isSixteenByNine(measured.width, measured.height) ? (
        <FieldDescription>This image is not 16:9. YouTube will add bars.</FieldDescription>
      ) : null}
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  )
}
