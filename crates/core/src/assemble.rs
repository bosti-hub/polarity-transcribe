//! Turns recognised words into a readable verbatim transcript:
//! speaker turns, inline backchannels, bracketed fillers and measured pauses.

use crate::activity::{covered_seconds, Levels};
use crate::asr::Language;
use crate::lexicon::{is_backchannel, is_filler, is_hesitation, normalize};
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
    /// Keep hesitation fillers and pause tags. Off gives a clean reading text (a lecture).
    pub verbatim: bool,
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

/// Both copies of a word heard by both microphones start within this many seconds of each
/// other. Someone repeating the other's word ("Zero." after "absolutely zero") comes later.
const SAME_SOUND: f64 = 0.25;

fn edit_distance(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diag = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let next = (diag + usize::from(ca != cb)).min(row[j] + 1).min(row[j + 1] + 1);
            diag = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()]
}

/// Whether two recognitions are the same word, possibly heard a little differently on the
/// other microphone ("girlfriend" / "girlfriends", "Belgian" / "Belgium", "correctly" /
/// "currently", "mental" / "judgmental"). `None` when they are not.
fn same_word(a: &str, b: &str) -> Option<bool> {
    let (a, b) = (normalize(a), normalize(b));
    if a.is_empty() || b.is_empty() {
        return None;
    }
    if a == b {
        return Some(true);
    }
    let (ca, cb): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let (short, long) = (ca.len().min(cb.len()), ca.len().max(cb.len()));
    if short < 4 {
        return None;
    }
    let affix = a.starts_with(&b) || b.starts_with(&a) || a.ends_with(&b) || b.ends_with(&a);
    (affix || edit_distance(&ca, &cb) as f64 <= 0.3 * long as f64).then_some(false)
}

