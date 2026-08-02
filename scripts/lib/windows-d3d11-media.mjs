import { createHash } from 'node:crypto'

export const WINDOWS_D3D11_MEDIA_SCHEMA = 'videorc.windows-d3d11-media-stage'
export const WINDOWS_D3D11_MEDIA_SCHEMA_VERSION = 1
export const WINDOWS_D3D11_PATH_SCHEMA = 'videorc.windows-d3d11-path-evidence'
export const WINDOWS_D3D11_HOST_SCHEMA = 'videorc.windows-d3d11-host-evidence'
export const WINDOWS_D3D11_AGGREGATE_SCHEMA = 'videorc.windows-d3d11-aggregate-evidence'

export const WINDOWS_D3D11_MEDIA_STAGES = Object.freeze([
  'contract',
  'capture',
  'compositor',
  'encoder',
  'preview'
])

export const WINDOWS_D3D11_HARDWARE_CLASSES = Object.freeze([
  'nvidia-turing-floor',
  'intel-xe-integrated',
  'unsupported-natural-fallback'
])

export const WINDOWS_D3D11_PROFILES = Object.freeze(['1080p30', '1080p60'])
export const WINDOWS_D3D11_PATH_EVIDENCE = Object.freeze(['forced', 'default', 'natural'])
export const WINDOWS_D3D11_SUPPORTED_PATHS = Object.freeze(['forced', 'default'])
export const WINDOWS_D3D11_NATURAL_FALLBACK_SCENARIOS = Object.freeze([
  '1080p30-stream-preview',
  '1080p30-stream-no-preview',
  '1080p30-record-stream-preview',
  '1080p30-record-stream-no-preview'
])

export const WINDOWS_D3D11_FAIRNESS_LIMITS = Object.freeze({
  messagePumpLagP95Ms: 50,
  messagePumpLagMaxMs: 100,
  mediaCommandLagP95Ms: 50,
  mediaCommandLagMaxMs: 100,
  maximumConsecutiveMessageBatch: 32,
  maximumConsecutiveMediaBatch: 32
})

export const WINDOWS_D3D11_STAGE_PRODUCER_SCENARIOS = Object.freeze({
  capture: '1080p30-stream-no-preview',
  compositor: '1080p30-screen-camera-stream-no-preview',
  encoder: '1080p30-record-stream-no-preview',
  preview: '1080p30-stream-preview'
})

export const WINDOWS_D3D11_SELECTION_ENVIRONMENT_KEYS = Object.freeze([
  'VIDEORC_WINDOWS_D3D11_MEDIA',
  'VIDEORC_WINDOWS_REQUIRE_D3D11_MEDIA',
  'VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT',
  'VIDEORC_WINDOWS_REQUIRE_ENCODED_BRIDGE',
  'VIDEORC_WINDOWS_EXPECT_D3D11_FALLBACK',
  'VIDEORC_ENCODER_BRIDGE',
  'VIDEORC_RECORDING_ENCODER_BRIDGE',
  'VIDEORC_STREAMING_ENCODER_BRIDGE',
  'VIDEORC_WINDOWS_GRAPHICS_CAPTURE'
])

export const WINDOWS_D3D11_REQUIRED_RUST_TESTS = Object.freeze({
  contract: Object.freeze([
    'compositor::tests::windows_d3d11_export_handle_is_role_bound_and_releases_on_final_clone',
    'compositor::tests::windows_d3d11_pixel_formats_keep_preview_and_encoder_surfaces_distinct',
    'native_preview_host::tests::windows_d3d11_main_owned_host_bounds_preserve_opaque_handle_and_generation',
    'preview_surface::tests::windows_d3d11_main_owned_preview_bounds_are_generation_bound_and_redacted',
    'protocol::tests::windows_d3d11_main_owned_preview_bounds_preserve_opaque_hwnd_and_generation',
    'protocol::tests::windows_d3d11_opaque_hwnd_rejects_unsafe_wire_values',
    'protocol::tests::windows_d3d11_renderer_preview_bounds_never_serialize_an_hwnd',
    'recording::tests::windows_d3d11_layout_capability_covers_shipping_display_camera_presets',
    'tests::windows_d3d11_main_owned_preview_bounds_are_admin_only',
    'windows_d3d11_device::tests::canonical_dxgi_screen_id_round_trips_adapter_and_output',
    'windows_d3d11_device::tests::cloned_export_ticket_releases_role_exactly_once_on_last_drop',
    'windows_d3d11_device::tests::full_drop_queue_fails_closed_without_blocking_or_recycling',
    'windows_d3d11_device::tests::pool_rejects_duplicate_roles_stale_generations_and_fence_regressions',
    'windows_d3d11_device::tests::preview_release_cannot_stop_active_stream_role',
    'windows_d3d11_device::tests::windows_d3d11_adapter_selection_rejects_invalid_screen_ids',
    'windows_d3d11_device::tests::windows_d3d11_coordinator_rejects_cross_adapter_reuse',
    'windows_d3d11_device::tests::windows_d3d11_latency_samples_are_bounded_and_report_p95_and_max',
    'windows_d3d11_device::tests::windows_d3d11_media_authority_orders_capture_and_compositor_commands',
    'windows_d3d11_device::tests::windows_d3d11_media_authority_preserves_capture_when_compositor_is_unavailable',
    'windows_d3d11_device::tests::windows_d3d11_pool_batch_publication_is_atomic',
    'windows_d3d11_device::tests::windows_d3d11_pool_never_reuses_an_active_lease',
    'windows_d3d11_device::tests::windows_d3d11_pool_reserves_capture_preview_and_encoded_targets',
    'windows_d3d11_device::tests::windows_d3d11_texture_descriptor_validates_format_and_dimensions',
    'windows_d3d11_test_pattern::tests::odd_bgra_dimensions_are_covered_without_gaps',
    'windows_d3d11_test_pattern::tests::two_by_two_hash_matches_quadrant_bgra_order',
    'windows_d3d11_test_pattern::tests::windows_d3d11_test_pattern_changes_every_frame'
  ]),
  capture: Object.freeze([
    'windows_d3d11_capture::tests::windows_d3d11_capture_copies_before_releasing_duplication_frame',
    'windows_d3d11_capture::tests::windows_d3d11_capture_latest_wins_is_bounded',
    'windows_d3d11_capture::tests::windows_d3d11_capture_pointer_only_publication_is_truthful',
    'windows_d3d11_capture::tests::windows_d3d11_capture_pointer_ownership_is_exactly_once',
    'windows_d3d11_capture::tests::windows_d3d11_capture_qpc_timestamps_are_monotonic',
    'windows_d3d11_capture::tests::windows_d3d11_capture_recovers_duplication_access_loss',
    'windows_d3d11_capture::tests::windows_d3d11_capture_rotation_crop_scale_is_deterministic',
    'windows_d3d11_capture::tests::windows_d3d11_capture_selects_cursor_safe_backend',
    'windows_d3d11_capture::tests::windows_d3d11_capture_validates_pointer_shape_layouts',
    'windows_d3d11_capture::tests::windows_d3d11_capture_wgc_cursor_exclusion_fails_closed'
  ]),
  compositor: Object.freeze([
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_filters_scene_layers_per_output_leg',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_layout_plan_preserves_horizontal_and_vertical_geometry',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_overlay_alpha_uses_straight_alpha_contract',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_primary_and_auxiliary_outputs_validate_dimensions',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_rejects_adapter_and_generation_mismatch',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_rejects_layers_with_no_output_leg',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_runtime_blend_state_matches_overlay_reference',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_test_readback_is_separately_attributed',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_transforms_crop_mirror_and_masks_match_cpu_contract',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_bt709_video_range_matches_reference_fixtures',
    'windows_d3d11_compositor::tests::windows_d3d11_compositor_unsupported_scene_feature_falls_back_whole_frame',
    'windows_d3d11_device::tests::windows_d3d11_compositor_source_requires_live_role_bound_ticket'
  ]),
  encoder: Object.freeze([
    'windows_d3d11_encoder_contract::tests::windows_d3d11_encoder_callbacks_recycle_more_than_pool_capacity',
    'windows_d3d11_encoder_contract::tests::windows_d3d11_encoder_drain_waits_for_tracked_callbacks',
    'windows_d3d11_encoder_contract::tests::windows_d3d11_encoder_need_input_and_output_never_release_leases',
    'windows_d3d11_encoder_contract::tests::windows_d3d11_encoder_process_input_failure_returns_unsubmitted_lease',
    'windows_d3d11_encoder_contract::tests::windows_d3d11_encoder_release_callback_is_generation_bound',
    'windows_d3d11_encoder_contract::tests::windows_d3d11_encoder_requires_credit_and_bounded_capacity',
    'windows_d3d11_encoder_contract::tests::windows_d3d11_encoder_roles_are_isolated',
    'windows_media_foundation_encoder::tests::windows_d3d11_encoder_gpu_surface_api_is_separate_from_i420_bytes',
    'windows_media_foundation_encoder::tests::windows_d3d11_encoder_surface_descriptor_is_nv12_only',
    'windows_media_foundation_encoder::tests::windows_d3d11_encoder_tracked_callback_keys_and_roles_are_unambiguous'
  ]),
  preview: Object.freeze([
    'windows_d3d11_preview::tests::windows_d3d11_preview_claim_requires_first_present_and_source_liveness',
    'windows_d3d11_preview::tests::windows_d3d11_preview_clipped_actual_bounds_are_scalar_and_sanitized',
    'windows_d3d11_preview::tests::windows_d3d11_preview_extended_style_contains_click_through_noactivate_triple',
    'windows_d3d11_preview::tests::windows_d3d11_preview_hidden_and_busy_frames_drop_without_revoking_claim',
    'windows_d3d11_preview::tests::windows_d3d11_preview_latest_wins_drop_is_bounded_diagnostic',
    'windows_d3d11_preview::tests::windows_d3d11_preview_rejects_foreign_owner_and_stale_generation',
    'windows_d3d11_preview::tests::windows_d3d11_preview_rejects_missing_target_and_wrong_z_order',
    'windows_d3d11_preview::tests::windows_d3d11_preview_swapchain_is_flip_model_bgra_and_double_buffered',
    'windows_d3d11_preview::tests::windows_d3d11_preview_wndproc_is_transparent_and_never_activates',
    'windows_d3d11_session::tests::windows_d3d11_accepts_scaled_split_outputs_and_screen_camera_upload',
    'windows_d3d11_session::tests::windows_d3d11_auto_names_layout_and_window_fallbacks',
    'windows_d3d11_session::tests::windows_d3d11_cfr_rejects_nonadvancing_capture_sequence',
    'windows_d3d11_session::tests::windows_d3d11_cfr_repeats_retained_static_source_at_render_cadence',
    'windows_d3d11_session::tests::windows_d3d11_claim_gate_requires_every_ticket_and_encoder',
    'windows_d3d11_session::tests::windows_d3d11_media_env_selects_auto_required_and_disabled',
    'windows_d3d11_session::tests::windows_d3d11_required_fails_closed_for_unsupported_session',
    'windows_d3d11_session::tests::windows_d3d11_split_session_assigns_record_and_stream_roles',
    'windows_d3d11_session::tests::windows_d3d11_supported_auto_session_gets_generation_roles'
  ])
})

