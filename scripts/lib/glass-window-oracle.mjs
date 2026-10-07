import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// CGWindow supplies front-to-back order without capturing arbitrary desktop
// contents. Owner names exist only while assigning these bounded categories;
// titles are never read or returned.
const source = `
import CoreGraphics
import Foundation

func number(_ value: Any?) -> Double {
  return (value as? NSNumber)?.doubleValue ?? -1
}

let cursorWindowLevel = Int(CGWindowLevelForKey(.cursorWindow))

func category(_ value: Any?, layer: Int) -> String {
  let owner = (value as? String ?? "").lowercased()
  // screencapture -R excludes the pointer unless -C is requested. Keep every
  // other Window Server surface and every foreign window at the cursor level.
  if owner == "window server" && layer == cursorWindowLevel { return "system-cursor" }
  if owner == "electron" || owner == "videorc" { return "target-app" }
  if ["securityagent", "coreservicesuiagent", "usernotificationcenter", "authorizationhost", "loginwindow"].contains(owner) { return "system-dialog" }
  return "other-app"
}

guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { exit(1) }
let windows = list.enumerated().map { order, window -> [String: Any] in
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let layer = Int(number(window[kCGWindowLayer as String]))
  return [
    "order": order,
    "id": Int(number(window[kCGWindowNumber as String])),
    "pid": Int(number(window[kCGWindowOwnerPID as String])),
    "ownerCategory": category(window[kCGWindowOwnerName as String], layer: layer),
    "layer": layer,
    "alpha": number(window[kCGWindowAlpha as String]),
    "x": number(bounds["X"]), "y": number(bounds["Y"]),
    "width": number(bounds["Width"]), "height": number(bounds["Height"])
  ]
}
let payload: [String: Any] = ["observedAt": Int(Date().timeIntervalSince1970 * 1000), "cursorWindowLevel": cursorWindowLevel, "windows": windows]
let data = try JSONSerialization.data(withJSONObject: payload)
FileHandle.standardOutput.write(data)
`

/** Compile once, then make bounded one-shot reads; no persistent oracle child. */
export function createGlassWindowReader(directory, { execute = execFileSync } = {}) {
  const sourcePath = join(directory, 'glass-window-oracle.swift')
  const binaryPath = join(directory, 'glass-window-oracle')
  writeFileSync(sourcePath, source)
  execute('swiftc', [sourcePath, '-o', binaryPath], {
    timeout: 30_000,
    stdio: ['ignore', 'ignore', 'ignore']
  })
  return () => {
    try {
      const payload = JSON.parse(
        execute(binaryPath, [], {
          timeout: 2_000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        })
      )
      if (!Array.isArray(payload.windows)) throw new Error()
      return {
        observedAt: payload.observedAt,
        windows: payload.windows
          .filter(
            ({ ownerCategory, layer }) =>
              ownerCategory !== 'system-cursor' ||
              !Number.isSafeInteger(payload.cursorWindowLevel) ||
              layer !== payload.cursorWindowLevel
          )
          .map(({ id, pid, order, layer, alpha, x, y, width, height, ownerCategory }) => ({
            id,
            pid,
            order,
            layer,
            alpha,
            x,
            y,
            width,
            height,
            ownerCategory
          }))
      }
    } catch {
      throw new Error('Window metadata unavailable.')
    }
  }
}
