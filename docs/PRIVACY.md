# Data handling statement

This document describes how Polarity Transcribe handles data. It is written to be shared with
ethics committees, data stewards and supervisors. It describes the behaviour of the official
release builds of the application; the source code is public and can be inspected to confirm it.

## Summary

- All processing of recordings and transcripts takes place locally on the user's computer.
- The application makes only two kinds of network connection: downloading speech recognition
  models, which the user initiates on first use, and a check for a newer version at startup, which
  the user can turn off. No recordings, transcripts or other user data are transmitted.
- The application contains no telemetry, analytics or crash reporting.
- Original recordings are read but never modified, moved or copied.

## What is stored, and where

Each project is stored in the application's local data folder:

| Operating system | Location |
| --- | --- |
| Windows | `%LOCALAPPDATA%\nl.polarity.transcribe` (typically `C:\Users\<name>\AppData\Local\nl.polarity.transcribe`) |
| macOS | `~/Library/Application Support/nl.polarity.transcribe` |

On Windows this is the *Local* (non-roaming) application data folder. It is not synchronised to
other computers by Windows roaming profiles, which some universities use. Note that a user's own
backup or sync software (for example OneDrive folder backup, Time Machine or iCloud) may still
include this folder if configured to do so; this is outside the application's control.

The folder contains:

- **Models.** The downloaded speech recognition model and speaker (voice) model, and the voice
  activity detection model that ships with the application. These contain no user data.
- **Projects.** For each project: project settings (including the file paths of the imported
  recordings, speaker names and trim points), audio derived from the recordings (decoded,
  resampled working copies used for playback, waveform display and transcription), the transcript
  including edits and annotations, and intermediate state that allows an interrupted transcription
  to resume.
- **Application settings**, such as interface language and preferences.

Data is stored unencrypted on disk, protected by the operating system's normal user account
permissions. See [Recommendations](#recommendations).

## Original recordings

The application opens the original recording files read-only. It does not modify, move, rename or
copy them. The derived audio described above is a separate, re-encoded representation stored in
the project folder. The project stores the path of the original file, not a copy of it.

## Temporary files

Audio decoding is performed by a bundled copy of FFmpeg running as a child process. Decoded audio
is passed to the application through an in-memory pipe. The application does not write audio or
transcripts to the system temporary directory. All files the application writes are inside the
local data folder listed above, plus any export files the user explicitly saves to a location of
their choice.

## Network use

There are two kinds of network activity.

### Model downloads

- **When:** on first use (or when the user chooses a different model), started from within the
  application.
- **From:** `huggingface.co` (Hugging Face) for the speech recognition model and `github.com`
  (GitHub release downloads, which redirect to GitHub's file servers) for the speaker model, over
  HTTPS. Each file is verified against a SHA-256 checksum built into the application.
- **What is sent:** a standard HTTPS request for a public model file. No recordings, transcripts,
  project data, account details or identifiers are sent. As with any web request, the server can
  see the user's IP address and the request time.
- **Afterwards:** the application works fully offline. It can be used on a computer with networking
  disabled once the models are present.
- **Without any network use:** the model files can also be downloaded on another computer and
  imported from a file, so the computer that holds the recordings never needs a connection.

### Update check

- **When:** a few seconds after the application starts, and when the user clicks "Check now" in
  Settings. The automatic check is on by default and can be turned off in Settings ("Check for
  updates automatically"); it then never runs unless the user clicks "Check now".
- **From:** `github.com` (the project's GitHub Releases page), over HTTPS.
- **What is sent:** a request for a small public file (`latest.json`) that names the newest
  version. GitHub can see the user's IP address, the request time and a standard request header
  that includes the application's version and operating system. No recordings, transcripts,
  project data, account details or identifiers are sent, and nothing is stored about the user.
- **Updating:** only when the user clicks "Update now". The new version is downloaded from GitHub
  and installed only if its digital signature matches the project's update key built into the
  application; a tampered or unsigned download is rejected. Projects and settings are kept.
- **Offline:** if there is no connection, the check fails silently and the application works as
  normal.

There is no telemetry, usage analytics, crash reporting, advertising or account system. The
application does not contact any server operated by the Polarity Transcribe project; both model
downloads and update checks go to the public services named above.

**For a fully offline setup** (for example a computer that must never connect while holding
recordings): import the models from files and turn off "Check for updates automatically" in
Settings before importing any recordings. The application then makes no network connections.

## Pseudonymisation

Pseudonymisation rules (a list per study and rules per interview) are stored in the local data
folder with the projects. They are applied to everything the application exports when the
"Pseudonymise" option is on (the default when rules exist): transcript text, speaker names,
interview titles and notes. The transcripts inside the application are not changed, unless the
researcher chooses "Apply permanently". The pseudonym key (which real name became which
pseudonym) is exported only on request, as a separate file; it should be stored apart from the
transcripts. Pseudonymisation is text-based: spelling variants must be added as separate rules,
and the audio is not altered.

## Exports

Exports (DOCX, TXT, Markdown, JSON, SRT) are written only to the location the user selects in a
save dialog. Once exported, those files are outside the application's control and are not removed
when a project is deleted.

## Deleting a project

Deleting a project from within the application removes the project's folder: the derived audio,
the transcript and all project data. The original recordings and any exported files are not
affected.

**Limitation:** deletion uses the operating system's normal file deletion. It is not forensic
erasure. On solid-state drives in particular, deleted data may remain physically recoverable with
specialised tools until the drive reuses those storage cells, and overwriting files does not
reliably prevent this. The application does not and cannot guarantee secure erasure.

## Recommendations

For research data that requires protection at rest, use full-disk encryption on the computer that
runs the application:

- **Windows:** BitLocker (or Device Encryption on Windows Home editions).
- **macOS:** FileVault.

With full-disk encryption enabled, both the project data and any residual data from deleted
projects are protected when the computer is switched off or lost. Researchers should also follow
their institution's policy on where recordings, transcripts and exports may be stored, and delete
projects once the transcript has been finalised and exported.

## Third-party components

Speech recognition runs locally using whisper.cpp with OpenAI Whisper model weights. Voice
activity detection uses the Silero VAD model. Telling speakers apart on a single recording uses a
WeSpeaker speaker-embedding model run with ONNX Runtime (its usage telemetry is switched off).
Audio decoding uses FFmpeg, built without any network support. None of these components make
network connections in this application.

Speaker embeddings ("voice prints") are computed in memory to group the speech of one recording by
speaker. They are not stored, not compared across projects and not used to identify anyone.
