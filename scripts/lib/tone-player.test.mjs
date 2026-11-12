import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTonePlayer,
  powershellQuote,
  windowsPlayerCommand,
  windowsPlayerScript
} from './tone-player.mjs'

test('quotes a path for PowerShell, doubling single quotes', () => {
  assert.equal(powershellQuote('C:\\tmp\\tone.wav'), "'C:\\tmp\\tone.wav'")
  assert.equal(powershellQuote("C:\\Users\\o'brien\\t.wav"), "'C:\\Users\\o''brien\\t.wav'")
})

test('a one-shot player loads, says ready, then plays only after the trigger line', () => {
  const script = windowsPlayerScript('C:\\t\\tone.wav')
  const load = script.indexOf('$p.Load()')
  const ready = script.indexOf("WriteLine('ready')")
  const trigger = script.indexOf('[Console]::In.ReadLine()')
  const play = script.indexOf('$p.PlaySync()')
  assert.ok(load >= 0 && load < ready && ready < trigger && trigger < play, script)
  assert.ok(!script.includes('PlayLooping'))
})

test('the keep-alive player loops until its stdin closes', () => {
  const script = windowsPlayerScript('C:\\t\\silence.wav', { loop: true })
  assert.ok(script.indexOf('$p.PlayLooping()') < script.indexOf('[Console]::In.ReadToEnd()'))
  assert.ok(script.endsWith('$p.Stop()'))
})

test('runs Windows PowerShell without a profile or prompts', () => {
  const { command, args } = windowsPlayerCommand('C:\\t\\tone.wav')
  assert.equal(command, 'powershell.exe')
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
})

test('refuses a platform with no player instead of playing nothing', () => {
  assert.throws(() => createTonePlayer({ platform: 'linux' }), /no tone player for linux/)
})

test('a Windows play without prepare names the missing step', () => {
  const player = createTonePlayer({ platform: 'win32' })
  assert.throws(() => player.play('C:\\t\\tone.wav'), /call prepare first/)
})
