#!/bin/sh
# Wraps the release binary in "spike-desktop.app" so macOS can deliver
# videorc-spike:// links to it and post its notifications (both need a
# bundle). Registers the bundle with LaunchServices; `--unregister` removes it.
#
#   cargo build --release -p spike-desktop
#   ./spike-desktop/bundle-macos.sh            # prints the .app path
#   open 'videorc-spike://hello'               # cold start from a link
#   ./spike-desktop/bundle-macos.sh --unregister
#
# It uses its own scheme and bundle id (never videorc:// or Videorc's id), so
# it cannot catch links meant for the installed app.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
target=${CARGO_TARGET_DIR:-$here/target}
bin=$target/release/spike-desktop
app=$target/release/spike-desktop.app
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if [ "${1:-}" = "--unregister" ]; then
  [ -d "$app" ] && "$lsregister" -u "$app" && echo "unregistered $app"
  exit 0
fi
[ -x "$bin" ] || { echo "build first: cargo build --release -p spike-desktop" >&2; exit 1; }

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/spike-desktop"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.videorc.spike-desktop</string>
  <key>CFBundleName</key><string>spike-desktop</string>
  <key>CFBundleExecutable</key><string>spike-desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.videorc.spike-desktop</string>
      <key>CFBundleURLSchemes</key><array><string>videorc-spike</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
codesign --force --sign - "$app" >/dev/null 2>&1
"$lsregister" -f "$app"
echo "$app"
