#!/usr/bin/env bash
# Build the minimal FFmpeg sidecar that ships with Polarity Transcribe.
#
#   scripts/build-ffmpeg.sh [rust-target-triple]
#
# Produces src-tauri/binaries/ffmpeg-<triple>[.exe]: a static, audio-only, LGPL-only FFmpeg
# that can decode the common interview-recorder formats, resample/remix through libavfilter
# and write PCM/WAV/AAC. Nothing GPL, nonfree or network-related is compiled in.
#
# Supported build hosts:
#   - macOS (Apple clang). Targets aarch64-apple-darwin and x86_64-apple-darwin.
#   - Windows under MSYS2 MINGW64 or UCRT64 (gcc). Target x86_64-pc-windows-msvc (or -gnu).
#     The result is fully static (no libgcc/libwinpthread DLLs), so it runs next to an
#     MSVC-built app. Required packages: make, diffutils, tar, curl, and the matching
#     mingw-w64-*-gcc and mingw-w64-*-nasm.
#
# The script is idempotent: if the output exists and was produced by the same FFmpeg version and
# the same version of this script, it exits immediately. CI caches src-tauri/binaries keyed on the
# hash of this file, so any change here triggers a rebuild.
#
# Environment overrides:
#   FFMPEG_SHA256   expected SHA-256 of the source tarball (overrides the pinned value)
#   BUILD_ROOT      scratch directory (default: target/ffmpeg-build)
#   JOBS            parallel make jobs (default: number of CPUs)

set -euo pipefail

FFMPEG_VERSION="7.1.5"
# SHA-256 of ffmpeg-${FFMPEG_VERSION}.tar.xz from https://ffmpeg.org/releases/, pinned after
# checking the tarball's .asc signature against FFmpeg's release signing key
# (FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8). When updating the version, verify the new
# tarball the same way (gpg --verify ffmpeg-X.tar.xz.asc ffmpeg-X.tar.xz) before pinning its hash.
FFMPEG_SHA256_PINNED="de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f"
FFMPEG_SHA256="${FFMPEG_SHA256:-$FFMPEG_SHA256_PINNED}"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"

# LAME (LGPL) for MP3 export of quote fragments. SHA-256 of lame-3.100.tar.gz as published by
# the LAME project on SourceForge (the same value Homebrew and the major distributions pin).
LAME_VERSION="3.100"
LAME_SHA256="${LAME_SHA256:-ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e}"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/src-tauri/binaries"
BUILD_ROOT="${BUILD_ROOT:-$REPO_ROOT/target/ffmpeg-build}"

log() { printf '[build-ffmpeg] %s\n' "$*" >&2; }
die() { printf '[build-ffmpeg] error: %s\n' "$*" >&2; exit 1; }

ncpu() {
  if command -v nproc >/dev/null 2>&1; then nproc
  elif command -v sysctl >/dev/null 2>&1; then sysctl -n hw.ncpu
  else echo 2; fi
}
JOBS="${JOBS:-$(ncpu)}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# ---------------------------------------------------------------------------------------------
# Target triple
# ---------------------------------------------------------------------------------------------
host_triple() {
  if command -v rustc >/dev/null 2>&1; then
    rustc -vV | sed -n 's/^host: //p'
    return
  fi
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)                    echo aarch64-apple-darwin ;;
    Darwin-x86_64)                   echo x86_64-apple-darwin ;;
    MINGW64*-x86_64|MSYS*-x86_64|UCRT64*-x86_64) echo x86_64-pc-windows-msvc ;;
    *) die "cannot determine host target triple; pass it as the first argument" ;;
  esac
}

TRIPLE="${1:-$(host_triple)}"

case "$TRIPLE" in
  *-windows-*)
    EXE_SUFFIX=".exe"
    [ -n "${MSYSTEM:-}" ] || die "Windows builds must run inside an MSYS2 MINGW64/UCRT64 shell"
    case "$MSYSTEM" in MINGW64|UCRT64) ;; *) die "unsupported MSYSTEM '$MSYSTEM' (use MINGW64 or UCRT64)" ;; esac
    ;;
  *-apple-darwin)
    EXE_SUFFIX=""
    [ "$(uname -s)" = "Darwin" ] || die "macOS targets must be built on macOS"
    ;;
  *) die "unsupported target triple '$TRIPLE' (Windows x64 and macOS only)" ;;
