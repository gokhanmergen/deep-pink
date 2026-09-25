#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The native Quick Question launcher is Linux-only."
  exit 0
fi

if ! command -v pkg-config >/dev/null || ! pkg-config --exists gtk+-3.0; then
  echo "Building the native launcher requires GTK 3 development files (gtk+-3.0)." >&2
  exit 1
fi

mkdir -p build/native
cc -O2 -Wall -Wextra \
  $(pkg-config --cflags gtk+-3.0) \
  native/quick-question.c \
  -o build/native/deep-pink-quick \
  $(pkg-config --libs gtk+-3.0)
chmod 0755 build/native/deep-pink-quick
