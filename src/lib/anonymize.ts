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

// ------------------------------------------------------------------ suggestions

export type CandidateKind = "name" | "term" | "date" | "year" | "number" | "postcode" | "email" | "phone";

export interface Candidate {
  term: string;
  kind: CandidateKind;
  count: number;
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
]);
const PARTICLES = new Set(["de", "van", "der", "den", "ter", "ten", "te", "het", "la", "le", "von", "da", "di", "du"]);

/** "Vries" yes; "ik", "NL" and "I" no. */
const isCapitalised = (w: string) => /^\p{Lu}\p{Ll}/u.test(w);
const bare = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** Words and details in the transcript that may identify someone, most frequent first. */
export function suggestCandidates(t: Transcript, glossary: string[], covered: AnonymizeRule[]): Candidate[] {
  const found = new Map<string, Candidate>();
  const add = (term: string, kind: CandidateKind) => {
    const key = term.toLowerCase();
    const c = found.get(key);
    if (c) c.count++;
    else found.set(key, { term, kind, count: 1 });
  };
  const speakerNames = new Set(t.speakers.map((s) => s.name.toLowerCase()));
  // Words that occur in lower case more often than capitalised are ordinary words ("Ja",
  // "Maar") that the recogniser capitalised; a name written in lower case once still counts.
  const lower = new Map<string, number>();
  const upper = new Map<string, number>();
  for (const p of t.paragraphs) {
    for (const it of p.items) {
      if (it.k !== "w") continue;
      const w = bare(it.t);
      const map = /^\p{Ll}/u.test(w) ? lower : upper;
      map.set(w.toLowerCase(), (map.get(w.toLowerCase()) ?? 0) + 1);
    }
  }
  const lowercase = { has: (w: string) => (lower.get(w) ?? 0) > (upper.get(w) ?? 0) };

  for (const p of t.paragraphs) {
    // Fillers count for where a sentence starts ("[eh]. Ja"), but are never names.
    const all = p.items.filter((it): it is Extract<Item, { k: "w" }> => it.k === "w");
    const words = all.map((it) => (it.f ? "" : it.t));
    const text = words.filter(Boolean).join(" ");

    // Names: capitalised words that do not start a sentence, with particles ("Jan de Vries").
    for (let i = 0; i < words.length; i++) {
      const prev = i > 0 ? all[i - 1].t : "";
      const sentenceStart = i === 0 || /[.?!:"]$/.test(prev);
      const w = bare(words[i]);
      if (!w || sentenceStart || !isCapitalised(w) || NOT_NAMES.has(w.toLowerCase()) || lowercase.has(w.toLowerCase())) continue;
      if (MONTHS.includes(w.toLowerCase()) || DAYS.includes(w.toLowerCase())) continue;
      const parts = [w];
      let j = i + 1;
      while (j < words.length && !/[,.?!;:]$/.test(words[j - 1])) {
        const nw = bare(words[j]);
        if (PARTICLES.has(nw) && j + 1 < words.length && isCapitalised(bare(words[j + 1]))) {
          parts.push(nw, bare(words[j + 1]));
          j += 2;
        } else if (isCapitalised(nw) && !NOT_NAMES.has(nw.toLowerCase()) && !lowercase.has(nw.toLowerCase())) {
          parts.push(nw);
          j++;
        } else break;
      }
      const term = parts.join(" ");
      if (!speakerNames.has(term.toLowerCase())) add(term, "name");
      i = j - 1;
    }

    for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) add(m[0], "email");
    for (const m of text.matchAll(/(?<!\d)(?:\+31\s?|0)\d(?:[\s-]?\d){8}(?!\d)/g)) add(m[0], "phone");
    for (const m of text.matchAll(/\b\d{4}\s?[A-Z]{2}\b/g)) add(m[0], "postcode");
    const monthRe = new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS.join("|")})(?:\\s+\\d{4})?\\b`, "gi");
    for (const m of text.matchAll(monthRe)) add(m[0], "date");
    for (const m of text.matchAll(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g)) add(m[0], "date");
    for (const m of text.replace(monthRe, " ").matchAll(/\b(?:19|20)\d{2}\b/g)) add(m[0], "year");
    // Long numbers (file or client numbers); a full stop after it may end the sentence.
    for (const m of text.matchAll(/(?<![\d.,])\d{5,}(?![\d,]|[.]\d)/g)) add(m[0], "number");
  }

  // Names and terms from the names list that occur in the text.
  const plain = t.paragraphs.map((p) => p.items.map((it) => ("t" in it ? it.t : "")).join(" ")).join("\n");
  for (const term of glossary) {
    const re = wholeWord(term);
    const n = re ? (plain.match(re)?.length ?? 0) : 0;
    if (n > 0 && !found.has(term.toLowerCase())) found.set(term.toLowerCase(), { term, kind: "term", count: n });
  }

  const isCovered = (term: string) => covered.some((r) => wholeWord(r.find)?.test(term) ?? false);
  return [...found.values()].filter((c) => !isCovered(c.term)).sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

/** A suggested placeholder for a candidate, in the interview language. */
export function placeholderFor(kind: CandidateKind, lang: "nl" | "en", n: number): string {
  const nl: Record<CandidateKind, string> = {
    name: `[naam ${n}]`, term: `[naam ${n}]`, date: "[datum]", year: "[jaar]", number: "[nummer]", postcode: "[postcode]", email: "[e-mailadres]", phone: "[telefoonnummer]",
  };
  const en: Record<CandidateKind, string> = {
    name: `[name ${n}]`, term: `[name ${n}]`, date: "[date]", year: "[year]", number: "[number]", postcode: "[postcode]", email: "[email address]", phone: "[phone number]",
  };
  return (lang === "nl" ? nl : en)[kind];
}