const OPERATION_FLAGS = new Set([
  '--list',
  '--verify-windows-rust',
  '--merge-evidence',
  '--combine-path-evidence',
  '--finalize-fallback-evidence'
])

const VALUE_FLAGS = new Set([
  '--stage',
  '--hardware-class',
  '--output',
  '--profiles',
  '--bridge',
  '--expect-fallback',
  '--path-evidence'
])

const BOOLEAN_FLAGS = new Set([
  '--gate',
  '--list-only',
  '--require-bridge',
  '--d3d11',
  '--require-d3d11'
])

const PATH_TOP_LEVEL_KEYS = Object.freeze([
  'schema',
  'schemaVersion',
  'status',
  'createdAt',
  'candidate',
  'host',
  'profiles',
  'selection',
  'budget',
  'workload',
  'adapterProof',
  'invariants',
  'evidence',
  'runtimeProofLimitations'
])

const ADAPTER_PROOF_KEYS = Object.freeze([
  'scope',
  'perRoleLuidsAvailable',
  'selectedScreenAdapterLuid',
  'mediaAuthorityAdapterLuid',
  'captureAdapterLuid',
  'compositorAdapterLuid',
  'primaryEncoderAdapterLuid',
  'auxiliaryEncoderAdapterLuid',
  'equal'
])

const REQUIRED_ZERO_COUNTERS = Object.freeze([
  'captureReadbackFrames',
  'compositorCpuFallbackFrames',
  'encoderSystemMemorySamples',
  'rawVideoCopiedFrames',
  'previewBmpRequests',
  'previewBmpBytes',
  'texturePoolPressureEvents',
  'adapterMismatches',
  'deviceResets',
  'staleGenerationCallbacks',
  'synchronizationTimeouts',
  'pathIdentityChanges',
  'unexpectedFallbacks'
])

const COMMON_PHYSICAL_STAGE_ASSERTIONS = Object.freeze([
  'installed-packaged-candidate',
  'exact-windows-rust-discovery',
  'focused-windows-rust-tests',
  'd3d11-live-same-adapter',
  'zero-copy-counters',
  'bounded-media-thread-fairness',
  'no-path-fallback'
])

const STAGE_SPECIFIC_ASSERTIONS = Object.freeze({
  capture: 'native-capture-textures',
  compositor: 'd3d11-screen-camera-composition',
  encoder: 'media-foundation-gpu-input',
  preview: 'directcomposition-preview-input-continuity'
})

export function parseWindowsD3d11MediaArgs(argv = []) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const parsed = {
    operation: null,
    stage: null,
    hardwareClass: null,
    output: null,
    profiles: [],
    bridge: null,
    expectFallback: null,
    pathEvidence: null,
    gate: false,
    listOnly: false,
    requireBridge: false,
    d3d11: false,
    requireD3d11: false,
    inputPaths: []
  }
  const seen = new Set()

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (typeof flag !== 'string' || !flag.startsWith('--')) {
      throw new Error(`Unexpected Windows D3D11 media argument: ${flag}`)
    }
    if (seen.has(flag)) throw new Error(`${flag} may be supplied only once.`)
    seen.add(flag)

    if (OPERATION_FLAGS.has(flag)) {
      if (parsed.operation !== null) {
        throw new Error(
          `Only one D3D11 media operation may be selected (${parsed.operation}, ${flag}).`
        )
      }
      parsed.operation = flag.slice(2)
      if (
        ['merge-evidence', 'combine-path-evidence', 'finalize-fallback-evidence'].includes(
          parsed.operation
        )
      ) {
        parsed.inputPaths = parseUniqueCsv(requiredValue(args, ++index, flag), flag)
      }
      continue
    }

    if (BOOLEAN_FLAGS.has(flag)) {
      parsed[camelCaseFlag(flag)] = true
      continue
    }

    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`Unknown Windows D3D11 media argument: ${flag}`)
    }
    const value = requiredValue(args, ++index, flag)
    switch (flag) {
      case '--stage':
        parsed.stage = assertMember(value, WINDOWS_D3D11_MEDIA_STAGES, flag)
        break
      case '--hardware-class':
        parsed.hardwareClass = assertMember(value, WINDOWS_D3D11_HARDWARE_CLASSES, flag)
        break
      case '--output':
        parsed.output = value
        break
      case '--profiles':
        parsed.profiles = parseUniqueCsv(value, flag)
        for (const profile of parsed.profiles) {
          assertMember(profile, WINDOWS_D3D11_PROFILES, flag)
        }
        break
      case '--bridge':
        parsed.bridge = assertMember(value, ['mf'], flag)
        break
      case '--expect-fallback':
        parsed.expectFallback = assertMember(value, ['natural'], flag)
        break
      case '--path-evidence':
        parsed.pathEvidence = assertMember(value, WINDOWS_D3D11_PATH_EVIDENCE, flag)
        break
      default:
        throw new Error(`Unhandled Windows D3D11 media argument: ${flag}`)
    }
  }

  parsed.operation ??= parsed.stage === null ? 'gate' : 'stage'
  validateParsedOptions(parsed)
  return parsed
}

export function expectedWindowsD3d11Profiles(hardwareClass) {
  assertMember(hardwareClass, WINDOWS_D3D11_HARDWARE_CLASSES, 'hardwareClass')
  return hardwareClass === 'unsupported-natural-fallback'
    ? ['1080p30']
    : [...WINDOWS_D3D11_PROFILES]
}

export function expectedWindowsD3d11PathKinds(hardwareClass) {
  return hardwareClass === 'unsupported-natural-fallback'
    ? ['natural']
    : [...WINDOWS_D3D11_SUPPORTED_PATHS]
}

export function expectedWindowsD3d11Selection(pathEvidence) {
  switch (pathEvidence) {
    case 'forced':
      return {
        mode: 'forced',
        environment: {
          d3d11Media: '1',
          requireD3d11Media: '1',
          encoderBridgeVideoOutput: 'windows-media-foundation-h264-mpegts',
          requireEncodedBridge: '1',
          expectFallback: null
        },
        requestedMediaPath: 'd3d11-native',
        requestedEncoderPath: 'media-foundation',
        effectiveMediaPath: 'd3d11-native',
        effectiveEncoderPath: 'media-foundation',
        obsParityQualified: true
      }
    case 'default':
      return {
        mode: 'default',
        environment: {
          d3d11Media: null,
          requireD3d11Media: null,
          encoderBridgeVideoOutput: null,
          requireEncodedBridge: null,
          expectFallback: null
        },
        requestedMediaPath: 'automatic',
        requestedEncoderPath: 'automatic',
        effectiveMediaPath: 'd3d11-native',
        effectiveEncoderPath: 'media-foundation',
        obsParityQualified: true
      }
    case 'natural':
      return {
        mode: 'natural',
        environment: {
          d3d11Media: null,
          requireD3d11Media: null,
          encoderBridgeVideoOutput: null,
          requireEncodedBridge: null,
          expectFallback: 'natural'
        },
        requestedMediaPath: 'natural-capability-selection',
        requestedEncoderPath: 'automatic',
        effectiveMediaPath: 'legacy-fallback',
        effectiveEncoderPath: 'legacy-software',
        obsParityQualified: false
      }
    default:
      throw new Error(`Unknown D3D11 path evidence: ${pathEvidence}`)
  }
}

export function requiredWindowsD3d11TestsThrough(stage = 'preview') {
  const stageIndex = WINDOWS_D3D11_MEDIA_STAGES.indexOf(stage)
  if (stageIndex < 0) throw new Error(`Unknown Windows D3D11 media stage: ${stage}`)
  return WINDOWS_D3D11_MEDIA_STAGES.slice(0, stageIndex + 1).flatMap(
    (name) => WINDOWS_D3D11_REQUIRED_RUST_TESTS[name]
  )
}

export function parseWindowsD3d11RustTestList(stdout) {
  const names = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /^\s*(\S*windows_d3d11\S*): test\s*$/.exec(line)
    if (match) names.push(match[1])
  }
  return names
}

export function assertWindowsD3d11RustDiscovery(
  discovered,
  { stage = 'preview', allowUnimplementedStages = false } = {}
) {
  if (!Array.isArray(discovered) || discovered.length === 0) {
    throw new Error('Windows D3D11 Rust discovery returned zero tests.')
  }
  const duplicates = duplicateValues(discovered)
  if (duplicates.length > 0) {
    throw new Error(`Windows D3D11 Rust discovery returned duplicate test: ${duplicates[0]}`)
  }
  const expected = requiredWindowsD3d11TestsThrough(stage)
  if (expected.length === 0) {
    throw new Error(`Windows D3D11 Rust manifest for ${stage} contained zero tests.`)
  }
  const expectedSet = new Set(expected)
  const missing = expected.filter((name) => !discovered.includes(name))
  const extra = discovered.filter((name) => !expectedSet.has(name))
  if (missing.length > 0) {
    throw new Error(`Windows D3D11 Rust discovery was missing: ${missing.join(', ')}`)
  }
  if (extra.length > 0) {
    throw new Error(`Windows D3D11 Rust discovery had unexpected tests: ${extra.join(', ')}`)
  }
  if (!allowUnimplementedStages) {
    const through = WINDOWS_D3D11_MEDIA_STAGES.slice(
      0,
      WINDOWS_D3D11_MEDIA_STAGES.indexOf(stage) + 1
    )
    const empty = through.find((name) => WINDOWS_D3D11_REQUIRED_RUST_TESTS[name].length === 0)
    if (empty) throw new Error(`Windows D3D11 Rust manifest stage ${empty} is not implemented.`)
  }
  return [...discovered]
}

export function windowsD3d11RustDiscoveryCommand() {
  return [
    'cargo',
    ['test', '-p', 'videorc-backend', '--bin', 'videorc-backend', 'windows_d3d11', '--', '--list']
  ]
}

