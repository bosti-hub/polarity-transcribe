//! Turns recognised words into a readable verbatim transcript:
//! speaker turns, inline backchannels, bracketed fillers and measured pauses.

use crate::activity::covered_seconds;
use crate::asr::Language;
use crate::lexicon::{is_backchannel, is_filler, normalize};
use crate::transcript::{default_speaker_name, ms, speaker_id, Item, Paragraph, Speaker, Transcript};
use crate::vad::Span;

/// A recognised word on the project timeline.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SpokenWord {
    pub speaker: usize,
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub prob: f32,
}

pub struct AssembleOpts {
    pub language: Language,
    /// Silences longer than this get a pause tag (seconds).
    pub pause_threshold: f64,
    pub speaker_count: usize,
    /// Mark speech that overlaps another speaker's turn. Only meaningful when each speaker
    /// has their own microphone: otherwise the speaker detection never lets turns overlap.
    pub mark_overlap: bool,
}

/// Overlap shorter than this is ordinary turn-taking, not talking at the same time.
const MIN_OVERLAP: f64 = 0.5;

fn overlap_note(lang: Language, at: f64) -> Item {
    let t = match lang {
        Language::Nl => "[door elkaar]",
        Language::En => "[overlapping]",
    };
    Item::Note { t: t.to_string(), s: Some(ms(at)) }
}

/// Tighten word times against the speaker's speech spans.
///
/// Attention-based word times are good to roughly a tenth of a second but include adjacent
/// silence. Clipping to voice activity gives click-to-play a clean start and keeps words out
/// of measured pauses.
pub fn refine_times(words: &mut [SpokenWord], speech: &[Span]) {
    for w in words.iter_mut() {
        let i = speech.partition_point(|s| s.end <= w.start);
        let Some(span) = speech.get(i) else { continue };
        if span.start > w.start {
            // Word starts in silence: move to the speech onset if that is close.
            if span.start - w.start <= 0.6 && span.start < w.end + 0.3 {
                w.start = span.start;
            } else {
                continue;
            }
        }
        if w.end > span.end && span.end > w.start + 0.04 {
            // Does the word continue in the next span after a tiny gap? Then keep it.
            let continues = speech.get(i + 1).is_some_and(|n| n.start - span.end < 0.15 && n.start < w.end);
            if !continues {
                w.end = span.end;
            }
        }
        if w.end < w.start + 0.04 {
            w.end = w.start + 0.04;
        }
    }
    for i in 1..words.len() {
        if words[i].start < words[i - 1].start {
            words[i].start = words[i - 1].start;
            words[i].end = words[i].end.max(words[i].start + 0.04);
        }
        if words[i - 1].end > words[i].start {
            words[i - 1].end = words[i].start.max(words[i - 1].start);
        }
    }
}

/// Drop words that a microphone only picked up as bleed: the same words appear at the same
/// time on the other speaker's track, and that speaker owns the passage.
pub fn drop_cross_talk(words: [Vec<SpokenWord>; 2], spans: &[Vec<Span>; 2]) -> Vec<SpokenWord> {
    let [a, b] = words;
    let mut keep_a = vec![true; a.len()];
    let mut keep_b = vec![true; b.len()];
    let mut j0 = 0usize;
    let mut i = 0usize;
    while i < a.len() {
        while j0 < b.len() && b[j0].end < a[i].start - 1.0 {
            j0 += 1;
        }
        // Find a run of identical words starting at a[i] and some nearby b[j].
        let mut best = (0usize, 0usize); // (j, run length)
        let mut j = j0;
        while j < b.len() && b[j].start <= a[i].start + 1.0 {
            let mut run = 0;
            while i + run < a.len()
                && j + run < b.len()
                && normalize(&a[i + run].text) == normalize(&b[j + run].text)
                && !normalize(&a[i + run].text).is_empty()
                && (a[i + run].start - b[j + run].start).abs() < 1.0
            {
                run += 1;
            }
            if run > best.1 {
                best = (j, run);
            }
            j += 1;
        }
        let (j, run) = best;
        let chars: usize = (0..run).map(|k| normalize(&a[i + k].text).chars().count()).sum();
        if run >= 2 || (run == 1 && chars >= 6) {
            let (t0, t1) = (a[i].start.min(b[j].start), a[i + run - 1].end.max(b[j + run - 1].end));
            let own_a = covered_seconds(&spans[0], t0, t1);
            let own_b = covered_seconds(&spans[1], t0, t1);
            let drop_a = own_a < own_b;
            for k in 0..run {
                if drop_a {
                    keep_a[i + k] = false;
                } else {
                    keep_b[j + k] = false;
                }
            }
            i += run;
        } else {
            i += 1;
        }
    }
    let mut out: Vec<SpokenWord> = a
        .into_iter()
        .zip(keep_a)
        .chain(b.into_iter().zip(keep_b))
        .filter(|(_, k)| *k)
        .map(|(w, _)| w)
        .collect();
    out.sort_by(|x, y| x.start.total_cmp(&y.start));
    out
}

