import { useState, type ReactElement } from 'react'

import { CameraIcon, CopyIcon, WarningIcon } from '@/components/icons'
import { PanelSection } from '@/components/panel-section'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useVirtualCamera } from '@/hooks/use-virtual-camera'
import type { VirtualCameraAction } from '@/lib/backend'
import { useCopyText } from '@/lib/copy-text'
import {
  VIDEORC_CAMERA,
  VIDEORC_CAMERA_DESCRIPTION,
  VIDEORC_CAMERA_SECTION_DESCRIPTION,
  VIDEORC_CAMERA_SECTION_TITLE,
  virtualCameraView,
  type VirtualCameraView
} from '@/lib/virtual-camera-view'

/** A pending action's words ("…" on every pending label). */
const PENDING_LABEL: Readonly<Record<Exclude<VirtualCameraAction, 'remove'>, string>> = {
  'open-approval-settings': 'Opening…',
  'set-up': 'Setting up…',
  'load-module': 'Loading…'
}

/**
 * Output → Camera for other apps (plan 214 E1, D14): Videorc Camera's one
 * home. One row: the switch, what it does, the state in one line and that
 * state's one action. On and off say nothing else: the row is the
 * confirmation. Where this computer can't have the camera (the hide rule),
 * the section isn't there.
 */
export function VideorcCameraSection(): ReactElement | null {
  const camera = useVirtualCamera()
  const view = virtualCameraView(camera)
  const [pending, setPending] = useState<Exclude<VirtualCameraAction, 'remove'> | 'switch' | null>(
    null
  )
  // A refusal from the switch or the action, under the row until the next try.
  const [problem, setProblem] = useState<string | null>(null)
  if (view.hidden) return null

  const run = async (
    what: Exclude<VirtualCameraAction, 'remove'> | 'switch',
    task: () => Promise<{ ok: boolean; message?: string }>
  ): Promise<void> => {
    setPending(what)
    setProblem(null)
    try {
      const result = await task()
      if (!result.ok) setProblem(result.message ?? null)
    } finally {
      setPending(null)
    }
  }

  return (
    <PanelSection
      description={VIDEORC_CAMERA_SECTION_DESCRIPTION}
      icon={CameraIcon}
      title={VIDEORC_CAMERA_SECTION_TITLE}
    >
      <FieldGroup variant="grouped">
        <SettingsRow
          data-state={camera.status?.state}
          data-testid="output-videorc-camera"
          description={
            <>
              <span className="block">{VIDEORC_CAMERA_DESCRIPTION}</span>
              <StatusLine view={view} />
              {view.command ? <CommandLine command={view.command} /> : null}
            </>
          }
          error={problem}
          label={VIDEORC_CAMERA}
        >
          <div className="flex shrink-0 items-center gap-2">
            {view.action ? (
              <Button
                data-testid="output-videorc-camera-action"
                disabled={!camera.connected || pending !== null}
                type="button"
                variant="outline"
                onClick={() => {
                  const action = view.action
                  if (action) void run(action.kind, () => camera.runAction(action.kind))
                }}
              >
                {pending === view.action.kind ? PENDING_LABEL[view.action.kind] : view.action.label}
              </Button>
            ) : null}
            <Switch
              checked={view.checked}
              data-testid="output-videorc-camera-switch"
              disabled={view.disabled || pending === 'switch'}
              onCheckedChange={(checked) => void run('switch', () => camera.setOn(checked))}
            />
          </div>
        </SettingsRow>
      </FieldGroup>
    </PanelSection>
  )
}

/** The state in one line. The tone rides on the icon; the words stay monochrome (plan 174 S1.8). */
function StatusLine({ view }: { view: VirtualCameraView }): ReactElement | null {
  const { line } = view
  if (!line) return null
  return (
    <span
      aria-live="polite"
      className={`mt-1 flex items-start gap-1.5 ${
        line.tone === 'warn' ? 'text-foreground' : 'text-muted-foreground'
      }`}
      data-testid="output-videorc-camera-status"
      data-tone={line.tone}
    >
      {line.busy ? (
        <Spinner aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      ) : line.tone === 'warn' ? (
        <WarningIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" weight="fill" />
      ) : line.tone === 'good' ? (
        <StatusDot className="mt-1.5 shrink-0" tone="good" />
      ) : null}
      <span>{line.text}</span>
    </span>
  )
}

/** Linux: the distro's install command, to copy into a terminal (D9). */
function CommandLine({ command }: { command: string }): ReactElement {
  const { copied, copy } = useCopyText()
  return (
    <span className="mt-1.5 flex min-w-0 items-center gap-2">
      <code
        className="min-w-0 truncate rounded-chip bg-inset px-1.5 py-0.5 font-mono text-xs text-foreground select-text"
        data-testid="output-videorc-camera-command"
      >
        {command}
      </code>
      <Button
        size="xs"
        type="button"
        variant="ghost"
        onClick={() => void copy(command, "Couldn't copy the command.")}
      >
        <CopyIcon data-icon="inline-start" />
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  )
}
