// Editor behaviour that is not part of the document itself: highlights (uncertain words,
// the word being played, the loop range, hand-typed bracket notes) and the rule that a word
// someone has edited is no longer "uncertain".

import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { TimingAttrs } from "./schema";

export interface Range {
  from: number;
  to: number;
}

export interface SearchState {
  query: string;
  wholeWord: boolean;
  hits: Range[];
  /** Index of the selected hit, or -1. */
  current: number;
}

interface HighlightState {
  showDoubts: boolean;
  threshold: number;
  active: Range | null;
  loop: Range | null;
  /** Turns that end at or before this time (seconds) have been checked against the audio. */
  reviewedUntil: number | null;
  search: SearchState;
  /** Doubts, bracket notes and checked turns; rebuilt when the text changes. */
  base: DecorationSet;
}

export type HighlightMeta = Partial<Pick<HighlightState, "showDoubts" | "threshold" | "active" | "loop" | "reviewedUntil">> & {
  searchQuery?: { query: string; wholeWord: boolean };
  searchCurrent?: number;
};

const NO_SEARCH: SearchState = { query: "", wholeWord: false, hits: [], current: -1 };

/** Every occurrence of the query in the text of the turns (case-insensitive). */
export function findHits(doc: PMNode, query: string, wholeWord: boolean): Range[] {
  const core = query.trim();
  if (!core) return [];
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, "giu");
  const hits: Range[] = [];
  doc.forEach((turn, offset) => {
    // A turn holds only text, so text offsets map directly to document positions.
    for (const m of turn.textContent.matchAll(re)) hits.push({ from: offset + 1 + m.index, to: offset + 1 + m.index + m[0].length });
  });
  return hits;
}

/** End time of a turn (the latest timed item in it), or null. */
export function turnEnd(turn: PMNode): number | null {
  let end: number | null = null;
  turn.descendants((node) => {
    const t = node.isText ? timingOf(node) : null;
    if (t && t.k !== "n") end = Math.max(end ?? 0, t.e);
  });
  return end;
}

export const highlightKey = new PluginKey<HighlightState>("highlights");
/** Transactions carrying this meta are programmatic and must not confirm words. */
export const SYSTEM = "system-change";

const NOTE_RE = /\[[^\]\n]*\]/g;

function timingOf(node: PMNode): TimingAttrs | null {
  const mark = node.marks.find((m) => m.type.name === "timing");
  return mark ? (mark.attrs as TimingAttrs) : null;
}

function buildBase(doc: PMNode, showDoubts: boolean, threshold: number, reviewedUntil: number | null): DecorationSet {
  const decos: Decoration[] = [];
  if (reviewedUntil !== null) {
    doc.forEach((turn, offset) => {
      const end = turnEnd(turn);
      if (end !== null && end <= reviewedUntil + 0.01) decos.push(Decoration.node(offset, offset + turn.nodeSize, { class: "reviewed" }));
    });
  }
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const t = timingOf(node);
    if (t) {
      if (showDoubts && t.k === "w" && t.c < threshold) decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: "doubt" }));
    } else {
      // Brackets typed by hand get the same look as inserted notes.
      for (const m of node.text.matchAll(NOTE_RE)) {
        decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, { class: "typed-note" }));
      }
    }
  });
  return DecorationSet.create(doc, decos);
}

