#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION=$(node -p "require('./chromium/upstream.json').version")
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export PATH="$ROOT/.tools/depot_tools:$PATH"
export DEPOT_TOOLS_UPDATE=0
# Bound uv's connections; the default burst timed out on this host's network.
export UV_CONCURRENT_DOWNLOADS="${UV_CONCURRENT_DOWNLOADS:-4}"
export UV_HTTP_TIMEOUT="${UV_HTTP_TIMEOUT:-60}"
cd "$ROOT"
case "${1:-}" in
  sync)
    mkdir -p .tools .chromium
    if [ ! -d .tools/depot_tools/.git ]; then
      git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git .tools/depot_tools
    fi
    if [ ! -d .chromium/src/.git ]; then
      git clone --depth 1 --single-branch --branch "$VERSION" https://chromium.googlesource.com/chromium/src.git .chromium/src
    fi
    if [ "$(git -C .chromium/src describe --tags --exact-match HEAD)" != "$VERSION" ]; then
      echo 'Checkout does not match the pinned version; leaving it untouched.' >&2
      exit 1
    fi
    if ! git -C .chromium/src remote get-url upstream >/dev/null 2>&1; then
      git -C .chromium/src remote add upstream https://chromium.googlesource.com/chromium/src.git
    fi
    node --input-type=module <<'CONFIG'
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
const {repository,version}=JSON.parse(readFileSync('chromium/upstream.json','utf8'));
const config=`solutions = [{"name": "src", "url": "${repository}@${version}", "managed": False, "custom_deps": {}, "custom_vars": {"checkout_configuration": "small"}}]\n`;
if (!existsSync('.chromium/.gclient')) writeFileSync('.chromium/.gclient',config);
else if (!readFileSync('.chromium/.gclient','utf8').includes(`${repository}@${version}`))
  throw new Error('Existing .gclient uses another version; leaving it untouched.');
CONFIG
    cd .chromium
    gclient sync --no-history --shallow --jobs=8
    ;;
  build)
    # Xcode distributes Metal separately; fail before a long partial build.
    xcrun metal --version >/dev/null
    node scripts/apply-chromium-poc.mjs
    if [ ! -f .tools/depot_tools/python3_bin_reldir.txt ]; then
      source .tools/depot_tools/bootstrap_python3
      bootstrap_python3
    fi
    cd .chromium/src
    if [ ! -f out/AgenticPoC/args.gn ]; then
      mkdir -p out/AgenticPoC
      cat > out/AgenticPoC/args.gn <<'ARGS'
target_cpu = "arm64"
is_debug = false
is_component_build = true
symbol_level = 0
blink_symbol_level = 0
v8_symbol_level = 0
use_remoteexec = false
ARGS
    fi
    gn gen out/AgenticPoC
    # Compile our only native module first so API errors surface before linking.
    autoninja -C out/AgenticPoC -j 18 obj/chrome/browser/core/agentic_poc.o
    autoninja -C out/AgenticPoC -j 18 chrome
    ;;
  *) echo 'Usage: bash scripts/chromium.sh sync|build' >&2; exit 2 ;;
esac
