#!/usr/bin/env bash
# Mac PoC only: official LibVNC source, installed inside this project.
set -euo pipefail
cd "$(dirname "$0")/.."
export PKG_CONFIG_PATH="$PWD/.runtime/libvnc/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
if pkg-config --exists libvncserver libvncclient libpng; then
  echo 'VNC build dependencies are already available.'
  exit 0
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This preparation script is for the current Mac PoC only.' >&2
  exit 1
fi
if ! command -v cmake >/dev/null || ! pkg-config --exists libpng libjpeg openssl; then
  echo 'Install the build prerequisites first: brew install cmake pkgconf libpng jpeg-turbo openssl' >&2
  exit 1
fi
version=0.9.15
archive="$PWD/.runtime/libvnc-source/libvncserver-$version.tar.gz"
source_dir="$PWD/.runtime/libvnc-source/libvncserver-LibVNCServer-$version"
build_dir="$PWD/.runtime/libvnc-source/build"
prefix="$PWD/.runtime/libvnc"
mkdir -p "$(dirname "$archive")"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --connect-timeout 20 --max-time 180 \
    "https://github.com/LibVNC/libvncserver/archive/refs/tags/LibVNCServer-$version.tar.gz" -o "$archive.part"
  mv "$archive.part" "$archive"
fi
expected=62352c7795e231dfce044beb96156065a05a05c974e5de9e023d688d8ff675d7
actual="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
if [[ "$actual" != "$expected" ]]; then
  echo 'LibVNC source checksum mismatch; refusing to build.' >&2
  exit 1
fi
if [[ ! -d "$source_dir" ]]; then
  tar -xzf "$archive" -C "$(dirname "$archive")"
fi
cmake -S "$source_dir" -B "$build_dir" \
  -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DWITH_EXAMPLES=OFF -DWITH_TESTS=OFF -DWITH_FFMPEG=OFF -DWITH_SDL=OFF \
  -DWITH_GTK=OFF -DWITH_QT=OFF -DWITH_XCB=OFF -DWITH_LIBSSHTUNNEL=OFF \
  -DWITH_GNUTLS=OFF -DWITH_GCRYPT=OFF -DWITH_SASL=OFF -DWITH_SYSTEMD=OFF \
  -DWITH_TIGHTVNC_FILETRANSFER=OFF -DWITH_OPENSSL=ON \
  -DOPENSSL_ROOT_DIR="$(pkg-config --variable=prefix openssl)"
cmake --build "$build_dir" --target vncserver vncclient -j 8
cmake --install "$build_dir"
echo 'Prepared local VNC libraries. Next: bash scripts/build-vnc.sh'