export function windowsD3d11StageProducerSpec({ stage, output } = {}) {
  const scenario = WINDOWS_D3D11_STAGE_PRODUCER_SCENARIOS[stage]
  if (!scenario) {
    throw new Error(`Physical D3D11 stage producer does not support ${stage ?? 'missing'}.`)
  }
  if (!portableAbsolutePath(output)) {
    throw new Error('Physical D3D11 stage producer --output must be absolute.')
  }
  return {
    producer: 'installed-packaged-stream-performance',
    scenario,
    args: [
      '--scenario',
      scenario,
      '--runs',
      '1',
      '--bridge',
      'mf',
      '--require-bridge',
      '--d3d11',
      '--require-d3d11',
      '--path-evidence',
      'forced',
      '--video-only',
      '--output',
      output
    ]
  }
}

export function requiredWindowsD3d11StageAssertionIds(stage) {
  const stageAssertion = STAGE_SPECIFIC_ASSERTIONS[stage]
  if (!stageAssertion) {
    throw new Error(`Physical D3D11 stage assertions do not support ${stage ?? 'missing'}.`)
  }
  return [...COMMON_PHYSICAL_STAGE_ASSERTIONS, stageAssertion]
}

export function validateWindowsD3d11StageReport(value, { expectedStage } = {}) {
  const failures = []
  if (!isPlainObject(value)) return ['report must be an object']
  if (value.schema !== WINDOWS_D3D11_MEDIA_SCHEMA) {
    failures.push(`schema must be ${WINDOWS_D3D11_MEDIA_SCHEMA}`)
  }
  if (value.schemaVersion !== WINDOWS_D3D11_MEDIA_SCHEMA_VERSION) {
    failures.push(`schemaVersion must be ${WINDOWS_D3D11_MEDIA_SCHEMA_VERSION}`)
  }
  if (!WINDOWS_D3D11_MEDIA_STAGES.includes(value.stage)) failures.push('stage was unknown')
  else if (expectedStage && value.stage !== expectedStage) {
    failures.push(`stage ${value.stage} did not match ${expectedStage}`)
  }
  if (!['PASS', 'FAIL', 'BLOCKED', 'UNSUPPORTED'].includes(value.status)) {
    failures.push('status must be PASS, FAIL, BLOCKED, or UNSUPPORTED')
  }
  if (!canonicalTimestamp(value.createdAt)) failures.push('createdAt must be an ISO timestamp')
  validateCandidate(value.candidate, 'candidate', failures, {
    allowNull: value.stage === 'contract'
  })
  if (!Array.isArray(value.assertions) || value.assertions.length === 0) {
    failures.push('assertions must contain at least one entry')
  } else {
    const ids = []
    for (const [index, assertion] of value.assertions.entries()) {
      if (
        !isPlainObject(assertion) ||
        !nonEmptyString(assertion.id) ||
        typeof assertion.passed !== 'boolean'
      ) {
        failures.push(`assertions[${index}] was invalid`)
      } else {
        ids.push(assertion.id)
      }
    }
    if (duplicateValues(ids).length > 0) failures.push('assertion IDs must be unique')
  }
  if (value.status === 'PASS' && value.assertions?.some((assertion) => !assertion.passed)) {
    failures.push('PASS report contained a failed assertion')
  }
  if (STAGE_SPECIFIC_ASSERTIONS[value.stage] && value.status === 'PASS') {
    const requiredAssertions = requiredWindowsD3d11StageAssertionIds(value.stage)
    const assertionIds = new Set(value.assertions?.map((assertion) => assertion?.id))
    for (const id of requiredAssertions) {
      if (!assertionIds.has(id)) failures.push(`PASS report was missing required assertion ${id}`)
    }
    if (value.sourceEvidence?.producer !== 'installed-packaged-stream-performance') {
      failures.push('PASS report did not identify the installed packaged-app producer')
    }
    for (const field of ['producerAggregatePath', 'producerReportPath']) {
      if (!portableAbsolutePath(value.sourceEvidence?.[field])) {
        failures.push(`PASS report sourceEvidence.${field} must be absolute`)
      }
    }
    for (const field of [
      'producerAggregateSha256',
      'producerReportSha256',
      'listingSha256',
      'testOutputSha256'
    ]) {
      if (!lowercaseHex(value.sourceEvidence?.[field], 64)) {
        failures.push(`PASS report sourceEvidence.${field} was invalid`)
      }
    }
  }
  return failures
}

export function createWindowsD3d11StageReport({
  stage,
  status = 'PASS',
  sourceCommit = null,
  installerSha256 = null,
  appSha256 = null,
  payloadSha256 = null,
  assertions,
  metrics = {},
  host = {},
  sourceEvidence = {}
}) {
  const report = {
    schema: WINDOWS_D3D11_MEDIA_SCHEMA,
    schemaVersion: WINDOWS_D3D11_MEDIA_SCHEMA_VERSION,
    stage,
    status,
    createdAt: new Date().toISOString(),
    candidate: { sourceCommit, installerSha256, appSha256, payloadSha256 },
    host,
    assertions,
    metrics,
    sourceEvidence
  }
  const failures = validateWindowsD3d11StageReport(report, { expectedStage: stage })
  if (failures.length > 0) {
    throw new Error(`Invalid Windows D3D11 stage report: ${failures.join('; ')}`)
  }
  return report
}

export function deriveWindowsD3d11HostIdentity({
  declaredClass,
  operatingSystem,
  selectedScreenId,
  selectedScreenDetail,
  adapterLuid,
  settingsSha256
}) {
  const descriptor = sanitizeHardwareDescriptor(selectedScreenDetail)
  const vendor = windowsGpuVendor(descriptor)
  const observedClass =
    declaredClass === 'unsupported-natural-fallback'
      ? 'unsupported-natural-fallback'
      : inferSupportedHardwareClass(descriptor)
  const canonicalInputs = {
    operatingSystem: {
      platform: operatingSystem?.platform,
      arch: operatingSystem?.arch,
      release: operatingSystem?.release
    },
    selectedScreenId,
    adapterLuid,
    adapterDescriptorSha256: sha256Text(`${descriptor}\n`),
    settingsSha256
  }
  return {
    declaredClass,
    observedClass,
    vendor,
    fingerprintSha256: sha256CanonicalJson(canonicalInputs),
    fingerprintRecipe:
      'sha256(canonical-json-v1:{operatingSystem,selectedScreenId,adapterLuid,adapterDescriptorSha256,settingsSha256})',
    canonicalInputs,
    classProof: {
      settingsSha256,
      adapterDescriptorSha256: canonicalInputs.adapterDescriptorSha256,
      rule:
        observedClass === 'nvidia-turing-floor'
          ? 'DXGI adapter descriptor contains NVIDIA and GTX 1650 SUPER'
          : observedClass === 'intel-xe-integrated'
            ? 'DXGI adapter descriptor contains Intel and Iris Xe'
            : 'natural capability selection reported the named unsupported fallback'
    }
  }
}

export function createWindowsD3d11PathManifest(input) {
  const manifest = {
    schema: WINDOWS_D3D11_PATH_SCHEMA,
    schemaVersion: 1,
    status: 'PATH_PASS',
    createdAt: input.createdAt,
    candidate: input.candidate,
    host: input.host,
    profiles: input.profiles,
    selection: input.selection,
    budget: input.budget,
    workload: input.workload,
    adapterProof: input.adapterProof,
    invariants: input.invariants,
    evidence: input.evidence,
    runtimeProofLimitations: input.runtimeProofLimitations
  }
  const failures = validateWindowsD3d11PathManifest(manifest)
  if (failures.length > 0) {
    throw new Error(`Invalid D3D11 path manifest: ${failures.join('; ')}`)
  }
  return manifest
}

