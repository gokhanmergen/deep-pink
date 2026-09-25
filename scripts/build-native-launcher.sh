#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The native Quick Question launcher is Linux-only."
  exit 0
fi

if ! command -v pkg-config >/dev/null || ! pkg-config --exists gtk+-3.0 gtk-layer-shell-0; then
  echo "Building the native launcher requires GTK 3 and GTK Layer Shell development files." >&2
  exit 1
fi

mkdir -p build/native
cc -O2 -Wall -Wextra \
  $(pkg-config --cflags gtk+-3.0 gtk-layer-shell-0) \
  native/launcher.c \
  -o build/native/deep-pink-launcher \
  $(pkg-config --libs gtk+-3.0 gtk-layer-shell-0)
chmod 0755 build/native/deep-pink-launcher
