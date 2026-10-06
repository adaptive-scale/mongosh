#!/bin/sh
# mongo-sh installer: downloads the release binary for this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/adaptive-scale/mongo-sh/master/install.sh | sh
#
# Options (environment variables):
#   MONGO_SH_VERSION      release tag to install, e.g. v2.0.0   (default: latest)
#   MONGO_SH_INSTALL_DIR  where to put the binary               (default: /usr/local/bin if
#                         writable, otherwise ~/.local/bin)
#   MONGO_SH_REPO         GitHub repository to download from    (default: adaptive-scale/mongo-sh)
#   MONGO_SH_BASE_URL     download the archives from this URL instead of GitHub releases
#                         (a mirror, or a directory served on an internal network)
#
# Pass options through the pipe like this:
#   curl -fsSL .../install.sh | MONGO_SH_VERSION=v2.0.0 sh
set -eu

REPO="${MONGO_SH_REPO:-adaptive-scale/mongo-sh}"
VERSION="${MONGO_SH_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN*) os=windows ;;
    *) fail "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
    x86_64 | amd64)  arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
esac

if [ "$os" = windows ]; then
    archive="mongo-sh-${os}-${arch}.zip"
    binary="mongo-sh.exe"
else
    archive="mongo-sh-${os}-${arch}.tar.gz"
    binary="mongo-sh"
fi

if [ -n "${MONGO_SH_BASE_URL:-}" ]; then
    base="${MONGO_SH_BASE_URL%/}"
elif [ "$VERSION" = latest ]; then
    base="https://github.com/${REPO}/releases/latest/download"
else
    base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

if command -v curl > /dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget > /dev/null 2>&1; then
    fetch() { wget -q "$1" -O "$2"; }
else
    fail "curl or wget is required"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading ${archive} (${VERSION}) from ${base}..."
fetch "${base}/${archive}" "${tmp}/${archive}" \
    || fail "could not download ${base}/${archive}"

# Check the download against the checksums published with the release.
if fetch "${base}/checksums.txt" "${tmp}/checksums.txt" 2> /dev/null; then
    expected="$(grep " ${archive}\$" "${tmp}/checksums.txt" | awk '{print $1}')"
    if command -v sha256sum > /dev/null 2>&1; then
        actual="$(sha256sum "${tmp}/${archive}" | awk '{print $1}')"
    elif command -v shasum > /dev/null 2>&1; then
        actual="$(shasum -a 256 "${tmp}/${archive}" | awk '{print $1}')"
    else
        actual=""
    fi
    if [ -n "$expected" ] && [ -n "$actual" ]; then
        [ "$expected" = "$actual" ] || fail "checksum mismatch for ${archive}"
        say "Checksum verified."
    else
        say "Skipping checksum verification (no sha256 tool or no entry for ${archive})."
    fi
else
    say "Skipping checksum verification (the release has no checksums.txt)."
fi

if [ "$os" = windows ]; then
    command -v unzip > /dev/null 2>&1 || fail "unzip is required to extract ${archive}"
    unzip -q "${tmp}/${archive}" -d "${tmp}/out"
else
    mkdir -p "${tmp}/out"
    tar -xzf "${tmp}/${archive}" -C "${tmp}/out"
fi
[ -f "${tmp}/out/${binary}" ] || fail "${archive} does not contain ${binary}"

if [ -n "${MONGO_SH_INSTALL_DIR:-}" ]; then
    dir="$MONGO_SH_INSTALL_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    dir=/usr/local/bin
else
    dir="${HOME}/.local/bin"
fi
mkdir -p "$dir" || fail "cannot create ${dir}"
[ -w "$dir" ] || fail "${dir} is not writable; set MONGO_SH_INSTALL_DIR or re-run with sudo"

cp "${tmp}/out/${binary}" "${dir}/${binary}"
chmod +x "${dir}/${binary}"

say "Installed $("${dir}/${binary}" --version 2> /dev/null | sed 's/^/mongo-sh /' || echo mongo-sh) to ${dir}/${binary}"
case ":${PATH}:" in
    *":${dir}:"*) ;;
    *) say "Note: ${dir} is not on your PATH. Add it with:  export PATH=\"${dir}:\$PATH\"" ;;
esac
say "Run 'mongo-sh --help' to get started."
