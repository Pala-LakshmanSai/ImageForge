#!/bin/sh

# Source this file before local development to keep large caches off the Mac's
# internal drive: `. ./scripts/use-usb-toolchain.sh`.
IMAGEFORGE_ROOT=/Volumes/ESD-USB/ImageForge
export IMAGEFORGE_ROOT
export RUSTUP_HOME="$IMAGEFORGE_ROOT/.toolchains/rustup"
export CARGO_HOME="$IMAGEFORGE_ROOT/.toolchains/cargo"
export CARGO_TARGET_DIR="$IMAGEFORGE_ROOT/.cache/cargo-target"
export npm_config_cache="$IMAGEFORGE_ROOT/.cache/npm"
export PIP_CACHE_DIR="$IMAGEFORGE_ROOT/.cache/pip"
export TMPDIR="$IMAGEFORGE_ROOT/.tmp"
export PATH="$CARGO_HOME/bin:$PATH"

mkdir -p "$CARGO_TARGET_DIR" "$npm_config_cache" "$PIP_CACHE_DIR" "$TMPDIR"
