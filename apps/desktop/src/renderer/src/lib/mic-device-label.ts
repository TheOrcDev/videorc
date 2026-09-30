// Chromium ↔ backend microphone name matching (plan 080 S3).
//
// The backend names a CoreAudio device by its plain name ("AirPods Pro").
// Chromium's enumerateDevices label decorates the same device: macOS appends
// the transport ("AirPods Pro (Bluetooth)", "MacBook Pro Microphone
// (Built-in)"), USB devices get the model's vid:pid ("Shure MV7 (14ed:1012)"),
// and the synthetic default/communications entries get a prefix ("Default -
// MacBook Pro Microphone (Built-in)"). Comparing raw labels never matched a
// real Mac mic, so the strict visual preview silently never opened (0.9.101 to
// plan 080). Matching compares both sides with those decorations removed.

/** Transport suffixes Chromium appends on macOS (core_audio_util_mac.cc). */
const CHROMIUM_TRANSPORT_SUFFIX =
  / \((?:Built-in|Bluetooth|Bluetooth LE|USB|Virtual|Aggregate|AutoAggregate|PCI|FireWire|HDMI|DisplayPort|AirPlay|AVB|Thunderbolt)\)$/i
/** USB model suffix: a lowercase `vid:pid` pair. */
const CHROMIUM_USB_MODEL_SUFFIX = / \([0-9a-f]{4}:[0-9a-f]{4}\)$/i
/** Prefixes on the synthetic default/communications entries. */
const CHROMIUM_ROLE_PREFIX = /^(?:Default|Communications) - /i

function normalizeLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

/** A Chromium audio-input label with its role prefix and device suffix removed. */
export function chromiumAudioInputBaseLabel(label: string): string {
  return label
    .trim()
    .replace(CHROMIUM_ROLE_PREFIX, '')
    .replace(CHROMIUM_USB_MODEL_SUFFIX, '')
    .replace(CHROMIUM_TRANSPORT_SUFFIX, '')
    .trim()
}

export type AudioInputLike = { deviceId: string; label: string }

export type StrictAudioInputMatch =
  | { deviceId: string }
  | { failure: 'no-label-match' | 'ambiguous-label' | 'labels-hidden' | 'device-missing' }

/**
 * The one Chromium input that is the backend's `deviceName`, or why there is
 * none. Never guesses: two inputs with the same plain name are ambiguous, and
 * a name that only contains another ("Studio" vs "Studio Plus") is no match.
 * The synthetic `default`/`communications` entries are never chosen, since
 * they follow the OS default rather than the selected device.
 */
export function matchStrictAudioInput(
  deviceName: string | undefined,
  inputs: readonly AudioInputLike[]
): StrictAudioInputMatch {
  const devices = inputs.filter(
    (input) => input.deviceId !== 'default' && input.deviceId !== 'communications'
  )
  if (devices.length === 0) return { failure: 'device-missing' }
  if (devices.every((input) => input.label.trim() === '')) return { failure: 'labels-hidden' }
  const wanted = normalizeLabel(deviceName ?? '')
  if (!wanted) return { failure: 'no-label-match' }

  const exact = devices.filter((input) => normalizeLabel(input.label) === wanted)
  if (exact.length === 1) return { deviceId: exact[0].deviceId }
  if (exact.length > 1) return { failure: 'ambiguous-label' }

  const base = devices.filter(
    (input) => normalizeLabel(chromiumAudioInputBaseLabel(input.label)) === wanted
  )
  if (base.length === 1) return { deviceId: base[0].deviceId }
  return { failure: base.length > 1 ? 'ambiguous-label' : 'no-label-match' }
}
