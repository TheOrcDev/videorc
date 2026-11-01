import assert from 'node:assert/strict'
import test from 'node:test'
import { linuxRenderNodeInvocation } from './linux-render-node-isolation.mjs'

function fixture(overrides = {}) {
  const reads = []
  const device = '/sys/devices/pci0000:00/0000:00:02.0'
  return {
    reads,
    options: {
      platform: 'linux',
      command: 'pnpm',
      args: ['smoke:first-run'],
      env: {
        VIDEORC_LINUX_VAAPI_DEVICE: '/dev/dri/renderD128',
        DRI_PRIME: 'wrong',
        LIBVA_DEVICE: 'wrong'
      },
      realpath: (path) => {
        reads.push(path)
        return path.endsWith('/device') ? device : path
      },
      stat: (path) => {
        reads.push(path)
        return { isCharacterDevice: () => true }
      },
      readDirectory: (path) => {
        reads.push(path)
        return ['card1', 'renderD128', 'controlD65', 'card1-DP-1']
      },
      ...overrides
    }
  }
}

test('restricts device visibility for the entire command without opening another GPU', () => {
  const f = fixture()
  const spec = linuxRenderNodeInvocation(f.options)
  const bindings = spec.args.flatMap((arg, i) =>
    arg === '--dev-bind' ? [spec.args.slice(i + 1, i + 3)] : []
  )
  assert.deepEqual(bindings, [
    ['/dev', '/dev'],
    ['/dev/dri/renderD128', '/dev/dri/renderD128'],
    ['/dev/dri/card1', '/dev/dri/card1']
  ])
  assert.ok(spec.args.indexOf('--tmpfs') > spec.args.indexOf('--dev-bind'))
  assert.deepEqual(
    spec.args.slice(spec.args.indexOf('--tmpfs') + 1, spec.args.indexOf('--tmpfs') + 2),
    ['/dev/dri']
  )
  assert.deepEqual(spec.args.slice(spec.args.indexOf('--') + 1), ['pnpm', 'smoke:first-run'])
  assert.equal(spec.env.DRI_PRIME, 'pci-0000_00_02_0')
  assert.equal(spec.env.LIBVA_DEVICE, '/dev/dri/renderD128')
  assert.equal(f.options.env.DRI_PRIME, 'wrong')
  assert.deepEqual(
    new Set(f.reads),
    new Set([
      '/dev/dri/renderD128',
      '/sys/class/drm/renderD128/device',
      '/sys/devices/pci0000:00/0000:00:02.0/drm',
      '/dev/dri/card1'
    ])
  )
})

test('refuses absent or ambiguous authorization before inspecting any device', () => {
  for (const node of [
    undefined,
    '',
    'auto',
    '/dev/dri',
    '/dev/dri/renderD128/../renderD129',
    '/dev/dri/renderD128 --no-sandbox'
  ]) {
    const f = fixture({ env: { VIDEORC_LINUX_VAAPI_DEVICE: node } })
    assert.throws(() => linuxRenderNodeInvocation(f.options), /explicitly permitted/)
    assert.deepEqual(f.reads, [])
  }
  for (const overrides of [{ platform: 'darwin' }, { platform: 'win32' }, { command: '' }]) {
    const f = fixture(overrides)
    assert.throws(() => linuxRenderNodeInvocation(f.options))
    assert.deepEqual(f.reads, [])
  }
})

test('refuses alias redirection, non-devices, and uncertain card ownership', () => {
  for (const overrides of [
    { realpath: (path) => (path === '/dev/dri/renderD128' ? '/dev/dri/renderD130' : path) },
    { stat: () => ({ isCharacterDevice: () => false }) },
    { readDirectory: () => [] },
    { readDirectory: () => ['card1', 'card2'] },
    { realpath: (path) => (path.endsWith('/device') ? '/sys/not-a-pci-device' : path) }
  ]) {
    assert.throws(() => linuxRenderNodeInvocation(fixture(overrides).options))
  }
  const f = fixture()
  const original = f.options.realpath
  f.options.realpath = (path) => (path === '/dev/dri/card1' ? '/dev/dri/card2' : original(path))
  assert.throws(() => linuxRenderNodeInvocation(f.options), /matching DRM card/)
})
