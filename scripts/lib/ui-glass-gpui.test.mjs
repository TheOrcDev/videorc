import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GPUI_GROUND_SAMPLES, evaluateGpuiGround, minAlpha } from './ui-glass-gpui.mjs'

const solid = (rgb, size = 8, alpha = 255) => {
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = alpha
  }
  return { width: size, height: size, data }
}
const rect = { x: 0, y: 0, width: 8, height: 8 }
const text = {
  foreground: { r: 245, g: 245, b: 246 },
  'muted-foreground': { r: 161, g: 161, b: 166 },
  subtle: { r: 150, g: 150, b: 155 }
}

test('an opaque, steady dark ground with the dark tokens passes every check', () => {
  const a = solid([10, 10, 12])
  const b = solid([10, 10, 12])
  const result = evaluateGpuiGround({ theme: 'dark', role: 'main', images: [a, b], rect, text })
  assert.equal(result.pass, true, JSON.stringify(result))
  assert.equal(result.metrics.minAlpha, 255)
})

test('a translucent pixel fails opaqueAlpha', () => {
  const a = solid([10, 10, 12])
  a.data[3] = 200
  assert.equal(minAlpha(a, rect), 200)
  const result = evaluateGpuiGround({
    theme: 'dark',
    role: 'main',
    images: [a, solid([10, 10, 12])],
    rect,
    text
  })
  assert.equal(result.checks.opaqueAlpha, false)
  assert.equal(result.pass, false)
})

test('one changed channel between two captures fails stableCapture', () => {
  const a = solid([10, 10, 12])
  const b = solid([10, 10, 12])
  b.data[0] = 11
  const result = evaluateGpuiGround({ theme: 'dark', role: 'main', images: [a, b], rect, text })
  assert.equal(result.checks.stableCapture, false)
})

test('a light ground under the dark theme fails followsTheme; the reverse too', () => {
  const light = [solid([250, 250, 250]), solid([250, 250, 250])]
  const dark = [solid([10, 10, 12]), solid([10, 10, 12])]
  assert.equal(
    evaluateGpuiGround({ theme: 'dark', role: 'main', images: light, rect, text }).checks
      .followsTheme,
    false
  )
  assert.equal(
    evaluateGpuiGround({ theme: 'light', role: 'main', images: dark, rect, text }).checks
      .followsTheme,
    false
  )
})

test('text that is too close to the ground fails its contrast tier', () => {
  const grey = [solid([140, 140, 140]), solid([140, 140, 140])]
  const result = evaluateGpuiGround({
    theme: 'light',
    role: 'main',
    images: grey,
    rect,
    text: { ...text, foreground: { r: 150, g: 150, b: 150 } }
  })
  assert.equal(result.checks.foregroundContrast, false)
})

test('the Preview stays dark under the light theme and has no theme or contrast checks', () => {
  const dark = [solid([5, 5, 6]), solid([5, 5, 6])]
  const result = evaluateGpuiGround({ theme: 'light', role: 'preview', images: dark, rect, text })
  assert.deepEqual(Object.keys(result.checks).sort(), ['opaqueAlpha', 'pinnedDark', 'stableCapture'])
  assert.equal(result.pass, true)
  const lit = [solid([200, 200, 200]), solid([200, 200, 200])]
  assert.equal(
    evaluateGpuiGround({ theme: 'light', role: 'preview', images: lit, rect, text }).checks
      .pinnedDark,
    false
  )
})

test('every role has at least one named sample rect inside a 1100x700 window', () => {
  for (const [role, samples] of Object.entries(GPUI_GROUND_SAMPLES)) {
    assert.ok(samples.length > 0, role)
    for (const sample of samples) {
      const r = sample.rect({ width: 1100, height: 700 })
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 1100 && r.y + r.height <= 700, `${role}/${sample.name}`)
    }
  }
})
