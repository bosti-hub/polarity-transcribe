// Pseudonymisation: replacing names and other identifying details.
//
// Rules are kept apart from the transcript and applied when exporting, so the transcript in the
// app stays complete (it can still be checked against the audio) while everything that leaves
// the app is pseudonymised. A study has one list for all its interviews; an interview can add
// its own rules. Matching is whole-word and case-insensitive, also across words ("Jan de
// Vries"), and the longest term wins.

import type { AnonymizeRule, Item, Paragraph, Transcript } from "./types";

/** Regex that finds a term as a whole word, case-insensitively; null for an empty term. */
export function wholeWord(term: string): RegExp | null {
  const core = term.trim();
  if (!core) return null;
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
}

/** Interview rules first, then the study's; within that, longer terms first. Empty and duplicate terms are dropped. */
export function mergeRules(interview: AnonymizeRule[], study: AnonymizeRule[]): AnonymizeRule[] {
  const seen = new Set<string>();
  const out: AnonymizeRule[] = [];
  for (const r of [...interview, ...study]) {
    const key = r.find.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ find: r.find.trim(), replace: r.replace });
  }
  return out.sort((a, b) => b.find.length - a.find.length);
}

/** Replace in a plain string; adds the number of replacements per rule to `counts`. */
export function anonymizeText(text: string, rules: AnonymizeRule[], counts?: number[]): string {
  let out = text;
  rules.forEach((rule, i) => {
    const re = wholeWord(rule.find);
    if (!re) return;
    out = out.replace(re, () => {
      if (counts) counts[i] = (counts[i] ?? 0) + 1;
      return rule.replace;
    });
  });
  return out;
}

/** Replace in the words of a paragraph; a match across several words becomes one word. */
function anonymizeWords(items: Item[], rules: AnonymizeRule[], counts: number[]): Item[] {
  let words = items;
  rules.forEach((rule, r) => {
    const re = wholeWord(rule.find);
    if (!re) return;
    // The word items joined by spaces, with where each one starts.
    const idx: number[] = [];
    const starts: number[] = [];
    let text = "";
    words.forEach((it, i) => {
      if (it.k !== "w") return;
      if (text) text += " ";
      idx.push(i);
      starts.push(text.length);
      text += it.t;
    });
    const matches = [...text.matchAll(re)];
    if (matches.length === 0) return;
    const next = [...words];
    // Right to left, so earlier positions stay valid.
    for (const m of matches.reverse()) {
      const a = m.index;
      const b = a + m[0].length;
      let first = 0;
      let last = 0;
      starts.forEach((s, k) => {
        if (s <= a) first = k;
        if (s < b) last = k;
      });
      const firstItem = words[idx[first]] as Extract<Item, { k: "w" }>;
      const lastItem = words[idx[last]] as Extract<Item, { k: "w" }>;
      const lastEnd = starts[last] + lastItem.t.length;
      const t = text.slice(starts[first], a) + rule.replace + text.slice(b, lastEnd);
      const merged: Item = { k: "w", t, s: firstItem.s, e: lastItem.e, c: 1 };
      // The matched words become one; anything else between them (a listening sound) stays after it.
      const between = words.slice(idx[first] + 1, idx[last]).filter((x) => x.k !== "w");
      next.splice(idx[first], idx[last] - idx[first] + 1, merged, ...between);
      counts[r] = (counts[r] ?? 0) + 1;
    }
    words = next;
  });
  return words;
}

export interface Anonymized {
  transcript: Transcript;
  /** Replacements per rule, in the order of `rules`. */
  counts: number[];
}

/** Apply the rules to the transcript's words, listening sounds, annotations and speaker names. */
export function anonymizeTranscript(t: Transcript, rules: AnonymizeRule[]): Anonymized {
  const counts = rules.map(() => 0);
  if (rules.length === 0) return { transcript: t, counts };
  const paragraphs: Paragraph[] = t.paragraphs.map((p) => {
    const items = anonymizeWords(p.items, rules, counts).map((it) => {
      if (it.k === "b") return { ...it, t: anonymizeText(it.t, rules, counts) };
      if (it.k === "n") return { ...it, t: anonymizeText(it.t, rules, counts) };
      return it;
    });
    return { ...p, items };
  });
  const speakers = t.speakers.map((s) => ({ ...s, name: anonymizeText(s.name, rules, counts) }));
  return { transcript: { ...t, speakers, paragraphs }, counts };
}

