import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WINDOWS_ENCODED_BRIDGE_PROFILES,
  parseWindowsEncodedBridgeArgs,
  selectWindowsEncodedBridgeProfiles
} from './windows-encoded-bridge-profiles.mjs'

test('defaults to the complete ten-profile characterization matrix', () => {
  const selected = selectWindowsEncodedBridgeProfiles()
  assert.equal(selected.length, 10)
  assert.deepEqual(
    selected.map(({ id }) => id),
    WINDOWS_ENCODED_BRIDGE_PROFILES.map(({ id }) => id)
  )
})

test('returns selected profiles in canonical order', () => {
  assert.deepEqual(
    selectWindowsEncodedBridgeProfiles(['--profiles', 'vertical-1080p60,1080p30']).map(
      ({ id }) => id
    ),
    ['1080p30', 'vertical-1080p60']
  )
})

test('rejects missing, empty, unknown, duplicate, repeated, and extra arguments', () => {
  assert.throws(
    () => selectWindowsEncodedBridgeProfiles(['--profiles']),
    /requires a comma-separated value/
  )
  assert.throws(
    () => selectWindowsEncodedBridgeProfiles(['--profiles', '']),
    /at least one non-empty/
  )
  assert.throws(
    () => selectWindowsEncodedBridgeProfiles(['--profiles', '1080p30,']),
    /at least one non-empty/
  )
  assert.throws(
    () => selectWindowsEncodedBridgeProfiles(['--profiles', 'not-real']),
    /Unknown Windows encoded-bridge profile/
  )
  assert.throws(
    () => selectWindowsEncodedBridgeProfiles(['--profiles', '1080p30,1080p30']),
    /Duplicate Windows encoded-bridge profile/
  )
  assert.throws(
    () => selectWindowsEncodedBridgeProfiles(['--profiles', '1080p30', '--profiles', '1080p60']),
    /Unknown Windows encoded-bridge argument|only once/
  )
  assert.throws(() => selectWindowsEncodedBridgeProfiles(['--wat']), /Unknown/)
})

test('propagates strict D3D11 selection and natural fallback modes', () => {
  const selected = parseWindowsEncodedBridgeArgs([
    '--profiles',
    '1080p30,1080p60',
    '--d3d11',
    '--require-d3d11'
  ])
  assert.deepEqual(
    selected.profiles.map(({ id }) => id),
    ['1080p30', '1080p60']
  )
  assert.equal(selected.d3d11, true)
  assert.equal(selected.requireD3d11, true)

  const fallback = parseWindowsEncodedBridgeArgs([
    '--profiles',
    '1080p30',
    '--expect-fallback',
    'natural'
  ])
  assert.equal(fallback.expectFallback, 'natural')
  assert.equal(fallback.d3d11, false)

  assert.throws(() => parseWindowsEncodedBridgeArgs(['--require-d3d11']), /requires --d3d11/)
  assert.throws(
    () =>
      parseWindowsEncodedBridgeArgs(['--d3d11', '--require-d3d11', '--expect-fallback', 'natural']),
    /cannot be combined/
  )
})