export function validateWindowsD3d11PathManifest(value) {
  const failures = []
  if (!isPlainObject(value)) return ['path manifest must be an object']
  exactKeys(value, PATH_TOP_LEVEL_KEYS, 'path manifest', failures)
  if (value.schema !== WINDOWS_D3D11_PATH_SCHEMA) {
    failures.push(`schema must be ${WINDOWS_D3D11_PATH_SCHEMA}`)
  }
  if (value.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (value.status !== 'PATH_PASS') failures.push('status must be PATH_PASS')
  if (!canonicalTimestamp(value.createdAt)) failures.push('createdAt must be an ISO timestamp')
  validateCandidate(value.candidate, 'candidate', failures)
  validatePathHost(value.host, failures)
  validateProfiles(value.profiles, value.host?.declaredClass, failures)
  validateSelection(value.selection, value.host?.declaredClass, failures)
  validateBudgetBinding(value.budget, value.profiles, failures)
  validateWorkload(value.workload, value.profiles, value.selection?.mode, failures)
  validateAdapterProof(value.adapterProof, value.selection?.mode, failures)
  validatePathInvariants(value.invariants, value.selection?.mode, failures)
  validatePathEvidence(value.evidence, value.workload, value.selection?.mode, failures)
  if (!Array.isArray(value.runtimeProofLimitations) || value.runtimeProofLimitations.length !== 0) {
    failures.push('runtimeProofLimitations must be empty for qualified evidence')
  }
  return failures
}

export function combineWindowsD3d11PathEvidence(
  artifacts,
  { hardwareClass, operation = 'combine-path-evidence' } = {}
) {
  const normalized = normalizeEvidenceArtifacts(artifacts, 'path manifest')
  if (normalized.length === 0) throw new Error('At least one D3D11 path manifest is required.')
  const manifests = normalized.map(({ document }) => document)
  for (const manifest of manifests) {
    const failures = validateWindowsD3d11PathManifest(manifest)
    if (failures.length > 0) throw new Error(`Invalid D3D11 path manifest: ${failures.join('; ')}`)
  }
  const requestedClass = hardwareClass ?? manifests[0].host.declaredClass
  const expectedPaths = expectedWindowsD3d11PathKinds(requestedClass)
  if (
    operation === 'finalize-fallback-evidence' &&
    requestedClass !== 'unsupported-natural-fallback'
  ) {
    throw new Error('Only the natural fallback class may use the fallback finalizer.')
  }
  if (
    operation !== 'finalize-fallback-evidence' &&
    requestedClass === 'unsupported-natural-fallback'
  ) {
    throw new Error('Fallback HOST_PASS may be written only by the fallback finalizer.')
  }
  const pathKinds = manifests.map((manifest) => manifest.selection.mode)
  if (
    pathKinds.length !== expectedPaths.length ||
    duplicateValues(pathKinds).length > 0 ||
    expectedPaths.some((mode) => !pathKinds.includes(mode))
  ) {
    throw new Error(
      `Hardware class ${requestedClass} requires ${expectedPaths.join('+')} path evidence.`
    )
  }
  for (const manifest of manifests) {
    if (
      manifest.host.declaredClass !== requestedClass ||
      manifest.host.observedClass !== requestedClass
    ) {
      throw new Error('D3D11 path manifests did not prove the requested hardware class.')
    }
  }
  const candidate = uniqueCanonicalField(manifests, 'candidate')
  const host = uniqueCanonicalField(manifests, 'host')
  const profiles = uniqueCanonicalField(manifests, 'profiles')
  const activeBudgetSha256 = uniqueNestedField(manifests, ['budget', 'activeSha256'])
  const workloadSettingsSha256 = uniqueNestedField(manifests, ['workload', 'settingsSha256'])
  const scenarioSetSha256 = uniqueNestedField(manifests, ['workload', 'scenarioSetSha256'])
  const scenarioCoordinatesSha256 = uniqueNestedField(manifests, [
    'workload',
    'scenarioCoordinatesSha256'
  ])
  const resolvedProfileSetSha256 = uniqueNestedField(manifests, [
    'budget',
    'resolvedProfileSetSha256'
  ])
  const pathManifests = normalized
    .sort(
      (left, right) =>
        expectedPaths.indexOf(left.document.selection.mode) -
        expectedPaths.indexOf(right.document.selection.mode)
    )
    .map(({ path, sha256, document }) => ({
      mode: document.selection.mode,
      path,
      sha256,
      selection: document.selection,
      invariants: document.invariants,
      scenarioEvidenceSha256: document.evidence.scenarioEvidenceSha256,
      artifactEvidenceSha256: document.evidence.artifactEvidenceSha256,
      supportBundleEvidenceSha256: document.evidence.supportBundleEvidenceSha256,
      lifecycleEvidenceSha256: document.evidence.lifecycleEvidenceSha256,
      faultEvidenceSha256: document.evidence.faultEvidenceSha256,
      comparisonEvidenceSha256: document.evidence.comparisonEvidenceSha256,
      inputContinuityEvidenceSha256: document.evidence.inputContinuityEvidenceSha256,
      cameraUploadEvidenceSha256: document.evidence.cameraUploadEvidenceSha256
    }))
  const hostManifest = {
    schema: WINDOWS_D3D11_HOST_SCHEMA,
    schemaVersion: 1,
    status: 'HOST_PASS',
    hardwareClass: requestedClass,
    candidate,
    host,
    qualifiedProfiles: profiles,
    obsParityQualified: requestedClass !== 'unsupported-natural-fallback',
    budget: {
      activeSha256: activeBudgetSha256,
      resolvedProfileSetSha256
    },
    workload: {
      settingsSha256: workloadSettingsSha256,
      scenarioSetSha256,
      scenarioCoordinatesSha256
    },
    pathManifests,
    evidenceSha256: sha256CanonicalJson(pathManifests)
  }
  const failures = validateWindowsD3d11HostManifest(hostManifest)
  if (failures.length > 0) {
    throw new Error(`Invalid Windows D3D11 host manifest: ${failures.join('; ')}`)
  }
  return hostManifest
}

export function validateWindowsD3d11HostManifest(value) {
  const failures = []
  if (!isPlainObject(value)) return ['host manifest must be an object']
  exactKeys(
    value,
    [
      'schema',
      'schemaVersion',
      'status',
      'hardwareClass',
      'candidate',
      'host',
      'qualifiedProfiles',
      'obsParityQualified',
      'budget',
      'workload',
      'pathManifests',
      'evidenceSha256'
    ],
    'host manifest',
    failures
  )
  if (value.schema !== WINDOWS_D3D11_HOST_SCHEMA) {
    failures.push(`schema must be ${WINDOWS_D3D11_HOST_SCHEMA}`)
  }
  if (value.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (value.status !== 'HOST_PASS') failures.push('status must be HOST_PASS')
  if (!WINDOWS_D3D11_HARDWARE_CLASSES.includes(value.hardwareClass)) {
    failures.push('hardwareClass was unknown')
  }
  validateCandidate(value.candidate, 'candidate', failures)
  validatePathHost(value.host, failures)
  if (
    value.host?.declaredClass !== value.hardwareClass ||
    value.host?.observedClass !== value.hardwareClass
  ) {
    failures.push('host class proof did not match hardwareClass')
  }
  validateProfiles(value.qualifiedProfiles, value.hardwareClass, failures)
  const fallback = value.hardwareClass === 'unsupported-natural-fallback'
  if (value.obsParityQualified !== !fallback) {
    failures.push('obsParityQualified did not match the hardware class')
  }
  if (!lowercaseHex(value.budget?.activeSha256, 64)) {
    failures.push('budget.activeSha256 was invalid')
  }
  if (!lowercaseHex(value.budget?.resolvedProfileSetSha256, 64)) {
    failures.push('budget.resolvedProfileSetSha256 was invalid')
  }
  for (const field of ['settingsSha256', 'scenarioSetSha256', 'scenarioCoordinatesSha256']) {
    if (!lowercaseHex(value.workload?.[field], 64)) failures.push(`workload.${field} was invalid`)
  }
  const expectedModes = expectedWindowsD3d11PathKinds(value.hardwareClass)
  if (!Array.isArray(value.pathManifests) || value.pathManifests.length !== expectedModes.length) {
    failures.push(`pathManifests must retain exactly ${expectedModes.join('+')}`)
  } else {
    const modes = value.pathManifests.map((child) => child?.mode)
    if (duplicateValues(modes).length > 0 || expectedModes.some((mode) => !modes.includes(mode))) {
      failures.push(`pathManifests must retain exactly ${expectedModes.join('+')}`)
    }
    const paths = new Set()
    const hashes = new Set()
    for (const [index, child] of value.pathManifests.entries()) {
      if (!portableAbsolutePath(child?.path)) {
        failures.push(`pathManifests[${index}].path must be absolute`)
      } else if (paths.has(canonicalPortablePath(child.path))) {
        failures.push('pathManifests paths must be distinct')
      } else {
        paths.add(canonicalPortablePath(child.path))
      }
      for (const field of [
        'sha256',
        'scenarioEvidenceSha256',
        'artifactEvidenceSha256',
        'supportBundleEvidenceSha256',
        'lifecycleEvidenceSha256',
        'faultEvidenceSha256',
        'comparisonEvidenceSha256',
        'inputContinuityEvidenceSha256',
        'cameraUploadEvidenceSha256'
      ]) {
        if (!lowercaseHex(child?.[field], 64)) {
          failures.push(`pathManifests[${index}].${field} was invalid`)
        }
      }
      if (lowercaseHex(child?.sha256, 64)) {
        if (hashes.has(child.sha256)) failures.push('pathManifests hashes must be distinct')
        hashes.add(child.sha256)
      }
      validateSelection(child?.selection, value.hardwareClass, failures)
      validatePathInvariants(child?.invariants, child?.mode, failures)
    }
    if (
      value.pathManifests.every((child) => lowercaseHex(child?.sha256, 64)) &&
      value.evidenceSha256 !== sha256CanonicalJson(value.pathManifests)
    ) {
      failures.push('evidenceSha256 did not bind the retained child manifests')
    }
  }
  return failures
}

export function mergeWindowsD3d11HostEvidence(artifacts) {
  const normalized = normalizeEvidenceArtifacts(artifacts, 'host manifest')
  if (normalized.length !== WINDOWS_D3D11_HARDWARE_CLASSES.length) {
    throw new Error(
      `Exactly ${WINDOWS_D3D11_HARDWARE_CLASSES.length} D3D11 host manifests are required.`
    )
  }
  const manifests = normalized.map(({ document }) => document)
  for (const manifest of manifests) {
    const failures = validateWindowsD3d11HostManifest(manifest)
    if (failures.length > 0) {
      throw new Error(`Invalid Windows D3D11 host manifest: ${failures.join('; ')}`)
    }
  }
  const classes = manifests.map(({ hardwareClass }) => hardwareClass)
  if (
    duplicateValues(classes).length > 0 ||
    WINDOWS_D3D11_HARDWARE_CLASSES.some((hardwareClass) => !classes.includes(hardwareClass))
  ) {
    throw new Error('D3D11 host manifests did not cover each required hardware class exactly once.')
  }
  const fingerprints = manifests.map((manifest) => manifest.host.fingerprintSha256)
  if (duplicateValues(fingerprints).length > 0) {
    throw new Error('D3D11 host manifests reused a physical-host fingerprint.')
  }
  const byClass = new Map(manifests.map((manifest) => [manifest.hardwareClass, manifest]))
  if (byClass.get('nvidia-turing-floor').host.vendor !== 'nvidia') {
    throw new Error('NVIDIA class evidence was not observed on the NVIDIA reference adapter.')
  }
  if (byClass.get('intel-xe-integrated').host.vendor !== 'intel') {
    throw new Error('Intel class evidence was not observed on an Intel Iris Xe adapter.')
  }
  const candidate = uniqueCanonicalField(manifests, 'candidate')
  const activeBudgetSha256 = uniqueNestedField(manifests, ['budget', 'activeSha256'])
  const hosts = normalized
    .sort(
      (left, right) =>
        WINDOWS_D3D11_HARDWARE_CLASSES.indexOf(left.document.hardwareClass) -
        WINDOWS_D3D11_HARDWARE_CLASSES.indexOf(right.document.hardwareClass)
    )
    .map(({ path, sha256, document }) => ({
      hardwareClass: document.hardwareClass,
      fingerprintSha256: document.host.fingerprintSha256,
      vendor: document.host.vendor,
      qualifiedProfiles: document.qualifiedProfiles,
      obsParityQualified: document.obsParityQualified,
      pathModes: document.pathManifests.map(({ mode }) => mode),
      path,
      sha256
    }))
  const aggregate = {
    schema: WINDOWS_D3D11_AGGREGATE_SCHEMA,
    schemaVersion: 1,
    status: 'PASS',
    candidate,
    activeBudgetSha256,
    hosts,
    aggregateSha256: sha256CanonicalJson({
      candidate,
      activeBudgetSha256,
      hosts
    })
  }
  const failures = validateWindowsD3d11Aggregate(aggregate)
  if (failures.length > 0) {
    throw new Error(`Invalid Windows D3D11 aggregate: ${failures.join('; ')}`)
  }
  return aggregate
}

export function validateWindowsD3d11Aggregate(value) {
  const failures = []
  if (!isPlainObject(value)) return ['aggregate must be an object']
  exactKeys(
    value,
    [
      'schema',
      'schemaVersion',
      'status',
      'candidate',
      'activeBudgetSha256',
      'hosts',
      'aggregateSha256'
    ],
    'aggregate',
    failures
  )
  if (value.schema !== WINDOWS_D3D11_AGGREGATE_SCHEMA) {
    failures.push(`schema must be ${WINDOWS_D3D11_AGGREGATE_SCHEMA}`)
  }
  if (value.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (value.status !== 'PASS') failures.push('status must be PASS')
  validateCandidate(value.candidate, 'candidate', failures)
  if (!lowercaseHex(value.activeBudgetSha256, 64)) {
    failures.push('activeBudgetSha256 was invalid')
  }
  if (!Array.isArray(value.hosts) || value.hosts.length !== 3) {
    failures.push('hosts must retain exactly three host-manifest bindings')
    return failures
  }
  const classes = value.hosts.map((host) => host?.hardwareClass)
  if (!equalArrays(classes, WINDOWS_D3D11_HARDWARE_CLASSES)) {
    failures.push('hosts were not in the canonical NVIDIA, Intel, fallback order')
  }
  const fingerprints = []
  for (const [index, host] of value.hosts.entries()) {
    if (!lowercaseHex(host?.fingerprintSha256, 64)) {
      failures.push(`hosts[${index}].fingerprintSha256 was invalid`)
    } else {
      fingerprints.push(host.fingerprintSha256)
    }
    if (!['nvidia', 'intel', 'amd', 'microsoft', 'other'].includes(host?.vendor)) {
      failures.push(`hosts[${index}].vendor was invalid`)
    }
    validateProfiles(host?.qualifiedProfiles, host?.hardwareClass, failures, `hosts[${index}]`)
    const fallback = host?.hardwareClass === 'unsupported-natural-fallback'
    if (host?.obsParityQualified !== !fallback) {
      failures.push(`hosts[${index}].obsParityQualified was invalid`)
    }
    if (!equalArrays(host?.pathModes, expectedWindowsD3d11PathKinds(host?.hardwareClass))) {
      failures.push(`hosts[${index}].pathModes was invalid`)
    }
    if (!portableAbsolutePath(host?.path)) failures.push(`hosts[${index}].path was not absolute`)
    if (!lowercaseHex(host?.sha256, 64)) failures.push(`hosts[${index}].sha256 was invalid`)
  }
  if (duplicateValues(fingerprints).length > 0) failures.push('host fingerprints were duplicated')
  if (value.hosts[0]?.vendor !== 'nvidia') failures.push('NVIDIA host vendor proof was invalid')
  if (value.hosts[1]?.vendor !== 'intel') failures.push('Intel host vendor proof was invalid')
  const expectedHash = sha256CanonicalJson({
    candidate: value.candidate,
    activeBudgetSha256: value.activeBudgetSha256,
    hosts: value.hosts
  })
  if (value.aggregateSha256 !== expectedHash) {
    failures.push('aggregateSha256 did not bind the canonical aggregate')
  }
  return failures
}

export function normalizeWindowsD3d11InvariantSummary(runs, { pathEvidence } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('D3D11 invariant summary requires at least one measured run.')
  }
  const d3dRuns = runs.map((run) => run?.evidence?.pipeline?.d3d11 ?? {})
  const natural = pathEvidence === 'natural'
  const previewRuns = runs.filter((run) => run?.evidence?.context?.previewOpen === true)
  const presenterSamples = previewRuns.flatMap((run) => run.presenterSamples ?? [])
  const capacityValues = d3dRuns
    .flatMap((d3d) => d3d.texturePoolCapacitySamples ?? [d3d.texturePoolCapacity])
    .filter(Number.isFinite)
  const inUseValues = d3dRuns
    .flatMap((d3d) => d3d.texturePoolInUseSamples ?? [d3d.texturePoolInUse])
    .filter(Number.isFinite)
  return {
    adapterLuidMatchesSelectedScreen: runs.every(
      (run) => run.selectedScreenAdapterLuid === run.evidence?.pipeline?.d3d11?.adapterLuid
    ),
    adapterRolesMatchAuthority: runs.every((run) => {
      const d3d11 = run.evidence?.pipeline?.d3d11 ?? {}
      const fields = ['captureAdapterLuid', 'compositorAdapterLuid', 'primaryEncoderAdapterLuid']
      if (natural) {
        return ['adapterLuid', ...fields, 'auxiliaryEncoderAdapterLuid'].every(
          (field) => d3d11[field] === null || d3d11[field] === undefined
        )
      }
      const authority = d3d11.adapterLuid
      if (
        !/^[a-f0-9]{16}$/.test(authority ?? '') ||
        fields.some((field) => d3d11[field] !== authority)
      ) {
        return false
      }
      const auxiliary = d3d11.auxiliaryEncoderAdapterLuid
      const auxiliaryRequired = run.evidence?.context?.topology === 'record-plus-stream'
      return auxiliaryRequired
        ? auxiliary === authority
        : auxiliary == null || auxiliary === authority
    }),
    presenterSameAdapter:
      natural ||
      (presenterSamples.length > 0 && presenterSamples.every((sample) => sample.sameAdapter)),
    presenterGenerationBound:
      natural ||
      (presenterSamples.length > 0 && presenterSamples.every((sample) => sample.generationMatches)),
    presenterOwnerBound:
      natural ||
      (presenterSamples.length > 0 &&
        presenterSamples.every((sample) => sample.ownerProcessMatches)),
    presenterSourceLive:
      natural ||
      (presenterSamples.length > 0 && presenterSamples.every((sample) => sample.sourceLive)),
    presenterFirstPresentSucceeded:
      natural ||
      (presenterSamples.length > 0 &&
        presenterSamples.every((sample) => sample.firstPresentSucceeded)),
    presenterPresentsPositive:
      natural ||
      (presenterSamples.length > 0 &&
        presenterSamples.every((sample) => positiveNumber(sample.successfulPresents))),
    captureReadbackFrames: maxCounter(d3dRuns, 'captureReadbackFrames'),
    compositorCpuFallbackFrames: maxCounter(d3dRuns, 'compositorCpuFallbackFrames'),
    encoderSystemMemorySamples: maxCounter(d3dRuns, 'encoderSystemMemorySamples'),
    rawVideoCopiedFrames: maxCounter(d3dRuns, 'rawVideoCopiedFrames'),
    previewBmpRequests: maxCounter(d3dRuns, 'previewBmpRequests'),
    previewBmpBytes: maxCounter(d3dRuns, 'previewBmpBytes'),
    textureImportFrames: sumCounter(d3dRuns, 'textureImportFrames'),
    encoderGpuSamples: sumCounter(d3dRuns, 'encoderGpuSamples'),
    cursorCorrect: natural || d3dRuns.every((d3d) => d3d.cursorCorrect === true),
    inputContinuity:
      natural ||
      runs.every((run) => {
        const previewOpen = run?.evidence?.context?.previewOpen === true
        const input = run?.evidence?.pipeline?.d3d11?.inputContinuityEvidence
        return previewOpen
          ? input?.verdict === 'PASS' && input?.applicable === true && input?.physicalInput === true
          : input?.applicable === false
      }),
    physicalInputContractPassed:
      natural ||
      runs.every((run) => {
        const previewOpen = run?.evidence?.context?.previewOpen === true
        const input = run?.evidence?.pipeline?.d3d11?.inputContinuityEvidence
        return previewOpen
          ? input?.verdict === 'PASS' && input?.applicable === true && input?.physicalInput === true
          : input?.applicable === false && input?.physicalInput === false
      }),
    cameraUploadsMatchScenarios: runs.every((run) => {
      const camera = run?.evidence?.context?.sourceComposition === 'screen-camera'
      const frames = run?.evidence?.pipeline?.d3d11?.cameraUploadFrames
      return camera ? positiveNumber(frames) : frames === 0
    }),
    messageDispatchP95Ms: maximumFinite(d3dRuns.map((d3d) => d3d.messageDispatchP95Ms)),
    messageDispatchMaxMs: maximumFinite(d3dRuns.map((d3d) => d3d.messageDispatchMaxMs)),
    mediaCommandLagP95Ms: maximumFinite(d3dRuns.map((d3d) => d3d.mediaCommandLagP95Ms)),
    mediaCommandLagMaxMs: maximumFinite(d3dRuns.map((d3d) => d3d.mediaCommandLagMaxMs)),
    maximumConsecutiveMessageBatch: maximumFinite(
      d3dRuns.map((d3d) => d3d.maximumConsecutiveMessageBatch)
    ),
    maximumConsecutiveMediaBatch: maximumFinite(
      d3dRuns.map((d3d) => d3d.maximumConsecutiveMediaBatch)
    ),
    texturePoolCapacityMinimum: minimumFinite(capacityValues),
    texturePoolInUseMaximum: maximumFinite(inUseValues),
    texturePoolPressureEvents: maxCounter(d3dRuns, 'texturePoolPressureEvents'),
    adapterMismatches: maxCounter(d3dRuns, 'adapterMismatches'),
    deviceResets: maxCounter(d3dRuns, 'deviceResets'),
    staleGenerationCallbacks: maxCounter(d3dRuns, 'staleGenerationCallbacks'),
    synchronizationTimeouts: maxCounter(d3dRuns, 'synchronizationTimeouts'),
    pathIdentityChanges: d3dRuns.filter(
      (d3d) => d3d.stateChanged || d3d.adapterChanged || d3d.fallbackChanged
    ).length,
    unexpectedFallbacks: natural
      ? 0
      : d3dRuns.filter((d3d) => nonEmptyString(d3d.fallbackReason)).length,
    namedNaturalFallback:
      natural &&
      d3dRuns.every(
        (d3d) =>
          d3d.state === 'fallback' &&
          d3d.captureBackend === 'legacy-ffmpeg' &&
          nonEmptyString(d3d.fallbackReason)
      )
  }
}

export function sha256CanonicalJson(value) {
  return createHash('sha256')
    .update(`${canonicalJson(value)}\n`)
    .digest('hex')
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'))
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value))
}

