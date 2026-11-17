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
- macOS build tested on Apple Silicon.

## 1. Studies and interviews (done, November 2026)

- Studies that hold interviews and participants, with study-wide defaults (language, names and
  terms, pause threshold, speaker labels, participant codes, tags, participant attributes).
- Interview details: participant, date, interviewer, tags, notes, review status
  (to check, checked, anonymised, done).
- Speakers named automatically by role (interviewer / participant code).
- Several recordings at once, each its own interview; a transcription queue ("Transcribe all").
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
- Export a whole study at once: one file per interview, optionally with the audio, plus a
  participants table (CSV) for document or case variables.
- REFI-QDA project exchange (`.qdpx`): one file per study with all interviews, participant
  variables and tags, readable by ATLAS.ti, MAXQDA, NVivo and others. Test whether the link
  between transcript and audio survives the import.
- Further formats: PDF, VTT, a clean reading version without fillers and pause tags, and a
  quote list (see 6).

## 3. Anonymisation for ethics committees (done, November 2026)

Done as described below, with one change: the rules are applied when exporting instead of
changing the transcript, so the transcript stays complete and checkable (permanent apply is
still available).

- One pseudonym list per study, used consistently across all interviews.
- Suggestions: capitalised words, names from the names list, places, numbers and dates.
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

## 5. Transcription conventions (partly done, November 2026)

Done: pause notation at export (own, Dresing & Pehl, Jefferson/GAT), overlap marking with a
microphone per speaker, clean reading version. Still open: non-verbal sounds and splitting a
recording with several conversations.

- Choice per study: true verbatim, Dresing & Pehl, or a clean reading version, all rendered from
  the same transcript.
- Overlapping speech marked automatically when two microphones were used.
- Laughter and other non-verbal sounds (small offline sound classifier).
- Split a recording that holds several conversations at the detected change of seats.

## 6. Quotes and search within a study (done, November 2026)

- Highlights and comments in the transcript; a quote list with participant code and timestamp.
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
- Translation to English, recording inside the app, encryption per study, sharing a study as a
  single file with a supervisor.
- Not planned: cloud sync, accounts, meeting bots, dictation.