/// Give each word of a shared stream to the speaker who was talking at that moment.
///
/// `spans[k]` are speaker k's speech spans. The spans say very precisely *when* the speaker
/// changes; recognised word times are less precise (a few tenths of a second, usually late).
/// Speakers mostly change between sentences, so each change is snapped to a nearby sentence
/// boundary in the text when there is one, and placed by time otherwise.
///
/// `slack` (seconds) widens the search for that sentence boundary. It is zero when the spans
/// come from the microphones (accurate to a few hundredths of a second) and larger when they
/// come from comparing voices, which only locates a change to within about a second.
pub fn assign_speakers(words: &mut [SpokenWord], spans: &[Vec<Span>], lang: Language, slack: f64) {
    if words.is_empty() || spans.is_empty() {
        return;
    }
    assign_by_turn_order(words, spans, lang, slack);
    settle_sentences(words, spans);
}

/// Sentences are the unit of a speaker turn: nobody takes over for the last word of someone
/// else's sentence. After the first pass, which follows the order of the turns and is right about
/// short answers ("Ja, klopt."), every longer sentence goes as a whole to whoever was talking
/// during most of it. That makes the result immune to brief flickers in the speaker detection
/// and to recognised word times being a few tenths of a second off.
///
/// A long "sentence" that is really a question and its answer run together (the recogniser left
/// out the full stop) is cut where the speaker clearly changes.
fn settle_sentences(words: &mut [SpokenWord], spans: &[Vec<Span>]) {
    /// Below this length the timing is too coarse to outvote the order of the turns.
    const SHORT: f64 = 1.2;
    let n = words.len();
    let mut a = 0usize;
    while a < n {
        let mut b = a;
        while b + 1 < n && !word_ends_sentence(&words[b]) && words[b + 1].start - words[b].end < 1.0 {
            b += 1;
        }
        if words[b].end - words[a].start < SHORT {
            // Short: keep what the turn order said, but as one piece.
            let mut count = vec![0usize; spans.len().max(words[a..=b].iter().map(|w| w.speaker + 1).max().unwrap_or(1))];
            for w in &words[a..=b] {
                count[w.speaker] += 1;
            }
            let first = words[a].speaker;
            let best = (0..count.len()).max_by_key(|&k| (count[k], k == first)).unwrap_or(first);
            for w in &mut words[a..=b] {
                w.speaker = best;
            }
        } else {
            vote(words, spans, a, b, 0);
        }
        a = b + 1;
    }
}

fn word_ends_sentence(w: &SpokenWord) -> bool {
    w.text.ends_with(['.', '?', '!'])
}

/// Seconds of word `w` during which speaker `k` was talking.
fn word_cover(w: &SpokenWord, spans: &[Span]) -> f64 {
    covered_seconds(spans, w.start, w.end.max(w.start + 0.08))
}