function validateParsedOptions(parsed) {
  if (parsed.listOnly && parsed.operation !== 'verify-windows-rust') {
    throw new Error('--list-only requires --verify-windows-rust.')
  }
  if (parsed.requireBridge && parsed.bridge !== 'mf') {
    throw new Error('--require-bridge requires --bridge mf.')
  }
  if (parsed.requireD3d11 && !parsed.d3d11) {
    throw new Error('--require-d3d11 requires --d3d11.')
  }
  if (parsed.expectFallback && (parsed.d3d11 || parsed.requireD3d11)) {
    throw new Error('--expect-fallback natural cannot be combined with D3D11 requirements.')
  }
  if (parsed.pathEvidence === 'natural' && parsed.expectFallback !== 'natural') {
    throw new Error('--path-evidence natural requires --expect-fallback natural.')
  }
  if (parsed.operation === 'gate') validateGateOptions(parsed)
  if (
    ['combine-path-evidence', 'finalize-fallback-evidence'].includes(parsed.operation) &&
    parsed.hardwareClass === null
  ) {
    throw new Error(`--${parsed.operation} requires --hardware-class.`)
  }
  if (
    ['merge-evidence', 'combine-path-evidence', 'finalize-fallback-evidence'].includes(
      parsed.operation
    ) &&
    parsed.output === null
  ) {
    throw new Error(`--${parsed.operation} requires --output.`)
  }
  if (parsed.operation === 'finalize-fallback-evidence') {
    if (parsed.hardwareClass !== 'unsupported-natural-fallback' || parsed.inputPaths.length !== 1) {
      throw new Error(
        '--finalize-fallback-evidence requires exactly one unsupported-natural-fallback child.'
      )
    }
  }
  if (parsed.operation === 'combine-path-evidence') {
    if (parsed.hardwareClass === 'unsupported-natural-fallback' || parsed.inputPaths.length !== 2) {
      throw new Error('--combine-path-evidence requires exactly two supported-host children.')
    }
  }
  if (parsed.operation === 'merge-evidence' && parsed.inputPaths.length !== 3) {
    throw new Error('--merge-evidence requires exactly three host manifests.')
  }
  if (parsed.operation === 'stage' && parsed.stage === null) {
    throw new Error('--stage requires a stage name.')
  }
  if (
    parsed.operation === 'stage' &&
    parsed.stage !== 'contract' &&
    !portableAbsolutePath(parsed.output)
  ) {
    throw new Error('Physical --stage execution requires an absolute --output.')
  }
}

