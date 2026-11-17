// Editor behaviour that is not part of the document itself: highlights (uncertain words,
// the word being played, the loop range, hand-typed bracket notes) and the rule that a word
// someone has edited is no longer "uncertain".

import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
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
