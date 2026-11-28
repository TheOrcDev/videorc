import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useStudioCloud, useStudioDiagnostics } from '@/hooks/use-studio'
import type { HostTranscriptCue } from '../../../../shared/cloud-speech'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { PanelSection } from '@/components/panel-section'
/** Owner-only local transcript. No browser storage, analytics or room transport. */
export function HostTranscript(): ReactElement | null {
  const { cloudStatus } = useStudioCloud()
  const { client } = useStudioDiagnostics()
  const showId = cloudStatus?.show?.id
  const owner = useRef({ showId, client })
  owner.current = { showId, client }
  const [rows, setRows] = useState<HostTranscriptCue[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    setRows([])
    setError(false)
  }, [showId, client])
  if (!showId || cloudStatus?.room?.phase !== 'open') return null
  return (
    <PanelSection title="Host transcript">
      <p className="text-xs text-muted-foreground">
        Saved on this computer. Times follow each processed microphone source; alignment with the
        cloud recording is unmeasured.
      </p>
      <Button
        variant="outline"
        disabled={!client}
        onClick={async () => {
          try {
            const next = await client!.requestTyped('cloud.speech.transcript', { showId })
            if (owner.current.showId !== showId || owner.current.client !== client) return
            setRows(next)
            setError(false)
          } catch {
            if (owner.current.showId !== showId || owner.current.client !== client) return
            setError(true)
          }
        }}
      >
        Refresh transcript
      </Button>
      {error && (
        <Alert>
          <AlertDescription>The host transcript is unavailable for this room.</AlertDescription>
        </Alert>
      )}
      <ol className="max-h-64 overflow-auto text-sm" aria-label="Saved host transcript">
        {rows
          .slice()
          .reverse()
          .map((cue) => (
            <li key={`${cue.sourceId}:${cue.speechSessionId}:${cue.seq}`}>
              <span className="text-muted-foreground">{cue.offsetSeconds.toFixed(1)}s </span>
              {cue.text}
            </li>
          ))}
      </ol>
    </PanelSection>
  )
}
