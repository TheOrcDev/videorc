import { useEffect, useState } from 'react'
import { useStudioCore, useStudioDiagnostics } from '@/hooks/use-studio'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { CloudClipsStatus, CloudClipJob } from '../../../../shared/cloud-clips'

/** Same Clips actions, cloud ownership. Never arms the native camera session. */
export function CloudClipsSection({ showId }: { showId: string }) {
  const { client } = useStudioDiagnostics()
  const { settings } = useStudioCore()
  const [status, setStatus] = useState<CloudClipsStatus | null>(null)
  const [jobs, setJobs] = useState<CloudClipJob[]>([])
  const [orientation, setOrientation] = useState<'h' | 'v'>('h')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true,
      pending = false
    const refresh = async () => {
      if (!client || pending) return
      pending = true
      try {
        const [s, j] = await Promise.all([
          client.requestTyped('cloud.clips.status', { showId }),
          client.requestTyped('cloud.clips.jobs')
        ])
        if (active) {
          setStatus(s)
          setJobs(j.filter((x) => x.showId === showId))
        }
      } catch {
        if (active) setStatus(null)
      } finally {
        pending = false
      }
    }
    setStatus(null)
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [client, showId])
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await run()
    } catch {
      setError(
        'The clip action could not finish. Check the current buffer and job status before retrying.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <PanelSection
      title="Clips"
      description="Save marked windows of the cloud program to Library. Enable first, then start cloud Record separately. The buffer keeps up to 90 seconds / 64 MiB, for at most five minutes per enablement. No recording starts automatically."
    >
      <p className="text-sm text-muted-foreground">
        {status?.reason ?? 'Clips availability is unconfirmed. Reconnect to check again.'}
      </p>
      <p className="text-xs text-muted-foreground">
        Opt-in cloud reads: up to 256 MiB and 0.10 account-currency units per enablement. Local
        staging is limited to 192 MiB; saved clips remain in Library until you delete them.
        Disabling clears the shared program buffer, including any archive using it.
      </p>
      <ToggleGroup
        aria-label="Clip program orientation"
        value={[orientation]}
        onValueChange={(v) => {
          if (v[0] === 'h' || v[0] === 'v') setOrientation(v[0])
        }}
      >
        <ToggleGroupItem value="h">Horizontal</ToggleGroupItem>
        <ToggleGroupItem value="v">Vertical</ToggleGroupItem>
      </ToggleGroup>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={!client || !status?.available || busy || status.enabled}
          onClick={() =>
            void act(async () => {
              const grant = settings.outputDirectoryHandle
                ? await window.videorc?.authorizeOutputDirectory?.(settings.outputDirectoryHandle)
                : undefined
              if (settings.outputDirectoryHandle && !grant)
                throw new Error('Recording folder unavailable')
              if (client)
                setStatus(
                  await client.requestTyped('cloud.clips.enable', {
                    showId,
                    consent: true,
                    orientation,
                    requestId: crypto.randomUUID(),
                    ...(grant ? { outputDirectoryCapability: grant.capabilityId } : {})
                  })
                )
            })
          }
        >
          Enable cloud Clips
        </Button>
        {status?.enabled && status.generation && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (client && status.generation)
                  setStatus(
                    await client.requestTyped('cloud.clips.disable', {
                      showId,
                      generation: status.generation
                    })
                  )
              })
            }
          >
            Disable Clips
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Use Save 30-second clip or Save 1-minute clip in Stream Manager. Without a confirmed media
        clock, the action saves a marker only.
      </p>
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {jobs.map((job) => (
        <div key={job.id} className="flex flex-col gap-2">
          <p className="text-sm">
            {job.state} · {job.reason}
          </p>
          {['downloading', 'trimming', 'publishing'].includes(job.state) ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(async () => client?.requestTyped('cloud.clips.cancel', { id: job.id }))
              }
            >
              Cancel clip
            </Button>
          ) : (
            <div className="flex gap-2">
              {job.state === 'interrupted' && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !status?.generation}
                  onClick={() =>
                    void act(async () => {
                      if (client && status?.generation)
                        await client.requestTyped('cloud.clips.save', {
                          showId,
                          markerId: job.markerId,
                          generation: status.generation
                        })
                    })
                  }
                >
                  Retry clip
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async () => client?.requestTyped('cloud.clips.discard', { id: job.id }))
                }
              >
                {job.state === 'complete' ? 'Dismiss job' : 'Discard staging files'}
              </Button>
            </div>
          )}
        </div>
      ))}
    </PanelSection>
  )
}
