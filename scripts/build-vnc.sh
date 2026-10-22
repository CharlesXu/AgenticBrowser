#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PKG_CONFIG_PATH="$PWD/.runtime/libvnc/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
if ! pkg-config --exists libvncserver libpng; then
  echo 'Missing LibVNCServer/libpng. Run bash scripts/prepare-vnc.sh, then retry this build.' >&2
  exit 1
fi
mkdir -p .runtime/bin
# The helper is a separate GPL-2.0-or-later executable, not a Chromium library.
cc -std=c11 -O2 -Wall -Wextra -Werror \
  $(pkg-config --cflags libvncserver libpng) src/vnc-server.c \
  $(pkg-config --libs libvncserver libpng) \
  -Wl,-rpath,"$(pkg-config --variable=libdir libvncserver)" -o .runtime/bin/agentic-vnc
if [[ "${1:-}" == "--probe" ]]; then
  cc -std=c11 -O2 -Wall -Wextra -Werror \
    $(pkg-config --cflags libvncclient libpng) scripts/vnc-probe.c \
    $(pkg-config --libs libvncclient libpng) \
    -Wl,-rpath,"$(pkg-config --variable=libdir libvncclient)" -o .runtime/bin/vnc-probe
fi