esac

OUT="$OUT_DIR/ffmpeg-${TRIPLE}${EXE_SUFFIX}"
STAMP="$OUT_DIR/.ffmpeg-${TRIPLE}.stamp"
SCRIPT_HASH="$(sha256_of "${BASH_SOURCE[0]}")"
STAMP_CONTENT="ffmpeg=${FFMPEG_VERSION} lame=${LAME_VERSION} script=${SCRIPT_HASH}"

print_size() {
  local bytes
  bytes=$(wc -c <"$OUT" | tr -d ' ')
  log "output: $OUT"
  log "size:   ${bytes} bytes ($(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1048576 }') MiB)"
}

if [ -f "$OUT" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$STAMP_CONTENT" ]; then
  log "up to date (FFmpeg ${FFMPEG_VERSION}, ${TRIPLE}); nothing to do"
  print_size
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------------------------
mkdir -p "$BUILD_ROOT" "$OUT_DIR"
TARBALL="$BUILD_ROOT/ffmpeg-${FFMPEG_VERSION}.tar.xz"
if [ ! -f "$TARBALL" ]; then
  log "downloading $FFMPEG_URL"
  curl -fL --retry 3 -o "$TARBALL.part" "$FFMPEG_URL"
  mv "$TARBALL.part" "$TARBALL"
fi

ACTUAL_SHA="$(sha256_of "$TARBALL")"
if [ -n "$FFMPEG_SHA256" ]; then
  [ "$ACTUAL_SHA" = "$FFMPEG_SHA256" ] || { rm -f "$TARBALL"; die "SHA-256 mismatch for $TARBALL (got $ACTUAL_SHA)"; }
  log "SHA-256 verified"
else
  log "warning: no pinned SHA-256; tarball hash is $ACTUAL_SHA (pin it in FFMPEG_SHA256_PINNED)"
fi

LAME_TARBALL="$BUILD_ROOT/lame-${LAME_VERSION}.tar.gz"
if [ ! -f "$LAME_TARBALL" ]; then
  log "downloading $LAME_URL"
  curl -fL --retry 3 -o "$LAME_TARBALL.part" "$LAME_URL"
  mv "$LAME_TARBALL.part" "$LAME_TARBALL"
fi
LAME_ACTUAL="$(sha256_of "$LAME_TARBALL")"
[ "$LAME_ACTUAL" = "$LAME_SHA256" ] || { rm -f "$LAME_TARBALL"; die "SHA-256 mismatch for $LAME_TARBALL (got $LAME_ACTUAL)"; }
log "LAME SHA-256 verified"

SRC_DIR="$BUILD_ROOT/ffmpeg-${FFMPEG_VERSION}"
BUILD_DIR="$BUILD_ROOT/build-${TRIPLE}"
LAME_SRC="$BUILD_ROOT/lame-${LAME_VERSION}"
LAME_PREFIX="$BUILD_DIR/lame"
rm -rf "$SRC_DIR" "$BUILD_DIR" "$LAME_SRC"
tar -xJf "$TARBALL" -C "$BUILD_ROOT"
tar -xzf "$LAME_TARBALL" -C "$BUILD_ROOT"
mkdir -p "$BUILD_DIR"

# ---------------------------------------------------------------------------------------------
# Configure
# ---------------------------------------------------------------------------------------------
PROTOCOLS="file,pipe"
# pcm_s16le: the app pipes raw aligned audio in when it renders the playback file.
DEMUXERS="mov,mp3,wav,w64,flac,ogg,aac,matroska,amr,aiff,caf,asf,pcm_s16le,pcm_f32le"
DECODERS="aac,aac_latm,mp3,mp3float,mp2,mp2float,flac,vorbis,opus,alac,amrnb,amrwb,wmav2,wmapro,ac3,eac3"
DECODERS="$DECODERS,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_u8,pcm_s16be,pcm_s24be"
DECODERS="$DECODERS,pcm_alaw,pcm_mulaw,adpcm_ima_wav,adpcm_ms"
PARSERS="aac,aac_latm,mpegaudio,flac,vorbis,opus,ac3"
# libmp3lame: MP3 quote fragments.
ENCODERS="aac,pcm_f32le,pcm_s16le,libmp3lame"
# Raw PCM muxers are called pcm_* in configure (on the command line: -f f32le / -f s16le).
MUXERS="mp4,ipod,pcm_f32le,pcm_s16le,wav,mp3"
# Voice anonymisation for quote fragments: asetrate + atempo shift pitch and formants, vibrato
# makes that shift vary over time, afftfilt randomises the phase (whisper mode), highpass/lowpass
# limit the band and acompressor/alimiter make the result clear and loud. aeval puts a beep over
# pseudonymised names.
FILTERS="aformat,aresample,pan,anull,atrim,asetpts,amerge,volume,asetrate,atempo,afftfilt,highpass,lowpass"
FILTERS="$FILTERS,vibrato,acompressor,alimiter,aeval"

CONFIGURE_ARGS=(
  --prefix="$BUILD_DIR/install"
  --enable-static
  --disable-shared
  --disable-debug
  --disable-doc
  --disable-autodetect
  --disable-network
  --disable-everything
  --disable-ffplay
  --disable-ffprobe
  --disable-avdevice
  --disable-swscale
  --enable-ffmpeg
  --enable-avcodec
  --enable-avformat
  --enable-avfilter
  --enable-swresample
  --enable-protocol="$PROTOCOLS"
  --enable-demuxer="$DEMUXERS"
  --enable-decoder="$DECODERS"
  --enable-parser="$PARSERS"
  --enable-encoder="$ENCODERS"
  --enable-muxer="$MUXERS"
  --enable-filter="$FILTERS"
  --enable-libmp3lame
)
# Deliberately NOT passed: --enable-gpl, --enable-version3, --enable-nonfree.

EXTRA_CFLAGS=""
EXTRA_LDFLAGS=""

case "$TRIPLE" in
  *-windows-*)
    # Fully static so the exe does not depend on libgcc_s / libwinpthread DLLs from MSYS2.
    # Windows threads (w32threads) are FFmpeg's default on MinGW; no pthreads library needed.
    CONFIGURE_ARGS+=(--target-os=mingw32 --arch=x86_64 --cc=gcc --pkg-config-flags=--static)
    EXTRA_LDFLAGS="-static -static-libgcc"
    if ! command -v nasm >/dev/null 2>&1; then
      log "warning: nasm not found, building without x86 assembly (slower decoding)"
      CONFIGURE_ARGS+=(--disable-x86asm)
    fi
    ;;
  aarch64-apple-darwin|x86_64-apple-darwin)
    ARCH="${TRIPLE%%-*}"
    CLANG_ARCH="$ARCH"; [ "$ARCH" = "aarch64" ] && CLANG_ARCH="arm64"
    # Matches the app's minimum macOS version.
    MIN_MACOS="${MACOSX_DEPLOYMENT_TARGET:-13.3}"
    EXTRA_CFLAGS="-arch $CLANG_ARCH -mmacosx-version-min=$MIN_MACOS"
    EXTRA_LDFLAGS="-arch $CLANG_ARCH -mmacosx-version-min=$MIN_MACOS"
    CONFIGURE_ARGS+=(--cc=clang --arch="$ARCH" --target-os=darwin)
    if [ "$CLANG_ARCH" != "$(uname -m)" ]; then
      CONFIGURE_ARGS+=(--enable-cross-compile)
    fi
    if [ "$ARCH" = "x86_64" ] && ! command -v nasm >/dev/null 2>&1; then
      CONFIGURE_ARGS+=(--disable-x86asm)
    fi
    ;;
