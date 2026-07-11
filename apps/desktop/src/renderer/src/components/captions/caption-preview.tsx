import { Eye } from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStudioCore } from '@/hooks/use-studio'
import { renderCaptionCueFramePng } from '@/lib/caption-overlay'
import { cn } from '@/lib/utils'

type PreviewBackdrop = 'dark' | 'light' | 'motion'

const PREVIEW_WIDTH = 960
const SAMPLE_CAPTION = 'Your words become clear, live captions.'

export function CaptionPreview(): ReactElement {
  const { captionLines, captureConfig } = useStudioCore()
  const [backdrop, setBackdrop] = useState<PreviewBackdrop>('motion')
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null)
  const latest = captionLines.at(-1)
  const text = latest?.text.trim() || SAMPLE_CAPTION
  const aspect = captureConfig.video.width / Math.max(1, captureConfig.video.height)
  const previewHeight = Math.max(360, Math.round(PREVIEW_WIDTH / aspect))
  const isSample = !latest

  useEffect(() => {
    let cancelled = false
    void renderCaptionCueFramePng({
      text,
      canvasWidth: PREVIEW_WIDTH,
      canvasHeight: previewHeight,
      styleId: captureConfig.captions.styleId,
      position: captureConfig.captions.position,
      textSize: captureConfig.captions.textSize
    })
      .then((png) => {
        if (!cancelled) setOverlayUrl(png ? `data:image/png;base64,${png}` : null)
      })
      .catch(() => {
        if (!cancelled) setOverlayUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [captureConfig.captions, previewHeight, text])

  const backdropClass = useMemo(
    () =>
      backdrop === 'light'
        ? 'bg-[linear-gradient(135deg,#f4f4f5_0%,#d4d4d8_45%,#a1a1aa_100%)]'
        : backdrop === 'dark'
          ? 'bg-[linear-gradient(135deg,#09090b_0%,#27272a_55%,#18181b_100%)]'
          : 'bg-[radial-gradient(circle_at_25%_20%,#64748b_0%,transparent_32%),radial-gradient(circle_at_78%_70%,#7c3aed_0%,transparent_30%),linear-gradient(135deg,#0f172a,#334155)]',
    [backdrop]
  )

  return (
    <PanelSection
      action={
        <Badge variant={isSample ? 'secondary' : 'success'}>{isSample ? 'Sample' : 'Live'}</Badge>
      }
      className="lg:sticky lg:top-4"
      description="The selected style at your current video aspect ratio."
      icon={Eye}
      title="Caption preview"
    >
      <div
        aria-label={`${captionStyleLabel(captureConfig.captions.styleId)} caption preview: ${text}`}
        className={cn(
          'relative aspect-video w-full overflow-hidden rounded-panel border border-border shadow-inner',
          backdropClass
        )}
        role="img"
        style={{ aspectRatio: `${PREVIEW_WIDTH} / ${previewHeight}` }}
      >
        <div
          aria-hidden
          className="absolute inset-0 opacity-35 [background-image:linear-gradient(90deg,transparent_49%,rgba(255,255,255,0.08)_50%,transparent_51%)] [background-size:8rem_100%]"
        />
        {overlayUrl ? (
          <img alt="" aria-hidden className="absolute inset-0 size-full" src={overlayUrl} />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{text}</p>
          <p className="text-xs text-muted-foreground">
            {captureConfig.video.width} × {captureConfig.video.height} ·{' '}
            {captureConfig.captions.position === 'top' ? 'Top' : 'Bottom'}
          </p>
        </div>
        <ToggleGroup
          aria-label="Preview background"
          size="sm"
          type="single"
          value={backdrop}
          variant="outline"
          onValueChange={(value) => {
            if (value === 'dark' || value === 'light' || value === 'motion') setBackdrop(value)
          }}
        >
          <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          <ToggleGroupItem value="light">Light</ToggleGroupItem>
          <ToggleGroupItem value="motion">Mixed</ToggleGroupItem>
        </ToggleGroup>
      </div>
    </PanelSection>
  )
}

function captionStyleLabel(styleId: string): string {
  switch (styleId) {
    case 'classic':
      return 'Classic'
    case 'lower-third':
      return 'Lower third'
    case 'high-contrast':
      return 'High contrast'
    default:
      return 'Glass'
  }
}
