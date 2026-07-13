export function buildRecordingStudioGateSteps({
  includeAppSmoke = true,
  includeDeviceSmoke = false
} = {}) {
  const steps = [
    {
      label: 'desktop recording studio unit tests',
      command: 'pnpm',
      args: [
        '--filter',
        '@videorc/desktop',
        'test',
        'capture.test.ts',
        'caption-overlay.test.ts',
        'captions-ui.test.ts',
        'background-assets.test.ts',
        'session-params.test.ts',
        'studio-health.test.ts',
        'noise-cleanup-view.test.ts',
        'library-noise-cleanup.test.ts',
        'studio-provider.integration.test.ts',
        'backend-rpc-contract.test.ts',
        'native-preview-present-policy.test.ts',
        'native-preview-first-frame.test.ts',
        'backend-isolation.test.ts'
      ]
    },
    {
      label: 'script artifact analyzer and A/V sync tests',
      command: 'pnpm',
      args: ['test:scripts']
    },
    {
      label: 'backend live layout tests',
      command: 'cargo',
      args: ['test', '-p', 'videorc-backend', 'live_layout::tests::']
    },
    {
      label: 'backend scene layout tests',
      command: 'cargo',
      args: ['test', '-p', 'videorc-backend', 'scene::tests::']
    },
    {
      label: 'backend recording pipeline tests',
      command: 'cargo',
      args: ['test', '-p', 'videorc-backend', 'recording::tests::']
    },
    {
      label: 'backend audio pipeline tests',
      command: 'cargo',
      args: ['test', '-p', 'videorc-backend', 'audio::tests::']
    },
    {
      label: 'backend noise cleanup tests',
      command: 'cargo',
      args: ['test', '-p', 'videorc-backend', 'noise_cleanup::tests::']
    }
  ]

  if (includeAppSmoke) {
    steps.push(
      {
        label: 'live captions transport contract smoke',
        command: 'pnpm',
        args: ['smoke:captions-contract']
      },
      {
        label: 'live captions mute/gain and record+stream artifact smoke',
        command: 'pnpm',
        args: ['smoke:captions-live']
      },
      {
        label: 'noise cleanup final-artifact smoke',
        command: 'pnpm',
        args: ['smoke:noise-cleanup']
      },
      {
        label: 'dev app all-layout recording artifact smoke',
        command: 'pnpm',
        args: ['smoke:dev']
      },
      {
        label: 'imported screen image recording smoke',
        command: 'pnpm',
        args: ['smoke:screens']
      },
      {
        // The reality gate: real capture config (no synthetic preview scene),
        // isolated backend state, and the first-frame contract at launch. This
        // is the scenario every other preview smoke bypasses via
        // VIDEORC_SMOKE_PREVIEW_MOTION (2026-07-01 incident).
        label: 'real-user launch first-frame contract smoke',
        command: 'pnpm',
        args: ['smoke:preview-real-launch']
      },
      {
        label: 'layout/source preview liveness smoke',
        command: 'pnpm',
        args: ['smoke:layout-source-loop']
      },
      {
        label: 'active-session live layout switch recording smoke',
        command: 'pnpm',
        args: ['smoke:live-layout-switch-recording']
      },
      {
        label: 'comment highlight stream artifact smoke',
        command: 'pnpm',
        args: ['smoke:comment-highlight-stream']
      },
      {
        label: 'backend-owned preview scene commit smoke',
        command: 'pnpm',
        args: ['smoke:preview-scene-commit']
      },
      {
        label: 'preview main pump diagnostics smoke',
        command: 'pnpm',
        args: ['smoke:preview-pump-diagnostics']
      },
      {
        label: 'preview click/focus continuity smoke',
        command: 'pnpm',
        args: ['smoke:preview-click-focus']
      },
      {
        // Combined perceptual contract: native CAMetalLayer continuity while
        // floating/docked windows move, focus/click changes, and rapid layout
        // intent replaces the previous scene without an artificial settle.
        label: 'preview interaction stress smoke',
        command: 'pnpm',
        args: ['smoke:preview-interaction-stress']
      },
      {
        label: 'detached preview lifecycle probe',
        command: 'pnpm',
        args: ['probe:preview-lifecycle']
      },
      {
        // Placement authority: floating open/move/resize/close/reopen plus the
        // docked ("stick") scenario — slot glue, main-window follow, stale-epoch
        // rejection, overlay/scroll occlusion, undock restore.
        label: 'preview window placement + docked stick probe',
        command: 'pnpm',
        args: ['probe:preview-window']
      },
      {
        label: 'detached native preview surface reattach smoke',
        command: 'pnpm',
        args: ['smoke:preview-surface'],
        env: {
          VIDEORC_PREVIEW_SURFACE_MIN_FPS: '30',
          VIDEORC_PREVIEW_SURFACE_MAX_INTERVAL_P95_MS: '120',
          VIDEORC_PREVIEW_SURFACE_MAX_INPUT_TO_PRESENT_P95_MS: '100'
        }
      },
      {
        label: 'real ScreenCaptureKit screen recording smoke',
        command: 'pnpm',
        args: ['smoke:screen-recording-real'],
        env: {
          VIDEORC_BASELINE_SOURCE_READINESS_MS: '60000'
        }
      },
      {
        label: 'Notes window recording invisibility smoke',
        command: 'pnpm',
        args: ['smoke:notes-window-invisible'],
        env: {
          VIDEORC_BASELINE_SOURCE_READINESS_MS: '60000'
        }
      }
    )
  }

  if (includeDeviceSmoke) {
    steps.push(
      {
        label: 'real-device preview interaction and recording artifact smoke',
        command: 'pnpm',
        args: ['smoke:preview-interaction-stress:devices']
      },
      {
        label: 'real ScreenCaptureKit live layout switch recording smoke',
        command: 'pnpm',
        args: ['smoke:live-layout-switch-recording:devices']
      },
      {
        label: 'native preview source-complete layout stress recording smoke',
        command: 'pnpm',
        args: ['smoke:recording-native-preview'],
        env: {
          VIDEORC_NATIVE_PREVIEW_SOURCE_COMPLETE_SCENE: '1',
          VIDEORC_NATIVE_PREVIEW_LAYOUT_STRESS_UPDATES: '4'
        }
      }
    )
  }

  return steps
}

export function formatRecordingStudioGatePlan({ steps }) {
  const lines = ['recording-studio-gates: plan']
  for (const [index, step] of steps.entries()) {
    lines.push(`${index + 1}. ${step.label}: ${formatCommand(step)}`)
  }
  return lines.join('\n')
}

function formatCommand(step) {
  const env = step.env
    ? `${Object.keys(step.env)
        .map((name) => `${name}=${step.env[name]}`)
        .join(' ')} `
    : ''
  return `${env}${step.command} ${step.args.join(' ')}`
}