/// Give words `a..=b` to the speaker who talked most during them, or cut the stretch in two where
/// one speaker clearly hands over to another.
fn vote(words: &mut [SpokenWord], spans: &[Vec<Span>], a: usize, b: usize, depth: usize) {
    let k_n = spans.len();
    let len = b - a + 1;
    // prefix[k][i] = cover of speaker k over the first i words of the stretch.
    let prefix: Vec<Vec<f64>> = (0..k_n)
        .map(|k| {
            let mut acc = Vec::with_capacity(len + 1);
            acc.push(0.0);
            for w in &words[a..=b] {
                acc.push(acc.last().unwrap() + word_cover(w, &spans[k]));
            }
            acc
        })
        .collect();
    let total = |k: usize| prefix[k][len];
    let whole = (0..k_n).max_by(|&x, &y| total(x).total_cmp(&total(y))).unwrap();
    if total(whole) <= 0.0 {
        return; // nobody was detected here: leave the first pass's answer
    }

    // Best single hand-over: speaker x up to word i, speaker y from word i on.
    let mut best: Option<(f64, usize, usize, usize)> = None;
    if depth < 4 && len >= 4 {
        for i in 2..=len - 2 {
            for x in 0..k_n {
                for y in 0..k_n {
                    if x == y {
                        continue;
                    }
                    let left = prefix[x][i];
                    let right = total(y) - prefix[y][i];
                    // Each side must be a real stretch of speech, mostly by its own speaker.
                    let left_other = prefix[y][i];
                    let right_other = total(x) - prefix[x][i];
                    if left < 0.6 || right < 0.6 || left < 2.0 * left_other || right < 2.0 * right_other {
                        continue;
                    }
                    // People hand over at a pause in the sentence rather than mid-phrase.
                    let comma = if words[a + i - 1].text.ends_with([',', ';', ':']) { 0.15 } else { 0.0 };
                    let value = left + right + comma;
                    if best.map(|(v, ..)| value > v).unwrap_or(true) {
                        best = Some((value, i, x, y));
                    }
                }
            }
        }
    }
    match best {
        Some((value, i, _, _)) if value >= total(whole) + 0.8 => {
            vote(words, spans, a, a + i - 1, depth + 1);
            vote(words, spans, a + i, b, depth + 1);
        }
        _ => {
            for w in &mut words[a..=b] {
                w.speaker = whole;
            }
        }
    }
}

