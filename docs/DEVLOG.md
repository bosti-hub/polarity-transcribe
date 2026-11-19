# Developer log

Experiments that were tried and not (yet) adopted, with what was measured and why. Newest first.
Decisions that did make it into the app are in [ROADMAP.md](ROADMAP.md).

## November 2026: Qwen3-ASR 1.7B (looked into, not run)

**Question.** After the Cohere test below: would [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)
1.7B (Alibaba, Apache-2.0, released early 2026) be a better recogniser for Dutch interviews than
Whisper? Nothing was downloaded or run. This is a desk review of the published material (19
November 2026).

**Findings**
- **Dutch is supported for recognition.** It is one of the 30 named languages of the 1.7B and
  0.6B models (plus 22 Chinese dialects).
- **No Dutch word timestamps.** Timestamps come from a separate model, Qwen3-ForcedAligner-0.6B,
  which covers 11 languages: Chinese, English, Cantonese, French, German, Italian, Japanese,
  Korean, Portuguese, Russian and Spanish. Dutch is not one of them, and each call is limited to
  about 5 minutes of speech. The editor needs a time for every word (click to listen, uncertain
  words, quotes, subtitles), so for Dutch the app would still have to align the words some other
  way, for example by running Whisper as well.
- **Not better on Dutch.** Across all languages the technical report puts it slightly ahead of
  Whisper large-v3 (FLEURS 4.90 vs 5.27 WER, Common Voice 9.18 vs 10.77), but it gives no figure
  per language. An independent test on FLEURS (about 150 read sentences per language) measured
  Dutch at **7.4% WER for Qwen3-ASR 1.7B against 5.7% for Whisper large-v3 turbo**, the model the
  app uses. In that test Whisper turbo also won on most other smaller European languages (Swedish,
  Danish, Finnish, Polish, Czech and others), while Qwen3-ASR won on English, German and French. A
  community fine-tune reports 6.7% zero-shot on Dutch Common Voice. None of this is
  conversational speech, so it says little about interviews, but it shows no advantage for Dutch.
- **Probably not verbatim.** Like Cohere, it is trained to produce clean text. The app's verbatim
  mode depends on Whisper writing out fillers such as "[uhm]".
- **Hard to run in the app.** There is no llama.cpp or whisper.cpp support. GGUF builds run in
  transcribe.cpp or CrispASR, and the transcribe.cpp build failed on this machine during the Cohere
  test (see the workaround below). The aligner needs a fork branch of transcribe.cpp that is not
  upstream yet.

**Decision.** Not tested further. It would be a second engine and a download of about 2 GB (plus
an aligner without Dutch) for a model that, on the evidence available, does not recognise Dutch
better than what the app already uses. Worth another look only if a later version adds Dutch to
the aligner and an independent Dutch benchmark on conversational speech shows a clear gain.

