#!/bin/sh
# Videorc deb post-install. electron-builder (fpm) installs the app payload
# under /opt/Videorc; the AppStream metainfo rides in the payload at
# resources/metainfo/. Copy it to the system metainfo directory and refresh
# the icon/desktop caches so software centers, search and launchers pick up
# the freshly installed app.
#
# Runs as root from dpkg's postinst. Keep POSIX-sh compatible.
set -eu

APP_METAINFO="/opt/Videorc/resources/metainfo/dev.theorcdev.videorc.metainfo.xml"
SYSTEM_METAINFO="/usr/share/metainfo/dev.theorcdev.videorc.metainfo.xml"

if [ -f "$APP_METAINFO" ]; then
  install -Dm644 "$APP_METAINFO" "$SYSTEM_METAINFO"
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0