function validateGateOptions(parsed) {
  if (!parsed.gate) {
    const supplied = [
      parsed.hardwareClass,
      parsed.output,
      parsed.bridge,
      parsed.expectFallback,
      parsed.pathEvidence,
      parsed.profiles.length > 0,
      parsed.requireBridge,
      parsed.d3d11,
      parsed.requireD3d11
    ].some(Boolean)
    if (supplied) throw new Error('Final evidence options require --gate.')
    return
  }
  if (!parsed.hardwareClass || !parsed.output || !parsed.pathEvidence) {
    throw new Error('--gate requires --hardware-class, --path-evidence, and --output.')
  }
  const expectedProfiles = expectedWindowsD3d11Profiles(parsed.hardwareClass)
  if (!equalArrays(parsed.profiles, expectedProfiles)) {
    throw new Error(
      `${parsed.hardwareClass} gate profiles must be exactly ${expectedProfiles.join(',')}.`
    )
  }
  if (parsed.pathEvidence === 'forced') {
    if (
      parsed.hardwareClass === 'unsupported-natural-fallback' ||
      parsed.bridge !== 'mf' ||
      !parsed.requireBridge ||
      !parsed.d3d11 ||
      !parsed.requireD3d11 ||
      parsed.expectFallback
    ) {
      throw new Error(
        'Forced evidence requires a supported class plus --bridge mf --require-bridge --d3d11 --require-d3d11.'
      )
    }
  } else if (parsed.pathEvidence === 'default') {
    if (
      parsed.hardwareClass === 'unsupported-natural-fallback' ||
      parsed.bridge ||
      parsed.requireBridge ||
      parsed.d3d11 ||
      parsed.requireD3d11 ||
      parsed.expectFallback
    ) {
      throw new Error('Default evidence must use automatic selection without override flags.')
    }
  } else if (
    parsed.hardwareClass !== 'unsupported-natural-fallback' ||
    parsed.expectFallback !== 'natural' ||
    parsed.bridge ||
    parsed.requireBridge ||
    parsed.d3d11 ||
    parsed.requireD3d11
  ) {
    throw new Error(
      'Natural evidence requires the unsupported fallback class and --expect-fallback natural only.'
    )
  }
}

function validateCandidate(value, label, failures, { allowNull = false } = {}) {
  if (!isPlainObject(value)) {
    failures.push(`${label} must be an object`)
    return
  }
  const fields = [
    ['sourceCommit', 40],
    ['installerSha256', 64],
    ['appSha256', 64],
    ['payloadSha256', 64]
  ]
  for (const [field, length] of fields) {
    if (allowNull && value[field] === null) continue
    if (!lowercaseHex(value[field], length)) failures.push(`${label}.${field} was invalid`)
  }
}

function validatePathHost(value, failures) {
  if (!isPlainObject(value)) {
    failures.push('host must be an object')
    return
  }
  const hardwareClass = value.declaredClass
  if (!WINDOWS_D3D11_HARDWARE_CLASSES.includes(hardwareClass)) {
    failures.push('host.declaredClass was unknown')
  }
  if (value.observedClass !== hardwareClass) {
    failures.push('host.observedClass did not independently match declaredClass')
  }
  const expectedVendor =
    hardwareClass === 'nvidia-turing-floor'
      ? 'nvidia'
      : hardwareClass === 'intel-xe-integrated'
        ? 'intel'
        : null
  if (!['nvidia', 'intel', 'amd', 'microsoft', 'other'].includes(value.vendor)) {
    failures.push('host.vendor was invalid')
  } else if (expectedVendor && value.vendor !== expectedVendor) {
    failures.push(`host.vendor must be ${expectedVendor} for ${hardwareClass}`)
  }
  if (!lowercaseHex(value.fingerprintSha256, 64)) {
    failures.push('host.fingerprintSha256 was invalid')
  }
  if (
    value.fingerprintRecipe !==
    'sha256(canonical-json-v1:{operatingSystem,selectedScreenId,adapterLuid,adapterDescriptorSha256,settingsSha256})'
  ) {
    failures.push('host.fingerprintRecipe was invalid')
  }
  if (!isPlainObject(value.canonicalInputs)) {
    failures.push('host.canonicalInputs was missing')
  } else {
    if (
      value.canonicalInputs.operatingSystem?.platform !== 'win32' ||
      value.canonicalInputs.operatingSystem?.arch !== 'x64' ||
      !nonEmptyString(value.canonicalInputs.operatingSystem?.release)
    ) {
      failures.push('host canonical Windows OS identity was invalid')
    }
    if (!/^screen:dxgi:[a-f0-9]{16}:\d+$/.test(value.canonicalInputs.selectedScreenId ?? '')) {
      failures.push('host canonical selectedScreenId was invalid')
    }
    if (!/^[a-f0-9]{16}$/.test(value.canonicalInputs.adapterLuid ?? '')) {
      failures.push('host canonical adapterLuid was invalid')
    }
    for (const field of ['adapterDescriptorSha256', 'settingsSha256']) {
      if (!lowercaseHex(value.canonicalInputs[field], 64)) {
        failures.push(`host canonical ${field} was invalid`)
      }
    }
    if (
      lowercaseHex(value.fingerprintSha256, 64) &&
      value.fingerprintSha256 !== sha256CanonicalJson(value.canonicalInputs)
    ) {
      failures.push('host.fingerprintSha256 did not bind canonicalInputs')
    }
  }
  if (
    !lowercaseHex(value.classProof?.settingsSha256, 64) ||
    !lowercaseHex(value.classProof?.adapterDescriptorSha256, 64) ||
    !nonEmptyString(value.classProof?.rule)
  ) {
    failures.push('host.classProof was invalid')
  } else if (
    value.classProof.settingsSha256 !== value.canonicalInputs?.settingsSha256 ||
    value.classProof.adapterDescriptorSha256 !== value.canonicalInputs?.adapterDescriptorSha256
  ) {
    failures.push('host.classProof did not bind the fingerprint inputs')
  }
}

function validateProfiles(value, hardwareClass, failures, label = 'profiles') {
  const expected = WINDOWS_D3D11_HARDWARE_CLASSES.includes(hardwareClass)
    ? expectedWindowsD3d11Profiles(hardwareClass)
    : []
  if (!Array.isArray(value) || !equalArrays(value, expected)) {
    failures.push(`${label} must be exactly ${expected.join(',') || 'the class profile set'}`)
  }
}

function validateSelection(value, hardwareClass, failures) {
  if (!isPlainObject(value) || !WINDOWS_D3D11_PATH_EVIDENCE.includes(value.mode)) {
    failures.push('selection.mode was invalid')
    return
  }
  const expected = expectedWindowsD3d11Selection(value.mode)
  if (canonicalJson(value) !== canonicalJson(expected)) {
    failures.push(`selection did not match the exact ${value.mode} environment/path contract`)
  }
  const fallback = hardwareClass === 'unsupported-natural-fallback'
  if ((value.mode === 'natural') !== fallback) {
    failures.push('selection mode did not match the hardware class')
  }
}

function validateBudgetBinding(value, profiles, failures) {
  if (
    !isPlainObject(value) ||
    !portableAbsolutePath(value.path) ||
    !lowercaseHex(value.activeSha256, 64)
  ) {
    failures.push('budget path/activeSha256 binding was invalid')
    return
  }
  if (!Array.isArray(value.resolvedProfiles) || value.resolvedProfiles.length === 0) {
    failures.push('budget.resolvedProfiles was empty')
    return
  }
  const ids = new Set()
  const coveredProfiles = new Set()
  for (const [index, profile] of value.resolvedProfiles.entries()) {
    if (
      !nonEmptyString(profile?.id) ||
      !WINDOWS_D3D11_PROFILES.includes(profile?.profile) ||
      !nonEmptyString(profile?.scenario) ||
      !lowercaseHex(profile?.sha256, 64)
    ) {
      failures.push(`budget.resolvedProfiles[${index}] was invalid`)
      continue
    }
    if (ids.has(profile.id)) failures.push('budget resolved profile IDs were duplicated')
    ids.add(profile.id)
    coveredProfiles.add(profile.profile)
  }
  if (!equalArrays([...coveredProfiles].sort(), [...profiles].sort())) {
    failures.push('budget resolved profiles did not cover the exact qualified profile set')
  }
  if (
    lowercaseHex(value.resolvedProfileSetSha256, 64) &&
    value.resolvedProfileSetSha256 !== sha256CanonicalJson(value.resolvedProfiles)
  ) {
    failures.push('budget.resolvedProfileSetSha256 did not bind resolvedProfiles')
  } else if (!lowercaseHex(value.resolvedProfileSetSha256, 64)) {
    failures.push('budget.resolvedProfileSetSha256 was invalid')
  }
}