/// First pass: follow the order of the speaker turns.
fn assign_by_turn_order(words: &mut [SpokenWord], spans: &[Vec<Span>], lang: Language, slack: f64) {
    if words.is_empty() {
        return;
    }
    // Speaker runs in time order; consecutive spans of one speaker form one run.
    let mut all: Vec<(f64, f64, usize)> =
        spans.iter().enumerate().flat_map(|(k, s)| s.iter().map(move |x| (x.start, x.end, k))).collect();
    all.sort_by(|x, y| x.0.total_cmp(&y.0));
    let merge = |runs: Vec<(f64, f64, usize)>| -> Vec<(f64, f64, usize)> {
        let mut out: Vec<(f64, f64, usize)> = Vec::new();
        for r in runs {
            match out.last_mut() {
                Some(last) if last.2 == r.2 => last.1 = last.1.max(r.1),
                _ => out.push(r),
            }
        }
        out
    };
    let mut runs = merge(all);
    // A blip of another speaker inside someone's sentence is a stray reflection, not a turn.
    let keep: Vec<bool> = (0..runs.len())
        .map(|i| {
            let blip = runs[i].1 - runs[i].0 < 0.15;
            let inside = i > 0 && i + 1 < runs.len() && runs[i - 1].2 == runs[i + 1].2;
            !(blip && inside)
        })
        .collect();
    let mut k = keep.iter();
    runs.retain(|_| *k.next().unwrap());
    let runs = merge(runs);
    if runs.is_empty() {
        return;
    }

    // Sentence boundaries: (time between the two words, index of the word after it).
    let boundaries: Vec<(f64, usize)> = (0..words.len() - 1)
        .filter(|&i| words[i].text.ends_with(['.', '?', '!']))
        .map(|i| ((words[i].end + words[i + 1].start) / 2.0, i + 1))
        .collect();

    // Where each change of speaker falls in the word sequence.
    let mut splits: Vec<(usize, usize)> = Vec::with_capacity(runs.len()); // (first word index, speaker)
    let mut last = 0usize;
    for pair in runs.windows(2) {
        let change = (pair[0].1 + pair[1].0) / 2.0;
        let snapped = boundaries
            .iter()
            // `> last`: the speaker whose run ends here keeps at least one word.
            .filter(|(t, i)| *i > last && *t >= change - 0.15 - slack && *t <= change + 0.45 + slack)
            .min_by(|x, y| (x.0 - change).abs().total_cmp(&(y.0 - change).abs()))
            .map(|(_, i)| *i);
        let at = snapped.unwrap_or_else(|| {
            let by_time = words.partition_point(|w| (w.start + w.end) / 2.0 <= change);
            by_time.max(last)
        });
        splits.push((at, pair[1].2));
        last = at;
    }
    let mut speaker = runs[0].2;
    let mut next = 0usize;
    for (i, w) in words.iter_mut().enumerate() {
        while next < splits.len() && splits[next].0 <= i {
            speaker = splits[next].1;
            next += 1;
        }
        w.speaker = speaker;
    }

    // A few words that change speaker in the middle of someone else's sentence are almost
    // always a labelling slip. Keep them only if they can stand on their own: a listening
    // sound ("ja", "hm-hm") or a complete short sentence ("Prima.").
    let ends = |w: &SpokenWord| w.text.ends_with(['.', '?', '!']);
    let mut i = 0usize;
    while i < words.len() {
        let mut j = i;
        while j + 1 < words.len() && words[j + 1].speaker == words[i].speaker {
            j += 1;
        }
        let flanked = i > 0 && j + 1 < words.len() && words[i - 1].speaker == words[j + 1].speaker;
        if flanked && j - i < 3 && words[j].end - words[i].start < 1.5 {
            let texts: Vec<&str> = words[i..=j].iter().map(|w| w.text.as_str()).collect();
            let own_sentence = ends(&words[i - 1]) && ends(&words[j]);
            if !is_backchannel(&texts, lang) && !own_sentence {
                let host = words[i - 1].speaker;
                for w in &mut words[i..=j] {
                    w.speaker = host;
                }
            }
        }
        i = j + 1;
    }
}

fn bracket_filler(text: &str) -> String {
    let start = text.find(|c: char| c.is_alphanumeric()).unwrap_or(0);
    let end = text.rfind(|c: char| c.is_alphanumeric()).map(|i| i + text[i..].chars().next().unwrap().len_utf8()).unwrap_or(text.len());
    format!("{}[{}]{}", &text[..start], text[start..end].to_lowercase(), &text[end..])
}

struct Utterance {
    speaker: usize,
    words: Vec<SpokenWord>,
}

impl Utterance {
    fn start(&self) -> f64 {
        self.words[0].start
    }
    fn end(&self) -> f64 {
        self.words.last().unwrap().end
    }
}

struct Turn {
    speaker: usize,
    items: Vec<Item>,
}

fn word_item(w: &SpokenWord, lang: Language) -> Item {
    let filler = is_filler(&w.text, lang);
    Item::Word {
        t: if filler { bracket_filler(&w.text) } else { w.text.clone() },
        s: ms(w.start),
        e: ms(w.end),
        c: (w.prob * 100.0).round() / 100.0,
        f: filler,
    }
}

fn ends_sentence(item: &Item) -> bool {
    matches!(item, Item::Word { t, .. } if t.ends_with(['.', '?', '!']))
}

