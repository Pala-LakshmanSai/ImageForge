#!/bin/sh

# Source this file before local development to keep large caches off the Mac's
# internal drive: `. ./scripts/use-usb-toolchain.sh`.
IMAGEFORGE_ROOT=/Volumes/ESD-USB/ImageForge
export IMAGEFORGE_ROOT
export RUSTUP_HOME="$IMAGEFORGE_ROOT/.toolchains/rustup"
export CARGO_HOME="$IMAGEFORGE_ROOT/.toolchains/cargo"
IMAGEFORGE_BUILD_CACHE="$IMAGEFORGE_ROOT/.cache"
if [ "$(uname -s)" = "Darwin" ]; then
  IMAGEFORGE_CACHE_IMAGE=/Volumes/ESD-USB/ImageForge-build-cache.sparsebundle
  IMAGEFORGE_CACHE_VOLUME=/Volumes/ImageForgeBuild
  if [ -d "$IMAGEFORGE_CACHE_IMAGE" ] && ! /sbin/mount | grep -Fq "on $IMAGEFORGE_CACHE_VOLUME "; then
    hdiutil attach -nobrowse "$IMAGEFORGE_CACHE_IMAGE" >/dev/null
  fi
  if [ -d "$IMAGEFORGE_CACHE_VOLUME" ]; then
    IMAGEFORGE_BUILD_CACHE="$IMAGEFORGE_CACHE_VOLUME"
  fi
fi
export IMAGEFORGE_BUILD_CACHE
export CARGO_TARGET_DIR="$IMAGEFORGE_BUILD_CACHE/cargo-target"
export npm_config_cache="$IMAGEFORGE_BUILD_CACHE/npm"
export PIP_CACHE_DIR="$IMAGEFORGE_BUILD_CACHE/pip"
export TMPDIR="$IMAGEFORGE_BUILD_CACHE/tmp"
export PATH="$CARGO_HOME/bin:$PATH"
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

mkdir -p "$CARGO_TARGET_DIR" "$npm_config_cache" "$PIP_CACHE_DIR" "$TMPDIR"