function validateWorkload(value, profiles, mode, failures) {
  if (!isPlainObject(value)) {
    failures.push('workload was missing')
    return
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    failures.push('workload.scenarios was empty')
    return
  }
  const coordinates = []
  const ids = new Set()
  for (const [index, scenario] of value.scenarios.entries()) {
    if (
      !nonEmptyString(scenario?.id) ||
      !WINDOWS_D3D11_PROFILES.includes(scenario?.profile) ||
      !positiveInteger(scenario?.repetitions) ||
      !['screen-only', 'screen-camera'].includes(scenario?.sourceComposition) ||
      typeof scenario?.previewOpen !== 'boolean'
    ) {
      failures.push(`workload.scenarios[${index}] was invalid`)
      continue
    }
    if (ids.has(scenario.id)) failures.push('workload scenario IDs were duplicated')
    ids.add(scenario.id)
    coordinates.push({
      id: scenario.id,
      profile: scenario.profile,
      repetitions: scenario.repetitions,
      sourceComposition: scenario.sourceComposition,
      previewOpen: scenario.previewOpen
    })
  }
  const coveredProfiles = [...new Set(coordinates.map(({ profile }) => profile))].sort()
  if (!equalArrays(coveredProfiles, [...profiles].sort())) {
    failures.push('workload scenarios did not cover the exact profile set')
  }
  if (mode === 'natural') {
    const idsInOrder = coordinates.map(({ id }) => id)
    if (
      !equalArrays(idsInOrder, WINDOWS_D3D11_NATURAL_FALLBACK_SCENARIOS) ||
      coordinates.some(
        ({ profile, repetitions, sourceComposition }) =>
          profile !== '1080p30' || repetitions !== 3 || sourceComposition !== 'screen-only'
      )
    ) {
      failures.push('natural workload was not the exact four-context, three-repetition matrix')
    }
  }
  if (
    value.scenarioSetSha256 !== sha256CanonicalJson(value.scenarios) ||
    value.scenarioCoordinatesSha256 !== sha256CanonicalJson(coordinates)
  ) {
    failures.push('workload scenario hashes did not bind the retained scenarios')
  }
  if (!lowercaseHex(value.settingsSha256, 64)) {
    failures.push('workload.settingsSha256 was invalid')
  }
}

function validateAdapterProof(value, mode, failures) {
  if (!isPlainObject(value)) {
    failures.push('adapterProof was missing')
    return
  }
  exactKeys(value, ADAPTER_PROOF_KEYS, 'adapterProof', failures)
  const natural = mode === 'natural'
  const luidFields = [
    'selectedScreenAdapterLuid',
    'mediaAuthorityAdapterLuid',
    'captureAdapterLuid',
    'compositorAdapterLuid',
    'primaryEncoderAdapterLuid'
  ]
  if (!natural) {
    const authority = value.mediaAuthorityAdapterLuid
    if (
      value.scope !== 'selected-dxgi-display-plus-per-role-session-authority' ||
      value.perRoleLuidsAvailable !== true ||
      luidFields.some((field) => !/^[a-f0-9]{16}$/.test(value[field] ?? '')) ||
      luidFields.some((field) => value[field] !== authority) ||
      (value.auxiliaryEncoderAdapterLuid !== null &&
        (!/^[a-f0-9]{16}$/.test(value.auxiliaryEncoderAdapterLuid ?? '') ||
          value.auxiliaryEncoderAdapterLuid !== authority)) ||
      value.equal !== true
    ) {
      failures.push(
        'adapterProof did not prove selected display == media authority == every D3D11 role'
      )
    }
  } else {
    if (
      value.scope !== 'named-natural-fallback-without-d3d-authority' ||
      value.perRoleLuidsAvailable !== false
    ) {
      failures.push('natural fallback adapterProof scope must not claim D3D role authority')
    }
    if (
      [...luidFields, 'auxiliaryEncoderAdapterLuid'].some((field) => value[field] !== null) ||
      value.equal !== null
    ) {
      failures.push('natural fallback adapterProof must not claim D3D adapter equality')
    }
  }
}

function validatePathInvariants(value, mode, failures) {
  if (!isPlainObject(value)) {
    failures.push('invariants were missing')
    return
  }
  const natural = mode === 'natural'
  if (value.physicalInputContractPassed !== true) {
    failures.push('invariants.physicalInputContractPassed must be true')
  }
  if (value.cameraUploadsMatchScenarios !== true) {
    failures.push('invariants.cameraUploadsMatchScenarios must be true')
  }
  if (value.adapterRolesMatchAuthority !== true) {
    failures.push('invariants.adapterRolesMatchAuthority must be true')
  }
  const zeroCounters = natural
    ? [
        'captureReadbackFrames',
        'compositorCpuFallbackFrames',
        'texturePoolPressureEvents',
        'adapterMismatches',
        'deviceResets',
        'staleGenerationCallbacks',
        'synchronizationTimeouts',
        'pathIdentityChanges',
        'unexpectedFallbacks'
      ]
    : REQUIRED_ZERO_COUNTERS
  for (const field of zeroCounters) {
    if (value[field] !== 0) failures.push(`invariants.${field} must be zero`)
  }
  if (!natural) {
    for (const field of [
      'adapterLuidMatchesSelectedScreen',
      'presenterSameAdapter',
      'presenterGenerationBound',
      'presenterOwnerBound',
      'presenterSourceLive',
      'presenterFirstPresentSucceeded',
      'presenterPresentsPositive',
      'cursorCorrect',
      'inputContinuity'
    ]) {
      if (value[field] !== true) failures.push(`invariants.${field} must be true`)
    }
    if (!positiveNumber(value.textureImportFrames)) {
      failures.push('invariants.textureImportFrames must be positive')
    }
    if (!positiveNumber(value.encoderGpuSamples)) {
      failures.push('invariants.encoderGpuSamples must be positive')
    }
    if (
      !positiveInteger(value.texturePoolCapacityMinimum) ||
      !Number.isFinite(value.texturePoolInUseMaximum) ||
      value.texturePoolInUseMaximum < 0 ||
      value.texturePoolInUseMaximum > value.texturePoolCapacityMinimum
    ) {
      failures.push('invariants texture pool was missing, unbounded, or grew past capacity')
    }
    if (!Number.isFinite(value.messageDispatchP95Ms) || value.messageDispatchP95Ms > 50) {
      failures.push('invariants.messageDispatchP95Ms exceeded 50ms')
    }
    if (!Number.isFinite(value.messageDispatchMaxMs) || value.messageDispatchMaxMs > 100) {
      failures.push('invariants.messageDispatchMaxMs exceeded 100ms')
    }
    if (
      !Number.isFinite(value.mediaCommandLagP95Ms) ||
      value.mediaCommandLagP95Ms < 0 ||
      value.mediaCommandLagP95Ms > WINDOWS_D3D11_FAIRNESS_LIMITS.mediaCommandLagP95Ms
    ) {
      failures.push('invariants.mediaCommandLagP95Ms exceeded 50ms')
    }
    if (
      !Number.isFinite(value.mediaCommandLagMaxMs) ||
      value.mediaCommandLagMaxMs < 0 ||
      value.mediaCommandLagMaxMs > WINDOWS_D3D11_FAIRNESS_LIMITS.mediaCommandLagMaxMs
    ) {
      failures.push('invariants.mediaCommandLagMaxMs exceeded 100ms')
    }
    for (const field of ['maximumConsecutiveMessageBatch', 'maximumConsecutiveMediaBatch']) {
      if (
        !Number.isInteger(value[field]) ||
        value[field] < 0 ||
        value[field] > WINDOWS_D3D11_FAIRNESS_LIMITS[field]
      ) {
        failures.push(`invariants.${field} exceeded its bounded fairness limit`)
      }
    }
    if (value.namedNaturalFallback !== false) {
      failures.push('supported path must not claim a natural fallback')
    }
  } else {
    if (value.namedNaturalFallback !== true) {
      failures.push('natural path did not retain one named fallback')
    }
    if (value.encoderGpuSamples !== 0 || value.textureImportFrames !== 0) {
      failures.push('natural path must not claim D3D texture/encoder activity')
    }
  }
}

