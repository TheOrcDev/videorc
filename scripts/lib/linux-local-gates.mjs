// Development gates with explicit Linux behavior. This is not an installed
// candidate acceptance record; that requires the physical ledger and pilot.
export const LINUX_SOURCE_GATES = [
  ['typecheck', 'pnpm', ['typecheck']],
  ['lint', 'pnpm', ['lint']],
  ['format', 'pnpm', ['format:check']],
  ['ui-registry', 'pnpm', ['ui:check']],
  ['dependency-audit', 'pnpm', ['audit:deps']],
  ['script-tests', 'pnpm', ['test:scripts']],
  ['desktop-tests', 'pnpm', ['--filter', '@videorc/desktop', 'test']],
  ['desktop-build', 'pnpm', ['build']],
  ['rust-format', 'cargo', ['fmt', '--check', '--all']],
  ['rust-tests', 'cargo', ['test', '-p', 'videorc-backend']],
  ['rust-clippy', 'cargo', ['clippy', '-p', 'videorc-backend', '--', '-D', 'warnings']]
].map(([id, command, args]) => ({ id, command, args, kind: 'source' }))

export const LINUX_RUNTIME_GATES = [
  ['first-run', 'smoke:first-run', /PASS first-run smoke: all steps passed/],
  ['encoders', 'smoke:linux-encoder-acceptance', /Linux L1\.5 hardware acceptance PASS\./],
  ['av-devices', 'smoke:linux-av-devices', /Linux AV devices smoke PASS \(mic, camera\)/],
  ['portal-capture', 'smoke:linux-portal-capture', /Linux portal capture smoke PASS \(granted\)/],
  ['portal-record', 'smoke:linux-portal-record', /Linux portal record smoke PASS:/],
  [
    'portal-preview',
    'smoke:portal-preview-proof',
    /Linux portal preview proof smoke PASS \(sourcePixelsPresent=true,/
  ],
  [
    'preview-lifecycle',
    'probe:preview-lifecycle:linux',
    /PASS - 20 repeated preview toggle cycles/
  ],
  ['recording-matrix', 'smoke:recording-matrix', /Recording matrix: (\d+)\/\1 combos PASS/],
  ['record-latency', 'smoke:record-latency:gate', /PASS in enforce mode/]
].map(([id, script, proof]) => ({ id, command: 'pnpm', args: [script], kind: 'runtime', proof }))

export function assessLinuxGateExit(step, { code, signal, output, timedOut = false }) {
  if (timedOut || signal || code !== 0)
    return { status: 'failed', reason: timedOut ? 'timeout' : `exit=${code}, signal=${signal}` }
  if (step.kind === 'runtime') {
    // Match skip results, not the first-run smoke's "skip-look" scenario,
    // which positively tests the user's Skip setup action.
    if (/\b(?:skipped|report-only)\b|\bskip(?=[:\s)])/i.test(output))
      return { status: 'blocked', reason: 'runtime reported skipped or report-only evidence' }
    if (!step.proof.test(output))
      return { status: 'failed', reason: 'missing positive Linux proof' }
    if (step.id === 'recording-matrix' && /Recording matrix: 0\/0/.test(output))
      return { status: 'failed', reason: 'empty recording matrix' }
  }
  return { status: 'pass', reason: null }
}

export function linuxGateEnvironment(env, outputDir, repoRoot = process.cwd()) {
  // Never pass release/upload/cloud authority into a development app.
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'XDG_SESSION_TYPE',
    'XDG_CURRENT_DESKTOP',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'RUSTUP_HOME',
    'CARGO_HOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'PKG_CONFIG_PATH',
    'LIBCLANG_PATH',
    'VIDEORC_WEB_DIR',
    'VIDEORC_LINUX_TESTER_NAME',
    'VIDEORC_LINUX_TESTER_MACHINE',
    'VIDEORC_LINUX_PHYSICAL_HARDWARE',
    'VIDEORC_LINUX_VAAPI_DEVICE',
    'VIDEORC_LINUX_AV_TONE',
    'VIDEORC_LINUX_AV_MICROPHONE_ID',
    'LIBVA_DRIVER_NAME',
    'LIBVA_DEVICE'
  ]
  const result = Object.fromEntries(
    allowed.filter((name) => env[name] != null).map((name) => [name, env[name]])
  )
  return {
    ...result,
    CARGO_BUILD_JOBS: '2',
    VIDEORC_APP_DATA_DIR: `${outputDir}/profile`,
    VIDEORC_SMOKE_OUTPUT_DIR: outputDir,
    VIDEORC_SMOKE_FFMPEG_PATH: `${repoRoot}/vendor/ffmpeg/linux-x64/bin/ffmpeg`,
    VIDEORC_LINUX_ENCODER_EVIDENCE_DIR: `${outputDir}/encoders`,
    VIDEORC_LINUX_H264_ENCODER: 'openh264',
    VIDEORC_PORTAL_EXPECT: 'granted',
    VIDEORC_PORTAL_RECORD_MOTION: '1',
    VIDEORC_PREVIEW_LIFECYCLE_CYCLES: '20'
  }
}
