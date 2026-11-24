# Roadmap

Polarity Transcribe is meant for qualitative research: a study with a series of interviews that
have to be transcribed verbatim, checked, anonymised and handed over to analysis software. This
roadmap follows that workflow. It comes from a review against comparable tools (MacWhisper,
noScribe, aTrain, f4x, Amberscript, Happy Scribe) in November 2026.

Guiding principles: everything stays offline, the app adapts to the computer and the recording by
itself, and it prepares data for analysis software rather than becoming one.

## 0. Release-ready

- FFmpeg bundled with the installers: done (7.1.5, audio-only, LGPL, signature-checked source
  pinned by SHA-256; Windows installer tested on a PC without FFmpeg).
- First run of the GitHub release workflow; signed update packages (updater key in GitHub secrets).
- macOS build tested on Apple Silicon: done (November 2026, Apple M5, macOS 26). Tests pass,
  transcription runs on the GPU through Metal (about 11x real time end to end), the DMG with
  the bundled FFmpeg builds and is ad-hoc signed. See the macOS notes in BUILDING.md.

## 1. Studies and interviews (done, November 2026)

- Studies that hold interviews and participants, with study-wide defaults (language, names and
  terms, pause threshold, speaker labels, participant codes, tags, participant attributes).
- Interview details: participant, date, interviewer, tags, notes, review status
  (to check, checked, anonymised, done).
- Speakers named automatically by role (interviewer / participant code).
- Several recordings at once, each its own interview; a transcription queue ("Transcribe all").
- Recordings that are not interviews, such as a lecture or presentation: "New transcription"
  opens an import dialog for audio or video that asks the kind of recording, and one speaker
  skips telling voices apart (done, November 2026).
- Participants table with attributes, exportable as CSV.

Several participants per interview (focus groups) are supported. After a restart the queue is
not resumed by itself, but "Transcribe all" picks up every interview that is not done yet.

## 2. Export for analysis software (QDA) (done, November 2026)

Done: MAXQDA/ATLAS.ti timestamps, NVivo table, study export (files, participants CSV, original
recordings), REFI-QDA `.qdpx` (validated against the official schema and read back with
pyrefiqda), WebVTT, clean reading version, quote list. Still open: PDF, and testing the
imports in the analysis programs themselves.

- MAXQDA and ATLAS.ti: timestamps in the `#hh:mm:ss-x#` format (f4 style) at the end of each
  paragraph, so imported transcripts stay linked to the audio.
- NVivo: Word table with time span, speaker and content columns.
- An interview's export can include its trimmed and aligned audio (mono MP3, M4A or WAV, same name); the
  times then count from the start of that file (done, November 2026).
- Export a whole study at once: one file per interview, optionally with the audio, plus a
  participants table (CSV) for document or case variables.
- REFI-QDA project exchange (`.qdpx`): one file per study with all interviews, participant
  variables and tags, readable by ATLAS.ti, MAXQDA, NVivo and others. Test whether the link
  between transcript and audio survives the import.
- Further formats: PDF, VTT, a clean reading version without fillers and pause tags, and a
  quote list (see 6).

## 3. Anonymisation for ethics committees (done, November 2026)

Done as described below, with one change: the rules are applied when exporting instead of
changing the transcript, so the transcript stays complete and checkable.

- One pseudonym list per study, used consistently across all interviews.
- Suggestions: capitalised words, names from the names list, places, numbers and dates. Since
  November 2026 a guided check ("Find automatically") that goes through them one by one
  (replace, keep, later). A local name-finding model (GLiNER x-small, 189 MB) was tested for it
  and left out: on a 2h21 Dutch interview it found no real name that the capitalisation rule
  missed, and its labels (person, place, organisation) were often wrong. See DEVLOG.md.
- Visible replacements (`[colleague 1]`) instead of silent substitutions.
- Anonymisation log, exported separately from the transcripts.
- Original and anonymised version side by side; exports choose which.

