#!/bin/sh
set -eu

REPO="axiomlayer/pyr"
INSTALL_DIR="${PYR_HOME:-$HOME/.pyr}/bin"
PYTHON_DIR="${PYR_HOME:-$HOME/.pyr}/python/bin"

main() {
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)

  case "$os" in
    darwin) ;;
    linux) ;;
    mingw*|msys*|cygwin*)
      echo "Git Bash/Cygwin is a Windows environment; run install.ps1 from PowerShell"
      exit 1
      ;;
    *) echo "unsupported os: $os"; exit 1 ;;
  esac

  command -v unzip >/dev/null 2>&1 || { echo "unzip is required"; exit 1; }

  case "$arch" in
    x86_64|amd64) arch="x86_64" ;;
    arm64|aarch64) arch="aarch64" ;;
    *) echo "unsupported arch: $arch"; exit 1 ;;
  esac

  target="${os}-${arch}"
  asset_name="pyr-${target}.zip"

  # Resolve one immutable release tag before fetching either the checksum
  # manifest or the archive. Fetching two independent `latest` URLs would
  # allow a release rollover between the requests.
  release_json=$(curl --proto '=https' --tlsv1.2 -fsSL \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO}/releases/latest")
  tag=$(printf '%s\n' "$release_json" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1)
  case "$tag" in
    v[0-9A-Za-z._-]*) ;;
    *) echo "invalid latest release tag"; exit 1 ;;
  esac

  base_url="https://github.com/${REPO}/releases/download/${tag}"
  url="${base_url}/${asset_name}"

  echo "installing pyr..."

  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT

  curl --proto '=https' --tlsv1.2 -fsSL \
    "${base_url}/SHA256SUMS" -o "$tmpdir/SHA256SUMS"
  expected=$(awk -v name="$asset_name" \
    '$2 == name || $2 == "*" name { print $1; exit }' "$tmpdir/SHA256SUMS")
  if [ -z "$expected" ] || ! printf '%s\n' "$expected" | grep -Eq '^[0-9A-Fa-f]{64}$'; then
    echo "SHA256SUMS has no valid entry for ${asset_name}"
    exit 1
  fi

  curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$tmpdir/$asset_name"
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmpdir/$asset_name" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmpdir/$asset_name" | awk '{print $1}')
  else
    echo "sha256sum or shasum is required"
    exit 1
  fi
  expected=$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')
  if [ "$actual" != "$expected" ]; then
    echo "SHA-256 mismatch for ${asset_name}"
    exit 1
  fi

  mv "$tmpdir/$asset_name" "$tmpdir/pyr.zip"
  unzip -qo "$tmpdir/pyr.zip" -d "$tmpdir"

  mkdir -p "$INSTALL_DIR"
  mv "$tmpdir/pyr" "$INSTALL_DIR/pyr"
  chmod +x "$INSTALL_DIR/pyr"

  echo "installed to ${INSTALL_DIR}/pyr"

  # check PATH
  case ":$PATH:" in
    *":${INSTALL_DIR}:"*":${PYTHON_DIR}:"*) ;;
    *":${PYTHON_DIR}:"*":${INSTALL_DIR}:"*) ;;
    *)
      echo ""
      echo "add to your shell profile:"
      echo "  export PATH=\"${INSTALL_DIR}:${PYTHON_DIR}:\$PATH\""
      ;;
  esac
}

main