esac

# ---------------------------------------------------------------------------------------------
# LAME, static, for libmp3lame (LGPL; only the encoder library, no frontend or decoder)
# ---------------------------------------------------------------------------------------------
log "building LAME ${LAME_VERSION}"
(
  cd "$LAME_SRC"
  LAME_ARGS=(--prefix="$LAME_PREFIX" --enable-static --disable-shared --disable-frontend --disable-decoder --disable-gtktest)
  case "$TRIPLE" in
    *-apple-darwin)
      LAME_ARGS+=(CC=clang)
      # LAME's config.sub predates arm64 names; only say --host when cross-compiling.
      [ "$CLANG_ARCH" != "$(uname -m)" ] && LAME_ARGS+=(--host="${CLANG_ARCH/arm64/aarch64}-apple-darwin")
      ;;
  esac
  CFLAGS="-O2 $EXTRA_CFLAGS" LDFLAGS="$EXTRA_LDFLAGS" ./configure "${LAME_ARGS[@]}" >"$BUILD_DIR/lame-configure.log" 2>&1 || {
    tail -n 40 "$BUILD_DIR/lame-configure.log" >&2
    exit 1
  }
  make -j"$JOBS" >"$BUILD_DIR/lame-make.log" 2>&1 && make install >>"$BUILD_DIR/lame-make.log" 2>&1 || {
    tail -n 60 "$BUILD_DIR/lame-make.log" >&2
    exit 1
  }
)
[ -f "$LAME_PREFIX/lib/libmp3lame.a" ] || die "LAME build finished but libmp3lame.a is missing"
EXTRA_CFLAGS="$EXTRA_CFLAGS -I$LAME_PREFIX/include"
EXTRA_LDFLAGS="$EXTRA_LDFLAGS -L$LAME_PREFIX/lib"