function highlightPlugin(initial: { showDoubts: boolean; threshold: number }) {
  return new Plugin<HighlightState>({
    key: highlightKey,
    state: {
      init: (_, state) => ({
        ...initial,
        active: null,
        loop: null,
        reviewedUntil: null,
        search: NO_SEARCH,
        base: buildBase(state.doc, initial.showDoubts, initial.threshold, null),
      }),
      apply(tr, prev) {
        const meta = tr.getMeta(highlightKey) as HighlightMeta | undefined;
        let next = prev;
        if (meta) {
          const { searchQuery, searchCurrent, ...rest } = meta;
          next = { ...next, ...rest };
          if (searchQuery) {
            const hits = findHits(tr.doc, searchQuery.query, searchQuery.wholeWord);
            next = { ...next, search: { ...searchQuery, hits, current: hits.length ? 0 : -1 } };
          }
          if (searchCurrent !== undefined) next = { ...next, search: { ...next.search, current: searchCurrent } };
        }
        if (tr.docChanged && next.search.query && !meta?.searchQuery) {
          const hits = findHits(tr.doc, next.search.query, next.search.wholeWord);
          next = { ...next, search: { ...next.search, hits, current: Math.min(next.search.current, hits.length - 1) } };
        }
        if (tr.docChanged) {
          const map = (r: Range | null) => {
            if (!r) return null;
            const from = tr.mapping.map(r.from, 1);
            const to = tr.mapping.map(r.to, -1);
            return to > from ? { from, to } : null;
          };
          next = { ...next, active: meta && "active" in meta ? next.active : map(next.active), loop: meta && "loop" in meta ? next.loop : map(next.loop) };
        }
        const rebuild = tr.docChanged || (meta && ("showDoubts" in meta || "threshold" in meta || "reviewedUntil" in meta));
        if (rebuild) next = { ...next, base: buildBase(tr.doc, next.showDoubts, next.threshold, next.reviewedUntil) };
        return next;
      },
    },
    props: {
      decorations(state) {
        const s = highlightKey.getState(state);
        if (!s) return null;
        const extra: Decoration[] = [];
        const size = state.doc.content.size;
        if (s.loop && s.loop.to <= size) extra.push(Decoration.inline(s.loop.from, s.loop.to, { class: "looping" }));
        if (s.active && s.active.to <= size) extra.push(Decoration.inline(s.active.from, s.active.to, { class: "playing" }));
        s.search.hits.forEach((h, i) => {
          if (h.to <= size) extra.push(Decoration.inline(h.from, h.to, { class: i === s.search.current ? "search-hit current" : "search-hit" }));
        });
        return extra.length > 0 ? s.base.add(state.doc, extra) : s.base;
      },
    },
  });
}

/** After a person edits text inside a recognised word, the word counts as checked. */
function confirmOnEdit() {
  return new Plugin({
    key: new PluginKey("confirm-on-edit"),
    appendTransaction(transactions, _old, state) {
      const ranges: Range[] = [];
      for (const tr of transactions) {
        if (!tr.docChanged || tr.getMeta(SYSTEM) || tr.getMeta("history$")) continue;
        tr.steps.forEach((step, i) => {
          step.getMap().forEach((_os, _oe, newStart, newEnd) => {
            const rest = tr.mapping.slice(i + 1);
            ranges.push({ from: rest.map(newStart, -1), to: rest.map(newEnd, 1) });
          });
        });
      }
      if (ranges.length === 0) return null;
      const type = state.schema.marks.timing;
      let out: Transaction | null = null;
      const size = state.doc.content.size;
      for (const r of ranges) {
        const from = Math.max(0, Math.min(r.from, size));
        const to = Math.max(from, Math.min(r.to, size));
        state.doc.nodesBetween(Math.max(0, from - 1), Math.min(size, to + 1), (node, pos) => {
          if (!node.isText) return;
          const t = timingOf(node);
          if (t && t.k === "w" && t.c < 1) {
            out = (out ?? state.tr).addMark(pos, pos + node.nodeSize, type.create({ ...t, c: 1 }));
          }
        });
      }
      if (out) (out as Transaction).setMeta(SYSTEM, true).setMeta("addToHistory", false);
      return out;
    },
  });
}

export const Highlights = Extension.create<{ showDoubts: boolean; threshold: number }>({
  name: "highlights",
  addOptions() {
    return { showDoubts: true, threshold: 0.5 };
  },
  addProseMirrorPlugins() {
    return [highlightPlugin(this.options), confirmOnEdit()];
  },
});

// ------------------------------------------------------------------ queries

export interface TimedRange extends Range {
  s: number;
  e: number;
}

/** Every piece of text with an audio position, in document order. */
export function timedRanges(doc: PMNode): TimedRange[] {
  const out: TimedRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const t = timingOf(node);
    if (t && (t.k === "w" || t.k === "f" || t.k === "b")) out.push({ from: pos, to: pos + node.nodeSize, s: t.s, e: t.e });
  });
  return out;
}

/** Index of the range that is being spoken at `time`, searching outward from `hint`. */
export function rangeAt(ranges: TimedRange[], time: number, hint: number): number {
  const n = ranges.length;
  if (n === 0) return -1;
  const hit = (i: number) => time >= ranges[i].s - 0.02 && time < Math.max(ranges[i].e, ranges[i].s + 0.12);
  let i = Math.max(0, Math.min(hint, n - 1));
  if (hit(i)) return i;
  // Playback usually moves forward a word at a time.
  for (let k = 1; k <= 4 && i + k < n; k++) if (hit(i + k)) return i + k;
  // Otherwise binary search on start time (ranges are nearly sorted by time).
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ranges[mid].s <= time) lo = mid;
    else hi = mid - 1;
  }
  for (let k = Math.max(0, lo - 6); k <= Math.min(n - 1, lo + 6); k++) if (hit(k)) return k;
  return -1;
}