**Sources**
- [Qwen3-ASR on GitHub](https://github.com/QwenLM/Qwen3-ASR): languages, aligner languages, benchmark table
- [Qwen3-ASR technical report](https://arxiv.org/abs/2601.21337) (arXiv 2601.21337)
- [Qwen3-ASR vs Whisper on FLEURS, 30 languages](https://whispernotes.app/blog/qwen3-asr-vs-whisper) (independent, MLX 8-bit vs whisper.cpp)
- [Qwen3-ForcedAligner GGUF for transcribe.cpp](https://huggingface.co/Adit2K/Qwen3-ForcedAligner-0.6B-gguf) and the [CrispASR discussion](https://huggingface.co/Qwen/Qwen3-ASR-0.6B/discussions/12)

## November 2026: a second recogniser and a name-finding model

Two ideas were tested on the same Dutch interview: a second speech model as a "second opinion"
next to Whisper, and a small language model that finds names for the pseudonymisation check.
Both were built far enough to measure, and both were left out for now: they cost a large download,
extra time or extra clicks, for little gain.

The main lesson: a researcher who transcribes verbatim has to listen to the whole interview
anyway. That listening pass is where the time goes. A feature that points at errors you would hear
during that pass anyway saves very little.

**Test material:** one interview of 2:21:45, recorded with one microphone per speaker (`mic1.wav`),
and a 5-minute fragment of it (07:30-12:30). There is **no hand-corrected reference
transcript**, so no word error rates could be measured. `bench-out/correctie_07m30-12m30.txt` is
a template that was never corrected, so earlier comparisons against it were invalid. Machine:
Ryzen 7 7700 and an RTX 5060 Ti (Vulkan).

### Cohere Transcribe as a second opinion (not implemented)

**Idea.** Run a second recogniser on exactly the same audio chunks as Whisper and keep Whisper's
timestamps. Where the two differ, offer the researcher the alternative. Whisper large-v3 instead
of turbo was not an option: earlier tests by the maintainer showed no real gain.

**Setup**
- Cohere Transcribe (`cohere-transcribe-03-2026`), run with [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)
  (MIT, ggml) as GGUF Q4_K_M (1.56 GB) and Q8_0. Both quantisations gave nearly the same
  differences, so Q4_K_M is enough.
- The chunks came from `pt bench --dump-chunks`, so both models heard the same audio.
- Fillers, punctuation and case were ignored when comparing the two transcripts.

**Speed**

| | Whisper large-v3-turbo q8 | Cohere Q4_K_M |
|---|---|---|
| GPU, full interview | 143 s | 108 s (about 75% extra on top of Whisper) |
| CPU, 5-minute fragment, 8 threads | 97 s | 30 s |
| CPU, 5-minute fragment, 4 threads | 161 s | 45 s |

**Differences across the full interview:** 2,430.
- Cohere writes a clean verbatim. It drops repetitions, "ja", "zeg maar" and the like, so the
  1,000 places where only Whisper has words are not useful.
- What is left: 1,242 places where the words differ plus 173 where only Cohere heard something,
  about **600 per hour**.
  Most of these are rewordings ("aan kunnen vragen" → "aanvragen", "dat" ↔ "het") or plain
  Cohere errors ("leelijk", "foreplanting").

**Spell checker as referee.** The Windows spell checker (Spell Checking API, nl-NL) split those
600 per hour into four groups:

| Group | Per hour | What it is |
|---|---|---|
| Whisper wrote a non-word, Cohere a real word | 41 | Nearly all real Whisper errors, and Cohere is mostly right: ontslachtig → omslachtig, groepsbeleiders → groepsleiders, zenuwstelte → zenuwstelsel, gichelen → giechelen |
| Whisper was already unsure (below the yellow threshold) | 188 | Often garbled audio where both models are wrong |
| Both are real words and Whisper was sure | 342 | Mostly Cohere's rewording. The few real catches are hidden in it, for example "bleek" → "bleef" |
| Cohere wrote a non-word | 28 | Whisper is nearly always right |

**Net gain**
- The first group is exactly what a spell checker already finds without Cohere: 157 non-words in
  Whisper's output, 66 per hour, including English code-switching such as "trash" and "social".
- For the single-word cases in that group (41 in the whole interview), the spell checker's own
  suggestions already contained Cohere's word 16 times. Windows also suggested "tactloos" for
  "takloos", where Cohere said "dakloos".
- In the other 25 cases Cohere was right in some ("mogelijkerwijs", "teleurgesteld") and wrong in
  others ("prachtigste", "borderland").
- So the gain is about **5 to 10 better words per hour of interview**, at places that are already
  marked.
- The errors that matter most, real words that are wrong and that Whisper was sure about, cannot be
  picked out of the 342-per-hour group without flooding the researcher.

**Costs**
- A 1.6 GB extra download, and about 75% more time on the GPU.
- A second inference engine next to whisper.cpp.
- On Windows the `transcribe-cpp-sys` build script failed (MSBuild MSB1009 through a junction in
  `%LOCALAPPDATA%`). It only worked with a manual CMake build and `TRANSCRIBE_DIR`. macOS was not
  tried.
- The spell-check referee needs a Dutch spell checker installed in the operating system.

**Revisit if** a hand-corrected reference shows that the cross-check finds real-word errors with
few false alarms, or if a second model appears that writes true verbatim.

### Name finder for the pseudonymisation check (removed)

**Idea.** Find names, places and organisations with a small multilingual NER model, so that "Find
automatically" also knows what kind a term is and catches names a capitalisation rule misses.

**Models tried** (GLiNER family, run with ONNX Runtime, which the app already has for the speaker
model)
- **knowledgator/gliner-x-small** (mt5-small, Apache-2.0): 8-bit ONNX of 173 MB plus a 16 MB
  tokenizer, 189 MB in total. The full interview took 7.6 s with 8 threads and 11.2 s with 4.
- **gliner-x-base:** no better.
- **urchade/gliner_multi_pii-v1:** useless on Dutch (highest score 0.32).
- **gliner-pii-edge:** English only.

**Result on the full interview** (after filtering fillers and ordinary words for both methods)

| | Terms to go through | Only in this list |
|---|---|---|
| With the model | 38 | LVB, N1, N.E, Duitsers, plus false hits such as "Verbaal" and "Baby-jongetjes" |
| Capitalisation rule only | 35 | Campina, Beethoven, "Mocht" |

- Every real person and place name (Alex, Jantine, Floris, Anton, Saskia, Jörg Korn, Delft,
  Loosdrecht and so on) was found by both.
- The model's labels were often wrong: "Japanner", "Fanta" and "Italianen" became a person,
  "UvA" a place, and "LVB" (here most likely a diagnosis) an organisation.
- On the 5-minute fragment the model found 2 terms and the rule 1. The extra one, "Verbaal", is a
  false hit.

**Costs**
- 189 MB to download, and one more choice for the user.
- The Hugging Face `tokenizers` crate with Oniguruma, a C library, in the build.
- A model pinned to a Hugging Face commit.

**Decision.** Removed before it was committed. "Find automatically" uses the capitalisation rule,
the names list and patterns for dates, numbers, postcodes, e-mail addresses and phone numbers.
The test did improve the rule:
- capitals at the start of a sentence no longer count as evidence for a name;
- interjections such as "Alright" and "Goh" are on the list of ordinary words.

**Revisit if** tests on more interviews show names that the rule misses, for example names that
only ever appear at the start of a sentence. Technical notes for a new attempt:
- GLiNER in span mode (markerV0). The prompt is `<<ENT>> person <<ENT>> location ... <<SEP>>`
  followed by the words.
- ONNX inputs: `input_ids`, `attention_mask`, `words_mask`, `text_lengths`, `span_idx`,
  `span_mask` (bool). The logits have the shape [1, words, 12, labels].
- Decoding: sigmoid above 0.5, then the best spans that do not overlap.
- Feed windows of about 160 words that end at a sentence end.
- Remove fillers first: the model takes a capitalised "Eh" for a name.

### Where the material is

None of this is in git:
- the analysis output is in `bench-out/xc/`;
- the scripts are in `.tools/scripts/`: `xcheck.py`, `xtiers.py`, `xspell.py`, `xspellonly.py`
  and `winspell.cs` / `winspell.ps1`.

The models and the transcribe.cpp builds were deleted after the test. `pt bench --dump-chunks`
stays in the command-line tool, so the comparison can be repeated with another recogniser.