CONFIGURE_ARGS+=(--extra-cflags="$EXTRA_CFLAGS" --extra-ldflags="$EXTRA_LDFLAGS")

log "configuring FFmpeg ${FFMPEG_VERSION} for ${TRIPLE}"
(
  cd "$BUILD_DIR"
  "$SRC_DIR/configure" "${CONFIGURE_ARGS[@]}" >configure.log 2>&1 || {
    tail -n 60 configure.log >&2
    tail -n 80 ffbuild/config.log >&2 2>/dev/null || true
    exit 1
  }
)

# ---------------------------------------------------------------------------------------------
# License check: refuse to continue unless the configuration is plain LGPL.
# ---------------------------------------------------------------------------------------------
CONFIG_H="$BUILD_DIR/config.h"
for flag in CONFIG_GPL CONFIG_NONFREE CONFIG_VERSION3; do
  if grep -Eq "^#define ${flag} 1" "$CONFIG_H"; then
    die "${flag} is enabled; the sidecar must be LGPL-only"
  fi
done
LICENSE_LINE="$(grep -E '^#define FFMPEG_LICENSE ' "$CONFIG_H" || true)"
case "$LICENSE_LINE" in
  *"LGPL version 2.1 or later"*) log "license: LGPL version 2.1 or later" ;;
  *) die "unexpected FFmpeg license: '${LICENSE_LINE}'" ;;
esac
# No external libraries other than LAME (LGPL) should have slipped in (autodetect is off, but
# be explicit).
EXTERNAL_RE='^#define CONFIG_(LIB[A-Z0-9_]+|ZLIB|BZLIB|LZMA|ICONV|SDL2|SCHANNEL|SECURETRANSPORT|AUDIOTOOLBOX|VIDEOTOOLBOX|AVFOUNDATION|COREIMAGE|APPKIT) 1'
if grep -E "$EXTERNAL_RE" "$CONFIG_H" | grep -Ev 'CONFIG_LIBMP3LAME ' | grep -q .; then
  grep -E "$EXTERNAL_RE" "$CONFIG_H" | grep -Ev 'CONFIG_LIBMP3LAME ' >&2
  die "external libraries enabled; expected only LAME"
fi
grep -Eq '^#define CONFIG_LIBMP3LAME 1' "$CONFIG_H" || die "libmp3lame is not enabled"