/** Positions of uncertain words. */
export function doubts(doc: PMNode, threshold: number): Range[] {
  const out: Range[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const t = timingOf(node);
    if (t && t.k === "w" && t.c < threshold) out.push({ from: pos, to: pos + node.nodeSize });
  });
  return out;
}

/** The timing mark at a document position, if any. */
export function timingAt(state: EditorState, pos: number): TimingAttrs | null {
  const size = state.doc.content.size;
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, size)));
  const node = $pos.nodeAfter?.isText ? $pos.nodeAfter : $pos.nodeBefore;
  return node ? timingOf(node) : null;
}

/** Audio span covered by a selection: first to last timed text inside it. */
export function selectionSpan(state: EditorState): { s: number; e: number; from: number; to: number } | null {
  const { from, to } = state.selection;
  if (from === to) return null;
  let s = Infinity;
  let e = -Infinity;
  let first = to;
  let last = from;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const t = timingOf(node);
    if (t && (t.k === "w" || t.k === "f" || t.k === "b")) {
      s = Math.min(s, t.s);
      e = Math.max(e, t.e);
      first = Math.min(first, pos);
      last = Math.max(last, pos + node.nodeSize);
    }
  });
  return Number.isFinite(s) && e > s ? { s, e, from: first, to: last } : null;
}