/**
 * When the pseudonymised words are spoken between `from` and `to` (seconds on the transcript
 * timeline): one span per match, from the first matched word's start to the last one's end,
 * merged where they touch. Used to beep them out of audio fragments.
 */
export function pseudonymSpans(t: Pick<Transcript, "paragraphs">, rules: AnonymizeRule[], from: number, to: number): [number, number][] {
  const res = rules.map((r) => wholeWord(r.find)).filter((re): re is RegExp => re !== null);
  if (res.length === 0) return [];
  const spans: [number, number][] = [];
  for (const p of t.paragraphs) {
    if (p.end < from || p.start > to) continue;
    // The words joined by spaces, with where each one starts (as the export matches them).
    const words: { s: number; e: number; at: number; len: number }[] = [];
    let text = "";
    for (const it of p.items) {
      if (it.k === "b") {
        // A listening sound is short: beep all of it when it holds a name.
        if (res.some((re) => new RegExp(re.source, re.flags).test(it.t))) spans.push([it.s, it.e]);
        continue;
      }
      if (it.k !== "w") continue;
      if (text) text += " ";
      words.push({ s: it.s, e: it.e, at: text.length, len: it.t.length });
      text += it.t;
    }
    for (const re of res) {
      for (const m of text.matchAll(re)) {
        const a = m.index;
        const b = a + m[0].length;
        const hit = words.filter((w) => w.at < b && w.at + w.len > a);
        if (hit.length) spans.push([hit[0].s, hit[hit.length - 1].e]);
      }
    }
  }
  const inside = spans.filter(([s, e]) => e > from && s < to).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [s, e] of inside) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// ------------------------------------------------------------------ the pseudonymisation check

/**
 * What a detail is: a name (a capitalised word in the middle of a sentence), a term from the
 * study's names list, or something recognised by its form (dates, numbers, addresses).
 */
export type DetailKind =
  | "name"
  | "term"
  | "date"
  | "year"
  | "number"
  | "postcode"
  | "email"
  | "phone";

/** A term the pseudonymisation check asks about. */
export interface Detail {
  term: string;
  kind: DetailKind;
  /** Occurrences the export would still leave as they are (whole words, outside existing rules). */
  count: number;
  /** Paragraph and character offset of the first occurrence: the check goes through in order. */
  first: [number, number];
}

const MONTHS = [
  "januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december",
  "january", "february", "march", "may", "june", "july", "august", "october",
];
const DAYS = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
/** Capitalised words that are not identifying on their own. */
const NOT_NAMES = new Set([
  "ik", "i", "oké", "ok", "okay", "nederland", "nederlands", "engels", "english", "dutch", "god", "corona", "covid", "tv",
  // Discourse words the recogniser often capitalises after a pause.
  "ja", "nee", "nou", "oh", "ah", "dus", "en", "maar", "want", "dan", "als", "of", "je", "jij", "wij", "we", "ze", "zij", "hij",
  "het", "de", "een", "dat", "die", "wat", "hoe", "waarom", "wel", "niet", "ook", "echt", "goed", "precies", "klopt", "zeker",
  "inderdaad", "yes", "no", "so", "and", "but", "well", "right", "yeah", "sure",
  // Interjections that stand alone, capitalised, after a pause.
  "alright", "allright", "cheers", "goh", "mmh", "mm", "hm", "prima", "jazeker", "kijk", "vertel", "zeg", "blablabla", "hallo",
  "hoi", "doei", "sorry", "super", "top", "mooi", "nice", "cool", "bedankt", "dankjewel", "thanks", "hey", "hè", "joh", "tja",
]);
const PARTICLES = new Set(["de", "van", "der", "den", "ter", "ten", "te", "het", "la", "le", "von", "da", "di", "du"]);