/// Drop words that a microphone only picked up as bleed: the same words appear at the same
/// time on the other speaker's track, and that speaker owns the passage.
///
/// A run of two or more words, or one long word, is matched within a second. A single short
/// word ("or", "just", "Yeah.") or a slightly different spelling only counts when both copies
/// start at practically the same moment, so that someone echoing the other's word keeps it.
/// Who owns the passage follows the speech spans; where those cannot decide, `levels` (the
/// level difference between the microphones during the word) does.
///
/// When the microphones hardly separate the voices, the spans are not to be trusted near the
/// other speaker's voice. Words that are not a listening sound then go to the track where they
/// sit inside a running sentence ("…uncomfortable with my sexuality ever since I was younger")
/// rather than to the one where they stand alone.
pub fn drop_cross_talk(
    words: [Vec<SpokenWord>; 2],
    spans: &[Vec<Span>; 2],
    levels: Option<&Levels>,
    lang: Language,
) -> Vec<SpokenWord> {
    let weak_mics = levels.is_some_and(|l| l.separation() < 10.0);
    // How many sides of words[from..to] continue the speaker's own speech (as one utterance in `assemble`).
    let context = |w: &[SpokenWord], from: usize, to: usize| -> u8 {
        let before = from > 0 && w[from].start - w[from - 1].end <= 1.0;
        let after = to < w.len() && w[to].start - w[to - 1].end <= 1.0;
        u8::from(before) + u8::from(after)
    };
    let [a, b] = words;
    let mut keep_a = vec![true; a.len()];
    let mut keep_b = vec![true; b.len()];
    let mut paired_b = vec![false; b.len()];
    let mut j0 = 0usize;
    let mut i = 0usize;
    while i < a.len() {
        while j0 < b.len() && b[j0].end < a[i].start - 1.0 {
            j0 += 1;
        }
        // Find a run of matching words starting at a[i] and some nearby b[j].
        let mut best = (0usize, 0usize, true); // (j, run length, all copies start together)
        let mut j = j0;
        while j < b.len() && b[j].start <= a[i].start + 1.0 {
            let (mut run, mut together) = (0, true);
            // A word already paired with one on the other track is not paired again.
            while i + run < a.len() && j + run < b.len() && !paired_b[j + run] {
                let (x, y) = (&a[i + run], &b[j + run]);
                let dt = (x.start - y.start).abs();
                // A partial recognition ("mental" for "judgmental") shares the end, not the start.
                let same_time = dt.min((x.end - y.end).abs()) < SAME_SOUND;
                match same_word(&x.text, &y.text) {
                    Some(true) if dt < 1.0 => {}
                    Some(false) if same_time => {}
                    _ => break,
                }
                together &= same_time;
                run += 1;
            }
            if run > best.1 {
                best = (j, run, together);
            }
            j += 1;
        }
        let (j, run, together) = best;
        let chars: usize = (0..run).map(|k| normalize(&a[i + k].text).chars().count()).sum();
        if run >= 2 || (run == 1 && (chars >= 6 || together)) {
            let (t0, t1) = (a[i].start.min(b[j].start), a[i + run - 1].end.max(b[j + run - 1].end));
            let own_a = covered_seconds(&spans[0], t0, t1);
            let own_b = covered_seconds(&spans[1], t0, t1);
            // Both speakers count as talking here (a word right at a hand-over, or both at once):
            // the microphones say whose voice it was.
            let by_level = if (own_a - own_b).abs() < 0.05 { levels.and_then(|l| l.owner(t0, t1)) } else { None };
            let texts: Vec<&str> = a[i..i + run].iter().map(|w| w.text.as_str()).collect();
            let listening = is_backchannel(&texts, lang) && !texts.iter().all(|t| is_hesitation(t, lang));
            let (ctx_a, ctx_b) = (context(&a, i, i + run), context(&b, j, j + run));
            let drop_a = if weak_mics && !listening && ctx_a != ctx_b {
                ctx_a < ctx_b
            } else {
                match by_level {
                    Some(owner) => owner == 1,
                    None => own_a < own_b,
                }
            };
            for k in 0..run {
                paired_b[j + k] = true;
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

/// Drop a stray word or two that one microphone made out of the other speaker's voice, where
/// the recogniser heard something else than the other microphone did ("ability" inside the
/// other speaker's "responsibility to not watch"), so [`drop_cross_talk`] finds no twin.
///
/// Such a fragment is at most three words of one speaker, standing alone, that is not a
/// listening sound, and that either falls on top of the other speaker's words or sits in a
/// tiny pause in the middle of the other speaker's sentence. A short answer or an echo ("23.",
/// "Zero.") comes after the other speaker has finished a sentence and stays. Where the
/// microphones separate the voices well, a fragment the levels show to be the speaker's own
/// voice stays as well.
pub fn drop_stray_bleed(words: Vec<SpokenWord>, levels: Option<&Levels>, lang: Language) -> Vec<SpokenWord> {
    const ALONE: f64 = 1.0; // the same gap that separates utterances in `assemble`
    let end = |w: &SpokenWord| w.end.max(w.start + 0.08);
    let mut drop = vec![false; words.len()];
    for k in 0..2 {
        let own: Vec<usize> = (0..words.len()).filter(|&i| words[i].speaker == k).collect();
        let other: Vec<&SpokenWord> = words.iter().filter(|w| w.speaker != k).collect();
        let mut a = 0;
        while a < own.len() {
            let mut b = a;
            while b + 1 < own.len() && words[own[b + 1]].start - end(&words[own[b]]) <= ALONE {
                b += 1;
            }
            let piece: Vec<&SpokenWord> = own[a..=b].iter().map(|&i| &words[i]).collect();
            let (s, e) = (piece[0].start, end(piece[piece.len() - 1]));
            let texts: Vec<&str> = piece.iter().map(|w| w.text.as_str()).collect();
            if piece.len() <= 3 && e - s <= 1.0 && !is_backchannel(&texts, lang) {
                let on_top: f64 = other.iter().map(|o| (end(o).min(e) - o.start.max(s)).max(0.0)).sum();
                let before = other.iter().filter(|o| end(o) <= s + 0.05).last();
                let after = other.iter().find(|o| o.start >= e - 0.05);
                let mid_sentence = piece.len() <= 2
                    && before.is_some_and(|o| s - end(o) <= 0.6 && !word_ends_sentence(o))
                    && after.is_some_and(|o| o.start - e <= 0.6);
                let own_voice = levels.filter(|l| l.separation() >= 10.0).and_then(|l| l.owner(s, e)) == Some(k);
                if (on_top >= 0.8 * (e - s) || mid_sentence) && !own_voice {
                    for &i in &own[a..=b] {
                        drop[i] = true;
                    }
                }
            }
            a = b + 1;
        }
    }
    words.into_iter().zip(drop).filter(|(_, d)| !d).map(|(w, _)| w).collect()
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

fn turn_end(t: &Turn) -> f64 {
    t.items.iter().filter_map(|i| i.end()).fold(0.0, f64::max)
}

/// Put a listening sound into a turn at its place in time.
fn insert_backchannel(items: &mut Vec<Item>, speaker: usize, words: &[SpokenWord]) {
    let (Some(first), Some(last)) = (words.first(), words.last()) else { return };
    let text = words
        .iter()
        .map(|w| w.text.replace(['[', ']'], "").trim_end_matches(['.', ',']).to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    let item = Item::Backchannel { sp: speaker_id(speaker), t: text, s: ms(first.start), e: ms(last.end) };
    let at = items.iter().position(|i| i.start().is_some_and(|s| s > first.start)).unwrap_or(items.len());
    items.insert(at, item);
}

/// Question tags ("…, right?", "…, toch?") ask for no real answer.
const QUESTION_TAGS: &[&str] = &[
    "right", "yeah", "yes", "no", "okay", "ok", "huh", "eh", "know", "true", "see", "hè", "he", "toch", "ja",
    "nee", "oké", "niet", "joh", "zo",
];

/// `u` comes after a question of the speaker of `t` ("Klinkt dat goed voor jou?" "Prima."): a
/// short answer is a turn of its own, not a listening sound. A mere "hm-hm" or "ah" is not.
fn answers_question(t: &Turn, u: &Utterance, lang: Language) -> bool {
    if u.words.iter().all(|w| is_filler(&w.text, lang)) {
        return false;
    }
    let before = t.items.iter().filter(|i| i.start().is_some_and(|s| s < u.start())).max_by(|a, b| {
        a.start().unwrap_or(0.0).total_cmp(&b.start().unwrap_or(0.0))
    });
    match before {
        Some(Item::Word { t, e, .. }) => {
            t.ends_with('?') && *e <= u.start() + 0.05 && !QUESTION_TAGS.contains(&normalize(t).as_str())
        }
        _ => false,
    }
}

/// The rest of an interrupted turn is only a listening sound, said while `u` was talking.
fn is_listening_tail(t: &Turn, u: &Utterance, lang: Language) -> bool {
    let mut texts: Vec<&str> = Vec::new();
    for item in &t.items {
        match item {
            Item::Word { t, .. } => texts.push(t),
            _ => return false,
        }
    }
    let (start, end) = (t.items.iter().filter_map(|i| i.start()).fold(f64::INFINITY, f64::min), turn_end(t));
    end - start <= 2.0 && end <= u.end() + 0.05 && is_backchannel(&texts, lang)
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

fn capitalise(text: &str) -> String {
    match text.char_indices().find(|(_, c)| c.is_alphabetic()) {
        Some((i, c)) => format!("{}{}{}", &text[..i], c.to_uppercase(), &text[i + c.len_utf8()..]),
        None => text.to_string(),
    }
}

/// Leave out hesitation fillers. A sentence end attached to a filler ("[uhm].") moves to the
/// word before it, and a sentence that began with a filler starts with a capital again.
fn drop_fillers(items: Vec<Item>) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::with_capacity(items.len());
    let mut capital_next = false;
    for item in items {
        match item {
            Item::Word { f: true, t, .. } => {
                let punct = &t[t.trim_end_matches(['.', '?', '!']).len()..];
                match out.iter_mut().rev().find(|i| matches!(i, Item::Word { .. })) {
                    Some(Item::Word { t: prev, .. }) => {
                        if !punct.is_empty() && !prev.ends_with(['.', '?', '!']) {
                            *prev = format!("{}{punct}", prev.trim_end_matches([',', ';', ':']));
                        }
                        // The filler opened a sentence (or now closes one): the next word opens it.
                        if prev.ends_with(['.', '?', '!']) {
                            capital_next = true;
                        }
                    }
                    _ => capital_next = true,
                }
            }
            Item::Word { t, s, e, c, f } => {
                let t = if capital_next { capitalise(&t) } else { t };
                capital_next = false;
                out.push(Item::Word { t, s, e, c, f });
            }
            other => out.push(other),
        }
    }
    out
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

    // 2. Turns, with listening sounds folded into the turn of whoever has the floor.
    let mut turns: Vec<Turn> = Vec::new();
    for (idx, u) in utterances.iter().enumerate() {
        if turns.is_empty() {
            turns.push(Turn { speaker: u.speaker, items: u.words.iter().map(|w| word_item(w, lang)).collect() });
            continue;
        }
        let texts: Vec<&str> = u.words.iter().map(|w| w.text.as_str()).collect();
        let short = u.end() - u.start() <= 2.0 && is_backchannel(&texts, lang);
        // Someone else keeps the floor if they are still talking, or resume right away. After an
        // interruption the rest of the interrupted turn comes last, so the turn that holds the
        // floor is not always the last one.
        let floor = (turns.len().saturating_sub(3)..turns.len()).rev().find(|&k| {
            let t = &turns[k];
            t.speaker != u.speaker
                && (turn_end(t) > u.start() + 0.05
                    || utterances.get(idx + 1).is_some_and(|n| n.speaker == t.speaker && n.start() - u.end() <= 2.5))
        });
        if let Some(k) = floor.filter(|&k| short && !answers_question(&turns[k], u, lang)) {
            insert_backchannel(&mut turns[k].items, u.speaker, &u.words);
            continue;
        }
        let cur = turns.last_mut().unwrap();
        if cur.speaker == u.speaker {
            cur.items.extend(u.words.iter().map(|w| word_item(w, lang)));
            continue;
        }
        // How long both talk at once: until the interrupted speaker stops or the other one is
        // done. What the interrupted speaker only says after that is not overlap.
        let together = turn_end(cur).min(u.end()) - u.start();
        // A real interruption: split the current turn where the other speaker comes in.
        let split = cur.items.iter().position(|i| i.start().is_some_and(|s| s >= u.start() + 0.05));
        let mut tail = match split {
            Some(at) if at > 0 => Some(Turn { speaker: cur.speaker, items: cur.items.split_off(at) }),
            _ => None,
        };
        let mut items: Vec<Item> = Vec::with_capacity(u.words.len() + 1);
        if opts.mark_overlap && together >= MIN_OVERLAP {
            items.push(overlap_note(lang, u.start()));
        }
        items.extend(u.words.iter().map(|w| word_item(w, lang)));
        // What the interrupted speaker still said while the other one talked may be no more
        // than a listening sound ("Yes?"): that goes inline as well.
        if let Some(t) = tail.as_ref().filter(|t| is_listening_tail(t, u, lang)) {
            let words: Vec<SpokenWord> = t
                .items
                .iter()
                .filter_map(|i| match i {
                    Item::Word { t, s, e, .. } => Some(SpokenWord { speaker: 0, text: t.clone(), start: *s, end: *e, prob: 1.0 }),
                    _ => None,
                })
                .collect();
            insert_backchannel(&mut items, t.speaker, &words);
            tail = None;
        }
        turns.push(Turn { speaker: u.speaker, items });
        if let Some(t) = tail {
            turns.push(t);
        }
    }

    if !opts.verbatim {
        for turn in turns.iter_mut() {
            turn.items = drop_fillers(std::mem::take(&mut turn.items));
        }
        turns.retain(|t| t.items.iter().any(|i| matches!(i, Item::Word { .. })));
    }

    // 3. Pauses measured on the audio: gaps in everyone's voice activity (verbatim only).
    let mut silences: Vec<Span> = Vec::new();
    let mut prev_end = 0.0;
    for s in speech.iter().filter(|_| opts.verbatim) {
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
        AssembleOpts { language: Language::Nl, pause_threshold: 3.0, speaker_count: 2, mark_overlap: false, verbatim: true }
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
    fn clean_text_leaves_out_fillers_and_pauses() {
        let words = vec![
            w(0, "Uhm,", 0.0, 0.3),
            w(0, "dat", 0.4, 0.6),
            w(0, "klopt", 0.6, 0.9),
            w(0, "eh.", 1.0, 1.2),
            w(0, "hoe", 5.0, 5.2),
            w(0, "verder?", 5.2, 5.6),
        ];
        let speech = [Span::new(0.0, 1.2), Span::new(5.0, 5.6)];
        let verbatim = assemble(words.clone(), &speech, 6.0, &opts());
        assert_eq!(text(&verbatim.paragraphs[0]), "[uhm], dat klopt [eh]. [stilte 3.8s] hoe verder?");
        let clean = assemble(words, &speech, 6.0, &AssembleOpts { verbatim: false, ..opts() });
        assert_eq!(text(&clean.paragraphs[0]), "Dat klopt. Hoe verder?");
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
    fn listening_sounds_during_a_long_answer_stay_inline_after_an_interruption() {
        // The interviewer's "Yes?" runs into the answer; later "hm-hm"s and "yeah" fall while the
        // participant is still talking, and only then the next question comes.
        let mut words = vec![w(1, "And", 0.0, 0.3), w(1, "how", 0.3, 0.6), w(1, "did", 0.6, 0.9), w(1, "that", 0.9, 1.2), w(1, "go?", 1.2, 1.6)];
        words.push(w(1, "Yes?", 2.4, 2.6));
        for i in 0..60 {
            let t = 2.0 + i as f64 * 0.3;
            words.push(w(0, if i == 59 { "it." } else { "word" }, t, t + 0.25));
        }
        words.push(w(1, "Hm-hm.", 8.0, 8.2));
        words.push(w(1, "Hm-hm.", 14.0, 14.1));
        words.push(w(1, "Yeah.", 19.5, 19.6));
        for (i, t) in ["So", "you", "feel", "that?"].iter().enumerate() {
            words.push(w(1, t, 21.5 + i as f64 * 0.3, 21.5 + i as f64 * 0.3 + 0.25));
        }
        let t = assemble(words, &[Span::new(0.0, 23.0)], 24.0, &AssembleOpts { language: Language::En, ..opts() });
        let speakers: Vec<&str> = t.paragraphs.iter().map(|p| p.speaker.as_str()).collect();
        assert_eq!(speakers, ["S2", "S1", "S2"]);
        assert_eq!(text(&t.paragraphs[0]), "And how did that go?");
        let inline: Vec<String> = t.paragraphs[1]
            .items
            .iter()
            .filter_map(|i| match i {
                Item::Backchannel { t, .. } => Some(t.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(inline, ["yes?", "hm-hm", "hm-hm", "yeah"]);
        assert_eq!(text(&t.paragraphs[2]), "So you feel that?");
    }

    #[test]
    fn a_short_reaction_goes_inline_too() {
        let mut words = vec![];
        for (i, t) in ["It", "was", "quite", "traumatic", "because", "it", "is", "big."].iter().enumerate() {
            words.push(w(0, t, i as f64 * 0.4, i as f64 * 0.4 + 0.3));
        }
        words.push(w(1, "I", 1.7, 1.8));
        words.push(w(1, "can", 1.8, 1.9));
        words.push(w(1, "imagine.", 1.9, 2.3));
        let t = assemble(words, &[Span::new(0.0, 3.2)], 4.0, &AssembleOpts { language: Language::En, ..opts() });
        assert_eq!(t.paragraphs.len(), 1);
        assert_eq!(text(&t.paragraphs[0]), "It was quite traumatic because [S2: i can imagine] it is big.");
    }

    #[test]
    fn a_short_answer_to_a_question_stays_its_own_turn_even_when_the_asker_goes_on() {
        let words = vec![
            w(0, "Klinkt", 0.0, 0.3),
            w(0, "dat", 0.3, 0.5),
            w(0, "goed?", 0.5, 0.9),
            w(1, "Prima.", 1.2, 1.5),
            w(0, "Heb", 2.2, 2.4),
            w(0, "je", 2.4, 2.5),
            w(0, "geschreven?", 2.5, 3.0),
        ];
        let t = assemble(words, &[Span::new(0.0, 3.0)], 4.0, &opts());
        let speakers: Vec<&str> = t.paragraphs.iter().map(|p| p.speaker.as_str()).collect();
        assert_eq!(speakers, ["S1", "S2", "S1"]);

        // Nobody talks at the same time here, so no overlap is marked either.
        let words = vec![
            w(0, "Right", 315.2, 315.4),
            w(0, "now?", 315.4, 315.68),
            w(1, "Yes.", 315.75, 315.85),
            w(0, "Absolutely", 316.06, 316.4),
            w(0, "zero.", 316.4, 316.58),
        ];
        let marked = AssembleOpts { language: Language::En, mark_overlap: true, ..opts() };
        let t = assemble(words, &[Span::new(315.2, 316.6)], 320.0, &marked);
        assert_eq!(t.paragraphs.iter().map(text).collect::<Vec<_>>(), ["Right now?", "Yes.", "Absolutely zero."]);

        // A question tag asks for nothing: the "ja" stays inline.
        let words = vec![
            w(0, "Dat", 0.0, 0.3),
            w(0, "was", 0.3, 0.5),
            w(0, "zwaar,", 0.5, 0.8),
            w(0, "toch?", 0.8, 1.0),
            w(1, "Ja.", 1.2, 1.4),
            w(0, "En", 2.0, 2.2),
            w(0, "toen?", 2.2, 2.6),
        ];
        let t = assemble(words, &[Span::new(0.0, 2.6)], 3.0, &opts());
        assert_eq!(t.paragraphs.len(), 1);
        assert_eq!(text(&t.paragraphs[0]), "Dat was zwaar, toch? [S2: ja] En toen?");
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
        let out = drop_cross_talk([a, b], &spans, None, Language::Nl);
        let who: Vec<(usize, &str)> = out.iter().map(|w| (w.speaker, w.text.as_str())).collect();
        assert_eq!(who, [(0, "Dat"), (0, "is"), (0, "waar."), (1, "Ja.")]);
    }

    #[test]
    fn a_single_short_word_heard_by_both_microphones_is_kept_once() {
        // The interviewer says "just tell me"; the participant's microphone, open for a
        // "hm-hm", also recognised "Just" at the same moment.
        let a = vec![w(0, "Hm-hm.", 73.3, 73.45), w(0, "Just", 73.47, 73.6)];
        let b = vec![w(1, "just,", 73.49, 73.6), w(1, "tell", 73.7, 73.9), w(1, "me", 73.9, 74.0)];
        let spans = [vec![Span::new(73.2, 73.5)], vec![Span::new(73.45, 75.0)]];
        let out = drop_cross_talk([a, b], &spans, None, Language::Nl);
        let who: Vec<(usize, &str)> = out.iter().map(|w| (w.speaker, w.text.as_str())).collect();
        assert_eq!(who, [(0, "Hm-hm."), (1, "just,"), (1, "tell"), (1, "me")]);
    }

    #[test]
    fn a_word_spelled_differently_on_the_other_microphone_is_the_same_word() {
        let a = vec![w(0, "Correctly.", 313.64, 313.86)];
        let b = vec![w(1, "life", 313.2, 313.5), w(1, "currently?", 313.66, 314.0)];
        let spans = [vec![Span::new(313.7, 313.8)], vec![Span::new(312.0, 314.0)]];
        let out = drop_cross_talk([a, b], &spans, None, Language::Nl);
        let texts: Vec<&str> = out.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["life", "currently?"]);

        // Only the end of the word made it to the other microphone.
        let a = vec![w(0, "really", 1009.03, 1009.35), w(0, "judgmental,", 1009.35, 1009.91)];
        let b = vec![w(1, "mental.", 1009.7, 1009.94)];
        let spans = [vec![Span::new(1008.5, 1010.0)], vec![Span::new(1009.8, 1010.2)]];
        let out = drop_cross_talk([a, b], &spans, None, Language::Nl);
        let texts: Vec<&str> = out.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["really", "judgmental,"]);

        assert_eq!(same_word("girlfriend", "girlfriends,"), Some(false));
        assert_eq!(same_word("Belgian.", "Belgium."), Some(false));
        assert_eq!(same_word("mental.", "judgmental,"), Some(false));
        assert_eq!(same_word("the", "they"), None);
        assert_eq!(same_word("place", "space"), None);
    }

    #[test]
    fn stray_words_from_the_other_voice_are_dropped() {
        let mut words = vec![];
        // Speaker 0 talks on: "...I found porn on his phone, so that was also..."
        for (i, t) in ["I", "found", "porn", "on", "his", "phone,", "so", "that", "was", "also"].iter().enumerate() {
            let s = 345.0 + i as f64 * 0.25 + if i >= 6 { 0.2 } else { 0.0 };
            words.push(w(0, t, s, s + 0.22));
        }
        // Speaker 1's microphone made "it" out of "his" and "porn." in the comma pause.
        words.push(w(1, "it", 345.98, 346.2));
        words.push(w(1, "porn.", 346.48, 346.6));
        words.sort_by(|a, b| a.start.total_cmp(&b.start));
        let out = drop_stray_bleed(words, None, Language::En);
        assert!(out.iter().all(|w| w.speaker == 0), "{out:?}");
    }

    #[test]
    fn short_answers_echoes_and_listening_sounds_are_not_stray_bleed() {
        let words = vec![
            w(1, "How", 162.0, 162.3),
            w(1, "old", 162.3, 162.5),
            w(1, "are", 162.5, 162.7),
            w(1, "you?", 162.7, 163.07),
            w(0, "23.", 163.41, 163.58),
            w(1, "Twenty-three.", 164.03, 164.6),
            w(0, "Absolutely", 315.8, 316.3),
            w(0, "zero.", 316.4, 316.58),
            w(1, "Zero.", 317.03, 317.34),
            w(0, "Yeah.", 317.68, 317.9),
            w(0, "I", 318.0, 318.1),
            w(0, "stopped", 318.1, 318.5),
            w(1, "Mm-hmm.", 318.2, 318.45),
            w(0, "really", 318.5, 318.8),
        ];
        let n = words.len();
        assert_eq!(drop_stray_bleed(words, None, Language::En).len(), n);
    }

    #[test]
    fn with_weak_microphones_words_go_to_the_running_sentence() {
        // 7 dB apart: the spans wrongly say speaker 1 talks during speaker 0's sentence.
        let report = crate::activity::BleedReport {
            ratio_speaker1_db: 3.5,
            ratio_speaker2_db: -3.5,
            separation_db: 7.0,
            separable: true,
            speaker1_sec: 0.0,
            speaker2_sec: 0.0,
            overlap_sec: 0.0,
        };
        let p = vec![1e-4f32; 20_000];
        let levels = Levels::new([&p, &p], &report);
        let mut a = vec![];
        for (i, t) in ["with", "my", "sexuality", "ever", "since", "I", "was", "younger."].iter().enumerate() {
            a.push(w(0, t, 318.86 + i as f64 * 0.4, 318.86 + i as f64 * 0.4 + 0.38));
        }
        let b = vec![w(1, "sexuality", 319.68, 320.06), w(1, "ever", 320.08, 320.46), w(1, "since", 320.48, 320.86)];
        let spans = [vec![Span::new(318.8, 319.6), Span::new(320.9, 322.1)], vec![Span::new(319.5, 320.9)]];
        let out = drop_cross_talk([a, b], &spans, Some(&levels), Language::En);
        assert!(out.iter().all(|w| w.speaker == 0) && out.len() == 8, "{out:?}");
    }

    #[test]
    fn an_echo_of_the_other_speakers_word_is_not_bleed() {
        // "Absolutely zero." - "Zero." The interviewer repeats the word half a second later.
        let a = vec![w(0, "Absolutely", 315.8, 316.3), w(0, "zero.", 316.44, 316.8)];
        let b = vec![w(1, "Zero.", 317.03, 317.34)];
        let spans = [vec![Span::new(315.7, 316.9)], vec![Span::new(317.0, 317.4)]];
        let out = drop_cross_talk([a, b], &spans, None, Language::Nl);
        assert_eq!(out.len(), 3);
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
