# Building Polarity Transcribe from source

Polarity Transcribe is a [Tauri 2](https://tauri.app) app: a Rust workspace for the engine and
desktop shell, and a React 19 + TypeScript + Vite + Tailwind 4 frontend. Speech recognition uses
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) through the `whisper-rs` crate, which
compiles whisper.cpp from source with CMake and generates bindings with bindgen (libclang).
Telling voices apart uses ONNX Runtime through the `ort` crate, which downloads a prebuilt ONNX
Runtime library at build time (from `cdn.pyke.io`, checksum-verified by the crate) and links it
statically.

Supported build platforms are Windows x64 and macOS on Apple Silicon. Linux is not supported.

## Prerequisites

### All platforms

- [Rust](https://rustup.rs), stable toolchain.
- [Node.js](https://nodejs.org) 22 with npm.
- [CMake](https://cmake.org) 3.x on `PATH` (or set the `CMAKE` environment variable to its full
  path).
- LLVM / libclang, needed by bindgen.
- An `ffmpeg` executable for development (see [FFmpeg](#ffmpeg)).

### Windows

- Visual Studio 2022 Build Tools with the "Desktop development with C++" workload (MSVC compiler
  and Windows SDK). The Build Tools include a copy of CMake under
  `Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin`.
- LLVM, for example from the official LLVM installer. If bindgen cannot find `libclang.dll`, set
  `LIBCLANG_PATH` to the folder that contains it (typically `C:\Program Files\LLVM\bin`).
  Without installing LLVM: `pip install --target .tools/libclang libclang` and point
  `LIBCLANG_PATH` at `.tools\libclang\clang\native`.
- WebView2 runtime (preinstalled on Windows 10/11).
- For GPU acceleration (used for published builds): the
  [Vulkan SDK](https://vulkan.lunarg.com/sdk/home), tested with 1.4.363.1. The ggml Vulkan backend
  needs `VULKAN_SDK` at build time and `glslc` on `PATH`. No administrator rights are needed: the
  SDK installs into your user folder with
  `vulkansdk.exe --root %LOCALAPPDATA%\VulkanSDK\<version> --accept-licenses --default-answer --confirm-command install copy_only=1`;
  then set `VULKAN_SDK` to that folder and add its `Bin` to `PATH`.
- **Short build folder for Vulkan builds.** whisper.cpp's shader generator nests so deeply that
  the paths under `target\` exceed Windows' 260-character limit (error FTK1011). Build into a
  short folder, for example `set CARGO_TARGET_DIR=C:\ptvk`.

### macOS

- Xcode Command Line Tools (`xcode-select --install`). They provide clang, libclang and the Metal
  toolchain.
- CMake, for example via Homebrew (`brew install cmake`).

## Windows build environment

Two settings are needed on Windows, both through environment variables:

1. **Optimisation flags.** The `cmake` crate replaces CMake's per-configuration MSVC flags and
   drops every `/O` flag, which leaves whisper.cpp unoptimised and 10 to 50 times slower. `cl.exe`
   prepends the contents of the `CL` environment variable to its command line, which puts the
   flags back:

   ```
   CL=/O2 /Ob2 /DNDEBUG
   ```

2. **Portable CPU baseline.** By default ggml optimises for the CPU of the build machine. For
   binaries that run on other computers, use a fixed x86-64 baseline (AVX2, roughly 2013 and newer):

   ```
   GGML_NATIVE=OFF
   GGML_AVX=ON
   GGML_AVX2=ON
   GGML_FMA=ON
   GGML_F16C=ON
   ```

The easiest way to set these for every `cargo` invocation is a local `.cargo/config.toml`
(gitignored). Copy [`.cargo/config.example.toml`](../.cargo/config.example.toml) to
`.cargo/config.toml` and adjust the machine-specific paths (`CMAKE`, `LIBCLANG_PATH`) or remove
them if those tools are already found.

Do not set the `GGML_*` x86 flags on macOS.

## FFmpeg

The engine decodes audio by running FFmpeg as a child process. It looks for the executable in this
order:

1. The path in the `PT_FFMPEG` environment variable.
2. Next to the application executable (this is where the bundled sidecar ends up in an installed
   app).
3. `ffmpeg` on `PATH`.

For development, any reasonably recent FFmpeg on `PATH` works (for example `winget install ffmpeg`
or `brew install ffmpeg`), or point `PT_FFMPEG` at one.

Release builds ship a minimal, audio-only, LGPL-only FFmpeg as a Tauri sidecar. Build it with:

```sh
scripts/build-ffmpeg.sh            # target triple defaults to the host
scripts/build-ffmpeg.sh aarch64-apple-darwin
```

The output is `src-tauri/binaries/ffmpeg-<target-triple>[.exe]`. On Windows the script must run in
an [MSYS2](https://www.msys2.org) MINGW64 or UCRT64 shell with these packages installed (UCRT64
shown):

```sh
pacman -S make diffutils tar curl mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-nasm
```

MSYS2 does not need administrator rights: unpacking the `msys2-base-x86_64-<date>.tar.xz`
archive from the [MSYS2 releases](https://github.com/msys2/msys2-installer/releases) into a user
folder is enough. Run the script from that folder's `usr\bin\bash.exe -l` with `MSYSTEM=UCRT64`
and `CHERE_INVOKING=1` set, from the repository root. The build takes a few minutes.

The script is idempotent; it only rebuilds when the pinned FFmpeg version or the script changes.

## Commands

```sh
npm install                 # frontend dependencies and the Tauri CLI

npm run tauri dev           # run the app in development mode (hot reload for the frontend)

npm run typecheck           # TypeScript check
npm test                    # frontend unit tests (Vitest)
cargo test -p pt-core       # engine tests
```

Release build on macOS (requires the FFmpeg sidecar, see above):

```sh
npm run tauri build -- --features metal --config src-tauri/tauri.release.conf.json
```

Release build on Windows (requires the FFmpeg sidecar, the Vulkan SDK and a short
`CARGO_TARGET_DIR`, see above):

```sh
cargo build --release -p pt-core --features vulkan
node scripts/collect-runtime.mjs
npm run tauri build -- --features vulkan --config src-tauri/tauri.release.conf.json --config src-tauri/tauri.release.windows.conf.json
```

`src-tauri/tauri.conf.json` is the development configuration. The release configurations are
merged on top of it:

- `tauri.release.conf.json` adds the FFmpeg sidecar (`bundle.externalBin`) and the macOS ad-hoc
  signing identity.
- `tauri.release.windows.conf.json` adds the DLLs that must sit next to the Windows executable:
  `DirectML.dll` (the ONNX Runtime build links against it) and the Visual C++ runtime, so the app
  starts on a computer without the VC++ redistributable. `scripts/collect-runtime.mjs` gathers
  them into `src-tauri/runtime/` (gitignored) after the engine has been built once.

A plain `npm run tauri build` without the release configurations also works for a quick local
installer. That installer has no FFmpeg and no runtime DLLs inside, so it only runs on a computer
that has `ffmpeg` on `PATH` and the Visual C++ redistributable installed. Do not hand it out.

GPU acceleration is selected with Cargo features on the app crate: `--features metal` on macOS
and `--features vulkan` on Windows, both used for published builds. At run time the app picks the
device itself (`crates/core/src/gpu.rs`): a dedicated graphics card with enough memory if there
is one, otherwise graphics built into the processor, otherwise the processor. Chips with an
unmistakable name are classified by a small table (`classify`: clearly fast, clearly slow).
Outside macOS, every other chip races the processor once, on the first chunk of the first
transcription; the result is remembered per chip and app version in `gpu-check.json` in the
models folder (delete it to race again). To add a chip to the table, use the name that Settings
or `pt bench --gpu` reports. On Windows
`vulkan-1.dll` (installed by every graphics driver) is delay-loaded, so the Vulkan build also
starts on a PC without it and then runs on the processor. `PT_GPU_DEVICE=<index>` or
`PT_GPU_DEVICE=cpu` overrides the choice for testing.

A `cuda` feature exists for experiments but is not used for published builds.

Installers are written to `target/release/bundle/` (or `target/<triple>/release/bundle/` when
`--target` is given).

### The `pt` command-line harness

`crates/cli` builds a small binary, `pt`, for benchmarking and testing the engine without the UI.
For example, to transcribe the first 60 seconds of a file:

```sh
cargo run --release -p pt-cli -- bench <file> --start 0 --duration 60
```

To run the complete pipeline on one or two recordings and print the transcript:

```sh
cargo run --release -p pt-cli -- run --in1 <file> [--in2 <file>] --lang nl
```

The models are looked up in `models/` (gitignored); use `--model`, `--vad-model` and
`--voice-model` to point elsewhere, and `--help` on each subcommand for all options. Setting
`PT_KEEP_JOB=1` keeps the job folder after a successful run, so a second run with `--project <id>`
skips recognition and only repeats the assembly of the transcript.

Always use `--release` (or at least the workspace's dev profile, which already optimises
dependencies): unoptimised inference is unusably slow.

## Continuous integration

- `.github/workflows/ci.yml` runs on every push and pull request on Windows and macOS (Apple
  Silicon): typecheck, frontend tests, `cargo test -p pt-core` and `cargo check` of the app crate.
- `.github/workflows/release.yml` runs on `v*` tags (and manually). It builds the FFmpeg sidecar,
  collects the Windows runtime DLLs, builds the NSIS installer (Windows) and DMG (macOS) and
  attaches them to a draft GitHub Release. The version lives in one place, `version` under
  `[workspace.package]` in the root `Cargo.toml`, and the tag must match it, for example
  `v0.1.0`. Running it manually with "windows_cpu_only" ticked builds Windows without Vulkan.

Neither workflow has run on GitHub yet. The FFmpeg source tarball is pinned by SHA-256 in
`scripts/build-ffmpeg.sh`; when changing the version, check the new tarball's signature first
(the comment above `FFMPEG_SHA256_PINNED` says how).

### Updates

Installed apps check `releases/latest/download/latest.json` of the repository named in
`plugins.updater.endpoints` in `src-tauri/tauri.conf.json` at startup (unless the user turns
it off in Settings), and offer a one-click update. The release workflow builds the update
packages and `latest.json` and signs them. Because drafts are not "latest", nothing reaches users
until you publish the draft release.

The app only installs packages signed with the updater key, whose public half is
`plugins.updater.pubkey`. This is a free minisign key, not a code-signing certificate. Before the
first release, add two repository secrets (Settings > Secrets and variables > Actions):

- `TAURI_SIGNING_PRIVATE_KEY`: the contents of the private key file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password.

Keep a backup of the private key: without it, installed apps can no longer be updated
automatically (users would have to download the next installer by hand). A new key pair is made
with `npx tauri signer generate -w <file>`; put the new public key in `tauri.conf.json`.

To try the update flow locally, build a newer version with
`--config '{"version":"0.1.1"}'` and `createUpdaterArtifacts`, serve its installer and a
`latest.json` from a local web server, and point a test build's `endpoints` at it (with
`"dangerousInsecureTransportProtocol": true` for plain http).

## Repository layout

```
.
├── crates/
│   ├── core/          pt-core: engine (import, sync, speaker attribution, VAD, recognition, assembly)
│   └── cli/           pt-cli: the `pt` benchmark / test harness
├── src-tauri/         polarity-transcribe: Tauri app crate (commands, state, config, icons)
│   ├── tauri.conf.json           development configuration
│   ├── tauri.release.conf.json   release overrides (sidecar, macOS signing)
│   ├── tauri.release.windows.conf.json   Windows release overrides (runtime DLLs)
│   ├── binaries/                 FFmpeg sidecar output (gitignored)
│   └── runtime/                  Windows runtime DLLs (gitignored)
├── src/               React + TypeScript frontend
├── scripts/
│   ├── build-ffmpeg.sh           builds the minimal LGPL FFmpeg sidecar
│   └── collect-runtime.mjs       gathers the DLLs the Windows installer ships
├── docs/              BUILDING.md, PRIVACY.md
├── .cargo/config.example.toml    template for local build environment variables
└── .github/workflows/            CI and release pipelines
```