/** "Vries" yes; "ik", "NL" and "I" no. */
const isCapitalised = (w: string) => /^\p{Lu}\p{Ll}/u.test(w);
const bare = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** The text of each paragraph as the check reads it: its words, without fillers. */
export function detailTexts(t: Pick<Transcript, "paragraphs">): string[] {
  return t.paragraphs.map((p) =>
    p.items
      .filter((it): it is Extract<Item, { k: "w" }> => it.k === "w" && !it.f)
      .map((it) => it.t)
      .join(" "),
  );
}

/** Details recognised by their form, with where they start in `text`. */
function patternDetails(text: string): { term: string; kind: DetailKind; at: number }[] {
  const out: { term: string; kind: DetailKind; at: number }[] = [];
  const add = (m: RegExpMatchArray, kind: DetailKind) => out.push({ term: m[0], kind, at: m.index ?? 0 });
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) add(m, "email");
  for (const m of text.matchAll(/(?<!\d)(?:\+31\s?|0)\d(?:[\s-]?\d){8}(?!\d)/g)) add(m, "phone");
  for (const m of text.matchAll(/\b\d{4}\s?[A-Z]{2}\b/g)) add(m, "postcode");
  const monthRe = new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS.join("|")})(?:\\s+\\d{4})?\\b`, "gi");
  for (const m of text.matchAll(monthRe)) add(m, "date");
  for (const m of text.matchAll(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g)) add(m, "date");
  // Years outside the dates found above (same length, so positions stay right).
  for (const m of text.replace(monthRe, (d) => " ".repeat(d.length)).matchAll(/\b(?:19|20)\d{2}\b/g)) add(m, "year");
  // Long numbers (file or client numbers); a full stop after it may end the sentence.
  for (const m of text.matchAll(/(?<![\d.,])\d{5,}(?![\d,]|[.]\d)/g)) add(m, "number");
  return out;
}

/** Capitalised words that do not start a sentence, with particles ("Jan de Vries"). */
function capitalisedNames(text: string, ordinary: (w: string) => boolean): { term: string; at: number }[] {
  const out: { term: string; at: number }[] = [];
  const words = [...text.matchAll(/\S+/g)];
  for (let i = 0; i < words.length; i++) {
    const sentenceStart = i === 0 || /[.?!:"]$/.test(words[i - 1][0]);
    const w = bare(words[i][0]);
    if (!w || sentenceStart || !isCapitalised(w) || ordinary(w)) continue;
    const parts = [w];
    let j = i + 1;
    while (j < words.length && !/[,.?!;:]$/.test(words[j - 1][0])) {
      const nw = bare(words[j][0]);
      if (PARTICLES.has(nw) && j + 1 < words.length && isCapitalised(bare(words[j + 1][0]))) {
        parts.push(nw, bare(words[j + 1][0]));
        j += 2;
      } else if (isCapitalised(nw) && !ordinary(nw)) {
        parts.push(nw);
        j++;
      } else break;
    }
    out.push({ term: parts.join(" "), at: (words[i].index ?? 0) + words[i][0].indexOf(w) });
    i = j - 1;
  }
  return out;
}

/**
 * The terms the pseudonymisation check goes through, in the order they first occur: names
 * (capitalised words in the middle of a sentence), terms from the study's names list, and dates,
 * numbers and addresses recognised by their form. Leaves out what the export already replaces
 * (`rules`) and what was checked and kept (`keep`).
 *
 * A small name-finding language model (GLiNER) was tried for this in November 2026: on a 2h21
 * Dutch interview it found no real name that this rule missed, so it was left out.
 */
export function findDetails(
  t: Pick<Transcript, "paragraphs">,
  opts: { glossary: string[]; rules: AnonymizeRule[]; keep: string[] },
): Detail[] {
  const texts = detailTexts(t);
  // How often each word is written with and without a capital in the middle of a sentence: a
  // word mostly written in lower case is an ordinary word ("Vader" at the start of a sentence).
  const lower = new Map<string, number>();
  const upper = new Map<string, number>();
  for (const text of texts) {
    let start = true;
    for (const raw of text.split(/\s+/)) {
      const w = bare(raw);
      if (w && (/^\p{Ll}/u.test(w) || !start)) {
        const map = /^\p{Ll}/u.test(w) ? lower : upper;
        map.set(w.toLowerCase(), (map.get(w.toLowerCase()) ?? 0) + 1);
      }
      if (raw) start = /[.?!:"]$/.test(raw);
    }
  }
  const ordinary = (w: string) => {
    const k = w.toLowerCase();
    return NOT_NAMES.has(k) || MONTHS.includes(k) || DAYS.includes(k) || (lower.get(k) ?? 0) > (upper.get(k) ?? 0);
  };

  const items = new Map<string, { term: string; weight: Map<DetailKind, number>; first: [number, number] }>();
  const add = (term: string, kind: DetailKind, weight: number, para: number, at: number) => {
    const key = term.toLowerCase().replace(/\s+/g, " ");
    let d = items.get(key);
    if (!d) {
      d = { term, weight: new Map(), first: [para, at] };
      items.set(key, d);
    } else if (para < d.first[0] || (para === d.first[0] && at < d.first[1])) {
      d.first = [para, at];
    }
    d.weight.set(kind, (d.weight.get(kind) ?? 0) + weight);
  };

  texts.forEach((text, i) => {
    for (const n of capitalisedNames(text, ordinary)) add(n.term, "name", 1, i, n.at);
    for (const p of patternDetails(text)) add(p.term, p.kind, 1, i, p.at);
  });
  for (const term of opts.glossary) {
    const re = wholeWord(term);
    if (!re) continue;
    texts.forEach((text, i) => {
      const m = new RegExp(re.source, re.flags).exec(text);
      if (m) add(term.trim(), "term", 0.5, i, m.index);
    });
  }

  // Count what the export would still leave visible: the text with the current rules applied.
  const rules = mergeRules(opts.rules, []);
  const remaining = texts.map((text) => anonymizeText(text, rules));
  const keep = new Set(opts.keep.map((k) => k.trim().toLowerCase().replace(/\s+/g, " ")));
  const out: Detail[] = [];
  for (const [key, d] of items) {
    if (keep.has(key)) continue;
    const re = wholeWord(d.term);
    if (!re) continue;
    const count = remaining.reduce((n, text) => n + (text.match(re)?.length ?? 0), 0);
    if (count === 0) continue;
    // The kind with the most evidence.
    const kind = [...d.weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ term: d.term, kind, count, first: d.first });
  }
  return out.sort((a, b) => a.first[0] - b.first[0] || a.first[1] - b.first[1]);
}

const PLACEHOLDER: Record<DetailKind, { nl: string; en: string; numbered: boolean }> = {
  name: { nl: "naam", en: "name", numbered: true },
  term: { nl: "naam", en: "name", numbered: true },
  date: { nl: "datum", en: "date", numbered: false },
  year: { nl: "jaar", en: "year", numbered: false },
  number: { nl: "nummer", en: "number", numbered: false },
  postcode: { nl: "postcode", en: "postcode", numbered: false },
  email: { nl: "e-mailadres", en: "email address", numbered: false },
  phone: { nl: "telefoonnummer", en: "phone number", numbered: false },
};

/**
 * A suggested pseudonym for a detail, in the interview language. Numbered ones continue the
 * numbering already in `rules`: with "[naam 1]" and "[naam 2]" taken, a name gets "[naam 3]".
 */
export function placeholderFor(kind: DetailKind, lang: "nl" | "en", rules: AnonymizeRule[] = []): string {
  const p = PLACEHOLDER[kind];
  const word = p[lang];
  if (!p.numbered) return `[${word}]`;
  const re = new RegExp(`^\\[${word} (\\d+)\\]$`, "i");
  const used = rules.map((r) => Number(re.exec(r.replace.trim())?.[1] ?? 0));
  return `[${word} ${Math.max(0, ...used) + 1}]`;
}

