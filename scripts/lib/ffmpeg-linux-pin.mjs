const AUTOBUILD_DOWNLOAD =
  /^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/autobuild-(\d{4})-(\d{2})-(\d{2})-\d{2}-\d{2}\/(.+linux64-lgpl.+\.tar\.xz)$/

const SHA256 = /^[0-9a-f]{64}$/

export const REQUIRED_LINUX_FFMPEG_CONFIGURATION = [
  '--enable-vaapi',
  '--enable-libopenh264',
  '--disable-libx264',
  '--disable-libx265',
  '--disable-libfdk-aac'
]

export const REQUIRED_LINUX_H264_ENCODERS = ['h264_vaapi', 'libopenh264']

export function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function linuxAutobuildDurability(url) {
  const match = AUTOBUILD_DOWNLOAD.exec(String(url ?? ''))
  if (!match) return null
  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  return {
    tagDate: `${yearText}-${monthText}-${dayText}`,
    durable: day === lastDayOfMonth(year, month)
  }
}

export function assessFfmpegLinuxPin(pin) {
  const problems = []
  const url = pin?.url
  const sha256 = pin?.sha256

  if (!url || typeof url !== 'string') {
    problems.push('missing "url"')
  } else if (!/linux64-lgpl/.test(url)) {
    problems.push(`not a Linux x64 LGPL build: ${url}`)
  }
  if (!sha256 || typeof sha256 !== 'string') {
    problems.push('missing "sha256"')
  } else if (!SHA256.test(sha256)) {
    problems.push(`"sha256" must be 64 lowercase hex characters, got "${sha256}"`)
  }

  const durability = linuxAutobuildDurability(url)
  if (durability && !durability.durable) {
    problems.push(
      `autobuild-${durability.tagDate} is a prunable mid-month build; pin the final autobuild of a month`
    )
  }

  return { ok: problems.length === 0, problems }
}

function configurationLine(versionOutput) {
  return String(versionOutput ?? '')
    .split(/\r?\n/)
    .find((line) => line.startsWith('configuration:'))
}

export function assessLinuxFfmpegCapabilities({ versionOutput, encodersOutput }) {
  const problems = []
  const configuration = configurationLine(versionOutput)
  if (!configuration) {
    problems.push('ffmpeg -version did not report a configuration line')
  } else {
    for (const flag of REQUIRED_LINUX_FFMPEG_CONFIGURATION) {
      if (!configuration.includes(flag)) problems.push(`missing configure flag ${flag}`)
    }
    for (const forbidden of ['--enable-gpl', '--enable-nonfree']) {
      if (configuration.includes(forbidden)) problems.push(`forbidden configure flag ${forbidden}`)
    }
  }

  const encoders = String(encodersOutput ?? '')
  for (const encoder of REQUIRED_LINUX_H264_ENCODERS) {
    if (!encoders.split(/\s+/).includes(encoder)) problems.push(`missing H.264 encoder ${encoder}`)
  }

  return { ok: problems.length === 0, problems }
}
