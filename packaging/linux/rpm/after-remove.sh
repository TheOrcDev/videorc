#!/bin/sh
# Videorc rpm post-uninstall (%postun).
#
# On a real uninstall rpm has already deleted the /opt/Videorc payload, so we
# remove the system metainfo copy. On an UPGRADE the new package's %post runs
# before the old package's %postun; the new payload is already in place then,
# so skip deleting the metainfo it (re)installed.
#
# Runs as root from rpm %postun. Keep POSIX-sh compatible.
set -eu

SYSTEM_METAINFO="/usr/share/metainfo/dev.theorcdev.videorc.metainfo.xml"
APP_METAINFO="/opt/Videorc/resources/metainfo/dev.theorcdev.videorc.metainfo.xml"

if [ ! -f "$APP_METAINFO" ]; then
  rm -f "$SYSTEM_METAINFO"
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0