# Third-party notices

Polarity Transcribe itself is released under the MIT License (see [LICENSE](LICENSE)). The
installers and the models the app downloads contain or use the following third-party work.

## Shipped inside the installers

| Component | Used for | License |
| --- | --- | --- |
| [FFmpeg](https://ffmpeg.org) (separate executable, built by `scripts/build-ffmpeg.sh` from the unmodified official source release named in that script, without GPL or non-free parts) | Reading audio files, writing the playback copy and quote fragments | LGPL 2.1 or later |
| [LAME](https://lame.sourceforge.io) 3.100 (linked into the FFmpeg executable above, built from the unmodified official source by the same script) | MP3 quote fragments | LGPL 2.0 or later |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and ggml | Speech recognition | MIT |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime), prebuilt by the [ort](https://github.com/pykeio/ort) project | Running the speaker model | MIT |
| DirectML (`DirectML.dll`, Windows only) | Required by the ONNX Runtime build | Microsoft DirectML redistributable license |
| Microsoft Visual C++ runtime (`msvcp140*.dll`, `vcruntime140*.dll`, Windows only) | C++ runtime of the above | Microsoft Visual Studio redistributable license |
| [Silero VAD](https://github.com/snakers4/silero-vad) model, converted for whisper.cpp | Finding speech and silence | MIT |
| [Tauri](https://tauri.app) and the Rust crates listed in `Cargo.lock` | Application shell and engine | MIT and/or Apache-2.0 (a few: BSD, ISC, MPL-2.0, Unicode) |
| [React](https://react.dev), [TipTap](https://tiptap.dev) / ProseMirror, [Radix UI](https://www.radix-ui.com), [lucide](https://lucide.dev), [docx](https://docx.js.org), [zustand](https://github.com/pmndrs/zustand), [Tailwind CSS](https://tailwindcss.com) and the other packages listed in `package-lock.json` | User interface and export | MIT, ISC or Apache-2.0 |
| [Inter](https://rsms.me/inter/) typeface (bundled, so no font is fetched from the internet) | User interface | SIL Open Font License 1.1 |

FFmpeg (with LAME) is called as a separate program and is not linked into the application. The
source code is available from <https://ffmpeg.org/releases/> and
<https://sourceforge.net/projects/lame/files/lame/>; the exact versions and build options are in
`scripts/build-ffmpeg.sh`.

## Downloaded by the app on request (not in the installers)

| Model | Source | License |
| --- | --- | --- |
| Whisper large-v3-turbo, large-v3 and small (OpenAI), in GGML format | `huggingface.co/ggerganov/whisper.cpp` | MIT |
| WeSpeaker ResNet34-LM speaker embedding model, trained on VoxCeleb | `github.com/k2-fsa/sherpa-onnx` release files | Apache-2.0 (model code); the VoxCeleb data it was trained on is licensed CC BY 4.0 |

Before publishing a release, check this list against the actual dependency tree
(`cargo tree`, `npm ls`): it was written by hand.
