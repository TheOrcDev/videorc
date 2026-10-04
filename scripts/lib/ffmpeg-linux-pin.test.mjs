import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  REQUIRED_LINUX_FFMPEG_FILTERS,
  assessFfmpegLinuxPin,
  assessLinuxFfmpegCapabilities,
  linuxAutobuildDurability
} from './ffmpeg-linux-pin.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DURABLE_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-lgpl-8.1.tar.xz'
const SHA = '8c8b2897f2a8093ae2d985f7f1867d218451d4c567c1b2437f86a7c73a950b9f'

describe('Linux FFmpeg pin', () => {
  it('requires a durable Linux x64 LGPL autobuild with a lowercase SHA-256', () => {
    assert.deepEqual(assessFfmpegLinuxPin({ url: DURABLE_URL, sha256: SHA }), {
      ok: true,
      problems: []
    })
    assert.deepEqual(linuxAutobuildDurability(DURABLE_URL), {
      tagDate: '2026-07-31',
      durable: true
    })
  })

  it('rejects prunable, GPL, wrong-platform, and malformed pins', () => {
    assert.match(
      assessFfmpegLinuxPin({
        url: DURABLE_URL.replace('2026-07-31-14-10', '2026-08-22-12-58'),
        sha256: SHA
      }).problems.join('\n'),
      /prunable/
    )
    assert.match(
      assessFfmpegLinuxPin({ url: DURABLE_URL.replace('lgpl', 'gpl'), sha256: SHA }).problems.join(
        '\n'
      ),
      /LGPL/
    )
    assert.match(
      assessFfmpegLinuxPin({
        url: DURABLE_URL.replace('linux64', 'win64'),
        sha256: SHA
      }).problems.join('\n'),
      /Linux x64 LGPL/
    )
    assert.match(
      assessFfmpegLinuxPin({ url: DURABLE_URL, sha256: 'ABC' }).problems.join('\n'),
      /64 lowercase hex/
    )
  })

  it('keeps the committed pin durable', async () => {
    const pin = JSON.parse(
      await readFile(join(repoRoot, 'vendor', 'ffmpeg', 'linux-pin.json'), 'utf8')
    )
    const assessment = assessFfmpegLinuxPin(pin)
    assert.equal(assessment.ok, true, assessment.problems.join('\n'))
  })
})

describe('Linux FFmpeg capability policy', () => {
  const versionOutput = [
    'ffmpeg version 8.1.2',
    'configuration: --disable-gpl --disable-nonfree --enable-vaapi --enable-libopenh264 --disable-libx264 --disable-libx265 --disable-libfdk-aac'
  ].join('\n')
  const encodersOutput = [
    ' V..... h264_vaapi VAAPI H.264 encoder',
    ' V..... libopenh264 OpenH264'
  ].join('\n')
  const filtersOutput = [
    'Filters:',
    ' ... trim             V->V       Pick one continuous section from the input, drop the rest.',
    ' ... atrim            A->A       Pick one continuous section from the input, drop the rest.',
    ' ... concat           N->N       Concatenate audio and video streams.',
    ' T.. afade            A->A       Fade in/out input audio.',
    ' ... split            V->N       Pass on the input to N video outputs.',
    ' ... asplit           A->N       Pass on the audio input to N audio outputs.',
    ' ... setpts           V->V       Set PTS for the output video frame.',
    ' ... asetpts          A->A       Set PTS for the output audio frame.',
    ' ... format           V->V       Convert the input video to one of the specified pixel formats.',
    ' ... hwupload         V->V       Upload a normal frame to a hardware frame'
  ].join('\n')

  it('accepts exactly the LGPL VAAPI plus OpenH264 contract with the Clean cut filters', () => {
    assert.deepEqual(
      assessLinuxFfmpegCapabilities({ versionOutput, encodersOutput, filtersOutput }),
      {
        ok: true,
        problems: []
      }
    )
    assert.deepEqual(REQUIRED_LINUX_FFMPEG_FILTERS, [
      'trim',
      'atrim',
      'concat',
      'afade',
      'split',
      'asplit',
      'setpts',
      'asetpts',
      'format',
      'hwupload'
    ])
  })

  it('rejects GPL/nonfree flags, missing fallbacks, and incomplete configuration', () => {
    const assessment = assessLinuxFfmpegCapabilities({
      versionOutput: versionOutput.replace('--disable-gpl', '--enable-gpl'),
      encodersOutput: ' V..... h264_vaapi VAAPI H.264 encoder',
      filtersOutput
    })
    assert.match(assessment.problems.join('\n'), /forbidden configure flag --enable-gpl/)
    assert.match(assessment.problems.join('\n'), /missing H.264 encoder libopenh264/)
    assert.match(
      assessLinuxFfmpegCapabilities({
        versionOutput: 'ffmpeg version 8.1.2',
        encodersOutput,
        filtersOutput
      }).problems.join('\n'),
      /configuration line/
    )
  })

  it('fails closed on a missing filter or a missing -filters listing (plan 119 S13)', () => {
    const withoutUpload = assessLinuxFfmpegCapabilities({
      versionOutput,
      encodersOutput,
      filtersOutput: filtersOutput
        .split('\n')
        .filter((line) => !/ hwupload /.test(line))
        .join('\n')
    })
    assert.deepEqual(withoutUpload.problems, ['missing filter hwupload'])
    const unlisted = assessLinuxFfmpegCapabilities({ versionOutput, encodersOutput })
    assert.deepEqual(unlisted.problems, ['ffmpeg -filters output was not provided'])
  })
})
