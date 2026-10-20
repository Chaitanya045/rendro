#!/usr/bin/env bash
# Visual baselines (#120) render in ONE pinned Linux environment: the official Playwright image,
# pinned by digest, at the repo's Playwright version. The Worker, Convex backend and the Playwright
# client keep running on the host; only the browser runs in the container (a launched browser server, host
# network, so the container reaches the loopback Worker), so every screenshot is rasterised with the
# same Chromium build, system libraries and fonts on a laptop and on a CI runner.
#
#   scripts/visual-baselines.sh check    compare against the committed baselines (`pnpm visual`)
#   scripts/visual-baselines.sh update   rewrite baselines that changed or are new (`pnpm visual:update`)
#   scripts/visual-baselines.sh repeat   render every cell into a scratch directory, then twice more against it: the
#                                        determinism check the zero threshold relies on (#276)
#
# Extra arguments go to `playwright test` (for example `-g "projects — list"`).
# RENDRO_VISUAL_CPUS=0.5 limits the browser container's CPU (docker --cpus), to prove a cell waits on state, not time.
set -euo pipefail

mode="${1:-check}"
[ "$#" -gt 0 ] && shift
case "$mode" in
  check) update=() ;;
  update) update=(--update-snapshots=changed) ;;
  repeat) update=() ;;
  *) echo "usage: $0 [check|update|repeat] [playwright test args]" >&2; exit 2 ;;
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
scratch=""
cleanup() {
  # Remove exactly the container (and scratch directory) this run started.
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  if [ -n "$scratch" ]; then rm -rf "$scratch"; fi
}
trap cleanup EXIT INT TERM

# The browser's flags are fixed here, on the server side, so no client can change how a baseline is rasterised.
# --disable-partial-raster (#276): Chromium otherwise re-rasterises only the invalidated part of a tile and keeps the
# rest from an earlier raster, and the two can round an antialiased edge or a translucent fill one level apart. Which
# regions get a partial raster depends on paint timing, so the same cell differed by up to 0.04 (YIQ) between runs.
cpus=()
[ -n "${RENDRO_VISUAL_CPUS:-}" ] && cpus=(--cpus "$RENDRO_VISUAL_CPUS")
container="$(docker run -d --rm --init --ipc=host --network host --name "$name" "${cpus[@]}" \
  -e RENDRO_VISUAL_PORT="$port" -v "$root:/work:ro" -w /work "$image" \
  node -e 'require("@playwright/test").chromium.launchServer({ host: "127.0.0.1", port: Number(process.env.RENDRO_VISUAL_PORT), wsPath: "/", args: ["--disable-partial-raster"] }).then(server => console.log(`Listening on ${server.wsEndpoint()}`), error => { console.error(error); process.exit(1); })')"

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
visual() {
  RENDRO_VISUAL_WS="ws://127.0.0.1:$port/" RENDRO_E2E_VISUAL=1 \
    pnpm exec playwright test --config e2e/visual.config.ts --project=visual-chromium "$@"
}
if [ "$mode" = repeat ]; then
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/rendro-visual-repeat.XXXXXX")"
  export RENDRO_VISUAL_SNAPSHOTS="$scratch"
  visual --update-snapshots=all "$@"
  for run in 2 3; do
    echo "Run $run of 3: every cell must match the first run pixel for pixel"
    visual "$@"
  done
  exit 0
fi
visual "${update[@]}" "$@"