## 4. Faster correcting (done, November 2026)

- Auto-rewind of one to two seconds when playback stops; configurable hotkeys (foot pedals send
  key presses).
- Split and merge speaker turns; general find and replace (interview or whole study).
- Dutch spell check in the editor.
- "Checked up to here" marker with progress.
- `[onverstaanbaar hh:mm:ss]` from uncertain stretches with one click.
- A short reply inside the other speaker's turn ("ja, klopt") given to the right speaker as an
  inline `[Name: ja, klopt]` ("Said by…" under a selection), and renaming an interview from the
  editor (done, November 2026).
- Recognition that stops early on unclear audio (far fewer words than speech) is retried with
  beam search; what stays sparse is pointed out calmly in the editor (done, November 2026).

## 5. Transcription conventions (partly done, November 2026)

Done: pause notation at export (own, Dresing & Pehl, Jefferson/GAT), overlap marking with a
microphone per speaker, clean reading version. Still open: non-verbal sounds and splitting a
recording with several conversations.

- Choice per study: true verbatim, Dresing & Pehl, or a clean reading version, all rendered from
  the same transcript.
- Overlapping speech marked automatically when two microphones were used.
- Cleaner speaker turns with a microphone per speaker (done, November 2026, after 0.1.3). Words
  one microphone only heard from the other speaker are removed, down to a single word, a slightly
  different spelling or a garbled stray word. Short reactions ("I can imagine", "wat erg", "ja ja
  ja ja") go inline, and so do listening sounds while the other person is talking. A short answer
  to a question stays a turn of its own. An overlap note is only added while both are really
  talking. Measured in DEVLOG.md.
- Laughter and other non-verbal sounds (small offline sound classifier).
- Split a recording that holds several conversations at the detected change of seats.

## 6. Quotes and search within a study (done, November 2026)

- Highlights and comments in the transcript; a quote list with participant code and timestamp.
- Quote export: numbered, as Word, CSV, text or Markdown, with an audio fragment per quote (MP3,
  M4A or WAV) and optional voice anonymisation: a TV voice (clear and loud, about 80% of words
  still recognised by the speech model) or an irreversible whisper (about 60%), and a beep over
  pseudonymised names, placed by the word timings (done, November 2026).
- Search across all interviews of a study, with the hit in context and a click to the audio.
- Deliberately not: coding schemes and analysis; that belongs in QDA software.

## 7. Credibility (partly done, November 2026)

Done: generated methods paragraph. Still open: validation, citation file and DOI, retention
date.

- Validation on Dutch interview audio: word error rate, filler recall, speaker errors (needs a
  hand-corrected reference).
- Citation file and DOI so the tool can be cited in a methods section.
- Generated methods paragraph and data handling statement per study.
- Retention date per study with a reminder, and a "finish" step that removes audio copies after
  export.

## Later or not at all

- Offline summaries with a local language model: possible, but opt-in; large download and
  methodologically sensitive.
- Translation to English, recording inside the app, encryption per study. (Sharing a study or
  interview as one ZIP file came in 0.1.2.)
- A second recogniser as a cross-check (Cohere Transcribe next to Whisper), tested in November
  2026: about 600 differences per hour of interview, most of them rewording. The useful ones
  (about 5 to 10 better words per hour) sit where a spell checker already finds a non-word.
  Not worth a 1.6 GB download and a second engine for now. See DEVLOG.md.
- Qwen3-ASR 1.7B as the recogniser, looked into in November 2026 (not run): it recognises Dutch,
  but its timestamp model has no Dutch, and in an independent read-speech test it did worse on
  Dutch than Whisper turbo. See DEVLOG.md.
- Switching to voice recognition for the stretches of a two-microphone recording where the
  microphones stop separating the voices (for example after the clip-on microphones were taken
  off), measured in November 2026. Not built: trimming the recording does the same. See DEVLOG.md.
- Not planned: cloud sync, accounts, meeting bots, dictation.
