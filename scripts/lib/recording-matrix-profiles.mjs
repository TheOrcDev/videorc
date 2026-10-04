// Every shipping recording profile plus the 60fps combos the encoder bridge
// now serves. 4K60 must use its experimental preset at the EXACT pinned
// values (validate_video_profile_policy rejects any deviation).
export const RECORDING_MATRIX_PROFILES = [
  // Floor of the performance-check ladder (tutorial-540p30, plan 090 D1).
  {
    label: '540p30',
    preset: 'tutorial-540p30',
    width: 960,
    height: 540,
    fps: 30,
    bitrateKbps: 2500
  },
  {
    label: '720p30',
    preset: 'tutorial-720p30',
    width: 1280,
    height: 720,
    fps: 30,
    bitrateKbps: 4000
  },
  { label: '1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
  { label: '1080p60', width: 1920, height: 1080, fps: 60, bitrateKbps: 12000 },
  { label: '1440p30', width: 2560, height: 1440, fps: 30, bitrateKbps: 8000 },
  { label: '1440p60', width: 2560, height: 1440, fps: 60, bitrateKbps: 16000 },
  { label: '4K30', width: 3840, height: 2160, fps: 30, bitrateKbps: 30000 },
  {
    label: '4K60',
    width: 3840,
    height: 2160,
    fps: 60,
    bitrateKbps: 50000,
    preset: 'record-4k60-experimental'
  },
  { label: 'vertical-1080p30', width: 1080, height: 1920, fps: 30, bitrateKbps: 6000 },
  { label: 'vertical-1440p30', width: 1440, height: 2560, fps: 30, bitrateKbps: 8000 },
  { label: 'vertical-4K30', width: 2160, height: 3840, fps: 30, bitrateKbps: 30000 },
  { label: 'floor-360p24', width: 640, height: 360, fps: 24, bitrateKbps: 2000 },
  { label: 'vertical-1080p60', width: 1080, height: 1920, fps: 60, bitrateKbps: 12000 },
  { label: 'vertical-1440p60', width: 1440, height: 2560, fps: 60, bitrateKbps: 16000 }
]

export function selectRecordingMatrixProfiles(matrixOnly) {
  return RECORDING_MATRIX_PROFILES.filter(
    (combo) => !matrixOnly || matrixOnly.split(',').includes(combo.label)
  )
}
