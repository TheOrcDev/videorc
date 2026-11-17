import { useEffect, useState } from 'react'
import { useStudioCloud, useStudioCore, useStudioDiagnostics } from '@/hooks/use-studio'
import type { CloudArchiveView } from '@/lib/backend'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export function LibraryCloudArchive() {
  const { client } = useStudioDiagnostics()
  const { cloudStatus } = useStudioCloud()
  const { settings } = useStudioCore()
  const showId = cloudStatus?.show?.id
  const [jobs, setJobs] = useState<CloudArchiveView[]>([])
  const [availability, setAvailability] = useState({
    available: false,
    reason: 'Open a cloud room to check archive availability.'
  })
  const [orientation, setOrientation] = useState<'h' | 'v'>('h')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!client) return
    let live = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const rows = await client.requestTyped('cloud.archive.status')
        if (live) setJobs(rows)
      } catch {
        /* Disconnect retains last confirmed job state. */
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [client])
  useEffect(() => {
    let live = true
    setAvailability({
      available: false,
      reason: 'Open a cloud room to check archive availability.'
    })
    if (client && showId)
      void client
        .requestTyped('cloud.archive.availability', { showId })
        .then((value) => {
          if (live) setAvailability(value)
        })
        .catch(() => {
          if (live)
            setAvailability({
              available: false,
              reason: 'Archive availability could not be confirmed.'
            })
        })
    return () => {
      live = false
    }
  }, [client, showId])
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await run()
      if (client) setJobs(await client.requestTyped('cloud.archive.status'))
    } catch {
      setError('The archive action could not finish. Check its status before retrying.')
    } finally {
      setBusy(false)
    }
  }
  const enable = async () => {
    if (!client || !showId || !availability.available) return
    let outputDirectoryCapability: string | undefined
    if (settings.outputDirectoryHandle) {
      const grant = await window.videorc?.authorizeOutputDirectory?.(settings.outputDirectoryHandle)
      if (!grant) throw new Error('Recording folder unavailable')
      outputDirectoryCapability = grant.capabilityId
    }
    await client.requestTyped('cloud.archive.start', {
      consent: true,
      showId,
      orientation,
      outputDirectoryCapability
    })
  }
  return (
    <PanelSection
      title="Local program archive"
      description="A local copy supplied by cloud egress and your network. It cannot protect against losing that connection. Enable first, then start cloud Record separately. Up to five minutes and 256 MiB per enablement; cloud usage is bounded to 0.10 account-currency units."
    >
      <p className="text-muted-foreground text-sm">{availability.reason}</p>
      <ToggleGroup
        aria-label="Archive orientation"
        value={[orientation]}
        onValueChange={(values) => {
          if (values[0] === 'h' || values[0] === 'v') setOrientation(values[0])
        }}
      >
        <ToggleGroupItem value="h">Horizontal</ToggleGroupItem>
        <ToggleGroupItem value="v">Vertical</ToggleGroupItem>
      </ToggleGroup>
      <Button
        variant="outline"
        disabled={
          !availability.available ||
          busy ||
          jobs.some((j) => ['copying', 'waiting', 'finalizing'].includes(j.state))
        }
        onClick={() => void act(enable)}
      >
        Enable local archive
      </Button>
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {jobs.map((job) => (
        <div key={job.id} className="flex flex-col gap-2">
          <p className="text-sm">
            {job.state} · {job.segments} segments · {(job.bytes / 1048576).toFixed(1)} MiB
          </p>
          <p className="text-muted-foreground text-sm">{job.reason}</p>
          <div className="flex gap-2">
            {['waiting', 'copying', 'finalizing'].includes(job.state) ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => client?.requestTyped('cloud.archive.stop', { id: job.id }))
                  }
                >
                  Stop archive
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      client?.requestTyped('cloud.archive.cancel', { id: job.id })
                    )
                  }
                >
                  Cancel archive
                </Button>
              </>
            ) : (
              <>
                {job.state === 'interrupted' && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        client?.requestTyped('cloud.archive.resume', { id: job.id })
                      )
                    }
                  >
                    Resume archive
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      client?.requestTyped('cloud.archive.discard', { id: job.id })
                    )
                  }
                >
                  Discard staging files
                </Button>
              </>
            )}
          </div>
        </div>
      ))}
    </PanelSection>
  )
}