# ---------------------------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------------------------
log "building with ${JOBS} jobs"
make -C "$BUILD_DIR" -j"$JOBS" ffmpeg"${EXE_SUFFIX}" >"$BUILD_DIR/make.log" 2>&1 || {
  tail -n 80 "$BUILD_DIR/make.log" >&2
  exit 1
}

BUILT="$BUILD_DIR/ffmpeg${EXE_SUFFIX}"
[ -f "$BUILT" ] || die "build finished but $BUILT is missing"
strip "$BUILT" 2>/dev/null || true

# On Windows, confirm the binary only imports system DLLs.
if [ -n "$EXE_SUFFIX" ] && command -v objdump >/dev/null 2>&1; then
  if objdump -p "$BUILT" | grep -Ei 'DLL Name: (lib|.*gcc|.*winpthread|.*stdc\+\+)' >&2; then
    die "binary depends on MinGW runtime DLLs; static linking failed"
  fi
fi
# On macOS, confirm it only links system libraries.
if [ -z "$EXE_SUFFIX" ] && command -v otool >/dev/null 2>&1; then
  if otool -L "$BUILT" | tail -n +2 | grep -Ev '^[[:space:]]*/(usr/lib|System/Library)/' >&2; then
    die "binary links non-system libraries"
  fi
fi

cp "$BUILT" "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
printf '%s' "$STAMP_CONTENT" >"$STAMP"

# Self-test when the binary can run on this host: the two things the app asks of it.
#   1. raw PCM in  -> AAC in an MP4 container out (playback and preview files)
#   2. any file in -> 16 kHz float PCM out through the app's filter chain (import and decoding)
if "$OUT" -hide_banner -version >/dev/null 2>&1; then
  "$OUT" -hide_banner -version | head -n 1 >&2
  TEST_DIR="$BUILD_ROOT/selftest-${TRIPLE}"
  rm -rf "$TEST_DIR"; mkdir -p "$TEST_DIR"
  head -c 64000 /dev/zero >"$TEST_DIR/silence.raw"   # one second, stereo, 16 kHz, s16
  "$OUT" -hide_banner -nostdin -v error -y -f s16le -ar 16000 -ac 2 -i "$TEST_DIR/silence.raw"     -c:a aac -b:a 112k -movflags +faststart -f mp4 "$TEST_DIR/out.m4a"     || die "self-test failed: could not encode raw PCM to AAC/MP4"
  "$OUT" -hide_banner -nostdin -v error -i "$TEST_DIR/out.m4a" -map 0:a:0 -vn -sn -dn     -af "aformat=channel_layouts=stereo,pan=mono|c0=0.5*c0+0.5*c1,volume=1.5" -ar 16000 -f f32le "$TEST_DIR/out.f32"     || die "self-test failed: could not decode AAC/MP4 to float PCM"
  BYTES=$(wc -c <"$TEST_DIR/out.f32" | tr -d ' ')
  [ "$BYTES" -ge 60000 ] || die "self-test failed: decoded output is too short (${BYTES} bytes)"
  #   3. a quote fragment: MP3 with the voice anonymisation filter chain (as in the app)
  "$OUT" -hide_banner -nostdin -v error -y -i "$TEST_DIR/out.m4a" -vn \
    -af "aresample=44100,asetrate=37044,aresample=44100,atempo=1.190476,vibrato=f=0.35:d=0.08,highpass=f=150,lowpass=f=6000,acompressor=threshold=-26dB:ratio=5:attack=5:release=150:makeup=8,alimiter=limit=0.95,afftfilt=real='hypot(re,im)*cos(2*PI*random(0))':imag='hypot(re,im)*sin(2*PI*random(1))':win_size=512:overlap=0.75,aeval=exprs='if(between(t,0.2,0.5),0.2*sin(2*PI*1000*t),val(ch))'" \
    -c:a libmp3lame -b:a 128k "$TEST_DIR/out.mp3" \
    || die "self-test failed: could not encode an MP3 with the voice filter"
  log "self-test passed"
  rm -rf "$TEST_DIR"
fi

print_size