const WORD_CHAR = /[\p{L}\p{N}'’-]/u;

/** `from`..`to` widened to whole words: a selection that starts or ends halfway through a word is a slip. */
export function wholeWords(doc: PMNode, from: number, to: number): Range {
  const grow = (pos: number, dir: -1 | 1) => {
    const $pos = doc.resolve(pos);
    const text = $pos.parent.textContent;
    let i = $pos.parentOffset;
    const word = (c: string | undefined) => !!c && WORD_CHAR.test(c);
    // Only when the selection really ends inside a word: a double-click selects "word " with
    // the space after it, which must not pull in the next word.
    if (dir < 0 && word(text[i])) while (i > 0 && word(text[i - 1])) i--;
    if (dir > 0 && word(text[i - 1])) while (i < text.length && word(text[i])) i++;
    return $pos.start() + i;
  };
  return from === to ? { from, to } : { from: grow(from, -1), to: grow(to, 1) };
}

/** Number of sentences in a piece of text: "Ja, klopt." is one, "Ja. Dat klopt." two. */
export function sentenceCount(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
}

/**
 * The selected words as a short phrase, for example to start a pseudonym rule with: whole words
 * within one turn, without the punctuation around them. Empty when nothing is selected, the
 * selection spans turns, holds a bracketed tag or is longer than `max` words.
 */
export function selectedPhrase(state: EditorState, max = 5): string {
  const { from, to } = state.selection;
  if (from === to || state.doc.resolve(from).parent !== state.doc.resolve(to).parent) return "";
  const r = wholeWords(state.doc, from, to);
  const text = state.doc
    .textBetween(r.from, r.to, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/\s+/g, " ");
  if (!text || /[[\]]/.test(text) || text.split(" ").length > max) return "";
  return text;
}

// ------------------------------------------------------------------ pseudonyms in the text
// Every match of a rule is shown as its pseudonym, in a distinct style, with the original as a
// tooltip. The text itself is not changed (that only happens on export). When the cursor or the
// selection touches a match while the person is working in the text, the original is shown
// instead, so it can be read and edited. While they work elsewhere (typing a new rule in the
// panel, with the word still selected in the text), the pseudonym shows at once.

export interface PseudonymRule {
  find: string;
  replace: string;
}

type Match = Range & { replace: string };

interface PseudonymState {
  on: boolean;
  rules: PseudonymRule[];
  /** Tooltip text for a pseudonym, given the original text. */
  label: (original: string) => string;
  matches: Match[];
  /** The match the arrows in the panel jumped to: highlighted, but still shown as pseudonym. */
  current: Range | null;
  /** Whether the text has the keyboard focus; only then does the selection reveal originals. */
  focused: boolean;
  decos: DecorationSet;
}

export type PseudonymMeta = Partial<Pick<PseudonymState, "on" | "rules" | "label" | "current" | "focused">>;

export const pseudonymKey = new PluginKey<PseudonymState>("pseudonyms");

/** Same matching as the export: whole words, case-insensitive, longest rule first, no overlaps. */
export function pseudonymMatches(doc: PMNode, rules: PseudonymRule[]): Match[] {
  const out: Match[] = [];
  const res = rules
    .map((r) => ({ rule: r, re: pseudonymRegex(r.find) }))
    .filter((x): x is { rule: PseudonymRule; re: RegExp } => x.re !== null);
  if (res.length === 0) return out;
  doc.forEach((turn, offset) => {
    const text = turn.textContent;
    const taken: [number, number][] = [];
    for (const { rule, re } of res) {
      for (const m of text.matchAll(re)) {
        const a = m.index;
        const b = a + m[0].length;
        if (taken.some(([x, y]) => a < y && b > x)) continue;
        taken.push([a, b]);
        out.push({ from: offset + 1 + a, to: offset + 1 + b, replace: rule.replace });
      }
    }
  });
  return out.sort((x, y) => x.from - y.from);
}

function pseudonymRegex(term: string): RegExp | null {
  const core = term.trim();
  if (!core) return null;
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
}

/** True when the selection touches the match (the cursor right before or after it counts). */
function touches(m: Range, from: number, to: number): boolean {
  return from <= m.to && to >= m.from;
}

function buildPseudonyms(state: EditorState, s: Pick<PseudonymState, "on" | "matches" | "label" | "current" | "focused">): DecorationSet {
  const cur = s.current;
  const isCurrent = (m: Range) => !!cur && m.from === cur.from && m.to === cur.to;
  if (!s.on) {
    // Pseudonyms switched off: a jump still marks the original it landed on.
    return cur && cur.to <= state.doc.content.size ? DecorationSet.create(state.doc, [Decoration.inline(cur.from, cur.to, { class: "search-hit current" })]) : DecorationSet.empty;
  }
  if (s.matches.length === 0) return DecorationSet.empty;
  const { from, to } = state.selection;
  const decos: Decoration[] = [];
  for (const m of s.matches) {
    if (s.focused && !isCurrent(m) && touches(m, from, to)) {
      decos.push(Decoration.inline(m.from, m.to, { class: "anon-editing" }));
      continue;
    }
    const original = state.doc.textBetween(m.from, m.to);
    decos.push(Decoration.inline(m.from, m.to, { class: "anon-hidden" }));
    decos.push(
      Decoration.widget(
        m.from,
        (view, getPos) => {
          const chip = document.createElement("span");
          chip.className = (m.replace ? "anon-chip" : "anon-chip removed") + (isCurrent(m) ? " current" : "");
          chip.textContent = m.replace || "—";
          chip.title = s.label(original);
          chip.contentEditable = "false";
          // Clicking the pseudonym puts the cursor at the end of the original, which reveals it.
          chip.addEventListener("mousedown", (e) => {
            const pos = getPos();
            if (pos === undefined) return;
            e.preventDefault();
            const end = Math.min(pos + (m.to - m.from), view.state.doc.content.size);
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
            view.focus();
          });
          return chip;
        },
        { side: -1, ignoreSelection: true, key: `anon-${m.replace}-${original}${isCurrent(m) ? "-current" : ""}` },
      ),
    );
  }
  return DecorationSet.create(state.doc, decos);
}

function pseudonymPlugin() {
  return new Plugin<PseudonymState>({
    key: pseudonymKey,
    state: {
      init: () => ({ on: false, rules: [], label: (t) => t, matches: [], current: null, focused: false, decos: DecorationSet.empty }),
      apply(tr, prev, old, state) {
        const meta = tr.getMeta(pseudonymKey) as PseudonymMeta | undefined;
        if (!meta && !tr.docChanged && !tr.selectionSet) return prev;
        let next = { ...prev, ...meta };
        // The jump highlight lasts until the person edits or really moves the cursor (focus changes
        // re-read the same selection from the page; those keep it).
        const moved = tr.selectionSet && !tr.selection.eq(old.selection);
        if (!(meta && "current" in meta) && (tr.docChanged || moved)) next = { ...next, current: null };
        if (meta?.rules || tr.docChanged) next = { ...next, matches: pseudonymMatches(tr.doc, next.rules) };
        return { ...next, decos: buildPseudonyms(state, next) };
      },
    },
    props: {
      decorations: (state) => pseudonymKey.getState(state)?.decos ?? null,
      handleDOMEvents: {
        focus: (view) => {
          view.dispatch(view.state.tr.setMeta(pseudonymKey, { focused: true }).setMeta("addToHistory", false));
          return false;
        },
        blur: (view) => {
          view.dispatch(view.state.tr.setMeta(pseudonymKey, { focused: false }).setMeta("addToHistory", false));
          return false;
        },
      },
    },
  });
}

export const Pseudonyms = Extension.create({
  name: "pseudonyms",
  addProseMirrorPlugins() {
    return [pseudonymPlugin()];
  },
});
