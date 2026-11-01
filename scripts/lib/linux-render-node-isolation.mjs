import { readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

// Scope device visibility to this command and its descendants. VAAPI's pin
// alone does not constrain Chromium, Mesa, or Vulkan device selection.
export function linuxRenderNodeInvocation({
  command,
  args = [],
  env = process.env,
  platform = process.platform,
  realpath = realpathSync,
  readDirectory = readdirSync,
  stat = statSync
}) {
  if (platform !== 'linux') throw new Error('Render-node isolation requires Linux.')
  if (typeof command !== 'string' || !command.trim())
    throw new Error('Provide a command to run inside render-node isolation.')
  const node = env.VIDEORC_LINUX_VAAPI_DEVICE
  if (typeof node !== 'string' || !/^\/dev\/dri\/renderD\d+$/.test(node))
    throw new Error(
      'Set VIDEORC_LINUX_VAAPI_DEVICE to an explicitly permitted /dev/dri/renderD node.'
    )
  if (realpath(node) !== node || !stat(node).isCharacterDevice())
    throw new Error('The permitted render node must be a character device, not an alias.')
  const device = realpath(`/sys/class/drm/${basename(node)}/device`)
  const pci = basename(device)
  if (!/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(pci))
    throw new Error('Render-node isolation requires an identifiable PCI GPU.')
  const cards = readDirectory(join(device, 'drm')).filter((name) => /^card\d+$/.test(name))
  if (cards.length !== 1)
    throw new Error('The permitted render node must have exactly one matching DRM card.')
  const card = `/dev/dri/${cards[0]}`
  if (realpath(card) !== card || !stat(card).isCharacterDevice())
    throw new Error('The matching DRM card must be a character device, not an alias.')
  return {
    command: '/usr/bin/bwrap',
    args: [
      '--die-with-parent',
      '--bind',
      '/',
      '/',
      '--dev-bind',
      '/dev',
      '/dev',
      '--tmpfs',
      '/dev/dri',
      '--dev-bind',
      node,
      node,
      '--dev-bind',
      card,
      card,
      '--',
      command,
      ...args
    ],
    env: { ...env, LIBVA_DEVICE: node, DRI_PRIME: `pci-${pci.replace(/[:.]/g, '_')}` },
    renderNode: node,
    cardNode: card
  }
}