/// Build the transcript.
///
/// `words` may be in any order. `speech` is the union of everyone's voice activity and is used
/// to measure pauses from the audio itself rather than from word timestamps.
pub fn assemble(mut words: Vec<SpokenWord>, speech: &[Span], duration: f64, opts: &AssembleOpts) -> Transcript {
    let lang = opts.language;
    words.retain(|w| !w.text.trim().is_empty());
    words.sort_by(|a, b| a.start.total_cmp(&b.start));

    // 1. Utterances: runs of one speaker's words without a long gap.
    const UTTERANCE_GAP: f64 = 1.0;
    let n_speakers = opts.speaker_count.max(words.iter().map(|w| w.speaker + 1).max().unwrap_or(1));
    let mut open: Vec<Option<Utterance>> = (0..n_speakers).map(|_| None).collect();
    let mut utterances: Vec<Utterance> = Vec::new();
    for w in words {
        let slot = &mut open[w.speaker];
        match slot {
            Some(u) if w.start - u.end() <= UTTERANCE_GAP => u.words.push(w),
            _ => {
                if let Some(u) = slot.take() {
                    utterances.push(u);
                }
                *slot = Some(Utterance { speaker: w.speaker, words: vec![w] });
            }
        }
    }
    utterances.extend(open.into_iter().flatten());
    utterances.sort_by(|a, b| a.start().total_cmp(&b.start()));

    // 2. Turns, with listening sounds folded into the main speaker's turn.
    let mut turns: Vec<Turn> = Vec::new();
    for (idx, u) in utterances.iter().enumerate() {
        let Some(cur) = turns.last_mut() else {
            turns.push(Turn { speaker: u.speaker, items: u.words.iter().map(|w| word_item(w, lang)).collect() });
            continue;
        };
        if cur.speaker == u.speaker {
            cur.items.extend(u.words.iter().map(|w| word_item(w, lang)));
            continue;
        }
        let cur_end = cur.items.iter().filter_map(|i| i.end()).fold(0.0, f64::max);
        let texts: Vec<&str> = u.words.iter().map(|w| w.text.as_str()).collect();
        let short = u.end() - u.start() <= 2.0 && is_backchannel(&texts, lang);
        // The main speaker keeps the floor if they are still talking, or resume right away.
        let main_continues = cur_end > u.start() + 0.05
            || utterances.get(idx + 1).is_some_and(|n| n.speaker == cur.speaker && n.start() - u.end() <= 2.5);
        if short && main_continues {
            let text = u
                .words
                .iter()
                .map(|w| w.text.trim_end_matches(['.', ',']).to_lowercase())
                .collect::<Vec<_>>()
                .join(" ");
            let item = Item::Backchannel { sp: speaker_id(u.speaker), t: text, s: ms(u.start()), e: ms(u.end()) };
            let at = cur.items.iter().position(|i| i.start().is_some_and(|s| s > u.start())).unwrap_or(cur.items.len());
            cur.items.insert(at, item);
            continue;
        }
        // A real interruption: split the current turn where the other speaker comes in.
        let split = cur.items.iter().position(|i| i.start().is_some_and(|s| s >= u.start() + 0.05));
        let tail = match split {
            Some(at) if at > 0 => Some(Turn { speaker: cur.speaker, items: cur.items.split_off(at) }),
            _ => None,
        };
        let mut items: Vec<Item> = Vec::with_capacity(u.words.len() + 1);
        if opts.mark_overlap && cur_end - u.start() >= MIN_OVERLAP {
            items.push(overlap_note(lang, u.start()));
        }
        items.extend(u.words.iter().map(|w| word_item(w, lang)));
        turns.push(Turn { speaker: u.speaker, items });
        if let Some(t) = tail {
            turns.push(t);
        }
    }

    // 3. Pauses measured on the audio: gaps in everyone's voice activity.
    let mut silences: Vec<Span> = Vec::new();
    let mut prev_end = 0.0;
    for s in speech {
        if s.start - prev_end >= opts.pause_threshold {
            silences.push(Span::new(prev_end, s.start));
        }
        prev_end = prev_end.max(s.end);
    }
    let first_word = turns.iter().flat_map(|t| &t.items).filter_map(|i| i.start()).fold(f64::INFINITY, f64::min);
    let last_word = turns.iter().flat_map(|t| &t.items).filter_map(|i| i.end()).fold(0.0, f64::max);
    silences.retain(|s| s.end > first_word && s.start < last_word);
    for sil in silences {
        // A word in the middle of a "silence" means the voice detector missed quiet speech.
        let has_word = turns.iter().flat_map(|t| &t.items).any(|i| match (i.start(), i.end()) {
            (Some(s), Some(e)) => {
                let mid = (s + e) / 2.0;
                mid > sil.start + 0.2 && mid < sil.end - 0.2
            }
            _ => false,
        });
        if has_word {
            continue;
        }
        // Insert before the first item that starts after the silence.
        'place: for turn in turns.iter_mut() {
            for at in 0..turn.items.len() {
                if turn.items[at].start().is_some_and(|s| s >= sil.end - 0.3) {
                    turn.items.insert(at, Item::Pause { s: ms(sil.start), e: ms(sil.end) });
                    break 'place;
                }
            }
        }
    }

    // 4. Paragraphs: break very long turns at sentence ends for readability.
    const SOFT_LIMIT: usize = 110;
    let mut paragraphs: Vec<Paragraph> = Vec::new();
    for turn in turns {
        let mut current: Vec<Item> = Vec::new();
        let mut count = 0usize;
        let mut pieces: Vec<Vec<Item>> = Vec::new();
        for item in turn.items {
            let boundary = ends_sentence(&item);
            if matches!(item, Item::Word { .. }) {
                count += 1;
            }
            current.push(item);
            if boundary && count >= SOFT_LIMIT {
                pieces.push(std::mem::take(&mut current));
                count = 0;
            }
        }
        if !current.is_empty() {
            // Avoid a tiny trailing paragraph.
            match pieces.last_mut() {
                Some(last) if count < 12 => last.extend(current),
                _ => pieces.push(current),
            }
        }
        for items in pieces {
            let start = items.iter().filter_map(|i| i.start()).fold(f64::INFINITY, f64::min);
            let end = items.iter().filter_map(|i| i.end()).fold(0.0, f64::max);
            paragraphs.push(Paragraph {
                id: format!("p{}", paragraphs.len() + 1),
                speaker: speaker_id(turn.speaker),
                start: if start.is_finite() { ms(start) } else { 0.0 },
                end: ms(end),
                items,
            });
        }
    }

    Transcript {
        version: 1,
        language: lang,
        duration: ms(duration),
        speakers: (0..n_speakers).map(|i| Speaker { id: speaker_id(i), name: default_speaker_name(i, lang) }).collect(),
        paragraphs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(speaker: usize, text: &str, start: f64, end: f64) -> SpokenWord {
        SpokenWord { speaker, text: text.into(), start, end, prob: 0.9 }
    }

    fn opts() -> AssembleOpts {
        AssembleOpts { language: Language::Nl, pause_threshold: 3.0, speaker_count: 2, mark_overlap: false }
    }

    fn text(p: &Paragraph) -> String {
        p.items
            .iter()
            .map(|i| match i {
                Item::Word { t, .. } => t.clone(),
                Item::Pause { s, e } => format!("[stilte {:.1}s]", e - s),
                Item::Backchannel { sp, t, .. } => format!("[{sp}: {t}]"),
                Item::Note { t, .. } => t.clone(),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn fillers_are_bracketed() {
        assert_eq!(bracket_filler("Uhm,"), "[uhm],");
        assert_eq!(bracket_filler("hmm..."), "[hmm]...");
        let t = assemble(vec![w(0, "Uhm,", 0.0, 0.3), w(0, "ja.", 0.4, 0.6)], &[Span::new(0.0, 0.6)], 1.0, &opts());
        assert_eq!(text(&t.paragraphs[0]), "[uhm], ja.");
    }

    #[test]
    fn backchannel_goes_inline_when_the_speaker_continues() {
        let words = vec![
            w(0, "Ik", 0.0, 0.2),
            w(0, "denk", 0.2, 0.5),
            w(0, "dat", 0.5, 0.7),
            w(1, "Hm-hm.", 0.75, 1.0),
            w(0, "het", 1.1, 1.3),
            w(0, "klopt.", 1.3, 1.7),
            w(1, "Waarom", 2.4, 2.8),
            w(1, "denk", 2.8, 3.0),
            w(1, "je", 3.0, 3.1),
            w(1, "dat?", 3.1, 3.4),
        ];
        let t = assemble(words, &[Span::new(0.0, 3.4)], 4.0, &opts());
        assert_eq!(t.paragraphs.len(), 2);
        assert_eq!(text(&t.paragraphs[0]), "Ik denk dat [S2: hm-hm] het klopt.");
        assert_eq!(t.paragraphs[1].speaker, "S2");
    }

    #[test]
    fn a_short_answer_stays_its_own_turn() {
        let words = vec![
            w(0, "Klinkt", 0.0, 0.3),
            w(0, "dat", 0.3, 0.5),
            w(0, "goed?", 0.5, 0.9),
            w(1, "Ja.", 1.3, 1.6),
            w(1, "Prima.", 5.0, 5.4),
        ];
        let t = assemble(words, &[Span::new(0.0, 0.9), Span::new(1.3, 1.6), Span::new(5.0, 5.4)], 6.0, &opts());
        assert_eq!(t.paragraphs.len(), 2);
        assert_eq!(text(&t.paragraphs[1]), "Ja. [stilte 3.4s] Prima.");
    }

    #[test]
    fn interruption_splits_the_turn() {
        let mut words = vec![];
        for (i, t) in ["Dus", "ik", "ging", "daarheen", "en", "toen", "zei", "hij"].iter().enumerate() {
            words.push(w(0, t, i as f64 * 0.3, i as f64 * 0.3 + 0.25));
        }
        for (i, t) in ["Maar", "wacht", "even,", "wanneer", "was", "dat?"].iter().enumerate() {
            words.push(w(1, t, 1.2 + i as f64 * 0.3, 1.2 + i as f64 * 0.3 + 0.25));
        }
        let t = assemble(words, &[Span::new(0.0, 3.0)], 3.0, &opts());
        let speakers: Vec<&str> = t.paragraphs.iter().map(|p| p.speaker.as_str()).collect();
        assert_eq!(speakers, ["S1", "S2", "S1"]);
        // "en" starts together with the interruption and stays with the first part.
        assert_eq!(text(&t.paragraphs[0]), "Dus ik ging daarheen en");

        // With a microphone per speaker the overlap is real, and marked where it starts.
        let marked = assemble(words_again(), &[Span::new(0.0, 3.0)], 3.0, &AssembleOpts { mark_overlap: true, ..opts() });
        assert!(matches!(&marked.paragraphs[1].items[0], Item::Note { t, s: Some(s) } if t == "[door elkaar]" && (*s - 1.2).abs() < 1e-9));
        assert!(!t.paragraphs[1].items.iter().any(|i| matches!(i, Item::Note { .. })));
    }

    fn words_again() -> Vec<SpokenWord> {
        let mut words = vec![];
        for (i, t) in ["Dus", "ik", "ging", "daarheen", "en", "toen", "zei", "hij"].iter().enumerate() {
            words.push(w(0, t, i as f64 * 0.3, i as f64 * 0.3 + 0.25));
        }
        for (i, t) in ["Maar", "wacht", "even,", "wanneer", "was", "dat?"].iter().enumerate() {
            words.push(w(1, t, 1.2 + i as f64 * 0.3, 1.2 + i as f64 * 0.3 + 0.25));
        }
        words
    }

    #[test]
    fn duplicated_bleed_words_are_dropped_from_the_wrong_track() {
        let a = vec![w(0, "Dat", 1.0, 1.2), w(0, "is", 1.2, 1.3), w(0, "waar.", 1.3, 1.6)];
        let b = vec![w(1, "dat", 1.05, 1.2), w(1, "is", 1.2, 1.35), w(1, "waar", 1.35, 1.6), w(1, "Ja.", 2.0, 2.2)];
        let spans = [vec![Span::new(0.9, 1.7)], vec![Span::new(1.9, 2.3)]];
        let out = drop_cross_talk([a, b], &spans);
        let who: Vec<(usize, &str)> = out.iter().map(|w| (w.speaker, w.text.as_str())).collect();
        assert_eq!(who, [(0, "Dat"), (0, "is"), (0, "waar."), (1, "Ja.")]);
    }

    #[test]
    fn speaker_changes_snap_to_sentence_boundaries() {
        // The recogniser places "Ja, klopt." a quarter of a second late.
        let mut words = vec![
            w(0, "op", 9.1, 9.3),
            w(0, "je", 9.3, 9.7),
            w(0, "werksituatie.", 9.7, 10.6),
            w(0, "Ja,", 10.7, 10.8),
            w(0, "klopt.", 11.0, 11.3),
            w(0, "En", 11.4, 11.8),
            w(0, "vandaag", 11.8, 12.0),
        ];
        let spans = vec![
            vec![Span::new(0.0, 10.45), Span::new(10.72, 10.82), Span::new(11.0, 20.0)],
            vec![Span::new(10.5, 10.7), Span::new(10.85, 11.0)],
        ];
        assign_speakers(&mut words, &spans, Language::Nl, 0.0);
        let who: Vec<usize> = words.iter().map(|w| w.speaker).collect();
        assert_eq!(who, [0, 0, 0, 1, 1, 0, 0]);
    }

    #[test]
    fn a_flicker_in_speaker_detection_does_not_split_a_sentence() {
        // Speaker 1 answers in two sentences; the detection briefly flips to speaker 0 twice
        // and the last word of the first sentence is recognised late.
        let mut words = vec![
            w(0, "hadden?", 30.4, 30.7),
            w(0, "ja,", 31.66, 31.72),
            w(0, "heb", 31.86, 31.94),
            w(0, "ik", 31.94, 32.04),
            w(0, "inderdaad", 32.04, 32.34),
            w(0, "wel", 32.34, 32.54),
            w(0, "geprobeerd.", 32.54, 33.46),
            w(0, "Ja.", 33.6, 34.18),
            w(0, "Ja,", 34.74, 34.78),
            w(0, "ik", 34.88, 34.98),
            w(0, "heb", 34.98, 35.22),
            w(0, "al", 35.22, 35.62),
            w(0, "wat", 35.62, 35.8),
            w(0, "dingen", 35.8, 35.94),
            w(0, "opgeschreven.", 35.94, 36.76),
            w(0, "Oké.", 37.02, 37.31),
        ];
        let spans = vec![
            vec![Span::new(27.68, 30.53), Span::new(32.99, 33.31), Span::new(33.44, 34.37), Span::new(35.23, 35.46), Span::new(36.86, 37.31)],
            vec![Span::new(31.55, 32.99), Span::new(34.69, 35.23), Span::new(35.52, 36.54)],
        ];
        assign_speakers(&mut words, &spans, Language::Nl, 0.0);
        let who: Vec<usize> = words.iter().map(|w| w.speaker).collect();
        assert_eq!(who, [0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0]);
    }

    #[test]
    fn question_and_answer_without_a_full_stop_are_cut_at_the_hand_over() {
        let mut words = vec![
            w(0, "Hoe", 1.0, 1.3),
            w(0, "was", 1.3, 1.6),
            w(0, "dat", 1.6, 1.9),
            w(0, "voor", 1.9, 2.2),
            w(0, "jou,", 2.2, 2.6),
            w(0, "nou", 3.0, 3.3),
            w(0, "dat", 3.3, 3.6),
            w(0, "was", 3.6, 3.9),
            w(0, "best", 3.9, 4.2),
            w(0, "zwaar.", 4.2, 4.8),
        ];
        let spans = vec![vec![Span::new(0.9, 2.6)], vec![Span::new(2.9, 4.8)]];
        assign_speakers(&mut words, &spans, Language::Nl, 0.0);
        let who: Vec<usize> = words.iter().map(|w| w.speaker).collect();
        assert_eq!(who, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    }

    #[test]
    fn word_times_are_clipped_to_speech() {
        let mut words = vec![w(0, "Alex.", 0.5, 1.9), w(0, "Eh,", 1.9, 2.2)];
        refine_times(&mut words, &[Span::new(0.4, 1.2), Span::new(1.95, 2.3)]);
        assert!((words[0].end - 1.2).abs() < 1e-9);
        assert!((words[1].start - 1.95).abs() < 1e-9);
    }
}
