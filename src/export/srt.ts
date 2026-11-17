import type { Paragraph, Transcript } from "../lib/types";
import { itemText, speakerName } from "../lib/transcript";

/** Upper bounds for a single subtitle cue. */
export const MAX_CUE_WORDS = 12;
export const MAX_CUE_SECONDS = 6;

interface Cue {
  start: number;
  end: number;
  parts: string[];
  words: number;
}

/**
 * Splits one paragraph into cues. Pauses end the current cue and are not shown;
 * notes have no reliable timing and join the cue they follow (or the next one
 * when they open the paragraph).
 */
function paragraphCues(p: Paragraph, transcript: Transcript): Cue[] {
  const cues: Cue[] = [];
  let current: Cue | null = null;
  const leadingNotes: string[] = [];

  for (const item of p.items) {
    if (item.k === "p") {
      current = null;
      continue;
    }
    const text = itemText(item, transcript);
    if (item.k === "n") {
      const previous = cues[cues.length - 1];
      if (previous) previous.parts.push(text);
      else leadingNotes.push(text);
      continue;
    }
    if (current && (current.words >= MAX_CUE_WORDS || item.e - current.start > MAX_CUE_SECONDS)) {
      current = null;
    }
    if (!current) {
      current = { start: item.s, end: item.e, parts: cues.length === 0 ? leadingNotes : [], words: 0 };
      cues.push(current);
    }
    current.parts.push(text);
    current.end = Math.max(current.end, item.e);
    if (item.k === "w") current.words++;
  }

  if (cues.length === 0 && leadingNotes.length > 0) {
    cues.push({ start: p.start, end: p.end, parts: leadingNotes, words: 0 });
  }

  return cues;
}

/** Cues of the whole transcript, monotonic and non-overlapping, in milliseconds. */
function allCues(transcript: Transcript): { start: number; end: number; speaker: string; text: string; first: boolean }[] {
  const out: { start: number; end: number; speaker: string; text: string; first: boolean }[] = [];
  let previousEnd = 0;
  for (const p of transcript.paragraphs) {
    paragraphCues(p, transcript).forEach((cue, i) => {
      const start = Math.max(Math.round(cue.start * 1000), previousEnd);
      const end = Math.max(Math.round(cue.end * 1000), start + 1);
      previousEnd = end;
      out.push({ start, end, speaker: speakerName(transcript, p.speaker), text: cue.parts.join(" "), first: i === 0 });
    });
  }
  return out;
}

/** 3723.5 → "01:02:03,500" */
function srtTime(ms: number): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** SubRip subtitles: numbered cues; the speaker's name opens each turn. */
export function toSrt(transcript: Transcript): string {
  return allCues(transcript)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.first ? `${c.speaker}: ` : ""}${c.text}\n`)
    .join("\n");
}

/** WebVTT subtitles with voice tags, so players can show or style each speaker. */
export function toVtt(transcript: Transcript): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const time = (ms: number) => srtTime(ms).replace(",", ".");
  const cues = allCues(transcript).map((c) => `${time(c.start)} --> ${time(c.end)}\n<v ${escape(c.speaker)}>${escape(c.text)}\n`);
  return ["WEBVTT\n", ...cues].join("\n");
}
