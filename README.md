# Polarity Transcribe

Polarity Transcribe is a free, open-source desktop app that turns recorded research interviews
into verbatim transcripts, entirely on your own computer. It is made for students and researchers
who interview people in Dutch or English and need a careful transcript they can check, correct,
anonymise and export for qualitative analysis.

> **Nederlands.** Polarity Transcribe is een gratis, open-source programma voor Windows en macOS
> dat opgenomen onderzoeksinterviews in het Nederlands of Engels letterlijk (verbatim) uitschrijft.
> Alles gebeurt op je eigen computer: de opnames en transcripten verlaten je apparaat nooit.
> Internet wordt alleen gebruikt om eenmalig het spraakherkenningsmodel te downloaden en om bij het
> opstarten op updates te controleren (uit te zetten in Instellingen); transcriberen werkt volledig
> offline. Je kunt het transcript naast de audio nakijken en verbeteren, sprekers een
> naam geven, gegevens anonimiseren en exporteren naar onder andere Word (DOCX). De interface is
> beschikbaar in het Nederlands en het Engels.
>
> **Installeren.** Download de installer van de [Releases-pagina](../../releases). De installers
> zijn niet ondertekend met een betaald certificaat, dus je computer waarschuwt de eerste keer:
>
> - **Windows:** bij "Windows heeft uw pc beschermd" klik je op **Meer informatie** en dan op
>   **Toch uitvoeren**. Je hebt geen beheerdersrechten nodig.
> - **Mac:** sleep de app naar Programma's en open hem. Zegt macOS dat de app niet gecontroleerd
>   kan worden, ga dan naar **Systeeminstellingen > Privacy en beveiliging**, scrol naar beneden
>   en kies daar om de app toch te openen. Daarna onthoudt macOS je keuze. Meer opties staan
>   hieronder bij [Installing](#installing).
>
> **Hulp nodig?** In de app: **Instellingen > Over > Systeeminformatie**. Kopieer die tekst en
> stuur hem mee met je vraag; er staan geen opnames, transcripten of namen in.

> **Status.** Version 0.1 is an early release. It has been tested end to end on Windows 11. The
> macOS build and the release pipeline have not been run yet; expect rough edges there.

## Privacy

Interview recordings are personal data, often sensitive. The app is built so that nothing leaves
your computer:

- All processing (decoding, speech recognition, editing, export) happens on your device.
- The only network use is the one-time download of the speech recognition models, which you
  start yourself, and a check for a newer version at startup, which you can turn off in Settings.
  No audio, text or other user data is ever sent anywhere.
- No telemetry, analytics or crash reporting. Updates are only installed when you click
  "Update now", and only if they carry the project's digital signature.
- Projects are stored in the local, non-roaming application data folder, so they do not sync to a
  university roaming profile.
- Deleting a project removes all audio and data the app derived from your recordings. Your
  original recording files are never modified or copied.

For a precise statement you can give to an ethics committee or supervisor, see
[docs/PRIVACY.md](docs/PRIVACY.md).

## Features

**Studies and interviews**
- Group the interviews of a research project in a study, with shared settings: interview
  language, names and terms, pause threshold, interviewer and tags.
- Participants with pseudonymous codes (R01, R02, …), created automatically for each new
  interview, and your own attributes (age group, role, site, …), exportable as CSV for analysis
  software.
- Per interview: participant(s) (several for a focus group), date (taken from the recording
  file), interviewer, tags, notes and progress (to check, checked, anonymised, done), with
  filters in the study.
- Search all transcripts of a study at once; every hit opens the transcript at that moment.
- Save quotes while you read (Ctrl+Q) and get one list per study, with participant code and time,
  as Word or CSV.
- A generated methods paragraph (Dutch or English) that describes how the study was transcribed.
- Drop several recordings at once: each becomes its own interview. "Transcribe all" queues them,
  so a whole study can run overnight.
- In a study the speakers are named automatically: whoever asks the questions becomes the
  interviewer, the other speaker gets the participant code.
- A single recording works without a study too.

**Importing audio and video**
- Import audio or video (mp3, m4a, wav, flac, ogg, mp4, mov, mkv, webm and more; from a video
  the app takes the sound). **New transcription** asks what kind of recording it is: a
  conversation or interview, or a lecture or presentation. A lecture has one speaker, so the app
  does not try to tell voices apart (also available in the setup as 1 speaker), and it gets a clean
  reading text without fillers, pause tags or the built-in annotations.
- Import one or two audio files (for example one per speaker), or a single split-stereo file with
  one speaker per channel.
- Automatic detection of whether a stereo file is split-stereo (one speaker per channel) or a
  plain recording with a safety track, with a manual override.
- Waveform view for trimming the recording with in and out points.
- Automatic synchronisation of two separate recordings, including compensation for clock drift
  between the two devices.
- Microphone-bleed handling, so a sentence picked up by both microphones is not transcribed twice.

**Who said what**

The app chooses the most reliable method the recording allows, and tells you which one it used:

- *Each speaker close to their own microphone:* each speaker is transcribed from their own
  microphone.
- *Two microphones that both hear everyone* (for example two phones on the same table): speakers
  are told apart by which microphone the sound reaches first.
- *One recording:* speakers (two or three) are told apart by the sound of their voice.

**Transcription**
- The spoken language (Dutch or English) is checked at the start of every transcription. If the
  interview was set to the other language by mistake, the app switches and tells you in the editor.
- Verbatim output that keeps filler words such as `[uhm]` and `[hmm]`. Switch **Verbatim
  transcript** off in the setup for a clean reading text (the default for a lecture).
- Measured pause tags, for example `[stilte 3.5s]` in Dutch or `[silence 3.5s]` in English.
- Short backchannels shown inline, for example `[Interviewer: hm-hm]`.
- With a microphone per speaker, speech that overlaps the other speaker is marked
  `[door elkaar]` / `[overlapping]`.
- Resume after an interruption, and the computer is kept awake while a transcription runs.

**Editing**
- Rename speakers.
- Click a word to play the audio from that point; the text follows playback.
- Loop mode with adjustable playback speed and a voice-clarity filter for hard-to-hear passages.
- Playback jumps back a moment when you resume after a pause (adjustable), and play/pause,
  rewind and fast forward can be put on any key, including the pedals of a foot switch.
- Words the recogniser is unsure about are highlighted, with a jump-to-next button.
- Toolbar for behavioural annotations, with keyboard shortcuts and your own custom tags. Click to
  insert at the cursor, or drag an annotation to a place in the text.
  `[onverstaanbaar]` replaces the selected words and records the time, for example
  `[onverstaanbaar 12:31]`.
- Split a turn with Enter, merge it with the previous one with Backspace.
- Give a short reply inside the other speaker's turn to the right person ("Said by…" under a
  selection): one sentence becomes `[R01: yes, right]` in the same paragraph, more sentences
  become a paragraph of their own.
