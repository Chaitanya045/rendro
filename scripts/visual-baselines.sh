#!/usr/bin/env bash
# Visual baselines (#120) render in ONE pinned Linux environment: the official Playwright image,
# pinned by digest, at the repo's Playwright version. The Worker, Convex backend and the Playwright
# client keep running on the host; only the browser runs in the container (`run-server`, host
# network, so the container reaches the loopback Worker), so every screenshot is rasterised with the
# same Chromium build, system libraries and fonts on a laptop and on a CI runner.
#
#   scripts/visual-baselines.sh check    compare against the committed baselines (`pnpm visual`)
#   scripts/visual-baselines.sh update   rewrite baselines that changed or are new (`pnpm visual:update`)
#
# Extra arguments go to `playwright test` (for example `-g "projects — list"`).
set -euo pipefail

mode="${1:-check}"
[ "$#" -gt 0 ] && shift
case "$mode" in
  check) update=() ;;
  update) update=(--update-snapshots=changed) ;;
  *) echo "usage: $0 [check|update] [playwright test args]" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Bump this digest together with the `@playwright/test` version in package.json (the image tag
# below must carry the same version); `docker buildx imagetools inspect` prints a tag's digest.
image="mcr.microsoft.com/playwright@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f" # v1.64.0-noble, linux/amd64
expected="1.64.0"

installed="$(node -p "require('@playwright/test/package.json').version")"
if [ "$installed" != "$expected" ]; then
  echo "Playwright is $installed but the pinned image is v$expected: update the digest in scripts/visual-baselines.sh" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required: baselines must be rendered in the pinned Playwright container" >&2
  exit 1
fi

port="$(node -e "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
name="rendro-visual-$$"
container=""
cleanup() {
  # Remove exactly the container this run started.
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

container="$(docker run -d --rm --init --ipc=host --network host --name "$name" \
  -v "$root:/work:ro" -w /work "$image" \
  node node_modules/@playwright/test/cli.js run-server --host 127.0.0.1 --port "$port")"

for _ in $(seq 1 60); do
  if docker logs "$container" 2>&1 | grep -q "Listening on"; then break; fi
  sleep 1
done
if ! docker logs "$container" 2>&1 | grep -q "Listening on"; then
  docker logs "$container" >&2 || true
  echo "The Playwright container did not start listening" >&2
  exit 1
fi

# A baseline is only meaningful from the pinned browser: the config and the spec both refuse to run without it.
RENDRO_VISUAL_WS="ws://127.0.0.1:$port/" RENDRO_E2E_VISUAL=1 \
  pnpm exec playwright test --config e2e/visual.config.ts --project=visual-chromium "${update[@]}" "$@"
