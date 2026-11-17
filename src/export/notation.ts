// Transcription conventions for pauses. The transcript stores measured pauses; this decides
// how they are written.
//
// - "polarity": [stilte 3.5s] / [silence 3.5s] (the app's own notation)
// - "dresing":  Dresing & Pehl: (.) about one second, (..) about two, (...) about three,
//               longer pauses as whole seconds, (5)
// - "jefferson": Jefferson / GAT 2: the length in tenths of a second, (3.5)

import type { Paragraph, Transcript } from "../lib/types";

export type PauseNotation = "polarity" | "dresing" | "jefferson";

export function pauseText(seconds: number, notation: Exclude<PauseNotation, "polarity">): string {
  if (notation === "jefferson") return `(${seconds.toFixed(1)})`;
  const s = Math.round(seconds);
  if (s <= 1) return "(.)";
  if (s === 2) return "(..)";
  if (s === 3) return "(...)";
  return `(${s})`;
}

/** Pauses rewritten as annotations in the chosen notation (unchanged for the app's own). */
export function applyNotation(t: Transcript, notation: PauseNotation): Transcript {
  if (notation === "polarity") return t;
  const paragraphs: Paragraph[] = t.paragraphs.map((p) => ({
    ...p,
    items: p.items.map((it) => (it.k === "p" ? { k: "n" as const, t: pauseText(it.e - it.s, notation), s: it.s } : it)),
  }));
  return { ...t, paragraphs };
}