- Find and replace (Ctrl+F), optionally whole words only.
- "Checked up to here" marker with a percentage, so you know where you stopped.
- Optional spell check.
- Autosave.

**Pseudonymisation**
- One pseudonym list per study, used for all its interviews, plus rules for a single interview.
- **Find automatically** goes through the transcript term by term: names (capitalised words in
  the middle of a sentence), terms from the names list, dates, years, long numbers, postcodes,
  e-mail addresses and phone numbers. For each one you see it in the text (and can listen to it),
  then replace it with a numbered pseudonym (`[naam 3]`), keep it, or leave it for later. Kept
  terms are not asked about again in the study.
- Applied when exporting: the transcript in the app stays complete, everything that leaves the
  app is pseudonymised (text, speaker names, titles, notes).
- A separate pseudonym key (CSV) to store apart from the transcripts.

**Export**
- Word, plain text and Markdown, with optional timestamps, numbering per turn or per line, and a
  clean reading version without filler words, silences and listening sounds.
- Pause notation of your choice: `[stilte 3.5s]`, Dresing & Pehl `(.) (..) (...) (5)` or
  Jefferson/GAT `(3.5)`.
- For analysis software: MAXQDA and ATLAS.ti (Word with `#00:12:31-4#` timestamps) and NVivo
  (Word table with time spans), so the transcript stays linked to the recording after import.
  Times follow the original recording file, also when you transcribed only part of it. Or
  include the audio (MP3, M4A or WAV, trimmed and with two recordings aligned) next to the
  transcript; the times then match that file.