function validatePathEvidence(value, workload, mode, failures) {
  if (!isPlainObject(value)) {
    failures.push('evidence was missing')
    return
  }
  if (
    !portableAbsolutePath(value.performanceAggregate?.path) ||
    !lowercaseHex(value.performanceAggregate?.sha256, 64)
  ) {
    failures.push('evidence.performanceAggregate binding was invalid')
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    failures.push('evidence.scenarios was empty')
    return
  }
  const expectedCount = workload?.scenarios?.reduce(
    (sum, scenario) => sum + scenario.repetitions,
    0
  )
  if (value.scenarios.length !== expectedCount) {
    failures.push(`evidence.scenarios retained ${value.scenarios.length}/${expectedCount} runs`)
  }
  const coordinates = new Set()
  const expectedCoordinates = new Set(
    (workload?.scenarios ?? []).flatMap((scenario) =>
      Array.from({ length: scenario.repetitions }, (_, index) => `${scenario.id}#${index + 1}`)
    )
  )
  for (const [index, scenario] of value.scenarios.entries()) {
    const key = `${scenario?.id}#${scenario?.repetition}`
    if (coordinates.has(key)) failures.push('evidence scenario coordinates were duplicated')
    coordinates.add(key)
    if (
      !nonEmptyString(scenario?.id) ||
      !positiveInteger(scenario?.repetition) ||
      !WINDOWS_D3D11_PROFILES.includes(scenario?.profile) ||
      !portableAbsolutePath(scenario?.report?.path) ||
      !lowercaseHex(scenario?.report?.sha256, 64)
    ) {
      failures.push(`evidence.scenarios[${index}] identity was invalid`)
    }
    const workloadScenario = workload?.scenarios?.find(({ id }) => id === scenario?.id)
    if (
      !workloadScenario ||
      scenario?.profile !== workloadScenario.profile ||
      scenario?.sourceComposition !== workloadScenario.sourceComposition ||
      scenario?.previewOpen !== workloadScenario.previewOpen ||
      scenario?.repetition > workloadScenario.repetitions
    ) {
      failures.push(`evidence.scenarios[${index}] did not match its workload context`)
    }
    for (const field of [
      'scenarioSha256',
      'artifactSetSha256',
      'supportBundleSha256',
      'lifecycleSha256',
      'faultSha256',
      'comparisonSha256',
      'inputContinuitySha256',
      'cameraUploadSha256'
    ]) {
      if (!lowercaseHex(scenario?.[field], 64)) {
        failures.push(`evidence.scenarios[${index}].${field} was invalid`)
      }
    }
    if (
      scenario?.scenarioSha256 !==
      sha256CanonicalJson({
        id: scenario?.id,
        repetition: scenario?.repetition,
        profile: scenario?.profile,
        reportSha256: scenario?.report?.sha256,
        sourceComposition: scenario?.sourceComposition,
        previewOpen: scenario?.previewOpen
      })
    ) {
      failures.push(`evidence.scenarios[${index}].scenarioSha256 did not bind the run`)
    }
    if (!isPlainObject(scenario?.artifacts) || Object.keys(scenario.artifacts).length === 0) {
      failures.push(`evidence.scenarios[${index}].artifacts was empty`)
    } else {
      for (const [name, artifact] of Object.entries(scenario.artifacts)) {
        if (
          !nonEmptyString(name) ||
          !portableAbsolutePath(artifact?.path) ||
          !lowercaseHex(artifact?.sha256, 64)
        ) {
          failures.push(`evidence.scenarios[${index}].artifacts.${name} was invalid`)
        }
      }
      if (scenario.artifactSetSha256 !== sha256CanonicalJson(scenario.artifacts)) {
        failures.push(`evidence.scenarios[${index}].artifactSetSha256 did not bind artifacts`)
      }
      if (scenario.supportBundleSha256 !== scenario.artifacts.supportBundle?.sha256) {
        failures.push(`evidence.scenarios[${index}] support bundle hash was not byte-bound`)
      }
    }
    if (
      scenario?.lifecycle?.verdict !== 'PASS' ||
      scenario.lifecycle.sha256 !== scenario.lifecycleSha256
    ) {
      failures.push(`evidence.scenarios[${index}] lifecycle PASS record was invalid`)
    }
    if (scenario?.fault?.verdict !== 'PASS' || scenario.fault.sha256 !== scenario.faultSha256) {
      failures.push(`evidence.scenarios[${index}] fault PASS record was invalid`)
    }
    const expectedComparisonStatus = mode === 'natural' ? 'NOT_APPLICABLE' : 'BOUND'
    if (
      scenario?.comparison?.status !== expectedComparisonStatus ||
      scenario.comparison.sha256 !== scenario.comparisonSha256
    ) {
      failures.push(`evidence.scenarios[${index}] comparison evidence record was invalid`)
    }
    const input = scenario?.inputContinuity
    const inputProjection = {
      verdict: input?.verdict,
      applicable: input?.applicable,
      physicalInput: input?.physicalInput,
      evidenceSha256: input?.evidenceSha256
    }
    if (
      !lowercaseHex(input?.evidenceSha256, 64) ||
      scenario.inputContinuitySha256 !== sha256CanonicalJson(inputProjection)
    ) {
      failures.push(`evidence.scenarios[${index}] input continuity hash was invalid`)
    }
    if (mode !== 'natural' && scenario?.previewOpen === true) {
      if (
        input?.verdict !== 'PASS' ||
        input?.applicable !== true ||
        input?.physicalInput !== true
      ) {
        failures.push(
          `evidence.scenarios[${index}] did not retain real preview-open physical input PASS`
        )
      }
    } else if (input?.applicable !== false || input?.physicalInput !== false) {
      failures.push(`evidence.scenarios[${index}] closed/non-D3D input must be not applicable`)
    }
    const camera = scenario?.cameraUpload
    if (
      camera?.sourceComposition !== scenario?.sourceComposition ||
      camera?.sha256 !== scenario?.cameraUploadSha256 ||
      camera?.sha256 !==
        sha256CanonicalJson({
          sourceComposition: camera?.sourceComposition,
          frames: camera?.frames
        })
    ) {
      failures.push(`evidence.scenarios[${index}] camera upload record was invalid`)
    } else if (
      (scenario.sourceComposition === 'screen-camera' && !positiveNumber(camera.frames)) ||
      (scenario.sourceComposition === 'screen-only' && camera.frames !== 0)
    ) {
      failures.push(`evidence.scenarios[${index}] camera uploads did not match the scenario`)
    }
  }
  if (
    coordinates.size !== expectedCoordinates.size ||
    [...expectedCoordinates].some((key) => !coordinates.has(key))
  ) {
    failures.push('evidence scenarios did not cover every workload coordinate exactly once')
  }
  const hashes = {
    scenarioEvidenceSha256: sha256CanonicalJson(
      value.scenarios.map(({ scenarioSha256 }) => scenarioSha256)
    ),
    artifactEvidenceSha256: sha256CanonicalJson(
      value.scenarios.map(({ artifactSetSha256 }) => artifactSetSha256)
    ),
    supportBundleEvidenceSha256: sha256CanonicalJson(
      value.scenarios.map(({ supportBundleSha256 }) => supportBundleSha256)
    ),
    lifecycleEvidenceSha256: sha256CanonicalJson(
      value.scenarios.map(({ lifecycleSha256 }) => lifecycleSha256)
    ),
    faultEvidenceSha256: sha256CanonicalJson(value.scenarios.map(({ faultSha256 }) => faultSha256)),
    comparisonEvidenceSha256: sha256CanonicalJson(
      value.scenarios.map(({ comparisonSha256 }) => comparisonSha256)
    ),
    inputContinuityEvidenceSha256: sha256CanonicalJson(
      value.scenarios.map(({ inputContinuitySha256 }) => inputContinuitySha256)
    ),
    cameraUploadEvidenceSha256: sha256CanonicalJson(
      value.scenarios.map(({ cameraUploadSha256 }) => cameraUploadSha256)
    )
  }
  for (const [field, expected] of Object.entries(hashes)) {
    if (value[field] !== expected) failures.push(`evidence.${field} did not bind scenario evidence`)
  }
  if (mode === 'natural' && value.scenarios.some(({ profile }) => profile !== '1080p30')) {
    failures.push('natural evidence attempted to retain a non-1080p30 profile')
  }
}

function normalizeEvidenceArtifacts(artifacts, label) {
  if (!Array.isArray(artifacts)) throw new Error(`${label} artifacts must be an array.`)
  return artifacts.map((artifact, index) => {
    if (
      !isPlainObject(artifact) ||
      !isPlainObject(artifact.document) ||
      !portableAbsolutePath(artifact.path) ||
      !lowercaseHex(artifact.sha256, 64)
    ) {
      throw new Error(`${label} artifact ${index + 1} did not bind absolute path + exact bytes.`)
    }
    return artifact
  })
}

function inferSupportedHardwareClass(descriptor) {
  const normalized = descriptor.toLocaleLowerCase('en-US')
  if (normalized.includes('nvidia') && /gtx\s*1650\s*super/.test(normalized)) {
    return 'nvidia-turing-floor'
  }
  if (normalized.includes('intel') && /iris(?:\s*\(r\))?\s*xe/.test(normalized)) {
    return 'intel-xe-integrated'
  }
  return 'unsupported'
}

function windowsGpuVendor(descriptor) {
  const normalized = descriptor.toLocaleLowerCase('en-US')
  if (normalized.includes('nvidia')) return 'nvidia'
  if (normalized.includes('intel')) return 'intel'
  if (normalized.includes('amd') || normalized.includes('radeon')) return 'amd'
  if (normalized.includes('microsoft')) return 'microsoft'
  return 'other'
}

function sanitizeHardwareDescriptor(value) {
  if (!nonEmptyString(value)) throw new Error('DXGI adapter descriptor was missing.')
  const sanitized = value
    .normalize('NFKC')
    .replaceAll(/[\u0000-\u001f\u007f]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
  if (!sanitized || sanitized.length > 512) {
    throw new Error('DXGI adapter descriptor was empty or unbounded after sanitization.')
  }
  return sanitized
}

function exactKeys(value, expected, label, failures) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (!equalArrays(actual, wanted)) failures.push(`${label} keys drifted from schema-v1`)
}

function camelCaseFlag(flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())
}

function requiredValue(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
    throw new Error(`${flag} requires a non-empty value.`)
  }
  return value.trim()
}

function parseUniqueCsv(value, flag) {
  const values = value.split(',').map((entry) => entry.trim())
  if (values.length === 0 || values.some((entry) => entry.length === 0)) {
    throw new Error(`${flag} requires non-empty comma-separated values.`)
  }
  const duplicates = duplicateValues(values)
  if (duplicates.length > 0) throw new Error(`${flag} contained duplicate value: ${duplicates[0]}`)
  return values
}

function assertMember(value, allowed, flag) {
  if (!allowed.includes(value)) {
    throw new Error(`${flag} value ${value} was unknown; expected ${allowed.join(', ')}.`)
  }
  return value
}

function duplicateValues(values) {
  return values.filter((value, index) => values.indexOf(value) !== index)
}

function lowercaseHex(value, length) {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
}

function canonicalTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0
}

function portableAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('/') || /^[a-zA-Z]:[\\/][^<>|?*]+$/.test(value)) &&
    !value.includes('\0')
  )
}

function canonicalPortablePath(value) {
  return value.replaceAll('\\', '/').toLocaleLowerCase('en-US')
}

function uniqueCanonicalField(values, field) {
  const encoded = new Set(values.map((value) => canonicalJson(value[field])))
  if (encoded.size !== 1) throw new Error(`D3D11 evidence did not share one ${field}.`)
  return values[0][field]
}

function uniqueNestedField(values, path) {
  const entries = values.map((value) => path.reduce((current, key) => current?.[key], value))
  const unique = new Set(entries.map((entry) => canonicalJson(entry)))
  if (unique.size !== 1) {
    throw new Error(`D3D11 evidence did not share one ${path.join('.')}.`)
  }
  return entries[0]
}

function maxCounter(values, field) {
  const counters = values.map((value) => value?.[field])
  return counters.every((value) => Number.isFinite(value)) ? Math.max(...counters) : null
}

function sumCounter(values, field) {
  const counters = values.map((value) => value?.[field])
  return counters.every((value) => Number.isFinite(value))
    ? counters.reduce((sum, value) => sum + value, 0)
    : null
}

function maximumFinite(values) {
  return values.length > 0 && values.every(Number.isFinite) ? Math.max(...values) : null
}

function minimumFinite(values) {
  return values.length > 0 && values.every(Number.isFinite) ? Math.min(...values) : null
}

function equalArrays(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)])
  )
}
