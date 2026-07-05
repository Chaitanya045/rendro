#!/usr/bin/env bash
set -euo pipefail

# rendro — one-liner install
# curl -fsSL https://rendro.sh/install.sh | bash

REPO="Chaitanya045/rendro"
VERSION="${RENDRO_VERSION:-latest}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" && exit 1 ;;
esac

case "$OS" in
  linux)   TARGET="rendro-linux-${ARCH}" ;;
  darwin)  TARGET="rendro-darwin-${ARCH}" ;;
  *) echo "Unsupported OS: $OS" && exit 1 ;;
esac

URL="https://github.com/${REPO}/releases/${VERSION}/download/${TARGET}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading rendro ${VERSION} for ${OS}/${ARCH}..."
curl -fsSL "$URL" -o "$TMP/rendro"
chmod +x "$TMP/rendro"

INSTALL_DIR="${RENDRO_INSTALL_DIR:-/usr/local/bin}"
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP/rendro" "$INSTALL_DIR/rendro"
else
  sudo mv "$TMP/rendro" "$INSTALL_DIR/rendro"
fi

echo "rendro installed to $INSTALL_DIR/rendro"
echo "Run: rendro push --source ./docs --org my-org"