- A whole study at once: one file per interview, the participants table, copies of the original
  recordings and a REFI-QDA project (`.qdpx`) that opens the study in ATLAS.ti, MAXQDA, NVivo and
  other programs (interviews, participants with attributes, tags as groups, annotations as codes).
- Subtitles (SRT, WebVTT) and the raw data (JSON).

**Languages**
- Dutch and English, both for the interview audio and for the interface.

## Installing

Download the installer for your system from the [Releases page](../../releases) of this
repository.

The installers are not code-signed, because signing certificates cost money that this volunteer
project does not have. Your operating system will therefore warn you the first time you open the
app. The steps below explain how to continue. If you prefer, you can build the app yourself from
the source code (see [Building from source](#building-from-source)).

### Windows 10 / 11 (64-bit)

1. Download `Polarity-Transcribe-<version>-Windows-setup.exe`.
2. Run it. Windows SmartScreen may show "Windows protected your PC". Click **More info**, then
   **Run anyway**.
3. The installer installs for your user account only and does not need administrator rights.

### macOS (Apple Silicon: M1 or newer)

1. Download `Polarity-Transcribe-<version>-Mac.dmg`, open it and drag the app to
   **Applications**.
2. The first time, macOS may say the app "cannot be opened because Apple cannot check it for
   malicious software" or that it is "damaged". To open it anyway, use one of these:
   - Try to open it once, then go to **System Settings > Privacy & Security**, scroll down and click
     **Open Anyway** (on macOS 15 and newer this is the only way without Terminal); or
   - On macOS 13 or 14: in Finder, right-click (or Control-click) the app and choose **Open**, then
     **Open** again; or
   - In Terminal, run:
     ```sh
     xattr -dr com.apple.quarantine "/Applications/Polarity Transcribe.app"
     ```
3. After the first successful launch, macOS remembers your choice.

### First run: model download

The speech recognition model is not included in the installer, which keeps the download small.
On first start the app downloads it once (Whisper large-v3-turbo, about 0.9 GB) from Hugging Face,
together with a small model for telling voices apart (27 MB, from GitHub). The download can be
paused and resumed, and the files are checked against known checksums. After that, the app works
completely offline.

**No internet on the computer you transcribe on?** Download these two files on another computer,
copy them over (for example on a USB stick) and use **Import model file…** in the app, once for
each file:

- <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin>
- <https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx>

### Updates

When a new version is published, the app shows "Version x is available" on its start screen.
Click **Update now**: it downloads, checks and installs the new version and restarts. Your
projects and settings are kept. You can turn the automatic check off in Settings.

## Quick start

1. **Import.** Create a project and add your recording: one file, two files (one per speaker), or
   one split-stereo file. Check the detected channel layout and change it if needed.
2. **Trim.** Set in and out points on the waveform to skip small talk or silence before and after
   the interview.
3. **Transcribe.** Start the transcription. You can keep working on other things; the app
   prevents the computer from sleeping and can resume if it is interrupted.
4. **Edit.** Read through the transcript while listening. Click any word to hear it, use loop mode
   and slower playback for difficult passages, and jump through highlighted uncertain words.
   Rename speakers, add annotations and anonymise names.
5. **Export.** Export to DOCX, TXT, Markdown, JSON or SRT.

## Recording tips for the best accuracy

The quality of the recording matters more than anything else.

- **Use two microphones if you can:** two phones (one in front of each speaker, both recording), or
  a dual wireless clip-on microphone set that records each speaker on a separate channel. The app
  synchronises the two recordings and knows who is speaking much more reliably than with one
  microphone.
- **Keep each speaker close to their own microphone** (roughly 20 to 50 cm for a phone, or a
  clip-on microphone on the collar).
- **Choose a quiet room.** Avoid cafes, open windows, air conditioning, clattering cups and
  reverberant halls.
- **Tell the app the names and jargon** that occur in the interview (the "Names and terms" field
  before you start). This noticeably improves how they are spelled.
- Put phones in flight mode while recording, and do a short test recording first.

## System requirements

- **Windows:** Windows 10 or 11, 64-bit (x64), with a processor that supports AVX2 (roughly any
  Intel or AMD processor from 2013 onward). 8 GB RAM.
- **macOS:** macOS 13.3 Ventura or newer on Apple Silicon (M1 or newer). Intel Macs are not
  supported. 8 GB RAM.
- About 2 GB of free disk space for the app and model, plus room for your projects.

## How fast is it?

Speech recognition is demanding work, and speed depends heavily on your computer. The app picks
the fastest option by itself: a dedicated graphics card if there is one, otherwise the graphics
built into the processor, otherwise the processor. Measured with the default model on a desktop
with an AMD Ryzen 7 7700 and an NVIDIA RTX 5060 Ti:

| Runs on | Speed | A 60-minute interview takes about |
| --- | --- | --- |
| Processor, 4 threads | 1.8 times real time | 35 minutes |
| Processor, 8 threads | 3 times real time | 20 minutes |
| Graphics card (Vulkan) | 55 times real time | 1 to 2 minutes |

- A typical student laptop without a graphics card is slower than the processor rows above,
  sometimes considerably: count on roughly the length of the recording, and let it run while you
  do something else. The app shows an estimate before you start, keeps the computer awake, and
  continues where it was if it gets interrupted.
- Graphics built into a laptop processor, such as AMD Radeon 680M/780M or Intel Arc, are reported
  to be three to four times faster than the processor; older ones (Intel UHD) are not. The app
  knows the common chips. For a chip it cannot place (for example Intel Iris Xe, or an
  entry-level graphics card), the first transcription compares it with the processor on a few
  seconds of your recording (this takes up to a minute, once per app version) and then keeps
  using whichever was faster. Settings shows which graphics chip is used, if any.
- **Fast mode** (in Settings) trades a little accuracy for roughly 30% more speed.
- The **Light** model is about three times faster but makes clearly more mistakes in Dutch.
- Apple Silicon Macs use the graphics chip and are much faster than their processor alone.

## Known limitations

- With a single microphone, telling speakers apart is less reliable than with two microphones.
  Very short turns ("ja", "nee") are the most likely to be given to the wrong speaker.
- Transcribe one conversation at a time (use the start and end markers). If a long recording
  holds several conversations, the app follows the change of seats, but "Speaker 2" is then a
  different person in each, and up to a few minutes around a change can be attributed wrongly.
- A part of the interview that only one of two recordings covers is attributed to speaker 1.
- The audio you hear while editing is a compact working copy (16 kHz), not the original recording.
- The pause threshold is applied while transcribing; changing it afterwards means transcribing
  again.
- One transcription runs at a time.
- Filler words are captured well but not perfectly; some will be missed or misheard.
- Automatic transcription makes mistakes, especially with names, jargon, accents, overlapping
  speech and poor recordings. **Always proofread the transcript against the audio** before you use
  it in your research.

## Something not working?

Open **Settings > About > System information**. It shows a description of your computer and the
app (versions, processor, memory, graphics chips and how fast they turned out, models, FFmpeg,
the figures of your most recent transcriptions and any error messages). Interview names, file
names and folders are replaced, and recordings and transcripts are not in it. Nothing is sent:
click **Copy** and paste it into your question or into a
[problem report](../../issues).

## Building from source

See [docs/BUILDING.md](docs/BUILDING.md). Experiments that were tried and not adopted, with what
was measured, are in [docs/DEVLOG.md](docs/DEVLOG.md).

## License

Polarity Transcribe is released under the [MIT License](LICENSE).

The installers include a build of FFmpeg, which is licensed under the LGPL version 2.1 or later.
The source of that build is the unmodified official FFmpeg release named in
[scripts/build-ffmpeg.sh](scripts/build-ffmpeg.sh), configured by that script.

## Acknowledgements

Polarity Transcribe builds on the work of many others, including:

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for fast on-device speech recognition
- [OpenAI Whisper](https://github.com/openai/whisper) for the speech recognition models
- [Silero VAD](https://github.com/snakers4/silero-vad) for voice activity detection
- [WeSpeaker](https://github.com/wenet-e2e/wespeaker) (speaker embedding model) and
  [ONNX Runtime](https://onnxruntime.ai) for telling voices apart
- [FFmpeg](https://ffmpeg.org) for audio decoding
- [Tauri](https://tauri.app) for the desktop application framework
- [TipTap](https://tiptap.dev) for the transcript editor
