#!/bin/bash
# Cross-compile mongo-sh and package one archive per platform into dist/.
#
# Runs inside the image built from Dockerfile.build (see `make release`).
#
# Usage: build-release.sh [os/arch ...]
#   With no arguments every supported platform is built:
#   linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64
#
# Archives are named mongo-sh-<os>-<arch>.tar.gz (.zip on Windows) so the
# "latest release" download URL is the same for every version, which is what
# install.sh relies on.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${DIST_DIR:-${SRC_DIR}/dist}"
ALL_PLATFORMS=(linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64)

# Rust target for each platform. Linux binaries are static (musl) so they run
# on any distribution.
rust_target() {
    case "$1" in
        linux/amd64)   echo x86_64-unknown-linux-musl ;;
        linux/arm64)   echo aarch64-unknown-linux-musl ;;
        darwin/amd64)  echo x86_64-apple-darwin ;;
        darwin/arm64)  echo aarch64-apple-darwin ;;
        windows/amd64) echo x86_64-pc-windows-gnu ;;
        windows/arm64) echo aarch64-pc-windows-gnullvm ;;
        *) echo "unsupported platform: $1" >&2; return 1 ;;
    esac
}

platforms=("$@")
if [ ${#platforms[@]} -eq 0 ]; then platforms=("${ALL_PLATFORMS[@]}"); fi

# windows/arm64 is the one target whose QuickJS bindings are generated at
# build time. libclang does not know Rust's "gnullvm" environment name, so
# it is pointed at the equivalent MinGW triple. cargo-zigbuild adds the
# include paths of zig's bundled headers to whichever of these it finds.
WINDOWS_ARM64_CLANG_TARGET="--target=aarch64-pc-windows-gnu"

cd "$SRC_DIR"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
mkdir -p "$DIST_DIR"
built=()
failed=()

for platform in "${platforms[@]}"; do
    target="$(rust_target "$platform")"
    os="${platform%/*}"; arch="${platform#*/}"
    name="mongo-sh-${os}-${arch}"
    exe="mongo-sh"; [ "$os" = windows ] && exe="mongo-sh.exe"

    extra_env=()
    if [ "$platform" = windows/arm64 ]; then
        extra_env=(
            "BINDGEN_EXTRA_CLANG_ARGS=${WINDOWS_ARM64_CLANG_TARGET}"
            "BINDGEN_EXTRA_CLANG_ARGS_${target}=${WINDOWS_ARM64_CLANG_TARGET}"
            "BINDGEN_EXTRA_CLANG_ARGS_${target//-/_}=${WINDOWS_ARM64_CLANG_TARGET}"
        )
    fi

    echo "==> ${platform} (${target})"
    if ! env "${extra_env[@]}" cargo zigbuild --release --locked --target "$target"; then
        echo "!!! build failed for ${platform}" >&2
        failed+=("$platform")
        continue
    fi

    stage="$(mktemp -d)"
    cp "${CARGO_TARGET_DIR:-target}/${target}/release/${exe}" "$stage/"
    cp LICENSE Readme.md "$stage/"
    rm -f "${DIST_DIR}/${name}.tar.gz" "${DIST_DIR}/${name}.zip"
    if [ "$os" = windows ]; then
        (cd "$stage" && zip -q "${DIST_DIR}/${name}.zip" "$exe" LICENSE Readme.md)
        built+=("${name}.zip")
    else
        tar -czf "${DIST_DIR}/${name}.tar.gz" -C "$stage" "$exe" LICENSE Readme.md
        built+=("${name}.tar.gz")
    fi
    rm -rf "$stage"
done

if [ ${#built[@]} -gt 0 ]; then
    # Checksums cover every archive present, including ones from earlier runs.
    (cd "$DIST_DIR" && sha256sum mongo-sh-*.tar.gz mongo-sh-*.zip 2>/dev/null > checksums.txt || true)
    echo ""
    echo "mongo-sh ${version}: built ${#built[@]} archive(s) in ${DIST_DIR}"
    (cd "$DIST_DIR" && ls -lh "${built[@]}")
fi
if [ ${#failed[@]} -gt 0 ]; then
    echo "failed: ${failed[*]}" >&2
    exit 1
fi
